import {
  decodeEffectSettlementPermit,
  knownEffectExposure,
  settleExternalEffect,
  type EffectSettlementPermit
} from '@agent-core/effects';
import { canonicalJsonString } from '@agent-core/json';
import {
  hashJson,
  type ConditionalEventAppendResult,
  type EventAppendReceipt,
  type EventLedgerTail,
  type EventRepository
} from '@agent-core/persistence';
import type { ToolCall } from '@agent-core/tools';
import { encodeToolObservation } from '@agent-core/tools';
import { encodeAgentEvent, type AgentAuditEvent, type AgentEvent } from '../../events.js';
import type { AgentRunBudgetState } from '../contracts.js';
import {
  decodeAgentRunState,
  nextAgentRunInstruction,
  providerWork,
  toolWork,
  type AgentProviderPhase,
  type AgentProviderTarget,
  type AgentRunControlConfiguration,
  type AgentRunControlPhase,
  type AgentRunInstruction,
  type AgentRunProcedure,
  type AgentRunState,
  type AgentRunStateInput,
  type AgentRunTarget,
  type AgentToolTarget
} from './contracts.js';
import {
  decodeAgentToolSettlementRecord,
  decodeToolResultDelivery,
  isToolCallStartable,
  type AgentToolCallState,
  type AgentToolPhase,
  type AgentToolResultDelivery,
  type AgentToolSettlementRecord
} from './tool-state.js';

export interface AgentRunAcceptance {
  readonly runId: string;
  readonly finalizationId: string;
  readonly input: AgentRunStateInput;
  readonly configuration: AgentRunControlConfiguration;
}

export interface AgentRunInspection {
  readonly state: AgentRunState;
  readonly transition: Readonly<{
    readonly eventId: string;
    readonly sequence: number;
    readonly hash: string;
  }>;
  readonly tail: EventLedgerTail;
  readonly instruction: AgentRunInstruction;
}

export interface AgentRunAdvance {
  readonly phase: AgentRunControlPhase;
  readonly providerRequests?: readonly AgentProviderPhase[];
  readonly toolBatches?: readonly AgentToolPhase[];
  readonly budget?: AgentRunBudgetState;
  readonly toolCalls?: readonly ToolCall[];
}

export interface AgentRunProcedureContext {
  readonly state: AgentRunState;
  readonly instruction: Extract<AgentRunInstruction, { readonly kind: 'execute' }>;
  append(event: AgentAuditEvent, idempotencyKey: string): Promise<EventAppendReceipt>;
}

export type AgentRunProcedureExecutor = (
  context: AgentRunProcedureContext
) => AgentRunAdvance | Promise<AgentRunAdvance>;

export type AgentRunDriveResult =
  | Readonly<{ readonly kind: 'advanced'; readonly inspection: AgentRunInspection }>
  | Readonly<{
      readonly kind: 'waiting';
      readonly inspection: AgentRunInspection;
      readonly reason: Extract<AgentRunInstruction, { readonly kind: 'wait' }>['reason'];
    }>
  | Readonly<{ readonly kind: 'complete'; readonly inspection: AgentRunInspection }>;

export class AgentRunConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly reason:
      | 'stale_tail'
      | 'stale_driver'
      | 'idempotency_conflict'
      | 'persistence_not_committed'
      | 'persistence_outcome_unknown',
    message: string
  ) {
    super(message);
    this.name = 'AgentRunConflictError';
  }
}

