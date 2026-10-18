import { createProgramResult } from './program-result.js';
import { ProgramExecutionCoordinator } from './program-execution.js';
import type { ProgramExecutionHost, RuntimeProgramRunner } from './program-contracts.js';
import { serializeToolModelContent } from '@agent-core/tools';
import { issueEffectStartTicket, startExternalEffect } from '@agent-core/effects';
import { hashJson, type EventRepository } from '@agent-core/persistence';
import {
  POLICY_TOOL_AUTHORIZER,
  abortableToolBoundary,
  contextRequiredObservation,
  effectsConflict,
  enforceAllowedEffects,
  invokeToolCallPlan,
  planToolCall,
  policyBlockedObservation,
  releaseToolCallPlan,
  releaseToolInvocation,
  runtimeErrorObservation,
  resourceBlockedObservation,
  updateToolObservation,
  startToolCallPlan,
  type CompiledToolDefinition,
  type ResourceLeaseCoordinator,
  type ToolAuthorizer,
  type ToolCall,
  type ToolCallPlan,
  type ToolEffects,
  type ToolInvocation,
  type ToolInputInspection,
  type ToolObservation,
  type ToolPlanningContext,
  type ToolProgress
} from '@agent-core/tools';
import type { AgentAuditEvent, AgentEvent, AgentProgressEvent } from '../events.js';
import { toolEventKey } from '../run/contracts.js';
import type { ModelWindow } from '../inference/model-window.js';
import type { PromptContextItemInput } from '../inference/prompt-material.js';
import type {
  AgentApprovalBinding,
  AgentApprovalRequest,
  AgentToolCallAttemptIdentity,
  AgentToolCallIdentity
} from '../run/contracts.js';
import {
  toolWork,
  type AgentRunProcedure,
  type AgentRunState,
  type AgentToolTarget
} from '../run/control/contracts.js';
import { AgentToolStartBlockedError } from '../run/control/driver.js';
import {
  isToolCallStartable,
  toolInvocationCaller,
  type AgentToolCallPlanRecord,
  type AgentToolCallState,
  type AgentToolPhase,
  type AgentToolSettlementRecord
} from '../run/control/tool-state.js';
import { captureToolCatalog, type ToolCatalogSnapshot } from '../run/tool-catalog.js';
import type { SessionDescriptor, SessionRepository } from '../session/contracts.js';
import { ObservationStore, type CommittedToolObservation } from './observation-store.js';

export type ToolContextPrerequisite = (request: ToolInputInspection) => Promise<
  | {
      readonly summary: string;
      readonly context: readonly PromptContextItemInput[];
    }
  | undefined
>;

export interface ToolExecutionInput {
  readonly runId: string;
  readonly events: Pick<EventRepository<AgentEvent>, 'referenceByKey' | 'readReference'>;
  readonly driverGeneration: number;
  readonly resolveTools: (source: ToolCatalogSnapshot) => readonly CompiledToolDefinition[];
  readonly currentTools: (phase: AgentToolPhase) =>
    readonly CompiledToolDefinition[] | Promise<readonly CompiledToolDefinition[]>;
  readonly toolContext: ToolPlanningContext;
  readonly programRunner?: RuntimeProgramRunner;
  readonly nativeProgrammaticTools?: boolean;
  readonly artifactRepository?: import('@agent-core/persistence').ArtifactRepository;
  readonly admitProgramCall?: (batch: AgentToolPhase, tools: readonly CompiledToolDefinition[]) => Promise<void>;
  readonly yieldProgramCall?: (target: { toolBatchId: string; callIndex: number }) => Promise<void>;
  readonly interruptProgramCall?: (target: { toolBatchId: string; callIndex: number }) => Promise<void>;
  readonly authorizer?: ToolAuthorizer;
  readonly contextPrerequisite?: ToolContextPrerequisite;
  readonly resourceLeases?: ResourceLeaseCoordinator;
  readonly modelWindow: Pick<ModelWindow, 'recordToolResult'>;
  readonly observationStore: Pick<
    ObservationStore,
    'commitToolObservation' | 'projectToolObservation'
  >;
  readonly session?: {
    readonly repository: SessionRepository;
    readonly descriptor: SessionDescriptor;
  };
  /** Stage completed ordinary batches; streaming native deliveries keep their adapter boundary. */
  readonly stagePresentations?: (phase: AgentToolPhase) => boolean;
  readonly selectPresentations?: (phase: AgentToolPhase, observations: readonly {
    readonly callIndex: number;
    readonly committed: CommittedToolObservation;
    readonly published: boolean;
  }[]) => Promise<readonly CommittedToolObservation[]>;
  readonly state: () => AgentRunState;
  readonly transitionTool: (
    procedure: AgentRunProcedure,
    target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>,
    update: (
      call: AgentToolCallState,
      batch: AgentToolPhase,
      state: AgentRunState
    ) => AgentToolCallState
  ) => Promise<void>;
  readonly settle: (input: {
    readonly effectId: string;
    readonly permit: import('@agent-core/effects').EffectSettlementPermit;
    readonly settlement: AgentToolSettlementRecord;
  }) => Promise<'owned' | 'ownership_lost'>;
  readonly append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}

export type ToolCallCompletion = Readonly<{
  outcome: 'owned' | 'ownership_lost';
  committed?: CommittedToolObservation;
}>;

export type ToolCallStepResult =
  | Readonly<{ kind: 'advanced' }>
  | Readonly<{ kind: 'started'; completion: Promise<ToolCallCompletion> }>
  | Readonly<{
      kind: 'blocked';
      reason: 'approval' | 'dependencies' | 'external_outcome' | 'complete';
    }>;

/** Local handles only. Every admission, start and settlement belongs to the run driver. */
export class ToolCallExecutor {
  private readonly retainedPlans = new Map<string, ToolCallPlan>();
  private readonly active = new Map<string, Promise<ToolCallCompletion>>();
  private readonly observations = new Map<string, CommittedToolObservation>();
  private readonly stepping = new Set<string>();
  private readonly preparedPresentations = new Set<string>();

  private readonly programs: ProgramExecutionCoordinator | undefined;

  constructor(private readonly input: ToolExecutionInput) {
    this.programs = input.programRunner ? new ProgramExecutionCoordinator(input, target => this.step(target)) : undefined;
  }

