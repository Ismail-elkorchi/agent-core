import {
  canonicalJsonString,
  parseJsonObject,
  type JsonObject,
  type JsonValue
} from '@agent-core/json';
import type {
  ModelReasoningRequest,
  ModelRequest,
  ModelResponseFormat,
  ModelTerminationReason
} from '@agent-core/model';
import type { ArtifactRef } from '@agent-core/persistence';
import type { ToolEffects } from '@agent-core/tools';

export type AgentModelOutputStatus = 'complete' | 'partial' | 'indeterminate' | 'absent';
export type AgentModelOutputSource = 'content' | 'stream_recovery';
export type AgentRunPhase =
  | 'initializing'
  | 'requesting_model'
  | 'executing_tools'
  | 'waiting_for_approval'
  | 'finalizing'
  | 'ended';

/** A monotonic clock used for elapsed-time decisions. Values have no wall-clock meaning. */
export interface AgentClock {
  now(): number;
}

export function systemAgentClock(): AgentClock {
  return Object.freeze({ now: () => performance.now() });
}

export type AgentTurnIdentity = Readonly<{
  readonly turnIndex: number;
  readonly turnId: string;
  readonly requestAttempt: number;
}>;

export type AgentToolBatchIdentity = AgentTurnIdentity &
  Readonly<{
    readonly toolBatchId: string;
  }>;

export type AgentToolCallIdentity = AgentToolBatchIdentity &
  Readonly<{
    readonly callIndex: number;
    readonly callId?: string;
  }>;

export type AgentToolCallAttemptIdentity = AgentToolCallIdentity &
  Readonly<{
    readonly toolAttempt: number;
  }>;

export function toolEventKey(
  runId: string,
  identity: Pick<
    AgentToolCallAttemptIdentity,
    'turnId' | 'toolBatchId' | 'callIndex' | 'toolAttempt'
  >,
  stage: string
): string {
  return `${runId}:tool:${identity.turnId}:${identity.toolBatchId}:${String(identity.callIndex)}:attempt:${String(identity.toolAttempt)}:${stage}`;
}

export function assistantResponseKey(
  runId: string,
  identity: Pick<AgentTurnIdentity, 'turnId' | 'requestAttempt'>
): string {
  return `${runId}:assistant:${identity.turnId}:${String(identity.requestAttempt)}:ended`;
}

export interface AgentApprovalBinding extends JsonObject {
  readonly toolImplementationId: string;
  readonly authorizationPolicyId: string;
  readonly executionTargetId: string;
}

export interface AgentApprovalRequest extends AgentToolCallIdentity {
  readonly runId: string;
  readonly approvalId: string;
  readonly status: 'pending';
  readonly toolName: string;
  readonly fingerprint: string;
  readonly input: JsonValue;
  readonly effects: ToolEffects;
  readonly binding: AgentApprovalBinding;
  readonly policyHash: string;
  readonly reason: string;
}

export interface AgentApprovalSuspension extends AgentRunIdentity {
  readonly state: 'suspended';
  readonly reason: 'approval_required';
  readonly pendingApprovals: readonly AgentApprovalRequest[];
  readonly budget: AgentRunBudgetState;
}

export interface AgentRunSuspension extends AgentRunIdentity {
  readonly contextAdmission?: import('./context-admission.js').ContextAdmissionConflict;
  readonly state: 'suspended';
  readonly reason:
    | 'provider_outcome_unknown'
    | 'tool_outcome_unknown'
    | 'missing_implementation'
    | 'context_admission'
    | 'user_decision';
  readonly effectId?: string;
  readonly decisionRequest?: import('./control/contracts.js').AgentDecisionRequest;
  readonly cleanupDiagnostic?: {
    readonly kind: 'resource_cleanup';
    readonly message: string;
  };
  readonly budget: AgentRunBudgetState;
}

export type AgentModelOutput = AgentAbsentModelOutput | AgentPresentModelOutput;
export type AgentAbsentModelOutput = Readonly<{ readonly status: 'absent' }>;
export type AgentPresentModelOutput = Readonly<{
  readonly status: Exclude<AgentModelOutputStatus, 'absent'>;
  readonly message: string;
  readonly source: AgentModelOutputSource;
  readonly turnIndex: number;
}>;

export type AgentRunIdentity = Readonly<{
  readonly runId: string;
  readonly finalizationId: string;
}>;

