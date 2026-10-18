import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as z from 'zod';
import { compileModelRequest, conservativeProtocolCapabilities, createProviderContextState } from '@agent-core/model';
import { ToolCatalog, TOOL_CATALOG_LIMITS, InMemoryToolCatalogSelectionStore, captureToolCatalogSelection,
  captureToolSourceSnapshot, describeCatalogTool, defineTool } from '@agent-core/tools';
import { AgentRuntime, InMemorySessionRepository, SessionToolCatalogSelectionStore,
  authorizeToolCatalogEffects, createToolCatalogTools, resolveRuntimeToolCatalog, ContextService, HistoryReader, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';

function tool(name, options = {}) {
  return defineTool({ name, implementationId: `${name}/1`, description: options.description ?? name,
    schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [{ mode: 'read', scope: name }], lockScopes: [] },
    canonicalizeInput: value => value,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: name }], lockScopes: [], recovery: { kind: 'unknown' } }),
    async invoke() { options.onInvoke?.(); return { kind: 'result', output: { value: name }, summary: name,
      execution: { state: 'settled' }, scope: { resources: [name], coverage: 'complete' } }; }
  });
}
function fixture(initial = [tool('alpha'), tool('beta')], selectionStore) {
  const state = { tools: initial, binding: 'connection-1', unavailable: false, loads: 0, replacement: undefined };
  const source = { id: 'fixture',
    async snapshot() { if (state.unavailable) throw new Error('offline'); return captureToolSourceSnapshot({
      sourceId: source.id, bindingRevision: state.binding, tools: state.tools.map(tool => describeCatalogTool({
        sourceId: source.id, toolId: tool.name, bindingRevision: state.binding, tool })) }); },
    async load(reference) { state.loads++; return state.replacement ?? state.tools.find(tool => tool.name === reference.toolId); }
  };
  return { state, source, catalog: new ToolCatalog({ sources: [source], ...(selectionStore ? { selectionStore } : {}) }) };
}
async function select(catalog, references, operationId = 'load') {
  return catalog.select(references, { operationId, expectedOwnerId: catalog.selection().ownerId, expectedSelectionRevision: catalog.selection().selection.revision });
}

test('discovery is bounded metadata; loading selects exact immutable definitions without changing a prior capture', async () => {
  const f = fixture();
  const initial = f.catalog.current();
  const page = await f.catalog.discover({ limit: 1 });
  assert.equal(page.coverage, 'partial');
  assert.equal(page.nextOffset, 1);
  assert.equal(page.items[0].loaded, false);
  assert.equal('jsonSchema' in page.items[0], false);
  assert.equal(f.state.loads, 0);
  const next = await f.catalog.discover({ offset: page.nextOffset, expectedRevision: page.revision });
  assert.equal(next.items[0].name, 'beta');
  const saved = await select(f.catalog, [page.items[0].reference]);
  assert.deepEqual(f.catalog.current().map(tool => tool.name), ['alpha']);
  assert.deepEqual(initial, []);
  assert.equal((await f.catalog.discover()).items[0].loaded, true);
  assert.deepEqual(await f.catalog.select([page.items[0].reference], {
    operationId: 'load', expectedOwnerId: f.catalog.selection().ownerId, expectedSelectionRevision: 'original-revision' }), saved);
  f.state.tools = [f.state.tools[1]];
  await assert.rejects(f.catalog.discover({ offset: 1, expectedRevision: page.revision }), /revision changed/);
  assert.deepEqual(f.catalog.current(), []);
  assert.equal((await f.catalog.discover({ target: 'selection' })).items[0].unavailableReason, 'definition_changed');
});

test('changed contracts, source bindings, collisions and failed loads cannot publish a selection', async () => {
  const f = fixture();
  const page = await f.catalog.discover();
  const original = f.catalog.selection();
  f.state.replacement = tool('alpha', { description: 'changed' });
  await assert.rejects(select(f.catalog, [page.items[0].reference]), /differs from/);
  assert.deepEqual(f.catalog.selection(), original);
  f.state.replacement = undefined;
  f.state.binding = 'connection-2';
  await assert.rejects(select(f.catalog, [page.items[0].reference]), /no longer available/);
  assert.deepEqual(f.catalog.selection(), original);
  const collision = new ToolCatalog({ tools: [tool('alpha')], sources: [f.source] });
  const collisionPage = await collision.discover();
  await assert.rejects(select(collision, [collisionPage.items[0].reference]), /already registered/);
  assert.equal(collision.selection().selection.references.length, 0);
  assert.deepEqual(collision.current().map(tool => tool.name), ['alpha']);
});