  async step(
    target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>
  ): Promise<ToolCallStepResult> {
    const key = callKey(target);
    const running = this.active.get(key);
    if (running) return Object.freeze({ kind: 'started', completion: running });
    if (this.stepping.has(key)) return Object.freeze({ kind: 'blocked', reason: 'dependencies' });
    this.stepping.add(key);
    try {
      const phase = toolWork(this.input.state(), target);
      const call = phase.callStates[target.callIndex];
      if (!call) throw new TypeError('Tool target is missing.');
      if (
        (call.stage === 'ready' || call.stage === 'effect_ready') &&
        (this.input.state().phase.kind !== 'active' ||
          this.input
            .state()
            .toolBatches.some((batch) =>
              batch.callStates.some((entry) => entry.stage === 'approval')
            ))
      ) {
        return Object.freeze({ kind: 'blocked', reason: 'approval' });
      }
      if (call.stage === 'ready') {
        const admitted = await planAndAuthorizeCall(
          this.input,
          phase,
          target.callIndex,
          this.retainedPlans,
          this.observations
        );
        return admitted
          ? Object.freeze({ kind: 'advanced' })
          : Object.freeze({ kind: 'blocked', reason: 'dependencies' });
      }
      if (call.stage === 'effect_ready') {
        if (this.input.programRunner?.toolName === phase.calls[target.callIndex]?.name && !phase.source.program) {
          const runningPrograms = this.input.state().toolBatches.flatMap(batch => batch.calls.flatMap((entry, index) =>
            !batch.source.program && entry.name === this.input.programRunner?.toolName &&
            (['effect_pending', 'outcome_unknown'].includes(batch.callStates[index]?.stage ?? '') ||
              this.active.has(callKey({ toolBatchId: batch.toolBatchId, callIndex: index }))) ? [entry] : []));
          if (runningPrograms.length >= (this.input.programRunner?.maxConcurrentPrograms ?? 1))
            return Object.freeze({ kind: 'blocked', reason: 'dependencies' });
        }
        if (
          !isToolCallStartable(
            phase,
            target.callIndex,
            this.input.driverGeneration,
            this.input.state().toolBatches
          )
        ) {
          return Object.freeze({ kind: 'blocked', reason: 'dependencies' });
        }
        const retained = this.retainedPlans.get(key);
        this.retainedPlans.delete(key);
        // Lease waits and the effect itself stay outside the provider reader and driver queue.
        const completion = startCall(this.input, phase, target.callIndex, retained,
          this.input.programRunner?.toolName === phase.calls[target.callIndex]?.name && !phase.source.program
            ? this.programs?.host(phase, target.callIndex, call.toolAttempt) : undefined)
          .then((started) => started.completion)
          .then((result) => {
            if (result.committed) this.observations.set(key, result.committed);
            return result;
          })
          .finally(() => {
            this.active.delete(key);
          });
        this.active.set(key, completion);
        return Object.freeze({ kind: 'started', completion });
      }
      if ((call.stage === 'settled' || call.stage === 'recording') &&
          !phase.source.program && this.input.stagePresentations?.(phase) && !this.preparedPresentations.has(phase.toolBatchId)) {
        if (phase.callStates.some(item => !['settled', 'recording', 'recorded', 'resolved', 'cancelled'].includes(item.stage)))
          return Object.freeze({ kind: 'blocked', reason: 'dependencies' });
        const observations = [];
        for (const [callIndex, state] of phase.callStates.entries()) {
          if (state.stage !== 'settled' && state.stage !== 'recording' && state.stage !== 'recorded') continue;
          const batchCall = requireCall(phase, callIndex);
          const committed = this.observations.get(callKey({ toolBatchId: phase.toolBatchId, callIndex })) ??
            committedFromState(this.input, phase, batchCall, state);
          const identity = attemptIdentity(phase, callIndex, batchCall, state.toolAttempt);
          const previous = await this.input.events.referenceByKey(this.input.runId, toolEventKey(this.input.runId, identity, 'observation'));
          const event = previous ? (await this.input.events.readReference(previous)).event : undefined;
          if (event && event.type !== 'observation.record.created') throw new Error('Invalid persisted observation selection.');
          const withoutReference = { ...committed };
          delete withoutReference.modelContentRef;
          observations.push({ callIndex, published: !!event,
            committed: event ? { ...withoutReference, modelContent: event.modelContent ?? [],
              ...(event.modelContentRef ? { modelContentRef: event.modelContentRef } : {}) } : committed });
        }
        const selected = await this.input.selectPresentations?.(phase, observations) ?? observations.map(item => item.committed);
        for (const [index, observation] of observations.entries()) {
          const chosen = selected[index];
          if (chosen?.id !== observation.committed.id) throw new Error('Tool presentation changed its observation identity.');
          this.observations.set(callKey({ toolBatchId: phase.toolBatchId, callIndex: observation.callIndex }), chosen);
        }
        this.preparedPresentations.add(phase.toolBatchId);
      }
      if (call.stage === 'settled') {
        await beginObservationRecording(this.input, phase, target.callIndex);
        return Object.freeze({ kind: 'advanced' });
      }
      if (call.stage === 'recording') {
        await finishObservationRecording(
          this.input,
          phase,
          target.callIndex,
          call,
          this.observations.get(key)
        );
        this.observations.delete(key);
        if (this.input.state().toolBatches.find(batch => batch.toolBatchId === phase.toolBatchId)?.callStates.every(item =>
          item.stage === 'recorded' || item.stage === 'resolved' || item.stage === 'cancelled'))
          this.preparedPresentations.delete(phase.toolBatchId);
        return Object.freeze({ kind: 'advanced' });
      }
      return Object.freeze({
        kind: 'blocked',
        reason:
          call.stage === 'approval'
            ? 'approval'
            : call.stage === 'recorded' || call.stage === 'resolved' || call.stage === 'cancelled'
              ? 'complete'
              : 'external_outcome'
      });
    } catch (error) {
      const retained = this.retainedPlans.get(key);
      this.retainedPlans.delete(key);
      if (retained) await releaseToolCallPlan(retained);
      throw error;
    } finally {
      this.stepping.delete(key);
    }
  }

