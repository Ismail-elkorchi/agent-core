import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withPersistenceFileLock } from '@agent-core/persistence/node';
import { createSessionBinding } from '@agent-core/runtime';
import {
  JsonlSessionRepository,
  SessionHistoryIndexError,
  SessionHistorySourceError,
  SessionHistoryIndexPublicationError
} from '@agent-core/runtime/node';

const binding = { schemaId: 'test/history-repair', schemaVersion: 1, subject: { workspace: 'one' } };

// Inject at the canonical database boundary, never through a parallel metadata file.
function interceptProjectionSql(intercept) {
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ['run', 'get', 'all']) {
      const execute = statement[method].bind(statement);
      statement[method] = (...args) => intercept({ sql, method, execute: () => execute(...args) });
    }
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql) {
    return intercept({ sql, method: 'exec', execute: () => exec.call(this, sql) });
  };
  return () => { DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; };
}
const rootWrite = sql => /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+projection_root\b/iu.test(sql);
const rootRead = sql => /SELECT\b[\s\S]*\bFROM\s+projection_root\b/iu.test(sql);
const commit = sql => /^\s*COMMIT\b/iu.test(sql);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'history-repair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = new JsonlSessionRepository(root);
  const session = await repository.create({ id: 'damaged', binding });
  await repository.appendInput(session, { runId: 'one', task: 'original input' });
  const healthy = await repository.create({ id: 'healthy', binding });
  await repository.appendInput(healthy, { runId: 'two', task: 'other original' });
  const file = repository.location(session.id);
  return { root, repository, session, healthy, file, index: `${file}.index` };
}

test('ordinary list repairs a damaged root without activating the session', async t => {
  const { root, repository, session, healthy, file, index } = await fixture(t);
  const source = await fs.readFile(file);
  const healthyIndex = await fs.readFile(`${repository.location(healthy.id)}.index`);
  await fs.writeFile(index, '{broken metadata}\n');
  const reader = new JsonlSessionRepository(root);
  assert.equal((await reader.list()).length, 2);
  assert(reader.historyReadMetrics(session.id).scannedBytes > 0);
  assert.equal((await reader.readBranchPage(healthy)).entries.length, 1);
  await reader.rebuildHistoryIndex(session.id, binding);
  assert.equal((await reader.list()).length, 2);
  assert.equal((await reader.readBranchPage(session)).entries[0].task, 'original input');
  assert.deepEqual(await fs.readFile(file), source);
  assert.deepEqual(await fs.readFile(`${repository.location(healthy.id)}.index`), healthyIndex);
  assert.equal(reader.indexMetrics().fullScans, 0, 'repair never uses session activation/replay');
});

test('repair validates original header identity and workspace binding before publishing', async t => {
  const { root, session, file, index } = await fixture(t);
  const previousIndex = await fs.readFile(index);
  const source = await fs.readFile(file, 'utf8');
  const reader = new JsonlSessionRepository(root);
  await assert.rejects(reader.rebuildHistoryIndex(session.id, { ...binding, subject: { workspace: 'other' } }), error => {
    assert(error instanceof SessionHistorySourceError);
    assert.match(error.cause.message, /binding/iu);
    return true;
  });
  assert.deepEqual(await fs.readFile(index), previousIndex);
  assert.equal(await fs.readFile(file, 'utf8'), source);
  const lines = source.trimEnd().split('\n');
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), id: 'another-session' });
  const wrongIdentity = `${lines.join('\n')}\n`;
  await fs.writeFile(file, wrongIdentity);
  await assert.rejects(reader.rebuildHistoryIndex(session.id, binding), error => {
    assert(error instanceof SessionHistorySourceError);
    assert.equal(error.sessionId, session.id);
    assert.match(error.message, /saved messages couldn’t be read/u);
    assert.match(error.cause.message, /header validation failed/u);
    return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), wrongIdentity);
  assert.deepEqual(await fs.readFile(index), previousIndex);
});

