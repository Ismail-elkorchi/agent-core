import { AgentRunRecords, AgentRunRecordStorageError } from './records.js';
import type { ArtifactRepository } from '@agent-core/persistence';
import { assertAgentRunStateInvariants } from './state-invariants.js';
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
import { encodeToolObservation } from '@agent-core/tools';
import type { AgentAuditEvent, AgentEvent } from '../../events.js';
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
  applyAgentRunStateTransition,
  createAgentRunStateTransition,
  type AgentRunStateTransition
} from './state-transition.js';
import {
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
  private readonly records: AgentRunRecords;
  private lastInspection: AgentRunInspection | undefined;
  constructor(
    private readonly events: EventRepository<AgentEvent>,
    readonly artifacts: ArtifactRepository
  ) {
    this.records = new AgentRunRecords(artifacts);
  }

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
      toolBatches: []
    });
    const expectedTail = await this.events.tail(state.runId);
    if (expectedTail.sequence !== -1) {
      const existing = await this.inspect(state.runId);
      if (canonicalJsonString(existing.state) === canonicalJsonString(state)) return existing;
      throw new AgentRunConflictError(
        state.runId,
        'stale_tail',
        `Run ${state.runId} already contains a different run.`
      );
    }
    const result = await this.events.appendConditional(
      state.runId,
      await transitionEvent(undefined, state, this.records),
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
      const cached = this.lastInspection?.state.runId === runId ? this.lastInspection : undefined;
      if (
        cached?.tail.sequence === before.sequence &&
        cached.tail.hash === before.hash &&
        cached.tail.driverGeneration === before.driverGeneration
      )
        return cached;
      let state = cached?.state;
      let transition = cached?.transition;
      let cursor = cached?.tail.sequence ?? -1;
      for (;;) {
        const page = await this.events.readRange(runId, {
          afterSequence: cursor,
          through: before,
          types: ['run.state.transitioned']
        });
        if (page.oversized) throw new Error('Run transition exceeds its independent record bound.');
        for (const record of page.records) {
          if (record.event.type !== 'run.state.transitioned') continue;
          state = await applyAgentRunStateTransition(state, record.event.transition, this.records);
          if (state.runId !== runId || state.driverGeneration !== record.driverGeneration)
            throw new Error(`Run ${runId} has a contradictory run transition.`);
          transition = record;
        }
        if (page.complete) break;
        if (page.nextSequence <= cursor)
          throw new Error('Run transition recovery made no progress.');
        cursor = page.nextSequence;
      }
      const tail = await this.events.tail(runId);
      if (
        before.sequence !== tail.sequence ||
        before.hash !== tail.hash ||
        before.driverGeneration !== tail.driverGeneration
      )
        continue;
      if (!transition || !state) throw new Error(`Run ${runId} has no durable run.`);
      this.lastInspection = Object.freeze({
        state,
        transition: Object.freeze({
          eventId: transition.eventId,
          sequence: transition.sequence,
          hash: transition.hash
        }),
        tail,
        instruction: nextAgentRunInstruction(state)
      });
      return this.lastInspection;
    }
  }

  async listUnfinished(): Promise<readonly AgentRunInspection[]> {
    const unfinished: AgentRunInspection[] = [];
    for (const runId of await this.events.listRunIds()) {
      const run = await this.inspect(runId);
      if (run.state.phase.kind !== 'terminal') unfinished.push(run);
    }
    return Object.freeze(unfinished);
  }

  async attach(runId: string, driverId = crypto.randomUUID()): Promise<AgentRunDriver> {
    const current = await this.inspect(runId);
    if (current.state.phase.kind === 'terminal')
      throw new Error(`Run ${runId} is already terminal.`);
    if (
      (current.state.control.status === 'owned' ||
        current.state.control.status === 'abort_requested') &&
      current.state.control.driverId === driverId &&
      current.state.driverGeneration === current.tail.driverGeneration
    ) {
      return new AgentRunDriver(
        this.events,
        this.artifacts,
        current.state,
        current.tail,
        current.transition,
        driverId
      );
    }
    const generation = current.tail.driverGeneration + 1;
    const state: AgentRunState = Object.freeze({
      ...current.state,
      revision: current.state.revision + 1,
      driverGeneration: generation,
      control:
        current.state.control.status === 'abort_requested'
          ? Object.freeze({
              status: 'abort_requested' as const,
              driverId,
              reason: current.state.control.reason
            })
          : Object.freeze({ status: 'owned' as const, driverId })
    });
    const result = await this.events.appendConditional(
      runId,
      await transitionEvent(current.state, state, this.records),
      {
        idempotencyKey: `${runId}:driver:${String(generation)}`,
        expectedTail: current.tail,
        driverGeneration: generation
      }
    );
    const committed = acceptConditionalResult(runId, result);
    return new AgentRunDriver(
      this.events,
      this.artifacts,
      state,
      committed.tail,
      committed.receipt,
      driverId
    );
  }

  async requestAbort(runId: string, reason: string): Promise<AgentRunInspection> {
    for (;;) {
      const current = await this.inspect(runId);
      if (
        current.state.phase.kind === 'terminal' ||
        current.state.control.status === 'abort_requested'
      )
        return current;
      const state: AgentRunState = Object.freeze({
        ...current.state,
        revision: current.state.revision + 1,
        control: {
          status: 'abort_requested' as const,
          ...(current.state.control.status === 'owned'
            ? { driverId: current.state.control.driverId }
            : {}),
          reason
        }
      });
      const event = await transitionEvent(current.state, state, this.records);
      const result = await this.events.appendConditional(runId, event, {
        idempotencyKey: transitionKey(state, event.transition),
        expectedTail: current.tail,
        driverGeneration: current.tail.driverGeneration
      });
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
    const settlement = input.settlement;
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
      if (!callState) {
        const committed = await this.findToolSettlement(runId, input.effectId);
        if (committed) {
          if (
            hashJson(committed.effect.settlementPermit) !== hashJson(permit) ||
            toolSettlementDigest(committed.settlement) !== toolSettlementDigest(settlement)
          )
            throw new AgentRunConflictError(
              runId,
              'idempotency_conflict',
              'Historical effect settlement does not match its immutable permit and observation.'
            );
          return current;
        }
      }
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
      const resultDigest = settlement.original.digest;
      const execution = settlement.original.execution;
      const uncertain = execution?.state === 'unknown';
      // Settlement confirms the invocation boundary. Process/check/task outcomes remain in
      // the observation; active processes retain their separate owner and transferred lease.
      const settled = uncertain
        ? undefined
        : settleExternalEffect(callState.effect, permit, {
            outcome: 'succeeded',
            resultDigest,
            exposure: knownEffectExposure(callState.effect.intent.exposure.quantities)
          });
      if (settled && settled.status !== 'settled' && settled.status !== 'already_settled') {
        throw new AgentRunConflictError(
          runId,
          'idempotency_conflict',
          `Tool effect ${input.effectId} settlement authority was rejected: ${settled.status}.`
        );
      }
      const state: AgentRunState = Object.freeze({
        ...current.state,
        revision: current.state.revision + 1,
        toolBatches: replaceAt(current.state.toolBatches, batchIndex, {
          ...batch,
          callStates: replaceAt(
            batch.callStates,
            callIndex,
            settled
              ? {
                  stage: 'settled',
                  plan: callState.plan,
                  toolAttempt: callState.toolAttempt,
                  effect: settled.state,
                  settlement
                }
              : {
                  stage: 'outcome_unknown',
                  plan: callState.plan,
                  toolAttempt: callState.toolAttempt,
                  effect: callState.effect
                }
          )
        })
      });
      let event: Extract<AgentEvent, { readonly type: 'run.state.transitioned' }>;
      try {
        event = await transitionEvent(current.state, state, this.records);
      } catch (error) {
        if (error instanceof AgentRunRecordStorageError) {
          const loss = await this.events.appendConditional(
            runId,
            {
              type: 'run.record.unavailable',
              runId,
              effectId: input.effectId,
              resultDigest,
              message: error.message
            },
            {
              expectedTail: current.tail,
              driverGeneration: current.state.driverGeneration,
              idempotencyKey: `${runId}:tool-effect:${input.effectId}:record-unavailable:${resultDigest}`
            }
          );
          acceptConditionalResult(runId, loss);
        }
        throw error;
      }
      const result = await this.events.appendConditional(runId, event, {
        idempotencyKey: `${runId}:tool-effect:${input.effectId}:settled:${resultDigest}`,
        expectedTail: current.tail,
        driverGeneration: current.state.driverGeneration
      });
      if (
        result.kind === 'rejected' &&
        (result.reason === 'stale_tail' || result.reason === 'stale_driver')
      )
        continue;
      acceptConditionalResult(runId, result);
      return this.inspect(runId);
    }
  }
  private async findToolSettlement(
    runId: string,
    effectId: string
  ): Promise<
    | (Extract<AgentToolCallState, { readonly stage: 'settled' | 'recording' | 'recorded' }> & {
        readonly effect: NonNullable<
          Extract<AgentToolCallState, { readonly stage: 'settled' }>['effect']
        >;
      })
    | undefined
  > {
    const through = await this.events.tail(runId);
    let cursor = -1;
    for (;;) {
      const page = await this.events.readRange(runId, {
        afterSequence: cursor,
        through,
        types: ['run.state.transitioned']
      });
      if (page.oversized)
        throw new Error('Historical settlement transition exceeds its record bound.');
      for (const event of page.records) {
        if (
          event.event.type !== 'run.state.transitioned' ||
          event.event.transition.kind !== 'updated'
        )
          continue;
        for (const entry of event.event.transition.toolRecords ?? []) {
          const batch = await this.records.loadTools(runId, entry.value);
          for (const call of batch.callStates)
            if (
              (call.stage === 'settled' ||
                call.stage === 'recording' ||
                call.stage === 'recorded') &&
              call.effect?.intent.effectId === effectId
            )
              return { ...call, effect: call.effect };
        }
      }
      if (page.complete) return undefined;
      if (page.nextSequence <= cursor)
        throw new Error('Historical settlement lookup made no progress.');
      cursor = page.nextSequence;
    }
  }
}

