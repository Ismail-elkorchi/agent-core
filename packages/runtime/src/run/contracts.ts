import type { ArtifactRef } from '@agent-core/evidence';
import { canonicalJsonString } from '@agent-core/evidence';
import { parseJsonObject, type JsonNormalizationDiagnostic, type JsonObject, type JsonValue } from '@agent-core/json';
import type { ModelReasoningRequest, ModelRequest, ModelResponseFormat, ModelTerminationReason } from '@agent-core/model';
import type { ToolEffects } from '@agent-core/tools';

export type AgentCandidateStatus = 'complete' | 'partial' | 'indeterminate' | 'absent';
export type AgentCandidateSource = 'content' | 'reasoning_summary' | 'stream_recovery';
export type AgentVerificationStatus = 'not_required' | 'not_run' | 'passed' | 'failed' | 'inconclusive';
export type AgentCompletedVerificationStatus = Exclude<AgentVerificationStatus, 'not_run'>;
export type AgentCheckVerdict = 'passed' | 'failed' | 'unknown';
export type AgentCheckRequirement = 'required' | 'advisory';
export type AgentRunPhase =
  | 'preparing'
  | 'requesting_model'
  | 'executing_tools'
  | 'waiting_for_approval'
  | 'verifying'
  | 'finalizing'
  | 'ended';

/** A monotonic clock used for elapsed-time decisions. Values have no wall-clock meaning. */
export interface AgentClock { now(): number }

export function systemAgentClock(): AgentClock {
  return Object.freeze({ now: () => performance.now() });
}

export type AgentTurnIdentity = Readonly<{
  readonly turnIndex: number;
  readonly turnId: string;
  readonly requestAttempt: number;
}>;

export type AgentToolBatchIdentity = AgentTurnIdentity & Readonly<{
  readonly toolBatchId: string;
}>;

export type AgentToolCallIdentity = AgentToolBatchIdentity & Readonly<{
  readonly callIndex: number;
  readonly callId?: string;
}>;

export type AgentToolCallAttemptIdentity = AgentToolCallIdentity & Readonly<{
  readonly toolAttempt: number;
}>;

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

export interface AgentOperationSuspension extends AgentRunIdentity {
  readonly state: 'suspended';
  readonly reason: 'provider_outcome_unknown' | 'tool_outcome_unknown' | 'missing_implementation' | 'user_decision';
  readonly effectId?: string;
  readonly budget: AgentRunBudgetState;
}

export type AgentCandidate = AgentAbsentCandidate | AgentPresentCandidate;
export type AgentAbsentCandidate = Readonly<{ readonly status: 'absent' }>;
export type AgentPresentCandidate = Readonly<{
  readonly status: Exclude<AgentCandidateStatus, 'absent'>;
  readonly message: string;
  readonly source: AgentCandidateSource;
  readonly turnIndex: number;
}>;

export type AgentRunIdentity = Readonly<{ readonly runId: string; readonly finalizationId: string }>;

export type AgentEffectiveInstruction = Readonly<{
  readonly id: string;
  readonly content: string;
  readonly provenance: 'application' | 'run' | 'steering';
  readonly role?: string;
  readonly sourceUri?: string;
  readonly priority?: number;
}>;

