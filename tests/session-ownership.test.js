import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalArtifactRepository, JsonlEventRepository } from '@agent-core/persistence/node';
import { AgentRunCoordinator, AgentRuntime, AgentSession, SessionSubmissionOwnershipError,
  agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'test.session-ownership', schemaVersion: 1, subject: {} };
const configuration = { provider: 'fixture', model: 'fixture' };

function deferred() {
  const value = Promise.withResolvers();
  void value.promise.catch(() => undefined);
  return value;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-ownership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstRepository = new JsonlSessionRepository({ rootDir: path.join(root, 'sessions') });
  const descriptor = await firstRepository.create({ binding });
  const providerStarted = deferred();
  const providerResult = deferred();
  let calls = 0;
  const provider = {
    id: 'fixture', implementationId: 'session-ownership.fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'fixture' }),
    describeModel: async () => ({ id: 'fixture', provider: 'fixture',
      capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [],
        jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 16_000, outputTokens: 2_000 },
      supportedParameters: ['maxOutputTokens'] }),
    async complete() {
      calls += 1;
      providerStarted.resolve();
      await providerResult.promise;
      return { provider: 'fixture', model: 'fixture', content: 'Done', terminationReason: 'stop' };
    }
  };
  function dispatcher(createRuntime, configureEvents, scheduling = 'manual') {
    const repository = new JsonlSessionRepository({ rootDir: path.join(root, 'sessions') });
    const events = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
    configureEvents?.(events);
    const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
    const runs = new AgentRunCoordinator(events, artifacts);
    let releases = 0;
    const runtime = () => new AgentRuntime({ provider, model: 'fixture', maxOutputTokens: 64,
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
      repositories: { events, artifacts, session: { repository, descriptor } },
      release() { releases += 1; } });
    const session = new AgentSession({ descriptor, expectedBinding: binding, repository, runs,
      configuration, scheduling, createRuntime: createRuntime ? () => createRuntime(runtime) : runtime });
    return { session, repository, runs, releases: () => releases };
  }
  return { root, descriptor, repository: firstRepository, dispatcher, providerStarted,
    providerResult, calls: () => calls };
}

test('two JSONL dispatchers cannot let the rejected claimant settle the active winner', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const first = f.dispatcher();
  const queued = await first.session.submit({ task: 'Execute once' });
  const second = f.dispatcher(() => assert.fail('A rejected claim cannot create a runtime'));
  await second.session.restore();
  const notifications = [];
  second.session.subscribe(event => notifications.push(event), assert.fail);
  const started = await first.session.startNextSubmission();
  await f.providerStarted.promise;
  const [winner] = await f.repository.loadPendingSubmissions(f.descriptor);
  assert.equal(await second.session.startNextSubmission(), undefined);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), [winner]);
  assert.equal(winner.state, 'claimed');
  assert.equal(f.calls(), 1);
  assert.equal(notifications.some(event => event.type === 'run.failed'), false);
  f.providerResult.resolve();
  assert.equal((await started.completion).terminal.executionStatus, 'completed');
  assert.equal((await queued.completion).terminal.runId, queued.runId);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  await first.session.close();
  await second.session.close();
});