export type AgentEffectiveInstruction = Readonly<{
  readonly id: string;
  readonly content: string;
  readonly provenance: 'application' | 'run' | 'steering';
  readonly role?: string;
  readonly sourceUri?: string;
  readonly priority?: number;
}>;

export interface AgentObservedFactsPage {
  readonly items: readonly JsonValue[];
  readonly nextCursor?: string;
  readonly bytes: number;
  readonly truncated: boolean;
}
export interface AgentObservedFactsReader {
  read(input?: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly maxBytes?: number;
  }): Promise<AgentObservedFactsPage>;
  readArtifact(ref: ArtifactRef, input?: { readonly maxBytes?: number }): Promise<Uint8Array>;
}
export interface ObservationAccess {
  readonly observedFacts: AgentObservedFactsReader;
}

export type AgentLimitKind =
  | 'model_turns'
  | 'total_tool_calls'
  | 'elapsed_time'
  | 'prompt_tokens'
  | 'completion_tokens'
  | 'known_cost';
export interface AgentRunLimits {
  readonly maxConcurrentToolCalls: number;
  readonly modelTurns?: number;
  readonly totalToolCalls?: number;
  readonly elapsedMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly activeImageCount: number;
  readonly activeImageBytes: number;
  readonly activeImageTokens: number;
  readonly knownCost?: { readonly amount: number; readonly currency: string };
}
/** Execution capacity defaults; work budgets are chosen explicitly by the application. */
export const DEFAULT_AGENT_RUN_LIMITS: AgentRunLimits = Object.freeze({
  maxConcurrentToolCalls: 4,
  activeImageCount: 16,
  activeImageBytes: 64 * 1024 * 1024,
  activeImageTokens: 32_000
});
export type AgentRunBudgetState = Readonly<{
  readonly modelTurns: number;
  readonly totalToolCalls: number;
  readonly elapsedMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly knownCosts: Readonly<Record<string, number>>;
  readonly pricingStatus: 'known' | 'partial' | 'unknown';
  readonly unknownPricedTokens: number;
}>;

const AGENT_RUN_BUDGET_FIELDS = [
  'modelTurns',
  'totalToolCalls',
  'elapsedMs',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'knownCosts',
  'pricingStatus',
  'unknownPricedTokens'
] as const;

export function decodeAgentRunBudgetState(value: unknown): AgentRunBudgetState {
  const object = parseJsonObject(value);
  const fields = Object.keys(object);
  if (
    fields.length !== AGENT_RUN_BUDGET_FIELDS.length ||
    fields.some(
      (field) =>
        !AGENT_RUN_BUDGET_FIELDS.includes(field as (typeof AGENT_RUN_BUDGET_FIELDS)[number])
    )
  ) {
    throw contract('Invalid run budget.', ['budget fields are invalid.']);
  }
  if (!isBudgetState(object)) throw contract('Invalid run budget.', ['budget values are invalid.']);
  return Object.freeze({
    ...object,
    knownCosts: Object.freeze({ ...object.knownCosts })
  });
}

export interface AgentTurnSnapshotRecord {
  readonly toolCatalog: import('./tool-catalog.js').ToolCatalogSnapshot;
  readonly turnIndex: number;
  readonly turnId: string;
  readonly requestAttempt: number;
  readonly provider: string;
  readonly model: string;
  readonly profileHash: string;
  readonly continuationEligible: boolean;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly responseFormat?: ModelResponseFormat;
  readonly toolNames: readonly string[];
  readonly toolPolicyHash: string;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly configuredContextSourceIds: readonly string[];
  readonly limits: AgentRunLimits;
  readonly budget: AgentRunBudgetState;
}

/** The immutable request truth created only after every dynamic input has resolved. */
export interface InferenceRequestFingerprintRecord extends AgentTurnIdentity {
  readonly parentRequestId?: string;
  readonly compiledInputIdentity: string;
  readonly capabilityRevision: string;
  readonly requestId: string;
  readonly configuredContextIds: readonly string[];
  readonly providerContextIds: readonly string[];
  readonly runContextIds: readonly string[];
  readonly effectiveInstructionHash: string;
  readonly modelWindowHistoryHash: string;
  readonly modelToolSchemasHash: string;
  readonly modelWindowHash: string;
}

export interface LogicalModelRequestRecord extends AgentTurnIdentity {
  readonly requestId: string;
  readonly request: Omit<ModelRequest, 'signal'>;
}