test('unavailable selected tools remain recorded but are revoked until the exact binding returns', async () => {
  const store = new InMemoryToolCatalogSelectionStore('branch-a');
  const f = fixture(undefined, store);
  const page = await f.catalog.discover();
  const saved = await select(f.catalog, [page.items[0].reference]);
  f.state.unavailable = true;
  const missing = await f.catalog.discover();
  assert.equal(missing.coverage, 'partial');
  assert.deepEqual(missing.unavailableSources, ['fixture']);
  assert.equal((await f.catalog.discover({ target: 'selection' })).items[0].unavailableReason, 'source_unavailable');
  assert.deepEqual(f.catalog.current(), []);
  assert.deepEqual(f.catalog.selection(), saved);
  const restart = new ToolCatalog({ sources: [f.source], selectionStore: store });
  f.state.unavailable = false;
  assert.deepEqual((await restart.refresh()).map(tool => tool.name), ['alpha']);
  f.state.tools = [tool('alpha', { description: 'new schema identity' })];
  assert.deepEqual(await restart.refresh(), []);
  assert.equal((await restart.discover()).items[0].loaded, false);
  assert.equal((await restart.discover({ target: 'selection' })).items[0].unavailableReason, 'definition_changed');
});

test('catalog cancellation escapes an uncooperative source without poisoning later refreshes', async () => {
  let blocked = true;
  const catalog = new ToolCatalog({ sources: [{ id: 'blocked', async snapshot() {
    if (blocked) return new Promise(() => {});
    return captureToolSourceSnapshot({ sourceId: 'blocked', bindingRevision: 'one', tools: [] });
  }, async load() { throw new Error('unreachable'); } }] });
  const controller = new AbortController();
  const pending = catalog.discover({}, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled-source'));
  await assert.rejects(pending, /cancelled-source/);
  blocked = false;
  assert.equal((await catalog.discover()).totalCount, 0);
});

test('ordinary eager work never contacts unselected sources; selected sources are revalidated and revoked', async () => {
  const f = fixture([tool('remote')]);
  let selectedSnapshots = 0, unrelatedSnapshots = 0;
  const originalSnapshot = f.source.snapshot;
  f.source.snapshot = async signal => { selectedSnapshots++; return originalSnapshot(signal); };
  const catalog = new ToolCatalog({ tools: [tool('local')], sources: [f.source, {
    id: 'unrelated', async snapshot() { unrelatedSnapshots++; throw new Error('optional offline source'); },
    async load() { throw new Error('unreachable'); }
  }] });
  assert.deepEqual((await catalog.refresh()).map(tool => tool.name), ['local']);
  assert.equal(selectedSnapshots, 0);
  assert.equal(unrelatedSnapshots, 0);
  const page = await catalog.discover();
  assert.equal(selectedSnapshots, 1);
  assert.equal(unrelatedSnapshots, 1);
  await select(catalog, [page.items[0].reference]);
  assert.equal(selectedSnapshots, 2);
  assert.equal(unrelatedSnapshots, 1);
  f.state.unavailable = true;
  assert.deepEqual((await catalog.refresh()).map(tool => tool.name), ['local']);
  assert.equal(selectedSnapshots, 3);
  assert.equal(unrelatedSnapshots, 1);
  assert.equal(catalog.selection().selection.references.length, 1);
  await select(catalog, [], 'clear');
  const before = selectedSnapshots;
  await catalog.refresh();
  assert.equal(selectedSnapshots, before);
});

test('source snapshots use bounded concurrency and cancellation prevents queued source starts', async () => {
  let active = 0, maximum = 0, started = 0, blocked = false;
  const releases = [];
  const sources = Array.from({ length: 11 }, (_, index) => ({ id: `source-${index}`,
    async snapshot() {
      started++;
      active++;
      maximum = Math.max(maximum, active);
      const captured = captureToolSourceSnapshot({ sourceId: this.id, bindingRevision: 'one', tools: [] });
      if (blocked) await new Promise(resolve => releases.push(resolve));
      else await new Promise(resolve => setImmediate(resolve));
      active--;
      return captured;
    },
    async load() { throw new Error('unreachable'); }
  }));
  const catalog = new ToolCatalog({ sources });
  const original = await catalog.discover();
  assert.equal(started, sources.length);
  assert.equal(maximum, TOOL_CATALOG_LIMITS.sourceConcurrency);
  started = 0;
  blocked = true;
  const controller = new AbortController();
  const pending = catalog.discover({}, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, TOOL_CATALOG_LIMITS.sourceConcurrency);
  controller.abort(new Error('cancelled-inventory'));
  await assert.rejects(pending, /cancelled-inventory/);
  for (const release of releases) release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, TOOL_CATALOG_LIMITS.sourceConcurrency);
  assert.deepEqual(catalog.current(), []);
  blocked = false;
  assert.equal((await catalog.discover()).revision, original.revision);
});

