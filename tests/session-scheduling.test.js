import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSession, SessionProviderBinding, InMemoryInferenceRepository, AgentRunCoordinator, agentEventCodec, InMemorySessionRepository, SessionSubmissionOwnershipError, SessionConfigurationChangedError } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'test.scheduling', schemaVersion: 1, subject: {} };
const configuration = { provider: 'test', model: 'model' };
function modelProvider(selection, describe = () => {}) {
  return { id: selection.provider, async describeModel(model) {
    await describe();
    return { id: model, provider: selection.provider,
      capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [], jsonMode: false, jsonSchema: false, logprobs: false, topP: false, reasoning: { strategies: [], canDisable: true, separateOutput: false }, temperature: true },
      modalities: { input: ['text'], output: ['text'] }, limits: {}, supportedParameters: ['temperature', 'reasoning'] };
  } };
}
function providerBinding(selection, describe) {
  return new SessionProviderBinding({ selection, provider: modelProvider(selection, describe),
    resolveProvider: next => modelProvider(next, describe),
    artifacts: new InMemoryArtifactRepository(), repository: new InMemoryInferenceRepository() });
}
for (const kind of ['memory', 'jsonl']) {
  async function fixture(t) {
    let repository, other;
    if (kind === 'memory') other = repository = new InMemorySessionRepository();
    else {
      const root = await mkdtemp(path.join(tmpdir(), 'session-scheduling-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      repository = new JsonlSessionRepository({ rootDir: root });
      other = new JsonlSessionRepository({ rootDir: root });
    }
    const session = await repository.create({ binding });
    const input = (id, extra = {}) => ({ submissionId: id, runId: `run-${id}`, input: { task: id }, configuration, ...extra });
    return { repository, other, session, input };
  }

  test(`${kind}: execution ownership is nonblocking, session-scoped and released explicitly`, async t => {
    const f = await fixture(t);
    const revision = await f.repository.revision(f.session);
    const first = await f.repository.tryAcquireExecution(f.session);
    assert.ok(first);
    await first.assertOwned();
    assert.equal(await f.other.tryAcquireExecution(f.session), undefined);
    assert.equal(await f.repository.revision(f.session), revision, 'Execution ownership is not another session ledger');
    await first.release();
    await first.release();
    await assert.rejects(first.assertOwned(), /ownership|lock/);
    const next = await f.other.tryAcquireExecution(f.session);
    assert.ok(next);
    await next.release();
  });

  test(`${kind}: a contended execution guard rejects capacity-zero admission without losing input capacity`, async t => {
    const f = await fixture(t);
    const owner = await f.repository.tryAcquireExecution(f.session);
    const session = new AgentSession({ descriptor: f.session, repository: f.other, expectedBinding: binding, configuration, maximumQueuedInputs: 0,
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
      createRuntime() { return { run(input) { return { runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), abort() {} }; } }; } });
    await assert.rejects(session.submit({ task: 'No execution slot yet' }), /queue limit/);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.session), []);
    await owner.release();
    const accepted = await session.submit({ task: 'Capacity zero permits one immediate execution' });
    assert.equal(accepted.kind, 'started');
    await accepted.completion;
    await session.close();
    const released = await f.repository.tryAcquireExecution(f.session);
    assert.ok(released);
    await released.release();
  });

  test(`${kind}: admission and zero-capacity immediate claim share one durable boundary`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.repository.admitSubmission(f.session, f.input('manual-zero', { maximumQueuedInputs: 0 })), /queue limit/);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.session), []);
    const attempts = await Promise.allSettled([
      f.repository.admitSubmission(f.session, f.input('a', { maximumQueuedInputs: 0, claimId: 'claim-a' })),
      f.other.admitSubmission(f.session, f.input('b', { maximumQueuedInputs: 0, claimId: 'claim-b' }))
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(attempts.find(result => result.status === 'rejected').reason.message, /queue limit/);
    const [active] = await f.other.loadPendingSubmissions(f.session);
    assert.equal(active.state, 'claimed');
    await f.repository.transitionSubmission(f.session, active.submissionId, { state: 'completed', claimId: active.claimId });
    assert.equal((await f.other.admitSubmission(f.session, f.input('c', { maximumQueuedInputs: 0, claimId: 'claim-c' }))).state, 'claimed');
    await assert.rejects(f.repository.admitSubmission(f.session, f.input('d', { maximumQueuedInputs: 1 })), /capacity differs/);
  });

  test(`${kind}: malformed admission identities are rejected before any source append`, async t => {
    const f = await fixture(t);
    for (const extra of [{ submissionId: '' }, { runId: '' }, { claimId: '' }, { claimId: 42 }])
      await assert.rejects(f.repository.admitSubmission(f.session, f.input('invalid', extra)), /identity is invalid/);
    assert.deepEqual(await f.other.loadPendingSubmissions(f.session), []);
    assert.equal(await f.repository.revision(f.session), 0);
    assert.equal((await f.repository.admitSubmission(f.session, f.input('valid', { claimId: 'claim' }))).state, 'claimed');
  });

  test(`${kind}: configuration races reject before admission and refresh without replacing client response defaults`, async t => {
    const f = await fixture(t);
    await f.repository.admitSubmission(f.session, f.input('initial', { claimId: 'initial' }));
    await f.repository.transitionSubmission(f.session, 'initial', { state: 'completed', claimId: 'initial' });
    const session = new AgentSession({ descriptor: f.session, repository: f.other, expectedBinding: binding,
      configuration: { provider: 'stale', model: 'stale', responseFormat: 'json' }, scheduling: 'manual',
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
      createRuntime() { assert.fail('Manual admission does not execute'); } });
    const admit = f.other.admitSubmission.bind(f.other);
    f.other.admitSubmission = async (descriptor, input) => {
      await f.repository.appendModelSettings(f.session, { provider: 'committed', model: 'selected' });
      return admit(descriptor, input);
    };
    await assert.rejects(session.submit({ task: 'Do not silently substitute the changed model' }), SessionConfigurationChangedError);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.session), []);
    f.other.admitSubmission = admit;
    const accepted = await session.submit({ task: 'Use the refreshed durable model' });
    assert.equal(session.state().configuration.provider, 'committed');
    assert.equal(session.state().configuration.model, 'selected');
    assert.deepEqual(session.state().configuration.responseFormat, 'json');
    const rejected = assert.rejects(accepted.completion, /remains recorded/);
    await session.close();
    await rejected;
  });

  test(`${kind}: aggregate queue bound and durable oldest-input ordering span clients`, async t => {
    const f = await fixture(t);
    await f.repository.admitSubmission(f.session, f.input('active', { maximumQueuedInputs: 2, claimId: 'active' }));
    await f.other.admitSubmission(f.session, f.input('first', { maximumQueuedInputs: 2 }));
    await f.repository.admitSubmission(f.session, f.input('second', { maximumQueuedInputs: 2 }));
    await assert.rejects(f.other.admitSubmission(f.session, f.input('overflow', { maximumQueuedInputs: 2 })), /queue limit/);
    assert.equal(await f.other.claimNextSubmission(f.session, 'busy'), undefined);
    await assert.rejects(f.other.transitionSubmission(f.session, 'second', { state: 'claimed', claimId: 'skip' }), /occupied/);
    await f.repository.transitionSubmission(f.session, 'active', { state: 'completed', claimId: 'active' });
    await assert.rejects(f.other.transitionSubmission(f.session, 'second', { state: 'claimed', claimId: 'skip' }), /admission order/);
    assert.equal((await f.other.claimNextSubmission(f.session, 'first-claim')).submissionId, 'first');
    assert.equal(await f.repository.claimNextSubmission(f.session, 'duplicate'), undefined);
    await f.repository.transitionSubmission(f.session, 'first', { state: 'completed', claimId: 'first-claim' });
    assert.equal((await f.repository.claimNextSubmission(f.session, 'second-claim')).submissionId, 'second');
  });

  test(`${kind}: suspension retains the slot and same-submission claim fencing`, async t => {
    const f = await fixture(t);
    await f.repository.admitSubmission(f.session, f.input('active', { claimId: 'old' }));
    await f.other.admitSubmission(f.session, f.input('queued'));
    const suspension = { submissionId: 'active', runId: 'run-active', category: 'runtime', reason: 'runtime_failed', diagnostic: 'recover', actions: ['resume', 'abort'] };
    await f.repository.transitionSubmission(f.session, 'active', { state: 'suspended', claimId: 'old', suspension });
    assert.equal(await f.other.claimNextSubmission(f.session, 'different'), undefined);
    await assert.rejects(f.other.appendModelSettings(f.session, configuration), /idle/);
    await f.other.transitionSubmission(f.session, 'active', { state: 'claimed', claimId: 'new', expectedClaimId: 'old' });
    await assert.rejects(f.repository.transitionSubmission(f.session, 'active', { state: 'completed', claimId: 'old' }), SessionSubmissionOwnershipError);
    await f.other.transitionSubmission(f.session, 'active', { state: 'completed', claimId: 'new' });
    assert.equal((await f.repository.readSubmission(f.session, 'active')).state, 'completed');
    assert.equal((await f.repository.claimNextSubmission(f.session, 'next')).submissionId, 'queued');
  });

  test(`${kind}: model selection cannot be overwritten by an occupying execution`, async t => {
    const f = await fixture(t);
    await f.repository.admitSubmission(f.session, f.input('active', { claimId: 'claim' }));
    await assert.rejects(f.other.appendModelSettings(f.session, configuration), /idle/);
    await assert.rejects(f.other.appendModelSettings(f.session, { ...configuration, endpoint: 'https://different.invalid' }), /idle/);
    assert.deepEqual(await f.repository.currentModelSettings(f.session), configuration);
  });

  test(`${kind}: first admission fixes the initial model before runtime construction and explicit selection overrides it`, async t => {
    const f = await fixture(t);
    await f.repository.admitSubmission(f.session, f.input('first', { claimId: 'first', configuration: { provider: 'fixture', model: 'initial' } }));
    assert.equal((await f.other.currentModelSettings(f.session)).model, 'initial');
    await assert.rejects(f.other.admitSubmission(f.session, f.input('stale', { configuration: { provider: 'fixture', model: 'stale' } })), SessionConfigurationChangedError);
    const queued = await f.other.admitSubmission(f.session, f.input('second', { configuration: { provider: 'fixture', model: 'initial', responseFormat: 'json' } }));
    assert.equal(queued.configuration.model, 'initial');
    assert.equal(queued.configuration.responseFormat, 'json');
    await f.repository.transitionSubmission(f.session, 'first', { state: 'completed', claimId: 'first' });
    await f.other.claimNextSubmission(f.session, 'second');
    await f.other.transitionSubmission(f.session, 'second', { state: 'completed', claimId: 'second' });
    await f.repository.appendModelSettings(f.session, { provider: 'fixture', model: 'explicit-new-model' });
    const next = await f.other.admitSubmission(f.session, f.input('third', { claimId: 'third', configuration: { provider: 'fixture', model: 'explicit-new-model' } }));
    assert.equal(next.configuration.model, 'explicit-new-model');
  });

  test(`${kind}: admission uses committed model and rejects conflicting context before acceptance`, async t => {
    const f = await fixture(t);
    await f.repository.appendModelSettings(f.session, { provider: 'new-provider', model: 'new-model' });
    const item = { id: 'source', sourceUri: 'test:source', sourceKind: 'user', representation: 'full', mediaType: 'text/plain', title: 'Source', content: 'Original', purpose: 'task' };
    await assert.rejects(f.repository.admitSubmission(f.session, f.input('bad', { configuration: { provider: 'new-provider', model: 'new-model' }, input: { task: 'bad', contextItems: [item, { ...item, content: 'Changed' }] } })), /conflicting duplicate/);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.session), []);
    const accepted = await f.repository.admitSubmission(f.session, f.input('good', { configuration: { provider: 'new-provider', model: 'new-model' }, input: { task: 'good', contextItems: [item, { ...item }] } }));
    assert.equal(accepted.configuration.model, 'new-model');
    assert.equal(accepted.input.contextItems.length, 1);
  });
  test(`${kind}: full endpoint binding survives admission, persistence and runtime callbacks`, async t => {
    const f = await fixture(t);
    const selected = { ...configuration, endpoint: 'http://localhost:1234', temperature: 0.25, reasoning: { strategy: 'disabled' } };
    const seen = [];
    const session = new AgentSession({ descriptor: f.session, repository: f.other, expectedBinding: binding,
      configuration: selected,
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
      providerBinding: providerBinding(selected, () => seen.push(selected)),
      createRuntime(binding) {
        assert.deepEqual(binding, selected);
        return { run(input) { return { runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), abort() {} }; } };
      }
    });
    const accepted = await session.submit({ task: 'Bind endpoint before accepting input' });
    await accepted.completion;
    assert.deepEqual((await f.repository.readSubmission(f.session, accepted.submissionId)).configuration, selected);
    assert.deepEqual(await f.repository.currentModelSettings(f.session), selected);
    assert.deepEqual(seen, [selected, selected]);
    await session.close();
  });

  for (const changed of [
    { provider: 'other-provider' }, { model: 'other-model' }, { endpoint: 'http://localhost:5678' },
    { temperature: 0.5 }, { reasoning: { strategy: 'disabled' } }
  ]) test(`${kind}: configuration binding race rejects ${Object.keys(changed)[0]} before acceptance`, async t => {
    const f = await fixture(t);
    const selected = { ...configuration, endpoint: 'http://localhost:1234' };
    await f.repository.appendModelSettings(f.session, selected);
    let race = true;
    let dispatches = 0;
    const session = new AgentSession({ descriptor: f.session, repository: f.other, expectedBinding: binding,
      configuration: selected, scheduling: 'manual',
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
      providerBinding: providerBinding(selected, async () => {
        if (race) {
          race = false;
          await f.repository.appendModelSettings(f.session, { ...selected, ...changed });
        }
      }),
      createRuntime() { dispatches++; assert.fail('Manual admission must not dispatch'); }
    });
    await assert.rejects(session.submit({ task: 'Configuration changes during preparation' }), SessionConfigurationChangedError);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.session), []);
    assert.equal(dispatches, 0);
    const accepted = await session.submit({ task: 'Refresh and retry' });
    assert.deepEqual((await f.repository.readSubmission(f.session, accepted.submissionId)).configuration, { ...selected, ...changed });
    const rejection = assert.rejects(accepted.completion, /remains recorded/);
    await session.close();
    await rejection;
  });
}


