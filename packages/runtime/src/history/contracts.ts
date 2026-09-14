import type { SessionBranchEntry } from '../session/contracts.js';

export interface HistorySourceCut {
  readonly format: 'agent-core.history/1';
  readonly sessionId: string;
  readonly branchId: string;
  readonly throughEntryId: string | null;
  readonly sourceRevision: number;
  readonly ledgerCoverage: 'authoritative' | 'session';
  readonly ledgerHeads?: readonly HistoryLedgerHead[] | undefined;
}
export interface HistorySourceRef {
  readonly sessionId: string;
  readonly entryId: string;
  readonly sha256: string;
  readonly event?: HistoryEventSource | undefined;
}
export interface HistoryFilter {
  readonly sourceType?: SessionBranchEntry['type'] | undefined;
  readonly role?: 'user' | 'assistant' | 'tool' | 'control' | undefined;
  readonly runId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly resource?: string | undefined;
}
export interface HistorySearchRequest {
  readonly maxScannedBytes?: number | undefined;
  readonly query?: string | undefined;
  readonly filter?: HistoryFilter | undefined;
  readonly cut?: HistorySourceCut | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxScanned?: number | undefined;
}
export interface HistoryItem {
  readonly source: HistorySourceRef;
  readonly type: SessionBranchEntry['type'];
  readonly role: 'user' | 'assistant' | 'tool' | 'control';
  readonly runId?: string | undefined;
  readonly text: string;
  readonly truncated: boolean;
  readonly completeness?: 'complete' | 'partial' | 'indeterminate' | 'absent' | undefined;
}
export interface HistorySearchResult {
  readonly scannedBytes: number;
  readonly unavailable?: readonly {
    readonly source: HistorySourceRef;
    readonly bytes: number;
    readonly records?: number;
  }[];
  readonly items: readonly HistoryItem[];
  readonly cut: HistorySourceCut;
  readonly indexWatermark: HistorySourceCut;
  readonly index?: {
    readonly sources: number;
    readonly bytes: number;
    readonly terms: number;
    readonly coverage: 'complete' | 'partial';
  };
  readonly coverage: 'complete' | 'partial';
  readonly scanned: number;
  readonly bytes: number;
  readonly cursor?: string | undefined;
}
export interface HistoryReadRequest {
  readonly maxSourceBytes?: number | undefined;
  readonly source: HistorySourceRef;
  readonly cut?: HistorySourceCut | undefined;
  readonly offset?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly neighbors?: number | undefined;
}
export type HistoryReadResult =
  | Readonly<{
      readonly status: 'available';
      readonly item: HistoryItem;
      readonly offset: number;
      readonly nextOffset: number;
      readonly totalBytes: number;
      readonly neighbors: readonly HistoryItem[];
      readonly cut: HistorySourceCut;
    }>
  | Readonly<{
      readonly status: 'unavailable';
      readonly reason: 'outside_scope' | 'missing' | 'identity_mismatch' | 'source_too_large';
      readonly bytes?: number;
      readonly source: HistorySourceRef;
    }>;

export interface HistoryEventSource {
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly hash: string;
}
export interface HistoryLedgerHead {
  readonly runId: string;
  readonly sequence: number;
  readonly hash?: string | undefined;
}

export interface HistoryEntryPageRequest {
  /** Resolve bounded original observation artifacts as well as event/session records. */
  readonly originals?: boolean;
  /** Include related recorded representations and accepted input attachments. */
  readonly enrich?: boolean;
  readonly cut?: HistorySourceCut | undefined;
  readonly after?: HistorySourceCut | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly filter?: HistoryFilter | undefined;
}
export interface HistoryEntryPage {
  readonly entries: readonly SessionBranchEntry[];
  readonly cut: HistorySourceCut;
  readonly coverage: 'complete' | 'partial';
  readonly scanned: number;
  readonly bytes: number;
  readonly cursor?: string;
  readonly unavailable?: readonly {
    readonly source: HistorySourceRef;
    readonly bytes: number;
    readonly records?: number;
  }[];
}
