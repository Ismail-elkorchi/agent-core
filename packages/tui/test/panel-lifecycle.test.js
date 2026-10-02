import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPanelResult, cancelRemovedPanels, mountPanel } from '@agent-core/tui';
import { text } from '@ismail-elkorchi/terminal-ui/components';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiChild, createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';

const context = { terminalSize: { columns: 80, rows: 24 } };
const initial = () => ({ panelGeneration: 0, overlay: { kind: 'none' }, value: 'parent' });
const mounted = (state) => state.overlay.kind === 'none' ? [] : [state.overlay.state];

async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Panel lifecycle did not settle.');
}

test('panel mounting and result grafting retain parent state and explicit child work and outputs', () => {
  const child = createTuiChild({
    init: () => ({
      state: 0,
      effects: [{ id: 'load', concurrency: 'replace', run: async () => ({ kind: 'none' }) }],
      focus: { kind: 'element', elementId: 'value' }
    }),
    update: () => ({ state: 1, outputs: ['saved'], cancel: [{ kind: 'effect', id: 'load' }] }),
    view: () => text({ id: 'value', content: 'value' })
  }, (child) => ({ type: 'child', child }));
  const left = mountPanel(initial(), 'notes', child, context);
  const right = mountPanel(initial(), 'notes', child, context);
  assert.equal(left.state.panelGeneration, 1);
  assert.equal(right.state.panelGeneration, 1, 'independent parents do not share a generation counter');
  assert.equal(left.state.value, 'parent');
  assert.equal(left.focus.elementId, child.elementId(left.state.overlay.state, 'value'));
  assert.equal('effectIds' in left.state.overlay.state, false);
  assert.equal(left.effects.length, 1);
  const result = child.update(left.state.overlay.state, {
    id: 'notes', generation: 1, message: 'save'
  }, context);
  const applied = applyPanelResult(left.state, 'notes', result);
  assert.deepEqual(applied.outputs, ['saved'], 'the parent decides how to consume outputs');
  assert.equal(applied.state.overlay.state.state, 1);
  assert.equal(right.state.overlay.state.state, 0);
  assert.deepEqual(applied.cancel, [{ kind: 'effect', id: left.effects[0].id }]);
  const closed = applyPanelResult(applied.state, 'notes', result, true);
  assert.equal(closed.state.overlay.kind, 'none');
  const reopened = mountPanel(closed.state, 'notes', child, context);
  assert.equal(reopened.state.panelGeneration, 2);
  assert.equal(reopened.state.overlay.state.generation, 2);
});

test('panel lifetime reconciliation keeps unrelated cancellations and retained hidden children', () => {
  const first = { id: 'notes', generation: 1, state: 0 };
  const queue = { id: 'queue', generation: 2, state: 0 };
  const second = { ...first, generation: 3 };
  const result = { state: { value: 'parent' }, cancel: [{ kind: 'effect', id: 'parent-search' }] };
  assert.equal(cancelRemovedPanels(result, [first, queue], [first, queue]), result);
  assert.deepEqual(cancelRemovedPanels(result, [first, queue], [second, queue]), {
    ...result, cancel: [{ kind: 'effect', id: 'parent-search' }, { kind: 'child', id: 'notes', generation: 1 }]
  });
  assert.deepEqual(cancelRemovedPanels(result, [first, queue], []).cancel,
    [{ kind: 'effect', id: 'parent-search' }, { kind: 'child', id: 'notes', generation: 1 }, { kind: 'child', id: 'queue', generation: 2 }]);
});

test('mounted panel hide, removal and replacement preserve subscription ownership and reject stale work', { timeout: 5000 }, async (t) => {
  const reads = [];
  const sources = [];
  let disposals = 0;
  const child = createTuiChild({
    init: () => ({
      state: 0,
      effects: [{
        id: 'read', concurrency: 'replace',
        run: ({ signal }) => new Promise((resolve) => reads.push({ signal, resolve }))
      }]
    }),
    update: (state, message) => ({ state: state + message }),
    view: (state) => text({ content: String(state) }),
    subscriptions: () => [{
      id: 'updates', generation: 0,
      run({ signal }, sink) {
        sources.push({ signal, sink });
        return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      dispose() { disposals++; }
    }]
  }, (child) => ({ type: 'child', child }));
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost(),
    app: defineTui({
      init: (context) => mountPanel({ ...initial(), hidden: false }, 'notes', child, context),
      update(state, message, context) {
        let result;
        if (message.type === 'hide') result = { state: { ...state, hidden: true } };
        else if (message.type === 'remove') result = { state: { ...state, overlay: { kind: 'none' } } };
        else if (message.type === 'open') result = mountPanel({ ...state, hidden: false }, 'notes', child, context);
        else result = state.overlay.kind === 'none' ? { state } : applyPanelResult(
          state, 'notes', child.update(state.overlay.state, message.child, context)
        );
        return cancelRemovedPanels(result, mounted(state), mounted(result.state));
      },
      view: (state, context) => state.hidden || state.overlay.kind === 'none'
        ? text({ content: 'hidden' }) : child.view(state.overlay.state, context),
      subscriptions: (state, context) => state.overlay.kind === 'none'
        ? [] : child.subscriptions(state.overlay.state, context)
    })
  });
  t.after(async () => {
    for (const read of reads) read.resolve({ kind: 'none' });
    await runtime.dispose();
  });
  await runtime.start();
  await waitFor(() => reads.length === 1 && sources.length === 1);
  await runtime.dispatch({ type: 'hide' });
  assert.equal(reads[0].signal.aborted, false);
  assert.equal(sources[0].signal.aborted, false);
  await sources[0].sink.emit({ kind: 'reliable', message: 1 });
  await waitFor(() => runtime.state().overlay.state.state === 1);
  await runtime.dispatch({ type: 'remove' });
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(sources[0].signal.aborted, true);
  assert.equal(disposals, 1);
  await runtime.dispatch({ type: 'open' });
  await waitFor(() => reads.length === 2 && sources.length === 2);
  reads[0].resolve({ kind: 'message', message: 100 });
  await sources[0].sink.emit({ kind: 'reliable', message: 100 });
  await runtime.dispatch({ type: 'child', child: { id: 'notes', generation: 1, message: 100 } });
  assert.equal(runtime.state().overlay.state.state, 0);
  await sources[1].sink.emit({ kind: 'reliable', message: 2 });
  await waitFor(() => runtime.state().overlay.state.state === 2);
  await runtime.dispatch({ type: 'open' });
  assert.equal(reads[1].signal.aborted, true);
  assert.equal(sources[1].signal.aborted, true);
  assert.equal(disposals, 2);
  assert.equal(runtime.state().overlay.state.generation, 3);
  for (const read of reads) read.resolve({ kind: 'none' });
  await runtime.dispose();
  assert.equal(disposals, 3);
});
