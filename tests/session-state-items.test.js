import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, PersistenceConflictError } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository } from '@agent-core/runtime';

async function fixture(policy = {}) {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'narrative-items', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const requestRef = await artifacts.storeProtected({ label: 'admitted-input', content: Buffer.from('{}') });
  const history = new HistoryReader({ repository, session, artifacts });
  const context = new ContextService({ repository, session, artifacts, history,
    assertStateWrite: async batch => assert.deepEqual(batch.inference.requestRef, requestRef),
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true }, ...policy } });
  const cut = await history.capture();
  const batch = (idempotencyKey, operations, capturedHistoryCut = cut) => ({ idempotencyKey,
    owner: { kind: 'session', sessionId: capturedHistoryCut.sessionId, branchId: capturedHistoryCut.branchId }, branchId: capturedHistoryCut.branchId, capturedHistoryCut,
    inference: { ownerId: 'owner', invocationId: 'inference', requestRef }, operations });
  return { repository, session, artifacts, history, context, batch };
}
const admit = async input => ({ compiledInputIdentity: 'admitted-exact-view', capabilityRevision: 'fixture',
  selection: input.strategy === 'fresh' ? { ...input.selection, continuity: {
    kind: 'fresh', resetId: `reset-${input.cut.sourceRevision}`, historyPosition: input.cut,
    model: { provider: 'fixture', model: 'fixture' }, sources: input.selection.retained
  } } : input.selection });
async function activate(f, refs, sessionState) {
  const cut = await f.history.capture();
  return f.context.transition({ expectedWindowId: (await f.history.selectedContext(cut))?.windowId ?? null,
    expectedSourceRevision: cut.sourceRevision, idempotencyKey: `view-${cut.sourceRevision}`,
    reason: 'Select exact saved understanding', renewal: true,
    selection: { retained: [], sessionState: refs }, ...(sessionState ? { sessionState } : {}) }, { admit });
}

test('saving items is independently durable and never activates or compiles a request', async () => {
  const f = await fixture();
  const command = f.batch('save-one', [{ kind: 'create', text: 'Useful interpretation' }]);
  const receipt = await f.context.saveSessionState(command);
  assert.equal(receipt.revisions.length, 1);
  assert.deepEqual(await f.context.sessionState(), { id: null, items: [] });
  assert.equal(await f.history.selectedContext(await f.history.capture()), undefined);
  assert.equal((await f.context.readSessionState(receipt.revisions[0])).text, 'Useful interpretation');
  assert.deepEqual(await f.context.saveSessionState(command), receipt, 'lost receipt is safely reconciled');
  await assert.rejects(f.context.saveSessionState({ ...command, operations: [{ kind: 'create', text: 'Different' }] }), PersistenceConflictError);
});

test('per-item CAS permits disjoint writes from one capture and rejects all of a conflicting batch', async () => {
  const f = await fixture();
  const original = await f.context.saveSessionState(f.batch('initial', [
    { kind: 'create', text: 'first' }, { kind: 'create', text: 'second' }
  ]));
  const [a, b] = original.revisions;
  const update = (ref, text) => ({ kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text });
  await f.context.saveSessionState(f.batch('a', [update(a, 'first revised')]));
  await f.context.saveSessionState(f.batch('b', [update(b, 'second revised')]));
  await assert.rejects(f.context.saveSessionState(f.batch('conflict', [
    { kind: 'create', text: 'must not persist' }, update(a, 'stale')
  ])), PersistenceConflictError);
  assert.equal((await f.context.listSessionState()).items.length, 2);
  assert.equal((await f.context.readSessionState(a)).text, 'first', 'old immutable revisions remain readable');
});

test('active view pins old revisions and exact ranges despite later saves', async () => {
  const f = await fixture();
  const first = await f.context.saveSessionState(f.batch('initial', [{ kind: 'create', text: 'alpha beta gamma' }]));
  const original = first.revisions[0];
  await activate(f, [{ ...original, range: { offset: 6, bytes: 4 } }]);
  await f.context.saveSessionState(f.batch('replace', [{ kind: 'replace', itemId: original.itemId,
    expectedRevisionId: original.revisionId, text: 'new understanding' }]));
  const selected = await f.context.sessionState();
  assert.equal(selected.items[0].text, 'beta');
  assert.equal(selected.items[0].revisionId, original.revisionId);
});

test('failed atomic save-and-activate admission publishes neither state nor view', async () => {
  const f = await fixture();
  const staged = await f.context.stageSessionState(f.batch('atomic', [{ kind: 'create', text: 'pending interpretation' }]));
  const cut = await f.history.capture();
  await assert.rejects(f.context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'atomic-view', reason: 'Atomic admission', renewal: true, sessionState: staged,
    selection: { retained: [], sessionState: staged.revisions.map(({ itemId, revisionId }) => ({ itemId, revisionId })) }
  }, { admit: async () => { throw new Error('provider admission failed'); } }), /admission failed/);
  assert.deepEqual((await f.context.listSessionState()).items, []);
  assert.equal(await f.history.selectedContext(await f.history.capture()), undefined);
  await activate(f, staged.revisions.map(({ itemId, revisionId }) => ({ itemId, revisionId })), staged);
  assert.equal((await f.context.sessionState()).items[0].text, 'pending interpretation');
});