test('invalid original records remain distinct from damaged metadata and preserve both files', async t => {
  const { root, session, file, index } = await fixture(t);
  const previousIndex = await fs.readFile(index);
  await fs.appendFile(file, '{invalid source}\n');
  const invalidSource = await fs.readFile(file);
  await assert.rejects(new JsonlSessionRepository(root).rebuildHistoryIndex(session.id, binding), error => {
    assert(error instanceof SessionHistorySourceError);
    assert.match(error.message, /saved messages couldn’t be read/u);
    assert.match(error.cause.message, /line 3/iu);
    assert.doesNotMatch(error.message, /explicitly rebuildHistoryIndex/u);
    return true;
  });
  assert.deepEqual(await fs.readFile(file), invalidSource);
  assert.deepEqual(await fs.readFile(index), previousIndex);
});

test('cancelled or failed repair leaves original history and previous index intact', async t => {
  const { root, session, file, index } = await fixture(t);
  const source = await fs.readFile(file);
  const previousIndex = await fs.readFile(index);
  const reader = new JsonlSessionRepository(root);
  const controller = new AbortController();
  await assert.rejects(reader.rebuildHistoryIndex(session.id, binding, {
    signal: controller.signal,
    onProgress: ({ records }) => { if (records >= 1) controller.abort(); }
  }), /abort/iu);
  assert.deepEqual(await fs.readFile(file), source);
  assert.deepEqual(await fs.readFile(index), previousIndex);
  for (const phase of ['root', 'commit']) {
    let preparedRoot = false;
    let injected = false;
    const restore = interceptProjectionSql(({ sql, execute }) => {
      if (rootWrite(sql)) preparedRoot = true;
      if ((phase === 'root' && rootWrite(sql)) || (phase === 'commit' && preparedRoot && commit(sql))) {
        injected = true;
        throw new Error(`Injected index ${phase} failure`);
      }
      return execute();
    });
    try {
      await assert.rejects(reader.rebuildHistoryIndex(session.id, binding), /Injected index (root|commit) failure/u);
    } finally { restore(); }
    assert(injected, `${phase} fault reached the canonical SQLite publication`);
    assert.deepEqual(await fs.readFile(file), source);
    assert.deepEqual(await fs.readFile(index), previousIndex);
  }
  await reader.rebuildHistoryIndex(session.id, binding);
  assert.equal((await reader.list()).length, 2);
});

