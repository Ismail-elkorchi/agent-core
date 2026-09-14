import type { AgentRunState } from './control/contracts.js';
import { outstandingToolObligations } from './control/contracts.js';
import type { AgentToolCallState } from './control/tool-state.js';
import type { AgentToolCallIdentity } from './contracts.js';
import type { ToolCall } from '@agent-core/tools';

export interface PendingToolCall extends AgentToolCallIdentity {
  readonly runId: string;
  readonly call: ToolCall;
  readonly catalogRevision: string;
  readonly state: AgentToolCallState;
  readonly protocol: 'synchronous' | 'asynchronous';
}

/** A query over the driver's current obligations, including unacknowledged native delivery. */
export function pendingToolCalls(state: AgentRunState): readonly PendingToolCall[] {
  return Object.freeze(
    outstandingToolObligations(state).map(({ target }) => {
      const batch = state.toolBatches.find((item) => item.toolBatchId === target.toolBatchId);
      const call = batch?.calls[target.callIndex];
      const callState = batch?.callStates[target.callIndex];
      if (!batch || !call || !callState)
        throw new Error('Outstanding tool obligation lost its source.');
      return Object.freeze({
        runId: state.runId,
        ...batch.identity,
        ...target,
        ...(call.id ? { callId: call.id } : {}),
        call,
        catalogRevision: batch.source.catalog.revision,
        state: callState,
        protocol: batch.modelCalls[target.callIndex]?.async
          ? ('asynchronous' as const)
          : ('synchronous' as const)
      });
    })
  );
}

export function assertToolTransitionBoundary(state: AgentRunState): void {
  const pending = pendingToolCalls(state).filter((call) => call.protocol === 'synchronous');
  if (pending.length)
    throw new Error(
      `Context transition requires the exact results of pending calls: ${pending.map((call) => call.callId ?? `${call.toolBatchId}:${String(call.callIndex)}`).join(', ')}.`
    );
}