test('storage, mutation, read and view bounds are independent; retained versions consume quota', async () => {
  const f = await fixture({ maxSourceBytes: 512, committedRetainedStateBytes: 24000,
    sessionStateMutationBytes: 32768, sessionStateReadBytes: 128 });
  await assert.rejects(f.context.saveSessionState(f.batch('too-large', [{ kind: 'create', text: 'x'.repeat(32769) }])), /mutation preparation/);
  const original = (await f.context.saveSessionState(f.batch('large', [{ kind: 'create', text: 'a'.repeat(8000) }]))).revisions[0];
  await assert.rejects(f.context.readSessionState(original), /bounded read/);
  assert.equal((await f.context.readSessionState({ ...original, range: { offset: 100, bytes: 20 } })).text.length, 20);
  await assert.rejects(activate(f, [original]), /bounded read/);
  await f.context.saveSessionState(f.batch('second', [{ kind: 'replace', itemId: original.itemId, expectedRevisionId: original.revisionId, text: 'b'.repeat(8000) }]));
  await assert.rejects(f.context.saveSessionState(f.batch('quota', [{ kind: 'create', text: 'c'.repeat(8000) }])), /storage quota/);
});

test('state list and text search are bounded and cursor pinned', async () => {
  const f = await fixture();
  await f.context.saveSessionState(f.batch('many', Array.from({ length: 12 }, (_, i) => ({ kind: 'create', text: `needle ${i}` }))));
  const page = await f.context.listSessionState({ limit: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.coverage, 'partial');
  const search = await f.context.searchSessionState({ query: 'needle', limit: 2 });
  assert.equal(search.matches.length, 2);
  assert.equal(search.coverage, 'partial');
  const next = await f.context.searchSessionState({ query: 'needle', limit: 2, cursor: search.cursor });
  assert.equal(next.matches.length, 2);
  assert.ok(next.matches.every(item => !search.matches.some(prior => prior.itemId === item.itemId)));
  await assert.rejects(f.context.searchSessionState({ query: 'other', cursor: search.cursor }), /query or branch/);
});

test('small selected reads do not hydrate unrelated large stored items', async () => {
  const f = await fixture({ maxSourceBytes: 1024 });
  const saved = await f.context.saveSessionState(f.batch('inventory', Array.from({ length: 80 }, (_, i) => ({
    kind: 'create', text: `item-${i}:` + 'x'.repeat(4096)
  }))));
  const reads = [];
  const originalRead = f.artifacts.readVerified.bind(f.artifacts);
  f.artifacts.readVerified = async ref => { reads.push(ref.artifactId); return originalRead(ref); };
  await f.context.listSessionState({ limit: 2 });
  assert.equal(reads.length, 0, 'metadata inventory does not read content artifacts');
  const ref = { ...saved.revisions[45], range: { offset: 0, bytes: 20 } };
  const selected = await f.context.selectedSessionState([ref]);
  assert.equal(selected.items.length, 1);
  assert.equal(reads.length, 1, 'only the explicitly selected revision is read');
});

test('conditional UTF-8 edits and remove preserve immutable earlier revisions', async () => {
  const f = await fixture();
  const original = (await f.context.saveSessionState(f.batch('unicode', [{ kind: 'create', text: 'A café note' }]))).revisions[0];
  await assert.rejects(f.context.saveSessionState(f.batch('split', [{ kind: 'edit', itemId: original.itemId,
    expectedRevisionId: original.revisionId, edits: [{ offset: 6, bytes: 1, text: 'x' }] }])), /encoded data|UTF-8|valid/i);
  const edited = (await f.context.saveSessionState(f.batch('edit', [{ kind: 'edit', itemId: original.itemId,
    expectedRevisionId: original.revisionId, edits: [{ offset: 2, bytes: 5, text: 'tea' }] }]))).revisions[0];
  assert.equal((await f.context.readSessionState(edited)).text, 'A tea note');
  await f.context.saveSessionState(f.batch('remove', [{ kind: 'remove', itemId: edited.itemId, expectedRevisionId: edited.revisionId }]));
  assert.equal((await f.context.listSessionState()).items.length, 0);
  assert.equal((await f.context.readSessionState(original)).text, 'A café note');
});

test('unattributed mutation capability is absent and stale owners cannot publish after staging', async () => {
  const f = await fixture();
  const unowned = new ContextService({ repository: f.repository, session: f.session, artifacts: f.artifacts,
    history: f.history, policy: { maxSourceBytes: 1024 } });
  await assert.rejects(unowned.saveSessionState(f.batch('unowned', [{ kind: 'create', text: 'forged' }])), /validator/);
  let owned = true;
  const guarded = new ContextService({ repository: f.repository, session: f.session, artifacts: f.artifacts,
    history: f.history, policy: { maxSourceBytes: 1024 }, assertStateWrite: async () => {},
    withStateOwnership: async operation => { if (!owned) throw new Error('driver ownership expired'); return operation(); } });
  const staged = await guarded.stageSessionState(f.batch('staged', [{ kind: 'create', text: 'must not publish' }]));
  owned = false;
  await assert.rejects(f.repository.saveSessionState(f.session, staged, {
    withOwnership: async operation => { if (!owned) throw new Error('driver ownership expired'); return operation(); }
  }), /ownership expired/);
  assert.deepEqual((await f.context.listSessionState()).items, []);
});

test('admission cannot silently substitute another item revision or public artifact', async () => {
  const f = await fixture();
  const saved = await f.context.saveSessionState(f.batch('two', [{ kind: 'create', text: 'chosen' }, { kind: 'create', text: 'not chosen' }]));
  const cut = await f.history.capture();
  await assert.rejects(f.context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'wrong-view', reason: 'Exact revision selection', renewal: true,
    selection: { retained: [], sessionState: [saved.revisions[0]] }
  }, { admit: async input => ({ ...await admit(input), selection: {
    ...(await admit(input)).selection, sessionState: [saved.revisions[1]]
  } }) }), /changed the requested/);
  assert.equal(await f.history.selectedContext(await f.history.capture()), undefined);
  const artifact = await f.artifacts.store({ label: 'public-report', mediaType: 'text/plain', content: Buffer.from('Exact public report') });
  await f.context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'artifact-view', reason: 'Selected public artifact', renewal: true,
    selection: { retained: [], artifacts: [{ artifact, representation: 'text' }] }
  }, { admit });
  assert.equal((await f.context.selectedArtifactContext())[0].content, 'Exact public report');
  const secret = await f.artifacts.storeProtected({ label: 'secret', content: Buffer.from('private') });
  await assert.rejects(f.context.transition({ expectedWindowId: (await f.history.selectedContext(await f.history.capture())).windowId,
    idempotencyKey: 'protected-view', reason: 'Invalid protected selection', selection: { retained: [], artifacts: [{ artifact: secret, representation: 'reference' }] }
  }, { admit }), /Only public artifacts/);
});

