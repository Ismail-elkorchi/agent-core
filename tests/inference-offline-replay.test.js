import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { InferenceService, InMemoryInferenceRepository } from '@agent-core/runtime';

test('settled inference replays offline from its admitted profile without provider discovery or counting', async () => {
  const profile = {
    id: 'offline-fixture', provider: 'offline-fixture',
    capabilities: {
      streaming: false, toolCalling: false, supportedToolInputs: [],
      jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 4096, outputTokens: 128 },
    supportedParameters: ['maxOutputTokens']
  };
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  let calls = 0;
  const provider = {
    id: profile.provider,
    implementationId: 'tests/offline-replay@1',
    describe: () => ({ id: profile.provider, displayName: 'Replay fixture', defaultModel: profile.id }),
    describeModel: async () => profile,
    complete: async () => {
      calls++;
      return {
        provider: profile.provider, model: profile.id, content: 'Persisted result.', terminationReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 }
      };
    }
  };
  const input = {
    ownerId: 'owning-work', invocationId: 'original-invocation', purpose: 'classification',
    request: { model: profile.id, messages: [{ role: 'user', content: 'Original input.' }], maxOutputTokens: 64 }
  };
  const original = await new InferenceService({ provider, repository, artifacts }).invoke(input);
  const unavailable = async () => { throw new Error('Provider is offline.'); };
  const reopened = new InferenceService({
    provider: { ...provider, describeModel: unavailable, compileRequest: unavailable, complete: unavailable },
    repository, artifacts
  });
  const replayed = await reopened.invoke(input);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.response, original.response);
  assert.equal(calls, 1);
  await assert.rejects(reopened.invoke({
    ...input, request: { ...input.request, messages: [{ role: 'user', content: 'Conflicting input.' }] }
  }), /different input|conflict/iu);
});
