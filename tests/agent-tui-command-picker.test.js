import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createAgentTuiApp, runAgentTuiApp } from '@agent-core/cli/tui';
import { plainOutput, waitFor } from './agent-tui-test-helpers.js';

test('Ctrl+P opens the concise command picker and executes a selected command', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 16 } });
  const run = runAgentTuiApp(fakeAgent(), { host });

  await waitFor(() => host.frames().length > 0);
  host.input('\x10');
  await waitFor(() => /Commands/u.test(plainOutput(host)));
  assert.match(plainOutput(host), /\/exit/u);
  assert.doesNotMatch(plainOutput(host), /\/state\b/u);
  host.input('status\r');
  await waitFor(() => /Idle · test-model/u.test(plainOutput(host)));
  host.input('/exit\r');
  const result = await run;

  assert.equal(result.exit.status, 'completed');
  assert.ok(result.exit.state.conversation.items.some((item) => item.kind === 'notice' && item.text.includes('test-model')));
});

test('Escape closes the command picker without cancelling the app', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 18 } });
  const runtime = createTuiRuntime({
    app: createAgentTuiApp('', { commandHandler: { execute: () => ({ message: 'done' }) } }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await runtime.handleInput(key('p', { ctrl: true }));
  assert.equal(runtime.state().overlay.kind, 'commands');
  await runtime.handleInput(key('escape'));
  assert.equal(runtime.state().overlay.kind, 'none');
  assert.equal(runtime.exit(), undefined);
  await runtime.dispose();
});

test('the normal frame contains conversation, composer, and compact chrome only', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 96, rows: 18 } });
  const run = runAgentTuiApp(fakeAgent(), { host, runtimeDetails: { modelId: 'test-model' } });

  await waitFor(() => host.frames().length > 0);
  const output = plainOutput(host);
  assert.match(output, /Agent Core/u);
  assert.match(output, /Send a message/u);
  assert.doesNotMatch(output, /Run activity|Work log|Inspector|Session replay/u);
  host.input('/exit\r');
  await run;
});

function fakeAgent() {
  return {
    runtimeState() {
      return {
        active: false,
        model: 'test-model',
        queuedSteers: 0,
        queuedFollowUps: 0,
        queuedRetries: 0
      };
    }
  };
}

function key(name, modifiers = {}) {
  return {
    kind: 'key', key: name, eventType: 'press', location: 'standard',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
  };
}
