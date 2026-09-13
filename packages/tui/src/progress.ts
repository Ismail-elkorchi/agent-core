import type { ModelUsage } from '@agent-core/model';
import type { AgentProgressEvent, AgentRunBudgetState } from '@agent-core/runtime';
import type { StatusField } from './preferences.js';

export function reasoningLabel(
  reasoning: import('@agent-core/model').ModelReasoningRequest | undefined
): string | undefined {
  if (reasoning === undefined) return undefined;
  const label =
    reasoning.strategy === 'effort'
      ? `${reasoning.effort}${reasoning.mode === undefined ? '' : ` · ${reasoning.mode}`}`
      : reasoning.strategy === 'budget'
        ? `${String(reasoning.maxTokens)} reasoning tokens`
        : reasoning.strategy;
  return reasoning.strategy === 'disabled' || reasoning.summary === undefined
    ? label
    : `${label} · ${reasoning.summary} summary`;
}

export interface ProgressPresentation {
  readonly label: string;
  readonly budget?: AgentRunBudgetState;
  readonly request?: Extract<AgentProgressEvent, { readonly type: 'model.requested' }>;
  readonly usage?: ModelUsage;
}
export function presentProgress(
  state: ProgressPresentation,
  event: AgentProgressEvent
): ProgressPresentation {
  switch (event.type) {
    case 'run.configured':
      return { label: 'Assembling request' };
    case 'turn.started':
      return { ...state, label: 'Assembling request' };
    case 'assistant.started':
      return { ...state, label: 'Assembling request' };
    case 'model.requested':
      return { ...state, label: 'Requesting response', request: event };
    case 'assistant.delta':
      return { ...state, label: 'Responding' };
    case 'assistant.reasoning':
      return { ...state, label: 'Reasoning' };
    case 'assistant.status':
      return { ...state, label: event.message };
    case 'tool.call.received':
      return { ...state, label: 'Planning tool' };
    case 'tool.started':
      return { ...state, label: 'Running tool' };
    case 'tool.updated':
      return { ...state, label: event.progress.type === 'status' ? event.progress.message ?? event.progress.stage : 'Running tool' };
    case 'tool.ended':
    case 'assistant.ended':
      return { ...state, label: 'Working' };
    case 'run.phase.changed':
      return { ...state, budget: event.budget };
    case 'run.ended':
      return { ...state, label: event.terminal.executionStatus, budget: event.terminal.budget };
    case 'budget.provider_usage.recorded':
      return { ...state, usage: event.usage };
    case 'assistant.interrupted':
    case 'model.failed':
      return { ...state, label: 'Response interrupted' };
    default:
      return state;
  }
}
export function progressStatusFields(state: ProgressPresentation): readonly StatusField[] {
  const request = state.request;
  const usage = state.usage;
  const budget = state.budget;
  return [
    {
      id: 'context',
      label: 'Latest admitted request (estimated input / context window)',
      ...(request === undefined
        ? {}
        : {
            value:
              `≈${String(request.estimate.totalPromptTokens)}` +
              (request.contextWindowTokens === undefined ? '' : ` / ${String(request.contextWindowTokens)}`)
          })
    },
    {
      id: 'usage',
      label: 'Latest provider response tokens',
      ...(usage?.totalTokens === undefined ? {} : { value: `${String(usage.totalTokens)} response tokens` })
    },
    {
      id: 'elapsed',
      label: 'Recorded run elapsed time',
      ...(budget === undefined ? {} : { value: `${String(Math.floor(budget.elapsedMs / 1000))}s` })
    },
    {
      id: 'cost',
      label: 'Known run cost',
      ...(budget === undefined || Object.keys(budget.knownCosts).length === 0
        ? {}
        : {
            value: `${Object.entries(budget.knownCosts)
              .map(([currency, amount]) => `${currency} ${amount.toFixed(4)}`)
              .join(' + ')}${budget.pricingStatus === 'known' ? '' : ' (partial)'}`
          })
    }
  ];
}