  async settleProgramParents(reason: 'approval_required' | 'tool_outcome_unknown'): Promise<void> {
    this.programs?.quiesce(reason);
    const name = this.input.programRunner?.toolName;
    if (!name) return;
    const parents = this.input.state().toolBatches.flatMap(batch => batch.calls.flatMap((call, index) =>
      call.name === name && !batch.source.program ? [this.active.get(callKey({ toolBatchId: batch.toolBatchId, callIndex: index }))] : []));
    await Promise.all(parents.filter((value): value is Promise<ToolCallCompletion> => value !== undefined));
  }

  async release(): Promise<void> {
    const plans = [...this.retainedPlans.values()];
    this.retainedPlans.clear();
    this.preparedPresentations.clear();
    await Promise.all(plans.map((plan) => releaseToolCallPlan(plan)));
  }
}

function callKey(target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>): string {
  return `${target.toolBatchId}:${String(target.callIndex)}`;
}

function sourceTools(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  call: ToolCall
): readonly CompiledToolDefinition[] {
  const entry = phase.source.catalog.entries.find((item) => item.name === call.name);
  if (!entry) return [];
  return input
    .resolveTools(phase.source.catalog)
    .filter(
      (tool) =>
        tool.name === entry.name &&
        tool.implementationId === entry.implementationId &&
        captureToolCatalog([tool]).entries[0]?.definitionHash === entry.definitionHash
    );
}

async function callAvailable(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  call: ToolCall
): Promise<boolean> {
  const entry = phase.source.catalog.entries.find((item) => item.name === call.name);
  if (!entry) return false;
  return (await input.currentTools(phase)).some(
    (tool) =>
      tool.name === entry.name &&
      tool.implementationId === entry.implementationId &&
      captureToolCatalog([tool]).entries[0]?.definitionHash === entry.definitionHash
  );
}

async function contextPrerequisiteObservation(
  input: ToolExecutionInput,
  plan: ToolCallPlan,
  context: ToolPlanningContext
): Promise<ToolObservation | undefined> {
  if (!input.contextPrerequisite) return undefined;
  const prerequisite = await input.contextPrerequisite({
    call: plan.call,
    toolImplementationId: plan.toolImplementationId,
    input: plan.canonicalSnapshot,
    effects: plan.effects,
    context
  });
  if (!prerequisite) return undefined;
  return contextRequiredObservation(prerequisite.summary, prerequisite.context);
}

async function planAndAuthorizeCall(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  retainedPlans: Map<string, ToolCallPlan>,
  committedObservations: Map<string, CommittedToolObservation>
): Promise<boolean> {
  const call = requireCall(phase, callIndex);
  const key = callKey({ toolBatchId: phase.toolBatchId, callIndex });
  const ready = phase.callStates[callIndex];
  if (ready?.stage !== 'ready')
    throw new Error(`Tool call ${String(callIndex)} is not ready for plan.`);
  const batchesAtPlanning = input.state().toolBatches;
  const result = await planToolCall(
    call,
    sourceTools(input, phase, call),
    planningContext(input, phase, callIndex, call),
    async (request) => {
      const prerequisite = await input.contextPrerequisite?.(request);
      return prerequisite
        ? contextRequiredObservation(prerequisite.summary, prerequisite.context)
        : undefined;
    }
  );
  if (!result.ok) {
    const committed = await commitObservation(input, phase, call, undefined, result.observation);
    const state: AgentToolCallState = Object.freeze({
      stage: 'settled',
      toolAttempt: 1,
      settlement: settlementRecord(committed)
    });
    await replaceCall(input, phase, 'plan_tool_call', callIndex, state);
    await appendToolEnded(input, phase, callIndex, call, state);
    committedObservations.set(key, committed);
    return true;
  }

  const callPlan = result.plan;
  assertToolDependencies(callPlan.effects, callIndex, phase.calls.length);
  retainedPlans.set(key, callPlan);
  const currentAuthorization = await authorize(input, callPlan, planningContext(input, phase, callIndex, call));
  const storedApproval =
    ready.approved?.approval.fingerprint === callPlan.fingerprint &&
    ready.approved.approval.policyHash === hashJson(input.toolContext.policy) &&
    hashJson(ready.approved.approval.binding) ===
      hashJson(approvalBinding(callPlan, input.toolContext)) &&
    hashJson(ready.approved.approval.effects) === hashJson(callPlan.effects) &&
    hashJson(ready.approved.approval.input) === hashJson(callPlan.canonicalSnapshot)
      ? ready.approved
      : undefined;
  const authorization = storedApproval
    ? currentAuthorization.decision === 'deny'
      ? currentAuthorization
      : storedApproval.decision === 'allow'
        ? {
            decision: 'allow' as const,
            ...(currentAuthorization.reason ? { reason: currentAuthorization.reason } : {})
          }
        : {
            decision: 'deny' as const,
            reason: currentAuthorization.reason ?? storedApproval.approval.reason
          }
    : currentAuthorization;
  const planRecord = Object.freeze({
    ...toolCallPlanRecord(
      callPlan,
      input.toolContext,
      authorization.decision,
      authorization.reason
    ),
    ...(storedApproval?.decision === 'allow' ? { approval: storedApproval.approval } : {})
  });
  if (!storedApproval) {
    await input.append(
      authorizationEvent(phase, callIndex, call, callPlan, authorization, input.toolContext),
      authorizationKey(input.runId, phase, callIndex, callPlan)
    );
  }

  if (authorization.decision === 'require_approval') {
    const predecessors = batchesAtPlanning.slice(
      0,
      batchesAtPlanning.findIndex((batch) => batch.toolBatchId === phase.toolBatchId) + 1
    );
    const blocked = predecessors.some((batch) =>
      batch.callStates.some((other, index) => {
        if (batch.toolBatchId === phase.toolBatchId && index >= callIndex) return false;
        // An earlier unplanned call has no effect declaration yet. Do not let a later
        // approval suspend it before its dependencies can settle and its plan can bind.
        if (other.stage === 'ready' || other.stage === 'approval') return true;
        if (
          other.stage !== 'effect_ready' &&
          other.stage !== 'effect_pending' &&
          other.stage !== 'outcome_unknown'
        )
          return false;
        return (
          effectsConflict(other.plan.effects, callPlan.effects) ||
          (batch.toolBatchId === phase.toolBatchId &&
            callPlan.effects.dependsOnCallIndices?.includes(index) === true)
        );
      })
    );
    if (blocked) {
      // Earlier effects may change the canonical revision that a user would approve.
      await releaseToolCallPlan(callPlan);
      retainedPlans.delete(key);
      return false;
    }
    const approval = approvalRequest(
      input.runId,
      phase,
      callIndex,
      call,
      callPlan,
      authorization.reason,
      input.toolContext
    );
    await input.append(approvalEvent(approval), approvalKey(input.runId, approval));
    await replaceCall(
      input,
      phase,
      'plan_tool_call',
      callIndex,
      Object.freeze({ stage: 'approval', plan: planRecord, approval })
    );
    await releaseToolCallPlan(callPlan);
    retainedPlans.delete(key);
    return true;
  }

  if (authorization.decision === 'deny') {
    const observation = policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
      tool: call.name,
      policyReason: 'deny',
      ...(authorization.reason ? { details: { message: authorization.reason } } : {})
    });
    const committed = await commitObservation(input, phase, call, callPlan, observation);
    const state: AgentToolCallState = Object.freeze({
      stage: 'settled',
      plan: planRecord,
      toolAttempt: 1,
      settlement: settlementRecord(committed)
    });
    await replaceCall(input, phase, 'plan_tool_call', callIndex, state);
    await appendToolEnded(input, phase, callIndex, call, state);
    committedObservations.set(key, committed);
    await releaseToolCallPlan(callPlan);
    retainedPlans.delete(key);
    return true;
  }

  const effect = issueToolEffect(input, phase, callIndex, callPlan, 1);
  await replaceCall(
    input,
    phase,
    'plan_tool_call',
    callIndex,
    Object.freeze({ stage: 'effect_ready', plan: planRecord, toolAttempt: 1, effect })
  );
  return true;
}

