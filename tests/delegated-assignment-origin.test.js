import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { AgentRuntime, AgentSession, AgentRunCoordinator, HistoryReader, InMemorySessionRepository,
  agentEventCodec, ownSessionSubmissionInput, sourceRef } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { collaborationProvider } from './fixtures/collaboration-provider.mjs';

const binding = { schemaId: 'tests/delegated-origin', schemaVersion: 1, subject: {} };
const origin = { kind: 'delegated_assignment', groupId: 'group', participantId: 'worker',
  assignmentId: 'assignment', assignmentRevision: 1, sender: { sessionId: 'supervisor', runId: 'supervisor-run' } };
const toolBoundary = { authorizationPolicyId: 'tests/delegated-origin', executionTargetId: 'tests/delegated-origin' };

for (const persistence of ['memory', 'jsonl']) {
  test(`${persistence}: delegated input retains provenance and never matches user-history filters`, async t => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'delegated-origin-'));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    let repository = persistence === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir });
    let descriptor = await repository.create({ binding });
    const user = await repository.appendInput(descriptor, { runId: 'user-run', task: 'Original user requirement', instructions: [] });
    const accepted = await repository.admitSubmission(descriptor, { submissionId: 'delegated', runId: 'delegated-run',
      input: { task: 'Model assigned task', origin, relationship: { kind: 'correct' } }, configuration: { provider: 'fixture', model: 'fixture' }, maximumQueuedInputs: 4 });
    assert.equal(await repository.acceptedCorrectionRevision(descriptor), 0, 'Model-authored assignment cannot claim an accepted user correction');
    await assert.rejects(repository.appendInput(descriptor, { runId: accepted.runId, task: accepted.input.task }), /origin differs/u);
    await assert.rejects(repository.appendInput(descriptor, { runId: accepted.runId, task: accepted.input.task,
      origin: { ...origin, assignmentRevision: 2 } }), /origin differs/u);
    const delegated = await repository.appendInput(descriptor, { runId: accepted.runId, task: accepted.input.task, origin });
    assert.equal(delegated.task, accepted.input.task);
    assert.deepEqual(delegated.originalInput.origin, origin);
    if (persistence === 'jsonl') {
      repository = new JsonlSessionRepository({ rootDir });
      descriptor = await repository.open(descriptor.id, binding);
      await repository.rebuildHistoryIndex(descriptor.id, binding);
    }
    const history = new HistoryReader({ repository, session: descriptor });
    const source = sourceRef(descriptor.id, delegated);
    const cut = await history.capture();
    assert.equal((await history.metadata(source, cut)).inputAuthorship, 'model');
    assert.deepEqual((await history.latest()).items.map(item => item.source.entryId), [user.id]);
    const latest = await history.latest({ filter: { role: 'assistant' } });
    assert.deepEqual(latest.items.map(item => item.source.entryId), [delegated.id]);
    assert.equal(latest.items[0].generated, true);
    assert.equal((await history.search({ query: 'assigned', filter: { role: 'user' } })).items.length, 0);
    assert.deepEqual((await history.search({ query: 'assigned', filter: { role: 'assistant' } })).items.map(item => item.source.entryId), [delegated.id]);
    assert.equal((await history.read({ source })).item.role, 'assistant');
    assert.equal((await history.readExcerpts([{ source, offset: 0, bytes: 1 }], cut))[0].role, 'assistant');
    await assert.rejects(repository.appendInput(descriptor, { runId: accepted.runId, task: accepted.input.task }), /Conflicting session input/u);
  });

  test(`${persistence}: session dispatch and reopened request replay preserve delegated authorship without changing the task`, async t => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'delegated-replay-'));
    const artifacts = new InMemoryArtifactRepository();
    let repository = persistence === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir: path.join(rootDir, 'sessions') });
    let events = persistence === 'memory' ? new InMemoryEventRepository(agentEventCodec) : new JsonlEventRepository({ rootDir: path.join(rootDir, 'events'), codec: agentEventCodec });
    let descriptor = await repository.create({ binding });
    const fixture = collaborationProvider([{}, {}]);
    let runs = new AgentRunCoordinator(events, artifacts);
    const open = () => new AgentSession({ descriptor, expectedBinding: binding, repository, runs,
      configuration: { provider: fixture.profile.provider, model: fixture.profile.id },
      createRuntime: () => new AgentRuntime({ provider: fixture.provider, model: fixture.profile.id, maxOutputTokens: 64, toolBoundary,
        repositories: { events, artifacts, session: { repository, descriptor } } }) });
    let session = open();
    t.after(async () => { await session.close(); await rm(rootDir, { recursive: true, force: true }); });
    const task = 'Model assigned task';
    const delegated = await session.submit({ task, origin, runId: 'delegated-run' });
    assert.equal((await delegated.completion).terminal.executionStatus, 'completed');
    await session.close();
    if (persistence === 'jsonl') {
      repository = new JsonlSessionRepository({ rootDir: path.join(rootDir, 'sessions') });
      descriptor = await repository.open(descriptor.id, binding);
      events = new JsonlEventRepository({ rootDir: path.join(rootDir, 'events'), codec: agentEventCodec });
      runs = new AgentRunCoordinator(events, artifacts);
    }
    const state = (await runs.inspect(delegated.runId)).state;
    assert.equal(state.input.task, task);
    assert.deepEqual(state.input.origin, origin);
    assert.deepEqual((await events.latestOfType(delegated.runId, 'input.received')).event.origin, origin);
    assert.deepEqual((await events.latestOfType(delegated.runId, 'turn.started')).event.origin, origin);
    assert.deepEqual((await events.latestOfType(delegated.runId, 'prompt.material.selected')).event.material.origin, origin);
    const firstAssignment = fixture.requests[0].messages.find(message => message.content?.includes('Delegated model-authored assignment.'));
    assert.equal(firstAssignment.role, 'user', 'Provider framing must not promote the assignment to system authority');
    assert.ok(firstAssignment.content.endsWith(task));
    assert.match(firstAssignment.content, /supervisor-run/u);
    session = open();
    const user = await session.submit({ task: 'Actual user continuation', runId: 'user-run' });
    assert.equal((await user.completion).terminal.executionStatus, 'completed');
    const replayed = fixture.requests[1].messages.find(message => message.content?.includes('Delegated model-authored assignment.'));
    assert.equal(replayed.content, firstAssignment.content, 'Historical reconstruction preserves the original assignment label and sender');
    assert.ok(fixture.requests[1].messages.some(message => message.role === 'user' && message.content === 'Actual user continuation'));
    const history = new HistoryReader({ repository, session: descriptor, events });
    const latestUser = await history.latest();
    assert.deepEqual(latestUser.items.map(item => item.runId), ['user-run']);
    assert.equal((await runs.inspect(user.runId)).state.input.origin, undefined);
  });
}

test('delegated origin is strictly validated and captured as immutable host input', () => {
  const mutable = structuredClone(origin);
  const captured = ownSessionSubmissionInput({ task: 'assigned', origin: mutable });
  mutable.sender.sessionId = 'changed';
  assert.equal(captured.origin.sender.sessionId, 'supervisor');
  assert.equal(Object.isFrozen(captured.origin.sender), true);
  assert.throws(() => ownSessionSubmissionInput({ task: 'assigned', origin: { ...origin, assignmentRevision: 0 } }));
  assert.throws(() => ownSessionSubmissionInput({ task: 'assigned', origin: { ...origin, role: 'system' } }));
});
