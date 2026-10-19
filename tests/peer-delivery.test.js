import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { AgentRuntime, AgentSession, AgentRunCoordinator, ContextService, agentEventCodec, InMemorySessionRepository, PeerDeliveryService, PeerDeliveryAdmissionError, peerContributionFingerprint, peerDeliveryEventCodec, HistoryReader, sourceRef, createCollaborationPeerDelivery } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { collaborationProvider } from './fixtures/collaboration-provider.mjs';
const binding = { schemaId: 'peer-delivery-test', schemaVersion: 1, subject: {} };
function contribution(content = 'Model-authored finding 😀', deliveryId = 'delivery') {
  const body = { deliveryId, groupId: 'group', sender: { participantId: 'sender', sessionId: 'sender-session' }, recipient: { participantId: 'recipient', sessionId: 'recipient-session' }, assignmentId: 'assignment', assignmentRevision: 1, senderRunId: 'sender-run', correctionEpoch: 0, content, shares: [] };
  return { ...body, fingerprint: peerContributionFingerprint(body) };
}
for (const persistence of ['memory', 'jsonl']) {
  test(`${persistence}: initial exact source imports reach the first delegated assignment request`, async t => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'peer-initial-request-'));
    let agent;
    t.after(async () => { await agent?.close(); await rm(rootDir, { recursive: true, force: true }); });
    const sessions = persistence === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir });
    const supervisor = await sessions.create({ id: 'supervisor-session', binding });
    const recipient = await sessions.create({ id: 'recipient-session', binding });
    const selected = 'Selected original evidence 😀.';
    const excluded = 'Private excluded trailing detail.';
    const originalInput = { task: `Unselected prefix 🧭. ${selected} ${excluded}` };
    await sessions.admitSubmission(supervisor, { submissionId: 'original', runId: 'supervisor-run', input: originalInput,
      configuration: { provider: 'collaboration-fixture', model: 'collaboration-fixture' } });
    const original = await sessions.appendInput(supervisor, { runId: 'supervisor-run', ...originalInput, instructions: [] });
    const originalHistory = new HistoryReader({ repository: sessions, session: supervisor });
    const originalRef = sourceRef(supervisor.id, original);
    const exact = await originalHistory.read({ source: originalRef, maxBytes: 8192 });
    assert.equal(exact.status, 'available');
    assert.equal(exact.item.text, JSON.stringify(originalInput), 'Selection addresses the exact exposed source representation, including its envelope');
    const index = exact.item.text.indexOf(selected);
    assert.ok(index >= 0);
    const source = { kind: 'history', cut: await originalHistory.capture(), source: originalRef,
      range: { offset: Buffer.byteLength(exact.item.text.slice(0, index)), bytes: Buffer.byteLength(selected) } };
    const participant = { groupId: 'group', participantId: 'recipient', sessionId: recipient.id };
    const assignment = { assignmentId: 'assignment', revision: 1, runId: 'recipient-run', epoch: 0, initialSources: [source],
      sourceSender: { participantId: `supervisor:${supervisor.id}`, sessionId: supervisor.id, runId: 'supervisor-run' } };
    const group = { groupId: 'group', supervisorSessionId: supervisor.id, epoch: 0, participants: [{ participant, assignment, cancelled: false }] };
    const coordinator = { authorizationState: async () => group, withCurrent: async (epoch, operation) => { assert.equal(epoch, group.epoch); return operation(); } };
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const peer = createCollaborationPeerDelivery({ coordinator: () => coordinator, supervisorSession: () => supervisor,
      supervisorRunId: () => undefined, sessions, artifacts, events: new InMemoryEventRepository(peerDeliveryEventCodec) });
    const receipt = await peer.importAssignmentSources(assignment, participant);
    const imported = await sessions.findPeerContribution(recipient, receipt.deliveryId);
    assert.equal(imported.contribution.shares[0].text, selected);
    const repository = persistence === 'memory' ? sessions : new JsonlSessionRepository({ rootDir });
    const descriptor = await repository.open(recipient.id, binding);
    const history = new HistoryReader({ repository, session: descriptor, events, artifacts, authorizePeerContribution: peer.authorizeContribution });
    const context = new ContextService({ repository, session: descriptor, history, artifacts, policy: { maxSourceBytes: 4 * 1024 * 1024 } });
    const fixture = collaborationProvider([{}]);
    fixture.profile.capabilities.protocol = conservativeProtocolCapabilities('fixture', { contextReset: 'fresh_request' });
    agent = new AgentSession({ descriptor, repository, expectedBinding: binding, runs: new AgentRunCoordinator(events, artifacts),
      configuration: { provider: fixture.provider.id, model: fixture.profile.id },
      createRuntime: () => new AgentRuntime({ provider: fixture.provider, model: fixture.profile.id, maxOutputTokens: 64,
        context, contextRenewal: { automatic: true }, repositories: { events, artifacts, session: { repository, descriptor } },
        toolBoundary: { authorizationPolicyId: 'tests/peer', executionTargetId: 'tests/peer' } }) });
    const handle = await agent.submit({ task: 'Review selected evidence.', origin: { kind: 'delegated_assignment', groupId: 'group',
      participantId: participant.participantId, assignmentId: assignment.assignmentId, assignmentRevision: assignment.revision,
      sender: { sessionId: supervisor.id } } });
    const result = await handle.completion;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(fixture.requests.length, 1);
    const messages = fixture.requests[0].messages;
    const peerMessages = messages.filter(message => typeof message.content === 'string' && message.content.includes(selected));
    assert.equal(peerMessages.length, 1);
    assert.equal(peerMessages[0].role, 'assistant');
    assert.match(peerMessages[0].content, /Peer model-authored contribution/u);
    assert.match(peerMessages[0].content, /"sourceRole":"user"/u);
    assert.equal(JSON.stringify(messages).includes(excluded), false);
    assert.equal(JSON.stringify(messages).includes('Unselected prefix'), false);
    assert.equal(messages.some(message => typeof message.content === 'string' && message.content.includes('Delegated model-authored assignment.')), true);
  });
}
for (const persistence of ['memory', 'jsonl']) {
  test(`${persistence}: recipient imports are durable, exactly-once, attributable model material`, async t => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'peer-import-'));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    let repository = persistence === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir });
    let session = await repository.create({ id: 'recipient-session', binding });
    const first = await repository.appendPeerContribution(session, contribution());
    assert.equal(first.type, 'peer_contribution');
    assert.equal(first.authorship, 'model');
    if (persistence === 'jsonl') repository = new JsonlSessionRepository({ rootDir });
    session = await repository.open(session.id, binding);
    const again = await repository.appendPeerContribution(session, contribution());
    assert.equal(again.id, first.id);
    await assert.rejects(async () => repository.appendPeerContribution(session, contribution('changed')), /Conflicting peer delivery/u);
    assert.equal((await repository.readConversation(session)).length, 1);
    const history = new HistoryReader({ repository, session });
    const item = await history.read({ source: sourceRef(session.id, first), maxBytes: 8192 });
    assert.equal(item.status, 'available');
    assert.equal(item.item.role, 'assistant');
    assert.equal(item.item.generated, true);
    assert.match(item.item.text, /sender-session/u);
    assert.match(item.item.text, /Model-authored finding 😀/u);
    assert.equal((await history.latest({ maxBytes: 8192 })).items.length, 0, 'Peer imports do not become user requirements');
    await assert.rejects(async () => repository.appendPeerContribution(session, { ...contribution(), fingerprint: '0'.repeat(64) }), /fingerprint/u);
    await assert.rejects(async () => repository.appendPeerContribution(session, contribution('\ud800')), /Unicode/u);
  });
}
for (const persistence of ['memory', 'jsonl']) {
  test(`${persistence}: receipt crash and observer failure cannot duplicate recipient history`, async t => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'peer-receipt-'));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const sessions = persistence === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository({ rootDir: path.join(rootDir, 'sessions') });
    const recipient = await sessions.create({ id: 'recipient-session', binding });
    const events = persistence === 'memory' ? new InMemoryEventRepository(peerDeliveryEventCodec) : new JsonlEventRepository({ rootDir: path.join(rootDir, 'events'), codec: peerDeliveryEventCodec });
    let crash = true, notifications = 0, publicationAllowed = true;
    const failing = new Proxy(events, { get(target, key) { if (key === 'append') return async (...args) => { if (args[1].type === 'peer.delivery_received' && crash) { crash = false; throw new Error('Injected receipt failure'); } return target.append(...args); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    const options = { sessions, events: failing, resolveSession: async () => recipient, authorizeAddress: async () => {}, authorize: async (_input, stage) => { if (stage === 'publish' && !publicationAllowed) throw new Error('Sender assignment ended'); }, withAuthorization: async (_input, operation) => { assert.equal(publicationAllowed, true); return operation(); }, notify: () => { notifications++; throw new Error('Observer down'); } };
    await assert.rejects(new PeerDeliveryService(options).deliver(contribution()), /Injected receipt failure/u);
    assert.equal((await sessions.readConversation(recipient)).length, 1);
    publicationAllowed = false;
    const reopenedEvents = persistence === 'jsonl' ? new JsonlEventRepository({ rootDir: path.join(rootDir, 'events'), codec: peerDeliveryEventCodec }) : events;
    const service = new PeerDeliveryService({ ...options, events: reopenedEvents });
    const receipt = await service.reconcile({ groupId: 'group', recipient: contribution().recipient, deliveryId: 'delivery' });
    assert.equal((await sessions.readConversation(recipient)).length, 1);
    assert.equal(notifications, 1);
    assert.deepEqual(await service.deliver(contribution()), receipt);
    assert.equal((await sessions.readConversation(recipient)).length, 1);
    const list = await service.list({ groupId: 'group', recipient: contribution().recipient, maxBytes: 8192 });
    assert.deepEqual(list.items.map(item => item.state), ['received']);
    await assert.rejects(async () => service.read({ groupId: 'group', recipient: contribution().recipient, deliveryId: 'delivery' }, { maxBytes: 1 }), /envelope/u);
  });
}

test('unrelated recipient addresses are denied before reading journal data', async () => {
  let reads = 0;
  const service = new PeerDeliveryService({
    events: { referenceByKey: async () => { reads++; throw new Error('Unexpected source read'); }, readMetadataRange: async () => { reads++; throw new Error('Unexpected metadata read'); } },
    sessions: new InMemorySessionRepository(), resolveSession: async () => { throw new Error('Unexpected session resolution'); },
    authorizeAddress: async () => { throw new Error('Address denied'); }, authorize: async () => { throw new Error('Contribution denied'); }, withAuthorization: async (_input, operation) => operation()
  });
  await assert.rejects(async () => service.read({ groupId: 'group', recipient: contribution().recipient, deliveryId: 'delivery' }, { maxBytes: 8192 }), /Address denied/u);
  await assert.rejects(async () => service.list({ groupId: 'group', recipient: contribution().recipient }), /Address denied/u);
  assert.equal(reads, 0);
});

test('common peer host materializes exact sender-owned sources and denies unrelated and public artifact scope', async () => {
  const { createCollaborationPeerDelivery, InMemorySessionRepository, HistoryReader, sourceRef } = await import('@agent-core/runtime');
  const { InMemoryArtifactRepository } = await import('@agent-core/persistence');
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const supervisor = await sessions.create({ id: 'supervisor-session', binding });
  const recipient = await sessions.create({ id: 'recipient-session', binding });
  const original = await sessions.appendInput(supervisor, { runId: 'supervisor-run', task: 'Shared original 😀', instructions: [] });
  const history = new HistoryReader({ repository: sessions, session: supervisor });
  const cut = await history.capture();
  const group = { groupId: 'group', supervisorSessionId: supervisor.id, epoch: 0, participants: [{ participant: { participantId: 'recipient', sessionId: recipient.id }, assignment: { assignmentId: 'assignment', revision: 1, runId: 'recipient-run', capabilities: { toolNames: [] } }, cancelled: false }] };
  const coordinator = { authorizationState: async () => group, withCurrent: async (epoch, operation) => { assert.equal(epoch, group.epoch); return operation(); } };
  let activeSupervisorRun = 'supervisor-run';
  const peer = createCollaborationPeerDelivery({ coordinator: () => coordinator, supervisorSession: () => supervisor, supervisorRunId: () => activeSupervisorRun, sessions, artifacts, events: new InMemoryEventRepository(peerDeliveryEventCodec) });
  const source = { kind: 'history', cut, source: sourceRef(supervisor.id, original), range: { offset: 0, bytes: Buffer.byteLength(original.task) } };
  const receipt = await peer.send({ participantId: 'recipient', content: 'Consider this source', operationId: 'source-delivery', sources: [source] });
  const imports = await sessions.readConversation(recipient);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].contribution.shares[0].text, original.task);
  assert.equal(imports[0].contribution.shares[0].sourceRole, 'user');
  const receiverHistory = new HistoryReader({ repository: sessions, session: recipient, authorizePeerContribution: peer.authorizeContribution });
  const received = await receiverHistory.read({ source: receipt.source, maxBytes: 8192 });
  assert.equal(received.item.role, 'assistant');
  activeSupervisorRun = 'continued-supervisor-run';
  assert.deepEqual(await peer.send({ participantId: 'recipient', content: 'Consider this source', operationId: 'source-delivery', sources: [source], expectedEpoch: 0, sourceRunId: 'supervisor-run' }), receipt);
  await assert.rejects(peer.send({ participantId: 'recipient', content: 'New output from old root run', operationId: 'old-root-new-publication', sourceRunId: 'supervisor-run' }), /source run is no longer current/u);
  const foreign = await sessions.appendInput(recipient, { runId: 'recipient-run', task: 'Private recipient original', instructions: [] });
  const foreignCut = await receiverHistory.capture();
  await assert.rejects(async () => peer.send({ participantId: 'recipient', content: 'wrong scope', operationId: 'foreign', sources: [{ kind: 'history', cut: foreignCut, source: sourceRef(recipient.id, foreign), range: { offset: 0, bytes: 7 } }] }), /sender-owned/u);
  const artifact = await artifacts.store({ label: 'host-public', mediaType: 'text/plain', content: Buffer.from('public data') });
  await assert.rejects(async () => peer.send({ participantId: 'recipient', content: 'reference is insufficient', operationId: 'artifact', sources: [{ kind: 'public_artifact', artifact, range: { offset: 0, bytes: artifact.size } }] }), /explicit host/u);
  const assignment = group.participants[0].assignment;
  Object.assign(assignment, { participantId: 'recipient', epoch: 0, capabilities: { toolNames: [], collaboration: { actions: ['message'], participantIds: [`supervisor:${supervisor.id}`] } }, initialSources: [source], sourceSender: { participantId: `supervisor:${supervisor.id}`, sessionId: supervisor.id, runId: 'supervisor-run' } });
  Object.assign(group.participants[0].participant, { groupId: group.groupId });
  const recovering = createCollaborationPeerDelivery({ coordinator: () => coordinator, supervisorSession: () => supervisor, supervisorRunId: () => undefined, sessions, artifacts, events: new InMemoryEventRepository(peerDeliveryEventCodec) });
  const initial = await recovering.importAssignmentSources(assignment, group.participants[0].participant);
  assert.deepEqual(await recovering.importAssignmentSources(assignment, group.participants[0].participant), initial);
  assert.equal((await sessions.readConversation(recipient)).filter(entry => entry.type === 'peer_contribution').length, 2, 'Assignment source recovery imports once without a live supervisor run');
  group.epoch = 1;
  await assert.rejects(async () => peer.send({ actorParticipantId: 'recipient', participantId: `supervisor:${supervisor.id}`, content: 'late stale result', operationId: 'stale-epoch' }), /epoch is stale/u);
  assert.equal((await receiverHistory.read({ source: receipt.source, maxBytes: 8192 })).status, 'available', 'Correction preserves accepted historical evidence');
  assert.deepEqual(await recovering.importAssignmentSources(assignment, group.participants[0].participant), initial, 'Already received initial sources reconcile after correction');
});

