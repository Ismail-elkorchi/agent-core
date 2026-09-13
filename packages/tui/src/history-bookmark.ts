import type { SessionBranchCursor, SessionBranchEntry, SessionBranchPage } from '@agent-core/runtime';
import type { MeasuredWindowAnchor } from '@ismail-elkorchi/terminal-ui/collection';

export interface HistoryBookmark {
  readonly cursor?: SessionBranchCursor;
  readonly anchor?: MeasuredWindowAnchor;
  readonly followTail: boolean;
}

/** Store source positions instead of retaining rendered pages for inactive sessions. */
export function historyBookmark(
  pages: readonly SessionBranchPage[],
  anchor: MeasuredWindowAnchor | undefined,
  followTail: boolean,
  identify: (entry: SessionBranchEntry) => string
): HistoryBookmark {
  if (!followTail && anchor !== undefined)
    for (const page of pages) {
      const entry = page.entries.find((entry) => identify(entry) === anchor.itemId);
      if (entry !== undefined)
        return { cursor: { boundary: page.boundary, entryId: entry.id }, anchor, followTail };
    }
  return { followTail };
}