for (const factoryOutcome of ['returns', 'throws']) {
  test(`a replaced pre-accept claimant cannot dispatch or settle when its runtime factory ${factoryOutcome}`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const factoryStarted = deferred();
    const factoryResult = deferred();
    let supersededRuntime;
    const first = f.dispatcher(async makeRuntime => {
      factoryStarted.resolve();
      await factoryResult.promise;
      supersededRuntime = makeRuntime();
      return supersededRuntime;
    });
    const queued = await first.session.submit({ task: 'Preserve this original task', instructions: ['Keep the context'] });
    const attempt = first.session.startNextSubmission();
    const rejected = assert.rejects(attempt, factoryOutcome === 'throws' ? /Factory failed/ : SessionSubmissionOwnershipError);
    await factoryStarted.promise;
    assert.equal(await first.runs.find(queued.runId), undefined);
    const second = f.dispatcher();
    await second.session.restore();
    const inspection = await second.session.inspect();
    assert.equal(inspection.pendingSubmissions[0].state, 'claimed');
    assert.deepEqual(inspection.runs, []);
    assert.equal(await second.session.startNextSubmission(), undefined, 'A live factory retains execution ownership');
    const [previous] = await f.repository.loadPendingSubmissions(f.descriptor);
    await f.repository.transitionSubmission(f.descriptor, previous.submissionId, { state: 'claimed', claimId: 'replacement', expectedClaimId: previous.claimId });
    const [winner] = await f.repository.loadPendingSubmissions(f.descriptor);
    if (factoryOutcome === 'throws') factoryResult.reject(new Error('Factory failed'));
    else factoryResult.resolve();
    await rejected;
    await assert.rejects(queued.completion, factoryOutcome === 'throws' ? /Factory failed/ : SessionSubmissionOwnershipError);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), [winner]);
    assert.equal(first.releases(), factoryOutcome === 'returns' ? 1 : 0);
    assert.equal(second.releases(), 0, 'The competing dispatcher has not constructed a runtime');
    if (supersededRuntime) {
      await supersededRuntime.close();
      assert.equal(first.releases(), 1, 'Closing a discarded runtime releases exactly once');
      assert.throws(() => supersededRuntime.run({ task: 'Cannot reuse discarded resources' }), /has been closed/);
    }
    const recovered = await second.session.startNextSubmission();
    await f.providerStarted.promise;
    assert.equal(f.calls(), 1);
    f.providerResult.resolve();
    const result = await recovered.completion;
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.equal(second.releases(), 1);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
    const durable = await second.runs.inspect(queued.runId);
    assert.equal(durable.state.input.task, 'Preserve this original task');
    assert.deepEqual(durable.state.input.instructions, ['Keep the context']);
    const records = (await readFile(f.repository.location(f.descriptor.id), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(record => record.type === 'submission.completed').length, 1);
    assert.equal(records.filter(record => record.type === 'submission.failed' || record.type === 'submission.suspended').length, 0);
    await first.session.close();
    await second.session.close();
  });
}

for (const settlement of ['completed', 'failed', 'suspended']) {
  test(`JSONL submission ownership fences a stale ${settlement} settlement`, async t => {
    const f = await fixture(t);
    await f.repository.admitSubmission(f.descriptor, { submissionId: 'input', runId: 'run',
      input: { task: 'Do work' }, configuration });
    await f.repository.transitionSubmission(f.descriptor, 'input', { state: 'claimed', claimId: 'old' });
    const next = f.dispatcher().repository;
    await next.transitionSubmission(f.descriptor, 'input', { state: 'claimed', claimId: 'new', expectedClaimId: 'old' });
    const outcome = settlement === 'failed' ? { state: settlement, errorMessage: 'Stale failure' }
      : settlement === 'suspended' ? { state: settlement, suspension: { runId: 'run', submissionId: 'input',
        category: 'runtime', reason: 'runtime_failed', diagnostic: 'Stale failure', actions: ['resume', 'abort'] } }
      : { state: settlement };
    await assert.rejects(f.repository.transitionSubmission(f.descriptor, 'input', { ...outcome, claimId: 'old' }), SessionSubmissionOwnershipError);
    const [pending] = await next.loadPendingSubmissions(f.descriptor);
    assert.equal(pending.claimId, 'new');
    assert.equal(pending.state, 'claimed');
    await next.transitionSubmission(f.descriptor, 'input', { state: 'completed', claimId: 'new' });
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  });
}

