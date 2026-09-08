import { canonicalJsonString } from '@agent-core/json';
import type { EventRepository } from '@agent-core/persistence';

import type { AgentEvent } from '../events.js';
import type { AgentRunState } from './control/contracts.js';
import type { AgentToolCallState } from './control/tool-state.js';
import type { AgentToolCallIdentity, AgentTurnSnapshotRecord } from './contracts.js';
import type { ToolCall } from '@agent-core/tools';
import type { ToolCatalogSnapshot } from './tool-catalog.js';

export interface PendingToolCall extends AgentToolCallIdentity {
  readonly runId: string;
  readonly call: ToolCall;
  readonly catalogRevision: string;
  readonly state: AgentToolCallState;
  readonly protocol: 'synchronous' | 'asynchronous';
}

/**
 * Independent call tracking over the existing effect driver's authoritative records.
 * Rebuildable from those records; it never grants a second effect-start authority.
 */
export class PendingCallCoordinator {
  private readonly calls = new Map<string, PendingToolCall>();
  private readonly catalogs = new Map<string, ToolCatalogSnapshot>();

  static async recover(events: EventRepository<AgentEvent>, runId: string): Promise<PendingCallCoordinator> {
    const coordinator = new PendingCallCoordinator();
    for await (const record of events.read(runId)) {
      if (record.event.type === 'turn.snapshot.created') coordinator.bindCatalog(record.event.snapshot);
      if (record.event.type === 'run.state.changed') coordinator.observeState(record.event.state);
    }
    return coordinator;
  }

  bindCatalog(snapshot: AgentTurnSnapshotRecord): void {
    const key = turnKey(snapshot);
    const previous = this.catalogs.get(key);
    if (previous && previous.revision !== snapshot.toolCatalog.revision)
      throw new Error('A model request cannot change its advertised catalog.');
    this.catalogs.set(key, snapshot.toolCatalog);
  }

  observeState(state: AgentRunState): void {
    for (const phase of state.toolBatches) {
      const catalog = this.catalogs.get(turnKey(phase.identity));
      if (!catalog) throw new Error('Tool work has no immutable request catalog.');
      for (const [callIndex, call] of phase.calls.entries()) {
        const callState = phase.callStates[callIndex];
        if (!callState) throw new Error('Pending call lost its effect state.');
        const key = `${state.runId}:${phase.toolBatchId}:${String(callIndex)}`;
        const previous = this.calls.get(key);
        if (
          previous &&
          canonicalJsonString(previous.call) !== canonicalJsonString(call)
        )
          throw new Error('A pending call changed its original call identity or arguments.');
        this.calls.set(
          key,
          Object.freeze({
            runId: state.runId,
            ...phase.identity,
            toolBatchId: phase.toolBatchId,
            callIndex,
            ...(call.id ? { callId: call.id } : {}),
            call,
            catalogRevision: catalog.revision,
            state: callState,
            protocol: phase.modelCalls[callIndex]?.async ? 'asynchronous' : 'synchronous'
          })
        );
      }
    }
  }

  inspect(): readonly PendingToolCall[] {
    return Object.freeze([...this.calls.values()]);
  }

  pending(): readonly PendingToolCall[] {
    return Object.freeze(
      this.inspect().filter((call) => call.state.stage !== 'recorded' && call.state.stage !== 'cancelled')
    );
  }

  assertTransitionBoundary(): void {
    const pending = this.pending().filter((call) => call.protocol === 'synchronous');
    if (pending.length)
      throw new Error(
        `Context transition requires the exact results of pending calls: ${pending.map((call) => call.callId ?? `${call.toolBatchId}:${String(call.callIndex)}`).join(', ')}.`
      );
  }
}

function turnKey(identity: { readonly turnId: string; readonly requestAttempt: number }): string {
  return `${identity.turnId}:${String(identity.requestAttempt)}`;
}
