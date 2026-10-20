import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { collaborationProvider } from './fixtures/collaboration-provider.mjs';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, AgentSession, AgentRunCoordinator, InMemorySessionRepository, InMemoryIntentionRepository,
  HostWakeService, HistoryReader, sourceRef, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository, JsonlIntentionRepository } from '@agent-core/runtime/node';

const now = '2026-10-19T12:00:00.000Z';
const binding = { schemaId: 'tests/intentions', schemaVersion: 1, subject: { principal: 'person', environment: 'home' } };
const configuration = { provider: 'fixture', model: 'fixture' };
const origin = { kind: 'host_wake', ownerId: 'owner', intentionId: 'intention', intentionRevision: 1,
  triggerKey: 'due', authorizationRef: 'accepted-user-request', evidence: { now } };
const wake = { key: 'trigger', input: { task: 'Do the accepted future work', origin }, configuration };
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t, persistence) {
  const root = await mkdtemp(path.join(tmpdir(), 'durable-intentions-'));
  const sessionsDir = path.join(root, 'sessions'), intentionsDir = path.join(root, 'intentions');
  let sessions = persistence === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir: sessionsDir });
  let intentions = persistence === 'memory' ? new InMemoryIntentionRepository() : new JsonlIntentionRepository({ rootDir: intentionsDir });
  let descriptor = await sessions.create({ id: 'session', binding });
  const handles = [];
  const newSession = () => {
    const session = new AgentSession({ descriptor, repository: sessions, expectedBinding: binding,
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
      configuration, scheduling: 'manual', createRuntime() { assert.fail('Host recovery must not install another executor.'); } });
    handles.push(session); return session;
  };
  let session = newSession();
  const adapter = { now: () => now, evaluate: async () => ({ key: 'due', evidence: { now } }),
    withAdmission: (_record, _trigger, operation) => operation() };
  const service = () => new HostWakeService({ repository: intentions, adapter, resolveSession: async id => {
    assert.equal(id, descriptor.id); return session;
  } });
  t.after(async () => { for (const handle of handles) await handle.close(); await rm(root, { recursive: true, force: true }); });
  return {
    sessionsDir, intentionsDir,
    get sessions() { return sessions; }, get intentions() { return intentions; }, get descriptor() { return descriptor; },
    get session() { return session; }, adapter, service,
    accept: (id = 'intention') => service().accept({ ownerId: 'owner', intentionId: id, sessionId: descriptor.id,
      authorizationRef: 'accepted-user-request', condition: { kind: 'time', notBefore: now }, input: { task: 'Do the accepted future work' } }),
    restart: async () => {
      await session.close();
      if (persistence === 'jsonl') {
        sessions = new JsonlSessionRepository({ rootDir: sessionsDir });
        intentions = new JsonlIntentionRepository({ rootDir: intentionsDir });
        descriptor = await sessions.open(descriptor.id, binding);
      }
      session = newSession();
    }
  };
}