export type AgentCheckDiagnosticKind = 'exception' | 'timeout' | 'unavailable' | 'permission_denied' | 'aborted' | 'invalid_result';
export type AgentCheckDiagnostic = Readonly<{ readonly kind: AgentCheckDiagnosticKind; readonly message: string; readonly details?: JsonValue }>;
export interface AgentCheckObservation {
  readonly verdict: AgentCheckVerdict;
  readonly summary: string;
  readonly output?: unknown;
  readonly artifacts?: readonly ArtifactRef[];
  readonly diagnostic?: AgentCheckDiagnostic;
}
export type AgentCheckResult = Readonly<{
  readonly id: string;
  readonly requirement: AgentCheckRequirement;
  readonly verdict: AgentCheckVerdict;
  readonly summary: string;
  readonly durationMs: number;
  readonly output?: JsonValue;
  readonly outputNormalization?: readonly JsonNormalizationDiagnostic[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly diagnostic?: AgentCheckDiagnostic;
}>;

export interface AgentEvidencePage {
  readonly items: readonly JsonValue[];
  readonly nextCursor?: string;
  readonly bytes: number;
  readonly truncated: boolean;
}
export interface AgentEvidenceReader {
  read(input?: { readonly cursor?: string; readonly limit?: number; readonly maxBytes?: number }): Promise<AgentEvidencePage>;
  readArtifact(ref: ArtifactRef, input?: { readonly maxBytes?: number }): Promise<Uint8Array>;
}
export interface AgentVerificationCommandRequest {
  readonly command: string;
  readonly owner: { readonly runId: string; readonly turnId: string; readonly toolBatchId: string; readonly callIndex: number };
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}
export interface AgentVerificationCommandResult { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly durationMs: number }
export interface AgentVerificationExecutionContext {
  readonly evidence: AgentEvidenceReader;
  readonly runCommand?: (request: AgentVerificationCommandRequest, signal: AbortSignal) => Promise<AgentVerificationCommandResult>;
}
export interface AgentCheckContext {
  readonly runId: string;
  readonly task: string;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly candidate: AgentPresentCandidate;
  readonly turnIndex: number;
  readonly turnId: string;
  readonly requestAttempt: number;
  readonly metadata: Readonly<JsonObject>;
  readonly signal: AbortSignal;
  readonly execution: AgentVerificationExecutionContext;
}
export interface AgentCheckDefinition {
  readonly id: string;
  readonly requirement: AgentCheckRequirement;
  readonly description?: string;
  readonly timeoutMs?: number;
  run(context: AgentCheckContext): Promise<AgentCheckObservation>;
}

export type AgentLimitKind =
  | 'model_turns' | 'total_tool_calls' | 'repeated_tool_calls' | 'elapsed_time'
  | 'prompt_tokens' | 'completion_tokens' | 'known_cost' | 'consecutive_provider_failures'
  | 'consecutive_tool_failures' | 'provider_retries';
export interface AgentRunLimits {
  readonly maxConcurrentToolCalls: number;
  readonly modelTurns: number;
  readonly totalToolCalls: number;
  readonly repeatedIdenticalToolCalls: number;
  readonly elapsedMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly activeImageCount: number;
  readonly activeImageBytes: number;
  readonly activeImageTokens: number;
  readonly knownCost: { readonly amount: number; readonly currency: string };
  readonly consecutiveProviderFailures: number;
  readonly consecutiveToolFailures: number;
  readonly providerRetries: number;
}
export const DEFAULT_AGENT_RUN_LIMITS: AgentRunLimits = Object.freeze({
  maxConcurrentToolCalls: 4,
  modelTurns: 32,
  totalToolCalls: 128,
  repeatedIdenticalToolCalls: 3,
  elapsedMs: 30 * 60 * 1_000,
  promptTokens: 1_000_000,
  completionTokens: 250_000,
  activeImageCount: 16,
  activeImageBytes: 64 * 1024 * 1024,
  activeImageTokens: 32_000,
  knownCost: Object.freeze({ amount: 10, currency: 'USD' }),
  consecutiveProviderFailures: 3,
  consecutiveToolFailures: 5,
  providerRetries: 6
});
export type AgentRunBudgetState = Readonly<{
  readonly modelTurns: number;
  readonly totalToolCalls: number;
  readonly repeatedIdenticalToolCalls: number;
  readonly elapsedMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly knownCosts: Readonly<Record<string, number>>;
  readonly pricingStatus: 'known' | 'partial' | 'unknown';
  readonly unknownPricedTokens: number;
  readonly consecutiveProviderFailures: number;
  readonly consecutiveToolFailures: number;
  readonly providerRetries: number;
}>;
export interface AgentRunRetryPolicy { readonly retriesPerRequest: number; readonly initialDelayMs: number; readonly multiplier: number; readonly maximumDelayMs: number }
export const DEFAULT_AGENT_RUN_RETRY_POLICY: AgentRunRetryPolicy = Object.freeze({ retriesPerRequest: 2, initialDelayMs: 250, multiplier: 2, maximumDelayMs: 4_000 });

export interface AgentTurnSnapshotRecord {
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
  readonly checkIds: readonly string[];
  readonly limits: AgentRunLimits;
  readonly budget: AgentRunBudgetState;
}

export interface AgentRequestReductionRecord {
  readonly kind: string;
  readonly reason: string;
  readonly sequence: number;
}

/** The immutable request truth created only after every dynamic input has resolved. */
export interface AgentRequestSnapshotRecord extends AgentTurnIdentity {
  readonly requestId: string;
  readonly configuredContextIds: readonly string[];
  readonly providerContextIds: readonly string[];
  readonly runContextIds: readonly string[];
  readonly effectiveInstructionHash: string;
  readonly selectedEvidenceHash: string;
  readonly retainedHistoryHash: string;
  readonly modelToolSchemasHash: string;
  readonly compiledPromptHash: string;
  readonly reductions: readonly AgentRequestReductionRecord[];
}

export interface AgentExactRequestRecord extends AgentTurnIdentity {
  readonly requestId: string;
  readonly request: Omit<ModelRequest, 'signal'>;
}

export type AgentCompletedTerminationReason = 'model_completed' | 'model_output_limit' | 'content_filtered' | 'unknown_model_termination';
export type AgentFailureTerminationReason =
  | Exclude<AgentCompletedTerminationReason, 'model_completed'>
  | 'empty_response' | 'malformed_response' | 'provider_error' | 'runtime_error'
  | 'stream_interrupted' | 'request_too_large' | 'limit_exhausted' | 'uncertain_tool_effect';
type AgentTerminalBase = AgentRunIdentity & Readonly<{
  readonly phase: 'ended';
  readonly turnCount: number;
  readonly candidate: AgentCandidate;
  readonly modelTerminationReason?: ModelTerminationReason;
  readonly providerTerminationReason?: string;
  readonly checkResults: readonly AgentCheckResult[];
  readonly budget: AgentRunBudgetState;
  readonly exhaustedLimit?: AgentLimitKind;
  readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string };
}>;
export type AgentCompletedTerminalSnapshot = AgentTerminalBase & Readonly<{
  readonly executionStatus: 'completed';
  readonly candidate: AgentPresentCandidate;
  readonly verificationStatus: AgentCompletedVerificationStatus;
  readonly terminationReason: AgentCompletedTerminationReason;
  readonly errorMessage?: never;
}>;
export type AgentFailedTerminalSnapshot = AgentTerminalBase & Readonly<{
  readonly executionStatus: 'failed';
  readonly candidate: AgentCandidate;
  readonly verificationStatus: 'not_run';
  readonly terminationReason: AgentFailureTerminationReason;
  readonly errorMessage: string;
}>;
export type AgentAbortedTerminalSnapshot = AgentTerminalBase & Readonly<{
  readonly executionStatus: 'aborted';
  readonly candidate: AgentAbsentCandidate | (AgentPresentCandidate & { readonly status: 'partial' });
  readonly verificationStatus: 'not_run';
  readonly terminationReason: 'aborted';
  readonly errorMessage: string;
}>;
export type AgentTerminalSnapshot = AgentCompletedTerminalSnapshot | AgentFailedTerminalSnapshot | AgentAbortedTerminalSnapshot;
export interface AgentDeliveryDiagnostic { readonly eventType: string; readonly message: string; readonly persisted: boolean }
export interface AgentEndedRunResult {
  readonly state: 'ended';
  readonly terminal: AgentTerminalSnapshot;
  readonly deliveryDiagnostics: readonly AgentDeliveryDiagnostic[];
}
export type AgentRunResult = AgentApprovalSuspension | AgentOperationSuspension | AgentEndedRunResult;

