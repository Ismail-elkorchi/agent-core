import { randomUUID } from 'node:crypto';
import { type ContextHistoryReduction, decodeContextItemInput, type ContextItemInput, ContextManager } from './context/manager.js';
import { hashJson, type EventAppendReceipt } from '@agent-core/evidence';
import { normalizeJsonSafe, parseJsonValue } from '@agent-core/json';
import {
  UNKNOWN_EFFECT_RECOVERY,
  closeExternalEffect,
  decodeEffectRecoveryCapability,
  issueEffectStartTicket,
  knownEffectExposure,
  settleExternalEffect,
  startExternalEffect,
  unknownEffectExposure,
  type EffectExposureQuantity,
  type EffectExposureReservation
} from '@agent-core/effects';
import {
  createModelRequest,
  ModelContractError,
  type ModelProfile,
  type ModelProvider,
  type ModelProviderErrorDiagnostic,
  type ModelProviderSession,
  type ModelReasoningRequest,
  type ModelRequest,
  type ModelResponse,
  type ModelResponseFormat,
  type ModelUsage,
  SimpleTokenEstimator,
  parseModelProfile,
  parseModelResponse,
  parseModelStreamEvent,
  type TokenEstimator
} from '@agent-core/model';
import { compilePromptProjection, type PromptInstruction } from './context/prompt.js';
import {
  deriveAgentVerificationStatus,
  createAgentTerminalSnapshot,
  validateAgentCheckDefinitions,
  type AgentCandidate,
  type AgentApprovalRequest,
  type AgentClock,
  type AgentCheckDefinition,
  type AgentCheckResult,
  type AgentEffectiveInstruction,
  type AgentExactRequestRecord,
  type AgentPresentCandidate,
  type AgentRequestSnapshotRecord,
  type AgentRunLimits,
  type AgentRunResult,
  type AgentTerminalSnapshot,
  type AgentTurnIdentity,
  type AgentTurnSnapshotRecord,
  type AgentVerificationExecutionContext
} from './run/contracts.js';
import {
  isToolAvailable,
  isCommandExecution,
  prepareToolCall,
  releasePreparedToolCall,
  parseToolPolicy,
  READ_ONLY_TOOL_POLICY,
  ResourceLeaseCoordinator,
  toolRequirementsSatisfied,
  ToolRegistry,
  type ToolAuthorizer,
  type ToolCall,
  type CompiledToolDefinition,
  type ToolAuthorizationBoundary,
  type ToolExecutionContext,
  type ToolPreparationContext,
  type ToolPolicy,
  type CommandExecution
} from '@agent-core/tools';
import { encodeAgentEvent, type AgentAuditEvent, type AgentEvent, type AgentProgressEvent } from './events.js';
import type { AgentRuntimeRepositories } from './ports.js';
import { BudgetAccountant, type RequestCostEstimate, type RequestWindow } from './orchestration/budget-accountant.js';
import { AgentVerificationAbortedError, runAgentChecks } from './orchestration/checks.js';
import { contextEvidenceExecution } from './orchestration/context-evidence.js';
import { summarizeModelRequest, summarizeModelResponse, summarizeProviderState, summarizeRunConfiguration } from './orchestration/event-summaries.js';
import { AgentRunFinalizer } from './orchestration/finalization.js';
import {
  estimatePromptScaffoldTokens,
  finalMessageFromResponse,
  modelToolCallFromToolCall,
  normalizeModelToolCall,
  normalizeStreamedFinalResponse,
  promptInstructionsForRequest,
  promptToolSpecs,
  providerFailureDiagnostic,
  requestWindowForModel,
  supportsParameter,
  toolsForModel,
  validateModelRun,
  validateOptionalPositiveInteger
} from './orchestration/model-request.js';
import { ModelStreamInterruptedError } from './orchestration/model-stream.js';
import { ObservationStore } from './orchestration/observation-store.js';
import {
  OVERFLOW_RECOVERY_STAGES,
  createOverflowDiagnostic,
  type OverflowDiagnostic,
  type OverflowRecoveryAction,
  type OverflowRecoveryResult,
  type OverflowRecoveryStage
} from './orchestration/overflow-recovery.js';
import { readProviderStateArtifact, storeProviderStateArtifact } from './orchestration/provider-state-artifacts.js';
import { AgentLimitExceededError, AgentRunController } from './orchestration/run-controller.js';
import { rebuildContextFromRepositories } from './orchestration/session-replay.js';
import { executeAssistantToolCalls, type ToolAuthorizationOverride, type ToolCallRecoveryState } from './orchestration/tool-execution.js';
import { AgentOperationCoordinator, type AgentOperationAdvance, type AgentOperationDriver } from './operation/driver.js';
import { nextAgentOperationInstruction, type AgentOperationProcedure } from './operation/contracts.js';

export type {
  AgentCheckContext,
  AgentCheckDefinition,
  AgentCheckObservation,
  AgentCheckRequirement,
  AgentCheckResult,
  AgentCheckVerdict,
  AgentVerificationStatus
} from './run/contracts.js';

export interface AgentInstruction {
  readonly id: string;
  readonly content: string;
  readonly role?: PromptInstruction['role'];
  readonly sourceUri?: string;
  readonly priority?: number;
}

export interface AgentContextRequest {
  readonly task: string;
  readonly turnIndex: number;
  readonly instructions: readonly AgentEffectiveInstruction[];
}

export type AgentContextProvider = (request: AgentContextRequest) => readonly ContextItemInput[] | Promise<readonly ContextItemInput[]>;

export interface AgentRuntimeOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly repositories: AgentRuntimeRepositories;
  readonly tools?: readonly CompiledToolDefinition[];
  readonly toolBoundary: ToolAuthorizationBoundary;
  readonly toolContext?: Omit<ToolExecutionContext, 'policy' | 'signal'>;
  readonly toolResourceLeases?: ResourceLeaseCoordinator;
  readonly toolPolicy?: ToolPolicy;
  readonly toolAuthorizer?: ToolAuthorizer;
  readonly instructions?: readonly AgentInstruction[];
  readonly contextItems?: readonly ContextItemInput[];
  readonly contextProvider?: AgentContextProvider;
  readonly checks?: readonly AgentCheckDefinition[];
  readonly verification?: AgentVerificationExecutionContext;
  readonly estimator?: TokenEstimator;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly responseFormat?: ModelResponseFormat;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly limits?: Partial<AgentRunLimits>;
  readonly clock?: AgentClock;
  readonly onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
  readonly recordRequest?: (record: AgentExactRequestRecord) => void | Promise<void>;
}

export interface AgentRunInput {
  readonly task: string;
  readonly runId?: string;
  readonly finalizationId?: string;
  readonly instructions?: readonly string[];
  readonly contextItems?: readonly ContextItemInput[];
  readonly signal?: AbortSignal;
}
type ResolvedAgentRunInput = AgentRunInput & { readonly runId: string; readonly finalizationId: string };

export interface AgentSteeringInput { readonly instruction: string }
export interface AgentSteeringReceipt { readonly id: string; readonly runId: string; readonly timestamp: string }
export interface AgentRunControl {
  readonly runId: string;
  injectSteering(input: AgentSteeringInput): AgentSteeringReceipt;
  abort(reason?: string): Promise<void>;
  readonly result: Promise<AgentRunResult>;
}

interface RuntimeModelConfiguration {
  readonly model: string;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly responseFormat?: ModelResponseFormat;
}

interface TurnSnapshot {
  readonly record: AgentTurnSnapshotRecord;
  readonly profile: ModelProfile;
  readonly requestWindow: RequestWindow;
  readonly budgetAccountant: BudgetAccountant;
  readonly tools: readonly CompiledToolDefinition[];
  readonly configuration: RuntimeModelConfiguration;
  readonly instructions: readonly AgentEffectiveInstruction[];
}

interface ResolvedContextInputs {
  readonly configured: readonly ContextItemInput[];
  readonly provider: readonly ContextItemInput[];
  readonly run: readonly ContextItemInput[];
}

interface AssistantTurnRequest {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly runNotes: readonly string[];
  readonly turnIndex: number;
  readonly toolBatchId: string;
  readonly snapshot: TurnSnapshot;
  readonly modelSession: ModelProviderSession;
  readonly signal: AbortSignal;
  readonly contextManager: ContextManager;
  readonly controller: AgentRunController;
  readonly operation: AgentOperationDriver;
}

type AssistantTurnResult =
  | { readonly kind: 'settled'; readonly response: ModelResponse; readonly toolCalls: readonly ToolCall[]; readonly candidate: AgentCandidate }
  | { readonly kind: 'outcome_unknown'; readonly effectId: string };
type CompletedModelAttempt =
  | { readonly kind: 'settled'; readonly response: ModelResponse; readonly identity: AgentTurnIdentity }
  | { readonly kind: 'outcome_unknown'; readonly effectId: string };
type RequestAssemblyResult = { readonly ok: true; readonly request: ModelRequest; readonly estimate: RequestCostEstimate; readonly snapshot: AgentRequestSnapshotRecord } | { readonly ok: false; readonly diagnostic: OverflowDiagnostic };

type TerminalDecision =
  | { readonly executionStatus: 'completed'; readonly terminationReason: 'model_completed' | 'model_output_limit' | 'content_filtered' | 'unknown_model_termination'; readonly candidate: AgentPresentCandidate; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly modelTerminationReason: ModelResponse['terminationReason']; readonly providerTerminationReason?: string; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } }
  | { readonly executionStatus: 'failed'; readonly terminationReason: 'model_output_limit' | 'content_filtered' | 'unknown_model_termination' | 'empty_response' | 'malformed_response' | 'provider_error' | 'runtime_error' | 'stream_interrupted' | 'request_too_large' | 'limit_exhausted' | 'uncertain_tool_effect'; readonly candidate: AgentCandidate; readonly errorMessage: string; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly modelTerminationReason?: ModelResponse['terminationReason']; readonly providerTerminationReason?: string; readonly exhaustedLimit?: AgentLimitExceededError['limit']; readonly diagnostic?: ModelProviderErrorDiagnostic & { readonly turnIndex?: number }; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } }
  | { readonly executionStatus: 'aborted'; readonly terminationReason: 'aborted'; readonly candidate: AgentCandidate; readonly errorMessage: string; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly diagnostic?: ModelProviderErrorDiagnostic & { readonly turnIndex?: number }; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } };
type ExecutionDecision = TerminalDecision
  | { readonly executionStatus: 'waiting_for_approval'; readonly approvals: readonly AgentApprovalRequest[] }
  | { readonly executionStatus: 'waiting_for_recovery'; readonly reason: 'provider_outcome_unknown'; readonly effectId: string };

interface ToolResumeExecutionState {
  readonly kind: 'tool';
  readonly identity: AgentTurnIdentity;
  readonly toolBatchId: string;
  readonly toolCalls: readonly ToolCall[];
  readonly overrides: readonly ToolAuthorizationOverride[];
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly budget: import('./run/contracts.js').AgentRunBudgetState;
  readonly approvalIds: readonly string[];
  readonly callHistory: readonly ToolCall[];
  readonly recovery: readonly ToolCallRecoveryState[];
}
interface ProviderResumeExecutionState {
  readonly kind: 'provider';
  readonly identity: AgentTurnIdentity;
  readonly toolBatchId: string;
  readonly response: ModelResponse;
  readonly providerState?: import('./events.js').AgentProviderStateReference;
  readonly turnSnapshot: AgentTurnSnapshotRecord;
  readonly requestEstimate: RequestCostEstimate;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly budget: import('./run/contracts.js').AgentRunBudgetState;
  readonly callHistory: readonly ToolCall[];
}
type ResumeExecutionState = ToolResumeExecutionState | ProviderResumeExecutionState;
interface RunExecutionRuntime {
  readonly runId: string;
  readonly input: ResolvedAgentRunInput;
  readonly signal: AbortSignal;
  readonly controller: AgentRunController;
  readonly resume?: ResumeExecutionState;
  readonly restoring?: boolean;
  readonly operation: AgentOperationDriver;
  readonly append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<EventAppendReceipt>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}

interface RunFailureContext {
  readonly lastStartedTurnIndex: number;
  readonly activeCandidate: AgentCandidate;
  readonly checkResults: readonly AgentCheckResult[];
  readonly activeTurnIdentity?: AgentTurnIdentity;
}

class AgentExecutionError extends Error {
  constructor(override readonly cause: unknown, readonly context: RunFailureContext) {
    super(errorMessage(cause));
    this.name = 'AgentExecutionError';
  }
}

