import type { AgentRunBudgetState, AgentRunIdentity, AgentRunPhase, AgentTerminalSnapshot } from './contracts.js';

interface RunStateBase extends AgentRunIdentity { readonly budget: AgentRunBudgetState }
export interface PreparingRunState extends RunStateBase { readonly phase: 'preparing' }
export interface RequestingModelRunState extends RunStateBase { readonly phase: 'requesting_model'; readonly turnId: string; readonly requestAttempt: number }
export interface ExecutingToolsRunState extends RunStateBase { readonly phase: 'executing_tools'; readonly turnId: string; readonly requestAttempt: number; readonly toolBatchId: string }
export interface WaitingForApprovalRunState extends RunStateBase { readonly phase: 'waiting_for_approval'; readonly turnId: string; readonly requestAttempt: number; readonly toolBatchId: string; readonly approvalIds: readonly string[] }
export interface VerifyingRunState extends RunStateBase { readonly phase: 'verifying' }
export interface FinalizingRunState extends RunStateBase { readonly phase: 'finalizing' }
export interface EndedRunState extends RunStateBase { readonly phase: 'ended'; readonly terminal: AgentTerminalSnapshot }

export type AgentRunMachineState = PreparingRunState | RequestingModelRunState | ExecutingToolsRunState | WaitingForApprovalRunState | VerifyingRunState | FinalizingRunState | EndedRunState;
export type AgentRunMachineEvent =
  | { readonly type: 'model.request'; readonly turnId: string; readonly requestAttempt: number; readonly budget: AgentRunBudgetState }
  | { readonly type: 'tools.execute'; readonly turnId: string; readonly requestAttempt: number; readonly toolBatchId: string; readonly budget: AgentRunBudgetState }
  | { readonly type: 'approval.wait'; readonly approvalIds: readonly string[]; readonly budget: AgentRunBudgetState }
  | { readonly type: 'approval.resolved'; readonly budget: AgentRunBudgetState }
  | { readonly type: 'verification.start'; readonly budget: AgentRunBudgetState }
  | { readonly type: 'finalization.start'; readonly budget: AgentRunBudgetState }
  | { readonly type: 'finalization.committed'; readonly terminal: AgentTerminalSnapshot };

export class AgentRunTransitionError extends Error {
  constructor(readonly phase: AgentRunPhase, readonly eventType: AgentRunMachineEvent['type']) {
    super(`Illegal run transition: ${phase} + ${eventType}.`);
    this.name = 'AgentRunTransitionError';
  }
}

export function createAgentRunMachine(input: AgentRunIdentity & { readonly budget: AgentRunBudgetState }): PreparingRunState {
  return Object.freeze({ ...input, phase: 'preparing' });
}

/** Pure reducer that is the single authority for legal run phase changes. */
export function reduceAgentRun(state: AgentRunMachineState, event: AgentRunMachineEvent): AgentRunMachineState {
  const identity = { runId: state.runId, finalizationId: state.finalizationId };
  switch (state.phase) {
    case 'preparing':
      if (event.type === 'model.request') return freeze({ ...identity, phase: 'requesting_model', turnId: event.turnId, requestAttempt: event.requestAttempt, budget: event.budget });
      if (event.type === 'finalization.start') return freeze({ ...identity, phase: 'finalizing', budget: event.budget });
      break;
    case 'requesting_model':
      if (event.type === 'model.request') return freeze({ ...identity, phase: 'requesting_model', turnId: event.turnId, requestAttempt: event.requestAttempt, budget: event.budget });
      if (event.type === 'tools.execute') return freeze({ ...identity, phase: 'executing_tools', turnId: event.turnId, requestAttempt: event.requestAttempt, toolBatchId: event.toolBatchId, budget: event.budget });
      if (event.type === 'verification.start') return freeze({ ...identity, phase: 'verifying', budget: event.budget });
      if (event.type === 'finalization.start') return freeze({ ...identity, phase: 'finalizing', budget: event.budget });
      break;
    case 'executing_tools':
      if (event.type === 'approval.wait') return freeze({ ...identity, phase: 'waiting_for_approval', turnId: state.turnId, requestAttempt: state.requestAttempt, toolBatchId: state.toolBatchId, approvalIds: Object.freeze([...event.approvalIds]), budget: event.budget });
      if (event.type === 'model.request') return freeze({ ...identity, phase: 'requesting_model', turnId: event.turnId, requestAttempt: event.requestAttempt, budget: event.budget });
      if (event.type === 'finalization.start') return freeze({ ...identity, phase: 'finalizing', budget: event.budget });
      break;
    case 'waiting_for_approval':
      if (event.type === 'approval.resolved') return freeze({ ...identity, phase: 'executing_tools', turnId: state.turnId, requestAttempt: state.requestAttempt, toolBatchId: state.toolBatchId, budget: event.budget });
      if (event.type === 'finalization.start') return freeze({ ...identity, phase: 'finalizing', budget: event.budget });
      break;
    case 'verifying':
      if (event.type === 'finalization.start') return freeze({ ...identity, phase: 'finalizing', budget: event.budget });
      break;
    case 'finalizing':
      if (event.type === 'finalization.committed') return freeze({ ...identity, phase: 'ended', budget: event.terminal.budget, terminal: event.terminal });
      break;
    case 'ended':
      break;
    default:
      return assertNever(state);
  }
  throw new AgentRunTransitionError(state.phase, event.type);
}

function freeze<T extends AgentRunMachineState>(state: T): T { return Object.freeze(state); }
function assertNever(value: never): never { throw new Error(`Unhandled run state: ${JSON.stringify(value)}`); }
