import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import { canonicalJsonString, hashJson, InMemoryEventRepository, typedEventCodec } from '@agent-core/persistence';
import { normalizeJsonSafe } from '@agent-core/json';
import { createModelRequest, parseModelRequest, parseModelResponse } from '@agent-core/model';
import { agentEventCodec, decodeAgentEvent, encodeAgentEvent } from '@agent-core/runtime';
import { adoptToolDefinition, createToolCall, defineTool, invalidOutputObservation, invalidToolInputObservation, parseToolObservation, planToolCall, ToolRegistry } from '@agent-core/tools';

test('normalized JSON is already recursively owned', () => {
  const nested = { values: [{ count: 1 }] };
  const normalized = normalizeJsonSafe(nested).value;
  assert.ok(Object.isFrozen(normalized));
  assert.equal(Array.isArray(normalized), false);
  assert.ok(Object.isFrozen(normalized.values));
  assert.ok(Object.isFrozen(normalized.values[0]));
  nested.values[0].count = 2;
  assert.equal(normalized.values[0].count, 1);
});

test('event decoding rejects accessors without invoking them', () => {
  let calls = 0;
  const event = {};
  Object.defineProperty(event, 'type', { enumerable: true, get() { calls += 1; return 'run.started'; } });
  assert.throws(() => decodeAgentEvent(event), /accessor/u);
  assert.equal(calls, 0);
});

test('agent event append, idempotency, hashing, and read share one owned value', async () => {
  const repository = new InMemoryEventRepository(agentEventCodec);
  const observationInput = { kind: 'result', ok: true, summary: 'done', scope: { resources: [], coverage: 'complete' }, output: { nested: { count: 1 } } };
  const observation = parseToolObservation({ outputSchema: z.strictObject({ nested: z.strictObject({ count: z.number() }) }) }, observationInput);
  const original = { type: 'tool.ended', turnIndex: 1, turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, callId: 'call', toolAttempt: 1, toolName: 'tool', observation };
  const encoded = encodeAgentEvent(original);
  const appended = await repository.append('run-1', original, { timestamp: '2026-01-01T00:00:00.000Z', idempotencyKey: 'same' });
  observationInput.output.nested.count = 2;
  assert.ok(Object.isFrozen(appended));
  assert.equal('event' in appended, false);
  const { hash, ...receipt } = appended;
  assert.equal(hash, hashJson({ ...receipt, event: encoded }));
  const duplicate = await repository.append('run-1', original, { timestamp: '2026-01-01T00:00:00.000Z', idempotencyKey: 'same' });
  assert.deepEqual(duplicate, appended);
  const [read] = await Array.fromAsync(repository.read('run-1'));
  assert.equal(read.event.observation.output.nested.count, 1);
  assert.throws(() => { read.event.observation.output.nested.count = 4; }, TypeError);
  assert.equal((await repository.verifyIntegrity('run-1')).ok, true);
});

test('built-in failure constructors own unknown details without a second parse', () => {
  const details = { nested: { value: 1 } };
  const observation = invalidToolInputObservation('example', 'bad input', details);
  details.nested.value = 2;
  assert.equal(observation.output.details.nested.value, 1);
  assert.ok(Object.isFrozen(observation.output.details));
  assert.ok(Object.isFrozen(observation.output.details.nested));
  assert.equal(parseToolObservation(undefined, observation), observation);
  assert.throws(() => parseToolObservation(undefined, {
    kind: 'failure', ok: false, summary: 'blocked', scope: { resources: [], coverage: 'partial' },
    output: { blocked: true, reason: 'policy', recovery: 'retry', toolCall: { malformed: true } }
  }), /unsupported fields/u);
});

test('plain errors produce deeply immutable invalid-output observations', () => {
  const observation = invalidOutputObservation('example', new Error('invalid output'));
  assert.ok(Object.isFrozen(observation));
  assert.ok(Object.isFrozen(observation.output));
  assert.ok(Object.isFrozen(observation.output.issues));
  assert.ok(Object.isFrozen(observation.output.issues.issues));
  assert.ok(Object.isFrozen(observation.output.issues.issues[0]));
  assert.ok(Object.isFrozen(observation.output.issues.issues[0].path));
  assert.throws(() => observation.output.issues.issues.push({ path: [], code: 'changed', message: 'changed' }), TypeError);
  assert.throws(() => { observation.output.issues.issues[0].message = 'changed'; }, TypeError);
  assert.throws(() => observation.output.issues.issues[0].path.push('changed'), TypeError);
});

