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
} from '@agent-core/persistence/node';

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
  await Promise.all(
    Array.from({ length: 40 }, (_, index) => repository.append('run-1', { type: 'sample', index }))
  );
  const records = [];
  for await (const record of repository.read('run-1')) records.push(record);
  assert.deepEqual(
    records.map((record) => record.sequence),
    Array.from({ length: 40 }, (_, index) => index)
  );
  assert.equal(new Set(records.map((record) => record.hash)).size, 40);
  assert.equal((await repository.verifyIntegrity('run-1')).ok, true);
});

test('namespaced stream identities use portable filenames without changing ledger identity', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-events-portable-'));
  const repository = new JsonlEventRepository({ rootDir, codec: typedEventCodec });
  const ids = ['notes:session', 'notes-session', 'inference:owner:child'];
  for (const runId of ids) {
    const receipt = await repository.append(
      runId,
      { type: 'sample', runId },
      { idempotencyKey: 'write:1' }
    );
    assert.equal(receipt.runId, runId);
    assert.doesNotMatch(path.basename(repository.location(runId)), /[<>:"/\\|?*]/u);
  }
  const reopened = new JsonlEventRepository({ rootDir, codec: typedEventCodec });
  assert.deepEqual(await reopened.listRunIds(), ids.toSorted());
  for (const runId of ids) {
    const records = [];
    for await (const record of reopened.read(runId)) records.push(record);
    assert.equal(records.length, 1);
    assert.equal(records[0].runId, runId);
    const retry = await reopened.append(
      runId,
      { type: 'sample', runId },
      { idempotencyKey: 'write:1' }
    );
    assert.equal(retry.eventId, records[0].eventId);
    assert.equal((await reopened.verifyIntegrity(runId)).ok, true);
  }
});

test('event repositories scan once and incrementally ingest another writer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-index-'));
  const first = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  const second = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await first.append('indexed', { type: 'sample', writer: 1, index: 0 });
  const concurrent = Array.from({ length: 24 }, (_, index) =>
    (index % 2 === 0 ? first : second).append('indexed', {
      type: 'sample',
      writer: index % 2,
      index: index + 1
    })
  );
  await Promise.all(concurrent);
  const records = [];
  for await (const record of first.read('indexed')) records.push(record);
  assert.equal(records.length, 25);
  assert.deepEqual(
    records.map((record) => record.sequence),
    Array.from({ length: 25 }, (_, index) => index)
  );
  assert.equal((await first.verifyIntegrity('indexed')).ok, true);
  assert.equal(first.indexMetrics().fullScans, 1);
  assert.ok(first.indexMetrics().incrementalRefreshes > 0);
  assert.ok(second.indexMetrics().fullScans <= 1);
  assert.ok(
    first.indexMetrics().incrementalRefreshes + second.indexMetrics().incrementalRefreshes > 0
  );
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
  await assert.rejects(
    async () => {
      for await (const _record of repository.read('torn')) {
        /* read */
      }
    },
    (error) => {
      assert.ok(error instanceof PersistenceCorruptionError);
      assert.equal(error.line, 2);
      assert.ok(error.byteOffset > 0);
      return true;
    }
  );
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
  for await (const record of new JsonlEventRepository({
    rootDir: dir,
    codec: typedEventCodec
  }).read('valid-tail'))
    validRecords.push(record);
  assert.deepEqual(
    validRecords.map((record) => record.event.type),
    ['one', 'replacement']
  );
  assert.equal(
    (
      await new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec }).verifyIntegrity(
        'valid-tail'
      )
    ).ok,
    true
  );

  repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await repository.append('large-tail', { type: 'one' });
  await appendFile(repository.location('large-tail'), 'x'.repeat(70 * 1024));
  await new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec }).append('large-tail', {
    type: 'two'
  });
  const largeRecords = [];
  const fresh = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  for await (const record of fresh.read('large-tail')) largeRecords.push(record);
  assert.deepEqual(
    largeRecords.map((record) => record.event.type),
    ['one', 'two']
  );
  assert.equal((await fresh.verifyIntegrity('large-tail')).ok, true);
});

