import { ToolInputError } from '@agent-core/tools';
import { parseJsonObject } from '@agent-core/json';
import { decodeOwnedArtifactRef, hashJson, PersistenceConflictError, type ProtectedArtifactRef } from '@agent-core/persistence';
import * as z from 'zod';
import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import { historyCutSchema, sourceSchema } from '../history/schema.js';

/** Exact recorded inference attribution, never user authority. */
export interface SessionStateInference {
  readonly ownerId: string;
  readonly invocationId: string;
  readonly requestRef: ProtectedArtifactRef;
}
export interface SessionStateItemRef {
  readonly itemId: string;
  readonly revisionId: string;
  readonly range?: { readonly offset: number; readonly bytes: number } | undefined;
}
export interface SessionStateItemContent {
  readonly text: string;
  readonly sources?: readonly HistorySourceRef[] | undefined;
}
export interface SessionStateItemRevision {
  readonly contentRef: ProtectedArtifactRef;
  readonly sources?: readonly HistorySourceRef[] | undefined;
  readonly itemId: string;
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly deleted: boolean;
  readonly contentSha256: string;
  readonly contentBytes: number;
  readonly inference: SessionStateInference;
  readonly capturedHistoryCut: HistorySourceCut;
}
export interface SessionStateSelectedItem extends SessionStateItemRef, SessionStateItemContent {}
/** A view of exact immutable revisions, never a hydration of all current stored items. */
export interface SessionStateSnapshot {
  readonly id: string | null;
  readonly items: readonly SessionStateSelectedItem[];
}
export type SessionStateOperation =
  | ({ readonly kind: 'create' } & SessionStateItemContent)
  | ({ readonly kind: 'replace'; readonly itemId: string; readonly expectedRevisionId: string } & SessionStateItemContent)
  | { readonly kind: 'edit'; readonly itemId: string; readonly expectedRevisionId: string;
      readonly edits: readonly { readonly offset: number; readonly bytes: number; readonly text: string }[] }
  | { readonly kind: 'remove'; readonly itemId: string; readonly expectedRevisionId: string };
