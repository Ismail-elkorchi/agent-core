import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import { parseToolObservation, encodeToolObservation } from '@agent-core/tools';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { agentEventCodec, HistoryReader, InMemorySessionRepository, sourceRef } from '@agent-core/runtime';

const binding = { schemaId: 'tests/bounded-search', schemaVersion: 1, subject: {} };
function terminal(runId) {
  return {
    runId,
    finalizationId: `final-${runId}`,
    phase: 'ended',
    executionStatus: 'completed',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 },
    turnCount: 1,
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0
    }
  };
}
async function fixture(count = 1000) {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding });
  for (let i = 0; i < count; i++) {
    await repository.appendInput(session, { runId: `run-${i}`, task: `common 文😀 entry ${i}` });
    if (i === 0) await repository.recordRunFinalization(session, terminal(`run-${i}`));
  }
  let reads = 0;
  const original = repository.readBranchEntry.bind(repository);
  repository.readBranchEntry = (...args) => { reads++; return original(...args); };
  return { repository, session, reads: () => reads };
}

test('model search bounds common and short queries and resumes without skipped originals', async () => {
  const f = await fixture(40);
  const history = new HistoryReader(f);
  await history.search({ query: 'missing' });
  for (const query of ['c', '文😀', 'common']) {
    let cursor;
    const ids = [];
    do {
      const page = await history.search({ query, cursor, maxCandidates: 3, maxPostings: 2 });
      assert(page.candidates <= 3);
      assert(page.postings <= 2);
      ids.push(...page.items.map(x => x.source.entryId));
      cursor = page.cursor;
    } while (cursor);
    assert.equal(ids.length, 40);
    assert.equal(new Set(ids).size, 40);
  }
});

test('UI bounded empty batches warm the projection and repeated 1000-input misses read no bodies', async () => {
  const f = await fixture();
  let page = await f.repository.searchBranch(f.session, { query: 'absent', maxIndexEntries: 7 });
  assert.equal(page.coverage, 'partial');
  assert.equal(page.matches.length, 0);
  assert(page.older);
  while (page.older) {
    page = await f.repository.searchBranch(f.session, { query: 'absent', cursor: page.older, maxIndexEntries: 7 });
    assert(page.indexed <= 7);
  }
  const baseline = f.reads();
  for (let i = 0; i < 3; i++) {
    const miss = await f.repository.searchBranch(f.session, { query: 'absent' });
    assert.equal(miss.coverage, 'complete');
    assert.equal(miss.scannedBytes, 0);
    assert.equal(miss.indexed, 0);
  }
  assert.equal(f.reads(), baseline);
});

test('search cancellation rejects instead of publishing a misleading empty result', async () => {
  const f = await fixture(4);
  const controller = new AbortController();
  controller.abort(new Error('cancel search'));
  await assert.rejects(f.repository.searchBranch(f.session, { query: 'common', signal: controller.signal }), /cancel search/);
  await assert.rejects(new HistoryReader(f).search({ query: 'common', signal: controller.signal }), /cancel search/);
});

test('hash collisions are candidates only and original text must match', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding });
  await repository.appendInput(session, { runId: 'collision', task: '恝꿜Ჿ' });
  const history = new HistoryReader({ repository, session });
  await history.search({ query: 'warmup' });
  const result = await history.search({ query: '䫽匼ؿ' });
  assert.equal(result.candidates, 1);
  assert.equal(result.items.length, 0);
  assert.equal(result.coverage, 'complete');
  await repository.searchBranch(session, { query: 'warmup' });
  const ui = await repository.searchBranch(session, { query: '䫽匼ؿ' });
  assert.equal(ui.candidates, 1);
  assert.equal(ui.matches.length, 0);
  assert.equal(ui.coverage, 'complete');
});

