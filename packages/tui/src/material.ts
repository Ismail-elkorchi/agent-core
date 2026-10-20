import type { MaterialGrantPage, MaterialOwner, MaterialPage, QualifiedMaterialRef, ScopedMaterialService } from '@agent-core/runtime';
import { createTextAreaState, textAreaReducer, type TextAreaState, type TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, textArea, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiChildDefinition, TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { diagnosticMessage } from './diagnostics.js';
import { panel } from './panel.js';

export interface MaterialOperations {
  materialService(expectedSessionId?: string): ScopedMaterialService;
  submitMaterialCorrection(ref: QualifiedMaterialRef, text: string, expectedSessionId: string): Promise<unknown>;
}
export interface MaterialPanelState {
  readonly sessionId: string;
  readonly scopes?: MaterialGrantPage | undefined;
  readonly sessionOwner?: MaterialOwner | undefined;
  readonly owner?: MaterialOwner | undefined;
  readonly items?: MaterialPage | undefined;
  readonly selected?: QualifiedMaterialRef | undefined;
  readonly body?: Awaited<ReturnType<ScopedMaterialService['read']>> | undefined;
  readonly input: TextAreaState;
  readonly pending: boolean;
  readonly offset: number;
  readonly confirm?: 'revoke' | 'erase' | undefined;
  readonly notice?: string | undefined;
}
export type MaterialPanelMessage =
  | { readonly type: 'close' | 'refresh' | 'back' | 'next' | 'correct' | 'cancel-confirmation' | 'confirm' }
  | { readonly type: 'scopes'; readonly scopes: MaterialGrantPage; readonly sessionOwner: MaterialOwner }
  | { readonly type: 'choose'; readonly owner: MaterialOwner }
  | { readonly type: 'items'; readonly owner: MaterialOwner; readonly items: MaterialPage }
  | { readonly type: 'read'; readonly ref: QualifiedMaterialRef }
  | { readonly type: 'body'; readonly ref: QualifiedMaterialRef; readonly body: Awaited<ReturnType<ScopedMaterialService['read']>> }
  | { readonly type: 'notice'; readonly notice: string }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'prepare'; readonly action: 'revoke' | 'erase' }
  | { readonly type: 'scroll'; readonly offset: number };

