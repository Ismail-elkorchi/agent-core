import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRequestAssembler, ModelWindow, RequestAdmission, InferenceService, InMemoryInferenceRepository } from '@agent-core/runtime';
import { hashJson, InMemoryArtifactRepository } from '@agent-core/persistence';

const profile = {
  id: 'model', provider: 'fixture',
  capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [],
    jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 40000, outputTokens: 1000 }, supportedParameters: ['maxOutputTokens']
};
const item = (id, content = id) => ({ id, sourceUri: `app://${id}`, sourceKind: 'external',
  representation: 'full', mediaType: 'text/plain', title: id, content, purpose: 'Reference' });
const assembler = new ModelRequestAssembler();
async function bound(contextItems, capacityNotice) {
  const window = new ModelWindow();
  const input = { runId: 'run', window, task: 'Continue', instructions: [], tools: [],
    contextItems, ...(capacityNotice ? { capacityNotice } : {}), modelProfile: profile };
  const initial = await assembler.assemble(input);
  const request = { model: profile.id, messages: initial.messages };
  window.bindContinuation({ runId: 'run', request, presentation: initial.presentation });
  window.recordInput('answer', { role: 'assistant', content: 'Historical answer remains evidence' });
  return { input, initial, request, window };
}

for (const [name, next] of [
  ['empty removal', []],
  ['partial removal', [item('A', 'old A')]],
  ['replacement', [item('A', 'new A'), item('B')]],
  ['addition', [item('A', 'old A'), item('B'), item('C')]],
  ['reordering', [item('B'), item('A', 'old A')]]
]) {
  test(`bound host-context ${name} explicitly supersedes applicability without changing the native prefix`, async () => {
    const state = await bound([item('A', 'old A'), item('B')]);
    const before = structuredClone(state.window.continuation());
    const continued = await assembler.assemble({ ...state.input, contextItems: next });
    assert.deepEqual(continued.messages.slice(0, state.request.messages.length), state.request.messages);
    assert.match(continued.messages.at(-1).content, /Removed or superseded item revisions remain historical evidence only/);
    assert.match(continued.messages.at(-1).content, /context-selection-replacement kind="host-context"/);
    assert.deepEqual(continued.presentation.context.items.map(value => value.id), next.map(value => value.id));
    if (!next.length) assert.match(continued.messages.at(-1).content, /There are no current items/);
    if (name === 'reordering' || name === 'partial removal') {
      assert.doesNotMatch(continued.messages.at(-1).content, /<context id=/);
      assert.match(continued.messages.at(-1).content, /No new item bodies/);
    }
    assert.deepEqual(state.window.continuation(), before);
    const fresh = await assembler.assemble({ ...state.input, window: new ModelWindow(), contextItems: next });
    assert.deepEqual(fresh.presentation.context.items.map(value => value.id), next.map(value => value.id));
    assert.equal(fresh.presentation.context.fingerprint, hashJson(next.length ? fresh.messages[0].content : ''));
    if (!next.some(value => value.content === 'old A')) assert.doesNotMatch(JSON.stringify(fresh.messages), /old A/);
  });
}

test('unchanged current selection preserves the exact native prefix and historical tail', async () => {
  const state = await bound([item('A'), item('B')], item('capacity', 'Current notice'));
  const continued = await assembler.assemble(state.input);
  assert.deepEqual(continued.messages.slice(0, state.request.messages.length), state.request.messages);
  assert.equal(continued.messages.length, state.request.messages.length + 1);
  assert.equal(continued.messages.at(-1).content, 'Historical answer remains evidence');
  assert.deepEqual(continued.presentation, state.initial.presentation);
  assert.deepEqual(continued.presentation.context, {
    kind: 'host-context', applicability: 'current-request', update: 'replace',
    items: state.initial.presentation.context.items,
    fingerprint: hashJson(state.initial.messages[0].content)
  });
  assert.equal(Object.isFrozen(continued.presentation.context.items), true);
  assert.equal(Object.isFrozen(continued.presentation), true);
});

