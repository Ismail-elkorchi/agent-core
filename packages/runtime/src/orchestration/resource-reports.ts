import { grantContextControlTool } from '../context/recovery.js';
import * as z from 'zod';
import { parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';
import type { EventReference, EventRepository } from '@agent-core/persistence';
import type { CommandExecution, PendingCommandReportPage, PendingCommandReportRequest } from '@agent-core/tools';
import type { AgentEvent } from '../events.js';
import type { SessionDescriptor, SessionRepository } from '../session/contracts.js';
import { scopedTool, scopePath } from '../history/tool-support.js';

interface ResourceReportScope {
  readonly repository: SessionRepository;
  readonly session: SessionDescriptor;
  readonly ownerId: string;
  readonly command?: CommandExecution | undefined;
  readonly events: EventRepository<AgentEvent>;
}

/** A bounded view of unacknowledged handoffs, fenced by current branch membership. */
export async function readPendingResourceReports(
  scope: ResourceReportScope,
  request: Omit<PendingCommandReportRequest, 'ownerId'> = {}
): Promise<PendingCommandReportPage> {
  const snapshot = await scope.repository.sourceSnapshot(scope.session);
  let after: string | undefined;
  if (request.after !== undefined) {
    if (request.after.length > 8192) throw new TypeError('Invalid resource report cursor.');
    const cursor = parseJsonObject(JSON.parse(request.after));
    if (cursor.branchId !== snapshot.branchId || typeof cursor.cursor !== 'string')
      throw new Error('Pending resource cursor belongs to another branch.');
    after = cursor.cursor;
  }
  const page = await scope.command?.readPendingTerminalReports({
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    ...(after === undefined ? {} : { after }), ownerId: scope.ownerId
  }) ?? { reports: [], next: '', complete: true, scanned: 0 };
  const inherited = await snapshot.inheritedHeads;
  const reports = [];
  for (const report of page.reports)
    if (report.owner.ownerId === scope.ownerId && !inherited.has(report.owner.runId) && await snapshot.index.runs.has(report.owner.runId)) reports.push(report);
  const oversized = page.oversized?.owner.ownerId === scope.ownerId && !inherited.has(page.oversized.owner.runId) &&
    await snapshot.index.runs.has(page.oversized.owner.runId) ? page.oversized : undefined;
  const result = { reports: Object.freeze(reports), next: JSON.stringify({ branchId: snapshot.branchId, cursor: page.next }), complete: page.complete,
    scanned: page.scanned, ...(oversized ? { oversized } : {}) };
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const maxBytes = request.maxBytes ?? 16_384;
  if (bytes(result) <= maxBytes) return Object.freeze(result);
  // Re-read a smaller bounded page so its cursor still precedes every omitted report.
  const limit = request.limit ?? 16;
  if (limit > 1) return readPendingResourceReports(scope, { ...request, limit: limit - 1 });
  const first = reports[0];
  if (first) {
    const omitted = { ...result, reports: [], oversized: { processId: first.processId, owner: first.owner, bytes: bytes(first) } };
    if (bytes(omitted) <= maxBytes) return Object.freeze(omitted);
  }
  throw new RangeError('Pending resource identity exceeds the requested envelope budget.');
}

/** Read the canonical event ledger rather than manufacturing another report inventory. */
export async function readResourceReleaseReports(scope: ResourceReportScope, request: {
  readonly runId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
  readonly maxBytes?: number;
}) {
  const snapshot = await scope.repository.sourceSnapshot(scope.session);
  if (!await snapshot.index.runs.has(request.runId)) throw new Error('Resource report run is outside the current session branch.');
  const maxBytes = request.maxBytes ?? 16_384;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65_536)
    throw new TypeError('Invalid resource report envelope budget.');
  if (!Number.isSafeInteger(request.limit ?? 16) || (request.limit ?? 16) < 1 || (request.limit ?? 16) > 64)
    throw new TypeError('Invalid resource report page limit.');
  const inherited = (await snapshot.inheritedHeads).get(request.runId);
  const page = await scope.events.readRange(request.runId, {
    ...(request.afterSequence === undefined ? {} : { afterSequence: request.afterSequence }),
    limit: request.limit ?? 16, maxBytes, types: ['resource.released'],
    metadata: { resourceOwnerId: scope.ownerId },
    ...(inherited ? { through: inherited } : {})
  });
  const reports: { resourceId: string; outcome: 'released' | 'unknown'; details: JsonObject; settlementReference: EventReference }[] = [];
  for (const record of page.records) {
    const event = record.event;
    if (event.type !== 'resource.released') continue;
    const owner = event.details.owner;
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
        !('ownerId' in owner) || !('runId' in owner) || owner.ownerId !== scope.ownerId || owner.runId !== request.runId) continue;
    const details = publicResourceDetails(event.details);
    reports.push({ resourceId: event.resourceId, outcome: event.outcome, details,
      settlementReference: { runId: record.runId, eventId: record.eventId, sequence: record.sequence, hash: record.hash } });
  }
  let next = page.oversized?.reference.sequence ?? page.nextSequence;
  let complete = page.complete;
  let oversized = page.oversized;
  const result = () => ({ reports: [...reports], next, complete, scanned: page.scanned,
    ...(oversized ? { oversized } : {}) });
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes(result()) > maxBytes && oversized && reports.length) {
    oversized = undefined;
    const last = reports.at(-1);
    if (!last) throw new Error('Missing resource report position.');
    next = last.settlementReference.sequence;
    complete = false;
  }
  while (bytes(result()) > maxBytes && reports.length) {
    const omitted = reports.pop();
    if (!omitted) throw new Error('Missing resource report position.');
    // Leave the first omitted source unread; retrying with next never loses a receipt.
    next = omitted.settlementReference.sequence - 1;
    complete = false;
    oversized = undefined;
    if (!reports.length) {
      oversized = { reference: omitted.settlementReference, bytes: bytes(omitted) };
      next = omitted.settlementReference.sequence;
    }
  }
  const bounded = result();
  if (bytes(bounded) > maxBytes) throw new RangeError('Resource report identity exceeds the requested envelope budget.');
  return bounded;
}

