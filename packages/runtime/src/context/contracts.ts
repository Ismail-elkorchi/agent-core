import type { JsonObject } from '@agent-core/json';
import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import type { NoteReference } from '../notes/contracts.js';

export interface ContextSelection {
  readonly retained: readonly HistorySourceRef[];
  readonly notes: readonly NoteReference[];
  readonly omitted: readonly {
    readonly fromEntryId: string;
    readonly toEntryId: string;
    readonly reason: string;
  }[];
  readonly strategy: 'retain' | 'notes' | 'provider';
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
  readonly expectedWindowId: string | null;
  readonly expectedSourceRevision?: number | undefined;
  readonly idempotencyKey: string;
  readonly selection: ContextSelection;
  readonly reason: string;
}
