import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { notesView, updateNotes } from '@agent-core/tui';

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
    const app = defineTui({
      id: 'notes-consumer',
      init: () => ({ state: { offset: 0 } }),
      update: (state, message) =>
        message.type === 'overlay.close' ? { state } : updateNotes(state, message, reader),
      view: (state, context) => notesView(state, context.terminalSize.columns - 4, 20, (message) => message)
    });
    const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 24 } });
    const runtime = createTuiRuntime({ host, app });
    t.after(() => runtime.dispose());
    await runtime.start();
    await runtime.dispatch({ type: 'notes.open' });
    await waitFor(() => runtime.state().page !== undefined);
    assert.equal(runtime.state().page.coverage, 'partial');
    await runtime.dispatch({ type: 'notes.open', cursor: runtime.state().page.cursor });
    await waitFor(() => runtime.state().page?.coverage === 'complete');
    await runtime.dispatch({ type: 'notes.read', noteId: 'note', revisionId: 'revision' });
    await waitFor(() => runtime.state().source !== undefined);
    assert.equal(textDocumentText(runtime.state().source.input.document), source);
    assert.equal(runtime.state().source.result.revision.authorId, 'model');
    await runtime.dispatch({
      type: 'notes.read',
      noteId: 'note',
      revisionId: 'revision',
      offset: runtime.state().source.result.nextOffset
    });
    await waitFor(() => runtime.state().source?.result.truncated === false);
    assert.equal(requests[1].offset, 10);
  });

test('exact-copy requests reject terminal-ui normalization instead of silently changing source', async () => {
  const { copySource } = await import('@agent-core/tui');
  const { createClipboardWriteSequence } = await import('@ismail-elkorchi/terminal-ui/protocol');
  const original = 'a\t文\r\nb';
  const encoded = createClipboardWriteSequence(original, { allowed: true });
  assert.equal(encoded.status, 'encoded');
  assert.notEqual(Buffer.from(encoded.sequence.split(';')[2].slice(0, -1), 'base64').toString(), original);
  const effect = copySource(original, (message) => ({ type: 'notice', message }));
  const result = await effect.run({
    copySelectedText() {
      assert.fail('Source-changing copy must not be sent');
    }
  });
  assert.match(result.message.message, /Exact copy is unavailable/);
});