for (const [name, create] of [
  ['memory', async () => new InMemoryEventRepository(typedEventCodec)],
  [
    'jsonl',
    async () =>
      new JsonlEventRepository({
        rootDir: await mkdtemp(path.join(tmpdir(), 'agent-events-conditional-')),
        codec: typedEventCodec
      })
  ]
]) {
  test(`${name} event repository conditionally commits against tail and driver generation`, async () => {
    const repository = await create();
    const empty = await repository.tail('conditional');
    assert.deepEqual(empty, { sequence: -1, driverGeneration: 0 });

    const claimed = await repository.appendConditional(
      'conditional',
      { type: 'operation.claimed' },
      {
        idempotencyKey: 'claim:1',
        expectedTail: empty,
        driverGeneration: 1
      }
    );
    assert.equal(claimed.kind, 'committed');
    assert.equal(claimed.tail.driverGeneration, 1);
    assert.equal((await repository.latest('conditional')).event.type, 'operation.claimed');
    assert.equal(
      (await repository.latestOfType('conditional', 'operation.claimed')).event.type,
      'operation.claimed'
    );
    assert.equal(await repository.latestOfType('conditional', 'missing'), undefined);

    const duplicate = await repository.appendConditional(
      'conditional',
      { type: 'operation.claimed' },
      {
        idempotencyKey: 'claim:1',
        expectedTail: empty,
        driverGeneration: 1
      }
    );
    assert.equal(duplicate.kind, 'already_committed');
    assert.equal(duplicate.receipt.hash, claimed.receipt.hash);

    const conflict = await repository.appendConditional(
      'conditional',
      { type: 'different' },
      {
        idempotencyKey: 'claim:1',
        expectedTail: claimed.tail,
        driverGeneration: 1
      }
    );
    assert.deepEqual(
      { kind: conflict.kind, reason: conflict.reason },
      { kind: 'rejected', reason: 'idempotency_conflict' }
    );

    const staleTail = await repository.appendConditional(
      'conditional',
      { type: 'run.state.transitioned' },
      {
        idempotencyKey: 'transition:stale-tail',
        expectedTail: empty,
        driverGeneration: 1
      }
    );
    assert.deepEqual(
      { kind: staleTail.kind, reason: staleTail.reason },
      { kind: 'rejected', reason: 'stale_tail' }
    );

    const staleDriver = await repository.appendConditional(
      'conditional',
      { type: 'run.state.transitioned' },
      {
        idempotencyKey: 'transition:stale-driver',
        expectedTail: claimed.tail,
        driverGeneration: 0
      }
    );
    assert.deepEqual(
      { kind: staleDriver.kind, reason: staleDriver.reason },
      { kind: 'rejected', reason: 'stale_driver' }
    );

    const transitioned = await repository.appendConditional(
      'conditional',
      { type: 'run.state.transitioned', revision: 1 },
      {
        idempotencyKey: 'transition:1',
        expectedTail: claimed.tail,
        driverGeneration: 1
      }
    );
    assert.equal(transitioned.kind, 'committed');
    assert.equal(
      (await repository.latestOfType('conditional', 'operation.claimed')).sequence,
      claimed.receipt.sequence
    );
    assert.equal(
      (await repository.latestOfType('conditional', 'run.state.transitioned')).event.revision,
      1
    );
  });
}

test('JSONL latest event-type index survives reopening without a history scan', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-type-index-'));
  let repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  await repository.append('typed', { type: 'run.state.transitioned', revision: 1 });
  await repository.append('typed', { type: 'audit.sample', value: 1 });
  await repository.append('typed', { type: 'run.state.transitioned', revision: 2 });
  await repository.append('typed', { type: 'audit.sample', value: 2 });

  repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  const transition = await repository.latestOfType('typed', 'run.state.transitioned');
  assert.equal(transition.event.revision, 2);
  assert.equal(repository.indexMetrics().fullScans, 0);
});

test('JSONL derived indexes rebuild without retaining the event history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-rebuild-index-'));
  let repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  for (let index = 0; index < 200; index += 1) {
    await repository.append(
      'bounded',
      { type: 'sample', index },
      { idempotencyKey: `sample:${String(index)}` }
    );
  }
  const expectedTail = await repository.tail('bounded');
  await writeFile(path.join(dir, 'run-bounded.index', 'tail.json'), '{broken', 'utf8');
  repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  assert.deepEqual(await repository.tail('bounded'), expectedTail);
  assert.equal(repository.indexMetrics().fullScans, 1);
  assert.equal(repository.indexMetrics().retainedTailRecords, 1);
  const duplicate = await repository.appendConditional(
    'bounded',
    { type: 'sample', index: 199 },
    {
      idempotencyKey: 'sample:199',
      expectedTail,
      driverGeneration: expectedTail.driverGeneration
    }
  );
  assert.equal(duplicate.kind, 'already_committed');
});

test(
  'JSONL event state is private on POSIX hosts',
  { skip: process.platform === 'win32' },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'agent-events-private-'));
    const rootDir = path.join(parent, 'state');
    const repository = new JsonlEventRepository({ rootDir, codec: typedEventCodec });
    await repository.append('private', { type: 'sample' }, { idempotencyKey: 'private:1' });
    const rootMode = stat(rootDir).then((value) => value.mode & 0o777);
    const ledgerMode = stat(repository.location('private')).then((value) => value.mode & 0o777);
    assert.equal(await rootMode, 0o700);
    assert.equal(await ledgerMode, 0o600);
  }
);

