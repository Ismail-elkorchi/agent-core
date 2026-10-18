import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, decodeUtf8, isTextMediaType } from '@agent-core/persistence';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import { ContextService, HistoryReader, InMemorySessionRepository } from '@agent-core/runtime';
import { createReadArtifactTool } from '@agent-core/tools';
import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';

async function fixture(artifacts, repository = new InMemorySessionRepository(), session) {
  session ??= await repository.create({ binding: { schemaId: 'artifact-representation', schemaVersion: 1, subject: {} } });
  const history = new HistoryReader({ repository, session, artifacts });
  const context = new ContextService({ repository, session, artifacts, history, assertStateWrite: async () => {},
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  return { artifacts, repository, session, history, context };
}
const admit = async input => ({ compiledInputIdentity: 'exact-artifact', capabilityRevision: 'fixture',
  selection: input.strategy === 'fresh' ? { ...input.selection, continuity: { kind: 'fresh',
    resetId: `reset-${input.cut.sourceRevision}`, historyPosition: input.cut,
    model: { provider: 'fixture', model: 'fixture' }, sources: input.selection.retained } } : input.selection });
async function select(f, artifact, range) {
  const cut = await f.history.capture();
  return f.context.transition({ expectedWindowId: (await f.history.selectedContext(cut))?.windowId ?? null,
    expectedSourceRevision: cut.sourceRevision, idempotencyKey: `view-${cut.sourceRevision}`, reason: 'Exact artifact text', renewal: true,
    selection: { retained: [], artifacts: [{ artifact, representation: 'text', ...(range ? { range } : {}) }] } }, { admit });
}

for (const disk of [false, true]) {
  test(`${disk ? 'disk' : 'memory'} representations preserve selections through relabeling and media collisions`, async t => {
    const directory = disk ? await mkdtemp(path.join(tmpdir(), 'artifact-representations-')) : undefined;
    if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
    const artifacts = disk ? new LocalArtifactRepository(directory) : new InMemoryArtifactRepository();
    const f = await fixture(artifacts);
    for (const [mediaType, alternative] of [['text/html', 'text/plain'], ['application/vnd.test+json', 'application/json']]) {
      const original = await artifacts.store({ label: 'original', description: 'original description', mediaType, content: Buffer.from('evidence') });
      await select(f, original);
      const renamed = await artifacts.store({ label: 'renamed', description: 'new description', mediaType, content: Buffer.from('evidence') });
      assert.equal(renamed.artifactId, original.artifactId);
      assert.deepEqual(await artifacts.resolve(original.artifactId), original);
      assert.equal((await f.context.selectedArtifactContext())[0].content, 'evidence');
      const other = await artifacts.store({ label: 'same bytes', mediaType: alternative, content: Buffer.from('evidence') });
      assert.notEqual(other.artifactId, original.artifactId);
      assert.equal((await f.context.selectedArtifactContext())[0].content, 'evidence');
      await assert.rejects(artifacts.readVerified({ ...original, mediaType: alternative }), /representation|identity/i);
      if (disk) {
        const reopened = await fixture(new LocalArtifactRepository(directory), f.repository, f.session);
        assert.deepEqual(await reopened.artifacts.resolve(original.artifactId), original);
        assert.equal((await reopened.context.selectedArtifactContext())[0].content, 'evidence');
      }
    }
    const secret = await artifacts.storeProtected({ label: 'secret', mediaType: 'text/plain', content: Buffer.from('secret') });
    assert.equal(await artifacts.resolve(secret.artifactId), undefined);
    await assert.rejects(artifacts.readVerified({ ...secret, visibility: 'public' }), /Invalid artifact/);
  });
}

test('persisted descriptors are mandatory, strictly versioned and bind media and digest', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'artifact-descriptor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new LocalArtifactRepository(directory);
  const ref = await artifacts.store({ label: 'data', content: Buffer.from('valid'), mediaType: 'text/plain' });
  const descriptor = path.join(directory, `${ref.artifactId}.ref.json`);
  const original = await readFile(descriptor, 'utf8');
  for (const patch of [record => { record.format = 'old'; }, record => { record.ref.mediaType = 'text/html'; }, record => { record.ref.sha256 = '0'.repeat(64); }]) {
    const record = JSON.parse(original); patch(record);
    await writeFile(descriptor, JSON.stringify(record));
    const reopened = new LocalArtifactRepository(directory);
    await assert.rejects(reopened.resolve(ref.artifactId));
    await assert.rejects(reopened.readVerified(ref));
  }
  await writeFile(descriptor, original);
  await writeFile(path.join(directory, ref.artifactId), 'wrong');
  await assert.rejects(new LocalArtifactRepository(directory).readVerified(ref), /SHA-256/);
  await rm(descriptor);
  assert.equal(await new LocalArtifactRepository(directory).resolve(ref.artifactId), undefined);
  await assert.rejects(new LocalArtifactRepository(directory).readVerified(ref), /unavailable/);
  await assert.rejects(new LocalArtifactRepository(directory).resolve(`${ref.sha256}.txt`), /identifier/);
});

test('shared text interpretation preserves BOM, Arabic and emoji across exact and adjusted reads', async () => {
  assert.equal(decodeUtf8(Buffer.from('\uFEFFمرحبا🙂')), '\uFEFFمرحبا🙂');
  assert.throws(() => decodeUtf8(Uint8Array.from([0xff])));
  assert.equal(isTextMediaType(' Application/YAML ; charset=utf-8'), true);
  assert.equal(isTextMediaType('application/not-json-binary'), false);
  const f = await fixture(new InMemoryArtifactRepository());
  const artifact = await f.artifacts.store({ label: 'unicode', mediaType: 'Application/YAML; charset=utf-8', content: Buffer.from('x\uFEFFمرحبا🙂') });
  const range = { offset: 1, bytes: artifact.size - 1 };
  await select(f, artifact, range);
  assert.equal((await f.context.selectedArtifactContext())[0].content, '\uFEFFمرحبا🙂');
  const reader = createReadArtifactTool({ maxReadBytes: 100 });
  const read = async (offset, byteCount) => (await invokeToolCall(jsonToolCall('read_artifact', { artifactId: artifact.artifactId, offset, byteCount }), [reader], {
    policy: { allowedRisks: ['read'] }, services: { artifactRepository: f.artifacts } })).output;
  assert.equal((await read(range.offset, range.bytes)).text, '\uFEFFمرحبا🙂');
  const adjusted = await read(artifact.size - 2, 1);
  assert.equal(adjusted.text, '🙂');
  assert.deepEqual(adjusted.returnedRange, { start: artifact.size - 4, end: artifact.size });
  await assert.rejects(select(f, artifact, { offset: artifact.size - 2, bytes: 1 }), /exact UTF-8/);
  const full = await f.artifacts.store({ label: 'leading BOM', mediaType: 'text/plain', content: Buffer.from('\uFEFFabc') });
  await select(f, full);
  assert.equal((await f.context.selectedArtifactContext())[0].content, '\uFEFFabc');
});

test('state edit hydration preserves BOM and exact ranges reject every invalid boundary', async () => {
  const f = await fixture(new InMemoryArtifactRepository());
  const requestRef = await f.artifacts.storeProtected({ label: 'request', content: Buffer.from('{}') });
  const cut = await f.history.capture();
  const batch = { branchId: cut.branchId, capturedHistoryCut: cut,
    inference: { ownerId: 'fixture', invocationId: 'fixture', requestRef } };
  const initial = '\uFEFFمرحبا🙂';
  const ref = (await f.context.saveSessionState({ ...batch, idempotencyKey: 'initial', operations: [{ kind: 'create', text: initial }] })).revisions[0];
  assert.equal((await f.context.readSessionState(ref)).text, initial);
  const edited = (await f.context.saveSessionState({ ...batch, idempotencyKey: 'edited', operations: [{ kind: 'edit', itemId: ref.itemId,
    expectedRevisionId: ref.revisionId, edits: [{ offset: 0, bytes: 0, text: 'X' }] }] })).revisions[0];
  assert.equal((await f.context.readSessionState(edited)).text, `X${initial}`);
  assert.equal((await f.context.readSessionState(ref)).text, initial);
  for (const [offset, bytes] of [[2, 0], [2, 1], [1, 1], [0.5, 1], [0, NaN], [Infinity, 0], [-1, 1]]) {
    await assert.rejects(f.context.saveSessionState({ ...batch, idempotencyKey: `bad-${offset}-${bytes}`, operations: [{ kind: 'edit', itemId: ref.itemId,
      expectedRevisionId: edited.revisionId, edits: [{ offset, bytes, text: 'bad' }] }] }));
  }
});

test('text interpretation honors declared charset rather than decoding UTF-16 as UTF-8', async () => {
  for (const mediaType of ['text/plain', 'TEXT/PLAIN; CHARSET=UTF-8', 'text/plain; charset="UtF-8"', 'text/plain; charset=utf8',
    'text/plain; title="quoted; value"; charset="utf-8"']) assert.equal(isTextMediaType(mediaType), true, mediaType);
  for (const mediaType of ['text/plain;charset=utf-16', 'TEXT/PLAIN; CHARSET="UTF-16LE"', 'text/plain;charset=us-ascii',
    'text/plain;charset=iso-8859-1', 'text/plain;charset=', 'text/plain;charset="utf-8',
    'text/plain;charset=utf-8;charset=utf-16', 'text/plain;charset=utf-8;charset=utf-8']) assert.equal(isTextMediaType(mediaType), false, mediaType);
  const f = await fixture(new InMemoryArtifactRepository());
  const reader = createReadArtifactTool({ maxReadBytes: 100 });
  for (const mediaType of ['text/plain;charset=utf-16', 'TEXT/PLAIN; CHARSET="UTF-16LE"']) {
    const artifact = await f.artifacts.store({ label: 'UTF-16 source', mediaType, content: Buffer.from([0x61, 0, 0x62, 0]) });
    await assert.rejects(select(f, artifact), /supported text media type/);
    const result = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: artifact.artifactId }), [reader], {
      policy: { allowedRisks: ['read'] }, services: { artifactRepository: f.artifacts } });
    assert.equal(result.output.contentType, 'artifact');
    assert.equal(result.output.text, undefined);
    assert.equal(result.output.returnedBytes, 4);
  }
  const supported = await f.artifacts.store({ label: 'UTF-8 source', mediaType: 'TEXT/PLAIN; CHARSET="UtF-8"', content: Buffer.from('مرحبا🙂') });
  await select(f, supported);
  assert.equal((await f.context.selectedArtifactContext())[0].content, 'مرحبا🙂');
});
