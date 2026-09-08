import test from 'node:test';
import assert from 'node:assert/strict';
import { accountModelRequest, assertRequestAccountingFits, compileModelRequest, CompleteRequestEstimator, createProviderContextState, modelInputIdentity, parseModelRequest, parseProviderContextState, requestAccountingInputTokens } from '@agent-core/model';
import { OpenAIProvider } from '@agent-core/provider-openai';

const profile = { id: 'model', provider: 'test', capabilities: { streaming: true, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false }, modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 200000, maxInputTokens: 196000, outputTokens: 4000 }, supportedParameters: ['tools', 'maxOutputTokens'] };
const request = (value) => ({ model: 'model', messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call', type: 'function', name: 'write', input: { kind: 'json', value: { data: value, signature: value } } }] }], maxOutputTokens: 100 });

test('complete accounting includes large empty-text tool arguments and UTF-8 content', () => {
  const short = accountModelRequest(request('x'), profile);
  const large = accountModelRequest(request('a'.repeat(100000)), profile);
  assert.ok(large.estimatedInputTokens - short.estimatedInputTokens > 60000);
  assert.ok(large.components.some(item => item.kind === 'tool_arguments' && item.tokens > 60000));
  const estimator = new CompleteRequestEstimator();
  assert.ok(estimator.estimateItems(request('a'.repeat(100000)).messages) > 60000);
  assert.ok(estimator.estimateText('مرحبا世界') > estimator.estimateText('abcdefg'));
});

test('compiled accounting counts its representation once and does not erase user data/signature keys', async () => {
  const input = request('x'.repeat(12000));
  const compiled = await compileModelRequest({ request: input, profile, endpoint: 'https://test', body: { model: 'model', messages: input.messages }, headroomRatio: 0 });
  const wire = new CompleteRequestEstimator().estimateText(JSON.stringify(compiled.body));
  assert.ok(compiled.accounting.estimatedInputTokens >= wire - 5);
  assert.ok(compiled.accounting.estimatedInputTokens <= wire + 20);
  assert.ok(compiled.accounting.estimatedInputTokens > 8000);
});

test('provider input identities validate without invoking accessors and are independent of object key order', async () => {
  let accessed = false;
  const hostile = Object.defineProperty({}, 'secret', { enumerable: true, get() { accessed = true; return 'value'; } });
  await assert.rejects(() => modelInputIdentity(hostile), /accessor/u);
  assert.equal(accessed, false);
  assert.equal(await modelInputIdentity({ z: 1, a: ['hello'] }), await modelInputIdentity({ a: ['hello'], z: 1 }));
  await assert.rejects(() => modelInputIdentity({ missing: undefined }), /non-JSON/u);
});

test('opaque state never becomes zero or ciphertext-byte token accounting', async () => {
  const base = { model: 'model', messages: [{ role: 'user', content: 'hello' }] };
  const state = await createProviderContextState({ provider: 'test', endpoint: 'https://test', request: base, requestId: 'r', kind: 'signed', data: { encrypted: 'x'.repeat(100000) } });
  const logical = { ...base, messages: [...base.messages, { role: 'protocol', content: '', state }], maxOutputTokens: 100 };
  const accounting = accountModelRequest(logical, profile);
  assert.equal(accounting.unknownComponents.length, 1);
  assert.throws(() => assertRequestAccountingFits(accounting), /unknown token/u);
  const allowed = accountModelRequest(logical, profile, { unknownTokenAllowance: 5000 });
  assert.equal(requestAccountingInputTokens(allowed) - Math.ceil(allowed.estimatedInputTokens * 1.2), 5000);
  assert.doesNotThrow(() => assertRequestAccountingFits(allowed));
  assert.throws(() => new CompleteRequestEstimator().estimateItems(logical.messages), /unknown/u);
  assert.throws(() => parseProviderContextState({ provider: 'test', model: 'model', kind: 'old', data: {} }), /format/u);
});

test('schemas, control updates, media and reasoning reservations participate in accounting', () => {
  const logical = { model: 'model', messages: [{ role: 'developer', content: 'authority' }, { role: 'user', content: '', parts: [{ type: 'audio', mediaType: 'audio/wav', source: { type: 'base64', value: 'abc' } }] }, { role: 'control', content: '', update: { id: 'cfg-1', type: 'configuration', reasoning: { strategy: 'effort', effort: 'high' } } }], tools: [{ type: 'function', function: { name: 'tool', parameters: { description: 'x'.repeat(5000) } } }], responseFormat: { type: 'json_schema', schema: { description: 'x'.repeat(5000) } }, reasoning: { strategy: 'budget', maxTokens: 200 }, maxOutputTokens: 100 };
  const accounting = accountModelRequest(parseModelRequest(logical), profile, { unknownTokenAllowance: 1000 });
  for (const kind of ['tool_schema', 'response_schema', 'media', 'control']) assert.ok(accounting.components.some(item => item.kind === kind));
  assert.throws(() => assertRequestAccountingFits(accounting), /Reasoning reservation/u);
});

test('compiled OpenAI request owns the exact admitted body and preserves native roles', async () => {
  let sent;
  const provider = new OpenAIProvider({ apiKey: 'fixture', fetch: async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ id: 'r', model: 'gpt-5.6-sol', status: 'completed', output_text: 'done' }); } });
  const original = { model: 'gpt-5.6-sol', messages: [{ role: 'system', content: 'system' }, { role: 'developer', content: 'developer' }, { role: 'user', content: 'user' }], maxOutputTokens: 100 };
  const compiled = await provider.compileRequest(original);
  original.messages[0].content = 'mutated';
  assert.throws(() => { compiled.body.input[0].content = 'mutated'; }, TypeError);
  await provider.createSession().completeCompiled(compiled);
  const { stream, ...body } = sent;
  assert.equal(stream, false);
  assert.deepEqual(body, compiled.body);
  assert.deepEqual(body.input.map(item => item.role), ['system', 'developer', 'user']);
  assert.equal(await modelInputIdentity(body), compiled.inputIdentity);
});

