import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { SessionProviderBinding, InMemoryInferenceRepository, InMemorySessionRepository, AgentSession, AgentRunCoordinator, agentEventCodec, ContextService, HistoryReader } from '@agent-core/runtime';

const selection = { provider: 'first', model: 'model', endpoint: 'https://first.example' };
function provider(id, fail, image = false) {
  return { id, async describeModel(model) {
    if (fail) throw new Error('credentials unavailable');
    return { provider: id, id: model, capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [], jsonMode: true, jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: image ? ['text', 'image'] : ['text'], output: ['text'] }, limits: {}, supportedParameters: ['responseFormat'] };
  } };
}
async function fixture(resolveProvider, configuration = selection) {
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const repository = new InMemorySessionRepository();
  const expectedBinding = { schemaId: 'tests/provider-binding', schemaVersion: 1, subject: {} };
  const descriptor = await repository.create({ binding: expectedBinding });
  const initial = provider('first');
  const binding = new SessionProviderBinding({ provider: initial, selection, resolveProvider,
    artifacts, repository: new InMemoryInferenceRepository() });
  const history = new HistoryReader({ repository, session: descriptor, events, artifacts });
  const context = new ContextService({ repository, session: descriptor, history, artifacts, policy: { maxSourceBytes: 1000000 } });
  const dispatched = [];
  const agent = new AgentSession({ descriptor, expectedBinding, repository, configuration,
    scheduling: 'manual', providerBinding: binding, context, runs: new AgentRunCoordinator(events, artifacts),
    createRuntime(configuration) {
      dispatched.push({ configuration, provider: binding.provider });
      return { run(input) { return { runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), abort() {} }; } };
    } });
  return { agent, binding, initial, repository, descriptor, artifacts, dispatched };
}

test('cross-client endpoint and provider changes bind before acceptance and dispatch; formatting is client-local', async () => {
  const resolved = [];
  const f = await fixture(next => { resolved.push(next); return provider(next.provider); });
  const next = { provider: 'second', model: 'different', endpoint: 'https://second.example' };
  await f.agent.configure({ responseFormat: 'json' });
  await f.repository.appendModelSettings(f.descriptor, next);
  const accepted = await f.agent.submit({ task: 'Use exact new endpoint' });
  assert.deepEqual(resolved, [next]);
  assert.equal(f.binding.provider.id, 'second');
  assert.equal(f.agent.state().configuration.responseFormat, 'json');
  await f.agent.startNextSubmission();
  await accepted.completion;
  assert.equal(f.dispatched[0].provider.id, 'second');
  assert.equal(f.dispatched[0].configuration.endpoint, next.endpoint);
  await f.agent.close();
});

for (const reason of ['credentials', 'parameters', 'images']) test(`failed ${reason} validation preserves old binding and accepts no input`, async () => {
  const f = await fixture(next => provider(next.provider, reason === 'credentials'));
  const oldInference = f.binding.inference;
  await f.repository.appendModelSettings(f.descriptor, { provider: 'second', model: 'model', ...(reason === 'parameters' ? { temperature: 0.5 } : {}) });
  const images = reason === 'images' ? [{ artifact: await f.artifacts.store({ label: 'image', content: new Uint8Array([1]), mediaType: 'image/png' }) }] : undefined;
  await assert.rejects(f.agent.submit({ task: 'Reject before admission', ...(images ? { images } : {}) }), reason === 'images' ? /does not accept images/ : reason === 'parameters' ? /temperature/ : /credentials unavailable/);
  assert.equal(f.binding.provider, f.initial);
  assert.equal(f.binding.inference, oldInference);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  await f.agent.close();
});

test('durable model change failure retains old binding and retry recovers; pending work prevents replacement', async () => {
  const f = await fixture(next => provider(next.provider));
  const next = provider('second');
  const request = { selection: { provider: 'second', model: 'model' }, provider: next, profile: await next.describeModel('model'), artifacts: f.artifacts };
  const append = f.repository.appendModelSettings.bind(f.repository);
  f.repository.appendModelSettings = async () => { throw new Error('durability failed'); };
  const oldInference = f.binding.inference;
  await assert.rejects(f.agent.changeModel(request), /durability failed/);
  assert.equal(f.binding.provider, f.initial);
  assert.equal(f.binding.inference, oldInference);
  f.repository.appendModelSettings = append;
  await f.agent.changeModel(request);
  assert.equal(f.binding.provider, next);
  assert.notEqual(f.binding.inference, oldInference);
  const pending = await f.agent.submit({ task: 'Queued work' });
  await assert.rejects(f.agent.changeModel({ ...request, selection, provider: f.initial, profile: await f.initial.describeModel('model') }), /pending work/);
  assert.equal(f.binding.provider, next);
  const rejection = assert.rejects(pending.completion, /remains recorded/);
  await f.agent.close();
  await rejection;
});