test('explicit repair joins the same source lock as active session writers', async t => {
  const { root, session, file } = await fixture(t);
  let release;
  let acquired;
  const entered = new Promise(resolve => { acquired = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const writing = withPersistenceFileLock(file, 5000, async () => {
    acquired();
    await blocked;
  });
  await entered;
  const reader = new JsonlSessionRepository(root);
  let scanned = false;
  const repairing = reader.rebuildHistoryIndex(session.id, binding, { onProgress: () => { scanned = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanned, false, 'repair cannot scan while a writer owns the source lock');
  release();
  await writing;
  await repairing;
  assert.equal(scanned, true);
});

test('corrupt original submission lifecycles fail before replacing the old index', async t => {
  const { root, repository, session, file, index } = await fixture(t);
  await repository.admitSubmission(session, {
    submissionId: 'duplicate', runId: 'queued-run', input: { task: 'queued once' },
    configuration: { provider: 'unavailable', model: 'unavailable' }
  });
  const previousIndex = await fs.readFile(index);
  const source = await fs.readFile(file, 'utf8');
  await fs.appendFile(file, `${source.trimEnd().split('\n').at(-1)}\n`);
  const invalidSource = await fs.readFile(file);
  await assert.rejects(new JsonlSessionRepository(root).rebuildHistoryIndex(session.id, binding), error => {
    assert(error instanceof SessionHistorySourceError);
    assert.match(error.cause.message, /Invalid source record/iu);
    assert.match(error.cause.cause.message, /Duplicate submission/iu);
    return true;
  });
  assert.deepEqual(await fs.readFile(file), invalidSource);
  assert.deepEqual(await fs.readFile(index), previousIndex);
});

test('a disappeared warm root rebuilds its original automatically', async t => {
  const { repository, session, index } = await fixture(t);
  await repository.sourceSnapshot(session);
  const before = repository.historyReadMetrics(session.id);
  await fs.rm(index);
  assert.equal((await repository.sourceSnapshot(session)).entries.length, 1);
  assert(repository.historyReadMetrics(session.id).scannedBytes > before.scannedBytes);
});

test('application preflight recovers only selected damaged indexes and returns verified summaries', async t => {
  const { root, repository, session, healthy, file, index } = await fixture(t);
  const source = await fs.readFile(file);
  const healthyIndex = await fs.readFile(`${repository.location(healthy.id)}.index`);
  await fs.rm(index);
  const reader = new JsonlSessionRepository(root);
  const progress = [];
  const untouched = await reader.recoverHistoryIndexes(binding, { sessionId: healthy.id, onProgress: event => progress.push(event) });
  assert.equal(untouched.length, 1);
  assert.deepEqual(progress, []);
  assert.equal(reader.historyReadMetrics(healthy.id).scannedBytes, 0);
  const summaries = await reader.recoverHistoryIndexes(binding, { onProgress: event => progress.push(event) });
  assert.equal(summaries.length, 2);
  assert.deepEqual(progress.filter(event => event.phase !== 'progress'), [
    { phase: 'started', sessionId: session.id }, { phase: 'completed', sessionId: session.id }
  ]);
  assert(progress.some(event => event.phase === 'progress' && event.bytes === event.totalBytes));
  assert.deepEqual(await fs.readFile(file), source);
  assert.deepEqual(await fs.readFile(`${repository.location(healthy.id)}.index`), healthyIndex);
  progress.length = 0;
  await reader.recoverHistoryIndexes(binding, { onProgress: event => progress.push(event) });
  assert.deepEqual(progress, [], 'Healthy metadata never triggers a recovery scan or notice.');
});

test('a stale source boundary is fully revalidated before replacement', async t => {
  const { root, repository, session, file, index } = await fixture(t);
  const beforeIndex = await fs.readFile(index);
  await repository.appendInput(session, { runId: 'tail', task: 'The committed tail must be indexed once.' });
  const source = await fs.readFile(file);
  await fs.writeFile(index, beforeIndex);
  const reader = new JsonlSessionRepository(root);
  const progress = [];
  await reader.recoverHistoryIndexes(binding, { sessionId: session.id, onProgress: event => progress.push(event) });
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes, source.length);
  assert.equal((await reader.readBranchPage(session)).entries.length, 2);
  assert.deepEqual(await fs.readFile(file), source);
  assert.equal(progress.filter(event => event.phase === 'started').length, 1);
  assert.equal(progress.filter(event => event.phase === 'completed').length, 1);
});

test('preflight cancellation while waiting for a source lock preserves the prior index', async t => {
  const { root, session, file, index } = await fixture(t);
  await fs.writeFile(index, 'damaged checkpoint\n');
  const previousIndex = await fs.readFile(index);
  let release;
  let acquired;
  const entered = new Promise(resolve => { acquired = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const owner = withPersistenceFileLock(file, 5000, async () => { acquired(); await blocked; });
  await entered;
  const controller = new AbortController();
  const reader = new JsonlSessionRepository(root);
  const pending = reader.recoverHistoryIndexes(binding, {
    sessionId: session.id, signal: controller.signal,
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(Promise.race([
      pending,
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Cancellation waited for the lock owner.')), 1000); timer.unref(); })
    ]), error => error === controller.signal.reason);
    assert.deepEqual(await fs.readFile(index), previousIndex);
  } finally {
    release();
    await owner;
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await fs.readFile(index), previousIndex);
});

test('automatic recovery cancellation discards staged checkpoints and leaves metadata retryable', async t => {
  const { root, session, file, index } = await fixture(t);
  await fs.writeFile(index, 'damaged checkpoint\n');
  const previousIndex = await fs.readFile(index);
  const source = await fs.readFile(file);
  const controller = new AbortController();
  const events = [];
  const reader = new JsonlSessionRepository(root);
  await assert.rejects(reader.recoverHistoryIndexes(binding, {
    sessionId: session.id, signal: controller.signal,
    onProgress: event => {
      events.push(event);
      if (event.phase === 'progress' && event.records >= 1) controller.abort();
    }
  }), error => error === controller.signal.reason);
  assert.equal(events.some(event => event.phase === 'completed'), false);
  assert.deepEqual(await fs.readFile(index), previousIndex);
  assert.deepEqual(await fs.readFile(file), source);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
  await reader.recoverHistoryIndexes(binding, { sessionId: session.id });
  assert.equal((await reader.list()).length, 2);
});

test('automatic recovery handles a source/index commit gap after an index-only write failure', async t => {
  const { root, repository, session, file, index } = await fixture(t);
  const previousIndex = await fs.readFile(index);
  const restore = interceptProjectionSql(({ sql, execute }) => {
    if (rootWrite(sql)) throw new Error('Injected derived-index publication failure');
    return execute();
  });
  try {
    await assert.rejects(repository.appendInput(session, { runId: 'accepted', task: 'Accepted source survives index write failure.' }), /Injected derived-index/u);
  } finally { restore(); }
  assert.deepEqual(await fs.readFile(index), previousIndex, 'failed projection transaction retains the prior database bytes');
  const committed = await fs.readFile(file);
  const reader = new JsonlSessionRepository(root);
  await reader.recoverHistoryIndexes(binding, { sessionId: session.id });
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes, committed.length);
  const page = await reader.readBranchPage(session);
  assert.equal(page.entries.filter(entry => entry.runId === 'accepted').length, 1);
  assert.deepEqual(await fs.readFile(file), committed);
});

test('original workspace binding is enforced and isolated for both catch-up and full recovery', async t => {
  for (const missing of [false, true]) {
    const { root, session, healthy, file, index } = await fixture(t);
    const previousIndex = await fs.readFile(index);
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), binding: createSessionBinding({ ...binding, subject: { workspace: 'different original' } }) });
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    if (missing) await fs.rm(index);
    const original = await fs.readFile(file);
    const reader = new JsonlSessionRepository(root);
    await assert.rejects(reader.recoverHistoryIndexes(binding, { sessionId: session.id }), error => {
      assert(error instanceof SessionHistorySourceError);
      assert.match(error.cause.message, /binding/iu);
      return true;
    });
    const events = [];
    assert.deepEqual((await reader.recoverHistoryIndexes(binding, { onProgress: event => events.push(event) })).map(item => item.id), [healthy.id]);
    assert.equal(events.filter(event => event.phase === 'failed' && event.sessionId === session.id).length, 1);
    if (missing) await assert.rejects(fs.stat(index), error => error.code === 'ENOENT');
    else assert.deepEqual(await fs.readFile(index), previousIndex);
    assert.deepEqual(await fs.readFile(file), original);
  }
});

test('index publication and final verification retain the same index lock as metadata readers', async t => {
  const { root, session, index } = await fixture(t);
  let preparedRoot = false;
  let published = false;
  let checkedFinalRead = false;
  const restore = interceptProjectionSql(({ sql, execute }) => {
    if (rootWrite(sql)) {
      assert(statSync(`${index}.lock`).isDirectory());
      preparedRoot = true;
    }
    if (preparedRoot && commit(sql)) {
      assert(statSync(`${index}.lock`).isDirectory());
      const result = execute();
      published = true;
      return result;
    }
    if (published && rootRead(sql)) {
      assert(statSync(`${index}.lock`).isDirectory());
      checkedFinalRead = true;
    }
    return execute();
  });
  try {
    await new JsonlSessionRepository(root).rebuildHistoryIndex(session.id, binding);
  } finally { restore(); }
  assert(published);
  assert(checkedFinalRead);
});

test('post-publication verification failure is reported truthfully and never triggers another rebuild', async t => {
  const { root, session, file, index } = await fixture(t);
  const original = await fs.readFile(file);
  await fs.writeFile(index, 'invalid prior checkpoint\n');
  const previousIndex = await fs.readFile(index);
  let preparedRoot = false;
  let publications = 0;
  let failed = false;
  const restore = interceptProjectionSql(({ sql, execute }) => {
    if (rootWrite(sql)) preparedRoot = true;
    if (preparedRoot && commit(sql)) {
      const result = execute();
      publications++;
      return result;
    }
    if (publications > 0 && !failed && rootRead(sql)) {
      failed = true;
      throw new Error('Injected post-publication verification failure');
    }
    return execute();
  });
  try {
    await assert.rejects(new JsonlSessionRepository(root).recoverHistoryIndexes(binding, { sessionId: session.id }), error => {
      assert(error instanceof SessionHistoryIndexPublicationError);
      assert.equal(error.indexPublished, true);
      assert.equal(error.sessionId, session.id);
      assert.match(error.message, /save couldn’t be confirmed/u);
      assert.match(error.cause.message, /Injected post-publication/u);
      return true;
    });
  } finally { restore(); }
  assert(failed);
  assert.equal(publications, 1);
  assert.notDeepEqual(await fs.readFile(index), previousIndex);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await new JsonlSessionRepository(root).list()).length, 2);
});

