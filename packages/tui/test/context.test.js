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
      renewContext: async (selection) => selections.push(selection)
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
    assert.ok(!('notes' in selections[0]));
    assert.deepEqual(selections[0].retained, [source]);
  });
