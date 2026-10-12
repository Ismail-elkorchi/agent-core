import type {
  ContextSelection,
  ContextTransitionRequest,
  ContextService,
  HistorySearchRequest,
  HistorySearchResult,
  HistorySourceRef
} from '@agent-core/runtime';
import { button, checkbox, text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { panel } from './panel.js';

export type ContextInspection = Awaited<ReturnType<ContextService['inspect']>>;
export interface ContextOperations {
  inspectContext(): Promise<ContextInspection>;
  contextSources(request: HistorySearchRequest): Promise<HistorySearchResult>;
  transitionContext(request: ContextTransitionRequest): Promise<{
    readonly selection: { readonly kind: 'scheduled'; readonly requestId: string } | { readonly kind: 'selected' };
  }>;
  freshContext(retained?: readonly HistorySourceRef[]): Promise<unknown>;
}
export interface ContextState {
  readonly requestId?: string | undefined;
  readonly inspection?: ContextInspection;
  readonly history?: HistorySearchResult;
  readonly selection?: ContextSelection | undefined;
  readonly offset: number;
  readonly notice?: string | undefined;
  readonly pendingTransition?: { readonly idempotencyKey: string; readonly requestId?: string } | undefined;
}
export type ContextMessage =
  | { readonly type: 'context.open' | 'context.apply' | 'context.fresh' }
  | { readonly type: 'context.page'; readonly source: 'history' }
  | { readonly type: 'context.source'; readonly source: HistorySourceRef }
  | { readonly type: 'context.scroll'; readonly offset: number }
  | { readonly type: 'context.scheduled'; readonly requestId: string; readonly scheduledRequestId: string }
  | { readonly type: 'context.applied'; readonly idempotencyKey: string }
  | { readonly type: 'context.rejected'; readonly idempotencyKey: string; readonly message: string }
  | {
      readonly type: 'context.loaded';
      readonly requestId: string;
      readonly inspection: ContextInspection;
      readonly history: HistorySearchResult;
      readonly reset: boolean;
    }
  | { readonly type: 'context.failed'; readonly requestId: string; readonly message: string };

export function createContextState(): ContextState {
  return { offset: 0 };
}
const sameSource = (a: HistorySourceRef, b: HistorySourceRef) =>
  a.sessionId === b.sessionId && a.entryId === b.entryId && a.sha256 === b.sha256;

export function updateContext(
  state: ContextState,
  message: ContextMessage,
  operations: ContextOperations
): { readonly state: ContextState; readonly effects?: readonly TuiEffect<ContextMessage>[] } {
  switch (message.type) {
    case 'context.scheduled':
      return state.requestId !== message.requestId || state.pendingTransition?.idempotencyKey !== message.requestId
        ? { state }
        : { state: { ...state, requestId: undefined, pendingTransition: {
            idempotencyKey: message.requestId, requestId: message.scheduledRequestId
          } } };
    case 'context.applied': {
      if (state.pendingTransition?.idempotencyKey !== message.idempotencyKey) return { state };
      const result = updateContext({ ...state, pendingTransition: undefined }, { type: 'context.open' }, operations);
      return { ...result, state: { ...result.state, notice: 'Context selection applied.' } };
    }
    case 'context.rejected':
      return state.pendingTransition?.idempotencyKey !== message.idempotencyKey
        ? { state }
        : { state: { ...state, requestId: undefined, pendingTransition: undefined, notice: message.message } };
    case 'context.source': {
      if (state.requestId !== undefined || state.pendingTransition !== undefined) return { state };
      if (
        state.history?.items.some(
          (item) =>
            (item.generated === true || item.role === 'control') &&
            sameSource(item.source, message.source)
        )
      )
        return { state };
      if (state.inspection?.protectedSources.some((source) => sameSource(source, message.source)))
        return { state };
      const previous = state.selection?.retained ?? state.inspection?.protectedSources ?? [];
      const retained = previous.some((source) => sameSource(source, message.source))
        ? previous.filter((source) => !sameSource(source, message.source))
        : [...previous, message.source];
      return { state: { ...state, selection: { strategy: 'sources', retained } } };
    }
    case 'context.scroll':
      return { state: { ...state, offset: message.offset } };
    case 'context.failed':
      return message.requestId !== state.requestId
        ? { state }
        : { state: { ...state, requestId: undefined, pendingTransition: undefined, notice: message.message } };
    case 'context.loaded': {
      if (message.requestId !== state.requestId) return { state };
      const active = message.inspection.activeSelection;
      const selection = message.reset
        ? active.status === 'available'
          ? active.selection
          : undefined
        : state.selection;
      return {
        state: {
          inspection: message.inspection,
          history: message.history,
          selection,
          notice: state.notice,
          ...(active.status === 'unavailable'
            ? {
                notice:
                  active.conflict.message + ' Choose an explicit source selection.'
              }
            : {}),
          offset: 0
        }
      };
    }
    default: {
      if (state.pendingTransition !== undefined) return { state };
      if (
        (message.type === 'context.apply' || message.type === 'context.fresh') &&
        (state.selection === undefined || state.inspection === undefined)
      )
        return { state };
      const requestId = crypto.randomUUID();
      const reset = message.type !== 'context.page';
      return {
        state: { ...state, requestId, notice: undefined,
          ...(message.type === 'context.apply' ? { pendingTransition: { idempotencyKey: requestId } } : {}) },
        effects: [
          {
            id: 'context-controls',
            concurrency: 'replace',
            async run({ signal }) {
              if (message.type === 'context.apply' && state.selection && state.inspection) {
                const result = await operations.transitionContext({
                  expectedWindowId: state.inspection.window?.windowId ?? null,
                  expectedSourceRevision: state.inspection.cut.sourceRevision,
                  idempotencyKey: requestId,
                  reason: 'User-selected context sources.',
                  selection: state.selection
                });
                signal.throwIfAborted();
                return { kind: 'message', message: result.selection.kind === 'scheduled'
                  ? { type: 'context.scheduled', requestId, scheduledRequestId: result.selection.requestId }
                  : { type: 'context.applied', idempotencyKey: requestId } };
              }
              if (message.type === 'context.fresh')
                await operations.freshContext(state.selection?.retained);
              signal.throwIfAborted();
              const inspection = reset
                ? await operations.inspectContext()
                : (state.inspection ?? (await operations.inspectContext()));
              const history = await operations.contextSources({
                cut: inspection.cut,
                limit: 30,
                maxBytes: 32 * 1024,
                maxScanned: 100,
                maxScannedBytes: 128 * 1024,
                ...(message.type === 'context.page' && state.history?.cursor
                  ? { cursor: state.history.cursor }
                  : {})
              });
              signal.throwIfAborted();
              return {
                kind: 'message',
                message: { type: 'context.loaded', requestId, inspection, history, reset }
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
  const selectedOutsidePage = (state.selection?.retained ?? []).filter(
    (source) => !visible.some((item) => sameSource(item.source, source))
  );
  const sourceChoice = (source: HistorySourceRef, label: string): Element<Message> => {
    const protectedInput = protectedSources.some((item) => sameSource(item, source));
    return checkbox<Message>({
      id: `context-source:${source.entryId}`,
      label: `${protectedInput ? 'Required · ' : ''}${label}`,
      checked:
        protectedInput ||
        (state.selection?.retained ?? []).some((item) => sameSource(item, source)),
      ...(state.requestId !== undefined || state.pendingTransition !== undefined
        ? { disabled: true }
        : { onTransition: (): Message => ({ type: 'context.source', source }) })
    });
  };
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
            content: state.pendingTransition
              ? 'Selection queued; waiting for a safe context boundary.'
              : state.requestId
              ? 'Loading context…'
              : (state.notice ??
                state.inspection?.admission?.message ??
                'Choose original sources for the next window. Current working state is included automatically; history remains available.')
          }),
          ...(capacity
            ? [
                text({
                  content: `${String(capacity.remainingTokens ?? 'Unknown')} input tokens remaining · ${capacity.pressure} pressure · ${capacity.method.name} ${capacity.method.version}`
                })
              ]
            : []),
          text({
            content:
              state.selection === undefined
                ? 'Select originals to build a replacement window.'
                : `Draft selection: ${String(state.selection.retained.length)} sources. Required inputs are retained automatically.`
          }),
          ...selectedOutsidePage.map((source) => sourceChoice(source, source.entryId)),
          ...visible.map((item) =>
            item.generated === true || item.role === 'control'
              ? text({
                  content: `${item.generated ? 'Generated interpretation' : 'Session configuration'} · ${item.text.replaceAll(/\s+/gu, ' ').slice(0, 140)}${item.truncated ? '…' : ''}`
                })
              : sourceChoice(
                  item.source,
                  `${item.role} · ${item.text.replaceAll(/\s+/gu, ' ').slice(0, 140)}${item.truncated ? '…' : ''}`
                )
          ),
          ...(state.history?.cursor
            ? [
                button<Message>({
                  id: 'context-history-next',
                  label: 'Next history page',
                  ...(state.pendingTransition !== undefined
                    ? { disabled: true }
                    : { onPress: (): Message => ({ type: 'context.page', source: 'history' }) })
                })
              ]
            : []),
          ...(state.inspection?.workingState
            ? [
                text({
                  content: `Current working state · generated interpretation · ${state.inspection.workingState.revisionId ?? 'empty'}`
                }),
                text({
                  content: state.inspection.workingState.text || 'No working-state content.'
                }),
                ...(!state.inspection.workingState.complete
                  ? [
                      text({
                        content:
                          'Partial state preview. Retrieve its original through session history for the remaining content.'
                      })
                    ]
                  : [])
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
            ...(state.requestId !== undefined || state.pendingTransition !== undefined ||
            state.inspection === undefined ||
            state.selection === undefined
              ? { disabled: true }
              : { onPress: (): Message => ({ type: 'context.apply' }) })
          }),
          button<Message>({
            id: 'context-fresh',
            label: 'Fresh reasoning; keep selected originals',
            ...(state.requestId !== undefined || state.pendingTransition !== undefined ||
            state.inspection === undefined ||
            state.selection === undefined ||
            state.inspection.pendingWork.length
              ? { disabled: true }
              : { onPress: (): Message => ({ type: 'context.fresh' }) })
          }),
          button<Message>({
            id: 'context-refresh',
            label: 'Refresh',
            ...(state.pendingTransition !== undefined
              ? { disabled: true }
              : { onPress: (): Message => ({ type: 'context.open' }) })
          })
        ],
        { direction: 'horizontal' }
      )
    }
  });
}
