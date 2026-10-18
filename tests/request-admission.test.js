import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModelRequest } from '@agent-core/model';
import {
  RequestAdmission,
  ContextAdmissionError,
  ModelRequestAssembler,
  ModelWindow,
  InferenceService
} from '@agent-core/runtime';
const profile = {
  id: 'model',
  provider: 'fixture',
  capabilities: {
    streaming: false,
    toolCalling: true,
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: true,
    jsonSchema: true,
    logprobs: false,
    temperature: true,
    topP: false
  },
  modalities: { input: ['text', 'image'], output: ['text'] },
  limits: { contextTokens: 40000, outputTokens: 1000 },
  supportedParameters: ['tools', 'maxOutputTokens', 'temperature', 'responseFormat']
};
const provider = {
  id: 'fixture',
  implementationId: 'fixture@1',
  describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'model' }),
  describeModel: async () => profile,
  complete: async () => {
    throw new Error('No dispatch in admission test');
  }
};
const admission = new RequestAdmission(
  new ModelRequestAssembler(),
  InferenceService.inMemory({ provider })
);
test('the common assembler captures tool guides, sources, settings and exact compiled identity together', async () => {
  const input = {
    window: new ModelWindow(),
    task: 'Exact accepted input',
    instructions: [{ id: 'rules-1', role: 'developer', priority: 0, content: 'Original guidance' }],
    contextItems: [
      {
        id: 'source-rev-1',
        sourceUri: 'app://source',
        sourceKind: 'external',
        representation: 'full',
        mediaType: 'text/plain',
        title: 'Source',
        content: 'Original content',
        purpose: 'Reference'
      }
    ],
    tools: [
      {
        name: 'read',
        description: 'Read',
        inputFormat: 'JSON',
        accessModes: ['read'],
        promptGuide: 'Guide with exact range semantics'
      }
    ],
    modelProfile: profile
  };
  const settings = {
    model: 'model',
    temperature: 0.25,
    maxOutputTokens: 500,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read',
          parameters: { type: 'object', properties: {} }
        }
      }
    ],
    responseFormat: {
      type: 'json_schema',
      schema: { type: 'object', properties: { answer: { type: 'string' } } }
    }
  };
  const ordinary = await admission.assemble(input, settings, 500);
  const transition = await admission.assemble(
    { ...input, window: new ModelWindow() },
    settings,
    500
  );
  await admission.admit(ordinary.compiled, profile);
  assert.equal(ordinary.compiled.inputIdentity, transition.compiled.inputIdentity);
  assert.deepEqual(ordinary.compiled.logicalRequest.responseFormat, settings.responseFormat);
  assert.equal(ordinary.compiled.logicalRequest.temperature, 0.25);
  assert.ok(
    ordinary.request.messages.some((item) =>
      item.content.includes('Guide with exact range semantics')
    )
  );
  assert.equal(ordinary.assembly.context.items[0].id, 'source-rev-1');
});
test('native admission checks retained input identity and rejects a contradictory compiled body', async () => {
  const compiled = await compileModelRequest({
    request: {
      model: 'model',
      messages: [{ role: 'user', content: 'Next' }],
      maxOutputTokens: 500
    },
    profile,
    endpoint: 'fixture',
    body: { input: 'Next' },
    retainedBody: { input: 'Original native input' }
  });
  await admission.admit(compiled, profile);
  await assert.rejects(
    admission.admit({ ...compiled, retainedBody: { input: 'changed' } }, profile),
    /identity/
  );
});
test('separate reasoning consumes the same compiled capacity as output reservation', async () => {
  const small = {
    ...profile,
    limits: { contextTokens: 150, outputTokens: 1000 },
    capabilities: { ...profile.capabilities, protocol: { reasoningAccounting: 'separate' } }
  };
  const compiled = await compileModelRequest({
    request: {
      model: 'model',
      messages: [{ role: 'user', content: 'input' }],
      maxOutputTokens: 100,
      reasoning: { strategy: 'budget', maxTokens: 100 }
    },
    profile: small,
    endpoint: 'fixture',
    body: { input: 'input' }
  });
  await assert.rejects(admission.admit(compiled, small), ContextAdmissionError);
});

test('selected state references use the shared replacement lifecycle', async () => {
  const window = new ModelWindow();
  const state = {
    id: 'state-1', sourceUri: 'session://state/1', sourceKind: 'generated',
    representation: 'full', mediaType: 'application/json', title: 'Session state',
    content: '{"goal":"Finish repair"}', purpose: 'Current understanding'
  };
  const input = { runId: 'run', window, task: 'Repair', instructions: [], tools: [],
    modelProfile: profile, contextItems: [state] };
  const settings = { model: profile.id, maxOutputTokens: 500 };
  const initial = await admission.assemble(input, settings, 500);
  window.bindContinuation({ runId: 'run', request: initial.request,
    presentation: initial.assembly.presentation });
  window.recordInput('answer', { role: 'assistant', content: 'Progress' });
  const continued = await admission.assemble(input, settings, 500);
  assert.deepEqual(continued.request.messages.slice(0, initial.request.messages.length), initial.request.messages);
  assert.equal(continued.request.messages.filter(item => item.content.includes('Finish repair')).length, 1);
  assert.equal(continued.request.messages.at(-1).content, 'Progress');
  const replaced = await admission.assemble({ ...input, contextItems: [{ ...state,
    id: 'state-2', content: '{"goal":"Verify repair"}' }] }, settings, 500);
  assert.match(replaced.request.messages.at(-1).content, /context-selection-replacement/);
  const removed = await admission.assemble({ ...input, contextItems: [] }, settings, 500);
  assert.match(removed.request.messages.at(-1).content, /There are no current items/);
});

test('generated tool guidance uses the supported system authority channel', async () => {
  const input = { window: new ModelWindow(), task: 'Repair', instructions: [],
    modelProfile: { ...profile, capabilities: { ...profile.capabilities,
      protocol: { roles: ['system', 'user', 'assistant'] } } },
    tools: [{ name: 'read', description: 'Read', inputFormat: 'JSON', accessModes: ['read'],
      promptGuide: 'Keep original evidence' }] };
  const assembly = await new ModelRequestAssembler().assemble(input);
  assert.equal(assembly.messages[0].role, 'system');
  assert.equal(assembly.messages[0].content, 'Keep original evidence');
  assert.equal(assembly.messages.some(item => item.role === 'developer'), false);
});


test('hard compiled exhaustion and recovery reserve pressure are distinct', async () => {
  const request = { model: 'model', messages: [{ role: 'user', content: 'input' }], maxOutputTokens: 500 };
  const compiled = await compileModelRequest({ request, profile, endpoint: 'fixture', body: { input: 'input' }, providerInputTokens: 39000 });
  const reserve = new ContextAdmissionError(compiled, new Error('Reserve pressure'), false, 1000);
  assert.equal(reserve.hardCapacityExceeded, false);
  assert.equal(reserve.recoveryReserveExceeded, true);
  assert.equal(reserve.capacityExceeded, true);
  const overflow = await compileModelRequest({ request, profile, endpoint: 'fixture', body: { input: 'input' }, providerInputTokens: 40001 });
  const hard = new ContextAdmissionError(overflow, new Error('Hard overflow'), false, 1000);
  assert.equal(hard.hardCapacityExceeded, true);
  assert.equal(hard.recoveryReserveExceeded, false);
  assert.equal(hard.capacityExceeded, true);
});