test('accepted source imports survive sender continuation, departure, and correction while new stale publication fails', async t => {
  const sessions = new InMemorySessionRepository();
  const supervisor = await sessions.create({ id: 'supervisor-session', binding });
  const sender = await sessions.create({ id: 'sender-session', binding });
  const original = await sessions.appendInput(sender, { runId: 'sender-run', task: 'Original evidence 😀', instructions: [] });
  const sourceHistory = new HistoryReader({ repository: sessions, session: sender });
  const source = { kind: 'history', cut: await sourceHistory.capture(), source: sourceRef(sender.id, original), range: { offset: 0, bytes: Buffer.byteLength(original.task) } };
  const originalView = { participant: { participantId: 'sender', sessionId: sender.id, groupId: 'group' }, assignment: { assignmentId: 'assignment', revision: 1, runId: 'sender-run', epoch: 0, capabilityRevision: 'grant-1', capabilities: { toolNames: [], collaboration: { actions: ['message'], participantIds: [`supervisor:${supervisor.id}`] } } }, cancelled: false };
  const group = { groupId: 'group', supervisorSessionId: supervisor.id, epoch: 0, participants: [structuredClone(originalView)] };
  let revoked = false;
  const coordinator = { authorizationState: async () => group, findAssignment: async (...identity) => {
    assert.deepEqual(identity, ['sender', 'assignment', 1, 'sender-run']); return originalView;
  }, withCurrent: async (epoch, operation) => { assert.equal(epoch, group.epoch); return operation(); } };
  const peer = createCollaborationPeerDelivery({ coordinator: () => coordinator, supervisorSession: () => supervisor, supervisorRunId: () => 'root-run', sessions, events: new InMemoryEventRepository(peerDeliveryEventCodec), authorizeShare: async () => { if (revoked) throw new Error('Grant explicitly revoked'); } });
  const receipt = await peer.send({ actorParticipantId: 'sender', participantId: `supervisor:${supervisor.id}`, content: 'Evidence with original provenance', operationId: 'original', sources: [source] });
  const entry = (await sessions.readConversation(supervisor))[0];
  const history = new HistoryReader({ repository: sessions, session: supervisor, authorizePeerContribution: peer.authorizeContribution });
  const address = { groupId: 'group', recipient: entry.contribution.recipient, deliveryId: 'original' };
  group.participants[0].assignment = { ...originalView.assignment, revision: 2, runId: 'continued-run' };
  const actorAssignment = { assignmentId: 'assignment', assignmentRevision: 1, runId: 'sender-run', correctionEpoch: 0, capabilityRevision: 'grant-1' };
  await assert.rejects(peer.send({ actorParticipantId: 'sender', actorAssignment, sourceRunId: 'sender-run', participantId: `supervisor:${supervisor.id}`, content: 'Old caller cannot acquire a new sender assignment', operationId: 'stale-bound-caller' }), /assignment binding is stale/u);
  assert.equal((await history.read({ source: receipt.source, maxBytes: 8192 })).status, 'available');
  await peer.authorizeContribution(entry, 'admit');
  assert.deepEqual(await peer.service.reconcile(address), receipt);
  const { fingerprint: _fingerprint, ...staleBody } = entry.contribution;
  const stale = { ...staleBody, deliveryId: 'late-new-delivery' };
  stale.fingerprint = peerContributionFingerprint(stale);
  await assert.rejects(peer.service.deliver(stale), /no longer authorized/u);
  group.epoch = 1;
  group.participants[0].cancelled = true;
  assert.equal((await history.read({ source: receipt.source, maxBytes: 8192 })).status, 'available');
  await peer.authorizeContribution(entry, 'admit');
  assert.deepEqual(await peer.service.deliver(entry.contribution), receipt);
  group.participants = [];
  assert.deepEqual(await peer.service.reconcile(address), receipt, 'Historical source survives sender departure');
  assert.deepEqual(await peer.send({ actorParticipantId: 'sender', actorAssignment, sourceRunId: 'sender-run', expectedEpoch: 0, participantId: `supervisor:${supervisor.id}`, content: 'Evidence with original provenance', operationId: 'original', sources: [source] }), receipt, 'Canonical old sender retry recovers the same receipt after departure');
  await assert.rejects(peer.send({ actorParticipantId: 'sender', actorAssignment, sourceRunId: 'sender-run', expectedEpoch: 0, participantId: `supervisor:${supervisor.id}`, content: 'Changed retry', operationId: 'original', sources: [source] }), /Conflicting peer delivery/u);
  await assert.rejects(peer.service.deliver(stale), /epoch is stale/u);
  await assert.rejects(peer.send({ participantId: `supervisor:${supervisor.id}`, content: 'old authorized action', operationId: 'old-root-action', expectedEpoch: 0 }), /epoch is stale/u);
  assert.equal(entry.contribution.correctionEpoch, 0);
  const readEntry = sessions.readBranchEntry.bind(sessions);
  const blockedRead = t.mock.method(sessions, 'readBranchEntry', async (...args) => { const value = await readEntry(...args); revoked = true; return value; });
  await assert.rejects(peer.service.read(address, { maxBytes: 8192 }), /explicitly revoked/u, 'Revocation during receipt source I/O fences the returned envelope');
  blockedRead.mock.restore();
  revoked = true;
  await assert.rejects(history.read({ source: receipt.source, maxBytes: 8192 }), /explicitly revoked/u);
  await assert.rejects(peer.authorizeContribution(entry, 'admit'), /explicitly revoked/u);
  await assert.rejects(peer.service.reconcile(address), /explicitly revoked/u);
  assert.equal((await sessions.readConversation(supervisor)).length, 1);
});

