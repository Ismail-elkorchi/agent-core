import {
  createSearchPickerIndex,
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  prepareSearchPickerQuery,
  type SearchPickerIndex,
  type SearchPickerQueryResult,
  searchPickerView,
  textAreaReducer,
  type SearchPickerControlTransition,
  type TextAreaState,
  type TextAreaTransition,
  type UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import {
  button,
  searchPicker,
  text,
  textArea,
  type Element
} from '@ismail-elkorchi/terminal-ui/components';
import { column, flow } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { markdownCodeValueSourceSpan } from 'markspan';
import {
  conversationText,
  projectSessionEntry,
  type ConversationEntry,
  type ConversationReferenceEntry
} from './conversation.js';
import {
  createTuiPreparedQuery,
  type TuiChildDefinition,
  type TuiChildResult,
  type TuiPreparedQueryMessage,
  type TuiPreparedQueryState
} from '@ismail-elkorchi/terminal-ui/tui';
import { copySource } from './copy.js';
import { MarkdownDocument } from './markdown.js';
import { panel } from './panel.js';
import { diagnosticMessage } from './diagnostics.js';

export interface SourceInspector {
  readonly id: string;
  readonly entries: readonly ConversationEntry[];
  readonly picker: UnscrolledSearchPickerState;
  readonly searchPickerIndex: SearchPickerIndex<ConversationEntry>;
  readonly query: TuiPreparedQueryState<SearchPickerQueryResult<ConversationEntry>>;
  readonly selected?: {
    readonly entry: ConversationEntry;
    readonly document: MarkdownDocument;
    readonly input: TextAreaState;
    readonly format: 'original' | 'displayed' | number;
  };
  readonly notice?: string;
}
export type SourceInspectorMessage =
  | { readonly type: 'inspector.close' }
  | {
      readonly type: 'inspector.query';
      readonly message: TuiPreparedQueryMessage<SearchPickerQueryResult<ConversationEntry>>;
    }
  | { readonly type: 'inspector.read' }
  | {
      readonly type: 'inspector.loaded';
      readonly id: string;
      readonly entryId: string;
      readonly entries: readonly ConversationEntry[];
    }
  | { readonly type: 'inspector.pick'; readonly id: string }
  | { readonly type: 'inspector.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'inspector.edit'; readonly transition: TextAreaTransition }
  | {
      readonly type: 'inspector.format';
      readonly format: 'original' | 'displayed' | number;
      readonly width: number;
    }
  | { readonly type: 'inspector.back' | 'inspector.copy' }
  | {
      readonly type: 'inspector.read-failed';
      readonly id: string;
      readonly entryId: string;
      readonly message: string;
    }
  | { readonly type: 'inspector.notice'; readonly message: string };
const source = (entry: ConversationEntry) =>
  entry.kind === 'activity' || entry.kind === 'reference' ? conversationText(entry) : entry.text;
const label = (entry: ConversationEntry) =>
  `${entry.kind} · ${
    source(entry)
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.slice(0, 90) ?? '(empty)'
  }`;
const index = (entries: readonly ConversationEntry[]) =>
  createSearchPickerIndex(
    entries.map((entry) => ({ id: entry.id, label: label(entry), value: entry }))
  );
function createSourceInspector(entries: readonly ConversationEntry[]): SourceInspector {
  const searchPickerIndex = index(entries);
  return {
    id: crypto.randomUUID(),
    entries,
    searchPickerIndex,
    query: sourceQuery.init(),
    picker: createSearchPickerState(
      { query: { text: '', mode: 'fuzzy' }, queryResult: null },
      searchPickerIndex
    )
  };
}
function updateSourceInspector(
  state: SourceInspector,
  message: SourceInspectorMessage
): SourceInspector {
  switch (message.type) {
    case 'inspector.query':
    case 'inspector.close':
    case 'inspector.copy':
    case 'inspector.read':
      return state;
    case 'inspector.loaded': {
      if (message.id !== state.id || state.selected?.entry.id !== message.entryId) return state;
      const next = { ...createSourceInspector(message.entries), id: state.id, query: state.query };
      return message.entries[0] === undefined
        ? { ...next, notice: 'This recorded entry has no public conversation source.' }
        : updateSourceInspector(next, { type: 'inspector.pick', id: message.entries[0].id });
    }
    case 'inspector.read-failed':
      return message.id !== state.id || state.selected?.entry.id !== message.entryId
        ? state
        : { ...state, notice: message.message };
    case 'inspector.notice':
      return { ...state, notice: message.message };
    case 'inspector.transition':
      return {
        ...state,
        picker: searchPickerReducer(state.picker, message.transition, {
          searchPickerIndex: state.searchPickerIndex,
          queryResult: state.query.result
        })
      };
    case 'inspector.pick': {
      const entry = state.entries.find((entry) => entry.id === message.id);
      if (entry === undefined) return state;
      return {
        ...state,
        selected: {
          entry,
          document: new MarkdownDocument(source(entry)),
          input: createTextAreaState({ value: source(entry) }),
          format: 'original'
        }
      };
    }
    case 'inspector.back': {
      const next = { ...state };
      delete next.selected;
      return next;
    }
    case 'inspector.edit':
      return state.selected === undefined
        ? state
        : {
            ...state,
            selected: {
              ...state.selected,
              input: textAreaReducer(state.selected.input, message.transition).state
            }
          };
    case 'inspector.format': {
      const selected = state.selected;
      if (selected === undefined) return state;
      const { document } = selected;
      const block =
        typeof message.format === 'number' ? document.codeBlocks()[message.format] : undefined;
      const value =
        message.format === 'original'
          ? document.source
          : message.format === 'displayed'
            ? document.copyDisplayed(message.width)
            : block === undefined
              ? undefined
              : document.copyOriginal(markdownCodeValueSourceSpan(block, 0, block.value.length));
      return value === undefined
        ? state
        : {
            ...state,
            selected: { ...selected, format: message.format, input: createTextAreaState({ value }) }
          };
    }
  }
}
function inspectedSource(state: SourceInspector): string | undefined {
  return state.selected === undefined ? undefined : textDocumentText(state.selected.input.document);
}
function sourceInspectorView(
  state: SourceInspector,
  width: number,
  height: number
): Element<SourceInspectorMessage> {
  type Message = SourceInspectorMessage;
  const selected = state.selected;
  const blocks = selected?.document.codeBlocks() ?? [];
  const codeIndex = typeof selected?.format === 'number' ? selected.format : -1;
  const formats: readonly ['original' | 'displayed' | number, string][] = [
    ['original', 'Original'],
    ['displayed', 'Displayed'],
    ...(blocks.length === 0
      ? []
      : [
          [
            (codeIndex + 1) % blocks.length,
            `Next code (${String(Math.max(0, codeIndex + 1))}/${String(blocks.length)})`
          ] as [number, string]
        ])
  ];
  return panel<Message>({
    id: 'source-inspector',
    title:
      selected === undefined
        ? 'Inspect loaded conversation · page history to load older source'
        : label(selected.entry),
    width,
    height,
    focusId: selected === undefined ? 'source-entries' : 'source-inspector-text',
    onClose: () => ({ type: 'inspector.close' }),
    slots: {
      content:
        selected === undefined
          ? searchPicker({
              id: 'source-entries',
              title: 'Messages and tool observations',
              view: searchPickerView(state.picker),
              searchPickerIndex: state.searchPickerIndex,
              queryResult: state.query.result,
              maxVisible: Math.max(1, height - 5 - (state.query.error === null ? 0 : 1)),
              emptyText: 'No loaded source. Close and load history first.',
              onTransition: (transition): Message => ({ type: 'inspector.transition', transition }),
              onAccept: (event): Message => ({ type: 'inspector.pick', id: event.id })
            })
          : column(
              [
                ...(selected.entry.kind === 'reference'
                  ? [
                      button<Message>({
                        id: 'read-large-entry',
                        label: 'Read complete recorded source',
                        onPress: () => ({ type: 'inspector.read' })
                      })
                    ]
                  : []),
                textArea<Message>({
                  id: 'source-inspector-text',
                  meta: { accessibleName: 'Exact source; select text to copy' },
                  state: selected.input,
                  readOnly: true,
                  wrap: false,
                  scrollbar: { axis: 'both', visible: 'auto' },
                  onTransition: (transition: TextAreaTransition): Message => ({
                    type: 'inspector.edit',
                    transition
                  })
                }),
                text({
                  content:
                    state.notice ??
                    'Select source and copy, or copy this view. Formatting does not change the original.'
                })
              ],
              {
                sizes: [
                  ...(selected.entry.kind === 'reference' ? [{ kind: 'content' as const }] : []),
                  { kind: 'fill' },
                  { kind: 'content' }
                ]
              }
            ),
      ...(selected === undefined
        ? state.query.error === null
          ? {}
          : {
              actions: text({
                content: `Search failed. Edit the query to retry: ${diagnosticMessage(state.query.error)}`
              })
            }
        : {
            actions: column([
              flow(
                [
                  button<Message>({
                    id: 'source-back',
                    label: 'Messages',
                    onPress: () => ({ type: 'inspector.back' })
                  })
                ],
                { direction: 'horizontal' }
              ),
              flow(
                [
                  ...formats.map(([format, label]) =>
                    button<Message>({
                      id: `source-format:${String(format)}`,
                      label,
                      onPress: () => ({ type: 'inspector.format', format, width })
                    })
                  ),
                  button<Message>({
                    id: 'source-copy',
                    label: 'Copy view',
                    onPress: () => ({ type: 'inspector.copy' })
                  })
                ],
                { direction: 'horizontal' }
              )
            ])
          })
    }
  });
}

export type HistoryEntryReader = (
  boundary: import('@agent-core/runtime').SessionBranchBoundary,
  entryId: string
) => Promise<import('@agent-core/runtime').SessionBranchEntry>;
function readSourceEntry(
  inspector: SourceInspector,
  reference: ConversationReferenceEntry,
  read: HistoryEntryReader
): import('@ismail-elkorchi/terminal-ui/tui').TuiEffect<SourceInspectorMessage> {
  return {
    id: 'source-entry-read',
    concurrency: 'replace',
    async run({ signal }) {
      const entry = await read(reference.boundary, reference.entryId);
      signal.throwIfAborted();
      return {
        kind: 'message',
        message: {
          type: 'inspector.loaded',
          id: inspector.id,
          entryId: reference.id,
          entries: projectSessionEntry(entry)
        }
      };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: {
        type: 'inspector.read-failed',
        id: inspector.id,
        entryId: reference.id,
        message: diagnostic.message
      }
    })
  };
}

const sourceQuery = createTuiPreparedQuery({
  id: 'source-query',
  prepare: (
    input: {
      readonly index: SearchPickerIndex<ConversationEntry>;
      readonly picker: UnscrolledSearchPickerState;
    },
    context
  ) =>
    prepareSearchPickerQuery(
      input.index,
      {
        text: input.picker.editor.input.text,
        mode: input.picker.mode,
        caseSensitive: input.picker.caseSensitive
      },
      {
        signal: context.signal,
        yield: async () => {
          await context.clock.sleep(0, context.signal);
        }
      }
    ),
  toMessage: (message): SourceInspectorMessage => ({ type: 'inspector.query', message })
});
function requestSourceQuery(
  state: SourceInspector
): TuiChildResult<SourceInspector, SourceInspectorMessage> {
  const result = sourceQuery.request(state.query, {
    index: state.searchPickerIndex,
    picker: state.picker
  });
  return { ...result, state: { ...state, query: result.state } };
}

export function sourceInspectorPanel(
  entries: readonly ConversationEntry[],
  reader?: HistoryEntryReader,
  selectedId?: string
): TuiChildDefinition<SourceInspector, SourceInspectorMessage, 'close'> {
  return {
    init: () => {
      const state = createSourceInspector(entries);
      return requestSourceQuery(
        selectedId === undefined
          ? state
          : updateSourceInspector(state, { type: 'inspector.pick', id: selectedId })
      );
    },
    update: (state, message) => {
      if (message.type === 'inspector.close')
        return { state, cancelEffects: ['source-query'], outputs: ['close'] };
      if (message.type === 'inspector.query') {
        const result = sourceQuery.update(state.query, message.message);
        if (result.state === state.query) return { state };
        const activeId = searchPickerView(state.picker).activeId;
        return {
          ...result,
          state: {
            ...state,
            query: result.state,
            picker: searchPickerReducer(
              state.picker,
              activeId === undefined
                ? { kind: 'firstActive' }
                : { kind: 'setActive', id: activeId },
              { searchPickerIndex: state.searchPickerIndex, queryResult: result.state.result }
            )
          }
        };
      }
      if (message.type === 'inspector.copy') {
        const source = inspectedSource(state);
        return source === undefined
          ? { state }
          : {
              state,
              effects: [
                copySource(source, (message): SourceInspectorMessage => ({
                  type: 'inspector.notice',
                  message
                }))
              ]
            };
      }
      if (message.type === 'inspector.read' && state.selected?.entry.kind === 'reference') {
        return reader === undefined
          ? { state: { ...state, notice: 'Explicit history reads are unavailable.' } }
          : { state, effects: [readSourceEntry(state, state.selected.entry, reader)] };
      }
      const next = updateSourceInspector(state, message);
      return next.searchPickerIndex !== state.searchPickerIndex ||
        next.picker.editor.input.text !== state.picker.editor.input.text ||
        next.picker.mode !== state.picker.mode ||
        next.picker.caseSensitive !== state.picker.caseSensitive
        ? requestSourceQuery(next)
        : { state: next };
    },
    view: (state, context) =>
      sourceInspectorView(
        state,
        Math.max(5, Math.min(84, context.terminalSize.columns - 4)),
        Math.max(4, Math.min(24, context.terminalSize.rows - 4))
      )
  };
}
