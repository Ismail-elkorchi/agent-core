import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import { canonicalJsonString, hashJson, InMemoryEventRepository, typedEventCodec } from '@agent-core/evidence';
import { normalizeJsonSafe } from '@agent-core/json';
import { createModelRequest, parseModelRequest, parseModelResponse } from '@agent-core/model';
import { decodeAgentEvent } from '@agent-core/runtime';
import { adoptToolDefinition, defineTool, parseToolObservation, ToolRegistry } from '@agent-core/tools';

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

test('in-memory event append and read expose no mutable aliases', async () => {
  const repository = new InMemoryEventRepository(typedEventCodec);
  const original = { type: 'example.recorded', nested: { count: 1 } };
  const appended = await repository.append('run-1', original, { timestamp: '2026-01-01T00:00:00.000Z' });
  original.nested.count = 2;
  assert.equal(appended.event.nested.count, 1);
  assert.ok(Object.isFrozen(appended));
  assert.ok(Object.isFrozen(appended.event));
  assert.ok(Object.isFrozen(appended.event.nested));
  assert.throws(() => { appended.event.nested.count = 3; }, TypeError);
  const [read] = await Array.fromAsync(repository.read('run-1'));
  assert.equal(read.event.nested.count, 1);
  assert.throws(() => { read.event.nested.count = 4; }, TypeError);
  assert.equal((await repository.verifyIntegrity('run-1')).ok, true);
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
    deriveEffects: () => ({ accesses: [], lockScopes: [], idempotency: 'idempotent' }),
    invoke: async (input) => ({ kind: 'result', ok: true, summary: 'ok', scope: { resources: [], coverage: 'complete' }, output: input })
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  effectEnvelope.accesses[0].scope = 'changed';
  assert.equal(tool.effectEnvelope.accesses[0].scope, 'memory');
  assert.equal(registry.require(tool.name), tool);
  assert.notEqual(adoptToolDefinition(tool), tool);
  assert.throws(() => adoptToolDefinition({ ...tool, unsupported: true }), /unsupported fields/u);
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
