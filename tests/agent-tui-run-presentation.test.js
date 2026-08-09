import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { AgentTuiEventSource, createAgentTuiApp } from '@agent-core/tui';
import { parseAgentTerminalSnapshot } from '@agent-core/runtime';
import { waitFor } from './agent-tui-test-helpers.js';

test('TUI preserves terminal truth and does not duplicate the final answer', async () => {
  const terminal = parseAgentTerminalSnapshot({
    ...base(),
    verificationStatus: 'failed',
    checkResults: [{ id: 'tests', requirement: 'required', verdict: 'failed', summary: 'Tests failed', durationMs: 4 }]
  });
  const { host, events, running } = runProjectionApp();
  await waitFor(() => host.frames().length > 0);
  events.enqueue({
    type: 'progress',
    event: {
      type: 'assistant.ended', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1,
      content: 'Answer.', candidate: { status: 'complete', message: 'Answer.', source: 'content', turnIndex: 1 }
    }
  });
  events.enqueue({ type: 'result', result: { state: 'ended', terminal, deliveryDiagnostics: [] } });
  await waitFor(() => host.frames().length > 2);
  host.input('/exit\r');
  const exit = await running;
  events.close();

  assert.equal(exit.state.run.kind, 'ended');
  assert.equal(exit.state.run.terminal.verificationStatus, 'failed');
  assert.equal(exit.state.conversation.items.filter((item) => item.kind === 'assistant' && item.text === 'Answer.').length, 1);
  assert.ok(exit.state.conversation.items.some((item) => item.kind === 'notice' && item.text === 'Verification failed'));
});

test('advisory check failures remain visible without becoming required failures', async () => {
  const { host, events, running } = runProjectionApp();
  await waitFor(() => host.frames().length > 0);
  events.enqueue({
    type: 'progress',
    event: {
      type: 'check.ended', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1,
      result: { id: 'style', requirement: 'advisory', verdict: 'failed', summary: 'Style issue', durationMs: 3 }
    }
  });
  await waitFor(() => host.frames().length > 1);
  host.input('/exit\r');
  const exit = await running;
  events.close();

  const check = exit.state.conversation.items.find((item) => item.id === 'check:style');
  assert.equal(check.status, 'warning');
  assert.equal(check.summary, 'Style issue');
});

function runProjectionApp() {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 20 } });
  const events = new AgentTuiEventSource();
  const app = createAgentTuiApp('task', {
    eventSource: events,
    commandHandler: { execute: () => ({ message: 'Exiting.', exit: true }) }
  });
  return {
    host,
    events,
    running: runTui(app, host, { initialFocus: { kind: 'element', elementId: 'composer' } })
  };
}

function base() {
  return {
    runId: 'run', finalizationId: 'final', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop',
    candidate: { status: 'complete', message: 'Answer.', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [],
    budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0, providerRetries: 0 }
  };
}
