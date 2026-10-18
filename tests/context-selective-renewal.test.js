import { admitContext } from './context-admission-fixtures.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository, sourceRef, contextSelectionSchema, contextTransitionRequestSchema } from '@agent-core/runtime';

async function fixture() {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'selective-renewal', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository, session, artifacts });
  const context = new ContextService({ repository, session, artifacts, history, assertStateWrite: async () => {},
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const entries = [];
  for (let n = 0; n < 3; n++) entries.push(await repository.appendAssistant(session, {
    runId: 'run', identity: { turnId: `turn-${n}`, turnIndex: n + 1, requestAttempt: 1 }, content: `Original ${n}`
  }));
  const refs = entries.map(entry => sourceRef(session.id, entry));
  const requestRef = await artifacts.storeProtected({ label: 'inference', content: Buffer.from('{}') });
  const batch = (cut, operations, idempotencyKey = `state-${cut.sourceRevision}`) => ({ idempotencyKey,
    branchId: cut.branchId, capturedHistoryCut: cut, operations,
    inference: { ownerId: 'owner', invocationId: idempotencyKey, requestRef } });
  return { repository, session, artifacts, history, context, refs, batch };
}
const admitted = { admit: admitContext };
function request(cut, retained, id = 'renew') {
  return { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision, idempotencyKey: id, reason: 'Renew',
    renewal: true, selection: { retained } };
}

test('recentFrom is an exact stable inclusive boundary, with canonical add/release', async () => {
  const { context, history, refs } = await fixture();
  const cut = await history.capture();
  assert.deepEqual((await context.selectSources(cut, { recentFrom: refs[1] })).retained, refs.slice(1));
  assert.deepEqual((await context.selectSources(cut, { recentFrom: refs[1], add: [refs[0], refs[0]], release: [refs[2]] })).retained, refs.slice(0, 2));
  await assert.rejects(context.selectSources(cut, { recentFrom: { ...refs[1], sha256: '0'.repeat(64) } }), /Recent boundary/);
  await assert.rejects(context.selectSources(cut, { recentFrom: refs[1], retain: [] }), /replacement/);
});

test('narrative item ordering never changes citation retention', async () => {
  const { context, history, refs, batch } = await fixture();
  const item = { kind: 'create', text: 'Same cited evidence', sources: [refs[0]] };
  for (const [index, heading] of ['Current question', 'Evidence', 'Working notes', 'What changed'].entries()) {
    const cut = await history.capture();
    const headingItem = { kind: 'create', text: `${heading}\nA freely authored narrative heading.` };
    const operations = index % 2 ? [item, headingItem] : [headingItem, item];
    const staged = await context.stageSessionState(batch(cut, operations));
    const selected = staged.revisions.map(({ itemId, revisionId }) => ({ itemId, revisionId }));
    const committed = await context.transition({ ...request(cut, [], `move-${index}`),
      expectedWindowId: (await history.selectedContext(cut))?.windowId ?? null,
      sessionState: staged, selection: { retained: [], sessionState: selected }
    }, admitted);
    assert.deepEqual(committed.window.selection.retained, []);
    assert.deepEqual((await context.selectSources(await history.capture(), {})).retained, []);
    assert.deepEqual((await context.sessionState()).items.map(({ text, sources }) => ({ text, ...(sources ? { sources } : {}) })),
      operations.map(({ kind, ...content }) => content));
    assert.equal((await history.read({ source: refs[0] })).item.text, 'Original 0');
    assert.deepEqual((await context.selectSources(await history.capture(), { retain: [refs[0]] })).retained, [refs[0]]);
    assert.deepEqual((await context.selectSources(await history.capture(), { add: [refs[0]] })).retained, [refs[0]]);
  }
});

test('citations do not prevent explicit release of an original', async () => {
  const { context, history, refs, batch } = await fixture();
  const cut = await history.capture();
  const staged = await context.stageSessionState(batch(cut, [{ kind: 'create', text: 'Cited original', sources: [refs[0]] }]));
  const selected = staged.revisions.map(({ itemId, revisionId }) => ({ itemId, revisionId }));
  await context.transition({ ...request(cut, refs), sessionState: staged,
    selection: { retained: refs, sessionState: selected } }, admitted);
  const releaseCut = await history.capture();
  const selection = await context.selectSources(releaseCut, { release: [refs[0]] });
  assert.deepEqual(selection.retained, refs.slice(1));
  const released = await context.transition({ ...request(releaseCut, selection.retained, 'release-cited'),
    selection, expectedWindowId: (await history.selectedContext(releaseCut)).windowId }, admitted);
  assert.deepEqual(released.window.selection.retained, refs.slice(1));
  assert.deepEqual((await context.sessionState()).items.map(({ itemId, revisionId }) => ({ itemId, revisionId })), selected);
});

test('narrative item citations validate exact source identity and captured branch access', async () => {
  const { context, history, repository, session, refs, batch } = await fixture();
  const point = await context.transition(request(await history.capture(), refs, 'branch-point'), admitted);
  const later = await repository.appendAssistant(session, { runId: 'run',
    identity: { turnId: 'parent-only', turnIndex: 4, requestAttempt: 1 }, content: 'Parent-only evidence' });
  const parentOnly = sourceRef(session.id, later);
  const cited = source => [{ kind: 'create', text: 'Exact evidence', sources: [source] }];
  await context.stageSessionState(batch(await history.capture(), cited(parentOnly)));
  await repository.branchFrom(session, point.id, 'Citation isolation');
  const childCut = await history.capture();
  await context.stageSessionState(batch(childCut, cited(refs[0])));
  await assert.rejects(context.stageSessionState(batch(childCut, cited(parentOnly))), /unavailable|outside|branch|cut/i);
  await assert.rejects(context.stageSessionState(batch(childCut, cited({ ...refs[0], sha256: '0'.repeat(64) }))));
  await assert.rejects(context.stageSessionState(batch(childCut, cited({ ...refs[0], sessionId: 'other-session' }))));
});

test('renewal cannot publish without actual admission, and failed admission leaves no window', async () => {
  const { context, history, refs } = await fixture();
  const cut = await history.capture();
  const candidate = request(cut, [refs[2]]);
  await assert.rejects(context.transition(candidate), /compiled next-request admission/);
  await assert.rejects(context.transition(candidate, { admit: async () => { throw new Error('too large'); } }), /too large/);
  assert.equal(await history.selectedContext(), undefined);
  const committed = await context.transition(candidate, admitted);
  assert.equal(committed.transition.admission.status, 'admitted');
  assert.deepEqual(await context.transition(candidate, admitted), committed);
});

test('retired provider selection and caller continuation controls are rejected', async () => {
  assert.equal(contextSelectionSchema.safeParse({ retained: [], strategy: 'provider' }).success, false);
  assert.equal(contextSelectionSchema.safeParse({ retained: [], providerState: {} }).success, false);
  const { context, history, refs } = await fixture();
  const cut = await history.capture();
  const renewed = await context.transition(request(cut, refs), admitted);
  assert.equal(renewed.transition.strategy, 'fresh');
  await assert.rejects(context.transition({ ...request(cut, refs), preserveSelection: true }, admitted));
});

test('recent boundary preserves complete tool exchanges and active accepted input', async () => {
  const { repository, session, context, history } = await fixture();
  const input = await repository.appendInput(session, { runId: 'active', task: 'Original requirement' });
  const identity = { turnId: 'exchange', turnIndex: 1, requestAttempt: 1 };
  const call = { id: 'call', type: 'function', name: 'lookup', input: { kind: 'json', value: {} } };
  const assistant = await repository.appendAssistant(session, { runId: 'active', identity,
    content: '', output: [{ type: 'tool_call', toolCall: call }] });
  const started = await repository.appendToolCall(session, { runId: 'active', identity: { ...identity,
    toolBatchId: 'batch', callIndex: 0, callId: 'call' }, call });
  const observation = await repository.appendObservation(session, { runId: 'active',
    identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call', toolAttempt: 1 }, toolName: 'lookup',
    observation: { kind: 'result', output: { found: true }, summary: 'Found', scope: { resources: ['test'], coverage: 'complete' } } });
  const selection = await context.selectSources(await history.capture(), { recentFrom: sourceRef(session.id, observation) });
  assert.deepEqual(selection.retained, [input, assistant, started, observation].map(entry => sourceRef(session.id, entry)));
});

test('explicit release cannot remove active input and unfinished exchanges remain mandatory', async () => {
  const { repository, session, context, history, refs } = await fixture();
  const input = await repository.appendInput(session, { runId: 'active', task: 'Still current' });
  const inputRef = sourceRef(session.id, input);
  let cut = await history.capture();
  assert.deepEqual((await context.selectSources(cut, { retain: [] })).retained, [inputRef]);
  assert.deepEqual((await context.selectSources(cut, { release: [inputRef] })).retained, [...refs, inputRef]);
  assert.deepEqual((await context.inspect(cut)).protectedSources, [inputRef]);
  await assert.rejects(context.transition(request(cut, [], 'omit-active'), admitted), /active accepted or protected input is mandatory/);

  const identity = { turnId: 'pending-exchange', turnIndex: 1, requestAttempt: 1 };
  const call = { id: 'pending-call', type: 'function', name: 'lookup', input: { kind: 'json', value: {} } };
  await repository.appendAssistant(session, { runId: 'active', identity,
    content: '', output: [{ type: 'tool_call', toolCall: call }] });
  await repository.appendToolCall(session, { runId: 'active', identity: { ...identity,
    toolBatchId: 'pending-batch', callIndex: 0, callId: 'pending-call' }, call });
  cut = await history.capture();
  await assert.rejects(context.transition(request(cut, [inputRef], 'omit-unfinished'), admitted), /unfinished tool exchange/);
});

test('session-state citations cannot claim observations newer than the originating inference cut', async () => {
  const { context, history, repository, session, batch } = await fixture();
  const origin = await history.capture();
  const later = await repository.appendAssistant(session, { runId: 'run',
    identity: { turnId: 'later', turnIndex: 4, requestAttempt: 1 }, content: 'After inference' });
  const operations = [{ kind: 'create', text: 'Unavailable to the origin', sources: [sourceRef(session.id, later)] }];
  await assert.rejects(context.stageSessionState(batch(origin, operations)), /unavailable|outside|cut|boundary/i);
  await context.stageSessionState(batch(await history.capture(), operations));
});

test('retained excerpts merge exact spans as attributed evidence without replaying original exchanges', async () => {
  const { context, history, refs } = await fixture();
  const cut = await history.capture();
  const selection = await context.selectSources(cut, { retain: [], excerpts: [
    { source: refs[1], offset: 0, bytes: 4 },
    { source: refs[0], offset: 2, bytes: 4 },
    { source: refs[0], offset: 0, bytes: 4 }
  ] });
  assert.deepEqual(selection.retained, []);
  assert.deepEqual(selection.excerpts, [
    { source: refs[0], offset: 0, bytes: 6 }, { source: refs[1], offset: 0, bytes: 4 }
  ]);
  let evidence;
  const proposed = request(cut, []);
  const committed = await context.transition({ ...proposed, selection: { ...proposed.selection, excerpts: selection.excerpts } }, {
    admit: async input => {
      assert.deepEqual(input.entries, [], 'Text evidence must not manufacture assistant/tool protocol replay.');
      evidence = input.excerpts;
      return admitContext(input);
    }
  });
  assert.deepEqual(evidence.map(item => item.text), ['Origin', 'Orig']);
  assert.deepEqual(evidence.map(item => item.role), ['assistant', 'assistant']);
  assert.deepEqual(committed.window.selection.excerpts, selection.excerpts);
  const tool = context.toolDefinitions().find(item => item.name === 'context_inspect');
  const canonical = await tool.canonicalizeInput({ limit: 1, maxBytes: 4096 }, {});
  const observation = await (await tool.bindExecution(canonical, {})).invoke({});
  const inspection = JSON.parse(tool.buildModelContent({ observation })[0].text);
  assert.equal(inspection.excerpts.totalCount, 2);
  assert.equal(inspection.excerpts.textBytes, 10);
  assert.equal(inspection.excerpts.coverage, 'partial');
  assert.equal(inspection.excerpts.items.length, 1);
  assert.equal((await history.read({ source: refs[0] })).item.text, 'Original 0');
});

test('full original retention dominates redundant excerpt evidence and forged excerpt identities reject', async () => {
  const { context, history, refs } = await fixture();
  const cut = await history.capture();
  const selection = await context.selectSources(cut, { retain: [refs[0]], excerpts: [{ source: refs[0], offset: 0, bytes: 4 }] });
  assert.equal(selection.excerpts, undefined);
  await assert.rejects(context.selectSources(cut, { retain: [], excerpts: [
    { source: { ...refs[0], sha256: '0'.repeat(64) }, offset: 0, bytes: 4 }
  ] }));
});


test('public proposals reject provider lineage while persisted runtime selections retain it', async () => {
  const { context, history } = await fixture();
  const selection = { retained: [], continuity: { kind: 'fresh', resetId: 'runtime-owned',
    model: { provider: 'fixture', model: 'fixture' }, sources: [], historyPosition: await history.capture() } };
  assert.equal(contextSelectionSchema.parse(selection).continuity.resetId, 'runtime-owned');
  const proposal = { expectedWindowId: null, idempotencyKey: 'caller-reset', reason: 'Unsupported lineage', selection };
  assert.equal(contextTransitionRequestSchema.safeParse(proposal).success, false);
  await assert.rejects(context.transition(proposal, admitted), /continuity/);
  assert.equal(contextTransitionRequestSchema.safeParse({ ...proposal, renewal: true, selection: { retained: [] } }).success, true);
  assert.equal('freshSelection' in context, false);
});