export class AgentRunDriver {
  private readonly coordinator: AgentRunCoordinator;
  private queue: Promise<void> = Promise.resolve();
  private readonly generation: number;

  constructor(
    private readonly events: EventRepository<AgentEvent>,
    readonly artifacts: ArtifactRepository,
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
    this.coordinator = new AgentRunCoordinator(events, artifacts);
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
        return Object.freeze({
          kind: 'waiting',
          inspection,
          reason: inspection.instruction.reason
        });
      const advance = await execute(
        Object.freeze({
          state: this.stateValue,
          instruction: inspection.instruction,
          append: (event: AgentAuditEvent, idempotencyKey: string) =>
            this.appendNow(event, idempotencyKey)
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
      await this.coordinator.settleToolEffect(this.stateValue.runId, input);
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

  resumeContextAdmission(input: {
    readonly expectedRevision: number;
    readonly inputIdentity: string;
  }): Promise<AgentRunInspection> {
    return this.serial(async () => {
      await this.refresh();
      const state = this.stateValue;
      if (
        state.revision !== input.expectedRevision ||
        state.phase.kind !== 'suspended' ||
        state.phase.reason !== 'context_admission'
      )
        throw new AgentRunConflictError(
          state.runId,
          'stale_tail',
          'Context suspension changed during admission.'
        );
      if (
        state.providerRequests.some(
          (request) => request.stage !== 'ready' && request.stage !== 'consumed'
        ) ||
        state.toolBatches.some(
          (batch) =>
            !batch.callStates.every(
              (call) =>
                call.stage === 'resolved' || call.stage === 'cancelled' || call.stage === 'recorded'
            )
        )
      )
        throw new Error('Context admission cannot bypass unresolved provider or tool obligations.');
      this.assertTransitionAuthority({
        kind: 'initializing',
        step: 'assemble_turn',
        turnIndex: state.phase.turnIndex
      });
      return this.commitState({
        phase: { kind: 'initializing', step: 'assemble_turn', turnIndex: state.phase.turnIndex },
        providerRequests: []
      });
    });
  }

  recordBudget(
    update: (budget: AgentRunBudgetState | undefined) => AgentRunBudgetState
  ): Promise<AgentRunInspection> {
    return this.serial(async () => {
      await this.refresh();
      this.assertTransitionAuthority(this.stateValue.phase);
      return this.commitState({
        phase: this.stateValue.phase,
        budget: update(this.stateValue.budget)
      });
    });
  }

  transitionTool(
    procedure: AgentRunProcedure,
    target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>,
    update: (
      call: AgentToolCallState,
      batch: AgentToolPhase,
      state: AgentRunState
    ) => AgentToolCallState,
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
      if (call.stage !== 'recorded')
        throw new TypeError('Only a recorded observation can be delivered.');
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
        toolBatches: replaceAt(
          this.stateValue.toolBatches,
          this.stateValue.toolBatches.indexOf(batch),
          {
            ...batch,
            callStates: replaceAt(
              batch.callStates,
              callIndex,
              Object.freeze({
                stage: 'ready',
                approved: Object.freeze({ approval: call.approval, decision: input.decision })
              })
            )
          }
        )
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
        const state: AgentRunState = Object.freeze({
          ...this.stateValue,
          revision: this.stateValue.revision + 1,
          control: Object.freeze({
            status: 'abort_requested' as const,
            driverId: this.driverId,
            reason
          })
        });
        assertAgentRunStateInvariants(state);
        const event = await transitionEvent(
          this.stateValue,
          state,
          new AgentRunRecords(this.artifacts)
        );
        const result = await this.events.appendConditional(state.runId, event, {
          idempotencyKey: transitionKey(state, event.transition),
          expectedTail: this.tailValue,
          driverGeneration: state.driverGeneration
        });
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

  private async appendNow(
    event: AgentAuditEvent,
    idempotencyKey: string
  ): Promise<EventAppendReceipt> {
    this.assertEventAuthority(event);
    const result = await this.events.appendConditional(this.stateValue.runId, event, {
      idempotencyKey,
      expectedTail: this.tailValue,
      driverGeneration: this.stateValue.driverGeneration
    });
    if (
      result.kind === 'rejected' &&
      (result.reason === 'stale_tail' || result.reason === 'stale_driver')
    )
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
    return this.commitState(advance);
  }

  private async commitState(advance: AgentRunAdvance): Promise<AgentRunInspection> {
    const requests = advance.providerRequests ?? this.stateValue.providerRequests;
    const batches = advance.toolBatches ?? this.stateValue.toolBatches;
    const releaseCompleted =
      advance.phase.kind === 'initializing' ||
      advance.phase.kind === 'finalization' ||
      advance.phase.kind === 'terminal' ||
      requests.some(
        (request) =>
          !this.stateValue.providerRequests.includes(request) && request.stage === 'ready'
      );
    const state: AgentRunState = Object.freeze({
      ...this.stateValue,
      revision: this.stateValue.revision + 1,
      phase: advance.phase,
      providerRequests: Object.freeze(
        releaseCompleted
          ? requests.filter(
              (request) =>
                request.stage !== 'consumed' ||
                !this.stateValue.providerRequests.some(
                  (previous) =>
                    previous.stage === 'consumed' &&
                    previous.identity.turnId === request.identity.turnId &&
                    previous.identity.requestAttempt === request.identity.requestAttempt
                )
            )
          : [...requests]
      ),
      toolBatches: Object.freeze(
        releaseCompleted
          ? batches.filter(
              (batch) =>
                !toolWorkResolved(batch) ||
                !this.stateValue.toolBatches.some(
                  (previous) =>
                    previous.toolBatchId === batch.toolBatchId && toolWorkResolved(previous)
                )
            )
          : [...batches]
      ),
      ...(advance.budget === undefined
        ? this.stateValue.budget === undefined
          ? {}
          : { budget: this.stateValue.budget }
        : { budget: advance.budget })
    });
    assertAgentRunStateInvariants(state);
    const event = await transitionEvent(
      this.stateValue,
      state,
      new AgentRunRecords(this.artifacts)
    );
    const ownedState = await applyAgentRunStateTransition(
      this.stateValue,
      event.transition,
      new AgentRunRecords(this.artifacts)
    );
    const result = await this.events.appendConditional(state.runId, event, {
      idempotencyKey: transitionKey(state, event.transition),
      expectedTail: this.tailValue,
      driverGeneration: state.driverGeneration
    });
    if (
      result.kind === 'rejected' &&
      (result.reason === 'stale_tail' || result.reason === 'stale_driver')
    )
      await this.refresh();
    const committed = acceptConditionalResult(state.runId, result);
    this.stateValue = ownedState;
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
    const tail = await this.events.tail(this.stateValue.runId);
    if (
      tail.sequence === this.tailValue.sequence &&
      tail.hash === this.tailValue.hash &&
      tail.driverGeneration === this.tailValue.driverGeneration
    )
      return;
    let cursor = this.tailValue.sequence;
    const records = new AgentRunRecords(this.artifacts);
    for (;;) {
      const page = await this.events.readRange(this.stateValue.runId, {
        afterSequence: cursor,
        through: tail,
        types: ['run.state.transitioned']
      });
      if (page.oversized)
        throw new Error('Run transition exceeds its independently bounded record size.');
      for (const record of page.records) {
        if (record.event.type !== 'run.state.transitioned') continue;
        this.stateValue = await applyAgentRunStateTransition(
          this.stateValue,
          record.event.transition,
          records
        );
        if (this.stateValue.driverGeneration !== record.driverGeneration)
          throw new Error('Run transition changed driver fencing.');
        this.transitionValue = record;
      }
      if (page.complete) break;
      if (page.nextSequence <= cursor) throw new Error('Run transition reader made no progress.');
      cursor = page.nextSequence;
    }
    this.tailValue = tail;
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

async function transitionEvent(
  previous: AgentRunState | undefined,
  state: AgentRunState,
  records: AgentRunRecords
): Promise<Extract<AgentEvent, { readonly type: 'run.state.transitioned' }>> {
  return Object.freeze({
    type: 'run.state.transitioned',
    transition: await createAgentRunStateTransition(previous, state, records)
  });
}

function transitionKey(state: AgentRunState, transition: AgentRunStateTransition): string {
  return `${state.runId}:run:revision:${String(state.revision)}:${hashJson(transition)}`;
}

function toolSettlementDigest(settlement: AgentToolSettlementRecord): string {
  return hashJson(
    Object.freeze({
      observationId: settlement.observationId,
      ...(settlement.observation
        ? { observation: encodeToolObservation(settlement.observation) }
        : {}),
      original: settlement.original,
      modelContent: settlement.modelContent,
      ...(settlement.modelContentRef ? { modelContentRef: settlement.modelContentRef } : {}),
      createdAt: settlement.createdAt
    })
  );
}

function abortAdministrativeEvent(event: AgentAuditEvent): boolean {
  return (
    event.type === 'context.transition.requested' ||
    event.type === 'context.transition.bound' ||
    event.type === 'context.transition.completed' ||
    event.type === 'context.transition.rejected' ||
    event.type === 'run.finalization.staged' ||
    event.type === 'run.ended' ||
    event.type === 'delivery.failed' ||
    event.type === 'resource.released' ||
    (event.type === 'run.phase.changed' && event.phase === 'finalizing')
  );
}

function advanceMatchesProcedure(
  procedure: AgentRunProcedure,
  phase: AgentRunControlPhase
): boolean {
  switch (procedure) {
    case 'initialize_run':
      return phase.kind === 'initializing' || phase.kind === 'finalization';
    case 'assemble_turn':
      return (
        phase.kind === 'active' ||
        phase.kind === 'finalization' ||
        phase.kind === 'cancelling' ||
        (phase.kind === 'suspended' && phase.reason === 'context_admission')
      );
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
      return (
        phase.kind === 'cancelling' || phase.kind === 'finalization' || phase.kind === 'terminal'
      );
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
          state.toolBatches.some((item) =>
            item.callStates.some((entry) => entry.stage === 'approval')
          ))
      ) {
        throw new TypeError('Tool admission is quiesced for this run.');
      }
      assertToolAdvance(procedure, call, updated);
      if (updated.stage === 'effect_pending' && call.stage === 'effect_ready') {
        if (
          state.phase.kind !== 'active' ||
          state.control.status !== 'owned' ||
          state.toolBatches.some((item) =>
            item.callStates.some((entry) => entry.stage === 'approval')
          ) ||
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
    throw new TypeError(
      `Procedure ${procedure} cannot change tool ${previous.stage} to ${next.stage}.`
    );
  if (
    procedure === 'record_tool_delivery' &&
    previous.stage === 'recorded' &&
    next.stage === 'recorded'
  ) {
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
        ? previous.stage === 'effect_ready' &&
          ['effect_pending', 'outcome_unknown'].includes(next.stage)
        : procedure === 'reconcile_provider_request'
          ? ['effect_pending', 'effect_ready'].includes(previous.stage) &&
            ['settled', 'rejected', 'outcome_unknown', 'effect_ready'].includes(next.stage)
          : procedure === 'consume_provider_settlement'
            ? (previous.stage === 'settled' || previous.stage === 'rejected') &&
              next.stage === 'consumed'
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

function toolWorkResolved(batch: AgentToolPhase): boolean {
  return batch.callStates.every(
    (call) =>
      call.stage === 'resolved' ||
      call.stage === 'cancelled' ||
      (call.stage === 'recorded' &&
        (!batch.source.nativeCatalogIdentity || call.delivery?.status === 'applied'))
  );
}
