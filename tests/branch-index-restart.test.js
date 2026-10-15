import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { hashJson } from '@agent-core/persistence';
import { jsonlBoundaryMarker } from '@agent-core/persistence/node';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlSessionRepository, SessionHistorySourceError } from '@agent-core/runtime/node';

function readRoot(index) {
  const database = new DatabaseSync(index);
  try {return Buffer.from(database.prepare('SELECT payload FROM projection_root WHERE id=1').get().payload);}
  finally {database.close();}
}
function writeRoot(index, value) {
  const database = new DatabaseSync(index);
  try {database.prepare('UPDATE projection_root SET payload=? WHERE id=1').run(Buffer.from(value));}
  finally {database.close();}
}

async function fixture(t, count = 4) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'branch-index-restart-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = new JsonlSessionRepository(root);
  const session = await writer.create({id: 'large', binding: {schemaId: 'tests/restart', schemaVersion: 1, subject: {}}});
  for (let i = 0; i < count; i++) await writer.appendInput(session, {runId: `run-${i}`, task: `${i} ${'x'.repeat(850000)}`});
  const file = writer.location(session.id);
  return {root, writer, session, file, indexFile: `${file}.index`};
}

test('cold list and open read one bounded root and the original header, never history bodies', async t => {
  const {root, writer, session, file, indexFile} = await fixture(t);
  const reader = new JsonlSessionRepository(root);
  assert.equal((await reader.list()).length, 1);
  const opened = await reader.open(session.id, session.header.binding);
  const metrics = reader.historyReadMetrics(session.id);
  assert.equal(metrics.scannedBytes, 0);
  assert.equal(metrics.bodyBytesRead, 0);
  assert.equal(metrics.metadataRecordsRead, 1);
  assert.equal(metrics.metadataBytesRead, readRoot(indexFile).length);
  assert(metrics.headerBytesRead < 4096);
  assert(metrics.metadataBytesRead < 4096);
  assert.equal(reader.indexMetrics().fullScans, 0);
  await reader.list(); await reader.open(session.id, session.header.binding);
  assert.deepEqual(reader.historyReadMetrics(session.id), metrics);
  const snapshot = await reader.sourceSnapshot(opened);
  assert.equal(snapshot.entries.length, 4);
  assert.equal(reader.historyReadMetrics(session.id).bodyBytesRead, 0);
  const before = readRoot(indexFile).length;
  await writer.appendInput(session, {runId: 'new', task: 'tail'});
  assert(readRoot(indexFile).length < before + 1000, 'root does not accumulate prior checkpoints');
  assert.equal((await reader.sourceSnapshot(session)).entries.length, 5);
  assert.equal(snapshot.entries.length, 4, 'captured metadata is stable');
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes, 0);
  assert((await fs.stat(file)).size > 3_000_000);
});

test('cold settings, first append and idempotent retry use point paths and retain no body history', async t => {
  const {root, writer, session} = await fixture(t, 12);
  const settings = {provider:'test', model:'small', temperature:0.2};
  await writer.appendModelSettings(session, settings);
  const reader = new JsonlSessionRepository(root);
  const opened = await reader.open(session.id, session.header.binding);
  assert.equal((await reader.currentModelSettings(opened)).model, 'small');
  const before = reader.historyReadMetrics(session.id);
  assert.equal(before.bodyRecordsRead, 1);
  const entry = await reader.appendInput(opened, {runId:'first-cold',task:'one small append'});
  const after = reader.historyReadMetrics(session.id);
  assert.equal(after.bodyRecordsRead, before.bodyRecordsRead);
  assert(after.scannedBytes < 1024, 'only the newly committed record is decoded');
  assert(after.metadataBytesRead - before.metadataBytesRead < 100_000, 'append uses bounded tree paths');
  assert.equal(reader.indexMetrics().fullScans, 0);
  assert.equal((await reader.appendInput(opened, {runId:'first-cold',task:'one small append'})).id, entry.id);
  assert.equal(reader.historyReadMetrics(session.id).bodyRecordsRead, after.bodyRecordsRead + 1);
  await assert.rejects(reader.appendInput(opened, {runId:'first-cold',task:'conflict'}), /Conflicting session input/);
});

