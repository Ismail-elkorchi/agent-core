import type { ContextBundle, ContextHistoryReduction, PromptProjection } from './context/manager.js';
import { decodeOwnedArtifactRef, decodeOwnedEvidenceRecord, type ArtifactRef, type RuntimeCodec } from '@agent-core/evidence';
import { parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';
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
import { decodeOwnedModelCapabilities, decodeOwnedModelLimits, decodeOwnedModelModalities, decodeOwnedModelResponseFormat, decodeOwnedModelTransport, parseModelReasoningRequest, parseModelUsage } from '@agent-core/model';
import {
  decodeOwnedAgentCandidate,
  decodeOwnedAgentCheckResult,
  decodeOwnedAgentTerminalSnapshot,
  type AgentCandidate,
  type AgentApprovalBinding,
  type AgentCheckRequirement,
  type AgentEffectiveInstruction,
  type AgentRunLimits,
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
import { decodeOwnedToolCall, decodeOwnedToolEffects, decodeOwnedToolObservationForPersistence, decodeOwnedToolPolicy, type ToolCall, type ToolEffects, type ToolObservation, type ToolObservationPresentation, type ToolPolicy, type ToolProgress } from '@agent-core/tools';
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

export const agentEventCodec: RuntimeCodec<AgentEvent> = {
  encode: encodeAgentEvent,
  decode: decodeAgentEvent
};

const AGENT_EVENT_MAX_STRING_BYTES = 1024 * 1024;
const AGENT_EVENT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const AGENT_EVENT_MAX_COLLECTION_ENTRIES = 20_000;


export function encodeAgentEvent(value: AgentEvent): JsonObject { return ownEventJson(value); }

export function decodeAgentEvent(value: unknown): AgentEvent {
  const owned = ownEventJson(value);
  const decoder: (input: JsonObject) => AgentEvent = AGENT_EVENT_DECODERS[decodeEventType(owned.type)];
  return decoder(owned);
}

function ownEventJson(value: unknown): JsonObject {
  let owned: JsonObject;
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
  return owned;
}

function decodeEventType(value: JsonValue | undefined): AgentEvent['type'] {
  if (typeof value !== 'string') throw malformed('type is invalid');
  for (const type of AGENT_EVENT_TYPES) if (type === value) return type;
  throw malformed(`unsupported type ${value}`);
}

type AgentEventOf<Type extends AgentEvent['type']> = Extract<AgentEvent, { readonly type: Type }>;
type AgentEventDecoderMap = { readonly [Type in AgentEvent['type']]: (value: JsonObject) => AgentEventOf<Type> };

const AGENT_EVENT_DECODERS = {
  'run.started': (value) => {
    exact(value, ['type', 'runId', 'finalizationId', 'task', 'model', 'toolPolicy', 'metadata']);
    const metadata = optionalStringRecord(value.metadata, 'metadata');
    return Object.freeze({
      type: 'run.started', runId: requiredString(value.runId, 'runId'), finalizationId: requiredString(value.finalizationId, 'finalizationId'),
      task: requiredString(value.task, 'task'), model: requiredString(value.model, 'model'), toolPolicy: decodeOwnedToolPolicy(requiredObject(value.toolPolicy, 'toolPolicy')),
      ...(metadata ? { metadata } : {})
    });
  },
  'run.phase.changed': (value) => {
    exact(value, ['type', 'runId', 'phase', 'budget']);
    return Object.freeze({ type: 'run.phase.changed', runId: requiredString(value.runId, 'runId'), phase: requiredEnum(value.phase, RUN_PHASES, 'phase'), budget: decodeRunBudget(value.budget) });
  },
  'run.configured': (value) => {
    exact(value, ['type', 'configuration']);
    return Object.freeze({ type: 'run.configured', configuration: decodeRunConfiguration(value.configuration) });
  },
  'turn.snapshot.created': (value) => {
    exact(value, ['type', 'snapshot']);
    return Object.freeze({ type: 'turn.snapshot.created', snapshot: decodeTurnSnapshot(value.snapshot) });
  },
  'request.snapshot.created': (value) => {
    exact(value, ['type', 'snapshot']);
    return Object.freeze({ type: 'request.snapshot.created', snapshot: decodeRequestSnapshot(value.snapshot) });
  },
  'run.retry.scheduled': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'kind', 'attempt', 'delayMs', 'diagnostic']);
    const diagnostic = optionalDiagnostic(value.diagnostic);
    return Object.freeze({ type: 'run.retry.scheduled', ...decodeTurnIdentity(value), kind: requiredEnum(value.kind, RETRY_KINDS, 'kind'), attempt: positiveInteger(value.attempt, 'attempt'), delayMs: nonnegativeNumber(value.delayMs, 'delayMs'), ...(diagnostic ? { diagnostic } : {}) });
  },
  'finalization.prepared': (value) => {
    exact(value, ['type', 'terminal']);
    return Object.freeze({ type: 'finalization.prepared', terminal: decodeOwnedAgentTerminalSnapshot(requiredObject(value.terminal, 'terminal')) });
  },
  'run.ended': (value) => {
    exact(value, ['type', 'terminal', 'diagnostic']);
    const diagnostic = optionalDiagnostic(value.diagnostic, true);
    return Object.freeze({ type: 'run.ended', terminal: decodeOwnedAgentTerminalSnapshot(requiredObject(value.terminal, 'terminal')), ...(diagnostic ? { diagnostic } : {}) });
  },
  'delivery.failed': (value) => {
    exact(value, ['type', 'finalizationId', 'diagnostic']);
    return Object.freeze({ type: 'delivery.failed', finalizationId: requiredString(value.finalizationId, 'finalizationId'), diagnostic: decodeDeliveryDiagnostic(value.diagnostic) });
  },
  'process.ended': (value) => {
    exact(value, ['type', 'runId', 'processId', 'status', 'result']);
    return Object.freeze({ type: 'process.ended', runId: requiredString(value.runId, 'runId'), processId: requiredString(value.processId, 'processId'), status: requiredString(value.status, 'status'), result: requiredJson(value.result, 'result') });
  },
  'turn.started': (value) => {
    exact(value, ['type', 'runId', 'task', 'sessionId', 'sessionEntryId', ...TURN_KEYS]);
    const sessionId = optionalString(value.sessionId, 'sessionId');
    const sessionEntryId = optionalString(value.sessionEntryId, 'sessionEntryId');
    return Object.freeze({ type: 'turn.started', ...decodeTurnIdentity(value), runId: requiredString(value.runId, 'runId'), task: requiredString(value.task, 'task'), ...(sessionId ? { sessionId } : {}), ...(sessionEntryId ? { sessionEntryId } : {}) });
  },
  'context.replay.created': (value) => {
    exact(value, ['type', ...REPLAY_KEYS]);
    return Object.freeze({ type: 'context.replay.created', ...decodeReplayPayload(value) });
  },
  'provider.state.restored': (value) => {
    exact(value, ['type', 'state', 'stateRef']);
    const stateRef = optionalArtifactRef(value.stateRef);
    return Object.freeze({ type: 'provider.state.restored', state: decodeProviderStateSummary(value.state), ...(stateRef ? { stateRef } : {}) });
  },
  'provider.state.updated': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'state', 'stateRef']);
    return Object.freeze({ type: 'provider.state.updated', ...decodeTurnIdentity(value), state: decodeProviderStateSummary(value.state), stateRef: decodeOwnedArtifactRef(requiredObject(value.stateRef, 'artifact')) });
  },
  'input.received': (value) => {
    exact(value, ['type', 'task']);
    return Object.freeze({ type: 'input.received', task: requiredString(value.task, 'task') });
  },
  'context.bundle.created': (value) => {
    exact(value, ['type', 'bundle']);
    return Object.freeze({ type: 'context.bundle.created', bundle: decodeContextBundle(value.bundle) });
  },
  'prompt.projection.created': (value) => {
    exact(value, ['type', 'projection']);
    return Object.freeze({ type: 'prompt.projection.created', projection: decodePromptProjection(value.projection) });
  },
  'assistant.started': (value) => {
    exact(value, ['type', ...TURN_KEYS]);
    return Object.freeze({ type: 'assistant.started', ...decodeTurnIdentity(value) });
  },
  'assistant.ended': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'content', 'candidate', 'toolCalls']);
    const identity = decodeTurnIdentity(value);
    const candidate = decodeOwnedAgentCandidate(requiredObject(value.candidate, 'candidate'));
    if (candidate.status !== 'absent' && candidate.turnIndex !== identity.turnIndex) throw malformed('candidate turnIndex does not match event turnIndex');
    const toolCalls = optionalArray(value.toolCalls, 'toolCalls')?.map((call, index) => decodeOwnedToolCall(requiredObject(call, `toolCalls[${String(index)}]`)));
    return Object.freeze({ type: 'assistant.ended', ...identity, content: requiredStringValue(value.content, 'content'), candidate, ...(toolCalls ? { toolCalls: Object.freeze(toolCalls) } : {}) });
  },
  'assistant.interrupted': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'content', 'candidate', 'reasoningSummary', 'finalResponseReceived', 'diagnostic']);
    const identity = decodeTurnIdentity(value);
    const candidate = decodeOwnedAgentCandidate(requiredObject(value.candidate, 'candidate'));
    if (candidate.status !== 'absent' && candidate.turnIndex !== identity.turnIndex) throw malformed('candidate turnIndex does not match event turnIndex');
    const reasoningSummary = optionalStringValue(value.reasoningSummary, 'reasoningSummary');
    const diagnostic = optionalDiagnostic(value.diagnostic);
    return Object.freeze({ type: 'assistant.interrupted', ...identity, content: requiredStringValue(value.content, 'content'), candidate, ...(reasoningSummary !== undefined ? { reasoningSummary } : {}), finalResponseReceived: requiredBoolean(value.finalResponseReceived, 'finalResponseReceived'), ...(diagnostic ? { diagnostic } : {}) });
  },
  'model.failed': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'diagnostic']);
    return Object.freeze({ type: 'model.failed', ...decodeTurnIdentity(value), diagnostic: decodeDiagnostic(value.diagnostic) });
  },
  'model.requested': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'request']);
    return Object.freeze({ type: 'model.requested', ...decodeTurnIdentity(value), request: decodeModelRequestSummary(value.request) });
  },
  'model.responded': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'response']);
    return Object.freeze({ type: 'model.responded', ...decodeTurnIdentity(value), response: decodeModelResponseSummary(value.response) });
  },
  'budget.estimate.created': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'attempt', 'estimate', 'snapshot']);
    return Object.freeze({ type: 'budget.estimate.created', ...decodeTurnIdentity(value), attempt: positiveInteger(value.attempt, 'attempt'), estimate: decodeRequestCostEstimate(value.estimate), snapshot: decodeBudgetSnapshot(value.snapshot) });
  },
  'budget.provider_usage.recorded': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'usage', 'snapshot']);
    return Object.freeze({ type: 'budget.provider_usage.recorded', ...decodeTurnIdentity(value), usage: parseModelUsage(value.usage), snapshot: decodeBudgetSnapshot(value.snapshot) });
  },
  'overflow.recovery.started': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'attempt', 'estimate', 'snapshot']);
    return Object.freeze({ type: 'overflow.recovery.started', ...decodeTurnIdentity(value), attempt: positiveInteger(value.attempt, 'attempt'), estimate: decodeRequestCostEstimate(value.estimate), snapshot: decodeBudgetSnapshot(value.snapshot) });
  },
  'overflow.recovery.ended': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'attempt', 'result']);
    return Object.freeze({ type: 'overflow.recovery.ended', ...decodeTurnIdentity(value), attempt: positiveInteger(value.attempt, 'attempt'), result: decodeOverflowResult(value.result) });
  },
  'context.history.reduced': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'reductions']);
    return Object.freeze({ type: 'context.history.reduced', ...decodeTurnIdentity(value), reductions: Object.freeze(requiredArray(value.reductions, 'reductions').map((item, index) => decodeHistoryReduction(item, `reductions[${String(index)}]`))) });
  },
  'context.checkpoint.created': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'compactedToolResults', 'removedItems', 'beforeBytes', 'afterBytes']);
    return Object.freeze({ type: 'context.checkpoint.created', ...decodeTurnIdentity(value), compactedToolResults: nonnegativeInteger(value.compactedToolResults, 'compactedToolResults'), ...optionalNonnegativeFields(value, ['removedItems', 'beforeBytes', 'afterBytes']) });
  },
  'observation.record.created': (value) => {
    exact(value, ['type', ...TOOL_ATTEMPT_KEYS, 'id', 'toolName', 'call', 'toolCallType', 'evidence', 'immediatePresentation', 'retainedPresentation', 'durableStorageDegraded']);
    const degraded = value.durableStorageDegraded === undefined ? undefined : decodeMessageRecord(value.durableStorageDegraded, 'durableStorageDegraded');
    return Object.freeze({
      type: 'observation.record.created', ...decodeToolAttemptIdentity(value), id: requiredString(value.id, 'id'), toolName: requiredString(value.toolName, 'toolName'),
      call: decodeOwnedToolCall(requiredObject(value.call, 'call')), toolCallType: requiredEnum(value.toolCallType, TOOL_CALL_TYPES, 'toolCallType'), evidence: requiredJson(value.evidence, 'evidence'),
      immediatePresentation: decodePresentation(value.immediatePresentation, 'immediatePresentation'), retainedPresentation: decodePresentation(value.retainedPresentation, 'retainedPresentation'),
      ...(degraded ? { durableStorageDegraded: degraded } : {})
    });
  },
  'observation.projection.failed': (value) => {
    exact(value, ['type', ...TOOL_ATTEMPT_KEYS, 'id', 'toolName', 'message']);
    return Object.freeze({ type: 'observation.projection.failed', ...decodeToolAttemptIdentity(value), id: requiredString(value.id, 'id'), toolName: requiredString(value.toolName, 'toolName'), message: requiredStringValue(value.message, 'message') });
  },
  'tool.authorization.decided': (value) => {
    exact(value, ['type', ...TOOL_CALL_KEYS, 'toolName', 'fingerprint', 'binding', 'decision', 'reason']);
    const reason = optionalStringValue(value.reason, 'reason');
    return Object.freeze({ type: 'tool.authorization.decided', ...decodeToolCallIdentity(value), toolName: requiredString(value.toolName, 'toolName'), fingerprint: requiredString(value.fingerprint, 'fingerprint'), binding: decodeApprovalBinding(value.binding), decision: requiredEnum(value.decision, AUTHORIZATION_DECISIONS, 'decision'), ...(reason !== undefined ? { reason } : {}) });
  },
  'approval.requested': (value) => {
    exact(value, ['type', ...TOOL_CALL_KEYS, 'runId', 'approvalId', 'toolName', 'fingerprint', 'input', 'effects', 'binding', 'policyHash', 'reason']);
    return Object.freeze({
      type: 'approval.requested', ...decodeToolCallIdentity(value), runId: requiredString(value.runId, 'runId'), approvalId: requiredString(value.approvalId, 'approvalId'),
      toolName: requiredString(value.toolName, 'toolName'), fingerprint: requiredString(value.fingerprint, 'fingerprint'), input: requiredJson(value.input, 'input'),
      effects: decodeOwnedToolEffects(requiredObject(value.effects, 'effects')), binding: decodeApprovalBinding(value.binding), policyHash: requiredString(value.policyHash, 'policyHash'), reason: requiredStringValue(value.reason, 'reason')
    });
  },
  'approval.resolved': (value) => {
    exact(value, ['type', ...TOOL_CALL_KEYS, 'runId', 'approvalId', 'fingerprint', 'binding', 'decision']);
    return Object.freeze({ type: 'approval.resolved', ...decodeToolCallIdentity(value), runId: requiredString(value.runId, 'runId'), approvalId: requiredString(value.approvalId, 'approvalId'), fingerprint: requiredString(value.fingerprint, 'fingerprint'), binding: decodeApprovalBinding(value.binding), decision: requiredEnum(value.decision, APPROVAL_DECISIONS, 'decision') });
  },
  'tool.started': (value) => {
    exact(value, ['type', ...TOOL_ATTEMPT_KEYS, 'toolName', 'input', 'fingerprint', 'effects']);
    return Object.freeze({ type: 'tool.started', ...decodeToolAttemptIdentity(value), toolName: requiredString(value.toolName, 'toolName'), input: decodeOwnedToolCall(requiredObject(value.input, 'input')), fingerprint: requiredString(value.fingerprint, 'fingerprint'), effects: decodeOwnedToolEffects(requiredObject(value.effects, 'effects')) });
  },
  'tool.updated': (value) => {
    exact(value, ['type', ...TOOL_ATTEMPT_KEYS, 'toolName', 'progress']);
    return Object.freeze({ type: 'tool.updated', ...decodeToolAttemptIdentity(value), toolName: requiredString(value.toolName, 'toolName'), progress: decodeToolProgress(value.progress) });
  },
  'tool.ended': (value) => {
    exact(value, ['type', ...TOOL_ATTEMPT_KEYS, 'toolName', 'observation']);
    return Object.freeze({ type: 'tool.ended', ...decodeToolAttemptIdentity(value), toolName: requiredString(value.toolName, 'toolName'), observation: decodeOwnedToolObservationForPersistence(requiredObject(value.observation, 'observation')) });
  },
  'check.started': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'check', 'requirement', 'timeoutMs']);
    return Object.freeze({ type: 'check.started', ...decodeTurnIdentity(value), check: requiredString(value.check, 'check'), requirement: requiredEnum(value.requirement, CHECK_REQUIREMENTS, 'requirement'), timeoutMs: positiveInteger(value.timeoutMs, 'timeoutMs') });
  },
  'check.ended': (value) => {
    exact(value, ['type', ...TURN_KEYS, 'check', 'result']);
    const check = requiredString(value.check, 'check');
    const result = decodeOwnedAgentCheckResult(requiredObject(value.result, 'result'));
    if (result.id !== check) throw malformed('check id does not match result id');
    return Object.freeze({ type: 'check.ended', ...decodeTurnIdentity(value), check, result });
  }
} satisfies AgentEventDecoderMap;