test('separate processes cannot commit against the same event tail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-process-race-'));
  const expected = JSON.stringify({ sequence: -1, driverGeneration: 0 });
  const fixture = path.resolve('tests/fixtures/conditional-event-writer.mjs');
  const run = (key) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fixture, dir, 'race', key, expected], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))
      );
    });
  const results = await Promise.all([run('writer:one'), run('writer:two')]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ['committed', 'rejected']);
  assert.equal(results.find((result) => result.kind === 'rejected').reason, 'stale_tail');
  const repository = new JsonlEventRepository({ rootDir: dir, codec: typedEventCodec });
  assert.equal((await repository.tail('race')).sequence, 0);
});

test('a live writer lock is not stolen after its stale interval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-events-live-lock-'));
  const repository = new JsonlEventRepository({
    rootDir: dir,
    codec: typedEventCodec,
    lockTimeoutMs: 50,
    staleLockMs: 10
  });
  const fixture = path.resolve('tests/fixtures/event-lock-holder.mjs');
  const filePath = repository.location('held');
  const child = spawn(process.execPath, [fixture, filePath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout
      .setEncoding('utf8')
      .once('data', (chunk) =>
        chunk.includes('acquired')
          ? resolve()
          : reject(new Error(`Unexpected lock fixture output: ${chunk}`))
      );
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await repository.appendConditional(
      'held',
      { type: 'must-not-commit' },
      {
        idempotencyKey: 'held:1',
        expectedTail: { sequence: -1, driverGeneration: 0 },
        driverGeneration: 1
      }
    );
    assert.equal(result.kind, 'not_committed');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
  assert.deepEqual(await repository.tail('held'), { sequence: -1, driverGeneration: 0 });
});

test('artifact JSON media type, concurrent atomic writes, confinement, and SHA verification work', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-artifacts-'));
  const repository = new LocalArtifactRepository({ rootDir: dir });
  const refs = await Promise.all(
    Array.from({ length: 12 }, () => repository.storeJson('same', { value: '1n' }))
  );
  assert.equal(new Set(refs.map((ref) => ref.artifactId)).size, 1);
  assert.equal(refs[0].mediaType, 'application/json; charset=utf-8');
  assert.match(new TextDecoder().decode(await repository.readVerified(refs[0])), /"1n"/);
  await assert.rejects(
    repository.readVerified({ ...refs[0], artifactId: '../escape' }),
    /Invalid artifact/
  );
  await writeFile(path.join(dir, refs[0].artifactId), 'tampered', 'utf8');
  await assert.rejects(repository.readVerified(refs[0]), ArtifactIntegrityError);
});

