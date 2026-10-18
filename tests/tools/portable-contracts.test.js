import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import { captureToolCatalog, decodeToolCatalog, assertToolCatalogCurrent } from '@agent-core/runtime';
import {
  adoptToolDefinition, defineTool, defineJsonSchema, embedJsonSchema, parseToolObservation, planToolCall,
  releaseToolCallPlan, toolDefinitionHash
} from '@agent-core/tools';
import { invokePlannedForTest, jsonToolCall } from '../tool-call-helpers.js';

const observation = output => ({
  kind: 'result', summary: 'Contract result.', scope: { resources: [], coverage: 'complete' }, output
});

test('portable schema embedding escapes paths and shares the exact resource restrictions', () => {
  const schema = { $defs: { child: { type: 'string' } }, type: 'object',
    properties: { child: { $ref: '#/$defs/child' }, self: { $ref: '#' },
      marker: { const: { $id: 'literal', $ref: 'literal' } } },
    anyOf: [{ properties: { child: { $ref: '#/$defs/child' } } }],
    examples: [{ $dynamicRef: 'literal' }] };
  const embedded = embedJsonSchema(schema, ['$defs', 'slash/name~key']);
  const base = '#/$defs/slash~1name~0key';
  assert.equal(embedded.properties.child.$ref, `${base}/$defs/child`);
  assert.equal(embedded.properties.self.$ref, base);
  assert.equal(embedded.anyOf[0].properties.child.$ref, `${base}/$defs/child`);
  assert.deepEqual(embedded.properties.marker.const, schema.properties.marker.const);
  assert.deepEqual(embedded.examples, schema.examples);
  schema.$defs.child.type = 'number';
  assert.equal(embedded.$defs.child.type, 'string');
  assert(Object.isFrozen(embedded.properties.child));
  for (const invalid of [{ $id: 'resource' }, { $dynamicRef: '#' }, { $ref: 'https://remote.invalid/schema' },
    { properties: { child: { $anchor: 'child' } } }, { $schema: 'http://json-schema.org/draft-07/schema#' }]) {
    assert.throws(() => embedJsonSchema(invalid, ['$defs', 'output']), /Portable external JSON Schema/u);
    assert.throws(() => defineJsonSchema(invalid, () => () => undefined), /Portable external JSON Schema/u);
  }
  assert.throws(() => embedJsonSchema({}, [3]), /path of property names/u);
});

test('input default normalization preserves schema-shaped literal data exactly', () => {
  const literal = { properties: { x: { default: 1 } }, required: ['x'] };
  const schema = z.strictObject({ value: z.json().default(literal),
    marker: z.string() }).meta({ examples: [literal] });
  const tool = defineTool(options({ schema }));
  assert.deepEqual(tool.jsonSchema.properties.value.default, literal);
  assert.deepEqual(tool.jsonSchema.examples, [literal]);
  assert.deepEqual(tool.jsonSchema.required, ['marker']);
  assert.deepEqual(tool.decodeInput({ kind: 'json', value: { marker: 'present' } }).input.value, literal);
});
const options = overrides => ({
  name: 'portable', implementationId: 'tests/portable@1', description: 'Portable result contract',
  schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'state' }], lockScopes: [] },
  canonicalizeInput: input => input,
  deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'state' }], lockScopes: [], recovery: { kind: 'unknown' } }),
  invoke: async () => observation({ value: 'value' }),
  ...overrides
});
const context = caller => ({
  policy: { allowedRisks: ['read'] }, signal: new AbortController().signal,
  boundary: { authorizationPolicyId: 'tests/portable-policy@1', executionTargetId: 'tests' },
  ...(caller ? { invocation: {
    runId: 'run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1, caller
  } } : {})
});
const caller = programId => ({
  kind: 'programmatic', programId,
  parent: { runId: 'run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 }
});

test('portable result contracts preserve strict discriminants, defaults, and validator ownership', () => {
  const outputSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('success'), value: z.string().default('value') }),
    z.strictObject({ status: z.literal('conflict'), reason: z.string() })
  ]);
  const authored = options({ outputSchema });
  const tool = defineTool(authored);
  const portable = z.fromJSONSchema(JSON.parse(JSON.stringify(tool.outputJsonSchema)));
  assert(Object.isFrozen(tool.outputJsonSchema));
  assert(Object.isFrozen(tool.outputJsonSchema.oneOf));
  const validated = parseToolObservation(tool, observation({ status: 'success' })).output;
  assert.deepEqual(validated, { status: 'success', value: 'value' });
  assert(portable.safeParse(validated).success);
  assert(!portable.safeParse({ status: 'success', value: 4 }).success);
  assert(!portable.safeParse({ status: 'conflict', value: 'wrong branch' }).success);
  assert(!portable.safeParse({ status: 'success', value: 'ok', extra: true }).success);
  const success = tool.outputJsonSchema.oneOf.find(branch => branch.properties.status.const === 'success');
  assert(success.required.includes('value'));
  authored.outputSchema = z.number();
  assert.deepEqual(parseToolObservation(tool, observation({ status: 'success' })).output, validated);
  assert.throws(() => parseToolObservation(tool, observation({ status: 'conflict', value: 'wrong' })));
});