test('save-and-activate tool replaces touched selections and removes deleted items', async () => {
  const f = await fixture();
  const refs = (await f.context.saveSessionState(f.batch('selected', [{ kind: 'create', text: 'old a' }, { kind: 'create', text: 'old b' }]))).revisions;
  await activate(f, refs);
  const cut = await f.history.capture();
  let scheduled;
  f.context.bindRuntime({ origin: async () => ({ inference: f.batch('origin', []).inference, capturedHistoryCut: cut }),
    schedule: async request => { scheduled = request; return { requestId: 'pending' }; } });
  const tool = f.context.toolDefinitions().find(tool => tool.name === 'context_save_and_activate');
  const invocation = { runId: 'run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 };
  const decoded = tool.decodeInput({ kind: 'json', value: { reason: 'Revise and remove selected understanding', operations: [
    { kind: 'replace', itemId: refs[0].itemId, expectedRevisionId: refs[0].revisionId, text: 'new a' },
    { kind: 'remove', itemId: refs[1].itemId, expectedRevisionId: refs[1].revisionId }
  ] } });
  assert.equal(decoded.ok, true);
  const canonical = await tool.canonicalizeInput(decoded.input, { invocation });
  const binding = await tool.bindExecution(canonical, { invocation });
  await binding.invoke({ invocation });
  assert.equal(scheduled.selection.sessionState.length, 1);
  assert.equal(scheduled.selection.sessionState[0].itemId, refs[0].itemId);
  assert.notEqual(scheduled.selection.sessionState[0].revisionId, refs[0].revisionId);
  await f.context.transition(scheduled, { admit });
  assert.deepEqual((await f.context.sessionState()).items.map(item => item.text), ['new a']);
});

test('quota and conflicting batches reject before artifact staging; append failure never publishes state', async () => {
  const bounded = await fixture({ committedRetainedStateBytes: 1024 });
  let writes = 0;
  const store = bounded.artifacts.storeProtected.bind(bounded.artifacts);
  bounded.artifacts.storeProtected = async input => { writes++; return store(input); };
  await assert.rejects(bounded.context.saveSessionState(bounded.batch('too-much', [{ kind: 'create', text: 'x'.repeat(1024) }])), /storage quota/);
  assert.equal(writes, 0, 'known retained quota rejection does not stage unreachable blobs');
  assert.equal(await bounded.repository.committedRetainedStateBytes(bounded.session), 0);

  const f = await fixture();
  const ref = (await f.context.saveSessionState(f.batch('initial', [{ kind: 'create', text: 'original' }]))).revisions[0];
  await f.context.saveSessionState(f.batch('update', [{ kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'current' }]));
  let stagedWrites = 0;
  const saveArtifact = f.artifacts.storeProtected.bind(f.artifacts);
  f.artifacts.storeProtected = async input => { stagedWrites++; return saveArtifact(input); };
  await assert.rejects(f.context.saveSessionState(f.batch('conflicting-batch', [{ kind: 'create', text: 'must not stage' },
    { kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'stale' }])), PersistenceConflictError);
  assert.equal(stagedWrites, 0);

  const commit = f.repository.saveSessionState.bind(f.repository);
  f.repository.saveSessionState = async () => { throw new Error('journal unavailable'); };
  const command = f.batch('fault', [{ kind: 'create', text: 'staged but not committed' }]);
  const before = await f.repository.committedRetainedStateBytes(f.session);
  await assert.rejects(f.context.saveSessionState(command), /journal unavailable/);
  assert.equal(await f.repository.committedRetainedStateBytes(f.session), before);
  assert.equal((await f.context.listSessionState()).items.length, 1);
  f.repository.saveSessionState = commit;
  const receipt = await f.context.saveSessionState(command);
  assert.equal((await f.context.readSessionState(receipt.revisions[0])).text, 'staged but not committed');
});

test('state inspection is bounded while selection identity covers all exact references', async () => {
  const f = await fixture();
  const refs = (await f.context.saveSessionState(f.batch('selected-page', Array.from({ length: 40 }, (_, i) => ({ kind: 'create', text: `item ${i}` }))))).revisions;
  await activate(f, refs);
  const identity = (await f.context.sessionState()).id;
  let reads = 0;
  const read = f.artifacts.readVerified.bind(f.artifacts);
  f.artifacts.readVerified = async ref => { reads++; return read(ref); };
  const inspection = await f.context.inspectSessionState(undefined, 0);
  assert.equal(inspection.selectionId, identity);
  assert.equal(inspection.selectedCount, 40);
  assert.equal(inspection.selectedCoverage, 'partial');
  assert.deepEqual(inspection.selected, []);
  const page = await f.context.listSelectedSessionState({ limit: 2, maxBytes: 1024 });
  const next = await f.context.listSelectedSessionState({ limit: 2, maxBytes: 1024, cursor: page.cursor });
  assert.deepEqual(page.items, refs.slice(0, 2));
  assert.deepEqual(next.items, refs.slice(2, 4));
  assert.equal(reads, 0, 'inspection and selected reference pages do not hydrate item bodies');
});

test('state-only view changes use lawful append admission and do not demand a provider reset', async () => {
  const f = await fixture();
  const refs = (await f.context.saveSessionState(f.batch('views', [{ kind: 'create', text: 'first view' }, { kind: 'create', text: 'second view' }]))).revisions;
  const strategies = [];
  for (const [index, ref] of refs.entries()) {
    const cut = await f.history.capture();
    await f.context.transition({ expectedWindowId: (await f.history.selectedContext(cut))?.windowId ?? null,
      expectedSourceRevision: cut.sourceRevision, idempotencyKey: `append-view-${index}`, reason: 'Change selected understanding',
      selection: { retained: [], sessionState: [ref] }
    }, { admit: async input => { strategies.push(input.strategy); return { compiledInputIdentity: `exact-${index}`,
      capabilityRevision: 'fixture', selection: input.selection }; } });
  }
  assert.deepEqual(strategies, ['append', 'append']);
  assert.equal((await f.context.sessionState()).items[0].text, 'second view');
});

test('artifact view selection requires artifact read authorization before any body read', async () => {
  const f = await fixture();
  const artifact = await f.artifacts.store({ label: 'restricted-report', mediaType: 'text/plain', content: Buffer.from('Do not read without permission') });
  const cut = await f.history.capture();
  let scheduled = 0;
  f.context.bindRuntime({ origin: async () => ({ inference: f.batch('origin', []).inference, capturedHistoryCut: cut }),
    schedule: async () => { scheduled++; return { requestId: 'unexpected' }; } });
  let reads = 0;
  const read = f.artifacts.readVerified.bind(f.artifacts);
  f.artifacts.readVerified = async ref => { reads++; return read(ref); };
  const observation = await invokeToolCall(jsonToolCall('context_transition', {
    reason: 'Try selecting protected-by-policy public report', artifacts: [{ artifact, representation: 'text' }]
  }, 'denied-artifact'), f.context.toolDefinitions(), { policy: { allowedRisks: ['write'] },
    invocation: { runId: 'run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 } });
  assert.equal(observation.kind, 'failure');
  assert.equal(reads, 0);
  assert.equal(scheduled, 0);
});

test('artifact views select explicit text ranges or metadata-only binary references', async () => {
  const f = await fixture();
  const text = await f.artifacts.store({ label: 'text', mediaType: 'text/plain', content: Buffer.from('alpha café omega') });
  const binary = await f.artifacts.store({ label: 'image', mediaType: 'image/png', content: Uint8Array.from([137, 80, 78, 71, 255]) });
  const reads = [];
  const read = f.artifacts.readVerified.bind(f.artifacts);
  f.artifacts.readVerified = async ref => { reads.push(ref.artifactId); return read(ref); };
  const cut = await f.history.capture();
  await f.context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'typed-artifacts', reason: 'Exact artifact representations', selection: { retained: [], artifacts: [
      { artifact: text, representation: 'text', range: { offset: 6, bytes: 5 } },
      { artifact: binary, representation: 'reference' }
    ] } }, { admit });
  assert.deepEqual(reads, [text.artifactId]);
  const material = await f.context.selectedArtifactContext();
  assert.equal(material[0].content, 'café');
  assert.equal(material[0].representation, 'excerpt');
  assert.equal(JSON.parse(material[1].content).artifact.artifactId, binary.artifactId);
  assert.ok(!reads.includes(binary.artifactId));
  const current = await f.history.capture();
  await assert.rejects(f.context.transition({ expectedWindowId: (await f.history.selectedContext(current)).windowId,
    idempotencyKey: 'binary-as-text', reason: 'Invalid binary text representation', selection: { retained: [], artifacts: [
      { artifact: binary, representation: 'text' }
    ] } }, { admit }), /supported text media type/);
  assert.ok(!reads.includes(binary.artifactId));
});

test('state refusal details identify the conditional conflict and exact limit', async () => {
  const f = await fixture({ sessionStateReadBytes: 2 });
  const ref = (await f.context.saveSessionState(f.batch('diagnostic', [{ kind: 'create', text: 'original' }]))).revisions[0];
  const current = (await f.context.saveSessionState(f.batch('new', [{ kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'new value' }]))).revisions[0];
  await assert.rejects(f.context.saveSessionState(f.batch('stale', [{ kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'stale' }])), error => {
    assert.ok(error instanceof PersistenceConflictError);
    assert.equal(error.details.itemId, ref.itemId);
    assert.equal(error.details.expectedRevisionId, ref.revisionId);
    assert.equal(error.details.currentRevisionId, current.revisionId);
    return true;
  });
  await assert.rejects(f.context.readSessionState(current), error => {
    assert.equal(error.details.resource, 'state_read');
    assert.equal(error.details.limit, 2);
    assert.equal(error.details.observedBytes, 9);
    return true;
  });
  const cut = await f.history.capture();
  f.context.bindRuntime({ origin: async () => ({ inference: f.batch('origin', []).inference, capturedHistoryCut: cut }),
    schedule: async () => { throw new Error('Saving cannot schedule a view.'); } });
  const observation = await invokeToolCall(jsonToolCall('context_state_save', { operations: [{ kind: 'replace',
    itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'stale via tool' }] }, 'stale-tool'), f.context.toolDefinitions(),
  { policy: { allowedRisks: ['read', 'write'] }, invocation: { runId: 'run', turnId: 'turn', requestAttempt: 1,
    toolBatchId: 'diagnostic-batch', callIndex: 0, toolAttempt: 1 } });
  assert.equal(observation.kind, 'failure');
  assert.equal(observation.output.details.currentRevisionId, current.revisionId);
  assert.equal(observation.output.details.expectedRevisionId, ref.revisionId);
});

test('denied atomic edits neither read item bodies nor stage new artifacts during planning', async () => {
  const f = await fixture();
  const ref = (await f.context.saveSessionState(f.batch('before-denial', [{ kind: 'create', text: 'existing body' }]))).revisions[0];
  const cut = await f.history.capture();
  f.context.bindRuntime({ origin: async () => ({ inference: f.batch('origin', []).inference, capturedHistoryCut: cut }),
    schedule: async () => { throw new Error('Denied selection must not schedule.'); } });
  let reads = 0, writes = 0;
  const read = f.artifacts.readVerified.bind(f.artifacts);
  const store = f.artifacts.storeProtected.bind(f.artifacts);
  f.artifacts.readVerified = async ref => { reads++; return read(ref); };
  f.artifacts.storeProtected = async input => { writes++; return store(input); };
  const observation = await invokeToolCall(jsonToolCall('context_save_and_activate', {
    reason: 'An edit requires state read access', operations: [{ kind: 'edit', itemId: ref.itemId,
      expectedRevisionId: ref.revisionId, edits: [{ offset: 0, bytes: 8, text: 'changed' }] }]
  }, 'denied-edit'), f.context.toolDefinitions(), { policy: { allowedRisks: ['write'] },
    invocation: { runId: 'run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 } });
  assert.equal(observation.kind, 'failure');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('selected snapshots own immutable range and source identities', async () => {
  const f = await fixture();
  const ref = (await f.context.saveSessionState(f.batch('ownership', [{ kind: 'create', text: 'owned bytes' }]))).revisions[0];
  const mutable = { ...ref, range: { offset: 0, bytes: 5 } };
  const snapshot = await f.context.selectedSessionState([mutable]);
  mutable.range.offset = 6;
  assert.equal(snapshot.items[0].range.offset, 0);
  assert.equal(snapshot.items[0].text, 'owned');
  assert.equal(Object.isFrozen(snapshot.items[0].range), true);
  assert.equal(Object.isFrozen(snapshot.items[0]), true);
});

test('combined activation retains exact source fences while unrelated item saves commit independently', async () => {
  const f = await fixture();
  const original = (await f.context.saveSessionState(f.batch('original-for-atomic', [{ kind: 'create', text: 'original value' }]))).revisions[0];
  const staged = await f.context.stageSessionState(f.batch('combined-race', [{ kind: 'replace', itemId: original.itemId,
    expectedRevisionId: original.revisionId, text: 'must remain unpublished' }]));
  const cut = await f.history.capture();
  await assert.rejects(f.context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'combined-view-race', reason: 'Exact admitted source boundary', sessionState: staged,
    selection: { retained: [], sessionState: staged.revisions.map(({ itemId, revisionId }) => ({ itemId, revisionId })) }
  }, { admit: async input => {
    await f.context.saveSessionState(f.batch('independent-during-admission', [{ kind: 'create', text: 'independent saved value' }]));
    return admit(input);
  } }), PersistenceConflictError);
  assert.equal((await f.context.listSessionState()).items.length, 2);
  assert.equal((await f.repository.currentSessionStateItem(f.session, original.itemId)).revisionId, original.revisionId);
  assert.equal(await f.history.selectedContext(await f.history.capture()), undefined);
});

test('state retrieval rejects forged sibling and abandoned branch boundaries before body reads', async () => {
  const f = await fixture();
  const seed = await f.context.saveSessionState(f.batch('shared-seed', [{ kind: 'create', text: 'shared value' }]));
  const secret = await f.context.saveSessionState(f.batch('abandoned-secret', [{ kind: 'create', text: 'secret abandoned value' }]));
  const abandonedCut = await f.history.capture();
  await f.repository.branchFrom(f.session, seed.entryId, 'sibling');
  const authorizedCut = await f.history.capture();
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const owner = { kind: 'session', sessionId: authorizedCut.sessionId, branchId: authorizedCut.branchId };
  const boundary = await f.context.materials.captureBoundary(owner);
  let reads = 0;
  const read = f.artifacts.readVerified.bind(f.artifacts);
  const range = f.artifacts.readVerifiedRange.bind(f.artifacts);
  f.artifacts.readVerified = async ref => { reads++; return read(ref); };
  f.artifacts.readVerifiedRange = async (ref, span) => { reads++; return range(ref, span); };
  const forgedSearch = encode({ sessionId: authorizedCut.sessionId, branchId: authorizedCut.branchId,
    query: 'secret', leafId: secret.entryId });
  await assert.rejects(f.context.searchSessionState({ query: 'secret', cursor: forgedSearch }), /authorized branch|authorized.*cut/);
  await assert.rejects(f.context.listSessionState({ leafId: secret.entryId }), /authorized branch|authorized.*cut/);
  await assert.rejects(f.context.listSessionState({ cursor: encode({ owner, ...boundary, cursor: encode({ sessionId: authorizedCut.sessionId,
    leafId: secret.entryId, after: seed.revisions[0].itemId, revocationRevision: boundary.revocationRevision }) }) }), /authorized branch|authorized.*cut/);
  await assert.rejects(f.context.readSessionState(secret.revisions[0], abandonedCut), /authorized branch/);
  await assert.rejects(f.context.readSessionState(secret.revisions[0], { ...abandonedCut, branchId: authorizedCut.branchId }), /authorized branch/);
  await assert.rejects(f.context.listSelectedSessionState({ cursor: encode({ cut: { ...abandonedCut,
    branchId: authorizedCut.branchId }, boundary, offset: 0 }) }, authorizedCut), /authorized branch|authorized.*cut/);
  assert.equal(reads, 0);
  assert.equal((await f.context.readSessionState(seed.revisions[0])).text, 'shared value');
});

test('state cursors stay pinned to authorized ancestors and cannot exceed an earlier authorization cut', async () => {
  const f = await fixture();
  await f.context.saveSessionState(f.batch('page-seed', [{ kind: 'create', text: 'match one' }, { kind: 'create', text: 'match two' }]));
  const cut = await f.history.capture();
  const page = await f.context.listSessionState({ limit: 1 });
  const toolPage = await invokeToolCall(jsonToolCall('context_state_list', { limit: 1 }, 'page-one'), f.context.toolDefinitions(),
    { policy: { allowedRisks: ['read'] } });
  assert.equal(toolPage.kind, 'result');
  const search = await f.context.searchSessionState({ query: 'match', limit: 1 });
  const later = await f.context.saveSessionState(f.batch('later-value', [{ kind: 'create', text: 'match later' }]));
  assert.equal((await f.context.listSessionState({ cursor: page.cursor, limit: 1 })).items.length, 1);
  const continued = await invokeToolCall(jsonToolCall('context_state_list', { cursor: toolPage.output.cursor, limit: 1 }, 'page-two'),
    f.context.toolDefinitions(), { policy: { allowedRisks: ['read'] } });
  assert.equal(continued.kind, 'result');
  assert.equal(continued.output.items.length, 1);
  assert.equal((await f.context.searchSessionState({ query: 'match', cursor: search.cursor, limit: 1 })).matches.length, 1);
  await assert.rejects(f.context.listSessionState({ leafId: later.entryId }, cut), /authorized branch|authorized.*cut/);
  const forged = Buffer.from(JSON.stringify({ sessionId: cut.sessionId, branchId: cut.branchId,
    query: 'match', leafId: later.entryId })).toString('base64url');
  await assert.rejects(f.context.searchSessionState({ query: 'match', cursor: forged, cut }), /authorized branch|authorized.*cut/);
});

test('atomic state and view publication is fenced when ownership changes during admission', async () => {
  const f = await fixture();
  let owned = true, guardedPublications = 0;
  const context = new ContextService({ repository: f.repository, session: f.session, artifacts: f.artifacts,
    history: f.history, policy: { maxSourceBytes: 65536 }, assertStateWrite: async () => {},
    withStateOwnership: async publish => {
      guardedPublications++;
      if (!owned) throw new PersistenceConflictError('Run driver ownership was lost.');
      return publish();
    } });
  const staged = await context.stageSessionState(f.batch('takeover-atomic', [{ kind: 'create', text: 'superseded interpretation' }]));
  const cut = await f.history.capture();
  const request = { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision, idempotencyKey: 'takeover-view',
    reason: 'Publish under the originating driver', sessionState: staged,
    selection: { retained: [], sessionState: staged.revisions.map(({ itemId, revisionId }) => ({ itemId, revisionId })) } };
  await assert.rejects(context.transition(request, { admit: async input => { owned = false; return admit(input); } }), /ownership was lost/);
  assert.equal(guardedPublications, 1);
  assert.deepEqual((await f.context.listSessionState()).items, []);
  assert.equal(await f.history.selectedContext(await f.history.capture()), undefined);
  owned = true;
  const committed = await context.transition(request, { admit });
  owned = false;
  assert.equal((await context.transition(request, { admit })).id, committed.id, 'lost receipt reconciliation precedes live ownership');
  assert.equal(guardedPublications, 2);
});

test('state retrieval schemas and repository share defaults and advertised bounds', async () => {
  const f = await fixture();
  await f.context.saveSessionState(f.batch('bounds', Array.from({ length: 128 }, (_, i) => ({ kind: 'create', text: `${i}: ${'😀'.repeat(80)}` }))));
  const direct = await f.repository.listSessionState(f.session, { limit: 256 });
  const service = await f.context.listSessionState({ limit: 256 });
  assert.deepEqual(service.items, direct.items.slice(0, service.items.length), 'Authority-qualified envelope can fit fewer items within the same complete budget');
  assert.equal(service.revocationRevision, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(service)) <= 32768);
  for (const name of ['context_state_list', 'context_state_search']) {
    const tool = f.context.toolDefinitions().find(item => item.name === name);
    const required = name.endsWith('search') ? { query: 'literal' } : {};
    for (const maxBytes of [1, 511, 1048577]) assert.equal(tool.decodeInput({ kind: 'json', value: { ...required, maxBytes } }).ok, false);
    for (const maxBytes of [512, 65536, 1048576]) assert.equal(tool.decodeInput({ kind: 'json', value: { ...required, maxBytes } }).ok, true);
    assert.equal(tool.decodeInput({ kind: 'json', value: { ...required, cursor: 'x'.repeat(16385) } }).ok, false);
    assert.equal(tool.decodeInput({ kind: 'json', value: required }).input.maxBytes, 32768);
    if (required.query) assert.equal(tool.decodeInput({ kind: 'json', value: { query: '😀'.repeat(300) } }).ok, false);
  }
  for (const read of [r => f.context.listSessionState(r), r => f.context.listSelectedSessionState(r), r => f.context.searchSessionState({ query: 'literal', ...r })]) {
    await assert.rejects(read({ maxBytes: 511 }));
    await assert.rejects(read({ maxBytes: 1048577 }));
    await assert.rejects(read({ cursor: 'x'.repeat(16385) }), /cursor/);
  }
});

test('selected and searched pages shrink to the complete envelope and refuse zero progress', async () => {
  const f = await fixture();
  const refs = (await f.context.saveSessionState(f.batch('fit-envelope', Array.from({ length: 8 }, () => ({ kind: 'create', text: '"'.repeat(200) + 'needle' + '"'.repeat(200) }))))).revisions;
  await activate(f, refs);
  for (const read of [r => f.context.listSelectedSessionState(r), r => f.context.searchSessionState({ query: 'needle', ...r })]) {
    const one = await read({ limit: 1 });
    const maxBytes = Buffer.byteLength(JSON.stringify(one));
    const many = await read({ limit: 8, maxBytes });
    assert.equal((many.items ?? many.matches).length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(many)) <= maxBytes);
    assert.ok(many.cursor);
    const next = await read({ cursor: many.cursor, maxBytes });
    assert.notEqual((next.items ?? next.matches)[0].itemId, (many.items ?? many.matches)[0].itemId);
  }
  await assert.rejects(f.context.searchSessionState({ query: 'needle', maxBytes: 512 }), error => {
    assert.equal(error.details.resource, 'state_result');
    assert.ok(error.details.observedBytes > 512);
    assert.match(error.message, /Retry/);
    return true;
  });
  await assert.rejects(f.context.searchSessionState({ query: 'needle', maxScannedBytes: 1 }), error => {
    assert.equal(error.details.resource, 'state_search_scan');
    assert.equal(error.details.observedBytes, 406);
    return true;
  });
});

test('state previews are byte bounded metadata and exact Unicode search spans select original text', async () => {
  const f = await fixture();
  const text = '\uFEFF' + '😀'.repeat(90) + 'café😀needle' + '😀'.repeat(200) + 'needle';
  const [ref] = (await f.context.saveSessionState(f.batch('unicode-spans', [{ kind: 'create', text }]))).revisions;
  let reads = 0;
  const read = f.artifacts.readVerified.bind(f.artifacts);
  f.artifacts.readVerified = async value => { reads++; return read(value); };
  const item = (await f.context.listSessionState()).items[0];
  assert.ok(Buffer.byteLength(item.preview) <= 160);
  assert.ok(text.startsWith(item.preview));
  assert.equal(item.preview.isWellFormed(), true);
  assert.equal(reads, 0);
  const search = await f.context.searchSessionState({ query: 'needle' });
  assert.equal(search.occurrence, 'first_per_item');
  const [match] = search.matches;
  assert.equal(match.excerpt.isWellFormed(), true);
  assert.equal(match.range.offset, Buffer.byteLength(text.slice(0, text.indexOf('needle'))));
  assert.equal((await f.context.readSessionState({ ...ref, range: match.range })).text, 'needle');
  assert.equal((await f.context.readSessionState({ ...ref, range: match.excerptRange })).text, match.excerpt);
  assert.equal((await f.context.readSessionState(ref)).text, text);
});

test('state search reuses bounded history gram machinery and re-verifies candidates', async () => {
  const f = await fixture();
  await f.context.saveSessionState(f.batch('index-work', Array.from({ length: 20 }, (_, i) => ({ kind: 'create', text: `ordinary narrative ${i}` }))));
  let reads = 0;
  const read = f.artifacts.readVerified.bind(f.artifacts);
  f.artifacts.readVerified = async value => { reads++; return read(value); };
  const first = await f.context.searchSessionState({ query: 'absent' });
  assert.equal(first.coverage, 'complete');
  assert.equal(first.indexed, 20);
  assert.equal(reads, 20);
  reads = 0;
  const repeated = await f.context.searchSessionState({ query: 'absent' });
  assert.equal(repeated.coverage, 'complete');
  assert.equal(repeated.indexed, 0);
  assert.equal(repeated.scannedBytes, 0);
  assert.equal(reads, 0);
  const matching = await f.context.searchSessionState({ query: 'ordinary', limit: 256 });
  assert.equal(matching.matches.length, 20);
  assert.equal(reads, 20, 'derived candidates are verified against original immutable bodies');
  await f.context.saveSessionState(f.batch('index-append', [{ kind: 'create', text: 'new absent match' }]));
  reads = 0;
  const appended = await f.context.searchSessionState({ query: 'absent' });
  assert.equal(appended.matches.length, 1);
  assert.equal(appended.indexed, 1);
  assert.equal(reads, 1, 'append indexes only the new revision');
});


test('incremental state search respects scan work and cached abandoned revisions never leak across forks', async () => {
  const f = await fixture();
  const seed = await f.context.saveSessionState(f.batch('incremental', Array.from({ length: 5 }, () => ({ kind: 'create', text: 'ordinary narrative' }))));
  let cursor, indexed = 0;
  do {
    const page = await f.context.searchSessionState({ query: 'absent', maxScannedBytes: 18, ...(cursor ? { cursor } : {}) });
    assert.ok(page.scannedBytes <= 18);
    assert.ok(!cursor || page.cursor !== cursor);
    indexed += page.indexed;
    cursor = page.cursor;
  } while (cursor);
  assert.equal(indexed, 5);
  const future = await f.context.saveSessionState(f.batch('future-cached', [{ kind: 'create', text: 'abandoned secret' }]));
  assert.equal((await f.context.searchSessionState({ query: 'secret' })).matches[0].revisionId, future.revisions[0].revisionId);
  await f.repository.branchFrom(f.session, seed.entryId, 'exclude-cached-future');
  const result = await f.context.searchSessionState({ query: 'secret' });
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.matches, []);
  assert.equal(result.scannedBytes, 0);
});


test('stored previews are refreshed by replace and edit without activating content', async () => {
  const f = await fixture();
  const [original] = (await f.context.saveSessionState(f.batch('preview-original', [{ kind: 'create', text: 'first 😀' }]))).revisions;
  const [replaced] = (await f.context.saveSessionState(f.batch('preview-replace', [{ kind: 'replace', itemId: original.itemId,
    expectedRevisionId: original.revisionId, text: '\uFEFFupdated 😀' }]))).revisions;
  assert.equal((await f.context.listSessionState()).items[0].preview, '\uFEFFupdated 😀');
  await f.context.saveSessionState(f.batch('preview-edit', [{ kind: 'edit', itemId: replaced.itemId,
    expectedRevisionId: replaced.revisionId, edits: [{ offset: 3, bytes: 7, text: 'edited' }] }]));
  assert.equal((await f.context.listSessionState()).items[0].preview, '\uFEFFedited 😀');
  assert.deepEqual((await f.context.sessionState()).items, []);
});


test('state text writes reject lone surrogates before staging or committing', async () => {
  const f = await fixture();
  const valid = '\uFEFFexact 😀 source';
  const [ref] = (await f.context.saveSessionState(f.batch('unicode-valid-source', [{ kind: 'create', text: valid }]))).revisions;
  const revision = await f.repository.revision(f.session);
  let staged = 0;
  const store = f.artifacts.storeProtected.bind(f.artifacts);
  f.artifacts.storeProtected = async input => { staged++; return store(input); };
  for (const [i, text] of ['\uD800', '\uDC00', 'long '.repeat(80) + '\uD800', 'x\uD800y'].entries()) {
    for (const operation of [
      { kind: 'create', text },
      { kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text },
      { kind: 'edit', itemId: ref.itemId, expectedRevisionId: ref.revisionId, edits: [{ offset: 0, bytes: 0, text }] }
    ]) await assert.rejects(f.context.saveSessionState(f.batch(`invalid-unicode-${i}-${operation.kind}`, [operation])), /well-formed Unicode/);
  }
  assert.equal(staged, 0);
  assert.equal(await f.repository.revision(f.session), revision);
  assert.equal((await f.context.readSessionState(ref)).text, valid);
  assert.equal((await f.context.listSessionState()).items.length, 1);
});

test('state read maxBytes is an operation budget for the exact complete JSON result', async () => {
  const f = await fixture({ sessionStateReadBytes: 4096 });
  const [ref] = (await f.context.saveSessionState(f.batch('bounded-read', [{ kind: 'create', text: '\uFEFF😀' + '"'.repeat(100) }]))).revisions;
  const expected = await f.context.readSessionState(ref);
  const required = Buffer.byteLength(JSON.stringify(expected));
  assert.ok(required > Buffer.byteLength(expected.text));
  const tool = f.context.toolDefinitions().find(value => value.name === 'context_state_read');
  for (const maxBytes of [0, -1, 0.5, 1048577]) assert.equal(tool.decodeInput({ kind: 'json', value: { ...ref, maxBytes } }).ok, false);
  assert.equal(tool.decodeInput({ kind: 'json', value: ref }).ok, true);
  assert.equal(tool.decodeInput({ kind: 'json', value: { ...ref, maxBytes: required } }).ok, true);
  const canonical = await tool.canonicalizeInput({ ...ref, maxBytes: required }, {});
  assert.equal(canonical.value.maxBytes, required);
  assert.deepEqual(canonical.value.ref, ref, 'output allowance is excluded from immutable reference identity');
  const result = await invokeToolCall(jsonToolCall('context_state_read', { ...ref, maxBytes: required }, 'bounded-read-ok'),
    f.context.toolDefinitions(), { policy: { allowedRisks: ['read'] } });
  assert.equal(result.kind, 'result');
  assert.deepEqual(result.output, expected);
  assert.equal(Buffer.byteLength(JSON.stringify(result.output)), required);
  const refused = await invokeToolCall(jsonToolCall('context_state_read', { ...ref, maxBytes: required - 1 }, 'bounded-read-refusal'),
    f.context.toolDefinitions(), { policy: { allowedRisks: ['read'] } });
  assert.equal(refused.kind, 'failure');
  assert.equal(refused.output.details.resource, 'state_result');
  assert.equal(refused.output.details.observedBytes, required);
  await assert.rejects(f.context.readSessionState(ref, undefined, 1048577));
  assert.deepEqual(await f.context.readSessionState(ref), expected, 'omitted budget preserves ordinary exact-read behavior');
  const [full] = (await f.context.saveSessionState(f.batch('source-at-limit', [{ kind: 'create', text: 'x'.repeat(4096) }]))).revisions;
  const fullResult = await f.context.readSessionState(full);
  const envelopeBytes = Buffer.byteLength(JSON.stringify(fullResult));
  assert.ok(envelopeBytes > 4096);
  assert.deepEqual(await f.context.readSessionState(full, undefined, envelopeBytes), fullResult,
    'delivery allowance can exceed the independent source-byte allowance to fit metadata');
});
