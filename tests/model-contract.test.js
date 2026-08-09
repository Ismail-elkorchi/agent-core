import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelContractError,
  SimpleTokenEstimator,
  assertModelRequestSupported,
  parseModelProfile,
  parseModelRequest,
  parseModelResponse,
  parseModelStreamEvent
} from '@agent-core/model';

const profile = {
  id: 'test',
  provider: 'test-provider',
  capabilities: {
    streaming: true, toolCalling: false, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false,
    logprobs: false, temperature: false, topP: false,
    reasoning: { strategies: ['effort'], canDisable: false, efforts: ['high'], modes: ['standard'], separateOutput: true }
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 1000, maxInputTokens: 900, outputTokens: 100 },
  supportedParameters: ['reasoning']
};

test('model request validation rejects illegal message combinations and unsafe options', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => parseModelRequest({ model: 'test', messages: [{ role: 'tool', content: 'result', toolName: 'read', toolCallType: 'invalid' }], providerOptions: { provider: 'test', values: cyclic } }),
    error => error instanceof ModelContractError && /toolCallType/.test(error.message) && /JSON-safe/.test(error.message)
  );
});

test('tool-result images validate, require image input support, and consume estimated tokens', () => {
  const request = parseModelRequest({
    model: 'test',
    messages: [{ role: 'tool', content: 'image result', toolName: 'view_image', toolCallType: 'function', toolCallId: 'call', images: [{ type: 'base64', data: 'aGVsbG8=', mediaType: 'image/png', detail: 'original' }] }]
  });
  assert.equal(request.messages[0].images.length, 1);
  assert.throws(() => assertModelRequestSupported(profile, request), error => error instanceof ModelContractError && /image input/u.test(error.message));
  const imageProfile = parseModelProfile({ ...profile, modalities: { input: ['text', 'image'], output: ['text'] } });
  assert.doesNotThrow(() => assertModelRequestSupported(imageProfile, request));
  const estimator = new SimpleTokenEstimator();
  assert.ok(estimator.estimateMessages(request.messages) >= estimator.estimateImage(request.messages[0].images[0]));
  assert.ok(estimator.estimateImage(request.messages[0].images[0]) > 0);
});

test('model JSON boundaries reject metadata accessors and own tool-call input', () => {
  const metadata = {};
  Object.defineProperty(metadata, 'secret', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => parseModelRequest({ model: 'test', messages: [{ role: 'user', content: 'hello' }], metadata }), /metadata/u);
  const input = { path: 'before.txt' };
  const request = parseModelRequest({ model: 'test', messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call', type: 'function', name: 'read_files', input: { kind: 'json', value: input } }] }] });
  input.path = 'after.txt';
  assert.equal(request.messages[0].toolCalls[0].input.value.path, 'before.txt');
  assert.equal(Object.isFrozen(request.messages[0].toolCalls[0].input.value), true);
});

test('request/profile validation rejects unsupported controls and reasoning combinations', () => {
  assert.throws(
    () => assertModelRequestSupported(profile, { model: 'test', messages: [{ role: 'user', content: 'hello' }], temperature: 0.2, reasoning: { strategy: 'disabled' } }),
    error => error instanceof ModelContractError && /temperature/.test(error.message) && /cannot be disabled/.test(error.message)
  );
  assert.throws(
    () => assertModelRequestSupported(profile, { model: 'test', messages: [{ role: 'user', content: 'hello' }], reasoning: { strategy: 'effort', effort: 'low', mode: 'pro' } }),
    error => error instanceof ModelContractError && /effort low/.test(error.message) && /mode pro/.test(error.message)
  );
});

test('profile validation rejects contradictory token limits and incomplete reasoning capabilities', () => {
  assert.throws(
    () => parseModelProfile({
      ...profile,
      limits: { contextTokens: 100, maxInputTokens: 90, outputTokens: 20 },
      capabilities: { ...profile.capabilities, reasoning: { strategies: ['effort'], canDisable: true, separateOutput: true } }
    }),
    error => error instanceof ModelContractError && /maxInputTokens \+ outputTokens/.test(error.message) && /reasoning/.test(error.message)
  );
});

test('response and stream validation enforce coherent terminal and accumulation state', () => {
  assert.throws(
    () => parseModelResponse({
      content: '',
      model: 'test',
      provider: 'test-provider',
      terminationReason: 'stop',
      toolCalls: [{ type: 'function', name: 'read', input: { kind: 'json', value: {} } }],
      transport: { provider: 'different-provider', strategy: 'http' },
      timings: { total: -1 }
    }),
    error => error instanceof ModelContractError
      && /transport.provider/.test(error.message)
      && /timings/.test(error.message)
  );
  assert.throws(
    () => parseModelStreamEvent({ type: 'content', content: 'tail', accumulated: 'prefix' }),
    error => error instanceof ModelContractError && /Malformed content/.test(error.message)
  );
});
