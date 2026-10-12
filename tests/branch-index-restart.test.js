import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlSessionRepository, SessionHistoryIndexError } from '@agent-core/runtime/node';

async function fixture(t, count = 4) {
  const root = await mkdtemp(path.join(tmpdir(), 'branch-index-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = new JsonlSessionRepository(root);
  const session = await writer.create({id: 'large', binding: {schemaId: 'tests/restart', schemaVersion: 1, subject: {}}});
  for (let i = 0; i < count; i++) await writer.appendInput(session, {runId: `run-${i}`, task: `${i} ${'x'.repeat(850000)}`});
  const file = writer.location(session.id);
  return {root, writer, session, file, indexFile: `${file}.index`};
}

test('cold metadata restores only the persisted index and warm reads never reload it', async t => {
  const {root, writer, session, file, indexFile} = await fixture(t);
  const reader = new JsonlSessionRepository(root);
  const fs = (await import('node:fs')).promises;
  const open = fs.open;
  fs.open = async function (target, flags, ...args) {
    if (target === file && flags === 'r') throw new Error('Cold metadata must not open original bodies');
    return open.call(this, target, flags, ...args);
  };
  let snapshot;
  try { snapshot = await reader.sourceSnapshot(session); }
  finally { fs.open = open; }
  const metrics = reader.historyReadMetrics(session.id);
  assert.equal(snapshot.entries.length, 4);
  assert.equal(metrics.scannedBytes, 0, 'cold reopen never scans or decodes source JSONL bodies');
  assert.equal(metrics.bodyBytesRead, 0);
  assert.equal(metrics.metadataRecordsRead, 5);
  assert.equal(metrics.metadataBytesRead, (await stat(indexFile)).size);
  assert(metrics.metadataBytesRead < (await stat(file)).size / 100);
  const page = await reader.readBranchPage(session, {maxBytes: 100});
  assert(page.oversizedEntry);
  await reader.sourceSnapshot(session);
  assert.deepEqual(reader.historyReadMetrics(session.id), metrics);
  const before = await readFile(indexFile);
  await writer.appendInput(session, {runId: 'new', task: 'tail'});
  const after = await readFile(indexFile);
  assert(after.subarray(0, before.length).equals(before), 'append retains existing metadata bytes');
  assert(after.length - before.length < 5000, 'one append persists one bounded metadata checkpoint');
  const latest = await reader.sourceSnapshot(session);
  assert.equal(latest.entries.length, 5);
  assert.equal(snapshot.entries.length, 4, 'captured cut remains stable');
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes, 0);
  const fresh = new JsonlSessionRepository(root);
  assert.equal((await fresh.sourceSnapshot(session)).entries.length, 5);
  assert.equal(fresh.historyReadMetrics(session.id).scannedBytes, 0);
});

test('corrupt or incomplete persisted metadata fails closed until explicit recovery', async t => {
  const {root, writer, session, file, indexFile} = await fixture(t, 2);
  const original = await readFile(file);
  const index = await readFile(indexFile, 'utf8');
  await writeFile(indexFile, index.replace('run-0', 'run-X'));
  const reader = new JsonlSessionRepository(root);
  await assert.rejects(reader.sourceSnapshot(session), SessionHistoryIndexError);
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes, 0);
  assert((await readFile(file)).equals(original));
  await reader.rebuildHistoryIndex(session.id, session.header.binding);
  assert.equal((await new JsonlSessionRepository(root).sourceSnapshot(session)).entries.length, 2);
  await appendFile(indexFile, '{"metadata":');
  await assert.rejects(new JsonlSessionRepository(root).sourceSnapshot(session), SessionHistoryIndexError);
  await writer.rebuildHistoryIndex(session.id, session.header.binding);
  assert((await readFile(file)).equals(original));
});

test('missing index requires explicit rebuild and cancelled recovery preserves the committed index', async t => {
  const {root, writer, session, indexFile} = await fixture(t, 2);
  const before = await readFile(indexFile);
  const controller = new AbortController();
  await assert.rejects(writer.rebuildHistoryIndex(session.id, session.header.binding, {
    signal: controller.signal,
    onProgress: ({records}) => {if (records >= 1) controller.abort();}
  }), /abort/i);
  assert((await readFile(indexFile)).equals(before));
  assert.equal((await writer.sourceSnapshot(session)).entries.length, 2);
  await rm(indexFile);
  const reader = new JsonlSessionRepository(root);
  await assert.rejects(reader.sourceSnapshot(session), SessionHistoryIndexError);
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes, 0);
  await reader.rebuildHistoryIndex(session.id, session.header.binding);
  assert.equal((await reader.sourceSnapshot(session)).entries.length, 2);
});

test('metadata write failure preserves committed source identity across retry', async t => {
  const {root, writer, session, file, indexFile} = await fixture(t, 1);
  const fs = (await import('node:fs')).promises;
  const open = fs.open;
  let failed = false;
  fs.open = async function (target, flags, ...args) {
    if (!failed && target === indexFile && flags === 'a') {
      failed = true;
      throw new Error('injected metadata append failure');
    }
    return open.call(this, target, flags, ...args);
  };
  try {
    await assert.rejects(writer.appendInput(session, {runId: 'retry', task: 'accepted once'}), /injected metadata/);
  } finally {
    fs.open = open;
  }
  assert(failed);
  const failedRead = new JsonlSessionRepository(root);
  await assert.rejects(failedRead.sourceSnapshot(session), SessionHistoryIndexError);
  assert.equal(failedRead.historyReadMetrics(session.id).scannedBytes, 0);
  await assert.rejects(writer.sourceSnapshot(session), SessionHistoryIndexError);
  const entry = await writer.appendInput(session, {runId: 'retry', task: 'accepted once'});
  const originals = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(originals.filter(item => item.runId === 'retry').length, 1);
  assert.equal(originals.at(-1).id, entry.id);
  await writer.rebuildHistoryIndex(session.id, session.header.binding);
  assert.equal((await new JsonlSessionRepository(root).sourceSnapshot(session)).entries.length, 2);
});

test('cold pending submission summaries never hydrate accepted inputs or configuration', async t => {
  const {root, writer, session, file} = await fixture(t, 1);
  await writer.enqueueSubmission(session, {
    submissionId: 'pending', runId: 'pending-run', input: {task: 'q'.repeat(850000)},
    configuration: {provider: 'test', model: 'test'}
  });
  await writer.transitionSubmission(session, 'pending', {state: 'claimed', claimId: 'claim'});
  const reader = new JsonlSessionRepository(root);
  const fs = (await import('node:fs')).promises;
  const open = fs.open;
  fs.open = async function (target, flags, ...args) {
    if (target === file && flags === 'r') throw new Error('Pending summaries must not open original bodies');
    return open.call(this, target, flags, ...args);
  };
  try {
    assert.deepEqual(await reader.pendingSubmissionSummaries(session), [
      {submissionId: 'pending', runId: 'pending-run', state: 'claimed'}
    ]);
  } finally { fs.open = open; }
  assert.equal(reader.indexMetrics().fullScans, 0);
  assert.equal(reader.historyReadMetrics(session.id).scannedBytes, 0);
  await writer.transitionSubmission(session, 'pending', {state: 'completed', claimId: 'claim'});
  assert.deepEqual(await reader.pendingSubmissionSummaries(session), []);
  assert.equal(reader.indexMetrics().fullScans, 0);
});
