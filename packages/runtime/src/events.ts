import type { ContextBundle, ContextHistoryReduction, PromptProjection } from './context/manager.js';
import type { ArtifactRef, RuntimeCodec } from '@agent-core/evidence';
import { parseJsonObject, type JsonValue } from '@agent-core/json';
import type {
  ModelCapabilities,
  ModelLimits,
  ModelModalities,
  ModelProviderErrorDiagnostic,
  ModelReasoningRequest,
  ModelTerminationReason,
  ModelTransportMetadata,
  ModelUsage
} from '@agent-core/model';
import {
  parseAgentCandidate,
  parseAgentCheckResult,
  parseAgentTerminalSnapshot,
  type AgentCandidate,
  type AgentApprovalBinding,
  type AgentCheckRequirement,
  type AgentCheckResult,
  type AgentDeliveryDiagnostic,
  type AgentRunBudgetState,
  type AgentRunPhase,
  type AgentRequestSnapshotRecord,
  type AgentTerminalSnapshot,
  type AgentToolCallIdentity,
  type AgentToolCallAttemptIdentity,
  type AgentTurnIdentity,
  type AgentTurnSnapshotRecord
} from './run/contracts.js';
import { normalizeToolObservationForPersistence, type ToolCall, type ToolEffects, type ToolObservation, type ToolObservationPresentation, type ToolPolicy, type ToolProgress } from '@agent-core/tools';
import type { BudgetAccountantSnapshot, RequestCostEstimate } from './orchestration/budget-accountant.js';
import type { OverflowRecoveryResult } from './orchestration/overflow-recovery.js';

export interface AgentProviderStateSummary {
  readonly provider: string;
  readonly model: string;
  readonly kind: string;
  readonly dataKeys: readonly string[];
  readonly bytes: number;
}

export interface AgentProviderStateReference {
  readonly summary: AgentProviderStateSummary;
  readonly artifact: ArtifactRef;
}

export interface AgentRunConfiguration {
  readonly provider: { readonly id: string; readonly displayName: string };
  readonly model: {
    readonly id: string;
    readonly provider: string;
    readonly displayName?: string;
    readonly limits: ModelLimits;
    readonly modalities: ModelModalities;
    readonly capabilities: ModelCapabilities;
    readonly supportedParameters: readonly string[];
  };
  readonly tools: readonly { readonly name: string; readonly accessModes: readonly string[] }[];
  readonly toolPolicy: ToolPolicy;
  readonly authority: {
    readonly ambientShell: boolean;
    readonly summary: string;
  };
  readonly requestWindow: {
    readonly contextWindowTokens: number;
    readonly maxOutputTokens: number;
    readonly maxPromptTokens: number;
    readonly requestedMaxOutputTokens?: number;
  };
  readonly runtime: {
    readonly temperature?: number;
    readonly reasoning?: ModelReasoningRequest;
    readonly metadataKeys: readonly string[];
  };
}

export interface AgentModelRequestSummary {
  readonly model: string;
  readonly messageCount: number;
  readonly messageRoleCounts: Readonly<Record<string, number>>;
  readonly messageBytes: number;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly toolSchemaBytes: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly metadataKeys: readonly string[];
  readonly providerOptionKeys: readonly string[];
}

export interface AgentModelResponseSummary {
  readonly provider: string;
  readonly model: string;
  readonly contentChars: number;
  readonly contentBytes: number;
  readonly toolCallCount: number;
  readonly toolCallNames: readonly string[];
  readonly requestId?: string;
  readonly transport?: ModelTransportMetadata;
  readonly usage?: ModelUsage;
  readonly terminationReason: ModelTerminationReason;
  readonly providerTerminationReason?: string;
  readonly reasoningSummaryChars?: number;
  readonly rawBytes?: number;
  readonly providerState?: AgentProviderStateSummary;
  readonly providerStateRef?: ArtifactRef;
}

