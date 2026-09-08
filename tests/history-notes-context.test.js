import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createProviderContextState } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { LocalArtifactRepository, JsonlEventRepository } from '@agent-core/persistence/node';
import { AgentSession, AgentRunCoordinator, ContextService, HistoryReader, InMemorySessionRepository, InMemoryNoteRepository, agentEventCodec, createHistoryTools, createNotesTools, createContextTools, sourceRef, historySourceAfterCut } from '@agent-core/runtime';
import { JsonlSessionRepository, JsonlNoteRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/history', schemaVersion: 1, subject: { app: 'neutral' } };
const scope = { sessionId: 'session', branchId: 'session' };
const identity = { turnId: 'turn', turnIndex: 1, requestAttempt: 1 };
function terminal(runId) {
  return { runId, finalizationId: `final-${runId}`, phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [],
    budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, revisionAttempts: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0 } };
}
function writeRequest(overrides = {}) { return { scope, noteId: 'entry', title: 'Working note', mediaType: 'text/markdown', content: 'Hypothesis, not authority.', expectedRevision: null, idempotencyKey: 'write-1', authorId: 'model', invocationId: 'invocation-1', ...overrides }; }
async function backend(kind) {
  if (kind === 'memory') return { sessions: new InMemorySessionRepository(), notes: new InMemoryNoteRepository(), events: new InMemoryEventRepository(agentEventCodec) };
  const root = await mkdtemp(path.join(tmpdir(), 'agent-history-'));
  const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
  return { root, sessions: new JsonlSessionRepository(path.join(root, 'sessions')), notes: new JsonlNoteRepository({ rootDir: path.join(root, 'notes'), artifacts }), events: new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec }), artifacts };
}
for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: 1000 completed original inputs remain searchable with bounded pages and stable cuts`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ id: 'session', binding });
    let first;
    for (let i = 0; i < 1000; i++) {
      const entry = await sessions.appendInput(session, { runId: `run-${i}`, task: `${'x'.repeat(900)} original-${i} keep original Unicode: 改正` });
      if (i === 0) first = entry;
      await sessions.appendAssistant(session, { runId: `run-${i}`, identity: { ...identity, turnId: `turn-${i}` }, content: `answer-${i}` });
      await sessions.recordRunFinalization(session, terminal(`run-${i}`));
    }
    const history = new HistoryReader({ repository: sessions, session });
    let page = await history.search({ query: 'original-', maxScanned: 37, limit: 11, maxBytes: 8192 });
    const cut = page.cut;
    const sources = [];
    while (true) {
      assert.ok(page.scanned <= 37); assert.ok(page.bytes <= 8192); assert.ok(page.items.length <= 11);
      sources.push(...page.items.map((item) => item.source));
      if (!page.cursor) break;
      page = await history.search({ query: 'original-', cursor: page.cursor, maxScanned: 37, limit: 11, maxBytes: 8192 });
    }
    assert.equal(sources.length, 1000);
    assert.equal(new Set(sources.map((item) => item.entryId)).size, 1000);
    await sessions.appendInput(session, { runId: 'later', task: 'original-later must stay after captured cut' });
    const old = await history.search({ query: 'original-later', cut });
    assert.equal(old.items.length, 0);
    const exact = await history.read({ source: sourceRef(session.id, first), maxBytes: 8192 });
    assert.equal(exact.status, 'available'); assert.equal(exact.item.text, first.task);
    const wrong = await history.read({ source: { ...sources[0], sha256: '0'.repeat(64) } });
    assert.equal(wrong.status, 'unavailable'); assert.equal(wrong.reason, 'identity_mismatch');
    if (kind === 'jsonl') assert.ok(sessions.indexMetrics().fullScans <= 1, 'JSONL cache must not rescan the file per page');
  });

  test(`${kind}: accepted input owns original context attachments and strict branch scope`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ id: 'session', binding });
    const input = { task: 'Original input', instructions: ['original instruction'], contextItems: [{ sourceUri: 'test:attachment', sourceKind: 'external', representation: 'full', mediaType: 'text/plain', title: 'attachment', content: 'unmodified attachment', purpose: 'reference' }] };
    await sessions.enqueueSubmission(session, { submissionId: 'submission', runId: 'run', input, configuration: { provider: 'test', model: 'test' } });
    input.task = 'mutated'; input.contextItems[0].content = 'mutated';
    const first = await sessions.appendInput(session, { runId: 'run', task: 'runtime transformed task' });
    await sessions.recordRunFinalization(session, terminal('run'));
    assert.equal(first.originalInput.task, 'Original input'); assert.equal(first.originalInput.contextItems[0].content, 'unmodified attachment');
    const secret = await sessions.appendInput(session, { runId: 'parent-later', task: 'sibling-only secret' });
    await sessions.recordRunFinalization(session, terminal('parent-later'));
    await sessions.branchFrom(session, first.id);
    const reader = new HistoryReader({ repository: sessions, session });
    assert.equal((await reader.search({ query: 'sibling-only' })).items.length, 0);
    assert.equal((await reader.read({ source: sourceRef(session.id, secret) })).status, 'unavailable');
    assert.equal((await reader.read({ source: { ...sourceRef(session.id, first), sessionId: 'other' } })).reason, 'outside_scope');
  });

  test(`${kind}: note CAS, idempotency, pinned inheritance, tombstones and exact historical reads`, async () => {
    const { notes } = await backend(kind);
    const initial = await notes.write(writeRequest());
    assert.equal(initial.status, 'committed');
    const retry = await notes.write(writeRequest()); assert.equal(retry.revision.revisionId, initial.revision.revisionId);
    await assert.rejects(notes.write(writeRequest({ content: 'conflicting retry' })), /idempotency/u);
    const concurrent = await Promise.all([
      notes.write(writeRequest({ expectedRevision: initial.revision.revisionId, idempotencyKey: 'left', content: 'left' })),
      notes.write(writeRequest({ expectedRevision: initial.revision.revisionId, idempotencyKey: 'right', content: 'right' }))
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'committed').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'conflict').length, 1);
    const parent = (await notes.read({ scope, noteId: 'entry' })).revision;
    const child = { sessionId: scope.sessionId, branchId: 'child' };
    await notes.fork({ scope: child, parentScope: scope });
    const next = await notes.write(writeRequest({ expectedRevision: parent.revisionId, idempotencyKey: 'parent-next', content: 'parent only' }));
    assert.equal((await notes.read({ scope: child, noteId: 'entry' })).revision.revisionId, parent.revisionId);
    assert.equal((await notes.read({ scope: child, noteId: 'entry', revisionId: next.revision.revisionId })).status, 'missing');
    const removed = await notes.remove({ scope: child, noteId: 'entry', expectedRevision: parent.revisionId, idempotencyKey: 'remove', authorId: 'model', invocationId: 'invocation-2' });
    assert.equal(removed.status, 'committed'); assert.equal((await notes.read({ scope: child, noteId: 'entry' })).status, 'tombstone');
    assert.equal((await notes.read({ scope: child, noteId: 'entry', revisionId: parent.revisionId })).status, 'available');
    assert.equal((await notes.read({ scope, noteId: 'entry' })).text, 'parent only');
    assert.equal((await notes.list({ scope: child })).items.length, 0);
    const duplicate = writeRequest({ noteId: 'parallel', idempotencyKey: 'parallel' });
    const same = await Promise.all([notes.write(duplicate), notes.write(duplicate)]);
    assert.deepEqual(same.map((result) => result.status), ['committed', 'committed']);
    assert.equal(same[0].revision.revisionId, same[1].revision.revisionId);
  });

  test(`${kind}: context commit retains the post-boundary tail and rejects stale input/oversized bootstrap`, async () => {
    const { sessions, notes } = await backend(kind);
    const session = await sessions.create({ id: 'session', binding });
    const first = await sessions.appendInput(session, { runId: 'one', task: 'original requirement' });
    await sessions.recordRunFinalization(session, terminal('one'));
    const history = new HistoryReader({ repository: sessions, session });
    const note = await notes.write(writeRequest());
    const service = new ContextService({ repository: sessions, session, history, notes, bootstrap: { validate: async () => {}, maxBytes: 16 * 1024, historyRead: { history, isAvailable: () => true } } });
    const request = { expectedWindowId: null, idempotencyKey: 'transition', reason: 'Use note and retrieve originals', selection: { strategy: 'notes', retained: [], notes: [{ scope, noteId: 'entry', revisionId: note.revision.revisionId }], omitted: [{ fromEntryId: first.id, toEntryId: first.id, reason: 'Retrievable original' }] } };
    const transition = await service.transition(request);
    assert.equal((await service.transition(request)).id, transition.id);
    const later = await sessions.appendInput(session, { runId: 'two', task: 'later correction must survive' });
    const view = await history.view();
    assert.equal(view.contextWindow.windowId, transition.window.windowId);
    assert.ok(view.entries.some((entry) => entry.id === later.id));
    assert.equal((await history.read({ source: sourceRef(session.id, first) })).status, 'available');
    await assert.rejects(service.transition({ ...request, idempotencyKey: 'stale' }), /stale/u);
    const tiny = new ContextService({ repository: sessions, session, bootstrap: { validate: async () => {}, maxBytes: 1, selfContained: true } });
    await assert.rejects(tiny.transition({ expectedWindowId: transition.window.windowId, idempotencyKey: 'oversized', reason: 'test', selection: { strategy: 'retain', retained: view.entries.map((entry) => sourceRef(session.id, entry)), notes: [], omitted: [] } }), /byte budget/u);
    assert.equal((await history.view()).contextWindow.windowId, transition.window.windowId);
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: authoritative unfinished ledger output survives a missing mirror and captured heads exclude later output`, async () => {
    const { sessions, events } = await backend(kind);
    const session = await sessions.create({ id: 'ledger-session', binding });
    await sessions.appendInput(session, { runId: 'open-run', task: 'Original task' });
    const receipt = await events.append('open-run', { type: 'assistant.interrupted', ...identity, content: 'committed partial answer', modelOutput: { status: 'partial', message: 'committed partial answer', source: 'stream_recovery', turnIndex: 1 }, finalResponseReceived: false });
    const history = new HistoryReader({ repository: sessions, session, events });
    const cut = await history.capture();
    const view = await history.view(cut);
    const answer = view.entries.find((entry) => entry.type === 'assistant');
    assert.equal(answer.content, 'committed partial answer'); assert.equal(answer.completeness, 'partial');
    const source = sourceRef(session.id, answer);
    assert.equal(source.event.eventId, receipt.eventId); assert.equal(source.sha256, receipt.hash);
    await events.append('open-run', { type: 'assistant.ended', ...identity, content: 'later settled answer', modelOutput: { status: 'complete', message: 'later settled answer', source: 'content', turnIndex: 1 } });
    assert.equal((await history.read({ source, cut })).item.text, 'committed partial answer');
    const latest = await history.view();
    assert.equal(latest.entries.filter((entry) => entry.type === 'assistant').length, 2);
    assert.equal(latest.entries.find((entry) => entry.type === 'assistant' && entry.completeness === 'complete').content, 'later settled answer');
    await sessions.appendAssistant(session, { runId: 'open-run', identity, content: 'later settled answer' });
    assert.equal((await history.view()).entries.filter((entry) => entry.type === 'assistant').length, 2, 'mirror cannot duplicate authoritative output');
    assert.equal((await history.read({ source })).item.text, 'committed partial answer');
  });
}

