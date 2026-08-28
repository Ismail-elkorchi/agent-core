import { hashJson } from '@agent-core/evidence';
import {
  issueEffectStartTicket,
  NO_EFFECT_EXPOSURE,
  startExternalEffect
} from '@agent-core/effects';
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
  type ToolInvocation,
  type ToolObservation,
  type ToolPreparationContext,
  type ToolProgress
} from '@agent-core/tools';
import type { AgentAuditEvent, AgentProgressEvent } from '../events.js';
import type { AgentOperationPhase, AgentOperationProcedure } from '../operation/contracts.js';
import type { AgentToolOperationPhase, AgentToolPreparationRecord, AgentToolSettlementRecord } from '../operation/tool-state.js';
import type { AgentApprovalBinding, AgentApprovalRequest, AgentToolCallAttemptIdentity, AgentToolCallIdentity } from '../run/contracts.js';
import type { SessionRepository } from '../session/repository.js';
import { ContextManager } from '../context/manager.js';
import { ObservationStore, serializeToolObservationPresentation, type CommittedToolObservation } from './observation-store.js';
import type { AgentRunController } from './run-controller.js';

export type ToolBatchExecutionResult =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'waiting_for_approval'; readonly approvals: readonly AgentApprovalRequest[] }
  | { readonly outcome: 'ownership_lost' };