const AGENT_EVENT_TYPES = Object.freeze(Object.keys(AGENT_EVENT_DECODERS)) as readonly AgentEvent['type'][];
const TURN_KEYS = ['turnIndex', 'turnId', 'requestAttempt'] as const;
const TOOL_CALL_KEYS = [...TURN_KEYS, 'toolBatchId', 'callIndex', 'callId'] as const;
const TOOL_ATTEMPT_KEYS = [...TOOL_CALL_KEYS, 'toolAttempt'] as const;
const REPLAY_KEYS = ['sessionId', 'replayedLedgers', 'replayedTurns', 'replayedSessionEntries', 'replayedCheckpoints', 'replayedToolResults', 'replayedEvidenceRecords', 'restoredProviderState', 'restoredProviderStateRef'] as const;
const RUN_PHASES = ['preparing', 'requesting_model', 'executing_tools', 'waiting_for_approval', 'verifying', 'finalizing', 'ended'] as const;
const RETRY_KINDS = ['transport', 'provider_request', 'agent_turn'] as const;
const TOOL_CALL_TYPES = ['function', 'custom'] as const;
const AUTHORIZATION_DECISIONS = ['allow', 'deny', 'require_approval'] as const;
const APPROVAL_DECISIONS = ['allow', 'deny'] as const;
const CHECK_REQUIREMENTS = ['required', 'advisory'] as const;
const PRICING_STATUSES = ['known', 'partial', 'unknown'] as const;
const BUDGET_PRESSURES = ['normal', 'constrained', 'critical', 'exhausted'] as const;
const TERMINATION_REASONS = ['stop', 'tool_calls', 'output_limit', 'content_filter', 'unknown'] as const;
const HISTORY_REDUCTION_KINDS = ['tool_result_reduced', 'checkpoint_installed', 'image_content_removed'] as const;
const HISTORY_REASONS = ['unsupported_modality', 'image_count_limit', 'image_byte_limit', 'image_token_limit'] as const;

