import {
  createSearchPickerIndex,
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  searchPickerView,
  type SearchPickerControlTransition,
  type UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import { searchPicker } from '@ismail-elkorchi/terminal-ui/components';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { draftFromSubmission, type ComposerDraft } from './draft.js';
import { panel } from './panel.js';

export interface PromptHistory {
  readonly entries: readonly ComposerDraft[];
  readonly index: number | null;
  readonly unsent?: ComposerDraft;
}
export const emptyPromptHistory: PromptHistory = { entries: [], index: null };
export function rememberPrompt(history: PromptHistory, draft: ComposerDraft): PromptHistory {
  const input = createTextAreaState({
    value: textDocumentText(draft.input.document),
    caret: draft.input.caret,
    ...(draft.input.selection === undefined ? {} : { selection: draft.input.selection })
  });
  return { entries: [...history.entries, { ...draft, input }].slice(-100), index: null };
}
export function navigatePromptHistory(
  history: PromptHistory,
  draft: ComposerDraft,
  direction: 'previous' | 'next'
): { readonly history: PromptHistory; readonly draft: ComposerDraft } {
  const index = history.index;
  if (history.entries.length === 0 || (direction === 'next' && index === null)) return { history, draft };
  const next =
    direction === 'previous' ? Math.max(0, (index ?? history.entries.length) - 1) : (index ?? 0) + 1;
  if (next >= history.entries.length)
    return { history: { entries: history.entries, index: null }, draft: history.unsent ?? draft };
  const selected = history.entries[next];
  return selected === undefined
    ? { history, draft }
    : {
        history: { entries: history.entries, index: next, unsent: history.unsent ?? draft },
        draft: selected
      };
}
export interface PromptRecallState {
  readonly id: string;
  readonly entries: readonly ComposerDraft[];
  readonly picker: UnscrolledSearchPickerState;
}
export type PromptRecallMessage =
  | { readonly type: 'recall.open' }
  | { readonly type: 'recall.loaded'; readonly id: string; readonly drafts: readonly ComposerDraft[] }
  | { readonly type: 'recall.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'recall.accept'; readonly id: string };
const index = (entries: readonly ComposerDraft[]) =>
  createSearchPickerIndex(
    entries.map((draft, position) => ({
      id: String(position),
      value: draft,
      label: textDocumentText(draft.input.document),
      description:
        draft.attachments.length === 0
          ? 'Restore as an editable draft'
          : `${String(draft.attachments.length)} attachments · restore as an editable draft`
    }))
  );
export function createPromptRecall(history: PromptHistory): PromptRecallState {
  const entries = [...history.entries].reverse();
  return {
    id: crypto.randomUUID(),
    entries,
    picker: createSearchPickerState({ query: { text: '', mode: 'fuzzy' } }, index(entries))
  };
}
export function updatePromptRecall(
  state: PromptRecallState,
  transition: SearchPickerControlTransition
): PromptRecallState {
  return {
    ...state,
    picker: searchPickerReducer(state.picker, transition, { searchPickerIndex: index(state.entries) })
  };
}
export function promptRecallView(state: PromptRecallState, width: number, height: number) {
  type Message = PromptRecallMessage | { readonly type: 'overlay.close' };
  return panel<Message>({
    id: 'prompt-recall',
    title: 'Recall a prompt · select to edit',
    width,
    height,
    focusId: 'prompt-recall-picker',
    onClose: () => ({ type: 'overlay.close' }),
    slots: {
      content: searchPicker({
        id: 'prompt-recall-picker',
        title: 'Loaded prompts and recovered drafts',
        view: searchPickerView(state.picker),
        searchPickerIndex: index(state.entries),
        maxVisible: Math.max(1, height - 5),
        emptyText: 'No matching prompts. Close to return to your unchanged draft.',
        onTransition: (transition): Message => ({ type: 'recall.transition', transition }),
        onAccept: (event): Message => ({ type: 'recall.accept', id: event.id })
      })
    }
  });
}

export function loadRecoveredPrompts(
  storage: import('./draft.js').DraftStorage,
  sessionId: string,
  id: string
): import('@ismail-elkorchi/terminal-ui/tui').TuiEffect<
  | PromptRecallMessage
  | { readonly type: 'draft.failed'; readonly sessionId: string; readonly message: string }
> {
  return {
    id: 'recovered-drafts',
    concurrency: 'replace',
    async run({ signal }) {
      const drafts = await storage.readRecovered(sessionId);
      signal.throwIfAborted();
      return { kind: 'message', message: { type: 'recall.loaded', id, drafts } };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'draft.failed', sessionId, message: diagnostic.message }
    })
  };
}
export function recoverDraft<Message>(
  storage: import('./draft.js').DraftStorage | undefined,
  sessionId: string,
  draft: ComposerDraft,
  failed: (message: string) => Message
): import('@ismail-elkorchi/terminal-ui/tui').TuiEffect<Message> {
  return {
    id: 'recover-draft',
    concurrency: 'enqueue',
    async run() {
      await storage?.recover(sessionId, draft);
      return { kind: 'none' };
    },
    onError: ({ diagnostic }) => ({ kind: 'message', message: failed(diagnostic.message) })
  };
}

export function appendRecalledDrafts(
  state: PromptRecallState,
  drafts: readonly ComposerDraft[]
): PromptRecallState {
  const entries = [...state.entries, ...drafts];
  const activeId = searchPickerView(state.picker).activeId;
  return {
    ...state,
    entries,
    picker: searchPickerReducer(
      state.picker,
      { kind: 'setActive', ...(activeId === undefined ? {} : { id: activeId }) },
      { searchPickerIndex: index(entries) }
    )
  };
}
export function promptsFromHistory(
  entries: readonly import('@agent-core/runtime').SessionBranchEntry[]
): readonly ComposerDraft[] {
  return entries.flatMap((entry) =>
    entry.type === 'input'
      ? [
          draftFromSubmission(
            entry.originalInput ?? {
              task: entry.task,
              ...(entry.images === undefined ? {} : { images: entry.images })
            }
          )
        ]
      : entry.type === 'steering'
        ? [draftFromSubmission(entry.originalInput ?? { task: entry.content })]
        : []
  );
}