for (const persistence of ['memory', 'jsonl']) {
  test(`${persistence}: concurrent duplicate trigger delivery commits one immutable receipt`, async t => {
    const f = await fixture(t, persistence);
    const other = persistence === 'jsonl' ? new JsonlSessionRepository({ rootDir: f.sessionsDir }) : f.sessions;
    const receipts = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? other : f.sessions).admitTriggeredSubmission(f.descriptor, wake)));
    for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
    assert.equal((await f.sessions.loadPendingSubmissions(f.descriptor)).length, 1);
    await assert.rejects(f.sessions.admitTriggeredSubmission(f.descriptor, { ...wake, input: { ...wake.input, task: 'Conflicting work' } }), /different payload/);
    await f.restart();
    assert.deepEqual(await f.sessions.admitTriggeredSubmission(f.descriptor, wake), receipts[0]);
    const pending = await f.sessions.readSubmission(f.descriptor, receipts[0].submissionId);
    await f.sessions.updateQueuedSubmission(f.descriptor, pending.submissionId, { kind: 'cancel', expectedInput: pending.input });
    assert.deepEqual(await f.sessions.admitTriggeredSubmission(f.descriptor, wake), receipts[0]);
    assert.equal((await f.sessions.loadPendingSubmissions(f.descriptor)).length, 0, 'Replay cannot resurrect canceled work');
    await assert.rejects(f.sessions.admitSubmission(f.descriptor, { ...wake, submissionId: 'forged', runId: 'forged' }), /trigger/);
  });

  test(`${persistence}: process reconstruction recovers an admission whose acknowledgement was lost`, async t => {
    const f = await fixture(t, persistence);
    await f.accept();
    const original = f.sessions.admitTriggeredSubmission.bind(f.sessions);
    let lost = false;
    f.sessions.admitTriggeredSubmission = async (...args) => {
      const receipt = await original(...args);
      if (!lost) { lost = true; throw new Error('Simulated process death after durable admission'); }
      return receipt;
    };
    await assert.rejects(f.service().dispatch('owner', 'intention'), /process death/);
    assert.equal((await f.intentions.read('owner', 'intention')).status, 'triggered');
    const admitted = (await f.sessions.loadPendingSubmissions(f.descriptor))[0];
    await f.restart();
    f.adapter.evaluate = async () => assert.fail('Recorded triggers must retain their original evidence across restart');
    f.adapter.withAdmission = async () => assert.fail('Receipt replay must not require new authorization or admit twice');
    const recovery = await f.service().recover('owner');
    assert.deepEqual(recovery.failures, []);
    assert.equal(recovery.intentions[0].status, 'admitted');
    assert.equal(recovery.intentions[0].receipt.runId, admitted.runId);
    assert.equal((await f.sessions.loadPendingSubmissions(f.descriptor)).length, 1);
    const claimed = await f.sessions.claimNextSubmission(f.descriptor, 'ordinary-claim');
    await f.sessions.transitionSubmission(f.descriptor, claimed.submissionId, { state: 'completed', claimId: claimed.claimId });
    const settled = await f.service().recover('owner');
    assert.equal(settled.intentions[0].status, 'completed');
    assert.equal(settled.intentions[0].outcome, 'completed');
  });

  test(`${persistence}: an eligible trigger recorded before a crash is redelivered after restart`, async t => {
    const f = await fixture(t, persistence);
    await f.accept();
    f.adapter.withAdmission = async () => { throw new Error('Process stopped before admission'); };
    await assert.rejects(f.service().dispatch('owner', 'intention'), /before admission/);
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
    await f.restart();
    f.adapter.evaluate = async () => assert.fail('Do not replace recorded evidence with a new trigger');
    let checked = 0;
    f.adapter.withAdmission = async (_record, trigger, operation) => { checked++; assert.deepEqual(trigger.evidence, { now }); return operation(); };
    const recovered = await f.service().recover('owner');
    assert.equal(checked, 1);
    assert.equal(recovered.intentions[0].status, 'admitted');
    assert.equal((await f.sessions.loadPendingSubmissions(f.descriptor)).length, 1);
  });

  test(`${persistence}: cancellation wins during slow eligibility and stale evaluation cannot resurrect work`, async t => {
    const f = await fixture(t, persistence);
    const accepted = await f.accept();
    const started = gate(), finish = gate();
    f.adapter.evaluate = async () => { started.resolve(); await finish.promise; return { key: 'stale', evidence: { now } }; };
    const dispatch = f.service().dispatch('owner', 'intention');
    await started.promise;
    const cancelled = await f.service().cancel('owner', 'intention', { expectedRevision: accepted.revision, reason: 'User cancelled' });
    assert.equal(cancelled.status, 'cancelled');
    finish.resolve();
    assert.equal((await dispatch).status, 'cancelled');
    await f.restart();
    assert.equal((await f.service().recover('owner')).intentions[0].status, 'cancelled');
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
  });

  test(`${persistence}: rescheduling fences delayed evaluation and the old trigger revision`, async t => {
    const f = await fixture(t, persistence);
    const accepted = await f.accept();
    const started = gate(), finish = gate();
    f.adapter.evaluate = async () => { started.resolve(); await finish.promise; return { key: 'old', evidence: { now } }; };
    const dispatch = f.service().dispatch('owner', 'intention');
    await started.promise;
    const next = await f.service().reschedule('owner', 'intention', { expectedRevision: accepted.revision,
      condition: { kind: 'time', notBefore: '2026-10-20T12:00:00.000Z' }, authorizationRef: 'reschedule-request' });
    finish.resolve();
    await assert.rejects(dispatch, /changed during/);
    await assert.rejects(f.service().dispatch('owner', 'intention', { expectedRevision: accepted.revision }), /revision changed/);
    assert.equal((await f.service().dispatch('owner', 'intention')).revision, next.revision);
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
  });

  test(`${persistence}: fresh authority and live condition are checked before admission, and cancellation settles queued work`, async t => {
    const f = await fixture(t, persistence);
    await f.accept();
    let authorized = false;
    f.adapter.withAdmission = async (_record, _trigger, operation) => {
      if (!authorized) throw new Error('Condition is stale or current authorization was withdrawn');
      return operation();
    };
    await assert.rejects(f.service().dispatch('owner', 'intention'), /withdrawn/);
    assert.equal((await f.intentions.read('owner', 'intention')).status, 'triggered');
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
    authorized = true;
    const admitted = await f.service().dispatch('owner', 'intention');
    const cancelled = await f.service().cancel('owner', 'intention', { expectedRevision: admitted.revision, reason: 'User cancelled after admission' });
    assert.equal(cancelled.status, 'completed');
    assert.equal(cancelled.outcome, 'cancelled');
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
    assert.equal((await f.service().dispatch('owner', 'intention')).outcome, 'cancelled');
  });

  test(`${persistence}: recovery pages remain bounded and owner-qualified with false conditions`, async t => {
    const f = await fixture(t, persistence);
    for (let i = 0; i < 5; i++) await f.accept(`intention-${i}`);
    let evaluations = 0;
    f.adapter.evaluate = async () => { evaluations++; return undefined; };
    let cursor, count = 0;
    do {
      const page = await f.service().recover('owner', { limit: 2, ...(cursor ? { cursor } : {}) });
      assert.ok(page.intentions.length <= 2); count += page.intentions.length;
      if (page.cursor) await assert.rejects(f.service().list('other-owner', { cursor: page.cursor }), /another owner/);
      cursor = page.cursor;
    } while (cursor);
    assert.equal(count, 5); assert.equal(evaluations, 5);
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
  });

  test(`${persistence}: cancelled host observation cannot record or admit a trigger`, async t => {
    const f = await fixture(t, persistence);
    await f.accept();
    const entered = gate(), release = gate();
    f.adapter.evaluate = async () => { entered.resolve(); await release.promise; return { key: 'late', evidence: {} }; };
    const controller = new AbortController();
    const work = f.service().dispatch('owner', 'intention', { signal: controller.signal });
    await entered.promise;
    controller.abort(new Error('Host stopped recovery'));
    await assert.rejects(work, /stopped recovery/);
    release.resolve();
    assert.equal((await f.intentions.read('owner', 'intention')).status, 'pending');
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
  });

  test(`${persistence}: typed host evidence remains control provenance across history restart`, async t => {
    const f = await fixture(t, persistence);
    await assert.rejects(f.sessions.appendInput(f.descriptor, { runId: 'forged', task: 'fake', origin }), /durable triggered/);
    const receipt = await f.sessions.admitTriggeredSubmission(f.descriptor, wake);
    const entry = await f.sessions.appendInput(f.descriptor, { runId: receipt.runId, task: wake.input.task, origin });
    await f.restart();
    const history = new HistoryReader({ repository: f.sessions, session: f.descriptor });
    const ref = sourceRef(f.descriptor.id, entry);
    assert.equal((await history.metadata(ref, await history.capture())).inputAuthorship, 'host');
    assert.equal((await history.read({ source: ref })).item.role, 'control');
    assert.equal((await history.latest()).items.length, 0);
  });
}