export class AgentRuntime {
  private readonly estimator: TokenEstimator;
  private readonly maxOutputTokens: number | undefined;
  private readonly toolPolicy: ToolPolicy;
  private readonly tools: readonly CompiledToolDefinition[];
  private readonly resourceLeases: ResourceLeaseCoordinator;
  private readonly checks: readonly AgentCheckDefinition[];
  private readonly commandExecution: CommandExecution | undefined;
  private readonly steerQueue: (AgentSteeringReceipt & { readonly instruction: string })[] = [];
  private activeAbortController: AbortController | undefined;
  private activeRunId: string | undefined;
  private activeOperations: AgentOperationCoordinator | undefined;
  private activeOperationDriver: AgentOperationDriver | undefined;
  private activeOperationReady: Promise<void> | undefined;
  private activeAbortRequest: Promise<void> | undefined;
  private static readonly MAX_STEERING_ITEMS = 1024;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.estimator = options.estimator ?? new SimpleTokenEstimator();
    this.maxOutputTokens = validateOptionalPositiveInteger(options.maxOutputTokens, 'maxOutputTokens');
    this.toolPolicy = parseToolPolicy(options.toolPolicy ?? READ_ONLY_TOOL_POLICY);
    this.tools = Object.freeze(new ToolRegistry(options.tools ?? []).list());
    const configuredCommandExecution = options.toolContext?.services?.commandExecution;
    if (configuredCommandExecution !== undefined && !isCommandExecution(configuredCommandExecution)) {
      throw new TypeError('AgentRuntime requires an adopted CommandExecution service.');
    }
    this.commandExecution = configuredCommandExecution;
    this.resourceLeases = options.toolResourceLeases
      ?? this.commandExecution?.resourceLeases
      ?? new ResourceLeaseCoordinator();
    validateToolBoundary(options.toolBoundary);
    this.checks = validateAgentCheckDefinitions(options.checks);
  }

  run(input: AgentRunInput): AgentRunControl {
    const runId = input.runId ?? randomUUID();
    const finalizationId = input.finalizationId ?? randomUUID();
    return this.startRun({ ...input, runId, finalizationId });
  }

  inspectOperation(runId: string) {
    return new AgentOperationCoordinator(this.options.repositories.events).inspect(runId);
  }

  resume(runId: string, signal?: AbortSignal): AgentRunControl {
    if (this.activeAbortController) throw new Error('AgentRuntime already has an active run.');
    const operations = new AgentOperationCoordinator(this.options.repositories.events);
    const abortController = new AbortController();
    const operationReady = Promise.resolve();
    this.activeAbortController = abortController;
    this.activeRunId = runId;
    this.activeOperations = operations;
    this.activeOperationReady = operationReady;
    const result = this.resumeActive(runId, signal, operations, abortController, operationReady);
    return Object.freeze({
      runId,
      injectSteering: (steering: AgentSteeringInput) => this.injectSteering(runId, steering),
      abort: (reason?: string) => this.scheduleAbortRun(runId, reason),
      result
    });
  }

  async resumeApproval(input: { readonly runId: string; readonly approvalId: string; readonly fingerprint: string; readonly decision: 'allow' | 'deny'; readonly signal?: AbortSignal }): Promise<AgentRunControl> {
    const records: AgentEvent[] = [];
    for await (const envelope of this.options.repositories.events.read(input.runId)) records.push(envelope.event);
    const committed = [...records].reverse().find((event): event is Extract<AgentEvent, { type: 'run.ended' }> => event.type === 'run.ended');
    if (committed) {
      const deliveryDiagnostics = records.flatMap((event) => event.type === 'delivery.failed' ? [event.diagnostic] : []);
      return completedRunControl(input.runId, Object.freeze({ state: 'ended', terminal: committed.terminal, deliveryDiagnostics: Object.freeze(deliveryDiagnostics) }));
    }
    const started = records.find((event): event is Extract<AgentEvent, { type: 'run.started' }> => event.type === 'run.started');
    if (!started) throw new Error(`Cannot resume unknown run: ${input.runId}.`);
    const requests = records.filter((event): event is Extract<AgentEvent, { type: 'approval.requested' }> => event.type === 'approval.requested');
    const target = requests.find((request) => request.approvalId === input.approvalId);
    if (!target) throw new Error(`Unknown approval ${input.approvalId} for run ${input.runId}.`);
    if (target.fingerprint !== input.fingerprint) throw new Error(`Approval fingerprint mismatch for ${input.approvalId}.`);
    if (target.binding.authorizationPolicyId !== this.options.toolBoundary.authorizationPolicyId || target.binding.executionTargetId !== this.options.toolBoundary.executionTargetId) {
      throw new Error(`Approval boundary changed for ${input.approvalId}; a new approval is required.`);
    }
    const assistant = [...records].reverse().find((event): event is Extract<AgentEvent, { type: 'assistant.ended' }> => event.type === 'assistant.ended' && event.turnId === target.turnId);
    const currentCall = assistant?.toolCalls?.[target.callIndex];
    if (!currentCall) throw new Error(`Approval ${input.approvalId} has no persisted assistant tool call.`);
    const authorizationContext = this.toolContext(input.signal ?? new AbortController().signal);
    const currentPreparation = await prepareToolCall(currentCall, this.tools, authorizationContext);
    if (!currentPreparation.ok) throw new Error(`Approved tool call is no longer valid: ${currentPreparation.observation.summary}`);
    const preparation = currentPreparation.prepared;
    let validationFailure: unknown;
    try {
      if (preparation.toolImplementationId !== target.binding.toolImplementationId) throw new Error(`Approved tool implementation changed for ${input.approvalId}; a new approval is required.`);
      if (preparation.fingerprint !== target.fingerprint) throw new Error(`Approval fingerprint changed for ${input.approvalId}; a new approval is required.`);
    } catch (error) {
      validationFailure = error;
    }
    try {
      await releasePreparedToolCall(preparation);
    } catch (releaseFailure) {
      if (validationFailure !== undefined) throw new AggregateError([validationFailure, releaseFailure], 'Approval revalidation and preparation release both failed.', { cause: releaseFailure });
      throw releaseFailure;
    }
    if (validationFailure !== undefined) {
      if (validationFailure instanceof Error) throw validationFailure;
      throw new Error('Approval revalidation failed.', { cause: validationFailure });
    }
    const priorResolutions = records.filter((event): event is Extract<AgentEvent, { type: 'approval.resolved' }> => event.type === 'approval.resolved');
    const existing = priorResolutions.find((resolution) => resolution.approvalId === input.approvalId);
    if (existing && (existing.decision !== input.decision || existing.fingerprint !== input.fingerprint)) throw new Error(`Conflicting approval resolution for ${input.approvalId}.`);
    const resolutions = new Map([...priorResolutions, ...(!existing ? [{ ...target, type: 'approval.resolved' as const, decision: input.decision }] : [])].map((resolution) => [resolution.approvalId, resolution]));
    const batchRequests = requests.filter((request) => request.toolBatchId === target.toolBatchId);
    const pending = batchRequests.filter((request) => !resolutions.has(request.approvalId));
    const phase = [...records].reverse().find((event): event is Extract<AgentEvent, { type: 'run.phase.changed' }> => event.type === 'run.phase.changed');
    if (!phase) throw new Error(`Run ${input.runId} has no persisted phase budget.`);
    const operations = new AgentOperationCoordinator(this.options.repositories.events);
    const operation = await operations.attach(input.runId);
    this.assertRuntimeMatchesOperation(operation);
    if (!existing) {
      await operation.append(
        { type: 'approval.resolved', runId: input.runId, turnIndex: target.turnIndex, turnId: target.turnId, requestAttempt: target.requestAttempt, toolBatchId: target.toolBatchId, callIndex: target.callIndex, ...(target.callId ? { callId: target.callId } : {}), approvalId: target.approvalId, fingerprint: target.fingerprint, binding: target.binding, decision: input.decision },
        `${input.runId}:approval:${input.approvalId}`
      );
    }
    const operationPhase = operation.state().phase;
    if (operationPhase.kind === 'approval') {
      await operation.resolveApproval(input.approvalId);
    } else if (operationPhase.kind !== 'tools' || operationPhase.toolBatchId !== target.toolBatchId || (operationPhase.stage !== 'ready' && operationPhase.stage !== 'effect_pending')) {
      throw new Error(`Approval ${input.approvalId} does not match the current durable operation phase.`);
    }
    if (pending.length > 0) return completedRunControl(input.runId, Object.freeze({ state: 'suspended', reason: 'approval_required', runId: input.runId, finalizationId: started.finalizationId, pendingApprovals: Object.freeze(pending.map(approvalFromEvent)), budget: phase.budget }));
    const authorizations = records.filter((event): event is Extract<AgentEvent, { type: 'tool.authorization.decided' }> => event.type === 'tool.authorization.decided' && event.toolBatchId === target.toolBatchId);
    const overrides: ToolAuthorizationOverride[] = authorizations.map((authorization) => {
      const decision = authorization.decision === 'require_approval'
        ? resolutions.get(batchRequests.find((request) => request.callIndex === authorization.callIndex)?.approvalId ?? '')?.decision
        : authorization.decision;
      if (decision !== 'allow' && decision !== 'deny') throw new Error(`Tool authorization at call ${String(authorization.callIndex)} is unresolved.`);
      return { callIndex: authorization.callIndex, fingerprint: authorization.fingerprint, decision, ...(authorization.reason ? { reason: authorization.reason } : {}) };
    });
    const snapshot = [...records].reverse().find((event): event is Extract<AgentEvent, { type: 'turn.snapshot.created' }> => event.type === 'turn.snapshot.created' && event.snapshot.turnId === target.turnId);
    if (!snapshot) throw new Error(`Approval ${input.approvalId} has no immutable turn snapshot.`);
    const callHistory = records.flatMap((event) => event.type === 'assistant.ended' ? [...(event.toolCalls ?? [])] : []);
    const resume: ToolResumeExecutionState = { kind: 'tool', identity: { turnIndex: target.turnIndex, turnId: target.turnId, requestAttempt: target.requestAttempt }, toolBatchId: target.toolBatchId, toolCalls: assistant.toolCalls, overrides, instructions: snapshot.snapshot.instructions, budget: phase.budget, approvalIds: batchRequests.map((request) => request.approvalId), callHistory, recovery: toolRecoveryState(records, target.toolBatchId, assistant.toolCalls.length) };
    return this.startRun({ task: started.task, runId: input.runId, finalizationId: started.finalizationId, ...(input.signal ? { signal: input.signal } : {}) }, resume, operation);
  }

  private startRun(input: ResolvedAgentRunInput, resume?: ResumeExecutionState, operation?: AgentOperationDriver): AgentRunControl {
    const result = this.runActive(input, resume, operation);
    return Object.freeze({
      runId: input.runId,
      injectSteering: (steering: AgentSteeringInput) => this.injectSteering(input.runId, steering),
      abort: (reason?: string) => this.scheduleAbortRun(input.runId, reason),
      result
    });
  }

  private async runActive(input: ResolvedAgentRunInput, resume?: ResumeExecutionState, attachedOperation?: AgentOperationDriver): Promise<AgentRunResult> {
    if (this.activeAbortController) throw new Error('AgentRuntime already has an active run.');
    const { runId } = input;
    const abortController = new AbortController();
    const operations = new AgentOperationCoordinator(this.options.repositories.events);
    const operationReady = resume
      ? Promise.resolve()
      : operations.accept(this.operationAcceptance(input)).then(() => undefined);
    this.activeAbortController = abortController;
    this.activeRunId = runId;
    this.activeOperations = operations;
    this.activeOperationReady = operationReady;
    let cleanupExternalAbort: () => void = () => undefined;
    try {
      await operationReady;
      const operation = attachedOperation ?? await operations.attach(runId);
      this.activeOperationDriver = operation;
      this.assertRuntimeMatchesOperation(operation);
      if (input.signal?.aborted) await this.scheduleAbortRun(runId, abortReason(input.signal.reason));
      else cleanupExternalAbort = bindExternalAbort(input.signal, () => this.scheduleAbortRun(runId, abortReason(input.signal?.reason)), abortController);
      return await this.runInternal(input, abortController.signal, operation, resume);
    }
    finally {
      cleanupExternalAbort();
      removeRunItems(this.steerQueue, runId);
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      if (this.activeRunId === runId) this.activeRunId = undefined;
      if (this.activeOperations === operations) {
        this.activeOperations = undefined;
        this.activeOperationDriver = undefined;
      }
      if (this.activeOperationReady === operationReady) this.activeOperationReady = undefined;
    }
  }

  private async resumeActive(runId: string, signal: AbortSignal | undefined, operations: AgentOperationCoordinator, abortController: AbortController, operationReady: Promise<void>): Promise<AgentRunResult> {
    let cleanupExternalAbort: () => void = () => undefined;
    try {
      const inspection = await operations.inspect(runId);
      const terminal = inspection.state.phase.kind === 'terminal'
        ? await this.options.repositories.events.latestOfType(runId, 'run.ended')
        : undefined;
      if (terminal?.event.type === 'run.ended') {
        return Object.freeze({ state: 'ended', terminal: terminal.event.terminal, deliveryDiagnostics: Object.freeze([]) });
      }
      const operation = await operations.attach(runId);
      this.activeOperationDriver = operation;
      this.assertRuntimeMatchesOperation(operation);
      if (signal?.aborted) await this.scheduleAbortRun(runId, abortReason(signal.reason));
      else cleanupExternalAbort = bindExternalAbort(signal, () => this.scheduleAbortRun(runId, abortReason(signal?.reason)), abortController);
      const operationState = operation.state();
      if (operationState.control.status === 'abort_requested') {
        abortController.abort(operationState.control.reason);
        return await this.runInternal(operationInput(operationState), abortController.signal, operation, undefined, true);
      }
      const phase = operationState.phase;
      if (phase.kind === 'approval') return await this.approvalSuspension(operationState);
      if (phase.kind === 'suspended') return operationSuspension(operationState);
      if (phase.kind === 'provider' && phase.stage === 'effect_ready') {
        const closed = closeExternalEffect(phase.effect, 'cancelled_before_start');
        await this.advanceOperation(operation, 'start_provider_request', {
          phase: { kind: 'suspended', reason: 'user_decision', effectId: closed.intent.effectId },
          ...(operation.state().budget ? { budget: operation.state().budget } : {})
        });
        return operationSuspension(operation.state());
      }
      if (phase.kind === 'provider' && phase.stage === 'effect_pending') {
        const settlement = await this.findProviderSettlement(runId, phase.effect.intent.effectId, phase.responseId);
        if (settlement) {
          const settled = settleExternalEffect(phase.effect, phase.effect.settlementPermit, {
            outcome: 'succeeded',
            resultDigest: hashJson(normalizeJsonSafe(settlement.event).value),
            exposure: settlement.event.response.usage
              ? knownEffectExposure(providerUsageQuantities(settlement.event.response.usage))
              : unknownEffectExposure(phase.effect.intent.exposure)
          });
          if (settled.status !== 'settled' && settled.status !== 'already_settled') throw new Error(`Persisted provider settlement ${settlement.event.responseId} cannot settle effect ${phase.effect.intent.effectId}.`);
          await this.advanceOperation(operation, 'reconcile_provider_request', {
            phase: { ...phase, stage: 'settled', effect: settled.state, settlementEventId: settlement.eventId },
            ...(operation.state().budget ? { budget: operation.state().budget } : {})
          });
        } else {
          const closed = closeExternalEffect(phase.effect, 'unknown_outcome');
          await this.advanceOperation(operation, 'reconcile_provider_request', { phase: { ...phase, stage: 'outcome_unknown', effect: closed }, ...(operation.state().budget ? { budget: operation.state().budget } : {}) });
          return operationSuspension(operation.state());
        }
      }
      const reconciledState = operation.state();
      if (reconciledState.phase.kind === 'provider' && reconciledState.phase.stage === 'settled') {
        const resume = await this.providerResumeExecutionState(reconciledState);
        return await this.runInternal(operationInput(reconciledState), abortController.signal, operation, resume, true);
      }
      if (phase.kind === 'tools' && phase.stage === 'effect_pending') {
        await this.advanceOperation(operation, 'reconcile_tool_call', { phase: { kind: 'suspended', reason: 'tool_outcome_unknown', ...(phase.effectId ? { effectId: phase.effectId } : {}) }, ...(operation.state().budget ? { budget: operation.state().budget } : {}) });
        return operationSuspension(operation.state());
      }
      if (phase.kind !== 'accepted' && phase.kind !== 'preparing') {
        throw new Error(`Run ${runId} requires ${nextAgentOperationInstruction(operation.state()).kind === 'wait' ? 'an explicit recovery decision' : 'a phase-specific recovery implementation'} before it can resume.`);
      }
      const input: ResolvedAgentRunInput = {
        task: operation.state().input.task,
        runId,
        finalizationId: operation.state().finalizationId,
        instructions: operation.state().input.instructions,
        contextItems: operation.state().input.contextItems
      };
      return await this.runInternal(input, abortController.signal, operation, undefined, true);
    } finally {
      cleanupExternalAbort();
      removeRunItems(this.steerQueue, runId);
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      if (this.activeRunId === runId) this.activeRunId = undefined;
      if (this.activeOperations === operations) {
        this.activeOperations = undefined;
        this.activeOperationDriver = undefined;
      }
      if (this.activeOperationReady === operationReady) this.activeOperationReady = undefined;
    }
  }

  private async runInternal(input: ResolvedAgentRunInput, signal: AbortSignal, operation: AgentOperationDriver, resume?: ResumeExecutionState, restoring = false): Promise<AgentRunResult> {
    const { runId, finalizationId } = input;
    const controller = new AgentRunController({
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(resume ? { initialBudget: resume.budget, initialToolCalls: resume.callHistory } : {})
    });
    const deliveryDiagnostics: { eventType: string; message: string; persisted: boolean }[] = [];
    const append = (event: AgentAuditEvent, idempotencyKey?: string) => operation.append(event, idempotencyKey ?? `${runId}:event:${hashJson(encodeAgentEvent(event))}`);
    const emit = (event: AgentProgressEvent) => this.emitProgress(finalizationId, event, deliveryDiagnostics, append);
    const finalizer = new AgentRunFinalizer({
      runId,
      finalizationId,
      events: this.options.repositories.events,
      append,
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}),
      ...(this.options.onProgress ? { deliver: this.options.onProgress } : {}),
      deliveryDiagnostics
    });
    if (operation.state().phase.kind === 'accepted' && operation.state().control.status === 'owned') {
      await this.advanceOperation(operation, 'prepare', { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: resume?.identity.turnIndex ?? 1 }, budget: controller.snapshot() });
    }
    let decision: ExecutionDecision;
    try {
      decision = await this.executeRun({ runId, input, signal, controller, operation, append, emit, ...(resume ? { resume } : {}), ...(restoring ? { restoring: true } : {}) });
    } catch (error) {
      decision = await this.decisionFromError({ error, signal, runId, controller, append, emit });
    }
    if (decision.executionStatus === 'waiting_for_approval') {
      const cleanupError = await this.disposeOwnedProcesses(runId, append);
      if (!cleanupError) {
        controller.waitForApproval();
        const budget = controller.snapshot();
        await append({ type: 'run.phase.changed', runId, phase: 'waiting_for_approval', budget });
        await emit({ type: 'run.phase.changed', phase: 'waiting_for_approval', budget });
        return Object.freeze({ state: 'suspended', reason: 'approval_required', runId, finalizationId, pendingApprovals: decision.approvals, budget });
      }
      decision = cleanupFailureDecision(undefined, cleanupError);
    } else if (decision.executionStatus === 'waiting_for_recovery') {
      const cleanupError = await this.disposeOwnedProcesses(runId, append);
      const state = operation.state();
      if (state.phase.kind !== 'provider' || state.phase.stage !== 'outcome_unknown') throw new Error(`Run ${runId} lost its provider recovery state.`);
      return Object.freeze({
        state: 'suspended', reason: decision.reason, runId, finalizationId, effectId: decision.effectId,
        ...(cleanupError ? { cleanupDiagnostic: { kind: 'process_cleanup' as const, message: cleanupError.message } } : {}),
        budget: controller.snapshot()
      });
    } else {
      const cleanupError = await this.disposeOwnedProcesses(runId, append);
      if (cleanupError) decision = cleanupFailureDecision(decision, cleanupError);
    }
    await this.prepareOperationForFinalization(operation, controller.snapshot());
    await this.enterPhase(runId, controller, 'finalizing', append, emit);
    await this.waitForAbortRequest(runId);
    decision = decisionBeforeFinalization(decision, signal);
    const terminal = terminalSnapshot(runId, finalizationId, decision, controller, this.checks);
    const result = await finalizer.finalize(terminal, 'diagnostic' in decision ? decision.diagnostic : undefined);
    const terminalRecord = await this.options.repositories.events.latestOfType(runId, 'run.ended');
    if (terminalRecord?.event.type !== 'run.ended') throw new Error(`Run ${runId} finalized without a durable terminal event.`);
    const terminalInstruction = nextAgentOperationInstruction(operation.state());
    if (terminalInstruction.kind !== 'execute' || (terminalInstruction.procedure !== 'finalize' && terminalInstruction.procedure !== 'finalize_abort')) {
      throw new Error(`Run ${runId} cannot publish its durable terminal operation from the current phase.`);
    }
    await this.advanceOperation(operation, terminalInstruction.procedure, { phase: { kind: 'terminal', resultEventId: terminalRecord.eventId }, budget: controller.snapshot() });
    controller.commitTerminal();
    return result;
  }

  private async executeRun(runtime: RunExecutionRuntime): Promise<ExecutionDecision> {
    throwIfAborted(runtime.signal);
    const runNotes: string[] = [];
    const checkResults: AgentCheckResult[] = [];
    const effectiveInstructions = runtime.resume ? [...runtime.resume.instructions] : applicationInstructions(this.options.instructions);
    if (!runtime.resume) effectiveInstructions.push(...runInstructions(runtime.input.instructions));
    const replay = await rebuildContextFromRepositories({
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}),
      events: this.options.repositories.events,
      ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}),
      estimator: this.estimator,
      contextImageLimits: {
        maxCount: runtime.controller.limits.activeImageCount,
        maxBytes: runtime.controller.limits.activeImageBytes,
        maxEstimatedTokens: runtime.controller.limits.activeImageTokens
      },
      providerId: this.options.provider.id,
      model: this.options.model,
      ...(runtime.resume ? { runIds: [runtime.runId] } : {})
    });
    const contextManager = replay.contextManager;
    const observationStore = new ObservationStore({ estimator: this.estimator, ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}) });
    if (!runtime.resume && !runtime.restoring) {
      await runtime.append({ type: 'run.started', runId: runtime.runId, finalizationId: runtime.input.finalizationId, task: runtime.input.task, model: this.options.model, toolPolicy: this.toolPolicy, ...(this.options.metadata ? { metadata: this.options.metadata } : {}) }, `${runtime.runId}:started`);
      await runtime.append({ type: 'run.phase.changed', runId: runtime.runId, phase: 'preparing', budget: runtime.controller.snapshot() });
    }
    if (this.options.repositories.session && !runtime.resume && !runtime.restoring) {
      const replayEvent = { type: 'context.replay.created' as const, sessionId: this.options.repositories.session.sessionId,
        replayedLedgers: replay.replayedLedgers, replayedTurns: replay.replayedTurns, replayedSessionEntries: replay.replayedSessionEntries,
        replayedCheckpoints: replay.replayedCheckpoints, replayedToolResults: replay.replayedToolResults, replayedEvidenceRecords: replay.replayedEvidenceRecords,
        ...(replay.providerStateSummary ? { restoredProviderState: replay.providerStateSummary } : {}), ...(replay.providerStateRef ? { restoredProviderStateRef: replay.providerStateRef } : {}) };
      await runtime.append(replayEvent);
      await runtime.emit({ ...replayEvent, type: 'context.replay.restored' });
    }
    if (!runtime.resume && !runtime.restoring) await runtime.append({ type: 'input.received', task: runtime.input.task });
    let sessionEntryId: string | undefined;
    if (this.options.repositories.session && !runtime.resume && !runtime.restoring) {
      const inputEntry = await this.options.repositories.session.repository.appendInput(this.options.repositories.session.sessionId, { runId: runtime.runId, task: runtime.input.task, instructions: effectiveInstructions });
      sessionEntryId = inputEntry.id;
    }
    throwIfAborted(runtime.signal);

    let turnIndex = runtime.resume ? runtime.resume.identity.turnIndex : 1;
    let lastStartedTurnIndex = 0;
    let activeCandidate: AgentCandidate = { status: 'absent' };
    let activeTurnIdentity: AgentTurnIdentity | undefined;
    let modelSession: ModelProviderSession | undefined;
    let sessionModel: string | undefined;
    let replayRestored = false;
    try {
      if (runtime.resume?.kind === 'tool') {
        const resumeDecision = await this.resumeToolBatch({ ...runtime, resume: runtime.resume }, contextManager, observationStore, checkResults);
        if (resumeDecision) return resumeDecision;
        turnIndex += 1;
      }
      let providerResume = runtime.resume?.kind === 'provider' ? runtime.resume : undefined;
      const availableTurnEntries = runtime.controller.limits.modelTurns - runtime.controller.snapshot().modelTurns + 1;
      for (let turnEntry = 0; turnEntry < availableTurnEntries; turnEntry += 1) {
        runtime.controller.assertElapsed();
        throwIfAborted(runtime.signal);
        const steering = this.consumeSteeringInstructions(runtime.runId);
        if (steering.length > 0) {
          effectiveInstructions.push(...steeringInstructions(steering, effectiveInstructions.length));
          runNotes.push(`User steering added before turnIndex ${String(turnIndex)}:\n${steering.map((instruction) => `- ${instruction}`).join('\n')}`);
        }
        let snapshot: TurnSnapshot;
        let toolBatchId: string;
        let assistant: AssistantTurnResult;
        if (providerResume) {
          snapshot = await this.restoreTurnSnapshot(providerResume.turnSnapshot, providerResume.requestEstimate);
          toolBatchId = providerResume.toolBatchId;
          activeTurnIdentity = providerResume.identity;
          lastStartedTurnIndex = turnIndex;
          runtime.controller.transition('requesting_model');
          runtime.controller.recordProviderSuccess();
          modelSession = this.options.provider.createSession?.() ?? directProviderSession(this.options.provider);
          sessionModel = snapshot.configuration.model;
          if (providerResume.providerState && this.options.repositories.artifacts && modelSession.restoreProviderState) {
            const storedState = await readProviderStateArtifact({ artifacts: this.options.repositories.artifacts, ref: providerResume.providerState.artifact });
            if (!storedState) throw new Error(`Provider continuation state for settled response ${providerResume.providerState.artifact.artifactId} is unavailable.`);
            modelSession.restoreProviderState(storedState);
            replayRestored = true;
          }
          assistant = await this.consumeProviderSettlement({
            request: { runId: runtime.runId, turnIndex, snapshot, controller: runtime.controller, operation: runtime.operation },
            requestEstimate: providerResume.requestEstimate,
            response: providerResume.response,
            identity: providerResume.identity,
            append: runtime.append,
            emit: runtime.emit
          });
          providerResume = undefined;
        } else {
          runtime.controller.beginModelTurn();
          const configuration = this.captureRuntimeConfiguration();
          const profile = parseModelProfile(await this.options.provider.describeModel(configuration.model));
          const providerInfo = this.options.provider.describe();
          const tools = Object.freeze(this.availableTools(profile));
          validateModelRun(providerInfo.id, profile, [...tools], configuration.temperature, configuration.reasoning);
          const requestWindow = requestWindowForModel(profile, this.maxOutputTokens);
          observationStore.setTokenBudgets({
            immediate: Math.max(256, Math.min(4_000, Math.floor(requestWindow.maxPromptTokens * 0.12))),
            retained: Math.max(128, Math.min(1_000, Math.floor(requestWindow.maxPromptTokens * 0.03)))
          });
          const continuationEligible = modelSession !== undefined && sessionModel === configuration.model;
          if (!continuationEligible) {
            if (modelSession) { modelSession.resetContinuation?.('Model changed between immutable turn snapshots.'); await modelSession.close?.(); }
            modelSession = this.options.provider.createSession?.() ?? directProviderSession(this.options.provider);
            sessionModel = configuration.model;
            const restoreProviderState = modelSession.restoreProviderState?.bind(modelSession);
            if (!replayRestored && replay.providerState?.model === configuration.model && restoreProviderState) {
              restoreProviderState(replay.providerState);
              replayRestored = true;
              const restoredSummary = replay.providerStateSummary ?? summarizeProviderState(replay.providerState);
              await runtime.append({ type: 'provider.state.restored', state: restoredSummary, ...(replay.providerStateRef ? { stateRef: replay.providerStateRef } : {}) });
              await runtime.emit({ type: 'provider.state.restored', state: restoredSummary, ...(replay.providerStateRef ? { stateRef: replay.providerStateRef } : {}) });
            }
          }
          const turnId = randomUUID();
          toolBatchId = randomUUID();
          snapshot = this.createTurnSnapshot({ turnIndex, turnId, requestAttempt: 1, configuration, profile, requestWindow, tools, instructions: effectiveInstructions, controller: runtime.controller, continuationEligible });
          activeTurnIdentity = turnIdentity(snapshot.record);
          const turnStarted = { type: 'turn.started' as const, runId: runtime.runId, task: runtime.input.task, ...activeTurnIdentity,
            ...(this.options.repositories.session ? { sessionId: this.options.repositories.session.sessionId } : {}), ...(sessionEntryId ? { sessionEntryId } : {}) };
          await runtime.append(turnStarted);
          await runtime.emit(turnStarted);
          if (this.options.repositories.session && turnIndex === 1) {
            await this.options.repositories.session.repository.appendModelSettings(this.options.repositories.session.sessionId, {
              provider: providerInfo.id, model: configuration.model,
              ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
              ...(configuration.reasoning?.strategy === 'effort' ? { reasoningEffort: configuration.reasoning.effort } : {})
            });
          }
          if (turnIndex === 1) {
            const configuredEvent = { type: 'run.configured' as const, configuration: summarizeRunConfiguration({
              provider: providerInfo, model: profile, tools: [...tools], toolPolicy: this.toolPolicy, requestWindow,
              ...(this.maxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: this.maxOutputTokens }),
              ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
              ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
              ...(this.options.metadata === undefined ? {} : { metadata: this.options.metadata })
            }) };
            await runtime.append(configuredEvent);
            await runtime.emit(configuredEvent);
          }
          await this.advanceOperation(runtime.operation, 'assemble_turn', { phase: { kind: 'provider', stage: 'ready', identity: activeTurnIdentity, toolBatchId }, budget: runtime.controller.snapshot() });
          await this.enterPhase(runtime.runId, runtime.controller, 'requesting_model', runtime.append, runtime.emit);
          lastStartedTurnIndex = turnIndex;
          const currentModelSession = modelSession;
          if (!currentModelSession) throw new Error('Model session was not initialized for the turn snapshot.');
          assistant = await this.requestAssistantTurn({ runId: runtime.runId, input: runtime.input, runNotes, turnIndex, toolBatchId, snapshot, modelSession: currentModelSession, signal: runtime.signal, contextManager, controller: runtime.controller, operation: runtime.operation }, runtime.append, runtime.emit);
        }
        if (assistant.kind === 'outcome_unknown') return { executionStatus: 'waiting_for_recovery', reason: 'provider_outcome_unknown', effectId: assistant.effectId };
        activeCandidate = assistant.candidate;
        const { response, toolCalls } = assistant;

        if (response.terminationReason === 'tool_calls') {
          if (toolCalls.length === 0) {
            await this.advanceOperation(runtime.operation, 'consume_provider_settlement', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
            return failedDecision('malformed_response', partialOrAbsent(activeCandidate), 'Model reported tool-call termination without usable native tool calls.', turnIndex, checkResults, response);
          }
        } else if (toolCalls.length > 0) {
          await this.advanceOperation(runtime.operation, 'consume_provider_settlement', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
          return failedDecision('malformed_response', partialOrAbsent(activeCandidate), 'Model returned native tool calls with a non-tool termination reason.', turnIndex, checkResults, response);
        }

        if (toolCalls.length === 0) {
          if (activeCandidate.status === 'absent') {
            const emptyMessage = [`Model returned no native tool calls and no visible candidate at turnIndex ${String(turnIndex)}.`, response.reasoning ? 'Raw private reasoning is not a candidate.' : ''].filter(Boolean).join(' ');
            await this.options.repositories.session?.repository.appendObservation(this.options.repositories.session.sessionId, { runId: runtime.runId, identity: turnIdentity(snapshot.record), toolName: 'assistant_response', observation: { ok: false, summary: emptyMessage, output: { content: response.content } } });
            await this.advanceOperation(runtime.operation, 'consume_provider_settlement', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
            return failedDecision('empty_response', activeCandidate, emptyMessage, turnIndex, checkResults, response);
          }
          await this.advanceOperation(runtime.operation, 'consume_provider_settlement', { phase: { kind: 'verification', stage: 'ready', checkIds: this.checks.map((check) => check.id), nextCheckIndex: 0 }, budget: runtime.controller.snapshot() });
          await this.enterPhase(runtime.runId, runtime.controller, 'verifying', runtime.append, runtime.emit);
          await this.advanceOperation(runtime.operation, 'prepare_verification', { phase: { kind: 'verification', stage: this.checks.length === 0 ? 'complete' : 'effect_pending', checkIds: this.checks.map((check) => check.id), nextCheckIndex: 0 }, budget: runtime.controller.snapshot() });
          checkResults.push(...await runAgentChecks({ runId: runtime.runId, checks: this.checks, task: runtime.input.task, instructions: snapshot.instructions, candidate: activeCandidate, ...turnIdentity(snapshot.record), signal: runtime.signal,
            ...(this.options.metadata ? { metadata: this.options.metadata } : {}), execution: contextEvidenceExecution({ contextManager, ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}), ...(this.options.verification ? { configured: this.options.verification } : {}) }),
            append: runtime.append, emit: runtime.emit }));
          if (this.checks.length > 0) {
            const checkRecord = await this.options.repositories.events.latestOfType(runtime.runId, 'check.ended');
            await this.advanceOperation(runtime.operation, 'reconcile_verification', { phase: { kind: 'verification', stage: 'settled', checkIds: this.checks.map((check) => check.id), nextCheckIndex: this.checks.length, ...(checkRecord ? { resultEventId: checkRecord.eventId } : {}) }, budget: runtime.controller.snapshot() });
          }
          await this.advanceOperation(runtime.operation, 'consume_verification_settlement', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
          return completedDecision(activeCandidate, turnIndex, checkResults, response);
        }

        await this.advanceOperation(runtime.operation, 'consume_provider_settlement', { phase: { kind: 'tools', stage: 'ready', identity: activeTurnIdentity, toolBatchId, callCount: toolCalls.length, nextCallIndex: 0 }, budget: runtime.controller.snapshot() });
        runtime.controller.recordToolCalls(toolCalls);
        contextManager.recordModelOutput({ turnIndex, content: response.content, toolCalls: toolCalls.map(modelToolCallFromToolCall) });
        await this.enterPhase(runtime.runId, runtime.controller, 'executing_tools', runtime.append, runtime.emit);
        await this.advanceOperation(runtime.operation, 'prepare_tool_call', { phase: { kind: 'tools', stage: 'effect_pending', identity: activeTurnIdentity, toolBatchId, callCount: toolCalls.length, nextCallIndex: 0, effectId: toolBatchId }, budget: runtime.controller.snapshot() });
        const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
        let toolResult;
        try {
          toolResult = await executeAssistantToolCalls({ runId: runtime.runId, driverGeneration: runtime.operation.state().driverGeneration, ...turnIdentity(snapshot.record), toolBatchId, toolCalls, tools: this.tools, toolContext: this.toolContext(toolDeadline.signal), resourceLeases: this.resourceLeases, modelInputModalities: snapshot.profile.modalities.input,
            ...(this.options.toolAuthorizer ? { authorizer: this.options.toolAuthorizer } : {}), contextManager, observationStore,
            ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}), controller: runtime.controller, append: runtime.append, emit: runtime.emit });
        } finally { toolDeadline.dispose(); }
        if (toolResult.outcome === 'waiting_for_approval') {
          await this.advanceOperation(runtime.operation, 'reconcile_tool_call', { phase: { kind: 'approval', identity: activeTurnIdentity, toolBatchId, callCount: toolCalls.length, nextCallIndex: toolResult.approvals[0]?.callIndex ?? 0, pendingApprovalIds: toolResult.approvals.map((approval) => approval.approvalId) }, budget: runtime.controller.snapshot() });
          return { executionStatus: 'waiting_for_approval', approvals: toolResult.approvals };
        }
        if (toolResult.outcome === 'uncertain_effect') {
          await this.advanceOperation(runtime.operation, 'reconcile_tool_call', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
          return { executionStatus: 'failed', terminationReason: 'uncertain_tool_effect', candidate: { status: 'absent' }, errorMessage: `Tool ${toolResult.toolName} attempt ${String(toolResult.toolAttempt)} has an uncertain external outcome without sufficient recovery proof.`, turnCount: turnIndex, checkResults };
        }
        const toolSettlement = await this.options.repositories.events.latestOfType(runtime.runId, 'tool.ended');
        await this.advanceOperation(runtime.operation, 'reconcile_tool_call', { phase: { kind: 'tools', stage: 'settled', identity: activeTurnIdentity, toolBatchId, callCount: toolCalls.length, nextCallIndex: toolCalls.length, effectId: toolBatchId, ...(toolSettlement ? { settlementEventId: toolSettlement.eventId } : {}) }, budget: runtime.controller.snapshot() });
        await this.advanceOperation(runtime.operation, 'consume_tool_settlement', { phase: { kind: 'tools', stage: 'projecting', identity: activeTurnIdentity, toolBatchId, callCount: toolCalls.length, nextCallIndex: toolCalls.length, effectId: toolBatchId, ...(toolSettlement ? { settlementEventId: toolSettlement.eventId } : {}) }, budget: runtime.controller.snapshot() });
        await this.advanceOperation(runtime.operation, 'project_tool_settlement', { phase: { kind: 'tools', stage: 'complete', identity: activeTurnIdentity, toolBatchId, callCount: toolCalls.length, nextCallIndex: toolCalls.length }, budget: runtime.controller.snapshot() });
        await this.advanceOperation(runtime.operation, 'advance_after_tools', { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: turnIndex + 1 }, budget: runtime.controller.snapshot() });
        turnIndex += 1;
      }
      throw new Error('Model-turn execution exhausted its available entries without a terminal or limit decision.');
    } catch (error) {
      throw new AgentExecutionError(error, { lastStartedTurnIndex, activeCandidate, checkResults: [...checkResults], ...(activeTurnIdentity ? { activeTurnIdentity } : {}) });
    } finally {
      await modelSession?.close?.();
    }
  }

  private async resumeToolBatch(runtime: RunExecutionRuntime & { readonly resume: ToolResumeExecutionState }, contextManager: ContextManager, observationStore: ObservationStore, checkResults: readonly AgentCheckResult[]): Promise<TerminalDecision | undefined> {
    const profile = parseModelProfile(await this.options.provider.describeModel(this.options.model));
    const batchIdentity = { ...runtime.resume.identity, toolBatchId: runtime.resume.toolBatchId };
    runtime.controller.transition('requesting_model');
    runtime.controller.transition('executing_tools');
    runtime.controller.waitForApproval();
    runtime.controller.resumeApprovedTools();
    const resumedBudget = runtime.controller.snapshot();
    await runtime.append({ type: 'run.phase.changed', runId: runtime.runId, phase: 'executing_tools', budget: resumedBudget });
    await runtime.emit({ type: 'run.phase.changed', phase: 'executing_tools', budget: resumedBudget });
    const operationPhase = runtime.operation.state().phase;
    if (operationPhase.kind !== 'tools' || (operationPhase.stage !== 'ready' && operationPhase.stage !== 'effect_pending')) throw new Error('Approval resolution did not restore the durable tool procedure.');
    if (operationPhase.stage === 'ready') {
      await this.advanceOperation(runtime.operation, 'prepare_tool_call', {
        phase: { ...operationPhase, stage: 'effect_pending', effectId: operationPhase.toolBatchId },
        budget: resumedBudget
      });
    }
    const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
    let resumedTools;
    try {
      resumedTools = await executeAssistantToolCalls({ runId: runtime.runId, driverGeneration: runtime.operation.state().driverGeneration, ...batchIdentity, toolCalls: runtime.resume.toolCalls, tools: this.tools, toolContext: this.toolContext(toolDeadline.signal), resourceLeases: this.resourceLeases, modelInputModalities: profile.modalities.input, authorizationOverrides: runtime.resume.overrides, recovery: runtime.resume.recovery, resuming: true,
        ...(this.options.toolAuthorizer ? { authorizer: this.options.toolAuthorizer } : {}), contextManager, observationStore,
        ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}), controller: runtime.controller, append: runtime.append, emit: runtime.emit });
    } finally { toolDeadline.dispose(); }
    if (resumedTools.outcome === 'uncertain_effect') {
      await this.advanceOperation(runtime.operation, 'reconcile_tool_call', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
      return { executionStatus: 'failed', terminationReason: 'uncertain_tool_effect', candidate: { status: 'absent' }, errorMessage: `Tool ${resumedTools.toolName} attempt ${String(resumedTools.toolAttempt)} may have produced an external outcome before the process stopped; its captured recovery capability does not prove that replay is safe.`, turnCount: batchIdentity.turnIndex, checkResults };
    }
    if (resumedTools.outcome !== 'completed') throw new Error('Resolved approval batch requested another approval.');
    const settlement = await this.options.repositories.events.latestOfType(runtime.runId, 'tool.ended');
    await this.advanceOperation(runtime.operation, 'reconcile_tool_call', { phase: { ...operationPhase, stage: 'settled', nextCallIndex: operationPhase.callCount, effectId: operationPhase.toolBatchId, ...(settlement ? { settlementEventId: settlement.eventId } : {}) }, budget: runtime.controller.snapshot() });
    await this.advanceOperation(runtime.operation, 'consume_tool_settlement', { phase: { ...operationPhase, stage: 'projecting', nextCallIndex: operationPhase.callCount, effectId: operationPhase.toolBatchId, ...(settlement ? { settlementEventId: settlement.eventId } : {}) }, budget: runtime.controller.snapshot() });
    await this.advanceOperation(runtime.operation, 'project_tool_settlement', { phase: { ...operationPhase, stage: 'complete', nextCallIndex: operationPhase.callCount }, budget: runtime.controller.snapshot() });
    await this.advanceOperation(runtime.operation, 'advance_after_tools', { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: operationPhase.identity.turnIndex + 1 }, budget: runtime.controller.snapshot() });
    return undefined;
  }

  private async decisionFromError(runtime: {
    readonly error: unknown;
    readonly signal: AbortSignal;
    readonly runId: string;
    readonly controller: AgentRunController;
    readonly append: (event: AgentAuditEvent) => Promise<unknown>;
    readonly emit: (event: AgentProgressEvent) => Promise<void>;
  }): Promise<TerminalDecision> {
    const executionError = runtime.error instanceof AgentExecutionError ? runtime.error : undefined;
    const cause = executionError?.cause ?? runtime.error;
    const attached = executionError?.context;
    const turnCount = cause instanceof ModelStreamInterruptedError ? cause.turnIndex : attached?.lastStartedTurnIndex ?? 0;
    const attachedIdentity = attached?.activeTurnIdentity
      ?? { turnIndex: Math.max(1, turnCount), turnId: `unidentified-turn-${String(Math.max(1, turnCount))}`, requestAttempt: 1 };
    const existingCandidate = attached?.activeCandidate ?? { status: 'absent' as const };
    const checkResults = attached?.checkResults ?? [];
    const diagnostic = providerFailureDiagnostic(cause instanceof ModelStreamInterruptedError ? cause.cause : cause);
    let recoveredCandidate: AgentCandidate = existingCandidate;
    if (cause instanceof ModelStreamInterruptedError) {
      const content = cause.content.trim();
      const summary = cause.reasoningSummary?.trim() ?? '';
      const visible = content.length > 0 ? content : summary;
      recoveredCandidate = visible ? { status: 'partial', message: visible, source: 'stream_recovery', turnIndex: cause.turnIndex } : { status: 'absent' };
      const interrupted = { type: 'assistant.interrupted' as const, ...attachedIdentity, turnIndex: cause.turnIndex, content: cause.content, candidate: recoveredCandidate,
        ...(cause.reasoningSummary !== undefined ? { reasoningSummary: cause.reasoningSummary } : {}), finalResponseReceived: cause.finalResponseReceived, ...(diagnostic ? { diagnostic } : {}) };
      await safePersist(runtime.append, interrupted);
      await runtime.emit(interrupted);
    }
    if (diagnostic && turnCount > 0) {
      const failed = { type: 'model.failed' as const, ...attachedIdentity, turnIndex: Math.max(1, turnCount), diagnostic };
      await safePersist(runtime.append, failed);
      await runtime.emit(failed);
    }
    const message = errorMessage(cause);
    const terminalDiagnostic = diagnostic ? { ...diagnostic, ...(turnCount > 0 ? { turnIndex: turnCount } : {}) } : undefined;
    if (runtime.signal.aborted || cause instanceof AgentVerificationAbortedError) {
      return { executionStatus: 'aborted', terminationReason: 'aborted', candidate: partialOrAbsent(recoveredCandidate), errorMessage: message, turnCount, checkResults, ...(terminalDiagnostic ? { diagnostic: terminalDiagnostic } : {}) };
    }
    if (cause instanceof AgentLimitExceededError) {
      return { executionStatus: 'failed', terminationReason: 'limit_exhausted', candidate: partialOrAbsent(recoveredCandidate), errorMessage: message, turnCount, checkResults, exhaustedLimit: cause.limit };
    }
    const boundaryError = cause instanceof ModelStreamInterruptedError ? cause.cause : cause;
    const terminationReason = boundaryError instanceof ModelContractError
      ? 'malformed_response'
      : cause instanceof ModelStreamInterruptedError
        ? 'stream_interrupted'
        : cause instanceof RequestAssemblyError
          ? 'request_too_large'
          : diagnostic
            ? 'provider_error'
            : 'runtime_error';
    return { executionStatus: 'failed', terminationReason, candidate: partialOrAbsent(recoveredCandidate), errorMessage: message, turnCount, checkResults, ...(terminalDiagnostic ? { diagnostic: terminalDiagnostic } : {}) };
  }

  private createTurnSnapshot(input: {
    readonly turnIndex: number;
    readonly turnId: string;
    readonly requestAttempt: number;
    readonly configuration: RuntimeModelConfiguration;
    readonly profile: ModelProfile;
    readonly requestWindow: RequestWindow;
    readonly tools: readonly CompiledToolDefinition[];
    readonly instructions: readonly AgentEffectiveInstruction[];
    readonly controller: AgentRunController;
    readonly continuationEligible: boolean;
  }): TurnSnapshot {
    const record: AgentTurnSnapshotRecord = Object.freeze({
      turnIndex: input.turnIndex, turnId: input.turnId, requestAttempt: input.requestAttempt,
      provider: this.options.provider.id, model: input.configuration.model,
      profileHash: hashJson(normalizeJsonSafe(input.profile).value), continuationEligible: input.continuationEligible,
      ...(input.configuration.temperature === undefined ? {} : { temperature: input.configuration.temperature }),
      ...(input.configuration.reasoning === undefined ? {} : { reasoning: input.configuration.reasoning }),
      ...(input.configuration.responseFormat === undefined ? {} : { responseFormat: input.configuration.responseFormat }),
      toolNames: input.tools.map((tool) => tool.name), toolPolicyHash: hashJson(this.toolPolicy), instructions: [...input.instructions],
      configuredContextSourceIds: contextSourceIds(this.options.contextItems, 'configured'), checkIds: this.checks.map((check) => check.id), limits: input.controller.limits, budget: input.controller.snapshot()
    });
    return Object.freeze({ record, profile: input.profile, requestWindow: Object.freeze({ ...input.requestWindow }), budgetAccountant: new BudgetAccountant(input.requestWindow, this.estimator), tools: Object.freeze([...input.tools]), configuration: input.configuration, instructions: Object.freeze([...input.instructions]) });
  }

  private async restoreTurnSnapshot(record: AgentTurnSnapshotRecord, requestEstimate: RequestCostEstimate): Promise<TurnSnapshot> {
    if (record.provider !== this.options.provider.id || record.model !== this.options.model) throw new Error(`Persisted turn ${record.turnId} does not match the configured provider and model.`);
    const profile = parseModelProfile(await this.options.provider.describeModel(record.model));
    if (hashJson(normalizeJsonSafe(profile).value) !== record.profileHash) throw new Error(`Provider model profile changed for persisted turn ${record.turnId}.`);
    const available = new Map(this.availableTools(profile).map((tool) => [tool.name, tool]));
    const tools = record.toolNames.map((name) => {
      const tool = available.get(name);
      if (!tool) throw new Error(`Tool ${name} required by persisted turn ${record.turnId} is unavailable.`);
      return tool;
    });
    const requestWindow = requestWindowForModel(profile, this.maxOutputTokens);
    const budgetAccountant = new BudgetAccountant(requestWindow, this.estimator);
    budgetAccountant.recordSent(requestEstimate);
    const configuration: RuntimeModelConfiguration = Object.freeze({
      model: record.model,
      ...(record.temperature === undefined ? {} : { temperature: record.temperature }),
      ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
      ...(record.responseFormat === undefined ? {} : { responseFormat: record.responseFormat })
    });
    return Object.freeze({ record, profile, requestWindow, budgetAccountant, tools: Object.freeze(tools), configuration, instructions: record.instructions });
  }

  private async requestAssistantTurn(request: AssistantTurnRequest, append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>, emit: (event: AgentProgressEvent) => Promise<void>): Promise<AssistantTurnResult> {
    const identity = turnIdentity(request.snapshot.record);
    const assembly = await this.assembleModelRequest(request, append, emit);
    if (!assembly.ok) throw new RequestAssemblyError(formatOverflowDiagnostic(assembly.diagnostic));
    request.snapshot.budgetAccountant.recordSent(assembly.estimate);
    const ledgerModelRequest = { ...assembly.request }; delete ledgerModelRequest.signal;
    await append({ type: 'assistant.started', ...identity });
    await emit({ type: 'assistant.started', ...identity });
    const completedAttempt = await this.completeProviderAttempt(assembly.request, assembly.estimate, assembly.snapshot, summarizeModelRequest(ledgerModelRequest), request, append, emit);
    if (completedAttempt.kind === 'outcome_unknown') return completedAttempt;
    return this.consumeProviderSettlement({ request, requestEstimate: assembly.estimate, response: completedAttempt.response, identity: completedAttempt.identity, append, emit });
  }

  private async consumeProviderSettlement(input: { readonly request: Pick<AssistantTurnRequest, 'runId' | 'turnIndex' | 'snapshot' | 'controller' | 'operation'>; readonly requestEstimate: RequestCostEstimate; readonly response: ModelResponse; readonly identity: AgentTurnIdentity; readonly append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>; readonly emit: (event: AgentProgressEvent) => Promise<void> }): Promise<Extract<AssistantTurnResult, { readonly kind: 'settled' }>> {
    const { request, response, identity: responseIdentity, append, emit } = input;
    const providerPhase = request.operation.state().phase;
    if (providerPhase.kind !== 'provider' || providerPhase.stage !== 'settled') throw new Error('Provider response is not durably settled.');
    const settlementRecord = await this.findProviderSettlement(request.runId, providerPhase.effect.intent.effectId, providerPhase.responseId);
    if (settlementRecord?.eventId !== providerPhase.settlementEventId) throw new Error('Provider response settlement is missing or contradictory.');
    const providerState = settlementRecord.event.providerState;
    await append({ type: 'model.responded', ...responseIdentity, response: summarizeModelResponse(response, providerState) });
    if (providerState) await append({ type: 'provider.state.updated', ...responseIdentity, state: providerState.summary, stateRef: providerState.artifact });
    if (response.usage) {
      const budget = request.snapshot.budgetAccountant.recordProviderUsage(response.usage);
      await append({ type: 'budget.provider_usage.recorded', ...responseIdentity, usage: response.usage, snapshot: budget });
      request.controller.recordUsage(response.usage, request.snapshot.profile.pricing);
    } else {
      const completionTokens = this.estimateAssistantOutput(response);
      request.snapshot.budgetAccountant.recordEstimatedResponse(completionTokens);
      request.controller.recordUsage({ promptTokens: input.requestEstimate.totalPromptTokens, completionTokens, totalTokens: input.requestEstimate.totalPromptTokens + completionTokens }, request.snapshot.profile.pricing);
    }
    const toolCalls = Object.freeze((response.toolCalls ?? []).map(normalizeModelToolCall));
    const candidate = candidateFromResponse(response, request.turnIndex, toolCalls.length > 0);
    const assistantEnded = { type: 'assistant.ended' as const, ...responseIdentity, content: response.content, candidate, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
    await append(assistantEnded);
    await emit(assistantEnded);
    if (this.options.repositories.session) {
      await this.options.repositories.session.repository.appendAssistant(this.options.repositories.session.sessionId, {
        runId: request.runId,
        identity: responseIdentity,
        content: response.content
      });
    }
    return { kind: 'settled', response, toolCalls, candidate };
  }

  private async completeProviderAttempt(request: ModelRequest, requestEstimate: RequestCostEstimate, requestSnapshot: AgentRequestSnapshotRecord, requestSummary: ReturnType<typeof summarizeModelRequest>, turnRequest: AssistantTurnRequest, append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>, emit: (event: AgentProgressEvent) => Promise<void>): Promise<CompletedModelAttempt> {
      const identity = turnIdentity(turnRequest.snapshot.record);
      await append({ type: 'turn.snapshot.created', snapshot: { ...turnRequest.snapshot.record, requestAttempt: identity.requestAttempt } });
      if (this.options.recordRequest) {
        const ownedRequest = recordableModelRequest(request);
        await this.options.recordRequest(Object.freeze({ ...identity, requestId: requestSnapshot.requestId, request: ownedRequest }));
      }
      await append({ type: 'request.snapshot.created', snapshot: { ...requestSnapshot, requestAttempt: identity.requestAttempt } });
      const requestReceipt = await append({ type: 'model.requested', ...identity, request: requestSummary });
      const exactRequest = recordableModelRequest(request);
      const parametersDigest = hashJson(normalizeJsonSafe(exactRequest).value);
      const recovery = this.options.provider.requestRecovery
        ? decodeEffectRecoveryCapability(this.options.provider.requestRecovery(exactRequest))
        : UNKNOWN_EFFECT_RECOVERY;
      const exposure = providerExposureReservation(requestEstimate);
      const effectId = `${requestSnapshot.requestId}:${String(identity.requestAttempt)}`;
      const responseId = randomUUID();
      const issued = issueEffectStartTicket({
        intent: Object.freeze({ effectId, operationId: turnRequest.runId, implementationId: this.options.provider.implementationId, parametersDigest, recovery, exposure }),
        ticketId: randomUUID(),
        settlementPermitId: randomUUID(),
        driverGeneration: turnRequest.operation.state().driverGeneration,
        currentDriverGeneration: turnRequest.operation.state().driverGeneration
      });
      if (issued.status !== 'issued') throw new Error(`Provider effect ${effectId} was rejected before intent commit.`);
      await this.advanceOperation(turnRequest.operation, 'prepare_provider_request', {
        phase: {
          kind: 'provider',
          stage: 'effect_ready',
          identity,
          toolBatchId: turnRequest.toolBatchId,
          requestEventId: requestReceipt.eventId,
          responseId,
          effect: issued.state
        },
        budget: turnRequest.controller.snapshot()
      });
      const current = turnRequest.operation.state().phase;
      if (current.kind !== 'provider' || current.stage !== 'effect_ready') throw new Error(`Provider effect ${effectId} lost its issued ticket.`);
      const started = startExternalEffect(current.effect, current.effect.ticket, turnRequest.operation.state().driverGeneration);
      if (started.status !== 'started') throw new Error(`Provider effect ${effectId} could not consume its start authority: ${started.reason}.`);
      await this.advanceOperation(turnRequest.operation, 'start_provider_request', {
        phase: { ...current, stage: 'effect_pending', effect: started.state },
        budget: turnRequest.controller.snapshot()
      });
      const deadline = runDeadline(turnRequest.controller, request);
      let response: ModelResponse;
      let settlementReceipt: EventAppendReceipt;
      let settlementEvent: Extract<AgentEvent, { readonly type: 'provider.attempt.settled' }>;
      try {
        const responseWithPrivateState = await this.completeModelOnce(deadline.request, identity, turnRequest.toolBatchId, turnRequest.snapshot.profile, turnRequest.modelSession, emit);
        const providerState = responseWithPrivateState.providerState && this.options.repositories.artifacts
          ? await storeProviderStateArtifact({ artifacts: this.options.repositories.artifacts, turnIndex: turnRequest.turnIndex, state: responseWithPrivateState.providerState })
          : undefined;
        response = durableProviderResponse(responseWithPrivateState);
        settlementEvent = { type: 'provider.attempt.settled', ...identity, effectId, responseId, response, ...(providerState ? { providerState } : {}) };
        settlementReceipt = await append(settlementEvent);
      } catch (error) {
        turnRequest.controller.recordProviderFailure();
        const pending = turnRequest.operation.state().phase;
        if (pending.kind !== 'provider' || pending.stage !== 'effect_pending' || pending.effect.intent.effectId !== effectId) throw error;
        const closed = closeExternalEffect(pending.effect, 'unknown_outcome');
        await this.advanceOperation(turnRequest.operation, 'reconcile_provider_request', {
          phase: { ...pending, stage: 'outcome_unknown', effect: closed },
          budget: turnRequest.controller.snapshot()
        });
        return Object.freeze({ kind: 'outcome_unknown', effectId });
      } finally {
        deadline.dispose();
      }
      const pending = turnRequest.operation.state().phase;
      if (pending.kind !== 'provider' || pending.stage !== 'effect_pending' || pending.effect.intent.effectId !== effectId) throw new Error(`Provider effect ${effectId} completed outside its durable start state.`);
      const effectSettlement = settleExternalEffect(pending.effect, pending.effect.settlementPermit, {
        outcome: 'succeeded',
        resultDigest: hashJson(normalizeJsonSafe(settlementEvent).value),
        exposure: response.usage ? knownEffectExposure(providerUsageQuantities(response.usage)) : unknownEffectExposure(pending.effect.intent.exposure)
      });
      if (effectSettlement.status !== 'settled' && effectSettlement.status !== 'already_settled') {
        throw new Error(`Provider effect ${effectId} could not settle: ${effectSettlement.status === 'rejected' ? effectSettlement.reason : 'effect was already closed'}.`);
      }
      await this.advanceOperation(turnRequest.operation, 'reconcile_provider_request', {
        phase: { ...pending, stage: 'settled', effect: effectSettlement.state, settlementEventId: settlementReceipt.eventId },
        budget: turnRequest.controller.snapshot()
      });
      turnRequest.controller.recordProviderSuccess();
      return Object.freeze({ kind: 'settled', response, identity: Object.freeze(identity) });
  }

  private async assembleModelRequest(request: AssistantTurnRequest, append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>, emit: (event: AgentProgressEvent) => Promise<void>): Promise<RequestAssemblyResult> {
    const identity = turnIdentity(request.snapshot.record);
    const contextInputs = await this.collectContextItems(request.input, request.turnIndex, request.snapshot.instructions);
    const allContextInputs = [...contextInputs.configured, ...contextInputs.provider, ...contextInputs.run];
    let attempt = 1;
    let nextRecoveryStage = 0;
    const recoveryActions: OverflowRecoveryAction[] = [];
    const modelTools = toolsForModel([...request.snapshot.tools], request.snapshot.profile);
    const outputReserveTokens = request.snapshot.requestWindow.maxOutputTokens;
    let contextRemoved = false;
    let evidenceRemoved = false;
    const reductionRecords: { kind: string; reason: string; sequence: number }[] = [];
    const recordedProjectionReductions = new Set<string>();
    const runInstructions = request.snapshot.instructions.filter((item) => item.provenance !== 'application').map((item) => item.content);
    for (;;) {
      const estimatedBaseTokens = estimatePromptScaffoldTokens(this.estimator, { task: request.input.task, runNotes: [...request.runNotes], runInstructions,
        configuredInstructions: [...(this.options.instructions ?? [])], tools: [...request.snapshot.tools], modelProfile: request.snapshot.profile, ...(this.options.toolContext ? { toolContext: this.options.toolContext } : {}) });
      const toolSchemaTokens = this.estimator.estimateText(JSON.stringify(modelTools));
      const contextHistory = request.contextManager.projectHistory(request.snapshot.profile);
      const evidenceTokenBudget = evidenceRemoved ? 0 : Math.min(1_600, Math.floor(request.snapshot.requestWindow.maxPromptTokens * 0.08));
      const contextCapacity = contextRemoved ? 0 : Math.max(0, request.snapshot.requestWindow.maxPromptTokens - estimatedBaseTokens - contextHistory.estimatedTokens - toolSchemaTokens - evidenceTokenBudget);
      const projection = request.contextManager.project({ task: request.input.task,
        instructions: promptInstructionsForRequest({ runInstructions, configuredInstructions: [...(this.options.instructions ?? [])] }), notes: request.runNotes.slice(-8),
        contextItems: allContextInputs, tools: promptToolSpecs([...request.snapshot.tools], request.snapshot.profile, this.options.toolContext), modelTools,
        modelProfile: request.snapshot.profile, requestWindow: request.snapshot.requestWindow, contextTokenBudget: contextCapacity, evidenceTokenBudget });
      const newProjectionReductions = projection.reductions.filter((reduction) => {
        const key = JSON.stringify([reduction.itemId, reduction.kind, reduction.reason, reduction.removedItems, reduction.removedImageBytes]);
        if (recordedProjectionReductions.has(key)) return false;
        recordedProjectionReductions.add(key);
        return true;
      });
      if (newProjectionReductions.length > 0) {
        const firstSequence = reductionRecords.length + 1;
        reductionRecords.push(...newProjectionReductions.map((reduction, index) => ({ kind: reduction.kind, reason: reduction.reason ?? 'projection', sequence: firstSequence + index })));
        await append({ type: 'context.history.reduced', ...identity, reductions: newProjectionReductions });
        await emit({ type: 'context.history.reduced', ...identity, reductions: newProjectionReductions });
      }
      await append({ type: 'context.bundle.created', bundle: projection.context });
      await append({ type: 'prompt.projection.created', projection: projection.prompt });
      const compiled = compilePromptProjection(projection.prompt);
      const estimate = request.snapshot.budgetAccountant.estimateRequest({ promptMessages: compiled.messages, contextHistoryTokens: projection.estimate.contextHistoryTokens,
        contextTokens: projection.estimate.contextTokens, evidenceTokens: projection.estimate.evidenceTokens, tools: modelTools, outputReserveTokens });
      await append({ type: 'budget.estimate.created', ...identity, attempt, estimate, snapshot: request.snapshot.budgetAccountant.snapshot() });
      if (request.snapshot.budgetAccountant.canSend(estimate)) {
        const pressure = request.snapshot.budgetAccountant.pressureAfter(estimate);
        if (pressure !== 'normal') {
          const reductions = request.contextManager.reduceHistoryForPromptPressure({ modelProfile: request.snapshot.profile, maxHistoryTokens: Math.floor(request.snapshot.requestWindow.maxPromptTokens * 0.35), keepLatestToolResults: 2 }).reductions;
          if (reductions.length > 0) {
            reductionRecords.push({ kind: 'reduce_history_pressure', reason: pressure, sequence: reductionRecords.length + 1 });
            await append({ type: 'context.history.reduced', ...identity, reductions });
            await emit({ type: 'context.history.reduced', ...identity, reductions });
            attempt += 1;
            continue;
          }
        }
        const modelRequest: ModelRequest = { model: request.snapshot.configuration.model, messages: [...compiled.messages, ...projection.contextHistoryMessages],
          ...(supportsParameter(request.snapshot.profile, 'maxOutputTokens') ? { maxOutputTokens: outputReserveTokens } : {}), ...(modelTools.length > 0 ? { tools: modelTools } : {}), signal: request.signal,
          ...(request.snapshot.configuration.temperature !== undefined ? { temperature: request.snapshot.configuration.temperature } : {}),
          ...(request.snapshot.configuration.reasoning !== undefined && supportsParameter(request.snapshot.profile, 'reasoning') ? { reasoning: request.snapshot.configuration.reasoning } : {}),
          ...(request.snapshot.configuration.responseFormat !== undefined ? { responseFormat: request.snapshot.configuration.responseFormat } : {}) };
        const finalRequestSnapshot: AgentRequestSnapshotRecord = Object.freeze({
          ...identity,
          requestId: randomUUID(),
          configuredContextIds: contextSourceIds(contextInputs.configured, 'configured'),
          providerContextIds: contextSourceIds(contextInputs.provider, 'provider'),
          runContextIds: contextSourceIds(contextInputs.run, 'run'),
          effectiveInstructionHash: hashJson(normalizeJsonSafe(request.snapshot.instructions).value),
          selectedEvidenceHash: hashJson(normalizeJsonSafe(projection.prompt.evidence ?? null).value),
          retainedHistoryHash: hashJson(normalizeJsonSafe(projection.contextHistoryMessages).value),
          modelToolSchemasHash: hashJson(normalizeJsonSafe(modelTools).value),
          compiledPromptHash: hashJson(normalizeJsonSafe(compiled.messages).value),
          reductions: reductionRecords
        });
        return { ok: true, request: modelRequest, estimate, snapshot: finalRequestSnapshot };
      }
      await append({ type: 'overflow.recovery.started', ...identity, attempt, estimate, snapshot: request.snapshot.budgetAccountant.snapshot() });
      let latestReductions: readonly ContextHistoryReduction[] = [];
      let recoveryResult: OverflowRecoveryResult | undefined;
      while (recoveryResult === undefined && nextRecoveryStage < OVERFLOW_RECOVERY_STAGES.length) {
        const recoveryStage: OverflowRecoveryStage | undefined = OVERFLOW_RECOVERY_STAGES[nextRecoveryStage];
        if (recoveryStage === undefined) break;
        nextRecoveryStage += 1;
        let action: Exclude<OverflowRecoveryAction, { kind: 'diagnostic_failure' }> | undefined;
        if (recoveryStage === 'older_history') {
          latestReductions = request.contextManager.reduceOlderLargeToolResults({ keepLatestToolResults: 1 });
          if (latestReductions.length > 0) action = { kind: 'reduce_context_history', reductions: latestReductions.length };
        } else if (recoveryStage === 'all_history') {
          latestReductions = request.contextManager.reduceOlderLargeToolResults({ keepLatestToolResults: 0, includeLatest: true });
          if (latestReductions.length > 0) action = { kind: 'reduce_context_history', reductions: latestReductions.length };
        } else if (recoveryStage === 'context') {
          const removedItems = projection.context.items.length;
          if (removedItems > 0) action = { kind: 'reduce_context', removedItems };
        } else if (recoveryStage === 'evidence') {
          const removedRecords = request.contextManager.evidenceRecordCount();
          if (removedRecords > 0) action = { kind: 'reduce_evidence', removedRecords };
        } else {
          const contextItems = request.contextManager.itemCount();
          if (contextItems > 0) action = { kind: 'install_checkpoint', compactedToolResults: request.contextManager.compactedToolResultCount() };
        }
        if (action !== undefined) {
          recoveryActions.push(action);
          recoveryResult = { kind: 'retry', action };
        }
      }
      recoveryResult ??= { kind: 'diagnostic', diagnostic: createOverflowDiagnostic(estimate, recoveryActions) };
      await append({ type: 'overflow.recovery.ended', ...identity, attempt, result: recoveryResult });
      if (recoveryResult.kind === 'diagnostic') {
        return { ok: false, diagnostic: recoveryResult.diagnostic };
      }
      reductionRecords.push({ kind: recoveryResult.action.kind, reason: 'request_overflow', sequence: reductionRecords.length + 1 });
      if (recoveryResult.action.kind === 'reduce_context_history') { await append({ type: 'context.history.reduced', ...identity, reductions: latestReductions }); await emit({ type: 'context.history.reduced', ...identity, reductions: latestReductions }); }
      else if (recoveryResult.action.kind === 'reduce_context') contextRemoved = true;
      else if (recoveryResult.action.kind === 'reduce_evidence') evidenceRemoved = true;
      else if (recoveryResult.action.kind === 'install_checkpoint') { const checkpoint = request.contextManager.installCheckpoint();
        await append({ type: 'context.checkpoint.created', ...identity, compactedToolResults: recoveryResult.action.compactedToolResults, ...(checkpoint ? { removedItems: checkpoint.removedItems, beforeBytes: checkpoint.beforeBytes, afterBytes: checkpoint.afterBytes } : {}) });
        await emit({ type: 'context.checkpoint.created', ...identity, compactedToolResults: recoveryResult.action.compactedToolResults, ...(checkpoint ? { removedItems: checkpoint.removedItems, beforeBytes: checkpoint.beforeBytes, afterBytes: checkpoint.afterBytes } : {}) }); }
      attempt += 1;
    }
  }

  private async completeModelOnce(request: ModelRequest, identity: AgentTurnIdentity, toolBatchId: string, profile: ModelProfile, session: ModelProviderSession, emit: (event: AgentProgressEvent) => Promise<void>): Promise<ModelResponse> {
    if (profile.capabilities.streaming && session.stream) {
      let response: ModelResponse | undefined; let sawUpdate = false; let streamedContent = ''; let streamedReasoningSummary = ''; let terminalEvents = 0;
      try {
        let streamedToolCallIndex = 0;
        for await (const rawEvent of session.stream(request)) {
          const event = parseModelStreamEvent(rawEvent);
          if (terminalEvents > 0) throw new Error('Provider stream emitted an event after its terminal event.');
          if (event.type === 'content') { sawUpdate = true; streamedContent = event.accumulated; await emit({ type: 'assistant.delta', ...identity, delta: event.content, accumulated: event.accumulated }); }
          else if (event.type === 'reasoning') { sawUpdate = true; if (event.channel === 'summary') streamedReasoningSummary = event.accumulatedReasoning;
            if (profile.capabilities.reasoning?.separateOutput) await emit({ type: 'assistant.reasoning', ...identity, delta: event.reasoning, accumulated: event.accumulatedReasoning, ...(event.channel ? { channel: event.channel } : {}) }); }
          else if (event.type === 'tool_call') { sawUpdate = true; const toolCall = normalizeModelToolCall(event.toolCall); await emit({ type: 'tool.call.received', ...identity, toolBatchId, toolCall, callIndex: streamedToolCallIndex, ...(toolCall.id ? { callId: toolCall.id } : {}) }); streamedToolCallIndex += 1; }
          else if (event.type === 'status') await emit({ type: 'assistant.status', ...identity, message: event.message });
          else { terminalEvents += 1; response = event.response; if (!sawUpdate && response.content.length > 0) await emit({ type: 'assistant.delta', ...identity, delta: response.content, accumulated: response.content }); }
        }
      } catch (error) { throw modelStreamInterrupted({ turnIndex: identity.turnIndex, cause: error, content: streamedContent, reasoningSummary: streamedReasoningSummary, finalResponseReceived: response !== undefined }); }
      if (!response) throw modelStreamInterrupted({ turnIndex: identity.turnIndex, cause: new Error('Model stream ended without a final response.'), content: streamedContent, reasoningSummary: streamedReasoningSummary, finalResponseReceived: false });
      return normalizeStreamedFinalResponse(response, streamedContent, streamedReasoningSummary);
    }
    const response = parseModelResponse(await session.complete(request));
    if (response.content.length > 0) await emit({ type: 'assistant.delta', ...identity, delta: response.content, accumulated: response.content });
    return response;
  }

  private async enterPhase(runId: string, controller: AgentRunController, phase: Parameters<AgentRunController['transition']>[0], append: (event: AgentAuditEvent) => Promise<unknown>, emit: (event: AgentProgressEvent) => Promise<void>): Promise<void> {
    controller.transition(phase); const budget = controller.snapshot(); await append({ type: 'run.phase.changed', runId, phase, budget }); await emit({ type: 'run.phase.changed', phase, budget });
  }
  private async emitProgress(
    finalizationId: string,
    event: AgentProgressEvent,
    diagnostics: { eventType: string; message: string; persisted: boolean }[],
    append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<EventAppendReceipt>
  ): Promise<void> {
    if (!this.options.onProgress) return;
    try { await this.options.onProgress(event); }
    catch (error) {
      const base = { eventType: event.type, message: errorMessage(error) };
      try { const diagnostic = { ...base, persisted: true }; await append({ type: 'delivery.failed', finalizationId, diagnostic }, `${finalizationId}:delivery:${event.type}:${String(diagnostics.length)}`); diagnostics.push(diagnostic); }
      catch { diagnostics.push({ ...base, persisted: false }); }
    }
  }
  private async advanceOperation(
    operation: AgentOperationDriver,
    procedure: AgentOperationProcedure,
    advance: AgentOperationAdvance
  ): Promise<void> {
    const result = await operation.drive(({ instruction }) => {
      if (instruction.procedure !== procedure) {
        throw new Error(`Durable operation expected ${instruction.procedure}, not ${procedure}.`);
      }
      return advance;
    });
    if (result.kind !== 'advanced') {
      throw new Error(`Durable operation cannot execute ${procedure} while it is ${result.kind}.`);
    }
  }
  private async approvalSuspension(state: import('./operation/contracts.js').AgentOperationState): Promise<AgentRunResult> {
    if (state.phase.kind !== 'approval') throw new Error(`Run ${state.runId} is not waiting for approval.`);
    const pendingIds = new Set(state.phase.pendingApprovalIds);
    const pending: AgentApprovalRequest[] = [];
    for await (const record of this.options.repositories.events.read(state.runId)) {
      if (record.event.type === 'approval.requested' && pendingIds.has(record.event.approvalId)) pending.push(approvalFromEvent(record.event));
    }
    if (pending.length !== pendingIds.size) throw new Error(`Run ${state.runId} is missing a durable approval request.`);
    if (!state.budget) throw new Error(`Run ${state.runId} has no durable budget at its approval boundary.`);
    return Object.freeze({
      state: 'suspended',
      reason: 'approval_required',
      runId: state.runId,
      finalizationId: state.finalizationId,
      pendingApprovals: Object.freeze(pending),
      budget: state.budget
    });
  }
  private async findProviderSettlement(runId: string, effectId: string, responseId: string): Promise<{ readonly eventId: string; readonly event: Extract<AgentEvent, { readonly type: 'provider.attempt.settled' }> } | undefined> {
    let match: { readonly eventId: string; readonly event: Extract<AgentEvent, { readonly type: 'provider.attempt.settled' }> } | undefined;
    for await (const record of this.options.repositories.events.read(runId)) {
      if (record.event.type !== 'provider.attempt.settled' || record.event.effectId !== effectId || record.event.responseId !== responseId) continue;
      if (match) throw new Error(`Run ${runId} contains duplicate provider settlements for ${responseId}.`);
      match = Object.freeze({ eventId: record.eventId, event: record.event });
    }
    return match;
  }
  private async providerResumeExecutionState(state: import('./operation/contracts.js').AgentOperationState): Promise<ProviderResumeExecutionState> {
    const phase = state.phase;
    if (phase.kind !== 'provider' || phase.stage !== 'settled') throw new Error(`Run ${state.runId} has no settled provider response to resume.`);
    if (!state.budget) throw new Error(`Run ${state.runId} has no durable budget at its provider settlement.`);
    const settlement = await this.findProviderSettlement(state.runId, phase.effect.intent.effectId, phase.responseId);
    if (settlement?.eventId !== phase.settlementEventId) throw new Error(`Run ${state.runId} is missing its exact provider settlement ${phase.settlementEventId}.`);
    let turnSnapshot: AgentTurnSnapshotRecord | undefined;
    let requestEstimate: RequestCostEstimate | undefined;
    const callHistory: ToolCall[] = [];
    for await (const record of this.options.repositories.events.read(state.runId)) {
      const event = record.event;
      if (event.type === 'turn.snapshot.created' && sameTurnIdentity(turnIdentity(event.snapshot), phase.identity)) turnSnapshot = event.snapshot;
      else if (event.type === 'budget.estimate.created' && sameTurnIdentity(event, phase.identity)) requestEstimate = event.estimate;
      else if (event.type === 'assistant.ended') callHistory.push(...(event.toolCalls ?? []));
    }
    if (!turnSnapshot) throw new Error(`Run ${state.runId} is missing the immutable snapshot for provider response ${phase.responseId}.`);
    if (!requestEstimate) throw new Error(`Run ${state.runId} is missing the request estimate for provider response ${phase.responseId}.`);
    return Object.freeze({
      kind: 'provider',
      identity: phase.identity,
      toolBatchId: phase.toolBatchId,
      response: settlement.event.response,
      ...(settlement.event.providerState ? { providerState: settlement.event.providerState } : {}),
      turnSnapshot,
      requestEstimate,
      instructions: turnSnapshot.instructions,
      budget: state.budget,
      callHistory: Object.freeze(callHistory)
    });
  }
  private async prepareOperationForFinalization(operation: AgentOperationDriver, budget: import('./run/contracts.js').AgentRunBudgetState): Promise<void> {
    for (let transitions = 0; transitions < 4; transitions += 1) {
      const state = operation.state();
      if (state.phase.kind === 'finalization') return;
      if (state.phase.kind === 'terminal') throw new Error(`Run ${state.runId} is already terminal.`);
      const next = nextAgentOperationInstruction(state);
      if (next.kind !== 'execute') throw new Error(`Run ${state.runId} requires ${next.kind === 'wait' ? next.reason : 'completion'} instead of finalization.`);
      const instruction = next.procedure;
      switch (instruction) {
        case 'prepare':
        case 'assemble_turn':
        case 'prepare_provider_request':
        case 'consume_provider_settlement':
        case 'prepare_tool_call':
        case 'reconcile_tool_call':
        case 'consume_tool_settlement':
        case 'advance_after_tools':
        case 'consume_verification_settlement':
        case 'decide_candidate':
        case 'finalize_abort':
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
          continue;
        case 'start_provider_request': {
          if (state.phase.kind !== 'provider' || state.phase.stage !== 'effect_ready') throw new Error(`Run ${state.runId} has contradictory provider start state.`);
          closeExternalEffect(state.phase.effect, 'cancelled_before_start');
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
          continue;
        }
        case 'reconcile_provider_request': throw new Error(`Run ${state.runId} has an unresolved started provider effect and cannot finalize it as a local failure.`);
        case 'prepare_verification':
          await this.advanceOperation(operation, instruction, { phase: { kind: 'verification', stage: 'complete', checkIds: this.checks.map((check) => check.id), nextCheckIndex: this.checks.length }, budget });
          continue;
        case 'reconcile_verification': {
          const result = await this.options.repositories.events.latestOfType(state.runId, 'check.ended');
          await this.advanceOperation(operation, instruction, { phase: { kind: 'verification', stage: 'settled', checkIds: this.checks.map((check) => check.id), nextCheckIndex: this.checks.length, ...(result ? { resultEventId: result.eventId } : {}) }, budget });
          continue;
        }
        case 'project_tool_settlement':
          if (state.phase.kind !== 'tools') throw new Error(`Run ${state.runId} has a contradictory tool projection instruction.`);
          await this.advanceOperation(operation, instruction, { phase: { kind: 'tools', stage: 'complete', identity: state.phase.identity, toolBatchId: state.phase.toolBatchId, callCount: state.phase.callCount, nextCallIndex: state.phase.callCount }, budget });
          continue;
        case 'finalize': return;
        case 'reconcile_finalization': return;
      }
    }
    throw new Error(`Run ${operation.state().runId} could not enter finalization within its bounded transition path: ${JSON.stringify(operation.state().phase)}.`);
  }
  private operationAcceptance(input: ResolvedAgentRunInput) {
    return Object.freeze({
      runId: input.runId,
      finalizationId: input.finalizationId,
      input: Object.freeze({
        task: input.task,
        instructions: Object.freeze([...(input.instructions ?? [])]),
        contextItems: Object.freeze((input.contextItems ?? []).map((item) => decodeContextItemInput(item)))
      }),
      configuration: this.currentOperationConfiguration()
    });
  }
  private assertRuntimeMatchesOperation(operation: AgentOperationDriver): void {
    const captured = operation.state().configuration;
    const current = this.currentOperationConfiguration();
    if (hashJson(normalizeJsonSafe(captured).value) !== hashJson(normalizeJsonSafe(current).value)) {
      throw new Error(`Run ${operation.state().runId} was captured for a different runtime implementation or configuration.`);
    }
  }
  private currentOperationConfiguration() {
    return Object.freeze({
      providerId: this.options.provider.id,
      providerImplementationId: this.options.provider.implementationId,
      model: this.options.model,
      runtimeImplementationId: 'agent-core.runtime.operation-v1',
      toolImplementationIds: Object.freeze(this.tools.map((tool) => tool.implementationId)),
      checkIds: Object.freeze(this.checks.map((check) => check.id)),
      policyHash: hashJson(this.toolPolicy)
    });
  }
  private captureRuntimeConfiguration(): RuntimeModelConfiguration { return Object.freeze({ model: this.options.model, ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }), ...(this.options.reasoning === undefined ? {} : { reasoning: this.options.reasoning }), ...(this.options.responseFormat === undefined ? {} : { responseFormat: this.options.responseFormat }) }); }
  private toolContext(signal: AbortSignal): ToolPreparationContext {
    const services = {
      ...(this.options.toolContext?.services ?? {}),
      ...(this.options.repositories.artifacts ? { artifactRepository: this.options.repositories.artifacts } : {})
    };
    return {
      ...(this.options.toolContext ?? {}),
      ...(Object.keys(services).length > 0 ? { services } : {}),
      policy: this.toolPolicy,
      signal,
      boundary: this.options.toolBoundary
    };
  }
  private async collectContextItems(input: AgentRunInput, turnIndex: number, instructions: readonly AgentEffectiveInstruction[]): Promise<ResolvedContextInputs> {
    const providerItems = this.options.contextProvider ? await this.options.contextProvider({ task: input.task, turnIndex, instructions }) : [];
    return Object.freeze({
      configured: Object.freeze([...(this.options.contextItems ?? [])]),
      provider: Object.freeze([...providerItems]),
      run: Object.freeze([...(input.contextItems ?? [])])
    });
  }
  private estimateAssistantOutput(response: ModelResponse): number { const toolText = response.toolCalls?.length ? `\n${JSON.stringify(response.toolCalls)}` : ''; return this.estimator.estimateText(`${response.content}${response.reasoningSummary ?? ''}${toolText}`); }
  private availableTools(profile?: ModelProfile): CompiledToolDefinition[] {
    const context = this.toolContext(new AbortController().signal);
    return this.tools.filter((tool) => isToolAvailable(tool, this.toolPolicy) && toolRequirementsSatisfied(tool, {
      ...(context.services ? { services: context.services } : {}),
      ...(profile ? { modelInputModalities: profile.modalities.input } : {}),
      hostCapabilities: this.commandExecution?.descriptor.capabilities ?? []
    }));
  }
  private async disposeOwnedProcesses(runId: string, append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>): Promise<Error | undefined> {
    const service = this.commandExecution;
    if (!service) return undefined;
    try {
      const results = await service.disposeRun(runId);
      for (const report of results) {
        const durable = durableProcessTermination(report);
        await append(
          { type: 'process.ended', runId, processId: durable.processId, status: durable.status, result: durable.result },
          `${runId}:process:${durable.processId}:ended`
        );
        await service.acknowledgeTerminalReport(durable.processId);
      }
      return undefined;
    }
    catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }
  private consumeSteeringInstructions(runId: string): string[] { const selected = this.steerQueue.filter((item) => item.runId === runId); removeRunItems(this.steerQueue, runId); return selected.map((item) => item.instruction); }
  private injectSteering(runId: string, input: AgentSteeringInput): AgentSteeringReceipt {
    if (this.activeRunId !== runId) throw new Error(`Run ${runId} is not active.`);
    if (input.instruction.trim().length === 0) throw new Error('Steering instruction must not be empty.');
    assertQueueCapacity(this.steerQueue, AgentRuntime.MAX_STEERING_ITEMS, 'steering');
    const receipt = Object.freeze({ id: randomUUID(), runId, timestamp: new Date().toISOString() });
    this.steerQueue.push({ ...receipt, instruction: input.instruction });
    return receipt;
  }
  private async abortRun(runId: string, reason = 'Agent run aborted.'): Promise<void> {
    const operations = this.activeOperations;
    const operationReady = this.activeOperationReady;
    if (this.activeRunId !== runId || !operations || !operationReady) return;
    const driver = this.activeOperationDriver;
    if (driver?.state().runId === runId) {
      await driver.requestAbort(reason);
    } else {
      await operationReady;
      if (this.activeRunId !== runId || this.activeOperations !== operations) return;
      const attachedDriver = this.activeOperationDriver;
      if (attachedDriver?.state().runId === runId) await attachedDriver.requestAbort(reason);
      else await operations.requestAbort(runId, reason);
    }
    if (this.activeRunId === runId) this.activeAbortController?.abort(reason);
  }
  private scheduleAbortRun(runId: string, reason = 'Agent run aborted.'): Promise<void> {
    const request = this.abortRun(runId, reason);
    this.activeAbortRequest = request;
    void request.finally(() => { if (this.activeAbortRequest === request) this.activeAbortRequest = undefined; }).catch(() => undefined);
    return request;
  }
  private async waitForAbortRequest(runId: string): Promise<void> {
    const request = this.activeRunId === runId ? this.activeAbortRequest : undefined;
    if (request) await request;
  }
}