test('artifact JSON rejects unsupported data and preserves complete valid values', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-artifacts-exact-json-'));
  const repository = new LocalArtifactRepository({ rootDir: dir });
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'getter', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'hidden';
    }
  });
  const cycle = {};
  cycle.self = cycle;
  for (const value of [accessor, cycle, new Date(), { bigint: 7n }, { missing: undefined }]) {
    assert.throws(() => repository.storeJson('invalid', value), TypeError);
  }
  assert.equal(getterCalls, 0);
  const value = JSON.parse('{"__proto__":{"retained":true}}');
  value.text = 'x'.repeat(100_000) + 'complete';
  const ref = await repository.storeJson('exact', value);
  const persisted = JSON.parse(new TextDecoder().decode(await repository.readVerified(ref)));
  assert.deepEqual(persisted, value);
  const different = await repository.storeJson('exact', { ...value, text: value.text + '!' });
  assert.notEqual(different.sha256, ref.sha256);
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: exact event references and sequence pages bound decoding before filtering`, async (t) => {
    const { InMemoryEventRepository, typedEventCodec } = await import('@agent-core/persistence');
    const { JsonlEventRepository } = await import('@agent-core/persistence/node');
    const directory = await mkdtemp(path.join(tmpdir(), 'event-ranges-'));
    t.after(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(directory, { recursive: true, force: true });
    });
    let decoded = 0;
    const codec = {
      encode: typedEventCodec.encode,
      decode(value) {
        decoded++;
        return typedEventCodec.decode(value);
      }
    };
    const events =
      kind === 'memory'
        ? new InMemoryEventRepository(codec)
        : new JsonlEventRepository({ rootDir: directory, codec });
    const receipts = [];
    for (let at = 0; at < 30; at++)
      receipts.push(
        await events.append(
          'range',
          { type: at === 24 ? 'wanted' : 'other', text: 'x'.repeat(2000) },
          { idempotencyKey: `item:${at}` }
        )
      );
    const cut = await events.tail('range');
    const before = decoded;
    const filtered = await events.readRange('range', {
      afterSequence: 19,
      through: cut,
      limit: 7,
      maxBytes: 4096,
      types: ['wanted']
    });
    assert.equal(filtered.scanned, 7);
    assert.equal(filtered.nextSequence, 26);
    assert.deepEqual(
      filtered.records.map((record) => record.sequence),
      [24]
    );
    assert.equal(decoded - before, 1, 'unrelated indexed event types are not decoded');
    assert.ok(filtered.bytes <= 4096);
    const reference = await events.referenceByKey('range', 'item:24');
    assert.equal((await events.readReference(reference)).event.text.length, 2000);
    await assert.rejects(events.readReference({ ...reference, hash: '0'.repeat(64) }), /identity/);
    const oversizedBefore = decoded;
    const oversized = await events.readRange('range', {
      afterSequence: 20,
      through: cut,
      maxBytes: 32
    });
    assert.equal(oversized.records.length, 0);
    assert.equal(oversized.scanned, 0);
    assert.equal(oversized.oversized.reference.sequence, 21);
    assert.equal(decoded, oversizedBefore);
    await events.append('range', { type: 'wanted', text: 'later' });
    const tailPage = await events.readRange('range', {
      afterSequence: filtered.nextSequence,
      through: cut
    });
    assert.deepEqual(
      tailPage.records.map((record) => record.sequence),
      [27, 28, 29]
    );
    assert.equal(tailPage.complete, true);
    await assert.rejects(
      events.readRange('range', { through: { ...cut, hash: '0'.repeat(64) } }),
      /boundary/
    );
    await assert.rejects(events.readRange('range', { afterSequence: -2 }), /bounds/);
    if (kind === 'jsonl') {
      const reopened = new JsonlEventRepository({ rootDir: directory, codec });
      const beforeReopen = decoded;
      assert.equal((await reopened.readReference(reference)).sequence, 24);
      assert.equal(decoded - beforeReopen, 1);
      assert.equal(reopened.indexMetrics().fullScans, 0);
      const { rm } = await import('node:fs/promises');
      await rm(path.join(directory, 'run-range.index', 'sequences', '24.json'));
      assert.equal((await reopened.readReference(reference)).sequence, 24);
      assert.equal(
        reopened.indexMetrics().fullScans,
        1,
        'missing derived offsets rebuild from the unchanged ledger'
      );
    }
  });
}

test('JSONL range refresh decodes only appended bodies; explicit rebuild can be cancelled without rewriting originals', async (t) => {
  const { typedEventCodec } = await import('@agent-core/persistence');
  const { JsonlEventRepository } = await import('@agent-core/persistence/node');
  const { readFile, rm } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(tmpdir(), 'event-refresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = new JsonlEventRepository({ rootDir: directory, codec: typedEventCodec });
  for (let at = 0; at < 12; at++)
    await writer.append('warm', { type: 'record', text: 'x'.repeat(4096) });
  let decoded = 0;
  const reader = new JsonlEventRepository({
    rootDir: directory,
    codec: {
      encode: typedEventCodec.encode,
      decode(value) {
        decoded++;
        return typedEventCodec.decode(value);
      }
    }
  });
  const cut = await reader.tail('warm');
  const before = reader.indexMetrics();
  const appended = await writer.append('warm', { type: 'record', text: 'new' });
  const page = await reader.readRange('warm', {
    afterSequence: cut.sequence,
    limit: 1,
    maxBytes: 4096
  });
  assert.equal(decoded, 1);
  assert.equal(page.records[0].eventId, appended.eventId);
  assert.equal(reader.indexMetrics().bodyRecordsRead - before.bodyRecordsRead, 1);
  assert.equal(reader.indexMetrics().bodyBytesRead - before.bodyBytesRead, page.bytes);
  assert.equal(reader.indexMetrics().indexedBytes - before.indexedBytes, page.bytes);
  const original = await readFile(reader.location('warm'));
  const controller = new AbortController();
  const progress = [];
  await assert.rejects(
    reader.rebuild('warm', {
      signal: controller.signal,
      onProgress(item) {
        progress.push(item);
        if (item.records >= 4) controller.abort();
      }
    }),
    /abort/i
  );
  assert(progress.length > 1);
  assert.deepEqual(await readFile(reader.location('warm')), original);
  const rebuilt = new JsonlEventRepository({ rootDir: directory, codec: typedEventCodec });
  assert.equal((await rebuilt.readReference(appended)).event.text, 'new');
  assert.equal((await rebuilt.verifyIntegrity('warm')).ok, true);
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: metadata inventory bounds descriptors independently of source payloads`, async (t) => {
    const { rm } = await import('node:fs/promises');
    const directory = await mkdtemp(path.join(tmpdir(), 'event-metadata-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let decoded = 0;
    const codec = {
      encode: typedEventCodec.encode,
      decode(value) { decoded++; return typedEventCodec.decode(value); },
      metadata(value) { return { group: value.group }; }
    };
    const writer = kind === 'memory'
      ? new InMemoryEventRepository(codec)
      : new JsonlEventRepository({ rootDir: directory, codec });
    for (let at = 0; at < 5; at++)
      await writer.append('metadata', { type: at === 1 ? 'other' : 'wanted', group: at === 2 ? 'excluded' : 'selected', body: 'x'.repeat(100_000) },
        { timestamp: `2026-01-01T00:00:0${at}.000Z` });
    const cut = await writer.tail('metadata');
    const reader = kind === 'memory' ? writer : new JsonlEventRepository({ rootDir: directory, codec });
    const before = decoded;
    const page = await reader.readMetadataRange('metadata', {
      through: cut, limit: 4, maxBytes: 4096, types: ['wanted'], metadata: { group: 'selected' },
      afterTime: '2026-01-01T00:00:01.000Z', beforeTime: '2026-01-01T00:00:04.000Z'
    });
    assert.equal(decoded, before, 'cold metadata inventory never decodes event bodies');
    assert.equal(page.scanned, 4);
    assert.equal(page.nextSequence, 3);
    assert.equal(page.complete, false);
    assert.deepEqual(page.records.map(record => record.reference.sequence), [3]);
    assert.equal(page.records[0].metadata.group, 'selected');
    assert.equal(page.records[0].type, 'wanted');
    assert.ok(page.records[0].bytes > 100_000);
    assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page.records[0])));
    assert.ok(Object.isFrozen(page.records[0].metadata));
    assert.ok(Object.isFrozen(page.records[0].reference));
    const oversized = await reader.readMetadataRange('metadata', { maxBytes: 1 });
    assert.equal(oversized.scanned, 0);
    assert.equal(oversized.oversized.reference.sequence, 0);
    assert.ok(oversized.oversized.bytes < 4096);
    await writer.append('metadata', { type: 'wanted', group: 'selected', body: 'later' });
    const remainder = await reader.readMetadataRange('metadata', { afterSequence: page.nextSequence, through: cut });
    assert.deepEqual(remainder.records.map(record => record.reference.sequence), [4]);
    assert.equal(remainder.complete, true);
    const refreshed = await reader.readMetadataRange('metadata', { afterSequence: cut.sequence });
    assert.deepEqual(refreshed.records.map(record => record.reference.sequence), [5]);
    await assert.rejects(reader.readMetadataRange('metadata', { through: { ...cut, hash: 'changed' } }), /boundary/);
    await assert.rejects(reader.readMetadataRange('metadata', { limit: 0 }), /bounds/);
    if (kind === 'jsonl') {
      assert.equal(reader.indexMetrics().bodyRecordsRead, 0);
      assert.equal(reader.indexMetrics().fullScans, 0);
      assert.equal(reader.indexMetrics().indexedBytes, 0);
    }
  });
}

