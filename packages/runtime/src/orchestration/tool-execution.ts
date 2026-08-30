import { hashJson } from '@agent-core/evidence';
import { issueEffectStartTicket, startExternalEffect } from '@agent-core/effects';
import {
  POLICY_TOOL_AUTHORIZER,
  abortableToolBoundary,
  enforceAllowedEffects,
  invokePreparedToolCall,
  policyBlockedObservation,
  prepareToolCall,
  releasePreparedToolCall,
  releaseToolInvocation,
  startPreparedToolCall,
  type PreparedToolCall,
  type ResourceLeaseCoordinator,
  type ToolAuthorizer,
  type ToolCall,
  type ToolDefinition,
  type ToolEffects,
  type ToolInvocation,
  type ToolObservation,
  type ToolPreparationContext,
  type ToolProgress
} from '@agent-core/tools';
import type { AgentAuditEvent, AgentProgressEvent } from '../events.js';
import type { AgentOperationPhase, AgentOperationProcedure } from '../operation/contracts.js';
import {
  nextStartableToolCallIndex,
  type AgentToolCallOperationState,
  type AgentToolOperationPhase,
  type AgentToolPreparationRecord,
  type AgentToolSettlementRecord
} from '../operation/tool-state.js';
import type { AgentApprovalBinding, AgentApprovalRequest, AgentToolCallAttemptIdentity, AgentToolCallIdentity } from '../run/contracts.js';
import type { SessionDescriptor, SessionRepository } from '../session/contracts.js';
import { ContextManager } from '../context/manager.js';
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
  readonly toolContext: ToolPreparationContext;
  readonly authorizer?: ToolAuthorizer;
  readonly resourceLeases?: ResourceLeaseCoordinator;
  readonly contextManager: ContextManager;
  readonly observationStore: ObservationStore;
  readonly session?: { readonly repository: SessionRepository; readonly descriptor: SessionDescriptor };
  readonly controller: AgentRunController;
  readonly phase: () => AgentOperationPhase;
  readonly transition: (procedure: AgentOperationProcedure, update: (phase: AgentOperationPhase) => AgentOperationPhase) => Promise<void>;
  readonly settle: (input: { readonly effectId: string; readonly permit: import('@agent-core/effects').EffectSettlementPermit; readonly settlement: AgentToolSettlementRecord }) => Promise<'owned' | 'ownership_lost'>;
  readonly append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}
type ActiveToolCompletion = Readonly<{
  outcome: 'owned' | 'ownership_lost';
  committed: CommittedToolObservation;
}>;

export async function executeAssistantToolCalls(input: ToolExecutionInput): Promise<ToolBatchExecutionResult> {
  const retainedPreparations = new Map<number, PreparedToolCall>();
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
      if (phase.nextProjectionIndex === phase.calls.length) {
        if (active.size > 0) throw new Error('A completed tool batch still has active invocations.');
        return { outcome: 'completed' };
      }

      const readyIndex = phase.callStates.findIndex((state) => state.stage === 'ready');
      if (readyIndex >= 0) {
        await prepareAndAuthorizeCall(input, phase, readyIndex, retainedPreparations, committedObservations);
        continue;
      }

      const startIndex = nextStartableToolCallIndex(phase, input.driverGeneration);
      if (startIndex !== undefined) {
        const { completion } = await startCall(input, phase, startIndex, retainedPreparations.get(startIndex));
        retainedPreparations.delete(startIndex);
        active.set(startIndex, completion);
        continue;
      }

      const projectionState = phase.callStates[phase.nextProjectionIndex];
      if (projectionState?.stage === 'settled') {
        await beginProjection(input, phase.nextProjectionIndex);
        continue;
      }
      if (projectionState?.stage === 'projecting') {
        await finishProjection(input, phase, phase.nextProjectionIndex, projectionState, committedObservations.get(phase.nextProjectionIndex));
        committedObservations.delete(phase.nextProjectionIndex);
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
    await Promise.all([...retainedPreparations.values()].map((prepared) => releasePreparedToolCall(prepared)));
  }
}