function durableProcessTermination(value: unknown): { readonly processId: string; readonly status: string; readonly result: import('@agent-core/json').JsonValue } {
  const outer = parseJsonValue(value, { maxDepth: 16, maxCollectionEntries: 20_000, maxStringBytes: 1_000_000, maxTotalBytes: 4_000_000 });
  const normalized = isRecord(outer) && isRecord(outer.result) ? outer.result : outer;
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) throw new Error('Process cleanup returned an invalid terminal result.');
  const record = normalized as import('@agent-core/json').JsonObject;
  if (typeof record.processId !== 'string' || typeof record.status !== 'string') throw new Error('Process cleanup returned an invalid terminal result.');
  const stream = (candidate: unknown) => isRecord(candidate)
    ? { observedBytes: typeof candidate.observedBytes === 'number' ? candidate.observedBytes : 0, capturedBytes: typeof candidate.capturedBytes === 'number' ? candidate.capturedBytes : 0, omittedBytes: typeof candidate.omittedBytes === 'number' ? candidate.omittedBytes : 0 }
    : { observedBytes: 0, capturedBytes: 0, omittedBytes: 0 };
  return {
    processId: record.processId,
    status: record.status,
    result: normalizeJsonSafe({
      owner: record.owner,
      cursorEnd: record.cursorEnd,
      stdout: stream(record.stdout), stderr: stream(record.stderr), combined: stream(record.combined),
      ...(record.artifact === undefined ? {} : { artifact: record.artifact }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(isRecord(outer) && outer.protectedArtifact !== undefined ? { protectedArtifact: outer.protectedArtifact } : {})
    }).value
  };
}
function cleanupFailureDecision(previous: TerminalDecision | undefined, error: Error): TerminalDecision {
  const cleanupDiagnostic = { kind: 'process_cleanup' as const, message: error.message };
  if (!previous) return { executionStatus: 'failed', terminationReason: 'runtime_error', candidate: { status: 'absent' }, errorMessage: `Process cleanup failed: ${error.message}`, turnCount: 0, checkResults: [], cleanupDiagnostic };
  return {
    ...previous,
    executionStatus: 'failed',
    terminationReason: 'runtime_error',
    errorMessage: `${'errorMessage' in previous ? `${previous.errorMessage} ` : ''}Process cleanup failed: ${error.message}`,
    cleanupDiagnostic
  };
}