test('context validation releases the session queue and accepted queued input makes its capture stale', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ id: 'responsive', binding });
  const first = await sessions.appendInput(session, { runId: 'first', task: 'first' });
  await sessions.recordRunFinalization(session, terminal('first'));
  let release; let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const context = new ContextService({ repository: sessions, session, bootstrap: { maxBytes: 8192, async validate() { entered(); await gate; } } });
  const agent = new AgentSession({ descriptor: session, expectedBinding: binding, repository: sessions, context,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec)), configuration: { provider: 'test', model: 'test' },
    createRuntime() { throw new Error('No runtime needed'); } });
  const changing = agent.transitionContext({ expectedWindowId: null, idempotencyKey: 'pending', reason: 'capture', selection: { strategy: 'retain', retained: [sourceRef(session.id, first)], notes: [], omitted: [] } });
  await ready;
  assert.equal(await agent.abort('No active run'), false, 'abort uses the serial queue while validation awaits external work');
  await sessions.enqueueSubmission(session, { submissionId: 'queued', runId: 'queued', input: { task: 'accepted during validation' }, configuration: { provider: 'test', model: 'test' } });
  release();
  await assert.rejects(changing, /stale/u);
  assert.equal((await sessions.loadReplayState(session)).contextWindow, undefined);
});

