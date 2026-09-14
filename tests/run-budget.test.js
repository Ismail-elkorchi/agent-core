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
const charge = (promptTokens, completionTokens = 0, cost) => ({
  usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  usageSource: 'provider',
  cost: cost ?? { status: 'unknown', unknownTokens: promptTokens + completionTokens }
});

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
  const charges = [charge(6, 2)];
  await assert.rejects(
    budget.recordUsage(charges),
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
  await assert.rejects(resumed.recordUsage(charges), AgentLimitExceededError);
  assert.equal(resumed.snapshot().promptTokens, 6);
});

test('run usage preserves unknown pricing and distinct currencies from inference settlement', async () => {
  const { budget } = await fixture({});
  await budget.recordUsage([
    charge(100, 50),
    charge(1000, 0, { status: 'known', amount: 2, currency: 'EUR', unknownTokens: 0 }),
    charge(0, 1000, { status: 'known', amount: 4, currency: 'USD', unknownTokens: 0 })
  ]);
  assert.deepEqual(budget.snapshot().knownCosts, { EUR: 2, USD: 4 });
  assert.equal(budget.snapshot().pricingStatus, 'partial');
  assert.equal(budget.snapshot().unknownPricedTokens, 150);
});
