import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository, InMemoryEventRepository, sameArtifactIdentity } from '@agent-core/persistence';
import { createParticipantArtifactRepository, ParticipantArtifactAccessError, InMemorySessionRepository,
  ScopedShareService, PeerDeliveryService, peerContributionFingerprint, peerDeliveryEventCodec } from '@agent-core/runtime';

function ownership() {
  const records = new Map();
  let enabled = true;
  return {
    records,
    revoke() { enabled = false; },
    coordinator: {
      async recordPublicArtifact(participantId, ref) { records.set(`${participantId}:${ref.artifactId}`, structuredClone(ref)); },
      async canReadPublicArtifact(participantId, ref) {
        const recorded = records.get(`${participantId}:${typeof ref === 'string' ? ref : ref.artifactId}`);
        return enabled && !!recorded && (typeof ref === 'string' || sameArtifactIdentity(recorded, ref));
      }
    }
  };
}

test('participant writes await durable attribution and sibling known references are denied before lookup or body I/O', async t => {
  const artifacts = new InMemoryArtifactRepository();
  const ledger = ownership();
  const left = createParticipantArtifactRepository({ artifacts, participantId: 'left', coordinator: () => ledger.coordinator });
  const right = createParticipantArtifactRepository({ artifacts, participantId: 'right', coordinator: () => ledger.coordinator });
  const produced = await left.store({ label: 'output', content: Buffer.from('Attributable output 😀'), mediaType: 'text/plain' });
  assert.ok(ledger.records.has(`left:${produced.artifactId}`));
  let lookups = 0, reads = 0;
  const resolve = artifacts.resolve.bind(artifacts), read = artifacts.readVerified.bind(artifacts), range = artifacts.readVerifiedRange.bind(artifacts);
  t.mock.method(artifacts, 'resolve', async id => { lookups++; return resolve(id); });
  t.mock.method(artifacts, 'readVerified', async ref => { reads++; return read(ref); });
  t.mock.method(artifacts, 'readVerifiedRange', async (...args) => { reads++; return range(...args); });
  assert.equal(await right.resolve(produced.artifactId), undefined);
  await assert.rejects(right.readVerified(produced), ParticipantArtifactAccessError);
  await assert.rejects(right.readVerifiedRange(produced, { offset: 0, length: 1 }), ParticipantArtifactAccessError);
  assert.deepEqual([lookups, reads], [0, 0]);
  const changedLabel = { ...produced, label: 'Presentation label changes', description: 'Different annotation' };
  assert.equal(Buffer.from(await left.readVerified(changedLabel)).toString(), 'Attributable output 😀');
  const previousReads = reads;
  await assert.rejects(left.readVerified({ ...produced, size: produced.size + 1 }), ParticipantArtifactAccessError);
  assert.equal(reads, previousReads, 'A forged immutable identity cannot touch the body');
  await right.recordProducedArtifact(produced); // Explicit host attribution, never a model operation.
  assert.equal((await right.resolve(produced.artifactId)).artifactId, produced.artifactId);
});

test('participant artifact access is rechecked after asynchronous resolution and reads', async t => {
  for (const method of ['resolve', 'readVerified', 'readVerifiedRange']) {
    const artifacts = new InMemoryArtifactRepository();
    const ledger = ownership();
    const view = createParticipantArtifactRepository({ artifacts, participantId: 'reader', coordinator: () => ledger.coordinator });
    const produced = await view.store({ label: 'output', content: Buffer.from('private bytes'), mediaType: 'text/plain' });
    const original = artifacts[method].bind(artifacts);
    const mocked = t.mock.method(artifacts, method, async (...args) => { const result = await original(...args); ledger.revoke(); return result; });
    await assert.rejects(method === 'resolve' ? view.resolve(produced.artifactId) : method === 'readVerified' ? view.readVerified(produced) : view.readVerifiedRange(produced, { offset: 0, length: 3 }), ParticipantArtifactAccessError);
    mocked.mock.restore();
  }
});

test('failed ownership publication cannot return a new model-readable artifact reference', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const ledger = ownership();
  let fail = true;
  const record = ledger.coordinator.recordPublicArtifact;
  ledger.coordinator.recordPublicArtifact = async (...args) => { if (fail) throw new Error('Ownership journal unavailable'); return record(...args); };
  const view = createParticipantArtifactRepository({ artifacts, participantId: 'producer', coordinator: () => ledger.coordinator });
  const input = { label: 'output', content: Buffer.from('Own output'), mediaType: 'text/plain' };
  await assert.rejects(view.store(input), /Ownership journal unavailable/u);
  const persistedBody = await artifacts.store(input);
  assert.equal(await view.resolve(persistedBody.artifactId), undefined);
  fail = false;
  const retried = await view.store(input);
  assert.equal(retried.artifactId, persistedBody.artifactId);
  assert.equal(Buffer.from(await view.readVerified(retried)).toString(), 'Own output');
});

test('exact ranged material imports do not confer full public artifact grants and protected state stays non-resolvable', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const ledger = ownership();
  const view = createParticipantArtifactRepository({ artifacts, participantId: 'recipient', coordinator: () => ledger.coordinator });
  const source = await artifacts.store({ label: 'host source', content: Buffer.from('selected and private remainder'), mediaType: 'text/plain' });
  const sessions = new InMemorySessionRepository();
  const recipient = await sessions.create({ id: 'recipient-session', binding: { schemaId: 'artifact-sharing-test', schemaVersion: 1, subject: {} } });
  const grant = { grantId: 'exact-range', revision: 1, groupId: 'group', sender: { participantId: 'sender', sessionId: 'sender-session' }, recipient: { participantId: 'recipient', sessionId: recipient.id }, correctionEpoch: 0,
    source: { kind: 'public_artifact', artifact: source, range: { offset: 0, bytes: 8 } } };
  const shares = new ScopedShareService({ repository: sessions, artifacts, resolveSession: async () => { throw new Error('Public source needs no unrelated session read'); }, authorize: async () => {} });
  const material = await shares.materialize(grant, { maxBytes: 8192 });
  const body = { deliveryId: 'ranged-import', groupId: 'group', sender: grant.sender, recipient: grant.recipient, assignmentId: 'assignment', assignmentRevision: 1, senderRunId: 'sender-run', correctionEpoch: 0, content: 'Exact selected bytes', shares: [material] };
  const delivery = new PeerDeliveryService({ sessions, shares, events: new InMemoryEventRepository(peerDeliveryEventCodec), resolveSession: async () => recipient, authorizeAddress: async () => {}, authorize: async () => {}, withAuthorization: async (_input, operation) => operation() });
  await delivery.deliver({ ...body, fingerprint: peerContributionFingerprint(body) });
  assert.equal((await sessions.readConversation(recipient))[0].contribution.shares[0].text, 'selected');
  assert.equal(await view.resolve(source.artifactId), undefined);
  await assert.rejects(view.readVerifiedRange(source, { offset: 13, length: 17 }), ParticipantArtifactAccessError);
  const protectedRef = await view.storeProtected({ label: 'native input', content: Buffer.from('protected provider state') });
  assert.equal(await view.resolve(protectedRef.artifactId), undefined);
  assert.equal(Buffer.from(await view.readVerified(protectedRef)).toString(), 'protected provider state', 'Canonical host runtime protected reads remain supported');
  await assert.rejects(view.recordProducedArtifact(protectedRef), /Protected artifacts/u);
  assert.equal(ledger.records.size, 0);
});