export interface AgentReplayPayload {
  readonly sessionId: string;
  readonly replayedLedgers: number;
  readonly replayedTurns: number;
  readonly replayedSessionEntries: number;
  readonly replayedCheckpoints: number;
  readonly replayedToolResults: number;
  readonly replayedEvidenceRecords: number;
  readonly restoredProviderState?: AgentProviderStateSummary;
  readonly restoredProviderStateRef?: ArtifactRef;
}

export type AgentEvent =
  | { readonly type: 'run.started'; readonly runId: string; readonly finalizationId: string; readonly task: string; readonly model: string; readonly toolPolicy: ToolPolicy; readonly metadata?: Readonly<Record<string, string>> }
  | { readonly type: 'run.phase.changed'; readonly runId: string; readonly phase: AgentRunPhase; readonly budget: AgentRunBudgetState }
  | { readonly type: 'run.configured'; readonly configuration: AgentRunConfiguration }
  | { readonly type: 'turn.snapshot.created'; readonly snapshot: AgentTurnSnapshotRecord }
  | { readonly type: 'request.snapshot.created'; readonly snapshot: AgentRequestSnapshotRecord }
  | ({ readonly type: 'run.retry.scheduled'; readonly kind: 'transport' | 'provider_request' | 'agent_turn'; readonly attempt: number; readonly delayMs: number; readonly diagnostic?: ModelProviderErrorDiagnostic } & AgentTurnIdentity)
  | { readonly type: 'finalization.prepared'; readonly terminal: AgentTerminalSnapshot }
  | { readonly type: 'run.ended'; readonly terminal: AgentTerminalSnapshot; readonly diagnostic?: ModelProviderErrorDiagnostic & { readonly turnIndex?: number } }
  | { readonly type: 'delivery.failed'; readonly finalizationId: string; readonly diagnostic: AgentDeliveryDiagnostic }
  | { readonly type: 'process.ended'; readonly runId: string; readonly processId: string; readonly status: string; readonly result: JsonValue }
  | ({ readonly type: 'turn.started'; readonly runId: string; readonly task: string; readonly sessionId?: string; readonly sessionEntryId?: string } & AgentTurnIdentity)
  | ({ readonly type: 'context.replay.created' } & AgentReplayPayload)
  | { readonly type: 'provider.state.restored'; readonly state: AgentProviderStateSummary; readonly stateRef?: ArtifactRef }
  | ({ readonly type: 'provider.state.updated'; readonly state: AgentProviderStateSummary; readonly stateRef: ArtifactRef } & AgentTurnIdentity)
  | { readonly type: 'input.received'; readonly task: string }
  | { readonly type: 'context.bundle.created'; readonly bundle: ContextBundle }
  | { readonly type: 'prompt.projection.created'; readonly projection: PromptProjection }
  | ({ readonly type: 'assistant.started' } & AgentTurnIdentity)
  | ({ readonly type: 'assistant.ended'; readonly content: string; readonly candidate: AgentCandidate; readonly toolCalls?: readonly ToolCall[] } & AgentTurnIdentity)
  | ({ readonly type: 'assistant.interrupted'; readonly content: string; readonly candidate: AgentCandidate; readonly reasoningSummary?: string; readonly finalResponseReceived: boolean; readonly diagnostic?: ModelProviderErrorDiagnostic } & AgentTurnIdentity)
  | ({ readonly type: 'model.failed'; readonly diagnostic: ModelProviderErrorDiagnostic } & AgentTurnIdentity)
  | ({ readonly type: 'model.requested'; readonly request: AgentModelRequestSummary } & AgentTurnIdentity)
  | ({ readonly type: 'model.responded'; readonly response: AgentModelResponseSummary } & AgentTurnIdentity)
  | ({ readonly type: 'budget.estimate.created'; readonly attempt: number; readonly estimate: RequestCostEstimate; readonly snapshot: BudgetAccountantSnapshot } & AgentTurnIdentity)
  | ({ readonly type: 'budget.provider_usage.recorded'; readonly usage: ModelUsage; readonly snapshot: BudgetAccountantSnapshot } & AgentTurnIdentity)
  | ({ readonly type: 'overflow.recovery.started'; readonly attempt: number; readonly estimate: RequestCostEstimate; readonly snapshot: BudgetAccountantSnapshot } & AgentTurnIdentity)
  | ({ readonly type: 'overflow.recovery.ended'; readonly attempt: number; readonly result: OverflowRecoveryResult } & AgentTurnIdentity)
  | ({ readonly type: 'context.history.reduced'; readonly reductions: readonly ContextHistoryReduction[] } & AgentTurnIdentity)
  | ({ readonly type: 'context.checkpoint.created'; readonly compactedToolResults: number; readonly removedItems?: number; readonly beforeBytes?: number; readonly afterBytes?: number } & AgentTurnIdentity)
  | ({ readonly type: 'observation.record.created'; readonly id: string; readonly toolName: string; readonly call: ToolCall; readonly toolCallType: 'function' | 'custom'; readonly evidence: JsonValue; readonly immediatePresentation: ToolObservationPresentation; readonly retainedPresentation: ToolObservationPresentation; readonly durableStorageDegraded?: { readonly message: string } } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'observation.projection.failed'; readonly id: string; readonly toolName: string; readonly message: string } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'tool.authorization.decided'; readonly toolName: string; readonly fingerprint: string; readonly binding: AgentApprovalBinding; readonly decision: 'allow' | 'deny' | 'require_approval'; readonly reason?: string } & AgentToolCallIdentity)
  | ({ readonly type: 'approval.requested'; readonly runId: string; readonly approvalId: string; readonly toolName: string; readonly fingerprint: string; readonly input: JsonValue; readonly effects: ToolEffects; readonly binding: AgentApprovalBinding; readonly policyHash: string; readonly reason: string } & AgentToolCallIdentity)
  | ({ readonly type: 'approval.resolved'; readonly runId: string; readonly approvalId: string; readonly fingerprint: string; readonly binding: AgentApprovalBinding; readonly decision: 'allow' | 'deny' } & AgentToolCallIdentity)
  | ({ readonly type: 'tool.started'; readonly toolName: string; readonly input: ToolCall; readonly fingerprint: string; readonly effects: ToolEffects } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'tool.updated'; readonly toolName: string; readonly progress: ToolProgress } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'tool.ended'; readonly toolName: string; readonly observation: ToolObservation } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'check.started'; readonly check: string; readonly requirement: AgentCheckRequirement; readonly timeoutMs: number } & AgentTurnIdentity)
  | ({ readonly type: 'check.ended'; readonly check: string; readonly result: AgentCheckResult } & AgentTurnIdentity);

