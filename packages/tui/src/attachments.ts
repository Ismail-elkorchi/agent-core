import {
  createTextAreaState,
  textAreaReducer,
  type TextAreaState,
  type TextAreaTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, textArea } from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, row } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { diagnosticMessage } from './diagnostics.js';
import type { DraftAttachment } from './draft.js';
import { panel } from './panel.js';

export interface AttachmentOperations {
  readContext?(
    path: string,
    signal: AbortSignal
  ): Promise<import('@agent-core/runtime').PromptContextItemInput>;
  readImage?(
    path: string,
    signal: AbortSignal
  ): Promise<{
    readonly path: string;
    readonly image: Extract<DraftAttachment, { readonly kind: 'image' }>['image'];
  }>;
}
export interface AttachmentState {
  readonly id: string;
  readonly path: TextAreaState;
  readonly loading: boolean;
  readonly error?: string;
}
export type AttachmentMessage =
  | { readonly type: 'attachments.open' }
  | { readonly type: 'attachments.path'; readonly transition: TextAreaTransition }
  | { readonly type: 'attachments.add-image' | 'attachments.add-context' }
  | { readonly type: 'attachments.loaded'; readonly id: string; readonly attachment: DraftAttachment }
  | { readonly type: 'attachments.failed'; readonly id: string; readonly error: string }
  | { readonly type: 'attachments.inspect'; readonly id: string }
  | { readonly type: 'attachments.remove'; readonly id: string };
export function createAttachments(): AttachmentState {
  return { id: crypto.randomUUID(), path: createTextAreaState({ value: '' }), loading: false };
}
export function updateAttachments(
  state: AttachmentState,
  message: AttachmentMessage,
  operations: AttachmentOperations | undefined
): { readonly state: AttachmentState; readonly effects?: readonly TuiEffect<AttachmentMessage>[] } {
  switch (message.type) {
    case 'attachments.path':
      return { state: { ...state, path: textAreaReducer(state.path, message.transition).state } };
    case 'attachments.failed':
      return message.id !== state.id
        ? { state }
        : { state: { ...state, loading: false, error: message.error } };
    case 'attachments.add-image':
    case 'attachments.add-context': {
      if (state.loading) return { state };
      const path = textDocumentText(state.path.document);
      if (path.length === 0) return { state: { ...state, error: 'Choose a file path.' } };
      const read = attachmentReader(message.type, operations);
      if (read === undefined)
        return {
          state: {
            ...state,
            error:
              message.type === 'attachments.add-context'
                ? 'This application does not provide file snapshot acquisition.'
                : 'This application does not provide image acquisition.'
          }
        };
      return {
        state: { ...state, loading: true },
        effects: [
          {
            id: 'attachment-read',
            concurrency: 'replace',
            async run({ signal }) {
              const attachment = await read(path, signal);
              signal.throwIfAborted();
              return { kind: 'message', message: { type: 'attachments.loaded', id: state.id, attachment } };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: { type: 'attachments.failed', id: state.id, error: diagnosticMessage(diagnostic) }
            })
          }
        ]
      };
    }
    default:
      return { state };
  }
}
function attachmentReader(
  type: 'attachments.add-context' | 'attachments.add-image',
  operations: AttachmentOperations | undefined
): ((path: string, signal: AbortSignal) => Promise<DraftAttachment>) | undefined {
  if (type === 'attachments.add-context') {
    const read = operations?.readContext?.bind(operations);
    return read === undefined
      ? undefined
      : async (path, signal) => {
          const item = await read(path, signal);
          return { kind: 'context', id: crypto.randomUUID(), label: item.title, item };
        };
  }
  const read = operations?.readImage?.bind(operations);
  return read === undefined
    ? undefined
    : async (path, signal) => {
        const result = await read(path, signal);
        return { kind: 'image', id: crypto.randomUUID(), label: result.path, image: result.image };
      };
}
export function attachmentsView(
  state: AttachmentState,
  attachments: readonly DraftAttachment[],
  width: number,
  height: number
) {
  type Message = AttachmentMessage | { readonly type: 'overlay.close' };
  return panel<Message>({
    id: 'attachments-panel',
    title: 'Draft attachments',
    width,
    height,
    focusId: 'attachment-path',
    onClose: () => ({ type: 'overlay.close' }),
    slots: {
      content: column(
        [
          text({
            content:
              state.error ??
              (state.loading
                ? 'Reading and validating the attachment…'
                : 'Choose a file snapshot or an image from the allowed files. Only image-capable models accept images.')
          }),
          textArea<Message>({
            id: 'attachment-path',
            meta: { accessibleName: 'Attachment path' },
            state: state.path,
            placeholder: 'Path to a file',
            onTransition: (transition: TextAreaTransition): Message => ({
              type: 'attachments.path',
              transition
            })
          }),
          flow(
            ['image', 'context'].map((kind) =>
              button<Message>({
                id: `attachment-add:${kind}`,
                label: kind === 'image' ? 'Add image' : 'Add file',
                ...(state.loading
                  ? { disabled: true }
                  : {
                      onPress: (): Message => ({
                        type: kind === 'image' ? 'attachments.add-image' : 'attachments.add-context'
                      })
                    })
              })
            ),
            { direction: 'horizontal' }
          ),
          ...attachments.map((attachment) =>
            row(
              [
                text({
                  content:
                    attachment.kind === 'image'
                      ? `${attachment.label} · ${attachment.image.artifact.mediaType} · ${String(attachment.image.artifact.size)} bytes`
                      : `${attachment.label} · ${attachment.item.sourceUri} · ${attachment.item.representation}`
                }),
                button<Message>({
                  id: `inspect-attachment:${attachment.id}`,
                  label: 'Inspect',
                  onPress: () => ({ type: 'attachments.inspect', id: attachment.id })
                }),
                button<Message>({
                  id: `remove-attachment:${attachment.id}`,
                  label: 'Remove',
                  onPress: () => ({ type: 'attachments.remove', id: attachment.id })
                })
              ],
              { sizes: [{ kind: 'fill' }, { kind: 'content' }, { kind: 'content' }] }
            )
          )
        ],
        {
          sizes: [
            { kind: 'content' },
            { kind: 'fixed', cells: 3 },
            { kind: 'content' },
            ...attachments.map(() => ({ kind: 'content' as const }))
          ]
        }
      )
    }
  });
}
