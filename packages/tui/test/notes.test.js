import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { combineTuiResults, createTuiChild, createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { notesPanel } from '@agent-core/tui';

async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Notes read did not settle.');
}
const revision = {
  noteId: 'note',
  revisionId: 'revision',
  title: 'Model hypothesis',
  authorId: 'model',
  invocationId: 'invocation',
  sources: [],
  scope: { sessionId: 'session', branchId: 'branch' },
  mediaType: 'text/markdown'
};
for (const columns of [48, 120])
  test(`attributed notes page and chunk access at ${columns} columns preserves exact source`, async (t) => {
    const requests = [];
    const source = '**Hypothesis**\r\n文 👩🏽‍💻\n';
    const reader = {
      listNotes: async (cursor) => ({
        items: cursor === undefined ? [] : [revision],
        coverage: cursor === undefined ? 'partial' : 'complete',
        ...(cursor === undefined ? { cursor: 'next' } : {})
      }),
      readNote: async (request) => {
        requests.push(request);
        return {
          status: 'available',
          revision,
          text: source,
          offset: request.offset ?? 0,
          nextOffset: request.offset === undefined ? 10 : 20,
          totalBytes: 20,
          truncated: request.offset === undefined
        };
      }
    };
    const notes = createTuiChild(notesPanel(reader), (child) => ({ type: 'notes', child }));
    const app = defineTui({
      id: 'notes-consumer',
      init: (context) => notes.init({ id: 'notes', generation: 1 }, context),
      update: (state, message, context) => notes.update(state, message.child, context),
      view: notes.view
    });
    const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 24 } });
    const runtime = createTuiRuntime({ host, app });
    t.after(() => runtime.dispose());
    await runtime.start();
    const dispatch = (message) =>
      runtime.dispatch({ type: 'notes', child: { id: 'notes', generation: 1, message } });
    await waitFor(() => runtime.state().state.page !== undefined);
    assert.equal(runtime.state().state.page.coverage, 'partial');
    await dispatch({ type: 'notes.open', cursor: runtime.state().state.page.cursor });
    await waitFor(() => runtime.state().state.page?.coverage === 'complete');
    await dispatch({ type: 'notes.read', noteId: 'note', revisionId: 'revision' });
    await waitFor(() => runtime.state().state.source !== undefined);
    assert.equal(textDocumentText(runtime.state().state.source.input.document), source);
    assert.equal(runtime.state().state.source.result.revision.authorId, 'model');
    await dispatch({
      type: 'notes.read',
      noteId: 'note',
      revisionId: 'revision',
      offset: runtime.state().state.source.result.nextOffset
    });
    await waitFor(() => runtime.state().state.source?.result.truncated === false);
    assert.equal(requests[1].offset, 10);
  });

test('exact-copy requests preserve source through clipboard transport', async () => {
  const { copySource } = await import('@agent-core/tui');
  const { createClipboardWriteSequence } = await import('@ismail-elkorchi/terminal-ui/protocol');
  const original = 'a\t文\r\nb';
  const encoded = createClipboardWriteSequence(original, { allowed: true });
  assert.equal(encoded.status, 'encoded');
  assert.equal(
    Buffer.from(encoded.sequence.split(';')[2].slice(0, -1), 'base64').toString(),
    original
  );
  const effect = copySource(original, (message) => ({ type: 'notice', message }));
  const result = await effect.run({
    async copySelectedText({ selection }) {
      assert.equal(selection.text, original);
      return { status: 'copied' };
    }
  });
  assert.equal(result.message.message, 'Source sent to clipboard.');
});

test('two notes instances own independent reads, identities and removal', async (t) => {
  const { column } = await import('@ismail-elkorchi/terminal-ui/layout');
  const pending = [];
  const child = createTuiChild(
    notesPanel({
      listNotes: () => new Promise((resolve) => pending.push(resolve)),
      readNote: async () => {
        throw new Error('Unexpected read');
      }
    }),
    (child) => ({ type: 'child', child })
  );
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 30 } }),
    app: defineTui({
      id: 'two-notes',
      init(context) {
        const left = child.init({ id: 'left', generation: 1 }, context);
        const right = child.init({ id: 'right', generation: 1 }, context);
        return combineTuiResults({ left: left.state, right: right.state }, left, right);
      },
      update(state, message, context) {
        const current = state[message.child.id];
        if (current === undefined) return { state };
        const result = child.update(current, message.child, context);
        if (result.outputs?.includes('close')) {
          const next = { ...state };
          delete next[message.child.id];
          return combineTuiResults(next, result, child.remove(current));
        }
        return { ...result, state: { ...state, [message.child.id]: result.state } };
      },
      view: (state, context) =>
        column(Object.values(state).map((state) => child.view(state, context)))
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  await waitFor(() => pending.length === 2);
  assert.notEqual(
    child.elementId(runtime.state().left, 'model-notes'),
    child.elementId(runtime.state().right, 'model-notes')
  );
  assert.equal('effectIds' in runtime.state().left, false);
  await runtime.dispatch({
    type: 'child',
    child: { id: 'left', generation: 1, message: { type: 'notes.close' } }
  });
  pending[0]({ items: [revision], coverage: 'complete' });
  pending[1]({ items: [], coverage: 'complete' });
  await waitFor(() => runtime.state().right.state.page !== undefined);
  assert.equal(runtime.state().left, undefined);
  assert.deepEqual(runtime.state().right.state.page.items, []);
});
