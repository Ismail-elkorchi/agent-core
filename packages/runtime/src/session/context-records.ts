import { parseJsonObject } from '@agent-core/json';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import type { ContextTransitionCommit, ContextWindowRecord } from '../context/contracts.js';
import { contextEntrySchema } from '../context/schema.js';
import { scopeSchema } from '../history/schema.js';
import type {
  SessionBranchEntry,
  SessionContextTransitionEntry,
  SessionDescriptor,
  SessionReplayState,
  SessionRunFinalization
} from './contracts.js';

export function sessionReplayState(
  session: SessionDescriptor,
  branch: readonly SessionBranchEntry[],
  finalizations: readonly SessionRunFinalization[],
  sourceRevision: number
): SessionReplayState {
  const branchIds = new Set(branch.map((entry) => entry.id));
  const runFinalizations = Object.freeze(
    finalizations.filter((record) => branchIds.has(record.throughEntryId))
  );
  const ended = new Set(runFinalizations.map((record) => record.runId));
  const unfinished = branch.flatMap((entry) =>
    entry.type === 'input' && !ended.has(entry.runId) ? [entry.runId] : []
  );
  const latest = runFinalizations.at(-1)?.runId;
  const contextWindow = latestContextWindow(branch);
  return Object.freeze({
    session,
    branch: Object.freeze([...branch]),
    runFinalizations,
    sourceRevision,
    ledgerRunIds: Object.freeze([...new Set([...unfinished, ...(latest ? [latest] : [])])]),
    ...(contextWindow ? { contextWindow } : {})
  });
}
export function latestContextWindow(
  branch: readonly SessionBranchEntry[]
): ContextWindowRecord | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === 'context_transition') return entry.window;
  }
  return undefined;
}
export function validateContextCommit(
  sessionId: string,
  branch: readonly SessionBranchEntry[],
  sourceRevision: number,
  input: ContextTransitionCommit,
  finalizations: readonly SessionRunFinalization[] = []
): void {
  const leaf = branch.at(-1)?.id ?? null;
  const currentWindowId = latestContextWindow(branch)?.windowId ?? null;
  if (
    input.expectedLeafId !== leaf ||
    input.expectedSourceRevision !== sourceRevision ||
    input.expectedWindowId !== currentWindowId
  ) {
    throw new PersistenceConflictError(
      'Context transition is stale: accepted input, branch, or context changed. Capture a new source cut and revalidate.'
    );
  }
  const cut = input.window.historyPosition;
  if (
    cut.sessionId !== sessionId ||
    cut.throughEntryId !== leaf ||
    cut.sourceRevision !== sourceRevision ||
    input.window.parentWindowId !== currentWindowId ||
    input.transition.previousWindowId !== currentWindowId ||
    input.transition.windowId !== input.window.windowId
  )
    throw new Error('Context transition identities do not match its captured boundary.');
  const refs = new Map(branch.map((entry) => [entry.id, hashJson(entry)]));
  for (const ref of input.window.selection.retained) {
    const ledger = ref.event
      ? cut.ledgerHeads?.find((head) => head.runId === ref.event?.runId)
      : undefined;
    const finalized =
      ref.event &&
      finalizations.some(
        (record) =>
          record.runId === ref.event?.runId &&
          branch.some((entry) => entry.id === record.throughEntryId)
      );
    const eventCovered =
      ref.sha256 === ref.event?.hash &&
      (finalized === true || (ledger !== undefined && ref.event.sequence <= ledger.sequence));
    if (ref.sessionId !== sessionId || (!eventCovered && refs.get(ref.entryId) !== ref.sha256))
      throw new Error('Context retained source is unavailable or outside the branch.');
  }
}
export function contextCommitRetry(
  entries: readonly SessionBranchEntry[],
  input: ContextTransitionCommit
): SessionContextTransitionEntry | undefined {
  const existing = entries.find(
    (entry): entry is SessionContextTransitionEntry =>
      entry.type === 'context_transition' &&
      entry.transition.idempotencyKey === input.transition.idempotencyKey
  );
  if (
    existing &&
    (existing.transition.requestFingerprint !== input.transition.requestFingerprint ||
      hashJson(existing.window.selection) !== hashJson(input.window.selection) ||
      existing.window.reason !== input.window.reason)
  )
    throw new PersistenceConflictError(
      'Context transition idempotency key has conflicting content.'
    );
  return existing;
}

/** Decode the current format only. Committed transitions are immutable source records. */
export function decodeContextTransitionEntry(value: unknown): SessionContextTransitionEntry {
  const entry = contextEntrySchema.parse(value);
  if (
    entry.transition.windowId !== entry.window.windowId ||
    entry.transition.previousWindowId !== entry.window.parentWindowId
  ) {
    throw new Error('Context transition record identities disagree.');
  }
  const fingerprint = hashJson({
    expectedWindowId: entry.transition.previousWindowId,
    idempotencyKey: entry.transition.idempotencyKey,
    selection: {
      retained: entry.window.selection.retained,
      notes: entry.window.selection.notes,
      strategy: entry.window.selection.strategy,
      ...(entry.window.selection.protected ? { protected: entry.window.selection.protected } : {}),
      ...(entry.window.selection.continuity
        ? { continuity: entry.window.selection.continuity }
        : {})
    },
    reason: entry.window.reason,
    ...(entry.transition.requestedSourceRevision === undefined
      ? {}
      : { expectedSourceRevision: entry.transition.requestedSourceRevision })
  });
  if (hashJson(entry.window.selection) !== entry.transition.selectionFingerprint)
    throw new Error(
      'Context selected provider state fingerprint does not match its committed window.'
    );
  if (fingerprint !== entry.transition.requestFingerprint)
    throw new Error(
      'Context transition request fingerprint does not match its committed selection.'
    );
  return entry;
}

export function ownBranchNoteSource(
  value: unknown
): NonNullable<import('./contracts.js').SessionBranchMarkerEntry['noteSource']> {
  const source = parseJsonObject(value);
  const scope = scopeSchema.parse(source.scope);
  if (
    typeof source.watermark !== 'number' ||
    !Number.isSafeInteger(source.watermark) ||
    source.watermark < -1
  )
    throw new Error('Invalid branch note source revision.');
  return Object.freeze({ scope, watermark: source.watermark });
}
