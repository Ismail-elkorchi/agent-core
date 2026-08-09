import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createAgentTuiApp } from '@agent-core/tui';

test('composer sends with Enter and inserts newlines with Shift+Enter and Ctrl+O', async () => {
  const submitted = [];
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 16 } });
  const runtime = createTuiRuntime({
    app: createAgentTuiApp('', {
      commandHandler: { execute(line) { submitted.push(line); return { message: 'Run started.' }; } }
    }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();

  await runtime.handleInput({ kind: 'text', text: 'first', paste: false });
  await runtime.handleInput(key('enter', { shift: true }));
  await runtime.handleInput({ kind: 'text', text: 'second', paste: false });
  await runtime.handleInput(key('o', { ctrl: true }));
  await runtime.handleInput({ kind: 'text', text: 'third', paste: false });
  assert.equal(textDocumentText(runtime.state().composer.input.document), 'first\nsecond\nthird');

  await runtime.handleInput(key('enter'));
  await waitFor(() => submitted.length === 1);
  assert.deepEqual(submitted, ['first\nsecond\nthird']);
  assert.equal(textDocumentText(runtime.state().composer.input.document), '');
  await runtime.dispose();
});

function key(name, modifiers = {}) {
  return {
    kind: 'key', key: name, eventType: 'press', location: 'standard',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
  };
}

async function waitFor(condition) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for command effect.');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('approval dialogs focus Deny and Escape also denies', async () => {
  const decisions = [];
  const host = createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 20 } });
  const suspension = approvalSuspension();
  const runtime = createTuiRuntime({
    app: createAgentTuiApp('', {
      approvalHandler(_suspension, decision) {
        decisions.push(decision);
        return Promise.resolve(suspension);
      }
    }),
    host,
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  await runtime.start();
  await runtime.dispatch({ type: 'approval.required', suspension });
  await runtime.handleInput(key('enter'));
  await waitFor(() => decisions.length === 1);
  assert.equal(decisions[0], 'deny');

  await runtime.handleInput(key('escape'));
  await waitFor(() => decisions.length === 2);
  assert.equal(decisions[1], 'deny');
  await runtime.dispose();
});

function approvalSuspension() {
  return {
    state: 'suspended', reason: 'approval_required', runId: 'run', finalizationId: 'final',
    pendingApprovals: [{
      runId: 'run', approvalId: 'approval', status: 'pending', toolName: 'exec_command',
      fingerprint: 'fingerprint', input: { command: 'echo ok' },
      effects: { accesses: [{ mode: 'execute', scope: 'workspace/command' }], lockScopes: ['workspace/command'], idempotency: 'non_idempotent' },
      binding: { toolImplementationId: 'shell@1', authorizationPolicyId: 'policy@1', executionTargetId: 'workspace@1' },
      policyHash: 'policy-hash', reason: 'Shell execution requires approval.',
      turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, toolBatchId: 'batch-1', callIndex: 0, callId: 'call-1'
    }],
    budget: { modelTurns: 1, totalToolCalls: 1, repeatedIdenticalToolCalls: 1, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0, providerRetries: 0 }
  };
}
