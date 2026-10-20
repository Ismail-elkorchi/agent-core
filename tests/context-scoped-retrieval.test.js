import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';
import { InMemorySkillSource, SkillCatalog } from '@agent-core/skills';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, PersistenceConflictError } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemoryMaterialGrantProvider, InMemoryMaterialRepository,
  InMemorySessionRepository, collectOptionalContext } from '@agent-core/runtime';
import { admittedSelection } from './context-admission-fixtures.js';

const request = { task: 'Current task', turnIndex: 1, instructions: [], boundary: {
  runId: 'run', turnId: 'turn', requestAttempt: 1, instructionHash: 'exact-instructions' } };
const item = content => ({ sourceUri: 'test://evidence', sourceKind: 'external', representation: 'full', mediaType: 'text/plain', title: 'Evidence', purpose: 'Reference material', content });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const signal = () => new AbortController().signal;

test('optional supplier receives captured identity, cancellation, deadline and complete output bounds', async () => {
  let captured;
  const result = await collectOptionalContext({ owner: {}, request, signal: signal(), isCurrent: () => true,
    policy: { maxItems: 2, maxBytes: 1024, timeoutMs: 1000 },
    provider: input => { captured = input; return { items: [item('one')], candidates: { materials: [] } }; } });
  assert.equal(result.result.items[0].content, 'one');
  assert.deepEqual(captured.boundary, request.boundary);
  assert.deepEqual(captured.budget, { maxItems: 2, maxBytes: 1024 });
  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal(typeof captured.deadline, 'number');
  const oversized = await collectOptionalContext({ owner: {}, request, signal: signal(), isCurrent: () => true,
    policy: { maxBytes: 128 }, provider: () => ({ items: [item('x')] }) });
  assert.equal(oversized.diagnostic, 'budget', 'The envelope and attribution count even when body text is small');
  assert.deepEqual(oversized.result.items, []);
});

test('obsolete recall aborts immediately and ignores later completion without clearing selections', async () => {
  const entered = deferred(), release = deferred(), obsolete = new AbortController();
  let supplierSignal;
  const running = collectOptionalContext({ owner: {}, request, signal: signal(), obsoleteSignal: obsolete.signal,
    isCurrent: () => !obsolete.signal.aborted,
    provider: async input => { supplierSignal = input.signal; entered.resolve(); await release.promise; return { items: [item('STALE')] }; } });
  await entered.promise;
  obsolete.abort();
  const result = await running;
  assert.equal(result.diagnostic, 'stale');
  assert.equal(supplierSignal.aborted, true);
  release.resolve();
  await Promise.resolve();
  assert.deepEqual(result.result.items, []);
  const empty = await collectOptionalContext({ owner: {}, request, signal: signal(), isCurrent: () => true,
    provider: () => ({ items: [], candidates: { materials: [] } }) });
  assert.equal(empty.diagnostic, undefined);
  assert.deepEqual(empty.result.candidates.materials, []);
});

test('optional recall deadline bounds remote candidate validation too', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred();
  const candidate = { owner: { kind: 'scope', scopeId: 'granted' }, itemId: 'item', revisionId: 'rev' };
  const running = collectOptionalContext({ owner: {}, request, signal: signal(), policy: { timeoutMs: 100 },
    isCurrent: () => true, provider: () => ({ items: [], candidates: { materials: [candidate] } }),
    validateCandidates: async () => { entered.resolve(); return new Promise(() => {}); } });
  await entered.promise;
  t.mock.timers.tick(100);
  const result = await running;
  assert.equal(result.diagnostic, 'deadline');
  assert.deepEqual(result.result.items, []);
});

test('timed-out supplier and validator attempts cannot accumulate for one runtime collection owner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const blockedPhase of ['supplier', 'validator']) {
    const entered = deferred(), release = deferred();
    let calls = 0;
    const provider = async () => { calls++; if (blockedPhase === 'supplier') { entered.resolve(); await release.promise; } return { items: [], candidates: { materials: [] } }; };
    const input = { owner: {}, request, signal: signal(), policy: { timeoutMs: 100 }, isCurrent: () => true, provider,
      validateCandidates: async () => { if (blockedPhase === 'validator') { entered.resolve(); await release.promise; } } };
    const running = collectOptionalContext(input);
    await entered.promise; t.mock.timers.tick(100);
    assert.equal((await running).diagnostic, 'deadline');
    for (let index = 0; index < 20; index++) assert.equal((await collectOptionalContext(input)).diagnostic, 'busy');
    assert.equal(calls, 1);
    const independent = collectOptionalContext({ ...input, owner: {} });
    await Promise.resolve();
    assert.equal(calls, 2, 'Independent runtime owners do not block one another');
    release.resolve();
    await independent; await new Promise(resolve => setImmediate(resolve));
    assert.equal((await collectOptionalContext(input)).diagnostic, undefined);
    assert.equal(calls, 3);
  }
});

