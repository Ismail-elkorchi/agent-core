import { hashJson } from '@agent-core/persistence';
import { issueEffectStartTicket, startExternalEffect } from '@agent-core/effects';
import {
  POLICY_TOOL_AUTHORIZER,
  abortableToolBoundary,
  enforceAllowedEffects,
  invokeToolCallPlan,
  policyBlockedObservation,
  planToolCall,
  releaseToolCallPlan,
  releaseToolInvocation,
  startToolCallPlan,
  type ToolCallPlan,
  type ResourceLeaseCoordinator,
  type ToolAuthorizer,
  type ToolCall,
  type ToolDefinition,
  type ToolEffects,
  type ToolInvocation,
  type ToolObservation,
  type ToolPlanningContext,
  type ToolProgress
} from '@agent-core/tools';
import type { AgentAuditEvent, AgentProgressEvent } from '../events.js';
import type { AgentRunControlPhase, AgentRunProcedure } from '../run/control/contracts.js';
import {
  nextStartableToolCallIndex,
  type AgentToolCallState,
  type AgentToolPhase,
  type AgentToolCallPlanRecord,
  type AgentToolSettlementRecord
} from '../run/control/tool-state.js';
import type { AgentApprovalBinding, AgentApprovalRequest, AgentToolCallAttemptIdentity, AgentToolCallIdentity } from '../run/contracts.js';
import type { SessionDescriptor, SessionRepository } from '../session/contracts.js';
import { ModelWindow } from '../inference/model-window.js';
import { ObservationStore, serializeToolObservationPresentation, type CommittedToolObservation } from './observation-store.js';
import type { AgentRunController } from './run-controller.js';

export type ToolBatchExecutionResult =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'waiting_for_approval'; readonly approvals: readonly AgentApprovalRequest[] }
  | { readonly outcome: 'waiting_for_recovery' }
  | { readonly outcome: 'ownership_lost' };

interface ToolExecutionInput {
  readonly runId: string;
  readonly driverGeneration: number;
  readonly tools: readonly ToolDefinition[];
  readonly toolContext: ToolPlanningContext;
  readonly authorizer?: ToolAuthorizer;
  readonly resourceLeases?: ResourceLeaseCoordinator;
  readonly modelWindow: ModelWindow;
  readonly observationStore: ObservationStore;
  readonly session?: { readonly repository: SessionRepository; readonly descriptor: SessionDescriptor };
  readonly controller: AgentRunController;
  readonly phase: () => AgentRunControlPhase;
  readonly transition: (procedure: AgentRunProcedure, update: (phase: AgentRunControlPhase) => AgentRunControlPhase) => Promise<void>;
  readonly settle: (input: { readonly effectId: string; readonly permit: import('@agent-core/effects').EffectSettlementPermit; readonly settlement: AgentToolSettlementRecord }) => Promise<'owned' | 'ownership_lost'>;
  readonly append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}
type ActiveToolCompletion = Readonly<{
  outcome: 'owned' | 'ownership_lost';
  committed: CommittedToolObservation;
}>;