test('continued assignments reusing a label receive distinct initial-source imports and historical retries keep their receipts', async () => {
  const sessions = new InMemorySessionRepository();
  const supervisor = await sessions.create({ id: 'supervisor-session', binding });
  const recipient = await sessions.create({ id: 'recipient-session', binding });
  const original = await sessions.appendInput(supervisor, { runId: 'root-run', task: 'Initial exact source', instructions: [] });
  const history = new HistoryReader({ repository: sessions, session: supervisor });
  const source = { kind: 'history', cut: await history.capture(), source: sourceRef(supervisor.id, original), range: { offset: 0, bytes: Buffer.byteLength(original.task) } };
  const participant = { groupId: 'group', participantId: 'recipient', sessionId: recipient.id };
  const first = { assignmentId: 'same-label', revision: 1, runId: 'child-1', epoch: 0, initialSources: [source], sourceSender: { participantId: `supervisor:${supervisor.id}`, sessionId: supervisor.id, runId: 'root-run' } };
  const group = { groupId: 'group', supervisorSessionId: supervisor.id, epoch: 0, participants: [{ participant, assignment: first, cancelled: false }] };
  const coordinator = { authorizationState: async () => group, withCurrent: async (epoch, operation) => { assert.equal(epoch, group.epoch); return operation(); } };
  const peer = createCollaborationPeerDelivery({ coordinator: () => coordinator, supervisorSession: () => supervisor, supervisorRunId: () => undefined, sessions, events: new InMemoryEventRepository(peerDeliveryEventCodec) });
  const firstReceipt = await peer.importAssignmentSources(first, participant);
  const second = { ...first, revision: 2, runId: 'child-2' };
  group.participants[0].assignment = second;
  const secondReceipt = await peer.importAssignmentSources(second, participant);
  assert.notEqual(firstReceipt.deliveryId, secondReceipt.deliveryId);
  assert.notEqual(firstReceipt.entryId, secondReceipt.entryId);
  assert.deepEqual(await peer.importAssignmentSources(first, participant), firstReceipt);
  assert.deepEqual(await peer.importAssignmentSources(second, participant), secondReceipt);
  assert.equal((await sessions.readConversation(recipient)).length, 2);
});