async function startCall(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  retained: ToolCallPlan | undefined,
  programHost?: ProgramExecutionHost
): Promise<{ readonly completion: Promise<ToolCallCompletion> }> {
  const call = requireCall(phase, callIndex);
  const callState = phase.callStates[callIndex];
  if (callState?.stage !== 'effect_ready')
    throw new Error(`Tool call ${String(callIndex)} is not ready to start.`);
  const plan = await requireMatchingPlan(input, phase, callIndex, call, callState, retained);
  let lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined;
  let invocation: ToolInvocation | undefined;
  try {
    try {
      lease = await acquireLease(input, phase, callIndex, call, callState);
    } catch (error) {
      if (input.toolContext.signal.aborted) throw error;
      // No invocation has started: a failed resource admission cannot have executed the tool.
      const observation = error instanceof ResourceAdmissionYield
        ? resourceBlockedObservation(call.name, error.blocker, error.waitMs, error.blockingResourceIds)
        : updateToolObservation(runtimeErrorObservation(call.name, error), {
            execution: { state: 'not_started' }
          });
      const committed = await commitObservation(input, phase, call, plan, observation);
      const settled: AgentToolCallState = Object.freeze({
        stage: 'settled', plan: callState.plan, toolAttempt: callState.toolAttempt,
        settlement: settlementRecord(committed)
      });
      await replaceCall(input, phase, 'start_tool_call', callIndex, settled, callState.effect.intent.effectId);
      await appendToolEnded(input, phase, callIndex, call, settled);
      await releaseToolCallPlan(plan);
      return { completion: Promise.resolve({ outcome: 'owned', committed }) };
    }
    if (!(await callAvailable(input, phase, call))) {
      const committed = await commitObservation(
        input,
        phase,
        call,
        plan,
        policyBlockedObservation(`Original tool binding is no longer available: ${call.name}`, {
          tool: call.name,
          policyReason: 'deny'
        })
      );
      await replaceCall(
        input,
        phase,
        'start_tool_call',
        callIndex,
        {
          stage: 'settled',
          plan: callState.plan,
          toolAttempt: callState.toolAttempt,
          settlement: settlementRecord(committed)
        },
        callState.effect.intent.effectId
      );
      if (lease && !lease.transferred) lease.release();
      await releaseToolCallPlan(plan);
      return { completion: Promise.resolve({ outcome: 'owned', committed }) };
    }
    // The admitted plan owns its canonical source snapshot. Recheck current policy after
    // the lease without replacing that snapshot with a newly captured history or resource view.
    const authorization = await authorize(input, plan, planningContext(input, phase, callIndex, call, callState.toolAttempt));
    const approved = callState.plan.approval;
    const approvedNow =
      approved?.fingerprint === plan.fingerprint &&
      approved.policyHash === hashJson(input.toolContext.policy) &&
      hashJson(approved.binding) === hashJson(approvalBinding(plan, input.toolContext));
    if (
      authorization.decision === 'deny' ||
      (authorization.decision === 'require_approval' && !approvedNow)
    ) {
      await replaceCall(
        input,
        phase,
        'start_tool_call',
        callIndex,
        { stage: 'ready' },
        callState.effect.intent.effectId
      );
      if (lease && !lease.transferred) lease.release();
      await releaseToolCallPlan(plan);
      return { completion: Promise.resolve({ outcome: 'owned' }) };
    }
    const prerequisite = await contextPrerequisiteObservation(input, plan, planningContext(input, phase, callIndex, call, callState.toolAttempt));
    if (prerequisite) {
      const committed = await commitObservation(input, phase, call, undefined, prerequisite);
      const state: AgentToolCallState = Object.freeze({
        stage: 'settled',
        toolAttempt: callState.toolAttempt,
        settlement: settlementRecord(committed)
      });
      await replaceCall(
        input,
        phase,
        'start_tool_call',
        callIndex,
        state,
        callState.effect.intent.effectId
      );
      await appendToolEnded(input, phase, callIndex, call, state);
      if (lease && !lease.transferred) lease.release();
      await releaseToolCallPlan(plan);
      return { completion: Promise.resolve({ outcome: 'owned', committed }) };
    }
    const started = startExternalEffect(
      callState.effect,
      callState.effect.ticket,
      input.driverGeneration
    );
    if (started.status !== 'started')
      throw new Error(`Tool effect start was rejected: ${started.reason}.`);
    await replaceCall(
      input,
      phase,
      'start_tool_call',
      callIndex,
      Object.freeze({
        stage: 'effect_pending',
        plan: callState.plan,
        toolAttempt: callState.toolAttempt,
        effect: started.state
      }),
      callState.effect.intent.effectId
    );
    invocation = await startToolCallPlan(plan, started.state);
    const identity = attemptIdentity(phase, callIndex, call, callState.toolAttempt);
    await input.append(
      {
        type: 'tool.started',
        ...identity,
        toolName: call.name,
        input: call,
        fingerprint: plan.fingerprint,
        effects: plan.effects
      },
      toolEventKey(input.runId, identity, 'started')
    );
    await input.emit({
      type: 'tool.started',
      ...identity,
      toolName: call.name,
      input: call,
      fingerprint: plan.fingerprint,
      effects: plan.effects
    });
    return Object.freeze({
      completion: executeStartedCall(
        input,
        phase,
        callIndex,
        call,
        callState,
        plan,
        invocation,
        lease,
        programHost
      )
    });
  } catch (error) {
    if (lease && !lease.transferred) lease.release();
    if (invocation) await releaseToolInvocation(invocation);
    else await releaseToolCallPlan(plan);
    if (error instanceof AgentToolStartBlockedError)
      return { completion: Promise.resolve({ outcome: 'owned' }) };
    throw error;
  }
}

