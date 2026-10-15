import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository, sourceRef, contextSelectionSchema } from '@agent-core/runtime';

async function fixture() {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'selective-renewal', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository, session, artifacts });
  const context = new ContextService({ repository, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const entries = [];
  for (let n = 0; n < 3; n++) entries.push(await repository.appendAssistant(session, {
    runId: 'run', identity: { turnId: `turn-${n}`, turnIndex: n + 1, requestAttempt: 1 }, content: `Original ${n}`
  }));
  const refs = entries.map(entry => sourceRef(session.id, entry));
  return { repository, session, artifacts, history, context, refs };
}
const admitted = { admit: async () => ({ compiledInputIdentity: 'compiled-fixture', capabilityRevision: 'fixture' }) };
function request(cut, retained, id = 'renew') {
  return { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision, idempotencyKey: id, reason: 'Renew',
    selection: { retained, continuity: { kind: 'fresh', resetId: id, model: { provider: 'fixture', model: 'fixture' }, sources: retained } } };
}

test('recentFrom is an exact stable inclusive boundary, with canonical add/release', async () => {
  const { context, history, refs } = await fixture();
  const cut = await history.capture();
  assert.deepEqual((await context.selectSources(cut, { recentFrom: refs[1] })).retained, refs.slice(1));
  assert.deepEqual((await context.selectSources(cut, { recentFrom: refs[1], add: [refs[0], refs[0]], release: [refs[2]] })).retained, refs.slice(0, 2));
  await assert.rejects(context.selectSources(cut, { recentFrom: { ...refs[1], sha256: '0'.repeat(64) } }), /Recent boundary/);
  await assert.rejects(context.selectSources(cut, { recentFrom: refs[1], retain: [] }), /replacement/);
});

test('state citations retain only interaction originals and validate exact captured access', async () => {
  const { context, history, refs } = await fixture();
  const cut = await history.capture();
  const sessionState = {
    interaction: [{ id: 'request', text: 'Current request', sources: [refs[0]] }],
    understanding: [{ id: 'fact', text: 'Supporting detail', sources: [refs[1]] }]
  };
  assert.deepEqual((await context.selectSources(cut, { retain: [], sessionState })).retained, [refs[0]]);
  await context.validateSessionStateSources(sessionState, cut);
  await assert.rejects(context.validateSessionStateSources({ working: [{ id: 'bad', text: 'Wrong ref', sources: [{ ...refs[0], sha256: '0'.repeat(64) }] }] }, cut));
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
  await assert.rejects(context.transition({ ...request(cut, refs), selection: { retained: refs } }, admitted), /new fresh continuation/);
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

test('session-state citations cannot claim observations newer than the originating inference cut', async () => {
  const { context, history, repository, session } = await fixture();
  const origin = await history.capture();
  const later = await repository.appendAssistant(session, { runId: 'run',
    identity: { turnId: 'later', turnIndex: 4, requestAttempt: 1 }, content: 'After inference' });
  const content = { understanding: [{ id: 'late', text: 'Unavailable to the origin', sources: [sourceRef(session.id, later)] }] };
  await assert.rejects(context.validateSessionStateSources(content, origin), /unavailable|outside|cut/i);
  await context.validateSessionStateSources(content, await history.capture());
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
      return { compiledInputIdentity: 'excerpt-fixture', capabilityRevision: 'fixture' };
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