test('delivery admission rejects a burst before asynchronous authorization and releases every permit', async () => {
  const sessions = new InMemorySessionRepository();
  const recipient = await sessions.create({ id: 'recipient-session', binding });
  let release, reads = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const service = new PeerDeliveryService({ sessions, events: new InMemoryEventRepository(peerDeliveryEventCodec), maxPendingDeliveries: 2,
    resolveSession: async () => recipient, authorizeAddress: async () => { reads++; await blocked; }, authorize: async () => {}, withAuthorization: async (_input, operation) => operation() });
  const first = service.deliver(contribution('first', 'first'));
  const second = service.deliver(contribution('second', 'second'));
  assert.equal(service.pendingDeliveries, 2);
  await assert.rejects(service.deliver(contribution('third', 'third')), error => error instanceof PeerDeliveryAdmissionError && error.code === 'peer_delivery_capacity');
  assert.equal(reads, 2, 'Rejected calls do not start authorization or source work');
  release();
  await Promise.all([first, second]);
  assert.equal(service.pendingDeliveries, 0);
  for (const error of [new Error('Preparation failed'), new DOMException('Cancelled', 'AbortError')]) {
    await assert.rejects(service.prepareAndDeliver(async () => { throw error; }), value => value === error);
    assert.equal(service.pendingDeliveries, 0);
  }
  await assert.rejects(service.deliver({ ...contribution(), fingerprint: '0'.repeat(64) }), /fingerprint/u);
  assert.equal(service.pendingDeliveries, 0);
  await service.deliver(contribution('last', 'last'));
  assert.equal((await sessions.readConversation(recipient)).length, 3);
});

