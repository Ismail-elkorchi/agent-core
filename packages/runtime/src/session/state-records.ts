import { fitBoundedJsonPage } from './bounded-result.js';
import * as z from 'zod';
import { PersistenceConflictError, hashJson } from '@agent-core/persistence';
import { sessionStateBatchCommitSchema, sessionStateLimitError, sessionStatePageSchema, SESSION_STATE_RETRIEVAL_LIMITS, type SessionStateBatchCommit, type SessionStateBatchReceipt, type SessionStateItemRevision, type SessionStatePageRequest, type SessionStateItemMetadata } from './session-state.js';
import type { SessionBranchEntry, SessionStateBatchEntry } from './contracts.js';

export const sessionStateBatchEntrySchema = z.strictObject({
  type: z.literal('session_state_batch'), id: z.string().min(1), parentId: z.string().min(1).nullable(), timestamp: z.string().min(1), batch: sessionStateBatchCommitSchema
}).readonly();
export function decodeSessionStateBatchEntry(value: unknown): SessionStateBatchEntry { return sessionStateBatchEntrySchema.parse(value); }
export interface MaterialRevisionEntry { readonly type: 'material_batch'; readonly id: string; readonly batch: SessionStateBatchCommit }
export type StateRevisionEntry = SessionBranchEntry | MaterialRevisionEntry;
export function stateBatch(entry: StateRevisionEntry): SessionStateBatchCommit | undefined {
  return (entry.type === 'session_state_batch' || entry.type === 'material_batch') ? entry.batch : entry.type === 'context_transition' ? entry.sessionState : undefined;
}
export function stateReceipt(entry: StateRevisionEntry): SessionStateBatchReceipt {
  const batch = stateBatch(entry);
  if (!batch) throw new Error('Session entry has no state batch.');
  return Object.freeze({ idempotencyKey: batch.idempotencyKey, entryId: entry.id, fingerprint: batch.fingerprint,
    revisions: Object.freeze(batch.revisions.map(({itemId, revisionId}) => Object.freeze({itemId, revisionId}))) });
}
export function assertStateRetry(entry: StateRevisionEntry, batch: SessionStateBatchCommit): SessionStateBatchReceipt {
  const previous = stateBatch(entry);
  if (!previous || hashJson(previous) !== hashJson(batch)) throw new PersistenceConflictError('Session-state idempotency key has conflicting content.');
  return stateReceipt(entry);
}
export function stateItemMetadata(item: SessionStateItemRevision): SessionStateItemMetadata {
  return Object.freeze({itemId: item.itemId, revisionId: item.revisionId, contentBytes: item.contentBytes, contentSha256: item.contentSha256, ...(item.preview === undefined ? {} : {preview:item.preview})});
}
export function statePageLimits(request: SessionStatePageRequest) {
  const parsed = sessionStatePageSchema.safeParse({ cursor: request.cursor, limit: request.limit, maxBytes: request.maxBytes });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join('.') : 'page';
    throw new RangeError(`Session-state page limits exceed supported bounds (${field}): ${issue?.message ?? 'Invalid page request'}`);
  }
  return parsed.data;
}
const cursorSchema = z.strictObject({revocationRevision:z.int().nonnegative(),sessionId: z.string(), leafId: z.string().nullable(), after: z.string(), query: z.string().optional()});
export function statePageCursor(sessionId: string, leafId: string | null, after: string, query?: string, revocationRevision=0): string {
  return Buffer.from(JSON.stringify({sessionId,leafId,after,revocationRevision,...(query === undefined ? {} : {query})})).toString('base64url');
}
export function decodeStatePageCursor(sessionId: string, request: SessionStatePageRequest, query?: string) {
  if (!request.cursor) return undefined;
  if (Buffer.byteLength(request.cursor) > SESSION_STATE_RETRIEVAL_LIMITS.maxCursorBytes) throw new Error('Session-state cursor exceeds its limit.');
  const cursor = cursorSchema.parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8')));
  if (cursor.sessionId !== sessionId || (request.leafId !== undefined && request.leafId !== cursor.leafId) || cursor.query !== query)
    throw new Error('Session-state cursor belongs to a different query or boundary.');
  return cursor;
}