test('all-session preflight reports invalid original history without blocking healthy sessions', async t => {
  const { root, repository, session, healthy, file, index } = await fixture(t);
  const healthySource = await fs.readFile(repository.location(healthy.id));
  const healthyIndex = await fs.readFile(`${repository.location(healthy.id)}.index`);
  const badIndex = await fs.readFile(index);
  await fs.appendFile(file, '{invalid original}\n');
  const badSource = await fs.readFile(file);
  const events = [];
  const reader = new JsonlSessionRepository(root);
  const summaries = await reader.recoverHistoryIndexes(binding, { onProgress: event => events.push(event) });
  assert.deepEqual(summaries.map(item => item.id), [healthy.id]);
  const failures = events.filter(event => event.phase === 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].sessionId, session.id);
  assert.match(failures[0].message, /saved messages couldn’t be read/u);
  assert.equal(events.some(event => event.phase === 'completed' && event.sessionId === session.id), false);
  await assert.rejects(reader.recoverHistoryIndexes(binding, { sessionId: session.id }), SessionHistorySourceError);
  assert.deepEqual(await fs.readFile(file), badSource);
  assert.deepEqual(await fs.readFile(index), badIndex);
  assert.deepEqual(await fs.readFile(repository.location(healthy.id)), healthySource);
  assert.deepEqual(await fs.readFile(`${repository.location(healthy.id)}.index`), healthyIndex);
});


