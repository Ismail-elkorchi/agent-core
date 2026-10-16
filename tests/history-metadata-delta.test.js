import { admitContext } from './context-admission-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { InMemorySessionRepository, HistoryReader, ContextService, agentEventCodec } from '@agent-core/runtime';

async function fixture() {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding: { schemaId: 'metadata-delta', schemaVersion: 1, subject: {} } });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const policy = { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } };
  const context = new ContextService({ repository: sessions, session, artifacts, history, policy });
  await sessions.appendInput(session, { runId: 'run', task: 'Original' });
  const answer = async (i, mirror = true) => {
    const identity = { turnId: `turn-${i}`, turnIndex: i + 1, requestAttempt: 1 };
    const receipt = await events.append('run', { type: 'assistant.ended', ...identity, content: `Answer ${i}`,
      modelOutput: { status: 'complete', message: `Answer ${i}`, source: 'content', turnIndex: i + 1 } });
    if (mirror) await sessions.appendAssistant(session, { runId: 'run', identity, content: `Answer ${i}`,
      source: { runId: 'run', eventId: receipt.eventId, sequence: receipt.sequence, hash: receipt.hash } });
    return { identity, receipt };
  };
  return { sessions, session, events, history, context, policy, answer };
}

test('metadata deltas skip the old run mirror prefix and preserve bounded continuation', async () => {
  const f = await fixture();
  for (let i = 0; i < 100; i++) await f.answer(i);
  const after = await f.history.capture();
  await f.answer(100);
  await f.sessions.appendInput(f.session, { runId: 'next', task: 'Next input' });
  const cut = await f.history.capture();
  const snapshot = f.sessions.sourceSnapshot.bind(f.sessions);
  let visits = 0;
  f.sessions.sourceSnapshot = async (...args) => {
    const value = await snapshot(...args);
    return { ...value, entries: { length: value.entries.length,
      at: async index => { visits++; return value.entries.at(index); },
      [Symbol.asyncIterator]: value.entries[Symbol.asyncIterator].bind(value.entries) } };
  };
  let cursor;
  const items = [];
  do {
    const page = await f.history.metadataPage({ after, cut, cursor, limit: 1 });
    assert.ok(page.scanned <= 1);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(items.map(item => item.description), ['Answer 100', 'Next input']);
  assert.ok(visits < 20, `Visited ${visits} old metadata positions`);
});

test('selected metadata extends with only new metadata and still enforces updated capacity', async () => {
  const f = await fixture();
  for (let i = 0; i < 30; i++) await f.answer(i);
  await f.context.assertSourceCapacity();
  const read = f.events.readMetadataRange.bind(f.events);
  let records = 0;
  f.events.readMetadataRange = async (...args) => { const page = await read(...args); records += page.records.length; return page; };
  for (let i = 30; i < 35; i++) { await f.answer(i); await f.context.assertSourceCapacity(); }
  assert.ok(records <= 10, `Re-read ${records} historical records`);
  f.policy.maxSourceBytes = 1;
  await assert.rejects(f.context.assertSourceCapacity(), /capacity|source/i);
});

test('late assistant mirrors refresh cached facts even without a receipt', async () => {
  const f = await fixture();
  const { identity, receipt } = await f.answer(0, false);
  await f.context.assertSourceCapacity();
  await f.sessions.appendAssistant(f.session, { runId: 'run', identity, content: 'Answer 0',
    output: [{ type: 'tool_call', toolCall: { id: 'call', type: 'function', name: 'lookup',
      input: { kind: 'json', value: {} } } }] });
  const cut = await f.history.capture();
  const updates = [];
  // The public metadata-update traversal must preserve mirror enrichment before cache reuse.
  // Force a fresh read to compare the cached selection to the authoritative metadata source.
  const source = { sessionId: f.session.id, entryId: `event:${receipt.eventId}`, sha256: receipt.hash,
    event: { runId: 'run', eventId: receipt.eventId, sequence: receipt.sequence, hash: receipt.hash } };
  const item = await f.history.metadata(source, cut);
  assert.equal(item.expectedCalls, 1);
  const metadata = f.history.metadataUpdates.bind(f.history);
  f.history.metadataUpdates = async function* (...args) { for await (const item of metadata(...args)) { updates.push(item); yield item; } };
  await f.context.assertSourceCapacity(cut);
  assert.equal(updates.find(item => item.source.entryId === source.entryId)?.expectedCalls, 1);
});

test('a changed selection and later mirrors cannot resurrect released sources', async () => {
  const f = await fixture();
  const { identity } = await f.answer(0, false);
  await f.context.assertSourceCapacity();
  const cut = await f.history.capture();
  const retained = await f.context.protectedSources(cut);
  await f.context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'release', reason: 'Release completed answer', renewal: true, selection: { retained } },
    { admit: admitContext });
  await f.context.assertSourceCapacity();
  await f.sessions.appendAssistant(f.session, { runId: 'run', identity, content: 'Answer 0' });
  const selected = await f.context.selectSources(await f.history.capture(), {});
  assert.equal(selected.retained.some(source => source.entryId.startsWith('event:')), false);
});

test('an exact cached cut is revalidated after branch replacement', async () => {
  const f = await fixture();
  const cut = await f.history.capture();
  const retained = await f.context.protectedSources(cut);
  const point = await f.context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'branch-point', reason: 'Branch point', renewal: true, selection: { retained } },
    { admit: admitContext });
  await f.answer(0);
  const stale = await f.history.capture();
  await f.context.assertSourceCapacity(stale);
  await f.sessions.branchFrom(f.session, point.id, 'Replacement');
  await assert.rejects(f.context.assertSourceCapacity(stale), /authorized branch|inherited fork boundary/);
  const selected = await f.context.selectSources(await f.history.capture(), {});
  assert.equal(selected.retained.some(source => source.entryId.startsWith('event:')), false);
});

test('a newly authoritative ledger replaces previously selected session originals', async () => {
  const f = await fixture();
  const identity = { turnId: 'turn-0', turnIndex: 1, requestAttempt: 1 };
  const mirror = await f.sessions.appendAssistant(f.session, { runId: 'run', identity, content: 'Answer 0' });
  await f.context.assertSourceCapacity();
  await f.answer(0, false);
  const selected = await f.context.selectSources(await f.history.capture(), {});
  assert.equal(selected.retained.some(source => source.entryId === mirror.id), false);
  assert.equal(selected.retained.filter(source => source.entryId.startsWith('event:')).length, 1);
});
