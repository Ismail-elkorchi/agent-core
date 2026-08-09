import type { AgentEndedRunResult, AgentProgressEvent, AgentRunPhase } from '@agent-core/runtime';
import type { AgentTuiState } from './state.js';
import type { AgentTuiActivityEntry } from './conversation-model.js';
import { appendNotice, upsertActivity, upsertAssistant, upsertReasoning } from './conversation.js';
import {
  completedToolActivity,
  pendingToolActivity,
  runningToolActivity,
  toolActivityId,
  updatedToolActivity
} from './tool-presentation.js';
import { terminalPresentation } from './run-presentation.js';

type ProgressEventType = AgentProgressEvent['type'];
type ProgressEvent<K extends ProgressEventType> = Extract<AgentProgressEvent, { readonly type: K }>;

export function applyProgress(state: AgentTuiState, event: AgentProgressEvent): AgentTuiState {
  switch (event.type) {
    case 'turn.started': return reduceTurnStarted(state, event);
    case 'context.replay.restored': return reduceReplayRestored(state, event);
    case 'provider.state.restored': return reduceProviderStateRestored(state, event);
    case 'run.configured': return reduceRunConfigured(state, event);
    case 'run.phase.changed': return reducePhaseChanged(state, event);
    case 'context.history.reduced': return { ...state, debug: { ...state.debug, latestHistoryReduction: event } };
    case 'context.checkpoint.created': return { ...state, debug: { ...state.debug, latestCheckpoint: event } };
    case 'assistant.started': return upsertAssistant(withWorking(state, 'Thinking'), event.turnId, '', 'streaming');
    case 'assistant.delta': return upsertAssistant(withWorking(state, 'Responding'), event.turnId, event.accumulated, 'streaming');
    case 'assistant.reasoning': return reduceReasoning(state, event);
    case 'assistant.status': return withWorking(state, compact(event.message));
    case 'tool.call.received': return reduceToolCall(state, event);
    case 'assistant.ended': return upsertAssistant(withWorking(state, 'Working'), event.turnId, event.content, 'complete');
    case 'assistant.interrupted': return reduceAssistantInterrupted(state, event);
    case 'model.failed': return reduceModelFailed(state, event);
    case 'tool.started': return reduceToolStarted(state, event);
    case 'tool.updated': return reduceToolUpdated(state, event);
    case 'tool.ended': return reduceToolEnded(state, event);
    case 'check.ended': return reduceCheckEnded(state, event);
    case 'run.ended': return applyTerminal(state, event.terminal, event.deliveryDiagnostics);
  }
}

function reduceTurnStarted(state: AgentTuiState, event: ProgressEvent<'turn.started'>): AgentTuiState {
  return {
    ...withWorking(state, 'Preparing'),
    debug: {
      ...state.debug,
      runId: event.runId,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId })
    }
  };
}

function reduceReplayRestored(state: AgentTuiState, event: ProgressEvent<'context.replay.restored'>): AgentTuiState {
  return {
    ...state,
    debug: {
      ...state.debug,
      sessionId: event.sessionId,
      replay: event,
      ...(event.restoredProviderState === undefined ? {} : { providerState: event.restoredProviderState })
    }
  };
}

function reduceProviderStateRestored(state: AgentTuiState, event: ProgressEvent<'provider.state.restored'>): AgentTuiState {
  return { ...state, debug: { ...state.debug, providerState: event.state } };
}

function reduceRunConfigured(state: AgentTuiState, event: ProgressEvent<'run.configured'>): AgentTuiState {
  const reasoning = event.configuration.runtime.reasoning;
  return {
    ...state,
    runtimeDetails: {
      ...state.runtimeDetails,
      providerId: event.configuration.provider.id,
      modelId: event.configuration.model.id,
      ...(event.configuration.runtime.temperature === undefined ? {} : { temperature: event.configuration.runtime.temperature }),
      ...(reasoning?.strategy === 'effort' ? { reasoningEffort: reasoning.effort } : {})
    },
    debug: { ...state.debug, configuration: event.configuration }
  };
}

function reducePhaseChanged(state: AgentTuiState, event: ProgressEvent<'run.phase.changed'>): AgentTuiState {
  return {
    ...state,
    run: { kind: 'working', phase: event.phase, label: phaseLabel(event.phase) },
    debug: { ...state.debug, phase: event.phase, budget: event.budget }
  };
}

function reduceReasoning(state: AgentTuiState, event: ProgressEvent<'assistant.reasoning'>): AgentTuiState {
  if (state.runtimeDetails.showReasoning !== true || event.channel !== 'summary') return withWorking(state, 'Thinking');
  return upsertReasoning(withWorking(state, 'Thinking'), event.turnId, event.accumulated);
}

function reduceToolCall(state: AgentTuiState, event: ProgressEvent<'tool.call.received'>): AgentTuiState {
  return upsertActivity(
    withWorking(state, 'Preparing tool'),
    pendingToolActivity(toolActivityId(event), event.toolCall)
  );
}

function reduceAssistantInterrupted(state: AgentTuiState, event: ProgressEvent<'assistant.interrupted'>): AgentTuiState {
  let next = upsertAssistant(withWorking(state, 'Recovering'), event.turnId, event.content, 'interrupted');
  if (event.reasoningSummary !== undefined && state.runtimeDetails.showReasoning === true) {
    next = upsertReasoning(next, event.turnId, event.reasoningSummary);
  }
  if (event.diagnostic !== undefined) {
    next = appendNotice(next, diagnosticText(event.diagnostic), 'error');
  }
  return next;
}

