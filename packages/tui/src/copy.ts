import type { TextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import { extractTextDocumentSelection, sanitizeTerminalText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';

export function selectedSource(input: TextAreaState | undefined): string | undefined {
  return input === undefined ? undefined : extractTextDocumentSelection({ ...input, sanitize: false });
}

export function copySource<Message>(
  text: string,
  report: (message: string) => Message
): TuiEffect<Message> {
  return {
    id: 'copy-source',
    concurrency: 'replace',
    async run(context) {
      // The installed clipboard API applies display normalization even inside its encoded payload.
      if (sanitizeTerminalText(text).text !== text)
        return {
          kind: 'message',
          message: report(
            'Exact copy is unavailable: terminal-ui would alter this source. The original remains in the source reader.'
          )
        };
      const result = await context.copySelectedText({
        policy: { allowed: true },
        selection: { sourceId: 'source-selection', text }
      });
      return {
        kind: 'message',
        message: report(
          result.status === 'copied' ? 'Source sent to clipboard.' : result.diagnostic.message
        )
      };
    }
  };
}
