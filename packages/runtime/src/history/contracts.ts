import type { SessionBranchEntry } from '../session/contracts.js';

export interface HistorySearchPosition {
  readonly at: number;
  readonly sequence: number;
  readonly entryId: string;
}
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
  /** Inclusive lower and exclusive upper timestamp bounds. */
  readonly afterTime?: string | undefined;
  readonly beforeTime?: string | undefined;
  readonly sourceType?: SessionBranchEntry['type'] | undefined;
  readonly role?: 'user' | 'assistant' | 'tool' | 'control' | undefined;
  readonly runId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly resource?: string | undefined;
}
/** Every allowance is per call. An empty partial batch is resumable, never a proved miss. */
export interface HistorySearchRequest {
  readonly signal?: AbortSignal;
  /** Posting visits, including false-positive candidates. */
  readonly maxPostings?: number | undefined;
  readonly maxCandidates?: number | undefined;
  /** Source population and stale-tail removal share this rebuild allowance. */
  readonly maxIndexEntries?: number | undefined;
  readonly maxIndexBytes?: number | undefined;
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
  /** Generated interpretations remain distinct from original contributions and evidence. */
  readonly generated?: true;
  readonly source: HistorySourceRef;
  readonly type: SessionBranchEntry['type'];
  readonly role: 'user' | 'assistant' | 'tool' | 'control';
  readonly runId?: string | undefined;
  readonly text: string;
  readonly truncated: boolean;
  readonly completeness?: 'complete' | 'partial' | 'indeterminate' | 'absent' | undefined;
}
export interface HistorySearchResult {
  readonly postings: number;
  readonly candidates: number;
  readonly indexed: number;
  readonly indexBytes: number;
  readonly scannedBytes: number;
  readonly unread?: readonly HistoryUnreadSource[];
  readonly items: readonly HistoryItem[];
  readonly cut: HistorySourceCut;
  readonly coverage: 'complete' | 'partial';
  readonly scanned: number;
  readonly bytes: number;
  readonly cursor?: string | undefined;
}
/** A source was not inspected within this scan's allowance; it is not missing. */
export interface HistoryUnreadSource {
  readonly source: HistorySourceRef;
  readonly reason: 'source_byte_limit' | 'source_record_limit';
  readonly bytes: number;
  readonly records?: number;
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
      /** Chronological context only; no reply relationship is inferred. */
      readonly neighbors: readonly HistoryItem[];
      readonly neighborsCoverage: 'complete' | 'partial';
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
  readonly unread?: readonly HistoryUnreadSource[];
}

/** Small routing facts captured from originals, never a substitute for their bodies. */
export interface HistorySourceMetadata {
  readonly inputAuthorship?: 'model' | 'host';
  readonly source: HistorySourceRef;
  readonly type: SessionBranchEntry['type'];
  readonly description: string;
  readonly sourceBytes: number;
  readonly runId?: string;
  readonly exchangeId?: string;
  readonly callIndex?: number;
  readonly toolBatchId?: string;
  readonly expectedCalls?: number;
  readonly prefixBound?: boolean;
  readonly contextRecovery?: true;
}
/** A continuation cursor requires the cut returned by its preceding metadata page. */
export type HistoryMetadataPageRequest = Omit<HistoryEntryPageRequest, 'originals' | 'enrich'>;
export interface HistoryMetadataPage {
  readonly items: readonly HistorySourceMetadata[];
  readonly cut: HistorySourceCut;
  readonly coverage: 'complete' | 'partial';
  readonly scanned: number;
  readonly bytes: number;
  readonly cursor?: string;
}

/** Newest-first original contributions. Defaults to user-authored input and steering when filter is omitted. */
export interface HistoryLatestRequest {
  readonly signal?: AbortSignal | undefined;
  readonly cut?: HistorySourceCut | undefined;
  readonly cursor?: string | undefined;
  readonly filter?: HistoryFilter | undefined;
  readonly limit?: number | undefined;
  readonly maxBytes?: number | undefined;
  /** Maximum journal positions inspected, including nonmatching records. */
  readonly maxScanned?: number | undefined;
  readonly maxScannedBytes?: number | undefined;
}
export interface HistoryLatestResult {
  readonly items: readonly HistoryItem[];
  readonly cut: HistorySourceCut;
  readonly coverage: 'complete' | 'partial';
  readonly scanned: number;
  readonly scannedBytes: number;
  readonly bytes: number;
  readonly cursor?: string;
  readonly unread?: readonly HistoryUnreadSource[];
}

/** Exact UTF-8 span of an original contribution's text, never provider-native state. */
export interface HistorySourceExcerpt {
  readonly source: HistorySourceRef;
  readonly offset: number;
  readonly bytes: number;
}
export interface HistoryExcerptItem {
  readonly excerpt: HistorySourceExcerpt;
  readonly text: string;
  readonly type: SessionBranchEntry['type'];
  readonly role: HistoryItem['role'];
}
