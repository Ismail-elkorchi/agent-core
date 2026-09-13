import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraft, completeResource, acceptResource, updateResourceCompletion } from '@agent-core/tui';
import { createTextAreaState, textAreaReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import { textCaretAt, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';

test('resource completion replaces only its caret range and remains one undo operation', () => {
  const source = 'Inspect @src/ma then continue 文';
  const input = createTextAreaState({ value: source, caret: textCaretAt(15) });
  const loading = completeResource(input);
  assert.equal(loading.query, 'src/ma');
  const ready = updateResourceCompletion(loading, {
    type: 'resource.loaded',
    id: loading.id,
    items: [{ id: 'main', label: 'main', insertion: '@src/main.ts' }]
  });
  const inserted = acceptResource(ready, input);
  assert.equal(textDocumentText(inserted.document), 'Inspect @src/main.ts then continue 文');
  assert.equal(textDocumentText(textAreaReducer(inserted, { kind: 'undo' }).state.document), source);
  const changed = createDraft(source).input;
  assert.equal(acceptResource(ready, changed), changed);
});

test('stale resource responses cannot replace newer results, and paste does not trigger completion', () => {
  const input = createDraft('@one').input;
  assert.equal(
    completeResource(input, { kind: 'edit', operation: { kind: 'insert', text: '@one' } }),
    undefined
  );
  const completion = completeResource(input);
  assert.equal(
    updateResourceCompletion(completion, { type: 'resource.loaded', id: 'replaced', items: [] }),
    completion
  );
  assert.equal(updateResourceCompletion(completion, { type: 'resource.close' }), undefined);
});
