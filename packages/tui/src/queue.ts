import type {
  SessionPendingSubmission,
  SessionQueuedSubmissionChange,
  SessionSubmissionInput
} from '@agent-core/runtime';
import {
  createTextAreaState,
  textAreaReducer,
  type TextAreaState,
  type TextAreaTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, textArea, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { textCaretAt, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiEffect, TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import { diagnosticMessage } from './diagnostics.js';
import { panel } from './panel.js';

export interface QueueOperations {
  readPendingSubmissions(): Promise<readonly SessionPendingSubmission[]>;
  updateQueuedSubmission(id: string, change: SessionQueuedSubmissionChange): Promise<void>;
}
export type QueueState = { readonly id: string; readonly sessionId: string; readonly offset: number } & (
  | { readonly stage: 'loading' }
  | { readonly stage: 'list'; readonly submissions: readonly SessionPendingSubmission[] }
  | {
      readonly stage: 'editing' | 'saving';
      readonly submission: SessionPendingSubmission;
      readonly input: TextAreaState;
      readonly error?: string;
    }
  | { readonly stage: 'failed'; readonly error: string }
);
export type QueueMessage =
  | { readonly type: 'queue.refresh' }
  | {
      readonly type: 'queue.loaded';
      readonly id: string;
      readonly submissions: readonly SessionPendingSubmission[];
    }
  | {
      readonly type: 'queue.failed';
      readonly operation: 'read' | 'change';
      readonly id: string;
      readonly error: string;
    }
  | { readonly type: 'queue.select'; readonly submissionId: string }
  | { readonly type: 'queue.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'queue.save' | 'queue.cancel' | 'queue.withdraw' }
  | {
      readonly type: 'queue.withdrawn';
      readonly id: string;
      readonly sessionId: string;
      readonly input: SessionSubmissionInput;
    }
  | { readonly type: 'queue.scroll'; readonly offset: number };
export function createQueue(
  operations: QueueOperations,
  sessionId: string
): TuiUpdateResult<QueueState, QueueMessage> {
  const state: QueueState = { id: crypto.randomUUID(), sessionId, offset: 0, stage: 'loading' };
  return { state, effects: [load(state.id, operations)] };
}
export function updateQueue(
  state: QueueState,
  message: QueueMessage,
  operations: QueueOperations
): TuiUpdateResult<QueueState, QueueMessage> {
  if ('id' in message && message.id !== state.id) return { state };
  switch (message.type) {
    case 'queue.refresh':
      if (state.stage === 'saving') return { state };
      return {
        state: { id: state.id, sessionId: state.sessionId, stage: 'loading', offset: 0 },
        effects: [load(state.id, operations)]
      };
    case 'queue.loaded':
      return {
        state: {
          id: state.id,
          sessionId: state.sessionId,
          stage: 'list',
          offset: 0,
          submissions: message.submissions
        }
      };
    case 'queue.failed':
      return {
        state:
          state.stage === 'saving'
            ? { ...state, stage: 'editing', error: message.error }
            : { id: state.id, sessionId: state.sessionId, stage: 'failed', error: message.error, offset: 0 }
      };
    case 'queue.scroll':
      return { state: { ...state, offset: message.offset } };
    case 'queue.select': {
      if (state.stage !== 'list') return { state };
      const submission = state.submissions.find((entry) => entry.submissionId === message.submissionId);
      if (submission?.state !== 'queued') return { state };
      return {
        state: {
          id: state.id,
          sessionId: state.sessionId,
          stage: 'editing',
          offset: 0,
          submission,
          input: createTextAreaState({
            value: submission.input.task,
            caret: textCaretAt(submission.input.task.length)
          })
        },
        focus: { kind: 'element', elementId: 'queue-input' }
      };
    }
    case 'queue.edit':
      return state.stage !== 'editing'
        ? { state }
        : { state: { ...state, input: textAreaReducer(state.input, message.transition).state } };
    case 'queue.save':
    case 'queue.cancel':
    case 'queue.withdraw': {
      if (state.stage !== 'editing') return { state };
      const submission = state.submission;
      const task = textDocumentText(state.input.document);
      if (message.type === 'queue.save' && task.trim().length === 0)
        return { state: { ...state, error: 'Queued input cannot be empty.' } };
      return {
        state: { ...state, stage: 'saving' },
        effects: [
          {
            id: 'queue-change',
            concurrency: 'keep-first',
            async run() {
              await operations.updateQueuedSubmission(
                submission.submissionId,
                message.type === 'queue.save'
                  ? {
                      kind: 'replace',
                      expectedInput: submission.input,
                      input: { ...submission.input, task }
                    }
                  : { kind: 'cancel', expectedInput: submission.input }
              );
              return {
                kind: 'message',
                message:
                  message.type === 'queue.withdraw'
                    ? {
                        type: 'queue.withdrawn',
                        id: state.id,
                        sessionId: state.sessionId,
                        input: { ...submission.input, task }
                      }
                    : {
                        type: 'queue.loaded',
                        id: state.id,
                        submissions: await operations.readPendingSubmissions()
                      }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'queue.failed',
                operation: 'change',
                id: state.id,
                error: diagnosticMessage(diagnostic)
              }
            })
          }
        ]
      };
    }
    case 'queue.withdrawn':
      return { state };
  }
}
export function queueView(
  state: QueueState,
  width: number,
  height: number
): Element<QueueMessage | { readonly type: 'overlay.close' }> {
  type Message = QueueMessage | { readonly type: 'overlay.close' };
  let content: Element<Message>;
  if (state.stage === 'loading') content = text({ content: 'Loading accepted inputs…' });
  else if (state.stage === 'failed') content = text({ content: state.error });
  else if (state.stage === 'list')
    content = column([
      text({
        content:
          state.submissions.length === 0
            ? 'No pending inputs.'
            : 'Queued inputs can be revised or cancelled until the runner claims them.'
      }),
      ...state.submissions.map((submission) =>
        button<Message>({
          id: `queued:${submission.submissionId}`,
          label: `${submission.state} · ${submission.input.task}`,
          ...(submission.state !== 'queued'
            ? { disabled: true }
            : { onPress: (): Message => ({ type: 'queue.select', submissionId: submission.submissionId }) })
        })
      )
    ]);
  else
    content = column(
      [
        text({
          content:
            state.error ??
            `${state.submission.state} · ${String(state.submission.input.images?.length ?? 0)} images · ${String(state.submission.input.contextItems?.length ?? 0)} references`
        }),
        textArea<Message>({
          id: 'queue-input',
          meta: { accessibleName: 'Queued input text' },
          state: state.input,
          readOnly: state.stage === 'saving',
          onTransition: (transition: TextAreaTransition): Message => ({ type: 'queue.edit', transition })
        }),
        flow(
          [
            button<Message>({
              id: 'queue-save',
              label: 'Save',
              ...(state.stage === 'saving'
                ? { disabled: true }
                : { onPress: (): Message => ({ type: 'queue.save' }) })
            }),
            button<Message>({
              id: 'queue-cancel',
              label: 'Cancel input',
              ...(state.stage === 'saving'
                ? { disabled: true }
                : { onPress: (): Message => ({ type: 'queue.cancel' }) })
            }),
            button<Message>({
              id: 'queue-withdraw',
              label: 'Return to draft',
              ...(state.stage === 'saving'
                ? { disabled: true }
                : { onPress: (): Message => ({ type: 'queue.withdraw' }) })
            })
          ],
          { direction: 'horizontal' }
        )
      ],
      { sizes: [{ kind: 'content' }, { kind: 'fill', weight: 1 }, { kind: 'content' }] }
    );
  return panel({
    id: 'queue-panel',
    title: 'Pending inputs',
    width,
    height,
    onClose: () => ({ type: 'overlay.close' }),
    slots: {
      content: viewport(content, {
        id: 'queue-viewport',
        offset: { row: state.offset },
        scrollbar: { axis: 'vertical', visible: 'auto' },
        onScroll: (request) => ({ type: 'queue.scroll', offset: request.nextState.offsetRow })
      }),
      actions: button({
        id: 'queue-refresh',
        label: 'Refresh',
        ...(state.stage === 'saving'
          ? { disabled: true }
          : { onPress: (): Message => ({ type: 'queue.refresh' }) })
      })
    }
  });
}
function load(id: string, operations: QueueOperations): TuiEffect<QueueMessage> {
  return {
    id: 'queue-load',
    concurrency: 'replace',
    async run({ signal }) {
      const submissions = await operations.readPendingSubmissions();
      signal.throwIfAborted();
      return { kind: 'message', message: { type: 'queue.loaded', id, submissions } };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'queue.failed', operation: 'read', id, error: diagnosticMessage(diagnostic) }
    })
  };
}