export type AgentCompletedTerminationReason =
  'model_completed' | 'model_output_limit' | 'content_filtered' | 'unknown_model_termination';
export type AgentFailureTerminationReason =
  | Exclude<AgentCompletedTerminationReason, 'model_completed'>
  | 'empty_response'
  | 'malformed_response'
  | 'provider_error'
  | 'runtime_error'
  | 'stream_interrupted'
  | 'request_too_large'
  | 'limit_exhausted';
type AgentTerminalBase = AgentRunIdentity &
  Readonly<{
    readonly phase: 'ended';
    readonly turnCount: number;
    readonly modelOutput: AgentModelOutput;
    readonly modelTerminationReason?: ModelTerminationReason;
    readonly providerTerminationReason?: string;
    readonly budget: AgentRunBudgetState;
    readonly exhaustedLimit?: AgentLimitKind;
    readonly cleanupDiagnostic?: {
      readonly kind: 'resource_cleanup';
      readonly message: string;
    };
  }>;
export type AgentCompletedTerminalSnapshot = AgentTerminalBase &
  Readonly<{
    readonly executionStatus: 'completed';
    readonly modelOutput: AgentPresentModelOutput;
    readonly terminationReason: AgentCompletedTerminationReason;
    readonly errorMessage?: never;
  }>;
export type AgentFailedTerminalSnapshot = AgentTerminalBase &
  Readonly<{
    readonly executionStatus: 'failed';
    readonly modelOutput: AgentModelOutput;
    readonly terminationReason: AgentFailureTerminationReason;
    readonly errorMessage: string;
  }>;
export type AgentAbortedTerminalSnapshot = AgentTerminalBase &
  Readonly<{
    readonly executionStatus: 'aborted';
    readonly modelOutput:
      AgentAbsentModelOutput | (AgentPresentModelOutput & { readonly status: 'partial' });
    readonly terminationReason: 'aborted';
    readonly errorMessage: string;
  }>;
export type AgentTerminalSnapshot =
  AgentCompletedTerminalSnapshot | AgentFailedTerminalSnapshot | AgentAbortedTerminalSnapshot;
export interface AgentDeliveryDiagnostic {
  readonly eventType: string;
  readonly message: string;
  readonly persisted: boolean;
}
export interface AgentEndedRunResult {
  readonly state: 'ended';
  readonly terminal: AgentTerminalSnapshot;
  readonly deliveryDiagnostics: readonly AgentDeliveryDiagnostic[];
}
export type AgentRunResult = AgentApprovalSuspension | AgentRunSuspension | AgentEndedRunResult;

export class AgentContractError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(`${message}${issues.length > 0 ? ` ${issues.join(' ')}` : ''}`);
    this.name = 'AgentContractError';
    this.issues = Object.freeze([...issues]);
  }
}

export function validateAgentRunLimits(input: Partial<AgentRunLimits> = {}): AgentRunLimits {
  const limits: AgentRunLimits = { ...DEFAULT_AGENT_RUN_LIMITS, ...input };
  const capacities = [
    'maxConcurrentToolCalls',
    'activeImageCount',
    'activeImageBytes',
    'activeImageTokens'
  ] as const;
  const budgets = [
    'modelTurns',
    'totalToolCalls',
    'elapsedMs',
    'promptTokens',
    'completionTokens'
  ] as const;
  const issues = [
    ...capacities.filter((field) => !positiveInteger(limits[field])),
    ...budgets.filter((field) => limits[field] !== undefined && !positiveInteger(limits[field]))
  ].map((field) => `${field} must be a positive finite integer.`);
  const knownCost = limits.knownCost;
  if (knownCost !== undefined) {
    if (!Number.isFinite(knownCost.amount) || knownCost.amount <= 0)
      issues.push('knownCost.amount must be positive and finite.');
    if (knownCost.currency.trim().length === 0)
      issues.push('knownCost.currency must be non-empty.');
  }
  if (issues.length > 0) throw new AgentContractError('Invalid run limits.', issues);
  return Object.freeze({
    ...limits,
    ...(knownCost === undefined ? {} : { knownCost: Object.freeze({ ...knownCost }) })
  });
}