/** A bounded view over the admission service. No separate memory cache or access policy. */
export function materialPanel(operations: MaterialOperations, sessionId: string):
  TuiChildDefinition<MaterialPanelState, MaterialPanelMessage, 'close'> {
  const service = () => operations.materialService(sessionId);
  const effect = (run: (signal: AbortSignal) => Promise<MaterialPanelMessage>): TuiEffect<MaterialPanelMessage> => ({
    id: 'material-controls', concurrency: 'keep-first',
    async run({ signal }) { signal.throwIfAborted(); const message = await run(signal); signal.throwIfAborted(); return { kind: 'message', message }; },
    onError: ({ diagnostic }) => ({ kind: 'message', message: { type: 'failed', message: diagnosticMessage(diagnostic) } })
  });
  const load = (owner?: MaterialOwner, cursor?: string) => effect(async () => {
    const page = { limit: 30, maxBytes: 32 * 1024, ...(cursor === undefined ? {} : { cursor }) };
    return owner === undefined
      ? { type: 'scopes', scopes: await service().listScopes(page), sessionOwner: await service().currentSessionOwner() }
      : { type: 'items', owner, items: await service().list(owner, page) };
  });
  return {
    init: () => ({ state: { sessionId, input: createTextAreaState({ value: '' }), pending: true, offset: 0 }, effects: [load()] }),
    update(state, message) {
      if (message.type === 'close') return { state, outputs: ['close'] };
      if (message.type === 'scroll') return { state: { ...state, offset: message.offset } };
      switch (message.type) {
        case 'failed': return { state: { ...state, scopes: undefined, pending: false, body: undefined, selected: undefined, items: undefined, confirm: undefined, notice: message.message } };
        case 'notice': return { state: { ...state, pending: false, body: undefined, selected: undefined, items: undefined, confirm: undefined, notice: message.notice } };
        case 'scopes': return { state: { ...state, scopes: message.scopes, sessionOwner: message.sessionOwner, owner: undefined, items: undefined, selected: undefined, body: undefined, pending: false, confirm: undefined, offset: 0 } };
        case 'items': return { state: { ...state, owner: message.owner, items: message.items, selected: undefined, body: undefined, pending: false, confirm: undefined, offset: 0 } };
        case 'body': return { state: { ...state, selected: message.ref, body: message.body, input: createTextAreaState({ value: '' }), pending: false, confirm: undefined, offset: 0 } };
        case 'edit': return state.pending ? { state } : { state: { ...state, input: textAreaReducer(state.input, message.transition).state } };
        case 'cancel-confirmation': return { state: { ...state, confirm: undefined } };
        default: break;
      }
      if (state.pending) return { state };
      switch (message.type) {
        case 'refresh':
        case 'back':
        case 'next': {
          const owner = message.type === 'back' ? undefined : state.owner;
          const cursor = message.type === 'next' ? (owner ? state.items?.cursor : state.scopes?.cursor) : undefined;
          return { state: { ...state, pending: true, body: undefined, selected: undefined, notice: undefined, confirm: undefined }, effects: [load(owner, cursor)] };
        }
        case 'choose': return { state: { ...state, pending: true, notice: undefined }, effects: [load(message.owner)] };
        case 'read': return { state: { ...state, pending: true, notice: undefined }, effects: [effect(async () => ({ type: 'body', ref: message.ref, body: await service().read(message.ref, { maxBytes: 64 * 1024 }) }))] };
        case 'prepare': return state.selected === undefined ? { state } : { state: { ...state, confirm: message.action } };
        case 'correct': {
          if (state.selected === undefined) return { state };
          const correction = textDocumentText(state.input.document);
          if (!correction.trim()) return { state: { ...state, notice: 'Enter the correction you want recorded.' } };
          const ref = state.selected;
          return { state: { ...state, pending: true, confirm: undefined }, effects: [effect(async () => {
            service();
            const result = await operations.submitMaterialCorrection(ref, correction, sessionId);
            if (result !== null && typeof result === 'object' && 'kind' in result && result.kind === 'rejected')
              throw new Error('The correction was not accepted. Check the current session configuration.');
            return { type: 'notice', notice: 'Correction submitted as user input. The retained revision is unchanged until a conditional update is recorded. Refresh to inspect its result.' };
          })] };
        }
        case 'confirm': {
          if (state.selected === undefined || state.confirm === undefined || state.items === undefined) return { state };
          const ref = state.selected, action = state.confirm, items = state.items;
          return { state: { ...state, pending: true, confirm: undefined, body: undefined, selected: undefined, items: undefined }, effects: [effect(async () => {
            const materials = service();
            await materials.revoke({ owner: ref.owner, expectedRevision: items.revocationRevision,
              operationId: crypto.randomUUID(), refs: [{ itemId: ref.itemId, revisionId: ref.revisionId }] });
            if (action === 'revoke') {
              return { type: 'notice', notice: 'Future use of this exact revision is revoked. Historical records and previous remote deliveries have not been erased.' };
            }
            try {
              const receipt = await materials.erase([ref]);
              return { type: 'notice', notice: `Future use of this exact revision is revoked. Local erasure coverage: ${JSON.stringify(receipt)}\nThis does not erase previous provider deliveries or establish semantic unlearning.` };
            } catch (error) {
              return { type: 'notice', notice: `Future use of this exact revision is revoked. Local erasure was not completed: ${error instanceof Error ? error.message : String(error)}\nHistorical records and previous remote deliveries may remain. Revocation is not erasure.` };
            }
          })] };
        }
      }
    },
    view: (state, context) => materialView(state,
      Math.max(5, Math.min(96, context.terminalSize.columns - 4)),
      Math.max(4, Math.min(32, context.terminalSize.rows - 4)))
  };
}

