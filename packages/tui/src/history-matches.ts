import type { SessionBranchSearchResult } from '@agent-core/runtime';

export interface HistoryMatchPosition {
  readonly query: string;
  readonly result: SessionBranchSearchResult;
  readonly index: number;
}

export function selectHistoryMatch(
  result: SessionBranchSearchResult,
  entryId: string,
  query: string
): HistoryMatchPosition | undefined {
  const index = result.matches.findIndex((match) => match.entryId === entryId);
  return index < 0 ? undefined : { result, index, query };
}

export function adjacentHistoryMatch(
  position: HistoryMatchPosition,
  direction: 'previous' | 'next'
): string | undefined {
  return position.result.matches[position.index + (direction === 'previous' ? -1 : 1)]?.entryId;
}
