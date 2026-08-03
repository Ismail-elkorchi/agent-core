import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { AgentTuiEventSource, createAgentTuiApp } from '@agent-core/cli/tui';
import { waitFor } from './agent-tui-test-helpers.js';

test('tool activity collapses success, expands failure, and keeps bounded evidence', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 20 } });
  const events = new AgentTuiEventSource();
  const app = createAgentTuiApp('', {
    eventSource: events,
    commandHandler: { execute: () => ({ message: 'Exiting.', exit: true }) }
  });
  const running = runTui(app, host, { initialFocus: { kind: 'element', elementId: 'composer' } });
  await waitFor(() => host.frames().length > 0);

  events.enqueue({ type: 'progress', event: toolStarted('call-ok', 'echo ok') });
  events.enqueue({ type: 'progress', event: toolEnded('call-ok', true, 'Command completed.') });
  events.enqueue({ type: 'progress', event: toolStarted('call-failed', 'false') });
  events.enqueue({ type: 'progress', event: toolEnded('call-failed', false, 'Command failed.') });
  await waitFor(() => host.frames().length > 4);
  host.input('/exit\r');
  const exit = await running;
  events.close();

  const success = exit.state.conversation.items.find((item) => item.id === 'tool:call-ok');
  const failure = exit.state.conversation.items.find((item) => item.id === 'tool:call-failed');
  assert.equal(success.status, 'success');
  assert.equal(failure.status, 'failed');
  assert.ok(!exit.state.conversation.expandedIds.includes(success.id));
  assert.ok(exit.state.conversation.expandedIds.includes(failure.id));
  assert.match(failure.details, /workspace:\/\/command/u);
});

function identity(callId) {
  return { turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, toolBatchId: 'batch-1', callIndex: callId === 'call-ok' ? 0 : 1, callId, toolAttempt: 1 };
}

function toolStarted(callId, command) {
  return {
    type: 'tool.started', ...identity(callId), toolName: 'shell_command',
    input: { id: callId, name: 'shell_command', input: { kind: 'json', value: { command } } },
    fingerprint: `fingerprint-${callId}`,
    effects: { kind: 'execute', resourceScopes: ['workspace://command'], reversible: false, idempotency: 'non_idempotent' }
  };
}

function toolEnded(callId, ok, summary) {
  return {
    type: 'tool.ended', ...identity(callId), toolName: 'shell_command',
    observation: {
      kind: 'result', ok, summary, output: { outcome: ok ? 'exited' : 'runtime_error', command: callId },
      evidence: { items: [{ action: 'execute', resources: [{ uri: 'workspace://command' }], outcome: ok ? 'success' : 'failure' }] }
    }
  };
}
