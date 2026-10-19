import type { CollaborationCoordinator, CollaborationParticipantPage, ParticipantSummary } from '@agent-core/runtime';
import { createTextAreaState, textAreaReducer, type TextAreaState, type TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, textArea, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiChildDefinition, TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { diagnosticMessage } from './diagnostics.js';
import { panel } from './panel.js';

export interface CollaborationOperations {
  readCollaboration(input?: Parameters<CollaborationCoordinator['inspectParticipants']>[0]): ReturnType<CollaborationCoordinator['inspectParticipants']>;
  sendParticipantInput(input: Parameters<CollaborationCoordinator['sendUserInput']>[0]): ReturnType<CollaborationCoordinator['sendUserInput']>;
  continueParticipant(input: Parameters<CollaborationCoordinator['continueUserInput']>[0]): ReturnType<CollaborationCoordinator['continueUserInput']>;
  interruptParticipant(input: Parameters<CollaborationCoordinator['interrupt']>[0]): ReturnType<CollaborationCoordinator['interrupt']>;
  cancelParticipant(input: Parameters<CollaborationCoordinator['cancel']>[0]): ReturnType<CollaborationCoordinator['cancel']>;
  waitForParticipants(input: Parameters<CollaborationCoordinator['wait']>[0]): ReturnType<CollaborationCoordinator['wait']>;
}

/** A bounded rendering snapshot; all execution and control truth remains in the coordinator. */
export interface CollaborationPanelState {
  readonly sessionId: string;
  readonly snapshot?: CollaborationParticipantPage;
  readonly selectedId?: string;
  readonly input: TextAreaState;
  readonly pending: boolean;
  readonly refreshRequested?: boolean;
  readonly offset: number;
  readonly pageOffset: number;
  readonly error?: string;
}
export type CollaborationPanelMessage =
  | { readonly type: 'close' | 'refresh' }
  | { readonly type: 'page'; readonly offset: number }
  | { readonly type: 'loaded'; readonly snapshot: CollaborationParticipantPage }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'select'; readonly participantId: string }
  | { readonly type: 'edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'control'; readonly action: 'send' | 'continue' | 'interrupt' | 'cancel' | 'wait' }
  | { readonly type: 'scroll'; readonly offset: number };

export function collaborationPanel(operations: CollaborationOperations, sessionId: string):
  TuiChildDefinition<CollaborationPanelState, CollaborationPanelMessage, 'close'> {
  const load = (offset = 0): TuiEffect<CollaborationPanelMessage> => ({
    id: 'collaboration-load', concurrency: 'replace',
    async run({ signal }) {
      const snapshot = await operations.readCollaboration({ offset });
      signal.throwIfAborted();
      if (snapshot.supervisorSessionId !== sessionId) throw new Error('The selected session changed. Reopen collaboration.');
      return { kind: 'message', message: { type: 'loaded', snapshot } };
    },
    onError: ({ diagnostic }) => ({ kind: 'message', message: { type: 'failed', message: diagnosticMessage(diagnostic) } })
  });
  return {
    init: () => ({
      state: { sessionId, input: createTextAreaState({ value: '' }), pending: true, offset: 0, pageOffset: 0 },
      effects: [load()]
    }),
    update(state, message) {
      switch (message.type) {
        case 'close': return { state, outputs: ['close'] };
        case 'scroll': return { state: { ...state, offset: message.offset } };
        case 'edit': return state.pending ? { state } : { state: { ...state, input: textAreaReducer(state.input, message.transition).state } };
        case 'select': return { state: { ...state, selectedId: message.participantId, offset: 0, input: createTextAreaState({ value: '' }) } };
        case 'failed': return { state: { ...state, pending: false, error: message.message } };
        case 'loaded': {
          if (message.snapshot.supervisorSessionId !== state.sessionId) return { state };
          const current = { ...state };
          delete current.error;
          delete current.refreshRequested;
          return { state: { ...current, snapshot: message.snapshot, pending: state.refreshRequested === true },
            ...(state.refreshRequested === true ? { effects: [load(state.pageOffset)] } : {}) };
        }
        case 'page': return state.pending ? { state } : { state: { ...state, pageOffset: message.offset, pending: true }, effects: [load(message.offset)] };
        case 'refresh': return state.pending ? { state: { ...state, refreshRequested: true } } : { state: { ...state, pending: true }, effects: [load(state.pageOffset)] };
        case 'control': {
          const snapshot = state.snapshot;
          const selected = snapshot?.participants.find(item => item.participant.participantId === state.selectedId);
          if (state.pending || snapshot === undefined || selected === undefined) return { state };
          const task = textDocumentText(state.input.document);
          if ((message.action === 'send' || message.action === 'continue') && !task.trim())
            return { state: { ...state, error: 'Enter an instruction for the selected participant.' } };
          const target = {
            participantId: selected.participant.participantId,
            sessionId: selected.participant.sessionId,
            expectedRunId: selected.assignment.runId,
            expectedEpoch: snapshot.epoch
          };
          const operationId = crypto.randomUUID();
          return {
            state: { ...state, pending: true },
            effects: [{
              id: 'collaboration-control', concurrency: 'keep-first',
              async run({ signal }) {
                switch (message.action) {
                  case 'send': {
                    const result = await operations.sendParticipantInput({ ...target, task });
                    if (result.kind === 'rejected') throw new Error(`Input rejected: ${result.reason}`);
                    void result.completion.catch(() => undefined);
                    break;
                  }
                  case 'continue': await operations.continueParticipant({ ...target, operationId, task }); break;
                  case 'interrupt':
                  case 'cancel': {
                    const input = {
                      operationId, participantId: target.participantId,
                      expectedSessionId: target.sessionId, expectedRunId: target.expectedRunId,
                      expectedEpoch: target.expectedEpoch, reason: 'Requested by the user.'
                    };
                    if (message.action === 'interrupt') await operations.interruptParticipant(input);
                    else await operations.cancelParticipant({ ...input, cascade: false });
                    break;
                  }
                  case 'wait': await operations.waitForParticipants({ participantIds: [target.participantId], timeoutMs: snapshot.maxWaitMs, signal }); break;
                }
                const next = await operations.readCollaboration({ offset: state.pageOffset });
                signal.throwIfAborted();
                return { kind: 'message', message: { type: 'loaded', snapshot: next } };
              },
              onError: ({ diagnostic }) => ({ kind: 'message', message: { type: 'failed', message: diagnosticMessage(diagnostic) } })
            }]
          };
        }
      }
    },
    view: (state, context) => collaborationView(state,
      Math.max(5, Math.min(96, context.terminalSize.columns - 4)),
      Math.max(4, Math.min(30, context.terminalSize.rows - 4)))
  };
}

function collaborationView(state: CollaborationPanelState, width: number, height: number): Element<CollaborationPanelMessage> {
  const snapshot = state.snapshot;
  const selected = snapshot?.participants.find(item => item.participant.participantId === state.selectedId);
  const content: Element<CollaborationPanelMessage>[] = [text({ content: state.error ?? (state.pending ? 'Refreshing collaboration…' : 'Select a participant to inspect its recorded assignment and control its exact session and run.') })];
  if (snapshot !== undefined) {
    content.push(text({ content: `Epoch ${String(snapshot.epoch)} · ${String(snapshot.total)}/${String(snapshot.maxParticipants)} participants · ${String(snapshot.maxConcurrentRuns)} concurrent runs` }));
    if (snapshot.coverage === 'partial') content.push(text({ content: `Showing ${String(state.pageOffset + 1)}–${String(state.pageOffset + snapshot.participants.length)} of ${String(snapshot.total)}` }));
    if (snapshot.participants.length === 0) content.push(text({ content: 'No participants. The agent can start bounded collaboration when useful.' }));
    for (const participant of snapshot.participants) content.push(button<CollaborationPanelMessage>({
      id: `participant:${participant.participant.participantId}`,
      label: `${participant.participant.participantId} · ${participant.cancelled ? 'cancelled' : participant.phase} · ${participant.assignment.task.slice(0, 160)}`,
      disabled: state.pending,
      onPress: () => ({ type: 'select', participantId: participant.participant.participantId })
    }));
  }
  if (selected !== undefined) {
    content.push(text({ content: participantDetail(selected) }));
    content.push(textArea<CollaborationPanelMessage>({
      id: 'participant-input', meta: { accessibleName: 'User instruction for selected participant' },
      state: state.input, readOnly: state.pending,
      onTransition: (transition: TextAreaTransition): CollaborationPanelMessage => ({ type: 'edit', transition })
    }));
    content.push(flow([
      control('Send steering', 'send', selected.phase !== 'running' || selected.cancelled),
      control('Continue', 'continue', (selected.phase !== 'ended' && selected.phase !== 'cancelled') || selected.cancelled),
      control('Interrupt', 'interrupt', selected.phase === 'ended' || selected.phase === 'cancelled' || selected.cancelled),
      control('Cancel participant', 'cancel', selected.cancelled),
      control('Wait', 'wait', selected.phase === 'ended' || selected.phase === 'suspended' || selected.phase === 'cancelled')
    ], { direction: 'horizontal' }));
  }
  function control(label: string, action: Extract<CollaborationPanelMessage, { type: 'control' }>['action'], disabled: boolean): Element<CollaborationPanelMessage> {
    return button<CollaborationPanelMessage>({ id: `participant-${action}`, label, disabled: state.pending || disabled, onPress: () => ({ type: 'control', action }) });
  }
  return panel({
    id: 'collaboration-panel', title: 'Collaboration', width, height, onClose: () => ({ type: 'close' }),
    slots: {
      content: viewport(column(content), { id: 'collaboration-viewport', offset: { row: state.offset }, scrollbar: { axis: 'vertical', visible: 'auto' }, onScroll: request => ({ type: 'scroll', offset: request.nextState.offsetRow }) }),
      actions: flow([
        button<CollaborationPanelMessage>({ id: 'collaboration-first', label: 'First', disabled: state.pending || state.pageOffset === 0, onPress: () => ({ type: 'page', offset: 0 }) }),
        button<CollaborationPanelMessage>({ id: 'collaboration-next', label: 'Next', disabled: state.pending || snapshot?.nextOffset == null, onPress: () => ({ type: 'page', offset: snapshot?.nextOffset ?? 0 }) }),
        button<CollaborationPanelMessage>({ id: 'collaboration-refresh', label: 'Refresh', disabled: state.pending, onPress: () => ({ type: 'refresh' }) })
      ], { direction: 'horizontal' })
    }
  });
}

function participantDetail(view: ParticipantSummary): string {
  return [
    `Participant: ${view.participant.participantId}`,
    `Session: ${view.participant.sessionId}`,
    `Run: ${view.assignment.runId}`,
    `Assignment: ${view.assignment.assignmentId} revision ${String(view.assignment.revision)}`,
    `State: ${view.cancelled ? 'cancelled' : view.phase} · epoch ${String(view.assignment.epoch)}`,
    `Budget owner: ${view.assignment.budgetOwnerId} · scope: ${view.assignment.budgetScopeId}`,
    `Task: ${view.assignment.task}${view.taskTruncated ? '\n[Task preview truncated; inspect the participant session history for the original.]' : ''}`,
    `Recorded results (${String(view.results.length)}/${String(view.resultCount)}): ${view.results.map(result => `${result.kind}:${result.resultId}`).join(', ') || 'none'}`,
    'Instructions sent here are user steering. Participant contributions remain peer input.'
  ].join('\n');
}