test('missing, corrupt, incomplete and stale derived roots rebuild automatically without changing originals', async t => {
  const {root, writer, session, file, indexFile} = await fixture(t, 2);
  const old = await fs.readFile(indexFile);
  await writer.appendInput(session,{runId:'tail',task:'committed tail'});
  const original = await fs.readFile(file);
  for (const damage of ['missing','corrupt','incomplete','stale']) {
    if (damage === 'missing') await fs.rm(indexFile);
    else await fs.writeFile(indexFile, damage === 'stale' ? old : damage === 'incomplete' ? '{"metadata":' : '{broken}');
    const reader = new JsonlSessionRepository(root);
    assert.equal((await reader.open(session.id, session.header.binding)).id, session.id);
    assert.equal((await reader.sourceSnapshot(session)).entries.length, 3);
    assert(reader.historyReadMetrics(session.id).scannedBytes > 0);
    assert.deepEqual(await fs.readFile(file), original);
  }
});

test('missing or corrupt point nodes recover automatically, while invalid originals reject', async t => {
  const {root, session, file, indexFile} = await fixture(t, 2);
  const original = await fs.readFile(file);
  const envelope = JSON.parse(readRoot(indexFile));
  const database = new DatabaseSync(`${file}.index`);
  database.prepare('UPDATE nodes SET payload=? WHERE namespace=? AND hash=?').run(Buffer.from('{corrupt}'), `main-${envelope.metadata.lineage}`, envelope.metadata.tree);
  database.close();
  const reader = new JsonlSessionRepository(root);
  assert.equal((await reader.sourceSnapshot(session)).entries.length, 2);
  assert.deepEqual(await fs.readFile(file), original);
  await fs.appendFile(file,'{invalid source}\n');
  const invalid = await fs.readFile(file);
  await assert.rejects(new JsonlSessionRepository(root).open(session.id,session.header.binding), SessionHistorySourceError);
  assert.deepEqual(await fs.readFile(file), invalid);
});

test('cancelled rebuild retains committed root and source byte-for-byte', async t => {
  const {writer,session,file,indexFile}=await fixture(t,2);
  const before=await fs.readFile(indexFile); const original=await fs.readFile(file);
  const controller=new AbortController();
  await assert.rejects(writer.rebuildHistoryIndex(session.id,session.header.binding,{
    signal:controller.signal,onProgress:({records})=>{if(records>=1)controller.abort();}
  }),error=>error===controller.signal.reason);
  assert.deepEqual(await fs.readFile(indexFile),before);
  assert.deepEqual(await fs.readFile(file),original);
});

test('root publication failure after source commit retries the original identity once', async t => {
  const {root,writer,session,file}=await fixture(t,1);
  const prepare = DatabaseSync.prototype.prepare; let failed = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('INSERT OR REPLACE INTO projection_root')) statement.run = () => {failed = true; throw new Error('injected root publication failure');};
    return statement;
  };
  try {await assert.rejects(writer.appendInput(session,{runId:'retry',task:'accepted once'}),/injected root publication/);}
  finally {DatabaseSync.prototype.prepare = prepare;}
  assert(failed);
  const reader=new JsonlSessionRepository(root);
  const entry=await reader.appendInput(session,{runId:'retry',task:'accepted once'});
  const originals=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(originals.filter(item=>item.runId==='retry').length,1);
  assert.equal(originals.at(-1).id,entry.id);
});

