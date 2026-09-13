import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { text } from '@ismail-elkorchi/terminal-ui/components';
import { textAreaReducer, createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import { textDocumentText, textCaretAt } from '@ismail-elkorchi/terminal-ui/text';
import {
  shortcutBindings,
  completeCommand,
  insertCommand,
  reconcileConversationEntries,
  createSourceInspector,
  updateSourceInspector,
  inspectedSource,
  createDraft,
  draftSubmission,
  sameDraft
} from '@agent-core/tui';
import {
  defaultTuiPreferences,
  parseShortcut,
  insertAcceptedInput,
  transitionCommandPicker,
  createAttachments,
  updateAttachments
} from '@agent-core/tui';
import {
  createSearchPickerIndex,
  createSearchPickerState,
  searchPickerView
} from '@ismail-elkorchi/terminal-ui/behavior';
import { readTuiPreferences, writeTuiPreferences } from '@agent-core/tui/node';
import { FileDraftStorage, FileSessionNames } from '@agent-core/tui/node';

const key = (key, modifiers = {}) => ({
  kind: 'key',
  key,
  eventType: 'press',
  location: 'standard',
  modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
});

test('shortcut capture consumes local cancellation and conflicts, then dispatches the new action', async (t) => {
  const bindings = shortcutBindings(
    [
      {
        id: 'tools',
        label: 'Tools',
        phase: 'beforeFocus',
        triggers: [{ kind: 'key', key: 'o', modifiers: { ctrl: true } }],
        message: { type: 'tools' }
      },
      {
        id: 'exit',
        label: 'Exit',
        phase: 'beforeFocus',
        triggers: [{ kind: 'key', key: 'd', modifiers: { ctrl: true } }],
        message: { type: 'exit' }
      }
    ],
    {
      actions: [{ id: 'tools', label: 'Tools', bindings: ['tools'] }],
      overrides: (state) => state.overrides,
      capturing: (state) => state.capture,
      captured: (action, shortcut) => ({ type: 'captured', action, shortcut }),
      cancelled: () => ({ type: 'cancel' }),
      failed: (error) => ({ type: 'failed', error })
    }
  );
  const runtime = createTuiRuntime({
    host: createMemoryTerminalHost(),
    app: defineTui({
      id: 'neutral-shortcuts',
      init: () => ({ state: { capture: 'tools', overrides: {}, invoked: 0 } }),
      inputBindings: bindings,
      update: (state, message) => ({
        state:
          message.type === 'captured'
            ? { ...state, capture: undefined, overrides: { [message.action]: message.shortcut } }
            : message.type === 'capture'
              ? { ...state, capture: 'tools' }
              : message.type === 'cancel'
                ? { ...state, capture: undefined }
                : message.type === 'failed'
                  ? { ...state, error: message.error }
                  : message.type === 'tools'
                    ? { ...state, invoked: state.invoked + 1 }
                    : { ...state, exited: true }
      }),
      view: () => text({ content: 'Neutral actions' })
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.handleInput(key('d', { ctrl: true }));
  assert.match(runtime.state().error, /belongs to Exit/);
  assert.equal(runtime.state().exited, undefined);
  await runtime.handleInput(key('c', { ctrl: true }));
  assert.equal(runtime.state().capture, undefined);
  await runtime.dispatch({ type: 'capture' });
  await runtime.handleInput(key('k', { ctrl: true, shift: true }));
  await runtime.handleInput(key('o', { ctrl: true }));
  assert.equal(runtime.state().invoked, 0);
  await runtime.handleInput(key('k', { ctrl: true, shift: true }));
  assert.equal(runtime.state().invoked, 1);
});

test('command completion retains suffix source and undo, and cannot reinterpret pasted code or paths', () => {
  const input = createTextAreaState({ value: '/mo discuss this', caret: textCaretAt(3) });
  const commands = [{ name: '/model', description: 'Choose model' }];
  const completion = completeCommand(
    input,
    { kind: 'edit', operation: { kind: 'insert', text: 'o' } },
    commands
  );
  const result = insertCommand(completion, input, '/model');
  assert.equal(textDocumentText(result.document), '/model discuss this');
  assert.equal(
    textDocumentText(textAreaReducer(result, { kind: 'undo' }).state.document),
    '/mo discuss this'
  );
  const changed = createDraft('New work').input;
  assert.equal(insertCommand(completion, changed, '/model'), changed);
  for (const source of ['/model/file', '/model\nnew code'])
    assert.equal(
      completeCommand(
        createDraft(source).input,
        { kind: 'edit', operation: { kind: 'insert', text: 'x' } },
        commands
      ),
      undefined
    );
  assert.equal(
    completeCommand(input, { kind: 'edit', operation: { kind: 'insert', text: '/mo' } }, commands),
    undefined
  );
});

test('exact command names win over prefixes without resetting a deliberate highlighted choice', () => {
  const commands = [
    { name: '/statusline', description: 'Appearance' },
    { name: '/status', description: 'Inspect' }
  ];
  const input = createDraft('/status').input;
  assert.equal(
    completeCommand(input, { kind: 'edit', operation: { kind: 'insert', text: 's' } }, commands).names[0],
    '/status'
  );
  const index = createSearchPickerIndex(commands, (command) => ({
    id: command.name,
    label: command.name,
    value: command.name
  }));
  let picker = transitionCommandPicker(
    createSearchPickerState({}, index),
    { kind: 'setQuery', query: { text: 'status', mode: 'fuzzy' } },
    index,
    commands
  );
  assert.equal(searchPickerView(picker).activeId, '/status');
  picker = transitionCommandPicker(picker, { kind: 'setActive', id: '/statusline' }, index, commands);
  assert.equal(searchPickerView(picker).activeId, '/statusline');
});

test('late acceptance precedes its own output and preserves distinct runs', () => {
  const input = { id: 'input:next', kind: 'user', runId: 'next', text: 'Next request' };
  const old = { id: 'old', kind: 'notice', text: 'Earlier work', tone: 'info', runId: 'old' };
  const output = {
    id: 'assistant:next',
    kind: 'assistant',
    turnId: 'next',
    status: 'streaming',
    text: 'Responding',
    runId: 'next'
  };
  const accepted = insertAcceptedInput([old, output], input);
  assert.deepEqual(
    accepted.map((entry) => entry.id),
    ['old', 'input:next', 'assistant:next']
  );
  assert.deepEqual(insertAcceptedInput(accepted, input), accepted);
});

test('text-only attachment acquisition retains its capability receiver and rejects unavailable image acquisition', async () => {
  const operations = {
    title: 'Selected file',
    async readContext() {
      return { title: this.title, content: 'exact\t文\r\n' };
    }
  };
  const state = { ...createAttachments(), path: createDraft('file.txt').input };
  const result = updateAttachments(state, { type: 'attachments.add-context' }, operations);
  const loaded = await result.effects[0].run({ signal: new AbortController().signal });
  assert.equal(loaded.message.attachment.item.title, operations.title);
  assert.equal(loaded.message.attachment.item.content, 'exact\t文\r\n');
  assert.match(
    updateAttachments(state, { type: 'attachments.add-image' }, operations).state.error,
    /does not provide image/
  );
});

test('persisted shortcut overrides survive restart and reject unhandled keys and unknown actions', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'neutral-shortcuts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'preferences.json');
  const actions = [{ id: 'tools', label: 'Tools', bindings: ['tools'] }];
  const shortcuts = { tools: parseShortcut({ kind: 'key', key: 'pageDown', modifiers: { ctrl: true } }) };
  await writeTuiPreferences(file, { ...defaultTuiPreferences, shortcuts });
  assert.deepEqual((await readTuiPreferences(file, actions)).shortcuts, shortcuts);
  await assert.rejects(readTuiPreferences(file, []), /unknown shortcut action/);
  assert.throws(() => parseShortcut({ kind: 'key', key: 'f13' }), /F1–F12/);
});

test('recorded tool calls anchor uncommitted reasoning and completed output wins over stale deltas', () => {
  const reasoning = { id: 'r', kind: 'reasoning', turnId: 'turn', channel: 'reasoning', text: 'Compare' };
  const tool = { id: 't', kind: 'activity', activity: 'tool', label: 'Observe', status: 'running' };
  const assistant = { id: 'a', kind: 'assistant', turnId: 'turn', text: 'Done', status: 'complete' };
  const live = [reasoning, tool, { ...assistant, text: 'Partial', status: 'streaming' }];
  assert.deepEqual(
    reconcileConversationEntries([tool, assistant], live).map((entry) => entry.id),
    ['r', 't', 'a']
  );
  assert.equal(reconcileConversationEntries([tool, assistant], live).at(-1).text, 'Done');
});

test('source inspection addresses old messages and individual code blocks without altering literal source', () => {
  const source = '```ts\r\n\tconst value = 1;\r\n```\r\n\n```sh\nexit 0\n```\n';
  let inspector = createSourceInspector([
    { id: 'old', kind: 'assistant', turnId: 'turn', text: source, status: 'complete' },
    { id: 'new', kind: 'user', text: 'Later request' }
  ]);
  inspector = updateSourceInspector(inspector, { type: 'inspector.pick', id: 'old' });
  assert.equal(inspectedSource(inspector), source);
  inspector = updateSourceInspector(inspector, { type: 'inspector.format', format: 0, width: 48 });
  assert.equal(inspectedSource(inspector), '\tconst value = 1;\r\n');
  inspector = updateSourceInspector(inspector, { type: 'inspector.format', format: 1, width: 48 });
  assert.equal(inspectedSource(inspector), 'exit 0\n');
});

test('current and recovered drafts retain metadata across restart and session names stay separate', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'neutral-presentation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drafts = new FileDraftStorage(path.join(directory, 'drafts'));
  const draft = { ...createDraft('literal\t文\r\n'), instructions: ['Original instruction'] };
  await drafts.write('../opaque-session', draft);
  await drafts.recover('../opaque-session', draft);
  const reopened = new FileDraftStorage(path.join(directory, 'drafts'));
  assert.deepEqual(draftSubmission(await reopened.read('../opaque-session')), draftSubmission(draft));
  assert.deepEqual(
    draftSubmission((await reopened.readRecovered('../opaque-session'))[0]),
    draftSubmission(draft)
  );
  assert.equal(sameDraft(draft, { ...draft, instructions: ['Changed'] }), false);
  const names = new FileSessionNames(path.join(directory, 'names'));
  await names.write('../opaque-session', 'Research and code');
  assert.equal(
    await new FileSessionNames(path.join(directory, 'names')).read('../opaque-session'),
    'Research and code'
  );
  assert.equal(await names.read('another-session'), undefined);
  await assert.rejects(async () => names.write('../opaque-session', 'Invalid\nname'), /single line/);
});
