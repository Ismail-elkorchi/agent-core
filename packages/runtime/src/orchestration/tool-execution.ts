import { randomUUID } from 'node:crypto';
import { issueEffectStartTicket, NO_EFFECT_EXPOSURE } from '@agent-core/effects';
import { ContextManager } from '../context/manager.js';
import { hashJson } from '@agent-core/evidence';
import type { SessionRepository } from '../session/repository.js';
import type { AgentApprovalBinding, AgentApprovalRequest, AgentToolBatchIdentity, AgentToolCallAttemptIdentity, AgentToolCallIdentity } from '../run/contracts.js';
import {
  POLICY_TOOL_AUTHORIZER,
  abortableToolBoundary,
  enforceAllowedEffects,
  invokePreparedToolCall,
  releasePreparedToolCall,
  releaseToolInvocation,
  startPreparedToolCall,
  policyBlockedObservation,
  prepareToolCall,
  type PreparedToolCall,
  type ToolInvocation,
  type ToolAuthorizer,
  type ToolAuthorizationDecision,
  type ToolCall,
  type ToolDefinition,
  type ToolPreparationContext,
  type ToolObservation
} from '@agent-core/tools';
import type { ResourceLeaseCoordinator } from '@agent-core/tools';
import type { AgentAuditEvent, AgentProgressEvent } from '../events.js';
import { ObservationStore, serializeToolObservationPresentation } from './observation-store.js';
import type { AgentRunController } from './run-controller.js';
import { scheduleToolCalls } from './tool-scheduler.js';

export type ToolBatchExecutionResult =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'waiting_for_approval'; readonly approvals: readonly AgentApprovalRequest[] }
  | { readonly outcome: 'uncertain_effect'; readonly callIndex: number; readonly toolName: string; readonly toolAttempt: number };

export interface ToolCallRecoveryState {
  readonly callIndex: number;
  readonly lastAttempt: number;
  readonly incompleteStart?: {
    readonly toolAttempt: number;
    readonly fingerprint: string;
    readonly effects: import('@agent-core/tools').ToolEffects;
  };
  readonly completed?: {
    readonly toolAttempt: number;
    readonly observation: ToolObservation;
    readonly observationProjected: boolean;
  };
}

export interface ToolAuthorizationOverride {
  readonly callIndex: number;
  readonly fingerprint: string;
  readonly decision: 'allow' | 'deny';
  readonly reason?: string;
}

interface PreparedEntry {
  readonly identity: AgentToolCallAttemptIdentity;
  readonly call: ToolCall;
  readonly prepared?: PreparedToolCall;
  observation?: ToolObservation;
  observationProjected?: boolean;
  invoke?: true;
}

