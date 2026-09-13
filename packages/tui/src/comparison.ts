import type { InlineContent } from '@ismail-elkorchi/terminal-ui/components';
import { diffWordsWithSpace } from 'diff';

/** Review segmentation is derived; original source and revision bindings remain unchanged. */
export function compareText(
  before: string,
  after: string
): { readonly segments: InlineContent; readonly failure?: string } {
  const changes = diffWordsWithSpace(before, after, { timeout: 30, maxEditLength: 10_000 });
  if (changes === undefined)
    return {
      segments: [],
      failure:
        'Word comparison exceeded its presentation budget. Inspect the original and proposed sources.'
    };
  return {
    segments: changes.map((change) => ({
      kind: 'text',
      text: change.value,
      style: change.added
        ? { underline: true, fg: { kind: 'theme', token: 'status.success' } }
        : change.removed
          ? { strikethrough: true, fg: { kind: 'theme', token: 'status.error' } }
          : {}
    }))
  };
}
