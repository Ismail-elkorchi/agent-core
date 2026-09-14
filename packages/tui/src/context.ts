import type {
  ContextSelection,
  ContextService,
  HistorySearchRequest,
  HistorySearchResult,
  HistorySourceRef,
  NoteQueryResult,
  NoteReference
} from '@agent-core/runtime';
import { button, checkbox, text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { panel } from './panel.js';

export type ContextInspection = Awaited<ReturnType<ContextService['inspect']>>;
export interface ContextOperations {
  inspectContext(): Promise<ContextInspection>;
  contextSources(request: HistorySearchRequest): Promise<HistorySearchResult>;
  listNotes(cursor?: string): Promise<NoteQueryResult>;
  renewContext(selection?: ContextSelection): Promise<unknown>;
}
export interface ContextState {
  readonly requestId?: string | undefined;
  readonly inspection?: ContextInspection;
  readonly history?: HistorySearchResult;
  readonly notes?: NoteQueryResult;
  readonly selection: ContextSelection;
  readonly offset: number;
  readonly notice?: string;
}
export type ContextMessage =
  | { readonly type: 'context.open' | 'context.renew' | 'context.apply' }
  | { readonly type: 'context.page'; readonly source: 'history' | 'notes' }
  | { readonly type: 'context.source'; readonly source: HistorySourceRef }
  | { readonly type: 'context.note'; readonly note: NoteReference }
  | { readonly type: 'context.scroll'; readonly offset: number }
  | {
      readonly type: 'context.loaded';
      readonly requestId: string;
      readonly inspection: ContextInspection;
      readonly history: HistorySearchResult;
      readonly notes: NoteQueryResult;
      readonly reset: boolean;
    }
  | { readonly type: 'context.failed'; readonly requestId: string; readonly message: string };

export function createContextState(): ContextState {
  return { selection: { strategy: 'sources', retained: [], notes: [] }, offset: 0 };
}
const sameSource = (a: HistorySourceRef, b: HistorySourceRef) =>
  a.sessionId === b.sessionId && a.entryId === b.entryId && a.sha256 === b.sha256;
const sameNote = (a: NoteReference, b: NoteReference) =>
  a.scope.sessionId === b.scope.sessionId &&
  a.scope.branchId === b.scope.branchId &&
  a.noteId === b.noteId &&
  a.revisionId === b.revisionId;

export function updateContext(
  state: ContextState,
  message: ContextMessage,
  operations: ContextOperations
): { readonly state: ContextState; readonly effects?: readonly TuiEffect<ContextMessage>[] } {
  switch (message.type) {
    case 'context.source': {
      if (state.inspection?.protectedSources.some((source) => sameSource(source, message.source)))
        return { state };
      const retained = state.selection.retained.some((source) => sameSource(source, message.source))
        ? state.selection.retained.filter((source) => !sameSource(source, message.source))
        : [...state.selection.retained, message.source];
      return { state: { ...state, selection: { ...state.selection, retained } } };
    }
    case 'context.note': {
      const notes = state.selection.notes.some((note) => sameNote(note, message.note))
        ? state.selection.notes.filter((note) => !sameNote(note, message.note))
        : [...state.selection.notes, message.note];
      return { state: { ...state, selection: { ...state.selection, notes } } };
    }
    case 'context.scroll':
      return { state: { ...state, offset: message.offset } };
    case 'context.failed':
      return message.requestId !== state.requestId
        ? { state }
        : { state: { ...state, requestId: undefined, notice: message.message } };
    case 'context.loaded': {
      if (message.requestId !== state.requestId) return { state };
      const selection = message.reset
        ? {
            strategy: 'sources' as const,
            retained:
              message.inspection.window?.selection.retained ?? message.inspection.protectedSources,
            notes: message.inspection.window?.selection.notes ?? []
          }
        : state.selection;
      return {
        state: {
          inspection: message.inspection,
          history: message.history,
          notes: message.notes,
          selection,
          offset: 0
        }
      };
    }
    default: {
      const requestId = crypto.randomUUID();
      const reset = message.type !== 'context.page';
      return {
        state: { ...state, requestId },
        effects: [
          {
            id: 'context-controls',
            concurrency: 'replace',
            async run({ signal }) {
              if (message.type === 'context.apply') await operations.renewContext(state.selection);
              if (message.type === 'context.renew') await operations.renewContext();
              signal.throwIfAborted();
              const inspection = reset
                ? await operations.inspectContext()
                : (state.inspection ?? (await operations.inspectContext()));
              const [history, notes] = await Promise.all([
                message.type === 'context.page' && message.source === 'notes' && state.history
                  ? state.history
                  : operations.contextSources({
                      cut: inspection.cut,
                      limit: 30,
                      maxBytes: 32 * 1024,
                      maxScanned: 100,
                      maxScannedBytes: 128 * 1024,
                      ...(message.type === 'context.page' &&
                      message.source === 'history' &&
                      state.history?.cursor
                        ? { cursor: state.history.cursor }
                        : {})
                    }),
                message.type === 'context.page' && message.source === 'history' && state.notes
                  ? state.notes
                  : operations.listNotes(
                      message.type === 'context.page' && message.source === 'notes'
                        ? state.notes?.cursor
                        : undefined
                    )
              ]);
              signal.throwIfAborted();
              return {
                kind: 'message',
                message: { type: 'context.loaded', requestId, inspection, history, notes, reset }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'context.failed', requestId, message: diagnostic.message }
            })
          }
        ]
      };
    }
  }
}