test('catalog control authorization recognizes exact host definitions and current branch effects only', async () => {
  const f = fixture();
  await f.catalog.refresh();
  const controls = createToolCatalogTools({ catalog: f.catalog });
  const loadTool = controls.find(tool => tool.name === 'tool_catalog_select');
  const request = { call: { name: loadTool.name }, toolImplementationId: loadTool.implementationId,
    effects: { accesses: [{ mode: 'write', scope: 'tool_catalog/runtime' }], lockScopes: ['tool_catalog/runtime'] } };
  assert.equal(authorizeToolCatalogEffects(request, loadTool).decision, 'allow');
  assert.equal(authorizeToolCatalogEffects(request, { ...loadTool }), undefined);
  assert.equal(authorizeToolCatalogEffects({ ...request, effects: {
    accesses: [{ mode: 'write', scope: 'elsewhere' }], lockScopes: ['elsewhere'] } }, loadTool).decision, 'deny');
});

const binding = { schemaId: 'tests/tool-catalog', schemaVersion: 1, subject: {} };
function terminal(runId) { return { runId, finalizationId: `${runId}-final`, phase: 'ended',
  executionStatus: 'completed', terminationReason: 'model_completed', modelTerminationReason: 'stop',
  modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1,
  budget: { modelTurns: 1, totalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0 } }; }
