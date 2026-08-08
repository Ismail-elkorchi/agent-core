import { randomUUID } from 'node:crypto';
import { ContextManager } from '../context/manager.js';
import { hashRecord, normalizeJsonSafe, type JsonObject } from '@agent-core/evidence';
import type { SessionRepository } from '../session/repository.js';
import type { AgentApprovalBinding, AgentApprovalRequest, AgentToolBatchIdentity, AgentToolCallAttemptIdentity, AgentToolCallIdentity } from '../run/contracts.js';
import {
  POLICY_TOOL_AUTHORIZER,
  abortableToolBoundary,
  invokePreparedToolCall,
  normalizeToolObservationForPersistence,
  policyBlockedObservation,
  prepareToolCall,
  type PreparedToolCall,
  type ToolAuthorizer,
  type ToolAuthorizationDecision,
  type ToolCall,
  type ToolDefinition,
  type ToolPreparationContext,
  type ToolObservation
} from '@agent-core/tools';
import type { AgentEvent, AgentProgressEvent } from '../events.js';
import { ObservationStore, serializeToolObservationPresentation } from './observation-store.js';
import type { AgentRunController } from './run-controller.js';
import { createToolCallMachine, reduceToolCall, type ToolCallMachineCommand, type ToolCallMachineEvent, type ToolCallMachineState } from './tool-call-machine.js';
import { scheduleToolCalls } from './tool-scheduler.js';

export type ToolBatchExecutionResult =
  | { readonly outcome: 'completed'; readonly failedTool: boolean; readonly retrySafe: boolean }
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
  machine: ToolCallMachineState;
  readonly observation?: ToolObservation;
  readonly observationProjected?: boolean;
  readonly invoke?: true;
}