async function executeStartedCall(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  callState: Extract<AgentToolCallState, { readonly stage: 'effect_ready' }>,
  plan: ToolCallPlan,
  invocation: ToolInvocation,
  lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined,
  programHost?: ProgramExecutionHost
): Promise<ToolCallCompletion> {
  try {
    const observation = await invokeToolCallPlan(invocation, {
      ...input.toolContext,
      ...(programHost ? { services: { ...input.toolContext.services, programExecution: programHost } } : {}),
      ...(lease ? { resourceLease: lease } : {}),
      emitProgress: (progress) =>
        input.emit({
          type: 'tool.updated',
          ...attemptIdentity(phase, callIndex, call, callState.toolAttempt),
          toolName: call.name,
          progress
        }),
      persistProgressCheckpoint: async (progress) => {
        const identity = attemptIdentity(phase, callIndex, call, callState.toolAttempt);
        const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
        await input.append(
          event,
          toolEventKey(input.runId, identity, `updated:${hashJson(progress)}`)
        );
        await input.emit(event);
      },
      invocation: invocationIdentity(
        input.runId,
        phase,
        callIndex,
        call,
        callState.toolAttempt,
        callState
      )
    });
    const committed = await commitObservation(input, phase, call, plan, observation);
    const ownership = await input.settle({
      effectId: callState.effect.intent.effectId,
      permit: callState.effect.settlementPermit,
      settlement: settlementRecord(committed)
    });
    if (ownership === 'ownership_lost') return Object.freeze({ outcome: ownership, committed });
    const settled: AgentToolCallState = Object.freeze({
      stage: 'settled',
      plan: callState.plan,
      toolAttempt: callState.toolAttempt,
      settlement: settlementRecord(committed)
    });
    await appendToolEnded(input, phase, callIndex, call, settled);
    return Object.freeze({ outcome: ownership, committed });
  } finally {
    if (lease && !lease.transferred) lease.release();
    await releaseToolInvocation(invocation);
  }
}

async function beginObservationRecording(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number
): Promise<void> {
  await input.transitionTool(
    'begin_observation_recording',
    { toolBatchId: phase.toolBatchId, callIndex },
    (call) => {
      if (call.stage !== 'settled')
        throw new Error('Tool call is not settled for observation recording.');
      return Object.freeze({ ...call, stage: 'recording' });
    }
  );
}

async function finishObservationRecording(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  state: Extract<AgentToolCallState, { readonly stage: 'recording' }>,
  retained: CommittedToolObservation | undefined
): Promise<void> {
  const call = requireCall(phase, callIndex);
  if (!retained) await appendToolEnded(input, phase, callIndex, call, state);
  await recordObservation(
    input,
    phase,
    callIndex,
    call,
    state,
    retained ?? committedFromState(input, phase, call, state)
  );
  await input.transitionTool(
    'record_tool_observation',
    { toolBatchId: phase.toolBatchId, callIndex },
    (current) => {
      if (current.stage !== 'recording')
        throw new Error('Tool call lost its observation-recording state.');
      return Object.freeze({ ...current, stage: 'recorded' });
    }
  );
}

function planningContext(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  toolAttempt = 1
): ToolPlanningContext {
  const identity = attemptIdentity(phase, callIndex, call, toolAttempt);
  return Object.freeze({
    ...input.toolContext,
    invocation: invocationIdentity(input.runId, phase, callIndex, call, toolAttempt),
    emitProgress: (progress: ToolProgress) =>
      input.emit({ type: 'tool.updated', ...identity, toolName: call.name, progress }),
    persistProgressCheckpoint: async (progress: ToolProgress) => {
      const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
      await input.append(event, toolEventKey(input.runId, identity, `plan:${hashJson(progress)}`));
      await input.emit(event);
    }
  });
}

async function requireMatchingPlan(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'effect_ready' }>,
  retained: ToolCallPlan | undefined
): Promise<ToolCallPlan> {
  if (retained) return retained;
  const result = await planToolCall(
    call,
    sourceTools(input, phase, call),
    planningContext(input, phase, callIndex, call, state.toolAttempt)
  );
  if (!result.ok)
    throw new Error(
      `Planned tool ${call.name} is no longer available: ${result.observation.summary}`
    );
  const plan = result.plan;
  if (
    plan.toolImplementationId !== state.plan.toolImplementationId ||
    plan.fingerprint !== state.plan.fingerprint
  ) {
    await releaseToolCallPlan(plan);
    throw new Error(`Planned tool ${call.name} no longer matches its durable intent.`);
  }
  return plan;
}

async function authorize(input: ToolExecutionInput, plan: ToolCallPlan, context: ToolPlanningContext) {
  const request = {
    call: plan.call,
    toolImplementationId: plan.toolImplementationId,
    input: plan.canonicalSnapshot,
    effects: plan.effects,
    fingerprint: plan.fingerprint,
    context
  };
  return (
    enforceAllowedEffects(request) ??
    (await abortableToolBoundary(input.toolContext.signal, () =>
      (input.authorizer ?? POLICY_TOOL_AUTHORIZER)(request)
    ))
  );
}

class ResourceAdmissionYield extends Error {
  constructor(readonly blocker: 'steering' | 'timeout', readonly waitMs: number, readonly blockingResourceIds: readonly string[]) {
    super(`Resource admission yielded: ${blocker}.`);
  }
}

