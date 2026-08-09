import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import type { AgentTuiCommandHandler, AgentTuiCommandRequest } from './command-surface.js';
import type { AgentTuiMessage } from './messages.js';

export function commandEffect(
  request: AgentTuiCommandRequest,
  handler: AgentTuiCommandHandler | undefined
): TuiEffect<AgentTuiMessage> {
  return {
    id: request.id,
    concurrency: 'parallel',
    async run(context) {
      if (context.signal.aborted) return { kind: 'none' };
      const execution = handler === undefined
        ? { message: 'No command handler is attached.', tone: 'error' as const }
        : await handler.execute(request.value);
      return {
        kind: 'message',
        message: { type: 'command.completed', execution, recordResult: request.recordResult }
      };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'command.failed', message: diagnostic.message }
    })
  };
}