export class AgentContractError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(`${message}${issues.length > 0 ? ` ${issues.join(' ')}` : ''}`);
    this.name = 'AgentContractError';
    this.issues = Object.freeze([...issues]);
  }
}

export function validateAgentRunLimits(input: Partial<AgentRunLimits> = {}): AgentRunLimits {
  const limits: AgentRunLimits = { ...DEFAULT_AGENT_RUN_LIMITS, ...input, knownCost: { ...DEFAULT_AGENT_RUN_LIMITS.knownCost, ...(input.knownCost ?? {}) } };
  const fields: (keyof Omit<AgentRunLimits, 'knownCost'>)[] = [
    'maxConcurrentToolCalls', 'modelTurns', 'totalToolCalls', 'repeatedIdenticalToolCalls', 'elapsedMs', 'promptTokens',
    'completionTokens', 'activeImageCount', 'activeImageBytes', 'activeImageTokens',
    'consecutiveProviderFailures', 'consecutiveToolFailures', 'providerRetries'
  ];
  const issues = fields.flatMap((field) => positiveInteger(limits[field]) ? [] : [`${field} must be a positive finite integer.`]);
  if (!Number.isFinite(limits.knownCost.amount) || limits.knownCost.amount <= 0) issues.push('knownCost.amount must be positive and finite.');
  if (limits.knownCost.currency.trim().length === 0) issues.push('knownCost.currency must be non-empty.');
  if (issues.length > 0) throw new AgentContractError('Invalid run limits.', issues);
  return Object.freeze({ ...limits, knownCost: Object.freeze({ ...limits.knownCost }) });
}