function runDeadline(controller: AgentRunController, request: ModelRequest): { readonly request: ModelRequest; readonly error: AgentLimitExceededError | undefined; readonly dispose: () => void } {
  const timeout = new AbortController();
  let deadlineError: AgentLimitExceededError | undefined;
  const timer = setTimeout(() => {
    deadlineError = controller.elapsedDeadlineError();
    timeout.abort(deadlineError);
  }, controller.remainingElapsedMs() + 1);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
  return {
    request: createModelRequest({ ...request, signal }),
    get error() { return deadlineError; },
    dispose: () => { clearTimeout(timer); }
  };
}

function recordableModelRequest(request: ModelRequest): Omit<ModelRequest, 'signal'> {
  return createModelRequest({
    model: request.model,
    messages: request.messages,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.keepAlive === undefined ? {} : { keepAlive: request.keepAlive }),
    ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
    ...(request.logprobs === undefined ? {} : { logprobs: request.logprobs }),
    ...(request.topLogprobs === undefined ? {} : { topLogprobs: request.topLogprobs }),
    ...(request.providerOptions === undefined ? {} : { providerOptions: request.providerOptions }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata })
  });
}

function providerExposureReservation(estimate: RequestCostEstimate): EffectExposureReservation {
  return Object.freeze({
    quantities: Object.freeze([
      Object.freeze({ unit: 'prompt_tokens', amount: Math.ceil(estimate.totalPromptTokens) }),
      Object.freeze({ unit: 'completion_tokens', amount: Math.ceil(estimate.outputReserveTokens) })
    ])
  });
}

