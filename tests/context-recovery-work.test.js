import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModelRequest } from '@agent-core/model';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository, sourceRef } from '@agent-core/runtime';

const profile = {
  id: 'metadata-count', provider: 'metadata-count',
  capabilities: { streaming: false, toolCalling: false, jsonMode: false, jsonSchema: false,
    logprobs: false, temperature: false, topP: false },
  modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 64000, outputTokens: 1024 },
  supportedParameters: ['maxOutputTokens']
};

// Operation counts at the public history boundary, not timing or model-quality evidence.
// Session repository/index initialization is deliberately outside these counters.
test('one selected-metadata scan per captured cut is independent of released archive size', async t => {
  const evidence = [];
  for (const archiveSize of [100, 1000, 10000]) {
    const sessions = new InMemorySessionRepository();
    const session = await sessions.create({ binding: { schemaId: 'metadata-count', schemaVersion: 1, subject: {} } });
    const artifacts = new InMemoryArtifactRepository();
    let archived;
    for (let i = 0; i < archiveSize; i++) archived = await sessions.appendAssistant(session, {
      runId: `archive-${i}`, identity: { turnId: `turn-${i}`, turnIndex: 1, requestAttempt: 1 },
      content: `Released original ${i}: ${'x'.repeat(100)}`
    });
    const setup = new ContextService({ repository: sessions, session, artifacts,
      policy: { maxSourceBytes: 100000, selfContained: true } });
    await setup.transition({ expectedWindowId: null, expectedSourceRevision: (await setup.history.capture()).sourceRevision,
      selection: { strategy: 'sources', retained: [] }, reason: 'Explicitly release optional archived sources.', idempotencyKey: 'archive' });
    await sessions.appendInput(session, { runId: 'active', task: 'Fixed active input.' });
    await sessions.appendAssistant(session, { runId: 'active', identity: { turnId: 'active', turnIndex: 1, requestAttempt: 1 }, content: 'Fixed active response.' });
    const history = new HistoryReader({ repository: sessions, session, artifacts });
    let protection = [];
    const createContext = () => new ContextService({ repository: sessions, session, artifacts, history,
      policy: { maxSourceBytes: 100000, selfContained: true, protectedSources: () => protection } });
    const context = createContext();
    const counts = { pages: 0, scanned: 0, pointed: 0 };
    const page = history.metadataPage.bind(history);
    const metadata = history.metadata.bind(history);
    t.mock.method(history, 'metadataPage', async (...args) => {
      const result = await page(...args); counts.pages++; counts.scanned += result.scanned; return result;
    });
    t.mock.method(history, 'metadata', async (...args) => { counts.pointed++; return metadata(...args); });
    const request = { model: profile.id, messages: [{ role: 'user', content: 'Fixed active input.' }], maxOutputTokens: 512 };
    const compiled = await compileModelRequest({ request, body: request, profile,
      endpoint: 'fixture://metadata-count', providerInputTokens: 100 });
    const capture = await history.capture();
    // A fresh service per read is the uncached control for the same two public
    // operations. This isolates repeated selected-source work, not repository startup.
    await createContext().assertSourceCapacity(capture);
    await createContext().capacityFeedback(compiled);
    const uncached = { ...counts };
    Object.assign(counts, { pages: 0, scanned: 0, pointed: 0 });
    await context.assertSourceCapacity(capture);
    await context.capacityFeedback(compiled);
    const cold = { ...counts };
    await context.assertSourceCapacity(capture);
    await context.capacityFeedback(compiled);
    assert.deepEqual(counts, cold, 'Warm admission and feedback must reuse the exact-cut source facts.');
    evidence.push({ archiveSize, activeSources: 2, uncached, cold, warm: { pages: 0, scanned: 0, pointed: 0 } });
    assert.deepEqual(uncached, { pages: 2, scanned: 6, pointed: 0 });
    assert.equal(cold.pages, 1);
    assert.equal(cold.pointed, 0);
    assert.ok(cold.scanned <= 3);

    // Protection is policy, not source metadata: changes at the same cut must be fresh.
    protection = [sourceRef(session.id, archived)];
    const selection = await context.selectSources(capture, {});
    assert.ok(selection.retained.some(source => source.entryId === protection[0].entryId));
    assert.deepEqual(counts, cold);

    await sessions.appendInput(session, { runId: 'next-active', task: 'New mandatory input invalidates the cut.' });
    await context.assertSourceCapacity();
    assert.equal(counts.pages, cold.pages + 1);
    const updated = await context.selectSources(await history.capture(), {});
    assert.equal(updated.retained.length, 4, 'New active input and fresh protected archive source are both retained.');
  }
  assert.deepEqual(evidence[0].cold, evidence[1].cold);
  assert.deepEqual(evidence[1].cold, evidence[2].cold);
  t.diagnostic(JSON.stringify({ measurement: 'selected source metadata operations', evidence }));
});