test('cold pending summaries read only live metadata and never hydrate accepted inputs', async t=>{
  const {root,writer,session}=await fixture(t,1);
  await writer.admitSubmission(session,{submissionId:'pending',runId:'pending-run',input:{task:'q'.repeat(850000)},configuration:{provider:'test',model:'test'}});
  await writer.transitionSubmission(session,'pending',{state:'claimed',claimId:'claim'});
  const reader=new JsonlSessionRepository(root);
  assert.deepEqual(await reader.pendingSubmissionSummaries(session),[{submissionId:'pending',runId:'pending-run',state:'claimed'}]);
  assert.equal(reader.historyReadMetrics(session.id).bodyRecordsRead,0);
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes,0);
  await writer.transitionSubmission(session,'pending',{state:'completed',claimId:'claim'});
  const before=reader.historyReadMetrics(session.id);
  assert.deepEqual(await reader.pendingSubmissionSummaries(session),[]);
  const after=reader.historyReadMetrics(session.id);
  assert.equal(after.bodyRecordsRead,0);
  assert.equal(after.metadataRecordsRead-before.metadataRecordsRead,1,'empty pending query reads only changed root, no completed history');
});

function projectionRows(file) {
  const database = new DatabaseSync(`${file}.index`);
  try {return database.prepare('SELECT namespace,hash,payload FROM nodes ORDER BY namespace,hash').all();}
  finally {database.close();}
}

test('failed preflight and failed source appends do not retain unpublished node generations', async t => {
  const {writer, session, file} = await fixture(t, 3);
  const before = await fs.readFile(file);
  const rows = projectionRows(file);
  const open = fs.open;
  fs.open = async function(target, flags, ...args) {
    if (String(target) === file && String(flags).includes('a')) throw new Error('source append unavailable');
    return open.call(this, target, flags, ...args);
  };
  try {
    for (let i = 0; i < 4; i++) await assert.rejects(writer.appendInput(session, {runId: `failed-${i}`, task: 'never committed'}), /source append unavailable/u);
  } finally {fs.open = open;}
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(projectionRows(file), rows);
  assert.equal((await writer.sourceSnapshot(session)).entries.length, 3);
});

test('a failed retirement rolls back metadata and a committed source is recovered on retry', async t => {
  const {writer, session, file} = await fixture(t, 3);
  const before = projectionRows(file), original = await fs.readFile(file);
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (sql === 'DELETE FROM nodes WHERE namespace=? AND hash=?') statement.run = () => {throw new Error('retirement interrupted');};
    return statement;
  };
  try {await assert.rejects(writer.appendInput(session, {runId: 'accepted', task: 'committed source survives metadata rollback'}), /retirement interrupted/u);}
  finally {DatabaseSync.prototype.prepare = prepare;}
  assert.deepEqual(projectionRows(file), before);
  assert((await fs.readFile(file)).length > original.length);
  await writer.appendInput(session, {runId: 'accepted', task: 'committed source survives metadata rollback'});
  assert.equal((await writer.sourceSnapshot(session)).entries.length, 4);
});

test('captured cuts survive automatic projection rebuild while changed originals are rejected', async t => {
  const {writer, session, file, indexFile} = await fixture(t, 3);
  const snapshot = await writer.sourceSnapshot(session);
  const entry = await snapshot.entries.at(0);
  await fs.rm(indexFile);
  assert.equal((await snapshot.entries.at(0)).entryId, entry.entryId);
  assert.equal((await writer.sourceSnapshot(session)).boundary.leafHash, snapshot.boundary.leafHash);
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, original.replace('2 x', '2 y'));
  await assert.rejects(snapshot.entries.at(0), error => error instanceof SessionHistorySourceError && /boundary changed/u.test(error.cause.message));
  assert.equal(await fs.readFile(file, 'utf8'), original.replace('2 x', '2 y'));
});

test('SQLite rollback needs no external retirement bookkeeping', async t => {
  const {writer, session, file} = await fixture(t, 3);
  await writer.appendInput(session, {runId: 'one-more', task: 'single derived owner'});
  await assert.rejects(fs.stat(`${file}.projection`), {code: 'ENOENT'});
  assert.equal((await writer.sourceSnapshot(session)).entries.length, 4);
});