test('JSONL metadata index failures require explicit recovery without hydrating original bodies', async (t) => {
  const { PersistenceIndexRecoveryRequiredError } = await import('@agent-core/persistence');
  const { rm } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(tmpdir(), 'event-metadata-repair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let decoded = 0;
  const codec = { ...typedEventCodec, decode(value) { decoded++; return typedEventCodec.decode(value); } };
  const writer = new JsonlEventRepository({ rootDir: directory, codec });
  await writer.append('metadata', { type: 'wanted', body: 'original' });
  const original = await readFile(writer.location('metadata'));
  const pointerPath = path.join(directory, 'run-metadata.index', 'sequences', '0.json');
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  await writeFile(pointerPath, JSON.stringify({ ...pointer, metadata: { protected: 'false' } }));
  const reader = new JsonlEventRepository({ rootDir: directory, codec });
  const before = decoded;
  await assert.rejects(reader.readMetadataRange('metadata'), PersistenceIndexRecoveryRequiredError);
  assert.equal(decoded, before);
  assert.equal(reader.indexMetrics().fullScans, 0);
  assert.equal(reader.indexMetrics().bodyRecordsRead, 0);
  await reader.rebuild('metadata');
  assert.equal((await reader.readMetadataRange('metadata')).records.length, 1);
  assert.deepEqual(await readFile(writer.location('metadata')), original);
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: exchange metadata seeks directly across bounded membership pages`, async (t) => {
    const { promises: fs } = await import('node:fs');
    const directory = await mkdtemp(path.join(tmpdir(), 'event-exchange-index-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const codec = { ...typedEventCodec, metadataIndexes: [{ field: 'exchangeId' }], metadata: event => ({ exchangeId: event.exchangeId }) };
    const writer = kind === 'memory' ? new InMemoryEventRepository(codec)
      : new JsonlEventRepository({ rootDir: directory, codec });
    for (let at = 0; at < 520; at++)
      await writer.append('exchanges', { type: 'item', exchangeId: at % 2 ? 'selected' : 'other', body: 'x'.repeat(1000) }, { idempotencyKey: `event:${at}` });
    const reader = kind === 'memory' ? writer : new JsonlEventRepository({ rootDir: directory, codec });
    let ledgerBytes = 0;
    let sequenceReads = 0;
    if (kind === 'jsonl') {
      const open = fs.open.bind(fs), readFile = fs.readFile.bind(fs);
      t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await open(file, ...args);
        if (file === reader.location('exchanges')) {
          const read = handle.read.bind(handle);
          handle.read = async (...input) => {
            const result = await read(...input);
            ledgerBytes += result.bytesRead;
            return result;
          };
        }
        return handle;
      });
      t.mock.method(fs, 'readFile', async (file, ...args) => {
        if (String(file).includes('/sequences/')) sequenceReads++;
        return readFile(file, ...args);
      });
    }
    const head = await reader.tail('exchanges', { metadataOnly: true });
    assert.equal((await reader.latestReferenceOfType('exchanges', 'item', { metadataOnly: true })).sequence, 519);
    assert.equal((await reader.referenceByKey('exchanges', 'event:519', { metadataOnly: true })).sequence, 519);
    const page = await reader.readMetadataRange('exchanges', {
      through: head, afterSequence: 507, limit: 4, metadata: { exchangeId: 'selected' }
    });
    assert.deepEqual(page.records.map(record => record.reference.sequence), [509, 511, 513, 515]);
    assert.equal(page.scanned, 4);
    assert.equal(page.complete, false);
    const last = await reader.readMetadataRange('exchanges', {
      through: head, afterSequence: page.nextSequence, limit: 4, metadata: { exchangeId: 'selected' }
    });
    assert.deepEqual(last.records.map(record => record.reference.sequence), [517, 519]);
    assert.equal(last.complete, true);
    if (kind === 'jsonl') {
      assert.ok(ledgerBytes <= 256, `cold metadata boundary reads only its fixed probe, read ${ledgerBytes} bytes`);
      assert.ok(sequenceReads <= 8, 'unrelated sequence pointers are never read');
      assert.equal(reader.indexMetrics().bodyRecordsRead, 0);
      assert.equal(reader.indexMetrics().indexedBytes, 0);
    }
  });
}

test('metadata boundaries refuse missing indexes and arbitrarily large torn tails without ledger scans', async (t) => {
  const { PersistenceIndexRecoveryRequiredError } = await import('@agent-core/persistence');
  const { promises: fs } = await import('node:fs');
  const directory = await mkdtemp(path.join(tmpdir(), 'event-metadata-boundary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writer = new JsonlEventRepository({ rootDir: directory, codec: typedEventCodec });
  await writer.append('boundary', { type: 'item', body: 'x'.repeat(100_000) });
  await appendFile(writer.location('boundary'), 'x'.repeat(500_000));
  const open = fs.open.bind(fs);
  let bytes = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === writer.location('boundary')) {
      const read = handle.read.bind(handle);
      handle.read = async (...input) => { const result = await read(...input); bytes += result.bytesRead; return result; };
    }
    return handle;
  });
  const reader = new JsonlEventRepository({ rootDir: directory, codec: typedEventCodec });
  await assert.rejects(reader.tail('boundary', { metadataOnly: true }), PersistenceIndexRecoveryRequiredError);
  assert.ok(bytes <= 256, `torn tail must not trigger a backwards scan, read ${bytes}`);
  await fs.rm(path.join(directory, 'run-boundary.index'), { recursive: true, force: true });
  bytes = 0;
  await assert.rejects(reader.latestReferenceOfType('boundary', 'item', { metadataOnly: true }), PersistenceIndexRecoveryRequiredError);
  assert.equal(bytes, 0, 'missing derived index does not trigger original history scan');
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: sparse recovery snapshots do not spend scan allowance on unrelated history`, async (t) => {
    const { promises: fs } = await import('node:fs');
    const directory = await mkdtemp(path.join(tmpdir(), 'event-recovery-routing-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const codec = { ...typedEventCodec, metadataIndexes: [{ type: 'turn.snapshot.created', metadata: { contextRecovery: 'true' } }], metadata: event => event.recovery ? { contextRecovery: 'true' } : {} };
    const writer = kind === 'memory' ? new InMemoryEventRepository(codec)
      : new JsonlEventRepository({ rootDir: directory, codec });
    for (let at = 0; at < 60; at++)
      await writer.append('recovery', { type: at % 2 ? 'ordinary' : 'assistant.ended', recovery: at % 2 === 0, body: 'x'.repeat(1000) });
    const reader = kind === 'memory' ? writer : new JsonlEventRepository({ rootDir: directory, codec });
    const query = { types: ['turn.snapshot.created'], metadata: { contextRecovery: 'true' }, limit: 5 };
    const fresh = await reader.readMetadataRange('recovery', query);
    assert.equal(fresh.complete, true);
    assert.equal(fresh.scanned, 0);
    assert.deepEqual(fresh.records, []);
    const first = await writer.append('recovery', { type: 'turn.snapshot.created', recovery: true });
    await writer.append('recovery', { type: 'turn.snapshot.created', recovery: false });
    const second = await writer.append('recovery', { type: 'turn.snapshot.created', recovery: true });
    const page = await reader.readMetadataRange('recovery', query);
    assert.equal(page.complete, true);
    assert.equal(page.scanned, 2);
    assert.deepEqual(page.records.map(record => record.reference.sequence), [first.sequence, second.sequence]);
    if (kind === 'jsonl') {
      assert.equal(reader.indexMetrics().bodyRecordsRead, 0);
      assert.equal(reader.indexMetrics().indexedBytes, 0);
      const cold = new JsonlEventRepository({ rootDir: directory, codec });
      assert.deepEqual((await cold.readMetadataRange('recovery', query)).records, page.records);
    }
  });
}

test('failed routing publication cannot expose incomplete exchange membership through a warm index', async (t) => {
  const { PersistenceIndexRecoveryRequiredError } = await import('@agent-core/persistence');
  const { promises: fs } = await import('node:fs');
  const directory = await mkdtemp(path.join(tmpdir(), 'event-routing-publication-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const codec = { ...typedEventCodec, metadataIndexes: [{ field: 'exchangeId' }], metadata: event => ({ exchangeId: event.exchangeId }) };
  const writer = new JsonlEventRepository({ rootDir: directory, codec });
  await writer.append('publication', { type: 'item', exchangeId: 'exchange' });
  const rename = fs.rename.bind(fs);
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to).split(path.sep).includes('routing') && path.basename(String(to)) === 'head.json') throw new Error('injected routing publication failure');
    return rename(from, to);
  });
  await assert.rejects(writer.append('publication', { type: 'item', exchangeId: 'exchange' }), /injected/);
  mocked.mock.restore();
  await assert.rejects(writer.readMetadataRange('publication', { metadata: { exchangeId: 'exchange' } }), PersistenceIndexRecoveryRequiredError);
  const cold = new JsonlEventRepository({ rootDir: directory, codec });
  await assert.rejects(cold.readMetadataRange('publication', { metadata: { exchangeId: 'exchange' } }), PersistenceIndexRecoveryRequiredError);
  await writer.rebuild('publication');
  const recovered = await writer.readMetadataRange('publication', { metadata: { exchangeId: 'exchange' } });
  assert.equal(recovered.complete, true);
  assert.equal(recovered.records.length, 2);
});

test('codec-owned metadata index declarations are immutable and persisted index compatibility is explicit', async (t) => {
  const { PersistenceIndexRecoveryRequiredError } = await import('@agent-core/persistence');
  const { promises: fs } = await import('node:fs');
  const directory = await mkdtemp(path.join(tmpdir(), 'event-declared-index-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const declaration = { type: 'checkpoint', metadata: { status: 'pending' } };
  const codec = { ...typedEventCodec, metadataIndexes: [declaration], metadata: event => ({ status: event.status }) };
  const repository = new JsonlEventRepository({ rootDir: directory, codec });
  declaration.metadata.status = 'done';
  for (let at = 0; at < 10; at++) await repository.append('declared', { type: 'ordinary', status: 'pending' });
  await repository.append('declared', { type: 'checkpoint', status: 'pending' });
  const page = await repository.readMetadataRange('declared', { types: ['checkpoint'], metadata: { status: 'pending' }, limit: 2 });
  assert.equal(page.complete, true);
  assert.equal(page.scanned, 1);
  assert.equal(page.records[0].reference.sequence, 10);
  const changed = new JsonlEventRepository({ rootDir: directory, codec });
  await assert.rejects(changed.readMetadataRange('declared'), PersistenceIndexRecoveryRequiredError);
  await changed.rebuild('declared');
  const empty = await changed.readMetadataRange('declared', { types: ['checkpoint'], metadata: { status: 'done' }, limit: 2 });
  assert.equal(empty.complete, true);
  assert.equal(empty.scanned, 0);
  assert.throws(() => new InMemoryEventRepository({ ...typedEventCodec, metadataIndexes: [{ field: 'group' }, { field: 'group' }] }), /Duplicate/);
});

test('warm original reads idempotently ingest routing memberships published by another writer', async (t) => {
  const { promises: fs } = await import('node:fs');
  const directory = await mkdtemp(path.join(tmpdir(), 'event-routing-two-writers-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const codec = { ...typedEventCodec, metadataIndexes: [{ field: 'group' }], metadata: event => ({ group: event.group }) };
  const writer = new JsonlEventRepository({ rootDir: directory, codec });
  await writer.append('shared', { type: 'item', group: 'same' });
  const reader = new JsonlEventRepository({ rootDir: directory, codec });
  await reader.tail('shared');
  for (let at = 1; at < 257; at++) await writer.append('shared', { type: 'item', group: 'same' });
  assert.equal((await reader.tail('shared')).sequence, 256);
  const indexed = await reader.readMetadataRange('shared', { metadata: { group: 'same' } });
  assert.equal(indexed.records.length, 256);
  const last = await reader.readMetadataRange('shared', { afterSequence: indexed.nextSequence, metadata: { group: 'same' } });
  assert.equal(last.records.length, 1);
  assert.equal(last.records[0].reference.sequence, 256);
  assert.equal((await reader.verifyIntegrity('shared')).ok, true);
});

for (const count of [1, 80]) {
  test(`dynamic JSONL routing proves unseen values empty with ${count} known routes`, async t => {
    const { promises: fs } = await import('node:fs');
    const { PersistenceIndexRecoveryRequiredError } = await import('@agent-core/persistence');
    const directory = await mkdtemp(path.join(tmpdir(), 'event-route-absence-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const codec = { ...typedEventCodec, metadataIndexes: [{ field: 'boundary' }], metadata: event => ({ boundary: event.boundary }) };
    const writer = new JsonlEventRepository({ rootDir: directory, codec });
    for (let at = 0; at < count; at++) await writer.append('routed', { type: 'item', boundary: `known-${at}` });
    const reader = new JsonlEventRepository({ rootDir: directory, codec });
    const empty = await reader.readMetadataRange('routed', { metadata: { boundary: 'never-recorded' } });
    assert.deepEqual(empty.records, []);
    assert.equal(empty.complete, true);
    assert.equal(empty.scanned, 0);
    assert.equal(reader.indexMetrics().bodyRecordsRead, 0);
    assert.equal(reader.indexMetrics().indexedBytes, 0);
    const routeKey = JSON.stringify({ index: { field: 'boundary' }, value: 'known-0' });
    const { createHash } = await import('node:crypto');
    const routeDirectory = path.join(directory, 'run-routed.index', 'routing', createHash('sha256').update(routeKey).digest('hex'));
    await fs.rm(path.join(routeDirectory, 'head.json'));
    await assert.rejects(reader.readMetadataRange('routed', { metadata: { boundary: 'known-0' } }), PersistenceIndexRecoveryRequiredError);
    await assert.rejects(new JsonlEventRepository({ rootDir: directory, codec }).readMetadataRange('routed', { metadata: { boundary: 'known-0' } }), PersistenceIndexRecoveryRequiredError);
    const tail = JSON.parse(await fs.readFile(path.join(directory, 'run-routed.index', 'tail.json'), 'utf8'));
    await fs.writeFile(path.join(directory, 'run-routed.index', 'routing', 'catalog', tail.routingRootHash + '.json'), '{broken');
    await assert.rejects(reader.readMetadataRange('routed', { metadata: { boundary: 'never-recorded' } }), PersistenceIndexRecoveryRequiredError);
  });
}

for (const stage of ['catalog', 'tail']) test(`routing ${stage} publication failure cannot expose a new value as absent after reopen`, async t => {
  const { promises: fs } = await import('node:fs');
  const { PersistenceIndexRecoveryRequiredError } = await import('@agent-core/persistence');
  const directory = await mkdtemp(path.join(tmpdir(), 'event-route-catalog-publication-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const codec = { ...typedEventCodec, metadataIndexes: [{ field: 'boundary' }], metadata: event => ({ boundary: event.boundary }) };
  const writer = new JsonlEventRepository({ rootDir: directory, codec });
  await writer.append('routed', { type: 'item', boundary: 'old' });
  const rename = fs.rename.bind(fs);
  const failing = t.mock.method(fs, 'rename', async (from, to) => {
    if (stage === 'catalog' ? String(to).split(path.sep).includes('catalog') : path.basename(String(to)) === 'tail.json')
      throw new Error('injected catalog publication failure');
    return rename(from, to);
  });
  await assert.rejects(writer.append('routed', { type: 'item', boundary: 'new' }), /injected catalog/);
  failing.mock.restore();
  for (const reader of [writer, new JsonlEventRepository({ rootDir: directory, codec })]) {
    await assert.rejects(reader.readMetadataRange('routed', { metadata: { boundary: 'new' } }), PersistenceIndexRecoveryRequiredError);
    await assert.rejects(reader.readMetadataRange('routed', { metadata: { boundary: 'unseen' } }), PersistenceIndexRecoveryRequiredError);
  }
  const sourceBeforeRepair = await fs.readFile(writer.location('routed'));
  assert.equal((await writer.tail('routed')).sequence, 1, 'An ordinary owned read repairs interrupted derived publication.');
  assert.ok((await fs.readFile(writer.location('routed'))).equals(sourceBeforeRepair));
  const repaired = new JsonlEventRepository({ rootDir: directory, codec });
  assert.equal((await repaired.readMetadataRange('routed', { metadata: { boundary: 'new' } })).records.length, 1);
  assert.equal((await repaired.readMetadataRange('routed', { metadata: { boundary: 'unseen' } })).scanned, 0);
});
