import type { NoteQueryResult, NoteReadResult } from '@agent-core/runtime';
import {
  createTextAreaState,
  textAreaReducer,
  type TextAreaState,
  type TextAreaTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, textArea, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, row, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { diagnosticMessage } from './diagnostics.js';
import { panel } from './panel.js';

export interface NoteReader {
  listNotes(cursor?: string): Promise<NoteQueryResult>;
  readNote(request: {
    readonly noteId: string;
    readonly revisionId: string;
    readonly offset?: number;
  }): Promise<NoteReadResult>;
}
export type NotesMessage =
  | { readonly type: 'notes.open'; readonly cursor?: string }
  | { readonly type: 'notes.listed'; readonly requestId: string; readonly page: NoteQueryResult }
  | {
      readonly type: 'notes.read';
      readonly noteId: string;
      readonly revisionId: string;
      readonly offset?: number;
    }
  | { readonly type: 'notes.loaded'; readonly requestId: string; readonly result: NoteReadResult }
  | { readonly type: 'notes.failed'; readonly requestId: string; readonly message: string }
  | { readonly type: 'notes.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'notes.scroll'; readonly offset: number };
export interface NotesState {
  readonly requestId?: string;
  readonly page?: NoteQueryResult;
  readonly source?: {
    readonly result: Extract<NoteReadResult, { status: 'available' }>;
    readonly input: TextAreaState;
  };
  readonly error?: string;
  readonly offset: number;
}

export function updateNotes(
  state: NotesState,
  message: NotesMessage,
  reader: NoteReader
): { readonly state: NotesState; readonly effects?: readonly TuiEffect<NotesMessage>[] } {
  switch (message.type) {
    case 'notes.open':
    case 'notes.read': {
      const requestId = crypto.randomUUID();
      return {
        state: { requestId, offset: 0 },
        effects: [
          {
            id: 'model-notes-read',
            concurrency: 'replace',
            async run() {
              return {
                kind: 'message',
                message:
                  message.type === 'notes.open'
                    ? { type: 'notes.listed', requestId, page: await reader.listNotes(message.cursor) }
                    : { type: 'notes.loaded', requestId, result: await reader.readNote(message) }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'notes.failed', requestId, message: diagnosticMessage(diagnostic) }
            })
          }
        ]
      };
    }
    case 'notes.listed':
      return message.requestId !== state.requestId
        ? { state }
        : { state: { page: message.page, offset: 0 } };
    case 'notes.loaded':
      return message.requestId !== state.requestId
        ? { state }
        : {
            state:
              message.result.status === 'available'
                ? {
                    source: {
                      result: message.result,
                      input: createTextAreaState({ value: message.result.text })
                    },
                    offset: 0
                  }
                : { error: `Note content ${message.result.status.replaceAll('_', ' ')}.`, offset: 0 }
          };
    case 'notes.failed':
      return message.requestId !== state.requestId
        ? { state }
        : { state: { error: message.message, offset: 0 } };
    case 'notes.scroll':
      return { state: { ...state, offset: message.offset } };
    case 'notes.edit':
      return state.source === undefined
        ? { state }
        : {
            state: {
              ...state,
              source: {
                ...state.source,
                input: textAreaReducer(state.source.input, message.transition).state
              }
            }
          };
  }
}

export function notesView<Message extends NotesMessage | { readonly type: 'overlay.close' }>(
  state: NotesState,
  width: number,
  height: number,
  map: (message: NotesMessage | { readonly type: 'overlay.close' }) => Message
): Element<Message> {
  const source = state.source;
  const children: Element<Message>[] = [];
  if (state.requestId !== undefined) children.push(text({ content: 'Reading model-authored notes…' }));
  if (state.error !== undefined && source === undefined) children.push(text({ content: state.error }));
  if (source !== undefined) {
    const { revision, offset, nextOffset, totalBytes, truncated } = source.result;
    children.push(
      text({
        content: `${state.error ?? revision.title}\nAuthor: ${revision.authorId} · revision ${revision.revisionId}\nInvocation: ${revision.invocationId}\nSources: ${JSON.stringify(revision.sources)}\nBytes ${String(offset)}–${String(nextOffset)} of ${String(totalBytes)}`
      })
    );
    children.push(
      textArea<Message>({
        id: 'model-note-source',
        meta: { accessibleName: 'Exact model note content' },
        state: source.input,
        readOnly: true,
        wrap: true,
        scrollbar: { axis: 'vertical', visible: 'auto' },
        onTransition: (transition: TextAreaTransition) => map({ type: 'notes.edit', transition })
      })
    );
    children.push(
      row([
        button({ id: 'notes-back', label: 'Note list', onPress: () => map({ type: 'notes.open' }) }),
        ...(truncated
          ? [
              button({
                id: 'notes-next-content',
                label: 'Next content chunk',
                onPress: () =>
                  map({
                    type: 'notes.read',
                    noteId: revision.noteId,
                    revisionId: revision.revisionId,
                    offset: nextOffset
                  })
              })
            ]
          : [])
      ])
    );
  } else {
    for (const revision of state.page?.items ?? [])
      children.push(
        button({
          id: `note:${revision.noteId}`,
          label: `${revision.title} · ${revision.authorId} · ${revision.revisionId}`,
          onPress: () =>
            map({ type: 'notes.read', noteId: revision.noteId, revisionId: revision.revisionId })
        })
      );
    const cursor = state.page?.cursor;
    if (cursor !== undefined)
      children.push(
        button({
          id: 'notes-next-page',
          label: 'Next notes page',
          onPress: () => map({ type: 'notes.open', cursor })
        })
      );
    children.push(
      text({
        content:
          state.page === undefined
            ? ''
            : state.page.coverage === 'partial'
              ? 'Partial coverage · continue paging to inspect remaining records.'
              : 'End of notes.'
      })
    );
  }
  const content = column(
    children,
    source === undefined
      ? {}
      : {
          sizes: [
            { kind: 'fixed', cells: 7 },
            { kind: 'fill', weight: 1 },
            { kind: 'fixed', cells: 1 }
          ]
        }
  );
  return panel({
    id: 'model-notes',
    title: 'Model notes · attributed reference material',
    width,
    height,
    ...(source === undefined
      ? state.page?.items[0] === undefined
        ? {}
        : { focusId: `note:${state.page.items[0].noteId}` }
      : { focusId: 'model-note-source' }),
    onClose: () => map({ type: 'overlay.close' }),
    slots: {
      content:
        source === undefined
          ? viewport(content, {
              id: 'model-notes-list',
              offset: { row: state.offset },
              onScroll: (request) => map({ type: 'notes.scroll', offset: request.nextState.offsetRow })
            })
          : content
    }
  });
}