export async function executeAssistantToolCalls(input: AgentToolBatchIdentity & {
  readonly runId: string;
  readonly driverGeneration: number;
  readonly toolCalls: readonly ToolCall[];
  readonly tools: readonly ToolDefinition[];
  readonly toolContext: ToolPreparationContext;
  readonly authorizer?: ToolAuthorizer;
  readonly resourceLeases?: ResourceLeaseCoordinator;
  readonly modelInputModalities?: readonly string[];
  readonly authorizationOverrides?: readonly ToolAuthorizationOverride[];
  readonly recovery?: readonly ToolCallRecoveryState[];
  readonly resuming?: boolean;
  readonly contextManager: ContextManager;
  readonly observationStore: ObservationStore;
  readonly session?: { readonly repository: SessionRepository; readonly sessionId: string };
  readonly controller: AgentRunController;
  readonly append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}): Promise<ToolBatchExecutionResult> {
  const authorizationContext = input.toolContext;
  const authorizer = input.authorizer ?? POLICY_TOOL_AUTHORIZER;
  const entries: PreparedEntry[] = [];
  const invocations = new Map<number, ToolInvocation>();
  const approvals: AgentApprovalRequest[] = [];
  let uncertain: { callIndex: number; toolName: string; toolAttempt: number } | undefined;

  const execute = async (): Promise<ToolBatchExecutionResult> => {
  // The whole batch crosses the untrusted parse/canonicalize/effects/authorization boundary before any effect runs.
  for (const [callIndex, call] of input.toolCalls.entries()) {
    const callIdentityValue = callIdentity(input, call, callIndex);
    if (!input.resuming) await input.session?.repository.appendToolCall(input.session.sessionId, { runId: input.runId, identity: callIdentityValue, call });
    const recovery = input.recovery?.find((item) => item.callIndex === callIndex);
    const toolAttempt = recovery?.completed?.toolAttempt ?? (recovery?.lastAttempt ?? 0) + 1;
    const identity: AgentToolCallAttemptIdentity = { ...callIdentityValue, toolAttempt };
    const preparation = await prepareToolCall(call, input.tools, {
      ...authorizationContext,
      emitProgress: async (progress) => {
        const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
        await input.emit(event);
      },
      persistProgressCheckpoint: async (progress) => {
        const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
        await input.append(event);
        await input.emit(event);
      }
    });
    if (!preparation.ok) {
      entries.push({ identity, call, observation: preparation.observation });
      continue;
    }
    const prepared = preparation.prepared;
    const preparedCall = prepared.call;
    const entry: PreparedEntry = { identity, call: preparedCall, prepared };
    // Register ownership immediately. Every later failure is then covered by the batch release boundary.
    entries.push(entry);
    if (recovery?.completed) {
      entry.observation = recovery.completed.observation;
      entry.observationProjected = recovery.completed.observationProjected;
      continue;
    }
    if (recovery?.incompleteStart) {
      if (recovery.incompleteStart.fingerprint !== prepared.fingerprint) throw new Error(`Tool call fingerprint changed after an incomplete execution at call ${String(callIndex)}.`);
      uncertain = { callIndex, toolName: call.name, toolAttempt: recovery.incompleteStart.toolAttempt };
      continue;
    }
    const override = input.authorizationOverrides?.find((item) => item.callIndex === callIndex);
    if (input.resuming && override?.fingerprint !== prepared.fingerprint) throw new Error(`Tool call fingerprint changed before approval resume at call ${String(callIndex)}.`);
    const authorizationRequest = { call: preparedCall, toolImplementationId: prepared.toolImplementationId, input: prepared.canonicalSnapshot, effects: prepared.effects, fingerprint: prepared.fingerprint, context: authorizationContext };
    const policyDenial = enforceAllowedEffects(authorizationRequest);
    const currentAuthorization = policyDenial ?? await abortableToolBoundary(input.toolContext.signal, () => authorizer(authorizationRequest));
    const authorization: ToolAuthorizationDecision = override
      ? currentAuthorization.decision === 'deny'
        ? currentAuthorization
        : override.decision === 'allow'
          ? { decision: 'allow', ...(override.reason ? { reason: override.reason } : {}) }
          : { decision: 'deny', reason: override.reason ?? 'Approval denied.' }
      : currentAuthorization;
    const binding = approvalBinding(prepared, authorizationContext);
    if (!input.resuming) await input.append({ type: 'tool.authorization.decided', ...callIdentityValue, toolName: call.name, fingerprint: prepared.fingerprint, binding, decision: authorization.decision, ...(authorization.reason ? { reason: authorization.reason } : {}) });
    if (authorization.decision === 'require_approval') {
      const approvalId = randomUUID();
      const approval = approvalRequest(input.runId, identity, approvalId, authorization.reason, prepared, authorizationContext);
      approvals.push(approval);
      await input.append({ type: 'approval.requested', runId: input.runId, ...callIdentityValue, approvalId, toolName: call.name, fingerprint: approval.fingerprint, input: approval.input, effects: prepared.effects, binding, policyHash: approval.policyHash, reason: approval.reason });
      continue;
    }
    if (authorization.decision === 'deny') {
      const observation = policyBlockedObservation(`Tool authorization denied: ${call.name}`, { tool: call.name, policyReason: 'deny', ...(authorization.reason ? { recovery: authorization.reason } : {}) });
      entry.observation = observation;
      continue;
    }
    entry.invoke = true;
  }

  if (approvals.length > 0) return { outcome: 'waiting_for_approval', approvals: Object.freeze(approvals) };
  if (uncertain) return { outcome: 'uncertain_effect', ...uncertain };

  const executable = entries.filter(isExecutableEntry).map((entry) => ({ callIndex: entry.identity.callIndex, effects: entry.prepared.effects, value: entry }));
  const observed = new Map<number, ToolObservation>();
  for (const wave of scheduleToolCalls(executable, input.controller.limits.maxConcurrentToolCalls)) {
    const results = await Promise.all(wave.map(async (item) => {
      if (input.resourceLeases?.wouldWait(item.value.prepared.effects)) {
        await input.emit({ type: 'tool.updated', ...item.value.identity, toolName: item.value.call.name, progress: {
          type: 'status', stage: 'resource_lease_waiting',
          message: 'Waiting for a conflicting resource lease held by another operation.'
        } });
      }
      const lease = await input.resourceLeases?.acquire(item.value.prepared.effects, `${input.runId}:${item.value.identity.toolBatchId}:${String(item.callIndex)}`, input.toolContext.signal);
      try {
        await persistToolStart(input, item.value);
        const effect = issueToolEffect(input, item.value);
        const invocation = await startPreparedToolCall(item.value.prepared, effect, input.driverGeneration);
        invocations.set(item.callIndex, invocation);
        return {
          callIndex: item.callIndex,
          observation: await invokePreparedToolCall(invocation, {
            ...input.toolContext,
            ...(lease ? { resourceLease: lease } : {}),
            emitProgress: async (progress) => {
              const event = { type: 'tool.updated' as const, ...item.value.identity, toolName: item.value.call.name, progress };
              await input.emit(event);
            },
            persistProgressCheckpoint: async (progress) => {
              const event = { type: 'tool.updated' as const, ...item.value.identity, toolName: item.value.call.name, progress };
              await input.append(event);
              await input.emit(event);
            },
            invocation: {
              runId: input.runId,
              turnId: item.value.identity.turnId,
              requestAttempt: item.value.identity.requestAttempt,
              toolBatchId: item.value.identity.toolBatchId,
              callIndex: item.value.identity.callIndex,
              ...(item.value.identity.callId ? { callId: item.value.identity.callId } : {}),
              toolAttempt: item.value.identity.toolAttempt
            }
          })
        };
      } finally {
        if (lease && !lease.transferred) lease.release();
      }
    }));
    for (const result of results) observed.set(result.callIndex, result.observation);
  }

  for (const entry of [...entries].sort((left, right) => left.identity.callIndex - right.identity.callIndex)) {
    const observation = entry.observation ?? observed.get(entry.identity.callIndex);
    if (!observation) throw new Error(`Tool call ${String(entry.identity.callIndex)} has no terminal observation.`);
    await persistObservation(input, entry, observation);
    input.controller.recordToolResult(observation.ok);
  }
  return { outcome: 'completed' };
  };

  const result = await execute().catch((failure: unknown) => releaseToolAuthoritiesAfterFailure(entries, invocations, failure));
  await releaseToolAuthorities(entries, invocations);
  return result;
}