async function acquireLease(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'effect_ready' }>
) {
  const coordinator = input.resourceLeases;
  if (!coordinator) return undefined;
  const owner = `${input.runId}:${phase.toolBatchId}:${String(callIndex)}`;
  // Freely available operations, notably exact resource controls, remain dispatchable.
  if (!coordinator.wouldWait(state.plan.effects))
    return coordinator.acquire(state.plan.effects, owner, input.toolContext.signal);
  const startedAt = performance.now();
  const waiting = new AbortController();
  const observationSignal = input.toolContext.observationSignal;
  const yieldToSteering = () => {
    waiting.abort(new ResourceAdmissionYield('steering', performance.now() - startedAt, coordinator.blockingResourceIds(state.plan.effects)));
  };
  const cancel = () => { waiting.abort(input.toolContext.signal.reason); };
  observationSignal?.addEventListener('abort', yieldToSteering, { once: true });
  input.toolContext.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    waiting.abort(new ResourceAdmissionYield('timeout', performance.now() - startedAt, coordinator.blockingResourceIds(state.plan.effects)));
  }, 1000);
  try {
    if (input.toolContext.signal.aborted) cancel();
    else if (observationSignal?.aborted) yieldToSteering();
    await input.emit({
      type: 'tool.updated',
      ...attemptIdentity(phase, callIndex, call, state.toolAttempt),
      toolName: call.name,
      progress: {
        type: 'status', stage: 'resource_lease_waiting',
        message: 'Waiting for an operation holding conflicting resources.'
      }
    });
    // Pass cancellation to the coordinator itself so rejected waits cannot acquire later.
    return await coordinator.acquire(state.plan.effects, owner, waiting.signal);
  } finally {
    clearTimeout(timer);
    observationSignal?.removeEventListener('abort', yieldToSteering);
    input.toolContext.signal.removeEventListener('abort', cancel);
  }
}

async function commitObservation(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  call: ToolCall,
  plan: ToolCallPlan | undefined,
  observation: ToolObservation
): Promise<CommittedToolObservation> {
  return input.observationStore.commitToolObservation({
    turnIndex: phase.identity.turnIndex,
    call,
    ...(plan ? { canonicalSnapshot: plan.canonicalSnapshot } : {}),
    tool: sourceTools(input, phase, call).find(
      (tool) => tool.name === call.name && tool.implementationId === plan?.toolImplementationId
    ),
    observation,
    modelInputModalities: phase.modelInputModalities
  });
}

async function appendToolEnded(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'settled' | 'recording' | 'recorded' }>
): Promise<void> {
  const identity = attemptIdentity(phase, callIndex, call, state.toolAttempt);
  const key = toolEventKey(input.runId, identity, 'ended');
  const previous = await input.events.referenceByKey(input.runId, key);
  if (previous) {
    const { event } = await input.events.readReference(previous);
    if (event.type !== 'tool.ended' || event.toolName !== call.name ||
        (event.observation.digest !== state.settlement.original.digest &&
         event.observation.execution?.state !== 'unknown'))
      throw new Error('A recorded tool outcome cannot be replaced by another result.');
  } else await input.append(
    {
      type: 'tool.ended',
      ...identity,
      toolName: call.name,
      observation: state.settlement.original,
      ...(phase.source.program ? { programId: phase.source.program.id } : {}),
      ...(state.settlement.modelContentRef
        ? { modelContentRef: state.settlement.modelContentRef }
        : { modelContent: state.settlement.modelContent })
    },
    key
  );
  if (state.settlement.observation)
    await input.emit({
      type: 'tool.ended',
      ...identity,
      toolName: call.name,
      observation: state.settlement.observation
    });
  else if (state.settlement.original.storage === 'unavailable')
    await input.emit({
      type: 'tool.observation.unavailable',
      ...identity,
      toolName: call.name,
      original: state.settlement.original
    });
}