export async function executeAssistantToolCalls(input: {
  readonly runId: string;
  readonly driverGeneration: number;
  readonly tools: readonly ToolDefinition[];
  readonly toolContext: ToolPreparationContext;
  readonly authorizer?: ToolAuthorizer;
  readonly resourceLeases?: ResourceLeaseCoordinator;
  readonly contextManager: ContextManager;
  readonly observationStore: ObservationStore;
  readonly session?: { readonly repository: SessionRepository; readonly sessionId: string };
  readonly controller: AgentRunController;
  readonly phase: () => AgentOperationPhase;
  readonly transition: (procedure: AgentOperationProcedure, phase: AgentOperationPhase) => Promise<void>;
  readonly settle: (input: { readonly effectId: string; readonly permit: import('@agent-core/effects').EffectSettlementPermit; readonly settlement: AgentToolSettlementRecord }) => Promise<'owned' | 'ownership_lost'>;
  readonly append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}): Promise<ToolBatchExecutionResult> {
  let prepared: PreparedToolCall | undefined;
  let invocation: ToolInvocation | undefined;
  let committed: CommittedToolObservation | undefined;
  let lease: Awaited<ReturnType<ResourceLeaseCoordinator['acquire']>> | undefined;
  try {
    for (;;) {
      const phase = input.phase();
      if (phase.kind === 'approval') return { outcome: 'waiting_for_approval', approvals: Object.freeze([phase.approval]) };
      if (phase.kind !== 'tools') throw new Error('Durable tool execution lost its tool-batch state.');
      if (phase.stage === 'complete') return { outcome: 'completed' };
      const call = phase.calls[phase.nextCallIndex];
      if (!call) {
        if (phase.stage !== 'ready' || phase.nextCallIndex !== phase.calls.length) throw new Error('Durable tool-batch position is invalid.');
        await input.transition('prepare_tool_call', Object.freeze({ ...phase, stage: 'complete' }));
        continue;
      }

      if (phase.stage === 'ready') {
        prepared = await prepareCurrent(input, phase, call);
        if (!prepared) continue;
        const storedApproval = phase.approved;
        const current = await authorize(input, prepared);
        const authorization = storedApproval
          ? current.decision === 'deny'
            ? current
            : storedApproval.decision === 'allow'
              ? { decision: 'allow' as const, ...(current.reason ? { reason: current.reason } : {}) }
              : { decision: 'deny' as const, reason: current.reason ?? storedApproval.approval.reason }
          : current;
        const preparation = preparationRecord(prepared, input.toolContext, authorization.decision, authorization.reason);
        if (!storedApproval) {
          await input.append(authorizationEvent(phase, call, prepared, authorization, input.toolContext), authorizationKey(input.runId, phase, prepared));
        }
        if (authorization.decision === 'require_approval') {
          const approval = approvalRequest(input.runId, phase, call, prepared, authorization.reason, input.toolContext);
          await input.append(approvalEvent(approval), approvalKey(input.runId, approval));
          await input.transition('prepare_tool_call', Object.freeze({
            kind: 'approval', identity: phase.identity, toolBatchId: phase.toolBatchId, calls: phase.calls,
            nextCallIndex: phase.nextCallIndex, instructions: phase.instructions,
            modelInputModalities: phase.modelInputModalities, preparation, approval
          }));
          await releasePreparedToolCall(prepared);
          prepared = undefined;
          continue;
        }
        if (authorization.decision === 'deny') {
          const observation = policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
            tool: call.name, policyReason: 'deny', ...(authorization.reason ? { recovery: authorization.reason } : {})
          });
          committed = await commitObservation(input, phase, call, prepared, observation);
          const settlement = settlementRecord(committed);
          await input.transition('prepare_tool_call', Object.freeze({
            ...batchBase(phase), stage: 'settled', preparation, toolAttempt: 1, settlement
          }));
          await releasePreparedToolCall(prepared);
          prepared = undefined;
          continue;
        }
        const toolAttempt = 1;
        const effect = issueToolEffect(input, phase, prepared, toolAttempt);
        await input.transition('prepare_tool_call', Object.freeze({
          ...batchBase(phase), stage: 'effect_ready', preparation, toolAttempt, effect
        }));
        continue;
      }

      if (phase.stage === 'effect_ready') {
        prepared = await requireMatchingPreparation(input, phase, call, prepared);
        lease = await acquireLease(input, phase, call);
        const started = startExternalEffect(phase.effect, phase.effect.ticket, input.driverGeneration);
        if (started.status !== 'started') throw new Error(`Tool effect start was rejected: ${started.reason}.`);
        await input.transition('start_tool_call', Object.freeze({ ...phase, stage: 'effect_pending', effect: started.state }));
        invocation = await startPreparedToolCall(prepared, started.state);
        const identity = attemptIdentity(phase, call, phase.toolAttempt);
        await input.append({ type: 'tool.started', ...identity, toolName: call.name, input: call, fingerprint: prepared.fingerprint, effects: prepared.effects }, toolEventKey(input.runId, identity, 'started'));
        await input.emit({ type: 'tool.started', ...identity, toolName: call.name, input: call, fingerprint: prepared.fingerprint, effects: prepared.effects });
        continue;
      }

      if (phase.stage === 'effect_pending') {
        if (!invocation || !prepared) {
          throw new Error(`Tool effect ${phase.effect.intent.effectId} has no process-local invocation authority.`);
        }
        let observation: ToolObservation;
        try {
          observation = await invokePreparedToolCall(invocation, {
            ...input.toolContext,
            ...(lease ? { resourceLease: lease } : {}),
            emitProgress: (progress) => input.emit({ type: 'tool.updated', ...attemptIdentity(phase, call, phase.toolAttempt), toolName: call.name, progress }),
            persistProgressCheckpoint: async (progress) => {
              const identity = attemptIdentity(phase, call, phase.toolAttempt);
              const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
              await input.append(event, toolEventKey(input.runId, identity, `updated:${hashJson(progress)}`));
              await input.emit(event);
            },
            invocation: invocationIdentity(input.runId, phase, call, phase.toolAttempt)
          });
        } finally {
          if (lease && !lease.transferred) lease.release();
          lease = undefined;
        }
        committed = await commitObservation(input, phase, call, prepared, observation);
        const ownership = await input.settle({
          effectId: phase.effect.intent.effectId,
          permit: phase.effect.settlementPermit,
          settlement: settlementRecord(committed)
        });
        await releaseToolInvocation(invocation);
        invocation = undefined;
        prepared = undefined;
        if (ownership === 'ownership_lost') return { outcome: 'ownership_lost' };
        continue;
      }

      if (phase.stage === 'settled') {
        const identity = attemptIdentity(phase, call, phase.toolAttempt);
        await input.append({ type: 'tool.ended', ...identity, toolName: call.name, observation: phase.settlement.observation }, toolEventKey(input.runId, identity, 'ended'));
        await input.transition('consume_tool_settlement', Object.freeze({ ...phase, stage: 'projecting' }));
        continue;
      }

      const owned = committed ?? committedFromState(input, phase, call);
      await projectObservation(input, phase, call, owned);
      input.controller.recordToolResult(phase.settlement.observation.ok);
      const nextCallIndex = phase.nextCallIndex + 1;
      const next: AgentToolOperationPhase = nextCallIndex === phase.calls.length
        ? Object.freeze({ ...batchBase(phase), stage: 'complete', nextCallIndex })
        : Object.freeze({ ...batchBase(phase), stage: 'ready', nextCallIndex });
      await input.transition('project_tool_settlement', next);
      committed = undefined;
    }
  } finally {
    if (lease && !lease.transferred) lease.release();
    if (invocation) await releaseToolInvocation(invocation);
    else if (prepared) await releasePreparedToolCall(prepared);
  }
}

