import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceService } from '@agent-core/runtime';
import { accountModelRequest, assertRequestAccountingFits, ModelContractError } from '@agent-core/model';

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
  const fit = accountModelRequest(request, { ...profile, limits: {contextTokens:2000, maxInputTokens:1900,outputTokens:25} });
  for (const kind of ['text', 'tool_schema', 'response_schema']) assert.ok(fit.components.some(part => part.kind === kind && part.tokens > 0));
  assert.equal(fit.outputReservation, 10);
  assertRequestAccountingFits(fit);
});

test('inference admission rejects an oversized logical request before provider invocation', async () => {
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
  const service = InferenceService.inMemory({ provider });
  await assert.rejects(
    service.invoke({ ownerId: 'test', invocationId: 'oversized', purpose: 'admission', request: { model: profile.id, messages: [{ role: 'user', content: 'x'.repeat(400) }] }, profile }),
    error => error instanceof ModelContractError
  );
  assert.equal(calls, 0);
});