export class AgentToolStartBlockedError extends Error {
  constructor() {
    super('Tool start is blocked by lifecycle, dependencies, conflicts, concurrency, or fencing.');
    this.name = 'AgentToolStartBlockedError';
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
      providerRequests: [],
      toolBatches: [],
      toolCalls: []
    });
    const expectedTail = await this.events.tail(state.runId);
    if (expectedTail.sequence !== -1) {
      const existing = await this.inspect(state.runId);
      if (
        canonicalJsonString(encodeAgentEvent({ type: 'run.state.changed', state: existing.state })) ===
        canonicalJsonString(encodeAgentEvent({ type: 'run.state.changed', state }))
      )
        return existing;
      throw new AgentRunConflictError(
        state.runId,
        'stale_tail',
        `Run ${state.runId} already contains a different run.`
      );
    }
    const result = await this.events.appendConditional(
      state.runId,
      { type: 'run.state.changed', state },
      {
        idempotencyKey: `${state.runId}:run:accepted`,
        expectedTail,
        driverGeneration: 0
      }
    );
    acceptConditionalResult(state.runId, result);
    return this.inspect(state.runId);
  }

  async inspect(runId: string): Promise<AgentRunInspection> {
    for (;;) {
      const before = await this.events.tail(runId);
      const transition = await this.events.latestOfType(runId, 'run.state.changed');
      const tail = await this.events.tail(runId);
      if (
        before.sequence !== tail.sequence ||
        before.hash !== tail.hash ||
        before.driverGeneration !== tail.driverGeneration
      )
        continue;
      if (transition?.event.type !== 'run.state.changed')
        throw new Error(`Run ${runId} has no durable run.`);
      const state = transition.event.state;
      if (state.runId !== runId || state.driverGeneration !== transition.driverGeneration) {
        throw new Error(`Run ${runId} has a contradictory run transition.`);
      }
      return Object.freeze({
        state,
        transition: Object.freeze({
          eventId: transition.eventId,
          sequence: transition.sequence,
          hash: transition.hash
        }),
        tail,
        instruction: nextAgentRunInstruction(state)
      });
    }
  }

  async listUnfinished(): Promise<readonly AgentRunInspection[]> {
    const unfinished: AgentRunInspection[] = [];
    for (const runId of await this.events.listRunIds()) {
      const transition = await this.events.latestOfType(runId, 'run.state.changed');
      if (
        transition?.event.type !== 'run.state.changed' ||
        transition.event.state.phase.kind === 'terminal'
      )
        continue;
      unfinished.push(await this.inspect(runId));
    }
    return Object.freeze(unfinished);
  }

  async attach(runId: string, driverId = crypto.randomUUID()): Promise<AgentRunDriver> {
    const current = await this.inspect(runId);
    if (current.state.phase.kind === 'terminal') throw new Error(`Run ${runId} is already terminal.`);
    if (
      (current.state.control.status === 'owned' || current.state.control.status === 'abort_requested') &&
      current.state.control.driverId === driverId &&
      current.state.driverGeneration === current.tail.driverGeneration
    ) {
      return new AgentRunDriver(this.events, current.state, current.tail, current.transition, driverId);
    }
    const generation = current.tail.driverGeneration + 1;
    const state = decodeAgentRunState({
      ...current.state,
      revision: current.state.revision + 1,
      driverGeneration: generation,
      control:
        current.state.control.status === 'abort_requested'
          ? { status: 'abort_requested', driverId, reason: current.state.control.reason }
          : { status: 'owned', driverId }
    });
    const result = await this.events.appendConditional(
      runId,
      { type: 'run.state.changed', state },
      {
        idempotencyKey: `${runId}:driver:${String(generation)}`,
        expectedTail: current.tail,
        driverGeneration: generation
      }
    );
    const committed = acceptConditionalResult(runId, result);
    return new AgentRunDriver(this.events, state, committed.tail, committed.receipt, driverId);
  }

  async requestAbort(runId: string, reason: string): Promise<AgentRunInspection> {
    for (;;) {
      const current = await this.inspect(runId);
      if (current.state.phase.kind === 'terminal' || current.state.control.status === 'abort_requested')
        return current;
      const state = decodeAgentRunState({
        ...current.state,
        revision: current.state.revision + 1,
        control: {
          status: 'abort_requested',
          ...(current.state.control.status === 'owned' ? { driverId: current.state.control.driverId } : {}),
          reason
        }
      });
      const result = await this.events.appendConditional(
        runId,
        { type: 'run.state.changed', state },
        {
          idempotencyKey: transitionKey(state),
          expectedTail: current.tail,
          driverGeneration: current.tail.driverGeneration
        }
      );
      if (
        result.kind === 'rejected' &&
        (result.reason === 'stale_tail' || result.reason === 'stale_driver')
      )
        continue;
      acceptConditionalResult(runId, result);
      return this.inspect(runId);
    }
  }

  async settleToolEffect(
    runId: string,
    input: {
      readonly effectId: string;
      readonly permit: EffectSettlementPermit;
      readonly settlement: AgentToolSettlementRecord;
    }
  ): Promise<AgentRunInspection> {
    if (typeof input.effectId !== 'string' || input.effectId.trim().length === 0)
      throw new TypeError('Tool effect identity must be non-empty.');
    const permit = decodeEffectSettlementPermit(input.permit);
    const settlement = decodeAgentToolSettlementRecord(input.settlement);
    for (;;) {
      const current = await this.inspect(runId);
      const batchIndex = current.state.toolBatches.findIndex((batch) =>
        batch.callStates.some(
          (call) =>
            call.stage !== 'ready' &&
            call.stage !== 'approval' &&
            call.effect?.intent.effectId === input.effectId
        )
      );
      const batch = current.state.toolBatches[batchIndex];
      const callIndex =
        batch?.callStates.findIndex(
          (call) =>
            call.stage !== 'ready' &&
            call.stage !== 'approval' &&
            call.effect?.intent.effectId === input.effectId
        ) ?? -1;
      const callState = batch?.callStates[callIndex];
      if (
        callState &&
        callState.stage !== 'ready' &&
        callState.stage !== 'approval' &&
        callState.effect &&
        hashJson(callState.effect.settlementPermit) !== hashJson(permit)
      ) {
        throw new AgentRunConflictError(
          runId,
          'idempotency_conflict',
          `Tool effect ${input.effectId} settlement authority was rejected: permit mismatch.`
        );
      }
      if (
        callState?.stage === 'settled' ||
        callState?.stage === 'recording' ||
        callState?.stage === 'recorded'
      ) {
        if (toolSettlementDigest(callState.settlement) !== toolSettlementDigest(settlement)) {
          throw new AgentRunConflictError(
            runId,
            'idempotency_conflict',
            `Tool effect ${input.effectId} already has a different settlement.`
          );
        }
        return current;
      }
      if (
        !batch ||
        callIndex < 0 ||
        (callState?.stage !== 'effect_pending' && callState?.stage !== 'outcome_unknown') ||
        callState.effect.phase !== 'started'
      ) {
        throw new AgentRunConflictError(
          runId,
          'stale_tail',
          `Tool effect ${input.effectId} is no longer awaiting settlement.`
        );
      }
      const resultDigest = hashJson(encodeToolObservation(settlement.observation));
      const settled = settleExternalEffect(callState.effect, permit, {
        outcome: settlement.observation.ok ? 'succeeded' : 'failed',
        resultDigest,
        exposure: knownEffectExposure(callState.effect.intent.exposure.quantities)
      });
      if (settled.status !== 'settled' && settled.status !== 'already_settled') {
        throw new AgentRunConflictError(
          runId,
          'idempotency_conflict',
          `Tool effect ${input.effectId} settlement authority was rejected: ${settled.status}.`
        );
      }
      const state = decodeAgentRunState({
        ...current.state,
        revision: current.state.revision + 1,
        toolBatches: replaceAt(current.state.toolBatches, batchIndex, {
          ...batch,
          callStates: replaceAt(batch.callStates, callIndex, {
            stage: 'settled',
            plan: callState.plan,
            toolAttempt: callState.toolAttempt,
            effect: settled.state,
            settlement
          })
        })
      });
      const result = await this.events.appendConditional(
        runId,
        { type: 'run.state.changed', state },
        {
          idempotencyKey: `${runId}:tool-effect:${input.effectId}:settled:${resultDigest}`,
          expectedTail: current.tail,
          driverGeneration: current.state.driverGeneration
        }
      );
      if (
        result.kind === 'rejected' &&
        (result.reason === 'stale_tail' || result.reason === 'stale_driver')
      )
        continue;
      acceptConditionalResult(runId, result);
      return this.inspect(runId);
    }
  }
}