export async function executeAssistantToolCalls(input: ToolExecutionInput): Promise<ToolBatchExecutionResult> {
  const retainedPlans = new Map<number, ToolCallPlan>();
  const active = new Map<number, Promise<ActiveToolCompletion>>();
  const committedObservations = new Map<number, CommittedToolObservation>();
  try {
    for (;;) {
      const phase = input.phase();
      if (phase.kind === 'approval') return { outcome: 'waiting_for_approval', approvals: Object.freeze([phase.approval]) };
      if (phase.kind !== 'tools') throw new Error('Durable tool execution lost its tool-batch state.');
      const durablyCompletedIndex = [...active.keys()].find((callIndex) => phase.callStates[callIndex]?.stage !== 'effect_pending');
      if (durablyCompletedIndex !== undefined) {
        const completion = await active.get(durablyCompletedIndex);
        active.delete(durablyCompletedIndex);
        if (!completion) throw new Error(`Active tool call ${String(durablyCompletedIndex)} lost its completion.`);
        if (completion.outcome === 'ownership_lost') {
          await Promise.allSettled(active.values());
          return { outcome: 'ownership_lost' };
        }
        committedObservations.set(durablyCompletedIndex, completion.committed);
        continue;
      }
      if (phase.nextObservationIndex === phase.calls.length) {
        if (active.size > 0) throw new Error('A completed tool batch still has active invocations.');
        return { outcome: 'completed' };
      }

      const readyIndex = phase.callStates.findIndex((state) => state.stage === 'ready');
      if (readyIndex >= 0) {
        await planAndAuthorizeCall(input, phase, readyIndex, retainedPlans, committedObservations);
        continue;
      }

      const startIndex = nextStartableToolCallIndex(phase, input.driverGeneration);
      if (startIndex !== undefined) {
        const { completion } = await startCall(input, phase, startIndex, retainedPlans.get(startIndex));
        retainedPlans.delete(startIndex);
        active.set(startIndex, completion);
        continue;
      }

      const observationState = phase.callStates[phase.nextObservationIndex];
      if (observationState?.stage === 'settled') {
        await beginObservationRecording(input, phase.nextObservationIndex);
        continue;
      }
      if (observationState?.stage === 'recording') {
        await finishObservationRecording(input, phase, phase.nextObservationIndex, observationState, committedObservations.get(phase.nextObservationIndex));
        committedObservations.delete(phase.nextObservationIndex);
        continue;
      }

      if (active.size > 0) {
        const completed = await firstCompletion(active);
        active.delete(completed.callIndex);
        if (completed.completion.outcome === 'ownership_lost') {
          await Promise.allSettled(active.values());
          return { outcome: 'ownership_lost' };
        }
        committedObservations.set(completed.callIndex, completed.completion.committed);
        continue;
      }

      if (phase.callStates.some((state) => state.stage === 'effect_pending')) {
        throw new Error('A durable pending tool effect has no process-local invocation authority.');
      }
      if (phase.callStates.some((state) => state.stage === 'outcome_unknown')) return { outcome: 'waiting_for_recovery' };
      throw new Error('Durable tool batch has no executable or recoverable call.');
    }
  } catch (error) {
    await Promise.allSettled(active.values());
    throw error;
  } finally {
    await Promise.all([...retainedPlans.values()].map((plan) => releaseToolCallPlan(plan)));
  }
}