export type AgentProgressEvent =
  | ({ readonly type: 'turn.started'; readonly runId: string; readonly task: string; readonly sessionId?: string; readonly sessionEntryId?: string } & AgentTurnIdentity)
  | ({ readonly type: 'context.replay.restored' } & AgentReplayPayload)
  | { readonly type: 'provider.state.restored'; readonly state: AgentProviderStateSummary; readonly stateRef?: ArtifactRef }
  | { readonly type: 'run.configured'; readonly configuration: AgentRunConfiguration }
  | { readonly type: 'run.phase.changed'; readonly phase: AgentRunPhase; readonly budget: AgentRunBudgetState }
  | ({ readonly type: 'context.history.reduced'; readonly reductions: readonly ContextHistoryReduction[] } & AgentTurnIdentity)
  | ({ readonly type: 'context.checkpoint.created'; readonly compactedToolResults: number; readonly removedItems?: number; readonly beforeBytes?: number; readonly afterBytes?: number } & AgentTurnIdentity)
  | ({ readonly type: 'assistant.started' } & AgentTurnIdentity)
  | ({ readonly type: 'assistant.delta'; readonly delta: string; readonly accumulated: string } & AgentTurnIdentity)
  | ({ readonly type: 'assistant.reasoning'; readonly delta: string; readonly accumulated: string; readonly channel?: 'reasoning' | 'summary' } & AgentTurnIdentity)
  | ({ readonly type: 'assistant.status'; readonly message: string } & AgentTurnIdentity)
  | ({ readonly type: 'tool.call.received'; readonly toolCall: ToolCall } & AgentToolCallIdentity)
  | ({ readonly type: 'assistant.ended'; readonly content: string; readonly candidate: AgentCandidate; readonly toolCalls?: readonly ToolCall[] } & AgentTurnIdentity)
  | ({ readonly type: 'assistant.interrupted'; readonly content: string; readonly candidate: AgentCandidate; readonly reasoningSummary?: string; readonly finalResponseReceived: boolean; readonly diagnostic?: ModelProviderErrorDiagnostic } & AgentTurnIdentity)
  | ({ readonly type: 'model.failed'; readonly diagnostic: ModelProviderErrorDiagnostic } & AgentTurnIdentity)
  | ({ readonly type: 'tool.started'; readonly toolName: string; readonly input: ToolCall; readonly fingerprint: string; readonly effects: ToolEffects } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'tool.updated'; readonly toolName: string; readonly progress: ToolProgress } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'tool.ended'; readonly toolName: string; readonly observation: ToolObservation } & AgentToolCallAttemptIdentity)
  | ({ readonly type: 'check.ended'; readonly result: AgentCheckResult } & AgentTurnIdentity)
  | { readonly type: 'run.ended'; readonly terminal: AgentTerminalSnapshot; readonly deliveryDiagnostics: readonly AgentDeliveryDiagnostic[] };

