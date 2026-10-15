import type { HistorySourceCut, HistorySourceRef, HistorySourceExcerpt, HistorySourceMetadata } from '../history/contracts.js';
import type { SessionStateChange } from '../session/session-state.js';

export interface ContextSelection {
  /** Exact historical text evidence, not conversational or native protocol replay. */
  readonly excerpts?: readonly HistorySourceExcerpt[] | undefined;
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
  readonly admission:
    { readonly status: 'admitted'; readonly compiledInputIdentity: string; readonly capabilityRevision: string };
  readonly transitionId: string;
  readonly idempotencyKey: string;
  readonly previousWindowId: string | null;
  readonly windowId: string;
  readonly requestFingerprint: string;
  readonly selectionFingerprint: string;
  readonly requestedSourceRevision?: number | undefined;
  readonly requestedSessionStateRevisionId?: string | null | undefined;
  readonly committedAt: string;
}
export interface ContextTransitionCommit {
  readonly expectedSessionStateRevisionId: string | null;
  readonly sessionState?: SessionStateChange | undefined;
  readonly expectedLeafId: string | null;
  readonly expectedSourceRevision: number;
  readonly expectedWindowId: string | null;
  readonly window: ContextWindowRecord;
  readonly transition: ContextTransitionRecord;
}
export interface ContextTransitionRequest {
  readonly expectedCut?: HistorySourceCut | undefined;
  readonly sessionState?: SessionStateChange | undefined;
  readonly expectedSessionStateRevisionId?: string | null | undefined;
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

/** One bounded inventory page; group facts never replace transition validation. */
export interface ContextSourceManifest {
  readonly status: 'available';
  readonly cut: HistorySourceCut;
  readonly offset: number;
  readonly items: readonly {
    readonly source: HistorySourceRef;
    readonly type: HistorySourceMetadata['type'];
    readonly description: string;
    readonly sourceBytes: number;
    readonly group: {
      readonly id: string;
      readonly prefixBound: boolean | 'unknown';
      readonly release: 'requires_validation' | 'protected' | 'unfinished_exchange';
    };
  }[];
  readonly coverage: 'complete' | 'partial';
  readonly cursor?: string;
  readonly releaseMeaning: string;
}