async function prepareCurrent(input: Parameters<typeof executeAssistantToolCalls>[0], phase: Extract<AgentOperationPhase, { readonly kind: 'tools'; readonly stage: 'ready' }>, call: ToolCall): Promise<PreparedToolCall | undefined> {
  const result = await prepareToolCall(call, input.tools, preparationContext(input, phase, call));
  if (result.ok) return result.prepared;
  const committed = await commitObservation(input, phase, call, undefined, result.observation);
  await input.transition('prepare_tool_call', Object.freeze({ ...batchBase(phase), stage: 'settled', toolAttempt: 1, settlement: settlementRecord(committed) }));
  return undefined;
}

function preparationContext(input: Parameters<typeof executeAssistantToolCalls>[0], phase: AgentToolOperationPhase, call: ToolCall): ToolPreparationContext {
  const identity = attemptIdentity(phase, call, 1);
  return Object.freeze({
    ...input.toolContext,
    emitProgress: (progress: ToolProgress) => input.emit({ type: 'tool.updated', ...identity, toolName: call.name, progress }),
    persistProgressCheckpoint: async (progress: ToolProgress) => {
      const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
      await input.append(event, toolEventKey(input.runId, identity, `preparation:${hashJson(progress)}`));
      await input.emit(event);
    }
  });
}

async function requireMatchingPreparation(
  input: Parameters<typeof executeAssistantToolCalls>[0],
  phase: Extract<AgentOperationPhase, { readonly kind: 'tools'; readonly stage: 'effect_ready' }>,
  call: ToolCall,
  retained: PreparedToolCall | undefined
): Promise<PreparedToolCall> {
  if (retained) return retained;
  const result = await prepareToolCall(call, input.tools, input.toolContext);
  if (!result.ok) throw new Error(`Prepared tool ${call.name} is no longer available: ${result.observation.summary}`);
  const prepared = result.prepared;
  if (prepared.toolImplementationId !== phase.preparation.toolImplementationId || prepared.fingerprint !== phase.preparation.fingerprint) {
    await releasePreparedToolCall(prepared);
    throw new Error(`Prepared tool ${call.name} no longer matches its durable intent.`);
  }
  return prepared;
}

async function authorize(input: Parameters<typeof executeAssistantToolCalls>[0], prepared: PreparedToolCall) {
  const request = { call: prepared.call, toolImplementationId: prepared.toolImplementationId, input: prepared.canonicalSnapshot, effects: prepared.effects, fingerprint: prepared.fingerprint, context: input.toolContext };
  return enforceAllowedEffects(request)
    ?? await abortableToolBoundary(input.toolContext.signal, () => (input.authorizer ?? POLICY_TOOL_AUTHORIZER)(request));
}