test('a checksummed but false derived boundary cannot authorize truncating committed source', async t => {
  const {root, session, file, indexFile} = await fixture(t, 3);
  const before = await fs.readFile(file);
  const envelope = JSON.parse(readRoot(indexFile));
  const shorter = before.lastIndexOf(10, before.length - 2) + 1;
  envelope.metadata.completeBytes = shorter;
  envelope.metadata.marker = await jsonlBoundaryMarker(file, shorter);
  envelope.sha256 = hashJson(envelope.metadata);
  writeRoot(indexFile, JSON.stringify(envelope));
  const reader = new JsonlSessionRepository(root);
  const opened = await reader.open(session.id, session.header.binding);
  await reader.appendInput(opened, {runId: 'after-false-boundary', task: 'still append after all committed records'});
  assert.deepEqual((await fs.readFile(file)).subarray(0, before.length), before);
  assert.equal((await reader.sourceSnapshot(opened)).entries.length, 4);
});

function contextCommit(session, snapshot, key, retained, excerpts = []) {
  const selection = {retained, ...(excerpts.length ? {excerpts} : {}), continuity: {kind: 'fresh', resetId: key, model: {provider: 'test', model: 'test'}, sources: retained}};
  const reason = 'Retain exactly the requested source';
  const timestamp = new Date().toISOString();
  return {
    expectedSessionStateRevisionId: null,
    expectedLeafId: snapshot.boundary.leafId,
    expectedSourceRevision: snapshot.sourceRevision,
    expectedWindowId: null,
    window: {windowId: key, parentWindowId: null, createdAt: timestamp, reason, selection,
      historyPosition: {format: 'agent-core.history/1', sessionId: session.id, branchId: snapshot.branchId,
        throughEntryId: snapshot.boundary.leafId, sourceRevision: snapshot.sourceRevision, ledgerCoverage: 'session'}},
    transition: {transitionId: key, idempotencyKey: key, previousWindowId: null, windowId: key,
      committedAt: timestamp, requestedSourceRevision: snapshot.sourceRevision,
      admission: {status: 'admitted', compiledInputIdentity: key, capabilityRevision: 'test'}, selectionFingerprint: hashJson(selection),
      requestFingerprint: hashJson({expectedWindowId: null, idempotencyKey: key, selection, reason, expectedSourceRevision: snapshot.sourceRevision})}
  };
}

test('context commit validates only requested refs and ancestor paths, without walking unrelated archive', async t => {
  const {writer, session} = await fixture(t, 0);
  for (let i = 0; i < 150; i++) await writer.appendInput(session, {runId: `archive-${i}`, task: 'Unrelated archived metadata'});
  const snapshot = await writer.sourceSnapshot(session);
  const target = await snapshot.entries.at(-1);
  const ref = {sessionId: session.id, entryId: target.entryId, sha256: target.sha256};
  const invalid = contextCommit(session, snapshot, 'invalid-selection', [{...ref, sha256: '0'.repeat(64)}]);
  await assert.rejects(writer.commitContextTransition(session, invalid), /outside the branch/u);
  assert.equal(await writer.revision(session), snapshot.sourceRevision);
  const before = writer.historyReadMetrics(session.id);
  const excerpts = [{source: ref, offset: 0, bytes: 8}, {source: ref, offset: 9, bytes: 8}];
  const committed = await writer.commitContextTransition(session, contextCommit(session, snapshot, 'bounded-selection', [], excerpts));
  assert.deepEqual(committed.window.selection.excerpts, excerpts);
  const after = writer.historyReadMetrics(session.id);
  assert.equal(after.bodyBytesRead - before.bodyBytesRead, 0);
  assert.equal(after.scannedBytes - before.scannedBytes, 0);
  assert.ok(after.metadataRecordsRead - before.metadataRecordsRead < 400,
    `context commit read ${after.metadataRecordsRead - before.metadataRecordsRead} metadata nodes`);
});

