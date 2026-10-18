import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository } from '@agent-core/runtime';

async function fixture() {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'reservation-test', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository, session, artifacts });
  const context = new ContextService({ repository, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const proposal = async (key, outputReservation, renewal = false) => {
    const cut = await history.capture();
    const window = await history.selectedContext(cut);
    return { expectedWindowId: window?.windowId ?? null, expectedSourceRevision: cut.sourceRevision,
      idempotencyKey: key, reason: 'Explicit request resource choice', selection: { retained: [] },
      ...(renewal ? { renewal } : {}), ...(outputReservation === undefined ? {} : { outputReservation }) };
  };
  return { repository, session, artifacts, history, context, proposal };
}

function admit(input) {
  return Promise.resolve({ compiledInputIdentity: `reservation-${input.outputReservation}`, capabilityRevision: 'fixture',
    ...(input.outputReservation === undefined ? {} : { outputReservation: input.outputReservation }),
    selection: input.strategy === 'fresh' ? { ...input.selection, continuity: { kind: 'fresh',
      resetId: `reset-${input.cut.sourceRevision}`, historyPosition: input.cut,
      model: { provider: 'fixture', model: 'fixture' }, sources: input.selection.retained } } : input.selection });
}

test('reservation-only change is admitted, persisted and inherited by subsequent views', async () => {
  const f = await fixture();
  const first = await f.context.transition(await f.proposal('first', 512), { admit });
  assert.equal(first.window.outputReservation, 512);
  assert.equal(first.transition.admission.outputReservation, 512);
  const changed = await f.context.transition(await f.proposal('changed', 256), { admit });
  assert.equal(changed.window.outputReservation, 256);
  assert.notEqual(changed.window.windowId, first.window.windowId);
  const inherited = await f.context.transition(await f.proposal('inherited', undefined, true), { admit });
  assert.equal(inherited.window.outputReservation, 256);
  assert.equal(inherited.transition.requestedOutputReservation, undefined);
  assert.equal((await f.history.selectedContext(await f.history.capture())).outputReservation, 256);
});

test('reservation changes require exact admission and cannot silently alter the accepted window', async () => {
  const f = await fixture();
  const prior = await f.context.transition(await f.proposal('initial', 512), { admit });
  const request = await f.proposal('denied', 128);
  await assert.rejects(f.context.transition(request, { admit: async input => ({ ...await admit(input), outputReservation: 64 }) }), /reservation/);
  assert.equal((await f.history.selectedContext(await f.history.capture())).windowId, prior.window.windowId);
  await assert.rejects(f.context.transition(request, { admit: async () => { throw new Error('Host reservation policy rejects this choice'); } }), /Host reservation policy/);
  assert.equal((await f.history.selectedContext(await f.history.capture())).outputReservation, 512);
});

test('reservation idempotency binds the requested value even after another window is accepted', async () => {
  const f = await fixture();
  const request = await f.proposal('retry', 512);
  const original = await f.context.transition(request, { admit });
  await f.context.transition(await f.proposal('later', 256), { admit });
  assert.deepEqual(await f.context.transition(request, { admit }), original);
  await assert.rejects(f.context.transition({ ...request, outputReservation: 128 }, { admit }), /conflicting content/);
});
