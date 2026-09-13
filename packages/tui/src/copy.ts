import type { TextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import { extractTextDocumentSelection } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';

export function selectedSource(input: TextAreaState | undefined): string | undefined {
  return input === undefined ? undefined : extractTextDocumentSelection({ ...input, sanitize: false });
}

export function copySource<Message>(text: string, report: (message: string) => Message): TuiEffect<Message> {
  return {
    id: 'copy-source',
    concurrency: 'replace',
    async run(context) {
      const result = await context.copySelectedText({
        policy: { allowed: true },
        selection: { sourceId: 'source-selection', text }
      });
      return {
        kind: 'message',
        message: report(result.status === 'copied' ? 'Source sent to clipboard.' : result.diagnostic.message)
      };
    }
  };
}