for (const [boundary, exitCode, expectedState, accepted] of [
  ['before-claim', 70, 'queued', false],
  ['after-claim', 71, 'claimed', false],
  ['after-accept', 72, 'claimed', true]
]) {
  test(`session admission recovers exactly once after process death ${boundary}`, { timeout: 20000 }, async t => {
    const f = await fixture(t);
    const original = f.dispatcher();
    const queued = await original.session.submit({ task: 'Recover exactly this accepted input',
      instructions: ['Retain original instructions'] });
    const fixturePath = path.resolve('packages/runtime/test/fault/fixtures/session-admission-crash.mjs');
    const crashed = spawnSync(process.execPath, [fixturePath, f.root, f.descriptor.id, boundary], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 15000
    });
    assert.equal(crashed.status, exitCode, crashed.stderr);
    const recovered = f.dispatcher();
    await recovered.session.restore();
    const snapshot = await recovered.session.inspect();
    assert.equal(snapshot.pendingSubmissions[0].state, expectedState);
    assert.equal(snapshot.runs.length, accepted ? 1 : 0);
    assert.equal(f.calls(), 0, 'restore and inspect do not execute accepted work');
    const started = await recovered.session.startNextSubmission();
    assert.equal(started.runId, queued.runId);
    await f.providerStarted.promise;
    f.providerResult.resolve();
    const result = await started.completion;
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.equal(f.calls(), 1);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
    const durable = await recovered.runs.inspect(queued.runId);
    assert.equal(durable.state.input.task, 'Recover exactly this accepted input');
    assert.deepEqual(durable.state.input.instructions, ['Retain original instructions']);
    const reopened = f.dispatcher();
    await reopened.session.restore();
    assert.equal(await reopened.session.startNextSubmission(), undefined);
    assert.equal(f.calls(), 1);
    const records = (await readFile(f.repository.location(f.descriptor.id), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(record => record.type === 'submission.completed').length, 1);
    await original.session.close();
    await recovered.session.close();
    await reopened.session.close();
  });
}

test('execution ownership spans the run.accepted boundary without live takeover', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const admissionStarted = deferred();
  const admissionReleased = deferred();
  const original = f.dispatcher(undefined, events => {
    const append = events.appendConditional.bind(events);
    events.appendConditional = async (runId, event, options) => {
      if (options.idempotencyKey === `${runId}:run:accepted`) {
        admissionStarted.resolve();
        await admissionReleased.promise;
      }
      return append(runId, event, options);
    };
  });
  await original.session.submit({ task: 'Fence delayed acceptance' });
  const attempt = await original.session.startNextSubmission();
  await admissionStarted.promise;
  const observer = f.dispatcher(() => assert.fail('Live admission cannot be recovered'));
  await observer.session.restore();
  const before = (await f.repository.loadPendingSubmissions(f.descriptor))[0];
  assert.equal(await observer.session.startNextSubmission(), undefined);
  assert.deepEqual((await f.repository.loadPendingSubmissions(f.descriptor))[0], before);
  admissionReleased.resolve();
  await f.providerStarted.promise;
  f.providerResult.resolve();
  assert.equal((await attempt.completion).terminal.executionStatus, 'completed');
  assert.equal(f.calls(), 1);
  await Promise.all([original.session.close(), observer.session.close()]);
});

test('an active runtime cannot be closed and explicit idle close is final and idempotent', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let runtime;
  const owner = f.dispatcher(makeRuntime => {
    runtime = makeRuntime();
    return runtime;
  });
  await owner.session.submit({ task: 'Keep resources until execution settles' });
  const attempt = await owner.session.startNextSubmission();
  await f.providerStarted.promise;
  await assert.rejects(runtime.close(), /Cannot close an active/);
  assert.equal(owner.releases(), 0);
  f.providerResult.resolve();
  await attempt.completion;
  await runtime.close();
  await runtime.close();
  assert.equal(owner.releases(), 1);
  assert.throws(() => runtime.run({ task: 'Closed' }), /has been closed/);
  assert.throws(() => runtime.resume(attempt.runId), /has been closed/);
  await assert.rejects(runtime.resolveApproval({ runId: attempt.runId, approvalId: 'unused',
    fingerprint: 'unused', decision: 'allow' }), /has been closed/);
  await owner.session.close();
});

test('factory failure releases execution ownership for automatic same-submission recovery', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const failed = f.dispatcher(() => { throw new Error('Factory unavailable'); });
  const submitted = await failed.session.submit({ task: 'Recover without a new submission' });
  const rejection = assert.rejects(submitted.completion, /Factory unavailable/);
  await assert.rejects(failed.session.startNextSubmission(), /Factory unavailable/);
  await rejection;
  const [before] = await f.repository.loadPendingSubmissions(f.descriptor);
  assert.equal(before.state, 'claimed');
  const recovery = f.dispatcher(undefined, undefined, 'automatic');
  await recovery.session.restore();
  await f.providerStarted.promise;
  f.providerResult.resolve();
  await recovery.session.waitForIdle();
  assert.equal(f.calls(), 1);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  assert.equal((await recovery.runs.inspect(submitted.runId)).state.phase.kind, 'terminal');
  await Promise.all([failed.session.close(), recovery.session.close()]);
});

