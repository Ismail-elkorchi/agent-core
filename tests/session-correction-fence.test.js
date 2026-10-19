import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentSession, AgentRunCoordinator, InMemorySessionRepository, InMemoryCollaborationRepository,
  CollaborationCoordinator, agentEventCodec
} from '@agent-core/runtime';
import { JsonlSessionRepository, JsonlCollaborationRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'test.accepted-correction', schemaVersion: 1, subject: {} };
const configuration = { provider: 'fixture', model: 'fixture' };
function deferred() { return Promise.withResolvers(); }
async function fixture(t, kind = 'memory', maximumQueuedInputs = 16, activate = true) {
  const rootDir = kind === 'jsonl' ? await mkdtemp(path.join(tmpdir(), 'accepted-correction-')) : undefined;
  const repository = rootDir ? new JsonlSessionRepository({ rootDir: path.join(rootDir, 'sessions') }) : new InMemorySessionRepository();
  const descriptor = await repository.create({ binding });
  const collaboration = rootDir ? new JsonlCollaborationRepository({ rootDir: path.join(rootDir, 'collaboration') }) : new InMemoryCollaborationRepository();
  const runs = new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository());
  const open = () => CollaborationCoordinator.open({ groupId: 'group', hostId: 'host', supervisorSessionId: descriptor.id,
    budgetOwnerId: 'work', repository: collaboration, runs,
    readCorrectionRevision: () => repository.acceptedCorrectionRevision(descriptor),
    createSession() { assert.fail('This test does not dispatch participant models'); } });
  let host = await open();
  // Existing participant authority must precede the correction this fixture tests.
  if (activate) await host.withCurrent(0, async () => undefined);
  let guardCalls = 0;
  const session = new AgentSession({ descriptor, expectedBinding: binding, repository, runs, configuration,
    maximumQueuedInputs, scheduling: 'manual',
    withSubmissionAdmission(operation) { guardCalls++; return host.withSupervisorSubmission(operation); },
    createRuntime() { assert.fail('Manual root admission must not dispatch'); } });
  t.after(async () => {
    await session.close();
    await host.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });
  return { repository, descriptor, session, rootDir, collaboration,
    get host() { return host; }, get guardCalls() { return guardCalls; },
    async reopenHost() { await host.close(); host = await open(); return host; } };
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: lazy activation captures earlier accepted corrections without inventing stale participant authority`, async t => {
    const f = await fixture(t, kind, 16, false);
    assert.equal(await f.collaboration.load('group'), undefined);
    await f.session.submit({ task: 'Correction before collaboration' }, { relationship: { kind: 'correct' } });
    const baseline = await f.repository.acceptedCorrectionRevision(f.descriptor);
    assert.ok(baseline > 0);
    assert.equal(await f.collaboration.load('group'), undefined, 'Ordinary root admission does not create a collaboration owner');
    assert.equal(await f.host.withCurrent(0, async () => 'new-authority'), 'new-authority');
    assert.equal((await f.host.inspect()).epoch, 0);
    assert.equal((await f.host.inspect()).correctionRevision, baseline);
    await f.session.submit({ task: 'Correction after activation' }, { relationship: { kind: 'replace' } });
    assert.equal((await f.host.inspect()).epoch, 1);
    await assert.rejects(f.host.withCurrent(0, async () => assert.fail('The pre-correction authority is stale')), /epoch|stale/i);
  });

  test(`${kind}: only accepted corrections, replacements and steering advance the durable correction revision`, async t => {
    const f = await fixture(t, kind);
    assert.equal(await f.repository.acceptedCorrectionRevision(f.descriptor), 0);
    const ordinary = await f.session.submit({ task: 'Ordinary follow-up' }, { delivery: 'follow_up', relationship: { kind: 'continue' } });
    assert.equal(await f.repository.acceptedCorrectionRevision(f.descriptor), 0);
    assert.equal((await f.host.inspect()).epoch, 0);
    const correction = await f.session.submit({ task: 'Correct the target' }, { delivery: 'follow_up', relationship: { kind: 'correct' } });
    const admittedRevision = await f.repository.acceptedCorrectionRevision(f.descriptor);
    assert.ok(admittedRevision > 0, 'A queued correction is authoritative before any run input is materialized');
    assert.equal((await f.host.inspect()).epoch, 1);
    await f.repository.appendInput(f.descriptor, { runId: correction.runId, task: 'Correct the target' });
    assert.equal(await f.repository.acceptedCorrectionRevision(f.descriptor), admittedRevision, 'Materializing accepted input cannot invalidate a new assignment twice');
    const original = (await f.repository.readSubmission(f.descriptor, ordinary.submissionId)).input;
    await f.session.updateQueuedSubmission(ordinary.submissionId, { kind: 'replace', expectedInput: original, input: { task: 'Replacement target' } });
    const replacementRevision = await f.repository.acceptedCorrectionRevision(f.descriptor);
    assert.ok(replacementRevision > admittedRevision);
    assert.equal((await f.host.inspect()).epoch, 2);
    await assert.rejects(f.session.updateQueuedSubmission(ordinary.submissionId, {
      kind: 'replace', expectedInput: original, input: { task: 'Stale replacement' }
    }), /changed/);
    assert.equal(await f.repository.acceptedCorrectionRevision(f.descriptor), replacementRevision);
    assert.equal((await f.host.inspect()).epoch, 2);
    await f.host.withSupervisorSubmission(() => f.repository.appendSteering(f.descriptor, {
      runId: correction.runId, content: 'Use the corrected destination', deliveryId: 'steer-once'
    }));
    const steeringRevision = await f.repository.acceptedCorrectionRevision(f.descriptor);
    assert.ok(steeringRevision > replacementRevision);
    await f.host.withSupervisorSubmission(() => f.repository.appendSteering(f.descriptor, {
      runId: correction.runId, content: 'Use the corrected destination', deliveryId: 'steer-once'
    }));
    assert.equal(await f.repository.acceptedCorrectionRevision(f.descriptor), steeringRevision, 'Same steering receipt does not create a second correction');
    assert.equal((await f.host.inspect()).epoch, 3);
    if (kind === 'jsonl') {
      const reopened = new JsonlSessionRepository({ rootDir: path.join(f.rootDir, 'sessions') });
      await reopened.rebuildHistoryIndex(f.descriptor.id, binding);
      assert.equal(await reopened.acceptedCorrectionRevision(f.descriptor), steeringRevision);
    }
  });

  test(`${kind}: rejected queue admission and rejected steering leave participant authority current`, async t => {
    const f = await fixture(t, kind, 1);
    await f.session.submit({ task: 'Fill the queue' });
    assert.equal(f.guardCalls, 1);
    await assert.rejects(f.session.submit({ task: 'Rejected correction' }, { relationship: { kind: 'correct' } }), /queue limit/);
    assert.deepEqual(await f.session.submit({ task: 'Rejected steer' }, { delivery: 'steer' }), { kind: 'rejected', reason: 'no_active_run' });
    assert.equal(f.guardCalls, 2, 'Steering precondition rejection never enters the durable admission guard');
    assert.equal(await f.repository.acceptedCorrectionRevision(f.descriptor), 0);
    assert.equal((await f.host.inspect()).epoch, 0);
    assert.equal(await f.host.withCurrent(0, async () => 'still-current'), 'still-current');
  });

  test(`${kind}: accepted input remains the fence when admission acknowledgement is lost`, async t => {
    const f = await fixture(t, kind);
    const admit = f.repository.admitSubmission.bind(f.repository);
    f.repository.admitSubmission = async (...args) => {
      await admit(...args);
      throw new Error('Lost acceptance acknowledgement');
    };
    await assert.rejects(f.session.submit({ task: 'Accepted correction' }, { relationship: { kind: 'replace' } }), /Lost acceptance/);
    assert.equal((await f.repository.loadPendingSubmissions(f.descriptor))[0].input.task, 'Accepted correction');
    assert.ok(await f.repository.acceptedCorrectionRevision(f.descriptor) > 0);
    assert.equal((await f.host.inspect()).epoch, 1);
    await assert.rejects(f.host.withCurrent(0, async () => assert.fail('Stale effect must not start')), /epoch|stale/i);
    await f.reopenHost();
    assert.equal((await f.host.inspect()).epoch, 1);
  });

  test(`${kind}: reopening synchronizes correction committed before group notification`, async t => {
    const f = await fixture(t, kind);
    await f.host.close();
    await f.repository.admitSubmission(f.descriptor, {
      submissionId: 'crash-correction', runId: 'crash-run', input: { task: 'Correction persisted before crash', relationship: { kind: 'correct' } },
      configuration, maximumQueuedInputs: 16
    });
    const before = await f.collaboration.load('group');
    assert.equal(before.epoch, 0, 'No cross-journal commit or callback was performed');
    const reopened = await f.reopenHost();
    assert.equal((await reopened.inspect()).epoch, 1);
    assert.equal((await reopened.inspect()).correctionRevision, await f.repository.acceptedCorrectionRevision(f.descriptor));
    await assert.rejects(reopened.withCurrent(0, async () => assert.fail('A stale effect cannot recover')), /epoch|stale/i);
  });
}

test('accepted correction admission and participant effect starts share one authority boundary', async t => {
  const f = await fixture(t);
  const written = deferred(), release = deferred();
  const admit = f.repository.admitSubmission.bind(f.repository);
  f.repository.admitSubmission = async (...args) => {
    const accepted = await admit(...args);
    written.resolve();
    await release.promise;
    return accepted;
  };
  const acceptance = f.session.submit({ task: 'Change the assignment' }, { relationship: { kind: 'correct' } });
  await written.promise;
  let effectStarts = 0;
  const effect = f.host.withCurrent(0, async () => { effectStarts++; });
  const rejectedEffect = assert.rejects(effect, /epoch|stale/i);
  await Promise.resolve();
  assert.equal(effectStarts, 0);
  release.resolve();
  await acceptance;
  await rejectedEffect;
  assert.equal(effectStarts, 0);
  assert.equal((await f.host.inspect()).epoch, 1);
});

test('the admission guard ends before root runtime dispatch and accepted steering injection', async t => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ binding });
  const completion = deferred();
  let guardDepth = 0, guardedWrites = 0, injections = 0;
  const session = new AgentSession({ descriptor, expectedBinding: binding, repository, configuration,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    async withSubmissionAdmission(operation) {
      guardDepth++; guardedWrites++;
      try { return await operation(); } finally { guardDepth--; }
    },
    createRuntime() {
      assert.equal(guardDepth, 0, 'Runtime dispatch inside the group guard would deadlock participant work');
      return { run(input) { return { runId: input.runId, result: completion.promise,
        injectSteering() { assert.equal(guardDepth, 0); injections++; },
        abort() { completion.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }); }
      }; } };
    }
  });
  t.after(() => session.close());
  const active = await session.submit({ task: 'Run until directed' });
  assert.equal(active.kind, 'started');
  assert.deepEqual(await session.submit({ task: 'Wrong run correction' }, { delivery: 'steer', expectedRunId: 'wrong' }),
    { kind: 'rejected', reason: 'run_mismatch' });
  assert.equal(await repository.acceptedCorrectionRevision(descriptor), 0);
  const steered = await session.submit({ task: 'Accepted steering' }, { delivery: 'steer', expectedRunId: active.runId });
  assert.equal(steered.kind, 'steered');
  assert.equal(guardedWrites, 2);
  assert.equal(injections, 1);
  assert.ok(await repository.acceptedCorrectionRevision(descriptor) > 0);
});