export class AgentRunDriver {
  private queue: Promise<void> = Promise.resolve();
  private readonly generation: number;

  constructor(
    private readonly events: EventRepository<AgentEvent>,
    private stateValue: AgentRunState,
    private tailValue: EventLedgerTail,
    private transitionValue: Readonly<{
      readonly eventId: string;
      readonly sequence: number;
      readonly hash: string;
    }>,
    readonly driverId: string
  ) {
    this.generation = stateValue.driverGeneration;
  }

  state(): AgentRunState {
    return this.stateValue;
  }

  drive(execute: AgentRunProcedureExecutor): Promise<AgentRunDriveResult> {
    return this.serial(async () => {
      const inspection = this.inspection();
      if (inspection.instruction.kind === 'complete')
        return Object.freeze({ kind: 'complete', inspection });
      if (inspection.instruction.kind === 'wait')
        return Object.freeze({ kind: 'waiting', inspection, reason: inspection.instruction.reason });
      const advance = await execute(
        Object.freeze({
          state: this.stateValue,
          instruction: inspection.instruction,
          append: (event: AgentAuditEvent, idempotencyKey: string) => this.appendNow(event, idempotencyKey)
        })
      );
      const next = await this.transitionNow(
        inspection.instruction.procedure,
        advance,
        inspection.instruction.target
      );
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

  transition(
    procedure: AgentRunProcedure,
    update: AgentRunAdvance | ((state: AgentRunState) => AgentRunAdvance),
    target?: AgentRunTarget
  ): Promise<AgentRunInspection> {
    return this.serial(async () => {
      for (;;) {
        await this.refresh();
        const advance = typeof update === 'function' ? update(this.stateValue) : update;
        try {
          return await this.transitionNow(procedure, advance, target);
        } catch (error) {
          if (
            typeof update === 'function' &&
            error instanceof AgentRunConflictError &&
            error.reason === 'stale_tail' &&
            (this.stateValue.control.status === 'owned' ||
              this.stateValue.control.status === 'abort_requested') &&
            this.stateValue.control.driverId === this.driverId
          )
            continue;
          throw error;
        }
      }
    });
  }

  transitionTool(
    procedure: AgentRunProcedure,
    target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>,
    update: (call: AgentToolCallState, batch: AgentToolPhase, state: AgentRunState) => AgentToolCallState,
    budget?: AgentRunBudgetState
  ): Promise<AgentRunInspection> {
    return this.transition(
      procedure,
      (state) => {
        const batch = toolWork(state, target);
        const call = batch.callStates[target.callIndex];
        if (!call) throw new TypeError('Tool target is missing.');
        const next = update(call, batch, state);
        return {
          phase: state.phase,
          toolBatches: replaceAt(state.toolBatches, state.toolBatches.indexOf(batch), {
            ...batch,
            callStates: replaceAt(batch.callStates, target.callIndex, next)
          }),
          ...(budget ? { budget } : {})
        };
      },
      { kind: 'tool', ...target }
    );
  }

  transitionProvider(
    procedure: AgentRunProcedure,
    target: Pick<AgentProviderTarget, 'turnId' | 'requestAttempt'>,
    update: (request: AgentProviderPhase, state: AgentRunState) => AgentProviderPhase,
    budget?: AgentRunBudgetState
  ): Promise<AgentRunInspection> {
    return this.transition(
      procedure,
      (state) => {
        const request = providerWork(state, target);
        return {
          phase: state.phase,
          providerRequests: replaceAt(
            state.providerRequests,
            state.providerRequests.indexOf(request),
            update(request, state)
          ),
          ...(budget ? { budget } : {})
        };
      },
      { kind: 'provider', ...target }
    );
  }

  recordToolDelivery(
    target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>,
    delivery: AgentToolResultDelivery
  ): Promise<AgentRunInspection> {
    const owned = decodeToolResultDelivery(delivery);
    return this.transitionTool('record_tool_delivery', target, (call) => {
      if (call.stage !== 'recorded') throw new TypeError('Only a recorded observation can be delivered.');
      return Object.freeze({ ...call, delivery: owned });
    });
  }

  decideApproval(input: {
    readonly approvalId: string;
    readonly fingerprint: string;
    readonly decision: 'allow' | 'deny';
  }): Promise<AgentRunInspection> {
    return this.serial(async () => {
      await this.refresh();
      this.assertTransitionAuthority(this.stateValue.phase);
      const batch = this.stateValue.toolBatches.find((item) =>
        item.callStates.some(
          (call) => call.stage === 'approval' && call.approval.approvalId === input.approvalId
        )
      );
      const callIndex =
        batch?.callStates.findIndex(
          (call) => call.stage === 'approval' && call.approval.approvalId === input.approvalId
        ) ?? -1;
      const call = batch?.callStates[callIndex];
      if (!batch || call?.stage !== 'approval')
        throw new TypeError(
          `Run ${this.stateValue.runId} is not waiting for approval ${input.approvalId}.`
        );
      if (call.approval.fingerprint !== input.fingerprint)
        throw new TypeError(`Approval fingerprint mismatch for ${input.approvalId}.`);
      return this.commitState({
        phase:
          this.stateValue.phase.kind === 'suspended' && this.stateValue.phase.reason === 'approval'
            ? { kind: 'active' }
            : this.stateValue.phase,
        toolBatches: replaceAt(this.stateValue.toolBatches, this.stateValue.toolBatches.indexOf(batch), {
          ...batch,
          callStates: replaceAt(
            batch.callStates,
            callIndex,
            Object.freeze({
              stage: 'ready',
              approved: Object.freeze({ approval: call.approval, decision: input.decision })
            })
          )
        })
      });
    });
  }

  requestAbort(reason: string): Promise<AgentRunInspection> {
    return this.serial(async () => {
      if (reason.trim().length === 0) throw new TypeError('Abort reason must not be empty.');
      for (;;) {
        await this.refresh();
        if (
          this.stateValue.phase.kind === 'terminal' ||
          this.stateValue.control.status === 'abort_requested'
        )
          return this.inspection();
        if (
          this.stateValue.control.status !== 'owned' ||
          this.stateValue.control.driverId !== this.driverId
        ) {
          throw new AgentRunConflictError(
            this.stateValue.runId,
            'stale_driver',
            `Driver ${this.driverId} cannot abort run ${this.stateValue.runId}.`
          );
        }
        const state = decodeAgentRunState({
          ...this.stateValue,
          revision: this.stateValue.revision + 1,
          control: { status: 'abort_requested', driverId: this.driverId, reason }
        });
        const result = await this.events.appendConditional(
          state.runId,
          { type: 'run.state.changed', state },
          {
            idempotencyKey: transitionKey(state),
            expectedTail: this.tailValue,
            driverGeneration: state.driverGeneration
          }
        );
        if (result.kind === 'rejected' && result.reason === 'stale_tail') continue;
        if (result.kind === 'rejected' && result.reason === 'stale_driver') await this.refresh();
        const committed = acceptConditionalResult(state.runId, result);
        this.stateValue = state;
        this.tailValue = committed.tail;
        this.transitionValue = committed.receipt;
        return this.inspection();
      }
    });
  }

  private async appendNow(event: AgentAuditEvent, idempotencyKey: string): Promise<EventAppendReceipt> {
    this.assertEventAuthority(event);
    const result = await this.events.appendConditional(this.stateValue.runId, event, {
      idempotencyKey,
      expectedTail: this.tailValue,
      driverGeneration: this.stateValue.driverGeneration
    });
    if (result.kind === 'rejected' && (result.reason === 'stale_tail' || result.reason === 'stale_driver'))
      await this.refresh();
    const committed = acceptConditionalResult(this.stateValue.runId, result);
    this.tailValue = committed.tail;
    return committed.receipt;
  }

  private async transitionNow(
    procedure: AgentRunProcedure,
    advance: AgentRunAdvance,
    target?: AgentRunTarget
  ): Promise<AgentRunInspection> {
    this.assertTransitionAuthority(advance.phase);
    if (!advanceMatchesProcedure(procedure, advance.phase)) {
      throw new TypeError(`Procedure ${procedure} cannot advance to ${advance.phase.kind}.`);
    }
    assertWorkAdvance(this.stateValue, advance, procedure, target);
    if (procedure === 'record_tool_observation') {
      let budget = advance.budget ?? this.stateValue.budget;
      if (budget) {
        for (const batch of advance.toolBatches ?? []) {
          const previous = this.stateValue.toolBatches.find(
            (item) => item.toolBatchId === batch.toolBatchId
          );
          for (const [index, call] of batch.callStates.entries()) {
            if (call.stage === 'recorded' && previous?.callStates[index]?.stage === 'recording') {
              budget = {
                ...budget,
                consecutiveToolFailures: call.settlement.observation.ok
                  ? 0
                  : budget.consecutiveToolFailures + 1
              };
            }
          }
        }
        return this.commitState({ ...advance, budget });
      }
    }
    return this.commitState(advance);
  }

  private async commitState(advance: AgentRunAdvance): Promise<AgentRunInspection> {
    const state = decodeAgentRunState({
      ...this.stateValue,
      revision: this.stateValue.revision + 1,
      phase: advance.phase,
      providerRequests: advance.providerRequests ?? this.stateValue.providerRequests,
      toolBatches: advance.toolBatches ?? this.stateValue.toolBatches,
      toolCalls: advance.toolCalls ?? this.stateValue.toolCalls,
      ...(advance.budget === undefined
        ? this.stateValue.budget === undefined
          ? {}
          : { budget: this.stateValue.budget }
        : { budget: advance.budget })
    });
    const result = await this.events.appendConditional(
      state.runId,
      { type: 'run.state.changed', state },
      {
        idempotencyKey: transitionKey(state),
        expectedTail: this.tailValue,
        driverGeneration: state.driverGeneration
      }
    );
    if (result.kind === 'rejected' && (result.reason === 'stale_tail' || result.reason === 'stale_driver'))
      await this.refresh();
    const committed = acceptConditionalResult(state.runId, result);
    this.stateValue = state;
    this.tailValue = committed.tail;
    this.transitionValue = committed.receipt;
    return this.inspection();
  }

  private inspection(): AgentRunInspection {
    return Object.freeze({
      state: this.stateValue,
      transition: Object.freeze({
        eventId: this.transitionValue.eventId,
        sequence: this.transitionValue.sequence,
        hash: this.transitionValue.hash
      }),
      tail: this.tailValue,
      instruction: nextAgentRunInstruction(this.stateValue)
    });
  }

  private async refresh(): Promise<void> {
    const current = await new AgentRunCoordinator(this.events).inspect(this.stateValue.runId);
    this.stateValue = current.state;
    this.tailValue = current.tail;
    this.transitionValue = current.transition;
  }

  private assertEventAuthority(event: AgentAuditEvent): void {
    const control = this.stateValue.control;
    if (
      control.status === 'detached' ||
      control.driverId !== this.driverId ||
      this.stateValue.driverGeneration !== this.generation ||
      (control.status === 'abort_requested' && !abortAdministrativeEvent(event))
    ) {
      throw new AgentRunConflictError(
        this.stateValue.runId,
        'stale_driver',
        `Driver ${this.driverId} cannot append work for run ${this.stateValue.runId}.`
      );
    }
  }

  private assertTransitionAuthority(nextPhase: AgentRunControlPhase): void {
    if (this.stateValue.phase.kind === 'terminal')
      throw new AgentRunConflictError(
        this.stateValue.runId,
        'stale_driver',
        'A terminal run cannot advance.'
      );
    if (
      (this.stateValue.control.status !== 'owned' &&
        this.stateValue.control.status !== 'abort_requested') ||
      this.stateValue.control.driverId !== this.driverId ||
      this.stateValue.driverGeneration !== this.generation
    ) {
      throw new AgentRunConflictError(
        this.stateValue.runId,
        'stale_driver',
        `Driver ${this.driverId} does not own run ${this.stateValue.runId}.`
      );
    }
    if (
      this.stateValue.control.status === 'abort_requested' &&
      nextPhase.kind !== 'cancelling' &&
      nextPhase.kind !== 'finalization' &&
      nextPhase.kind !== 'terminal'
    ) {
      throw new AgentRunConflictError(
        this.stateValue.runId,
        'stale_driver',
        `Run ${this.stateValue.runId} is aborting and cannot advance to ${nextPhase.kind}.`
      );
    }
  }

  private serial<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function acceptConditionalResult(
  runId: string,
  result: ConditionalEventAppendResult
): Extract<
  ConditionalEventAppendResult,
  { readonly kind: 'committed' | 'already_committed' | 'committed_index_unknown' }
> {
  if (
    result.kind === 'committed' ||
    result.kind === 'already_committed' ||
    result.kind === 'committed_index_unknown'
  )
    return result;
  if (result.kind === 'rejected')
    throw new AgentRunConflictError(
      runId,
      result.reason,
      `Run write for ${runId} was rejected: ${result.reason}.`
    );
  if (result.kind === 'not_committed')
    throw new AgentRunConflictError(
      runId,
      'persistence_not_committed',
      `Run write for ${runId} was not committed: ${result.failure.message}`
    );
  throw new AgentRunConflictError(
    runId,
    'persistence_outcome_unknown',
    `Run write outcome for ${runId} is unknown: ${result.failure.message}`
  );
}

function transitionKey(state: AgentRunState): string {
  return `${state.runId}:run:revision:${String(state.revision)}:${hashJson(encodeAgentEvent({ type: 'run.state.changed', state }))}`;
}

function toolSettlementDigest(settlement: AgentToolSettlementRecord): string {
  return hashJson(
    Object.freeze({
      observationId: settlement.observationId,
      observation: encodeToolObservation(settlement.observation),
      createdAt: settlement.createdAt
    })
  );
}

function abortAdministrativeEvent(event: AgentAuditEvent): boolean {
  return (
    event.type === 'context.transition.requested' ||
    event.type === 'context.transition.admitted' ||
    event.type === 'context.transition.completed' ||
    event.type === 'context.transition.rejected' ||
    event.type === 'run.finalization.staged' ||
    event.type === 'run.ended' ||
    event.type === 'delivery.failed' ||
    event.type === 'resource.released' ||
    (event.type === 'run.phase.changed' && event.phase === 'finalizing')
  );
}

function advanceMatchesProcedure(procedure: AgentRunProcedure, phase: AgentRunControlPhase): boolean {
  switch (procedure) {
    case 'initialize_run':
      return phase.kind === 'initializing' || phase.kind === 'finalization';
    case 'assemble_turn':
      return phase.kind === 'active' || phase.kind === 'finalization' || phase.kind === 'cancelling';
    case 'authorize_provider_request':
    case 'start_provider_request':
    case 'reconcile_provider_request':
    case 'consume_provider_settlement':
    case 'plan_tool_call':
    case 'start_tool_call':
    case 'reconcile_tool_call':
    case 'begin_observation_recording':
    case 'record_tool_observation':
    case 'record_tool_delivery':
    case 'advance_after_tools':
      return (
        phase.kind === 'active' ||
        phase.kind === 'suspended' ||
        phase.kind === 'cancelling' ||
        phase.kind === 'initializing' ||
        phase.kind === 'finalization'
      );
    case 'finalize':
    case 'reconcile_finalization':
      return phase.kind === 'finalization' || phase.kind === 'terminal';
    case 'finalize_abort':
      return phase.kind === 'cancelling' || phase.kind === 'finalization' || phase.kind === 'terminal';
  }
}

function assertWorkAdvance(
  state: AgentRunState,
  advance: AgentRunAdvance,
  procedure: AgentRunProcedure,
  target?: AgentRunTarget
): void {
  const batches = advance.toolBatches ?? state.toolBatches;
  const requests = advance.providerRequests ?? state.providerRequests;
  for (const batch of state.toolBatches) {
    const next = batches.find((item) => item.toolBatchId === batch.toolBatchId);
    if (!next) throw new TypeError('Retained tool work cannot be removed.');
    const { callStates: oldStates, ...source } = batch;
    const { callStates: nextStates, ...nextSource } = next;
    if (hashJson(source) !== hashJson(nextSource))
      throw new TypeError('Original tool source cannot change.');
    for (const [callIndex, call] of oldStates.entries()) {
      const updated = nextStates[callIndex];
      if (!updated) throw new TypeError('Retained call cannot be removed.');
      if (hashJson(call) === hashJson(updated)) continue;
      if (
        target &&
        (target.kind !== 'tool' ||
          target.toolBatchId !== batch.toolBatchId ||
          target.callIndex !== callIndex)
      ) {
        throw new TypeError('Targeted transition changed unrelated tool work.');
      }
      if (
        procedure === 'plan_tool_call' &&
        (state.phase.kind !== 'active' ||
          state.toolBatches.some((item) => item.callStates.some((entry) => entry.stage === 'approval')))
      ) {
        throw new TypeError('Tool admission is quiesced for this run.');
      }
      assertToolAdvance(procedure, call, updated);
      if (updated.stage === 'effect_pending' && call.stage === 'effect_ready') {
        if (
          state.phase.kind !== 'active' ||
          state.control.status !== 'owned' ||
          state.toolBatches.some((item) => item.callStates.some((entry) => entry.stage === 'approval')) ||
          !isToolCallStartable(batch, callIndex, state.driverGeneration, state.toolBatches)
        ) {
          throw new AgentToolStartBlockedError();
        }
      }
    }
  }
  for (const request of state.providerRequests) {
    const next = requests.find(
      (item) =>
        item.identity.turnId === request.identity.turnId &&
        item.identity.requestAttempt === request.identity.requestAttempt
    );
    if (!next) throw new TypeError('Retained provider work cannot be removed.');
    if (
      hashJson(request.identity) !== hashJson(next.identity) ||
      request.toolBatchId !== next.toolBatchId
    ) {
      throw new TypeError('Original provider identity cannot change.');
    }
    if (hashJson(request) === hashJson(next)) continue;
    if (
      target &&
      (target.kind !== 'provider' ||
        target.turnId !== request.identity.turnId ||
        target.requestAttempt !== request.identity.requestAttempt)
    )
      throw new TypeError('Targeted transition changed unrelated provider work.');
    assertProviderAdvance(procedure, request, next, state.driverGeneration);
  }
}

function assertToolAdvance(
  procedure: AgentRunProcedure,
  previous: AgentToolCallState,
  next: AgentToolCallState
): void {
  const valid =
    procedure === 'plan_tool_call'
      ? previous.stage === 'ready' && ['effect_ready', 'settled', 'approval'].includes(next.stage)
      : procedure === 'start_tool_call'
        ? previous.stage === 'effect_ready' &&
          ['effect_pending', 'ready', 'settled', 'approval', 'cancelled'].includes(next.stage)
        : procedure === 'begin_observation_recording'
          ? previous.stage === 'settled' && next.stage === 'recording'
          : procedure === 'record_tool_observation'
            ? previous.stage === 'recording' && next.stage === 'recorded'
            : procedure === 'record_tool_delivery'
              ? previous.stage === 'recorded' && next.stage === 'recorded'
              : procedure === 'reconcile_tool_call'
                ? ['effect_ready', 'effect_pending', 'outcome_unknown'].includes(previous.stage) &&
                  ['effect_ready', 'outcome_unknown', 'settled', 'cancelled'].includes(next.stage)
                : procedure === 'finalize_abort'
                  ? !['recorded', 'cancelled'].includes(previous.stage) &&
                    ['cancelled', 'outcome_unknown', 'settled', 'recorded'].includes(next.stage)
                  : false;
  if (!valid)
    throw new TypeError(`Procedure ${procedure} cannot change tool ${previous.stage} to ${next.stage}.`);
  if (procedure === 'record_tool_delivery' && previous.stage === 'recorded' && next.stage === 'recorded') {
    const { delivery: oldDelivery, ...oldRecord } = previous;
    const { delivery: newDelivery, ...newRecord } = next;
    if (!newDelivery || hashJson(oldRecord) !== hashJson(newRecord)) {
      throw new TypeError('Delivery cannot change the original observation.');
    }
    if (oldDelivery) {
      const sameIdentity =
        oldDelivery.deliveryId === newDelivery.deliveryId &&
        oldDelivery.inputIdentity === newDelivery.inputIdentity &&
        oldDelivery.targetResponseId === newDelivery.targetResponseId;
      if (!sameIdentity && oldDelivery.status !== 'failed' && oldDelivery.status !== 'admitted') {
        throw new TypeError('A submitted or uncertain result cannot be automatically redelivered.');
      }
      if (!sameIdentity && newDelivery.status !== 'admitted')
        throw new TypeError('A new result delivery requires admission.');
      const allowed: Readonly<
        Record<AgentToolResultDelivery['status'], readonly AgentToolResultDelivery['status'][]>
      > = {
        admitted: ['admitted', 'submitted', 'acknowledged', 'applied', 'failed', 'uncertain'],
        submitted: ['submitted', 'acknowledged', 'applied', 'failed', 'uncertain'],
        acknowledged: ['acknowledged', 'applied', 'failed', 'uncertain'],
        applied: ['applied'],
        failed: ['failed'],
        uncertain: ['uncertain', 'acknowledged', 'applied', 'failed']
      };
      if (sameIdentity && !allowed[oldDelivery.status].includes(newDelivery.status))
        throw new TypeError('Result delivery evidence cannot regress.');
      if (
        oldDelivery.successorResponseId &&
        oldDelivery.successorResponseId !== newDelivery.successorResponseId
      ) {
        throw new TypeError('Result delivery application identity cannot change.');
      }
    }
  }
  if (
    (procedure === 'begin_observation_recording' || procedure === 'record_tool_observation') &&
    (previous.stage === 'settled' || previous.stage === 'recording') &&
    (next.stage === 'recording' || next.stage === 'recorded')
  ) {
    const { stage: oldStage, ...oldRecord } = previous;
    const { stage: newStage, ...newRecord } = next;
    if (oldStage === newStage || hashJson(oldRecord) !== hashJson(newRecord))
      throw new TypeError('Recording cannot change the settled observation or effect.');
  }
  if (previous.stage === 'effect_ready' && next.stage === 'effect_pending') {
    if (
      hashJson(previous.effect.intent) !== hashJson(next.effect.intent) ||
      hashJson(previous.effect.ticket) !== hashJson(next.effect.ticket) ||
      hashJson(previous.effect.settlementPermit) !== hashJson(next.effect.settlementPermit) ||
      hashJson(previous.plan) !== hashJson(next.plan) ||
      previous.toolAttempt !== next.toolAttempt
    ) {
      throw new TypeError('Tool start must consume the exact issued ticket and plan.');
    }
  }
}

function assertProviderAdvance(
  procedure: AgentRunProcedure,
  previous: AgentProviderPhase,
  next: AgentProviderPhase,
  generation: number
): void {
  const valid =
    procedure === 'authorize_provider_request'
      ? previous.stage === 'ready' && next.stage === 'effect_ready'
      : procedure === 'start_provider_request'
        ? previous.stage === 'effect_ready' && ['effect_pending', 'outcome_unknown'].includes(next.stage)
        : procedure === 'reconcile_provider_request'
          ? ['effect_pending', 'effect_ready'].includes(previous.stage) &&
            ['settled', 'outcome_unknown', 'effect_ready'].includes(next.stage)
          : procedure === 'consume_provider_settlement'
            ? previous.stage === 'settled' && next.stage === 'consumed'
            : procedure === 'finalize_abort'
              ? next.stage === 'outcome_unknown'
              : false;
  if (!valid)
    throw new TypeError(
      `Procedure ${procedure} cannot change provider ${previous.stage} to ${next.stage}.`
    );
  if (next.stage === 'effect_pending' && next.effect.ticket.driverGeneration !== generation)
    throw new TypeError('Provider start belongs to a stale driver.');
  if (
    previous.stage !== 'ready' &&
    next.stage !== 'ready' &&
    (previous.requestEventId !== next.requestEventId ||
      previous.responseId !== next.responseId ||
      hashJson(previous.effect.intent) !== hashJson(next.effect.intent))
  )
    throw new TypeError('Provider source and intent cannot change.');
}

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  if (index < 0 || index >= values.length)
    throw new TypeError(`Cannot replace missing item ${String(index)}.`);
  const next = [...values];
  next[index] = value;
  return Object.freeze(next);
}
