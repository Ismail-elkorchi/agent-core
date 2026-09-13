import type { SessionBranchSearchRequest, SessionBranchSearchResult } from '../index.js';

/** Read bounded pages until a match batch or the end of the selected branch. */
export async function findBranchMatches(
  search: (request: SessionBranchSearchRequest) => Promise<SessionBranchSearchResult>,
  request: SessionBranchSearchRequest,
  signal: AbortSignal
): Promise<SessionBranchSearchResult> {
  for (;;) {
    signal.throwIfAborted();
    const result = await search(request);
    signal.throwIfAborted();
    if (result.oversizedEntry !== undefined || result.matches.length > 0 || result.older === undefined)
      return result;
    request = {
      query: request.query,
      cursor: result.older,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes })
    };
  }
}