test('unchanged automatic polling reads revision metadata without rehydrating accepted inputs', { timeout: 2000 }, async () => {
  class CountingRepository extends InMemorySessionRepository {
    revisions = 0;
    pendingReads = 0;
    revision(session) { this.revisions++; return super.revision(session); }
    loadPendingSubmissions(session) { this.pendingReads++; return super.loadPendingSubmissions(session); }
  }
  const repository = new CountingRepository();
  const descriptor = await repository.create({ binding });
  const session = new AgentSession({ descriptor, repository, expectedBinding: binding, configuration,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    createRuntime() { assert.fail('No input was admitted'); } });
  await session.restore();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(repository.revisions >= 3);
  assert.equal(repository.pendingReads, 1);
  await session.close();
  const revisions = repository.revisions;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(repository.revisions, revisions);
});


test('durable inspection overrides an outstanding local control after another claimant settles', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ binding });
  const result = Promise.withResolvers();
  const session = new AgentSession({ descriptor, repository, expectedBinding: binding, configuration,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    createRuntime() { return { run(input) { return { runId: input.runId, result: result.promise, abort() { result.reject(new Error('Local control stopped')); } }; } }; } });
  const submission = await session.submit({ task: 'Inspect durable ownership' });
  const [claimed] = await repository.loadPendingSubmissions(descriptor);
  const suspension = { runId: submission.runId, submissionId: submission.submissionId, category: 'runtime', reason: 'runtime_failed', diagnostic: 'Recovered elsewhere', actions: ['resume', 'abort'] };
  await repository.transitionSubmission(descriptor, submission.submissionId, { state: 'suspended', claimId: claimed.claimId, suspension });
  const suspended = await session.inspect();
  assert.equal(suspended.session.phase, 'suspended');
  assert.deepEqual(suspended.session.suspension, suspension);
  await repository.transitionSubmission(descriptor, submission.submissionId, { state: 'claimed', claimId: 'replacement', expectedClaimId: claimed.claimId });
  await repository.transitionSubmission(descriptor, submission.submissionId, { state: 'completed', claimId: 'replacement' });
  assert.equal((await session.inspect()).session.phase, 'idle');
  const rejected = assert.rejects(submission.completion, SessionSubmissionOwnershipError);
  await session.close();
  await rejected;
});