async function recordObservation(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'recording' }>,
  committed: CommittedToolObservation
): Promise<void> {
  const identity = attemptIdentity(phase, callIndex, call, state.toolAttempt);
  const modelCaller = phase.modelCalls[callIndex]?.caller;
  if (phase.source.program) {
    const key = toolEventKey(input.runId, identity, 'observation');
    if (await input.events.referenceByKey(input.runId, key)) return;
    const result = await createProgramResult({ runId: input.runId, toolBatchId: phase.toolBatchId,
      ...(call.id ? { callId: call.id } : {}), toolName: call.name, settlement: state.settlement,
      ...(input.artifactRepository ? { artifacts: input.artifactRepository } : {}) });
    await input.append({ type: 'observation.record.created', ...identity, programId: phase.source.program.id,
      id: committed.id, toolName: call.name, call, toolCallType: call.input.kind === 'text' ? 'custom' : 'function',
      observedFacts: [], kind: committed.original.kind, summary: committed.original.summary,
      modelContent: [{ type: 'text', text: JSON.stringify({ programId: phase.source.program.id,
        parent: phase.source.program.parent, receipt: result.receipt }) }] }, key);
    return;
  }
  const structuredProgramResult = !!phase.modelCalls[callIndex]?.caller || (input.nativeProgrammaticTools === true &&
    call.input.kind === 'json' && sourceTools(input, phase, call).some(tool => tool.invocationModes.includes('programmatic')));
  const previous = await input.events.referenceByKey(input.runId, toolEventKey(input.runId, identity, 'observation'));
  if (previous) {
    const event = (await input.events.readReference(previous)).event;
    if (event.type !== 'observation.record.created' || event.id !== committed.id || event.toolName !== call.name)
      throw new Error('Published tool presentation has a different source identity.');
    // Publication owns delivery even if recovery policy changed before restart.
    const withoutReference = { ...committed };
    delete withoutReference.modelContentRef;
    committed = { ...withoutReference, modelContent: event.modelContent ?? [],
      ...(event.modelContentRef ? { modelContentRef: event.modelContentRef } : {}) };
  } else if (structuredProgramResult) {
    // A provider-hosted program consumes exact typed JSON, never display text or an excerpt.
    const result = await createProgramResult({ runId: input.runId, toolBatchId: phase.toolBatchId,
      ...(call.id ? { callId: call.id } : {}), toolName: call.name, settlement: state.settlement,
      ...(input.artifactRepository ? { artifacts: input.artifactRepository } : {}) });
    const modelContent = Object.freeze([{ type: 'text' as const, text: JSON.stringify(result) }]);
    const modelContentRef = await input.artifactRepository?.store({ label: `${call.name}-program-result`,
      mediaType: 'application/json', content: new TextEncoder().encode(JSON.stringify(modelContent)),
      description: 'Exact structured program result delivery.' });
    const original = { ...committed };
    delete original.modelContentRef;
    committed = { ...original, modelContent, ...(modelContentRef ? { modelContentRef } : {}) };
  }
  try {
    const record = await input.observationStore.projectToolObservation(committed);
    if (!previous) await input.append(
      {
        type: 'observation.record.created',
        id: record.id,
        ...identity,
        toolName: call.name,
        call: record.call,
        toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function',
        observedFacts: record.observedFacts,
        kind: record.original.kind,
        summary: record.original.summary,
        ...(record.modelContentRef
          ? { modelContentRef: record.modelContentRef }
          : { modelContent: record.modelContent }),
        ...(record.durableStorageDegraded
          ? { durableStorageDegraded: record.durableStorageDegraded }
          : {})
      },
      toolEventKey(input.runId, identity, 'observation')
    );
    try {
      await input.session?.repository.appendObservation(input.session.descriptor, {
        runId: input.runId,
        identity,
        toolName: call.name,
        observation: sessionObservation(
          state.settlement.observation,
          record.modelContent,
          record.original,
          record.modelContentRef
        )
      });
    } catch (error) {
      // The ledger already owns this exact selected presentation. A failed
      // session mirror cannot reclassify the effect or replace that selection.
      await input.append({ type: 'observation.recording.failed', id: committed.id, ...identity,
        toolName: call.name, message: error instanceof Error ? error.message : String(error) },
      toolEventKey(input.runId, identity, 'recording-failed'));
    }
    const source = await input.events.referenceByKey(input.runId, toolEventKey(input.runId, identity, 'ended'), { metadataOnly: true });
    if (!source) throw new Error('A published observation requires its authoritative tool outcome.');
    input.modelWindow.recordToolResult({
      source,
      observationId: record.id,
      turnIndex: phase.identity.turnIndex,
      toolName: record.toolName,
      ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function',
      ...(modelCaller ? { caller: modelCaller } : {}),
      immediateContent: serializeToolModelContent(record.modelContent),
      immediateImages: record.modelImages
    });
  } catch (error) {
    // Once published, selection is immutable. Retry its session/window delivery;
    // never replace it with a different fallback after a partial publication.
    if (await input.events.referenceByKey(input.runId, toolEventKey(input.runId, identity, 'observation'))) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await input.append(
      {
        type: 'observation.recording.failed',
        id: committed.id,
        ...identity,
        toolName: call.name,
        message
      },
      toolEventKey(input.runId, identity, 'recording-failed')
    );
    if (structuredProgramResult) throw error;
    const fallback = minimalToolResultContent(state.settlement.original, call.name, message);
    input.modelWindow.recordToolResult({
      turnIndex: phase.identity.turnIndex,
      toolName: call.name,
      ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function',
      ...(modelCaller ? { caller: modelCaller } : {}),
      immediateContent: fallback
    });
  }

}

function committedFromState(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'settled' | 'recording' | 'recorded' }>
): CommittedToolObservation {
  const tool = state.plan
    ? sourceTools(input, phase, call).find(
        (modelOutput) =>
          modelOutput.name === call.name &&
          modelOutput.implementationId === state.plan?.toolImplementationId
      )
    : undefined;
  return Object.freeze({
    id: state.settlement.observationId,
    turnIndex: phase.identity.turnIndex,
    call,
    toolName: call.name,
    ...(state.plan ? { canonicalSnapshot: state.plan.canonicalInput } : {}),
    tool,
    ...(state.settlement.observation
      ? {
          fullObservation: state.settlement.observation,
          durableObservation: state.settlement.observation
        }
      : {}),
    original: state.settlement.original,
    modelContent: state.settlement.modelContent,
    ...(state.settlement.modelContentRef
      ? { modelContentRef: state.settlement.modelContentRef }
      : {}),
    createdAt: state.settlement.createdAt
  });
}

function toolCallPlanRecord(
  plan: ToolCallPlan,
  context: ToolPlanningContext,
  authorization: AgentToolCallPlanRecord['authorization'],
  reason: string | undefined
): AgentToolCallPlanRecord {
  return Object.freeze({
    toolImplementationId: plan.toolImplementationId,
    canonicalInput: plan.canonicalSnapshot,
    fingerprint: plan.fingerprint,
    effects: plan.effects,
    binding: approvalBinding(plan, context),
    authorization,
    ...(reason ? { authorizationReason: reason } : {})
  });
}

function settlementRecord(committed: CommittedToolObservation): AgentToolSettlementRecord {
  return Object.freeze({
    observationId: committed.id,
    ...(committed.durableObservation ? { observation: committed.durableObservation } : {}),
    original: committed.original,
    modelContent: committed.modelContent,
    ...(committed.modelContentRef ? { modelContentRef: committed.modelContentRef } : {}),
    createdAt: committed.createdAt
  });
}

function issueToolEffect(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  plan: ToolCallPlan,
  toolAttempt: number
) {
  const effectId = `${input.runId}:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:${String(toolAttempt)}`;
  const issued = issueEffectStartTicket({
    intent: {
      effectId,
      ownerId: input.runId,
      implementationId: plan.toolImplementationId,
      parametersDigest: plan.fingerprint,
      recovery: plan.effects.recovery,
      exposure: TOOL_INVOCATION_EXPOSURE
    },
    ticketId: `${effectId}:start`,
    settlementPermitId: `${effectId}:settle`,
    driverGeneration: input.driverGeneration,
    currentDriverGeneration: input.driverGeneration
  });
  if (issued.status !== 'issued')
    throw new Error(`Tool effect ticket was rejected: ${issued.reason}.`);
  return issued.state;
}

const TOOL_INVOCATION_EXPOSURE = Object.freeze({
  quantities: Object.freeze([Object.freeze({ unit: 'tool_invocations', amount: 1 })])
});