function decodeTurnIdentity(value: JsonObject): AgentTurnIdentity {
  return Object.freeze({ turnIndex: positiveInteger(value.turnIndex, 'turnIndex'), turnId: requiredString(value.turnId, 'turnId'), requestAttempt: positiveInteger(value.requestAttempt, 'requestAttempt') });
}
function decodeToolCallIdentity(value: JsonObject): AgentToolCallIdentity {
  const callId = optionalStringValue(value.callId, 'callId');
  return Object.freeze({ ...decodeTurnIdentity(value), toolBatchId: requiredString(value.toolBatchId, 'toolBatchId'), callIndex: nonnegativeInteger(value.callIndex, 'callIndex'), ...(callId !== undefined ? { callId } : {}) });
}
function decodeToolAttemptIdentity(value: JsonObject): AgentToolCallAttemptIdentity {
  return Object.freeze({ ...decodeToolCallIdentity(value), toolAttempt: positiveInteger(value.toolAttempt, 'toolAttempt') });
}
function decodeReplayPayload(value: JsonObject): AgentReplayPayload {
  const restoredProviderState = value.restoredProviderState === undefined ? undefined : decodeProviderStateSummary(value.restoredProviderState);
  const restoredProviderStateRef = optionalArtifactRef(value.restoredProviderStateRef);
  return Object.freeze({
    sessionId: requiredString(value.sessionId, 'sessionId'), replayedLedgers: nonnegativeInteger(value.replayedLedgers, 'replayedLedgers'),
    replayedTurns: nonnegativeInteger(value.replayedTurns, 'replayedTurns'), replayedSessionEntries: nonnegativeInteger(value.replayedSessionEntries, 'replayedSessionEntries'),
    replayedCheckpoints: nonnegativeInteger(value.replayedCheckpoints, 'replayedCheckpoints'), replayedToolResults: nonnegativeInteger(value.replayedToolResults, 'replayedToolResults'),
    replayedEvidenceRecords: nonnegativeInteger(value.replayedEvidenceRecords, 'replayedEvidenceRecords'),
    ...(restoredProviderState ? { restoredProviderState } : {}), ...(restoredProviderStateRef ? { restoredProviderStateRef } : {})
  });
}
function decodeRunBudget(value: JsonValue | undefined): AgentRunBudgetState {
  const object = requiredObject(value, 'budget');
  exact(object, ['modelTurns', 'totalToolCalls', 'repeatedIdenticalToolCalls', 'elapsedMs', 'promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'knownCosts', 'pricingStatus', 'unknownPricedTokens', 'consecutiveProviderFailures', 'consecutiveToolFailures', 'providerRetries']);
  return Object.freeze({
    modelTurns: nonnegativeInteger(object.modelTurns, 'budget.modelTurns'), totalToolCalls: nonnegativeInteger(object.totalToolCalls, 'budget.totalToolCalls'),
    repeatedIdenticalToolCalls: nonnegativeInteger(object.repeatedIdenticalToolCalls, 'budget.repeatedIdenticalToolCalls'), elapsedMs: nonnegativeInteger(object.elapsedMs, 'budget.elapsedMs'),
    promptTokens: nonnegativeInteger(object.promptTokens, 'budget.promptTokens'), completionTokens: nonnegativeInteger(object.completionTokens, 'budget.completionTokens'),
    cacheReadTokens: nonnegativeInteger(object.cacheReadTokens, 'budget.cacheReadTokens'), cacheWriteTokens: nonnegativeInteger(object.cacheWriteTokens, 'budget.cacheWriteTokens'),
    reasoningTokens: nonnegativeInteger(object.reasoningTokens, 'budget.reasoningTokens'), knownCosts: nonnegativeNumberRecord(object.knownCosts, 'budget.knownCosts'),
    pricingStatus: requiredEnum(object.pricingStatus, PRICING_STATUSES, 'budget.pricingStatus'), unknownPricedTokens: nonnegativeInteger(object.unknownPricedTokens, 'budget.unknownPricedTokens'),
    consecutiveProviderFailures: nonnegativeInteger(object.consecutiveProviderFailures, 'budget.consecutiveProviderFailures'), consecutiveToolFailures: nonnegativeInteger(object.consecutiveToolFailures, 'budget.consecutiveToolFailures'),
    providerRetries: nonnegativeInteger(object.providerRetries, 'budget.providerRetries')
  });
}
function decodeRunConfiguration(value: JsonValue | undefined): AgentRunConfiguration {
  const object = requiredObject(value, 'configuration');
  exact(object, ['provider', 'model', 'tools', 'toolPolicy', 'authority', 'requestWindow', 'runtime']);
  const provider = requiredObject(object.provider, 'configuration.provider');
  exact(provider, ['id', 'displayName']);
  const model = requiredObject(object.model, 'configuration.model');
  exact(model, ['id', 'provider', 'displayName', 'limits', 'modalities', 'capabilities', 'supportedParameters']);
  const authority = requiredObject(object.authority, 'configuration.authority');
  exact(authority, ['ambientShell', 'summary']);
  const requestWindow = requiredObject(object.requestWindow, 'configuration.requestWindow');
  exact(requestWindow, ['contextWindowTokens', 'maxOutputTokens', 'maxPromptTokens', 'requestedMaxOutputTokens']);
  const runtime = requiredObject(object.runtime, 'configuration.runtime');
  exact(runtime, ['temperature', 'reasoning', 'metadataKeys']);
  const displayName = optionalStringValue(model.displayName, 'configuration.model.displayName');
  const temperature = optionalFiniteNumber(runtime.temperature, 'configuration.runtime.temperature');
  const reasoning = runtime.reasoning === undefined ? undefined : parseModelReasoningRequest(runtime.reasoning);
  const requestedMaxOutputTokens = optionalPositiveInteger(requestWindow.requestedMaxOutputTokens, 'configuration.requestWindow.requestedMaxOutputTokens');
  return Object.freeze({
    provider: Object.freeze({ id: requiredString(provider.id, 'configuration.provider.id'), displayName: requiredString(provider.displayName, 'configuration.provider.displayName') }),
    model: Object.freeze({
      id: requiredString(model.id, 'configuration.model.id'), provider: requiredString(model.provider, 'configuration.model.provider'), ...(displayName !== undefined ? { displayName } : {}),
      limits: decodeOwnedModelLimits(model.limits), modalities: decodeOwnedModelModalities(model.modalities), capabilities: decodeOwnedModelCapabilities(model.capabilities),
      supportedParameters: stringArray(model.supportedParameters, 'configuration.model.supportedParameters')
    }),
    tools: Object.freeze(requiredArray(object.tools, 'configuration.tools').map((item, index) => {
      const tool = requiredObject(item, `configuration.tools[${String(index)}]`);
      exact(tool, ['name', 'accessModes']);
      return Object.freeze({ name: requiredString(tool.name, `configuration.tools[${String(index)}].name`), accessModes: stringArray(tool.accessModes, `configuration.tools[${String(index)}].accessModes`) });
    })),
    toolPolicy: decodeOwnedToolPolicy(requiredObject(object.toolPolicy, 'configuration.toolPolicy')),
    authority: Object.freeze({ ambientShell: requiredBoolean(authority.ambientShell, 'configuration.authority.ambientShell'), summary: requiredStringValue(authority.summary, 'configuration.authority.summary') }),
    requestWindow: Object.freeze({
      contextWindowTokens: positiveInteger(requestWindow.contextWindowTokens, 'configuration.requestWindow.contextWindowTokens'),
      maxOutputTokens: positiveInteger(requestWindow.maxOutputTokens, 'configuration.requestWindow.maxOutputTokens'),
      maxPromptTokens: positiveInteger(requestWindow.maxPromptTokens, 'configuration.requestWindow.maxPromptTokens'),
      ...(requestedMaxOutputTokens !== undefined ? { requestedMaxOutputTokens } : {})
    }),
    runtime: Object.freeze({ ...(temperature !== undefined ? { temperature } : {}), ...(reasoning ? { reasoning } : {}), metadataKeys: stringArray(runtime.metadataKeys, 'configuration.runtime.metadataKeys') })
  });
}
 function decodeTurnSnapshot(value: JsonValue | undefined): AgentTurnSnapshotRecord {
  const object = requiredObject(value, 'snapshot');
  exact(object, ['turnIndex', 'turnId', 'requestAttempt', 'provider', 'model', 'profileHash', 'continuationEligible', 'temperature', 'reasoning', 'responseFormat', 'toolNames', 'toolPolicyHash', 'instructions', 'configuredContextSourceIds', 'checkIds', 'limits', 'budget']);
  const temperature = optionalFiniteNumber(object.temperature, 'snapshot.temperature');
  const reasoning = object.reasoning === undefined ? undefined : parseModelReasoningRequest(object.reasoning);
  const responseFormat = object.responseFormat === undefined ? undefined : decodeOwnedModelResponseFormat(object.responseFormat);
  return Object.freeze({
    ...decodeTurnIdentity(object), provider: requiredString(object.provider, 'snapshot.provider'), model: requiredString(object.model, 'snapshot.model'),
    profileHash: requiredString(object.profileHash, 'snapshot.profileHash'), continuationEligible: requiredBoolean(object.continuationEligible, 'snapshot.continuationEligible'),
    ...(temperature !== undefined ? { temperature } : {}), ...(reasoning ? { reasoning } : {}), ...(responseFormat ? { responseFormat } : {}),
    toolNames: stringArray(object.toolNames, 'snapshot.toolNames'), toolPolicyHash: requiredString(object.toolPolicyHash, 'snapshot.toolPolicyHash'),
    instructions: Object.freeze(requiredArray(object.instructions, 'snapshot.instructions').map((item, index) => decodeInstruction(item, `snapshot.instructions[${String(index)}]`))),
    configuredContextSourceIds: stringArray(object.configuredContextSourceIds, 'snapshot.configuredContextSourceIds'), checkIds: stringArray(object.checkIds, 'snapshot.checkIds'),
    limits: decodeRunLimits(object.limits), budget: decodeRunBudget(object.budget)
  });
}
function decodeInstruction(value: JsonValue, path: string): AgentEffectiveInstruction {
  const object = requiredObject(value, path);
  exact(object, ['id', 'content', 'provenance', 'role', 'sourceUri', 'priority']);
  const role = optionalStringValue(object.role, `${path}.role`);
  const sourceUri = optionalStringValue(object.sourceUri, `${path}.sourceUri`);
  const priority = optionalFiniteNumber(object.priority, `${path}.priority`);
  return Object.freeze({
    id: requiredString(object.id, `${path}.id`), content: requiredStringValue(object.content, `${path}.content`),
    provenance: requiredEnum(object.provenance, ['application', 'run', 'steering'] as const, `${path}.provenance`),
    ...(role !== undefined ? { role } : {}), ...(sourceUri !== undefined ? { sourceUri } : {}), ...(priority !== undefined ? { priority } : {})
  });
}
 function decodeRunLimits(value: JsonValue | undefined): AgentRunLimits {
  const object = requiredObject(value, 'limits');
  exact(object, ['maxConcurrentToolCalls', 'modelTurns', 'totalToolCalls', 'repeatedIdenticalToolCalls', 'elapsedMs', 'promptTokens', 'completionTokens', 'activeImageCount', 'activeImageBytes', 'activeImageTokens', 'knownCost', 'consecutiveProviderFailures', 'consecutiveToolFailures', 'providerRetries']);
  const knownCost = requiredObject(object.knownCost, 'limits.knownCost');
  exact(knownCost, ['amount', 'currency']);
  return Object.freeze({
    maxConcurrentToolCalls: positiveInteger(object.maxConcurrentToolCalls, 'limits.maxConcurrentToolCalls'), modelTurns: positiveInteger(object.modelTurns, 'limits.modelTurns'),
    totalToolCalls: positiveInteger(object.totalToolCalls, 'limits.totalToolCalls'), repeatedIdenticalToolCalls: positiveInteger(object.repeatedIdenticalToolCalls, 'limits.repeatedIdenticalToolCalls'),
    elapsedMs: positiveInteger(object.elapsedMs, 'limits.elapsedMs'), promptTokens: positiveInteger(object.promptTokens, 'limits.promptTokens'),
    completionTokens: positiveInteger(object.completionTokens, 'limits.completionTokens'), activeImageCount: positiveInteger(object.activeImageCount, 'limits.activeImageCount'),
    activeImageBytes: positiveInteger(object.activeImageBytes, 'limits.activeImageBytes'), activeImageTokens: positiveInteger(object.activeImageTokens, 'limits.activeImageTokens'),
    knownCost: Object.freeze({ amount: positiveNumber(knownCost.amount, 'limits.knownCost.amount'), currency: requiredString(knownCost.currency, 'limits.knownCost.currency') }),
    consecutiveProviderFailures: positiveInteger(object.consecutiveProviderFailures, 'limits.consecutiveProviderFailures'), consecutiveToolFailures: positiveInteger(object.consecutiveToolFailures, 'limits.consecutiveToolFailures'),
    providerRetries: positiveInteger(object.providerRetries, 'limits.providerRetries')
  });
}
function decodeRequestSnapshot(value: JsonValue | undefined): AgentRequestSnapshotRecord {
  const object = requiredObject(value, 'snapshot');
  exact(object, [...TURN_KEYS, 'requestId', 'configuredContextIds', 'providerContextIds', 'runContextIds', 'effectiveInstructionHash', 'selectedEvidenceHash', 'retainedHistoryHash', 'modelToolSchemasHash', 'compiledPromptHash', 'reductions']);
  return Object.freeze({
    ...decodeTurnIdentity(object), requestId: requiredString(object.requestId, 'snapshot.requestId'), configuredContextIds: stringArray(object.configuredContextIds, 'snapshot.configuredContextIds'),
    providerContextIds: stringArray(object.providerContextIds, 'snapshot.providerContextIds'), runContextIds: stringArray(object.runContextIds, 'snapshot.runContextIds'),
    effectiveInstructionHash: requiredString(object.effectiveInstructionHash, 'snapshot.effectiveInstructionHash'), selectedEvidenceHash: requiredString(object.selectedEvidenceHash, 'snapshot.selectedEvidenceHash'),
    retainedHistoryHash: requiredString(object.retainedHistoryHash, 'snapshot.retainedHistoryHash'), modelToolSchemasHash: requiredString(object.modelToolSchemasHash, 'snapshot.modelToolSchemasHash'),
    compiledPromptHash: requiredString(object.compiledPromptHash, 'snapshot.compiledPromptHash'),
    reductions: Object.freeze(requiredArray(object.reductions, 'snapshot.reductions').map((item, index) => {
      const reduction = requiredObject(item, `snapshot.reductions[${String(index)}]`);
      exact(reduction, ['kind', 'reason', 'sequence']);
      return Object.freeze({ kind: requiredString(reduction.kind, 'reduction.kind'), reason: requiredStringValue(reduction.reason, 'reduction.reason'), sequence: nonnegativeInteger(reduction.sequence, 'reduction.sequence') });
    }))
  });
}
function decodeProviderStateSummary(value: JsonValue | undefined): AgentProviderStateSummary {
  const object = requiredObject(value, 'providerState');
  exact(object, ['provider', 'model', 'kind', 'dataKeys', 'bytes']);
  return Object.freeze({ provider: requiredString(object.provider, 'providerState.provider'), model: requiredString(object.model, 'providerState.model'), kind: requiredString(object.kind, 'providerState.kind'), dataKeys: stringArray(object.dataKeys, 'providerState.dataKeys'), bytes: nonnegativeInteger(object.bytes, 'providerState.bytes') });
}
function decodeModelRequestSummary(value: JsonValue | undefined): AgentModelRequestSummary {
  const object = requiredObject(value, 'request');
  exact(object, ['model', 'messageCount', 'messageRoleCounts', 'messageBytes', 'toolCount', 'toolNames', 'toolSchemaBytes', 'maxOutputTokens', 'temperature', 'topP', 'reasoning', 'metadataKeys', 'providerOptionKeys']);
  const maxOutputTokens = optionalPositiveInteger(object.maxOutputTokens, 'request.maxOutputTokens');
  const temperature = optionalFiniteNumber(object.temperature, 'request.temperature');
  const topP = optionalFiniteNumber(object.topP, 'request.topP');
  const reasoning = object.reasoning === undefined ? undefined : parseModelReasoningRequest(object.reasoning);
  return Object.freeze({
    model: requiredString(object.model, 'request.model'), messageCount: nonnegativeInteger(object.messageCount, 'request.messageCount'), messageRoleCounts: nonnegativeNumberRecord(object.messageRoleCounts, 'request.messageRoleCounts'),
    messageBytes: nonnegativeInteger(object.messageBytes, 'request.messageBytes'), toolCount: nonnegativeInteger(object.toolCount, 'request.toolCount'), toolNames: stringArray(object.toolNames, 'request.toolNames'),
    toolSchemaBytes: nonnegativeInteger(object.toolSchemaBytes, 'request.toolSchemaBytes'), ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}), ...(reasoning ? { reasoning } : {}), metadataKeys: stringArray(object.metadataKeys, 'request.metadataKeys'), providerOptionKeys: stringArray(object.providerOptionKeys, 'request.providerOptionKeys')
  });
}
function decodeModelResponseSummary(value: JsonValue | undefined): AgentModelResponseSummary {
  const object = requiredObject(value, 'response');
  exact(object, ['provider', 'model', 'contentChars', 'contentBytes', 'toolCallCount', 'toolCallNames', 'requestId', 'transport', 'usage', 'terminationReason', 'providerTerminationReason', 'reasoningSummaryChars', 'rawBytes', 'providerState', 'providerStateRef']);
  const requestId = optionalStringValue(object.requestId, 'response.requestId');
  const transport = object.transport === undefined ? undefined : decodeOwnedModelTransport(object.transport, object.provider);
  const usage = object.usage === undefined ? undefined : parseModelUsage(object.usage);
  const providerTerminationReason = optionalStringValue(object.providerTerminationReason, 'response.providerTerminationReason');
  const providerState = object.providerState === undefined ? undefined : decodeProviderStateSummary(object.providerState);
  const providerStateRef = optionalArtifactRef(object.providerStateRef);
  return Object.freeze({
    provider: requiredString(object.provider, 'response.provider'), model: requiredString(object.model, 'response.model'), contentChars: nonnegativeInteger(object.contentChars, 'response.contentChars'),
    contentBytes: nonnegativeInteger(object.contentBytes, 'response.contentBytes'), toolCallCount: nonnegativeInteger(object.toolCallCount, 'response.toolCallCount'), toolCallNames: stringArray(object.toolCallNames, 'response.toolCallNames'),
    ...(requestId !== undefined ? { requestId } : {}), ...(transport ? { transport } : {}), ...(usage ? { usage } : {}),
    terminationReason: requiredEnum(object.terminationReason, TERMINATION_REASONS, 'response.terminationReason'), ...(providerTerminationReason !== undefined ? { providerTerminationReason } : {}),
    ...optionalNonnegativeFields(object, ['reasoningSummaryChars', 'rawBytes']), ...(providerState ? { providerState } : {}), ...(providerStateRef ? { providerStateRef } : {})
  });
}
  function decodeRequestCostEstimate(value: JsonValue | undefined): RequestCostEstimate {
  const object = requiredObject(value, 'estimate');
  exact(object, ['messageTokens', 'contextHistoryTokens', 'contextTokens', 'evidenceTokens', 'toolSchemaTokens', 'outputReserveTokens', 'totalPromptTokens', 'totalRequestTokens', 'warnings']);
  return Object.freeze({
    messageTokens: nonnegativeInteger(object.messageTokens, 'estimate.messageTokens'), contextHistoryTokens: nonnegativeInteger(object.contextHistoryTokens, 'estimate.contextHistoryTokens'),
    contextTokens: nonnegativeInteger(object.contextTokens, 'estimate.contextTokens'), evidenceTokens: nonnegativeInteger(object.evidenceTokens, 'estimate.evidenceTokens'),
    toolSchemaTokens: nonnegativeInteger(object.toolSchemaTokens, 'estimate.toolSchemaTokens'), outputReserveTokens: nonnegativeInteger(object.outputReserveTokens, 'estimate.outputReserveTokens'),
    totalPromptTokens: nonnegativeInteger(object.totalPromptTokens, 'estimate.totalPromptTokens'), totalRequestTokens: nonnegativeInteger(object.totalRequestTokens, 'estimate.totalRequestTokens'), warnings: stringArray(object.warnings, 'estimate.warnings')
  });
}
function decodeBudgetSnapshot(value: JsonValue | undefined): BudgetAccountantSnapshot {
  const object = requiredObject(value, 'snapshot');
  exact(object, ['estimatedPromptTokens', 'providerPromptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'remainingPromptTokens', 'pressure', 'lastEstimate', 'lastProviderUsage', 'estimateToActualRatio']);
  const lastEstimate = object.lastEstimate === undefined ? undefined : decodeRequestCostEstimate(object.lastEstimate);
  const lastProviderUsage = object.lastProviderUsage === undefined ? undefined : decodeProviderUsage(object.lastProviderUsage);
  const estimateToActualRatio = optionalNonnegativeNumber(object.estimateToActualRatio, 'snapshot.estimateToActualRatio');
  return Object.freeze({
    estimatedPromptTokens: nonnegativeInteger(object.estimatedPromptTokens, 'snapshot.estimatedPromptTokens'), providerPromptTokens: nonnegativeInteger(object.providerPromptTokens, 'snapshot.providerPromptTokens'),
    completionTokens: nonnegativeInteger(object.completionTokens, 'snapshot.completionTokens'), cacheReadTokens: nonnegativeInteger(object.cacheReadTokens, 'snapshot.cacheReadTokens'),
    cacheWriteTokens: nonnegativeInteger(object.cacheWriteTokens, 'snapshot.cacheWriteTokens'), reasoningTokens: nonnegativeInteger(object.reasoningTokens, 'snapshot.reasoningTokens'),
    totalTokens: nonnegativeInteger(object.totalTokens, 'snapshot.totalTokens'), remainingPromptTokens: nonnegativeInteger(object.remainingPromptTokens, 'snapshot.remainingPromptTokens'),
    pressure: requiredEnum(object.pressure, BUDGET_PRESSURES, 'snapshot.pressure'), ...(lastEstimate ? { lastEstimate } : {}), ...(lastProviderUsage ? { lastProviderUsage } : {}),
    ...(estimateToActualRatio !== undefined ? { estimateToActualRatio } : {})
  });
}
function decodeProviderUsage(value: JsonValue): NonNullable<BudgetAccountantSnapshot['lastProviderUsage']> {
  const object = requiredObject(value, 'lastProviderUsage');
  exact(object, ['promptTokens', 'completionTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'source']);
  if (object.source !== 'provider') throw malformed('lastProviderUsage.source is invalid');
  const usage = parseModelUsage(object);
  if (usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined || usage.reasoningTokens === undefined) throw malformed('lastProviderUsage must include all provider token counters');
  return Object.freeze({ ...usage, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, reasoningTokens: usage.reasoningTokens, source: 'provider' });
}
function decodeOverflowResult(value: JsonValue | undefined): OverflowRecoveryResult {
  const object = requiredObject(value, 'result');
  if (object.kind === 'retry') { exact(object, ['kind', 'action']); return Object.freeze({ kind: 'retry', action: decodeOverflowAction(object.action, 'result.action') }); }
  if (object.kind === 'diagnostic') { exact(object, ['kind', 'diagnostic']); return Object.freeze({ kind: 'diagnostic', diagnostic: decodeOverflowDiagnostic(object.diagnostic) }); }
  throw malformed('result.kind is invalid');
}
function decodeOverflowAction(value: JsonValue | undefined, path: string): Extract<OverflowRecoveryResult, { kind: 'retry' }>['action'] {
  const object = requiredObject(value, path);
  if (object.kind === 'reduce_context_history') { exact(object, ['kind', 'reductions']); return Object.freeze({ kind: object.kind, reductions: positiveInteger(object.reductions, `${path}.reductions`) }); }
  if (object.kind === 'reduce_context') { exact(object, ['kind', 'removedItems']); return Object.freeze({ kind: object.kind, removedItems: positiveInteger(object.removedItems, `${path}.removedItems`) }); }
  if (object.kind === 'reduce_evidence') { exact(object, ['kind', 'removedRecords']); return Object.freeze({ kind: object.kind, removedRecords: positiveInteger(object.removedRecords, `${path}.removedRecords`) }); }
  if (object.kind === 'install_checkpoint') { exact(object, ['kind', 'compactedToolResults']); return Object.freeze({ kind: object.kind, compactedToolResults: positiveInteger(object.compactedToolResults, `${path}.compactedToolResults`) }); }
  if (object.kind === 'diagnostic_failure') { exact(object, ['kind', 'diagnostic']); return Object.freeze({ kind: object.kind, diagnostic: decodeOverflowDiagnostic(object.diagnostic) }); }
  throw malformed(`${path}.kind is invalid`);
}
function decodeOverflowDiagnostic(value: JsonValue | undefined): Extract<OverflowRecoveryResult, { kind: 'diagnostic' }>['diagnostic'] {
  const object = requiredObject(value, 'overflow diagnostic');
  exact(object, ['reason', 'messageTokens', 'contextHistoryTokens', 'contextTokens', 'evidenceTokens', 'toolSchemaTokens', 'outputReserveTokens', 'totalRequestTokens', 'reductionsAttempted']);
  return Object.freeze({
    reason: requiredEnum(object.reason, ['model_context_window', 'tool_schema_cost'] as const, 'diagnostic.reason'),
    messageTokens: nonnegativeInteger(object.messageTokens, 'diagnostic.messageTokens'), contextHistoryTokens: nonnegativeInteger(object.contextHistoryTokens, 'diagnostic.contextHistoryTokens'),
    contextTokens: nonnegativeInteger(object.contextTokens, 'diagnostic.contextTokens'), evidenceTokens: nonnegativeInteger(object.evidenceTokens, 'diagnostic.evidenceTokens'),
    toolSchemaTokens: nonnegativeInteger(object.toolSchemaTokens, 'diagnostic.toolSchemaTokens'), outputReserveTokens: nonnegativeInteger(object.outputReserveTokens, 'diagnostic.outputReserveTokens'),
    totalRequestTokens: nonnegativeInteger(object.totalRequestTokens, 'diagnostic.totalRequestTokens'),
    reductionsAttempted: Object.freeze(requiredArray(object.reductionsAttempted, 'diagnostic.reductionsAttempted').map((item, index) => decodeOverflowAction(item, `diagnostic.reductionsAttempted[${String(index)}]`)))
  });
}
function decodeHistoryReduction(value: JsonValue, path: string): ContextHistoryReduction {
  const object = requiredObject(value, path);
  exact(object, ['itemId', 'kind', 'beforeBytes', 'afterBytes', 'toolName', 'removedItems', 'removedImageBytes', 'removedImageTokens', 'reason']);
  const toolName = optionalStringValue(object.toolName, `${path}.toolName`);
  const reason = object.reason === undefined ? undefined : requiredEnum(object.reason, HISTORY_REASONS, `${path}.reason`);
  return Object.freeze({
    itemId: requiredString(object.itemId, `${path}.itemId`), kind: requiredEnum(object.kind, HISTORY_REDUCTION_KINDS, `${path}.kind`),
    beforeBytes: nonnegativeInteger(object.beforeBytes, `${path}.beforeBytes`), afterBytes: nonnegativeInteger(object.afterBytes, `${path}.afterBytes`),
    ...(toolName !== undefined ? { toolName } : {}), ...optionalNonnegativeFields(object, ['removedItems', 'removedImageBytes', 'removedImageTokens']), ...(reason ? { reason } : {})
  });
}
function decodeContextBundle(value: JsonValue | undefined): ContextBundle {
  const object = requiredObject(value, 'bundle');
  exact(object, ['items', 'totalTokens', 'omitted']);
  return Object.freeze({
    items: requiredArray(object.items, 'bundle.items').map((item, index) => decodeContextItem(item, `bundle.items[${String(index)}]`)),
    totalTokens: nonnegativeInteger(object.totalTokens, 'bundle.totalTokens'),
    omitted: requiredArray(object.omitted, 'bundle.omitted').map((item, index) => {
      const omission = requiredObject(item, `bundle.omitted[${String(index)}]`);
      exact(omission, ['reason', 'sourceUri']);
      const sourceUri = optionalStringValue(omission.sourceUri, 'omission.sourceUri');
      return Object.freeze({ reason: requiredStringValue(omission.reason, 'omission.reason'), ...(sourceUri !== undefined ? { sourceUri } : {}) });
    })
  });
}
function decodeContextItem(value: JsonValue, path: string): ContextBundle['items'][number] {
  const object = requiredObject(value, path);
  exact(object, ['id', 'sourceUri', 'sourceKind', 'confidence', 'representation', 'mediaType', 'title', 'content', 'range', 'tokenEstimate', 'selectionReason', 'score']);
  const confidence = object.confidence === undefined ? undefined : requiredEnum(object.confidence, ['unverified', 'verified'] as const, `${path}.confidence`);
  const range = object.range === undefined ? undefined : decodeRange(object.range, `${path}.range`);
  return Object.freeze({
    id: requiredString(object.id, `${path}.id`), sourceUri: requiredString(object.sourceUri, `${path}.sourceUri`),
    sourceKind: requiredEnum(object.sourceKind, ['user', 'external', 'session', 'tool-observation', 'generated'] as const, `${path}.sourceKind`),
    ...(confidence ? { confidence } : {}), representation: requiredEnum(object.representation, ['full', 'excerpt', 'summary'] as const, `${path}.representation`),
    mediaType: requiredString(object.mediaType, `${path}.mediaType`), title: requiredStringValue(object.title, `${path}.title`), content: requiredStringValue(object.content, `${path}.content`),
    ...(range ? { range } : {}), tokenEstimate: nonnegativeInteger(object.tokenEstimate, `${path}.tokenEstimate`), selectionReason: requiredStringValue(object.selectionReason, `${path}.selectionReason`), score: finiteNumber(object.score, `${path}.score`)
  });
}
function decodeRange(value: JsonValue, path: string): { kind: 'line' | 'byte'; start?: number; end?: number } {
  const object = requiredObject(value, path);
  exact(object, ['kind', 'start', 'end']);
  const start = optionalNonnegativeNumber(object.start, `${path}.start`);
  const end = optionalNonnegativeNumber(object.end, `${path}.end`);
  return Object.freeze({ kind: requiredEnum(object.kind, ['line', 'byte'] as const, `${path}.kind`), ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) });
}
function decodePromptProjection(value: JsonValue | undefined): PromptProjection {
  const object = requiredObject(value, 'projection');
  exact(object, ['id', 'task', 'instructions', 'notes', 'context', 'tools', 'continuity', 'evidence', 'outputContract', 'metadata']);
  const evidence = object.evidence === undefined ? undefined : decodePromptEvidence(object.evidence);
  const outputContract = object.outputContract === undefined ? undefined : decodeOutputContract(object.outputContract);
  const metadata = optionalStringRecord(object.metadata, 'projection.metadata');
  return Object.freeze({
    id: requiredString(object.id, 'projection.id'), task: requiredStringValue(object.task, 'projection.task'),
    instructions: requiredArray(object.instructions, 'projection.instructions').map((item, index) => decodePromptInstruction(item, `projection.instructions[${String(index)}]`)),
    notes: [...stringArray(object.notes, 'projection.notes')], context: requiredArray(object.context, 'projection.context').map((item, index) => decodeContextItem(item, `projection.context[${String(index)}]`)),
    tools: requiredArray(object.tools, 'projection.tools').map((item, index) => decodePromptTool(item, `projection.tools[${String(index)}]`)),
    continuity: [...stringArray(object.continuity, 'projection.continuity')], ...(evidence ? { evidence } : {}), ...(outputContract ? { outputContract } : {}), ...(metadata ? { metadata: { ...metadata } } : {})
  });
}
function decodePromptInstruction(value: JsonValue, path: string): PromptProjection['instructions'][number] {
  const object = requiredObject(value, path);
  exact(object, ['id', 'role', 'content', 'sourceUri', 'priority']);
  const sourceUri = optionalStringValue(object.sourceUri, `${path}.sourceUri`);
  return Object.freeze({ id: requiredString(object.id, `${path}.id`), role: requiredEnum(object.role, ['system', 'developer', 'workspace', 'user'] as const, `${path}.role`), content: requiredStringValue(object.content, `${path}.content`), ...(sourceUri !== undefined ? { sourceUri } : {}), priority: finiteNumber(object.priority, `${path}.priority`) });
}
function decodePromptTool(value: JsonValue, path: string): PromptProjection['tools'][number] {
  const object = requiredObject(value, path);
  exact(object, ['name', 'description', 'inputFormat', 'accessModes', 'promptGuide']);
  const promptGuide = optionalStringValue(object.promptGuide, `${path}.promptGuide`);
  return Object.freeze({ name: requiredString(object.name, `${path}.name`), description: requiredStringValue(object.description, `${path}.description`), inputFormat: requiredString(object.inputFormat, `${path}.inputFormat`), accessModes: [...stringArray(object.accessModes, `${path}.accessModes`)], ...(promptGuide !== undefined ? { promptGuide } : {}) });
}
function decodePromptEvidence(value: JsonValue): NonNullable<PromptProjection['evidence']> {
  const object = requiredObject(value, 'projection.evidence');
  exact(object, ['records', 'omittedRecords', 'omittedSummary', 'tokenEstimate', 'coverage']);
  const omittedSummary = object.omittedSummary === undefined ? undefined : requiredArray(object.omittedSummary, 'projection.evidence.omittedSummary').map((item, index) => {
    const summary = requiredObject(item, `omittedSummary[${String(index)}]`);
    exact(summary, ['toolName', 'action', 'outcome', 'count']);
    return Object.freeze({ toolName: requiredString(summary.toolName, 'omittedSummary.toolName'), action: requiredEnum(summary.action, ['list', 'search', 'read', 'execute', 'create', 'update', 'delete', 'move', 'verify'] as const, 'omittedSummary.action'), outcome: requiredEnum(summary.outcome, ['success', 'failure'] as const, 'omittedSummary.outcome'), count: positiveInteger(summary.count, 'omittedSummary.count') });
  });
  return Object.freeze({
    records: requiredArray(object.records, 'projection.evidence.records').map((item, index) => decodeOwnedEvidenceRecord(requiredObject(item, `projection.evidence.records[${String(index)}]`))),
    omittedRecords: nonnegativeInteger(object.omittedRecords, 'projection.evidence.omittedRecords'), ...(omittedSummary ? { omittedSummary } : {}),
    tokenEstimate: nonnegativeInteger(object.tokenEstimate, 'projection.evidence.tokenEstimate'), coverage: requiredEnum(object.coverage, ['complete', 'partial'] as const, 'projection.evidence.coverage')
  });
}
function decodeOutputContract(value: JsonValue): NonNullable<PromptProjection['outputContract']> {
  const object = requiredObject(value, 'projection.outputContract');
  exact(object, ['kind', 'description']);
  if (object.kind !== 'text') throw malformed('projection.outputContract.kind is invalid');
  return Object.freeze({ kind: 'text', description: requiredStringValue(object.description, 'projection.outputContract.description') });
}
 function optionalArtifactRef(value: JsonValue | undefined): ArtifactRef | undefined { return value === undefined ? undefined : decodeOwnedArtifactRef(requiredObject(value, 'artifact')); }
function decodeDiagnostic(value: JsonValue | undefined, allowTurnIndex = false): ModelProviderErrorDiagnostic & { readonly turnIndex?: number } {
  const object = requiredObject(value, 'diagnostic');
  exact(object, ['provider', 'code', 'retryable', 'transport', 'eventType', 'causeSummary', ...(allowTurnIndex ? ['turnIndex'] : [])]);
  const transport = optionalStringValue(object.transport, 'diagnostic.transport');
  const eventType = optionalStringValue(object.eventType, 'diagnostic.eventType');
  const causeSummary = object.causeSummary === undefined ? undefined : primitiveRecord(object.causeSummary, 'diagnostic.causeSummary');
  const turnIndex = allowTurnIndex ? optionalPositiveInteger(object.turnIndex, 'diagnostic.turnIndex') : undefined;
  return Object.freeze({
    provider: requiredString(object.provider, 'diagnostic.provider'), code: requiredEnum(object.code, ['provider_unavailable', 'model_unavailable', 'invalid_request', 'context_overflow', 'rate_limited', 'malformed_response', 'aborted', 'unknown'] as const, 'diagnostic.code'),
    retryable: requiredBoolean(object.retryable, 'diagnostic.retryable'), ...(transport !== undefined ? { transport } : {}), ...(eventType !== undefined ? { eventType } : {}),
    ...(causeSummary ? { causeSummary } : {}), ...(turnIndex !== undefined ? { turnIndex } : {})
  });
}
function optionalDiagnostic(value: JsonValue | undefined, allowTurnIndex = false): (ModelProviderErrorDiagnostic & { readonly turnIndex?: number }) | undefined { return value === undefined ? undefined : decodeDiagnostic(value, allowTurnIndex); }
function decodeDeliveryDiagnostic(value: JsonValue | undefined): AgentDeliveryDiagnostic {
  const object = requiredObject(value, 'diagnostic');
  exact(object, ['eventType', 'message', 'persisted']);
  return Object.freeze({ eventType: requiredString(object.eventType, 'diagnostic.eventType'), message: requiredStringValue(object.message, 'diagnostic.message'), persisted: requiredBoolean(object.persisted, 'diagnostic.persisted') });
}
function decodeApprovalBinding(value: JsonValue | undefined): AgentApprovalBinding {
  const object = requiredObject(value, 'binding');
  exact(object, ['toolImplementationId', 'authorizationPolicyId', 'executionTargetId']);
  return Object.freeze({ toolImplementationId: requiredString(object.toolImplementationId, 'binding.toolImplementationId'), authorizationPolicyId: requiredString(object.authorizationPolicyId, 'binding.authorizationPolicyId'), executionTargetId: requiredString(object.executionTargetId, 'binding.executionTargetId') });
}
function decodeToolProgress(value: JsonValue | undefined): ToolProgress {
  const object = requiredObject(value, 'progress');
  if (object.type === 'status') {
    exact(object, ['type', 'stage', 'message', 'completed', 'total']);
    const message = optionalStringValue(object.message, 'progress.message');
    return Object.freeze({ type: 'status', stage: requiredStringValue(object.stage, 'progress.stage'), ...(message !== undefined ? { message } : {}), ...optionalNonnegativeFields(object, ['completed', 'total']) });
  }
  if (object.type === 'output') { exact(object, ['type', 'stream', 'sequence', 'text', 'observedBytes']); return Object.freeze({ type: 'output', stream: requiredEnum(object.stream, ['stdout', 'stderr'] as const, 'progress.stream'), sequence: nonnegativeInteger(object.sequence, 'progress.sequence'), text: requiredStringValue(object.text, 'progress.text'), observedBytes: nonnegativeInteger(object.observedBytes, 'progress.observedBytes') }); }
  if (object.type === 'patch') {
    exact(object, ['type', 'changes']);
    return Object.freeze({ type: 'patch', changes: Object.freeze(requiredArray(object.changes, 'progress.changes').map((item, index) => {
      const change = requiredObject(item, `progress.changes[${String(index)}]`);
      exact(change, ['path', 'operation', 'status']);
      return Object.freeze({ path: requiredString(change.path, 'change.path'), operation: requiredEnum(change.operation, ['add', 'update', 'delete', 'move'] as const, 'change.operation'), status: requiredStringValue(change.status, 'change.status') });
    })) });
  }
  if (object.type === 'metric') { exact(object, ['type', 'name', 'value', 'unit']); const unit = optionalStringValue(object.unit, 'progress.unit'); return Object.freeze({ type: 'metric', name: requiredString(object.name, 'progress.name'), value: finiteNumber(object.value, 'progress.value'), ...(unit !== undefined ? { unit } : {}) }); }
  throw malformed('progress.type is invalid');
}
function decodePresentation(value: JsonValue | undefined, path: string): ToolObservationPresentation {
  const object = requiredObject(value, path);
  exact(object, ['ok', 'title', 'summary', 'scope', 'filters', 'limits', 'results', 'failures', 'omitted', 'coverage', 'truncated', 'warnings', 'next']);
  const scope = optionalObject(object.scope, `${path}.scope`);
  const filters = optionalObject(object.filters, `${path}.filters`);
  const limits = optionalObject(object.limits, `${path}.limits`);
  const omitted = optionalObject(object.omitted, `${path}.omitted`);
  const coverage = object.coverage === undefined ? undefined : requiredEnum(object.coverage, ['complete', 'partial'] as const, `${path}.coverage`);
  const truncated = object.truncated === undefined ? undefined : requiredBoolean(object.truncated, `${path}.truncated`);
  const warnings = object.warnings === undefined ? undefined : stringArray(object.warnings, `${path}.warnings`);
  const next = optionalStringValue(object.next, `${path}.next`);
  return Object.freeze({
    ok: requiredBoolean(object.ok, `${path}.ok`), title: requiredStringValue(object.title, `${path}.title`), summary: requiredStringValue(object.summary, `${path}.summary`),
    ...(scope ? { scope } : {}), ...(filters ? { filters } : {}), ...(limits ? { limits } : {}), ...(object.results !== undefined ? { results: object.results } : {}),
    ...(object.failures !== undefined ? { failures: object.failures } : {}), ...(omitted ? { omitted } : {}), ...(coverage ? { coverage } : {}),
    ...(truncated !== undefined ? { truncated } : {}), ...(warnings ? { warnings } : {}), ...(next !== undefined ? { next } : {})
  });
}
function decodeMessageRecord(value: JsonValue, path: string): { readonly message: string } {
  const object = requiredObject(value, path);
  exact(object, ['message']);
  return Object.freeze({ message: requiredStringValue(object.message, `${path}.message`) });
}

function requiredObject(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) throw malformed(`${path} must be an object`);
  return value;
}
function optionalObject(value: JsonValue | undefined, path: string): JsonObject | undefined { return value === undefined ? undefined : requiredObject(value, path); }
function requiredArray(value: JsonValue | undefined, path: string): readonly JsonValue[] { if (!isJsonArray(value)) throw malformed(`${path} must be an array`); return value; }
function optionalArray(value: JsonValue | undefined, path: string): readonly JsonValue[] | undefined { return value === undefined ? undefined : requiredArray(value, path); }
function requiredJson(value: JsonValue | undefined, path: string): JsonValue { if (value === undefined) throw malformed(`${path} is required`); return value; }
function requiredString(value: JsonValue | undefined, path: string): string { if (typeof value !== 'string' || value.trim().length === 0) throw malformed(`${path} must be a non-empty string`); return value; }
function requiredStringValue(value: JsonValue | undefined, path: string): string { if (typeof value !== 'string') throw malformed(`${path} must be a string`); return value; }
function optionalString(value: JsonValue | undefined, path: string): string | undefined { return value === undefined ? undefined : requiredString(value, path); }
function optionalStringValue(value: JsonValue | undefined, path: string): string | undefined { return value === undefined ? undefined : requiredStringValue(value, path); }
function requiredBoolean(value: JsonValue | undefined, path: string): boolean { if (typeof value !== 'boolean') throw malformed(`${path} must be boolean`); return value; }
function finiteNumber(value: JsonValue | undefined, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw malformed(`${path} must be finite`); return value; }
function positiveNumber(value: JsonValue | undefined, path: string): number { const number = finiteNumber(value, path); if (number <= 0) throw malformed(`${path} must be positive`); return number; }
function nonnegativeNumber(value: JsonValue | undefined, path: string): number { const number = finiteNumber(value, path); if (number < 0) throw malformed(`${path} must be nonnegative`); return number; }
function optionalFiniteNumber(value: JsonValue | undefined, path: string): number | undefined { return value === undefined ? undefined : finiteNumber(value, path); }
function optionalNonnegativeNumber(value: JsonValue | undefined, path: string): number | undefined { return value === undefined ? undefined : nonnegativeNumber(value, path); }
function positiveInteger(value: JsonValue | undefined, path: string): number { const number = finiteNumber(value, path); if (!Number.isInteger(number) || number < 1) throw malformed(`${path} must be a positive integer`); return number; }
function nonnegativeInteger(value: JsonValue | undefined, path: string): number { const number = finiteNumber(value, path); if (!Number.isInteger(number) || number < 0) throw malformed(`${path} must be a nonnegative integer`); return number; }
function optionalPositiveInteger(value: JsonValue | undefined, path: string): number | undefined { return value === undefined ? undefined : positiveInteger(value, path); }
function requiredEnum<const Values extends readonly string[]>(value: JsonValue | undefined, values: Values, path: string): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw malformed(`${path} is invalid`);
  return value;
}
function stringArray(value: JsonValue | undefined, path: string): readonly string[] { return Object.freeze(requiredArray(value, path).map((item, index) => requiredStringValue(item, `${path}[${String(index)}]`))); }
function optionalStringRecord(value: JsonValue | undefined, path: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const object = requiredObject(value, path);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) output[key] = requiredStringValue(item, `${path}.${key}`);
  return Object.freeze(output);
}
function nonnegativeNumberRecord(value: JsonValue | undefined, path: string): Readonly<Record<string, number>> {
  const object = requiredObject(value, path);
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(object)) output[key] = nonnegativeNumber(item, `${path}.${key}`);
  return Object.freeze(output);
}
function primitiveRecord(value: JsonValue, path: string): Readonly<Record<string, string | number | boolean | null>> {
  const object = requiredObject(value, path);
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(object)) {
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') throw malformed(`${path}.${key} must be primitive`);
    output[key] = item;
  }
  return Object.freeze(output);
}
function optionalNonnegativeFields<const Keys extends readonly string[]>(object: JsonObject, keys: Keys): Readonly<Partial<Record<Keys[number], number>>> {
  const output: Partial<Record<Keys[number], number>> = {};
  for (const key of keys) {
    if (object[key] !== undefined) Object.defineProperty(output, key, { value: nonnegativeInteger(object[key], key), enumerable: true });
  }
  return Object.freeze(output);
}
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] { return Array.isArray(value); }
function exact(value: JsonObject, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) throw malformed(`unsupported fields: ${unsupported.join(', ')}`);
}
function malformed(message: string): Error { return new Error(`Malformed Agent event: ${message}.`); }