async function acquireLease(input: Parameters<typeof executeAssistantToolCalls>[0], phase: AgentToolOperationPhase, call: ToolCall) {
  if (phase.stage !== 'effect_ready') throw new Error('Resource leases require an issued tool effect.');
  if (input.resourceLeases?.wouldWait(phase.preparation.effects)) {
    await input.emit({ type: 'tool.updated', ...attemptIdentity(phase, call, phase.toolAttempt), toolName: call.name, progress: {
      type: 'status', stage: 'resource_lease_waiting', message: 'Waiting for a conflicting resource lease held by another operation.'
    } });
  }
  return input.resourceLeases?.acquire(phase.preparation.effects, `${input.runId}:${phase.toolBatchId}:${String(phase.nextCallIndex)}`, input.toolContext.signal);
}

async function commitObservation(input: Parameters<typeof executeAssistantToolCalls>[0], phase: AgentToolOperationPhase, call: ToolCall, prepared: PreparedToolCall | undefined, observation: ToolObservation): Promise<CommittedToolObservation> {
  return input.observationStore.commitToolObservation({
    turnIndex: phase.identity.turnIndex,
    call,
    ...(prepared ? { canonicalSnapshot: prepared.canonicalSnapshot } : {}),
    tool: input.tools.find((tool) => tool.name === call.name && tool.implementationId === prepared?.toolImplementationId),
    observation
  });
}