test('captured UI search excludes appended and sibling originals with bounded continuation', async () => {
  const f = await fixture(8);
  const old = await f.repository.searchBranch(f.session, { query: 'common', maxIndexEntries: 2, limit: 1 });
  const first = (await f.repository.readBranchPage(f.session, { limit: 8 })).entries[0];
  await f.repository.branchFrom(f.session, first.id, 'fork');
  await f.repository.appendInput(f.session, { runId: 'new-fork', task: 'common sibling' });
  let page = old;
  const ids = [];
  do {
    ids.push(...page.matches.map(x => x.entryId));
    if (!page.older) break;
    page = await f.repository.searchBranch(f.session, { query: 'common', cursor: page.older, maxCandidates: 1, maxIndexEntries: 2 });
  } while (true);
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, 8);
  let current = await f.repository.searchBranch(f.session, { query: 'common', maxCandidates: 1 });
  const currentIds = [];
  for (let steps = 0; ; steps++) {
    assert(steps < 30, 'fork-only candidates must advance continuation');
    currentIds.push(...current.matches.map(x => x.entryId));
    if (!current.older) break;
    current = await f.repository.searchBranch(f.session, { query: 'common', cursor: current.older, maxCandidates: 1 });
  }
  assert.equal(currentIds.length, 2);
});

test('single-source cold search, filtered misses, and build-byte pauses retain truthful coverage', async () => {
  const f = await fixture(1);
  const history = new HistoryReader(f);
  assert.equal((await history.search({ query: 'common' })).items.length, 1);
  const filtered = await history.search({ query: 'common', filter: { role: 'tool' }, maxIndexEntries: 1 });
  assert.equal(filtered.items.length, 0);
  assert.equal(filtered.scannedBytes, 0);
  const partial = await f.repository.searchBranch(f.session, { query: 'common', maxIndexBytes: 1 });
  assert.equal(partial.coverage, 'partial');
  assert.equal(partial.indexBytes, 0);
  assert(partial.older);
  const resumed = await f.repository.searchBranch(f.session, { query: 'common', cursor: partial.older });
  assert.equal(resumed.matches.length, 1);
});

test('selective multi-gram warm search verifies only its narrow candidate', async () => {
  const f = await fixture(100);
  await f.repository.appendInput(f.session, { runId: 'selective', task: 'unique-selective-needle' });
  const history = new HistoryReader(f);
  await history.search({ query: 'absent' });
  const baseline = f.reads();
  const result = await history.search({ query: 'unique-selective-needle' });
  assert.equal(result.items.length, 1);
  assert.equal(result.candidates, 1);
  assert.equal(f.reads() - baseline, 1);
});

test('UI append extends a warmed branch by only its new source', async () => {
  const f = await fixture(100);
  let page = await f.repository.searchBranch(f.session, { query: 'absent' });
  while (page.older) page = await f.repository.searchBranch(f.session, { query: 'absent', cursor: page.older });
  await f.repository.appendInput(f.session, { runId: 'appended', task: 'absent only in old history' });
  const extended = await f.repository.searchBranch(f.session, { query: 'absent' });
  assert.equal(extended.indexed, 1);
  assert.equal(extended.matches.length, 1);
  assert.equal(extended.coverage, 'complete');
});

test('older open-run tail replacement consumes bounded build work and retains immutable cuts', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding });
  const events = new InMemoryEventRepository(agentEventCodec);
  for (let at = 0; at < 8; at++) await repository.appendInput(session, { runId: `open-${at}`, task: `match input ${at}` });
  const history = new HistoryReader({ repository, session, events });
  const old = await history.search({ query: 'match' });
  await events.append('open-0', { type: 'assistant.ended', turnId: 'turn', turnIndex: 1, requestAttempt: 1,
    content: 'match late output', modelOutput: { status: 'complete', message: 'match late output', source: 'content', turnIndex: 1 } });
  let page = await history.search({ query: 'match', maxIndexEntries: 1 });
  assert.equal(page.coverage, 'partial');
  const texts = [];
  for (let steps = 0; ; steps++) {
    assert(steps < 50);
    assert(page.indexed <= 1);
    texts.push(...page.items.map(x => x.text));
    if (!page.cursor) break;
    page = await history.search({ query: 'match', cursor: page.cursor, maxIndexEntries: 1 });
  }
  assert.equal(texts.length, 9);
  assert.equal(texts[1], 'match late output');
  assert.equal((await history.search({ query: 'late output', cut: old.cut })).items.length, 0);
});