export function createResourceReportTool(scope: ResourceReportScope) {
  const bounds = {
    limit: z.number().int().min(1).max(64).optional(),
    maxBytes: z.number().int().min(1024).max(65_536).optional(),
    branchId: z.string().optional()
  };
  const schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('pending'), after: z.string().max(8192).optional(), ...bounds }),
    z.strictObject({ kind: z.literal('committed'), runId: z.string().min(1),
      after: z.number().int().min(-1).optional(), ...bounds })
  ]);
  return grantContextControlTool(scopedTool({
    name: 'resource_reports_read', root: 'history', mode: 'read', schema,
    description: 'Read bounded public resource reports for this session branch. Pending means acknowledgement unfinished; a committed receipt may already exist. For committed reports supply the original runId. Continue with next as after; an oversized source is explicitly identified and can be skipped by advancing. Protected output is never exposed.',
    async canonicalize(value) {
      const snapshot = await scope.repository.sourceSnapshot(scope.session);
      if (value.branchId !== undefined && value.branchId !== snapshot.branchId) throw new Error('Resource report branch changed.');
      return { value: parseJsonObject({ ...value, branchId: snapshot.branchId }),
        scope: scopePath('history', scope.session.id, snapshot.branchId) };
    },
    async invoke(value) {
      const request = schema.parse(value);
      const snapshot = await scope.repository.sourceSnapshot(scope.session);
      if (request.branchId !== snapshot.branchId) throw new Error('Resource report branch changed after authorization.');
      const bounds = { ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }) };
      if (request.kind === 'pending') {
        return readPendingResourceReports(scope, {
        ...bounds, ...(request.after === undefined ? {} : { after: request.after })
      });
      }
      return readResourceReleaseReports(scope, { ...bounds, runId: request.runId,
        ...(request.after === undefined ? {} : { afterSequence: request.after }) });
    }
  }), 'read');
}

/** Public nested shapes are closed too; an arbitrary receipt object is not a public artifact. */
function publicResourceDetails(source: JsonObject): JsonObject {
  const primitiveFields = (value: JsonValue | undefined, keys: readonly string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.fromEntries(Object.entries(value).filter(([key, field]) => keys.includes(key) &&
      (field === null || typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean')));
  };
  const details = primitiveFields(source, ['status', 'cursorEnd', 'diagnostic', 'exitCode', 'signal']) ?? {};
  const owner = primitiveFields(source.owner, ['ownerId', 'runId', 'turnId', 'toolBatchId', 'callIndex']);
  const streams = Object.fromEntries(['stdout', 'stderr', 'combined'].flatMap(key => {
    const value = primitiveFields(source[key], ['observedBytes', 'capturedBytes']);
    return value ? [[key, value]] : [];
  }));
  const artifact = source.artifact;
  const publicArtifact = artifact && typeof artifact === 'object' && 'visibility' in artifact && artifact.visibility === 'public'
    ? primitiveFields(artifact, ['artifactId', 'sha256', 'size', 'mediaType', 'visibility', 'label', 'description']) : undefined;
  return parseJsonObject({ ...details, ...streams, ...(owner ? { owner } : {}),
    ...(publicArtifact ? { artifact: publicArtifact } : {}) });
}
