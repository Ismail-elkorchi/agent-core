import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  JsonlEventRepository,
  PersistenceConflictError,
  typedEventCodec,
  tryAcquirePersistenceFileLock,
  withPersistenceFileLock
} from '@agent-core/persistence/node';

test('long-root ownership preserves exclusion, release and reacquisition beyond MAX_PATH', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lock-long-root-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, ...Array.from({ length: 4 }, (_, index) => `${index}-${'nested'.repeat(12)}`));
  const file = path.join(root, 'events.jsonl');
  assert.ok(`${file}.lock.pending-XXXXXX`.length > 300);
  const owner = await tryAcquirePersistenceFileLock(file);
  assert.ok(owner);
  await owner.assertOwned();
  assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
  await owner.release();
  assert.deepEqual(await fs.readdir(root), []);
  const replacement = await tryAcquirePersistenceFileLock(file);
  assert.ok(replacement);
  await replacement.assertOwned();
  await replacement.release();
  assert.deepEqual(await fs.readdir(root), []);
});

test('same-process writers wait in order without spending the external lock timeout', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'persistence-lock-order-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const order = [];
  const first = withPersistenceFileLock(file, 1, async (assertOwned) => {
    entered.resolve();
    await release.promise;
    await assertOwned();
    order.push('first');
  });
  await entered.promise;
  const second = withPersistenceFileLock(file, 1, async (assertOwned) => {
    await assertOwned();
    order.push('second');
  });
  const third = withPersistenceFileLock(file, 1, async () => order.push('third'));
  const settled = Promise.allSettled([first, second, third]);
  try {
    await withPersistenceFileLock(path.join(directory, 'other.jsonl'), 1, async () => {
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
  const failed = withPersistenceFileLock(file, 1000, async () => { throw failure; });
  const next = withPersistenceFileLock(file, 1000, async (assertOwned) => {
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
  let ownerPath;
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
  await assert.rejects(withPersistenceFileLock(file, 1000, async () => {
    ownerPath = await lockOwnerPath(file);
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
    const removeDirectory = fs.rmdir;
    t.mock.method(fs, 'rmdir', async (target, options) => {
      if (target === `${file}.lock`) throw releaseFailure;
      return removeDirectory(target, options);
    });
    await assert.rejects(withPersistenceFileLock(file, 1000, async () => {
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
  const removeDirectory = fs.rmdir;
  const removal = t.mock.method(fs, 'rmdir', async (target, options) => {
    if (target === lockPath) throw failure;
    return removeDirectory(target, options);
  });
  const event = { type: 'committed' };
  const options = {
    idempotencyKey: 'commit-once', expectedTail: { sequence: -1, driverGeneration: 0 },
    driverGeneration: 1
  };
  await assert.rejects(repository.appendConditional('run', event, options), error => error === failure);
  removal.mock.restore();
  assert.equal((await repository.latest('run')).event.type, 'committed');
  const retried = await repository.appendConditional('run', event, options);
  assert.equal(retried.kind, 'already_committed');
  assert.equal(retried.tail.sequence, 0);
});

async function lockOwnerPath(file) {
  const entries = await fs.readdir(`${file}.lock`);
  assert.equal(entries.length, 1);
  return path.join(`${file}.lock`, entries[0]);
}

async function lockFixture(t, label) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), `persistence-lock-${label}-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'events.jsonl') };
}

async function writeOwnerFixture(file, pid, token = randomUUID()) {
  await fs.mkdir(`${file}.lock`, { mode: 0o700 });
  const ownerPath = path.join(`${file}.lock`, `${token}.json`);
  await fs.writeFile(ownerPath, JSON.stringify({ pid, token }), { mode: 0o600 });
  return ownerPath;
}

function mockDeadPid(t, deadPid) {
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === deadPid) {
      assert.equal(signal, 0);
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    }
    return kill.call(process, pid, signal);
  });
}

test('nonblocking ownership has one same-process winner and leaves no unpublished candidates', async (t) => {
  const { directory, file } = await lockFixture(t, 'nonblocking');
  const candidates = await Promise.all(Array.from({ length: 12 }, () => tryAcquirePersistenceFileLock(file)));
  const owners = candidates.filter(owner => owner !== undefined);
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.ok(Object.isFrozen(owner));
  assert.deepEqual(Object.keys(owner).sort(), ['assertOwned', 'release']);
  await owner.assertOwned();
  assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
  assert.deepEqual(await fs.readdir(directory), ['events.jsonl.lock']);
  await owner.release();
  await assert.rejects(owner.assertOwned(), PersistenceConflictError);
  const next = await tryAcquirePersistenceFileLock(file);
  assert.ok(next);
  await owner.release();
  await next.assertOwned();
  await next.release();
  assert.deepEqual(await fs.readdir(directory), []);
});

test('nonblocking acquisition returns while an active transaction and its queued successor are held', async (t) => {
  const { file } = await lockFixture(t, 'queue-free');
  const entered = Promise.withResolvers();
  const unblock = Promise.withResolvers();
  t.after(() => unblock.resolve());
  const first = withPersistenceFileLock(file, 1000, async () => {
    entered.resolve();
    await unblock.promise;
  });
  await entered.promise;
  let successorEntered = false;
  const second = withPersistenceFileLock(file, 1000, async () => { successorEntered = true; });
  try {
    assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
    assert.equal(successorEntered, false);
  } finally {
    unblock.resolve();
  }
  await Promise.all([first, second]);
  assert.equal(successorEntered, true);
});

test('a displaced lifetime owner cannot assert or remove the replacement', async (t) => {
  const { file } = await lockFixture(t, 'lost-owner');
  const owner = await tryAcquirePersistenceFileLock(file);
  assert.ok(owner);
  await fs.rename(`${file}.lock`, `${file}.displaced`);
  const replacement = await tryAcquirePersistenceFileLock(file);
  assert.ok(replacement);
  await assert.rejects(owner.assertOwned(), PersistenceConflictError);
  await assert.rejects(owner.release(), PersistenceConflictError);
  await replacement.assertOwned();
  await replacement.release();
});

test('live PID ownership is never reclaimed based on directory age', async (t) => {
  const { file } = await lockFixture(t, 'live-age');
  const owner = await tryAcquirePersistenceFileLock(file);
  assert.ok(owner);
  await fs.utimes(`${file}.lock`, new Date(0), new Date(0));
  assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
  await owner.assertOwned();
  await owner.release();
});

test('a complete proven-dead owner is reclaimed immediately without an age threshold', async (t) => {
  const { file } = await lockFixture(t, 'dead-owner');
  const deadPid = 2_000_000_000;
  mockDeadPid(t, deadPid);
  await writeOwnerFixture(file, deadPid);
  const owner = await tryAcquirePersistenceFileLock(file);
  assert.ok(owner);
  await owner.assertOwned();
  await owner.release();
});

for (const value of [null, {}, { pid: -1 }, { pid: '123' }, { pid: process.pid }, 'invalid JSON']) {
  test(`an incomplete or malformed owner remains occupied: ${JSON.stringify(value)}`, async (t) => {
    const { file } = await lockFixture(t, 'unknown-owner');
    const token = randomUUID();
    await fs.mkdir(`${file}.lock`);
    const ownerPath = path.join(`${file}.lock`, `${token}.json`);
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    await fs.writeFile(ownerPath, content);
    await fs.utimes(`${file}.lock`, new Date(0), new Date(0));
    assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
    assert.equal(await fs.readFile(ownerPath, 'utf8'), content);
  });
}

test('unknown PID liveness remains occupied', async (t) => {
  const { file } = await lockFixture(t, 'unknown-pid');
  const pid = 2_000_000_000;
  const ownerPath = await writeOwnerFixture(file, pid);
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  });
  assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
  assert.equal(JSON.parse(await fs.readFile(ownerPath, 'utf8')).pid, pid);
});

test('a paused preparer has no canonical incomplete owner and cannot displace a published owner', async (t) => {
  const { directory, file } = await lockFixture(t, 'paused-prepare');
  const writeFile = fs.writeFile;
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let pauseNext = true;
  t.after(() => resume.resolve());
  t.mock.method(fs, 'writeFile', async (target, ...args) => {
    if (String(target).includes('.lock.pending-') && pauseNext) {
      pauseNext = false;
      paused.resolve();
      await resume.promise;
    }
    return writeFile(target, ...args);
  });
  const preparing = tryAcquirePersistenceFileLock(file);
  await paused.promise;
  const winner = await tryAcquirePersistenceFileLock(file);
  assert.ok(winner);
  resume.resolve();
  assert.equal(await preparing, undefined);
  await winner.assertOwned();
  await winner.release();
  assert.deepEqual(await fs.readdir(directory), []);
});

for (const pauseAt of ['unlink', 'rmdir']) {
  test(`a delayed stale reclaimer at ${pauseAt} cannot remove a replacement live owner`, async (t) => {
    const { file } = await lockFixture(t, `reclaim-${pauseAt}`);
    const deadPid = 2_000_000_000;
    mockDeadPid(t, deadPid);
    const oldOwnerPath = await writeOwnerFixture(file, deadPid);
    const original = fs[pauseAt];
    const paused = Promise.withResolvers();
    const resume = Promise.withResolvers();
    let pauseNext = true;
    t.after(() => resume.resolve());
    t.mock.method(fs, pauseAt, async (target, ...args) => {
      const expected = pauseAt === 'unlink' ? oldOwnerPath : `${file}.lock`;
      if (target === expected && pauseNext) {
        pauseNext = false;
        paused.resolve();
        await resume.promise;
      }
      return original(target, ...args);
    });
    const delayed = tryAcquirePersistenceFileLock(file);
    await paused.promise;
    const replacement = await tryAcquirePersistenceFileLock(file);
    assert.ok(replacement);
    resume.resolve();
    assert.equal(await delayed, undefined);
    await replacement.assertOwned();
    await replacement.release();
  });
}

test('concurrent release is idempotent when replacement acquires before directory cleanup', async (t) => {
  const { file } = await lockFixture(t, 'concurrent-release');
  const owner = await tryAcquirePersistenceFileLock(file);
  assert.ok(owner);
  const rmdir = fs.rmdir;
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let pauseNext = true;
  t.after(() => resume.resolve());
  t.mock.method(fs, 'rmdir', async (target, ...args) => {
    if (target === `${file}.lock` && pauseNext) {
      pauseNext = false;
      paused.resolve();
      await resume.promise;
    }
    return rmdir(target, ...args);
  });
  const firstRelease = owner.release();
  await paused.promise;
  assert.equal(owner.release(), firstRelease);
  await assert.rejects(owner.assertOwned(), PersistenceConflictError);
  const replacement = await tryAcquirePersistenceFileLock(file);
  assert.ok(replacement);
  resume.resolve();
  await firstRelease;
  await owner.release();
  await replacement.assertOwned();
  await replacement.release();
});

test('cancellation before acquisition and immediately after publication leaves no owner behind', async (t) => {
  const { directory, file } = await lockFixture(t, 'abort');
  const reason = new Error('Cancelled');
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(reason);
  await assert.rejects(tryAcquirePersistenceFileLock(file, { signal: alreadyAborted.signal }), error => error === reason);
  const controller = new AbortController();
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    await rename(source, target);
    if (target === `${file}.lock`) controller.abort(reason);
  });
  await assert.rejects(tryAcquirePersistenceFileLock(file, { signal: controller.signal }), error => error === reason);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a failed owner preparation is removed without leaving a canonical lock', async (t) => {
  const { directory, file } = await lockFixture(t, 'prepare-failure');
  const failure = new Error('Owner write failed');
  t.mock.method(fs, 'writeFile', async () => { throw failure; });
  await assert.rejects(tryAcquirePersistenceFileLock(file), error => error === failure);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('cancelling a queued transaction does not admit later work before the active owner releases', async (t) => {
  const { file } = await lockFixture(t, 'queued-abort');
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  t.after(() => resume.resolve());
  const first = withPersistenceFileLock(file, 1000, async () => {
    entered.resolve();
    await resume.promise;
  });
  await entered.promise;
  const controller = new AbortController();
  const reason = new Error('Cancelled waiter');
  const cancelled = withPersistenceFileLock(file, 1000, async () => assert.fail('Cancelled operation ran'), {
    signal: controller.signal
  });
  let nextEntered = false;
  const next = withPersistenceFileLock(file, 1000, async () => { nextEntered = true; });
  controller.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  assert.equal(nextEntered, false);
  assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
  resume.resolve();
  await Promise.all([first, next]);
  assert.equal(nextEntered, true);
});

for (const failAt of ['unlink', 'rmdir']) {
  test(`release can retry a failure at ${failAt} without touching a replacement`, async (t) => {
    const { file } = await lockFixture(t, `retry-${failAt}`);
    const owner = await tryAcquirePersistenceFileLock(file);
    assert.ok(owner);
    const original = fs[failAt];
    const failure = new Error('Transient release failure');
    const expected = failAt === 'unlink' ? await lockOwnerPath(file) : `${file}.lock`;
    let failNext = true;
    t.mock.method(fs, failAt, async (target, ...args) => {
      if (target === expected && failNext) {
        failNext = false;
        throw failure;
      }
      return original(target, ...args);
    });
    await assert.rejects(owner.release(), error => error === failure);
    if (failAt === 'unlink') {
      await owner.assertOwned();
      assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
      await owner.release();
    } else {
      await assert.rejects(owner.assertOwned(), PersistenceConflictError);
    }
    const replacement = await tryAcquirePersistenceFileLock(file);
    assert.ok(replacement);
    await owner.release();
    await replacement.assertOwned();
    await replacement.release();
  });
}

test('repeated busy acquisition checks perform no filesystem writes', async (t) => {
  const { directory, file } = await lockFixture(t, 'read-only-busy');
  const owner = await tryAcquirePersistenceFileLock(file);
  assert.ok(owner);
  const writes = ['mkdir', 'chmod', 'mkdtemp', 'writeFile', 'rename', 'unlink', 'rmdir', 'rm']
    .map(method => t.mock.method(fs, method));
  for (let attempt = 0; attempt < 10; attempt += 1)
    assert.equal(await tryAcquirePersistenceFileLock(file), undefined);
  assert.deepEqual(writes.map(mock => mock.mock.callCount()), Array(writes.length).fill(0));
  assert.deepEqual(await fs.readdir(directory), ['events.jsonl.lock']);
  for (const mock of writes) mock.mock.restore();
  await owner.release();
});