for (const [name, next] of [['removal', undefined], ['replacement', item('capacity', 'New notice')]]) {
  test(`runtime notice ${name} cannot silently retain stale applicability`, async () => {
    const state = await bound([], item('capacity', 'Old notice'));
    const continued = await assembler.assemble({ ...state.input, capacityNotice: next });
    assert.deepEqual(continued.messages.slice(0, state.request.messages.length), state.request.messages);
    assert.match(continued.messages.at(-1).content, /Removed or superseded item revisions remain historical evidence only/);
    assert.match(continued.messages.at(-1).content, /context-selection-replacement kind="runtime-notice"/);
    assert.ok(continued.messages.at(-1).content.includes(state.initial.presentation.capacityNotice.fingerprint));
    if (!next) assert.match(continued.messages.at(-1).content, /There are no current items/);
    const fresh = await assembler.assemble({ ...state.input, window: new ModelWindow(), capacityNotice: next });
    assert.doesNotMatch(JSON.stringify(fresh.messages), /Old notice/);
    assert.equal(fresh.presentation.capacityNotice.items.length, next ? 1 : 0);
    assert.equal(fresh.presentation.capacityNotice.kind, 'runtime-notice');
  });
}

test('a rejected fresh request cannot publish its replacement presentation into the bound window', async () => {
  const state = await bound([item('A', 'old A')]);
  const before = structuredClone(state.window.continuation());
  const provider = { id: 'fixture', implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'model' }),
    describeModel: async () => profile,
    complete: async () => { throw new Error('No provider dispatch allowed'); } };
  const admission = new RequestAdmission(assembler, InferenceService.inMemory({ provider }));
  const fresh = await admission.assemble({ ...state.input, window: new ModelWindow(),
    contextItems: [item('A', 'new A'.repeat(2000))],
    modelProfile: { ...profile, limits: { contextTokens: 1024, outputTokens: 1000 } }
  }, { model: 'model', maxOutputTokens: 500 }, 500);
  await assert.rejects(admission.admit(fresh.compiled, profile));
  assert.deepEqual(state.window.continuation(), before);
  const resumed = await assembler.assemble(state.input);
  assert.deepEqual(resumed.presentation, before.input.presentation);
  assert.match(JSON.stringify(resumed.messages), /old A/);
  assert.doesNotMatch(JSON.stringify(resumed.messages), /new A/);
});

test('content revisions are exact while token estimation is not source identity', async () => {
  const state = await bound([item('A', 'Original')]);
  const same = await assembler.assemble({ ...state.input, contextItems: [{ ...item('A', 'Original'), tokenEstimate: 999 }] });
  assert.deepEqual(same.presentation.context, state.initial.presentation.context);
  const changed = await assembler.assemble({ ...state.input, window: new ModelWindow(), contextItems: [item('A', 'Changed')] });
  assert.equal(changed.presentation.context.items[0].id, 'A');
  assert.notEqual(changed.presentation.context.items[0].revision, same.presentation.context.items[0].revision);
});

test('explicit applicability replacements do not require unsupported provider reset', async () => {
  const state = await bound([item('A')], item('capacity'));
  const modelProfile = { ...profile, capabilities: { ...profile.capabilities,
    protocol: { roles: ['system', 'user', 'assistant'], contextReset: 'unsupported' } } };
  const continued = await assembler.assemble({ ...state.input, modelProfile,
    contextItems: [], capacityNotice: undefined });
  assert.deepEqual(continued.messages.slice(0, state.request.messages.length), state.request.messages);
  assert.equal(continued.messages.filter(message => message.content.includes('<context-selection-replacement')).length, 2);
  assert.deepEqual(continued.presentation.context.items, []);
  assert.deepEqual(continued.presentation.capacityNotice.items, []);
  assert.deepEqual(continued.continuationSource.messages.slice(0, state.request.messages.length), state.request.messages);
});