test('adoption derives the portable output contract and rejects deceptive or unsupported validators', () => {
  const original = defineTool(options());
  const adopted = adoptToolDefinition({ ...original });
  assert.deepEqual(adopted.outputJsonSchema, original.outputJsonSchema);
  assert.equal(toolDefinitionHash(adopted), toolDefinitionHash(original));
  assert.throws(() => adoptToolDefinition({ ...original, outputJsonSchema: { type: 'number' } }), /does not match/u);
  assert.throws(() => adoptToolDefinition({ ...original, outputSchema: { safeParse: value => ({ success: true, data: value }) } }), /Zod schema/u);
  for (const schema of [z.unknown(), z.any(), z.unknown().meta({ id: 'unconstrained' }), z.unknown().default(null)]) {
    assert.throws(() => defineTool(options({ outputSchema: schema })), /portable JSON result contract/u);
    const { outputJsonSchema: _, ...external } = original;
    assert.throws(() => adoptToolDefinition({ ...external, outputSchema: schema }), /portable JSON result contract/u);
  }
  assert.throws(() => defineTool(options({ outputSchema: z.json().transform(value => value) })), /Transforms/u);
  assert.doesNotThrow(() => defineTool(options({ outputSchema: z.json() })));
});

test('definition identity changes with output contracts, every requirement, and caller eligibility', () => {
  const base = toolDefinitionHash(defineTool(options()));
  for (const change of [
    { outputSchema: z.strictObject({ value: z.number() }) },
    { requirements: { services: ['documents'] } },
    { requirements: { hostCapabilities: ['bounded-worker'] } },
    { requirements: { modelInputModalities: ['image'] } },
    { invocationModes: ['direct', 'programmatic'] }
  ]) assert.notEqual(toolDefinitionHash(defineTool(options(change))), base);
  assert.deepEqual(defineTool(options()).invocationModes, ['direct']);
  for (const invocationModes of [[], ['programmatic', 'programmatic'], ['other']])
    assert.throws(() => defineTool(options({ invocationModes })), /invocationModes/u);
});

test('programmatic eligibility is checked before resource binding and pins caller authority', async () => {
  let bindings = 0;
  const direct = defineTool(options({
    bindExecution: input => { bindings++; return { snapshot: input, invoke: async () => observation({ value: 'ok' }) }; },
    invoke: undefined
  }));
  for (const origin of [caller('program'), { kind: 'provider_programmatic', programId: 'native', providerResponseId: 'response' }]) {
    const denied = await planToolCall(jsonToolCall('portable'), [direct], context(origin));
    assert.equal(denied.ok, false);
    assert.equal(denied.observation.output.reason, 'policy');
  }
  assert.equal(bindings, 0);
  const tool = defineTool(options({ invocationModes: ['direct', 'programmatic'] }));
  const first = await planToolCall(jsonToolCall('portable'), [tool], context(caller('first')));
  const second = await planToolCall(jsonToolCall('portable'), [tool], context(caller('second')));
  assert(first.ok && second.ok);
  assert.notEqual(first.plan.fingerprint, second.plan.fingerprint);
  await releaseToolCallPlan(second.plan);
  await assert.rejects(invokePlannedForTest(first.plan, context(caller('second'))), /caller changed/u);
  const allowedContext = context(caller('allowed'));
  const allowed = await planToolCall(jsonToolCall('portable'), [tool], allowedContext);
  assert(allowed.ok);
  assert.equal((await invokePlannedForTest(allowed.plan, allowedContext)).output.value, 'value');
});

