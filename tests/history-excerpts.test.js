import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderContextState } from '@agent-core/model';
import { HistoryReader, InMemorySessionRepository, sourceRef } from '@agent-core/runtime';

async function fixture() {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'tests/excerpts', schemaVersion: 1, subject: {} } });
  const history = new HistoryReader({ repository, session });
  return { repository, session, history };
}
const identity = { turnId: 'turn', turnIndex: 1, requestAttempt: 1 };

test('exact history excerpts merge overlaps and adjacency in original source order', async () => {
  const f = await fixture();
  const first = await f.repository.appendInput(f.session, { runId: 'r1', task: 'first evidence' });
  const second = await f.repository.appendInput(f.session, { runId: 'r2', task: 'second evidence' });
  const cut = await f.history.capture();
  const one = sourceRef(f.session.id, first), two = sourceRef(f.session.id, second);
  const excerpts = [
    { source: two, offset: 0, bytes: 6 },
    { source: one, offset: 3, bytes: 5 },
    { source: one, offset: 0, bytes: 5 },
    { source: one, offset: 8, bytes: 6 }
  ];
  const items = await f.history.readExcerpts(excerpts, cut);
  assert.deepEqual(items.map(item => item.text), ['first evidence', 'second']);
  assert.deepEqual(items.map(item => item.role), ['user', 'user']);
  assert.deepEqual(await f.history.canonicalizeExcerpts(excerpts, cut), [
    { source: one, offset: 0, bytes: 14 }, { source: two, offset: 0, bytes: 6 }
  ]);
});

test('history excerpts reject changed identities, invalid UTF-8 spans and out-of-range selections', async () => {
  const f = await fixture();
  const entry = await f.repository.appendInput(f.session, { runId: 'r', task: 'a😀b' });
  const source = sourceRef(f.session.id, entry), cut = await f.history.capture();
  assert.equal((await f.history.readExcerpts([{ source, offset: 1, bytes: 4 }], cut))[0].text, '😀');
  for (const [offset, bytes] of [[2, 3], [1, 1], [0, 7], [8, 1]])
    await assert.rejects(f.history.readExcerpts([{ source, offset, bytes }], cut), /UTF-8|original text|character/);
  await assert.rejects(f.history.readExcerpts([{ source: { ...source, sha256: '0'.repeat(64) }, offset: 0, bytes: 1 }], cut), /source|branch/i);
  await assert.rejects(f.history.readExcerpts([{ source, offset: 0, bytes: 1 }], cut, 8), /byte|limit/i);
  const later = await f.repository.appendInput(f.session, { runId: 'later', task: 'later' });
  await assert.rejects(f.history.readExcerpts([{ source: sourceRef(f.session.id, later), offset: 0, bytes: 1 }], cut), /branch/);
});

test('assistant excerpts expose only attributed original answer text, never provider state', async () => {
  const f = await fixture();
  await f.repository.appendInput(f.session, { runId: 'r', task: 'Question' });
  const state = await createProviderContextState({ protocolRevision: 'v1', provider: 'native', endpoint: 'https://native.example', request: { model: 'm', messages: [{ role: 'user', content: 'Question' }] }, requestId: 'request', kind: 'signed', requiresExactPrefix: true, data: { secret: 'OPAQUE STATE' } });
  const entry = await f.repository.appendAssistant(f.session, { runId: 'r', identity, content: 'Original answer.', output: [{ type: 'text', text: 'Original answer.' }, { type: 'protocol', state }] });
  const result = await f.history.readExcerpts([{ source: sourceRef(f.session.id, entry), offset: 0, bytes: 8 }], await f.history.capture());
  assert.deepEqual(result.map(item => [item.role, item.type, item.text]), [['assistant', 'assistant', 'Original']]);
  assert(!JSON.stringify(result).includes('OPAQUE STATE'));
});

test('observation evidence excerpts use the same safe text representation as exact source reads', async () => {
  const f = await fixture();
  await f.repository.appendInput(f.session, { runId: 'r', task: 'Read evidence' });
  const entry = await f.repository.appendObservation(f.session, {
    runId: 'r', identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call', toolAttempt: 1 }, toolName: 'read',
    observation: { kind: 'result', summary: 'Evidence', output: { result: 'needle' } }
  });
  const source = sourceRef(f.session.id, entry), cut = await f.history.capture();
  const original = await f.history.read({ source, cut });
  const offset = Buffer.byteLength(original.item.text.slice(0, original.item.text.indexOf('needle')));
  const [item] = await f.history.readExcerpts([{ source, offset, bytes: 6 }], cut);
  assert.equal(item.text, 'needle');
  assert.equal(item.role, 'tool');
  assert.equal(item.type, 'observation');
  assert.deepEqual(item.excerpt.source, source);
});