export interface SessionStateBatch {
  readonly idempotencyKey: string;
  readonly branchId: string;
  readonly inference: SessionStateInference;
  readonly capturedHistoryCut: HistorySourceCut;
  readonly operations: readonly SessionStateOperation[];
}
/** Immutable proposed values. Repositories recheck each touched item under their append lock. */
export interface SessionStateBatchCommit extends Omit<SessionStateBatch, 'operations'> {
  readonly revisions: readonly SessionStateItemRevision[];
  readonly fingerprint: string;
  readonly maxStorageBytes: number;
}
export interface SessionStateBatchReceipt {
  readonly idempotencyKey: string;
  readonly entryId: string;
  readonly fingerprint: string;
  readonly revisions: readonly SessionStateItemRef[];
}
export interface SessionStatePageRequest {
  readonly leafId?: string | null | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly maxBytes?: number | undefined;
}
export interface SessionStateItemMetadata {
  readonly itemId: string;
  readonly revisionId: string;
  readonly contentBytes: number;
  readonly contentSha256: string;
}
export interface SessionStatePage {
  readonly items: readonly SessionStateItemMetadata[];
  readonly coverage: 'complete' | 'partial';
  readonly cursor?: string | undefined;
}
const id = z.string().min(1).max(512);
export const sessionStateItemRefSchema = z.strictObject({
  itemId: id, revisionId: id,
  range: z.strictObject({ offset: z.int().nonnegative(), bytes: z.int().positive() }).readonly().optional()
}).readonly();
export const sessionStateItemContentSchema = z.strictObject({
  text: z.string().min(1), sources: z.array(sourceSchema).max(256).readonly().optional()
}).readonly();
const expected = { itemId: id, expectedRevisionId: id };
export const sessionStateOperationSchema = z.discriminatedUnion('kind', [
  sessionStateItemContentSchema.unwrap().extend({ kind: z.literal('create') }),
  sessionStateItemContentSchema.unwrap().extend({ kind: z.literal('replace'), ...expected }),
  z.strictObject({ kind: z.literal('edit'), ...expected, edits: z.array(z.strictObject({
    offset: z.int().nonnegative(), bytes: z.int().nonnegative(), text: z.string()
  }).readonly()).min(1).max(256).readonly() }).readonly(),
  z.strictObject({ kind: z.literal('remove'), ...expected }).readonly()
]);
const protectedRef = z.unknown().transform(value => {
  const ref = decodeOwnedArtifactRef(parseJsonObject(value));
  if (ref.visibility !== 'protected') throw new Error('Session-state inference references must be protected.');
  return ref;
});
export const sessionStateInferenceSchema = z.strictObject({ ownerId: id, invocationId: id, requestRef: protectedRef }).readonly();
export const sessionStateBatchSchema = z.strictObject({
  idempotencyKey: id, branchId: id, inference: sessionStateInferenceSchema,
  capturedHistoryCut: historyCutSchema, operations: z.array(sessionStateOperationSchema).min(1).max(256).readonly()
}).readonly();
export const sessionStateItemRevisionSchema = z.strictObject({
  itemId: id, revisionId: id, previousRevisionId: id.nullable(), deleted: z.boolean(), contentRef: protectedRef,
  sources: z.array(sourceSchema).max(256).readonly().optional(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  contentBytes: z.int().nonnegative(), inference: sessionStateInferenceSchema, capturedHistoryCut: historyCutSchema
}).readonly();
export const sessionStateBatchCommitSchema = sessionStateBatchSchema.unwrap().omit({ operations: true }).extend({
  revisions: z.array(sessionStateItemRevisionSchema).min(1).max(256).readonly(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), maxStorageBytes: z.int().positive()
}).readonly();

const selectedItemSchema = sessionStateItemRefSchema.unwrap().extend(sessionStateItemContentSchema.unwrap().shape).readonly();

export function sessionStateView(items: readonly SessionStateSelectedItem[]): SessionStateSnapshot {
  items = Object.freeze(items.map(item => selectedItemSchema.parse(item)));
  return Object.freeze({ id: items.length ? `state-view-${hashJson(items.map(({ itemId, revisionId, range }) => ({ itemId, revisionId, ...(range ? { range } : {}) })))}` : null,
    items: Object.freeze([...items]) });
}
/** UTF-8 ranges are exact; never silently split a code point or truncate a mutation. */
export function sessionStateTextRange(text: string, offset: number, bytes: number): string {
  const value = Buffer.from(text);
  if (offset < 0 || bytes < 0 || offset + bytes > value.length) throw new Error('Session-state range is outside its revision.');
  const result = new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(offset, offset + bytes));
  if (Buffer.byteLength(result) !== bytes) throw new Error('Session-state range must use UTF-8 boundaries.');
  return result;
}
export function applySessionStateEdits(text: string, edits: Extract<SessionStateOperation, { kind: 'edit' }>['edits']): string {
  const ordered = [...edits].sort((a, b) => a.offset - b.offset);
  const source = Buffer.from(text);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const edit of ordered) {
    if (edit.offset < offset) throw new Error('Session-state edits overlap.');
    sessionStateTextRange(text, edit.offset, edit.bytes);
    chunks.push(Buffer.from(sessionStateTextRange(text, offset, edit.offset - offset)), Buffer.from(edit.text));
    offset = edit.offset + edit.bytes;
  }
  chunks.push(source.subarray(offset));
  const result = Buffer.concat(chunks).toString('utf8');
  if (!result.length) throw new Error('Use remove to delete a session-state item.');
  return result;
}
export function assertSessionStateItemRevision(current: SessionStateItemRevision | undefined, expected: string, itemId?: string): asserts current is SessionStateItemRevision {
  if (!current || current.deleted || current.revisionId !== expected)
    throw Object.assign(new PersistenceConflictError('The addressed session-state item changed after it was read.'), { details: {
      code: 'session_state_conflict', itemId: itemId ?? current?.itemId ?? null, expectedRevisionId: expected, currentRevisionId: current?.revisionId ?? null,
      status: current ? current.deleted ? 'deleted' : 'changed' : 'missing'
    } });
}
export const SESSION_STATE_GUIDANCE = 'Session-state items are attributed, fallible narrative understanding, not authority or verification. Save useful changes with per-item conditional operations. Saving does not put content in the model context. Explicitly select exact item revisions and optional UTF-8 ranges to activate a bounded view. Earlier revisions remain addressable. User corrections take precedence; retrieve originals when detail matters. Unresolved work does not authorize execution after unrelated requests.';

