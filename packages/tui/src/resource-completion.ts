import {
  textAreaReducer,
  type TextAreaState,
  type TextAreaTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text } from '@ismail-elkorchi/terminal-ui/components';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';

export interface ResourceSuggestion {
  readonly id: string;
  readonly label: string;
  readonly insertion: string;
}
export interface ResourceSearch {
  search(query: string, signal: AbortSignal): Promise<readonly ResourceSuggestion[]>;
}
export interface ResourceCompletion {
  readonly id: string;
  readonly input: TextAreaState;
  readonly start: number;
  readonly end: number;
  readonly query: string;
  readonly phase: 'loading' | 'ready' | 'failed';
  readonly items: readonly ResourceSuggestion[];
  readonly selected: number;
  readonly error?: string;
}
export type ResourceCompletionMessage =
  | { readonly type: 'resource.loaded'; readonly id: string; readonly items: readonly ResourceSuggestion[] }
  | { readonly type: 'resource.failed'; readonly id: string; readonly error: string }
  | { readonly type: 'resource.move'; readonly delta: number }
  | { readonly type: 'resource.accept'; readonly id?: string }
  | { readonly type: 'resource.close' };

/** Recognize references at the caret. Multiline paste is ordinary editor input. */
export function completeResource(
  input: TextAreaState,
  transition?: TextAreaTransition,
  previous?: ResourceCompletion
): ResourceCompletion | undefined {
  if (
    transition !== undefined &&
    (transition.kind !== 'edit' ||
      ('text' in transition.operation && transition.operation.text.length !== 1))
  )
    return undefined;
  if (input.selection !== undefined && input.selection.anchor.offset !== input.selection.focus.offset)
    return undefined;
  const end = input.caret.position.offset;
  const before = textDocumentText(input.document).slice(0, end);
  const query = /(?:^|\s)@([^\s@]*)$/u.exec(before)?.[1];
  if (query === undefined) return undefined;
  return {
    id: crypto.randomUUID(),
    input,
    start: end - query.length - 1,
    end,
    query,
    phase: 'loading',
    items: previous?.items ?? [],
    selected: previous?.selected ?? 0
  };
}
export function searchResources(
  state: ResourceCompletion,
  operations: ResourceSearch
): TuiEffect<ResourceCompletionMessage> {
  return {
    id: 'resource-search',
    concurrency: 'replace',
    async run({ signal }) {
      const items = await operations.search(state.query, signal);
      signal.throwIfAborted();
      return { kind: 'message', message: { type: 'resource.loaded', id: state.id, items } };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'resource.failed', id: state.id, error: diagnostic.message }
    })
  };
}
export function updateResourceCompletion(
  state: ResourceCompletion,
  message: ResourceCompletionMessage
): ResourceCompletion | undefined {
  if ((message.type === 'resource.loaded' || message.type === 'resource.failed') && message.id !== state.id)
    return state;
  switch (message.type) {
    case 'resource.loaded': {
      const selectedId = state.items[state.selected]?.id;
      return {
        ...state,
        phase: 'ready',
        items: message.items,
        selected: Math.max(
          0,
          message.items.findIndex((item) => item.id === selectedId)
        )
      };
    }
    case 'resource.failed':
      return { ...state, phase: 'failed', items: [], error: message.error };
    case 'resource.move':
      return state.items.length === 0
        ? state
        : {
            ...state,
            selected: (state.selected + message.delta + state.items.length) % state.items.length
          };
    case 'resource.close':
      return undefined;
    case 'resource.accept':
      return state;
  }
}
export function acceptResource(
  state: ResourceCompletion,
  input: TextAreaState,
  id?: string
): TextAreaState {
  if (state.phase !== 'ready' || input !== state.input) return input;
  const item = id === undefined ? state.items[state.selected] : state.items.find((item) => item.id === id);
  return item === undefined
    ? input
    : textAreaReducer(input, {
        kind: 'edit',
        operation: {
          kind: 'replaceRange',
          range: { startOffset: state.start, endOffsetExclusive: state.end },
          text: item.insertion
        }
      }).state;
}
export function resourceCompletionRows(state?: ResourceCompletion): number {
  return state === undefined ? 0 : Math.max(1, Math.min(5, state.items.length)) + 1;
}
export function resourceSuggestions(state: ResourceCompletion) {
  const start = Math.max(0, state.selected - 4);
  return column([
    ...(state.phase !== 'ready' || state.items.length === 0
      ? [
          text({
            content:
              state.phase === 'failed'
                ? (state.error ?? 'Resource search failed.')
                : state.phase === 'loading'
                  ? 'Searching resources…'
                  : 'No matching resources.'
          })
        ]
      : state.items.slice(start, start + 5).map((item, index) =>
          button<ResourceCompletionMessage>({
            id: `resource:${item.id}`,
            label: `${start + index === state.selected ? '› ' : ''}${item.label}`,
            onPress: () => ({ type: 'resource.accept', id: item.id })
          })
        )),
    text({ content: '↑↓ choose · Tab / Enter insert · Esc dismiss', textRole: 'caption' })
  ]);
}
