import {
  createTextAreaState,
  textAreaReducer,
  type TextAreaState,
  type TextAreaTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, textArea } from '@ismail-elkorchi/terminal-ui/components';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { panel } from './panel.js';

export interface SessionNames {
  read(sessionId: string): Promise<string | undefined>;
  write(sessionId: string, name: string): Promise<void>;
}

export interface SessionNameState {
  readonly id: string;
  readonly loading: boolean;
  readonly sessionId: string;
  readonly input: TextAreaState;
  readonly saving: boolean;
  readonly error?: string;
}

export type SessionNameMessage =
  | { readonly type: 'session-name.open' }
  | { readonly type: 'session-name.loaded'; readonly id: string; readonly name?: string }
  | { readonly type: 'session-name.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'session-name.save' }
  | { readonly type: 'session-name.saved'; readonly id: string; readonly sessionId: string }
  | {
      readonly type: 'session-name.failed';
      readonly operation: 'read' | 'write';
      readonly id: string;
      readonly sessionId: string;
      readonly error: string;
    };

export function createSessionName(sessionId: string, name = ''): SessionNameState {
  return {
    id: crypto.randomUUID(),
    loading: true,
    sessionId,
    input: createTextAreaState({ value: name }),
    saving: false
  };
}

export function parseSessionName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
    throw new Error('Use a single line of at most 200 characters for the session name.');
  return value.trim();
}

export function updateSessionName(
  state: SessionNameState,
  message: SessionNameMessage,
  names: SessionNames
): {
  readonly state: SessionNameState;
  readonly effects?: readonly TuiEffect<SessionNameMessage>[];
} {
  switch (message.type) {
    case 'session-name.loaded':
      return message.id !== state.id
        ? { state }
        : {
            state: { ...state, loading: false, input: createTextAreaState({ value: message.name ?? '' }) }
          };
    case 'session-name.edit':
      return state.saving || state.loading
        ? { state }
        : { state: { ...state, input: textAreaReducer(state.input, message.transition).state } };
    case 'session-name.failed':
      return message.id !== state.id
        ? { state }
        : { state: { ...state, saving: false, loading: false, error: message.error } };
    case 'session-name.save':
      if (state.saving || state.loading) return { state };
      return {
        state: { ...state, saving: true },
        effects: [
          {
            id: 'session-name-save',
            concurrency: 'enqueue',
            async run() {
              await names.write(state.sessionId, parseSessionName(textDocumentText(state.input.document)));
              return {
                kind: 'message',
                message: { type: 'session-name.saved', id: state.id, sessionId: state.sessionId }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'session-name.failed',
                operation: 'write',
                id: state.id,
                sessionId: state.sessionId,
                error: diagnostic.message
              }
            })
          }
        ]
      };
    default:
      return { state };
  }
}

export function sessionNameView(state: SessionNameState, width: number, height: number) {
  type Message = SessionNameMessage | { readonly type: 'overlay.close' };
  return panel<Message>({
    id: 'session-name',
    title: 'Name this conversation',
    width,
    height,
    focusId: 'session-name-input',
    onClose: () => ({ type: 'overlay.close' }),
    slots: {
      content: column(
        [
          text({
            content:
              state.error ??
              (state.loading
                ? 'Reading the current name…'
                : `Session ${state.sessionId}\nAn empty name restores the default label. This changes display metadata only.`)
          }),
          textArea<Message>({
            id: 'session-name-input',
            state: state.input,
            readOnly: state.loading || state.saving,
            meta: { accessibleName: 'Conversation name' },
            onTransition: (transition: TextAreaTransition): Message => ({
              type: 'session-name.edit',
              transition
            })
          }),
          button<Message>({
            id: 'session-name-save',
            label: state.saving ? 'Saving…' : 'Save',
            ...(state.saving || state.loading
              ? { disabled: true }
              : { onPress: (): Message => ({ type: 'session-name.save' }) })
          })
        ],
        { sizes: [{ kind: 'content' }, { kind: 'fixed', cells: 3 }, { kind: 'content' }] }
      )
    }
  });
}

export function loadSessionName(
  state: SessionNameState,
  names: SessionNames
): TuiEffect<SessionNameMessage> {
  return {
    id: 'session-name-load',
    concurrency: 'replace',
    async run({ signal }) {
      const name = await names.read(state.sessionId);
      signal.throwIfAborted();
      return {
        kind: 'message',
        message: { type: 'session-name.loaded', id: state.id, ...(name === undefined ? {} : { name }) }
      };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: {
        type: 'session-name.failed',
        operation: 'read',
        id: state.id,
        sessionId: state.sessionId,
        error: diagnostic.message
      }
    })
  };
}
