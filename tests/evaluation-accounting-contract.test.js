import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import {
  InferenceService, InMemoryInferenceRepository, InferenceBudgetExceededError,
  inferenceEventCodec
} from '@agent-core/runtime';
import { recordInferenceEvents } from './inference-audit-helper.js';

test('evaluation consumers can retain reported versus estimated settlements across run IDs without resetting the owner', async () => {
  const profile = {
    id: 'local-accounting', provider: 'qualification',
    capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [],
      jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 8192, outputTokens: 128 },
    supportedParameters: ['maxOutputTokens']
  };
  let calls = 0;
  const provider = {
    id: profile.provider, implementationId: 'qualification/accounting@1',
    describe: () => ({ id: profile.provider, displayName: 'Local qualification', defaultModel: profile.id }),
    describeModel: async () => profile,
    complete: async () => ({
      provider: profile.provider, model: profile.id, content: 'Observed.',
      terminationReason: 'stop',
      ...(++calls === 1 ? { usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } } : {})
    })
  };
  const repository = new InMemoryInferenceRepository();
  const events = recordInferenceEvents(repository);
  const artifacts = new InMemoryArtifactRepository();
  const service = () => new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 2 } });
  const input = (id, purpose) => ({
    ownerId: 'continuing-task', invocationId: id, runId: id, purpose,
    request: { model: profile.id, messages: [{ role: 'user', content: 'Observe.' }], maxOutputTokens: 64 }
  });
  await service().invoke(input('first-run', 'agent_step'));
  await service().invoke(input('later-run', 'context_recovery'));
  await assert.rejects(service().invoke(input('extra-run', 'agent_step')), InferenceBudgetExceededError);
  assert.equal(calls, 2);
  const observed = events.map(({ event }) => inferenceEventCodec.decode(inferenceEventCodec.encode(event)));
  const starts = observed.filter(event => event.type === 'inference.started');
  const settlements = observed.filter(event => event.type === 'inference.settled');
  assert.deepEqual(starts.map(event => event.purpose), ['agent_step', 'context_recovery']);
  assert(starts.every(event => event.reservation.completionTokens === 64));
  assert.deepEqual(settlements.map(event => event.usageSource), ['provider', 'estimate']);
  assert(settlements.every(event => event.cost.status === 'unknown' && event.cost.amount === undefined));
  const owner = await repository.load('continuing-task');
  assert.equal(owner.settledUsage.invocations, 2);
  assert(owner.settledUsage.usage.promptTokens >= 7);
  assert.deepEqual(owner.settledUsage.knownCosts, {});
});