for (const mismatch of ['adapter', 'profile']) test(`mismatched ${mismatch} cannot replace a binding`, async () => {
  const f = await fixture(() => mismatch === 'adapter' ? provider('wrong') : {
    ...provider('second'), async describeModel() { return { ...(await provider('wrong').describeModel('wrong')) }; }
  });
  await f.repository.appendModelSettings(f.descriptor, { provider: 'second', model: 'model' });
  await assert.rejects(f.agent.submit({ task: 'Reject mismatched provider identity' }), /does not match/);
  assert.equal(f.binding.provider, f.initial);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  await f.agent.close();
});

test('failed credential resolution recovers on retry without accepting the failed draft', async () => {
  let available = false;
  const f = await fixture(next => {
    if (!available) throw new Error('credentials unavailable');
    return provider(next.provider);
  });
  await f.repository.appendModelSettings(f.descriptor, { provider: 'second', model: 'model', endpoint: 'https://second.example' });
  await assert.rejects(f.agent.submit({ task: 'First draft' }), /credentials unavailable/);
  available = true;
  const accepted = await f.agent.submit({ task: 'Retry draft' });
  await f.agent.startNextSubmission();
  await accepted.completion;
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].provider.id, 'second');
  await f.agent.close();
});

test('prospective inspection follows durable selection without publishing a transport replacement', async () => {
  const f = await fixture(next => provider(next.provider));
  const first = await f.agent.inspectProviderBinding();
  await f.agent.configure({ responseFormat: 'json' });
  assert.equal((await f.agent.inspectProviderBinding()).bindingId, first.bindingId);
  const oldInference = f.binding.inference;
  const next = { ...selection, endpoint: 'https://other-endpoint.example' };
  await f.repository.appendModelSettings(f.descriptor, next);
  const inspected = await f.agent.inspectProviderBinding();
  assert.deepEqual(inspected.selection, next);
  assert.notEqual(inspected.bindingId, first.bindingId);
  assert.equal(f.binding.provider, f.initial);
  assert.equal(f.binding.inference, oldInference);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  await f.agent.close();
});


test('supported response formatting validates without replacing the exact adapter or inference', async () => {
  const f = await fixture(() => assert.fail('Formatting must not resolve another adapter'));
  const inference = f.binding.inference;
  const id = (await f.agent.inspectProviderBinding()).bindingId;
  await f.agent.configure({ responseFormat: 'json' });
  const accepted = await f.agent.submit({ task: 'Use supported JSON response formatting' });
  assert.equal(f.binding.provider, f.initial);
  assert.equal(f.binding.inference, inference);
  assert.equal((await f.agent.inspectProviderBinding()).bindingId, id);
  await f.agent.startNextSubmission();
  await accepted.completion;
  await f.agent.close();
});

test('unsupported client formatting rejects configuration and admission without replacing the binding', async () => {
  const f = await fixture(next => provider(next.provider));
  const inference = f.binding.inference;
  const responseFormat = { type: 'json_schema', schema: { type: 'object' } };
  await assert.rejects(f.agent.configure({ responseFormat }), /JSON Schema/);
  assert.equal(f.agent.state().configuration.responseFormat, undefined);
  const unsupported = await fixture(next => provider(next.provider), { ...selection, responseFormat });
  await assert.rejects(unsupported.agent.submit({ task: 'Unsupported format' }), /JSON Schema/);
  assert.deepEqual(await unsupported.repository.loadPendingSubmissions(unsupported.descriptor), []);
  await unsupported.agent.close();
  assert.equal(f.binding.provider, f.initial);
  assert.equal(f.binding.inference, inference);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  await f.agent.close();
});

test('model replacement validates retained client formatting before durable selection changes', async () => {
  const f = await fixture(next => provider(next.provider));
  await f.agent.configure({ responseFormat: 'json' });
  const target = provider('second');
  const profile = await target.describeModel('model');
  const unsupported = { ...target, describeModel: async () => ({ ...profile, capabilities: { ...profile.capabilities, jsonMode: false } }) };
  await assert.rejects(f.agent.changeModel({ selection: { provider: 'second', model: 'model' },
    provider: unsupported, profile: await unsupported.describeModel(), artifacts: f.artifacts }), /JSON mode/);
  assert.equal(f.binding.provider, f.initial);
  assert.equal(f.agent.state().configuration.provider, 'first');
  assert.equal(await f.repository.currentModelSettings(f.descriptor), undefined);
  await f.agent.close();
});