test('projection buckets have fixed key and encoded-byte bounds and share small metadata values', async t => {
  const {writer, session, file} = await fixture(t, 0);
  for (let i = 0; i < 40; i++) await writer.appendInput(session, {runId: `bucket-${i}`, task: 'small source'});
  let grouped = 0;
  for (const row of projectionRows(file)) {
    const text = Buffer.from(row.payload).toString('utf8');
    const node = JSON.parse(text);
    assert.ok(node.kind === 'bucket' || node.kind === 'branch');
    if (node.kind !== 'bucket') continue;
    assert.ok(node.entries.length >= 1 && node.entries.length <= 16);
    if (node.entries.length > 1) {grouped++; assert.ok(Buffer.byteLength(text.trimEnd()) <= 8192);}
    assert.equal(new Set(node.entries.map(entry => entry.key)).size, node.entries.length);
  }
  assert.ok(grouped > 0, 'small values must actually use shared bounded buckets');
});

test('a partially inserted metadata transaction leaves no unpublished generations and preserves source', async t => {
  const {writer, session, file} = await fixture(t, 0);
  for (let i = 0; i < 20; i++) await writer.appendInput(session, {runId: `before-batch-${i}`, task: 'small source'});
  const before = await fs.readFile(file);
  const rows = projectionRows(file);
  const prepare = DatabaseSync.prototype.prepare;
  let inserted = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('INSERT OR REPLACE INTO nodes')) {
      const run = statement.run;
      statement.run = function(...args) {if (++inserted === 3) throw new Error('partial metadata transaction'); return run.apply(this, args);};
    }
    return statement;
  };
  try {await assert.rejects(writer.appendInput(session, {runId: 'failed-batch', task: 'not accepted'}), /partial metadata transaction/u);}
  finally {DatabaseSync.prototype.prepare = prepare;}
  assert.equal(inserted, 3);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(projectionRows(file), rows);
  await writer.appendInput(session, {runId: 'failed-batch', task: 'not accepted'});
  assert.equal((await writer.sourceSnapshot(session)).entries.length, 21);
});

for (const corruption of ['missing', 'invalid database', 'text payload', 'oversized blob']) test(`SQLite projection repairs ${corruption} without changing original history`, async t => {
  const {root, session, file, indexFile} = await fixture(t, 2);
  const original = await fs.readFile(file);
  const databasePath = `${file}.index`;
  if (corruption === 'missing') await fs.rm(databasePath);
  else if (corruption === 'invalid database') await fs.writeFile(databasePath, 'not a SQLite database');
  else {
    const envelope = JSON.parse(readRoot(indexFile));
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare('UPDATE nodes SET payload=? WHERE namespace=? AND hash=?').run(
        corruption === 'text payload' ? 'invalid' : Buffer.alloc(16 * 1024 * 1024 + 1),
        `main-${envelope.metadata.lineage}`, envelope.metadata.tree);
    } finally {database.close();}
  }
  const reader = new JsonlSessionRepository(root);
  assert.equal((await reader.sourceSnapshot(session)).entries.length, 2);
  assert.deepEqual(await fs.readFile(file), original);
  assert(reader.historyReadMetrics(session.id).scannedBytes > 0);
});

test('a busy SQLite projection fails without rebuilding or changing accepted history', async t => {
  const {root, session, file, indexFile} = await fixture(t, 2);
  const original = await fs.readFile(file), originalRoot = await fs.readFile(indexFile);
  const database = new DatabaseSync(`${file}.index`);
  database.exec('BEGIN EXCLUSIVE');
  const reader = new JsonlSessionRepository(root);
  try {
    await assert.rejects(reader.sourceSnapshot(session), /locked/u);
    assert.equal(reader.historyReadMetrics(session.id).scannedBytes, 0);
    assert.deepEqual(await fs.readFile(file), original);
    assert.deepEqual(await fs.readFile(indexFile), originalRoot);
  } finally {database.exec('ROLLBACK'); database.close();}
  assert.equal((await reader.sourceSnapshot(session)).entries.length, 2);
});