async function prepareAndAuthorizeCall(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  retainedPreparations: Map<number, PreparedToolCall>,
  committedObservations: Map<number, CommittedToolObservation>
): Promise<void> {
  const call = requireCall(phase, callIndex);
  const ready = phase.callStates[callIndex];
  if (ready?.stage !== 'ready') throw new Error(`Tool call ${String(callIndex)} is not ready for preparation.`);
  const result = await prepareToolCall(call, input.tools, preparationContext(input, phase, callIndex, call));
  if (!result.ok) {
    const committed = await commitObservation(input, phase, call, undefined, result.observation);
    const state: AgentToolCallOperationState = Object.freeze({ stage: 'settled', toolAttempt: 1, settlement: settlementRecord(committed) });
    await replaceCall(input, 'prepare_tool_call', callIndex, state);
    await appendToolEnded(input, phase, callIndex, call, state);
    committedObservations.set(callIndex, committed);
    return;
  }

  const prepared = result.prepared;
  assertToolDependencies(prepared.effects, callIndex, phase.calls.length);
  retainedPreparations.set(callIndex, prepared);
  const currentAuthorization = await authorize(input, prepared);
  const storedApproval = ready.approved;
  const authorization = storedApproval
    ? currentAuthorization.decision === 'deny'
      ? currentAuthorization
      : storedApproval.decision === 'allow'
        ? { decision: 'allow' as const, ...(currentAuthorization.reason ? { reason: currentAuthorization.reason } : {}) }
        : { decision: 'deny' as const, reason: currentAuthorization.reason ?? storedApproval.approval.reason }
    : currentAuthorization;
  const preparation = preparationRecord(prepared, input.toolContext, authorization.decision, authorization.reason);
  if (!storedApproval) {
    await input.append(authorizationEvent(phase, callIndex, call, prepared, authorization, input.toolContext), authorizationKey(input.runId, phase, callIndex, prepared));
  }

  if (authorization.decision === 'require_approval') {
    const approval = approvalRequest(input.runId, phase, callIndex, call, prepared, authorization.reason, input.toolContext);
    await input.append(approvalEvent(approval), approvalKey(input.runId, approval));
    await input.transition('prepare_tool_call', (current) => {
      const batch = requireToolPhase(current);
      requireReadyState(batch, callIndex);
      return Object.freeze({
        kind: 'approval', identity: batch.identity, toolBatchId: batch.toolBatchId, calls: batch.calls,
        callStates: batch.callStates, maxConcurrency: batch.maxConcurrency, nextProjectionIndex: batch.nextProjectionIndex,
        instructions: batch.instructions, modelInputModalities: batch.modelInputModalities,
        approvalCallIndex: callIndex, preparation, approval
      });
    });
    await releasePreparedToolCall(prepared);
    retainedPreparations.delete(callIndex);
    return;
  }

  if (authorization.decision === 'deny') {
    const observation = policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
      tool: call.name, policyReason: 'deny', ...(authorization.reason ? { recovery: authorization.reason } : {})
    });
    const committed = await commitObservation(input, phase, call, prepared, observation);
    const state: AgentToolCallOperationState = Object.freeze({ stage: 'settled', preparation, toolAttempt: 1, settlement: settlementRecord(committed) });
    await replaceCall(input, 'prepare_tool_call', callIndex, state);
    await appendToolEnded(input, phase, callIndex, call, state);
    committedObservations.set(callIndex, committed);
    await releasePreparedToolCall(prepared);
    retainedPreparations.delete(callIndex);
    return;
  }

  const effect = issueToolEffect(input, phase, callIndex, prepared, 1);
  await replaceCall(input, 'prepare_tool_call', callIndex, Object.freeze({ stage: 'effect_ready', preparation, toolAttempt: 1, effect }));
}

async function startCall(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  retained: PreparedToolCall | undefined
): Promise<{ readonly completion: Promise<ActiveToolCompletion> }> {
  const call = requireCall(phase, callIndex);
  const callState = phase.callStates[callIndex];
  if (callState?.stage !== 'effect_ready') throw new Error(`Tool call ${String(callIndex)} is not ready to start.`);
  const prepared = await requireMatchingPreparation(input, phase, callIndex, call, callState, retained);
  let lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined;
  let invocation: ToolInvocation | undefined;
  try {
    lease = await acquireLease(input, phase, callIndex, call, callState);
    const started = startExternalEffect(callState.effect, callState.effect.ticket, input.driverGeneration);
    if (started.status !== 'started') throw new Error(`Tool effect start was rejected: ${started.reason}.`);
    await replaceCall(input, 'start_tool_call', callIndex, Object.freeze({
      stage: 'effect_pending', preparation: callState.preparation, toolAttempt: callState.toolAttempt, effect: started.state
    }), callState.effect.intent.effectId);
    invocation = await startPreparedToolCall(prepared, started.state);
    const identity = attemptIdentity(phase, callIndex, call, callState.toolAttempt);
    await input.append({ type: 'tool.started', ...identity, toolName: call.name, input: call, fingerprint: prepared.fingerprint, effects: prepared.effects }, toolEventKey(input.runId, identity, 'started'));
    await input.emit({ type: 'tool.started', ...identity, toolName: call.name, input: call, fingerprint: prepared.fingerprint, effects: prepared.effects });
    return Object.freeze({ completion: executeStartedCall(input, phase, callIndex, call, callState, prepared, invocation, lease) });
  } catch (error) {
    if (lease && !lease.transferred) lease.release();
    if (invocation) await releaseToolInvocation(invocation);
    else await releasePreparedToolCall(prepared);
    throw error;
  }
}