test('context requires available scoped retrieval before omissions and checks exact note artifact availability', async () => {
  const sessions = new InMemorySessionRepository(); const artifacts = new InMemoryArtifactRepository();
  const notes = new InMemoryNoteRepository({ artifacts });
  const session = await sessions.create({ id: scope.sessionId, binding });
  const first = await sessions.appendInput(session, { runId: 'one', task: 'Original authority' });
  await sessions.recordRunFinalization(session, terminal('one'));
  const history = new HistoryReader({ repository: sessions, session });
  const selection = { strategy: 'notes', retained: [], notes: [], omitted: [{ fromEntryId: first.id, toEntryId: first.id, reason: 'retrieve' }] };
  const unavailable = new ContextService({ repository: sessions, session, history, bootstrap: { validate: async () => {}, maxBytes: 8192, historyRead: { history, isAvailable: () => false } } });
  await assert.rejects(unavailable.transition({ expectedWindowId: null, idempotencyKey: 'no-tools', reason: 'test', selection }), /read capability/u);
  const written = await notes.write(writeRequest());
  artifacts.readVerified = async () => { throw new Error('Artifact lost'); };
  assert.equal((await notes.read({ scope, noteId: 'entry' })).status, 'artifact_unavailable');
  const context = new ContextService({ repository: sessions, session, history, notes, bootstrap: { validate: async () => {}, maxBytes: 8192, historyRead: { history, isAvailable: () => true } } });
  await assert.rejects(context.transition({ expectedWindowId: null, idempotencyKey: 'missing-artifact', reason: 'test', selection: { ...selection, notes: [{ scope, noteId: 'entry', revisionId: written.revision.revisionId }] } }), /artifact is unavailable/u);
});