/** Called under the repository's fenced append lock. Disjoint item writes do not conflict. */
export async function validateSessionStateCommit(
  commit: SessionStateBatchCommit,
  current: (itemId: string) => Promise<SessionStateItemRevision | undefined>,
  retainedBytes: number
): Promise<void> {
  const owned = sessionStateBatchCommitSchema.parse(commit);
  const seen = new Set<string>();
  for (const [index, revision] of owned.revisions.entries()) {
    if (seen.has(revision.itemId)) throw new Error('A session-state batch may touch an item only once.');
    seen.add(revision.itemId);
    if (revision.revisionId !== sessionStateRevisionIdentity(owned.fingerprint, index))
      throw new Error('Session-state revision identity differs from its immutable batch.');
    const previous = await current(revision.itemId);
    if (revision.previousRevisionId === null) {
      if (previous) throw new PersistenceConflictError('Session-state create identity already exists.');
      if (revision.itemId !== sessionStateItemIdentity(owned.branchId, owned.fingerprint, index))
        throw new Error('Session-state item identity was not generated by this batch.');
    } else assertSessionStateItemRevision(previous, revision.previousRevisionId, revision.itemId);
    if (revision.contentBytes !== revision.contentRef.size || revision.contentSha256 !== revision.contentRef.sha256 ||
        hashJson(revision.inference) !== hashJson(owned.inference) ||
        hashJson(revision.capturedHistoryCut) !== hashJson(owned.capturedHistoryCut))
      throw new Error('Session-state revision metadata disagrees with its immutable content or attribution.');
  }
  if (retainedBytes + sessionStateBatchStorageBytes(owned) > owned.maxStorageBytes)
    throw sessionStateLimitError('committed_retained_state', owned.maxStorageBytes, retainedBytes + sessionStateBatchStorageBytes(owned), 'Session-state retained revision storage quota exceeded; no items were saved.');
}

/** All durable metadata and body bytes, including superseded and abandoned-fork revisions. */
export function sessionStateBatchStorageBytes(batch: SessionStateBatchCommit): number {
  return Buffer.byteLength(JSON.stringify(batch)) + batch.revisions.reduce((sum, revision) => sum + revision.contentBytes, 0);
}

export function sessionStateLimitError(resource: string, limit: number, observedBytes: number, message: string): ToolInputError {
  return new ToolInputError(message, { code: 'session_state_limit', resource, limit, observedBytes });
}

export function sessionStateRevisionIdentity(fingerprint: string, index: number): string {
  return `state-revision-${hashJson({ fingerprint, index })}`;
}
export function sessionStateItemIdentity(branchId: string, fingerprint: string, index: number): string {
  return `state-item-${hashJson({ branchId, fingerprint, index })}`;
}
export function plannedSessionStateRefs(batch: SessionStateBatch): readonly (SessionStateItemRef & { readonly deleted: boolean })[] {
  const fingerprint = hashJson(batch);
  return batch.operations.map((operation, index) => ({
    itemId: operation.kind === 'create' ? sessionStateItemIdentity(batch.branchId, fingerprint, index) : operation.itemId,
    revisionId: sessionStateRevisionIdentity(fingerprint, index), deleted: operation.kind === 'remove'
  }));
}
