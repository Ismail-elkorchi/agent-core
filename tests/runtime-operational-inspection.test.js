import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { AgentRuntime, InferenceService, InMemoryInferenceRepository, agentEventCodec,
  resolveEffectiveToolCatalog, inspectCapabilitySnapshot, generationAllowance } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { adoptToolDefinition, ResourceLeaseCoordinator, toolRequirementsSatisfied, isToolAvailable } from '@agent-core/tools';

const profile = {
  id: 'inspection', provider: 'fixture',
  capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
    jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 16000, outputTokens: 2000 }, supportedParameters: ['maxOutputTokens']
};
const policy = { allowedRisks: ['read'] };
function tool(name, requirements, mode = 'read') {
  const effects = { accesses: [{ mode, scope: 'memory' }], lockScopes: [], recovery: { kind: 'unknown' } };
  return adoptToolDefinition({ name, implementationId: `tests/${name}@1`, description: name,
    jsonSchema: { type: 'object' }, outputSchema: z.strictObject({}), requirements,
    effectEnvelope: { accesses: effects.accesses, lockScopes: [] },
    decodeInput: () => ({ ok: true, input: {} }), canonicalizeInput: value => value,
    snapshotInput: value => value, deriveEffects: () => effects,
    bindExecution: () => ({ snapshot: {}, invoke: async () => ({ kind: 'result', output: {}, summary: 'ok',
      scope: { resources: ['memory'], coverage: 'complete' } }) }) });
}
function fixture(complete) {
  return { id: 'fixture', implementationId: 'tests/inspection-provider@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'inspection' }),
    describeModel: async () => profile, complete };
}
function response(request) {
  return { provider: 'fixture', model: request.model, content: 'done', terminationReason: 'stop',
    usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } };
}
function input(invocationId) {
  return { invocationId, ownerId: 'continuing-work', purpose: 'inspection-test',
    request: { model: 'inspection', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 100 } };
}

test('effective catalog uses the execution eligibility decisions and explains every missing requirement', () => {
  const tools = [tool('available'), tool('service', { services: ['files'] }),
    tool('image', { modelInputModalities: ['image'] }), tool('host', { hostCapabilities: ['shell'] }),
    tool('write', undefined, 'write'), tool('all', { services: ['files'], modelInputModalities: ['image'], hostCapabilities: ['shell'] }, 'write')];
  for (const host of [{}, { services: { files: {} }, modelInputModalities: ['text', 'image'], hostCapabilities: ['shell'] }]) {
    const result = resolveEffectiveToolCatalog({ bindingId: 'binding', tools, policy, host });
    assert.deepEqual(result.tools.map(t => t.name), tools.filter(t => isToolAvailable(t, policy) && toolRequirementsSatisfied(t, host)).map(t => t.name));
    for (const entry of result.snapshot.tools) assert.equal(entry.available, entry.reasons.length === 0);
    assert.ok(Object.isFrozen(result.snapshot.tools[0]));
  }
  const result = resolveEffectiveToolCatalog({ bindingId: 'binding', tools, policy, host: {} });
  assert.deepEqual(result.snapshot.tools.at(-1).reasons.map(r => r.kind), ['policy', 'service', 'model_input_modality', 'host_capability']);
  assert.notEqual(result.snapshot.revision, resolveEffectiveToolCatalog({ bindingId: 'other-binding', tools, policy, host: {} }).snapshot.revision);
});

test('capability pages are bounded, lossless, revision-bound and reject invalid cursors', () => {
  const tools = Array.from({ length: 70 }, (_, i) => tool(`tool_${i}`));
  const { snapshot } = resolveEffectiveToolCatalog({ bindingId: 'binding', tools, policy, host: {} });
  const first = inspectCapabilitySnapshot(snapshot);
  assert.equal(first.items.length, 32);
  assert.equal(first.coverage, 'partial');
  const second = inspectCapabilitySnapshot(snapshot, { offset: first.nextOffset, limit: 32, expectedRevision: first.revision });
  const third = inspectCapabilitySnapshot(snapshot, { offset: second.nextOffset, expectedRevision: first.revision });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(t => t.name), tools.map(t => t.name));
  assert.equal(third.nextOffset, undefined);
  assert.equal(inspectCapabilitySnapshot(snapshot, { limit: 128 }).coverage, 'complete');
  assert.throws(() => inspectCapabilitySnapshot(snapshot, { expectedRevision: 'stale' }), /revision changed/);
  for (const params of [{ limit: 0 }, { limit: 129 }, { offset: -1 }, { offset: 71 }, { offset: 0.5 }])
    assert.throws(() => inspectCapabilitySnapshot(snapshot, params), RangeError);
});

