import { randomUUID } from 'node:crypto';
import {
  canonicalJsonString,
  type ConditionalEventAppendResult,
  type EventAppendReceipt,
  type EventLedgerTail,
  type EventRepository
} from '@agent-core/evidence';
import { encodeAgentEvent, type AgentEvent } from '../events.js';
import {
  decodeAgentOperationState,
  nextAgentOperationInstruction,
  type AgentOperationConfiguration,
  type AgentOperationInput,
  type AgentOperationInstruction,
  type AgentOperationPhase,
  type AgentOperationState
} from './contracts.js';
import type { AgentRunBudgetState } from '../run/contracts.js';

export interface AgentOperationAcceptance {
  readonly runId: string;
  readonly finalizationId: string;
  readonly input: AgentOperationInput;
  readonly configuration: AgentOperationConfiguration;
}

export interface AgentOperationInspection {
  readonly state: AgentOperationState;
  readonly transition: Readonly<{ readonly eventId: string; readonly sequence: number; readonly hash: string }>;
  readonly tail: EventLedgerTail;
  readonly instruction: AgentOperationInstruction;
}

export interface AgentOperationAdvance {
  readonly phase: AgentOperationPhase;
  readonly budget?: AgentRunBudgetState;
}

export interface AgentOperationProcedureContext {
  readonly state: AgentOperationState;
  readonly instruction: Extract<AgentOperationInstruction, { readonly kind: 'execute' }>;
  append(event: Exclude<AgentEvent, { readonly type: 'operation.transition' }>, idempotencyKey: string): Promise<EventAppendReceipt>;
}

export type AgentOperationProcedureExecutor = (context: AgentOperationProcedureContext) => AgentOperationAdvance | Promise<AgentOperationAdvance>;

export type AgentOperationDriveResult =
  | Readonly<{ readonly kind: 'advanced'; readonly inspection: AgentOperationInspection }>
  | Readonly<{ readonly kind: 'waiting'; readonly inspection: AgentOperationInspection; readonly reason: Extract<AgentOperationInstruction, { readonly kind: 'wait' }>['reason'] }>
  | Readonly<{ readonly kind: 'complete'; readonly inspection: AgentOperationInspection }>;

export class AgentOperationConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: 'stale_tail' | 'stale_driver' | 'idempotency_conflict' | 'persistence_not_committed' | 'persistence_outcome_unknown',
    message: string
  ) {
    super(message);
    this.name = 'AgentOperationConflictError';
  }
}

export class AgentOperationCoordinator {
  constructor(private readonly events: EventRepository<AgentEvent>) {}

  async accept(value: AgentOperationAcceptance): Promise<AgentOperationInspection> {
    const state = decodeAgentOperationState({
      runId: value.runId,
      finalizationId: value.finalizationId,
      revision: 0,
      driverGeneration: 0,
      input: value.input,
      configuration: value.configuration,
      control: { status: 'detached' },
      phase: { kind: 'accepted' }
    });
    const expectedTail = await this.events.tail(state.runId);
    if (expectedTail.sequence !== -1) {
      const existing = await this.inspect(state.runId);
      if (canonicalJsonString(encodeAgentEvent({ type: 'operation.transition', state: existing.state })) === canonicalJsonString(encodeAgentEvent({ type: 'operation.transition', state }))) return existing;
      throw new AgentOperationConflictError(state.runId, 'stale_tail', `Run ${state.runId} already contains a different operation.`);
    }
    const result = await this.events.appendConditional(state.runId, { type: 'operation.transition', state }, {
      idempotencyKey: `${state.runId}:operation:accepted`,
      expectedTail,
      driverGeneration: 0
    });
    acceptConditionalResult(state.runId, result);
    return this.inspect(state.runId);
  }

  async inspect(runId: string): Promise<AgentOperationInspection> {
    const transition = await this.events.latestOfType(runId, 'operation.transition');
    if (transition?.event.type !== 'operation.transition') {
      throw new Error(`Run ${runId} has no durable operation.`);
    }
    const state = transition.event.state;
    if (state.runId !== runId || state.driverGeneration !== transition.driverGeneration) {
      throw new Error(`Run ${runId} has a contradictory operation transition.`);
    }
    return Object.freeze({
      state,
      transition: Object.freeze({ eventId: transition.eventId, sequence: transition.sequence, hash: transition.hash }),
      tail: await this.events.tail(runId),
      instruction: nextAgentOperationInstruction(state)
    });
  }

  async listUnfinished(): Promise<readonly AgentOperationInspection[]> {
    const unfinished: AgentOperationInspection[] = [];
    for (const runId of await this.events.listRunIds()) {
      const transition = await this.events.latestOfType(runId, 'operation.transition');
      if (transition?.event.type !== 'operation.transition' || transition.event.state.phase.kind === 'terminal') continue;
      unfinished.push(await this.inspect(runId));
    }
    return Object.freeze(unfinished);
  }

