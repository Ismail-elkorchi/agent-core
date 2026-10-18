import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, agentEventCodec, parseNativeToolExposure, grantContextControlTool, createToolCatalogTools } from '@agent-core/runtime';
import { createReadArtifactTool, defineTool, ToolCatalog } from '@agent-core/tools';

function fixture(nativeToolExposure, supported = true, options = {}) {
  const calls = [];
  const provider = {
    id: 'native-exposure-test', implementationId: 'native-exposure-test@1',
    describe() { return { id: this.id, displayName: 'Exposure test', defaultModel: 'test' }; },
    async describeModel() { return {
      id: 'test', provider: this.id,
      capabilities: {
        protocol: conservativeProtocolCapabilities('test', { deferredTools: supported, programmaticTools: supported }),
        streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
        jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false
      },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 64000, outputTokens: 1000 }, supportedParameters: ['maxOutputTokens', 'tools']
    }; },
    async complete(request) { calls.push(request); return { model: 'test', provider: this.id, content: 'done', terminationReason: 'stop' }; }
  };
  const artifacts = new InMemoryArtifactRepository();
  const runtime = new AgentRuntime({ provider, model: 'test', maxOutputTokens: 100,
    tools: options.tools ?? [createReadArtifactTool({ maxReadBytes: 100 })],
    ...(options.programRunner ? { programRunner: options.programRunner } : {}),
    ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
    toolContext: { services: { artifactRepository: artifacts } },
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
    repositories: { events: new InMemoryEventRepository(agentEventCodec), artifacts },
    ...(nativeToolExposure === undefined ? {} : { nativeToolExposure })
  });
  return { runtime, calls };
}

test('native exposure configuration is exact, owned, and requires explicit selected modes', () => {
  for (const value of [{}, { discovery: false }, { programmatic: false }, { discovery: 'true' }, { discovery: true, providerOptions: {} }, null, []])
    assert.throws(() => parseNativeToolExposure(value));
  const source = { discovery: true, programmatic: false };
  const captured = parseNativeToolExposure(source);
  source.discovery = false;
  assert.deepEqual(captured, { discovery: true, programmatic: false });
  assert(Object.isFrozen(captured));
});

test('native exposure is conservative by default and uses the runtime result envelope when selected', async () => {
  const conservative = fixture(undefined);
  assert.equal((await conservative.runtime.run({ task: 'simple' }).result).state, 'ended');
  assert.equal(conservative.calls[0].tools[0].deferLoading, undefined);
  assert.equal(conservative.calls[0].tools[0].allowedCallers, undefined);
  assert.equal(conservative.calls[0].tools[0].outputSchema, undefined);
  const selected = fixture(parseNativeToolExposure({ discovery: true, programmatic: true }));
  const result = await selected.runtime.run({ task: 'advanced' }).result;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  const advertised = selected.calls[0].tools[0];
  assert.equal(advertised.deferLoading, true);
  assert.deepEqual(advertised.allowedCallers, ['direct', 'programmatic']);
  assert(advertised.outputSchema.properties.receipt);
  assert(advertised.outputSchema.properties.observation);
  assert(advertised.outputSchema.$defs.toolOutput.properties.returnedRange);
});

test('unsupported native exposure fails before model invocation', async () => {
  for (const modes of [{ discovery: true }, { programmatic: true }]) {
    const f = fixture(parseNativeToolExposure(modes), false);
    const result = await f.runtime.run({ task: 'unsupported' }).result;
    assert.equal(f.calls.length, 0);
    assert.equal(result.state, 'ended');
    assert.notEqual(result.terminal.executionStatus, 'completed');
  }
});

function simpleTool(name, services) {
  return defineTool({ name, implementationId: `native-exposure.${name}`, description: name,
    schema: z.strictObject({}), outputSchema: z.string(),
    ...(services ? { requirements: { services }, isAvailable: () => true } : {}),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'context' }], lockScopes: [] },
    canonicalizeInput: value => value,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'context' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    async invoke() { return { kind: 'result', output: 'ok', summary: 'ok', execution: { state: 'settled' },
      scope: { resources: ['context'], coverage: 'complete' } }; }
  });
}

test('native discovery preserves exact host control grants and the registered orchestration definition eagerly', async () => {
  const controls = ['read', 'state', 'activation'].map(role => grantContextControlTool(simpleTool(`host_${role}`), role));
  const catalogControls = createToolCatalogTools({ catalog: new ToolCatalog({ tools: [] }) });
  const program = simpleTool('host_composition', ['programExecution']);
  const spoof = simpleTool('run_program');
  const f = fixture({ discovery: true }, true, { tools: [...controls, ...catalogControls, program, spoof],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    programRunner: { toolName: program.name, configurationRevision: 'native-discovery.runner.v1', async run() { return { status: 'completed' }; } } });
  const result = await f.runtime.run({ task: 'preserve controls' }).result;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(f.calls.length, 1, JSON.stringify(result));
  const advertised = new Map(f.calls[0].tools.map(tool => [tool.function.name, tool]));
  for (const tool of [...controls, ...catalogControls, program]) {
    assert(advertised.has(tool.name), tool.name);
    assert.equal(advertised.get(tool.name).deferLoading, undefined, tool.name);
  }
  assert.equal(advertised.get(spoof.name).deferLoading, true);
});