test('runtime configured and admitted tools match actual dispatched request without changing output allowance', async () => {
  const calls = [];
  const provider = fixture(async request => { calls.push(request); return response(request); });
  const artifacts = new InMemoryArtifactRepository();
  const service = new InferenceService({ provider, artifacts, repository: new InMemoryInferenceRepository() });
  const runtime = new AgentRuntime({ provider, model: 'inspection', inferenceService: service, maxOutputTokens: 64,
    inferenceOwnerId: 'continuing-work', toolBoundary: { authorizationPolicyId: 'tests/inspection@1', executionTargetId: 'tests/inspection' },
    repositories: { events: new InMemoryEventRepository(agentEventCodec), artifacts }, toolPolicy: policy,
    tools: [tool('available'), tool('artifact', { services: ['artifactRepository'] }), tool('image', { modelInputModalities: ['image'] }), tool('write', undefined, 'write')] });
  const before = await runtime.inspectOperational();
  assert.equal(before.lastAdmittedRequest, null);
  assert.equal(before.generation.outputReservation, 64);
  assert.equal(before.generation.enforcement, 'provider-cap');
  assert.equal((await runtime.run({ task: 'hello' }).result).state, 'ended');
  const after = await runtime.inspectOperational();
  const names = calls[0].tools.map(t => t.name ?? t.function?.name);
  assert.deepEqual(names, before.capabilities.items.filter(t => t.available).map(t => t.name));
  assert.deepEqual((await runtime.inspectOperational({ target: 'last_admitted' })).capabilities.items.map(t => t.name), names);
  assert.equal(typeof after.lastAdmittedRequest.inputIdentity, 'string');
  assert.equal(calls[0].maxOutputTokens, 64);
  assert.equal(after.allowance.ownerId, 'continuing-work');
  assert.equal(after.allowance.settled.invocations, 1);
  await runtime.close();
});

test('owner allowance separates settlement from outstanding exposure at one ledger cut, preserving unknown pricing', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const provider = fixture(async request => { if (++calls === 2) { entered(); await gate; } return response(request); });
  const repository = new InMemoryInferenceRepository();
  const service = new InferenceService({ provider, repository, artifacts: new InMemoryArtifactRepository(),
    budget: { maxInvocations: 3, maxCompletionTokens: 500 } });
  await service.invoke(input('settled'));
  const pending = service.invoke(input('outstanding'));
  await started;
  try {
    const before = await repository.load('continuing-work');
    const observed = await service.inspectOwnerAllowance('continuing-work');
    assert.deepEqual(observed.ledgerTail, before.tail);
    assert.equal(observed.settled.invocations, 1);
    assert.equal(observed.outstanding.invocations, 1);
    assert.equal(observed.outstanding.completionTokens, 100);
    assert.equal(observed.remaining.invocations, 1);
    assert.equal(observed.remaining.completionTokens, 390);
    assert.ok(observed.settled.unknownPricedTokens > 0);
    assert.ok(observed.outstanding.unknownPricedTokens > 0);
    assert.deepEqual(observed.settled.knownCosts, {});
    assert.equal('knownCost' in observed.remaining, false);
    assert.equal('promptTokens' in observed.remaining, false);
    assert.deepEqual((await repository.load('continuing-work')).tail, before.tail, 'Inspection must not reserve or write authority.');
    release(); await pending;
    assert.equal(observed.outstanding.invocations, 1, 'Later settlement must not change the earlier cut.');
    const after = await service.inspectOwnerAllowance('continuing-work');
    assert.equal(after.settled.invocations, 2);
    assert.equal(after.outstanding.invocations, 0);
    assert.equal(after.remaining.completionTokens, 480);
  } finally { release(); await pending; }
});

test('resource inspection bounds active handles and reports blocked waiters without granting access', async () => {
  const coordinator = new ResourceLeaseCoordinator();
  const effects = { accesses: [{ mode: 'write', scope: 'exclusive' }], lockScopes: [], recovery: { kind: 'unknown' } };
  const held = await coordinator.acquire(effects, 'owner');
  held.transferToResource('resource', 'control');
  const abort = new AbortController();
  const waiting = coordinator.acquire(effects, 'waiter', abort.signal);
  const rejected = assert.rejects(waiting, /cancelled/);
  for (let i = 0; i < 40; i++) coordinator.restoreResource(`resource_${i}`, { ...effects, accesses: [{ mode: 'read', scope: `other_${i}` }] }, `control_${i}`);
  const observed = coordinator.inspect(2);
  assert.equal(observed.activeCount, 41);
  assert.equal(observed.waitingCount, 1);
  assert.equal(observed.items.length, 2);
  assert.equal(observed.coverage, 'partial');
  assert.equal(coordinator.wouldWait(effects), true);
  coordinator.failResource('resource_0', new Error('unresolved'));
  assert.equal(coordinator.inspect(2).items[1].status, 'unresolved');
  assert.equal(observed.items[1].status, 'active');
  assert.throws(() => coordinator.inspect(129), RangeError);
  abort.abort(new Error('cancelled')); await rejected;
  held.release();
  for (let i = 0; i < 40; i++) coordinator.releaseResource(`resource_${i}`);
  assert.equal(coordinator.inspect().coverage, 'complete');
  assert.equal(coordinator.inspect().activeCount, 0);
});

test('application generation ceiling respects finite model bounds without inventing unavailable limits', () => {
  assert.equal(generationAllowance(profile, 4096), 2000);
  assert.equal(generationAllowance({ ...profile, limits: { contextTokens: 1000 } }, 4096), 500);
  assert.equal(generationAllowance({ ...profile, limits: {} }, 4096), 4096);
  assert.equal(generationAllowance(profile, 64), 64);
  assert.throws(() => generationAllowance(profile, 0), RangeError);
});
