import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentSession,
  AgentRunCoordinator,
  AgentSubmissionCancelledError,
  InMemorySessionRepository,
  agentEventCodec
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/queued-input', schemaVersion: 1, subject: {} };
const configuration = { provider: 'fixture', model: 'fixture' };

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: queued input revisions and cancellation persist without executing a run`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'queued-input-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository =
      kind === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir: root });
    const descriptor = await repository.create({ binding });
    const session = new AgentSession({
      descriptor,
      expectedBinding: binding,
      repository,
      configuration,
      scheduling: 'manual',
      runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec)),
      createRuntime() {
        throw new Error('Queued work must not execute.');
      }
    });
    const accepted = await session.submit({ task: 'Original' });
    assert.equal(accepted.kind, 'queued');
    assert.equal(typeof accepted.runId, 'string');
    await session.updateQueuedSubmission(accepted.submissionId, {
      kind: 'replace',
      expectedInput: { task: 'Original' },
      input: { task: 'Revised' }
    });
    await assert.rejects(
      session.updateQueuedSubmission(accepted.submissionId, {
        kind: 'cancel',
        expectedInput: { task: 'Original' }
      }),
      /changed since/
    );
    const reopened = kind === 'memory' ? repository : new JsonlSessionRepository({ rootDir: root });
    const [pending] = await reopened.loadPendingSubmissions(descriptor);
    assert.equal(pending.input.task, 'Revised');
    assert.equal(pending.runId, accepted.runId);
    await session.updateQueuedSubmission(accepted.submissionId, {
      kind: 'cancel',
      expectedInput: pending.input
    });
    await assert.rejects(
      accepted.completion,
      (error) =>
        error instanceof AgentSubmissionCancelledError && error.submissionId === accepted.submissionId
    );
    assert.equal(session.state().queuedInputs, 0);
    assert.deepEqual(await reopened.loadPendingSubmissions(descriptor), []);
    await assert.rejects(
      session.updateQueuedSubmission(accepted.submissionId, { kind: 'cancel', expectedInput: pending.input }),
      /no longer queued/
    );
  });

  test(`${kind}: claimed submissions reject edits, and recorded inputs use the last accepted revision`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'queued-input-claim-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository =
      kind === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir: root });
    const descriptor = await repository.create({ binding });
    await repository.enqueueSubmission(descriptor, {
      submissionId: 'submission',
      runId: 'run',
      input: { task: 'Original' },
      configuration
    });
    await repository.updateQueuedSubmission(descriptor, 'submission', {
      kind: 'replace',
      expectedInput: { task: 'Original' },
      input: { task: 'Revised' }
    });
    await repository.transitionSubmission(descriptor, 'submission', { state: 'claimed' });
    await assert.rejects(
      repository.updateQueuedSubmission(descriptor, 'submission', {
        kind: 'replace',
        expectedInput: { task: 'Revised' },
        input: { task: 'Too late' }
      }),
      /no longer queued/
    );
    const input = await repository.appendInput(descriptor, { runId: 'run', task: 'Revised' });
    assert.deepEqual(input.originalInput, { task: 'Revised' });
  });
}
