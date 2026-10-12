/** Explicit, cancellable reconstruction of metadata from the original session ledger. */
export interface HistoryIndexRebuildOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly records: number;
    readonly bytes: number;
    readonly totalBytes: number;
  }) => void;
}

/** Metadata is unavailable; the original ledger must be validated by explicit repair. */
export class SessionHistoryIndexError extends Error {
  constructor(readonly sessionId: string, detail: string, options?: ErrorOptions) {
    super(
      `Session ${JSON.stringify(sessionId)} history index ${detail}. Its derived metadata needs recovery; original history has not been changed.`,
      options
    );
    this.name = 'SessionHistoryIndexError';
  }
}

/** Rebuilding metadata cannot fix invalid or incompatible original records. */
export class SessionHistorySourceError extends Error {
  constructor(readonly sessionId: string, detail: string, options?: ErrorOptions) {
    super(
      `Session ${JSON.stringify(sessionId)} original history could not be decoded or validated: ${detail} History-index recovery stopped; original data has not been changed.`,
      options
    );
    this.name = 'SessionHistorySourceError';
  }
}

/** Application-observed recovery of derived metadata; original history is never changed. */
export type HistoryIndexRecoveryProgress =
  | { readonly phase: 'started' | 'completed'; readonly sessionId: string }
  | { readonly phase: 'progress'; readonly sessionId: string; readonly records: number;
      readonly bytes: number; readonly totalBytes: number }
  | { readonly phase: 'cancelled' | 'failed'; readonly sessionId: string; readonly message: string };

export interface HistoryIndexRecoveryOptions {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: HistoryIndexRecoveryProgress) => void;
}

/** Publication succeeded, but its durability or final verification could not be confirmed. */
export class SessionHistoryIndexPublicationError extends Error {
  readonly indexPublished = true;

  constructor(readonly sessionId: string, cause: unknown) {
    super(
      `Session ${JSON.stringify(sessionId)} recovered history index was published, but durability or verification could not be confirmed. Original history is unchanged.`,
      { cause }
    );
    this.name = 'SessionHistoryIndexPublicationError';
  }
}