async function releaseToolAuthoritiesAfterFailure(entries: readonly PreparedEntry[], invocations: ReadonlyMap<number, ToolInvocation>, failure: unknown): Promise<never> {
  try {
    await releaseToolAuthorities(entries, invocations);
  } catch (releaseFailure) {
    throw new AggregateError([failure, releaseFailure], 'Tool execution and authority release both failed.', { cause: releaseFailure });
  }
  if (failure instanceof Error) throw failure;
  throw new Error('Tool execution failed.', { cause: failure });
}

async function releaseToolAuthorities(entries: readonly PreparedEntry[], invocations: ReadonlyMap<number, ToolInvocation>): Promise<void> {
  const releases: Promise<void>[] = [];
  for (const entry of entries) {
    if (!entry.prepared) continue;
    const invocation = invocations.get(entry.identity.callIndex);
    releases.push(invocation ? releaseToolInvocation(invocation) : releasePreparedToolCall(entry.prepared));
  }
  const settled = await Promise.allSettled(releases);
  const failures: unknown[] = [];
  for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Tool call authority release failed.');
}

function isExecutableEntry(entry: PreparedEntry): entry is PreparedEntry & { readonly prepared: PreparedToolCall; readonly invoke: true } {
  return entry.prepared !== undefined && entry.invoke === true;
}