test('durable inference input records the exact admitted replacement and current manifest', async () => {
  const state = await bound([item('A')], item('capacity'));
  const artifacts = new InMemoryArtifactRepository();
  const repository = new InMemoryInferenceRepository();
  const dispatched = [];
  const provider = { id: 'fixture', implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'model' }),
    describeModel: async () => profile,
    complete: async request => { dispatched.push(request); return {
      provider: 'fixture', model: 'model', content: 'Done', terminationReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }
    }; } };
  const inference = new InferenceService({ provider, repository, artifacts });
  const admission = new RequestAdmission(assembler, inference);
  const replacement = await admission.assemble({ ...state.input, contextItems: [], capacityNotice: undefined },
    { model: 'model', maxOutputTokens: 100 }, 100);
  await inference.invoke({ ownerId: 'owner', runId: 'run', invocationId: 'replacement', purpose: 'test',
    request: replacement.request, compiled: replacement.compiled, profile });
  const saved = await repository.load('owner', { invocationId: 'replacement' });
  const persisted = JSON.parse(new TextDecoder().decode(await artifacts.readVerified(saved.invocation.start.requestRef)));
  assert.deepEqual(persisted.presentation, replacement.assembly.presentation);
  assert.deepEqual(persisted.logical.messages, replacement.request.messages);
  assert.deepEqual(dispatched[0].messages, persisted.logical.messages);
  assert.deepEqual(persisted.presentation.context.items, []);
  assert.match(persisted.logical.messages.at(-1).content, /There are no current items/);
});

test('ten small revisions retain a 60KB unchanged body once with exact ordered manifests and persisted input', async () => {
  const stableText = 'UNCHANGED-LARGE-BODY-' + 'L'.repeat(60_000);
  const stable = item('stable', stableText);
  const window = new ModelWindow();
  const input = { runId: 'run', window, task: 'Continue', instructions: [], tools: [], modelProfile: profile };
  const artifacts = new InMemoryArtifactRepository();
  const repository = new InMemoryInferenceRepository();
  const provider = { id: 'fixture', implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'model' }),
    describeModel: async () => profile,
    complete: async () => ({ provider: 'fixture', model: 'model', content: 'Done', terminationReason: 'stop' }) };
  const inference = new InferenceService({ provider, repository, artifacts });
  const admission = new RequestAdmission(assembler, inference);
  const settings = { model: 'model', maxOutputTokens: 100 };
  let admitted = await admission.assemble({ ...input, contextItems: [stable, item('small', 'revision 0')] }, settings, 100);
  await admission.admit(admitted.compiled, profile);
  const stableRevision = admitted.assembly.presentation.context.items[0].revision;
  for (let index = 1; index <= 10; index++) {
    window.bindContinuation({ runId: 'run', request: admitted.request, presentation: admitted.assembly.presentation });
    const small = item('small', `revision ${index}`);
    const ordered = index % 2 ? [small, stable] : [stable, small];
    const next = await admission.assemble({ ...input, contextItems: ordered }, settings, 100);
    await admission.admit(next.compiled, profile);
    assert.deepEqual(next.request.messages.slice(0, admitted.request.messages.length), admitted.request.messages);
    const replacement = next.request.messages.at(-1).content;
    assert.ok(!replacement.includes(stableText));
    assert.match(replacement, /Unchanged exact item revisions remain applicable through the preserved prefix/);
    assert.ok(replacement.includes(`revision ${index}`));
    const superseded = JSON.parse(replacement.match(/<superseded>(.*?)<\/superseded>/s)[1]);
    assert.deepEqual(superseded, admitted.assembly.presentation.context.items.filter(ref => ref.id === 'small'));
    const current = JSON.parse(replacement.match(/<current>(.*?)<\/current>/s)[1]);
    assert.deepEqual(current, next.assembly.presentation.context.items);
    assert.deepEqual(current.map(ref => ref.id), ordered.map(ref => ref.id));
    assert.equal(current.find(ref => ref.id === 'stable').revision, stableRevision);
    admitted = next;
  }
  const body = JSON.stringify(admitted.request.messages);
  assert.equal(body.split(stableText).length - 1, 1);
  assert.ok(Buffer.byteLength(body) < Buffer.byteLength(stableText) + 30_000, 'Update bytes must follow changed material and manifests, not ten full bodies.');
  await inference.invoke({ ownerId: 'owner', runId: 'run', invocationId: 'ten-revisions', purpose: 'test',
    request: admitted.request, compiled: admitted.compiled, profile });
  const saved = await repository.load('owner', { invocationId: 'ten-revisions' });
  const persisted = JSON.parse(new TextDecoder().decode(await artifacts.readVerified(saved.invocation.start.requestRef)));
  assert.deepEqual(persisted.presentation, admitted.assembly.presentation);
  assert.deepEqual(persisted.logical.messages, admitted.request.messages);
});
