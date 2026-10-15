import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventRepository } from '@agent-core/persistence';
import { HistoryReader, InMemorySessionRepository, agentEventCodec, sourceRef, createHistoryTools } from '@agent-core/runtime';

async function fixture() {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'tests/latest', schemaVersion: 1, subject: {} } });
  return { repository, session };
}

test('latest user contributions are newest first with cache-free stable-cut pagination', async () => {
  const f = await fixture();
  const originals = [];
  for (let i = 0; i < 7; i++) {
    originals.push(await f.repository.appendInput(f.session, { runId: `run-${i}`, task: `user ${i}` }));
    await f.repository.appendAssistant(f.session, { runId: `run-${i}`, identity: { turnId: `turn-${i}`, turnIndex: 1, requestAttempt: 1 }, content: `assistant ${i}` });
  }
  const first = await new HistoryReader(f).latest({ limit: 2 });
  assert.deepEqual(first.items.map(x => x.text), ['user 6', 'user 5']);
  assert.equal(first.coverage, 'partial');
  await f.repository.appendInput(f.session, { runId: 'later', task: 'not in cut' });
  const items = [...first.items];
  let cursor = first.cursor;
  while (cursor) {
    const page = await new HistoryReader(f).latest({ cursor, limit: 2, maxScanned: 3 });
    assert.deepEqual(page.cut, first.cut);
    assert(page.scanned <= 3);
    items.push(...page.items);
    cursor = page.cursor;
  }
  assert.deepEqual(items.map(x => x.text), originals.map(x => x.task).reverse());
  assert(items.every(x => x.role === 'user'));
  assert.deepEqual(items.map(x => x.source), originals.map(x => sourceRef(f.session.id, x)).reverse());
  await assert.rejects(new HistoryReader(f).latest({ cursor: first.cursor, filter: { role: 'assistant' } }), /filter mismatch/);
  await assert.rejects(new HistoryReader(f).latest({ cursor: first.cursor, cut: await new HistoryReader(f).capture() }), /cut mismatch/);
});

test('latest includes ledger-only steering and preserves event identity and original roles', async () => {
  const f = await fixture();
  await f.repository.appendInput(f.session, { runId: 'run', task: 'original task' });
  const events = new InMemoryEventRepository(agentEventCodec);
  const accepted = await events.append('run', { type: 'input.steering.accepted', deliveryId: 'correction', content: 'corrected task' });
  await events.append('run', { type: 'input.steering.local_applied', deliveryId: 'correction' });
  const options = { ...f, events };
  const first = await new HistoryReader(options).latest({ maxScanned: 1 });
  assert.equal(first.items.length, 0);
  assert.equal(first.coverage, 'partial');
  const second = await new HistoryReader(options).latest({ cursor: first.cursor, maxScanned: 1 });
  assert.equal(second.items[0].text, 'corrected task');
  assert.equal(second.items[0].role, 'user');
  assert.equal(second.items[0].source.event.eventId, accepted.eventId);
  assert.equal(second.items[0].source.sha256, accepted.hash);
  const third = await new HistoryReader(options).latest({ cursor: second.cursor });
  assert.deepEqual(third.items.map(x => x.text), ['original task']);
  assert.equal(third.coverage, 'complete');
});

test('latest makes byte-limited gaps and abbreviated context explicit', async () => {
  const f = await fixture();
  const big = await f.repository.appendInput(f.session, { runId: 'large', task: 'x'.repeat(10000) });
  const small = await f.repository.appendInput(f.session, { runId: 'small', task: 'small' });
  const reader = new HistoryReader(f);
  const page = await reader.latest({ maxScannedBytes: 3000 });
  assert.deepEqual(page.items.map(x => x.text), ['small']);
  assert.equal(page.coverage, 'partial');
  assert.equal(page.unread[0].source.entryId, big.id);
  const read = await reader.read({ source: sourceRef(f.session.id, small), neighbors: 1, maxBytes: 5 });
  assert.equal(read.neighborsCoverage, 'partial');
  const controller = new AbortController();
  controller.abort(new Error('stop latest'));
  await assert.rejects(reader.latest({ signal: controller.signal }), /stop latest/);
  assert(createHistoryTools({ history: reader }).some(tool => tool.name === 'history_latest'));
});

test('latest output bounds preserve exact source identity when text is truncated', async () => {
  const f = await fixture();
  const original = await f.repository.appendInput(f.session, { runId: 'run', task: '😀'.repeat(10000) });
  const reader = new HistoryReader(f);
  const result = await reader.latest({ maxBytes: 2000 });
  assert(result.bytes <= 2000);
  assert.equal(result.items[0].truncated, true);
  assert.deepEqual(result.items[0].source, sourceRef(f.session.id, original));
  assert(!result.items[0].text.includes('�'));
  const full = await reader.read({ source: result.items[0].source, cut: result.cut, maxBytes: 50000 });
  assert.equal(full.item.text, original.task);
});

test('latest chronological context can remain on its captured cut after append', async () => {
  const f = await fixture();
  await f.repository.appendInput(f.session, { runId: 'r1', task: 'question' });
  const response = await f.repository.appendAssistant(f.session, { runId: 'r1', identity: { turnId: 't1', turnIndex: 1, requestAttempt: 1 }, content: 'answer' });
  const reader = new HistoryReader(f);
  const page = await reader.latest({ filter: { role: 'assistant' } });
  assert.equal(page.items[0].role, 'assistant');
  await f.repository.appendInput(f.session, { runId: 'r2', task: 'later question' });
  const context = await reader.read({ source: sourceRef(f.session.id, response), cut: page.cut, neighbors: 5 });
  assert.deepEqual(context.neighbors.map(x => [x.role, x.text]), [['user', 'question']]);
  assert.equal(context.neighborsCoverage, 'complete');
});

test('latest continuation never erases an earlier unread gap', async () => {
  const f = await fixture();
  await f.repository.appendInput(f.session, { runId: 'small', task: 'small' });
  await f.repository.appendInput(f.session, { runId: 'big', task: 'x'.repeat(10000) });
  const first = await new HistoryReader(f).latest({ maxScanned: 1, maxScannedBytes: 3000 });
  assert.equal(first.unread.length, 1);
  const last = await new HistoryReader(f).latest({ cursor: first.cursor });
  assert.equal(last.items[0].text, 'small');
  assert.equal(last.cursor, undefined);
  assert.equal(last.coverage, 'partial');
});
