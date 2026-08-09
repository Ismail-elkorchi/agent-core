import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { AgentTuiEventSource, createAgentTuiApp } from '@agent-core/tui';
import { waitFor } from './agent-tui-test-helpers.js';

test('delayed command effects preserve progress received while the effect is running', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 18 } });
  const events = new AgentTuiEventSource();
  let resolveCommand;
  const commandResult = new Promise((resolve) => { resolveCommand = resolve; });
  const app = createAgentTuiApp('', {
    eventSource: events,
    commandHandler: {
      execute(line) {
        if (line === '/exit') return { message: 'Exiting.', exit: true };
        return commandResult;
      }
    }
  });
  const running = runTui(app, host, { initialFocus: { kind: 'element', elementId: 'composer' } });

  await waitFor(() => host.frames().length > 0);
  host.input('/delayed\r');
  events.enqueue({
    type: 'progress',
    event: {
      type: 'assistant.ended',
      turnIndex: 1,
      turnId: 'turn-1',
      requestAttempt: 1,
      content: 'Progress received during command.',
      candidate: { status: 'complete', message: 'Progress received during command.', source: 'content', turnIndex: 1 }
    }
  });
  await waitFor(() => host.frames().length > 2);
  resolveCommand({ message: 'Delayed command completed.', tone: 'success' });
  await waitFor(() => host.frames().length > 3);
  host.input('/exit\r');
  const exit = await running;
  events.close();

  assert.ok(exit.state.conversation.items.some((item) =>
    item.kind === 'assistant' && item.text === 'Progress received during command.'
  ));
  assert.ok(exit.state.conversation.items.some((item) =>
    item.kind === 'notice' && item.text === 'Delayed command completed.'
  ));
});
