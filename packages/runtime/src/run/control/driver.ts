import { randomUUID } from 'node:crypto';
import {
  canonicalJsonString,
  hashJson,
  type ConditionalEventAppendResult,
  type EventAppendReceipt,
  type EventLedgerTail,
  type EventRepository
} from '@agent-core/persistence';
import { encodeAgentEvent, type AgentAuditEvent, type AgentEvent } from '../../events.js';
import {
  decodeAgentRunState,
  nextAgentRunInstruction,
  type AgentRunControlConfiguration,
  type AgentRunStateInput,
  type AgentRunInstruction,
  type AgentRunControlPhase,
  type AgentRunState
} from './contracts.js';
import type { AgentRunBudgetState } from '../contracts.js';
import type { ToolCall } from '@agent-core/tools';
import { encodeToolObservation } from '@agent-core/tools';
import { decodeEffectSettlementPermit, knownEffectExposure, settleExternalEffect, type EffectSettlementPermit } from '@agent-core/effects';
import { decodeAgentToolSettlementRecord, type AgentToolSettlementRecord } from './tool-state.js';

export interface AgentRunAcceptance {
  readonly runId: string;
  readonly finalizationId: string;
  readonly input: AgentRunStateInput;
  readonly configuration: AgentRunControlConfiguration;
}

export interface AgentRunInspection {
  readonly state: AgentRunState;
  readonly transition: Readonly<{ readonly eventId: string; readonly sequence: number; readonly hash: string }>;
  readonly tail: EventLedgerTail;
  readonly instruction: AgentRunInstruction;
}

export interface AgentRunAdvance {
  readonly phase: AgentRunControlPhase;
  readonly budget?: AgentRunBudgetState;
  readonly toolCalls?: readonly ToolCall[];
  readonly revisionInstructions?: readonly string[];
}

export interface AgentRunProcedureContext {
  readonly state: AgentRunState;
  readonly instruction: Extract<AgentRunInstruction, { readonly kind: 'execute' }>;
  append(event: AgentAuditEvent, idempotencyKey: string): Promise<EventAppendReceipt>;
}

export type AgentRunProcedureExecutor = (context: AgentRunProcedureContext) => AgentRunAdvance | Promise<AgentRunAdvance>;

export type AgentRunDriveResult =
  | Readonly<{ readonly kind: 'advanced'; readonly inspection: AgentRunInspection }>
  | Readonly<{ readonly kind: 'waiting'; readonly inspection: AgentRunInspection; readonly reason: Extract<AgentRunInstruction, { readonly kind: 'wait' }>['reason'] }>
  | Readonly<{ readonly kind: 'complete'; readonly inspection: AgentRunInspection }>;

export class AgentRunConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: 'stale_tail' | 'stale_driver' | 'idempotency_conflict' | 'persistence_not_committed' | 'persistence_outcome_unknown',
    message: string
  ) {
    super(message);
    this.name = 'AgentRunConflictError';
  }
}

export class AgentRunCoordinator {
  constructor(private readonly events: EventRepository<AgentEvent>) {}

  async accept(value: AgentRunAcceptance): Promise<AgentRunInspection> {
    const state = decodeAgentRunState({
      runId: value.runId,
      finalizationId: value.finalizationId,
      revision: 0,
      driverGeneration: 0,
      input: value.input,
      configuration: value.configuration,
      control: { status: 'detached' },
      phase: { kind: 'accepted' },
      toolCalls: [],
      revisionInstructions: []
    });
    const expectedTail = await this.events.tail(state.runId);
    if (expectedTail.sequence !== -1) {
      const existing = await this.inspect(state.runId);
      if (canonicalJsonString(encodeAgentEvent({ type: 'run.state.changed', state: existing.state })) === canonicalJsonString(encodeAgentEvent({ type: 'run.state.changed', state }))) return existing;
      throw new AgentRunConflictError(state.runId, 'stale_tail', `Run ${state.runId} already contains a different run.`);
    }
    const result = await this.events.appendConditional(state.runId, { type: 'run.state.changed', state }, {
      idempotencyKey: `${state.runId}:run:accepted`,
      expectedTail,
      driverGeneration: 0
    });
    acceptConditionalResult(state.runId, result);
    return this.inspect(state.runId);
  }

