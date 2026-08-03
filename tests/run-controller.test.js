import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLimitExceededError, AgentRunController } from '@agent-core/runtime';

test('planned tool reservations are transactional and expose a non-consumed limit decision', () => {
  const controller = new AgentRunController({ limits: { totalToolCalls: 1 } });
  const calls = [0, 1].map(index => ({ id: String(index), type: 'function', name: 'read', input: { kind: 'json', value: { index } } }));
  assert.throws(() => controller.recordToolCalls(calls), error => {
    assert.ok(error instanceof AgentLimitExceededError);
    assert.equal(error.consumed, false);
    assert.equal(error.attemptedDelta, 2);
    assert.equal(error.previousSnapshot.totalToolCalls, 0);
    assert.equal(error.resultingSnapshot.totalToolCalls, 2);
    return true;
  });
  assert.equal(controller.snapshot().totalToolCalls, 0);
  controller.recordToolCalls(calls.slice(0, 1));
  assert.equal(controller.snapshot().totalToolCalls, 1);
});

test('consumed usage errors expose previous, delta, and resulting snapshots', () => {
  const controller = new AgentRunController({ limits: { promptTokens: 5 } });
  assert.throws(() => controller.recordUsage({ promptTokens: 6, completionTokens: 2, totalTokens: 8 }), error => {
    assert.ok(error instanceof AgentLimitExceededError);
    assert.equal(error.consumed, true);
    assert.equal(error.attemptedDelta, 6);
    assert.equal(error.previousSnapshot.promptTokens, 0);
    assert.equal(error.resultingSnapshot.promptTokens, 6);
    assert.equal(error.resultingSnapshot.completionTokens, 2);
    return true;
  });
  assert.equal(controller.snapshot().promptTokens, 6);
});

test('unknown pricing and mixed currencies are tracked explicitly', () => {
  const controller = new AgentRunController({ limits: { promptTokens: 2_000_000, completionTokens: 2_000_000, knownCost: { amount: 100, currency: 'USD' } } });
  controller.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  assert.equal(controller.snapshot().pricingStatus, 'unknown');
  assert.equal(controller.snapshot().unknownPricedTokens, 150);

  controller.recordUsage({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }, { currency: 'EUR', rates: { input: 2, output: 3 } });
  controller.recordUsage({ promptTokens: 0, completionTokens: 1_000_000, totalTokens: 1_000_000 }, { currency: 'USD', rates: { input: 1, output: 4 } });
  assert.deepEqual(controller.snapshot().knownCosts, { EUR: 2, USD: 4 });
  assert.equal(controller.snapshot().pricingStatus, 'partial');
});

test('approval restart reconstructs repeated-call fingerprints from persisted history', () => {
  const call = { id: 'read-1', type: 'function', name: 'read', input: { kind: 'json', value: { path: 'same.txt' } } };
  const first = new AgentRunController({ limits: { repeatedIdenticalToolCalls: 1 } });
  first.recordToolCalls([call]);
  const restored = new AgentRunController({
    limits: { repeatedIdenticalToolCalls: 1 },
    initialBudget: first.snapshot(),
    initialToolCalls: [call]
  });
  assert.throws(() => restored.recordToolCalls([call]), error => {
    assert.ok(error instanceof AgentLimitExceededError);
    assert.equal(error.limit, 'repeated_tool_calls');
    assert.equal(error.consumed, false);
    return true;
  });
  assert.equal(restored.snapshot().totalToolCalls, 1);
  assert.equal(restored.snapshot().repeatedIdenticalToolCalls, 1);
});
