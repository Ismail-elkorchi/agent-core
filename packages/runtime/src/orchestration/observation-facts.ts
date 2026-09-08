import { parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';
import {
  validateArtifactRef,
  type ArtifactRef,
  type ArtifactRepository,
  type EventRepository
} from '@agent-core/persistence';
import { encodeObservedFactRecord, type ObservedFactRecord } from '@agent-core/tools';
import type { AgentEvent } from '../events.js';
import type {
  AgentObservedFactsPage,
  AgentObservedFactsReader,
  ObservationAccess
} from '../run/contracts.js';

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Expose owned tool observedFacts to verification without granting effect authority. */
export function createObservationAccess(input: {
  readonly events: EventRepository<AgentEvent>;
  readonly runId: string;
  readonly artifacts?: ArtifactRepository;
  readonly configured?: ObservationAccess;
}): ObservationAccess {
  let records: Promise<readonly ObservedFactRecord[]> | undefined;
  const observedFacts = observedFactsReader(
    () => (records ??= readCommittedFacts(input.events, input.runId)),
    input.artifacts,
    input.configured?.observedFacts
  );
  return Object.freeze({ observedFacts });
}

async function readCommittedFacts(
  events: EventRepository<AgentEvent>,
  runId: string
): Promise<readonly ObservedFactRecord[]> {
  const tail = await events.tail(runId);
  const facts: ObservedFactRecord[] = [];
  for await (const record of events.read(runId)) {
    if (record.sequence > tail.sequence) break;
    const event = record.event;
    if (event.type === 'observation.recording.failed')
      throw new Error(`Committed observation ${event.id} is unavailable: ${event.message}`);
    if (event.type === 'observation.record.created') {
      if (event.durableStorageDegraded)
        throw new Error(
          `Committed observation ${event.id} has degraded storage: ${event.durableStorageDegraded.message}`
        );
      facts.push(...event.observedFacts);
    }
  }
  return Object.freeze(facts);
}

function observedFactsReader(
  loadRecords: () => Promise<readonly ObservedFactRecord[]>,
  artifacts: ArtifactRepository | undefined,
  configured: AgentObservedFactsReader | undefined
): AgentObservedFactsReader {
  const reader: AgentObservedFactsReader = {
    async read(request?: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly maxBytes?: number;
    }): Promise<AgentObservedFactsPage> {
      const resolved = request ?? {};
      const records = await loadRecords();
      if (resolved.cursor?.startsWith('external:')) {
        if (!configured)
          throw new Error('Observed facts cursor refers to an unavailable external observedFacts reader.');
        const cursor = decodeExternalCursor(resolved.cursor);
        const page = await configured.read(withCursor(resolved, cursor));
        return externalPage(page);
      }
      if (resolved.cursor !== undefined && !resolved.cursor.startsWith('tool:'))
        throw new Error('Invalid observedFacts cursor.');
      const start = resolved.cursor === undefined ? 0 : parseToolCursor(resolved.cursor);
      if (start >= records.length) {
        if (!configured) return Object.freeze({ items: Object.freeze([]), bytes: 0, truncated: false });
        const page = await configured.read(withCursor(resolved, undefined));
        return externalPage(page);
      }
      const limit = positiveLimit(resolved.limit, DEFAULT_LIMIT);
      const maxBytes = positiveLimit(resolved.maxBytes, DEFAULT_MAX_BYTES);
      const items: JsonValue[] = [];
      let bytes = 0;
      let index = start;
      let includedOversizedStub = false;
      while (index < records.length && items.length < limit) {
        const record = records[index];
        if (!record) break;
        const item = encodeObservedFactRecord(record);
        const itemBytes = jsonBytes(item);
        if (items.length > 0 && bytes + itemBytes > maxBytes) break;
        if (items.length === 0 && itemBytes > maxBytes) {
          const stub = oversizedObservedFactStub(record, itemBytes, maxBytes);
          items.push(stub);
          bytes += jsonBytes(stub);
          index += 1;
          includedOversizedStub = true;
          break;
        }
        items.push(item);
        bytes += itemBytes;
        index += 1;
      }
      const nextCursor =
        index < records.length ? `tool:${String(index)}` : configured ? 'external:' : undefined;
      return Object.freeze({
        items: Object.freeze(items),
        bytes,
        truncated: includedOversizedStub || nextCursor !== undefined,
        ...(nextCursor ? { nextCursor } : {})
      });
    },
    async readArtifact(ref: ArtifactRef, request?: { readonly maxBytes?: number }) {
      const resolved = request ?? {};
      validateArtifactRef(ref);
      if (ref.visibility !== 'public')
        throw new Error('Protected artifacts are not available to verification observedFacts readers.');
      const maxBytes = positiveLimit(resolved.maxBytes, DEFAULT_MAX_BYTES);
      if (artifacts && (await artifacts.resolve(ref.artifactId))) {
        if (ref.size === 0) return new Uint8Array();
        const range = await artifacts.readVerifiedRange(ref, {
          offset: 0,
          length: Math.min(ref.size, maxBytes)
        });
        return new Uint8Array(range.bytes);
      }
      if (configured) {
        const bytes = await configured.readArtifact(ref, { maxBytes });
        if (!(bytes instanceof Uint8Array))
          throw new Error('External artifact reader returned invalid bytes.');
        return new Uint8Array(bytes.subarray(0, maxBytes));
      }
      throw new Error('Artifact reading is unavailable for this verification run.');
    }
  };
  return Object.freeze(reader);
}