export function validateAgentCheckDefinitions(definitions: readonly AgentCheckDefinition[] | undefined): readonly AgentCheckDefinition[] {
  const output = definitions ?? [];
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const [index, definition] of output.entries()) {
    const id = definition.id;
    const label = id.length > 0 ? id : String(index);
    if (id.trim().length === 0) issues.push(`Check at index ${String(index)} has an empty id.`);
    else if (ids.has(id)) issues.push(`Duplicate check id: ${id}.`);
    else ids.add(id);
    if (definition.timeoutMs !== undefined && !positiveInteger(definition.timeoutMs)) issues.push(`Check ${label} timeoutMs must be a positive finite integer.`);
  }
  if (issues.length > 0) throw new AgentContractError('Invalid check definitions.', issues);
  return Object.freeze([...output]);
}

export function deriveAgentVerificationStatus(
  definitions: readonly Pick<AgentCheckDefinition, 'id' | 'requirement'>[],
  results: readonly AgentCheckResult[]
): AgentCompletedVerificationStatus {
  if (definitions.length === 0) return 'not_required';
  const byId = new Map(results.map((result) => [result.id, result]));
  const required = definitions.filter((definition) => definition.requirement === 'required');
  if (required.length === 0) return 'not_required';
  if (required.some((definition) => byId.get(definition.id)?.verdict === 'failed')) return 'failed';
  if (required.some((definition) => byId.get(definition.id)?.verdict !== 'passed')) return 'inconclusive';
  return 'passed';
}

export function decodeOwnedAgentCandidate(value: JsonObject): AgentCandidate {
  if (typeof value.status !== 'string') throw contract('Invalid candidate.', ['Candidate must be a discriminated object.']);
  if (value.status === 'absent') {
    if (Object.keys(value).some((key) => key !== 'status')) throw contract('Invalid absent candidate.', ['Absent candidates cannot carry message, source, or turnIndex.']);
    return Object.freeze({ status: 'absent' });
  }
  if (!oneOf(value.status, ['complete', 'partial', 'indeterminate'])) throw contract('Invalid candidate.', ['Unsupported candidate status.']);
  if (typeof value.message !== 'string' || value.message.trim().length === 0) throw contract('Invalid candidate.', ['Candidate message must be non-empty.']);
  if (!oneOf(value.source, ['content', 'reasoning_summary', 'stream_recovery'])) throw contract('Invalid candidate.', ['Unsupported candidate source.']);
  if (!positiveInteger(value.turnIndex)) throw contract('Invalid candidate.', ['Candidate turnIndex must be a positive integer.']);
  if (value.source === 'stream_recovery' && value.status !== 'partial') throw contract('Invalid candidate.', ['Stream recovery candidates must be partial.']);
  return Object.freeze({ status: value.status, message: value.message, source: value.source, turnIndex: value.turnIndex });
}

