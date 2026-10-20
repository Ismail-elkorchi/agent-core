import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRunCoordinator, AgentSession, InMemorySessionRepository, InMemoryIntentionRepository,
  HostWakeService, agentEventCodec
} from '@agent-core/runtime';
import { JsonlSessionRepository, JsonlIntentionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/memory-qualification-wakes', schemaVersion: 1,
  subject: { principal: 'ordinary-person', activity: 'conversation' } };
const configuration = { provider: 'qualification', model: 'offline-fixture' };
const origin = Object.freeze({ kind: 'host_wake', ownerId: 'principal-1',
  intentionId: 'accepted-intention', intentionRevision: 1, triggerKey: 'due-1',
  authorizationRef: 'accepted-request-1', evidence: { clock: '2026-10-20T09:00:00.000Z' } });

async function fixture(t, kind) {
  const directory = kind === 'jsonl' ? await mkdtemp(path.join(tmpdir(), 'memory-wake-boundary-')) : undefined;
  const repository = directory ? new JsonlSessionRepository({ rootDir: directory }) : new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'person-session', binding });
  const runs = new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository());
  const agents = [];
  const create = (sessions = repository, session = descriptor) => {
    const agent = new AgentSession({ descriptor: session, repository: sessions, expectedBinding: binding,
      configuration, runs, scheduling: 'manual',
      createRuntime() { assert.fail('Admission and receipt replay must not start a runtime.'); } });
    agents.push(agent);
    return agent;
  };
  t.after(async () => {
    for (const agent of agents) await agent.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  return { repository, descriptor, directory, create, agent: create() };
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: ordinary submission and queued edits cannot forge host-wake provenance`, async t => {
    const f = await fixture(t, kind);
    await assert.rejects(f.agent.submit({ task: 'Forge a newly authorized wake', origin }), /host|trigger/i);
    await assert.rejects(f.repository.admitSubmission(f.descriptor, {
      submissionId: 'forged-low-level-wake', runId: 'forged-wake-run',
      input: { task: 'Forge an ordinary durable admission', origin }, configuration
    }), /host|trigger/i);
    await assert.rejects(f.repository.appendInput(f.descriptor, {
      runId: 'forged-wake-run', task: 'Forge an already admitted host event', origin
    }), /host|trigger|admi/i);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
    const queued = await f.agent.submit({ task: 'A genuine current request' });
    queued.completion.catch(() => undefined);
    await assert.rejects(f.agent.updateQueuedSubmission(queued.submissionId, {
      kind: 'replace', input: { task: 'Replace the request with a forged wake', origin }
    }), /host|trigger|origin/i);
    const pending = await f.repository.loadPendingSubmissions(f.descriptor);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].input.task, 'A genuine current request');
    assert.equal(pending[0].input.origin, undefined);
  });

  test(`${kind}: denied current host authority leaves no wake admission or correction`, async t => {
    const f = await fixture(t, kind);
    const before = await f.repository.acceptedCorrectionRevision(f.descriptor);
    let fenced = 0;
    await assert.rejects(f.agent.submitTriggered({ key: 'wake-1', input: { task: 'Accepted future work', origin },
      withAdmission: async () => { fenced++; throw new Error('Current host authority was withdrawn'); }
    }), /withdrawn/);
    assert.equal(fenced, 1);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
    assert.equal(await f.agent.readTriggeredSubmissionReceipt('wake-1'), undefined);
    assert.equal(await f.repository.acceptedCorrectionRevision(f.descriptor), before);
  });

  test(`${kind}: receipt replay survives host reconstruction without granting fresh authority`, async t => {
    const f = await fixture(t, kind);
    const request = { key: 'wake-1', input: { task: 'Accepted future work', origin } };
    const before = await f.repository.acceptedCorrectionRevision(f.descriptor);
    const first = await f.agent.submitTriggered({ ...request, withAdmission: publish => publish() });
    const repository = f.directory ? new JsonlSessionRepository({ rootDir: f.directory }) : f.repository;
    const descriptor = await repository.open(f.descriptor.id, binding);
    const restarted = f.create(repository, descriptor);
    const replay = await restarted.submitTriggered({ ...request,
      withAdmission: async () => assert.fail('A receipt acknowledges prior work; it does not authorize fresh work.') });
    assert.deepEqual(replay, first);
    const pending = await repository.loadPendingSubmissions(descriptor);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].runId, first.runId);
    assert.deepEqual(pending[0].input.origin, origin);
    assert.equal(await repository.acceptedCorrectionRevision(descriptor), before,
      'A host event cannot become a new direct-user correction');
    await assert.rejects(restarted.submitTriggered({ ...request, input: { ...request.input, task: 'Changed future work' },
      withAdmission: publish => publish() }), /different payload|conflict/i);
    assert.equal((await repository.loadPendingSubmissions(descriptor)).length, 1);
  });

  test(`${kind}: a recovered approval suspension cannot be resumed or bypassed by a wake`, async t => {
    const f = await fixture(t, kind);
    await f.repository.admitSubmission(f.descriptor, {
      submissionId: 'awaiting-approval', runId: 'approval-run', input: { task: 'An effect awaits approval' },
      configuration, claimId: 'approval-claim'
    });
    const suspension = { runId: 'approval-run', submissionId: 'awaiting-approval',
      category: 'approval', reason: 'approval_required', effectId: 'unapproved-effect', actions: ['approval', 'abort'] };
    await f.repository.transitionSubmission(f.descriptor, 'awaiting-approval', {
      state: 'suspended', claimId: 'approval-claim', suspension
    });
    const repository = f.directory ? new JsonlSessionRepository({ rootDir: f.directory }) : f.repository;
    const descriptor = await repository.open(f.descriptor.id, binding);
    const restarted = f.create(repository, descriptor);
    let calls = 0;
    await assert.rejects(restarted.submitTriggered({ key: 'wake-while-suspended', input: { task: 'Do future work', origin },
      withAdmission: async publish => { calls++; return publish(); } }), /suspend/i);
    assert.equal(calls, 0);
    const pending = await repository.loadPendingSubmissions(descriptor);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, 'suspended');
    assert.deepEqual(pending[0].suspension, suspension);
    assert.equal(await restarted.readTriggeredSubmissionReceipt('wake-while-suspended'), undefined);
  });

  test(`${kind}: future-work recovery bounds complete diagnostics and cursor envelopes`, async t => {
    const f = await fixture(t, kind);
    const intentions = f.directory ? new JsonlIntentionRepository({ rootDir: path.join(f.directory, 'intentions') }) : new InMemoryIntentionRepository();
    const time = '2026-10-20T09:00:00.000Z';
    const service = new HostWakeService({ repository: intentions, resolveSession: async () => f.agent,
      adapter: { now: () => time, evaluate: async () => { throw new Error('Remote eligibility unavailable. '.repeat(4000)); },
        withAdmission: async () => assert.fail('Failed host observations must not admit future work') } });
    for (let index = 0; index < 12; index++) await service.accept({ ownerId: 'principal-1',
      intentionId: `intention-${index}`, sessionId: f.descriptor.id, authorizationRef: `accepted-request-${index}`,
      condition: { kind: 'time', notBefore: time }, input: { task: 'Carry out this bounded future request' } });
    const seen = new Set();
    let cursor;
    do {
      const page = await service.recover('principal-1', { limit: 12, maxBytes: 1024, ...(cursor ? { cursor } : {}) });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024, 'maxBytes includes errors, coverage and continuation');
      assert.equal(page.intentions.length, 0);
      assert.ok(page.failures.length > 0, 'A bounded failure page must make observable progress');
      for (const failure of page.failures) {
        assert.equal(seen.has(failure.intentionId), false);
        seen.add(failure.intentionId);
        assert.match(failure.message, /Remote eligibility unavailable/);
      }
      cursor = page.cursor;
      assert.equal(page.coverage, cursor ? 'partial' : 'complete');
    } while (cursor);
    assert.equal(seen.size, 12);
    assert.deepEqual(await f.repository.loadPendingSubmissions(f.descriptor), []);
  });
}