function externalPage(page: AgentObservedFactsPage): AgentObservedFactsPage {
  const owned = parseJsonObject(page);
  const unknown = Object.keys(owned).filter(
    (key) => !['items', 'bytes', 'truncated', 'nextCursor'].includes(key)
  );
  if (
    unknown.length > 0 ||
    !jsonArray(owned.items) ||
    !Number.isSafeInteger(owned.bytes) ||
    typeof owned.bytes !== 'number' ||
    owned.bytes < 0 ||
    typeof owned.truncated !== 'boolean' ||
    (owned.nextCursor !== undefined && typeof owned.nextCursor !== 'string') ||
    (owned.truncated && typeof owned.nextCursor !== 'string')
  ) {
    throw new Error('External observedFacts reader returned an invalid page.');
  }
  const items = Object.freeze([...owned.items]);
  return Object.freeze({
    items,
    bytes: owned.bytes,
    truncated: owned.truncated,
    ...(typeof owned.nextCursor === 'string'
      ? { nextCursor: `external:${encodeURIComponent(owned.nextCursor)}` }
      : {})
  });
}

function jsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function oversizedObservedFactStub(
  record: ObservedFactRecord,
  originalBytes: number,
  maxBytes: number
): JsonObject {
  const stub: JsonObject = Object.freeze({
    id: record.id,
    action: record.action,
    outcome: record.outcome,
    toolName: record.toolName,
    originalBytes,
    truncated: true
  });
  if (jsonBytes(stub) > maxBytes)
    throw new Error(
      `Observed facts maxBytes ${String(maxBytes)} cannot retain the exact oversized-item identity.`
    );
  return stub;
}

function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function decodeExternalCursor(cursor: string): string | undefined {
  const encoded = cursor.slice('external:'.length);
  return encoded.length === 0 ? undefined : decodeURIComponent(encoded);
}
function parseToolCursor(cursor: string): number {
  const value = Number(cursor.slice('tool:'.length));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid tool observedFacts cursor.');
  return value;
}
function withCursor(
  request: { readonly cursor?: string; readonly limit?: number; readonly maxBytes?: number },
  cursor: string | undefined
): { readonly cursor?: string; readonly limit?: number; readonly maxBytes?: number } {
  return {
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    ...(cursor === undefined ? {} : { cursor })
  };
}
function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