  async inspect(runId: string): Promise<AgentRunInspection> {
    const transition = await this.events.latestOfType(runId, 'run.state.changed');
    if (transition?.event.type !== 'run.state.changed') {
      throw new Error(`Run ${runId} has no durable run.`);
    }
    const state = transition.event.state;
    if (state.runId !== runId || state.driverGeneration !== transition.driverGeneration) {
      throw new Error(`Run ${runId} has a contradictory run transition.`);
    }
    return Object.freeze({
      state,
      transition: Object.freeze({ eventId: transition.eventId, sequence: transition.sequence, hash: transition.hash }),
      tail: await this.events.tail(runId),
      instruction: nextAgentRunInstruction(state)
    });
  }

  async listUnfinished(): Promise<readonly AgentRunInspection[]> {
    const unfinished: AgentRunInspection[] = [];
    for (const runId of await this.events.listRunIds()) {
      const transition = await this.events.latestOfType(runId, 'run.state.changed');
      if (transition?.event.type !== 'run.state.changed' || transition.event.state.phase.kind === 'terminal') continue;
      unfinished.push(await this.inspect(runId));
    }
    return Object.freeze(unfinished);
  }

  async attach(runId: string, driverId = randomUUID()): Promise<AgentRunDriver> {
    const current = await this.inspect(runId);
    if (current.state.phase.kind === 'terminal') throw new Error(`Run ${runId} is already terminal.`);
    if ((current.state.control.status === 'owned' || current.state.control.status === 'abort_requested')
      && current.state.control.driverId === driverId
      && current.state.driverGeneration === current.tail.driverGeneration) {
      return new AgentRunDriver(this.events, current.state, current.tail, current.transition, driverId);
    }
    const generation = current.tail.driverGeneration + 1;
    const state = decodeAgentRunState({
      ...current.state,
      revision: current.state.revision + 1,
      driverGeneration: generation,
      control: current.state.control.status === 'abort_requested'
        ? { status: 'abort_requested', driverId, reason: current.state.control.reason }
        : { status: 'owned', driverId }
    });
    const result = await this.events.appendConditional(runId, { type: 'run.state.changed', state }, {
      idempotencyKey: `${runId}:driver:${String(generation)}`,
      expectedTail: current.tail,
      driverGeneration: generation
    });
    const committed = acceptConditionalResult(runId, result);
    return new AgentRunDriver(this.events, state, committed.tail, committed.receipt, driverId);
  }

  async requestAbort(runId: string, reason: string): Promise<AgentRunInspection> {
    for (;;) {
      const current = await this.inspect(runId);
      if (current.state.phase.kind === 'terminal' || current.state.control.status === 'abort_requested') return current;
      const state = decodeAgentRunState({
        ...current.state,
        revision: current.state.revision + 1,
        control: {
          status: 'abort_requested',
          ...(current.state.control.status === 'owned' ? { driverId: current.state.control.driverId } : {}),
          reason
        }
      });
      const result = await this.events.appendConditional(runId, { type: 'run.state.changed', state }, {
        idempotencyKey: transitionKey(state),
        expectedTail: current.tail,
        driverGeneration: current.tail.driverGeneration
      });
      if (result.kind === 'rejected' && (result.reason === 'stale_tail' || result.reason === 'stale_driver')) continue;
      acceptConditionalResult(runId, result);
      return this.inspect(runId);
    }
  }

