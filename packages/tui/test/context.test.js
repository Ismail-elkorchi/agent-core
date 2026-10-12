import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { contextView, createContextState, updateContext } from '@agent-core/tui';

for (const columns of [48, 120])
  test(`context selection at ${columns} columns preserves protected sources and current working-state interpretation`, async (t) => {
    const source = { sessionId: 'session', entryId: 'input', sha256: 'a'.repeat(64) };
    const cut = {
      format: 'agent-core.history/1',
      sessionId: 'session',
      branchId: 'session',
      throughEntryId: 'input',
      sourceRevision: 1,
      ledgerCoverage: 'session'
    };
    const inspection = {
      cut,
      window: null,
      activeSelection: { status: 'available', selection: { strategy: 'sources', retained: [source] } },
      workingState: { revisionId: 'revision', text: 'A model hypothesis', complete: true },
      protectedSources: [source],
      pendingWork: [],
      legalTransitions: ['sources'],
      budget: { maxSourceBytes: 8192, quality: 'byte_bound' }
    };
    const selections = [];
    const operations = {
      inspectContext: async () => inspection,
      contextSources: async (request) => {
        assert.equal(request.cut, cut);
        assert.equal(request.limit, 30);
        return {
          items: [
            { source, type: 'input', role: 'user', text: 'Original instruction', truncated: false }
          ],
          cut,
          scanned: 1,
          bytes: 20,
          scannedBytes: 20,
          coverage: 'complete'
        };
      },
      transitionContext: async (request) => {
        selections.push(request);
        return { selection: { kind: 'selected' } };
      }
    };
    const app = defineTui({
      id: 'context-test',
      init: () => ({ state: createContextState() }),
      update: (state, message) =>
        message.type === 'overlay.close' ? { state } : updateContext(state, message, operations),
      view: (state) => contextView(state, columns - 4, 20)
    });
    const runtime = createTuiRuntime({
      host: createMemoryTerminalHost({ terminalSize: { columns, rows: 24 } }),
      app
    });
    t.after(() => runtime.dispose());
    await runtime.start();
    await runtime.dispatch({ type: 'context.open' });
    for (let i = 0; i < 300 && runtime.state().requestId; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runtime.state().inspection.cut, cut);
    await runtime.dispatch({ type: 'context.source', source });
    assert.deepEqual(runtime.state().selection.retained, [source]);
    await runtime.dispatch({ type: 'context.apply' });
    for (let i = 0; i < 300 && selections.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runtime.state().inspection.workingState.text, 'A model hypothesis');
    assert.ok(!('notes' in selections[0].selection));
    assert.deepEqual(selections[0].selection.retained, [source]);
    assert.equal(selections[0].expectedWindowId, null);
    assert.equal(selections[0].expectedSourceRevision, cut.sourceRevision);
    assert.ok(selections[0].idempotencyKey);
  });

test('context controls preserve the effective selection and forward the edited set to fresh context', async () => {
  const source = (entryId) => ({ sessionId: 'session', entryId, sha256: 'a'.repeat(64) });
  const first = source('first'), recent = source('recent'), config = source('config');
  let state = { ...createContextState(), requestId: 'load' };
  state = updateContext(state, {
    type: 'context.loaded', requestId: 'load', reset: true,
    inspection: {
      activeSelection: { status: 'available', selection: { strategy: 'sources', retained: [first, recent] } },
      window: { selection: { strategy: 'sources', retained: [first] } },
      protectedSources: []
    },
    history: { items: [{ source: config, role: 'control', type: 'model_settings' }] }
  }, {}).state;
  assert.deepEqual(state.selection.retained, [first, recent], 'recent originals are not dropped by stale window metadata');
  state = updateContext(state, { type: 'context.source', source: config }, {}).state;
  assert.deepEqual(state.selection.retained, [first, recent], 'configuration records are not selectable messages');
  state = updateContext(state, { type: 'context.source', source: first }, {}).state;
  const calls = [];
  const result = updateContext(state, { type: 'context.fresh' }, {
    freshContext: async (retained) => calls.push(retained),
    inspectContext: async () => ({ cut: {} }),
    contextSources: async () => ({ items: [] })
  });
  await result.effects[0].run({ signal: new AbortController().signal });
  assert.deepEqual(calls, [[recent]]);
});