async function planAndAuthorizeCall(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  retainedPlans: Map<number, ToolCallPlan>,
  committedObservations: Map<number, CommittedToolObservation>
): Promise<void> {
  const call = requireCall(phase, callIndex);
  const ready = phase.callStates[callIndex];
  if (ready?.stage !== 'ready') throw new Error(`Tool call ${String(callIndex)} is not ready for plan.`);
  const result = await planToolCall(call, input.tools, planningContext(input, phase, callIndex, call));
  if (!result.ok) {
    const committed = await commitObservation(input, phase, call, undefined, result.observation);
    const state: AgentToolCallState = Object.freeze({ stage: 'settled', toolAttempt: 1, settlement: settlementRecord(committed) });
    await replaceCall(input, 'plan_tool_call', callIndex, state);
    await appendToolEnded(input, phase, callIndex, call, state);
    committedObservations.set(callIndex, committed);
    return;
  }

  const callPlan = result.plan;
  assertToolDependencies(callPlan.effects, callIndex, phase.calls.length);
  retainedPlans.set(callIndex, callPlan);
  const currentAuthorization = await authorize(input, callPlan);
  const storedApproval = ready.approved;
  const authorization = storedApproval
    ? currentAuthorization.decision === 'deny'
      ? currentAuthorization
      : storedApproval.decision === 'allow'
        ? { decision: 'allow' as const, ...(currentAuthorization.reason ? { reason: currentAuthorization.reason } : {}) }
        : { decision: 'deny' as const, reason: currentAuthorization.reason ?? storedApproval.approval.reason }
    : currentAuthorization;
  const planRecord = toolCallPlanRecord(callPlan, input.toolContext, authorization.decision, authorization.reason);
  if (!storedApproval) {
    await input.append(authorizationEvent(phase, callIndex, call, callPlan, authorization, input.toolContext), authorizationKey(input.runId, phase, callIndex, callPlan));
  }

  if (authorization.decision === 'require_approval') {
    const approval = approvalRequest(input.runId, phase, callIndex, call, callPlan, authorization.reason, input.toolContext);
    await input.append(approvalEvent(approval), approvalKey(input.runId, approval));
    await input.transition('plan_tool_call', (current) => {
      const batch = requireToolPhase(current);
      requireReadyState(batch, callIndex);
      return Object.freeze({
        kind: 'approval', identity: batch.identity, toolBatchId: batch.toolBatchId, calls: batch.calls,
        callStates: batch.callStates, maxConcurrency: batch.maxConcurrency, nextObservationIndex: batch.nextObservationIndex,
        instructions: batch.instructions, modelInputModalities: batch.modelInputModalities,
        approvalCallIndex: callIndex, plan: planRecord, approval
      });
    });
    await releaseToolCallPlan(callPlan);
    retainedPlans.delete(callIndex);
    return;
  }

  if (authorization.decision === 'deny') {
    const observation = policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
      tool: call.name, policyReason: 'deny', ...(authorization.reason ? { recovery: authorization.reason } : {})
    });
    const committed = await commitObservation(input, phase, call, callPlan, observation);
    const state: AgentToolCallState = Object.freeze({ stage: 'settled', plan: planRecord, toolAttempt: 1, settlement: settlementRecord(committed) });
    await replaceCall(input, 'plan_tool_call', callIndex, state);
    await appendToolEnded(input, phase, callIndex, call, state);
    committedObservations.set(callIndex, committed);
    await releaseToolCallPlan(callPlan);
    retainedPlans.delete(callIndex);
    return;
  }

  const effect = issueToolEffect(input, phase, callIndex, callPlan, 1);
  await replaceCall(input, 'plan_tool_call', callIndex, Object.freeze({ stage: 'effect_ready', plan: planRecord, toolAttempt: 1, effect }));
}