test('close joins an in-flight revision refresh and performs no later repository reads', { timeout: 3000 }, async () => {
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  class GatedRepository extends InMemorySessionRepository {
    reads = 0;
    block = false;
    async revision(session) {
      this.reads++;
      if (this.block) { started.resolve(); await released.promise; }
      return super.revision(session);
    }
  }
  const repository = new GatedRepository();
  const descriptor = await repository.create({ binding });
  const session = new AgentSession({ descriptor, repository, expectedBinding: binding, configuration,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    createRuntime() { assert.fail('No input was admitted'); } });
  await session.restore();
  repository.block = true;
  await started.promise;
  let closed = false;
  const closing = session.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  released.resolve();
  await closing;
  const reads = repository.reads;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(repository.reads, reads);
});

test('close joins settlement persistence after aborting the local active control', { timeout: 3000 }, async () => {
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  class GatedRepository extends InMemorySessionRepository {
    async transitionSubmission(session, id, outcome) {
      if (outcome.state === 'completed') { started.resolve(); await released.promise; }
      return super.transitionSubmission(session, id, outcome);
    }
  }
  const repository = new GatedRepository();
  const descriptor = await repository.create({ binding });
  const result = Promise.withResolvers();
  const session = new AgentSession({ descriptor, repository, expectedBinding: binding, configuration,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    createRuntime() { return { run(input) { return { runId: input.runId, result: result.promise,
      abort() { result.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }); } }; } }; } });
  const submission = await session.submit({ task: 'Close after durable settlement' });
  let closed = false;
  const closing = session.close().then(() => { closed = true; });
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal((await repository.loadPendingSubmissions(descriptor))[0].state, 'claimed');
  released.resolve();
  await closing;
  await submission.completion;
  assert.deepEqual(await repository.loadPendingSubmissions(descriptor), []);
});