export function decodeOwnedAgentModelOutput(value: JsonObject): AgentModelOutput {
  if (typeof value.status !== 'string')
    throw contract('Invalid modelOutput.', ['Model output must be a discriminated object.']);
  if (value.status === 'absent') {
    if (Object.keys(value).some((key) => key !== 'status'))
      throw contract('Invalid absent modelOutput.', [
        'Absent modelOutputs cannot carry message, source, or turnIndex.'
      ]);
    return Object.freeze({ status: 'absent' });
  }
  if (!oneOf(value.status, ['complete', 'partial', 'indeterminate']))
    throw contract('Invalid modelOutput.', ['Unsupported modelOutput status.']);
  if (typeof value.message !== 'string' || value.message.trim().length === 0)
    throw contract('Invalid modelOutput.', ['Model output message must be non-empty.']);
  if (!oneOf(value.source, ['content', 'stream_recovery']))
    throw contract('Invalid modelOutput.', ['Unsupported modelOutput source.']);
  if (!positiveInteger(value.turnIndex))
    throw contract('Invalid modelOutput.', ['Model output turnIndex must be a positive integer.']);
  if (value.source === 'stream_recovery' && value.status !== 'partial')
    throw contract('Invalid modelOutput.', ['Stream recovery modelOutputs must be partial.']);
  return Object.freeze({
    status: value.status,
    message: value.message,
    source: value.source,
    turnIndex: value.turnIndex
  });
}

export function createAgentTerminalSnapshot(value: AgentTerminalSnapshot): AgentTerminalSnapshot {
  const issues: string[] = [];
  if (!validIdentity(value.runId))
    issues.push('runId must be non-empty and at most 256 UTF-8 bytes.');
  if (!validIdentity(value.finalizationId))
    issues.push('finalizationId must be non-empty and at most 256 UTF-8 bytes.');
  if (!Number.isInteger(value.turnCount) || value.turnCount < 0)
    issues.push('turnCount must be a nonnegative integer.');
  if (value.executionStatus === 'completed')
    issues.push(...completedModelOutputIssues(value.terminationReason, value.modelOutput.status));
  if (value.terminationReason === 'limit_exhausted' && value.exhaustedLimit === undefined)
    issues.push('limit_exhausted requires exhaustedLimit.');
  if (value.terminationReason !== 'limit_exhausted' && value.exhaustedLimit !== undefined)
    issues.push('exhaustedLimit is only legal for limit_exhausted.');
  issues.push(
    ...modelTerminationIssues({
      terminationReason: value.terminationReason,
      ...(value.modelTerminationReason !== undefined
        ? { modelTerminationReason: value.modelTerminationReason }
        : {}),
      ...(value.providerTerminationReason !== undefined
        ? { providerTerminationReason: value.providerTerminationReason }
        : {})
    })
  );
  if (issues.length > 0) throw contract('Invalid terminal snapshot.', issues);
  const budget = Object.freeze({
    ...value.budget,
    knownCosts: Object.freeze({ ...value.budget.knownCosts })
  });
  const cleanup = value.cleanupDiagnostic
    ? { cleanupDiagnostic: Object.freeze({ ...value.cleanupDiagnostic }) }
    : {};
  if (value.executionStatus === 'completed')
    return Object.freeze({
      ...value,
      modelOutput: Object.freeze({ ...value.modelOutput }),
      budget,
      ...cleanup
    });
  if (value.executionStatus === 'failed')
    return Object.freeze({
      ...value,
      modelOutput: Object.freeze({ ...value.modelOutput }),
      budget,
      ...cleanup
    });
  return Object.freeze({
    ...value,
    modelOutput: Object.freeze({ ...value.modelOutput }),
    budget,
    ...cleanup
  });
}

export function decodeAgentTerminalSnapshot(value: unknown): AgentTerminalSnapshot {
  return decodeOwnedAgentTerminalSnapshot(parseJsonObject(value));
}