test('note quotas include all revisions; bounded search cursors pin revisions and reject a different scope', async () => {
  const notes = new InMemoryNoteRepository({ quotas: { maxNoteBytes: 32, maxTotalBytes: 48, maxRevisions: 3 } });
  await notes.write(writeRequest({ noteId: 'a', content: 'abc', idempotencyKey: 'a' }));
  await notes.write(writeRequest({ noteId: 'b', content: 'def', idempotencyKey: 'b' }));
  const page = await notes.list({ scope, limit: 1 });
  assert.equal(page.coverage, 'partial');
  await notes.write(writeRequest({ noteId: 'c', content: 'ghi', idempotencyKey: 'c' }));
  const next = await notes.list({ scope, limit: 10, cursor: page.cursor });
  assert.deepEqual(next.items.map((item) => item.noteId), ['b']);
  await assert.rejects(notes.list({ scope: { ...scope, branchId: 'other' }, cursor: page.cursor }), /scope/u);
  await assert.rejects(notes.write(writeRequest({ noteId: 'd', content: 'too many', idempotencyKey: 'd' })), /quota/u);
  const json = new InMemoryNoteRepository();
  const committed = await json.write(writeRequest({ mediaType: 'application/json', content: { hypothesis: false, details: ['not instructions'] } }));
  assert.deepEqual(JSON.parse((await json.read({ scope, noteId: 'entry', revisionId: committed.revision.revisionId })).text), { hypothesis: false, details: ['not instructions'] });
});

test('small UTF-8 ranges fail explicitly instead of returning an endless empty cursor', async () => {
  const sessions = new InMemorySessionRepository(); const session = await sessions.create({ binding });
  const entry = await sessions.appendInput(session, { runId: 'run', task: '改正😀' });
  const history = new HistoryReader({ repository: sessions, session });
  await assert.rejects(history.read({ source: sourceRef(session.id, entry), maxBytes: 1 }), /UTF-8/u);
  const range = await history.read({ source: sourceRef(session.id, entry), maxBytes: 4 });
  assert.equal(range.item.text, '改'); assert.equal(range.nextOffset, 3);
});

test('JSONL restart observes committed notes/windows and rejects incompatible session format without rewriting data', async () => {
  const { root, sessions, notes, artifacts } = await backend('jsonl');
  const session = await sessions.create({ id: scope.sessionId, binding });
  const entry = await sessions.appendInput(session, { runId: 'run', task: 'retained across restart' });
  const written = await notes.write(writeRequest());
  const context = new ContextService({ repository: sessions, session, bootstrap: { validate: async () => {}, maxBytes: 8192 } });
  const committed = await context.transition({ expectedWindowId: null, idempotencyKey: 'restart', reason: 'restart', selection: { strategy: 'retain', retained: [sourceRef(session.id, entry)], notes: [], omitted: [] } });
  const reopened = new JsonlSessionRepository(path.join(root, 'sessions'));
  assert.equal((await reopened.loadReplayState(await reopened.open(session.id, binding))).contextWindow.windowId, committed.window.windowId);
  const reopenedNotes = new JsonlNoteRepository({ rootDir: path.join(root, 'notes'), artifacts });
  assert.equal((await reopenedNotes.read({ scope, noteId: 'entry' })).revision.revisionId, written.revision.revisionId);
  const original = await readFile(sessions.location(session.id), 'utf8');
  const old = original.replace('"format":"agent-core.session/2",', '');
  await writeFile(sessions.location(session.id), old);
  await assert.rejects(new JsonlSessionRepository(path.join(root, 'sessions')).open(session.id, binding), /Incompatible session format/u);
  assert.equal(await readFile(sessions.location(session.id), 'utf8'), old);
});

