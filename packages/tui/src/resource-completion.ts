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
  /** Literal reference; the composer owns quoting and insertion. */
  readonly reference: string;
  /** Continue searching within this reference, for example after choosing a directory. */
  readonly continueSearch?: boolean;
}
export interface ResourceSearch {
  search(query: string, signal: AbortSignal): Promise<ResourceSearchResult>;
}
export interface ResourceSearchResult {
  readonly items: readonly ResourceSuggestion[];
  readonly coverage: 'complete' | 'partial';
}
interface ResourceCompletionBase {
  readonly id: string;
  readonly input: TextAreaState;
  readonly start: number;
  readonly end: number;
  readonly query: string;
  readonly items: readonly ResourceSuggestion[];
  readonly selected: number;
}
export type ResourceCompletion = ResourceCompletionBase & (
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly coverage: ResourceSearchResult['coverage'] }
  | { readonly phase: 'failed'; readonly error: string }
);
export type ResourceCompletionMessage =
  | {
      readonly type: 'resource.loaded';
      readonly id: string;
      readonly result: ResourceSearchResult;
    }
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
  if (
    input.selection !== undefined &&
    input.selection.anchor.offset !== input.selection.focus.offset
  )
    return undefined;
  const reference = referenceAt(textDocumentText(input.document), input.caret.position.offset);
  if (reference === undefined) return undefined;
  return {
    id: crypto.randomUUID(),
    input,
    ...reference,
    phase: 'loading',
    items: previous?.items ?? [],
    selected: previous?.selected ?? 0
  };
}

function referenceAt(source: string, caret: number) {
  // Match complete references so an edit in the middle also replaces the old suffix.
  for (const match of source.matchAll(/(?:^|\s)@(?:"(?:\\[^\r\n]|[^"\\\r\n])*"?|[^\s@"]*)/gu)) {
    const start = match.index + match[0].indexOf('@');
    const end = match.index + match[0].length;
    if (start >= caret) break;
    if (caret > end) continue;
    const prefix = source.slice(start + 1, caret);
    if (!prefix.startsWith('"')) return { start, end, query: prefix };
    const closed = prefix.length > 1 && /(?:^|[^\\])(?:\\\\)*"$/u.test(prefix);
    try {
      const query: unknown = JSON.parse(closed ? prefix : `${prefix}"`);
      return typeof query === 'string' ? { start, end, query } : undefined;
    } catch {
      // An unfinished escape is ordinary editor input until it can identify a resource.
      return undefined;
    }
  }
  return undefined;
}

export function searchResources(
  state: ResourceCompletion,
  operations: ResourceSearch
): TuiEffect<ResourceCompletionMessage> {
  return {
    id: 'resource-search',
    concurrency: 'replace',
    async run({ signal }) {
      const result = await operations.search(state.query, signal);
      signal.throwIfAborted();
      return { kind: 'message', message: { type: 'resource.loaded', id: state.id, result } };
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
  if (
    (message.type === 'resource.loaded' || message.type === 'resource.failed') &&
    message.id !== state.id
  )
    return state;
  switch (message.type) {
    case 'resource.loaded': {
      const selectedId = state.items[state.selected]?.id;
      return {
        ...state,
        phase: 'ready',
        items: message.result.items,
        coverage: message.result.coverage,
        selected: Math.max(
          0,
          message.result.items.findIndex((item) => item.id === selectedId)
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
): { readonly input: TextAreaState; readonly completion?: ResourceCompletion } {
  if (input !== state.input) return { input };
  if (state.phase !== 'ready') return { input, completion: state };
  const item =
    id === undefined ? state.items[state.selected] : state.items.find((item) => item.id === id);
  if (item === undefined) return { input, completion: state };
  const quoted = /[\s"\\@]/u.test(item.reference);
  const reference = `@${quoted ? JSON.stringify(item.reference) : item.reference}`;
  const following = textDocumentText(input.document).slice(state.end, state.end + 1);
  const separator = item.continueSearch || /\s/u.test(following) ? '' : ' ';
  const next = textAreaReducer(input, {
    kind: 'applyChanges',
    changeSet: {
      changes: [{
        startOffset: state.start,
        endOffsetExclusive: state.end,
        insertedText: reference + separator
      }]
    },
    caretOffset:
      state.start + reference.length + separator.length - (item.continueSearch && quoted ? 1 : 0)
  }).state;
  const completion = item.continueSearch ? completeResource(next) : undefined;
  return { input: next, ...(completion === undefined ? {} : { completion }) };
}
export function resourceCompletionRows(state?: ResourceCompletion, limit = 5): number {
  return state === undefined ? 0 : Math.max(1, Math.min(limit, state.items.length)) + 1;
}
export function resourceSuggestions(state: ResourceCompletion, limit = 5) {
  const start = Math.max(0, state.selected - limit + 1);
  return column([
    ...(state.phase !== 'ready' || state.items.length === 0
      ? [
          text({
            content:
              state.phase === 'failed'
                ? state.error
                : state.phase === 'loading'
                  ? 'Searching resources…'
                  : state.coverage === 'partial'
                    ? 'No match in the searched entries.'
                    : 'No matching resources.'
          })
        ]
      : state.items.slice(start, start + limit).map((item, index) =>
          button<ResourceCompletionMessage>({
            id: `resource:${item.id}`,
            label: `${start + index === state.selected ? '› ' : ''}${item.label}`,
            onPress: () => ({ type: 'resource.accept', id: item.id })
          })
        )),
    text({
      content: `${state.phase === 'ready' && state.coverage === 'partial' ? 'Partial results · ' : ''}↑↓ choose · Tab / Enter insert · Esc dismiss`,
      textRole: 'caption'
    })
  ]);
}
