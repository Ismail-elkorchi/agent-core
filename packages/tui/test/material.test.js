import assert from 'node:assert/strict';
import test from 'node:test';
import { materialPanel } from '@agent-core/tui';
import { createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';

const owner = { kind: 'scope', scopeId: 'private:alex-1' };
const ref = { owner, itemId: 'fact', revisionId: 'revision-1' };
const items = { items: [{ ...ref, preview: 'Prefers quiet places', contentBytes: 20, contentSha256: 'digest' }], coverage: 'complete', revocationRevision: 4 };
const effectContext = { signal: new AbortController().signal };
function fixture() {
  const calls = [];
  const service = {
    currentSessionOwner: async () => ({ kind: 'session', sessionId: 'session-1', branchId: 'session-1' }),
    listScopes: async () => ({ items: [{ owner, revision: 'grant-1', read: true, write: true }], coverage: 'complete' }),
    list: async () => items,
    read: async value => { calls.push(['read', value]); return { ...value, text: 'Prefers quiet places' }; },
    revoke: async value => { calls.push(['revoke', value]); return { revision: 5 }; },
    erase: async () => { throw new Error('Physical material erasure is unsupported'); }
  };
  const panel = materialPanel({
    materialService: sessionId => { assert.equal(sessionId, 'session-1'); return service; },
    submitMaterialCorrection: async (...input) => { calls.push(['correct', ...input]); return { status: 'correction_submitted' }; }
  }, 'session-1');
  let state = panel.update(panel.init().state, { type: 'items', owner, items }).state;
  state = panel.update(state, { type: 'body', ref, body: { ...ref, text: 'Prefers quiet places' } }).state;
  state = { ...state, input: createTextAreaState({ value: 'The preference depends on the occasion.' }) };
  return { panel, state, service, calls };
}

test('material panel submits an exact correction as pending and suppresses repeat actions', async () => {
  const { panel, state, calls } = fixture();
  const pending = panel.update(state, { type: 'correct' });
  assert.equal(pending.state.pending, true);
  assert.equal(panel.update(pending.state, { type: 'correct' }).effects, undefined);
  const result = await pending.effects[0].run(effectContext);
  assert.deepEqual(calls, [['correct', ref, 'The preference depends on the occasion.', 'session-1']]);
  assert.match(result.message.notice, /unchanged until a conditional update/);
  const received = panel.update(pending.state, result.message).state;
  assert.equal(received.selected, undefined);
  assert.equal(received.pending, false);
});

test('material panel asks before revocation, preserves exact revision and never calls it erasure', async () => {
  const { panel, state, calls } = fixture();
  const prepared = panel.update(state, { type: 'prepare', action: 'revoke' });
  assert.equal(calls.length, 0);
  assert.equal(panel.update(prepared.state, { type: 'cancel-confirmation' }).state.confirm, undefined);
  const pending = panel.update(prepared.state, { type: 'confirm' });
  const result = await pending.effects[0].run(effectContext);
  assert.deepEqual(calls[0][1].refs, [{ itemId: ref.itemId, revisionId: ref.revisionId }]);
  assert.equal(calls[0][1].expectedRevision, 4);
  assert.match(result.message.notice, /have not been erased/);
});

test('material panel clears stale body availability after denied access and honors cancellation', async () => {
  const { panel, state } = fixture();
  const failed = panel.update(state, { type: 'failed', message: 'Scope access was withdrawn.' }).state;
  assert.equal(failed.body, undefined);
  assert.equal(failed.items, undefined);
  assert.match(failed.notice, /withdrawn/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(panel.init().effects[0].run({ signal: abort.signal }), { name: 'AbortError' });
});

test('confirmed local erasure first revokes exact future use and reports unsupported erasure honestly', async () => {
  const { panel, state, calls } = fixture();
  const prepared = panel.update(state, { type: 'prepare', action: 'erase' });
  assert.equal(calls.length, 0);
  const pending = panel.update(prepared.state, { type: 'confirm' });
  assert.equal(pending.state.body, undefined);
  assert.equal(pending.state.selected, undefined);
  const result = await pending.effects[0].run(effectContext);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'revoke');
  assert.deepEqual(calls[0][1].refs, [{ itemId: ref.itemId, revisionId: ref.revisionId }]);
  assert.match(result.message.notice, /Future use.*revoked/);
  assert.match(result.message.notice, /erasure was not completed.*unsupported/);
  assert.match(result.message.notice, /Revocation is not erasure/);
  const done = panel.update(pending.state, result.message).state;
  assert.equal(done.pending, false);
  assert.equal(done.body, undefined);
  assert.equal(done.items, undefined);
});

test('local erasure follows successful revocation and preserves actual coverage receipt', async () => {
  const { panel, state, service, calls } = fixture();
  const receipt = { targets: [ref], coverage: [{ target: ref, bodies: 'removed', previews: 'removed', indexes: 'unsupported', caches: 'retained', retainedSharedBytes: 48 }],
    originalHistory: 'separately_governed', requestSnapshots: 'separately_governed', priorRemoteDelivery: 'not_erased', semanticDerivation: 'unknown' };
  service.erase = async refs => { assert.equal(calls[0][0], 'revoke'); calls.push(['erase', refs]); return receipt; };
  const prepared = panel.update(state, { type: 'prepare', action: 'erase' });
  const result = await panel.update(prepared.state, { type: 'confirm' }).effects[0].run(effectContext);
  assert.deepEqual(calls[1], ['erase', [ref]]);
  assert.match(result.message.notice, /"bodies":"removed"/);
  assert.match(result.message.notice, /"caches":"retained"/);
  assert.match(result.message.notice, /"retainedSharedBytes":48/);
});

test('failed revocation does not proceed to physical erasure', async () => {
  const { panel, state, service, calls } = fixture();
  service.revoke = async () => { throw new Error('Grant withdrawn'); };
  service.erase = async () => { calls.push(['erase']); };
  const prepared = panel.update(state, { type: 'prepare', action: 'erase' });
  await assert.rejects(panel.update(prepared.state, { type: 'confirm' }).effects[0].run(effectContext), /Grant withdrawn/);
  assert.deepEqual(calls, []);
});
