import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EffectExecutor, effectExecutionEventCodec } from '@agent-core/runtime';
import { InMemoryEventRepository, hashJson } from '@agent-core/persistence';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { parseJsonObject } from '@agent-core/json';
import {
  closeExternalEffect,
  issueEffectStartTicket,
  settleExternalEffect,
  startExternalEffect
} from '@agent-core/effects';

const codec = { encode: parseJsonObject, decode: parseJsonObject };
function effect(overrides = {}) {
  return {
    intent: {
      effectId: 'remote-export:1',
      ownerId: 'work:1',
      implementationId: 'export@1',
      parametersDigest: hashJson({ document: 'original' }),
      recovery: {
        kind: 'queryable',
        service: 'export',
        reconcilerId: 'export@1',
        externalExecutionId: 'job:1',
        expiresAt: '2099-01-01T00:00:00Z'
      },
      exposure: { quantities: [{ unit: 'exports', amount: 1 }] }
    },
    codec,
    exposure: () => ({ status: 'known', quantities: [{ unit: 'exports', amount: 1 }] }),
    start: async () => ({ artifactId: 'exported:1' }),
    reconcile: async () => ({ status: 'settled', observation: { artifactId: 'exported:1' } }),
    ...overrides
  };
}

test('effect event admission requires an exact observation only for a known settlement', () => {
  const intent = effect().intent;
  const issued = issueEffectStartTicket({
    intent,
    ticketId: 'ticket',
    settlementPermitId: 'permit',
    driverGeneration: 1,
    currentDriverGeneration: 1
  });
  const started = startExternalEffect(issued.state, issued.state.ticket, 1).state;
  for (const state of [
    issued.state,
    started,
    closeExternalEffect(issued.state, 'cancelled_before_start'),
    closeExternalEffect(started, 'unknown_outcome')
  ]) {
    const event = { type: 'execution.state.changed', state };
    assert.deepEqual(effectExecutionEventCodec.decode(effectExecutionEventCodec.encode(event)), event);
    assert.throws(
      () => effectExecutionEventCodec.decode({ ...event, observation: {} }),
      /An unsettled effect cannot own an observation/
    );
  }
  for (const outcome of ['succeeded', 'failed', 'cancelled']) {
    const observation = { export: { artifactId: 'original' } };
    const state = settleExternalEffect(started, started.settlementPermit, {
      outcome,
      resultDigest: hashJson(observation),
      exposure: effect().exposure()
    }).state;
    const event = { type: 'execution.state.changed', state, observation };
    assert.deepEqual(effectExecutionEventCodec.decode(effectExecutionEventCodec.encode(event)), event);
    assert.throws(
      () => effectExecutionEventCodec.decode({ type: event.type, state }),
      /Effect observation does not match its settlement/
    );
    assert.throws(
      () => effectExecutionEventCodec.decode({ ...event, observation: {} }),
      /Effect observation does not match its settlement/
    );
    const decoded = effectExecutionEventCodec.decode(event);
    observation.export.artifactId = 'changed';
    assert.equal(decoded.observation.export.artifactId, 'original');
    assert.equal(Object.isFrozen(decoded.observation.export), true);
  }
  const state = settleExternalEffect(started, started.settlementPermit, {
    outcome: 'unknown',
    exposure: { status: 'unknown', reserved: intent.exposure.quantities }
  }).state;
  for (const fields of [{}, { observation: {} }]) {
    assert.throws(
      () => effectExecutionEventCodec.decode({ type: 'execution.state.changed', state, ...fields }),
      /Effect observation does not match its settlement/
    );
  }
});

for (const persistence of ['memory', 'jsonl']) {
  test(`${persistence}: application effects settle once and reject changed authorization`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'effect-execution-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const memory = new InMemoryEventRepository(effectExecutionEventCodec);
    const repository = () =>
      persistence === 'memory'
        ? memory
        : new JsonlEventRepository({ rootDir: directory, codec: effectExecutionEventCodec });
    let starts = 0;
    const admitted = effect({
      start: async () => {
        starts++;
        return { artifactId: 'exported:1' };
      }
    });
    assert.equal((await new EffectExecutor(repository()).execute(admitted)).status, 'settled');
    assert.equal((await new EffectExecutor(repository()).execute(admitted)).replayed, true);
    assert.equal(starts, 1);
    await assert.rejects(
      new EffectExecutor(repository()).execute({
        ...admitted,
        intent: { ...admitted.intent, parametersDigest: hashJson({ document: 'changed' }) }
      }),
      /different admitted contract/
    );
  });

  test(`${persistence}: an uncertain export reconciles without another dispatch`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'effect-reconcile-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const memory = new InMemoryEventRepository(effectExecutionEventCodec);
    const repository = () =>
      persistence === 'memory'
        ? memory
        : new JsonlEventRepository({ rootDir: directory, codec: effectExecutionEventCodec });
    let starts = 0;
    const admitted = effect({
      start: async () => {
        starts++;
        throw new Error('response lost after dispatch');
      }
    });
    assert.equal((await new EffectExecutor(repository()).execute(admitted)).status, 'unknown');
    const recovered = await new EffectExecutor(repository()).execute(admitted);
    assert.equal(recovered.status, 'settled');
    assert.equal(recovered.replayed, true);
    assert.equal(starts, 1);
  });
}