test('incompatible SQLite schema is disposable and repaired from unchanged originals', async t => {
  const {root, session, file} = await fixture(t, 2);
  const original = await fs.readFile(file);
  const database = new DatabaseSync(`${file}.index`);
  database.exec('DROP TABLE nodes; CREATE TABLE nodes(namespace TEXT, hash TEXT)'); database.close();
  const reader = new JsonlSessionRepository(root);
  assert.equal((await reader.sourceSnapshot(session)).entries.length, 2);
  assert.deepEqual(await fs.readFile(file), original);
});

test('a queued snapshot from rebuild progress acquires a fresh connection and index lock', async t => {
  const {writer, session} = await fixture(t, 3);
  let pending;
  await writer.rebuildHistoryIndex(session.id, session.header.binding, {onProgress() {
    pending ??= writer.sourceSnapshot(session);
  }});
  assert.equal((await pending).entries.length, 3);
});

for (const schema of [
  'CREATE TABLE nodes(namespace TEXT NOT NULL, hash TEXT NOT NULL, payload BLOB NOT NULL)',
  'CREATE TABLE nodes(namespace TEXT, hash TEXT)'
]) test('schema-invalid prior databases survive cancelled rebuild byte-for-byte', async t => {
  const {root, session, file} = await fixture(t, 2);
  const database = new DatabaseSync(`${file}.index`);
  database.exec(`DROP TABLE nodes; ${schema}`); database.close();
  const before = await fs.readFile(`${file}.index`), original = await fs.readFile(file);
  const controller = new AbortController();
  const reader = new JsonlSessionRepository(root);
  await assert.rejects(reader.rebuildHistoryIndex(session.id, session.header.binding, {
    signal: controller.signal, onProgress: () => controller.abort()
  }), /abort/iu);
  assert.deepEqual(await fs.readFile(`${file}.index`), before);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await reader.sourceSnapshot(session)).entries.length, 2);
});

test('immutable historical lookup cache is bounded, warms without reads, and rebinds after repair', async t => {
  const {root, writer, session, file} = await fixture(t, 0);
  await writer.appendInput(session, {runId: 'oldest', task: 'old immutable cut'});
  const old = await writer.sourceSnapshot(session);
  assert.equal(await old.index.inputs.get('oldest'), 0);
  const warmed = writer.historyReadMetrics(session.id).metadataRecordsRead;
  for (let i = 0; i < 8; i++) assert.equal(await old.index.inputs.get('oldest'), 0);
  assert.equal(writer.historyReadMetrics(session.id).metadataRecordsRead, warmed);
  for (let i = 0; i < 270; i++) await writer.appendInput(session, {runId: `evict-${i}`, task: 'small'});
  const before = writer.historyReadMetrics(session.id).metadataRecordsRead;
  assert.equal(await old.index.inputs.get('oldest'), 0);
  assert(writer.historyReadMetrics(session.id).metadataRecordsRead > before, 'old immutable root must leave the bounded cache');
  const current = await writer.sourceSnapshot(session);
  await current.entries.at(0);
  const stat = fs.stat; let sourceStats = 0;
  fs.stat = async function(target, ...args) {if (String(target) === file) sourceStats++; return stat.call(this, target, ...args);};
  try {for (let i = 0; i < 8; i++) await current.entries.at(0);} finally {fs.stat = stat;}
  assert.equal(sourceStats, 8, 'one public lookup validates once, not once per ancestor');
  const original = await fs.readFile(file);
  await fs.writeFile(`${file}.index`, 'damaged derived database');
  await writer.rebuildHistoryIndex(session.id, session.header.binding);
  assert.equal(await old.index.inputs.get('oldest'), 0);
  assert.deepEqual(await fs.readFile(file), original);
  const cold = new JsonlSessionRepository(root);
  assert.equal(await (await cold.sourceSnapshot(session)).index.inputs.get('oldest'), 0);
});