async function startCall(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  retained: ToolCallPlan | undefined
): Promise<{ readonly completion: Promise<ActiveToolCompletion> }> {
  const call = requireCall(phase, callIndex);
  const callState = phase.callStates[callIndex];
  if (callState?.stage !== 'effect_ready') throw new Error(`Tool call ${String(callIndex)} is not ready to start.`);
  const plan = await requireMatchingPreparation(input, phase, callIndex, call, callState, retained);
  let lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined;
  let invocation: ToolInvocation | undefined;
  try {
    lease = await acquireLease(input, phase, callIndex, call, callState);
    const started = startExternalEffect(callState.effect, callState.effect.ticket, input.driverGeneration);
    if (started.status !== 'started') throw new Error(`Tool effect start was rejected: ${started.reason}.`);
    await replaceCall(input, 'start_tool_call', callIndex, Object.freeze({
      stage: 'effect_pending', plan: callState.plan, toolAttempt: callState.toolAttempt, effect: started.state
    }), callState.effect.intent.effectId);
    invocation = await startToolCallPlan(plan, started.state);
    const identity = attemptIdentity(phase, callIndex, call, callState.toolAttempt);
    await input.append({ type: 'tool.started', ...identity, toolName: call.name, input: call, fingerprint: plan.fingerprint, effects: plan.effects }, toolEventKey(input.runId, identity, 'started'));
    await input.emit({ type: 'tool.started', ...identity, toolName: call.name, input: call, fingerprint: plan.fingerprint, effects: plan.effects });
    return Object.freeze({ completion: executeStartedCall(input, phase, callIndex, call, callState, plan, invocation, lease) });
  } catch (error) {
    if (lease && !lease.transferred) lease.release();
    if (invocation) await releaseToolInvocation(invocation);
    else await releaseToolCallPlan(plan);
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
): Promise<ActiveToolCompletion> {
  try {
    const observation = await invokeToolCallPlan(invocation, {
      ...input.toolContext,
      ...(lease ? { resourceLease: lease } : {}),
      emitProgress: (progress) => input.emit({ type: 'tool.updated', ...attemptIdentity(phase, callIndex, call, callState.toolAttempt), toolName: call.name, progress }),
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
      stage: 'settled', plan: callState.plan, toolAttempt: callState.toolAttempt,
      settlement: settlementRecord(committed)
    });
    await appendToolEnded(input, phase, callIndex, call, settled);
    return Object.freeze({ outcome: ownership, committed });
  } finally {
    if (lease && !lease.transferred) lease.release();
    await releaseToolInvocation(invocation);
  }
}

async function beginObservationRecording(input: ToolExecutionInput, callIndex: number): Promise<void> {
  await input.transition('begin_observation_recording', (current) => {
    const phase = requireToolPhase(current);
    if (phase.nextObservationIndex !== callIndex) throw new Error('The ordered observation prefix changed before recording began.');
    const state = phase.callStates[callIndex];
    if (state?.stage !== 'settled') throw new Error(`Tool call ${String(callIndex)} is not settled for observation recording.`);
    return withCallState(phase, callIndex, Object.freeze({ ...state, stage: 'recording' }));
  });
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
  await recordObservation(input, phase, callIndex, call, state, retained ?? committedFromState(input, phase, call, state));
  input.controller.recordToolResult(state.settlement.observation.ok);
  await input.transition('record_tool_observation', (current) => {
    const batch = requireToolPhase(current);
    if (batch.nextObservationIndex !== callIndex) throw new Error('The ordered observation prefix changed during recording.');
    const currentState = batch.callStates[callIndex];
    if (currentState?.stage !== 'recording') throw new Error(`Tool call ${String(callIndex)} lost its observation-recording state.`);
    return Object.freeze({
      ...withCallState(batch, callIndex, Object.freeze({ ...currentState, stage: 'recorded' })),
      nextObservationIndex: callIndex + 1
    });
  });
}

async function firstCompletion(active: ReadonlyMap<number, Promise<ActiveToolCompletion>>): Promise<{ readonly callIndex: number; readonly completion: ActiveToolCompletion }> {
  return Promise.race([...active].map(async ([callIndex, completion]) => Object.freeze({ callIndex, completion: await completion })));
}

function planningContext(input: ToolExecutionInput, phase: AgentToolPhase, callIndex: number, call: ToolCall, toolAttempt = 1): ToolPlanningContext {
  const identity = attemptIdentity(phase, callIndex, call, toolAttempt);
  return Object.freeze({
    ...input.toolContext,
    invocation: invocationIdentity(input.runId, phase, callIndex, call, toolAttempt),
    emitProgress: (progress: ToolProgress) => input.emit({ type: 'tool.updated', ...identity, toolName: call.name, progress }),
    persistProgressCheckpoint: async (progress: ToolProgress) => {
      const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
      await input.append(event, toolEventKey(input.runId, identity, `plan:${hashJson(progress)}`));
      await input.emit(event);
    }
  });
}

async function requireMatchingPreparation(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'effect_ready' }>,
  retained: ToolCallPlan | undefined
): Promise<ToolCallPlan> {
  if (retained) return retained;
  const result = await planToolCall(call, input.tools, planningContext(input, phase, callIndex, call, state.toolAttempt));
  if (!result.ok) throw new Error(`Planned tool ${call.name} is no longer available: ${result.observation.summary}`);
  const plan = result.plan;
  if (plan.toolImplementationId !== state.plan.toolImplementationId || plan.fingerprint !== state.plan.fingerprint) {
    await releaseToolCallPlan(plan);
    throw new Error(`Planned tool ${call.name} no longer matches its durable intent.`);
  }
  return plan;
}