test('tool factories bind effects to host scope and context handlers schedule without committing a window', async () => {
  const sessions = new InMemorySessionRepository(); const session = await sessions.create({ id: scope.sessionId, binding });
  const history = new HistoryReader({ repository: sessions, session });
  const notes = new InMemoryNoteRepository(); const scheduled = [];
  const context = new ContextService({ repository: sessions, session, history, bootstrap: { validate: async () => {}, maxBytes: 8192, async schedule(request) { scheduled.push(request); return { requestId: request.idempotencyKey }; } } });
  assert.deepEqual(createHistoryTools({ history }).map((tool) => tool.name), ['history_read', 'history_search']);
  const writes = createNotesTools({ repository: notes, scope });
  const write = writes.find((tool) => tool.name === 'notes_write');
  const decoded = write.decodeInput({ kind: 'json', value: { noteId: 'tool-note', title: 'note', mediaType: 'text/plain', content: 'model hypothesis', expectedRevision: null, idempotencyKey: 'key' } });
  assert.equal(decoded.ok, true);
  const canonical = await write.canonicalizeInput(decoded.input, {});
  const effects = await write.deriveEffects(canonical, {});
  assert.deepEqual(effects.accesses, [{ mode: 'write', scope: 'notes/session/session/tool-note' }]);
  const toolContext = { policy: {}, invocation: { runId: 'run', ...identity, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 } };
  const result = await write.invoke(canonical, toolContext);
  assert.equal(result.output.status, 'committed');
  assert.equal((await write.invoke(canonical, toolContext)).output.revision.revisionId, result.output.revision.revisionId);
  assert.equal(write.decodeInput({ kind: 'json', value: { ...decoded.input, scope: { sessionId: 'other', branchId: 'other' } } }).ok, false);
  const tool = createContextTools({ context }).find((item) => item.name === 'context_transition');
  const decodedTransition = tool.decodeInput({ kind: 'json', value: { expectedWindowId: null, idempotencyKey: 'scheduled', reason: 'test', selection: { strategy: 'retain', retained: [], notes: [], omitted: [] } } });
  await tool.invoke(await tool.canonicalizeInput(decodedTransition.input, {}), toolContext);
  assert.equal(scheduled.length, 1); assert.equal((await history.view()).contextWindow, undefined);
});

test('note artifact reservations survive a failed store and prevent quota bypass on restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'note-reservation-'));
  const artifacts = new InMemoryArtifactRepository();
  const store = artifacts.storeProtected.bind(artifacts);
  artifacts.storeProtected = async () => { throw new Error('crash before artifact commit'); };
  const options = { rootDir: root, artifacts, quotas: { maxTotalBytes: 10, maxNoteBytes: 10, maxRevisions: 2 } };
  const notes = new JsonlNoteRepository(options);
  await assert.rejects(notes.write(writeRequest({ content: '12345678' })), /crash/u);
  artifacts.storeProtected = store;
  const recovered = new JsonlNoteRepository(options);
  await assert.rejects(recovered.write(writeRequest({ noteId: 'other', content: '345', idempotencyKey: 'different' })), /quota/u);
  const committed = await recovered.write(writeRequest({ content: '12345678' }));
  assert.equal(committed.status, 'committed');
  assert.equal((await recovered.write(writeRequest({ content: '12345678' }))).revision.revisionId, committed.revision.revisionId);
});

test('a crash between session fork and note fork restores the pinned parent revision', async () => {
  const { root, sessions, notes, artifacts } = await backend('jsonl');
  const session = await sessions.create({ id: scope.sessionId, binding });
  const source = await sessions.appendInput(session, { runId: 'run', task: 'branch boundary' });
  await sessions.recordRunFinalization(session, terminal('run'));
  const first = await notes.write(writeRequest());
  const watermark = (await notes.list({ scope })).watermark;
  const branch = await sessions.branchFrom(session, source.id, 'crash-gap', { scope, watermark });
  await notes.write(writeRequest({ content: 'parent change after fork', expectedRevision: first.revision.revisionId, idempotencyKey: 'later' }));
  const restartedSessions = new JsonlSessionRepository(path.join(root, 'sessions'));
  const restartedNotes = new JsonlNoteRepository({ rootDir: path.join(root, 'notes'), artifacts });
  const agent = new AgentSession({ descriptor: await restartedSessions.open(session.id, binding), expectedBinding: binding, repository: restartedSessions, notes: restartedNotes,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec)), configuration: { provider: 'test', model: 'test' }, createRuntime() { throw new Error('No run'); } });
  await agent.restore();
  const inherited = await restartedNotes.read({ scope: { sessionId: scope.sessionId, branchId: branch.id }, noteId: 'entry' });
  assert.equal(inherited.revision.revisionId, first.revision.revisionId);
  assert.equal(inherited.text, 'Hypothesis, not authority.');
});