for (const timing of ['before', 'after', 'close-retry']) {
  test(`execution release failure ${timing} actual release preserves terminal truth and closes dispatch`, async () => {
    class FailingReleaseRepository extends InMemorySessionRepository {
      releases = 0;
      async tryAcquireExecution(descriptor) {
        const owned = await super.tryAcquireExecution(descriptor);
        if (!owned) return undefined;
        return { assertOwned: () => owned.assertOwned(), release: async () => {
          this.releases++;
          if (this.releases === 1 || (timing === 'close-retry' && this.releases === 2)) {
            if (timing === 'after') await owned.release();
            throw new Error('Execution release failed');
          }
          await owned.release();
        } };
      }
    }
    const repository = new FailingReleaseRepository();
    const descriptor = await repository.create({ binding });
    const outcome = Promise.withResolvers();
    let executions = 0;
    const session = new AgentSession({ descriptor, repository, expectedBinding: binding, configuration,
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
      createRuntime() { return { run(input) { executions++; return { runId: input.runId, result: outcome.promise, abort() {} }; } }; } });
    const first = await session.submit({ task: 'Commit terminal first' });
    const queued = await session.submit({ task: 'Do not dispatch after release failure' });
    const rejected = assert.rejects(queued.completion, /Execution release failed/);
    outcome.resolve({ state: 'ended', terminal: { runId: first.runId }, deliveryDiagnostics: [] });
    assert.equal((await first.completion).state, 'ended');
    await rejected;
    await assert.rejects(session.submit({ task: 'Closed' }), /closed/);
    assert.equal((await repository.readSubmission(descriptor, first.submissionId)).state, 'completed');
    assert.equal(executions, 1);
    if (timing === 'close-retry') await assert.rejects(session.close(), /Execution release failed/);
    await session.close();
    assert.equal(repository.releases, timing === 'close-retry' ? 3 : 2);
    const owner = await repository.tryAcquireExecution(descriptor);
    assert.ok(owner);
    await owner.release();
  });
}