function reduceModelFailed(state: AgentTuiState, event: ProgressEvent<'model.failed'>): AgentTuiState {
  return appendNotice(withWorking(state, 'Provider failed'), diagnosticText(event.diagnostic), 'error');
}

function reduceToolStarted(state: AgentTuiState, event: ProgressEvent<'tool.started'>): AgentTuiState {
  return upsertActivity(
    withWorking(state, 'Running tool'),
    runningToolActivity(toolActivityId(event), event.input, event.effects)
  );
}

function reduceToolUpdated(state: AgentTuiState, event: ProgressEvent<'tool.updated'>): AgentTuiState {
  const id = toolActivityId(event);
  const label = progressLabel(event.progress);
  return upsertActivity(
    withWorking(state, 'Running tool'),
    updatedToolActivity(activity(state, id), id, event.toolName, label)
  );
}

function progressLabel(progress: import('@agent-core/tools').ToolProgress): string {
  switch (progress.type) {
    case 'status': return progress.message ?? progress.stage;
    case 'output': return `${progress.stream}: ${progress.text}`;
    case 'patch': return `Patch: ${String(progress.changes.length)} change${progress.changes.length === 1 ? '' : 's'}`;
    case 'metric': return `${progress.name}: ${String(progress.value)}${progress.unit ? ` ${progress.unit}` : ''}`;
  }
}

function reduceToolEnded(state: AgentTuiState, event: ProgressEvent<'tool.ended'>): AgentTuiState {
  const id = toolActivityId(event);
  return upsertActivity(
    withWorking(state, event.observation.ok ? 'Working' : 'Tool failed'),
    completedToolActivity(activity(state, id), id, event.toolName, event.observation)
  );
}

function reduceCheckEnded(state: AgentTuiState, event: ProgressEvent<'check.ended'>): AgentTuiState {
  const status = event.result.verdict === 'passed'
    ? 'success'
    : event.result.verdict === 'failed' && event.result.requirement === 'required' ? 'failed' : 'warning';
  const details = [
    event.result.diagnostic?.message,
    event.result.output === undefined ? undefined : JSON.stringify(event.result.output, null, 2),
    event.result.artifacts === undefined || event.result.artifacts.length === 0
      ? undefined
      : `Artifacts\n${event.result.artifacts.map((artifact) => artifact.artifactId).join('\n')}`
  ].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n');
  return upsertActivity(state, {
    id: `check:${event.result.id}`,
    kind: 'activity',
    activity: 'check',
    label: `Check ${event.result.id}`,
    status,
    summary: compact(event.result.summary),
    ...(details.length === 0 ? {} : { details: details.length <= 6_000 ? details : `${details.slice(0, 5_999)}…` })
  });
}

export function applyResult(state: AgentTuiState, result: AgentEndedRunResult): AgentTuiState {
  return applyTerminal(state, result.terminal, result.deliveryDiagnostics);
}

export function applyFailure(state: AgentTuiState, message: string): AgentTuiState {
  return appendNotice({ ...state, run: { kind: 'failed', message } }, message, 'error');
}

function applyTerminal(
  state: AgentTuiState,
  terminal: AgentEndedRunResult['terminal'],
  deliveryDiagnostics: AgentEndedRunResult['deliveryDiagnostics']
): AgentTuiState {
  const presentation = terminalPresentation(terminal);
  let next: AgentTuiState = {
    ...state,
    run: { kind: 'ended', terminal },
    debug: {
      ...state.debug,
      phase: 'ended',
      budget: terminal.budget,
      terminal,
      deliveryDiagnostics
    }
  };
  if (presentation.message.trim().length > 0 && !hasVisibleMessage(next, presentation.message)) {
    next = terminal.candidate.status === 'absent'
      ? appendNotice(next, presentation.message, presentation.status === 'error' ? 'error' : 'warning')
      : upsertAssistant(next, `terminal:${terminal.finalizationId}`, presentation.message, 'complete');
  }
  if (presentation.status === 'warning' || presentation.status === 'error') {
    if (!hasVisibleMessage(next, presentation.headline)) {
      next = appendNotice(next, presentation.headline, presentation.status === 'error' ? 'error' : 'warning');
    }
  }
  return next;
}

function hasVisibleMessage(state: AgentTuiState, message: string): boolean {
  const normalized = message.trim();
  return state.conversation.items.some((item) =>
    (item.kind === 'assistant' || item.kind === 'notice') && item.text.trim() === normalized
  );
}

function activity(state: AgentTuiState, id: string): AgentTuiActivityEntry | undefined {
  return state.conversation.items.find((item): item is AgentTuiActivityEntry => item.id === id && item.kind === 'activity');
}

function withWorking(state: AgentTuiState, label: string): AgentTuiState {
  const phase = state.run.kind === 'working' ? state.run.phase : state.debug.phase;
  return { ...state, run: { kind: 'working', label, ...(phase === undefined ? {} : { phase }) } };
}

function phaseLabel(phase: AgentRunPhase): string {
  switch (phase) {
    case 'preparing': return 'Preparing';
    case 'requesting_model': return 'Thinking';
    case 'executing_tools': return 'Using tools';
    case 'waiting_for_approval': return 'Approval required';
    case 'verifying': return 'Verifying';
    case 'finalizing': return 'Finishing';
    case 'ended': return 'Completed';
  }
}

function compact(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function diagnosticText(diagnostic: ProgressEvent<'model.failed'>['diagnostic']): string {
  const cause = diagnostic.causeSummary === undefined ? '' : ` · ${JSON.stringify(diagnostic.causeSummary)}`;
  return `${diagnostic.provider} ${diagnostic.code}${cause}`;
}
