import type { ToolAuthorizationDecision, ToolEffects, ToolObservation } from '@agent-core/tools';
import type { AgentToolCallIdentity } from '../run/contracts.js';

interface ToolCallStateBase extends AgentToolCallIdentity { readonly toolName: string }
export interface ReceivedToolCallState extends ToolCallStateBase { readonly state: 'received' }
export interface ParsedToolCallState extends ToolCallStateBase { readonly state: 'parsed'; readonly input: unknown }
export interface CanonicalizedToolCallState extends ToolCallStateBase { readonly state: 'canonicalized'; readonly input: unknown }
export interface EffectsDerivedToolCallState extends ToolCallStateBase { readonly state: 'effects_derived'; readonly input: unknown; readonly effects: ToolEffects; readonly fingerprint: string }
export interface AuthorizingToolCallState extends ToolCallStateBase { readonly state: 'authorizing'; readonly input: unknown; readonly effects: ToolEffects; readonly fingerprint: string }
export interface WaitingApprovalToolCallState extends ToolCallStateBase { readonly state: 'waiting_for_approval'; readonly input: unknown; readonly effects: ToolEffects; readonly fingerprint: string; readonly approvalId: string }
export interface ExecutingToolCallState extends ToolCallStateBase { readonly state: 'executing'; readonly input: unknown; readonly effects: ToolEffects; readonly fingerprint: string }
export interface ObservedToolCallState extends ToolCallStateBase { readonly state: 'observed'; readonly observation: ToolObservation; readonly effects: ToolEffects; readonly fingerprint: string }
export interface PersistedToolCallState extends ToolCallStateBase { readonly state: 'persisted'; readonly observation: ToolObservation; readonly effects: ToolEffects; readonly fingerprint: string }
export interface RejectedToolCallState extends ToolCallStateBase { readonly state: 'invalid_input' | 'unknown_tool' | 'denied' | 'failed' | 'aborted' | 'uncertain_side_effect'; readonly observation?: ToolObservation }

export type ToolCallMachineState = ReceivedToolCallState | ParsedToolCallState | CanonicalizedToolCallState | EffectsDerivedToolCallState | AuthorizingToolCallState | WaitingApprovalToolCallState | ExecutingToolCallState | ObservedToolCallState | PersistedToolCallState | RejectedToolCallState;
export type ToolCallMachineEvent =
  | { readonly type: 'input.parsed'; readonly input: unknown }
  | { readonly type: 'input.canonicalized'; readonly input: unknown }
  | { readonly type: 'effects.derived'; readonly effects: ToolEffects; readonly fingerprint: string }
  | { readonly type: 'authorization.started' }
  | { readonly type: 'authorization.decided'; readonly decision: ToolAuthorizationDecision; readonly approvalId?: string }
  | { readonly type: 'approval.resolved'; readonly decision: 'allow' | 'deny'; readonly fingerprint: string }
  | { readonly type: 'execution.observed'; readonly observation: ToolObservation }
  | { readonly type: 'observation.persisted' }
  | { readonly type: 'rejected'; readonly outcome: RejectedToolCallState['state']; readonly observation?: ToolObservation };

export type ToolCallMachineCommand =
  | { readonly type: 'authorization.invoke' }
  | { readonly type: 'approval.persist'; readonly approvalId: string; readonly fingerprint: string }
  | { readonly type: 'tool.invoke' }
  | { readonly type: 'observation.persist' };

export interface ToolCallTransition { readonly state: ToolCallMachineState; readonly commands: readonly ToolCallMachineCommand[] }
export class ToolCallTransitionError extends Error {
  constructor(readonly stateName: ToolCallMachineState['state'], readonly eventType: ToolCallMachineEvent['type']) { super(`Illegal tool-call transition: ${stateName} + ${eventType}.`); this.name = 'ToolCallTransitionError'; }
}

export function createToolCallMachine(identity: AgentToolCallIdentity, toolName: string): ReceivedToolCallState { return Object.freeze({ ...identity, toolName, state: 'received' }); }

export function reduceToolCall(state: ToolCallMachineState, event: ToolCallMachineEvent): ToolCallTransition {
  const base: ToolCallStateBase = { turnIndex: state.turnIndex, turnId: state.turnId, requestAttempt: state.requestAttempt, toolBatchId: state.toolBatchId, callIndex: state.callIndex, ...(state.callId ? { callId: state.callId } : {}), toolName: state.toolName };
  switch (state.state) {
    case 'received': if (event.type === 'input.parsed') return result({ ...base, state: 'parsed', input: event.input }); break;
    case 'parsed': if (event.type === 'input.canonicalized') return result({ ...base, state: 'canonicalized', input: event.input }); break;
    case 'canonicalized': if (event.type === 'effects.derived') return result({ ...base, state: 'effects_derived', input: state.input, effects: event.effects, fingerprint: event.fingerprint }); break;
    case 'effects_derived': if (event.type === 'authorization.started') return result({ ...base, state: 'authorizing', input: state.input, effects: state.effects, fingerprint: state.fingerprint }, [{ type: 'authorization.invoke' }]); break;
    case 'authorizing':
      if (event.type === 'authorization.decided') {
        if (event.decision.decision === 'allow') return result({ ...base, state: 'executing', input: state.input, effects: state.effects, fingerprint: state.fingerprint }, [{ type: 'tool.invoke' }]);
        if (event.decision.decision === 'deny') return result({ ...base, state: 'denied' });
        if (!event.approvalId) break;
        return result({ ...base, state: 'waiting_for_approval', input: state.input, effects: state.effects, fingerprint: state.fingerprint, approvalId: event.approvalId }, [{ type: 'approval.persist', approvalId: event.approvalId, fingerprint: state.fingerprint }]);
      }
      break;
    case 'waiting_for_approval':
      if (event.type === 'approval.resolved') {
        if (event.fingerprint !== state.fingerprint) throw new ToolCallTransitionError(state.state, event.type);
        return event.decision === 'allow' ? result({ ...base, state: 'executing', input: state.input, effects: state.effects, fingerprint: state.fingerprint }, [{ type: 'tool.invoke' }]) : result({ ...base, state: 'denied' });
      }
      break;
    case 'executing': if (event.type === 'execution.observed') return result({ ...base, state: 'observed', observation: event.observation, effects: state.effects, fingerprint: state.fingerprint }, [{ type: 'observation.persist' }]); break;
    case 'observed': if (event.type === 'observation.persisted') return result({ ...base, state: 'persisted', observation: state.observation, effects: state.effects, fingerprint: state.fingerprint }); break;
    case 'persisted': case 'invalid_input': case 'unknown_tool': case 'denied': case 'failed': case 'aborted': case 'uncertain_side_effect': break;
    default: return assertNever(state);
  }
  if (event.type === 'rejected' && state.state !== 'persisted') return result({ ...base, state: event.outcome, ...(event.observation ? { observation: event.observation } : {}) });
  throw new ToolCallTransitionError(state.state, event.type);
}

function result(state: ToolCallMachineState, commands: readonly ToolCallMachineCommand[] = []): ToolCallTransition { return Object.freeze({ state: Object.freeze(state), commands: Object.freeze([...commands]) }); }
function assertNever(value: never): never { throw new Error(`Unhandled tool-call state: ${JSON.stringify(value)}`); }