export async function executeAssistantToolCalls(input: AgentToolBatchIdentity & {
  readonly runId: string;
  readonly toolCalls: readonly ToolCall[];
  readonly tools: readonly ToolDefinition[];
  readonly toolContext: ToolPreparationContext;
  readonly authorizer?: ToolAuthorizer;
  readonly authorizationOverrides?: readonly ToolAuthorizationOverride[];
  readonly recovery?: readonly ToolCallRecoveryState[];
  readonly resuming?: boolean;
  readonly contextManager: ContextManager;
  readonly observationStore: ObservationStore;
  readonly session?: { readonly repository: SessionRepository; readonly sessionId: string };
  readonly controller: AgentRunController;
  readonly append: (event: AgentEvent, idempotencyKey?: string) => Promise<unknown>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}): Promise<ToolBatchExecutionResult> {
  const authorizationContext = input.toolContext;
  const authorizer = input.authorizer ?? POLICY_TOOL_AUTHORIZER;
  const entries: PreparedEntry[] = [];
  const approvals: AgentApprovalRequest[] = [];
  let uncertain: { callIndex: number; toolName: string; toolAttempt: number } | undefined;

  // The whole batch crosses the untrusted parse/canonicalize/effects/authorization boundary before any effect runs.
  for (const [callIndex, call] of input.toolCalls.entries()) {
    const callIdentityValue = callIdentity(input, call, callIndex);
    if (!input.resuming) await input.session?.repository.appendToolCall(input.session.sessionId, { runId: input.runId, identity: callIdentityValue, call });
    let machine: ToolCallMachineState = createToolCallMachine(callIdentityValue, call.name);
    const recovery = input.recovery?.find((item) => item.callIndex === callIndex);
    const toolAttempt = recovery?.completed?.toolAttempt ?? (recovery?.lastAttempt ?? 0) + 1;
    const identity: AgentToolCallAttemptIdentity = { ...callIdentityValue, toolAttempt };
    const preparation = await prepareToolCall(call, input.tools, {
      ...authorizationContext,
      emitProgress: async (progress) => {
        const event = { type: 'tool.updated' as const, ...identity, toolName: call.name, progress };
        await input.append(event);
        await input.emit(event);
      }
    });
    if (!preparation.ok) {
      machine = transitionWithoutCommands(machine, { type: 'rejected', outcome: preparationOutcome(preparation.observation), observation: preparation.observation });
      entries.push({ identity, call, machine, observation: preparation.observation });
      continue;
    }
    const prepared = preparation.prepared;
    machine = transitionWithoutCommands(machine, { type: 'input.parsed', input: prepared.decodedInput });
    machine = transitionWithoutCommands(machine, { type: 'input.canonicalized', input: prepared.canonicalInput });
    machine = transitionWithoutCommands(machine, { type: 'effects.derived', effects: prepared.effects, fingerprint: prepared.fingerprint });
    if (recovery?.completed) {
      entries.push({ identity, call, prepared, machine, observation: recovery.completed.observation, observationProjected: recovery.completed.observationProjected });
      continue;
    }
    if (recovery?.incompleteStart) {
      if (recovery.incompleteStart.fingerprint !== prepared.fingerprint) throw new Error(`Tool call fingerprint changed after an incomplete execution at call ${String(callIndex)}.`);
      if (recovery.incompleteStart.effects.idempotency === 'non_idempotent') {
        uncertain = { callIndex, toolName: call.name, toolAttempt: recovery.incompleteStart.toolAttempt };
        entries.push({ identity, call, prepared, machine });
        continue;
      }
    }
    machine = transitionWithCommand(machine, { type: 'authorization.started' }, 'authorization.invoke');
    const override = input.authorizationOverrides?.find((item) => item.callIndex === callIndex);
    if (input.resuming && override?.fingerprint !== prepared.fingerprint) throw new Error(`Tool call fingerprint changed before approval resume at call ${String(callIndex)}.`);
    const currentAuthorization = await abortableToolBoundary(input.toolContext.signal, () => authorizer({ call, tool: prepared.tool, input: prepared.canonicalInput, effects: prepared.effects, fingerprint: prepared.fingerprint, context: authorizationContext }));
    const authorization: ToolAuthorizationDecision = override
      ? currentAuthorization.decision === 'deny'
        ? currentAuthorization
        : override.decision === 'allow'
          ? { decision: 'allow', ...(override.reason ? { reason: override.reason } : {}) }
          : { decision: 'deny', reason: override.reason ?? 'Approval denied.' }
      : currentAuthorization;
    const approvalId = authorization.decision === 'require_approval' ? randomUUID() : undefined;
    const binding = approvalBinding(prepared, authorizationContext);
    const authorizationTransition = reduceToolCall(machine, { type: 'authorization.decided', decision: authorization, ...(approvalId ? { approvalId } : {}) });
    machine = authorizationTransition.state;
    if (!input.resuming) await input.append({ type: 'tool.authorization.decided', ...identity, toolName: call.name, fingerprint: prepared.fingerprint, binding, decision: authorization.decision, ...(authorization.reason ? { reason: authorization.reason } : {}) });
    if (authorization.decision === 'require_approval' && approvalId) {
      requireSingleCommand(authorizationTransition.commands, 'approval.persist');
      const approval = approvalRequest(input.runId, identity, approvalId, authorization.reason, prepared, authorizationContext);
      approvals.push(approval);
      await input.append({ type: 'approval.requested', runId: input.runId, ...identity, approvalId, toolName: call.name, fingerprint: approval.fingerprint, input: approval.input, effects: prepared.effects, binding, policyHash: approval.policyHash, reason: approval.reason });
      entries.push({ identity, call, prepared, machine });
      continue;
    }
    if (authorization.decision === 'deny') {
      requireNoCommands(authorizationTransition.commands);
      const observation = policyBlockedObservation(`Tool authorization denied: ${call.name}`, { tool: call.name, policyReason: 'deny', ...(authorization.reason ? { recovery: authorization.reason } : {}) });
      entries.push({ identity, call, prepared, machine, observation });
      continue;
    }
    requireSingleCommand(authorizationTransition.commands, 'tool.invoke');
    entries.push({ identity, call, prepared, machine, invoke: true });
  }

  if (approvals.length > 0) return { outcome: 'waiting_for_approval', approvals: Object.freeze(approvals) };
  if (uncertain) return { outcome: 'uncertain_effect', ...uncertain };

  const executable = entries.filter(isExecutableEntry).map((entry) => ({ callIndex: entry.identity.callIndex, effects: entry.prepared.effects, value: entry }));
  const observed = new Map<number, ToolObservation>();
  for (const wave of scheduleToolCalls(executable, input.controller.limits.maxConcurrentToolCalls)) {
    for (const item of wave) await persistToolStart(input, item.value);
    const results = await Promise.all(wave.map(async (item) => ({
      callIndex: item.callIndex,
      observation: await invokePreparedToolCall(item.value.prepared, {
        ...input.toolContext,
        emitProgress: async (progress) => {
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
          toolAttempt: item.value.identity.toolAttempt,
          ...(item.value.prepared.effects.idempotency === 'idempotent' ? { idempotencyKey: item.value.prepared.effects.idempotencyKey } : {})
        }
      })
    })));
    for (const result of results) observed.set(result.callIndex, result.observation);
  }

  let failedTool = false;
  let retrySafe = true;
  for (const entry of [...entries].sort((left, right) => left.identity.callIndex - right.identity.callIndex)) {
    const observation = entry.observation ?? observed.get(entry.identity.callIndex);
    if (!observation) throw new Error(`Tool call ${String(entry.identity.callIndex)} has no terminal observation.`);
    const observationMustPersist = entry.invoke === true;
    if (observationMustPersist) entry.machine = transitionWithCommand(entry.machine, { type: 'execution.observed', observation }, 'observation.persist');
    await persistObservation(input, entry, observation);
    if (observationMustPersist) entry.machine = transitionWithoutCommands(entry.machine, { type: 'observation.persisted' });
    input.controller.recordToolResult(observation.ok);
    if (!observation.ok) {
      failedTool = true;
      if (entry.prepared?.effects.idempotency === 'non_idempotent') retrySafe = false;
    }
  }
  return { outcome: 'completed', failedTool, retrySafe };
}

