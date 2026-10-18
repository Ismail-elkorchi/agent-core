import type { HistorySourceCut, HistorySourceRef, HistorySourceExcerpt, HistorySourceMetadata } from '../history/contracts.js';
import type { SessionStateBatchCommit, SessionStateItemRef } from '../session/session-state.js';

export type ContextArtifactSelection =
  | { readonly artifact: import('@agent-core/persistence').PublicArtifactRef; readonly representation: 'reference' }
  | { readonly artifact: import('@agent-core/persistence').PublicArtifactRef; readonly representation: 'text';
      readonly range?: { readonly offset: number; readonly bytes: number } | undefined };

export interface ContextSourceSelection {
  readonly sessionState?: readonly SessionStateItemRef[] | undefined;
  readonly artifacts?: readonly ContextArtifactSelection[] | undefined;
  /** Exact historical text evidence, not conversational or native protocol replay. */
  readonly excerpts?: readonly HistorySourceExcerpt[] | undefined;
  /** Explicit host/user retention across subsequent renewals. */
  readonly protected?: readonly HistorySourceRef[] | undefined;
  readonly retained: readonly HistorySourceRef[];
}
/** Runtime-owned persisted selection and provider continuation lineage. */
export interface ContextSelection extends ContextSourceSelection {
  readonly continuity?:
    | {
        readonly kind: 'fresh';
        readonly historyPosition: HistorySourceCut;
        readonly resetId: string;
        readonly model: import('@agent-core/model').ModelSelection;
        readonly sources: readonly HistorySourceRef[];
      }
    | undefined;
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
  readonly strategy: 'append' | 'fresh';
  readonly cause: 'state_update' | 'selection_change' | 'explicit_renewal' | 'capacity' | 'prefix_incompatibility';
  readonly requestedRenewal?: boolean | undefined;
  readonly admission:
    { readonly status: 'admitted'; readonly compiledInputIdentity: string; readonly capabilityRevision: string };
  readonly transitionId: string;
  readonly idempotencyKey: string;
  readonly previousWindowId: string | null;
  readonly windowId: string;
  readonly requestFingerprint: string;
  readonly selectionFingerprint: string;
  readonly requestedSourceRevision?: number | undefined;
  readonly committedAt: string;
}
/** Activation owns the exact admitted view read set. Unlike independent item saves, it never rebases across a changed source/window boundary. */
export interface ContextTransitionCommit {
  readonly sessionState?: SessionStateBatchCommit | undefined;
  readonly expectedLeafId: string | null;
  readonly expectedSourceRevision: number;
  readonly expectedWindowId: string | null;
  readonly window: ContextWindowRecord;
  readonly transition: ContextTransitionRecord;
}
export interface ContextTransitionRequest {
  /** Deliberately replace the provider continuation even when content is unchanged. */
  readonly renewal?: boolean | undefined;
  readonly expectedCut?: HistorySourceCut | undefined;
  readonly sessionState?: SessionStateBatchCommit | undefined;
  readonly toolInvocation?:
    | Pick<
        import('@agent-core/tools').ToolInvocationContext,
        'runId' | 'turnId' | 'requestAttempt' | 'toolBatchId' | 'callIndex' | 'toolAttempt'
      >
    | undefined;
  readonly expectedWindowId: string | null;
  readonly expectedSourceRevision?: number | undefined;
  readonly idempotencyKey: string;
  readonly selection: ContextSourceSelection;
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

export interface ContextTransitionUnchanged {
  readonly status: 'unchanged';
  readonly windowId: string | null;
}