export function parseAgentCheckResult(value: unknown, measuredDurationMs?: number): AgentCheckResult {
  return decodeOwnedAgentCheckResult(parseJsonObject(value), measuredDurationMs);
}

export function decodeOwnedAgentCheckResult(object: JsonObject, measuredDurationMs?: number): AgentCheckResult {
  const issues: string[] = [];
  const id = typeof object.id === 'string' && object.id.trim().length > 0 ? object.id : undefined;
  const requirement = oneOf(object.requirement, ['required', 'advisory']) ? object.requirement : undefined;
  const verdict = oneOf(object.verdict, ['passed', 'failed', 'unknown']) ? object.verdict : undefined;
  const summary = typeof object.summary === 'string' && object.summary.trim().length > 0 ? object.summary : undefined;
  const rawDurationMs = measuredDurationMs ?? object.durationMs;
  const durationMs = typeof rawDurationMs === 'number' && Number.isFinite(rawDurationMs) && rawDurationMs >= 0 ? rawDurationMs : undefined;
  if (!id) issues.push('id must be non-empty.');
  if (!requirement) issues.push('requirement is invalid.');
  if (!verdict) issues.push('verdict is invalid.');
  if (!summary) issues.push('summary must be non-empty.');
  if (durationMs === undefined) issues.push('durationMs must be finite and nonnegative.');
  const artifacts = object.artifacts === undefined ? undefined : Array.isArray(object.artifacts) && object.artifacts.every(isArtifactRef) ? Object.freeze([...object.artifacts]) : undefined;
  if (object.artifacts !== undefined && !artifacts) issues.push('artifacts are invalid.');
  const diagnostic = object.diagnostic === undefined ? undefined : isCheckDiagnostic(object.diagnostic) ? object.diagnostic : undefined;
  if (object.diagnostic !== undefined && !diagnostic) issues.push('diagnostic is invalid.');
  const outputNormalization = object.outputNormalization === undefined ? undefined : decodeNormalizationDiagnostics(object.outputNormalization);
  if (object.outputNormalization !== undefined && !outputNormalization) issues.push('outputNormalization is invalid.');
  if (issues.length > 0) throw contract('Invalid check result.', issues);
  if (!id || !requirement || !verdict || !summary || durationMs === undefined) throw contract('Invalid check result.', issues);
  return Object.freeze({ id, requirement, verdict, summary, durationMs,
    ...(object.output !== undefined ? { output: object.output } : {}),
    ...(outputNormalization ? { outputNormalization } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(diagnostic ? { diagnostic } : {})
  });
}

export function createAgentTerminalSnapshot(value: AgentTerminalSnapshot): AgentTerminalSnapshot {
  const issues: string[] = [];
  if (!validIdentity(value.runId)) issues.push('runId must be non-empty and at most 256 UTF-8 bytes.');
  if (!validIdentity(value.finalizationId)) issues.push('finalizationId must be non-empty and at most 256 UTF-8 bytes.');
  if (!Number.isInteger(value.turnCount) || value.turnCount < 0) issues.push('turnCount must be a nonnegative integer.');
  if (value.executionStatus === 'completed') issues.push(...completedCandidateIssues(value.terminationReason, value.candidate.status));
  if (value.terminationReason === 'limit_exhausted' && value.exhaustedLimit === undefined) issues.push('limit_exhausted requires exhaustedLimit.');
  if (value.terminationReason !== 'limit_exhausted' && value.exhaustedLimit !== undefined) issues.push('exhaustedLimit is only legal for limit_exhausted.');
  issues.push(...modelTerminationIssues({
    terminationReason: value.terminationReason,
    ...(value.modelTerminationReason !== undefined ? { modelTerminationReason: value.modelTerminationReason } : {}),
    ...(value.providerTerminationReason !== undefined ? { providerTerminationReason: value.providerTerminationReason } : {})
  }));
  if (issues.length > 0) throw contract('Invalid terminal snapshot.', issues);
  const checkResults = Object.freeze([...value.checkResults]);
  const budget = Object.freeze({ ...value.budget, knownCosts: Object.freeze({ ...value.budget.knownCosts }) });
  const cleanup = value.cleanupDiagnostic ? { cleanupDiagnostic: Object.freeze({ ...value.cleanupDiagnostic }) } : {};
  if (value.executionStatus === 'completed') return Object.freeze({ ...value, candidate: Object.freeze({ ...value.candidate }), checkResults, budget, ...cleanup });
  if (value.executionStatus === 'failed') return Object.freeze({ ...value, candidate: Object.freeze({ ...value.candidate }), checkResults, budget, ...cleanup });
  return Object.freeze({ ...value, candidate: Object.freeze({ ...value.candidate }), checkResults, budget, ...cleanup });
}

export function decodeAgentTerminalSnapshot(value: unknown): AgentTerminalSnapshot {
  return decodeOwnedAgentTerminalSnapshot(parseJsonObject(value));
}

export function decodeOwnedAgentTerminalSnapshot(value: JsonObject): AgentTerminalSnapshot {
  const issues = terminalBaseIssues(value);
  let candidate: AgentCandidate | undefined;
  try {
    const candidateValue = value.candidate;
    if (candidateValue === undefined || !isJsonObject(candidateValue)) throw contract('Invalid candidate.', ['Candidate must be a discriminated object.']);
    candidate = decodeOwnedAgentCandidate(candidateValue);
  } catch (error) { issues.push(errorMessage(error)); }
  const checkResults: AgentCheckResult[] = [];
  if (!isJsonArray(value.checkResults)) issues.push('checkResults must be an array.');
  else for (const result of value.checkResults) {
    try {
      if (!isJsonObject(result)) throw contract('Invalid check result.', ['Check result must be an object.']);
      checkResults.push(decodeOwnedAgentCheckResult(result));
    } catch (error) { issues.push(errorMessage(error)); }
  }
  const budget = isBudgetState(value.budget) ? value.budget : undefined;
  if (!budget) issues.push('budget is invalid.');
  if (value.executionStatus === 'completed') {
    if (!candidate || candidate.status === 'absent') issues.push('Completed execution requires a present candidate.');
    if (!oneOf(value.verificationStatus, ['not_required', 'passed', 'failed', 'inconclusive'])) issues.push('Completed execution has an invalid verification status.');
    if (!oneOf(value.terminationReason, ['model_completed', 'model_output_limit', 'content_filtered', 'unknown_model_termination'])) issues.push('Completed execution has an invalid termination reason.');
    if (candidate && candidate.status !== 'absent') issues.push(...completedCandidateIssues(value.terminationReason, candidate.status));
    if (value.errorMessage !== undefined) issues.push('Completed execution cannot have errorMessage.');
  } else if (value.executionStatus === 'failed') {
    if (value.verificationStatus !== 'not_run') issues.push('Failed execution must use verificationStatus not_run.');
    if (!oneOf(value.terminationReason, FAILURE_REASONS)) issues.push('Failed execution has an invalid termination reason.');
    if (typeof value.errorMessage !== 'string' || value.errorMessage.trim().length === 0) issues.push('Failed execution requires errorMessage.');
  } else if (value.executionStatus === 'aborted') {
    if (candidate && candidate.status !== 'absent' && candidate.status !== 'partial') issues.push('Aborted execution can only preserve a partial candidate.');
    if (value.verificationStatus !== 'not_run' || value.terminationReason !== 'aborted') issues.push('Aborted execution must use aborted/not_run.');
    if (typeof value.errorMessage !== 'string' || value.errorMessage.trim().length === 0) issues.push('Aborted execution requires errorMessage.');
  } else issues.push('executionStatus is invalid.');
  if (value.terminationReason === 'limit_exhausted' && !oneOf(value.exhaustedLimit, AGENT_LIMIT_KINDS)) issues.push('limit_exhausted requires exhaustedLimit.');
  if (value.terminationReason !== 'limit_exhausted' && value.exhaustedLimit !== undefined) issues.push('exhaustedLimit is only legal for limit_exhausted.');
  if (value.cleanupDiagnostic !== undefined && (!isRecord(value.cleanupDiagnostic) || value.cleanupDiagnostic.kind !== 'process_cleanup' || typeof value.cleanupDiagnostic.message !== 'string' || value.cleanupDiagnostic.message.length === 0)) issues.push('cleanupDiagnostic is invalid.');
  issues.push(...modelTerminationIssues(value));
  if (issues.length > 0) throw contract('Invalid terminal snapshot.', issues);
  if (!candidate) throw contract('Invalid terminal snapshot.', ['candidate is invalid.']);
  if (!budget) throw contract('Invalid terminal snapshot.', ['budget is invalid.']);
  const base = {
    runId: value.runId as string,
    finalizationId: value.finalizationId as string,
    phase: 'ended' as const,
    turnCount: value.turnCount as number,
    candidate,
    checkResults: Object.freeze(checkResults),
    budget,
    ...(value.modelTerminationReason !== undefined ? { modelTerminationReason: value.modelTerminationReason as ModelTerminationReason } : {}),
    ...(typeof value.providerTerminationReason === 'string' ? { providerTerminationReason: value.providerTerminationReason } : {}),
    ...(value.exhaustedLimit !== undefined ? { exhaustedLimit: value.exhaustedLimit as AgentLimitKind } : {}),
    ...(value.cleanupDiagnostic !== undefined ? { cleanupDiagnostic: value.cleanupDiagnostic as { readonly kind: 'process_cleanup'; readonly message: string } } : {})
  };
  if (value.executionStatus === 'completed') return Object.freeze({
    ...base,
    executionStatus: 'completed',
    candidate: candidate as AgentPresentCandidate,
    verificationStatus: value.verificationStatus as AgentCompletedVerificationStatus,
    terminationReason: value.terminationReason as AgentCompletedTerminationReason
  });
  if (value.executionStatus === 'failed') return Object.freeze({
    ...base,
    executionStatus: 'failed',
    verificationStatus: 'not_run',
    terminationReason: value.terminationReason as AgentFailureTerminationReason,
    errorMessage: value.errorMessage as string
  });
  return Object.freeze({
    ...base,
    executionStatus: 'aborted',
    candidate: candidate as AgentAbortedTerminalSnapshot['candidate'],
    verificationStatus: 'not_run',
    terminationReason: 'aborted',
    errorMessage: value.errorMessage as string
  });
}

export function terminalSnapshotFingerprint(snapshot: AgentTerminalSnapshot): string { return canonicalJsonString(snapshot); }
const AGENT_LIMIT_KINDS: readonly AgentLimitKind[] = [
  'model_turns', 'total_tool_calls', 'repeated_tool_calls', 'elapsed_time', 'prompt_tokens',
  'completion_tokens', 'known_cost', 'consecutive_provider_failures', 'consecutive_tool_failures', 'provider_retries'
];
const FAILURE_REASONS: readonly AgentFailureTerminationReason[] = [
  'model_output_limit', 'content_filtered', 'unknown_model_termination', 'empty_response', 'malformed_response',
  'provider_error', 'runtime_error', 'stream_interrupted', 'request_too_large', 'limit_exhausted', 'uncertain_tool_effect'
];
function terminalBaseIssues(value: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (!validIdentity(value.runId)) issues.push('runId must be non-empty and at most 256 UTF-8 bytes.');
  if (!validIdentity(value.finalizationId)) issues.push('finalizationId must be non-empty and at most 256 UTF-8 bytes.');
  if (value.phase !== 'ended') issues.push('Terminal phase must be ended.');
  if (typeof value.turnCount !== 'number' || !Number.isInteger(value.turnCount) || value.turnCount < 0) issues.push('turnCount must be a nonnegative integer.');
  if (value.modelTerminationReason !== undefined && !oneOf(value.modelTerminationReason, ['stop', 'tool_calls', 'output_limit', 'content_filter', 'unknown'])) issues.push('modelTerminationReason is invalid.');
  if (value.providerTerminationReason !== undefined && typeof value.providerTerminationReason !== 'string') issues.push('providerTerminationReason must be a string.');
  return issues;
}
function modelTerminationIssues(value: Record<string, unknown>): string[] {
  const mapping: Partial<Record<string, ModelTerminationReason>> = {
    model_completed: 'stop', model_output_limit: 'output_limit', content_filtered: 'content_filter', unknown_model_termination: 'unknown'
  };
  const expected = typeof value.terminationReason === 'string' ? mapping[value.terminationReason] : undefined;
  return expected !== undefined && value.modelTerminationReason !== expected ? [`${String(value.terminationReason)} requires modelTerminationReason ${expected}.`] : [];
}
function completedCandidateIssues(terminationReason: unknown, candidateStatus: AgentPresentCandidate['status']): string[] {
  const expected: Partial<Record<AgentCompletedTerminationReason, AgentPresentCandidate['status']>> = {
    model_completed: 'complete',
    model_output_limit: 'partial',
    content_filtered: 'partial',
    unknown_model_termination: 'indeterminate'
  };
  const status = isCompletedTerminationReason(terminationReason) ? expected[terminationReason] : undefined;
  return status !== undefined && candidateStatus !== status
    ? [`${String(terminationReason)} requires candidate status ${status}.`]
    : [];
}
function isBudgetState(value: unknown): value is AgentRunBudgetState {
  if (!isRecord(value)) return false;
  const names = ['modelTurns', 'totalToolCalls', 'repeatedIdenticalToolCalls', 'elapsedMs', 'promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'unknownPricedTokens', 'consecutiveProviderFailures', 'consecutiveToolFailures', 'providerRetries'];
  if (!names.every((name) => typeof value[name] === 'number' && Number.isFinite(value[name]) && Number.isInteger(value[name]) && (value[name]) >= 0)) return false;
  return finiteNonnegativeNumberRecord(value.knownCosts)
    && oneOf(value.pricingStatus, ['known', 'partial', 'unknown']);
}
function isCheckDiagnostic(value: unknown): value is AgentCheckDiagnostic {
  return isRecord(value) && oneOf(value.kind, ['exception', 'timeout', 'unavailable', 'permission_denied', 'aborted', 'invalid_result'])
    && typeof value.message === 'string';
}
function decodeNormalizationDiagnostics(value: JsonValue): readonly JsonNormalizationDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics: JsonNormalizationDiagnostic[] = [];
  for (const item of value) {
    if (!isRecord(item) || !NORMALIZATION_CODES.has(String(item.code)) || typeof item.path !== 'string' || typeof item.message !== 'string') return undefined;
    diagnostics.push(Object.freeze({ code: item.code as JsonNormalizationDiagnostic['code'], path: item.path, message: item.message }));
  }
  return Object.freeze(diagnostics);
}
const NORMALIZATION_CODES = new Set(['access_error', 'accessor', 'bigint', 'binary', 'circular', 'collection_truncated', 'depth_truncated', 'error', 'function', 'invalid_date', 'symbol', 'text_truncated', 'total_bytes_truncated', 'unsupported']);
function isArtifactRef(value: unknown): value is ArtifactRef {
  return isRecord(value) && typeof value.artifactId === 'string' && typeof value.sha256 === 'string'
    && typeof value.size === 'number' && Number.isInteger(value.size) && value.size >= 0 && typeof value.mediaType === 'string';
}
function finiteNonnegativeNumberRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => 'value' in descriptor && typeof descriptor.value === 'number' && Number.isFinite(descriptor.value) && descriptor.value >= 0);
}
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0; }
function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 256; }
function isCompletedTerminationReason(value: unknown): value is AgentCompletedTerminationReason { return oneOf(value, ['model_completed', 'model_output_limit', 'content_filtered', 'unknown_model_termination']); }
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.some((candidate) => candidate === value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isJsonObject(value: JsonValue): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] { return Array.isArray(value); }
function contract(message: string, issues: string[]): AgentContractError { return new AgentContractError(message, issues); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