test('qualified local reads opt into programs while mutation tools remain direct-only', async () => {
  const { readFilesTool, listDirectoryTool, findFilesTool, searchTextTool, applyPatchTool, editTextTool } = await import('@agent-core/tools-local');
  for (const tool of [readFilesTool, listDirectoryTool, findFilesTool, searchTextTool]) {
    assert.deepEqual(tool.invocationModes, ['direct', 'programmatic'], tool.name);
    assert(tool.outputJsonSchema.properties || tool.outputJsonSchema.oneOf || tool.outputJsonSchema.anyOf, tool.name);
  }
  for (const tool of [applyPatchTool, editTextTool]) assert.deepEqual(tool.invocationModes, ['direct'], tool.name);
});

test('admitted catalog snapshots declare the result-contract version and reject old formats', () => {
  const tool = defineTool(options());
  const snapshot = captureToolCatalog([tool]);
  assert.equal(snapshot.format, 'agent-core.tool-catalog/2');
  assert.deepEqual(decodeToolCatalog(snapshot), snapshot);
  const { format: _, ...old } = snapshot;
  assert.throws(() => decodeToolCatalog(old), /Invalid tool catalog snapshot/u);
  assert.throws(() => decodeToolCatalog({ ...snapshot, format: 'agent-core.tool-catalog/1' }), /Invalid tool catalog snapshot/u);
  assert.doesNotThrow(() => assertToolCatalogCurrent(snapshot, [tool]));
  assert.throws(() => assertToolCatalogCurrent(snapshot, [defineTool(options({ outputSchema: z.number() }))]), /definitions changed/u);
});

test('external JSON Schema keeps one exact validator owner and composes local references without rewriting literal data', () => {
  const original = {
    type: 'object',
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 1, default: 'x' },
      marker: { const: { $ref: 'literal-data' } },
      child: { $ref: '#/$defs/child' }
    },
    required: ['label', 'marker', 'child'], additionalProperties: false,
    $defs: { child: { type: 'integer', minimum: 3 } }
  };
  let captured;
  const contract = defineJsonSchema(original, owned => {
    captured = owned;
    return value => {
      const valid = value && typeof value === 'object' && !Array.isArray(value) &&
        typeof value.label === 'string' && [...value.label].length === 1 &&
        value.marker?.$ref === 'literal-data' && Object.keys(value.marker).length === 1 &&
        Number.isInteger(value.child) && value.child >= 3 && Object.keys(value).length === 3;
      return valid ? undefined : [{ message: 'Exact schema mismatch.' }];
    };
  });
  assert.deepEqual(captured, original);
  assert(Object.isFrozen(captured.properties));
  const good = { label: '😀', marker: { $ref: 'literal-data' }, child: 3 };
  const root = defineTool(options({ schema: contract, outputSchema: contract }));
  assert.deepEqual(root.jsonSchema, original);
  assert.deepEqual(root.outputJsonSchema, original);
  original.properties.label.maxLength = 99;
  assert.equal(root.jsonSchema.properties.label.maxLength, 1);
  assert(root.decodeInput({ kind: 'json', value: good }).ok);
  assert(!root.decodeInput({ kind: 'json', value: { ...good, label: 'xx' } }).ok);
  assert(!root.decodeInput({ kind: 'json', value: { ...good, child: 2 } }).ok);
  assert(!root.decodeInput({ kind: 'json', value: { marker: good.marker, child: 3 } }).ok);
  assert.deepEqual(parseToolObservation(root, observation(good)).output, good);
  const nested = defineTool(options({ schema: z.strictObject({ value: contract }), outputSchema: z.strictObject({ value: contract }) }));
  for (const schema of [nested.jsonSchema, nested.outputJsonSchema]) {
    assert.deepEqual(schema.required, ['value']);
    const reference = schema.properties.value.$ref;
    const name = reference.slice('#/$defs/'.length);
    const definition = schema.$defs[name];
    assert.equal(definition.properties.child.$ref, `${reference}/$defs/child`);
    assert.deepEqual(definition.properties.marker.const, { $ref: 'literal-data' });
    assert.deepEqual(definition.required, ['label', 'marker', 'child']);
  }
  assert.throws(() => defineJsonSchema({ $ref: 'https://remote.invalid/schema' }, () => () => undefined), /local JSON pointers/u);
  assert.throws(() => defineJsonSchema({ $id: 'https://remote.invalid/schema', type: 'string' }, () => () => undefined), /separate resources/u);
  assert.throws(() => defineJsonSchema({ type: 'string' }, async () => () => undefined), /synchronous validator/u);
  const asyncValidator = defineJsonSchema({ type: 'string' }, () => async () => undefined);
  assert.throws(() => asyncValidator.parse('value'), /synchronous issues/u);
});
