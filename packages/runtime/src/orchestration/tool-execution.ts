import { issueEffectStartTicket, startExternalEffect } from '@agent-core/effects';
import { hashJson } from '@agent-core/persistence';
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
import type { AgentAuditEvent, AgentProgressEvent } from '../events.js';
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
  type AgentToolCallPlanRecord,
  type AgentToolCallState,
  type AgentToolPhase,
  type AgentToolSettlementRecord
} from '../run/control/tool-state.js';
import { captureToolCatalog, type ToolCatalogSnapshot } from '../run/tool-catalog.js';
import type { SessionDescriptor, SessionRepository } from '../session/contracts.js';
import {
  ObservationStore,
  serializeToolObservationPresentation,
  type CommittedToolObservation
} from './observation-store.js';

export type ToolContextPrerequisite = (request: ToolInputInspection) => Promise<
  | {
      readonly summary: string;
      readonly context: readonly PromptContextItemInput[];
    }
  | undefined
>;

export interface ToolExecutionInput {
  readonly runId: string;
  readonly driverGeneration: number;
  readonly resolveTools: (source: ToolCatalogSnapshot) => readonly CompiledToolDefinition[];
  readonly currentTools: () =>
    | readonly CompiledToolDefinition[]
    | Promise<readonly CompiledToolDefinition[]>;
  readonly toolContext: ToolPlanningContext;
  readonly authorizer?: ToolAuthorizer;
  readonly contextPrerequisite?: ToolContextPrerequisite;
  readonly resourceLeases?: ResourceLeaseCoordinator;
  readonly modelWindow: Pick<ModelWindow, 'recordToolResult'>;
  readonly observationStore: Pick<ObservationStore, 'commitToolObservation' | 'projectToolObservation'>;
  readonly session?: { readonly repository: SessionRepository; readonly descriptor: SessionDescriptor };
  readonly state: () => AgentRunState;
  readonly transitionTool: (
    procedure: AgentRunProcedure,
    target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>,
    update: (call: AgentToolCallState, batch: AgentToolPhase, state: AgentRunState) => AgentToolCallState
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
  | Readonly<{ kind: 'blocked'; reason: 'approval' | 'dependencies' | 'external_outcome' | 'complete' }>;

/** Local handles only. Every admission, start and settlement belongs to the run driver. */
export class ToolCallExecutor {
  private readonly retainedPlans = new Map<string, ToolCallPlan>();
  private readonly active = new Map<string, Promise<ToolCallCompletion>>();
  private readonly observations = new Map<string, CommittedToolObservation>();
  private readonly stepping = new Set<string>();

  constructor(private readonly input: ToolExecutionInput) {}

  async step(target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>): Promise<ToolCallStepResult> {
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
            .toolBatches.some((batch) => batch.callStates.some((entry) => entry.stage === 'approval')))
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
        const completion = startCall(this.input, phase, target.callIndex, retained)
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
        return Object.freeze({ kind: 'advanced' });
      }
      return Object.freeze({
        kind: 'blocked',
        reason:
          call.stage === 'approval'
            ? 'approval'
            : call.stage === 'recorded' || call.stage === 'cancelled'
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

  async release(): Promise<void> {
    const plans = [...this.retainedPlans.values()];
    this.retainedPlans.clear();
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
  return (await input.currentTools()).some(
    (tool) =>
      tool.name === entry.name &&
      tool.implementationId === entry.implementationId &&
      captureToolCatalog([tool]).entries[0]?.definitionHash === entry.definitionHash
  );
}

async function contextPrerequisiteObservation(
  input: ToolExecutionInput,
  plan: ToolCallPlan
): Promise<ToolObservation | undefined> {
  if (!input.contextPrerequisite) return undefined;
  const prerequisite = await input.contextPrerequisite({
    call: plan.call,
    toolImplementationId: plan.toolImplementationId,
    input: plan.canonicalSnapshot,
    effects: plan.effects,
    context: input.toolContext
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
  if (ready?.stage !== 'ready') throw new Error(`Tool call ${String(callIndex)} is not ready for plan.`);
  const batchesAtPlanning = input.state().toolBatches;
  const result = await planToolCall(
    call,
    sourceTools(input, phase, call),
    planningContext(input, phase, callIndex, call),
    async (request) => {
      const prerequisite = await input.contextPrerequisite?.(request);
      return prerequisite ? contextRequiredObservation(prerequisite.summary, prerequisite.context) : undefined;
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
  const currentAuthorization = await authorize(input, callPlan);
  const storedApproval =
    ready.approved?.approval.fingerprint === callPlan.fingerprint &&
    ready.approved.approval.policyHash === hashJson(input.toolContext.policy) &&
    hashJson(ready.approved.approval.binding) === hashJson(approvalBinding(callPlan, input.toolContext)) &&
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
    ...toolCallPlanRecord(callPlan, input.toolContext, authorization.decision, authorization.reason),
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
      ...(authorization.reason ? { recovery: authorization.reason } : {})
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
  retained: ToolCallPlan | undefined
): Promise<{ readonly completion: Promise<ToolCallCompletion> }> {
  const call = requireCall(phase, callIndex);
  const callState = phase.callStates[callIndex];
  if (callState?.stage !== 'effect_ready')
    throw new Error(`Tool call ${String(callIndex)} is not ready to start.`);
  const plan = await requireMatchingPlan(input, phase, callIndex, call, callState, retained);
  let lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined;
  let invocation: ToolInvocation | undefined;
  try {
    lease = await acquireLease(input, phase, callIndex, call, callState);
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
    const authorization = await authorize(input, plan);
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
    const prerequisite = await contextPrerequisiteObservation(input, plan);
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
    const started = startExternalEffect(callState.effect, callState.effect.ticket, input.driverGeneration);
    if (started.status !== 'started') throw new Error(`Tool effect start was rejected: ${started.reason}.`);
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
      completion: executeStartedCall(input, phase, callIndex, call, callState, plan, invocation, lease)
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
  lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined
): Promise<ToolCallCompletion> {
  try {
    const observation = await invokeToolCallPlan(invocation, {
      ...input.toolContext,
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
        await input.append(event, toolEventKey(input.runId, identity, `updated:${hashJson(progress)}`));
        await input.emit(event);
      },
      invocation: invocationIdentity(input.runId, phase, callIndex, call, callState.toolAttempt, callState)
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
      if (call.stage !== 'settled') throw new Error('Tool call is not settled for observation recording.');
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
  await appendToolEnded(input, phase, callIndex, call, state);
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
      if (current.stage !== 'recording') throw new Error('Tool call lost its observation-recording state.');
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
    throw new Error(`Planned tool ${call.name} is no longer available: ${result.observation.summary}`);
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

async function authorize(input: ToolExecutionInput, plan: ToolCallPlan) {
  const request = {
    call: plan.call,
    toolImplementationId: plan.toolImplementationId,
    input: plan.canonicalSnapshot,
    effects: plan.effects,
    fingerprint: plan.fingerprint,
    context: input.toolContext
  };
  return (
    enforceAllowedEffects(request) ??
    (await abortableToolBoundary(input.toolContext.signal, () =>
      (input.authorizer ?? POLICY_TOOL_AUTHORIZER)(request)
    ))
  );
}

async function acquireLease(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'effect_ready' }>
) {
  if (input.resourceLeases?.wouldWait(state.plan.effects)) {
    await input.emit({
      type: 'tool.updated',
      ...attemptIdentity(phase, callIndex, call, state.toolAttempt),
      toolName: call.name,
      progress: {
        type: 'status',
        stage: 'resource_lease_waiting',
        message: 'Waiting for an operation holding conflicting resources.'
      }
    });
  }
  return input.resourceLeases?.acquire(
    state.plan.effects,
    `${input.runId}:${phase.toolBatchId}:${String(callIndex)}`,
    input.toolContext.signal
  );
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
    observation
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
  await input.append(
    { type: 'tool.ended', ...identity, toolName: call.name, observation: state.settlement.observation },
    toolEventKey(input.runId, identity, 'ended')
  );
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
  try {
    const record = await input.observationStore.projectToolObservation(
      committed,
      phase.modelInputModalities
    );
    await input.session?.repository.appendObservation(input.session.descriptor, {
      runId: input.runId,
      identity,
      toolName: call.name,
      observation: sessionObservation(state.settlement.observation)
    });
    await input.append(
      {
        type: 'observation.record.created',
        id: record.id,
        ...identity,
        toolName: call.name,
        call: record.call,
        toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function',
        observedFacts: record.observedFacts,
        immediatePresentation: record.immediatePresentation,
        retainedPresentation: record.retainedPresentation,
        ...(record.durableStorageDegraded ? { durableStorageDegraded: record.durableStorageDegraded } : {})
      },
      toolEventKey(input.runId, identity, 'observation')
    );
    input.modelWindow.recordToolResult({
      turnIndex: phase.identity.turnIndex,
      toolName: record.toolName,
      ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function',
      immediateContent: serializeToolObservationPresentation(record.immediatePresentation),
      immediateImages: record.immediateImages
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.append(
      { type: 'observation.recording.failed', id: committed.id, ...identity, toolName: call.name, message },
      toolEventKey(input.runId, identity, 'recording-failed')
    );
    const fallback = minimalToolResultPresentation(state.settlement.observation, call.name, message);
    input.modelWindow.recordToolResult({
      turnIndex: phase.identity.turnIndex,
      toolName: call.name,
      ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function',
      immediateContent: fallback
    });
  }
  await input.emit({
    type: 'tool.ended',
    ...identity,
    toolName: call.name,
    observation: state.settlement.observation
  });
}

function committedFromState(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'recording' }>
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
    fullObservation: state.settlement.observation,
    durableObservation: state.settlement.observation,
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
    observation: committed.durableObservation,
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
  if (issued.status !== 'issued') throw new Error(`Tool effect ticket was rejected: ${issued.reason}.`);
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

function callIdentity(phase: AgentToolPhase, callIndex: number, call: ToolCall): AgentToolCallIdentity {
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
  return {
    runId,
    ...attemptIdentity(phase, callIndex, call, toolAttempt),
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
  await input.transitionTool(procedure, { toolBatchId: phase.toolBatchId, callIndex }, (existing) => {
    if (expectedEffectId) {
      if (existing.stage !== 'effect_ready' || existing.effect.intent.effectId !== expectedEffectId) {
        throw new Error(`Tool call ${String(callIndex)} effect changed before start.`);
      }
    } else if (existing.stage !== 'ready')
      throw new Error(`Tool call ${String(callIndex)} is no longer ready.`);
    return state;
  });
}

function requireCall(phase: AgentToolPhase, callIndex: number): ToolCall {
  const call = phase.calls[callIndex];
  if (!call) throw new Error(`Durable tool call ${String(callIndex)} is missing.`);
  return call;
}

function assertToolDependencies(effects: ToolEffects, callIndex: number, callCount: number): void {
  for (const dependency of effects.dependsOnCallIndices ?? []) {
    if (dependency >= callIndex || dependency >= callCount)
      throw new Error(`Tool call ${String(callIndex)} has invalid dependency ${String(dependency)}.`);
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
function toolEventKey(runId: string, identity: AgentToolCallAttemptIdentity, stage: string): string {
  return `${runId}:tool:${identity.turnId}:${identity.toolBatchId}:${String(identity.callIndex)}:attempt:${String(identity.toolAttempt)}:${stage}`;
}

function sessionObservation(observation: ToolObservation) {
  const artifacts = observationArtifacts(observation);
  return {
    ok: observation.ok,
    summary: observation.summary,
    output: observation.output,
    ...(artifacts.length ? { artifacts } : {}),
    ...(observation.metadata ? { metadata: observation.metadata } : {})
  };
}
function minimalToolResultPresentation(
  observation: ToolObservation,
  toolName: string,
  recordingError: string
): string {
  return JSON.stringify({
    ok: observation.ok,
    title: `${toolName} completed`,
    summary: `${observation.summary} The durable tool result was committed, but its rich model presentation could not be recorded.`,
    scope: observation.scope,
    coverage: observation.scope.coverage,
    results: {
      artifacts: observationArtifacts(observation),
      recordingError: recordingError.slice(0, 1_000)
    }
  });
}
function observationArtifacts(observation: ToolObservation) {
  return [
    ...new Map(
      (observation.content ?? []).flatMap((item) =>
        item.type === 'text' ? [] : [[item.artifact.artifactId, item.artifact] as const]
      )
    ).values()
  ];
}