test('schema-bound JSON notes validate before artifact writes and remain generated material', async () => {
  const artifacts = new InMemoryArtifactRepository(); let stores = 0;
  const store = artifacts.store.bind(artifacts); artifacts.store = (value) => { stores++; return store(value); };
  const notes = new InMemoryNoteRepository({ artifacts, jsonSchemas: { 'working-state/1': (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.hypothesis !== 'string') throw new Error('hypothesis required');
    return value;
  } } });
  await assert.rejects(notes.write(writeRequest({ mediaType: 'application/json', schemaId: 'working-state/1', content: { approval: true } })), /hypothesis/u);
  assert.equal(stores, 0);
  const result = await notes.write(writeRequest({ mediaType: 'application/json', schemaId: 'working-state/1', content: { hypothesis: 'inspect the original result' } }));
  assert.equal(result.revision.schemaId, 'working-state/1'); assert.equal(result.revision.authorId, 'model');
});

test('rebuildable lexical index reports partial coverage and scans new source identities', async () => {
  const sessions = new InMemorySessionRepository(); const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'one', task: 'old alpha constraint' });
  await sessions.appendInput(session, { runId: 'two', task: 'beta constraint' });
  const history = new HistoryReader({ repository: sessions, session });
  assert.equal((await history.rebuildIndex({ maxScanned: 1 })).coverage, 'partial');
  assert.equal((await history.search({ query: 'beta' })).items.length, 1);
  assert.equal((await history.rebuildIndex()).coverage, 'complete');
  await sessions.appendInput(session, { runId: 'three', task: 'new gamma correction' });
  const fresh = await history.search({ query: 'gamma' });
  assert.equal(fresh.items.length, 1); assert.equal(fresh.index.coverage, 'partial');
  assert.equal(fresh.coverage, 'complete', 'bounded source fallback covers the stale index tail');
});

test('original accepted whitespace and relationship survive JSONL restart independently of scheduling', async () => {
  const { root, sessions } = await backend('jsonl');
  const session = await sessions.create({ id: 'relationship', binding });
  await sessions.enqueueSubmission(session, { submissionId: 'original', runId: 'run', input: { task: '  original\n\n', relationship: { kind: 'side_question' } }, configuration: { provider: 'test', model: 'test' } });
  await sessions.appendInput(session, { runId: 'run', task: 'original' });
  const reopened = new JsonlSessionRepository(path.join(root, 'sessions'));
  const read = await reopened.loadReplayState(await reopened.open(session.id, binding));
  assert.equal(read.branch[0].originalInput.task, '  original\n\n');
  assert.equal(read.branch[0].originalInput.relationship.kind, 'side_question');
  await assert.rejects(sessions.enqueueSubmission(session, { submissionId: 'invalid', runId: 'invalid', input: { task: 'valid', contextItems: [{ unexpected: true }] }, configuration: { provider: 'test', model: 'test' } }), /prompt context/iu);
});

test('assistant media bytes persist losslessly and protocol payloads stay out of history tools', async () => {
  const { root, sessions } = await backend('jsonl');
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'run', task: 'render image' });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const state = await createProviderContextState({ provider: 'test', endpoint: 'https://test', request: { model: 'model', messages: [{ role: 'user', content: 'render image' }] }, requestId: 'request', kind: 'signed', data: { opaque: 'hidden-provider-payload' } });
  const entry = await sessions.appendAssistant(session, { runId: 'run', identity, content: '', output: [{ type: 'media', part: { type: 'image', image: { type: 'bytes', data: bytes, mediaType: 'image/png' } } }, { type: 'protocol', state }] });
  bytes[0] = 99;
  const reopened = new JsonlSessionRepository(path.join(root, 'sessions'));
  const view = await new HistoryReader({ repository: reopened, session: await reopened.open(session.id, binding) }).view();
  const image = view.entries.find((item) => item.type === 'assistant').output[0].part.image;
  assert.equal(image.type, 'base64'); assert.deepEqual([...Buffer.from(image.data, 'base64')], [1, 2, 3, 4]);
  const read = await new HistoryReader({ repository: reopened, session }).read({ source: sourceRef(session.id, entry) });
  assert.equal(read.status, 'available'); assert.match(read.item.text, /image\/png/u);
  assert.equal(JSON.stringify(read).includes('hidden-provider-payload'), false);
  assert.equal((await new HistoryReader({ repository: reopened, session }).search({ query: 'hidden-provider-payload' })).items.length, 0);
});

