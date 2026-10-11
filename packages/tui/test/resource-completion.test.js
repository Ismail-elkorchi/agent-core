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
    items: [{ id: 'main', label: 'main', reference: 'src/main.ts' }]
  });
  const { input: inserted, completion } = acceptResource(ready, input);
  assert.equal(completion, undefined);
  assert.equal(textDocumentText(inserted.document), 'Inspect @src/main.ts then continue 文');
  assert.equal(textDocumentText(textAreaReducer(inserted, { kind: 'undo' }).state.document), source);
  const changed = createDraft(source).input;
  assert.equal(acceptResource(ready, changed).input, changed);
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

test('quoted resource completion decodes the query and replaces the complete reference', () => {
  const source = 'Read @"draft notes/old.md" then review';
  const input = createTextAreaState({ value: source, caret: textCaretAt(source.indexOf('old') + 1) });
  const completion = completeResource(input);
  assert(completion, 'A quoted resource remains searchable at its caret.');
  assert.equal(completion.query, 'draft notes/o');
  assert.equal(source.slice(completion.start, completion.end), '@"draft notes/old.md"');
});

test('editing an unquoted resource replaces its remaining suffix as well as its prefix', () => {
  const source = 'Read @src/old.ts then review';
  const input = createTextAreaState({ value: source, caret: textCaretAt(source.indexOf('old') + 1) });
  const completion = completeResource(input);
  assert.equal(completion.query, 'src/o');
  assert.equal(source.slice(completion.start, completion.end), '@src/old.ts');
});

test('resource completion understands open quotes and escaped characters', () => {
  for (const [source, query] of [
    ['@"draft notes/', 'draft notes/'],
    ['@"a\\"b/', 'a"b/'],
    ['@"a\\\\b/"', 'a\\b/'],
    ['@"work @home/file"', 'work @home/file']
  ]) assert.equal(completeResource(createDraft(source).input)?.query, query);
});

test('a directory selection keeps the caret inside its quoted reference and continues searching', () => {
  const input = createDraft('Read @draft').input;
  const loading = completeResource(input);
  const ready = updateResourceCompletion(loading, {
    type: 'resource.loaded', id: loading.id,
    items: [{ id: 'directory', label: 'Draft notes', reference: 'draft notes/', continueSearch: true }]
  });
  const accepted = acceptResource(ready, input);
  assert.equal(textDocumentText(accepted.input.document), 'Read @"draft notes/"');
  assert.equal(accepted.completion.query, 'draft notes/');
  assert.equal(accepted.input.caret.position.offset, 'Read @"draft notes/'.length);
  const transition = { kind: 'edit', operation: { kind: 'insert', text: 'c' } };
  const edited = textAreaReducer(accepted.input, transition).state;
  const next = completeResource(edited, transition);
  assert.equal(next.query, 'draft notes/c');
  const found = updateResourceCompletion(next, {
    type: 'resource.loaded', id: next.id,
    items: [{ id: 'file', label: 'Chapter', reference: 'draft notes/chapter"one.md' }]
  });
  const final = acceptResource(found, edited);
  assert.equal(textDocumentText(final.input.document), 'Read @"draft notes/chapter\\"one.md" ');
  assert.equal(final.completion, undefined);
  assert.equal(textDocumentText(textAreaReducer(final.input, { kind: 'undo' }).state.document),
    'Read @"draft notes/c"');
});

test('unfinished resource searches ignore acceptance instead of discarding their query', () => {
  const input = createDraft('@src').input;
  const loading = completeResource(input);
  assert.deepEqual(acceptResource(loading, input), { input, completion: loading });
});

test('resource insertion replaces an old quoted suffix without duplicating its separator', () => {
  const source = 'Read @"old notes/old.md" then review';
  const input = createTextAreaState({ value: source, caret: textCaretAt(source.indexOf('old.md') + 1) });
  const loading = completeResource(input);
  const ready = updateResourceCompletion(loading, {
    type: 'resource.loaded', id: loading.id,
    items: [{ id: 'file', label: 'New', reference: 'new notes/new.md' }]
  });
  assert.equal(textDocumentText(acceptResource(ready, input).input.document),
    'Read @"new notes/new.md" then review');
});