test('lost execution ownership rejects a constructed runtime before acceptance and leaves the same input recoverable', async () => {
  class RevocableRepository extends InMemorySessionRepository {
    ownership;
    async tryAcquireExecution(descriptor) { this.ownership = await super.tryAcquireExecution(descriptor); return this.ownership; }
  }
  const repository = new RevocableRepository();
  const descriptor = await repository.create({ binding });
  const constructed = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  let released = 0;
  const session = new AgentSession({ descriptor, repository, expectedBinding: binding, configuration,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    createRuntime: async () => {
      constructed.resolve();
      await proceed.promise;
      return { close() { released++; }, run() { assert.fail('Lost owner cannot accept a run'); } };
    } });
  const submission = session.submit({ task: 'Preserve after guard loss' });
  const rejection = assert.rejects(submission, /ownership was lost/);
  await constructed.promise;
  await repository.ownership.release();
  proceed.resolve();
  await rejection;
  assert.equal(released, 1);
  const [pending] = await repository.loadPendingSubmissions(descriptor);
  assert.equal(pending.state, 'claimed');
  assert.equal(pending.input.task, 'Preserve after guard loss');
  await session.close();
  const recovered = await repository.tryAcquireExecution(descriptor);
  assert.ok(recovered);
  await recovered.release();
});

test('concurrent memory releases cannot delete a replacement execution owner', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ binding });
  const first = await repository.tryAcquireExecution(descriptor);
  const release = first.release();
  const next = repository.tryAcquireExecution(descriptor);
  const duplicate = first.release();
  await Promise.all([release, duplicate]);
  const owner = await next;
  assert.ok(owner);
  await owner.assertOwned();
  assert.equal(await repository.tryAcquireExecution(descriptor), undefined);
  await owner.release();
});