test('authored tools retain identity and dynamic tools cross an explicit adopter', () => {
  const effectEnvelope = { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] };
  const tool = defineTool({
    name: 'identity_tool',
    implementationId: 'tests/identity-tool@1',
    description: 'Checks registration ownership.',
    schema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope,
    canonicalizeInput: (input) => input,
    deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async (input) => ({ kind: 'result', ok: true, summary: 'ok', scope: { resources: [], coverage: 'complete' }, output: input })
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  effectEnvelope.accesses[0].scope = 'changed';
  assert.equal(tool.effectEnvelope.accesses[0].scope, 'memory');
  assert.equal(registry.require(tool.name), tool);
  assert.equal(adoptToolDefinition(tool), tool);
  assert.throws(() => registry.register({ ...tool }), /created by/u);
  assert.throws(() => adoptToolDefinition({ ...tool, unsupported: true }), /unsupported fields/u);
});

test('tool planning accepts owned calls without decoding structural lookalikes', async () => {
  const tool = defineTool({
    name: 'planned_tool', implementationId: 'tests/plan-tool@1', description: 'Checks call ownership.', schema: z.strictObject({ value: z.string() }), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: (input) => input, deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'ok', scope: { resources: [], coverage: 'complete' }, output: {} })
  });
  const input = { name: tool.name, input: { kind: 'json', value: { value: 'owned' } } };
  const context = { policy: { allowedRisks: [] }, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'tests', executionTargetId: 'tests' } };
  await assert.rejects(planToolCall(input, [tool], context), /created or decoded/u);
  const call = createToolCall(input);
  const plan = await planToolCall(call, [tool], context);
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.call, call);
});

test('owned provider values are not decoded again', () => {
  const response = parseModelResponse({ content: 'ok', model: 'm', provider: 'third-party', terminationReason: 'stop' });
  assert.ok(Object.isFrozen(response));
  assert.equal(parseModelResponse(response), response);
});

test('trusted model request construction owns retained input before provider validation', () => {
  const message = { role: 'user', content: 'before', images: [{ type: 'bytes', data: new Uint8Array([1]), mediaType: 'image/png' }] };
  const request = createModelRequest({ model: 'm', messages: [message] });
  message.content = 'after';
  message.images[0].data[0] = 2;
  assert.equal(request.messages[0].content, 'before');
  assert.equal(request.messages[0].images[0].data[0], 1);
  assert.equal(parseModelRequest(request), request);
});

test('owned extension observations are not decoded again', () => {
  let outputChecks = 0;
  const outputSchema = z.unknown().superRefine(() => { outputChecks += 1; });
  const tool = { outputSchema };
  const owned = parseToolObservation(tool, { kind: 'result', ok: true, summary: 'ok', scope: { resources: [], coverage: 'complete' }, output: { value: 1 } });
  assert.equal(parseToolObservation(tool, owned), owned);
  assert.equal(outputChecks, 1);
});

test('event decoding validates nested persisted observedFacts', () => {
  assert.throws(() => agentEventCodec.decode({
    type: 'observation.record.created', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1,
    toolBatchId: 'batch-1', callIndex: 0, toolAttempt: 1, id: 'observation-1', toolName: 'read',
    call: { name: 'read', input: { kind: 'json', value: {} } }, toolCallType: 'function',
    observedFacts: [{ id: 'observedFacts-1', observationId: 'observation-1', toolName: 'read', createdAt: '2026-01-01T00:00:00.000Z', action: 'read', resources: [{ uri: 42 }], outcome: 'success' }],
    immediatePresentation: { ok: true, title: 'Read', summary: 'Read a resource.' },
    retainedPresentation: { ok: true, title: 'Read', summary: 'Read a resource.' }
  }), /uri/iu);
});

test('canonical hashing uses the JSON persistence domain without invoking accessors', () => {
  assert.equal(canonicalJsonString({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  assert.equal(hashJson({ z: 1, a: [true, null] }), hashJson({ a: [true, null], z: 1 }));
  let calls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { calls += 1; return 1; } });
  assert.throws(() => canonicalJsonString(accessor), /accessor-backed/u);
  assert.equal(calls, 0);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJsonString(cyclic), /cycle/u);
});
