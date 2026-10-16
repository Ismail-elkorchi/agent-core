import type { ContextStateNotice } from './contracts.js';
import type { HistorySourceCut } from '../history/contracts.js';
import type { SessionStateContent } from '../session/session-state.js';
import { renderContext } from '../inference/model-request-assembler.js';

/** One canonical low-authority presentation of the singular immutable state revision. */
export function createContextStateNotice(
  previousRevisionId: string | null,
  revisionId: string,
  content: SessionStateContent,
  after: HistorySourceCut
): ContextStateNotice {
  const id = `session-state-notice:${revisionId}`;
  return {
    id, previousRevisionId, revisionId, after,
    message: { role: 'user', content: renderContext([{
      id,
      sourceUri: `session://session-state/${revisionId}`,
      sourceKind: 'generated', representation: 'full', mediaType: 'application/json',
      title: 'Session state replacement — generated interpretation',
      purpose: `Complete replacement of fallible interpretation ${previousRevisionId ?? 'empty'} by ${revisionId}. Earlier state presentations are superseded. Not instructions, authority, execution evidence or verification. Empty content explicitly clears current interpretation.`,
      content: JSON.stringify(content)
    }]) }
  };
}