function materialView(state: MaterialPanelState, width: number, height: number): Element<MaterialPanelMessage> {
  const content: Element<MaterialPanelMessage>[] = [text({ content: state.pending ? 'Loading retained material…' : state.notice ?? 'Inspect exact retained revisions, submit corrections, or revoke future use. Saved material does not grant permission.' })];
  if (state.owner === undefined) {
    const owner = state.sessionOwner;
    if (owner !== undefined) content.push(button<MaterialPanelMessage>({ id: 'material-current-session', label: 'Current session material',
      disabled: state.pending, onPress: () => ({ type: 'choose', owner }) }));
    for (const grant of state.scopes?.items ?? []) content.push(button<MaterialPanelMessage>({
      id: `material-scope:${JSON.stringify(grant.owner)}`, label: `${JSON.stringify(grant.owner)} · ${grant.read ? 'read' : 'unavailable'}${grant.write ? ' · write' : ''}`,
      disabled: state.pending || !grant.read, onPress: () => ({ type: 'choose', owner: grant.owner })
    }));
    if (state.scopes?.items.length === 0) content.push(text({ content: 'No shared material scopes are currently granted.' }));
  } else {
    content.push(text({ content: `Owner: ${JSON.stringify(state.owner)}` }));
    for (const item of state.items?.items ?? []) content.push(button<MaterialPanelMessage>({
      id: `material-item:${item.itemId}:${item.revisionId}`, label: `${item.itemId} @ ${item.revisionId} · ${item.preview ?? '(no preview)'}`,
      disabled: state.pending, onPress: () => ({ type: 'read', ref: { owner: item.owner, itemId: item.itemId, revisionId: item.revisionId } })
    }));
    if (state.items?.items.length === 0) content.push(text({ content: 'No available material in this bounded inventory.' }));
  }
  if (state.body !== undefined && state.selected !== undefined) {
    content.push(text({ content: `Exact revision: ${state.selected.revisionId}\n${JSON.stringify(state.body, null, 2)}` }));
    content.push(textArea<MaterialPanelMessage>({ id: 'material-correction', meta: { accessibleName: 'Correction to the inspected retained material' }, state: state.input,
      readOnly: state.pending, onTransition: (transition: TextAreaTransition): MaterialPanelMessage => ({ type: 'edit', transition }) }));
    content.push(flow([
      button<MaterialPanelMessage>({ id: 'material-correct', label: 'Submit correction', disabled: state.pending, onPress: () => ({ type: 'correct' }) }),
      button<MaterialPanelMessage>({ id: 'material-revoke', label: 'Revoke future use', disabled: state.pending, onPress: () => ({ type: 'prepare', action: 'revoke' }) }),
      button<MaterialPanelMessage>({ id: 'material-erase', label: 'Revoke and request local erasure', disabled: state.pending, onPress: () => ({ type: 'prepare', action: 'erase' }) })
    ], { direction: 'horizontal' }));
  }
  if (state.confirm !== undefined) content.push(text({ content: state.confirm === 'revoke'
    ? 'Revoke this exact revision from future requests? Original history and previous deliveries remain.'
    : 'Revoke future use of this exact revision, then request local erasure? Revocation will remain in effect even if erasure is unsupported or fails. The receipt will disclose storage coverage. Previous remote delivery is not erased.' }), flow([
      button<MaterialPanelMessage>({ id: 'material-confirm', label: 'Confirm', disabled: state.pending, onPress: () => ({ type: 'confirm' }) }),
      button<MaterialPanelMessage>({ id: 'material-cancel', label: 'Cancel', onPress: () => ({ type: 'cancel-confirmation' }) })
    ], { direction: 'horizontal' }));
  const cursor = state.owner === undefined ? state.scopes?.cursor : state.items?.cursor;
  return panel({ id: 'material-panel', title: 'Retained material', width, height, onClose: () => ({ type: 'close' }), slots: {
    content: viewport(column(content), { id: 'material-viewport', offset: { row: state.offset }, scrollbar: { axis: 'vertical', visible: 'auto' }, onScroll: event => ({ type: 'scroll', offset: event.nextState.offsetRow }) }),
    actions: flow([
      button<MaterialPanelMessage>({ id: 'material-scopes', label: 'Scopes', disabled: state.pending || state.owner === undefined, onPress: () => ({ type: 'back' }) }),
      button<MaterialPanelMessage>({ id: 'material-next', label: 'Next page', disabled: state.pending || cursor === undefined, onPress: () => ({ type: 'next' }) }),
      button<MaterialPanelMessage>({ id: 'material-refresh', label: 'Refresh', disabled: state.pending, onPress: () => ({ type: 'refresh' }) })
    ], { direction: 'horizontal' })
  } });
}
