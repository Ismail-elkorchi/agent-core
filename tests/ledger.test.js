import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ArtifactIntegrityError,
  InMemoryEventRepository,
  JsonlEventRepository,
  LocalArtifactRepository,
  PersistenceCorruptionError,
  typedEventCodec
} from '@agent-core/evidence/node';

test('event repository initializes a missing nested root before acquiring its stream lock', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-events-missing-root-'));
  const rootDir = path.join(parent, 'missing', 'nested');
  const repository = new JsonlEventRepository({ rootDir, codec: typedEventCodec });
  await repository.append('created', { type: 'created' });
  assert.equal((await repository.verifyIntegrity('created')).ok, true);
});

test('concurrent event appends preserve sequence, hash chain, and ordering', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-concurrent-'));
  const repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await Promise.all(Array.from({ length: 40 }, (_, index) => repository.append('run-1', { type: 'sample', index })));
  const records = [];
  for await (const record of repository.read('run-1')) records.push(record);
  assert.deepEqual(records.map(record => record.sequence), Array.from({ length: 40 }, (_, index) => index));
  assert.equal(new Set(records.map(record => record.hash)).size, 40);
  assert.equal((await repository.verifyIntegrity('run-1')).ok, true);
});

test('event repositories scan once and incrementally ingest another writer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-index-'));
  const first = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  const second = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await first.append('indexed', { type: 'sample', writer: 1, index: 0 });
  const concurrent = Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? first : second).append('indexed', { type: 'sample', writer: index % 2, index: index + 1 }));
  await Promise.all(concurrent);
  const records = [];
  for await (const record of first.read('indexed')) records.push(record);
  assert.equal(records.length, 25);
  assert.deepEqual(records.map(record => record.sequence), Array.from({ length: 25 }, (_, index) => index));
  assert.equal((await first.verifyIntegrity('indexed')).ok, true);
  assert.equal(first.indexMetrics().fullScans, 1);
  assert.ok(first.indexMetrics().incrementalRefreshes > 0);
  assert.ok(second.indexMetrics().fullScans <= 1);
  assert.ok(first.indexMetrics().incrementalRefreshes + second.indexMetrics().incrementalRefreshes > 0);
});

test('event JSONL tolerates one torn tail but reports exact middle corruption', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-torn-'));
  const repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await repository.append('torn', { type: 'one' });
  const file = repository.location('torn');
  await writeFile(file, `${await readFile(file, 'utf8')}{"eventId":`, 'utf8');
  const records = [];
  for await (const record of repository.read('torn')) records.push(record);
  assert.equal(records.length, 1);
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.splice(1, 0, '{broken json');
  await writeFile(file, lines.join('\n'), 'utf8');
  await assert.rejects(async () => { for await (const _record of repository.read('torn')) { /* read */ } }, error => {
    assert.ok(error instanceof PersistenceCorruptionError);
    assert.equal(error.line, 2);
    assert.ok(error.byteOffset > 0);
    return true;
  });
});

test('event JSONL indexes only newline-committed records and repairs arbitrarily large torn tails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-committed-prefix-'));
  let repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await repository.append('valid-tail', { type: 'one' });
  const validFile = repository.location('valid-tail');
  await appendFile(validFile, '{"uncommitted":true}');

  repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await repository.append('valid-tail', { type: 'replacement' });
  const validRecords = [];
  for await (const record of new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec }).read('valid-tail')) validRecords.push(record);
  assert.deepEqual(validRecords.map(record => record.event.type), ['one', 'replacement']);
  assert.equal((await new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec }).verifyIntegrity('valid-tail')).ok, true);

  repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await repository.append('large-tail', { type: 'one' });
  await appendFile(repository.location('large-tail'), 'x'.repeat(70 * 1024));
  await new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec }).append('large-tail', { type: 'two' });
  const largeRecords = [];
  const fresh = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  for await (const record of fresh.read('large-tail')) largeRecords.push(record);
  assert.deepEqual(largeRecords.map(record => record.event.type), ['one', 'two']);
  assert.equal((await fresh.verifyIntegrity('large-tail')).ok, true);
});

for (const [name, create] of [
  ['memory', async () => new InMemoryEventRepository(typedEventCodec)],
  ['jsonl', async () => new JsonlEventRepository({ rootDir: await mkdtemp(path.join(tmpdir(), 'agent-events-conditional-')), codec: typedEventCodec })]
]) {
  test(`${name} event repository conditionally commits against tail and driver generation`, async () => {
    const repository = await create();
    const empty = await repository.tail('conditional');
    assert.deepEqual(empty, { sequence: -1, driverGeneration: 0 });

    const claimed = await repository.appendConditional('conditional', { type: 'operation.claimed' }, {
      idempotencyKey: 'claim:1',
      expectedTail: empty,
      driverGeneration: 1
    });
    assert.equal(claimed.kind, 'committed');
    assert.equal(claimed.tail.driverGeneration, 1);
    assert.equal((await repository.latest('conditional')).event.type, 'operation.claimed');

    const duplicate = await repository.appendConditional('conditional', { type: 'operation.claimed' }, {
      idempotencyKey: 'claim:1',
      expectedTail: empty,
      driverGeneration: 1
    });
    assert.equal(duplicate.kind, 'already_committed');
    assert.equal(duplicate.receipt.hash, claimed.receipt.hash);

    const conflict = await repository.appendConditional('conditional', { type: 'different' }, {
      idempotencyKey: 'claim:1',
      expectedTail: claimed.tail,
      driverGeneration: 1
    });
    assert.deepEqual({ kind: conflict.kind, reason: conflict.reason }, { kind: 'rejected', reason: 'idempotency_conflict' });

    const staleTail = await repository.appendConditional('conditional', { type: 'operation.transition' }, {
      idempotencyKey: 'transition:stale-tail',
      expectedTail: empty,
      driverGeneration: 1
    });
    assert.deepEqual({ kind: staleTail.kind, reason: staleTail.reason }, { kind: 'rejected', reason: 'stale_tail' });

    const staleDriver = await repository.appendConditional('conditional', { type: 'operation.transition' }, {
      idempotencyKey: 'transition:stale-driver',
      expectedTail: claimed.tail,
      driverGeneration: 0
    });
    assert.deepEqual({ kind: staleDriver.kind, reason: staleDriver.reason }, { kind: 'rejected', reason: 'stale_driver' });
  });
}