export const agentEventCodec: RuntimeCodec<AgentEvent> = { name: 'AgentEvent', parse: parseAgentEvent };

const AGENT_EVENT_MAX_STRING_BYTES = 1024 * 1024;
const AGENT_EVENT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const AGENT_EVENT_MAX_COLLECTION_ENTRIES = 20_000;

export function parseAgentEvent(value: unknown): AgentEvent {
  let owned;
  try {
    owned = parseJsonObject(value, {
      maxDepth: 16,
      maxCollectionEntries: AGENT_EVENT_MAX_COLLECTION_ENTRIES,
      maxStringBytes: AGENT_EVENT_MAX_STRING_BYTES,
      maxTotalBytes: AGENT_EVENT_MAX_TOTAL_BYTES
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes('accessor') ? 'accessor' : message.includes('string byte limit') ? 'text_truncated' : 'invalid_json';
    throw new Error(`Agent event is not safely serializable: ${code}. ${message}`, { cause: error });
  }
  if (typeof owned.type !== 'string') throw new Error('Agent event must have a type.');
  if (!isAgentEventType(owned.type)) throw new Error(`Unsupported Agent event type: ${owned.type}.`);
  const issues = validateEventShape(owned);
  if (issues.length > 0) throw new Error(`Malformed Agent event ${owned.type}: ${issues.join(' ')}`);
  let parsed: unknown;
  if (owned.type === 'run.ended' || owned.type === 'finalization.prepared') {
    parsed = { ...owned, terminal: parseAgentTerminalSnapshot(owned.terminal) };
  } else if (owned.type === 'assistant.ended' || owned.type === 'assistant.interrupted') {
    const candidate = parseAgentCandidate(owned.candidate);
    if (candidate.status !== 'absent' && candidate.turnIndex !== owned.turnIndex) throw new Error(`Malformed Agent event ${owned.type}: candidate turnIndex does not match event turnIndex.`);
    parsed = { ...owned, candidate };
  } else if (owned.type === 'check.ended') {
    const result = parseAgentCheckResult(owned.result);
    if (result.id !== owned.check) throw new Error('Malformed Agent event check.ended: check id does not match result id.');
    parsed = { ...owned, result };
  } else if (owned.type === 'tool.ended') {
    parsed = { ...owned, observation: normalizeToolObservationForPersistence(owned.observation) };
  } else {
    parsed = owned;
  }
  if (!isAgentEvent(parsed)) throw new Error(`Malformed Agent event ${owned.type}: validated fields did not form an event.`);
  return parseJsonObject(parsed, {
    maxDepth: 16,
    maxCollectionEntries: AGENT_EVENT_MAX_COLLECTION_ENTRIES,
    maxStringBytes: AGENT_EVENT_MAX_STRING_BYTES,
    maxTotalBytes: AGENT_EVENT_MAX_TOTAL_BYTES
  }) as unknown as AgentEvent;
}

function validateEventShape(value: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const turnTypes = new Set([
    'run.retry.scheduled', 'provider.state.updated', 'assistant.started', 'assistant.ended', 'assistant.interrupted',
    'model.failed', 'model.requested', 'model.responded', 'budget.estimate.created', 'budget.provider_usage.recorded',
    'overflow.recovery.started', 'overflow.recovery.ended', 'context.history.reduced', 'context.checkpoint.created',
    'observation.record.created', 'observation.projection.failed', 'tool.authorization.decided', 'approval.requested', 'approval.resolved', 'tool.started', 'tool.updated', 'tool.ended'
  ]);
  if (turnTypes.has(String(value.type))) {
    if (!positiveInteger(value.turnIndex)) issues.push('turnIndex must be a positive integer.');
    requireStrings(value, ['turnId'], issues);
    if (!positiveInteger(value.requestAttempt)) issues.push('requestAttempt must be positive.');
  }
  const toolTypes = new Set(['observation.record.created', 'observation.projection.failed', 'tool.authorization.decided', 'approval.requested', 'approval.resolved', 'tool.started', 'tool.updated', 'tool.ended']);
  if (toolTypes.has(String(value.type))) requireStrings(value, ['toolBatchId'], issues);
  if (!isAgentEventType(value.type)) return ['type is unsupported.'];
  EVENT_VALIDATORS[value.type](value, issues);
  return issues;
}

type EventShapeValidator = (value: Record<string, unknown>, issues: string[]) => void;
const EVENT_VALIDATORS = {
  'run.started': (value, issues) => { requireStrings(value, ['runId', 'finalizationId', 'task', 'model'], issues); requireRecord(value.toolPolicy, 'toolPolicy', issues); },
  'run.phase.changed': (value, issues) => { requireStrings(value, ['runId'], issues); if (!['preparing', 'requesting_model', 'executing_tools', 'waiting_for_approval', 'verifying', 'finalizing', 'ended'].includes(String(value.phase))) issues.push('phase is invalid.'); requireRecord(value.budget, 'budget', issues); },
  'run.configured': (value, issues) => { requireRecord(value.configuration, 'configuration', issues); },
  'turn.snapshot.created': (value, issues) => { requireRecord(value.snapshot, 'snapshot', issues); },
  'request.snapshot.created': (value, issues) => { requireRecord(value.snapshot, 'snapshot', issues); },
  'run.retry.scheduled': (value, issues) => { if (!['transport', 'provider_request', 'agent_turn'].includes(String(value.kind))) issues.push('retry kind is invalid.'); if (!positiveInteger(value.attempt)) issues.push('attempt must be positive.'); if (!nonnegativeFinite(value.delayMs)) issues.push('delayMs must be nonnegative.'); },
  'finalization.prepared': (value, issues) => { requireRecord(value.terminal, 'terminal', issues); },
  'run.ended': (value, issues) => { requireRecord(value.terminal, 'terminal', issues); },
  'delivery.failed': (value, issues) => { requireStrings(value, ['finalizationId'], issues); requireRecord(value.diagnostic, 'diagnostic', issues); },
  'process.ended': (value, issues) => { requireStrings(value, ['runId', 'processId', 'status'], issues); if (value.result === undefined) issues.push('result is required.'); },
  'turn.started': (value, issues) => { requireStrings(value, ['runId', 'task', 'turnId'], issues); if (!positiveInteger(value.turnIndex) || !positiveInteger(value.requestAttempt)) issues.push('turn identity is invalid.'); },
  'context.replay.created': (value, issues) => { requireStrings(value, ['sessionId'], issues); for (const name of ['replayedLedgers', 'replayedTurns', 'replayedSessionEntries', 'replayedCheckpoints', 'replayedToolResults', 'replayedEvidenceRecords']) if (!nonnegativeInteger(value[name])) issues.push(`${name} must be nonnegative.`); },
  'provider.state.restored': (value, issues) => { requireRecord(value.state, 'state', issues); },
  'provider.state.updated': (value, issues) => { requireRecord(value.state, 'state', issues); requireRecord(value.stateRef, 'stateRef', issues); },
  'input.received': (value, issues) => { requireStrings(value, ['task'], issues); },
  'context.bundle.created': (value, issues) => { requireRecord(value.bundle, 'bundle', issues); },
  'prompt.projection.created': (value, issues) => { requireRecord(value.projection, 'projection', issues); },
  'assistant.started': () => undefined,
  'assistant.ended': (value, issues) => { if (typeof value.content !== 'string') issues.push('content must be a string.'); if (value.toolCalls !== undefined && !Array.isArray(value.toolCalls)) issues.push('toolCalls must be an array.'); },
  'assistant.interrupted': (value, issues) => { if (typeof value.content !== 'string') issues.push('content must be a string.'); if (typeof value.finalResponseReceived !== 'boolean') issues.push('finalResponseReceived must be boolean.'); },
  'model.failed': (value, issues) => { requireRecord(value.diagnostic, 'diagnostic', issues); },
  'model.requested': (value, issues) => { requireRecord(value.request, 'request', issues); },
  'model.responded': (value, issues) => { requireRecord(value.response, 'response', issues); },
  'budget.estimate.created': estimateEvent,
  'budget.provider_usage.recorded': (value, issues) => { requireRecord(value.usage, 'usage', issues); requireRecord(value.snapshot, 'snapshot', issues); },
  'overflow.recovery.started': estimateEvent,
  'overflow.recovery.ended': (value, issues) => { if (!positiveInteger(value.attempt)) issues.push('attempt must be positive.'); requireRecord(value.result, 'result', issues); },
  'context.history.reduced': (value, issues) => { if (!Array.isArray(value.reductions)) issues.push('reductions must be an array.'); },
  'context.checkpoint.created': (value, issues) => { if (!nonnegativeInteger(value.compactedToolResults)) issues.push('compactedToolResults must be nonnegative.'); },
  'observation.record.created': (value, issues) => { requireStrings(value, ['id', 'toolName'], issues); requireToolAttempt(value, issues); requireRecord(value.call, 'call', issues); requireRecord(value.immediatePresentation, 'immediatePresentation', issues); requireRecord(value.retainedPresentation, 'retainedPresentation', issues); if (value.toolCallType !== 'function' && value.toolCallType !== 'custom') issues.push('toolCallType is invalid.'); if (value.durableStorageDegraded !== undefined) { requireRecord(value.durableStorageDegraded, 'durableStorageDegraded', issues); if (isRecord(value.durableStorageDegraded)) requireStrings(value.durableStorageDegraded, ['message'], issues); } },
  'observation.projection.failed': (value, issues) => { requireStrings(value, ['id', 'toolName', 'message'], issues); requireToolAttempt(value, issues); },
  'tool.authorization.decided': (value, issues) => { requireStrings(value, ['toolName', 'fingerprint'], issues); validateApprovalBinding(value.binding, issues); if (!nonnegativeInteger(value.callIndex)) issues.push('callIndex must be nonnegative.'); if (!['allow', 'deny', 'require_approval'].includes(String(value.decision))) issues.push('authorization decision is invalid.'); },
  'approval.requested': (value, issues) => { requireStrings(value, ['runId', 'approvalId', 'toolName', 'fingerprint', 'policyHash', 'reason'], issues); requireRecord(value.effects, 'effects', issues); validateApprovalBinding(value.binding, issues); },
  'approval.resolved': (value, issues) => { requireStrings(value, ['runId', 'approvalId', 'fingerprint'], issues); validateApprovalBinding(value.binding, issues); if (value.decision !== 'allow' && value.decision !== 'deny') issues.push('approval decision is invalid.'); },
  'tool.started': (value, issues) => { requireStrings(value, ['toolName', 'fingerprint'], issues); requireToolAttempt(value, issues); requireRecord(value.input, 'input', issues); requireRecord(value.effects, 'effects', issues); if (!nonnegativeInteger(value.callIndex)) issues.push('callIndex must be nonnegative.'); },
  'tool.updated': (value, issues) => { requireStrings(value, ['toolName'], issues); validateToolProgress(value.progress, issues); requireToolAttempt(value, issues); if (!nonnegativeInteger(value.callIndex)) issues.push('callIndex must be nonnegative.'); },
  'tool.ended': (value, issues) => { requireStrings(value, ['toolName'], issues); requireToolAttempt(value, issues); requireRecord(value.observation, 'observation', issues); if (!nonnegativeInteger(value.callIndex)) issues.push('callIndex must be nonnegative.'); },
  'check.started': (value, issues) => { requireStrings(value, ['check', 'turnId'], issues); if (!positiveInteger(value.turnIndex) || !positiveInteger(value.requestAttempt)) issues.push('turn identity is invalid.'); if (value.requirement !== 'required' && value.requirement !== 'advisory') issues.push('requirement is invalid.'); if (!positiveInteger(value.timeoutMs)) issues.push('timeoutMs must be positive.'); },
  'check.ended': (value, issues) => { requireStrings(value, ['check', 'turnId'], issues); if (!positiveInteger(value.turnIndex) || !positiveInteger(value.requestAttempt)) issues.push('turn identity is invalid.'); requireRecord(value.result, 'result', issues); }
} satisfies Record<AgentEvent['type'], EventShapeValidator>;

function estimateEvent(value: Record<string, unknown>, issues: string[]): void { if (!positiveInteger(value.attempt)) issues.push('attempt must be positive.'); requireRecord(value.estimate, 'estimate', issues); requireRecord(value.snapshot, 'snapshot', issues); }

function requireStrings(value: Record<string, unknown>, names: readonly string[], issues: string[]): void {
  for (const name of names) if (typeof value[name] !== 'string' || value[name].trim().length === 0) issues.push(`${name} must be a non-empty string.`);
}
function requireRecord(value: unknown, name: string, issues: string[]): void { if (!isRecord(value)) issues.push(`${name} must be an object.`); }
function validateApprovalBinding(value: unknown, issues: string[]): void {
  if (!isRecord(value)) { issues.push('binding must be an object.'); return; }
  requireStrings(value, ['toolImplementationId', 'authorizationPolicyId', 'executionTargetId'], issues);
}
function validateToolProgress(value: unknown, issues: string[]): void {
  if (!isRecord(value) || !['status', 'output', 'patch', 'metric'].includes(String(value.type))) { issues.push('progress must be a supported typed progress value.'); return; }
  if (value.type === 'status' && typeof value.stage !== 'string') issues.push('status progress.stage must be a string.');
  if (value.type === 'output' && (!['stdout', 'stderr'].includes(String(value.stream)) || !nonnegativeInteger(value.sequence) || typeof value.text !== 'string' || !nonnegativeInteger(value.observedBytes))) issues.push('output progress is invalid.');
  if (value.type === 'patch' && !Array.isArray(value.changes)) issues.push('patch progress.changes must be an array.');
  if (value.type === 'metric' && (typeof value.name !== 'string' || typeof value.value !== 'number' || !Number.isFinite(value.value))) issues.push('metric progress is invalid.');
}
function requireToolAttempt(value: Record<string, unknown>, issues: string[]): void { if (!positiveInteger(value.toolAttempt)) issues.push('toolAttempt must be positive.'); }
function nonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function nonnegativeFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

function isAgentEventType(value: unknown): value is AgentEvent['type'] {
  return typeof value === 'string' && Object.hasOwn(EVENT_VALIDATORS, value);
}
function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && isAgentEventType(value.type) && validateEventShape(value).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