function approvalRequest(
  runId: string,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  plan: ToolCallPlan,
  reason: string,
  context: ToolPlanningContext
): AgentApprovalRequest {
  const identity = callIdentity(phase, callIndex, call);
  const approvalId = `approval-${hashJson({ runId, ...identity, fingerprint: plan.fingerprint }).slice(0, 32)}`;
  return Object.freeze({
    ...identity,
    approvalId,
    status: 'pending',
    toolName: call.name,
    fingerprint: plan.fingerprint,
    input: plan.canonicalSnapshot,
    effects: plan.effects,
    binding: approvalBinding(plan, context),
    policyHash: hashJson(context.policy),
    reason,
    runId
  });
}

function authorizationEvent(
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  plan: ToolCallPlan,
  authorization: Awaited<ReturnType<typeof authorize>>,
  context: ToolPlanningContext
): AgentAuditEvent {
  return {
    type: 'tool.authorization.decided',
    ...callIdentity(phase, callIndex, call),
    toolName: call.name,
    fingerprint: plan.fingerprint,
    binding: approvalBinding(plan, context),
    decision: authorization.decision,
    ...(authorization.reason ? { reason: authorization.reason } : {})
  };
}

function approvalEvent(approval: AgentApprovalRequest): AgentAuditEvent {
  return {
    type: 'approval.requested',
    runId: approval.runId,
    turnIndex: approval.turnIndex,
    turnId: approval.turnId,
    requestAttempt: approval.requestAttempt,
    toolBatchId: approval.toolBatchId,
    callIndex: approval.callIndex,
    ...(approval.callId ? { callId: approval.callId } : {}),
    approvalId: approval.approvalId,
    toolName: approval.toolName,
    fingerprint: approval.fingerprint,
    input: approval.input,
    effects: approval.effects,
    binding: approval.binding,
    policyHash: approval.policyHash,
    reason: approval.reason
  };
}

function approvalBinding(plan: ToolCallPlan, context: ToolPlanningContext): AgentApprovalBinding {
  return Object.freeze({
    toolImplementationId: plan.toolImplementationId,
    authorizationPolicyId: context.boundary.authorizationPolicyId,
    executionTargetId: context.boundary.executionTargetId
  });
}

function callIdentity(
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall
): AgentToolCallIdentity {
  return {
    ...phase.identity,
    toolBatchId: phase.toolBatchId,
    callIndex,
    ...(call.id ? { callId: call.id } : {})
  };
}

function attemptIdentity(
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  toolAttempt: number
): AgentToolCallAttemptIdentity {
  return { ...callIdentity(phase, callIndex, call), toolAttempt };
}

function invocationIdentity(
  runId: string,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  toolAttempt: number,
  state?: Extract<AgentToolCallState, { readonly stage: 'effect_ready' | 'effect_pending' }>
) {
  const recovery =
    state && toolAttempt > 1 && state.effect.intent.recovery.kind === 'preconditioned_reexecution'
      ? Object.freeze({
          kind: state.effect.intent.recovery.kind,
          preconditions: state.effect.intent.recovery.preconditions
        })
      : undefined;
  const caller = toolInvocationCaller(phase, callIndex);
  return {
    runId,
    ...attemptIdentity(phase, callIndex, call, toolAttempt),
    ...(caller ? { caller } : {}),
    ...(recovery ? { recovery } : {})
  };
}

async function replaceCall(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  procedure: AgentRunProcedure,
  callIndex: number,
  state: AgentToolCallState,
  expectedEffectId?: string
): Promise<void> {
  await input.transitionTool(
    procedure,
    { toolBatchId: phase.toolBatchId, callIndex },
    (existing) => {
      if (expectedEffectId) {
        if (
          existing.stage !== 'effect_ready' ||
          existing.effect.intent.effectId !== expectedEffectId
        ) {
          throw new Error(`Tool call ${String(callIndex)} effect changed before start.`);
        }
      } else if (existing.stage !== 'ready')
        throw new Error(`Tool call ${String(callIndex)} is no longer ready.`);
      return state;
    }
  );
}

function requireCall(phase: AgentToolPhase, callIndex: number): ToolCall {
  const call = phase.calls[callIndex];
  if (!call) throw new Error(`Durable tool call ${String(callIndex)} is missing.`);
  return call;
}

function assertToolDependencies(effects: ToolEffects, callIndex: number, callCount: number): void {
  for (const dependency of effects.dependsOnCallIndices ?? []) {
    if (dependency >= callIndex || dependency >= callCount)
      throw new Error(
        `Tool call ${String(callIndex)} has invalid dependency ${String(dependency)}.`
      );
  }
}

function authorizationKey(
  runId: string,
  phase: AgentToolPhase,
  callIndex: number,
  plan: ToolCallPlan
): string {
  return `${runId}:tool:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:authorization:${plan.fingerprint}`;
}
function approvalKey(runId: string, approval: AgentApprovalRequest): string {
  return `${runId}:approval:${approval.approvalId}:requested`;
}

function sessionObservation(
  observation: ToolObservation | undefined,
  modelContent: readonly import('@agent-core/tools').ToolContent[],
  original: import('./observation-source.js').StoredToolObservation,
  modelContentRef?: import('@agent-core/persistence').PublicArtifactRef
) {
  const artifacts = observationArtifacts(observation);
  return {
    kind: original.kind,
    summary: original.summary,
    ...(modelContentRef ? { modelContentRef } : { modelContent }),
    ...(original.storage === 'artifact'
      ? { originalArtifact: original.artifact }
      : original.storage === 'unavailable'
        ? {
            originalUnavailable: {
              message: original.message,
              bytes: original.bytes,
              digest: original.digest
            }
          }
        : { output: original.observation.output }),
    ...(artifacts.length ? { artifacts } : {}),
    ...(observation?.metadata ? { metadata: observation.metadata } : {})
  };
}
function minimalToolResultContent(
  original: import('./observation-source.js').StoredToolObservation,
  toolName: string,
  recordingError: string
): string {
  return `${toolName}: ${original.summary}\nInvocation disposition: ${original.kind}; execution state: ${original.execution?.state ?? 'not established'}. Model result content could not be recorded: ${recordingError.slice(0, 1000)}.`;
}
function observationArtifacts(observation: ToolObservation | undefined) {
  return [
    ...new Map(
      (observation?.content ?? []).flatMap((item) =>
        item.type === 'text' ? [] : [[item.artifact.artifactId, item.artifact] as const]
      )
    ).values()
  ];
}