async function persistToolStart(input: Parameters<typeof executeAssistantToolCalls>[0], entry: PreparedEntry): Promise<void> {
  if (!entry.prepared) throw new Error('Cannot persist a tool start without a prepared call.');
  await input.append({ type: 'tool.started', ...entry.identity, toolName: entry.call.name, input: entry.call, fingerprint: entry.prepared.fingerprint, effects: entry.prepared.effects }, toolEventKey(input.runId, entry.identity, 'started'));
  await input.emit({ type: 'tool.started', ...entry.identity, toolName: entry.call.name, input: entry.call, fingerprint: entry.prepared.fingerprint, effects: entry.prepared.effects });
  const progress = { type: 'status' as const, stage: 'executing' };
  await input.append({ type: 'tool.updated', ...entry.identity, toolName: entry.call.name, progress }, toolEventKey(input.runId, entry.identity, 'updated'));
  await input.emit({ type: 'tool.updated', ...entry.identity, toolName: entry.call.name, progress });
}

async function persistObservation(input: Parameters<typeof executeAssistantToolCalls>[0], entry: PreparedEntry, observation: ToolObservation): Promise<void> {
  const committed = entry.observationProjected
    ? undefined
    : await input.observationStore.commitToolObservation({
      turnIndex: input.turnIndex, call: entry.call,
      ...(entry.prepared ? { canonicalSnapshot: entry.prepared.canonicalSnapshot } : {}),
      tool: input.tools.find((tool) => tool.name === entry.call.name && tool.implementationId === entry.prepared?.toolImplementationId), observation
    });
  const persistedObservation = committed?.durableObservation ?? observation;
  await input.append({ type: 'tool.ended', ...entry.identity, toolName: entry.call.name, observation: persistedObservation }, toolEventKey(input.runId, entry.identity, 'ended'));
  if (entry.observationProjected) {
    await input.emit({ type: 'tool.ended', ...entry.identity, toolName: entry.call.name, observation: persistedObservation });
    return;
  }
  if (!committed) throw new Error('Committed tool observation identity was not created.');
  try {
    const record = await input.observationStore.projectToolObservation(committed, input.modelInputModalities);
    await input.session?.repository.appendObservation(input.session.sessionId, {
      runId: input.runId,
      identity: entry.identity,
      toolName: entry.call.name,
      observation: sessionObservation(persistedObservation)
    });
    await input.append({
      type: 'observation.record.created', id: record.id, ...entry.identity, toolName: entry.call.name, call: record.call,
      toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function', evidence: record.evidence,
      immediatePresentation: record.immediatePresentation, retainedPresentation: record.retainedPresentation,
      ...(record.durableStorageDegraded ? { durableStorageDegraded: record.durableStorageDegraded } : {})
    }, toolEventKey(input.runId, entry.identity, 'observation'));
    input.contextManager.recordToolResult({
      turnIndex: input.turnIndex,
      toolName: record.toolName,
      ...(record.call.id ? { callId: record.call.id } : {}),
      toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function',
      immediateContent: serializeToolObservationPresentation(record.immediatePresentation),
      retainedContent: serializeToolObservationPresentation(record.retainedPresentation),
      immediateImages: record.immediateImages,
      imageArtifacts: record.imageArtifacts,
      evidence: [...record.evidence]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.append({ type: 'observation.projection.failed', id: committed.id, ...entry.identity, toolName: entry.call.name, message }, toolEventKey(input.runId, entry.identity, 'projection-failed'));
    const fallback = minimalToolResultProjection(persistedObservation, entry.call.name, message);
    input.contextManager.recordToolResult({
      turnIndex: input.turnIndex,
      toolName: entry.call.name,
      ...(entry.call.id ? { callId: entry.call.id } : {}),
      toolCallType: entry.call.input.kind === 'text' ? 'custom' : 'function',
      immediateContent: fallback,
      retainedContent: fallback
    });
  }
  await input.emit({ type: 'tool.ended', ...entry.identity, toolName: entry.call.name, observation: persistedObservation });
}

function sessionObservation(observation: ToolObservation) {
  const artifacts = observationArtifacts(observation);
  return {
    ok: observation.ok,
    summary: observation.summary,
    output: observation.output,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(observation.metadata ? { metadata: observation.metadata } : {})
  };
}

function minimalToolResultProjection(observation: ToolObservation, toolName: string, projectionError: string): string {
  return JSON.stringify({
    ok: observation.ok,
    title: `${toolName} completed`,
    summary: `${observation.summary} The durable tool result was committed, but its rich model projection failed.`,
    scope: observation.scope,
    coverage: observation.scope.coverage,
    results: { artifacts: observationArtifacts(observation), projectionError: projectionError.slice(0, 1_000) }
  });
}

function observationArtifacts(observation: ToolObservation) {
  return [...new Map((observation.content ?? []).flatMap((item) => item.type === 'text' ? [] : [[item.artifact.artifactId, item.artifact] as const])).values()];
}

function callIdentity(input: AgentToolBatchIdentity, call: ToolCall, callIndex: number): AgentToolCallIdentity {
  return { turnIndex: input.turnIndex, turnId: input.turnId, requestAttempt: input.requestAttempt, toolBatchId: input.toolBatchId, callIndex, ...(call.id ? { callId: call.id } : {}) };
}
function toolEventKey(runId: string, identity: AgentToolCallAttemptIdentity, stage: string): string {
  return `${runId}:tool:${identity.turnId}:${identity.toolBatchId}:${String(identity.callIndex)}:attempt:${String(identity.toolAttempt)}:${stage}`;
}
function issueToolEffect(input: Parameters<typeof executeAssistantToolCalls>[0], entry: PreparedEntry & { readonly prepared: PreparedToolCall }) {
  const effectId = `${input.runId}:${entry.identity.turnId}:${entry.identity.toolBatchId}:${String(entry.identity.callIndex)}:${String(entry.identity.toolAttempt)}`;
  const issued = issueEffectStartTicket({
    intent: {
      effectId,
      operationId: input.runId,
      implementationId: entry.prepared.toolImplementationId,
      parametersDigest: entry.prepared.fingerprint,
      recovery: entry.prepared.effects.recovery,
      exposure: NO_EFFECT_EXPOSURE
    },
    ticketId: randomUUID(),
    settlementPermitId: randomUUID(),
    driverGeneration: input.driverGeneration,
    currentDriverGeneration: input.driverGeneration
  });
  if (issued.status !== 'issued') throw new Error(`Tool effect ticket was rejected: ${issued.reason}.`);
  return issued.state;
}
function approvalRequest(runId: string, identity: AgentToolCallIdentity, approvalId: string, reason: string, prepared: PreparedToolCall, context: ToolPreparationContext): AgentApprovalRequest {
  const input = prepared.canonicalSnapshot;
  const effects = prepared.effects;
  return Object.freeze({ ...identity, approvalId, status: 'pending', toolName: prepared.call.name, fingerprint: prepared.fingerprint, input, effects, binding: approvalBinding(prepared, context), policyHash: hashJson(context.policy), reason, runId });
}
function approvalBinding(prepared: PreparedToolCall, context: ToolPreparationContext): AgentApprovalBinding {
  return Object.freeze({ toolImplementationId: prepared.toolImplementationId, authorizationPolicyId: context.boundary.authorizationPolicyId, executionTargetId: context.boundary.executionTargetId });
}