test('JSONL derived indexes rebuild without retaining the event history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-rebuild-index-'));
  let repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  for (let index = 0; index < 200; index += 1) {
    await repository.append('bounded', { type: 'sample', index }, { idempotencyKey: `sample:${String(index)}` });
  }
  const expectedTail = await repository.tail('bounded');
  await writeFile(path.join(dir, 'run-bounded.index', 'tail.json'), '{broken', 'utf8');
  repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  assert.deepEqual(await repository.tail('bounded'), expectedTail);
  assert.equal(repository.indexMetrics().fullScans, 1);
  assert.equal(repository.indexMetrics().retainedTailRecords, 1);
  const duplicate = await repository.appendConditional('bounded', { type: 'sample', index: 199 }, {
    idempotencyKey: 'sample:199',
    expectedTail,
    driverGeneration: expectedTail.driverGeneration
  });
  assert.equal(duplicate.kind, 'already_committed');
});

test('JSONL event state is private on POSIX hosts', { skip: process.platform === 'win32' }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-events-private-'));
  const rootDir = path.join(parent, 'state');
  const repository = new JsonlEventRepository({ rootDir, codec: typedEventCodec });
  await repository.append('private', { type: 'sample' }, { idempotencyKey: 'private:1' });
  const rootMode = stat(rootDir).then(value => value.mode & 0o777);
  const ledgerMode = stat(repository.location('private')).then(value => value.mode & 0o777);
  assert.equal(await rootMode, 0o700);
  assert.equal(await ledgerMode, 0o600);
});

test('separate processes cannot commit against the same event tail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-process-race-'));
  const expected = JSON.stringify({ sequence: -1, driverGeneration: 0 });
  const fixture = path.resolve('tests/fixtures/conditional-event-writer.mjs');
  const run = key => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, dir, 'race', key, expected], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const results = await Promise.all([run('writer:one'), run('writer:two')]);
  assert.deepEqual(results.map(result => result.kind).sort(), ['committed', 'rejected']);
  assert.equal(results.find(result => result.kind === 'rejected').reason, 'stale_tail');
  const repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  assert.equal((await repository.tail('race')).sequence, 0);
});

test('a live writer lock is not stolen after its stale interval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-live-lock-'));
  const repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec, lockTimeoutMs: 50, staleLockMs: 10 });
  const fixture = path.resolve('tests/fixtures/event-lock-holder.mjs');
  const filePath = repository.location('held');
  const child = spawn(process.execPath, [fixture, filePath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.setEncoding('utf8').once('data', chunk => chunk.includes('acquired') ? resolve() : reject(new Error(`Unexpected lock fixture output: ${chunk}`)));
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = await repository.appendConditional('held', { type: 'must-not-commit' }, {
      idempotencyKey: 'held:1',
      expectedTail: { sequence: -1, driverGeneration: 0 },
      driverGeneration: 1
    });
    assert.equal(result.kind, 'not_committed');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
  assert.deepEqual(await repository.tail('held'), { sequence: -1, driverGeneration: 0 });
});

test('artifact JSON media type, concurrent atomic writes, confinement, and SHA verification work', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-artifacts-'));
  const repository = new LocalArtifactRepository({ rootDir: dir });
  const refs = await Promise.all(Array.from({ length: 12 }, () => repository.storeJson('same', { value: 1n })));
  assert.equal(new Set(refs.map(ref => ref.artifactId)).size, 1);
  assert.equal(refs[0].mediaType, 'application/json; charset=utf-8');
  assert.match(new TextDecoder().decode(await repository.readVerified(refs[0])), /"1n"/);
  await assert.rejects(repository.readVerified({ ...refs[0], artifactId: '../escape' }), /Invalid artifact/);
  await writeFile(path.join(dir, refs[0].artifactId), 'tampered', 'utf8');
  await assert.rejects(repository.readVerified(refs[0]), ArtifactIntegrityError);
});

test('artifact JSON persistence bounds hostile values without invoking accessors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-artifacts-hostile-json-'));
  const repository = new LocalArtifactRepository({ rootDir: dir });
  let getterCalls = 0;
  const value = Object.create(null);
  Object.defineProperty(value, 'getter', { enumerable: true, get() { getterCalls += 1; throw new Error('must not run'); } });
  Object.defineProperty(value, '__proto__', { enumerable: true, value: { retained: true } });
  value.cycle = value;
  value.invalidDate = new Date(Number.NaN);
  value.big = 7n;

  const ref = await repository.storeJson('hostile', value);
  const persisted = JSON.parse(new TextDecoder().decode(await repository.readVerified(ref)));
  assert.equal(getterCalls, 0);
  assert.equal(ref.mediaType, 'application/json; charset=utf-8');
  assert.equal(Object.hasOwn(persisted, '__proto__'), true);
  assert.equal(persisted.__proto__.retained, true);
  assert.equal(persisted.getter, '[accessor omitted]');
  assert.equal(persisted.invalidDate, '[invalid date]');
  assert.match(persisted.cycle, /circular/u);
  assert.equal(persisted.big, '7n');
});