export interface MemoryStateIndex {
  readonly heads: ReadonlyMap<string,SessionStateItemRevision>;
  readonly revisions: ReadonlyMap<string,SessionStateItemRevision>;
  readonly batches: ReadonlyMap<string,StateRevisionEntry>;
  readonly orderedItems: readonly SessionStateItemRevision[];
}
export const emptyMemoryStateIndex: MemoryStateIndex = Object.freeze({heads:new Map(),revisions:new Map(),batches:new Map(),orderedItems:Object.freeze([])});
export function advanceMemoryState(previous: MemoryStateIndex, entry: StateRevisionEntry): MemoryStateIndex {
  const batch = stateBatch(entry);
  if (!batch) return previous;
  const heads = new Map(previous.heads), revisions = new Map(previous.revisions), batches = new Map(previous.batches);
  batches.set(batch.idempotencyKey,entry);
  for (const item of batch.revisions) {heads.set(item.itemId,item);revisions.set(item.revisionId,item);}
  const orderedItems = Object.freeze([...heads.values()].filter(item => !item.deleted).sort((a,b) => hashJson(a.itemId).localeCompare(hashJson(b.itemId)) || a.itemId.localeCompare(b.itemId)));
  return Object.freeze({heads,revisions,batches,orderedItems});
}
export function assertStateSourceCut(sessionId: string, branch: readonly SessionBranchEntry[], batch: SessionStateBatchCommit, sourceRevision: number): void {
  const cut = batch.capturedHistoryCut;
  const branchId = [...branch].reverse().find(entry => entry.type === 'branch')?.id ?? sessionId;
  const through = cut.throughEntryId === null ? -1 : branch.findIndex(entry => entry.id === cut.throughEntryId);
  if (batch.owner.kind !== 'session' || batch.owner.sessionId !== sessionId || batch.owner.branchId !== branchId || batch.branchId !== branchId || cut.sessionId !== sessionId || cut.branchId !== branchId || cut.sourceRevision > sourceRevision || (cut.throughEntryId !== null && through < 0))
    throw new PersistenceConflictError('Session-state source cut is outside the active branch.');
  if (branch.slice(through + 1).some(entry => entry.type === 'input' || entry.type === 'steering'))
    throw new PersistenceConflictError('Accepted input changed after the state inference.');
}

export function assertStateSelection(ref: import('./session-state.js').SessionStateItemRef, item: Pick<SessionStateItemRevision,'itemId'|'revisionId'|'deleted'|'contentBytes'> | undefined): void {
  if (item?.itemId !== ref.itemId || item.revisionId !== ref.revisionId || item.deleted)
    throw new Error('Selected session-state revision is unavailable on this branch.');
  if (ref.range && ref.range.offset + ref.range.bytes > item.contentBytes)
    throw new Error('Selected session-state range exceeds its immutable revision.');
}

export function statePageResult(sessionId: string, leafId: string | null, items: readonly SessionStateItemMetadata[], partial: boolean, after: string | undefined, maxBytes: number, revocationRevision=0): import('./session-state.js').SessionStatePage {
  return fitStatePage(items, selected => {
    const incomplete = partial || selected.length < items.length;
    const last = selected.length < items.length ? selected.at(-1)?.itemId : after;
    return Object.freeze({items:Object.freeze([...selected]),coverage:incomplete ? 'partial' as const : 'complete' as const,
      ...(incomplete && last ? {cursor:statePageCursor(sessionId,leafId,last,undefined,revocationRevision)} : {})});
  }, maxBytes);
}

/** Fit whole inventory entries and their actual continuation envelope; never claim zero progress. */
export function fitStatePage<T, P>(items: readonly T[], present: (items: readonly T[]) => P, maxBytes: number): P {
  return fitBoundedJsonPage(items, present, maxBytes, requiredBytes => {
    throw sessionStateLimitError('state_result', maxBytes, requiredBytes,
      `State result requires ${String(requiredBytes)} bytes including its cursor; maxBytes is ${String(maxBytes)}. Retry with maxBytes at least ${String(requiredBytes)} or a smaller selection.`);
  });
}

/** Measure the complete serialized result, including continuation and coverage. */
export function boundedStateResult<T>(result: T, maxBytes: number): T {
  const requiredBytes = Buffer.byteLength(JSON.stringify(result));
  if (requiredBytes > maxBytes) throw sessionStateLimitError('state_result', maxBytes, requiredBytes,
    `State result requires ${String(requiredBytes)} bytes including its cursor; maxBytes is ${String(maxBytes)}. Retry with maxBytes at least ${String(requiredBytes)} or a smaller selection.`);
  return result;
}