test('every transition needs request-fit validation and active input/tool-result dependencies cannot be omitted', async () => {
  const sessions = new InMemorySessionRepository(); const session = await sessions.create({ binding });
  assert.throws(() => new ContextService({ repository: sessions, session, bootstrap: { maxBytes: 8192, selfContained: true } }), /request-fit validation/u);
  const input = await sessions.appendInput(session, { runId: 'run', task: 'mandatory current task' });
  const observation = await sessions.appendObservation(session, { runId: 'run', identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call', toolAttempt: 1 }, toolName: 'read', observation: { ok: true, summary: 'result' } });
  const context = new ContextService({ repository: sessions, session, bootstrap: { validate: async () => {}, maxBytes: 8192, selfContained: true } });
  await assert.rejects(context.transition({ expectedWindowId: null, idempotencyKey: 'orphan', reason: 'test', selection: { strategy: 'retain', retained: [sourceRef(session.id, input), sourceRef(session.id, observation)], notes: [], omitted: [] } }), /no matching original call/u);
  await assert.rejects(context.transition({ expectedWindowId: null, idempotencyKey: 'omit-active', reason: 'test', selection: { strategy: 'notes', retained: [], notes: [], omitted: [{ fromEntryId: input.id, toEntryId: observation.id, reason: 'cannot omit active input' }] } }), /active accepted input is mandatory/u);
});

test('native context selection binds only validated host state and rejects caller-supplied state', async () => {
  const sessions = new InMemorySessionRepository(); const session = await sessions.create({ binding });
  const input = await sessions.appendInput(session, { runId: 'run', task: 'original native input' });
  await sessions.recordRunFinalization(session, terminal('run'));
  const state = { artifact: { id: 'host-validated-artifact', sha256: 'a'.repeat(64) }, invocationId: 'native-invocation' };
  const context = new ContextService({ repository: sessions, session, bootstrap: { maxBytes: 8192, selfContained: true, validate: async () => ({ providerState: state }) } });
  const selection = { strategy: 'provider', retained: [sourceRef(session.id, input)], notes: [], omitted: [] };
  await assert.rejects(context.transition({ expectedWindowId: null, idempotencyKey: 'forged', reason: 'test', selection: { ...selection, providerState: { authority: 'forged' } } }), /governed host validation/u);
  const committed = await context.transition({ expectedWindowId: null, idempotencyKey: 'native', reason: 'test', selection });
  state.artifact.id = 'mutated';
  assert.equal(committed.window.selection.providerState.artifact.id, 'host-validated-artifact');
  assert.equal(Object.isFrozen(committed.window.selection.providerState.artifact), true);
  assert.equal((await context.inspect()).window.selection.providerState, undefined, 'ordinary context inspection exposes references without opaque state payload');
});


test('ledger source refs survive delayed mirrors and event heads decide transition tails', async () => {
  const sessions = new InMemorySessionRepository(); const events = new InMemoryEventRepository(agentEventCodec);
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'run', task: 'original' });
  const receipt = await events.append('run', { type: 'assistant.ended', ...identity, content: 'committed before mirror', modelOutput: { status: 'complete', message: 'committed before mirror', source: 'content', turnIndex: 1 } });
  const reader = new HistoryReader({ repository: sessions, session, events });
  const captured = await reader.view();
  const answer = captured.entries.find((entry) => entry.type === 'assistant');
  const source = sourceRef(session.id, answer);
  assert.equal(historySourceAfterCut(captured, answer, captured.cut), false, 'a missing mirror is still covered by the captured ledger head');
  await sessions.appendAssistant(session, { runId: 'run', identity, content: answer.content, completeness: 'complete', source: { runId: 'run', eventId: receipt.eventId, sequence: receipt.sequence, hash: receipt.hash } });
  const plain = new HistoryReader({ repository: sessions, session });
  assert.equal((await plain.read({ source })).item.text, answer.content);
  assert.equal((await reader.read({ source })).item.text, answer.content);
  await events.append('run', { type: 'assistant.ended', ...identity, turnId: 'next-turn', turnIndex: 2, content: 'new tail', modelOutput: { status: 'complete', message: 'new tail', source: 'content', turnIndex: 2 } });
  const latest = await reader.view();
  assert.equal(historySourceAfterCut(latest, latest.entries.find((entry) => entry.type === 'assistant' && entry.turnId === 'next-turn'), captured.cut), true);
});