export function decodeOwnedAgentTerminalSnapshot(value: JsonObject): AgentTerminalSnapshot {
  const issues = terminalBaseIssues(value);
  let modelOutput: AgentModelOutput | undefined;
  try {
    const candidateValue = value.modelOutput;
    if (candidateValue === undefined || !isJsonObject(candidateValue))
      throw contract('Invalid modelOutput.', ['Model output must be a discriminated object.']);
    modelOutput = decodeOwnedAgentModelOutput(candidateValue);
  } catch (error) {
    issues.push(errorMessage(error));
  }
  const budget = isBudgetState(value.budget) ? value.budget : undefined;
  if (!budget) issues.push('budget is invalid.');
  if (value.executionStatus === 'completed') {
    if (!modelOutput || modelOutput.status === 'absent')
      issues.push('Completed execution requires a present modelOutput.');
    if (
      !oneOf(value.terminationReason, [
        'model_completed',
        'model_output_limit',
        'content_filtered',
        'unknown_model_termination'
      ])
    )
      issues.push('Completed execution has an invalid termination reason.');
    if (modelOutput && modelOutput.status !== 'absent')
      issues.push(...completedModelOutputIssues(value.terminationReason, modelOutput.status));
    if (value.errorMessage !== undefined)
      issues.push('Completed execution cannot have errorMessage.');
  } else if (value.executionStatus === 'failed') {
    if (!oneOf(value.terminationReason, FAILURE_REASONS))
      issues.push('Failed execution has an invalid termination reason.');
    if (typeof value.errorMessage !== 'string' || value.errorMessage.trim().length === 0)
      issues.push('Failed execution requires errorMessage.');
  } else if (value.executionStatus === 'aborted') {
    if (modelOutput && modelOutput.status !== 'absent' && modelOutput.status !== 'partial')
      issues.push('Aborted execution can only preserve a partial modelOutput.');
    if (value.terminationReason !== 'aborted') issues.push('Aborted execution must use aborted.');
    if (typeof value.errorMessage !== 'string' || value.errorMessage.trim().length === 0)
      issues.push('Aborted execution requires errorMessage.');
  } else issues.push('executionStatus is invalid.');
  if (
    value.terminationReason === 'limit_exhausted' &&
    !oneOf(value.exhaustedLimit, AGENT_LIMIT_KINDS)
  )
    issues.push('limit_exhausted requires exhaustedLimit.');
  if (value.terminationReason !== 'limit_exhausted' && value.exhaustedLimit !== undefined)
    issues.push('exhaustedLimit is only legal for limit_exhausted.');
  if (
    value.cleanupDiagnostic !== undefined &&
    (!isRecord(value.cleanupDiagnostic) ||
      value.cleanupDiagnostic.kind !== 'resource_cleanup' ||
      typeof value.cleanupDiagnostic.message !== 'string' ||
      value.cleanupDiagnostic.message.length === 0)
  )
    issues.push('cleanupDiagnostic is invalid.');
  issues.push(...modelTerminationIssues(value));
  if (issues.length > 0) throw contract('Invalid terminal snapshot.', issues);
  if (!modelOutput) throw contract('Invalid terminal snapshot.', ['modelOutput is invalid.']);
  if (!budget) throw contract('Invalid terminal snapshot.', ['budget is invalid.']);
  const base = {
    runId: value.runId as string,
    finalizationId: value.finalizationId as string,
    phase: 'ended' as const,
    turnCount: value.turnCount as number,
    modelOutput,
    budget,
    ...(value.modelTerminationReason !== undefined
      ? {
          modelTerminationReason: value.modelTerminationReason as ModelTerminationReason
        }
      : {}),
    ...(typeof value.providerTerminationReason === 'string'
      ? { providerTerminationReason: value.providerTerminationReason }
      : {}),
    ...(value.exhaustedLimit !== undefined
      ? { exhaustedLimit: value.exhaustedLimit as AgentLimitKind }
      : {}),
    ...(value.cleanupDiagnostic !== undefined
      ? {
          cleanupDiagnostic: value.cleanupDiagnostic as {
            readonly kind: 'resource_cleanup';
            readonly message: string;
          }
        }
      : {})
  };
  if (value.executionStatus === 'completed')
    return Object.freeze({
      ...base,
      executionStatus: 'completed',
      modelOutput: modelOutput as AgentPresentModelOutput,
      terminationReason: value.terminationReason as AgentCompletedTerminationReason
    });
  if (value.executionStatus === 'failed')
    return Object.freeze({
      ...base,
      executionStatus: 'failed',
      terminationReason: value.terminationReason as AgentFailureTerminationReason,
      errorMessage: value.errorMessage as string
    });
  return Object.freeze({
    ...base,
    executionStatus: 'aborted',
    modelOutput: modelOutput as AgentAbortedTerminalSnapshot['modelOutput'],
    terminationReason: 'aborted',
    errorMessage: value.errorMessage as string
  });
}