  async attach(runId: string, driverId = randomUUID()): Promise<AgentOperationDriver> {
    const current = await this.inspect(runId);
    if (current.state.phase.kind === 'terminal') throw new Error(`Run ${runId} is already terminal.`);
    if ((current.state.control.status === 'owned' || current.state.control.status === 'abort_requested')
      && current.state.control.driverId === driverId
      && current.state.driverGeneration === current.tail.driverGeneration) {
      return new AgentOperationDriver(this.events, current.state, current.tail, current.transition, driverId);
    }
    const generation = current.tail.driverGeneration + 1;
    const state = decodeAgentOperationState({
      ...current.state,
      revision: current.state.revision + 1,
      driverGeneration: generation,
      control: current.state.control.status === 'abort_requested'
        ? { status: 'abort_requested', driverId, reason: current.state.control.reason }
        : { status: 'owned', driverId }
    });
    const result = await this.events.appendConditional(runId, { type: 'operation.transition', state }, {
      idempotencyKey: `${runId}:driver:${String(generation)}`,
      expectedTail: current.tail,
      driverGeneration: generation
    });
    const committed = acceptConditionalResult(runId, result);
    return new AgentOperationDriver(this.events, state, committed.tail, committed.receipt, driverId);
  }

  async requestAbort(runId: string, reason: string): Promise<AgentOperationInspection> {
    const current = await this.inspect(runId);
    if (current.state.phase.kind === 'terminal' || current.state.control.status === 'abort_requested') return current;
    const state = decodeAgentOperationState({
      ...current.state,
      revision: current.state.revision + 1,
      control: {
        status: 'abort_requested',
        ...(current.state.control.status === 'owned' ? { driverId: current.state.control.driverId } : {}),
        reason
      }
    });
    const result = await this.events.appendConditional(runId, { type: 'operation.transition', state }, {
      idempotencyKey: transitionKey(state),
      expectedTail: current.tail,
      driverGeneration: current.tail.driverGeneration
    });
    acceptConditionalResult(runId, result);
    return this.inspect(runId);
  }
}