test('binary model input is normalized to immutable JSON-safe media for durable replay', async () => {
  const source = new Uint8Array([0, 255, 128, 42]);
  const original = { model: 'model', messages: [{ role: 'user', content: '', parts: [{ type: 'image', image: { type: 'bytes', mediaType: 'image/png', data: source } }] }] };
  const request = parseModelRequest(original);
  const state = await createProviderContextState({ provider: 'test', endpoint: 'https://test', request: original, requestId: 'binary-origin', kind: 'test-state', data: {} });
  source.fill(99);
  assert.equal(state.origin.inputIdentity, await modelInputIdentity(request.messages));
  assert.equal(request.messages[0].parts[0].image.type, 'base64');
  assert.equal(request.messages[0].parts[0].image.data, 'AP+AKg==');
  assert.deepEqual(parseModelRequest(JSON.parse(JSON.stringify(request))), request);
});

test('missing output reservation is explicit instead of a silent zero budget', () => {
  const accounting = accountModelRequest({ model: 'model', messages: [{ role: 'user', content: 'hello' }] }, profile);
  assert.equal(accounting.outputReservationSource, 'unknown');
  assert.throws(() => assertRequestAccountingFits(accounting), /output reservation policy/u);
});

test('context admission includes separate reasoning and rejects unknown reasoning semantics', () => {
  const request = { model: 'model', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 100, reasoning: { strategy: 'budget', maxTokens: 50 } };
  const counted = { providerInputTokens: 100 };
  const definition = semantics => ({ ...profile, limits: { contextTokens: 240, outputTokens: 100 }, capabilities: { ...profile.capabilities, protocol: { reasoningAccounting: semantics } } });
  assert.throws(() => assertRequestAccountingFits(accountModelRequest(request, definition('separate'), counted)), /Context token limit/u);
  assert.doesNotThrow(() => assertRequestAccountingFits(accountModelRequest(request, definition('included_output'), counted)));
  assert.throws(() => assertRequestAccountingFits(accountModelRequest(request, definition('unknown'), counted)), /Reasoning accounting semantics/u);
});

test('Responses provider counting resolves preserved encrypted reasoning cost without counting ciphertext bytes', async () => {
  const calls = [];
  const native = { type: 'reasoning', id: 'rs-exact', encrypted_content: 'SIGNED+/='.repeat(1000), summary: [{ type: 'summary_text', text: 'safe summary' }] };
  const provider = new OpenAIProvider({ apiKey: 'fixture', countTokens: true, fetch: async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return Response.json(url.endsWith('/input_tokens') ? { input_tokens: 42 } : { id: 'r1', model: 'gpt-5.6-sol', status: 'completed', output: [native, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 42, output_tokens: 3, total_tokens: 45 } });
  } });
  const request = { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'question' }], maxOutputTokens: 100 };
  const response = await provider.complete(request);
  const { modelOutputToInput } = await import('@agent-core/model');
  const compiled = await provider.compileRequest({ ...request, messages: [...request.messages, ...modelOutputToInput(response.output), { role: 'user', content: 'next' }] });
  assert.equal(compiled.accounting.method.name, 'provider-count');
  assert.equal(compiled.accounting.estimatedInputTokens, 42);
  assert.equal(compiled.accounting.unknownComponents.length, 0);
  assert.deepEqual(compiled.body.input[1], native);
  assert.ok(calls[1][1].include.includes('reasoning.encrypted_content'));
  assert.doesNotThrow(() => assertRequestAccountingFits(compiled.accounting));
});
