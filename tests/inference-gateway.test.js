import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InferenceGateway,
  ModelRequestFitError,
  assertModelRequestFitsProfile,
  estimateModelRequestFit
} from '@agent-core/runtime';

const profile = Object.freeze({
  id: 'fit-model',
  provider: 'fit-provider',
  capabilities: {
    streaming: false,
    toolCalling: true,
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: false,
    jsonSchema: false,
    logprobs: false,
    temperature: false,
    topP: false
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 100, maxInputTokens: 75, outputTokens: 25 },
  supportedParameters: ['tools', 'maxOutputTokens']
});

test('model request fit accounts for messages, tool and response schemas, and the requested output reserve', () => {
  const request = {
    model: profile.id,
    messages: [{ role: 'user', content: 'small request' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'x'.repeat(40), parameters: { type: 'object' } } }],
    responseFormat: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    maxOutputTokens: 10
  };
  const fit = estimateModelRequestFit(request, profile);
  assert.ok(fit.messageTokens > 0);
  assert.ok(fit.toolTokens > 0);
  assert.ok(fit.responseFormatTokens > 0);
  assert.equal(fit.promptTokens, fit.messageTokens + fit.toolTokens + fit.responseFormatTokens);
  assert.equal(fit.outputReserveTokens, 10);
  assert.deepEqual(assertModelRequestFitsProfile(request, profile), fit);
});

test('inference gateway rejects an oversized logical request before provider invocation', async () => {
  let calls = 0;
  const provider = {
    id: profile.provider,
    implementationId: 'tests.fit-provider@1',
    describe: () => ({ id: profile.provider, displayName: 'Fit provider', defaultModel: profile.id }),
    describeModel: async () => profile,
    createSession: () => ({
      complete: async (request) => {
        calls += 1;
        return { content: '', model: request.model, provider: profile.provider, terminationReason: 'stop' };
      }
    }),
    complete: async (request) => ({ content: '', model: request.model, provider: profile.provider, terminationReason: 'stop' })
  };
  const gateway = new InferenceGateway(provider);
  const session = gateway.createSession();
  await assert.rejects(
    gateway.invoke({ request: { model: profile.id, messages: [{ role: 'user', content: 'x'.repeat(400) }] }, profile, session, turnIndex: 0 }),
    error => error instanceof ModelRequestFitError && error.fit.promptTokens > error.fit.maxPromptTokens
  );
  assert.equal(calls, 0);
});