export class AgentOperationDriver {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly events: EventRepository<AgentEvent>,
    private stateValue: AgentOperationState,
    private tailValue: EventLedgerTail,
    private transitionValue: Readonly<{ readonly eventId: string; readonly sequence: number; readonly hash: string }>,
    readonly driverId: string
  ) {}

  state(): AgentOperationState { return this.stateValue; }

  drive(execute: AgentOperationProcedureExecutor): Promise<AgentOperationDriveResult> {
    return this.serial(async () => {
      const inspection = this.inspection();
      if (inspection.instruction.kind === 'complete') return Object.freeze({ kind: 'complete', inspection });
      if (inspection.instruction.kind === 'wait') return Object.freeze({ kind: 'waiting', inspection, reason: inspection.instruction.reason });
      const advance = await execute(Object.freeze({
        state: this.stateValue,
        instruction: inspection.instruction,
        append: (event: Exclude<AgentEvent, { readonly type: 'operation.transition' }>, idempotencyKey: string) => this.appendNow(event, idempotencyKey)
      }));
      const next = await this.transitionNow(inspection.instruction.procedure, advance);
      return Object.freeze({ kind: 'advanced', inspection: next });
    });
  }

  append(event: Exclude<AgentEvent, { readonly type: 'operation.transition' }>, idempotencyKey: string): Promise<EventAppendReceipt> {
    return this.serial(() => this.appendNow(event, idempotencyKey));
  }

  private async appendNow(event: Exclude<AgentEvent, { readonly type: 'operation.transition' }>, idempotencyKey: string): Promise<EventAppendReceipt> {
    this.assertEventAuthority(event);
    const result = await this.events.appendConditional(this.stateValue.runId, event, {
      idempotencyKey,
      expectedTail: this.tailValue,
      driverGeneration: this.stateValue.driverGeneration
    });
    const committed = acceptConditionalResult(this.stateValue.runId, result);
    this.tailValue = committed.tail;
    return committed.receipt;
  }

  private async transitionNow(procedure: Extract<AgentOperationInstruction, { readonly kind: 'execute' }>['procedure'], advance: AgentOperationAdvance): Promise<AgentOperationInspection> {
    this.assertTransitionAuthority(advance.phase);
    if (!advanceMatchesProcedure(procedure, advance.phase)) {
      throw new TypeError(`Procedure ${procedure} cannot advance to ${advance.phase.kind}.`);
    }
    const state = decodeAgentOperationState({
      ...this.stateValue,
      revision: this.stateValue.revision + 1,
      phase: advance.phase,
      ...(advance.budget === undefined ? (this.stateValue.budget === undefined ? {} : { budget: this.stateValue.budget }) : { budget: advance.budget })
    });
    const result = await this.events.appendConditional(state.runId, { type: 'operation.transition', state }, {
      idempotencyKey: transitionKey(state),
      expectedTail: this.tailValue,
      driverGeneration: state.driverGeneration
    });
    const committed = acceptConditionalResult(state.runId, result);
    this.stateValue = state;
    this.tailValue = committed.tail;
    this.transitionValue = committed.receipt;
    return this.inspection();
  }

  private inspection(): AgentOperationInspection {
    return Object.freeze({
      state: this.stateValue,
      transition: Object.freeze({ eventId: this.transitionValue.eventId, sequence: this.transitionValue.sequence, hash: this.transitionValue.hash }),
      tail: this.tailValue,
      instruction: nextAgentOperationInstruction(this.stateValue)
    });
  }

  private assertEventAuthority(event: Exclude<AgentEvent, { readonly type: 'operation.transition' }>): void {
    const control = this.stateValue.control;
    if (control.status === 'detached' || control.driverId !== this.driverId || (control.status === 'abort_requested' && !abortAdministrativeEvent(event))) {
      throw new AgentOperationConflictError(this.stateValue.runId, 'stale_driver', `Driver ${this.driverId} cannot append work for run ${this.stateValue.runId}.`);
    }
  }

  private assertTransitionAuthority(nextPhase: AgentOperationPhase): void {
    if ((this.stateValue.control.status !== 'owned' && this.stateValue.control.status !== 'abort_requested')
      || this.stateValue.control.driverId !== this.driverId) {
      throw new AgentOperationConflictError(this.stateValue.runId, 'stale_driver', `Driver ${this.driverId} does not own run ${this.stateValue.runId}.`);
    }
    if (this.stateValue.control.status === 'abort_requested'
      && nextPhase.kind !== 'cancelling'
      && nextPhase.kind !== 'finalization'
      && nextPhase.kind !== 'terminal') {
      throw new AgentOperationConflictError(this.stateValue.runId, 'stale_driver', `Run ${this.stateValue.runId} is aborting and cannot advance to ${nextPhase.kind}.`);
    }
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function acceptConditionalResult(runId: string, result: ConditionalEventAppendResult): Extract<ConditionalEventAppendResult, { readonly kind: 'committed' | 'already_committed' | 'committed_index_unknown' }> {
  if (result.kind === 'committed' || result.kind === 'already_committed' || result.kind === 'committed_index_unknown') return result;
  if (result.kind === 'rejected') throw new AgentOperationConflictError(runId, result.reason, `Operation write for ${runId} was rejected: ${result.reason}.`);
  if (result.kind === 'not_committed') throw new AgentOperationConflictError(runId, 'persistence_not_committed', `Operation write for ${runId} was not committed: ${result.failure.message}`);
  throw new AgentOperationConflictError(runId, 'persistence_outcome_unknown', `Operation write outcome for ${runId} is unknown: ${result.failure.message}`);
}

function transitionKey(state: AgentOperationState): string {
  return `${state.runId}:operation:revision:${String(state.revision)}`;
}

function abortAdministrativeEvent(event: Exclude<AgentEvent, { readonly type: 'operation.transition' }>): boolean {
  return event.type === 'finalization.prepared'
    || event.type === 'run.ended'
    || event.type === 'delivery.failed'
    || event.type === 'process.ended'
    || (event.type === 'run.phase.changed' && event.phase === 'finalizing');
}

function advanceMatchesProcedure(procedure: Extract<AgentOperationInstruction, { readonly kind: 'execute' }>['procedure'], phase: AgentOperationPhase): boolean {
  switch (procedure) {
    case 'prepare': return phase.kind === 'preparing';
    case 'assemble_turn': return phase.kind === 'provider' || phase.kind === 'finalization' || phase.kind === 'cancelling';
    case 'prepare_provider_request': return phase.kind === 'provider' && phase.stage === 'effect_pending';
    case 'reconcile_provider_request': return (phase.kind === 'provider' && (phase.stage === 'settled' || phase.stage === 'outcome_unknown')) || phase.kind === 'suspended';
    case 'consume_provider_settlement': return phase.kind === 'tools' || phase.kind === 'preparing' || phase.kind === 'verification' || phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'prepare_tool_call': return phase.kind === 'tools' && (phase.stage === 'effect_pending' || phase.stage === 'complete');
    case 'reconcile_tool_call': return (phase.kind === 'tools' && phase.stage === 'settled') || phase.kind === 'suspended';
    case 'consume_tool_settlement': return phase.kind === 'tools' && phase.stage === 'projecting';
    case 'project_tool_settlement': return phase.kind === 'tools' && (phase.stage === 'ready' || phase.stage === 'complete');
    case 'advance_after_tools': return phase.kind === 'preparing' || phase.kind === 'verification' || phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'prepare_verification': return phase.kind === 'verification' && (phase.stage === 'effect_pending' || phase.stage === 'complete');
    case 'reconcile_verification': return (phase.kind === 'verification' && phase.stage === 'settled') || phase.kind === 'suspended';
    case 'consume_verification_settlement': return phase.kind === 'verification' || phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'decide_candidate': return phase.kind === 'disposition' || phase.kind === 'finalization';
    case 'finalize':
    case 'reconcile_finalization': return phase.kind === 'finalization' || phase.kind === 'terminal';
    case 'finalize_abort': return phase.kind === 'cancelling' || phase.kind === 'finalization' || phase.kind === 'terminal';
  }
}