for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: steering acceptance survives uncertain delivery and deduplicates exact late mirrors`, async () => {
    const { sessions, events } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, { runId: 'run', task: 'original task' });
    const receipt = await events.append('run', { type: 'input.steering.accepted', deliveryId: 'correction', content: '  corrected identifier  ' });
    const reader = new HistoryReader({ repository: sessions, session, events });
    const before = await reader.view();
    const source = sourceRef(session.id, before.entries.find((entry) => entry.type === 'steering'));
    assert.equal(source.event.eventId, receipt.eventId);
    const originalInput = { task: '  corrected identifier  ', instructions: ['Keep the attachment.'], contextItems: [] };
    const mirrorInput = { runId: 'run', deliveryId: 'correction', content: originalInput.task, originalInput, relationship: { kind: 'correct' } };
    const mirror = await sessions.appendSteering(session, mirrorInput);
    assert.equal((await sessions.appendSteering(session, mirrorInput)).id, mirror.id);
    await assert.rejects(() => sessions.appendSteering(session, { ...mirrorInput, content: 'different' }), /conflicting/u);
    const reopened = new HistoryReader({ repository: sessions, session: await sessions.open(session.id, binding), events });
    const after = await reopened.view();
    const steering = after.entries.filter((entry) => entry.type === 'steering');
    assert.equal(steering.length, 1);
    assert.deepEqual(sourceRef(session.id, steering[0]), source);
    assert.deepEqual(steering[0].originalInput, originalInput);
    assert.equal(historySourceAfterCut(after, steering[0], before.cut), false);
    assert.match((await reopened.read({ source })).item.text, /corrected identifier/u);
  });

  test(`${kind}: session-only cuts retain newly visible sourced assistant records`, async () => {
    const { sessions, events } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, { runId: 'run', task: 'original task' });
    const reader = new HistoryReader({ repository: sessions, session });
    const openCut = await reader.capture();
    await sessions.recordRunFinalization(session, terminal('run'));
    const finalizedCut = await reader.capture();
    const receipt = await events.append('run', { type: 'assistant.ended', ...identity, content: 'late source', modelOutput: { status: 'complete', message: 'late source', source: 'content', turnIndex: 1 } });
    await sessions.appendAssistant(session, { runId: 'run', identity, content: 'late source', source: { runId: 'run', eventId: receipt.eventId, sequence: receipt.sequence, hash: receipt.hash } });
    const view = await reader.view();
    const assistant = view.entries.find((entry) => entry.type === 'assistant');
    assert.equal(historySourceAfterCut(view, assistant, openCut), true);
    assert.equal(historySourceAfterCut(view, assistant, finalizedCut), true);
    const { ledgerHeads, ...noLedgerCut } = openCut;
    assert.equal(historySourceAfterCut(view, assistant, noLedgerCut), true);
  });

  test(`${kind}: canonical tool arguments retain content beyond normalization limits`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, { runId: 'run', task: 'read complete tool arguments later' });
    const text = `${'x'.repeat(100000)} exact final constraint`;
    const call = await sessions.appendToolCall(session, { runId: 'run', identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call' }, call: { id: 'call', name: 'write', input: { kind: 'json', value: { text } } } });
    const history = new HistoryReader({ repository: sessions, session });
    const read = await history.read({ source: sourceRef(session.id, call), maxBytes: 128 * 1024 });
    assert.equal(JSON.parse(read.item.text).input.value.text, text);
    assert.equal((await history.search({ query: 'exact final constraint' })).items.length, 1);
  });
}

test('context discovery advertises native strategy only when the host currently supports it', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  let available = false;
  const context = new ContextService({ repository: sessions, session, bootstrap: { maxBytes: 8192, validate: async () => undefined, providerStrategyAvailable: async () => available } });
  assert.deepEqual((await context.inspect()).legalTransitions, ['retain']);
  available = true;
  assert.deepEqual((await context.inspect()).legalTransitions, ['retain', 'provider']);
});
