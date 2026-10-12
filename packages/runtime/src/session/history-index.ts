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
  constructor(readonly sessionId: string | undefined, detail: string, options?: ErrorOptions) {
    super(
      'This conversation couldn’t be opened. Please try again.',
      { cause: new Error(detail, options) }
    );
    this.name = 'SessionHistoryIndexError';
  }
}

/** Rebuilding metadata cannot fix invalid or incompatible original records. */
export class SessionHistorySourceError extends Error {
  constructor(readonly sessionId: string, detail: string, options?: ErrorOptions) {
    super(
      'This conversation couldn’t be opened because its saved messages couldn’t be read. Its data hasn’t been changed.',
      { cause: new Error(detail, options) }
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
      'This conversation couldn’t finish opening because a save couldn’t be confirmed.',
      { cause }
    );
    this.name = 'SessionHistoryIndexPublicationError';
  }
}
