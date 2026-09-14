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