export function contextView(
  state: ContextState,
  width: number,
  height: number
): Element<ContextMessage | { readonly type: 'overlay.close' }> {
  type Message = ContextMessage | { readonly type: 'overlay.close' };
  const protectedSources = state.inspection?.protectedSources ?? [];
  const capacity = state.inspection?.capacity;
  const visible = state.history?.items ?? [];
  const selectedOutsidePage = state.selection.retained.filter(
    (source) => !visible.some((item) => sameSource(item.source, source))
  );
  const sourceChoice = (source: HistorySourceRef, label: string): Element<Message> => {
    const protectedInput = protectedSources.some((item) => sameSource(item, source));
    return checkbox<Message>({
      id: `context-source:${source.entryId}`,
      label: `${protectedInput ? 'Required · ' : ''}${label}`,
      checked: protectedInput || state.selection.retained.some((item) => sameSource(item, source)),
      onTransition: () => ({ type: 'context.source', source })
    });
  };
  const selectedNotes = state.selection.notes.filter(
    (note) => !state.notes?.items.some((item) => sameNote(item, note))
  );
  return panel<Message>({
    id: 'context-controls',
    title: 'Working context',
    width,
    height,
    onClose: () => ({ type: 'overlay.close' }),
    slots: {
      content: viewport(
        column([
          text({
            content: state.requestId
              ? 'Loading context…'
              : (state.notice ??
                state.inspection?.admission?.message ??
                'Choose original sources and optional note revisions for the next window. History remains available.')
          }),
          ...(capacity
            ? [
                text({
                  content: `${String(capacity.remainingTokens ?? 'Unknown')} input tokens remaining · ${capacity.pressure} pressure · ${capacity.method.name} ${capacity.method.version}`
                })
              ]
            : []),
          text({
            content: `Draft selection: ${String(state.selection.retained.length)} sources · ${String(state.selection.notes.length)} notes selected. Required inputs are retained automatically.`
          }),
          ...selectedOutsidePage.map((source) => sourceChoice(source, source.entryId)),
          ...visible.map((item) =>
            sourceChoice(
              item.source,
              `${item.role} · ${item.text.replaceAll(/\s+/gu, ' ').slice(0, 140)}${item.truncated ? '…' : ''}`
            )
          ),
          ...(state.history?.cursor
            ? [
                button<Message>({
                  id: 'context-history-next',
                  label: 'Next history page',
                  onPress: () => ({ type: 'context.page', source: 'history' })
                })
              ]
            : []),
          ...[...selectedNotes, ...(state.notes?.items ?? [])].map((note) =>
            checkbox<Message>({
              id: `context-note:${note.noteId}:${note.revisionId}`,
              label: `Note · ${'title' in note && typeof note.title === 'string' ? note.title : note.noteId} · ${note.revisionId}`,
              checked: state.selection.notes.some((item) => sameNote(item, note)),
              onTransition: () => ({
                type: 'context.note',
                note: { scope: note.scope, noteId: note.noteId, revisionId: note.revisionId }
              })
            })
          ),
          ...(state.notes?.cursor
            ? [
                button<Message>({
                  id: 'context-notes-next',
                  label: 'Next notes page',
                  onPress: () => ({ type: 'context.page', source: 'notes' })
                })
              ]
            : [])
        ]),
        {
          id: 'context-source-list',
          offset: { row: state.offset },
          scrollbar: { axis: 'vertical', visible: 'auto' },
          onScroll: (event) => ({ type: 'context.scroll', offset: event.nextState.offsetRow })
        }
      ),
      actions: flow(
        [
          button<Message>({
            id: 'context-apply',
            label: 'Apply selection',
            ...(state.requestId !== undefined || state.inspection === undefined
              ? { disabled: true }
              : { onPress: (): Message => ({ type: 'context.apply' }) })
          }),
          button<Message>({
            id: 'context-renew',
            label: 'Renew window',
            ...(state.requestId !== undefined
              ? { disabled: true }
              : { onPress: (): Message => ({ type: 'context.renew' }) })
          }),
          button<Message>({
            id: 'context-refresh',
            label: 'Refresh',
            onPress: () => ({ type: 'context.open' })
          })
        ],
        { direction: 'horizontal' }
      )
    }
  });
}