for (const phase of ['before_admission', 'after_admission']) {
  test(`JSONL process death ${phase} recovers the same accepted work`, async t => {
    const f = await fixture(t, 'jsonl');
    await f.accept();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { AgentRuntime, AgentSession, AgentRunCoordinator, HostWakeService, agentEventCodec } from '@agent-core/runtime';
      import { JsonlSessionRepository, JsonlIntentionRepository } from '@agent-core/runtime/node';
      import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
      const sessions = new JsonlSessionRepository({ rootDir: process.env.SESSIONS_DIR });
      const binding = JSON.parse(process.env.BINDING);
      const descriptor = await sessions.open('session', binding);
      const session = new AgentSession({ descriptor, repository: sessions, expectedBinding: binding,
        runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
        configuration: { provider: 'fixture', model: 'fixture' }, scheduling: 'manual',
        createRuntime() { throw new Error('Must use ordinary session scheduling'); } });
      const pause = async receipt => {
        process.send({ phase: process.env.PHASE, receipt });
        await new Promise(resolve => process.once('message', resolve));
      };
      const service = new HostWakeService({ repository: new JsonlIntentionRepository({ rootDir: process.env.INTENTIONS_DIR }),
        resolveSession: async () => session, adapter: {
          now: () => '${now}', evaluate: async () => ({ key: 'due', evidence: { now: '${now}' } }),
          withAdmission: async (_record, _trigger, operation) => {
            if (process.env.PHASE === 'before_admission') await pause();
            const receipt = await operation();
            if (process.env.PHASE === 'after_admission') await pause(receipt);
            return receipt;
          }
        } });
      await service.dispatch('owner', 'intention').catch(error => { process.send({ error: error.stack }); process.exit(1); });
    `], { env: { ...process.env, SESSIONS_DIR: f.sessionsDir, INTENTIONS_DIR: f.intentionsDir, BINDING: JSON.stringify(binding), PHASE: phase },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += String(bytes); });
    const checkpoint = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message));
      child.once('exit', (code, signal) => reject(new Error(`Child exited before checkpoint: ${code}/${signal}: ${stderr}`)));
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    assert.equal(checkpoint.phase, phase);
    await f.restart();
    f.adapter.evaluate = async () => assert.fail('The trigger was durably recorded before process death');
    let checks = 0;
    f.adapter.withAdmission = async (_record, _trigger, operation) => { checks++; return operation(); };
    const recovered = await f.service().recover('owner');
    assert.deepEqual(recovered.failures, []);
    assert.equal(recovered.intentions[0].status, 'admitted');
    const pending = await f.sessions.loadPendingSubmissions(f.descriptor);
    assert.equal(pending.length, 1);
    if (phase === 'after_admission') {
      assert.equal(checks, 0, 'Already accepted work is recovered without fresh admission');
      assert.deepEqual(recovered.intentions[0].receipt, checkpoint.receipt);
    } else assert.equal(checks, 1);
  });
}

for (const persistence of ['memory', 'jsonl']) {
  test(`${persistence}: host staging precedes admission and retries retain exact prospective identity`, async t => {
    const f = await fixture(t, persistence);
    let allowed = false, fenced = false;
    const stagings = [];
    const agent = new AgentSession({ descriptor: f.descriptor, repository: f.sessions, expectedBinding: binding,
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
      configuration, scheduling: 'manual', createRuntime() { assert.fail('Manual host admission cannot dispatch.'); },
      stageTriggeredSubmission: async prospective => {
        assert.equal(fenced, true);
        assert.equal(Object.isFrozen(prospective), true);
        assert.equal(Object.isFrozen(prospective.input.origin.evidence), true);
        assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
        stagings.push(prospective);
        if (!allowed) throw new Error('Application permission staging denied');
      } });
    t.after(() => agent.close());
    const request = { key: wake.key, input: wake.input, withAdmission: async operation => {
      fenced = true; try { return await operation(); } finally { fenced = false; }
    } };
    await assert.rejects(agent.submitTriggered(request), /staging denied/);
    assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
    allowed = true;
    const receipt = await agent.submitTriggered(request);
    assert.equal(stagings.length, 2);
    assert.deepEqual(stagings[0], stagings[1]);
    assert.equal(receipt.runId, stagings[0].runId);
    assert.equal(receipt.submissionId, stagings[0].submissionId);
    assert.deepEqual(await agent.submitTriggered(request), receipt);
    assert.equal(stagings.length, 2, 'Receipt replay must not repeat host staging');
  });
}


test('host wakes queue behind an active user run and dispatch with control provenance through the same executor', async t => {
  const f = await fixture(t, 'memory');
  const entered = gate(), finish = gate();
  const provider = collaborationProvider([async () => { entered.resolve(); await finish.promise; return {}; }, {}]);
  const artifacts = new InMemoryArtifactRepository(), events = new InMemoryEventRepository(agentEventCodec);
  let factories = 0;
  const session = new AgentSession({ descriptor: f.descriptor, repository: f.sessions, expectedBinding: binding,
    runs: new AgentRunCoordinator(events, artifacts), configuration: { provider: provider.profile.provider, model: provider.profile.id },
    createRuntime: () => { factories++; return new AgentRuntime({ provider: provider.provider, model: provider.profile.id,
      maxOutputTokens: 64, toolBoundary: { authorizationPolicyId: 'intentions-test', executionTargetId: 'intentions-test' },
      repositories: { events, artifacts, session: { repository: f.sessions, descriptor: f.descriptor } } }); } });
  t.after(async () => { finish.resolve(); await session.waitForIdle(); await session.close(); });
  const user = await session.submit({ task: 'Active user requirement' });
  await entered.promise;
  const receipt = await session.submitTriggered({ key: wake.key, input: wake.input, withAdmission: operation => operation() });
  assert.equal(factories, 1);
  assert.equal(provider.requests.length, 1);
  const pending = await f.sessions.loadPendingSubmissions(f.descriptor);
  assert.equal(pending[0].runId, user.runId);
  assert.equal(pending[1].runId, receipt.runId);
  assert.equal(pending[1].state, 'queued');
  finish.resolve();
  await user.completion;
  await session.waitForIdle();
  assert.equal(factories, 2);
  assert.equal(provider.requests.length, 2);
  const presented = provider.requests[1].messages.find(message => message.content?.startsWith('Host wake for previously accepted future work.'));
  assert.ok(presented);
  assert.equal(presented.role, 'user', 'Wire framing is not promoted to system/developer authority');
  assert.match(presented.content, /not a new direct user instruction/);
  assert.equal((await f.sessions.readSubmission(f.descriptor, receipt.submissionId)).state, 'completed');
});


test('a host fence cannot acknowledge without durable admission, and cancellation during staging admits nothing', async t => {
  const f = await fixture(t, 'memory');
  await assert.rejects(f.session.submitTriggered({ key: wake.key, input: wake.input,
    withAdmission: async () => ({ sessionId: f.descriptor.id, submissionId: 'fake', runId: 'fake' }) }), /did not complete durable admission/);
  assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
  const controller = new AbortController();
  const session = new AgentSession({ descriptor: f.descriptor, repository: f.sessions, expectedBinding: binding,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    configuration, scheduling: 'manual', stageTriggeredSubmission: async () => { controller.abort(new Error('Host cancelled during staging')); },
    createRuntime() { assert.fail('Cancelled staging cannot dispatch'); } });
  t.after(() => session.close());
  await assert.rejects(session.submitTriggered({ key: wake.key, input: wake.input, signal: controller.signal,
    withAdmission: operation => operation() }), /cancelled during staging/);
  assert.deepEqual(await f.sessions.loadPendingSubmissions(f.descriptor), []);
});