async function projectObservation(input: Parameters<typeof executeAssistantToolCalls>[0], phase: Extract<AgentToolOperationPhase, { readonly stage: 'projecting' }>, call: ToolCall, committed: CommittedToolObservation): Promise<void> {
  const identity = attemptIdentity(phase, call, phase.toolAttempt);
  try {
    const record = await input.observationStore.projectToolObservation(committed, phase.modelInputModalities);
    await input.session?.repository.appendObservation(input.session.sessionId, {
      runId: input.runId, identity, toolName: call.name, observation: sessionObservation(phase.settlement.observation)
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
    const fallback = minimalToolResultProjection(phase.settlement.observation, call.name, message);
    input.contextManager.recordToolResult({
      turnIndex: phase.identity.turnIndex, toolName: call.name, ...(call.id ? { callId: call.id } : {}),
      toolCallType: call.input.kind === 'text' ? 'custom' : 'function', immediateContent: fallback, retainedContent: fallback
    });
  }
  await input.emit({ type: 'tool.ended', ...identity, toolName: call.name, observation: phase.settlement.observation });
}

function committedFromState(input: Parameters<typeof executeAssistantToolCalls>[0], phase: Extract<AgentToolOperationPhase, { readonly stage: 'projecting' }>, call: ToolCall): CommittedToolObservation {
  const tool = phase.preparation ? input.tools.find((candidate) => candidate.name === call.name && candidate.implementationId === phase.preparation?.toolImplementationId) : undefined;
  return Object.freeze({
    id: phase.settlement.observationId,
    turnIndex: phase.identity.turnIndex,
    call,
    toolName: call.name,
    ...(phase.preparation ? { canonicalSnapshot: phase.preparation.canonicalInput } : {}),
    tool,
    fullObservation: phase.settlement.observation,
    durableObservation: phase.settlement.observation,
    createdAt: phase.settlement.createdAt
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

interface ToolBatchFields {
  readonly kind: 'tools';
  readonly identity: AgentToolOperationPhase['identity'];
  readonly toolBatchId: string;
  readonly calls: readonly ToolCall[];
  readonly nextCallIndex: number;
  readonly instructions: AgentToolOperationPhase['instructions'];
  readonly modelInputModalities: readonly string[];
}
function batchBase(phase: AgentToolOperationPhase): ToolBatchFields {
  return Object.freeze({
    kind: 'tools', identity: phase.identity, toolBatchId: phase.toolBatchId, calls: phase.calls,
    nextCallIndex: phase.nextCallIndex, instructions: phase.instructions, modelInputModalities: phase.modelInputModalities
  });
}

function issueToolEffect(input: Parameters<typeof executeAssistantToolCalls>[0], phase: AgentToolOperationPhase, prepared: PreparedToolCall, toolAttempt: number) {
  const effectId = `${input.runId}:${phase.identity.turnId}:${phase.toolBatchId}:${String(phase.nextCallIndex)}:${String(toolAttempt)}`;
  const issued = issueEffectStartTicket({
    intent: { effectId, operationId: input.runId, implementationId: prepared.toolImplementationId, parametersDigest: prepared.fingerprint, recovery: prepared.effects.recovery, exposure: NO_EFFECT_EXPOSURE },
    ticketId: `${effectId}:start`, settlementPermitId: `${effectId}:settle`,
    driverGeneration: input.driverGeneration, currentDriverGeneration: input.driverGeneration
  });
  if (issued.status !== 'issued') throw new Error(`Tool effect ticket was rejected: ${issued.reason}.`);
  return issued.state;
}

function approvalRequest(runId: string, phase: AgentToolOperationPhase, call: ToolCall, prepared: PreparedToolCall, reason: string, context: ToolPreparationContext): AgentApprovalRequest {
  const identity = callIdentity(phase, call);
  const approvalId = `approval-${hashJson({ runId, ...identity, fingerprint: prepared.fingerprint }).slice(0, 32)}`;
  return Object.freeze({ ...identity, approvalId, status: 'pending', toolName: call.name, fingerprint: prepared.fingerprint, input: prepared.canonicalSnapshot, effects: prepared.effects, binding: approvalBinding(prepared, context), policyHash: hashJson(context.policy), reason, runId });
}

function authorizationEvent(phase: AgentToolOperationPhase, call: ToolCall, prepared: PreparedToolCall, authorization: Awaited<ReturnType<typeof authorize>>, context: ToolPreparationContext): AgentAuditEvent {
  return { type: 'tool.authorization.decided', ...callIdentity(phase, call), toolName: call.name, fingerprint: prepared.fingerprint, binding: approvalBinding(prepared, context), decision: authorization.decision, ...(authorization.reason ? { reason: authorization.reason } : {}) };
}

function approvalEvent(approval: AgentApprovalRequest): AgentAuditEvent {
  return { type: 'approval.requested', runId: approval.runId, turnIndex: approval.turnIndex, turnId: approval.turnId, requestAttempt: approval.requestAttempt, toolBatchId: approval.toolBatchId, callIndex: approval.callIndex, ...(approval.callId ? { callId: approval.callId } : {}), approvalId: approval.approvalId, toolName: approval.toolName, fingerprint: approval.fingerprint, input: approval.input, effects: approval.effects, binding: approval.binding, policyHash: approval.policyHash, reason: approval.reason };
}

function approvalBinding(prepared: PreparedToolCall, context: ToolPreparationContext): AgentApprovalBinding {
  return Object.freeze({ toolImplementationId: prepared.toolImplementationId, authorizationPolicyId: context.boundary.authorizationPolicyId, executionTargetId: context.boundary.executionTargetId });
}

function callIdentity(phase: AgentToolOperationPhase, call: ToolCall): AgentToolCallIdentity {
  return { ...phase.identity, toolBatchId: phase.toolBatchId, callIndex: phase.nextCallIndex, ...(call.id ? { callId: call.id } : {}) };
}

function attemptIdentity(phase: AgentToolOperationPhase, call: ToolCall, toolAttempt: number): AgentToolCallAttemptIdentity {
  return { ...callIdentity(phase, call), toolAttempt };
}

function invocationIdentity(runId: string, phase: AgentToolOperationPhase, call: ToolCall, toolAttempt: number) {
  const recovery = (phase.stage === 'effect_ready' || phase.stage === 'effect_pending')
    && toolAttempt > 1
    && phase.effect.intent.recovery.kind === 'preconditioned_reexecution'
    ? Object.freeze({ kind: phase.effect.intent.recovery.kind, preconditions: phase.effect.intent.recovery.preconditions })
    : undefined;
  return { runId, ...attemptIdentity(phase, call, toolAttempt), ...(recovery ? { recovery } : {}) };
}

function authorizationKey(runId: string, phase: AgentToolOperationPhase, prepared: PreparedToolCall): string {
  return `${runId}:tool:${phase.identity.turnId}:${phase.toolBatchId}:${String(phase.nextCallIndex)}:authorization:${prepared.fingerprint}`;
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