  async settleToolEffect(runId: string, input: {
    readonly effectId: string;
    readonly permit: EffectSettlementPermit;
    readonly settlement: AgentToolSettlementRecord;
  }): Promise<AgentRunInspection> {
    if (typeof input.effectId !== 'string' || input.effectId.trim().length === 0) throw new TypeError('Tool effect identity must be non-empty.');
    const permit = decodeEffectSettlementPermit(input.permit);
    const settlement = decodeAgentToolSettlementRecord(input.settlement);
    for (;;) {
      const current = await this.inspect(runId);
      const phase = current.state.phase;
      const callIndex = phase.kind === 'tools'
        ? phase.callStates.findIndex((call) => call.stage !== 'ready' && call.effect?.intent.effectId === input.effectId)
        : -1;
      const callState = phase.kind === 'tools' && callIndex >= 0 ? phase.callStates[callIndex] : undefined;
      if (callState?.stage === 'settled' || callState?.stage === 'recording' || callState?.stage === 'recorded') {
        if (toolSettlementDigest(callState.settlement) !== toolSettlementDigest(settlement)) {
          throw new AgentRunConflictError(runId, 'idempotency_conflict', `Tool effect ${input.effectId} already has a different settlement.`);
        }
        return current;
      }
      if (phase.kind !== 'tools' || callIndex < 0
        || (callState?.stage !== 'effect_pending' && callState?.stage !== 'outcome_unknown')
        || callState.effect.phase !== 'started') {
        throw new AgentRunConflictError(runId, 'stale_tail', `Tool effect ${input.effectId} is no longer awaiting settlement.`);
      }
      const resultDigest = hashJson(encodeToolObservation(settlement.observation));
      const settled = settleExternalEffect(callState.effect, permit, {
        outcome: settlement.observation.ok ? 'succeeded' : 'failed',
        resultDigest,
        exposure: knownEffectExposure(callState.effect.intent.exposure.quantities)
      });
      if (settled.status !== 'settled' && settled.status !== 'already_settled') {
        throw new AgentRunConflictError(runId, 'idempotency_conflict', `Tool effect ${input.effectId} settlement authority was rejected: ${settled.status}.`);
      }
      const state = decodeAgentRunState({
        ...current.state,
        revision: current.state.revision + 1,
        phase: {
          ...phase,
          callStates: replaceAt(phase.callStates, callIndex, {
            stage: 'settled', plan: callState.plan, toolAttempt: callState.toolAttempt,
            effect: settled.state, settlement
          })
        }
      });
      const result = await this.events.appendConditional(runId, { type: 'run.state.changed', state }, {
        idempotencyKey: `${runId}:tool-effect:${input.effectId}:settled:${resultDigest}`,
        expectedTail: current.tail,
        driverGeneration: current.state.driverGeneration
      });
      if (result.kind === 'rejected' && (result.reason === 'stale_tail' || result.reason === 'stale_driver')) continue;
      acceptConditionalResult(runId, result);
      return this.inspect(runId);
    }
  }
}

