import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModelRequest, requestAccountingInputTokens, conservativeProtocolCapabilities, createProviderContextState } from '@agent-core/model';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { ModelRequestAssembler, ModelWindow, RequestAdmission, InferenceService, InMemoryInferenceRepository, agentEventCodec } from '@agent-core/runtime';

const profile = { id: 'model', provider: 'fixture', capabilities: {
  protocol: conservativeProtocolCapabilities('fixture', { inputKinds: ['text', 'tool_call', 'tool_result', 'protocol'], outputKinds: ['text', 'tool_call', 'protocol'], state: 'exact' }),
  streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
  jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false
}, modalities: { input: ['text'], output: ['text'] },
limits: { contextTokens: 40000, outputTokens: 1000 }, supportedParameters: ['tools', 'maxOutputTokens'] };
async function fixture() {
  const calls = [];
  const artifacts = new InMemoryArtifactRepository();
  const repository = new InMemoryInferenceRepository();
  const provider = { id: 'fixture', implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'model' }),
    describeModel: async () => profile,
    compileRequest: async request => {
      calls.push(request);
      return compileModelRequest({ request, profile, body: { messages: request.messages, tools: request.tools },
        endpoint: 'fixture', providerInputTokens: request.messages.reduce((sum, message) => sum + (message.role === 'protocol' ? JSON.stringify(message.state).length : message.content.length), 0) });
    },
    complete: async () => ({ provider: 'fixture', model: 'model', content: 'Done', terminationReason: 'stop' }) };
  const inference = new InferenceService({ provider, repository, artifacts });
  const admission = new RequestAdmission(new ModelRequestAssembler(), inference);
  const original = await admission.assemble({ window: new ModelWindow(), modelProfile: profile,
    runId: 'run', task: 'Exact accepted user request',
    instructions: [{ id: 'authority', role: 'system', content: 'Keep original authority', priority: 0 }],
    contextItems: [{ id: 'source', sourceUri: 'app://source', sourceKind: 'external', representation: 'full',
      mediaType: 'text/plain', title: 'Source', content: 'Complete original source', purpose: 'Evidence' }], tools: []
  }, { model: 'model', maxOutputTokens: 500, tools: [{ type: 'function', function: {
    name: 'context_transition', description: 'Propose a view', parameters: { type: 'object', properties: {} }
  } }] }, 500);
  return { admission, original, calls, inference, repository, artifacts };
}

test('runtime control uses the ordinary compiler with captured presentation and full original prefix', async () => {
  const f = await fixture();
  const control = { kind: 'context-recovery', id: 'boundary-1', content: 'Select existing revisions or renew without writing state.' };
  const input = { original: f.original.compiled, profile, control, outputReservation: 300 };
  const probe = await f.admission.assembleControl(input);
  const dispatch = await f.admission.assembleControl(input);
  assert.equal(probe.compiled.inputIdentity, dispatch.compiled.inputIdentity);
  assert.deepEqual(dispatch.request.messages.slice(0, f.original.request.messages.length), f.original.request.messages);
  assert.deepEqual(dispatch.request.tools, f.original.request.tools);
  assert.deepEqual(dispatch.request.messages.at(-1), { role: 'user', content: control.content });
  assert.deepEqual(dispatch.assembly.presentation.context, f.original.assembly.presentation.context);
  assert.deepEqual(dispatch.assembly.presentation.capacityNotice, f.original.assembly.presentation.capacityNotice);
  assert.equal(dispatch.assembly.presentation.authority, f.original.assembly.presentation.authority);
  assert.equal(dispatch.assembly.material.runtimeControl.kind, 'context-recovery');
  const materialEvent = { type: 'prompt.material.selected', material: dispatch.assembly.material };
  assert.deepEqual(agentEventCodec.decode(agentEventCodec.encode(materialEvent)), materialEvent);
  assert.throws(() => agentEventCodec.decode({ ...materialEvent, material: { ...materialEvent.material, sessionState: {} } }), /sessionState/);
  assert.equal(dispatch.assembly.presentation.runtimeControl.id, 'boundary-1');
  assert.equal(dispatch.compiled.accounting.outputReservation, 300);
  assert.equal(requestAccountingInputTokens(dispatch.compiled.accounting),
    requestAccountingInputTokens(f.original.compiled.accounting) + control.content.length);
  assert.equal(f.calls.length, 3);
  await f.admission.admit(dispatch.compiled, profile);
  await f.inference.invoke({ ownerId: 'owner', invocationId: 'control', runId: 'run', purpose: 'context_recovery',
    request: dispatch.request, compiled: dispatch.compiled, profile });
  const record = await f.repository.load('owner', { invocationId: 'control' });
  const persisted = JSON.parse(new TextDecoder().decode(await f.artifacts.readVerified(record.invocation.start.requestRef)));
  assert.deepEqual(persisted.logical.messages, dispatch.request.messages);
  assert.deepEqual(persisted.presentation, dispatch.assembly.presentation);
});

test('control fails explicitly rather than fabricating an uncaptured presentation', async () => {
  const f = await fixture();
  const uncaptured = await compileModelRequest({ request: f.original.request, profile, body: {}, endpoint: 'fixture' });
  await assert.rejects(f.admission.assembleControl({ original: uncaptured, profile,
    control: { kind: 'context-recovery', id: 'unknown', content: 'Control' }, outputReservation: 100 }),
  /original compiled request presentation/);
  assert.equal(f.calls.length, 1);
});

test('native and restarted captured requests retain their entire exact prefix during control assembly', async () => {
  const f = await fixture();
  const state = await createProviderContextState({ provider: 'fixture', protocolRevision: 'conservative-v1',
    endpoint: 'fixture', request: f.original.request, requestId: 'native-response', kind: 'fixture.reasoning',
    requiresExactPrefix: true, data: { signed: 'Do not rewrite this opaque reasoning' }, tokenCount: 10 });
  const logical = { ...f.original.request, messages: [...f.original.request.messages,
    { role: 'protocol', content: '', state }, { role: 'assistant', content: 'Earlier answer' }] };
  const compiled = await f.admission.compile(logical, profile, 500, f.original.assembly.presentation);
  const control = { kind: 'context-recovery', id: 'native-boundary', content: 'Renew selected references without rewriting stored state.' };
  const first = await f.admission.assembleControl({ original: compiled, profile, control, outputReservation: 200 });
  assert.deepEqual(first.request.messages.slice(0, logical.messages.length), logical.messages);
  assert.deepEqual(first.request.tools, logical.tools);
  assert.equal(first.request.messages.filter(message => message.role === 'protocol').length, 1);
  await f.inference.invoke({ ownerId: 'owner', invocationId: 'original', runId: 'run', purpose: 'test', request: logical, compiled, profile });
  const persisted = await f.inference.admittedInput('owner', 'original');
  const restarted = new RequestAdmission(new ModelRequestAssembler(), f.inference);
  const replayed = await restarted.compile(persisted.request, profile, 500, persisted.presentation);
  const next = await restarted.assembleControl({ original: replayed, profile, control, outputReservation: 200 });
  assert.deepEqual(next.request.messages, first.request.messages);
  assert.deepEqual(next.assembly.presentation, first.assembly.presentation);
});
