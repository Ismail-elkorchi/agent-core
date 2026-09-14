import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentLimitExceededError,
  AgentRunBudget,
  AgentRunCoordinator,
  agentEventCodec
} from '@agent-core/runtime';
import { InMemoryEventRepository, InMemoryArtifactRepository } from '@agent-core/persistence';

async function fixture(limits) {
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const runs = new AgentRunCoordinator(events, artifacts);
  await runs.accept({
    runId: 'budget-run',
    finalizationId: 'budget-final',
    input: { task: 'test', instructions: [], contextItems: [] },
    configuration: {
      providerId: 'test',
      providerImplementationId: 'test',
      model: 'test',
      runtimeImplementationId: 'test',
      toolImplementationIds: [],
      policyHash: 'test'
    }
  });
  const run = await runs.attach('budget-run');
  return { runs, run, budget: new AgentRunBudget({ run, limits }) };
}
test('tool limits reject unconsumed work transactionally in the driver', async () => {
  const { budget, runs, run } = await fixture({ totalToolCalls: 1 });
  await assert.rejects(
    run.recordBudget(() => budget.reserveToolCalls([{}, {}])),
    (error) => error instanceof AgentLimitExceededError && !error.consumed
  );
  assert.equal(budget.snapshot().totalToolCalls, 0);
  await run.recordBudget(() => budget.reserveToolCalls([{}]));
  assert.equal((await runs.inspect('budget-run')).state.budget.totalToolCalls, 1);
});

test('incurred charges commit before a crossed limit; repeated settlement and restart do not double count', async () => {
  const { budget, runs } = await fixture({ promptTokens: 5 });
  const totals = { invocations: 1, usage: { promptTokens: 6, completionTokens: 2, totalTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, knownCosts: {}, unknownPricedTokens: 8 };
  await assert.rejects(
    budget.recordUsage(totals),
    (error) =>
      error instanceof AgentLimitExceededError &&
      error.consumed &&
      error.resultingSnapshot.promptTokens === 6
  );
  assert.equal((await runs.inspect('budget-run')).state.budget.promptTokens, 6);
  const resumed = new AgentRunBudget({
    run: await runs.attach('budget-run'),
    limits: { promptTokens: 5 }
  });
  await assert.rejects(resumed.recordUsage(totals), AgentLimitExceededError);
  assert.equal(resumed.snapshot().promptTokens, 6);
});

test('run usage preserves unknown pricing and distinct currencies from inference settlement', async () => {
  const { budget } = await fixture({});
  await budget.recordUsage({ invocations: 3, usage: { promptTokens: 1100, completionTokens: 1050, totalTokens: 2150, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, knownCosts: { EUR: 2, USD: 4 }, unknownPricedTokens: 150 });
  assert.deepEqual(budget.snapshot().knownCosts, { EUR: 2, USD: 4 });
  assert.equal(budget.snapshot().pricingStatus, 'partial');
  assert.equal(budget.snapshot().unknownPricedTokens, 150);
});