export class AgentRunDriver {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly events: EventRepository<AgentEvent>,
    private stateValue: AgentRunState,
    private tailValue: EventLedgerTail,
    private transitionValue: Readonly<{ readonly eventId: string; readonly sequence: number; readonly hash: string }>,
    readonly driverId: string
  ) {}

  state(): AgentRunState { return this.stateValue; }

  drive(execute: AgentRunProcedureExecutor): Promise<AgentRunDriveResult> {
    return this.serial(async () => {
      const inspection = this.inspection();
      if (inspection.instruction.kind === 'complete') return Object.freeze({ kind: 'complete', inspection });
      if (inspection.instruction.kind === 'wait') return Object.freeze({ kind: 'waiting', inspection, reason: inspection.instruction.reason });
      const advance = await execute(Object.freeze({
        state: this.stateValue,
        instruction: inspection.instruction,
        append: (event: AgentAuditEvent, idempotencyKey: string) => this.appendNow(event, idempotencyKey)
      }));
      const next = await this.transitionNow(inspection.instruction.procedure, advance);
      return Object.freeze({ kind: 'advanced', inspection: next });
    });
  }

  append(event: AgentAuditEvent, idempotencyKey: string): Promise<EventAppendReceipt> {
    return this.serial(() => this.appendNow(event, idempotencyKey));
  }

  synchronize(): Promise<AgentRunInspection> {
    return this.serial(async () => {
      await this.refresh();
      return this.inspection();
    });
  }

  settleToolEffect(input: {
    readonly effectId: string;
    readonly permit: EffectSettlementPermit;
    readonly settlement: AgentToolSettlementRecord;
  }): Promise<AgentRunInspection> {
    return this.serial(async () => {
      await new AgentRunCoordinator(this.events).settleToolEffect(this.stateValue.runId, input);
      await this.refresh();
      return this.inspection();
    });
  }

  decideApproval(input: { readonly approvalId: string; readonly fingerprint: string; readonly decision: 'allow' | 'deny' }): Promise<AgentRunInspection> {
    return this.serial(async () => {
      this.assertTransitionAuthority(this.stateValue.phase);
      if (this.stateValue.phase.kind !== 'approval') throw new TypeError(`Run ${this.stateValue.runId} is not waiting for approval.`);
      const approval = this.stateValue.phase.approval;
      if (approval.approvalId !== input.approvalId) throw new TypeError(`Run ${this.stateValue.runId} is not waiting for approval ${input.approvalId}.`);
      if (approval.fingerprint !== input.fingerprint) throw new TypeError(`Approval fingerprint mismatch for ${input.approvalId}.`);
      const phase: AgentRunControlPhase = Object.freeze({
        kind: 'tools',
        identity: this.stateValue.phase.identity,
        toolBatchId: this.stateValue.phase.toolBatchId,
        calls: this.stateValue.phase.calls,
        callStates: replaceAt(this.stateValue.phase.callStates, this.stateValue.phase.approvalCallIndex, Object.freeze({
          stage: 'ready' as const,
          approved: Object.freeze({ approval, decision: input.decision })
        })),
        maxConcurrency: this.stateValue.phase.maxConcurrency,
        nextObservationIndex: this.stateValue.phase.nextObservationIndex,
        instructions: this.stateValue.phase.instructions,
        modelInputModalities: this.stateValue.phase.modelInputModalities
      });
      return this.commitState({ phase });
    });
  }

  requestAbort(reason: string): Promise<AgentRunInspection> {
    return this.serial(async () => {
      if (reason.trim().length === 0) throw new TypeError('Abort reason must not be empty.');
      if (this.stateValue.phase.kind === 'terminal' || this.stateValue.control.status === 'abort_requested') return this.inspection();
      if (this.stateValue.control.status !== 'owned' || this.stateValue.control.driverId !== this.driverId) {
        throw new AgentRunConflictError(this.stateValue.runId, 'stale_driver', `Driver ${this.driverId} cannot abort run ${this.stateValue.runId}.`);
      }
      const state = decodeAgentRunState({
        ...this.stateValue,
        revision: this.stateValue.revision + 1,
        control: { status: 'abort_requested', driverId: this.driverId, reason }
      });
      const result = await this.events.appendConditional(state.runId, { type: 'run.state.changed', state }, {
        idempotencyKey: transitionKey(state),
        expectedTail: this.tailValue,
        driverGeneration: state.driverGeneration
      });
      if (result.kind === 'rejected' && (result.reason === 'stale_tail' || result.reason === 'stale_driver')) await this.refresh();
      const committed = acceptConditionalResult(state.runId, result);
      this.stateValue = state;
      this.tailValue = committed.tail;
      this.transitionValue = committed.receipt;
      return this.inspection();
    });
  }

  private async appendNow(event: AgentAuditEvent, idempotencyKey: string): Promise<EventAppendReceipt> {
    this.assertEventAuthority(event);
    const result = await this.events.appendConditional(this.stateValue.runId, event, {
      idempotencyKey,
      expectedTail: this.tailValue,
      driverGeneration: this.stateValue.driverGeneration
    });
    if (result.kind === 'rejected' && (result.reason === 'stale_tail' || result.reason === 'stale_driver')) await this.refresh();
    const committed = acceptConditionalResult(this.stateValue.runId, result);
    this.tailValue = committed.tail;
    return committed.receipt;
  }

  private async transitionNow(procedure: Extract<AgentRunInstruction, { readonly kind: 'execute' }>['procedure'], advance: AgentRunAdvance): Promise<AgentRunInspection> {
    this.assertTransitionAuthority(advance.phase);
    if (!advanceMatchesProcedure(procedure, advance.phase)) {
      throw new TypeError(`Procedure ${procedure} cannot advance to ${advance.phase.kind}.`);
    }
    return this.commitState(advance);
  }

  private async commitState(advance: AgentRunAdvance): Promise<AgentRunInspection> {
    const state = decodeAgentRunState({
      ...this.stateValue,
      revision: this.stateValue.revision + 1,
      phase: advance.phase,
      toolCalls: advance.toolCalls ?? this.stateValue.toolCalls,
      revisionInstructions: advance.revisionInstructions ?? this.stateValue.revisionInstructions,
      ...(advance.budget === undefined ? (this.stateValue.budget === undefined ? {} : { budget: this.stateValue.budget }) : { budget: advance.budget })
    });
    const result = await this.events.appendConditional(state.runId, { type: 'run.state.changed', state }, {
      idempotencyKey: transitionKey(state),
      expectedTail: this.tailValue,
      driverGeneration: state.driverGeneration
    });
    if (result.kind === 'rejected' && (result.reason === 'stale_tail' || result.reason === 'stale_driver')) await this.refresh();
    const committed = acceptConditionalResult(state.runId, result);
    this.stateValue = state;
    this.tailValue = committed.tail;
    this.transitionValue = committed.receipt;
    return this.inspection();
  }

  private inspection(): AgentRunInspection {
    return Object.freeze({
      state: this.stateValue,
      transition: Object.freeze({ eventId: this.transitionValue.eventId, sequence: this.transitionValue.sequence, hash: this.transitionValue.hash }),
      tail: this.tailValue,
      instruction: nextAgentRunInstruction(this.stateValue)
    });
  }

  private async refresh(): Promise<void> {
    const transition = await this.events.latestOfType(this.stateValue.runId, 'run.state.changed');
    if (transition?.event.type !== 'run.state.changed') throw new Error(`Run ${this.stateValue.runId} lost its durable run transition.`);
    this.stateValue = transition.event.state;
    this.tailValue = await this.events.tail(this.stateValue.runId);
    this.transitionValue = Object.freeze({ eventId: transition.eventId, sequence: transition.sequence, hash: transition.hash });
  }

  private assertEventAuthority(event: AgentAuditEvent): void {
    const control = this.stateValue.control;
    if (control.status === 'detached' || control.driverId !== this.driverId || (control.status === 'abort_requested' && !abortAdministrativeEvent(event))) {
      throw new AgentRunConflictError(this.stateValue.runId, 'stale_driver', `Driver ${this.driverId} cannot append work for run ${this.stateValue.runId}.`);
    }
  }

  private assertTransitionAuthority(nextPhase: AgentRunControlPhase): void {
    if ((this.stateValue.control.status !== 'owned' && this.stateValue.control.status !== 'abort_requested')
      || this.stateValue.control.driverId !== this.driverId) {
      throw new AgentRunConflictError(this.stateValue.runId, 'stale_driver', `Driver ${this.driverId} does not own run ${this.stateValue.runId}.`);
    }
    if (this.stateValue.control.status === 'abort_requested'
      && nextPhase.kind !== 'cancelling'
      && nextPhase.kind !== 'finalization'
      && nextPhase.kind !== 'terminal') {
      throw new AgentRunConflictError(this.stateValue.runId, 'stale_driver', `Run ${this.stateValue.runId} is aborting and cannot advance to ${nextPhase.kind}.`);
    }
  }

  private serial<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function acceptConditionalResult(runId: string, result: ConditionalEventAppendResult): Extract<ConditionalEventAppendResult, { readonly kind: 'committed' | 'already_committed' | 'committed_index_unknown' }> {
  if (result.kind === 'committed' || result.kind === 'already_committed' || result.kind === 'committed_index_unknown') return result;
  if (result.kind === 'rejected') throw new AgentRunConflictError(runId, result.reason, `Run write for ${runId} was rejected: ${result.reason}.`);
  if (result.kind === 'not_committed') throw new AgentRunConflictError(runId, 'persistence_not_committed', `Run write for ${runId} was not committed: ${result.failure.message}`);
  throw new AgentRunConflictError(runId, 'persistence_outcome_unknown', `Run write outcome for ${runId} is unknown: ${result.failure.message}`);
}