function isExecutableEntry(entry: PreparedEntry): entry is PreparedEntry & { readonly prepared: PreparedToolCall; readonly invoke: true } {
  return entry.prepared !== undefined && entry.invoke === true;
}

async function persistToolStart(input: Parameters<typeof executeAssistantToolCalls>[0], entry: PreparedEntry): Promise<void> {
  if (!entry.prepared) throw new Error('Cannot persist a tool start without a prepared call.');
  await input.append({ type: 'tool.started', ...entry.identity, toolName: entry.call.name, input: entry.call, fingerprint: entry.prepared.fingerprint, effects: entry.prepared.effects }, toolEventKey(input.runId, entry.identity, 'started'));
  await input.emit({ type: 'tool.started', ...entry.identity, toolName: entry.call.name, input: entry.call, fingerprint: entry.prepared.fingerprint, effects: entry.prepared.effects });
  await input.append({ type: 'tool.updated', ...entry.identity, toolName: entry.call.name, progress: { stage: 'executing' } }, toolEventKey(input.runId, entry.identity, 'updated'));
  await input.emit({ type: 'tool.updated', ...entry.identity, toolName: entry.call.name, progress: { stage: 'executing' } });
}

async function persistObservation(input: Parameters<typeof executeAssistantToolCalls>[0], entry: PreparedEntry, observation: ToolObservation): Promise<void> {
  const record = entry.observationProjected
    ? undefined
    : await input.observationStore.put({ turnIndex: input.turnIndex, call: entry.call, canonicalInput: entry.prepared?.canonicalInput, tool: entry.prepared?.tool, observation });
  const persistedObservation = normalizeToolObservationForPersistence(record?.durableObservation ?? observation);
  const artifacts = observationArtifacts(persistedObservation);
  await input.append({ type: 'tool.ended', ...entry.identity, toolName: entry.call.name, observation: persistedObservation }, toolEventKey(input.runId, entry.identity, 'ended'));
  await input.session?.repository.appendObservation(input.session.sessionId, {
    runId: input.runId,
    identity: entry.identity,
    toolName: entry.call.name,
    observation: {
      ok: persistedObservation.ok,
      summary: persistedObservation.summary,
      output: persistedObservation.output,
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(persistedObservation.metadata ? { metadata: persistedObservation.metadata } : {})
    }
  });
  if (entry.observationProjected) {
    await input.emit({ type: 'tool.ended', ...entry.identity, toolName: entry.call.name, observation: persistedObservation });
    return;
  }
  if (!record) throw new Error('Tool observation record was not created.');
  input.contextManager.recordToolResult({
    turnIndex: input.turnIndex,
    toolName: record.toolName,
    ...(record.call.id ? { callId: record.call.id } : {}),
    toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function',
    immediateContent: serializeToolObservationPresentation(record.immediatePresentation),
    retainedContent: serializeToolObservationPresentation(record.retainedPresentation),
    immediateImages: record.immediateImages,
    evidence: record.evidence
  });
  await input.append({
    type: 'observation.record.created', id: record.id, ...entry.identity, toolName: entry.call.name, call: record.call,
    toolCallType: record.call.input.kind === 'text' ? 'custom' : 'function', evidence: normalizeJsonSafe(record.evidence).value,
    immediatePresentation: record.immediatePresentation, retainedPresentation: record.retainedPresentation
  }, toolEventKey(input.runId, entry.identity, 'observation'));
  await input.emit({ type: 'tool.ended', ...entry.identity, toolName: entry.call.name, observation: persistedObservation });
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
function transitionWithoutCommands(state: ToolCallMachineState, event: ToolCallMachineEvent): ToolCallMachineState {
  const transition = reduceToolCall(state, event);
  requireNoCommands(transition.commands);
  return transition.state;
}
function transitionWithCommand(state: ToolCallMachineState, event: ToolCallMachineEvent, command: ToolCallMachineCommand['type']): ToolCallMachineState {
  const transition = reduceToolCall(state, event);
  requireSingleCommand(transition.commands, command);
  return transition.state;
}
function requireNoCommands(commands: readonly ToolCallMachineCommand[]): void {
  if (commands.length !== 0) throw new Error(`Tool transition produced unhandled commands: ${commands.map((command) => command.type).join(', ')}.`);
}
function requireSingleCommand(commands: readonly ToolCallMachineCommand[], type: ToolCallMachineCommand['type']): void {
  if (commands.length !== 1 || commands[0]?.type !== type) throw new Error(`Tool transition must produce exactly ${type}; received ${commands.map((command) => command.type).join(', ') || 'none'}.`);
}
function preparationOutcome(observation: ToolObservation): 'invalid_input' | 'unknown_tool' | 'failed' {
  if (!observation.ok && isJsonObject(observation.output) && observation.output.reason === 'unknown_tool') return 'unknown_tool';
  if (!observation.ok && isJsonObject(observation.output) && observation.output.reason === 'invalid_arguments') return 'invalid_input';
  return 'failed';
}
function approvalRequest(runId: string, identity: AgentToolCallIdentity, approvalId: string, reason: string, prepared: PreparedToolCall, context: ToolPreparationContext): AgentApprovalRequest {
  const input = normalizeJsonSafe(prepared.canonicalInput).value;
  const effects = normalizeJsonSafe(prepared.effects).value;
  if (!isJsonObject(effects)) throw new Error('Prepared tool effects did not normalize to an object.');
  return Object.freeze({ ...identity, approvalId, status: 'pending', toolName: prepared.tool.name, fingerprint: prepared.fingerprint, input, effects, binding: approvalBinding(prepared, context), policyHash: hashRecord(normalizeJsonSafe(context.policy).value), reason, runId });
}
function approvalBinding(prepared: PreparedToolCall, context: ToolPreparationContext): AgentApprovalBinding {
  return Object.freeze({ toolImplementationId: prepared.tool.implementationId, authorizationPolicyId: context.boundary.authorizationPolicyId, executionTargetId: context.boundary.executionTargetId });
}
function isJsonObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
