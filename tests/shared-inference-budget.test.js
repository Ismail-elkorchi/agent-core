import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  InferenceBudgetExceededError,
  InferenceService,
  InMemoryInferenceRepository,
  agentEventCodec
} from '@agent-core/runtime';

test('primary and auxiliary inference consume the same durable owner budget', async () => {
  let calls = 0;
  const profile = {
    id: 'shared-budget',
    provider: 'shared-budget',
    capabilities: {
      streaming: false,
      toolCalling: false,
      supportedToolInputs: [],
      jsonMode: false,
      jsonSchema: false,
      logprobs: false,
      temperature: false,
      topP: false
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 16_000, outputTokens: 128 },
    supportedParameters: ['maxOutputTokens']
  };
  const provider = {
    id: profile.provider,
    implementationId: 'tests/shared-budget@1',
    describe: () => ({
      id: profile.provider,
      displayName: 'Shared budget fixture',
      defaultModel: profile.id
    }),
    describeModel: async () => profile,
    async complete() {
      calls++;
      return {
        provider: profile.provider,
        model: profile.id,
        content: 'Complete.',
        terminationReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 }
      };
    }
  };
  const artifacts = new InMemoryArtifactRepository();
  const repository = new InMemoryInferenceRepository();
  const createService = () =>
    new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 1 } });
  const ownerId = 'shared-owner';
  const runtime = new AgentRuntime({
    provider,
    model: profile.id,
    inferenceService: createService(),
    maxOutputTokens: 64,
    toolBoundary: { authorizationPolicyId: 'tests/none', executionTargetId: 'tests/shared-budget' },
    repositories: { artifacts, events: new InMemoryEventRepository(agentEventCodec) }
  });
  const result = await runtime.run({ runId: ownerId, task: 'Complete the primary request.' })
    .result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));

  // Recreate the service to prove the spent allowance is durable, not an instance counter.
  await assert.rejects(
    createService().invoke({
      invocationId: 'auxiliary-after-primary',
      ownerId,
      purpose: 'verification',
      request: {
        model: profile.id,
        messages: [{ role: 'user', content: 'Verify the result.' }],
        maxOutputTokens: 64
      }
    }),
    InferenceBudgetExceededError
  );
  assert.equal(calls, 1, 'The verifier must be rejected before another provider request.');

  const independent = await createService().invoke({
    invocationId: 'independent-request',
    ownerId: 'another-owner',
    purpose: 'classification',
    request: {
      model: profile.id,
      messages: [{ role: 'user', content: 'Classify this input.' }],
      maxOutputTokens: 64
    }
  });
  assert.equal(independent.status, 'settled');
  assert.equal(calls, 2, 'Independent work has its own explicitly scoped budget.');
});