async function authorize(input: ToolExecutionInput, plan: ToolCallPlan) {
  const request = { call: plan.call, toolImplementationId: plan.toolImplementationId, input: plan.canonicalSnapshot, effects: plan.effects, fingerprint: plan.fingerprint, context: input.toolContext };
  return enforceAllowedEffects(request)
    ?? await abortableToolBoundary(input.toolContext.signal, () => (input.authorizer ?? POLICY_TOOL_AUTHORIZER)(request));
}

async function acquireLease(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'effect_ready' }>
) {
  if (input.resourceLeases?.wouldWait(state.plan.effects)) {
    await input.emit({ type: 'tool.updated', ...attemptIdentity(phase, callIndex, call, state.toolAttempt), toolName: call.name, progress: {
      type: 'status', stage: 'resource_lease_waiting', message: 'Waiting for a conflicting resource lease held by another run.'
    } });
  }
  return input.resourceLeases?.acquire(state.plan.effects, `${input.runId}:${phase.toolBatchId}:${String(callIndex)}`, input.toolContext.signal);
}

async function commitObservation(input: ToolExecutionInput, phase: AgentToolPhase, call: ToolCall, plan: ToolCallPlan | undefined, observation: ToolObservation): Promise<CommittedToolObservation> {
  return input.observationStore.commitToolObservation({
    turnIndex: phase.identity.turnIndex,
    call,
    ...(plan ? { canonicalSnapshot: plan.canonicalSnapshot } : {}),
    tool: input.tools.find((tool) => tool.name === call.name && tool.implementationId === plan?.toolImplementationId),
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
  await input.append({ type: 'tool.ended', ...identity, toolName: call.name, observation: state.settlement.observation }, toolEventKey(input.runId, identity, 'ended'));
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
    const record = await input.observationStore.projectToolObservation(committed, phase.modelInputModalities);
    await input.session?.repository.appendObservation(input.session.descriptor, {
      runId: input.runId, identity, toolName: call.name, observation: sessionObservation(state.settlement.observation)
    });
    await input.append({
      type: 'observation.record.created', id: record.id, ...identity, toolName: call.name, call: record.call,
      toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function', observedFacts: record.observedFacts,
      immediatePresentation: record.immediatePresentation, retainedPresentation: record.retainedPresentation,
      ...(record.durableStorageDegraded ? { durableStorageDegraded: record.durableStorageDegraded } : {})
    }, toolEventKey(input.runId, identity, 'observation'));
    input.modelWindow.recordToolResult({
      turnIndex: phase.identity.turnIndex, toolName: record.toolName, ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function',
      immediateContent: serializeToolObservationPresentation(record.immediatePresentation),
      retainedContent: serializeToolObservationPresentation(record.retainedPresentation),
      immediateImages: record.immediateImages, imageArtifacts: record.imageArtifacts, observedFacts: [...record.observedFacts]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.append({ type: 'observation.recording.failed', id: committed.id, ...identity, toolName: call.name, message }, toolEventKey(input.runId, identity, 'recording-failed'));
    const fallback = minimalToolResultPresentation(state.settlement.observation, call.name, message);
    input.modelWindow.recordToolResult({
      turnIndex: phase.identity.turnIndex, toolName: call.name, ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function', immediateContent: fallback, retainedContent: fallback
    });
  }
  await input.emit({ type: 'tool.ended', ...identity, toolName: call.name, observation: state.settlement.observation });
}

function committedFromState(
  input: ToolExecutionInput,
  phase: AgentToolPhase,
  call: ToolCall,
  state: Extract<AgentToolCallState, { readonly stage: 'recording' }>
): CommittedToolObservation {
  const tool = state.plan ? input.tools.find((modelOutput) => modelOutput.name === call.name && modelOutput.implementationId === state.plan?.toolImplementationId) : undefined;
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

function toolCallPlanRecord(plan: ToolCallPlan, context: ToolPlanningContext, authorization: AgentToolCallPlanRecord['authorization'], reason: string | undefined): AgentToolCallPlanRecord {
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
  return Object.freeze({ observationId: committed.id, observation: committed.durableObservation, createdAt: committed.createdAt });
}

function issueToolEffect(input: ToolExecutionInput, phase: AgentToolPhase, callIndex: number, plan: ToolCallPlan, toolAttempt: number) {
  const effectId = `${input.runId}:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:${String(toolAttempt)}`;
  const issued = issueEffectStartTicket({
    intent: { effectId, ownerId: input.runId, implementationId: plan.toolImplementationId, parametersDigest: plan.fingerprint, recovery: plan.effects.recovery, exposure: TOOL_INVOCATION_EXPOSURE },
    ticketId: `${effectId}:start`, settlementPermitId: `${effectId}:settle`,
    driverGeneration: input.driverGeneration, currentDriverGeneration: input.driverGeneration
  });
  if (issued.status !== 'issued') throw new Error(`Tool effect ticket was rejected: ${issued.reason}.`);
  return issued.state;
}

const TOOL_INVOCATION_EXPOSURE = Object.freeze({
  quantities: Object.freeze([Object.freeze({ unit: 'tool_invocations', amount: 1 })])
});

function approvalRequest(runId: string, phase: AgentToolPhase, callIndex: number, call: ToolCall, plan: ToolCallPlan, reason: string, context: ToolPlanningContext): AgentApprovalRequest {
  const identity = callIdentity(phase, callIndex, call);
  const approvalId = `approval-${hashJson({ runId, ...identity, fingerprint: plan.fingerprint }).slice(0, 32)}`;
  return Object.freeze({ ...identity, approvalId, status: 'pending', toolName: call.name, fingerprint: plan.fingerprint, input: plan.canonicalSnapshot, effects: plan.effects, binding: approvalBinding(plan, context), policyHash: hashJson(context.policy), reason, runId });
}

function authorizationEvent(phase: AgentToolPhase, callIndex: number, call: ToolCall, plan: ToolCallPlan, authorization: Awaited<ReturnType<typeof authorize>>, context: ToolPlanningContext): AgentAuditEvent {
  return { type: 'tool.authorization.decided', ...callIdentity(phase, callIndex, call), toolName: call.name, fingerprint: plan.fingerprint, binding: approvalBinding(plan, context), decision: authorization.decision, ...(authorization.reason ? { reason: authorization.reason } : {}) };
}

function approvalEvent(approval: AgentApprovalRequest): AgentAuditEvent {
  return { type: 'approval.requested', runId: approval.runId, turnIndex: approval.turnIndex, turnId: approval.turnId, requestAttempt: approval.requestAttempt, toolBatchId: approval.toolBatchId, callIndex: approval.callIndex, ...(approval.callId ? { callId: approval.callId } : {}), approvalId: approval.approvalId, toolName: approval.toolName, fingerprint: approval.fingerprint, input: approval.input, effects: approval.effects, binding: approval.binding, policyHash: approval.policyHash, reason: approval.reason };
}

function approvalBinding(plan: ToolCallPlan, context: ToolPlanningContext): AgentApprovalBinding {
  return Object.freeze({ toolImplementationId: plan.toolImplementationId, authorizationPolicyId: context.boundary.authorizationPolicyId, executionTargetId: context.boundary.executionTargetId });
}

function callIdentity(phase: AgentToolPhase, callIndex: number, call: ToolCall): AgentToolCallIdentity {
  return { ...phase.identity, toolBatchId: phase.toolBatchId, callIndex, ...(call.id ? { callId: call.id } : {}) };
}

function attemptIdentity(phase: AgentToolPhase, callIndex: number, call: ToolCall, toolAttempt: number): AgentToolCallAttemptIdentity {
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
  const recovery = state && toolAttempt > 1 && state.effect.intent.recovery.kind === 'preconditioned_reexecution'
    ? Object.freeze({ kind: state.effect.intent.recovery.kind, preconditions: state.effect.intent.recovery.preconditions })
    : undefined;
  return { runId, ...attemptIdentity(phase, callIndex, call, toolAttempt), ...(recovery ? { recovery } : {}) };
}

async function replaceCall(
  input: ToolExecutionInput,
  procedure: AgentRunProcedure,
  callIndex: number,
  state: AgentToolCallState,
  expectedEffectId?: string
): Promise<void> {
  await input.transition(procedure, (current) => {
    const phase = requireToolPhase(current);
    if (expectedEffectId) {
      const existing = phase.callStates[callIndex];
      if (existing?.stage !== 'effect_ready' || existing.effect.intent.effectId !== expectedEffectId) {
        throw new Error(`Tool call ${String(callIndex)} effect changed before start.`);
      }
    } else requireReadyState(phase, callIndex);
    return withCallState(phase, callIndex, state);
  });
}

function withCallState(phase: AgentToolPhase, callIndex: number, state: AgentToolCallState): AgentToolPhase {
  if (callIndex < 0 || callIndex >= phase.callStates.length) throw new Error(`Tool call state ${String(callIndex)} is missing.`);
  const callStates = [...phase.callStates];
  callStates[callIndex] = state;
  return Object.freeze({ ...phase, callStates: Object.freeze(callStates) });
}

function requireToolPhase(phase: AgentRunControlPhase): AgentToolPhase {
  if (phase.kind !== 'tools') throw new Error('Durable run is not executing a tool batch.');
  return phase;
}

function requireReadyState(phase: AgentToolPhase, callIndex: number): void {
  if (phase.callStates[callIndex]?.stage !== 'ready') throw new Error(`Tool call ${String(callIndex)} is no longer ready.`);
}

function requireCall(phase: AgentToolPhase, callIndex: number): ToolCall {
  const call = phase.calls[callIndex];
  if (!call) throw new Error(`Durable tool call ${String(callIndex)} is missing.`);
  return call;
}

function assertToolDependencies(effects: ToolEffects, callIndex: number, callCount: number): void {
  for (const dependency of effects.dependsOnCallIndices ?? []) {
    if (dependency >= callIndex || dependency >= callCount) throw new Error(`Tool call ${String(callIndex)} has invalid dependency ${String(dependency)}.`);
  }
}

function authorizationKey(runId: string, phase: AgentToolPhase, callIndex: number, plan: ToolCallPlan): string {
  return `${runId}:tool:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:authorization:${plan.fingerprint}`;
}
function approvalKey(runId: string, approval: AgentApprovalRequest): string { return `${runId}:approval:${approval.approvalId}:requested`; }
function toolEventKey(runId: string, identity: AgentToolCallAttemptIdentity, stage: string): string { return `${runId}:tool:${identity.turnId}:${identity.toolBatchId}:${String(identity.callIndex)}:attempt:${String(identity.toolAttempt)}:${stage}`; }

function sessionObservation(observation: ToolObservation) {
  const artifacts = observationArtifacts(observation);
  return { ok: observation.ok, summary: observation.summary, output: observation.output, ...(artifacts.length ? { artifacts } : {}), ...(observation.metadata ? { metadata: observation.metadata } : {}) };
}
function minimalToolResultPresentation(observation: ToolObservation, toolName: string, recordingError: string): string {
  return JSON.stringify({ ok: observation.ok, title: `${toolName} completed`, summary: `${observation.summary} The durable tool result was committed, but its rich model presentation could not be recorded.`, scope: observation.scope, coverage: observation.scope.coverage, results: { artifacts: observationArtifacts(observation), recordingError: recordingError.slice(0, 1_000) } });
}
function observationArtifacts(observation: ToolObservation) { return [...new Map((observation.content ?? []).flatMap((item) => item.type === 'text' ? [] : [[item.artifact.artifactId, item.artifact] as const])).values()]; }