function providerUsageQuantities(usage: ModelUsage): readonly EffectExposureQuantity[] {
  return Object.freeze([
    Object.freeze({ unit: 'prompt_tokens', amount: Math.ceil(usage.promptTokens) }),
    Object.freeze({ unit: 'completion_tokens', amount: Math.ceil(usage.completionTokens) })
  ]);
}

function durableProviderResponse(response: ModelResponse): ModelResponse {
  return parseModelResponse({
    content: response.content,
    model: response.model,
    provider: response.provider,
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    ...(response.transport === undefined ? {} : { transport: response.transport }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    ...(response.reasoningSummary === undefined ? {} : { reasoningSummary: response.reasoningSummary }),
    ...(response.toolCalls === undefined ? {} : { toolCalls: response.toolCalls }),
    terminationReason: response.terminationReason,
    ...(response.providerTerminationReason === undefined ? {} : { providerTerminationReason: response.providerTerminationReason })
  });
}

function runSignalDeadline(controller: AgentRunController, parentSignal: AbortSignal): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const timeout = new AbortController();
  const timer = setTimeout(() => { timeout.abort(controller.elapsedDeadlineError()); }, controller.remainingElapsedMs() + 1);
  return { signal: AbortSignal.any([parentSignal, timeout.signal]), dispose: () => { clearTimeout(timer); } };
}

