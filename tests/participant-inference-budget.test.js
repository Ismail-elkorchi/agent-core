import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import {
  InferenceService, InMemoryInferenceRepository, InferenceBudgetExceededError,
  InferenceOutcomeUnknownError, inferenceEventCodec
} from '@agent-core/runtime';
import { JsonlInferenceRepository } from '@agent-core/runtime/node';
import { recordInferenceEvents } from './inference-audit-helper.js';

const profile = {
  id: 'scope-fixture', provider: 'scope-fixture',
  capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [],
    jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 4096, outputTokens: 128 }, supportedParameters: ['maxOutputTokens']
};
function response() {
  return { provider: profile.provider, model: profile.id, content: 'Done', terminationReason: 'stop',
    usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } };
}
function provider(complete = async () => response()) {
  return { id: profile.provider, implementationId: 'tests/participant-scopes@1',
    describe: () => ({ id: profile.provider, displayName: 'Scoped fixture', defaultModel: profile.id }),
    describeModel: async () => profile, complete };
}
function input(invocationId, participantId = 'alice') {
  return { ownerId: 'work', invocationId, participantId, budgetScopeId: `scope-${participantId}`,
    runId: `run-${invocationId}`, purpose: 'test',
    request: { model: profile.id, messages: [{ role: 'user', content: 'Inspect this input.' }], maxOutputTokens: 16 } };
}
function register(service, participantId = 'alice', budget = {}) {
  return service.registerBudgetScope({ ownerId: 'work', participantId, scopeId: `scope-${participantId}`, budget });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const constraint of ['aggregate', 'participant']) {
  test(`${constraint} admission survives a forced overlapping owner CAS race`, async () => {
    const repository = new InMemoryInferenceRepository();
    const artifacts = new InMemoryArtifactRepository();
    let calls = 0;
    const fixture = provider(async () => { calls++; return response(); });
    const budget = { maxInvocations: constraint === 'aggregate' ? 1 : 10 };
    const first = new InferenceService({ provider: fixture, repository, artifacts, budget });
    const second = new InferenceService({ provider: fixture, repository, artifacts, budget });
    await register(first, 'alice', { maxInvocations: 1 });
    if (constraint === 'aggregate') await register(first, 'bob', { maxInvocations: 1 });
    const barrier = deferred();
    const append = repository.append.bind(repository);
    let arrivals = 0;
    let stale = 0;
    repository.append = async (ownerId, event, tail) => {
      if (event.type === 'inference.started') {
        if (++arrivals === 2) barrier.resolve();
        await barrier.promise;
      }
      const committed = await append(ownerId, event, tail);
      if (!committed) stale++;
      return committed;
    };
    const results = await Promise.allSettled([
      first.invoke(input('first')),
      second.invoke(input('second', constraint === 'aggregate' ? 'bob' : 'alice'))
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failed = results.find(result => result.status === 'rejected').reason;
    assert.ok(failed instanceof InferenceBudgetExceededError);
    assert.equal(failed.diagnostic.budgetScopeId, constraint === 'aggregate' ? undefined : 'scope-alice');
    assert.equal(calls, 1);
    assert.equal(stale, 1, 'The loser must retry against the committed owner cut.');
    const state = await repository.load('work');
    assert.equal(state.committed.invocations, 1);
    assert.equal(Object.values(state.budgetScopes).reduce((sum, scope) => sum + scope.committed.invocations, 0), 1);
  });
}

test('durable participant scopes reject policy changes, omission, substitution and new-run resets after reopen', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'participant-inference-'));
  try {
    let calls = 0;
    const fixture = provider(async () => { calls++; return response(); });
    const artifacts = new InMemoryArtifactRepository();
    let repository = new JsonlInferenceRepository({ rootDir });
    const service = new InferenceService({ provider: fixture, repository, artifacts, budget: { maxInvocations: 3 } });
    await register(service, 'alice', { maxInvocations: 1 });
    await register(service, 'bob', { maxInvocations: 2 });
    const original = await service.invoke(input('original'));
    repository = new JsonlInferenceRepository({ rootDir });
    const reopened = new InferenceService({ provider: fixture, repository, artifacts });
    assert.equal((await register(reopened, 'alice', { maxInvocations: 1 })).settledUsage.invocations, 1);
    assert.equal((await reopened.invoke(input('original'))).replayed, true);
    assert.equal(original.budgetScopeId, 'scope-alice');
    await assert.rejects(reopened.invoke(input('another-run')), InferenceBudgetExceededError);
    await assert.rejects(register(reopened, 'alice', { maxInvocations: 2 }), /policy changed/);
    await assert.rejects(reopened.registerBudgetScope({ ownerId: 'work', participantId: 'alice', scopeId: 'replacement', budget: {} }), /scope or policy changed/);
    await assert.rejects(reopened.registerBudgetScope({ ownerId: 'work', participantId: 'charlie', scopeId: 'scope-alice', budget: {} }), /scope or policy changed/);
    const { participantId: _participantId, budgetScopeId: _budgetScopeId, ...unscoped } = input('omitted');
    await assert.rejects(reopened.invoke(unscoped), /cannot be omitted/);
    await assert.rejects(reopened.invoke({ ...input('substituted'), budgetScopeId: 'scope-bob' }), /registered participant/);
    await assert.rejects(reopened.invoke({ ...input('original'), budgetScopeId: 'scope-bob' }), /differs from its admitted/);
    await assert.rejects(reopened.invoke({ ...input('partial'), budgetScopeId: undefined }), /identity and purpose/);
    await assert.rejects(new InferenceService({ provider: fixture, repository, artifacts, budget: { maxInvocations: 1 } })
      .invoke(input('bob-next', 'bob')), /owner budget policy changed/);
    await reopened.invoke(input('bob-next', 'bob'));
    const snapshot = await reopened.inspectBudgetScopeAllowance('work', 'scope-alice');
    assert.equal(snapshot.remaining.invocations, 0);
    assert.equal(snapshot.settled.invocations, 1);
    assert.equal(snapshot.outstanding.invocations, 0);
    assert.match(snapshot.meaning, /not a hard monetary ceiling/);
    assert.equal((await reopened.settledRunUsage('work', 'run-original')).invocations, 1);
    assert.equal(calls, 2);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('scope registration preserves prior standalone usage and allows its late settlement', async () => {
  const repository = new InMemoryInferenceRepository();
  const started = deferred();
  const release = deferred();
  const fixture = provider(async () => { started.resolve(); await release.promise; return response(); });
  const service = new InferenceService({ provider: fixture, repository, artifacts: new InMemoryArtifactRepository(), budget: { maxInvocations: 1 } });
  const { participantId: _participantId, budgetScopeId: _budgetScopeId, ...ordinary } = input('ordinary');
  const pending = service.invoke(ordinary);
  await started.promise;
  await register(service, 'alice', { maxInvocations: 2 });
  await assert.rejects(service.invoke(input('scoped')), InferenceBudgetExceededError);
  release.resolve();
  await pending;
  assert.equal((await service.invoke(ordinary)).replayed, true);
  const state = await repository.load('work');
  assert.equal(state.settledUsage.invocations, 1);
  assert.equal(state.budgetScopes['scope-alice'].settledUsage.invocations, 0);
});

test('not-sent releases both reservations once and unknown prices remain explicit on settlement', async () => {
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  let calls = 0;
  const fixture = provider(async () => { calls++; return response(); });
  const denied = new InferenceService({ provider: fixture, repository, artifacts, budget: { maxInvocations: 1 },
    admitRequest() { throw new Error('Local authority denied'); } });
  await register(denied, 'alice', { maxInvocations: 1, maxKnownCost: { currency: 'USD', amount: 0 } });
  await assert.rejects(denied.invoke(input('not-sent')), /Local authority denied/);
  await assert.rejects(denied.invoke(input('not-sent')), /Local authority denied/);
  let state = await repository.load('work');
  assert.equal(state.committed.invocations, 0);
  assert.equal(state.budgetScopes['scope-alice'].committed.invocations, 0);
  assert.equal(calls, 0);
  const allowed = new InferenceService({ provider: fixture, repository, artifacts });
  const settled = await allowed.invoke(input('sent'));
  assert.equal(settled.cost.status, 'unknown');
  state = await repository.load('work');
  assert.equal(state.committed.invocations, 1);
  assert.equal(state.budgetScopes['scope-alice'].committed.invocations, 1);
  assert.equal(state.budgetScopes['scope-alice'].committed.unknownPricedTokens, 12);
  assert.deepEqual(state.budgetScopes['scope-alice'].committed, state.committed);
});

test('abort retains aggregate and scope exposure until the original late outcome settles exactly once', async () => {
  const repository = new InMemoryInferenceRepository();
  const started = deferred();
  const release = deferred();
  const settled = deferred();
  const append = repository.append.bind(repository);
  repository.append = async (ownerId, event, tail) => {
    const committed = await append(ownerId, event, tail);
    if (committed && event.type === 'inference.settled') settled.resolve();
    return committed;
  };
  let calls = 0;
  const service = new InferenceService({ repository, artifacts: new InMemoryArtifactRepository(), budget: { maxInvocations: 2 },
    provider: provider(async () => { calls++; started.resolve(); await release.promise; return response(); }) });
  await register(service, 'alice', { maxInvocations: 1 });
  const controller = new AbortController();
  const active = service.invoke({ ...input('late'), signal: controller.signal });
  await started.promise;
  controller.abort(new Error('cancelled'));
  await assert.rejects(active, InferenceOutcomeUnknownError);
  const uncertain = await repository.load('work', { invocationId: 'late' });
  assert.ok(uncertain.invocation.uncertain);
  assert.deepEqual(uncertain.committed, uncertain.budgetScopes['scope-alice'].committed);
  assert.equal(uncertain.budgetScopes['scope-alice'].settledUsage.invocations, 0);
  await assert.rejects(service.invoke(input('late')), InferenceOutcomeUnknownError);
  await assert.rejects(service.invoke(input('blocked')), error => error.diagnostic?.budgetScopeId === 'scope-alice');
  release.resolve();
  await settled.promise;
  assert.equal((await service.invoke(input('late'))).replayed, true);
  const state = await repository.load('work');
  assert.equal(state.committed.invocations, 1);
  assert.equal(state.budgetScopes['scope-alice'].settledUsage.invocations, 1);
  assert.equal(state.budgetScopes['scope-alice'].committed.usage.completionTokens, 4);
  assert.deepEqual(state.committed, state.budgetScopes['scope-alice'].committed);
  assert.equal(calls, 1);
});

for (const constraint of ['none', 'aggregate', 'participant']) {
  test(`native successor and replacement extension charge both ledgers (${constraint} extension limit)`, async () => {
    const repository = new InMemoryInferenceRepository();
    const audit = recordInferenceEvents(repository);
    const nativeProfile = { ...profile, capabilities: { ...profile.capabilities, streaming: true } };
    const service = new InferenceService({ provider: { ...provider(), describeModel: async () => nativeProfile }, repository,
      artifacts: new InMemoryArtifactRepository(), budget: { maxCompletionTokens: constraint === 'aggregate' ? 40 : 100 } });
    await register(service, 'alice', { maxCompletionTokens: constraint === 'participant' ? 40 : 100 });
    const request = input('native').request;
    const compiled = await service.compile(request, nativeProfile);
    const extended = await service.compile({ ...request, maxOutputTokens: 64 }, nativeProfile);
    const boundary = (responseId, value, deliveryIds = [], previousResponseId) => ({ responseId, deliveryIds,
      ...(previousResponseId ? { previousResponseId } : {}), requiredToolCallIds: [], pendingToolCalls: [],
      continuation: 'client', inputIdentity: value.inputIdentity, catalogIdentity: 'catalog', request: value.logicalRequest });
    let extensionFailure;
    const active = service.invokeNative({ ...input('native'), request, compiled, profile: nativeProfile,
      session: { complete: async () => { throw new Error('Expected stream'); },
        async *streamCompiled(_compiled, transport) {
          yield { type: 'response_boundary', response: { ...response(), requestId: 'r1' }, native: boundary('r1', compiled) };
          const dispatch = { kind: 'steering', responseId: 'r1', sourceCalls: [], generationDeliveryId: 'successor' };
          await transport.native.admit({ ...dispatch, compiled, deliveryId: 'first' });
          try { await transport.native.admit({ ...dispatch, compiled: extended, deliveryId: 'extended' }); }
          catch (error) { extensionFailure = error; throw error; }
          const state = await repository.load('work');
          assert.equal(state.committed.invocations, 2);
          assert.equal(state.committed.usage.completionTokens, 68);
          assert.deepEqual(state.committed, state.budgetScopes['scope-alice'].committed);
          yield { type: 'response_boundary', response: { ...response(), requestId: 'r2' },
            native: boundary('r2', extended, ['first', 'extended'], 'r1') };
          yield { type: 'done', response: response() };
        } }, start: async () => {}, settled: async () => {}, uncertain: async () => {} });
    if (constraint === 'none') {
      const results = await active;
      assert.equal(results.length, 2);
      assert.ok(results.every(result => result.context.budgetScopeId === 'scope-alice' && result.result.participantId === 'alice'));
      assert.equal(audit.filter(({ event }) => event.type === 'inference.extended').length, 1);
    } else {
      await assert.rejects(active);
      assert.ok(extensionFailure instanceof InferenceBudgetExceededError);
      assert.equal(extensionFailure.diagnostic.budgetScopeId, constraint === 'participant' ? 'scope-alice' : undefined);
      assert.equal(audit.filter(({ event }) => event.type === 'inference.extended').length, 0);
    }
    const state = await repository.load('work');
    assert.equal(state.committed.invocations, 2);
    assert.equal(state.committed.usage.completionTokens, constraint === 'none' ? 8 : 20);
    assert.equal(state.budgetScopes['scope-alice'].settledUsage.invocations, constraint === 'none' ? 2 : 1);
    assert.deepEqual(state.committed, state.budgetScopes['scope-alice'].committed);
    const starts = audit.filter(({ event }) => event.type === 'inference.started');
    assert.equal(starts.length, 2);
    assert.ok(starts.every(({ event }) => event.participantId === 'alice' && event.budgetScopeId === 'scope-alice'));
  });
}

test('obsolete inference record format is rejected instead of silently omitting scope provenance', async () => {
  const repository = new InMemoryInferenceRepository();
  const audit = recordInferenceEvents(repository);
  const service = new InferenceService({ provider: provider(), repository, artifacts: new InMemoryArtifactRepository() });
  await register(service);
  await service.invoke(input('current'));
  const start = audit.find(({ event }) => event.type === 'inference.started').event;
  assert.equal(start.format, 'agent-core.inference/2');
  assert.throws(() => inferenceEventCodec.decode({ ...start, format: 'agent-core.inference/1' }), /Incompatible inference format/);
});

test('unavailable outcome retains participant reservations across JSONL reopen', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'participant-uncertain-'));
  try {
    const artifacts = new InMemoryArtifactRepository();
    let calls = 0;
    const fixture = provider(async () => { calls++; throw new Error('Connection lost after dispatch'); });
    const original = new InferenceService({ provider: fixture, artifacts,
      repository: new JsonlInferenceRepository({ rootDir }), budget: { maxInvocations: 10 } });
    await register(original, 'alice', { maxInvocations: 1 });
    await assert.rejects(original.invoke(input('unknown')), InferenceOutcomeUnknownError);
    const reopened = new InferenceService({ provider: fixture, artifacts, repository: new JsonlInferenceRepository({ rootDir }) });
    await assert.rejects(reopened.invoke(input('unknown')), InferenceOutcomeUnknownError);
    await assert.rejects(reopened.invoke(input('fresh')), error => error.diagnostic?.budgetScopeId === 'scope-alice');
    const allowance = await reopened.inspectBudgetScopeAllowance('work', 'scope-alice');
    assert.equal(allowance.outstanding.invocations, 1);
    assert.equal(allowance.settled.invocations, 0);
    assert.equal(allowance.remaining.invocations, 0);
    assert.equal(calls, 1);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('participant known-cost limit records actual overspend before rejecting the next admission', async () => {
  const priced = { ...profile, pricing: { currency: 'USD', rates: { input: 1, output: 1 } } };
  const repository = new InMemoryInferenceRepository();
  let calls = 0;
  const fixture = { ...provider(async () => { calls++; return { ...response(),
    usage: { promptTokens: 300, completionTokens: 100, totalTokens: 400 } }; }), describeModel: async () => priced };
  const service = new InferenceService({ provider: fixture, repository, artifacts: new InMemoryArtifactRepository(),
    budget: { maxKnownCost: { currency: 'USD', amount: 1 } } });
  await register(service, 'alice', { maxKnownCost: { currency: 'USD', amount: 0.0003 } });
  const actual = await service.invoke(input('priced'));
  assert.ok(actual.cost.amount > 0.0003);
  await assert.rejects(service.invoke(input('over')), error => {
    assert.equal(error.diagnostic.budgetScopeId, 'scope-alice');
    assert.equal(error.resource, 'known_cost');
    assert.equal(error.diagnostic.settled, actual.cost.amount);
    return true;
  });
  const state = await repository.load('work');
  assert.equal(state.budgetScopes['scope-alice'].settledUsage.knownCosts.USD, actual.cost.amount);
  assert.equal(state.settledUsage.knownCosts.USD, actual.cost.amount);
  assert.equal(calls, 1);
});

test('participant prompt cap cannot silently ignore unquantified input under an unbounded aggregate', async () => {
  const { createProviderContextState } = await import('@agent-core/model');
  const initial = input('opaque');
  const state = await createProviderContextState({ provider: profile.provider, endpoint: profile.provider,
    protocolRevision: 'test', request: initial.request, requestId: 'previous', kind: 'opaque',
    requiresExactPrefix: false, data: { encrypted: 'opaque-state' } });
  const request = { ...initial.request, messages: [...initial.request.messages, { role: 'protocol', content: '', state }] };
  let calls = 0;
  const service = InferenceService.inMemory({ provider: provider(async () => { calls++; return response(); }) });
  await register(service, 'alice', { maxPromptTokens: 100 });
  await assert.rejects(service.invoke({ ...initial, request }), error => {
    assert.equal(error.diagnostic.budgetScopeId, 'scope-alice');
    assert.equal(error.resource, 'prompt_tokens');
    assert.equal(error.diagnostic.inputAccounting.basis, 'model_input_bound');
    assert.equal(error.diagnostic.candidate, 4080);
    return true;
  });
  assert.equal(calls, 0);
});

test('not-sent cancellation cannot omit or substitute a scoped invocation binding', async () => {
  const repository = new InMemoryInferenceRepository();
  const reached = deferred();
  const release = deferred();
  const fixture = provider(async () => response());
  const service = new InferenceService({ provider: fixture, repository, artifacts: new InMemoryArtifactRepository(),
    async admitRequest() { reached.resolve(); await release.promise; throw new Error('Authority cancelled'); } });
  await register(service);
  const original = input('cancel-scope');
  const active = service.invoke(original);
  await reached.promise;
  const identity = { ownerId: original.ownerId, invocationId: original.invocationId, runId: original.runId };
  await assert.rejects(service.cancelBeforeDispatch(identity, 'invalid release'), /differs from its admitted/);
  await assert.rejects(service.cancelBeforeDispatch({ ...identity, participantId: 'alice', budgetScopeId: 'wrong' }, 'invalid release'), /differs from its admitted/);
  assert.equal((await repository.load('work')).committed.invocations, 1);
  release.resolve();
  await assert.rejects(active, /Authority cancelled/);
  assert.equal((await repository.load('work')).committed.invocations, 0);
});
