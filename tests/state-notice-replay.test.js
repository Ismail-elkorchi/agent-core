import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelWindow } from '@agent-core/runtime';

const profile = { id: 'scripted', provider: 'scripted', modalities: { input: ['text'], output: ['text'] } };
const cut = { format: 'agent-core.history/1', sessionId: 'session', branchId: 'main',
  throughEntryId: null, sourceRevision: 0, ledgerCoverage: 'authoritative', ledgerHeads: [] };
const notice = { id: 'notice-1', previousRevisionId: null, revisionId: 'state-1', after: cut,
  message: { role: 'user', content: 'Generated interpretation. Replacement state: {}\nExact whitespace preserved.  ' } };

test('state notices retain exact role, bytes, position and one delivery identity', () => {
  const window = new ModelWindow();
  window.recordInput('before', { role: 'assistant', content: 'Before replacement.' });
  window.recordStateNotice(notice);
  window.recordInput('after', { role: 'user', content: 'Later correction.' });
  window.recordStateNotice(structuredClone(notice));
  assert.deepEqual(window.messagesFor(profile).messages, [
    { role: 'assistant', content: 'Before replacement.' }, notice.message,
    { role: 'user', content: 'Later correction.' }
  ]);
  assert.throws(() => window.recordStateNotice({ ...notice, message: { ...notice.message, content: '{}' } }), /immutable identity/);
});

test('replacing a model window preserves notice receipts and fresh renewal removes them', () => {
  const original = new ModelWindow();
  const stateSequence = { checkpointRevisionId: null, lineage: null, parent: null, notice };
  original.setStateSequence(stateSequence);
  original.recordStateNotice(notice, false);
  const restored = new ModelWindow();
  restored.replaceWith(original);
  restored.recordStateNotice(notice, false);
  assert.deepEqual(restored.stateSequence(), stateSequence);
  assert.deepEqual(restored.priorMessagesFor(profile).messages, [notice.message]);
  const fresh = new ModelWindow();
  fresh.setStateSequence({ checkpointRevisionId: 'state-1', lineage: cut, parent: null });
  restored.replaceWith(fresh);
  assert.deepEqual(restored.priorMessagesFor(profile).messages, []);
  assert.deepEqual(restored.messagesFor(profile).messages, []);
  assert.equal(restored.stateSequence().checkpointRevisionId, 'state-1');
});

test('staging an appended notice cannot mutate the admitted source window', () => {
  const live = new ModelWindow();
  live.bindContinuation({ request: { model: 'scripted', messages: [] } });
  const staged = new ModelWindow();
  staged.replaceWith(live);
  staged.recordStateNotice(notice);
  assert.deepEqual(live.continuation().current, []);
  assert.deepEqual(live.messagesFor(profile).messages, []);
  assert.deepEqual(staged.continuation().current, [notice.message]);
});