function terminalSnapshot(runId: string, finalizationId: string, decision: TerminalDecision, controller: AgentRunController, checks: readonly AgentCheckDefinition[]): AgentTerminalSnapshot {
  const common = { runId, finalizationId, phase: 'ended' as const, turnCount: decision.turnCount, candidate: decision.candidate, checkResults: decision.checkResults, budget: controller.snapshot(),
    ...('modelTerminationReason' in decision ? { modelTerminationReason: decision.modelTerminationReason } : {}),
    ...('providerTerminationReason' in decision ? { providerTerminationReason: decision.providerTerminationReason } : {}),
    ...('exhaustedLimit' in decision ? { exhaustedLimit: decision.exhaustedLimit } : {}),
    ...(decision.cleanupDiagnostic ? { cleanupDiagnostic: decision.cleanupDiagnostic } : {}) };
  if (decision.executionStatus === 'completed') {
    if (common.candidate.status === 'absent') throw new Error('Completed execution requires a present candidate.');
    return createAgentTerminalSnapshot({ ...common, candidate: common.candidate, executionStatus: 'completed', terminationReason: decision.terminationReason, verificationStatus: deriveAgentVerificationStatus(checks, decision.checkResults) });
  }
  if (decision.executionStatus === 'aborted') {
    const candidate = common.candidate;
    if (candidate.status !== 'absent' && candidate.status !== 'partial') throw new Error('Aborted execution can only preserve a partial candidate.');
    const abortedCandidate: import('./run/contracts.js').AgentAbortedTerminalSnapshot['candidate'] = candidate.status === 'absent'
      ? candidate
      : Object.freeze({ ...candidate, status: 'partial' });
    return createAgentTerminalSnapshot({ ...common, candidate: abortedCandidate, executionStatus: 'aborted', terminationReason: 'aborted', verificationStatus: 'not_run', errorMessage: decision.errorMessage });
  }
  return createAgentTerminalSnapshot({ ...common, executionStatus: 'failed', terminationReason: decision.terminationReason, verificationStatus: 'not_run', errorMessage: decision.errorMessage });
}

