import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashJson, InMemoryArtifactRepository } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { admitContext } from './context-admission-fixtures.js';

const binding = { schemaId: 'tests/state-sequence-integrity', schemaVersion: 1, subject: {} };
async function fixture(t, kind) {
  const root = await mkdtemp(path.join(tmpdir(), 'state-sequence-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = kind === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository(root);
  const session = await repository.create({ binding });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository, session, artifacts });
  const context = new ContextService({ repository, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const requestRef = await artifacts.storeProtected({ label: 'inference', mediaType: 'application/json',
    content: new TextEncoder().encode('{}') });
  const update = async (id, previousRevisionId, renewal = false) => {
    const cut = await history.capture();
    return context.transition({ expectedWindowId: (await history.selectedContext(cut))?.windowId ?? null,
      renewal, idempotencyKey: id, reason: 'Update interpretation', selection: { retained: [] },
      sessionState: { id, previousRevisionId, content: { working: [{ id: 'note', text: id }] },
        inference: { ownerId: 'owner', invocationId: id, requestRef }, capturedHistoryCut: cut }
    }, { admit: admitContext });
  };
  return { root, repository, session, context, history, update };
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: append cannot rewrite checkpoint lineage or remove its exact state sequence parent`, async t => {
    const f = await fixture(t, kind);
    const first = await f.update('state-a', null);
    const second = await f.update('state-b', 'state-a');
    const before = await f.history.capture();
    const commit = f.repository.commitContextTransition.bind(f.repository);
    const mutations = [
      p => ({ ...p, parent: null }),
      p => ({ ...p, checkpointRevisionId: 'state-b' }),
      p => ({ ...p, lineage: before }),
      p => ({ ...p, parent: { sessionId: f.session.id, entryId: first.id, sha256: hashJson(first) } }),
      p => ({ ...p, parent: null, checkpointRevisionId: 'state-b', lineage: before })
    ];
    for (const [index, mutate] of mutations.entries()) {
      f.repository.commitContextTransition = (session, input) => {
        const stateSequence = mutate(input.window.stateSequence);
        return commit(session, { ...input, window: { ...input.window, stateSequence },
          transition: { ...input.transition, stateSequenceFingerprint: hashJson(stateSequence) } });
      };
      await assert.rejects(f.update(`rejected-${index}`, 'state-b'), /exact parent, checkpoint and continuation lineage/);
      assert.deepEqual(await f.history.capture(), before);
      assert.equal((await f.context.sessionState()).revision.id, 'state-b');
    }
    f.repository.commitContextTransition = commit;
    const valid = await f.update('state-c', 'state-b');
    assert.equal(valid.window.stateSequence.parent.entryId, second.id);
    assert.equal(valid.window.stateSequence.checkpointRevisionId, null);
  });

  test(`${kind}: valid stateSequence hashes cannot replace canonical state notice bytes or delivery identity`, async t => {
    const f = await fixture(t, kind);
    await f.update('state-a', null);
    const before = await f.history.capture();
    const commit = f.repository.commitContextTransition.bind(f.repository);
    const mutations = [
      n => ({ ...n, message: { role: 'user', content: 'Unrelated generated interpretation' } }),
      n => ({ ...n, id: 'another-delivery' }),
      n => ({ ...n, message: { ...n.message, content: `${n.message.content} ` } })
    ];
    for (const [index, mutate] of mutations.entries()) {
      f.repository.commitContextTransition = (session, input) => {
        const stateSequence = { ...input.window.stateSequence, notice: mutate(input.window.stateSequence.notice) };
        return commit(session, { ...input, window: { ...input.window, stateSequence },
          transition: { ...input.transition, stateSequenceFingerprint: hashJson(stateSequence) } });
      };
      await assert.rejects(f.update(`rejected-${index}`, 'state-a'), /singular committed state revision/);
      assert.deepEqual(await f.history.capture(), before);
    }
  });
}

test('persisted notice with recomputed fingerprints is rejected without rewriting its journal', async t => {
  const f = await fixture(t, 'jsonl');
  await f.update('state-a', null);
  const file = f.repository.location(f.session.id);
  const records = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const record = records.find(item => item.type === 'context_transition');
  record.window.stateSequence.notice.message.content = 'Unrelated persisted bytes';
  record.transition.stateSequenceFingerprint = hashJson(record.window.stateSequence);
  const changed = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(file, changed);
  await assert.rejects(new JsonlSessionRepository(f.root).open(f.session.id, binding), /notice|singular committed|changed|hash/i);
  assert.equal(await readFile(file, 'utf8'), changed);
});

test('persisted append cannot erase its ancestry using a recomputed state-sequence fingerprint', async t => {
  const f = await fixture(t, 'jsonl');
  await f.update('state-a', null);
  await f.update('state-b', 'state-a');
  const file = f.repository.location(f.session.id);
  const records = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const record = records.find(item => item.id === 'state-b');
  record.window.stateSequence.parent = null;
  record.window.stateSequence.checkpointRevisionId = 'state-a';
  record.transition.stateSequenceFingerprint = hashJson(record.window.stateSequence);
  const changed = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(file, changed);
  await assert.rejects(new JsonlSessionRepository(f.root).open(f.session.id, binding), /preceding context window|changed|hash/i);
  assert.equal(await readFile(file, 'utf8'), changed);
});