test('competing drivers cannot both start one effect and an aborted admission starts nothing', async () => {
  const events = new InMemoryEventRepository(effectExecutionEventCodec);
  let starts = 0;
  const admitted = effect({
    start: async () => {
      starts++;
      return { artifactId: 'exported:1' };
    }
  });
  await Promise.allSettled([
    new EffectExecutor(events).execute(admitted),
    new EffectExecutor(events).execute(admitted)
  ]);
  assert.equal(starts, 1);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    new EffectExecutor(events).execute(
      effect({ intent: { ...admitted.intent, effectId: 'export:cancelled' } }),
      controller.signal
    ),
    /cancelled/
  );
  assert.equal(await events.latest('export:cancelled'), undefined);
});

test('unknown non-idempotent effects remain uncertain and do not invoke a reconciler', async () => {
  const executor = new EffectExecutor(new InMemoryEventRepository(effectExecutionEventCodec));
  let starts = 0;
  const admitted = effect({
    intent: { ...effect().intent, recovery: { kind: 'unknown' } },
    start: async () => {
      starts++;
      throw new Error('connection lost');
    },
    reconcile: async () => {
      throw new Error('must not reconcile an unknown capability');
    }
  });
  assert.equal((await executor.execute(admitted)).status, 'unknown');
  assert.equal((await executor.execute(admitted)).status, 'unknown');
  assert.equal(starts, 1);
});

test('durable reconciliation has no invented expiry and expiring authority is enforced', async () => {
  for (const expiresAt of [null, '2000-01-01T00:00:00Z']) {
    const executor = new EffectExecutor(new InMemoryEventRepository(effectExecutionEventCodec));
    let queries = 0;
    const admitted = effect({
      intent: { ...effect().intent, recovery: { ...effect().intent.recovery, expiresAt } },
      start: async () => {
        throw new Error('response lost');
      },
      reconcile: async () => {
        queries++;
        return { status: 'settled', observation: { artifactId: 'durable-export' } };
      }
    });
    assert.equal((await executor.execute(admitted)).status, 'unknown');
    assert.equal((await executor.execute(admitted)).status, expiresAt === null ? 'settled' : 'expired');
    assert.equal(queries, expiresAt === null ? 1 : 0);
  }
});

test('a non-process export retains a resource lease until its uncertain effect is reconciled', async () => {
  const { ResourceLeaseCoordinator } = await import('@agent-core/tools');
  const leases = new ResourceLeaseCoordinator();
  const accesses = {
    accesses: [{ mode: 'write', scope: 'document:1' }],
    lockScopes: ['document:1'],
    recovery: { kind: 'unknown' }
  };
  const lease = await leases.acquire(accesses, 'work:1');
  lease.transferToResource('export:job:1', 'export:control:1');
  const executor = new EffectExecutor(new InMemoryEventRepository(effectExecutionEventCodec));
  let starts = 0;
  const exportEffect = effect({
    start: async () => {
      starts++;
      throw new Error('reply lost after dispatch');
    }
  });
  assert.equal((await executor.execute(exportEffect)).status, 'unknown');
  assert.equal(leases.activeCount(), 1);
  const cancelled = new AbortController();
  const competing = leases.acquire(accesses, 'work:2', cancelled.signal);
  cancelled.abort(new Error('cancel waiting export'));
  await assert.rejects(competing, /cancel waiting export/);
  assert.equal((await executor.execute(exportEffect)).status, 'settled');
  assert.equal(starts, 1);
  leases.releaseResource('export:job:1');
  const next = await leases.acquire(accesses, 'work:2');
  next.release();
  assert.equal(leases.activeCount(), 0);
});