async function executeStartedCall(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  call: ToolCall,
  callState: Extract<AgentToolCallOperationState, { readonly stage: 'effect_ready' }>,
  prepared: PreparedToolCall,
  invocation: ToolInvocation,
  lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined
): Promise<ActiveToolCompletion> {
  try {
    const observation = await invokePreparedToolCall(invocation, {
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
    const committed = await commitObservation(input, phase, call, prepared, observation);
    const ownership = await input.settle({
      effectId: callState.effect.intent.effectId,
      permit: callState.effect.settlementPermit,
      settlement: settlementRecord(committed)
    });
    if (ownership === 'ownership_lost') return Object.freeze({ outcome: ownership, committed });
    const settled: AgentToolCallOperationState = Object.freeze({
      stage: 'settled', preparation: callState.preparation, toolAttempt: callState.toolAttempt,
      settlement: settlementRecord(committed)
    });
    await appendToolEnded(input, phase, callIndex, call, settled);
    return Object.freeze({ outcome: ownership, committed });
  } finally {
    if (lease && !lease.transferred) lease.release();
    await releaseToolInvocation(invocation);
  }
}

async function beginProjection(input: ToolExecutionInput, callIndex: number): Promise<void> {
  await input.transition('prepare_tool_projection', (current) => {
    const phase = requireToolPhase(current);
    if (phase.nextProjectionIndex !== callIndex) throw new Error('Tool projection prefix changed before projection preparation.');
    const state = phase.callStates[callIndex];
    if (state?.stage !== 'settled') throw new Error(`Tool call ${String(callIndex)} is not settled for projection.`);
    return withCallState(phase, callIndex, Object.freeze({ ...state, stage: 'projecting' }));
  });
}

async function finishProjection(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  state: Extract<AgentToolCallOperationState, { readonly stage: 'projecting' }>,
  retained: CommittedToolObservation | undefined
): Promise<void> {
  const call = requireCall(phase, callIndex);
  await appendToolEnded(input, phase, callIndex, call, state);
  await projectObservation(input, phase, callIndex, call, state, retained ?? committedFromState(input, phase, call, state));
  input.controller.recordToolResult(state.settlement.observation.ok);
  await input.transition('project_tool_settlement', (current) => {
    const batch = requireToolPhase(current);
    if (batch.nextProjectionIndex !== callIndex) throw new Error('Tool projection prefix changed during projection.');
    const currentState = batch.callStates[callIndex];
    if (currentState?.stage !== 'projecting') throw new Error(`Tool call ${String(callIndex)} lost its projecting state.`);
    return Object.freeze({
      ...withCallState(batch, callIndex, Object.freeze({ ...currentState, stage: 'projected' })),
      nextProjectionIndex: callIndex + 1
    });
  });
}

async function firstCompletion(active: ReadonlyMap<number, Promise<ActiveToolCompletion>>): Promise<{ readonly callIndex: number; readonly completion: ActiveToolCompletion }> {
  return Promise.race([...active].map(async ([callIndex, completion]) => Object.freeze({ callIndex, completion: await completion })));
}

function preparationContext(input: ToolExecutionInput, phase: AgentToolOperationPhase, callIndex: number, call: ToolCall, toolAttempt = 1): ToolPreparationContext {
  const identity = attemptIdentity(phase, callIndex, call, toolAttempt);
  return Object.freeze({
    ...input.toolContext,
    invocation: invocationIdentity(input.runId, phase, callIndex, call, toolAttempt),
    emitProgress: (progress: ToolProgress) => input.emit({ type: 'tool.updated', ...identity, toolName: call.name, progress }),
    persistProgressCheckpoint: async (progress: ToolProgress) => {
      const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
      await input.append(event, toolEventKey(input.runId, identity, `preparation:${hashJson(progress)}`));
      await input.emit(event);
    }
  });
}

async function requireMatchingPreparation(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallOperationState, { readonly stage: 'effect_ready' }>,
  retained: PreparedToolCall | undefined
): Promise<PreparedToolCall> {
  if (retained) return retained;
  const result = await prepareToolCall(call, input.tools, preparationContext(input, phase, callIndex, call, state.toolAttempt));
  if (!result.ok) throw new Error(`Prepared tool ${call.name} is no longer available: ${result.observation.summary}`);
  const prepared = result.prepared;
  if (prepared.toolImplementationId !== state.preparation.toolImplementationId || prepared.fingerprint !== state.preparation.fingerprint) {
    await releasePreparedToolCall(prepared);
    throw new Error(`Prepared tool ${call.name} no longer matches its durable intent.`);
  }
  return prepared;
}

async function authorize(input: ToolExecutionInput, prepared: PreparedToolCall) {
  const request = { call: prepared.call, toolImplementationId: prepared.toolImplementationId, input: prepared.canonicalSnapshot, effects: prepared.effects, fingerprint: prepared.fingerprint, context: input.toolContext };
  return enforceAllowedEffects(request)
    ?? await abortableToolBoundary(input.toolContext.signal, () => (input.authorizer ?? POLICY_TOOL_AUTHORIZER)(request));
}

async function acquireLease(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallOperationState, { readonly stage: 'effect_ready' }>
) {
  if (input.resourceLeases?.wouldWait(state.preparation.effects)) {
    await input.emit({ type: 'tool.updated', ...attemptIdentity(phase, callIndex, call, state.toolAttempt), toolName: call.name, progress: {
      type: 'status', stage: 'resource_lease_waiting', message: 'Waiting for a conflicting resource lease held by another operation.'
    } });
  }
  return input.resourceLeases?.acquire(state.preparation.effects, `${input.runId}:${phase.toolBatchId}:${String(callIndex)}`, input.toolContext.signal);
}

async function commitObservation(input: ToolExecutionInput, phase: AgentToolOperationPhase, call: ToolCall, prepared: PreparedToolCall | undefined, observation: ToolObservation): Promise<CommittedToolObservation> {
  return input.observationStore.commitToolObservation({
    turnIndex: phase.identity.turnIndex,
    call,
    ...(prepared ? { canonicalSnapshot: prepared.canonicalSnapshot } : {}),
    tool: input.tools.find((tool) => tool.name === call.name && tool.implementationId === prepared?.toolImplementationId),
    observation
  });
}

async function appendToolEnded(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallOperationState, { readonly stage: 'settled' | 'projecting' | 'projected' }>
): Promise<void> {
  const identity = attemptIdentity(phase, callIndex, call, state.toolAttempt);
  await input.append({ type: 'tool.ended', ...identity, toolName: call.name, observation: state.settlement.observation }, toolEventKey(input.runId, identity, 'ended'));
}

async function projectObservation(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  callIndex: number,
  call: ToolCall,
  state: Extract<AgentToolCallOperationState, { readonly stage: 'projecting' }>,
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
      toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function', evidence: record.evidence,
      immediatePresentation: record.immediatePresentation, retainedPresentation: record.retainedPresentation,
      ...(record.durableStorageDegraded ? { durableStorageDegraded: record.durableStorageDegraded } : {})
    }, toolEventKey(input.runId, identity, 'observation'));
    input.contextManager.recordToolResult({
      turnIndex: phase.identity.turnIndex, toolName: record.toolName, ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function',
      immediateContent: serializeToolObservationPresentation(record.immediatePresentation),
      retainedContent: serializeToolObservationPresentation(record.retainedPresentation),
      immediateImages: record.immediateImages, imageArtifacts: record.imageArtifacts, evidence: [...record.evidence]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.append({ type: 'observation.projection.failed', id: committed.id, ...identity, toolName: call.name, message }, toolEventKey(input.runId, identity, 'projection-failed'));
    const fallback = minimalToolResultProjection(state.settlement.observation, call.name, message);
    input.contextManager.recordToolResult({
      turnIndex: phase.identity.turnIndex, toolName: call.name, ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function', immediateContent: fallback, retainedContent: fallback
    });
  }
  await input.emit({ type: 'tool.ended', ...identity, toolName: call.name, observation: state.settlement.observation });
}

function committedFromState(
  input: ToolExecutionInput,
  phase: AgentToolOperationPhase,
  call: ToolCall,
  state: Extract<AgentToolCallOperationState, { readonly stage: 'projecting' }>
): CommittedToolObservation {
  const tool = state.preparation ? input.tools.find((candidate) => candidate.name === call.name && candidate.implementationId === state.preparation?.toolImplementationId) : undefined;
  return Object.freeze({
    id: state.settlement.observationId,
    turnIndex: phase.identity.turnIndex,
    call,
    toolName: call.name,
    ...(state.preparation ? { canonicalSnapshot: state.preparation.canonicalInput } : {}),
    tool,
    fullObservation: state.settlement.observation,
    durableObservation: state.settlement.observation,
    createdAt: state.settlement.createdAt
  });
}

function preparationRecord(prepared: PreparedToolCall, context: ToolPreparationContext, authorization: AgentToolPreparationRecord['authorization'], reason: string | undefined): AgentToolPreparationRecord {
  return Object.freeze({
    toolImplementationId: prepared.toolImplementationId,
    canonicalInput: prepared.canonicalSnapshot,
    fingerprint: prepared.fingerprint,
    effects: prepared.effects,
    binding: approvalBinding(prepared, context),
    authorization,
    ...(reason ? { authorizationReason: reason } : {})
  });
}

function settlementRecord(committed: CommittedToolObservation): AgentToolSettlementRecord {
  return Object.freeze({ observationId: committed.id, observation: committed.durableObservation, createdAt: committed.createdAt });
}

function issueToolEffect(input: ToolExecutionInput, phase: AgentToolOperationPhase, callIndex: number, prepared: PreparedToolCall, toolAttempt: number) {
  const effectId = `${input.runId}:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:${String(toolAttempt)}`;
  const issued = issueEffectStartTicket({
    intent: { effectId, operationId: input.runId, implementationId: prepared.toolImplementationId, parametersDigest: prepared.fingerprint, recovery: prepared.effects.recovery, exposure: TOOL_INVOCATION_EXPOSURE },
    ticketId: `${effectId}:start`, settlementPermitId: `${effectId}:settle`,
    driverGeneration: input.driverGeneration, currentDriverGeneration: input.driverGeneration
  });
  if (issued.status !== 'issued') throw new Error(`Tool effect ticket was rejected: ${issued.reason}.`);
  return issued.state;
}

const TOOL_INVOCATION_EXPOSURE = Object.freeze({
  quantities: Object.freeze([Object.freeze({ unit: 'tool_invocations', amount: 1 })])
});

function approvalRequest(runId: string, phase: AgentToolOperationPhase, callIndex: number, call: ToolCall, prepared: PreparedToolCall, reason: string, context: ToolPreparationContext): AgentApprovalRequest {
  const identity = callIdentity(phase, callIndex, call);
  const approvalId = `approval-${hashJson({ runId, ...identity, fingerprint: prepared.fingerprint }).slice(0, 32)}`;
  return Object.freeze({ ...identity, approvalId, status: 'pending', toolName: call.name, fingerprint: prepared.fingerprint, input: prepared.canonicalSnapshot, effects: prepared.effects, binding: approvalBinding(prepared, context), policyHash: hashJson(context.policy), reason, runId });
}

function authorizationEvent(phase: AgentToolOperationPhase, callIndex: number, call: ToolCall, prepared: PreparedToolCall, authorization: Awaited<ReturnType<typeof authorize>>, context: ToolPreparationContext): AgentAuditEvent {
  return { type: 'tool.authorization.decided', ...callIdentity(phase, callIndex, call), toolName: call.name, fingerprint: prepared.fingerprint, binding: approvalBinding(prepared, context), decision: authorization.decision, ...(authorization.reason ? { reason: authorization.reason } : {}) };
}

function approvalEvent(approval: AgentApprovalRequest): AgentAuditEvent {
  return { type: 'approval.requested', runId: approval.runId, turnIndex: approval.turnIndex, turnId: approval.turnId, requestAttempt: approval.requestAttempt, toolBatchId: approval.toolBatchId, callIndex: approval.callIndex, ...(approval.callId ? { callId: approval.callId } : {}), approvalId: approval.approvalId, toolName: approval.toolName, fingerprint: approval.fingerprint, input: approval.input, effects: approval.effects, binding: approval.binding, policyHash: approval.policyHash, reason: approval.reason };
}

function approvalBinding(prepared: PreparedToolCall, context: ToolPreparationContext): AgentApprovalBinding {
  return Object.freeze({ toolImplementationId: prepared.toolImplementationId, authorizationPolicyId: context.boundary.authorizationPolicyId, executionTargetId: context.boundary.executionTargetId });
}

function callIdentity(phase: AgentToolOperationPhase, callIndex: number, call: ToolCall): AgentToolCallIdentity {
  return { ...phase.identity, toolBatchId: phase.toolBatchId, callIndex, ...(call.id ? { callId: call.id } : {}) };
}

function attemptIdentity(phase: AgentToolOperationPhase, callIndex: number, call: ToolCall, toolAttempt: number): AgentToolCallAttemptIdentity {
  return { ...callIdentity(phase, callIndex, call), toolAttempt };
}

function invocationIdentity(
  runId: string,
  phase: AgentToolOperationPhase,
  callIndex: number,
  call: ToolCall,
  toolAttempt: number,
  state?: Extract<AgentToolCallOperationState, { readonly stage: 'effect_ready' | 'effect_pending' }>
) {
  const recovery = state && toolAttempt > 1 && state.effect.intent.recovery.kind === 'preconditioned_reexecution'
    ? Object.freeze({ kind: state.effect.intent.recovery.kind, preconditions: state.effect.intent.recovery.preconditions })
    : undefined;
  return { runId, ...attemptIdentity(phase, callIndex, call, toolAttempt), ...(recovery ? { recovery } : {}) };
}

async function replaceCall(
  input: ToolExecutionInput,
  procedure: AgentOperationProcedure,
  callIndex: number,
  state: AgentToolCallOperationState,
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

function withCallState(phase: AgentToolOperationPhase, callIndex: number, state: AgentToolCallOperationState): AgentToolOperationPhase {
  if (callIndex < 0 || callIndex >= phase.callStates.length) throw new Error(`Tool call state ${String(callIndex)} is missing.`);
  const callStates = [...phase.callStates];
  callStates[callIndex] = state;
  return Object.freeze({ ...phase, callStates: Object.freeze(callStates) });
}

function requireToolPhase(phase: AgentOperationPhase): AgentToolOperationPhase {
  if (phase.kind !== 'tools') throw new Error('Durable operation is not executing a tool batch.');
  return phase;
}

function requireReadyState(phase: AgentToolOperationPhase, callIndex: number): void {
  if (phase.callStates[callIndex]?.stage !== 'ready') throw new Error(`Tool call ${String(callIndex)} is no longer ready.`);
}

function requireCall(phase: AgentToolOperationPhase, callIndex: number): ToolCall {
  const call = phase.calls[callIndex];
  if (!call) throw new Error(`Durable tool call ${String(callIndex)} is missing.`);
  return call;
}

function assertToolDependencies(effects: ToolEffects, callIndex: number, callCount: number): void {
  for (const dependency of effects.dependsOnCallIndices ?? []) {
    if (dependency >= callIndex || dependency >= callCount) throw new Error(`Tool call ${String(callIndex)} has invalid dependency ${String(dependency)}.`);
  }
}

function authorizationKey(runId: string, phase: AgentToolOperationPhase, callIndex: number, prepared: PreparedToolCall): string {
  return `${runId}:tool:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:authorization:${prepared.fingerprint}`;
}
function approvalKey(runId: string, approval: AgentApprovalRequest): string { return `${runId}:approval:${approval.approvalId}:requested`; }
function toolEventKey(runId: string, identity: AgentToolCallAttemptIdentity, stage: string): string { return `${runId}:tool:${identity.turnId}:${identity.toolBatchId}:${String(identity.callIndex)}:attempt:${String(identity.toolAttempt)}:${stage}`; }

function sessionObservation(observation: ToolObservation) {
  const artifacts = observationArtifacts(observation);
  return { ok: observation.ok, summary: observation.summary, output: observation.output, ...(artifacts.length ? { artifacts } : {}), ...(observation.metadata ? { metadata: observation.metadata } : {}) };
}
function minimalToolResultProjection(observation: ToolObservation, toolName: string, projectionError: string): string {
  return JSON.stringify({ ok: observation.ok, title: `${toolName} completed`, summary: `${observation.summary} The durable tool result was committed, but its rich model projection failed.`, scope: observation.scope, coverage: observation.scope.coverage, results: { artifacts: observationArtifacts(observation), projectionError: projectionError.slice(0, 1_000) } });
}
function observationArtifacts(observation: ToolObservation) { return [...new Map((observation.content ?? []).flatMap((item) => item.type === 'text' ? [] : [[item.artifact.artifactId, item.artifact] as const])).values()]; }