for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: loaded references share the session journal, replay idempotently and follow branch ancestry`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'catalog-selection-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let repository = kind === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository(directory);
    let session = await repository.create({ id: 'catalog-session', binding });
    let store = new SessionToolCatalogSelectionStore(repository, session);
    const f = fixture(undefined, store);
    const page = await f.catalog.discover();
    const before = await store.read();
    const revision = await repository.revision(session);
    await assert.rejects(repository.saveToolCatalogSelection(session, {
      ownerId: before.ownerId, expectedRevision: before.selection.revision,
      selection: captureToolCatalogSelection([page.items[0].reference]), operationId: 'lost-owner'
    }, { withOwnership: async () => { throw new Error('driver fence lost'); } }), /driver fence lost/);
    assert.equal(await repository.revision(session), revision);
    assert.deepEqual(await store.read(), before);
    const first = await select(f.catalog, [page.items[0].reference], 'first');
    await repository.appendInput(session, { runId: 'before-future', task: 'A branch boundary.' });
    await repository.recordRunFinalization(session, terminal('before-future'));
    const point = (await repository.listBranchPoints(session))[0];
    await select(f.catalog, page.items.map(item => item.reference), 'future');
    assert.equal((await store.read()).selection.references.length, 2);
    assert.equal((await repository.readConversation(session)).some(entry => entry.type === 'tool_catalog_selection'), false);
    if (kind === 'jsonl') {
      repository = new JsonlSessionRepository(directory);
      session = await repository.open(session.id, session.header.binding);
      store = new SessionToolCatalogSelectionStore(repository, session);
      assert.equal((await store.read()).selection.references.length, 2);
      assert.equal(repository.indexMetrics().fullScans, 0);
    }
    await repository.branchFrom(session, point.entryId, 'earlier-selection');
    const fork = await store.read();
    assert.notEqual(fork.ownerId, first.ownerId);
    assert.deepEqual(fork.selection, first.selection);
    assert.equal(await store.find('future'), undefined);
    assert.deepEqual((await store.find('first')).selection, first.selection);
    await assert.rejects(store.save({ ownerId: first.ownerId, expectedRevision: first.selection.revision,
      selection: captureToolCatalogSelection([]), operationId: 'wrong-branch' }), /branch changed/);
    const replay = await store.save({ ownerId: fork.ownerId, expectedRevision: 'old',
      selection: first.selection, operationId: 'first' });
    assert.deepEqual(replay, fork);
    const restored = new ToolCatalog({ sources: [f.source], selectionStore: store });
    assert.deepEqual((await restored.refresh()).map(tool => tool.name), ['alpha']);
    if (kind === 'jsonl') {
      await rm(`${repository.location(session.id)}.index`);
      const rebuilt = new JsonlSessionRepository(directory);
      assert.deepEqual((await rebuilt.currentToolCatalogSelection(session)).selection, first.selection);
      assert.equal(await rebuilt.findToolCatalogSelection(session, 'future'), undefined);
    }
  });
}

function provider(complete) { return { id: 'fixture', implementationId: 'fixture/1',
  describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'fixture' }),
  async describeModel() { return { id: 'fixture', provider: 'fixture', capabilities: {
    streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false,
    jsonSchema: false, logprobs: false, temperature: false, topP: false },
    modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 32000, outputTokens: 1000 },
    supportedParameters: ['tools', 'maxOutputTokens'] }; }, complete }; }
const call = (id, name, value = {}) => ({ id, type: 'function', name, input: { kind: 'json', value } });
const response = calls => ({ provider: 'fixture', model: 'fixture', content: '', terminationReason: 'tool_calls', toolCalls: calls });
const done = { provider: 'fixture', model: 'fixture', content: 'Done.', terminationReason: 'stop' };

test('loading does not authorize an unadvertised same-batch call; only a successor admission can call it', async () => {
  let invokes = 0, requests = 0;
  const f = fixture([tool('alpha', { onInvoke: () => invokes++ })]);
  const descriptor = (await f.catalog.discover()).items[0];
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ id: 'runtime-catalog', binding });
  const runtime = new AgentRuntime({ provider: provider(async request => {
    requests++;
    if (requests === 1) {
      assert.equal(request.tools.some(tool => tool.function?.name === 'alpha'), false);
      return response([call('load-alpha', 'tool_catalog_select', { references: [descriptor.reference],
        expectedSelectionRevision: f.catalog.selection().selection.revision }), call('early-alpha', 'alpha')]);
    }
    if (requests === 2) {
      assert.equal(invokes, 0);
      assert.equal(request.tools.some(tool => tool.function?.name === 'alpha'), true, JSON.stringify(request));
      return response([call('admitted-alpha', 'alpha')]);
    }
    return done;
  }), model: 'fixture', maxOutputTokens: 64, toolCatalog: f.catalog,
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolBoundary: { authorizationPolicyId: 'catalog-fixture', executionTargetId: 'catalog-fixture' },
    repositories: { events, artifacts: new InMemoryArtifactRepository(),
      session: { repository: sessions, descriptor: session } } });
  const result = await runtime.run({ runId: 'catalog-batch', task: 'Load alpha and use it.' }).result;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
  assert.equal(invokes, 1);
  const starts = [];
  for await (const record of events.read('catalog-batch')) if (record.event.type === 'tool.started') starts.push(record.event.callId);
  assert.deepEqual(starts, ['load-alpha', 'admitted-alpha']);
  assert.equal((await sessions.currentToolCatalogSelection(session)).selection.references.length, 1);
  const restored = new ToolCatalog({ sources: [f.source],
    selectionStore: new SessionToolCatalogSelectionStore(sessions, session) });
  assert.deepEqual((await restored.refresh()).map(tool => tool.name), ['alpha']);
});


test('reserved host control names reject deferred collisions before selection publication', async () => {
  const f = fixture([tool('tool_catalog_select')]);
  createToolCatalogTools({ catalog: f.catalog });
  const page = await f.catalog.discover();
  await assert.rejects(select(f.catalog, [page.items[0].reference]), /host-reserved/);
  assert.equal(f.catalog.selection().selection.references.length, 0);
  assert.throws(() => createToolCatalogTools({ catalog: new ToolCatalog({ tools: [tool('tool_catalog_discover')] }) }), /host-reserved/);
});

test('failed successor compilation preserves loaded selection without publishing admitted capability', async () => {
  let invokes = 0, generations = 0;
  const f = fixture([tool('alpha', { onInvoke: () => invokes++ })]);
  const descriptor = (await f.catalog.discover()).items[0];
  const selectedBefore = f.catalog.selection().selection.revision;
  const events = new InMemoryEventRepository(agentEventCodec);
  const model = provider(async () => {
    generations++;
    return response([call('load-before-failure', 'tool_catalog_select', { references: [descriptor.reference],
      expectedSelectionRevision: selectedBefore })]);
  });
  model.compileRequest = async request => {
    if (request.tools.some(tool => tool.function?.name === 'alpha')) throw new Error('Successor compilation refused.');
    const { signal: _signal, ...body } = request;
    return compileModelRequest({ request, body, profile: await model.describeModel(), endpoint: 'fixture://catalog', providerInputTokens: 100 });
  };
  const runtime = new AgentRuntime({ provider: model, model: 'fixture', maxOutputTokens: 64,
    toolCatalog: f.catalog, toolPolicy: { allowedRisks: ['read', 'write'] },
    toolBoundary: { authorizationPolicyId: 'catalog-fixture', executionTargetId: 'catalog-fixture' },
    repositories: { events, artifacts: new InMemoryArtifactRepository() } });
  await runtime.run({ runId: 'failed-successor', task: 'Load alpha.' }).result;
  assert.equal(generations, 1);
  assert.equal(invokes, 0);
  assert.equal(f.catalog.selection().selection.references.length, 1);
  const configured = await runtime.inspectOperational();
  assert.equal(configured.capabilities.items.some(tool => tool.name === 'alpha'), true);
  const admitted = await runtime.inspectOperational({ target: 'last_admitted' });
  assert.equal(admitted.capabilities.items.some(tool => tool.name === 'alpha'), false);
});


test('selection atomically replaces, shrinks and clears references with one shared bound', async () => {
  const f = fixture();
  const page = await f.catalog.discover();
  const first = await select(f.catalog, page.items.map(item => item.reference), 'both');
  assert.deepEqual(f.catalog.current().map(tool => tool.name), ['alpha', 'beta']);
  const loads = f.state.loads;
  await select(f.catalog, [page.items[1].reference], 'beta-only');
  assert.deepEqual(f.catalog.current().map(tool => tool.name), ['beta']);
  assert.equal(f.state.loads, loads, 'Retained exact implementations are reused.');
  await assert.rejects(f.catalog.select([], { operationId: 'stale', expectedOwnerId: f.catalog.selection().ownerId, expectedSelectionRevision: first.selection.revision }), /selection changed/);
  f.state.unavailable = true;
  const missing = await f.catalog.discover({ target: 'selection', limit: 1 });
  assert.equal(missing.items[0].reference.toolId, 'beta');
  assert.equal(missing.items[0].unavailableReason, 'source_unavailable');
  await select(f.catalog, [], 'clear-unavailable');
  assert.deepEqual(f.catalog.current(), []);
  assert.deepEqual(f.catalog.selection().selection.references, []);
  await assert.rejects(f.catalog.select([page.items[0].reference], {
    operationId: 'clear-unavailable', expectedOwnerId: f.catalog.selection().ownerId,
    expectedSelectionRevision: first.selection.revision }), /operation changed/);
});

test('selection rejects a branch owner changed after canonicalization even when its revision is unchanged', async () => {
  const store = new InMemoryToolCatalogSelectionStore('branch-a');
  const f = fixture(undefined, store);
  const page = await f.catalog.discover();
  const authorized = f.catalog.selection();
  const replacement = new InMemoryToolCatalogSelectionStore('branch-b');
  f.catalog.bindSelectionStore(replacement);
  await assert.rejects(f.catalog.select([page.items[0].reference], {
    operationId: 'wrong-branch', expectedOwnerId: authorized.ownerId,
    expectedSelectionRevision: authorized.selection.revision
  }), /owner changed/);
  assert.equal((await replacement.read()).selection.references.length, 0);
  assert.equal(await replacement.find('wrong-branch'), undefined);
  assert.equal(f.state.loads, 0);
});

test('selection count and identifier byte bounds are shared before persistence', () => {
  const reference = { sourceId: 'source', toolId: 'tool', revision: 'revision', bindingRevision: 'binding' };
  assert.throws(() => captureToolCatalogSelection(Array.from({ length: TOOL_CATALOG_LIMITS.selectionReferences + 1 },
    (_, index) => ({ ...reference, toolId: `tool-${index}` }))), /bound/);
  assert.throws(() => captureToolCatalogSelection([{ ...reference, toolId: 'é'.repeat(513) }]), /toolId/);
});

test('removing the final source retains controls for discovering and clearing durable references', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'removed-sources', binding });
  const store = new SessionToolCatalogSelectionStore(repository, session);
  const f = fixture([tool('previously-configured')], store);
  await select(f.catalog, [(await f.catalog.discover()).items[0].reference]);
  const restarted = new ToolCatalog({ tools: [tool('local')], selectionStore: store });
  assert.deepEqual((await resolveRuntimeToolCatalog(restarted)).map(tool => tool.name),
    ['local', 'tool_catalog_discover', 'tool_catalog_select']);
  const page = await restarted.discover({ target: 'selection' });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].unavailableReason, 'source_unavailable');
  assert.equal(page.items[0].loaded, false);
  let requests = 0;
  const runtime = new AgentRuntime({ provider: provider(async request => {
    requests++;
    if (requests === 1) {
      assert.equal(request.tools.some(tool => tool.function?.name === 'tool_catalog_select'), true);
      return response([call('clear-removed', 'tool_catalog_select', { references: [],
        expectedSelectionRevision: (await store.read()).selection.revision })]);
    }
    assert.equal(request.tools.some(tool => tool.function?.name === 'tool_catalog_select'), false);
    return done;
  }), tools: [tool('local')], model: 'fixture', maxOutputTokens: 64,
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolBoundary: { authorizationPolicyId: 'catalog-fixture', executionTargetId: 'catalog-fixture' },
    repositories: { events: new InMemoryEventRepository(agentEventCodec), artifacts: new InMemoryArtifactRepository(),
      session: { repository, descriptor: session } } });
  const result = await runtime.run({ runId: 'clear-removed-sources', task: 'Clear unavailable tool references.' }).result;
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(requests, 2);
  assert.equal((await store.read()).selection.references.length, 0);
  assert.deepEqual((await resolveRuntimeToolCatalog(restarted)).map(tool => tool.name), ['local']);
});

test('selection discovery pages every unavailable exact reference with one pinned cursor contract', async () => {
  const f = fixture(Array.from({ length: 40 }, (_, i) => tool(`item_${String(i).padStart(2, '0')}`)));
  const inventory = await f.catalog.discover({ limit: 128 });
  await select(f.catalog, inventory.items.map(item => item.reference));
  f.state.unavailable = true;
  const first = await f.catalog.discover({ target: 'selection', limit: 17 });
  const second = await f.catalog.discover({ target: 'selection', offset: first.nextOffset, limit: 128, expectedRevision: first.revision });
  assert.equal(new Set([...first.items, ...second.items].map(item => item.reference.toolId)).size, 40);
  assert.equal(first.unavailableSelectedCount, 40);
  assert.equal(second.nextOffset, undefined);
  assert.ok(first.items.every(item => item.unavailableReason === 'source_unavailable'));
  const controls = createToolCatalogTools({ catalog: f.catalog });
  const resolved = await resolveRuntimeToolCatalog(f.catalog);
  assert.equal(resolved.find(tool => tool.name === 'tool_catalog_select'), controls.find(tool => tool.name === 'tool_catalog_select'));
});

test('oversized selected schemas can be cleared through an admitted bounded recovery request', async () => {
  const f = fixture([tool('large_schema')]);
  const descriptor = (await f.catalog.discover()).items[0];
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({ repository: sessions, session, history, artifacts,
    policy: { maxSourceBytes: 100000, historyRead: { history, isAvailable: () => true } } });
  let ordinary = 0, recoveries = 0;
  const model = provider(async request => {
    const recovery = request.messages.some(item => item.role === 'user' && item.content.includes('Prepare a fresh context for the same ongoing work'));
    if (recovery) {
      recoveries++;
      assert.equal(request.tools.some(tool => tool.function?.name === 'large_schema'), false);
      assert.equal(request.tools.some(tool => tool.function?.name === 'tool_catalog_select'), true);
      return response([call('clear-schema', 'tool_catalog_select', { references: [],
        expectedSelectionRevision: f.catalog.selection().selection.revision })]);
    }
    ordinary++;
    return ordinary === 1 ? response([call('select-large', 'tool_catalog_select', { references: [descriptor.reference],
      expectedSelectionRevision: f.catalog.selection().selection.revision })]) : done;
  });
  model.compileRequest = async request => {
    const { signal: _signal, ...body } = request;
    return compileModelRequest({ request, body, profile: await model.describeModel(), endpoint: 'fixture://catalog-pressure',
      providerInputTokens: request.tools.some(tool => tool.function?.name === 'large_schema') ? 40000 : 1000 });
  };
  const runtime = new AgentRuntime({ provider: model, model: 'fixture', maxOutputTokens: 64,
    toolCatalog: f.catalog, context, contextRenewal: { automatic: true },
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolBoundary: { authorizationPolicyId: 'catalog-fixture', executionTargetId: 'catalog-fixture' },
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } } });
  const result = await runtime.run({ runId: 'schema-recovery', task: 'Select the tool, then recover if its schema does not fit.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(recoveries, 1);
  assert.equal(ordinary, 2);
  assert.deepEqual(f.catalog.selection().selection.references, []);
});


test('native recovery keeps the admitted prefix and tool catalog after an oversized fresh proposal fails', async () => {
  const f = fixture([tool('native_large_schema')]);
  const descriptor = (await f.catalog.discover()).items[0];
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({ repository: sessions, session, history, artifacts,
    policy: { maxSourceBytes: 100000, historyRead: { history, isAvailable: () => true } } });
  let ordinary = 0, recoveries = 0, rejectedFresh = 0;
  let originalTools;
  const model = provider(async request => {
    const recovery = request.messages.some(item => item.role === 'user' && item.content.includes('Prepare a fresh context for the same ongoing work'));
    if (recovery) {
      recoveries++;
      assert.deepEqual(request.tools, originalTools, 'Recovery uses the exact admitted inventory.');
      assert.ok(request.messages.some(item => item.role === 'protocol' && item.state.data.marker === 'KEEP-EXACT-NATIVE'));
      assert.ok(request.messages.some(item => item.role === 'tool' && item.toolCallId === 'native-select-large'));
      return response([call('native-clear-schema', 'tool_catalog_select', { references: [],
        expectedSelectionRevision: f.catalog.selection().selection.revision })]);
    }
    ordinary++;
    if (ordinary > 1) return done;
    originalTools = request.tools;
    const selected = call('native-select-large', 'tool_catalog_select', { references: [descriptor.reference],
      expectedSelectionRevision: f.catalog.selection().selection.revision });
    const state = await createProviderContextState({ provider: 'fixture', protocolRevision: 'conservative-v1',
      endpoint: 'fixture://native-catalog', request, requestId: 'native-catalog-request',
      kind: 'fixture.native-catalog', data: { marker: 'KEEP-EXACT-NATIVE' }, requiresExactPrefix: true, tokenEstimate: 8 });
    return { ...response([selected]), output: [{ type: 'protocol', state }, { type: 'tool_call', toolCall: selected }] };
  });
  const describe = model.describeModel;
  model.describeModel = async () => {
    const profile = await describe();
    return { ...profile, capabilities: { ...profile.capabilities, protocol: conservativeProtocolCapabilities('fixture://native-catalog', {
      inputKinds: ['text', 'tool_call', 'tool_result', 'protocol'], outputKinds: ['text', 'tool_call', 'protocol'],
      state: 'exact', contextReset: 'fresh_request' }) } };
  };
  model.compileRequest = async request => {
    const large = request.tools.some(tool => tool.function?.name === 'native_large_schema');
    if (large && !request.messages.some(item => item.role === 'protocol')) rejectedFresh++;
    const { signal: _signal, ...body } = request;
    return compileModelRequest({ request, body, profile: await model.describeModel(), endpoint: 'fixture://native-catalog',
      providerInputTokens: large ? 40000 : 1000 });
  };
  const runtime = new AgentRuntime({ provider: model, model: 'fixture', maxOutputTokens: 64,
    toolCatalog: f.catalog, context, contextRenewal: { automatic: true },
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolBoundary: { authorizationPolicyId: 'catalog-fixture', executionTargetId: 'catalog-fixture' },
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } } });
  const result = await runtime.run({ runId: 'native-schema-recovery', task: 'Keep the exact native prefix while correcting tool selection.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.ok(rejectedFresh > 0);
  assert.equal(recoveries, 1);
  assert.equal(ordinary, 2);
  assert.deepEqual(f.catalog.selection().selection.references, []);
});