test('two restored automatic clients serialize distinct submissions and settle both original completion handles', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const first = f.dispatcher(undefined, undefined, 'automatic');
  const second = f.dispatcher(undefined, undefined, 'automatic');
  await Promise.all([first.session.restore(), second.session.restore()]);
  const a = await first.session.submit({ task: 'first distinct input' });
  await Promise.race([f.providerStarted.promise, a.completion.then(result => assert.fail(`Run ended before provider start: ${JSON.stringify(result)}`))]);
  const b = await second.session.submit({ task: 'second distinct input' });
  assert.equal(a.kind, 'started');
  assert.equal(b.kind, 'queued');
  const inspected = await second.session.inspect();
  assert.equal(inspected.session.phase, 'running');
  assert.equal(inspected.session.activeRunId, a.runId);
  assert.equal(inspected.session.queuedInputs, 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.calls(), 1);
  f.providerResult.resolve();
  const results = await Promise.all([a.completion, b.completion]);
  assert.deepEqual(results.map(result => result.terminal.runId), [a.runId, b.runId]);
  assert.equal(f.calls(), 2);
  assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  await Promise.all([first.session.close(), second.session.close()]);
});

test('an idle automatic client discovers durable input admitted by another client', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const automatic = f.dispatcher(undefined, undefined, 'automatic');
  await automatic.session.restore();
  const origin = f.dispatcher();
  const submission = await origin.session.submit({ task: 'discover without another user action' });
  await Promise.race([f.providerStarted.promise, submission.completion.then(result => assert.fail(`Run ended before provider start: ${JSON.stringify(result)}`))]);
  assert.equal(f.calls(), 1);
  f.providerResult.resolve();
  assert.equal((await submission.completion).terminal.runId, submission.runId);
  await Promise.all([automatic.session.close(), origin.session.close()]);
});


test("a restored observer never reexecutes its owner's completed submission", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const owner = f.dispatcher(undefined, undefined, 'automatic');
  const submission = await owner.session.submit({ task: 'Complete with the original owner' });
  await Promise.race([f.providerStarted.promise, submission.completion.then(result => assert.fail(JSON.stringify(result)))]);
  const observer = f.dispatcher(() => assert.fail('Completed work cannot be recovered again'));
  await observer.session.restore();
  assert.equal((await observer.session.inspect()).session.activeRunId, submission.runId);
  f.providerResult.resolve();
  await submission.completion;
  assert.equal((await observer.session.inspect()).session.phase, 'idle');
  assert.equal(await observer.session.startNextSubmission(), undefined);
  assert.equal(f.calls(), 1);
  await Promise.all([owner.session.close(), observer.session.close()]);
});

test('waiting for idle on a restored observer never reclaims a healthy occupying run', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const owner = f.dispatcher(undefined, undefined, 'automatic');
  const submission = await owner.session.submit({ task: 'Keep the executing owner while another client waits' });
  await Promise.race([f.providerStarted.promise, submission.completion.then(result => assert.fail(JSON.stringify(result)))]);
  const observer = f.dispatcher(() => assert.fail('Waiting cannot construct a recovery runtime'), undefined, 'automatic');
  await observer.session.restore();
  const before = (await f.repository.loadPendingSubmissions(f.descriptor))[0];
  let idle = false;
  const waiting = observer.session.waitForIdle().then(() => { idle = true; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(idle, false);
  assert.equal((await f.repository.loadPendingSubmissions(f.descriptor))[0].claimId, before.claimId);
  assert.equal(f.calls(), 1);
  f.providerResult.resolve();
  assert.equal((await submission.completion).terminal.executionStatus, 'completed');
  await waiting;
  assert.equal((await observer.session.inspect()).session.phase, 'idle');
  await Promise.all([owner.session.close(), observer.session.close()]);
});