test('common helper reserves group capacity before source preparation or state lookup', async () => {
  const sessions = new InMemorySessionRepository();
  const supervisor = await sessions.create({ id: 'supervisor-session', binding });
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const peer = createCollaborationPeerDelivery({ coordinator: () => ({ authorizationState: async () => { calls++; await blocked; throw new Error('State unavailable'); } }), supervisorSession: () => supervisor, supervisorRunId: () => 'run', sessions, events: new InMemoryEventRepository(peerDeliveryEventCodec), maxPendingDeliveries: 1 });
  const first = peer.send({ participantId: 'recipient', content: 'first', operationId: 'first' });
  await assert.rejects(peer.send({ participantId: 'recipient', content: 'excess', operationId: 'second' }), PeerDeliveryAdmissionError);
  assert.equal(calls, 1);
  release();
  await assert.rejects(first, /State unavailable/u);
  assert.equal(peer.service.pendingDeliveries, 0);
});

test('an old staged intent without recipient acceptance cannot be promoted during receipt recovery', async () => {
  const sessions = new InMemorySessionRepository();
  const recipient = await sessions.create({ id: 'recipient-session', binding });
  const events = new InMemoryEventRepository(peerDeliveryEventCodec);
  let current = true;
  const failing = new Proxy(sessions, { get(target, key) { if (key === 'appendPeerContribution') return async () => { throw new Error('Crash before recipient append'); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  const options = { events, sessions: failing, resolveSession: async () => recipient, authorizeAddress: async () => {}, authorize: async (_input, stage) => { if (stage === 'publish' && !current) throw new Error('Old publication fenced'); }, withAuthorization: async (_input, operation) => operation() };
  await assert.rejects(new PeerDeliveryService(options).deliver(contribution()), /Crash before recipient append/u);
  current = false;
  const service = new PeerDeliveryService({ ...options, sessions });
  await assert.rejects(service.reconcile({ groupId: 'group', recipient: contribution().recipient, deliveryId: 'delivery' }), /Old publication fenced/u);
  assert.equal((await sessions.readConversation(recipient)).length, 0);
  assert.equal((await service.read({ groupId: 'group', recipient: contribution().recipient, deliveryId: 'delivery' }, { maxBytes: 8192 })).receipt, undefined);
  assert.equal(service.pendingDeliveries, 0);
});

test('the common send helper checks actor recipient scope before looking up recipient delivery data', async () => {
  const sessions = new InMemorySessionRepository();
  const supervisor = await sessions.create({ id: 'supervisor-session', binding });
  let reads = 0;
  const group = { groupId: 'group', supervisorSessionId: supervisor.id, epoch: 0, participants: [{ participant: { participantId: 'sender', sessionId: 'sender-session' }, assignment: { assignmentId: 'assignment', revision: 1, runId: 'sender-run', epoch: 0, capabilities: { toolNames: [], collaboration: { actions: ['message'], participantIds: [] } } } }] };
  const peer = createCollaborationPeerDelivery({ coordinator: () => ({ authorizationState: async () => group }), supervisorSession: () => supervisor, supervisorRunId: () => 'root-run', sessions,
    events: { referenceByKey: async () => { reads++; throw new Error('Unexpected recipient journal access'); } } });
  await assert.rejects(peer.send({ actorParticipantId: 'sender', participantId: `supervisor:${supervisor.id}`, content: 'Unauthorized', operationId: 'guessed-receipt' }), /explicit message authority/u);
  assert.equal(reads, 0);
});
