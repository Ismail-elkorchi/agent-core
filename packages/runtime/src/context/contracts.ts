import type { JsonObject } from '@agent-core/json';
import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import type { NoteReference } from '../notes/contracts.js';

export interface ContextSelection {
  /** Explicit host/user retention across subsequent renewals. */
  readonly protected?: readonly HistorySourceRef[] | undefined;
  readonly continuity?:
    | {
        readonly kind: 'fresh';
        readonly resetId: string;
        readonly model: import('@agent-core/model').ModelSelection;
        readonly sources: readonly HistorySourceRef[];
      }
    | undefined;

  readonly retained: readonly HistorySourceRef[];
  readonly notes: readonly NoteReference[];
  readonly strategy: 'sources' | 'provider';
  readonly providerState?: JsonObject | undefined;
}
export interface ContextWindowRecord {
  readonly windowId: string;
  readonly parentWindowId: string | null;
  readonly historyPosition: HistorySourceCut;
  readonly selection: ContextSelection;
  readonly reason: string;
  readonly createdAt: string;
}
export interface ContextTransitionRecord {
  readonly compiledInputIdentity?: string | undefined;
  readonly capabilityRevision?: string | undefined;
  readonly transitionId: string;
  readonly idempotencyKey: string;
  readonly previousWindowId: string | null;
  readonly windowId: string;
  readonly requestFingerprint: string;
  readonly selectionFingerprint: string;
  readonly requestedSourceRevision?: number | undefined;
  readonly committedAt: string;
}
export interface ContextTransitionCommit {
  readonly expectedLeafId: string | null;
  readonly expectedSourceRevision: number;
  readonly expectedWindowId: string | null;
  readonly window: ContextWindowRecord;
  readonly transition: ContextTransitionRecord;
}
export interface ContextTransitionRequest {
  readonly toolInvocation?:
    | Pick<
        import('@agent-core/tools').ToolInvocationContext,
        'runId' | 'turnId' | 'requestAttempt' | 'toolBatchId' | 'callIndex' | 'toolAttempt'
      >
    | undefined;
  readonly expectedWindowId: string | null;
  readonly expectedSourceRevision?: number | undefined;
  readonly idempotencyKey: string;
  readonly selection: ContextSelection;
  readonly reason: string;
}