test('capture rejects a terminal proof that conflicts with the recorded finalization', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding });
  const events = new InMemoryEventRepository(agentEventCodec);
  await repository.appendInput(session, { runId: 'run', task: 'original' });
  await repository.recordRunFinalization(session, terminal('run'));
  await events.append('run', { type: 'run.ended', terminal: { ...terminal('run'),
    modelOutput: { status: 'complete', message: 'conflicting terminal', source: 'content', turnIndex: 1 } } });
  await assert.rejects(new HistoryReader({ repository, session, events }).capture(), /does not match its recorded session finalization/);
  assert.equal(await (await repository.sourceSnapshot(session)).confirmedHead('run'), undefined);
});

test('UI excerpts never split Unicode surrogate pairs at either boundary', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding });
  await repository.appendInput(session, { runId: 'unicode', task: `${'😀'.repeat(40)}xneedle${'x'}${'😀'.repeat(80)}` });
  const result = await repository.searchBranch(session, { query: 'needle' });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].excerpt.isWellFormed(), true);
});

test('model restart during bounded tail invalidation still searches the retained prefix', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding });
  const events = new InMemoryEventRepository(agentEventCodec);
  await repository.appendInput(session, { runId: 'settled-prefix', task: 'match retained prefix' });
  await repository.recordRunFinalization(session, terminal('settled-prefix'));
  await events.append('settled-prefix', { type: 'run.ended', terminal: terminal('settled-prefix') });
  for (let at = 0; at < 4; at++) await repository.appendInput(session, { runId: `open-tail-${at}`, task: `match tail ${at}` });
  const options = { repository, session, events };
  const history = new HistoryReader(options);
  await history.search({ query: 'match' });
  await events.append('open-tail-0', { type: 'assistant.ended', turnId: 'turn', turnIndex: 1, requestAttempt: 1,
    content: 'match added output', modelOutput: { status: 'complete', message: 'match added output', source: 'content', turnIndex: 1 } });
  let result = await history.search({ query: 'match', maxIndexEntries: 1 });
  const texts = [];
  for (let steps = 0; ; steps++) {
    assert(steps < 50);
    texts.push(...result.items.map(item => item.text));
    if (!result.cursor) break;
    result = await new HistoryReader(options).search({ query: 'match', cursor: result.cursor, maxIndexEntries: 1 });
  }
  assert.equal(texts.length, 6);
  assert.equal(new Set(texts).size, 6);
  assert.equal(texts[0], 'match retained prefix');
});

test('artifact hydration preserves persisted source identity across warm search and read', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding });
  const artifacts = new InMemoryArtifactRepository();
  await repository.appendInput(session, { runId: 'artifact', task: 'inspect original' });
  const observation = parseToolObservation({ outputSchema: z.json() }, {
    kind: 'result', summary: 'original output', output: { text: 'artifact-only-needle' },
    scope: { resources: [], coverage: 'complete' }
  });
  const artifact = await artifacts.store({ label: 'original',
    content: Buffer.from(JSON.stringify(encodeToolObservation(observation))), mediaType: 'application/json' });
  const original = await repository.appendObservation(session, {
    runId: 'artifact', identity: { turnId: 'turn', turnIndex: 1, requestAttempt: 1,
      toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 }, toolName: 'inspect',
    observation: { kind: 'result', summary: 'original output', originalArtifact: artifact }
  });
  const history = new HistoryReader({ repository, session, artifacts });
  const first = await history.search({ query: 'artifact-only-needle' });
  assert.equal(first.items.length, 1);
  assert.deepEqual(first.items[0].source, sourceRef(session.id, original));
  const warm = await history.search({ query: 'artifact-only-needle' });
  assert.equal(warm.items.length, 1);
  const read = await history.read({ source: first.items[0].source });
  assert.equal(read.status, 'available');
  assert.match(read.item.text, /artifact-only-needle/);
});