test('run cancellation remains cancellation; failed optional retrieval is explicitly diagnostic', async () => {
  const controller = new AbortController(), entered = deferred();
  const running = collectOptionalContext({ owner: {}, request, signal: controller.signal, isCurrent: () => true,
    provider: async () => { entered.resolve(); return new Promise(() => {}); } });
  const rejected = assert.rejects(running, /cancelled/);
  await entered.promise; controller.abort(new Error('cancelled')); await rejected;
  const failed = await collectOptionalContext({ owner: {}, request, signal: signal(), isCurrent: () => true,
    provider: () => { throw new Error('remote unavailable'); } });
  assert.equal(failed.diagnostic, 'failed');
});

async function fixture() {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ binding: { schemaId: 'scoped-search', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository, session, artifacts });
  const materialRepository = new InMemoryMaterialRepository();
  const owner = { kind: 'scope', scopeId: 'private-a' };
  const grants = new InMemoryMaterialGrantProvider([{ owner, revision: 'one', read: true, write: true }]);
  const requestRef = await artifacts.storeProtected({ label: 'producer', content: Buffer.from('{}') });
  const context = new ContextService({ repository, session, artifacts, history,
    materials: { repository: materialRepository, artifacts, grants, maxMutationBytes: 4 * 1024 * 1024 },
    assertStateWrite: async () => {}, policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const batch = async (key, operations) => {
    const cut = await history.capture();
    return { owner, idempotencyKey: key, branchId: cut.branchId, capturedHistoryCut: cut,
      inference: { ownerId: 'owner', invocationId: 'one', requestRef }, operations };
  };
  return { context, repository, session, artifacts, history, materialRepository, owner, grants, batch };
}

test('one bounded literal search returns direct scope-qualified UTF-8 references and invalidates revoked cursors', async () => {
  const f = await fixture();
  await f.context.saveSessionState(await f.batch('initial', [
    { kind: 'create', text: 'A 😀 needle one', subject: { personId: 'a', name: 'Alex' } },
    { kind: 'create', text: 'B 😀 needle two', subject: { personId: 'b', name: 'Alex' } }
  ]));
  const page = await f.context.searchMaterials(f.owner, { query: '😀', limit: 1, maxBytes: 4096 });
  assert.equal(page.matches.length, 1); assert.equal(page.coverage, 'partial');
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
  const { excerpt, excerptRange, ...ref } = page.matches[0];
  assert.equal((await f.context.readMaterial(ref)).text, '😀');
  assert.deepEqual(ref.owner, f.owner);
  const next = await f.context.searchMaterials(f.owner, { query: '😀', limit: 1, cursor: page.cursor });
  assert.equal(next.matches.length, 1); assert.notEqual(next.matches[0].itemId, ref.itemId);
  await assert.rejects(f.context.searchMaterials(f.owner, { query: 'other', cursor: page.cursor }), /changed query/);
  await f.context.materials.revoke({ owner: f.owner, operationId: 'revoke', expectedRevision: 0,
    refs: [{ itemId: ref.itemId, revisionId: ref.revisionId }] });
  await assert.rejects(f.context.searchMaterials(f.owner, { query: '😀', cursor: page.cursor }), /authority|revocation/);
});

test('denied scope is rejected before parsing cursors, reading metadata or consulting cached search', async t => {
  const f = await fixture();
  await f.context.saveSessionState(await f.batch('initial', [{ kind: 'create', text: 'private needle' }]));
  await f.context.searchMaterials(f.owner, { query: 'needle' });
  await f.grants.withdraw(f.owner, (await f.grants.get(f.owner)).revision);
  for (const method of ['list', 'read', 'revocationRevision']) t.mock.method(f.materialRepository, method, async () => assert.fail('Unauthorized metadata access'));
  await assert.rejects(f.context.searchMaterials(f.owner, { query: 'needle', cursor: 'invalid-json' }), /unavailable|grant/);
});

test('explicit empty selection clears applicability; failed oversized activation publishes nothing', async () => {
  const f = await fixture();
  const ref = (await f.context.saveSessionState(await f.batch('initial', [{ kind: 'create', text: 'retained preference' }]))).revisions[0];
  const activate = async (key, refs, admit = async input => ({ compiledInputIdentity: 'test', capabilityRevision: 'test', selection: admittedSelection(input) })) => {
    const cut = await f.history.capture();
    return f.context.transition({ idempotencyKey: key, reason: 'select exact material', renewal: true,
      expectedWindowId: (await f.history.selectedContext(cut))?.windowId ?? null,
      expectedSourceRevision: cut.sourceRevision, selection: { retained: [], materials: refs } }, { admit });
  };
  await activate('one', [ref]);
  const window = await f.history.selectedContext();
  await assert.rejects(activate('denied', [], async () => { throw new Error('capacity exceeded'); }), /capacity/);
  assert.equal((await f.history.selectedContext()).windowId, window.windowId);
  await activate('clear', []);
  assert.deepEqual((await f.history.selectedContext()).selection.materials, []);
  assert.equal((await f.context.readMaterial(ref)).text, 'retained preference');
});

test('one state tool family routes explicit shared owners through canonical material authority', async () => {
  const f = await fixture();
  const ref = (await f.context.saveSessionState(await f.batch('tool-data', [{ kind: 'create', text: 'shared searchable material' }]))).revisions[0];
  const tools = f.context.toolDefinitions();
  assert.ok(!tools.some(tool => /context_material_(list|read|search)$/.test(tool.name)));
  const call = (name, args) => invokeToolCall(jsonToolCall(name, args, name), tools, { policy: { allowedRisks: ['read'] } });
  const listed = await call('context_state_list', { owner: f.owner });
  assert.equal(listed.kind, 'result');
  assert.deepEqual(listed.output.items[0].owner, f.owner);
  const read = await call('context_state_read', { ...ref, owner: f.owner });
  assert.equal(read.kind, 'result'); assert.equal(read.output.text, 'shared searchable material');
  const found = await call('context_state_search', { owner: f.owner, query: 'searchable' });
  assert.equal(found.kind, 'result'); assert.deepEqual(found.output.matches[0].owner, f.owner);
});

test('skill discovery tool limits are the package canonical service limits', async () => {
  const f = await fixture();
  const source = new InMemorySkillSource({ scopeId: 'methods', bindingRevision: 'one', packages: [] });
  const skills = new SkillCatalog({ sources: [source] });
  const context = new ContextService({ repository: f.repository, session: f.session, artifacts: f.artifacts,
    history: f.history, skills, policy: { maxSourceBytes: 65536 } });
  const tools = context.toolDefinitions();
  const discover = tools.find(tool => tool.name === 'context_skill_discover');
  for (const [key, limit] of [['limit', 64], ['maxBytes', 128 * 1024], ['maxScanned', 32]]) {
    assert.equal(discover.decodeInput({ kind: 'json', value: { scopeId: 'methods', [key]: limit } }).ok, true);
    assert.equal(discover.decodeInput({ kind: 'json', value: { scopeId: 'methods', [key]: limit + 1 } }).ok, false);
  }
  const scopes = await invokeToolCall(jsonToolCall('context_skill_scopes', {}, 'scopes'), tools, { policy: { allowedRisks: ['read'] } });
  assert.equal(scopes.kind, 'result'); assert.deepEqual(scopes.output.items, [{ scopeId: 'methods', bindingRevision: 'one' }]);
});

test('local save reconciles an exact committed receipt before classifying a host fence error', async () => {
  const f = await fixture();
  const context = new ContextService({ repository: f.repository, session: f.session, artifacts: f.artifacts,
    history: f.history, policy: { maxSourceBytes: 65536 }, assertStateWrite: async () => {},
    withStateOwnership: async publish => { await publish(); throw new PersistenceConflictError('Host fence failed after commit'); } });
  const cut = await f.history.capture();
  const batch = { ...await f.batch('committed-before-fence-error', [{ kind: 'create', text: 'Actually committed' }]),
    owner: { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId } };
  const receipt = await context.saveSessionState(batch);
  assert.equal(receipt.revisions.length, 1);
  assert.equal((await context.readSessionState(receipt.revisions[0])).text, 'Actually committed');
  assert.equal((await context.saveSessionState(batch)).entryId, receipt.entryId);
});

test('transactional save and pre-schedule activation rejection are explicit known nonexecution', async () => {
  const f = await fixture();
  const cut = await f.history.capture(), owner = { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId };
  const batch = { ...await f.batch('local-to-correct', [{ kind: 'create', text: 'Current retained meaning' }]), owner };
  const ref = (await f.context.saveSessionState(batch)).revisions[0];
  const currentCut = await f.history.capture();
  f.context.bindRuntime({ origin: async () => ({ inference: batch.inference, capturedHistoryCut: currentCut }),
    schedule: async () => assert.fail('Rejected staged state must not schedule activation') });
  const tools = f.context.toolDefinitions();
  const invocation = { runId: 'test-run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 };
  for (const name of ['context_state_save', 'context_save_and_activate']) {
    const args = { operations: [{ kind: 'replace', itemId: ref.itemId, expectedRevisionId: 'not-current', text: 'Stale change' }],
      ...(name.endsWith('activate') ? { reason: 'Attempt stale replacement' } : {}) };
    const observed = await invokeToolCall(jsonToolCall(name, args, name), tools, { invocation, policy: { allowedRisks: ['read', 'write'] } });
    assert.equal(observed.kind, 'failure');
    assert.equal(observed.execution.state, 'not_started');
    assert.match(observed.summary, /revision|conflict|changed/i);
  }
  assert.equal((await f.context.readSessionState(ref)).text, 'Current retained meaning');
  assert.equal(await f.history.selectedContext(), undefined);
});