function candidateFromResponse(response: ModelResponse, turnIndex: number, continuingWithTools: boolean): AgentCandidate {
  if (continuingWithTools) return { status: 'absent' };
  const message = finalMessageFromResponse(response);
  if (!message) return { status: 'absent' };
  const source = response.content.trim().length > 0 ? 'content' as const : 'reasoning_summary' as const;
  const status = response.terminationReason === 'stop' ? 'complete' as const : response.terminationReason === 'output_limit' || response.terminationReason === 'content_filter' || response.terminationReason === 'tool_calls' ? 'partial' as const : 'indeterminate' as const;
  return { status, message, source, turnIndex };
}
function completedDecision(candidate: AgentPresentCandidate, turnCount: number, checkResults: readonly AgentCheckResult[], response: ModelResponse): TerminalDecision {
  const terminationReason = response.terminationReason === 'stop' ? 'model_completed' : response.terminationReason === 'output_limit' ? 'model_output_limit' : response.terminationReason === 'content_filter' ? 'content_filtered' : 'unknown_model_termination';
  return { executionStatus: 'completed', terminationReason, candidate, turnCount, checkResults, modelTerminationReason: response.terminationReason, ...(response.providerTerminationReason ? { providerTerminationReason: response.providerTerminationReason } : {}) };
}
function failedDecision(reason: Extract<TerminalDecision, { executionStatus: 'failed' }>['terminationReason'], candidate: AgentCandidate, errorMessage: string, turnCount: number, checkResults: readonly AgentCheckResult[], response: ModelResponse): TerminalDecision {
  return { executionStatus: 'failed', terminationReason: reason, candidate: partialOrAbsent(candidate), errorMessage, turnCount, checkResults, modelTerminationReason: response.terminationReason, ...(response.providerTerminationReason ? { providerTerminationReason: response.providerTerminationReason } : {}) };
}
function partialOrAbsent(candidate: AgentCandidate): AgentCandidate { return candidate.status === 'absent' ? candidate : { ...candidate, status: 'partial' }; }
function decisionBeforeFinalization(decision: TerminalDecision, signal: AbortSignal): TerminalDecision {
  if (!signal.aborted || decision.executionStatus === 'aborted' || decision.cleanupDiagnostic) return decision;
  return {
    executionStatus: 'aborted',
    terminationReason: 'aborted',
    candidate: partialOrAbsent(decision.candidate),
    errorMessage: abortReason(signal.reason),
    turnCount: decision.turnCount,
    checkResults: decision.checkResults
  };
}
function applicationInstructions(input: readonly AgentInstruction[] | undefined): AgentEffectiveInstruction[] { return (input ?? []).map((item, index) => ({ id: item.id.length > 0 ? item.id : `application-${String(index + 1)}`, content: item.content, provenance: 'application', ...(item.role ? { role: item.role } : {}), ...(item.sourceUri ? { sourceUri: item.sourceUri } : {}), ...(item.priority === undefined ? {} : { priority: item.priority }) })); }
function runInstructions(input: readonly string[] | undefined): AgentEffectiveInstruction[] { return (input ?? []).map((content, index) => ({ id: `run-${String(index + 1)}`, content, provenance: 'run' })); }
function steeringInstructions(input: readonly string[], offset: number): AgentEffectiveInstruction[] { return input.map((content, index) => ({ id: `steering-${String(offset + index + 1)}`, content, provenance: 'steering' })); }
function contextSourceIds(items: readonly ContextItemInput[] | undefined, provenance: 'configured' | 'provider' | 'run'): string[] {
  return (items ?? []).map((item, index) => isRecord(item) && typeof item.id === 'string' && item.id.length > 0
    ? item.id
    : `${provenance}-context-${String(index + 1)}-${hashJson(normalizeJsonSafe(item).value).slice(0, 12)}`);
}
function turnIdentity(snapshot: AgentTurnSnapshotRecord): AgentTurnIdentity { return { turnIndex: snapshot.turnIndex, turnId: snapshot.turnId, requestAttempt: snapshot.requestAttempt }; }
function sameTurnIdentity(left: AgentTurnIdentity, right: AgentTurnIdentity): boolean { return left.turnIndex === right.turnIndex && left.turnId === right.turnId && left.requestAttempt === right.requestAttempt; }
function formatOverflowDiagnostic(diagnostic: OverflowDiagnostic): string { return ['Request assembly exceeded budget after overflow recovery.', `Reason: ${diagnostic.reason}.`, `Components: messages=${String(diagnostic.messageTokens)}, contextHistory=${String(diagnostic.contextHistoryTokens)}, context=${String(diagnostic.contextTokens)}, evidence=${String(diagnostic.evidenceTokens)}, toolSchemas=${String(diagnostic.toolSchemaTokens)}, outputReserve=${String(diagnostic.outputReserveTokens)}.`, `Total request tokens=${String(diagnostic.totalRequestTokens)}.`, `Recovery actions attempted=${diagnostic.reductionsAttempted.map(formatOverflowAction).join(', ') || 'none'}.`].join(' '); }
function formatOverflowAction(action: OverflowRecoveryAction): string { if (action.kind === 'reduce_context_history') return `reduce_context_history(${String(action.reductions)})`; if (action.kind === 'reduce_context') return `reduce_context(${String(action.removedItems)})`; if (action.kind === 'install_checkpoint') return `install_checkpoint(${String(action.compactedToolResults)})`; return action.kind; }
class RequestAssemblyError extends Error {}
function modelStreamInterrupted(input: { turnIndex: number; cause: unknown; content: string; reasoningSummary: string; finalResponseReceived: boolean }): ModelStreamInterruptedError { return new ModelStreamInterruptedError({ turnIndex: input.turnIndex, cause: input.cause, content: input.content, finalResponseReceived: input.finalResponseReceived, ...(input.reasoningSummary.length > 0 ? { reasoningSummary: input.reasoningSummary } : {}) }); }
function operationInput(state: import('./operation/contracts.js').AgentOperationState): ResolvedAgentRunInput {
  return {
    task: state.input.task,
    runId: state.runId,
    finalizationId: state.finalizationId,
    instructions: state.input.instructions,
    contextItems: state.input.contextItems
  };
}
function bindExternalAbort(external: AbortSignal | undefined, requestAbort: () => Promise<void>, controller: AbortController): () => void {
  if (!external) return () => undefined;
  const abort = () => { void requestAbort().catch((error: unknown) => { controller.abort(error); }); };
  external.addEventListener('abort', abort, { once: true });
  return () => { external.removeEventListener('abort', abort); };
}
function abortReason(reason: unknown): string { return reason instanceof Error ? reason.message : typeof reason === 'string' && reason.length > 0 ? reason : 'Agent run aborted.'; }
function throwIfAborted(signal: AbortSignal): void { if (!signal.aborted) return; throw signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Agent run aborted.'); }
async function safePersist(append: (event: AgentAuditEvent) => Promise<unknown>, event: AgentAuditEvent): Promise<void> { try { await append(event); } catch { /* Terminal finalization will report its own persistence state. */ } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validateToolBoundary(value: unknown): asserts value is ToolAuthorizationBoundary {
  if (!isRecord(value)) throw new Error('toolBoundary must be an object.');
  for (const [name, member] of Object.entries(value)) {
    if (typeof member !== 'string' || member.trim().length === 0) throw new Error(`toolBoundary.${name} must be a non-empty string.`);
  }
  if (typeof value.authorizationPolicyId !== 'string' || typeof value.executionTargetId !== 'string') throw new Error('toolBoundary requires authorizationPolicyId and executionTargetId.');
}
function removeRunItems(items: { readonly runId: string }[], runId: string): void { for (let index = items.length - 1; index >= 0; index -= 1) if (items[index]?.runId === runId) items.splice(index, 1); }
function assertQueueCapacity(items: readonly unknown[], maximum: number, label: string): void { if (items.length >= maximum) throw new Error(`${label} queue limit of ${String(maximum)} was reached.`); }
function operationSuspension(state: import('./operation/contracts.js').AgentOperationState): AgentRunResult {
  if (!state.budget) throw new Error(`Run ${state.runId} has no durable budget at its suspension boundary.`);
  const phase = state.phase;
  if (phase.kind === 'provider' && phase.stage === 'outcome_unknown') return Object.freeze({ state: 'suspended', reason: 'provider_outcome_unknown', runId: state.runId, finalizationId: state.finalizationId, effectId: phase.effect.intent.effectId, budget: state.budget });
  if (phase.kind !== 'suspended') throw new Error(`Run ${state.runId} is not suspended.`);
  if (phase.reason === 'approval_required') throw new Error(`Run ${state.runId} requires approval request reconstruction.`);
  return Object.freeze({
    state: 'suspended',
    reason: phase.reason,
    runId: state.runId,
    finalizationId: state.finalizationId,
    ...(phase.effectId ? { effectId: phase.effectId } : {}),
    budget: state.budget
  });
}
function completedRunControl(runId: string, result: AgentRunResult): AgentRunControl {
  return Object.freeze({ runId, injectSteering() { throw new Error(`Run ${runId} is not active.`); }, abort: () => Promise.resolve(), result: Promise.resolve(result) });
}
function approvalFromEvent(event: Extract<AgentEvent, { type: 'approval.requested' }>): AgentApprovalRequest {
  return Object.freeze({ runId: event.runId, turnIndex: event.turnIndex, turnId: event.turnId, requestAttempt: event.requestAttempt, toolBatchId: event.toolBatchId, callIndex: event.callIndex, ...(event.callId ? { callId: event.callId } : {}), approvalId: event.approvalId, status: 'pending', toolName: event.toolName, fingerprint: event.fingerprint, input: event.input, effects: event.effects, binding: event.binding, policyHash: event.policyHash, reason: event.reason });
}
function toolRecoveryState(records: readonly AgentEvent[], toolBatchId: string, callCount: number): readonly ToolCallRecoveryState[] {
  const recovery: ToolCallRecoveryState[] = [];
  for (let callIndex = 0; callIndex < callCount; callIndex += 1) {
    const starts = records.filter((event): event is Extract<AgentEvent, { type: 'tool.started' }> => event.type === 'tool.started' && event.toolBatchId === toolBatchId && event.callIndex === callIndex);
    const endings = records.filter((event): event is Extract<AgentEvent, { type: 'tool.ended' }> => event.type === 'tool.ended' && event.toolBatchId === toolBatchId && event.callIndex === callIndex);
    if (endings.some((ended) => !starts.some((started) => started.toolAttempt === ended.toolAttempt))) throw new Error(`Tool recovery invariant failed: call ${String(callIndex)} ended without a matching start.`);
    const latest = [...starts].sort((left, right) => right.toolAttempt - left.toolAttempt)[0];
    if (!latest) { recovery.push({ callIndex, lastAttempt: 0 }); continue; }
    const ended = endings.find((event) => event.toolAttempt === latest.toolAttempt);
    if (!ended) {
      recovery.push({ callIndex, lastAttempt: latest.toolAttempt, incompleteStart: { toolAttempt: latest.toolAttempt, fingerprint: latest.fingerprint, effects: latest.effects } });
      continue;
    }
    const observationProjected = records.some((event) => event.type === 'observation.record.created' && event.toolBatchId === toolBatchId && event.callIndex === callIndex && event.toolAttempt === latest.toolAttempt);
    recovery.push({ callIndex, lastAttempt: latest.toolAttempt, completed: { toolAttempt: latest.toolAttempt, observation: ended.observation, observationProjected } });
  }
  return Object.freeze(recovery);
}
function directProviderSession(provider: ModelProvider): ModelProviderSession {
  const stream = provider.stream?.bind(provider);
  return {
    complete: (request) => provider.complete(request),
    ...(stream ? { stream: (request: ModelRequest) => stream(request) } : {}),
  };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