test('an oversized active context stays inspectable without presenting an empty set as the active selection', () => {
  const source = { sessionId: 'session', entryId: 'selected', sha256: 'a'.repeat(64) };
  const loaded = updateContext({ ...createContextState(), requestId: 'load' }, {
    type: 'context.loaded', requestId: 'load', reset: true,
    inspection: {
      activeSelection: { status: 'unavailable', conflict: { kind: 'source_capacity', message: 'Selected originals exceed the source bound.' } },
      protectedSources: []
    }, history: { items: [] }
  }, {}).state;
  assert.equal(loaded.selection, undefined);
  assert.match(loaded.notice, /source bound/);
  for (const type of ['context.apply', 'context.fresh'])
    assert.equal(updateContext(loaded, { type }, {}).effects, undefined);
  const selected = updateContext(loaded, { type: 'context.source', source }, {}).state;
  assert.deepEqual(selected.selection, { strategy: 'sources', retained: [source] });
});

function selectionDraft() {
  const source = { sessionId: 'session', entryId: 'chosen', sha256: 'a'.repeat(64) };
  return {
    ...createContextState(),
    inspection: { window: null, cut: { sourceRevision: 5 }, protectedSources: [] },
    selection: { strategy: 'sources', retained: [source] }
  };
}

test('scheduled Apply preserves its inspected draft and reports only its correlated rejection', async () => {
  const draft = selectionDraft();
  let inspections = 0;
  const operations = {
    transitionContext: async () => ({ selection: { kind: 'scheduled', requestId: 'scheduled-1' } }),
    inspectContext: async () => { inspections++; throw new Error('Must not reload a pending draft'); }
  };
  const applying = updateContext(draft, { type: 'context.apply' }, operations);
  const message = await applying.effects[0].run({ signal: new AbortController().signal });
  const queued = updateContext(applying.state, message.message, operations).state;
  assert.equal(queued.selection, draft.selection);
  assert.equal(queued.inspection, draft.inspection);
  assert.equal(queued.requestId, undefined);
  assert.equal(queued.pendingTransition.requestId, 'scheduled-1');
  assert.equal(inspections, 0);
  for (const type of ['context.apply', 'context.fresh', 'context.open'])
    assert.equal(updateContext(queued, { type }, operations).effects, undefined);
  const unrelated = updateContext(queued, { type: 'context.rejected', idempotencyKey: 'another', message: 'Unrelated failure' }, operations);
  assert.equal(unrelated.state, queued);
  const rejected = updateContext(queued, { type: 'context.rejected', idempotencyKey: queued.pendingTransition.idempotencyKey, message: 'Context selection source revision is stale.' }, operations).state;
  assert.equal(rejected.pendingTransition, undefined);
  assert.equal(rejected.selection, draft.selection);
  assert.equal(rejected.inspection, draft.inspection);
  assert.match(rejected.notice, /source revision is stale/);
});

test('committed Apply refreshes after its terminal event, including an event before scheduling returns', async () => {
  const draft = selectionDraft();
  const operations = {
    transitionContext: async () => ({ selection: { kind: 'scheduled', requestId: 'scheduled-early' } }),
    inspectContext: async () => ({ ...draft.inspection, activeSelection: { status: 'available', selection: draft.selection } }),
    contextSources: async () => ({ items: [] })
  };
  const applying = updateContext(draft, { type: 'context.apply' }, operations);
  const committed = updateContext(applying.state, { type: 'context.applied', idempotencyKey: applying.state.pendingTransition.idempotencyKey }, operations);
  assert.equal(committed.state.pendingTransition, undefined);
  assert.match(committed.state.notice, /applied/);
  const late = await applying.effects[0].run({ signal: new AbortController().signal });
  assert.equal(updateContext(committed.state, late.message, operations).state, committed.state);
  const loaded = await committed.effects[0].run({ signal: new AbortController().signal });
  const completed = updateContext(committed.state, loaded.message, operations).state;
  assert.equal(completed.requestId, undefined);
  assert.equal(completed.pendingTransition, undefined);
  assert.match(completed.notice, /applied/);
});

test('a rejected Apply before scheduling returns cannot be returned to pending by its late receipt', async () => {
  const operations = { transitionContext: async () => ({ selection: { kind: 'scheduled', requestId: 'late' } }) };
  const applying = updateContext(selectionDraft(), { type: 'context.apply' }, operations);
  const rejected = updateContext(applying.state, { type: 'context.rejected', idempotencyKey: applying.state.pendingTransition.idempotencyKey, message: 'Run ended before applying the selection.' }, operations);
  const late = await applying.effects[0].run({ signal: new AbortController().signal });
  assert.equal(updateContext(rejected.state, late.message, operations).state, rejected.state);
  assert.equal(rejected.state.pendingTransition, undefined);
  assert.match(rejected.state.notice, /Run ended/);
});
