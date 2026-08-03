import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ArtifactIntegrityError,
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
  assert.equal(second.indexMetrics().fullScans, 1);
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
  await repository.append('valid-tail', { type: 'uncommitted' });
  const validFile = repository.location('valid-tail');
  const validBytes = await readFile(validFile);
  await writeFile(validFile, validBytes.subarray(0, validBytes.length - 1));

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
