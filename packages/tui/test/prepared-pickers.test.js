import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRecalledDrafts,
  createDraft,
  createPromptRecall,
  promptRecallView,
  receivePromptRecallQuery,
  sourceInspectorPanel,
  updatePromptRecall
} from '@agent-core/tui';
import { renderElementFrame, renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';

async function context(signal = new AbortController().signal, onYield = () => {}) {
  const host = createMemoryTerminalHost();
  return {
    signal,
    terminalSize: host.getTerminalSize(),
    capabilities: await host.getCapabilities(),
    diagnostics: [],
    clock: {
      now: () => 0,
      sleep: async () => {
        onYield();
        return 'elapsed';
      }
    },
    withTerminalSuspended: async (operation) => operation(),
    copySelectedText: async () => {
      throw new Error('Not used.');
    }
  };
}
async function runQuery(update, ctx) {
  assert.equal(update.effects.length, 1);
  assert.equal(update.effects[0].concurrency, 'replace');
  const output = await update.effects[0].run(ctx);
  assert.equal(output.kind, 'message');
  return output.message;
}

test('prompt recall owns its index, prepares cooperatively and fences query/source replacements', async () => {
  const history = {
    entries: Array.from({ length: 512 }, (_, i) => createDraft(`Prompt ${i}`)),
    index: null
  };
  const opened = createPromptRecall(history);
  assert.equal(opened.state.query.pending, true);
  assert.equal(opened.state.query.result, null);
  const index = opened.state.searchPickerIndex;
  let yields = 0;
  const ctx = await context(undefined, () => {
    yields += 1;
  });
  const initial = await runQuery(opened, ctx);
  assert.ok(yields > 0);
  const ready = receivePromptRecallQuery(opened.state, initial).state;
  assert.equal(ready.query.result.searchPickerIndex, index);
  assert.equal(ready.query.pending, false);
  assert.equal(ready.picker.editor.activeId, ready.query.result.entries[0].id);
  const first = updatePromptRecall(ready, { kind: 'setQuery', query: { text: 'Prompt 1' } });
  const second = updatePromptRecall(first.state, { kind: 'setQuery', query: { text: 'Prompt 2' } });
  assert.equal(second.state.searchPickerIndex, index);
  const obsolete = await runQuery(first, ctx);
  assert.equal(receivePromptRecallQuery(second.state, obsolete).state, second.state);
  const changed = appendRecalledDrafts(second.state, [createDraft('Prompt 2 recovered')]);
  assert.notEqual(changed.state.searchPickerIndex, index);
  assert.equal(
    receivePromptRecallQuery(changed.state, await runQuery(second, ctx)).state,
    changed.state
  );
  const final = receivePromptRecallQuery(changed.state, await runQuery(changed, ctx)).state;
  assert.equal(final.query.result.searchPickerIndex, final.searchPickerIndex);
  assert.equal(final.query.result.query.text, 'Prompt 2');
  assert.ok(final.query.result.entries.some((entry) => entry.label === 'Prompt 2 recovered'));
  assert.equal(receivePromptRecallQuery(final, obsolete).state, final);
  assert.doesNotThrow(() => promptRecallView(final, 70, 20));
  assert.equal(final.searchPickerIndex, changed.state.searchPickerIndex);
});

test('prompt recall cancellation and reopened identities reject late completions', async () => {
  const opened = createPromptRecall({ entries: [createDraft('Original')], index: null });
  const reopened = createPromptRecall({ entries: [createDraft('New')], index: null });
  const stale = await runQuery(opened, await context());
  assert.equal(receivePromptRecallQuery(reopened.state, stale).state, reopened.state);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(opened.effects[0].run(await context(abort.signal)), /abort/iu);
});

test('source inspector prepares owned queries and close cancels pending work', async () => {
  const panel = sourceInspectorPanel(
    Array.from({ length: 512 }, (_, i) => ({
      id: `source-${i}`,
      kind: 'user',
      text: `Recorded ${i}`
    }))
  );
  const opened = panel.init();
  const first = panel.update(opened.state, {
    type: 'inspector.transition',
    transition: { kind: 'setQuery', query: { text: 'Recorded 3' } }
  });
  const second = panel.update(first.state, {
    type: 'inspector.transition',
    transition: { kind: 'setQuery', query: { text: 'Recorded 4' } }
  });
  assert.equal(first.state.searchPickerIndex, opened.state.searchPickerIndex);
  assert.equal(second.state.searchPickerIndex, opened.state.searchPickerIndex);
  const ctx = await context();
  assert.equal(panel.update(second.state, await runQuery(first, ctx)).state, second.state);
  const ready = panel.update(second.state, await runQuery(second, ctx)).state;
  assert.equal(ready.query.result.query.text, 'Recorded 4');
  assert.equal(ready.query.result.searchPickerIndex, ready.searchPickerIndex);
  assert.deepEqual(panel.update(ready, { type: 'inspector.close' }).cancel, [
    { kind: 'effect', id: 'source-query' }
  ]);
});

test('failed prompt preparation remains editable and shows retry feedback', async () => {
  const opened = createPromptRecall({ entries: [createDraft('Original')], index: null });
  const diagnostic = {
    code: 'TUI_EFFECT_FAILED',
    severity: 'error',
    message: 'Fixture query failure'
  };
  const failure = opened.effects[0].onError({ id: 'prompt-recall-query', diagnostic });
  const failed = receivePromptRecallQuery(opened.state, failure.message).state;
  assert.equal(failed.query.pending, false);
  assert.equal(failed.query.error, diagnostic);
  const frame = renderElementFrame(promptRecallView(failed, 76, 20), { columns: 80, rows: 24 });
  assert.match(renderFramePlain(frame), /Fixture query failure/);
  assert.match(renderFramePlain(frame), /Edit the query to retry/);
  const retry = updatePromptRecall(failed, { kind: 'setQuery', query: { text: 'Original' } });
  assert.equal(retry.state.query.pending, true);
  assert.equal(retry.state.query.error, null);
  const ready = receivePromptRecallQuery(retry.state, await runQuery(retry, await context())).state;
  assert.equal(ready.picker.editor.activeId, ready.query.result.entries[0].id);
});