function transitionKey(state: AgentRunState): string {
  return `${state.runId}:run:revision:${String(state.revision)}:${hashJson(encodeAgentEvent({ type: 'run.state.changed', state }))}`;
}

function toolSettlementDigest(settlement: AgentToolSettlementRecord): string {
  return hashJson(Object.freeze({
    observationId: settlement.observationId,
    observation: encodeToolObservation(settlement.observation),
    createdAt: settlement.createdAt
  }));
}

function abortAdministrativeEvent(event: AgentAuditEvent): boolean {
  return event.type === 'run.finalization.staged'
    || event.type === 'run.ended'
    || event.type === 'delivery.failed'
    || event.type === 'process.ended'
    || (event.type === 'run.phase.changed' && event.phase === 'finalizing');
}

function advanceMatchesProcedure(procedure: Extract<AgentRunInstruction, { readonly kind: 'execute' }>['procedure'], phase: AgentRunControlPhase): boolean {
  switch (procedure) {
    case 'initialize_run': return phase.kind === 'initializing' || phase.kind === 'finalization';
    case 'assemble_turn': return phase.kind === 'provider' || phase.kind === 'finalization' || phase.kind === 'cancelling';
    case 'authorize_provider_request': return (phase.kind === 'provider' && phase.stage === 'effect_ready') || phase.kind === 'finalization';
    case 'start_provider_request': return (phase.kind === 'provider' && phase.stage === 'effect_pending') || phase.kind === 'suspended' || phase.kind === 'finalization';
    case 'reconcile_provider_request': return (phase.kind === 'provider' && (phase.stage === 'settled' || phase.stage === 'outcome_unknown')) || phase.kind === 'suspended';
    case 'consume_provider_settlement': return phase.kind === 'provider' || phase.kind === 'tools' || phase.kind === 'initializing' || phase.kind === 'verification' || phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'plan_tool_call': return phase.kind === 'tools' || phase.kind === 'approval' || phase.kind === 'cancelling' || phase.kind === 'finalization';
    case 'start_tool_call': return phase.kind === 'tools' || phase.kind === 'suspended' || phase.kind === 'cancelling' || phase.kind === 'finalization';
    case 'reconcile_tool_call': return phase.kind === 'tools' || phase.kind === 'approval' || phase.kind === 'suspended' || phase.kind === 'cancelling' || phase.kind === 'finalization';
    case 'begin_observation_recording': return phase.kind === 'tools' || phase.kind === 'cancelling' || phase.kind === 'finalization';
    case 'record_tool_observation': return phase.kind === 'tools' || phase.kind === 'cancelling';
    case 'advance_after_tools': return phase.kind === 'initializing' || phase.kind === 'verification' || phase.kind === 'disposition' || phase.kind === 'cancelling' || phase.kind === 'finalization';
    case 'plan_check': return phase.kind === 'verification' && (phase.stage === 'deterministic_pending' || phase.stage === 'effect_ready' || phase.stage === 'settled' || phase.stage === 'complete');
    case 'start_verification': return (phase.kind === 'verification' && phase.stage === 'effect_pending') || phase.kind === 'finalization';
    case 'reconcile_verification': return (phase.kind === 'verification' && phase.stage === 'settled') || phase.kind === 'suspended' || phase.kind === 'finalization';
    case 'consume_verification_settlement': return phase.kind === 'verification' || phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'plan_disposition': return phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'start_disposition': return phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'reconcile_disposition': return phase.kind === 'disposition' || phase.kind === 'suspended' || phase.kind === 'finalization';
    case 'consume_disposition': return phase.kind === 'initializing' || phase.kind === 'finalization';
    case 'finalize':
    case 'reconcile_finalization': return phase.kind === 'finalization' || phase.kind === 'terminal';
    case 'finalize_abort': return phase.kind === 'cancelling' || phase.kind === 'finalization' || phase.kind === 'terminal';
  }
}

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  if (index < 0 || index >= values.length) throw new TypeError(`Cannot replace missing item ${String(index)}.`);
  const next = [...values];
  next[index] = value;
  return Object.freeze(next);
}