test('JSONL cold reopen reads bounded projection paths while active metadata work stays bounded', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { JsonlSessionRepository } = await import('@agent-core/runtime/node');
  const evidence = [];
  for (const archiveSize of [100, 1000, 10000]) {
    const root = await mkdtemp(path.join(tmpdir(), 'recovery-source-counts-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const memory = new InMemorySessionRepository();
    const session = await memory.create({ binding: { schemaId: 'disk-metadata-count', schemaVersion: 1, subject: {} } });
    const artifacts = new InMemoryArtifactRepository();
    const archive = new Set();
    for (let i = 0; i < archiveSize; i++) {
      const entry = await memory.appendAssistant(session, { runId: `archive-${i}`,
        identity: { turnId: `turn-${i}`, turnIndex: 1, requestAttempt: 1 }, content: `Archived original ${i}: ${'x'.repeat(1024)}` });
      archive.add(entry.id);
    }
    const setup = new ContextService({ repository: memory, session, artifacts, policy: { maxSourceBytes: 100000, selfContained: true } });
    await setup.transition({ expectedWindowId: null, selection: { strategy: 'sources', retained: [] },
      reason: 'Release complete optional archive.', idempotencyKey: 'release' });
    await memory.appendInput(session, { runId: 'active', task: 'Fixed active input.' });
    await memory.appendAssistant(session, { runId: 'active', identity: { turnId: 'active', turnIndex: 1, requestAttempt: 1 }, content: 'Fixed active response.' });
    const writer = new JsonlSessionRepository(root);
    const file = writer.location(session.id);
    const records = (await memory.loadReplayState(session)).branch;
    await writeFile(file, [session.header, ...records].map(record => JSON.stringify(record) + '\n').join(''));
    await writer.rebuildHistoryIndex(session.id, session.header.binding);
    const repository = new JsonlSessionRepository(root);
    const history = new HistoryReader({ repository, session, artifacts });
    const context = new ContextService({ repository, session, history, artifacts, policy: { maxSourceBytes: 100000, selfContained: true } });
    const counts = { pages: 0, scanned: 0, archivedBodyReads: 0 };
    const metadataPage = history.metadataPage.bind(history);
    const readBranchEntry = repository.readBranchEntry.bind(repository);
    t.mock.method(history, 'metadataPage', async (...args) => {
      const page = await metadataPage(...args); counts.pages++; counts.scanned += page.scanned; return page;
    });
    t.mock.method(repository, 'readBranchEntry', async (...args) => {
      if (archive.has(args[2])) counts.archivedBodyReads++;
      return readBranchEntry(...args);
    });
    const request = { model: profile.id, messages: [{ role: 'user', content: 'Fixed active input.' }], maxOutputTokens: 512 };
    const compiled = await compileModelRequest({ request, body: request, profile, endpoint: 'fixture://disk-count', providerInputTokens: 100 });
    await context.assertSourceCapacity();
    await context.capacityFeedback(compiled);
    const cold = { ...counts, ...repository.historyReadMetrics(session.id) };
    await context.assertSourceCapacity();
    await context.capacityFeedback(compiled);
    const after = { ...counts, ...repository.historyReadMetrics(session.id) };
    const warm = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - cold[key]]));
    assert.equal(cold.pages, 1);
    assert.equal(cold.scanned, 3);
    assert.equal(cold.archivedBodyReads, 0);
    assert.equal(cold.scannedBytes, 0, 'Cold reopen restores the persisted index without scanning source bodies.');
    // The projection restores a bounded root and point/navigation paths, rather
    // than materializing one checkpoint per archived source. These fixed budgets
    // apply to every archive size in this test, including the 10,000-source case.
    assert.ok(cold.metadataRecordsRead > 0 && cold.metadataRecordsRead <= 256,
      `Cold metadata reads must stay bounded: ${cold.metadataRecordsRead}`);
    assert.ok(cold.metadataBytesRead > 0 && cold.metadataBytesRead <= 512 * 1024,
      `Cold metadata bytes must stay bounded: ${cold.metadataBytesRead}`);
    assert.ok(cold.bodyRecordsRead <= 2, 'Only the selected context record is read, not archived source bodies.');
    assert.equal(warm.pages, 0);
    assert.equal(warm.scanned, 0);
    assert.equal(warm.archivedBodyReads, 0);
    assert.equal(warm.indexedRecords, 0);
    assert.equal(warm.scannedBytes, 0);
    assert.equal(warm.headerBytesRead, 0);
    assert.equal(warm.bodyBytesRead, 0);
    assert.equal(warm.bodyRecordsRead, 0);
    // Current-root point paths are rechecked; immutable historical metadata and
    // selected-source facts are reused without scanning the released archive.
    assert.ok(warm.metadataRecordsRead <= 32, JSON.stringify(warm));
    assert.ok(warm.metadataBytesRead <= 128 * 1024, JSON.stringify(warm));
    evidence.push({ archiveSize, activeSources: 2, indexedEntries: records.length, cold, warm });
  }
  t.diagnostic(JSON.stringify({ measurement: 'JSONL cold reopen and warm source checks', evidence }));
});
