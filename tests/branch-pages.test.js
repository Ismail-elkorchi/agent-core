import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/branch-pages', schemaVersion: 1, subject: {} };

async function fixture(t, count = 700) {
  const root = await mkdtemp(path.join(tmpdir(), 'branch-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = new InMemorySessionRepository();
  const session = await memory.create({ id: 'history', binding });
  const entries = [];
  const records = [];
  for (let index = 0; index < count; index++) {
    const entry = await memory.appendInput(session, {
      runId: `run-${index}`,
      task: `${index === 0 ? 'NEEDLE outside retained history' : `Input ${index}`}\n${'文 '.repeat(1500)}`
    });
    entries.push(entry);
    records.push(entry);
    if (index === 0)
      records.push(
        await memory.recordRunFinalization(session, {
          runId: 'run-0',
          finalizationId: 'final-0',
          phase: 'ended',
          executionStatus: 'completed',
          terminationReason: 'model_completed',
          modelTerminationReason: 'stop',
          turnCount: 1,
          modelOutput: { status: 'complete', message: 'Done', source: 'content', turnIndex: 1 },
          budget: {
            modelTurns: 1,
            totalToolCalls: 0,
            repeatedIdenticalToolCalls: 0,
            elapsedMs: 1,
            promptTokens: 0,
            completionTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            knownCosts: {},
            pricingStatus: 'unknown',
            unknownPricedTokens: 0,
            consecutiveProviderFailures: 0,
            consecutiveToolFailures: 0
          }
        })
      );
  }
  const repository = new JsonlSessionRepository({ rootDir: root });
  const file = repository.location(session.id);
  const source = [session.header, ...records].map((record) => JSON.stringify(record) + '\n').join('');
  await writeFile(file, source);
  return { memory, session, entries, file, source, repository };
}

test('offset-based pages retain bounded bodies while all history beyond 512 entries and 2 MiB remains retrievable', async (t) => {
  const { repository, session, entries, source } = await fixture(t);
  assert(Buffer.byteLength(source) > 2 * 1024 * 1024);
  let page = await repository.readBranchPage(session, { limit: 20, maxBytes: 64 * 1024 });
  assert.equal(page.entries.at(-1).id, entries.at(-1).id);
  const seen = new Set();
  for (;;) {
    for (const entry of page.entries) {
      assert(!seen.has(entry.id));
      seen.add(entry.id);
    }
    if (!page.older) break;
    const before = repository.historyReadMetrics(session.id);
    page = await repository.readBranchPage(session, { cursor: page.older, limit: 20, maxBytes: 64 * 1024 });
    const after = repository.historyReadMetrics(session.id);
    assert(after.bodyBytesRead - before.bodyBytesRead <= 64 * 1024);
    assert(after.bodyRecordsRead - before.bodyRecordsRead <= 20);
    assert.equal(after.scannedBytes, before.scannedBytes);
  }
  assert.equal(seen.size, entries.length);
  assert.equal(
    repository.indexMetrics().fullScans,
    0,
    'page retrieval never opens the full replay repository index'
  );
  const metrics = repository.historyReadMetrics(session.id);
  assert.equal(metrics.scannedBytes, Buffer.byteLength(source), 'one cold metadata scan is explicit');
  assert.equal(metrics.bodyRecordsRead, entries.length);
});

test('search walks beyond loaded pages and binds continuations to the original query and branch', async (t) => {
  const { repository, session, entries } = await fixture(t);
  let result = await repository.searchBranch(session, { query: 'NEEDLE', limit: 64 });
  assert.equal(result.matches.length, 0);
  assert(result.older);
  await assert.rejects(
    repository.searchBranch(session, { query: 'different', cursor: result.older }),
    /different query/
  );
  const matches = [];
  for (;;) {
    matches.push(...result.matches);
    if (!result.older) break;
    result = await repository.searchBranch(session, { query: 'NEEDLE', cursor: result.older, limit: 64 });
  }
  assert.equal(matches.length, 1);
  const entry = await repository.readBranchEntry(session, result.boundary, matches[0].entryId);
  assert.equal(entry.id, entries[0].id);
});

test('snapshot cursors remain stable after append and reject another branch, session, or rewritten leaf', async (t) => {
  const { repository, memory, session, entries, file, source } = await fixture(t, 5);
  const first = await repository.readBranchPage(session, { limit: 2 });
  const branch = await memory.branchFrom(session, entries[0].id, 'Alternative');
  const next = await memory.appendInput(session, { runId: 'branch-run', task: 'Different branch' });
  await appendFile(file, JSON.stringify(branch) + '\n' + JSON.stringify(next) + '\n');
  const older = await repository.readBranchPage(session, { cursor: first.older });
  assert.deepEqual(
    older.entries.map((entry) => entry.id),
    entries.slice(0, 3).map((entry) => entry.id)
  );
  await assert.rejects(
    repository.readBranchEntry(session, first.boundary, next.id),
    /outside the selected branch/
  );
  await assert.rejects(
    repository.readBranchPage(session, {
      cursor: { ...first.older, boundary: { ...first.boundary, sessionId: 'other' } }
    }),
    /does not match/
  );
  const alternate = await repository.readBranchPage(session, { leafId: branch.id });
  assert.deepEqual(
    alternate.entries.map((entry) => entry.id),
    [entries[0].id, branch.id]
  );
  const rewritten = source.replace('Input 4', 'Changed');
  await writeFile(file, rewritten + JSON.stringify(branch) + '\n' + JSON.stringify(next) + '\n');
  await assert.rejects(repository.readBranchPage(session, { cursor: first.older }), /does not match/);
});

test('oversized page entries stay available through explicit source reads', async (t) => {
  const { repository, session } = await fixture(t, 1);
  const page = await repository.readBranchPage(session);
  await assert.rejects(repository.readBranchPage(session, { maxBytes: 100 }), /read this entry explicitly/);
  assert.equal(
    (await repository.readBranchEntry(session, page.boundary, page.entries[0].id)).task,
    page.entries[0].task
  );
});