export function terminalSnapshotFingerprint(snapshot: AgentTerminalSnapshot): string {
  return canonicalJsonString(snapshot);
}
const AGENT_LIMIT_KINDS: readonly AgentLimitKind[] = [
  'model_turns',
  'total_tool_calls',
  'elapsed_time',
  'prompt_tokens',
  'completion_tokens',
  'known_cost'
];
const FAILURE_REASONS: readonly AgentFailureTerminationReason[] = [
  'model_output_limit',
  'content_filtered',
  'unknown_model_termination',
  'empty_response',
  'malformed_response',
  'provider_error',
  'runtime_error',
  'stream_interrupted',
  'request_too_large',
  'limit_exhausted'
];
function terminalBaseIssues(value: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const fields = [
    'runId',
    'finalizationId',
    'phase',
    'turnCount',
    'modelOutput',
    'modelTerminationReason',
    'providerTerminationReason',
    'exhaustedLimit',
    'budget',
    'cleanupDiagnostic',
    'executionStatus',
    'terminationReason',
    'errorMessage'
  ];
  for (const field of Object.keys(value))
    if (!fields.includes(field)) issues.push(`Unsupported terminal field: ${field}.`);
  if (!validIdentity(value.runId))
    issues.push('runId must be non-empty and at most 256 UTF-8 bytes.');
  if (!validIdentity(value.finalizationId))
    issues.push('finalizationId must be non-empty and at most 256 UTF-8 bytes.');
  if (value.phase !== 'ended') issues.push('Terminal phase must be ended.');
  if (
    typeof value.turnCount !== 'number' ||
    !Number.isInteger(value.turnCount) ||
    value.turnCount < 0
  )
    issues.push('turnCount must be a nonnegative integer.');
  if (
    value.modelTerminationReason !== undefined &&
    !oneOf(value.modelTerminationReason, [
      'stop',
      'tool_calls',
      'output_limit',
      'content_filter',
      'unknown'
    ])
  )
    issues.push('modelTerminationReason is invalid.');
  if (
    value.providerTerminationReason !== undefined &&
    typeof value.providerTerminationReason !== 'string'
  )
    issues.push('providerTerminationReason must be a string.');
  return issues;
}
function modelTerminationIssues(value: Record<string, unknown>): string[] {
  const mapping: Partial<Record<string, ModelTerminationReason>> = {
    model_completed: 'stop',
    model_output_limit: 'output_limit',
    content_filtered: 'content_filter',
    unknown_model_termination: 'unknown'
  };
  const expected =
    typeof value.terminationReason === 'string' ? mapping[value.terminationReason] : undefined;
  return expected !== undefined && value.modelTerminationReason !== expected
    ? [`${String(value.terminationReason)} requires modelTerminationReason ${expected}.`]
    : [];
}
function completedModelOutputIssues(
  terminationReason: unknown,
  candidateStatus: AgentPresentModelOutput['status']
): string[] {
  const expected: Partial<
    Record<AgentCompletedTerminationReason, AgentPresentModelOutput['status']>
  > = {
    model_completed: 'complete',
    model_output_limit: 'partial',
    content_filtered: 'partial',
    unknown_model_termination: 'indeterminate'
  };
  const status = isCompletedTerminationReason(terminationReason)
    ? expected[terminationReason]
    : undefined;
  return status !== undefined && candidateStatus !== status
    ? [`${String(terminationReason)} requires modelOutput status ${status}.`]
    : [];
}
function isBudgetState(value: unknown): value is AgentRunBudgetState {
  if (!isRecord(value)) return false;
  const names = [
    'modelTurns',
    'totalToolCalls',
    'elapsedMs',
    'promptTokens',
    'completionTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'unknownPricedTokens'
  ];
  if (
    !names.every(
      (name) =>
        typeof value[name] === 'number' &&
        Number.isFinite(value[name]) &&
        Number.isInteger(value[name]) &&
        value[name] >= 0
    )
  )
    return false;
  return (
    finiteNonnegativeNumberRecord(value.knownCosts) &&
    oneOf(value.pricingStatus, ['known', 'partial', 'unknown'])
  );
}
function finiteNonnegativeNumberRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(
    (descriptor) =>
      'value' in descriptor &&
      typeof descriptor.value === 'number' &&
      Number.isFinite(descriptor.value) &&
      descriptor.value >= 0
  );
}
function positiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 256
  );
}
function isCompletedTerminationReason(value: unknown): value is AgentCompletedTerminationReason {
  return oneOf(value, [
    'model_completed',
    'model_output_limit',
    'content_filtered',
    'unknown_model_termination'
  ]);
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((modelOutput) => modelOutput === value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function contract(message: string, issues: string[]): AgentContractError {
  return new AgentContractError(message, issues);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
