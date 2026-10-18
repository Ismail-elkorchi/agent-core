import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashJson, InMemoryArtifactRepository } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { admitContext } from './context-admission-fixtures.js';

const binding = { schemaId: 'tests/selected-view-integrity', schemaVersion: 1, subject: {} };
async function fixture(t, kind) {
  const root = await mkdtemp(path.join(tmpdir(), 'selected-view-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = kind === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository(root);
  const session = await repository.create({ binding });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository, session, artifacts });
  const context = new ContextService({ repository, session, artifacts, history, assertStateWrite: async () => {},
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const requestRef = await artifacts.storeProtected({ label: 'inference', content: Buffer.from('{}') });
  const cut = await history.capture();
  const receipt = await context.saveSessionState({ idempotencyKey: 'original', branchId: cut.branchId,
    capturedHistoryCut: cut, inference: { ownerId: 'owner', invocationId: 'inference', requestRef },
    operations: [{ kind: 'create', text: 'Exact interpretation 文😀' }] });
  const update = async (id, refs = receipt.revisions) => context.transition({
    expectedWindowId: (await history.selectedContext())?.windowId ?? null,
    renewal: true, idempotencyKey: id, reason: 'Select exact interpretation',
    selection: { retained: [], sessionState: refs }
  }, { admit: admitContext });
  return { root, repository, session, context, history, update, ref: receipt.revisions[0] };
}
function refingerprint(input) {
  const selection = input.window.selection;
  const { continuity, ...proposalSelection } = selection;
  return { ...input, transition: { ...input.transition,
    selectionFingerprint: hashJson(selection),
    requestFingerprint: hashJson({ expectedWindowId: input.transition.previousWindowId,
      idempotencyKey: input.transition.idempotencyKey, reason: input.window.reason,
      renewal: input.transition.requestedRenewal, selection: proposalSelection }) } };
}
for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: forged exact selected refs cannot commit even with recomputed fingerprints`, async t => {
    const f = await fixture(t, kind);
    await f.update('initial');
    const before = await f.history.capture();
    const selected = await f.context.sessionState();
    const commit = f.repository.commitContextTransition.bind(f.repository);
    const mutations = [
      ref => ({ ...ref, itemId: 'unrelated-item' }),
      ref => ({ ...ref, revisionId: 'unavailable-revision' }),
      ref => ({ ...ref, range: { offset: 0, bytes: 100000 } })
    ];
    for (const [index, mutate] of mutations.entries()) {
      f.repository.commitContextTransition = (session, input) => commit(session, refingerprint({ ...input,
        window: { ...input.window, selection: { ...input.window.selection,
          sessionState: [mutate(input.window.selection.sessionState[0])] } } }));
      await assert.rejects(f.update(`rejected-${index}`), /unavailable|range|revision/i);
      assert.deepEqual(await f.history.capture(), before);
      assert.deepEqual(await f.context.sessionState(), selected);
    }
    f.repository.commitContextTransition = commit;
    const valid = await f.update('valid');
    assert.deepEqual(valid.window.selection.sessionState, [f.ref]);
  });

  test(`${kind}: selected-view retries return their original selection after a later activation`, async t => {
    const f = await fixture(t, kind);
    const request = { expectedWindowId: null, renewal: true, idempotencyKey: 'original-view',
      reason: 'Select exact interpretation', selection: { retained: [], sessionState: [f.ref] } };
    const original = await f.context.transition(request, { admit: admitContext });
    await f.update('cleared-view', []);
    assert.deepEqual(await f.context.sessionState(), { id: null, items: [] });
    assert.deepEqual(await f.context.transition(request, { admit: admitContext }), original);
    assert.deepEqual(await f.context.sessionState(), { id: null, items: [] }, 'retry must not reactivate its old view');
    await assert.rejects(f.context.transition({ ...request, selection: { retained: [],
      sessionState: [{ ...f.ref, range: { offset: 0, bytes: 5 } }] } }, { admit: admitContext }), /conflicting content/);
    assert.equal((await f.context.readSessionState(f.ref)).text, 'Exact interpretation 文😀');
  });

  test(`${kind}: retired state sequence controls cannot be added to a committed window`, async t => {
    const f = await fixture(t, kind);
    const before = await f.history.capture();
    const commit = f.repository.commitContextTransition.bind(f.repository);
    f.repository.commitContextTransition = (session, input) => commit(session, { ...input,
      window: { ...input.window, stateSequence: { checkpointRevisionId: null, lineage: null, parent: null } } });
    await assert.rejects(f.update('legacy-sequence'), /stateSequence|unrecognized/i);
    assert.deepEqual(await f.history.capture(), before);
    assert.deepEqual(await f.context.sessionState(), { id: null, items: [] });
  });
}

test('persisted selected refs cannot be rewritten with only a recomputed selection fingerprint', async t => {
  const f = await fixture(t, 'jsonl');
  await f.update('original-view');
  const file = f.repository.location(f.session.id);
  const records = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const record = records.find(item => item.type === 'context_transition');
  record.window.selection.sessionState[0].revisionId = 'forged-revision';
  record.transition.selectionFingerprint = hashJson(record.window.selection);
  const changed = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(file, changed);
  await assert.rejects(new JsonlSessionRepository(f.root).open(f.session.id, binding), /fingerprint|changed|hash|revision/i);
  assert.equal(await readFile(file, 'utf8'), changed);
});
