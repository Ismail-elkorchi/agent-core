import { latestSessionState, assertSessionStateRevision } from './session-state.js';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import type { ContextTransitionCommit, ContextWindowRecord } from '../context/contracts.js';
import { contextEntrySchema } from '../context/schema.js';
import { createContextStateNotice } from '../context/state-notice.js';
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
    sessionState: latestSessionState(branch),
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
  validateContextCommitState(sessionId, {
    leafId: branch.at(-1)?.id ?? null,
    context: [...branch].reverse().find((entry): entry is SessionContextTransitionEntry => entry.type === 'context_transition') ?? null,
    sessionState: latestSessionState(branch),
    refs: new Map(branch.map(entry => [entry.id, hashJson(entry)])),
    finalizations
  }, sourceRevision, input);
}

export function validateContextCommitState(
  sessionId: string,
  source: {
    readonly leafId: string | null;
    readonly context: SessionContextTransitionEntry | null;
    readonly sessionState: import('./session-state.js').SessionStateRevision | null;
    readonly refs: ReadonlyMap<string, string>;
    readonly finalizations: readonly Pick<SessionRunFinalization, 'runId' | 'throughEntryId'>[];
  },
  sourceRevision: number,
  input: ContextTransitionCommit
): void {
  assertSessionStateRevision(source.sessionState, input.expectedSessionStateRevisionId);
  if (input.sessionState) assertSessionStateRevision(source.sessionState, input.sessionState.previousRevisionId);
  const leaf = source.leafId;
  const currentWindowId = source.context?.window.windowId ?? null;
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
  const stateSequence = input.window.stateSequence;
  if (hashJson(stateSequence) !== input.transition.stateSequenceFingerprint)
    throw new Error('Context state sequence fingerprint differs from the admitted state sequence.');
  if (input.transition.strategy === 'fresh' &&
      (stateSequence.parent !== null || stateSequence.notice !== undefined ||
        stateSequence.checkpointRevisionId !== (input.sessionState?.id ?? source.sessionState?.id ?? null) ||
        hashJson(stateSequence.lineage) !== hashJson(cut)))
    throw new Error('Fresh context state sequence does not match its checkpoint and lineage.');
  if (input.transition.strategy === 'append') {
    const previous = source.context;
    const expectedParent = previous
      ? { sessionId, entryId: previous.id, sha256: hashJson(previous) }
      : null;
    if (hashJson(stateSequence.parent) !== hashJson(expectedParent) ||
        stateSequence.checkpointRevisionId !== (previous ? previous.window.stateSequence.checkpointRevisionId : source.sessionState?.id ?? null) ||
        hashJson(stateSequence.lineage) !== hashJson(previous?.window.stateSequence.lineage ?? null) ||
        hashJson(input.window.selection.continuity ?? null) !== hashJson(previous?.window.selection.continuity ?? null))
      throw new Error('Append state sequence must preserve its exact parent, checkpoint and continuation lineage.');
  }
  assertStateNotice(input.transition.strategy, stateSequence, input.sessionState, cut);
  const refs = source.refs;
  if (stateSequence.parent && (stateSequence.parent.sessionId !== sessionId || refs.get(stateSequence.parent.entryId) !== stateSequence.parent.sha256))
    throw new Error('Context state sequence parent is unavailable on this branch.');
  for (const ref of [...input.window.selection.retained, ...(input.window.selection.excerpts ?? []).map(excerpt => excerpt.source)]) {
    const ledger = ref.event
      ? cut.ledgerHeads?.find((head) => head.runId === ref.event?.runId)
      : undefined;
    const finalized =
      ref.event &&
      source.finalizations.some(
        (record) =>
          record.runId === ref.event?.runId &&
          refs.has(record.throughEntryId)
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
      existing.window.reason !== input.window.reason ||
      hashJson(existing.sessionState ? { ...existing.sessionState, id: existing.id } : null) !==
        hashJson(input.sessionState ?? null))
  )
    throw new PersistenceConflictError(
      'Context transition idempotency key has conflicting content.'
    );
  return existing;
}

/** Hashes authenticate record identity, not the relationship between state and its presentation. */
function assertStateNotice(
  strategy: 'append' | 'fresh',
  stateSequence: ContextWindowRecord['stateSequence'],
  state: import('./session-state.js').SessionStateChange | undefined,
  cut: ContextWindowRecord['historyPosition']
): void {
  const expected = strategy === 'append' && state
    ? createContextStateNotice(state.previousRevisionId, state.id, state.content, cut)
    : null;
  if (hashJson(stateSequence.notice ?? null) !== hashJson(expected))
    throw new Error('Context state notice differs from its singular committed state revision.');
  if (strategy === 'fresh' &&
      (stateSequence.parent !== null || stateSequence.notice !== undefined ||
        hashJson(stateSequence.lineage) !== hashJson(cut) ||
        (state !== undefined && stateSequence.checkpointRevisionId !== state.id)))
    throw new Error('Fresh context state sequence does not match its checkpoint and lineage.');
}

/** Decode the current format only. Committed transitions are immutable source records. */
export function decodeContextTransitionEntry(value: unknown): SessionContextTransitionEntry {
  const entry = contextEntrySchema.parse(value);
  assertStateNotice(entry.transition.strategy, entry.window.stateSequence,
    entry.sessionState ? { id: entry.id, ...entry.sessionState } : undefined,
    entry.window.historyPosition);
  if (entry.transition.strategy === 'append' &&
      ((entry.window.stateSequence.parent === null) !== (entry.window.parentWindowId === null) ||
        (entry.window.stateSequence.parent !== null &&
          entry.window.stateSequence.parent.sessionId !== entry.window.historyPosition.sessionId)))
    throw new Error('Append state sequence must reference its preceding context window on the same session.');
  if (
    entry.transition.windowId !== entry.window.windowId ||
    entry.transition.previousWindowId !== entry.window.parentWindowId
  ) {
    throw new Error('Context transition record identities disagree.');
  }
  const fingerprint = hashJson({
    ...(entry.transition.requestedRenewal === undefined ? {} : { renewal: entry.transition.requestedRenewal }),
    ...(entry.sessionState ? { sessionState: { id: entry.id, ...entry.sessionState } } : {}),
    ...(entry.transition.requestedSessionStateRevisionId === undefined
      ? {}
      : {
          expectedSessionStateRevisionId: entry.transition.requestedSessionStateRevisionId
        }),
    expectedWindowId: entry.transition.previousWindowId,
    idempotencyKey: entry.transition.idempotencyKey,
    selection: {
      retained: entry.window.selection.retained,
      ...(entry.window.selection.excerpts ? { excerpts: entry.window.selection.excerpts } : {}),
      ...(entry.window.selection.protected ? { protected: entry.window.selection.protected } : {}),
    },
    reason: entry.window.reason,
    ...(entry.transition.requestedSourceRevision === undefined
      ? {}
      : { expectedSourceRevision: entry.transition.requestedSourceRevision })
  });
  if (hashJson(entry.window.stateSequence) !== entry.transition.stateSequenceFingerprint)
    throw new Error('Context state sequence fingerprint does not match its committed bytes.');
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
