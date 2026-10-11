import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  JsonlEventRepository,
  PersistenceConflictError,
  typedEventCodec,
  withPersistenceFileLock
} from '@agent-core/persistence/node';

test('same-process writers wait in order without spending the external lock timeout', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'persistence-lock-order-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const order = [];
  const first = withPersistenceFileLock(file, 1, 1, async (assertOwned) => {
    entered.resolve();
    await release.promise;
    await assertOwned();
    order.push('first');
  });
  await entered.promise;
  const second = withPersistenceFileLock(file, 1, 1, async (assertOwned) => {
    await assertOwned();
    order.push('second');
  });
  const third = withPersistenceFileLock(file, 1, 1, async () => order.push('third'));
  const settled = Promise.allSettled([first, second, third]);
  try {
    await withPersistenceFileLock(path.join(directory, 'other.jsonl'), 1, 1, async () => {
      assert.deepEqual(order, []);
    });
    await delay(30);
  } finally {
    release.resolve();
  }
  for (const result of await settled) assert.equal(result.status, 'fulfilled', result.reason?.message);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('failed operations release their lock and do not poison queued writers', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'persistence-lock-operation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl');
  const failure = new Error('Operation failed');
  const failed = withPersistenceFileLock(file, 1000, 1000, async () => { throw failure; });
  const next = withPersistenceFileLock(file, 1000, 1000, async (assertOwned) => {
    await assertOwned();
    return 'next writer';
  });
  const results = await Promise.allSettled([failed, next]);
  assert.deepEqual(results, [
    { status: 'rejected', reason: failure },
    { status: 'fulfilled', value: 'next writer' }
  ]);
});

test('a displaced writer reports lost ownership without removing the replacement lock', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'persistence-lock-replaced-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl');
  const ownerPath = path.join(`${file}.lock`, 'owner.json');
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
  await assert.rejects(withPersistenceFileLock(file, 1000, 1000, async () => {
    await fs.writeFile(ownerPath, replacement);
  }), PersistenceConflictError);
  assert.equal(await fs.readFile(ownerPath, 'utf8'), replacement);
});

for (const operationFails of [false, true]) {
  test(`lock release failures remain visible when the operation ${operationFails ? 'fails' : 'succeeds'}`, async (t) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'persistence-lock-release-'));
    const remove = fs.rm;
    t.after(() => remove(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'events.jsonl');
    const releaseFailure = new Error('Lock directory removal failed');
    const operationFailure = new Error('Operation failed');
    t.mock.method(fs, 'rm', async (target, options) => {
      if (target === `${file}.lock`) throw releaseFailure;
      return remove(target, options);
    });
    await assert.rejects(withPersistenceFileLock(file, 1000, 1000, async () => {
      if (operationFails) throw operationFailure;
      return 'committed';
    }), (error) => {
      if (operationFails) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [operationFailure, releaseFailure]);
      } else assert.equal(error, releaseFailure);
      return true;
    });
  });
}

test('release failure cannot label a committed conditional append as not committed', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'persistence-lock-commit-'));
  const remove = fs.rm;
  t.after(() => remove(directory, { recursive: true, force: true }));
  const repository = new JsonlEventRepository({ rootDir: directory, codec: typedEventCodec });
  const lockPath = `${repository.location('run')}.lock`;
  const failure = new Error('Release failed after commit');
  const removal = t.mock.method(fs, 'rm', async (target, options) => {
    if (target === lockPath) throw failure;
    return remove(target, options);
  });
  const event = { type: 'committed' };
  const options = {
    idempotencyKey: 'commit-once', expectedTail: { sequence: -1, driverGeneration: 0 },
    driverGeneration: 1
  };
  await assert.rejects(repository.appendConditional('run', event, options), error => error === failure);
  assert.equal((await repository.latest('run')).event.type, 'committed');
  removal.mock.restore();
  await remove(lockPath, { recursive: true, force: true });
  const retried = await repository.appendConditional('run', event, options);
  assert.equal(retried.kind, 'already_committed');
  assert.equal(retried.tail.sequence, 0);
});