test('conversation opening errors use ordinary wording while preserving typed technical causes', () => {
  const cause = Object.assign(new Error('underlying storage failure'), { code: 'EIO' });
  for (const Constructor of [SessionHistoryIndexError, SessionHistorySourceError]) {
    const error = new Constructor('selected', 'header validation failed at line 3', { cause });
    assert.equal(error.sessionId, 'selected');
    assert.equal(error.cause.message, 'header validation failed at line 3');
    assert.equal(error.cause.cause, cause);
    assert.doesNotMatch(error.message, /index|recover|header|line 3|selected/iu);
  }
  const published = new SessionHistoryIndexPublicationError('selected', cause);
  assert.equal(published.indexPublished, true);
  assert.equal(published.cause, cause);
  assert.doesNotMatch(published.message, /index|recover|unchanged|hasn’t been changed/iu);
});

test('deliberate full replay uses the same source validator and preserves a duplicate finalization journal', async t => {
  const {repository, session, file, index} = await fixture(t);
  await repository.recordRunFinalization(session, {
    runId: 'one', finalizationId: 'one-final', phase: 'ended', executionStatus: 'completed',
    terminationReason: 'model_completed', modelTerminationReason: 'stop',
    modelOutput: {status: 'complete', message: 'done', source: 'content', turnIndex: 1}, turnCount: 1,
    budget: {modelTurns: 1, totalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0}
  });
  const previousIndex = await fs.readFile(index);
  const original = await fs.readFile(file, 'utf8');
  const duplicate = `${original}${original.trimEnd().split('\n').at(-1)}\n`;
  await fs.writeFile(file, duplicate);
  await assert.rejects(repository.loadReplayState(session), error =>
    error instanceof SessionHistorySourceError && /Duplicate finalization/u.test(error.cause.cause.message));
  assert.equal(await fs.readFile(file, 'utf8'), duplicate);
  assert.deepEqual(await fs.readFile(index), previousIndex);
});
