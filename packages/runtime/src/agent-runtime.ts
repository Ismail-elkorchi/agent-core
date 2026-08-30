import { randomUUID } from 'node:crypto';
import { type ContextHistoryReduction, decodeContextItemInput, type ContextItemInput, ContextManager } from './context/manager.js';
import { hashJson, type EventAppendReceipt } from '@agent-core/evidence';
import { normalizeJsonSafe, parseJsonValue, type JsonValue } from '@agent-core/json';
import {
  NO_EFFECT_EXPOSURE,
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
  isAgentPreparedCheckEffect,
  type AgentCandidate,
  type AgentApprovalRequest,
  type AgentClock,
  type AgentCheckContext,
  type AgentCheckDefinition,
  type AgentCheckObservation,
  type AgentCheckResult,
  type AgentEffectiveInstruction,
  type AgentExactRequestRecord,
  type AgentPresentCandidate,
  type AgentPreparedCheckEffect,
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
  recoverPreparedToolCall,
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
import { AgentVerificationAbortedError, executeAgentCheckAction } from './orchestration/checks.js';
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
import { executeAssistantToolCalls } from './orchestration/tool-execution.js';
import { AgentOperationConflictError, AgentOperationCoordinator, type AgentOperationAdvance, type AgentOperationDriver } from './operation/driver.js';
import { nextAgentOperationInstruction, type AgentCheckPreparationRecord, type AgentOperationPhase, type AgentOperationProcedure, type AgentToolOperationPhase } from './operation/contracts.js';
import type { AgentToolCallOperationState, AgentToolPreparationRecord } from './operation/tool-state.js';
import {
  isAgentPreparedDispositionEffect,
  parseAgentDispositionDecision,
  parseAgentDispositionEffectReconciliation,
  validateAgentDispositionPolicy,
  type AgentDispositionDecision,
  type AgentDispositionInput,
  type AgentDispositionPolicy,
  type AgentPreparedDispositionEffect
} from './operation/disposition/contracts.js';
import type { AgentDispositionOperationPhase, AgentDispositionPreparationRecord } from './operation/disposition/state.js';

export type {
  AgentCheckContext,
  AgentCheckDefinition,
  AgentCheckObservation,
  AgentCheckRequirement,
  AgentCheckResult,
  AgentCheckVerdict,
  AgentVerificationStatus
} from './run/contracts.js';
export type {
  AgentDispositionDecision,
  AgentDispositionEffectReconciliation,
  AgentDispositionInput,
  AgentDispositionPolicy,
  AgentPreparedDispositionEffect,
  AgentPreparedDispositionEffectInput
} from './operation/disposition/contracts.js';

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
  readonly disposition?: AgentDispositionPolicy;
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
  | { readonly executionStatus: 'failed'; readonly terminationReason: 'model_output_limit' | 'content_filtered' | 'unknown_model_termination' | 'empty_response' | 'malformed_response' | 'provider_error' | 'runtime_error' | 'stream_interrupted' | 'request_too_large' | 'limit_exhausted' | 'candidate_rejected' | 'disposition_inconclusive'; readonly candidate: AgentCandidate; readonly errorMessage: string; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly verificationCompleted?: boolean; readonly modelTerminationReason?: ModelResponse['terminationReason']; readonly providerTerminationReason?: string; readonly exhaustedLimit?: AgentLimitExceededError['limit']; readonly diagnostic?: ModelProviderErrorDiagnostic & { readonly turnIndex?: number }; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } }
  | { readonly executionStatus: 'aborted'; readonly terminationReason: 'aborted'; readonly candidate: AgentCandidate; readonly errorMessage: string; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly diagnostic?: ModelProviderErrorDiagnostic & { readonly turnIndex?: number }; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } };
type ExecutionDecision = TerminalDecision
  | { readonly executionStatus: 'waiting_for_approval'; readonly approvals: readonly AgentApprovalRequest[] }
  | { readonly executionStatus: 'waiting_for_recovery'; readonly reason: 'provider_outcome_unknown' | 'tool_outcome_unknown' | 'disposition_outcome_unknown'; readonly effectId: string };

type DispositionExecutionResult =
  | Readonly<{ readonly kind: 'terminal'; readonly decision: TerminalDecision }>
  | Readonly<{ readonly kind: 'revise'; readonly instruction: string; readonly turnIndex: number }>
  | Readonly<{ readonly kind: 'waiting'; readonly decision: Extract<ExecutionDecision, { readonly executionStatus: 'waiting_for_recovery' }> }>;

interface DispositionExecutionContinuation {
  readonly phase: AgentDispositionOperationPhase;
  readonly input: AgentDispositionInput;
  readonly candidate: AgentPresentCandidate;
  readonly checkResults: readonly AgentCheckResult[];
  readonly response: ModelResponse;
}

interface ProviderExecutionContinuation {
  readonly identity: AgentTurnIdentity;
  readonly toolBatchId: string;
  readonly response: ModelResponse;
  readonly providerState?: import('./events.js').AgentProviderStateReference;
  readonly turnSnapshot: AgentTurnSnapshotRecord;
  readonly requestEstimate: RequestCostEstimate;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly budget: import('./run/contracts.js').AgentRunBudgetState;
}
interface RunExecutionRuntime {
  readonly runId: string;
  readonly input: ResolvedAgentRunInput;
  readonly signal: AbortSignal;
  readonly controller: AgentRunController;
  readonly providerContinuation?: ProviderExecutionContinuation;
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
  readonly verificationCompleted?: boolean;
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
  private readonly disposition: AgentDispositionPolicy;
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
    this.disposition = validateAgentDispositionPolicy(options.disposition);
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

  async resolveApproval(input: { readonly runId: string; readonly approvalId: string; readonly fingerprint: string; readonly decision: 'allow' | 'deny'; readonly signal?: AbortSignal }): Promise<AgentRunControl> {
    const terminal = await this.options.repositories.events.latestOfType(input.runId, 'run.ended');
    if (terminal?.event.type === 'run.ended') return completedRunControl(input.runId, Object.freeze({ state: 'ended', terminal: terminal.event.terminal, deliveryDiagnostics: Object.freeze([]) }));
    const operation = await new AgentOperationCoordinator(this.options.repositories.events).attach(input.runId);
    if (this.hasToolImplementationMismatch(operation) || this.hasDispositionImplementationMismatch(operation)) {
      return completedRunControl(input.runId, missingImplementationSuspension(operation.state()));
    }
    this.assertRuntimeMatchesOperation(operation);
    const phase = operation.state().phase;
    if (phase.kind !== 'approval' || phase.approval.approvalId !== input.approvalId) throw new Error(`Run ${input.runId} is not waiting for approval ${input.approvalId}.`);
    const approval = phase.approval;
    if (approval.fingerprint !== input.fingerprint) throw new Error(`Approval fingerprint mismatch for ${input.approvalId}.`);
    if (approval.binding.authorizationPolicyId !== this.options.toolBoundary.authorizationPolicyId || approval.binding.executionTargetId !== this.options.toolBoundary.executionTargetId) {
      throw new Error(`Approval boundary changed for ${input.approvalId}; a new approval is required.`);
    }
    const call = phase.calls[phase.approvalCallIndex];
    if (!call) throw new Error(`Approval ${input.approvalId} has no durable tool call.`);
    const authorizationContext = Object.freeze({
      ...this.toolContext(input.signal ?? new AbortController().signal),
      invocation: Object.freeze({
        runId: input.runId,
        turnId: approval.turnId,
        requestAttempt: approval.requestAttempt,
        toolBatchId: approval.toolBatchId,
        callIndex: approval.callIndex,
        ...(approval.callId ? { callId: approval.callId } : {}),
        toolAttempt: 1
      })
    });
    const current = await prepareToolCall(call, this.tools, authorizationContext);
    if (!current.ok) throw new Error(`Approved tool call is no longer valid: ${current.observation.summary}`);
    const validationFailure = current.prepared.toolImplementationId !== approval.binding.toolImplementationId
      ? new Error(`Approved tool implementation changed for ${input.approvalId}; a new approval is required.`)
      : current.prepared.fingerprint !== approval.fingerprint
        ? new Error(`Approval fingerprint changed for ${input.approvalId}; a new approval is required.`)
        : undefined;
    try { await releasePreparedToolCall(current.prepared); }
    catch (releaseFailure) {
      if (validationFailure !== undefined) throw new AggregateError([validationFailure, releaseFailure], 'Approval validation and preparation release both failed.', { cause: releaseFailure });
      throw releaseFailure;
    }
    if (validationFailure !== undefined) throw validationFailure;
    await operation.append({
      type: 'approval.resolved', runId: input.runId, turnIndex: approval.turnIndex, turnId: approval.turnId,
      requestAttempt: approval.requestAttempt, toolBatchId: approval.toolBatchId, callIndex: approval.callIndex,
      ...(approval.callId ? { callId: approval.callId } : {}), approvalId: approval.approvalId,
      fingerprint: approval.fingerprint, binding: approval.binding, decision: input.decision
    }, `${input.runId}:approval:${input.approvalId}:resolved`);
    await operation.decideApproval(input);
    const recoverySignal = input.signal ?? new AbortController().signal;
    if (!await this.reconcileDurableToolBatch(operation, recoverySignal)) {
      return completedRunControl(input.runId, operationSuspension(operation.state()));
    }
    return this.startRun(operationInput(operation.state(), input.signal), undefined, operation);
  }

  private startRun(input: ResolvedAgentRunInput, providerContinuation?: ProviderExecutionContinuation, operation?: AgentOperationDriver): AgentRunControl {
    const result = this.runActive(input, providerContinuation, operation);
    return Object.freeze({
      runId: input.runId,
      injectSteering: (steering: AgentSteeringInput) => this.injectSteering(input.runId, steering),
      abort: (reason?: string) => this.scheduleAbortRun(input.runId, reason),
      result
    });
  }

  private async runActive(input: ResolvedAgentRunInput, providerContinuation?: ProviderExecutionContinuation, attachedOperation?: AgentOperationDriver): Promise<AgentRunResult> {
    if (this.activeAbortController) throw new Error('AgentRuntime already has an active run.');
    const { runId } = input;
    const abortController = new AbortController();
    const operations = new AgentOperationCoordinator(this.options.repositories.events);
    const operationReady = attachedOperation
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
      return await this.runInternal(input, abortController.signal, operation, providerContinuation, attachedOperation !== undefined);
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
      if (this.hasToolImplementationMismatch(operation) || this.hasDispositionImplementationMismatch(operation)) return missingImplementationSuspension(operation.state());
      this.assertRuntimeMatchesOperation(operation);
      if (signal?.aborted) await this.scheduleAbortRun(runId, abortReason(signal.reason));
      else cleanupExternalAbort = bindExternalAbort(signal, () => this.scheduleAbortRun(runId, abortReason(signal?.reason)), abortController);
      const operationState = operation.state();
      if (operationState.control.status === 'abort_requested') {
        abortController.abort(operationState.control.reason);
        return await this.runInternal(operationInput(operationState), abortController.signal, operation, undefined, true);
      }
      const phase = operationState.phase;
      if (phase.kind === 'approval') return this.approvalSuspension(operationState);
      if (phase.kind === 'suspended') return operationSuspension(operationState);
      if (phase.kind === 'provider' && phase.stage === 'effect_ready') {
        const closed = closeExternalEffect(phase.effect, 'cancelled_before_start');
        const decisionRequest = cancelledProviderStartDecisionRequest(operation.state(), closed.intent.effectId);
        await this.advanceOperation(operation, 'start_provider_request', {
          phase: {
            kind: 'suspended', reason: 'user_decision', effectId: closed.intent.effectId, decisionRequest,
            continuation: {
              kind: 'cancelled_provider_start',
              blockedProvider: {
                kind: 'provider', identity: phase.identity, toolBatchId: phase.toolBatchId,
                requestEventId: phase.requestEventId, responseId: phase.responseId, effect: closed
              }
            }
          },
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
        const continuation = await this.providerExecutionContinuation(reconciledState);
        return await this.runInternal(operationInput(reconciledState), abortController.signal, operation, continuation, true);
      }
      if (phase.kind === 'tools' && !await this.reconcileDurableToolBatch(operation, abortController.signal)) {
        return operationSuspension(operation.state());
      }
      const recoverablePhase = operation.state().phase;
      if (recoverablePhase.kind !== 'accepted' && recoverablePhase.kind !== 'preparing' && recoverablePhase.kind !== 'tools' && recoverablePhase.kind !== 'verification' && recoverablePhase.kind !== 'disposition') {
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

  private async runInternal(input: ResolvedAgentRunInput, signal: AbortSignal, operation: AgentOperationDriver, providerContinuation?: ProviderExecutionContinuation, restoring = false): Promise<AgentRunResult> {
    const { runId, finalizationId } = input;
    const durableState = operation.state();
    const controller = new AgentRunController({
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(durableState.budget ? { initialBudget: durableState.budget, initialToolCalls: durableState.toolCalls } : {})
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
      await this.advanceOperation(operation, 'prepare', { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: providerContinuation?.identity.turnIndex ?? 1 }, budget: controller.snapshot() });
    }
    let decision: ExecutionDecision;
    try {
      decision = await this.executeRun({ runId, input, signal, controller, operation, append, emit, ...(providerContinuation ? { providerContinuation } : {}), ...(restoring ? { restoring: true } : {}) });
    } catch (error) {
      if (error instanceof AgentOperationOwnershipLostError || error instanceof AgentDispositionCommitInterruptedError) throw error;
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
    let checkResults: AgentCheckResult[] = [];
    const initialPhase = runtime.operation.state().phase;
    const initialToolPhase = initialPhase.kind === 'tools' || initialPhase.kind === 'approval' ? initialPhase : undefined;
    const durableInstructions = initialToolPhase?.instructions;
    const effectiveInstructions = durableInstructions
      ? [...durableInstructions]
      : runtime.providerContinuation
        ? [...runtime.providerContinuation.instructions]
        : [...applicationInstructions(this.options.instructions), ...runInstructions(runtime.input.instructions), ...dispositionInstructions(runtime.operation.state().revisionInstructions)];
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
      ...(runtime.restoring || runtime.providerContinuation ? { runIds: [runtime.runId] } : {})
    });
    const contextManager = replay.contextManager;
    const observationStore = new ObservationStore({ estimator: this.estimator, ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}) });
    if (!runtime.restoring) {
      await runtime.append({ type: 'run.started', runId: runtime.runId, finalizationId: runtime.input.finalizationId, task: runtime.input.task, model: this.options.model, toolPolicy: this.toolPolicy, ...(this.options.metadata ? { metadata: this.options.metadata } : {}) }, `${runtime.runId}:started`);
      await runtime.append({ type: 'run.phase.changed', runId: runtime.runId, phase: 'preparing', budget: runtime.controller.snapshot() });
    }
    if (this.options.repositories.session && !runtime.restoring) {
      const replayEvent = { type: 'context.replay.created' as const, sessionId: this.options.repositories.session.descriptor.id,
        replayedLedgers: replay.replayedLedgers, replayedTurns: replay.replayedTurns, replayedSessionEntries: replay.replayedSessionEntries,
        replayedCheckpoints: replay.replayedCheckpoints, replayedToolResults: replay.replayedToolResults, replayedEvidenceRecords: replay.replayedEvidenceRecords,
        ...(replay.providerStateSummary ? { restoredProviderState: replay.providerStateSummary } : {}), ...(replay.providerStateRef ? { restoredProviderStateRef: replay.providerStateRef } : {}) };
      await runtime.append(replayEvent);
      await runtime.emit({ ...replayEvent, type: 'context.replay.restored' });
    }
    if (!runtime.restoring) await runtime.append({ type: 'input.received', task: runtime.input.task });
    let sessionEntryId: string | undefined;
    if (this.options.repositories.session && !runtime.restoring) {
      const inputEntry = await this.options.repositories.session.repository.appendInput(this.options.repositories.session.descriptor, { runId: runtime.runId, task: runtime.input.task, instructions: effectiveInstructions });
      sessionEntryId = inputEntry.id;
    }
    throwIfAborted(runtime.signal);

    let revisedTurnIndex: number | undefined;
    if (initialPhase.kind === 'verification' || initialPhase.kind === 'disposition') {
      runtime.controller.transition('requesting_model');
      if (initialPhase.kind === 'verification') {
        const continuation = await this.verificationExecutionContinuation(runtime.runId, initialPhase);
        await this.enterPhase(runtime.runId, runtime.controller, 'verifying', runtime.append, runtime.emit);
        checkResults = [...await this.executeVerificationChecks({
          runtime,
          instructions: continuation.instructions,
          candidate: continuation.candidate,
          contextManager
        })];
        await this.enterDisposition(runtime, continuation.candidate, checkResults, continuation.response);
      } else {
        runtime.controller.transition('verifying');
      }
      await this.enterPhase(runtime.runId, runtime.controller, 'deciding', runtime.append, runtime.emit);
      const disposition = await this.executeDisposition(runtime);
      if (disposition.kind === 'terminal') return disposition.decision;
      if (disposition.kind === 'waiting') return disposition.decision;
      effectiveInstructions.push(dispositionInstruction(disposition.instruction, runtime.operation.state().revisionInstructions.length));
      checkResults = [];
      revisedTurnIndex = disposition.turnIndex;
    }

    let turnIndex = revisedTurnIndex ?? (initialToolPhase
      ? initialToolPhase.identity.turnIndex
      : runtime.providerContinuation?.identity.turnIndex ?? (initialPhase.kind === 'preparing' ? initialPhase.turnIndex : 1));
    let lastStartedTurnIndex = 0;
    let activeCandidate: AgentCandidate = { status: 'absent' };
    let activeTurnIdentity: AgentTurnIdentity | undefined;
    let modelSession: ModelProviderSession | undefined;
    let sessionModel: string | undefined;
    let replayRestored = false;
    try {
      if (initialPhase.kind === 'tools') {
        const resumeDecision = await this.resumeDurableToolBatch(runtime, contextManager, observationStore);
        if (resumeDecision) return resumeDecision;
        turnIndex += 1;
      }
      let providerResume = runtime.providerContinuation;
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
            ...(this.options.repositories.session ? { sessionId: this.options.repositories.session.descriptor.id } : {}), ...(sessionEntryId ? { sessionEntryId } : {}) };
          await runtime.append(turnStarted);
          await runtime.emit(turnStarted);
          if (this.options.repositories.session && turnIndex === 1) {
            await this.options.repositories.session.repository.appendModelSettings(this.options.repositories.session.descriptor, {
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
            await this.options.repositories.session?.repository.appendObservation(this.options.repositories.session.descriptor, { runId: runtime.runId, identity: turnIdentity(snapshot.record), toolName: 'assistant_response', observation: { ok: false, summary: emptyMessage, output: { content: response.content } } });
            await this.advanceOperation(runtime.operation, 'consume_provider_settlement', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
            return failedDecision('empty_response', activeCandidate, emptyMessage, turnIndex, checkResults, response);
          }
          const providerSettlement = runtime.operation.state().phase;
          if (providerSettlement.kind !== 'provider' || providerSettlement.stage !== 'settled') throw new Error('Verification requires an exact settled provider response.');
          await this.advanceOperation(runtime.operation, 'consume_provider_settlement', {
            phase: {
              kind: 'verification', stage: this.checks.length === 0 ? 'complete' : 'ready', identity: providerSettlement.identity,
              providerSettlementEventId: providerSettlement.settlementEventId,
              checkIds: this.checks.map((check) => check.id), nextCheckIndex: 0
            },
            budget: runtime.controller.snapshot()
          });
          await this.enterPhase(runtime.runId, runtime.controller, 'verifying', runtime.append, runtime.emit);
          checkResults = [...await this.executeVerificationChecks({ runtime, instructions: snapshot.instructions, candidate: activeCandidate, contextManager })];
          await this.enterDisposition(runtime, activeCandidate, checkResults, response);
          await this.enterPhase(runtime.runId, runtime.controller, 'deciding', runtime.append, runtime.emit);
          const disposition = await this.executeDisposition(runtime);
          if (disposition.kind === 'terminal') return disposition.decision;
          if (disposition.kind === 'waiting') return disposition.decision;
          effectiveInstructions.push(dispositionInstruction(disposition.instruction, runtime.operation.state().revisionInstructions.length));
          checkResults = [];
          activeCandidate = { status: 'absent' };
          turnIndex = disposition.turnIndex;
          continue;
        }

        runtime.controller.recordToolCalls(toolCalls);
        contextManager.recordModelOutput({ turnIndex, content: response.content, toolCalls: toolCalls.map(modelToolCallFromToolCall) });
        if (this.options.repositories.session) {
          for (const [callIndex, call] of toolCalls.entries()) {
            await this.options.repositories.session.repository.appendToolCall(this.options.repositories.session.descriptor, {
              runId: runtime.runId,
              identity: { ...activeTurnIdentity, toolBatchId, callIndex, ...(call.id ? { callId: call.id } : {}) },
              call
            });
          }
        }
        await this.advanceOperation(runtime.operation, 'consume_provider_settlement', {
          phase: {
            kind: 'tools', identity: activeTurnIdentity, toolBatchId, calls: toolCalls,
            callStates: Object.freeze(toolCalls.map(() => Object.freeze({ stage: 'ready' as const }))),
            maxConcurrency: runtime.controller.limits.maxConcurrentToolCalls, nextProjectionIndex: 0,
            instructions: Object.freeze([...effectiveInstructions]),
            modelInputModalities: snapshot.profile.modalities.input
          },
          budget: runtime.controller.snapshot(),
          toolCalls: Object.freeze([...runtime.operation.state().toolCalls, ...toolCalls])
        });
        await this.enterPhase(runtime.runId, runtime.controller, 'executing_tools', runtime.append, runtime.emit);
        const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
        let toolResult;
        try {
          toolResult = await executeAssistantToolCalls({
            runId: runtime.runId, driverGeneration: runtime.operation.state().driverGeneration,
            tools: this.tools, toolContext: this.toolContext(toolDeadline.signal), resourceLeases: this.resourceLeases,
            ...(this.options.toolAuthorizer ? { authorizer: this.options.toolAuthorizer } : {}), contextManager, observationStore,
            ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}), controller: runtime.controller,
            phase: () => runtime.operation.state().phase,
            transition: (procedure, update) => this.advanceOperation(runtime.operation, procedure, (state) => ({ phase: update(state.phase), budget: runtime.controller.snapshot() })),
            settle: (settlement) => this.settleToolEffect(runtime.operation, settlement),
            append: runtime.append, emit: runtime.emit
          });
        } finally { toolDeadline.dispose(); }
        if (toolResult.outcome === 'waiting_for_approval') {
          return { executionStatus: 'waiting_for_approval', approvals: toolResult.approvals };
        }
        if (toolResult.outcome === 'ownership_lost') throw new AgentOperationOwnershipLostError(runtime.runId);
        if (toolResult.outcome === 'waiting_for_recovery') return toolRecoveryDecision(runtime.operation.state());
        await this.advanceOperation(runtime.operation, 'advance_after_tools', { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: turnIndex + 1 }, budget: runtime.controller.snapshot() });
        turnIndex += 1;
      }
      throw new Error('Model-turn execution exhausted its available entries without a terminal or limit decision.');
    } catch (error) {
      if (error instanceof AgentOperationOwnershipLostError || error instanceof AgentDispositionCommitInterruptedError || error instanceof AgentExecutionError) throw error;
      throw new AgentExecutionError(error, { lastStartedTurnIndex, activeCandidate, checkResults: [...checkResults], ...(activeTurnIdentity ? { activeTurnIdentity } : {}) });
    } finally {
      await modelSession?.close?.();
    }
  }

  private async executeVerificationChecks(input: {
    readonly runtime: RunExecutionRuntime;
    readonly instructions: readonly AgentEffectiveInstruction[];
    readonly candidate: AgentPresentCandidate;
    readonly contextManager: ContextManager;
  }): Promise<readonly AgentCheckResult[]> {
    const metadataValue = normalizeJsonSafe(this.options.metadata ?? {}).value;
    const metadata = isRecord(metadataValue) ? metadataValue : Object.freeze({});
    const execution = contextEvidenceExecution({
      contextManager: input.contextManager,
      ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}),
      ...(this.options.verification ? { configured: this.options.verification } : {})
    });
    const initial = input.runtime.operation.state().phase;
    if (initial.kind !== 'verification') throw new Error(`Run ${input.runtime.runId} is not at its verification boundary.`);
    const results = [...await this.completedVerificationResults(input.runtime.runId, initial)];
    let retained: AgentPreparedCheckEffect | undefined;

    try {
      for (;;) {
        throwIfAborted(input.runtime.signal);
        const phase = input.runtime.operation.state().phase;
        if (phase.kind !== 'verification') throw new Error(`Run ${input.runtime.runId} left verification before its checks completed.`);
        if (phase.stage === 'complete') return Object.freeze(results);
        const check = this.checks[phase.nextCheckIndex];
        if (!check || check.id !== phase.checkIds[phase.nextCheckIndex]) throw new Error(`Run ${input.runtime.runId} is missing its captured verifier at index ${String(phase.nextCheckIndex)}.`);
        const context = verificationContext({
          runId: input.runtime.runId,
          task: input.runtime.input.task,
          instructions: input.instructions,
          candidate: input.candidate,
          identity: phase.identity,
          metadata,
          signal: input.runtime.signal,
          execution
        });
        const base = verificationPhaseBase(phase);
        const timeoutMs = check.timeoutMs ?? 30_000;
        const eventKey = `${input.runtime.runId}:verification:${phase.identity.turnId}:${String(phase.identity.requestAttempt)}:${String(phase.nextCheckIndex)}:${check.id}`;

        if (phase.stage === 'ready') {
          await input.runtime.append({
            type: 'check.started', ...phase.identity, check: check.id,
            implementationId: check.implementationId, requirement: check.requirement, timeoutMs
          }, `${eventKey}:started`);
          if (check.kind === 'deterministic') {
            await this.advanceOperation(input.runtime.operation, 'prepare_verification', {
              phase: { ...base, stage: 'deterministic_pending' }, budget: input.runtime.controller.snapshot()
            });
            continue;
          }
          let preparedOutcome: AgentCheckObservation | AgentPreparedCheckEffect;
          try { preparedOutcome = await check.prepare(context); }
          catch (error) {
            const result = await executeAgentCheckAction({
              check, timeoutMs, parentSignal: input.runtime.signal, context,
              action: () => Promise.reject(error instanceof Error ? error : new Error(String(error)))
            });
            await this.advanceOperation(input.runtime.operation, 'prepare_verification', {
              phase: { ...base, stage: 'settled', result }, budget: input.runtime.controller.snapshot()
            });
            continue;
          }
          if (!isAgentPreparedCheckEffect(preparedOutcome)) {
            const result = await executeAgentCheckAction({
              check, timeoutMs, parentSignal: input.runtime.signal, context,
              action: () => Promise.resolve(preparedOutcome)
            });
            await this.advanceOperation(input.runtime.operation, 'prepare_verification', {
              phase: { ...base, stage: 'settled', result }, budget: input.runtime.controller.snapshot()
            });
            continue;
          }
          retained = preparedOutcome;
          const preparation = checkPreparation(check, retained);
          const effectId = `${input.runtime.runId}:verification:${String(phase.nextCheckIndex)}:${check.implementationId}`;
          const generation = input.runtime.operation.state().driverGeneration;
          const issued = issueEffectStartTicket({
            intent: Object.freeze({
              effectId,
              operationId: input.runtime.runId,
              implementationId: check.implementationId,
              parametersDigest: preparation.fingerprint,
              recovery: preparation.recovery,
              exposure: NO_EFFECT_EXPOSURE
            }),
            ticketId: `${effectId}:start:${String(generation)}`,
            settlementPermitId: `${effectId}:settle:${String(generation)}`,
            driverGeneration: generation,
            currentDriverGeneration: generation
          });
          if (issued.status !== 'issued') throw new AgentOperationOwnershipLostError(input.runtime.runId);
          await this.advanceOperation(input.runtime.operation, 'prepare_verification', {
            phase: { ...base, stage: 'effect_ready', preparation, effect: issued.state },
            budget: input.runtime.controller.snapshot()
          });
          continue;
        }

        if (phase.stage === 'deterministic_pending') {
          if (check.kind !== 'deterministic') throw new Error(`Verifier ${check.id} changed kind after its durable preparation.`);
          const result = await executeAgentCheckAction({
            check, timeoutMs, parentSignal: input.runtime.signal, context,
            action: (activeContext) => check.run(activeContext)
          });
          await this.advanceOperation(input.runtime.operation, 'reconcile_verification', {
            phase: { ...base, stage: 'settled', result }, budget: input.runtime.controller.snapshot()
          });
          continue;
        }

        if (phase.stage === 'effect_ready') {
          if (check.kind !== 'effect') throw new Error(`Verifier ${check.id} changed kind after its durable preparation.`);
          retained = await requireMatchingCheckPreparation(check, context, phase.preparation, retained);
          const started = startExternalEffect(phase.effect, phase.effect.ticket, input.runtime.operation.state().driverGeneration);
          if (started.status !== 'started') throw new AgentOperationOwnershipLostError(input.runtime.runId);
          await this.advanceOperation(input.runtime.operation, 'start_verification', {
            phase: { ...base, stage: 'effect_pending', preparation: phase.preparation, effect: started.state },
            budget: input.runtime.controller.snapshot()
          });
          const activePreparation = retained;
          const result = await executeAgentCheckAction({
            check, timeoutMs, parentSignal: input.runtime.signal, context,
            action: (activeContext) => activePreparation.start(activeContext.signal)
          });
          const settled = settleExternalEffect(started.state, started.state.settlementPermit, {
            outcome: result.diagnostic ? 'failed' : 'succeeded',
            resultDigest: hashJson(normalizeJsonSafe(result).value),
            exposure: knownEffectExposure([])
          });
          if (settled.status !== 'settled' && settled.status !== 'already_settled') throw new Error(`Verifier ${check.id} effect settlement was rejected.`);
          await this.advanceOperation(input.runtime.operation, 'reconcile_verification', {
            phase: { ...base, stage: 'settled', result, effect: settled.state },
            budget: input.runtime.controller.snapshot()
          });
          await activePreparation.release();
          retained = undefined;
          continue;
        }

        if (phase.stage === 'effect_pending') {
          if (check.kind !== 'effect') throw new Error(`Verifier ${check.id} changed kind during recovery.`);
          retained = await requireMatchingCheckPreparation(check, context, phase.preparation, retained);
          const activePreparation = retained;
          const reconciliation = await activePreparation.reconcile(input.runtime.signal);
          let result: AgentCheckResult;
          let effect: Extract<ReturnType<typeof closeExternalEffect>, { readonly phase: 'closed' }> | Extract<ReturnType<typeof settleExternalEffect>, { readonly status: 'settled' | 'already_settled' }>['state'];
          if (reconciliation.status === 'settled') {
            result = await executeAgentCheckAction({
              check, timeoutMs, parentSignal: input.runtime.signal, context,
              action: () => Promise.resolve(reconciliation.observation)
            });
            const settlement = settleExternalEffect(phase.effect, phase.effect.settlementPermit, {
              outcome: result.diagnostic ? 'failed' : 'succeeded',
              resultDigest: hashJson(normalizeJsonSafe(result).value),
              exposure: knownEffectExposure([])
            });
            if (settlement.status !== 'settled' && settlement.status !== 'already_settled') throw new Error(`Verifier ${check.id} reconciliation settlement was rejected.`);
            effect = settlement.state;
          } else {
            const summary = reconciliation.status === 'running'
              ? 'Verifier execution remained active after driver recovery.'
              : reconciliation.status === 'expired'
                ? 'Verifier reconciliation expired before an outcome was recovered.'
                : 'Verifier outcome could not be reconciled.';
            const observation: AgentCheckObservation = {
              verdict: 'unknown', summary,
              diagnostic: { kind: 'unavailable', message: summary }
            };
            result = await executeAgentCheckAction({ check, timeoutMs, parentSignal: input.runtime.signal, context, action: () => Promise.resolve(observation) });
            effect = closeExternalEffect(phase.effect, reconciliation.status === 'expired' ? 'expired' : reconciliation.status === 'unknown' ? 'reconciliation_unavailable' : 'unknown_outcome');
          }
          await this.advanceOperation(input.runtime.operation, 'reconcile_verification', {
            phase: { ...base, stage: 'settled', result, effect }, budget: input.runtime.controller.snapshot()
          });
          await activePreparation.release();
          retained = undefined;
          continue;
        }

        results.push(phase.result);
        await input.runtime.append({ type: 'check.ended', ...phase.identity, check: check.id, result: phase.result }, `${eventKey}:ended`);
        await input.runtime.emit({ type: 'check.ended', ...phase.identity, result: phase.result });
        const nextCheckIndex = phase.nextCheckIndex + 1;
        await this.advanceOperation(input.runtime.operation, 'consume_verification_settlement', {
          phase: {
            ...base,
            stage: nextCheckIndex === phase.checkIds.length ? 'complete' : 'ready',
            nextCheckIndex
          },
          budget: input.runtime.controller.snapshot()
        });
      }
    } finally {
      if (retained) await retained.release();
    }
  }

  private async completedVerificationResults(
    runId: string,
    phase: Extract<import('./operation/contracts.js').AgentOperationPhase, { readonly kind: 'verification' }>
  ): Promise<readonly AgentCheckResult[]> {
    const results = new Map<string, AgentCheckResult>();
    for await (const record of this.options.repositories.events.read(runId)) {
      const event = record.event;
      if (event.type !== 'check.ended' || !sameTurnIdentity(event, phase.identity)) continue;
      if (results.has(event.check)) throw new Error(`Run ${runId} contains duplicate verification settlement for ${event.check}.`);
      results.set(event.check, event.result);
    }
    const completed = phase.checkIds.slice(0, phase.nextCheckIndex).map((checkId) => {
      const result = results.get(checkId);
      if (!result) throw new Error(`Run ${runId} is missing the durable result for completed verifier ${checkId}.`);
      return result;
    });
    return Object.freeze(completed);
  }

  private async enterDisposition(
    runtime: RunExecutionRuntime,
    candidate: AgentPresentCandidate,
    checkResults: readonly AgentCheckResult[],
    response: ModelResponse
  ): Promise<void> {
    const phase = runtime.operation.state().phase;
    if (phase.kind !== 'verification' || phase.stage !== 'complete') throw new Error(`Run ${runtime.runId} is not ready to enter candidate disposition.`);
    const evidence = await this.readDispositionEvidence(runtime.runId, phase.identity, phase.providerSettlementEventId, phase.checkIds);
    if (hashJson(normalizeJsonSafe(evidence.candidate).value) !== hashJson(normalizeJsonSafe(candidate).value)) {
      throw new Error(`Run ${runtime.runId} candidate does not match its exact assistant settlement.`);
    }
    if (hashJson(normalizeJsonSafe(evidence.checkResults).value) !== hashJson(normalizeJsonSafe(checkResults).value)) {
      throw new Error(`Run ${runtime.runId} verification results do not match their exact settlements.`);
    }
    if (hashJson(normalizeJsonSafe(evidence.response).value) !== hashJson(normalizeJsonSafe(response).value)) {
      throw new Error(`Run ${runtime.runId} provider response does not match its exact settlement.`);
    }
    const state = runtime.operation.state();
    if (state.control.status !== 'owned') throw new Error(`Run ${runtime.runId} has no owned control snapshot for candidate disposition.`);
    const budget = runtime.controller.snapshot();
    const controlSnapshot = Object.freeze({ status: 'owned' as const, driverGeneration: state.driverGeneration });
    const input = dispositionInput(state, evidence, budget, controlSnapshot);
    const inputDigest = hashJson(normalizeJsonSafe(input).value);
    await this.advanceOperation(runtime.operation, 'consume_verification_settlement', {
      phase: Object.freeze({
        kind: 'disposition' as const,
        stage: 'ready' as const,
        identity: phase.identity,
        providerSettlementEventId: phase.providerSettlementEventId,
        candidateEventId: evidence.candidateEventId,
        verificationEventIds: evidence.verificationEventIds,
        inputDigest,
        revisionCount: budget.candidateRevisions,
        controlSnapshot,
        budgetSnapshot: budget
      }),
      budget
    });
  }

  private async executeDisposition(runtime: RunExecutionRuntime): Promise<DispositionExecutionResult> {
    let retained: AgentPreparedDispositionEffect | undefined;
    let continuation: DispositionExecutionContinuation | undefined;
    try {
      for (let transitions = 0; transitions < 12; transitions += 1) {
        runtime.controller.assertElapsed();
        const state = runtime.operation.state();
        const phase = state.phase;
        if (phase.kind !== 'disposition') throw new Error(`Run ${runtime.runId} left candidate disposition before it completed.`);
        continuation = await this.dispositionExecutionContinuation(runtime.runId, state, phase);
        const persisted = await this.findDispositionDecision(runtime.runId, continuation);

        if (phase.stage !== 'decided' && persisted) {
          let effect: Extract<ReturnType<typeof settleExternalEffect>, { readonly status: 'settled' | 'already_settled' }>['state'] | undefined;
          if (phase.stage === 'effect_pending') effect = settleDispositionEffect(phase.effect, persisted.event.outputDigest, runtime.runId);
          else if (phase.stage === 'effect_ready' || phase.stage === 'outcome_unknown') {
            throw new Error(`Run ${runtime.runId} has a disposition decision that contradicts its external-effect state.`);
          }
          const instruction = nextAgentOperationInstruction(state);
          if (instruction.kind !== 'execute') throw new Error(`Run ${runtime.runId} cannot consume its persisted disposition decision.`);
          await this.advanceOperation(runtime.operation, instruction.procedure, {
            phase: Object.freeze({
              ...dispositionPhaseBase(phase),
              stage: 'decided' as const,
              decision: persisted.event.decision,
              decisionEventId: persisted.eventId,
              outputDigest: persisted.event.outputDigest,
              ...(effect ? { effect } : {})
            }),
            budget: runtime.controller.snapshot()
          });
          continue;
        }

        if (phase.stage === 'decided') {
          if (persisted?.eventId !== phase.decisionEventId) throw new Error(`Run ${runtime.runId} is missing its exact disposition decision ${phase.decisionEventId}.`);
          if (phase.decision.kind === 'accept') {
            await this.advanceOperation(runtime.operation, 'consume_disposition', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
            return Object.freeze({ kind: 'terminal', decision: completedDecision(continuation.candidate, phase.identity.turnIndex, continuation.checkResults, continuation.response) });
          }
          if (phase.decision.kind === 'fail' || phase.decision.kind === 'inconclusive') {
            await this.advanceOperation(runtime.operation, 'consume_disposition', { phase: { kind: 'finalization', stage: 'ready' }, budget: runtime.controller.snapshot() });
            return Object.freeze({
              kind: 'terminal',
              decision: dispositionFailedDecision(phase.decision, continuation.candidate, phase.identity.turnIndex, continuation.checkResults, continuation.response)
            });
          }
          runtime.controller.recordCandidateRevision();
          const revisionInstructions = Object.freeze([...state.revisionInstructions, phase.decision.instruction]);
          await this.advanceOperation(runtime.operation, 'consume_disposition', {
            phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: phase.identity.turnIndex + 1 },
            budget: runtime.controller.snapshot(),
            revisionInstructions
          });
          return Object.freeze({ kind: 'revise', instruction: phase.decision.instruction, turnIndex: phase.identity.turnIndex + 1 });
        }

        if (phase.stage === 'outcome_unknown') {
          return Object.freeze({ kind: 'waiting', decision: dispositionRecoveryDecision(phase) });
        }

        if (phase.stage === 'ready') {
          if (this.disposition.kind === 'deterministic') {
            const evaluated = this.disposition.evaluate(continuation.input);
            if (isPromiseLike(evaluated)) throw new TypeError(`Deterministic disposition ${this.disposition.implementationId} returned a promise.`);
            const decision = parseAgentDispositionDecision(evaluated);
            await this.commitDispositionDecision(runtime, phase, decision, 'prepare_disposition');
            continue;
          }
          const prepared = await this.disposition.prepare(continuation.input);
          if (!isAgentPreparedDispositionEffect(prepared)) throw new TypeError(`Effect disposition ${this.disposition.implementationId} must return a prepared external effect.`);
          retained = prepared;
          const preparation = dispositionPreparation(this.disposition, continuation.input, retained);
          const generation = state.driverGeneration;
          const effectId = dispositionEffectId(runtime.runId, phase.identity, phase.revisionCount);
          const issued = issueEffectStartTicket({
            intent: Object.freeze({
              effectId,
              operationId: runtime.runId,
              implementationId: this.disposition.implementationId,
              parametersDigest: preparation.fingerprint,
              recovery: preparation.recovery,
              exposure: NO_EFFECT_EXPOSURE
            }),
            ticketId: `${effectId}:start:${String(generation)}`,
            settlementPermitId: `${effectId}:settle:${String(generation)}`,
            driverGeneration: generation,
            currentDriverGeneration: generation
          });
          if (issued.status !== 'issued') throw new AgentOperationOwnershipLostError(runtime.runId);
          await this.advanceOperation(runtime.operation, 'prepare_disposition', {
            phase: Object.freeze({ ...dispositionPhaseBase(phase), stage: 'effect_ready' as const, preparation, effect: issued.state }),
            budget: runtime.controller.snapshot()
          });
          continue;
        }

        if (this.disposition.kind !== 'effect') throw new Error(`Disposition ${this.disposition.implementationId} changed kind after its durable preparation.`);
        if (!retained) {
          const outcome = await this.disposition.prepare(continuation.input);
          if (!isAgentPreparedDispositionEffect(outcome)) throw new Error(`Disposition ${this.disposition.implementationId} no longer requires the external effect captured by its durable intent.`);
          retained = outcome;
        }
        requireMatchingDispositionPreparation(this.disposition, continuation.input, phase.preparation, retained);

        if (phase.stage === 'effect_ready') {
          if (phase.effect.ticket.driverGeneration !== state.driverGeneration) {
            closeExternalEffect(phase.effect, 'cancelled_before_start');
            const issued = issueEffectStartTicket({
              intent: phase.effect.intent,
              ticketId: `${phase.effect.intent.effectId}:start:${String(state.driverGeneration)}`,
              settlementPermitId: `${phase.effect.intent.effectId}:settle:${String(state.driverGeneration)}`,
              driverGeneration: state.driverGeneration,
              currentDriverGeneration: state.driverGeneration
            });
            if (issued.status !== 'issued') throw new AgentOperationOwnershipLostError(runtime.runId);
            await this.advanceOperation(runtime.operation, 'start_disposition', {
              phase: Object.freeze({ ...dispositionPhaseBase(phase), stage: 'effect_ready' as const, preparation: phase.preparation, effect: issued.state }),
              budget: runtime.controller.snapshot()
            });
            continue;
          }
          const started = startExternalEffect(phase.effect, phase.effect.ticket, state.driverGeneration);
          if (started.status !== 'started') throw new AgentOperationOwnershipLostError(runtime.runId);
          await this.advanceOperation(runtime.operation, 'start_disposition', {
            phase: Object.freeze({ ...dispositionPhaseBase(phase), stage: 'effect_pending' as const, preparation: phase.preparation, effect: started.state }),
            budget: runtime.controller.snapshot()
          });
          const active = retained;
          const deadline = runSignalDeadline(runtime.controller, runtime.signal);
          let decision: AgentDispositionDecision;
          try { decision = parseAgentDispositionDecision(await active.start(deadline.signal)); }
          catch {
            return Object.freeze({ kind: 'waiting', decision: dispositionRecoveryDecision(runtime.operation.state().phase) });
          } finally { deadline.dispose(); }
          const settled = settleDispositionEffect(started.state, hashJson(normalizeJsonSafe(decision).value), runtime.runId);
          await this.commitDispositionDecision(runtime, runtime.operation.state().phase, decision, 'reconcile_disposition', settled);
          retained = undefined;
          await active.release();
          continue;
        }

        const active = retained;
        const deadline = runSignalDeadline(runtime.controller, runtime.signal);
        let reconciliation;
        try { reconciliation = parseAgentDispositionEffectReconciliation(await active.reconcile(deadline.signal)); }
        finally { deadline.dispose(); }
        if (reconciliation.status === 'settled') {
          const outputDigest = hashJson(normalizeJsonSafe(reconciliation.decision).value);
          const settled = settleDispositionEffect(phase.effect, outputDigest, runtime.runId);
          await this.commitDispositionDecision(runtime, phase, reconciliation.decision, 'reconcile_disposition', settled);
          retained = undefined;
          await active.release();
          continue;
        }
        if (reconciliation.status === 'expired') {
          const closed = closeExternalEffect(phase.effect, 'expired');
          await this.advanceOperation(runtime.operation, 'reconcile_disposition', {
            phase: Object.freeze({ ...dispositionPhaseBase(phase), stage: 'outcome_unknown' as const, preparation: phase.preparation, effect: closed }),
            budget: runtime.controller.snapshot()
          });
        }
        return Object.freeze({ kind: 'waiting', decision: dispositionRecoveryDecision(runtime.operation.state().phase) });
      }
      throw new Error(`Run ${runtime.runId} exceeded its bounded disposition transition path.`);
    } catch (error) {
      if (error instanceof AgentOperationOwnershipLostError || error instanceof AgentDispositionCommitInterruptedError || error instanceof AgentExecutionError) throw error;
      throw new AgentExecutionError(error, {
        lastStartedTurnIndex: continuation?.phase.identity.turnIndex ?? 0,
        activeCandidate: continuation?.candidate ?? { status: 'absent' },
        checkResults: continuation?.checkResults ?? [],
        ...(continuation ? { activeTurnIdentity: continuation.phase.identity, verificationCompleted: true } : {})
      });
    } finally {
      if (retained) await retained.release();
    }
  }

  private async commitDispositionDecision(
    runtime: RunExecutionRuntime,
    phase: Extract<AgentDispositionOperationPhase, { readonly stage: 'ready' | 'effect_pending' }> | AgentOperationPhase,
    decision: AgentDispositionDecision,
    procedure: 'prepare_disposition' | 'reconcile_disposition',
    effect?: Extract<ReturnType<typeof settleExternalEffect>, { readonly status: 'settled' | 'already_settled' }>['state']
  ): Promise<void> {
    if (phase.kind !== 'disposition' || (phase.stage !== 'ready' && phase.stage !== 'effect_pending')) throw new Error(`Run ${runtime.runId} cannot commit a decision outside an active disposition boundary.`);
    const outputDigest = hashJson(normalizeJsonSafe(decision).value);
    const configuration = runtime.operation.state().configuration.disposition;
    try {
      const receipt = await runtime.append({
        type: 'candidate.disposition.decided',
        ...phase.identity,
        revisionCount: phase.revisionCount,
        implementationId: configuration.implementationId,
        policyHash: configuration.policyHash,
        inputDigest: phase.inputDigest,
        outputDigest,
        decision
      }, `${runtime.runId}:disposition:${phase.inputDigest}:decision`);
      await this.advanceOperation(runtime.operation, procedure, {
        phase: Object.freeze({
          ...dispositionPhaseBase(phase),
          stage: 'decided' as const,
          decision,
          decisionEventId: receipt.eventId,
          outputDigest,
          ...(effect ? { effect } : {})
        }),
        budget: runtime.controller.snapshot()
      });
    } catch (error) {
      throw new AgentDispositionCommitInterruptedError(runtime.runId, error);
    }
  }

  private async dispositionExecutionContinuation(
    runId: string,
    state: import('./operation/contracts.js').AgentOperationState,
    phase: AgentDispositionOperationPhase
  ): Promise<DispositionExecutionContinuation> {
    if (!state.budget) throw new Error(`Run ${runId} has no durable budget at its disposition boundary.`);
    if (state.budget.candidateRevisions !== phase.revisionCount) throw new Error(`Run ${runId} disposition revision count contradicts its durable budget.`);
    const evidence = await this.readDispositionEvidence(
      runId,
      phase.identity,
      phase.providerSettlementEventId,
      this.checks.map((check) => check.id),
      Object.freeze({ candidateEventId: phase.candidateEventId, verificationEventIds: phase.verificationEventIds })
    );
    const input = dispositionInput(state, evidence, phase.budgetSnapshot, phase.controlSnapshot);
    const restoredInputDigest = hashJson(normalizeJsonSafe(input).value);
    if (restoredInputDigest !== phase.inputDigest) throw new Error(`Run ${runId} disposition input no longer matches its captured digest.`);
    return Object.freeze({ phase, input, candidate: evidence.candidate, checkResults: evidence.checkResults, response: evidence.response });
  }

  private async readDispositionEvidence(
    runId: string,
    identity: AgentTurnIdentity,
    providerSettlementEventId: string,
    checkIds: readonly string[],
    expected?: Readonly<{ readonly candidateEventId: string; readonly verificationEventIds: readonly string[] }>
  ): Promise<Readonly<{
    candidate: AgentPresentCandidate;
    checkResults: readonly AgentCheckResult[];
    response: ModelResponse;
    candidateEventId: string;
    verificationEventIds: readonly string[];
    providerSettlementEventId: string;
  }>> {
    let provider: Extract<AgentEvent, { readonly type: 'provider.attempt.settled' }> | undefined;
    const candidates: { readonly eventId: string; readonly event: Extract<AgentEvent, { readonly type: 'assistant.ended' }> }[] = [];
    const checks: { readonly eventId: string; readonly event: Extract<AgentEvent, { readonly type: 'check.ended' }> }[] = [];
    for await (const record of this.options.repositories.events.read(runId)) {
      const event = record.event;
      if (record.eventId === providerSettlementEventId) {
        if (event.type !== 'provider.attempt.settled' || !sameTurnIdentity(event, identity)) throw new Error(`Run ${runId} disposition provider receipt is contradictory.`);
        provider = event;
      }
      if (event.type === 'assistant.ended' && sameTurnIdentity(event, identity)) candidates.push(Object.freeze({ eventId: record.eventId, event }));
      if (event.type === 'check.ended' && sameTurnIdentity(event, identity)) checks.push(Object.freeze({ eventId: record.eventId, event }));
    }
    if (!provider) throw new Error(`Run ${runId} is missing disposition provider settlement ${providerSettlementEventId}.`);
    if (candidates.length !== 1) throw new Error(`Run ${runId} requires one exact candidate settlement for disposition, found ${String(candidates.length)}.`);
    const candidateRecord = candidates[0];
    if (!candidateRecord || candidateRecord.event.candidate.status === 'absent') throw new Error(`Run ${runId} disposition requires a present candidate.`);
    if (expected && candidateRecord.eventId !== expected.candidateEventId) throw new Error(`Run ${runId} disposition candidate receipt changed.`);
    if (checks.length !== checkIds.length) throw new Error(`Run ${runId} disposition verification receipt count is contradictory.`);
    const byCheck = new Map(checks.map((record) => [record.event.check, record]));
    if (byCheck.size !== checks.length) throw new Error(`Run ${runId} contains duplicate disposition verification receipts.`);
    const ordered = checkIds.map((checkId) => {
      const record = byCheck.get(checkId);
      if (!record) throw new Error(`Run ${runId} is missing disposition verification receipt ${checkId}.`);
      return record;
    });
    const verificationEventIds = Object.freeze(ordered.map((record) => record.eventId));
    if (expected && !sameStrings(expected.verificationEventIds, verificationEventIds)) throw new Error(`Run ${runId} disposition verification receipts changed.`);
    return Object.freeze({
      candidate: candidateRecord.event.candidate,
      checkResults: Object.freeze(ordered.map((record) => record.event.result)),
      response: provider.response,
      candidateEventId: candidateRecord.eventId,
      verificationEventIds,
      providerSettlementEventId
    });
  }

  private async findDispositionDecision(
    runId: string,
    continuation: DispositionExecutionContinuation
  ): Promise<{ readonly eventId: string; readonly event: Extract<AgentEvent, { readonly type: 'candidate.disposition.decided' }> } | undefined> {
    const matches: { readonly eventId: string; readonly event: Extract<AgentEvent, { readonly type: 'candidate.disposition.decided' }> }[] = [];
    for await (const record of this.options.repositories.events.read(runId)) {
      const event = record.event;
      if (event.type === 'candidate.disposition.decided'
        && sameTurnIdentity(event, continuation.phase.identity)
        && event.revisionCount === continuation.phase.revisionCount) matches.push(Object.freeze({ eventId: record.eventId, event }));
    }
    if (matches.length > 1) throw new Error(`Run ${runId} contains multiple disposition decisions for one candidate revision.`);
    const match = matches[0];
    if (!match) return undefined;
    const configuration = this.currentOperationConfiguration().disposition;
    if (match.event.implementationId !== configuration.implementationId
      || match.event.policyHash !== configuration.policyHash
      || match.event.inputDigest !== continuation.phase.inputDigest
      || match.event.outputDigest !== hashJson(normalizeJsonSafe(match.event.decision).value)) {
      throw new Error(`Run ${runId} contains a disposition decision with contradictory evaluator binding or digests.`);
    }
    if (continuation.phase.stage === 'decided'
      && (continuation.phase.decisionEventId !== match.eventId
        || continuation.phase.outputDigest !== match.event.outputDigest
        || hashJson(normalizeJsonSafe(continuation.phase.decision).value) !== match.event.outputDigest)) {
      throw new Error(`Run ${runId} durable disposition state contradicts its decision event.`);
    }
    return match;
  }

  private async resumeDurableToolBatch(runtime: RunExecutionRuntime, contextManager: ContextManager, observationStore: ObservationStore): Promise<ExecutionDecision | undefined> {
    const initial = runtime.operation.state().phase;
    if (initial.kind !== 'tools') throw new Error('Run does not have a durable tool batch to resume.');
    runtime.controller.transition('requesting_model');
    runtime.controller.transition('executing_tools');
    const resumedBudget = runtime.controller.snapshot();
    await runtime.append({ type: 'run.phase.changed', runId: runtime.runId, phase: 'executing_tools', budget: resumedBudget });
    await runtime.emit({ type: 'run.phase.changed', phase: 'executing_tools', budget: resumedBudget });
    const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
    let resumedTools;
    try {
      resumedTools = await executeAssistantToolCalls({
        runId: runtime.runId, driverGeneration: runtime.operation.state().driverGeneration,
        tools: this.tools, toolContext: this.toolContext(toolDeadline.signal), resourceLeases: this.resourceLeases,
        ...(this.options.toolAuthorizer ? { authorizer: this.options.toolAuthorizer } : {}), contextManager, observationStore,
        ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}), controller: runtime.controller,
        phase: () => runtime.operation.state().phase,
        transition: (procedure, update) => this.advanceOperation(runtime.operation, procedure, (state) => ({ phase: update(state.phase), budget: runtime.controller.snapshot() })),
        settle: (settlement) => this.settleToolEffect(runtime.operation, settlement),
        append: runtime.append, emit: runtime.emit
      });
    } finally { toolDeadline.dispose(); }
    if (resumedTools.outcome === 'ownership_lost') throw new AgentOperationOwnershipLostError(runtime.runId);
    if (resumedTools.outcome === 'waiting_for_approval') return { executionStatus: 'waiting_for_approval', approvals: resumedTools.approvals };
    if (resumedTools.outcome === 'waiting_for_recovery') return toolRecoveryDecision(runtime.operation.state());
    await this.advanceOperation(runtime.operation, 'advance_after_tools', { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: initial.identity.turnIndex + 1 }, budget: runtime.controller.snapshot() });
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
    const failureCandidate = attached?.verificationCompleted ? recoveredCandidate : partialOrAbsent(recoveredCandidate);
    if (cause instanceof AgentLimitExceededError) {
      return { executionStatus: 'failed', terminationReason: 'limit_exhausted', candidate: failureCandidate, errorMessage: message, turnCount, checkResults, exhaustedLimit: cause.limit, ...(attached?.verificationCompleted ? { verificationCompleted: true } : {}) };
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
    return { executionStatus: 'failed', terminationReason, candidate: failureCandidate, errorMessage: message, turnCount, checkResults, ...(attached?.verificationCompleted ? { verificationCompleted: true } : {}), ...(terminalDiagnostic ? { diagnostic: terminalDiagnostic } : {}) };
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
      configuredContextSourceIds: contextSourceIds(this.options.contextItems, 'configured'), checks: this.checks.map(checkBinding), limits: input.controller.limits, budget: input.controller.snapshot()
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
      await this.options.repositories.session.repository.appendAssistant(this.options.repositories.session.descriptor, {
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
    advance: AgentOperationAdvance | ((state: import('./operation/contracts.js').AgentOperationState) => AgentOperationAdvance)
  ): Promise<void> {
    const result = await operation.drive(({ instruction, state }) => {
      if (instruction.procedure !== procedure) {
        throw new Error(`Durable operation expected ${instruction.procedure}, not ${procedure}, while in ${JSON.stringify(operation.state().phase)}.`);
      }
      return typeof advance === 'function' ? advance(state) : advance;
    });
    if (result.kind !== 'advanced') {
      throw new Error(`Durable operation cannot execute ${procedure} while it is ${result.kind}.`);
    }
  }
  private async settleToolEffect(
    operation: AgentOperationDriver,
    input: Parameters<AgentOperationCoordinator['settleToolEffect']>[1]
  ): Promise<'owned' | 'ownership_lost'> {
    const synchronized = await operation.settleToolEffect(input);
    const control = synchronized.state.control;
    return (control.status === 'owned' || control.status === 'abort_requested') && control.driverId === operation.driverId
      ? 'owned'
      : 'ownership_lost';
  }
  private approvalSuspension(state: import('./operation/contracts.js').AgentOperationState): AgentRunResult {
    if (state.phase.kind !== 'approval') throw new Error(`Run ${state.runId} is not waiting for approval.`);
    if (!state.budget) throw new Error(`Run ${state.runId} has no durable budget at its approval boundary.`);
    return Object.freeze({
      state: 'suspended',
      reason: 'approval_required',
      runId: state.runId,
      finalizationId: state.finalizationId,
      pendingApprovals: Object.freeze([state.phase.approval]),
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
  private async verificationExecutionContinuation(
    runId: string,
    phase: Extract<AgentOperationPhase, { readonly kind: 'verification' }>
  ): Promise<Readonly<{
    readonly response: ModelResponse;
    readonly candidate: AgentPresentCandidate;
    readonly instructions: readonly AgentEffectiveInstruction[];
  }>> {
    let response: ModelResponse | undefined;
    let instructions: readonly AgentEffectiveInstruction[] | undefined;
    for await (const record of this.options.repositories.events.read(runId)) {
      if (record.eventId === phase.providerSettlementEventId) {
        if (record.event.type !== 'provider.attempt.settled' || !sameTurnIdentity(record.event, phase.identity)) {
          throw new Error(`Run ${runId} verification source ${phase.providerSettlementEventId} is not its exact provider settlement.`);
        }
        response = record.event.response;
      }
      if (record.event.type === 'turn.snapshot.created' && sameTurnIdentity(turnIdentity(record.event.snapshot), phase.identity)) {
        if (instructions) throw new Error(`Run ${runId} contains duplicate immutable snapshots for verification turn ${phase.identity.turnId}.`);
        instructions = record.event.snapshot.instructions;
      }
    }
    if (!response) throw new Error(`Run ${runId} is missing provider settlement ${phase.providerSettlementEventId} required by verification.`);
    if (!instructions) throw new Error(`Run ${runId} is missing the immutable turn snapshot required by verification.`);
    if ((response.toolCalls?.length ?? 0) !== 0) throw new Error(`Run ${runId} cannot verify a provider response that requested tools.`);
    const candidate = candidateFromResponse(response, phase.identity.turnIndex, false);
    if (candidate.status === 'absent') throw new Error(`Run ${runId} cannot verify an absent candidate.`);
    return Object.freeze({ response, candidate, instructions: Object.freeze([...instructions]) });
  }
  private async reconcileDurableToolBatch(operation: AgentOperationDriver, signal: AbortSignal): Promise<boolean> {
    const attempted = new Set<number>();
    for (;;) {
      const phase = operation.state().phase;
      if (phase.kind !== 'tools') throw new Error(`Run ${operation.state().runId} lost its durable tool batch during recovery.`);
      const callIndex = phase.callStates.findIndex((state, index) => !attempted.has(index) && (
        ((state.stage === 'effect_ready' || state.stage === 'effect_pending') && state.effect.ticket.driverGeneration !== operation.state().driverGeneration)
        || (state.stage === 'outcome_unknown' && state.effect.phase === 'started' && state.effect.intent.recovery.kind !== 'unknown')
      ));
      if (callIndex < 0) return !phase.callStates.some((state) => state.stage === 'outcome_unknown');
      const callState = phase.callStates[callIndex];
      if (callState?.stage === 'effect_ready') {
        closeExternalEffect(callState.effect, 'cancelled_before_start');
        const generation = operation.state().driverGeneration;
        const reissued = issueEffectStartTicket({
          intent: callState.effect.intent,
          ticketId: `${callState.effect.intent.effectId}:start:${String(generation)}`,
          settlementPermitId: `${callState.effect.intent.effectId}:settle:${String(generation)}`,
          driverGeneration: generation,
          currentDriverGeneration: generation
        });
        if (reissued.status !== 'issued') throw new Error(`Run ${operation.state().runId} could not reissue tool effect ${callState.effect.intent.effectId}.`);
        try {
          await this.advanceOperation(operation, 'reconcile_tool_call', (state) => ({
            phase: replaceToolCallState(requireToolBatch(state.phase), callIndex, {
              stage: 'effect_ready', preparation: callState.preparation, toolAttempt: callState.toolAttempt, effect: reissued.state
            }),
            ...(state.budget ? { budget: state.budget } : {})
          }));
        } catch (error) {
          if (!(error instanceof AgentOperationConflictError) || error.reason !== 'stale_tail') throw error;
        }
        continue;
      }
      if (callState?.stage !== 'effect_pending' && callState?.stage !== 'outcome_unknown') throw new Error(`Run ${operation.state().runId} has contradictory tool recovery state.`);
      const startedEffect = callState.effect;
      if (startedEffect.phase !== 'started') throw new Error(`Run ${operation.state().runId} selected a closed tool outcome for recovery.`);
      const startedCallState = Object.freeze({
        stage: callState.stage,
        preparation: callState.preparation,
        toolAttempt: callState.toolAttempt,
        effect: startedEffect
      });
      try {
        if (await this.reconcileStartedToolEffect(operation, phase, callIndex, startedCallState, signal)) continue;
      } catch (error) {
        if (!(error instanceof AgentOperationConflictError) || error.reason !== 'stale_tail') throw error;
        continue;
      }
      attempted.add(callIndex);
      if (callState.stage === 'effect_pending') {
        try {
          await this.advanceOperation(operation, 'reconcile_tool_call', (state) => ({
            phase: replaceToolCallState(requireToolBatch(state.phase), callIndex, {
              stage: 'outcome_unknown', preparation: callState.preparation, toolAttempt: callState.toolAttempt, effect: callState.effect
            }),
            ...(state.budget ? { budget: state.budget } : {})
          }));
        } catch (error) {
          if (!(error instanceof AgentOperationConflictError) || error.reason !== 'stale_tail') throw error;
          const current = requireToolBatch(operation.state().phase).callStates[callIndex];
          if (current?.stage === 'effect_pending') attempted.delete(callIndex);
        }
      }
    }
  }

  private async reconcileStartedToolEffect(
    operation: AgentOperationDriver,
    phase: AgentToolOperationPhase,
    callIndex: number,
    callState: Readonly<{
      readonly stage: 'effect_pending' | 'outcome_unknown';
      readonly preparation: AgentToolPreparationRecord;
      readonly toolAttempt: number;
      readonly effect: Extract<import('@agent-core/effects').EffectExecutionState, { readonly phase: 'started' }>;
    }>,
    signal: AbortSignal
  ): Promise<boolean> {
    if (callState.effect.intent.recovery.kind === 'unknown') return false;
    const call = phase.calls[callIndex];
    if (!call) throw new Error(`Run ${operation.state().runId} has no tool call for effect ${callState.effect.intent.effectId}.`);
    const context = Object.freeze({
      ...this.toolContext(signal),
      invocation: Object.freeze({
        runId: operation.state().runId,
        ...phase.identity,
        toolBatchId: phase.toolBatchId,
        callIndex,
        ...(call.id ? { callId: call.id } : {}),
        toolAttempt: callState.toolAttempt
      })
    });
    const preparedResult = await prepareToolCall(call, this.tools, context);
    if (!preparedResult.ok) return false;
    const prepared = preparedResult.prepared;
    try {
      if (prepared.toolImplementationId !== callState.preparation.toolImplementationId || prepared.fingerprint !== callState.preparation.fingerprint) return false;
      const recovery = await recoverPreparedToolCall(prepared, callState.effect, {
        ...context,
        invocation: context.invocation
      });
      if (recovery.status === 'settled') {
        if (callState.effect.intent.recovery.kind === 'preconditioned_reexecution') {
          throw new Error('A preconditioned re-execution capability cannot claim a previous external settlement.');
        }
        const observationStore = new ObservationStore({ estimator: this.estimator, ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}) });
        const tool = this.tools.find((candidate) => candidate.name === call.name && candidate.implementationId === prepared.toolImplementationId);
        const committed = await observationStore.commitToolObservation({
          turnIndex: phase.identity.turnIndex,
          call,
          canonicalSnapshot: prepared.canonicalSnapshot,
          tool,
          observation: recovery.observation
        });
        const settlement = { observationId: committed.id, observation: committed.durableObservation, createdAt: committed.createdAt };
        try {
          await operation.settleToolEffect({ effectId: callState.effect.intent.effectId, permit: callState.effect.settlementPermit, settlement });
        } catch (error) {
          if (!(error instanceof AgentOperationConflictError)
            || (error.reason !== 'stale_tail' && error.reason !== 'idempotency_conflict')) throw error;
          const synchronized = await operation.synchronize();
          const current = synchronized.state.phase.kind === 'tools' ? synchronized.state.phase.callStates[callIndex] : undefined;
          if ((current?.stage !== 'settled' && current?.stage !== 'projecting' && current?.stage !== 'projected')
            || current.effect?.intent.effectId !== callState.effect.intent.effectId) throw error;
        }
        return true;
      }
      if (recovery.status !== 'reexecute') return false;
      const capability = callState.effect.intent.recovery;
      if (capability.kind !== 'preconditioned_reexecution' || !sameResourcePreconditions(recovery.preconditions, capability.preconditions)) return false;
      closeExternalEffect(callState.effect, 'unknown_outcome');
      const toolAttempt = callState.toolAttempt + 1;
      const effectId = `${operation.state().runId}:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:${String(toolAttempt)}`;
      const generation = operation.state().driverGeneration;
      const issued = issueEffectStartTicket({
        intent: { ...callState.effect.intent, effectId },
        ticketId: `${effectId}:start:${String(generation)}`,
        settlementPermitId: `${effectId}:settle:${String(generation)}`,
        driverGeneration: generation,
        currentDriverGeneration: generation
      });
      if (issued.status !== 'issued') throw new Error(`Run ${operation.state().runId} could not issue a recovered tool effect.`);
      await this.advanceOperation(operation, 'reconcile_tool_call', (state) => ({
        phase: replaceToolCallState(requireToolBatch(state.phase), callIndex, {
          stage: 'effect_ready', preparation: callState.preparation, toolAttempt, effect: issued.state
        }),
        ...(state.budget ? { budget: state.budget } : {})
      }));
      return true;
    } finally {
      await releasePreparedToolCall(prepared);
    }
  }
  private async providerExecutionContinuation(state: import('./operation/contracts.js').AgentOperationState): Promise<ProviderExecutionContinuation> {
    const phase = state.phase;
    if (phase.kind !== 'provider' || phase.stage !== 'settled') throw new Error(`Run ${state.runId} has no settled provider response to resume.`);
    if (!state.budget) throw new Error(`Run ${state.runId} has no durable budget at its provider settlement.`);
    const settlement = await this.findProviderSettlement(state.runId, phase.effect.intent.effectId, phase.responseId);
    if (settlement?.eventId !== phase.settlementEventId) throw new Error(`Run ${state.runId} is missing its exact provider settlement ${phase.settlementEventId}.`);
    let turnSnapshot: AgentTurnSnapshotRecord | undefined;
    let requestEstimate: RequestCostEstimate | undefined;
    for await (const record of this.options.repositories.events.read(state.runId)) {
      const event = record.event;
      if (event.type === 'turn.snapshot.created' && sameTurnIdentity(turnIdentity(event.snapshot), phase.identity)) turnSnapshot = event.snapshot;
      else if (event.type === 'budget.estimate.created' && sameTurnIdentity(event, phase.identity)) requestEstimate = event.estimate;
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
      budget: state.budget
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
      if (state.phase.kind === 'tools') {
        await this.advanceOperation(operation, instruction, {
          phase: { kind: 'cancelling', stage: 'requested', toolBatch: closeOpenToolCalls(state.phase) },
          budget
        });
        continue;
      }
      switch (instruction) {
        case 'prepare':
        case 'assemble_turn':
        case 'prepare_provider_request':
        case 'consume_provider_settlement':
        case 'prepare_tool_call':
        case 'reconcile_tool_call':
        case 'prepare_tool_projection':
        case 'project_tool_settlement':
        case 'advance_after_tools':
        case 'consume_verification_settlement':
        case 'prepare_disposition':
        case 'consume_disposition':
        case 'finalize_abort':
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
          continue;
        case 'start_provider_request': {
          if (state.phase.kind !== 'provider' || state.phase.stage !== 'effect_ready') throw new Error(`Run ${state.runId} has contradictory provider start state.`);
          closeExternalEffect(state.phase.effect, 'cancelled_before_start');
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
          continue;
        }
        case 'start_tool_call': throw new Error(`Run ${state.runId} has a tool start instruction outside a tool batch.`);
        case 'reconcile_provider_request': throw new Error(`Run ${state.runId} has an unresolved started provider effect and cannot finalize it as a local failure.`);
        case 'prepare_verification':
          if (state.phase.kind !== 'verification') throw new Error(`Run ${state.runId} has contradictory verification preparation state.`);
          await this.advanceOperation(operation, instruction, {
            phase: { ...verificationPhaseBase(state.phase), stage: 'complete', nextCheckIndex: state.phase.checkIds.length }, budget
          });
          continue;
        case 'start_verification': {
          if (state.phase.kind !== 'verification' || state.phase.stage !== 'effect_ready') throw new Error(`Run ${state.runId} has contradictory verification start state.`);
          closeExternalEffect(state.phase.effect, 'cancelled_before_start');
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
          continue;
        }
        case 'reconcile_verification':
          if (state.phase.kind === 'verification' && state.phase.stage === 'effect_pending') throw new Error(`Run ${state.runId} has an unresolved verifier effect and cannot finalize it as a local failure.`);
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
          continue;
        case 'start_disposition': {
          if (state.phase.kind !== 'disposition' || state.phase.stage !== 'effect_ready') throw new Error(`Run ${state.runId} has contradictory disposition start state.`);
          closeExternalEffect(state.phase.effect, 'cancelled_before_start');
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
          continue;
        }
        case 'reconcile_disposition':
          if (state.phase.kind === 'disposition' && state.phase.stage === 'effect_pending') throw new Error(`Run ${state.runId} has an unresolved disposition effect and cannot finalize it as a local failure.`);
          await this.advanceOperation(operation, instruction, { phase: { kind: 'finalization', stage: 'ready' }, budget });
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
  private hasToolImplementationMismatch(operation: AgentOperationDriver): boolean {
    const phase = operation.state().phase;
    if (phase.kind !== 'tools' && phase.kind !== 'approval') return false;
    const captured = operation.state().configuration;
    const current = this.currentOperationConfiguration();
    const nonToolConfigurationMatches = captured.providerId === current.providerId
      && captured.providerImplementationId === current.providerImplementationId
      && captured.model === current.model
      && captured.runtimeImplementationId === current.runtimeImplementationId
      && captured.policyHash === current.policyHash
      && sameDispositionBinding(captured.disposition, current.disposition)
      && sameCheckBindings(captured.checks, current.checks);
    return nonToolConfigurationMatches && !sameStrings(captured.toolImplementationIds, current.toolImplementationIds);
  }
  private hasDispositionImplementationMismatch(operation: AgentOperationDriver): boolean {
    const captured = operation.state().configuration;
    const current = this.currentOperationConfiguration();
    const nonDispositionConfigurationMatches = captured.providerId === current.providerId
      && captured.providerImplementationId === current.providerImplementationId
      && captured.model === current.model
      && captured.runtimeImplementationId === current.runtimeImplementationId
      && captured.policyHash === current.policyHash
      && sameStrings(captured.toolImplementationIds, current.toolImplementationIds)
      && sameCheckBindings(captured.checks, current.checks);
    return nonDispositionConfigurationMatches && !sameDispositionBinding(captured.disposition, current.disposition);
  }
  private currentOperationConfiguration() {
    const disposition = Object.freeze({
      implementationId: this.disposition.implementationId,
      policyIdentity: this.disposition.policyIdentity,
      policyHash: hashJson(this.disposition.policyIdentity)
    });
    return Object.freeze({
      providerId: this.options.provider.id,
      providerImplementationId: this.options.provider.implementationId,
      model: this.options.model,
      runtimeImplementationId: 'agent-core.runtime.operation-v1',
      toolImplementationIds: Object.freeze(this.tools.map((tool) => tool.implementationId)),
      checks: Object.freeze(this.checks.map(checkBinding)),
      disposition,
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
    ...(previous.executionStatus === 'completed' || (previous.executionStatus === 'failed' && previous.verificationCompleted) ? { verificationCompleted: true } : {}),
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
  return createAgentTerminalSnapshot({
    ...common,
    executionStatus: 'failed',
    terminationReason: decision.terminationReason,
    verificationStatus: decision.verificationCompleted ? deriveAgentVerificationStatus(checks, decision.checkResults) : 'not_run',
    errorMessage: decision.errorMessage
  });
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
function dispositionInstructions(input: readonly string[]): AgentEffectiveInstruction[] { return input.map((content, index) => dispositionInstruction(content, index + 1)); }
function dispositionInstruction(content: string, revisionCount: number): AgentEffectiveInstruction { return Object.freeze({ id: `disposition-${String(revisionCount)}`, content, provenance: 'disposition' }); }
function contextSourceIds(items: readonly ContextItemInput[] | undefined, provenance: 'configured' | 'provider' | 'run'): string[] {
  return (items ?? []).map((item, index) => isRecord(item) && typeof item.id === 'string' && item.id.length > 0
    ? item.id
    : `${provenance}-context-${String(index + 1)}-${hashJson(normalizeJsonSafe(item).value).slice(0, 12)}`);
}
function turnIdentity(snapshot: AgentTurnSnapshotRecord): AgentTurnIdentity { return { turnIndex: snapshot.turnIndex, turnId: snapshot.turnId, requestAttempt: snapshot.requestAttempt }; }
function sameTurnIdentity(left: AgentTurnIdentity, right: AgentTurnIdentity): boolean { return left.turnIndex === right.turnIndex && left.turnId === right.turnId && left.requestAttempt === right.requestAttempt; }
function verificationPhaseBase(phase: Extract<AgentOperationPhase, { readonly kind: 'verification' }>) {
  return Object.freeze({
    kind: 'verification' as const,
    identity: phase.identity,
    providerSettlementEventId: phase.providerSettlementEventId,
    checkIds: phase.checkIds,
    nextCheckIndex: phase.nextCheckIndex
  });
}
function verificationContext(input: {
  readonly runId: string;
  readonly task: string;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly candidate: AgentPresentCandidate;
  readonly identity: AgentTurnIdentity;
  readonly metadata: Readonly<Record<string, import('@agent-core/json').JsonValue>>;
  readonly signal: AbortSignal;
  readonly execution: AgentVerificationExecutionContext;
}): AgentCheckContext {
  return Object.freeze({
    runId: input.runId,
    task: input.task,
    instructions: Object.freeze([...input.instructions]),
    candidate: input.candidate,
    ...input.identity,
    metadata: input.metadata,
    signal: input.signal,
    execution: input.execution
  });
}
function checkPreparation(check: AgentCheckDefinition, prepared: AgentPreparedCheckEffect): AgentCheckPreparationRecord {
  const preparation = Object.freeze({
    checkImplementationId: check.implementationId,
    authorization: prepared.authorization,
    recovery: prepared.recovery
  });
  return Object.freeze({ ...preparation, fingerprint: hashJson(normalizeJsonSafe(preparation).value) });
}
async function requireMatchingCheckPreparation(
  check: Extract<AgentCheckDefinition, { readonly kind: 'effect' }>,
  context: AgentCheckContext,
  expected: AgentCheckPreparationRecord,
  retained: AgentPreparedCheckEffect | undefined
): Promise<AgentPreparedCheckEffect> {
  const outcome = retained ?? await check.prepare(context);
  if (!isAgentPreparedCheckEffect(outcome)) throw new Error(`Verifier ${check.id} no longer requires the external effect captured by its durable intent.`);
  const prepared = outcome;
  const actual = checkPreparation(check, prepared);
  if (actual.fingerprint !== expected.fingerprint
    || actual.checkImplementationId !== expected.checkImplementationId
    || hashJson(actual.authorization) !== hashJson(expected.authorization)
    || hashJson(normalizeJsonSafe(actual.recovery).value) !== hashJson(normalizeJsonSafe(expected.recovery).value)) {
    await prepared.release();
    throw new Error(`Verifier ${check.id} preparation changed after its durable intent was recorded.`);
  }
  return prepared;
}
function dispositionInput(
  state: import('./operation/contracts.js').AgentOperationState,
  evidence: Readonly<{
    readonly candidate: AgentPresentCandidate;
    readonly checkResults: readonly AgentCheckResult[];
    readonly candidateEventId: string;
    readonly verificationEventIds: readonly string[];
    readonly providerSettlementEventId: string;
  }>,
  budget: import('./run/contracts.js').AgentRunBudgetState,
  control: Readonly<{ readonly status: 'owned'; readonly driverGeneration: number }>
): AgentDispositionInput {
  return Object.freeze({
    candidate: evidence.candidate,
    checkResults: Object.freeze([...evidence.checkResults]),
    budget,
    control,
    policyIdentity: state.configuration.disposition.policyIdentity,
    receipts: Object.freeze({
      providerSettlementEventId: evidence.providerSettlementEventId,
      candidateEventId: evidence.candidateEventId,
      verificationEventIds: Object.freeze([...evidence.verificationEventIds])
    })
  });
}
function dispositionPhaseBase(phase: AgentDispositionOperationPhase) {
  return Object.freeze({
    kind: 'disposition' as const,
    identity: phase.identity,
    providerSettlementEventId: phase.providerSettlementEventId,
    candidateEventId: phase.candidateEventId,
    verificationEventIds: phase.verificationEventIds,
    inputDigest: phase.inputDigest,
    revisionCount: phase.revisionCount,
    controlSnapshot: phase.controlSnapshot,
    budgetSnapshot: phase.budgetSnapshot
  });
}
function dispositionPreparation(
  policy: Extract<AgentDispositionPolicy, { readonly kind: 'effect' }>,
  input: AgentDispositionInput,
  prepared: AgentPreparedDispositionEffect
): AgentDispositionPreparationRecord {
  const record = Object.freeze({
    implementationId: policy.implementationId,
    inputDigest: hashJson(normalizeJsonSafe(input).value),
    authorization: prepared.authorization,
    recovery: prepared.recovery
  });
  return Object.freeze({
    implementationId: record.implementationId,
    authorization: record.authorization,
    recovery: record.recovery,
    fingerprint: hashJson(normalizeJsonSafe(record).value)
  });
}
function requireMatchingDispositionPreparation(
  policy: Extract<AgentDispositionPolicy, { readonly kind: 'effect' }>,
  input: AgentDispositionInput,
  expected: AgentDispositionPreparationRecord,
  retained: AgentPreparedDispositionEffect
): void {
  const actual = dispositionPreparation(policy, input, retained);
  if (actual.implementationId !== expected.implementationId
    || actual.fingerprint !== expected.fingerprint
    || hashJson(actual.authorization) !== hashJson(expected.authorization)
    || hashJson(normalizeJsonSafe(actual.recovery).value) !== hashJson(normalizeJsonSafe(expected.recovery).value)) {
    throw new Error(`Disposition ${policy.implementationId} preparation changed after its durable intent was recorded.`);
  }
}
function dispositionEffectId(runId: string, identity: AgentTurnIdentity, revisionCount: number): string {
  return `disposition:${hashJson(normalizeJsonSafe({ runId, identity, revisionCount }).value)}`;
}
function settleDispositionEffect(
  effect: Extract<AgentDispositionOperationPhase, { readonly stage: 'effect_pending' }>['effect'],
  outputDigest: string,
  runId: string
): Extract<ReturnType<typeof settleExternalEffect>, { readonly status: 'settled' | 'already_settled' }>['state'] {
  const settlement = settleExternalEffect(effect, effect.settlementPermit, {
    outcome: 'succeeded',
    resultDigest: outputDigest,
    exposure: knownEffectExposure([])
  });
  if (settlement.status !== 'settled' && settlement.status !== 'already_settled') throw new Error(`Run ${runId} disposition effect settlement was rejected: ${settlement.status}.`);
  return settlement.state;
}
function dispositionRecoveryDecision(phase: AgentOperationPhase): Extract<ExecutionDecision, { readonly executionStatus: 'waiting_for_recovery' }> {
  if (phase.kind !== 'disposition' || (phase.stage !== 'effect_pending' && phase.stage !== 'outcome_unknown')) {
    throw new Error('Disposition recovery requires a pending or unknown external effect.');
  }
  return Object.freeze({ executionStatus: 'waiting_for_recovery', reason: 'disposition_outcome_unknown', effectId: phase.effect.intent.effectId });
}
function dispositionFailedDecision(
  decision: Extract<AgentDispositionDecision, { readonly kind: 'fail' | 'inconclusive' }>,
  candidate: AgentPresentCandidate,
  turnCount: number,
  checkResults: readonly AgentCheckResult[],
  response: ModelResponse
): TerminalDecision {
  return Object.freeze({
    executionStatus: 'failed',
    terminationReason: decision.kind === 'fail' ? 'candidate_rejected' : 'disposition_inconclusive',
    candidate,
    errorMessage: decision.reason,
    turnCount,
    checkResults,
    verificationCompleted: true,
    modelTerminationReason: response.terminationReason,
    ...(response.providerTerminationReason ? { providerTerminationReason: response.providerTerminationReason } : {})
  });
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> { return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'; }
function formatOverflowDiagnostic(diagnostic: OverflowDiagnostic): string { return ['Request assembly exceeded budget after overflow recovery.', `Reason: ${diagnostic.reason}.`, `Components: messages=${String(diagnostic.messageTokens)}, contextHistory=${String(diagnostic.contextHistoryTokens)}, context=${String(diagnostic.contextTokens)}, evidence=${String(diagnostic.evidenceTokens)}, toolSchemas=${String(diagnostic.toolSchemaTokens)}, outputReserve=${String(diagnostic.outputReserveTokens)}.`, `Total request tokens=${String(diagnostic.totalRequestTokens)}.`, `Recovery actions attempted=${diagnostic.reductionsAttempted.map(formatOverflowAction).join(', ') || 'none'}.`].join(' '); }
function formatOverflowAction(action: OverflowRecoveryAction): string { if (action.kind === 'reduce_context_history') return `reduce_context_history(${String(action.reductions)})`; if (action.kind === 'reduce_context') return `reduce_context(${String(action.removedItems)})`; if (action.kind === 'install_checkpoint') return `install_checkpoint(${String(action.compactedToolResults)})`; return action.kind; }
class RequestAssemblyError extends Error {}
function modelStreamInterrupted(input: { turnIndex: number; cause: unknown; content: string; reasoningSummary: string; finalResponseReceived: boolean }): ModelStreamInterruptedError { return new ModelStreamInterruptedError({ turnIndex: input.turnIndex, cause: input.cause, content: input.content, finalResponseReceived: input.finalResponseReceived, ...(input.reasoningSummary.length > 0 ? { reasoningSummary: input.reasoningSummary } : {}) }); }
function operationInput(state: import('./operation/contracts.js').AgentOperationState, signal?: AbortSignal): ResolvedAgentRunInput {
  return {
    task: state.input.task,
    runId: state.runId,
    finalizationId: state.finalizationId,
    instructions: state.input.instructions,
    contextItems: state.input.contextItems,
    ...(signal ? { signal } : {})
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
  if (phase.kind === 'tools') {
    const unknown = phase.callStates.find((call) => call.stage === 'outcome_unknown');
    if (unknown?.stage === 'outcome_unknown') return Object.freeze({ state: 'suspended', reason: 'tool_outcome_unknown', runId: state.runId, finalizationId: state.finalizationId, effectId: unknown.effect.intent.effectId, budget: state.budget });
  }
  if (phase.kind === 'disposition' && phase.stage === 'outcome_unknown') return Object.freeze({ state: 'suspended', reason: 'disposition_outcome_unknown', runId: state.runId, finalizationId: state.finalizationId, effectId: phase.effect.intent.effectId, budget: state.budget });
  if (phase.kind !== 'suspended') throw new Error(`Run ${state.runId} is not suspended.`);
  return Object.freeze({
    state: 'suspended',
    reason: phase.reason,
    runId: state.runId,
    finalizationId: state.finalizationId,
    ...(phase.effectId ? { effectId: phase.effectId } : {}),
    ...(phase.reason === 'user_decision' ? { decisionRequest: phase.decisionRequest } : {}),
    budget: state.budget
  });
}
function cancelledProviderStartDecisionRequest(
  state: import('./operation/contracts.js').AgentOperationState,
  effectId: string
): import('./operation/contracts.js').AgentDecisionRequest {
  const operationRevision = state.revision + 1;
  const id = `${state.runId}:decision:${effectId}`;
  const reason = 'The provider effect was durably prepared but cannot be started after restoration. Aborting is the only safe continuation.';
  const choices = Object.freeze(['abort']);
  const fingerprint = hashJson({ id, reason, choices, operationRevision, effectId });
  return Object.freeze({ id, reason, choices, fingerprint, operationRevision });
}
function toolRecoveryDecision(state: import('./operation/contracts.js').AgentOperationState): Extract<ExecutionDecision, { readonly executionStatus: 'waiting_for_recovery' }> {
  const phase = requireToolBatch(state.phase);
  const unknown = phase.callStates.find((call) => call.stage === 'outcome_unknown');
  if (unknown?.stage !== 'outcome_unknown') throw new Error(`Run ${state.runId} has no unknown tool outcome.`);
  return Object.freeze({ executionStatus: 'waiting_for_recovery', reason: 'tool_outcome_unknown', effectId: unknown.effect.intent.effectId });
}
function requireToolBatch(phase: AgentOperationPhase): AgentToolOperationPhase {
  if (phase.kind !== 'tools') throw new Error('Operation does not retain a tool batch.');
  return phase;
}
function replaceToolCallState(phase: AgentToolOperationPhase, callIndex: number, callState: AgentToolCallOperationState): AgentToolOperationPhase {
  if (callIndex < 0 || callIndex >= phase.callStates.length) throw new Error(`Tool call state ${String(callIndex)} is missing.`);
  const callStates = [...phase.callStates];
  callStates[callIndex] = callState;
  return Object.freeze({ ...phase, callStates: Object.freeze(callStates) });
}
function closeOpenToolCalls(phase: AgentToolOperationPhase): AgentToolOperationPhase {
  return Object.freeze({
    ...phase,
    callStates: Object.freeze(phase.callStates.map((call): AgentToolCallOperationState => {
      if (call.stage === 'ready') return Object.freeze({ stage: 'cancelled', toolAttempt: 1 });
      if (call.stage === 'effect_ready') return Object.freeze({
        stage: 'cancelled', preparation: call.preparation, toolAttempt: call.toolAttempt,
        effect: closeExternalEffect(call.effect, 'cancelled_before_start')
      });
      if (call.stage === 'effect_pending') return Object.freeze({
        stage: 'outcome_unknown', preparation: call.preparation, toolAttempt: call.toolAttempt,
        effect: closeExternalEffect(call.effect, 'unknown_outcome')
      });
      if (call.stage === 'outcome_unknown' && call.effect.phase === 'started') return Object.freeze({
        stage: 'outcome_unknown', preparation: call.preparation, toolAttempt: call.toolAttempt,
        effect: closeExternalEffect(call.effect, 'unknown_outcome')
      });
      return call;
    }))
  });
}
function missingImplementationSuspension(state: import('./operation/contracts.js').AgentOperationState): AgentRunResult {
  if (!state.budget) throw new Error(`Run ${state.runId} has no durable budget at its tool implementation boundary.`);
  return Object.freeze({
    state: 'suspended',
    reason: 'missing_implementation',
    runId: state.runId,
    finalizationId: state.finalizationId,
    budget: state.budget
  });
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameDispositionBinding(
  left: Readonly<{ readonly implementationId: string; readonly policyIdentity: JsonValue; readonly policyHash: string }>,
  right: Readonly<{ readonly implementationId: string; readonly policyIdentity: JsonValue; readonly policyHash: string }>
): boolean {
  return left.implementationId === right.implementationId
    && left.policyHash === right.policyHash
    && hashJson(left.policyIdentity) === hashJson(right.policyIdentity);
}
function checkBinding(check: AgentCheckDefinition): { readonly id: string; readonly implementationId: string } {
  return Object.freeze({ id: check.id, implementationId: check.implementationId });
}
function sameCheckBindings(
  left: readonly { readonly id: string; readonly implementationId: string }[],
  right: readonly { readonly id: string; readonly implementationId: string }[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const value = left.at(index);
    const candidate = right.at(index);
    if (value === undefined) return false;
    if (candidate === undefined) return false;
    if (value.id !== candidate.id
      || value.implementationId !== candidate.implementationId) return false;
  }
  return true;
}
function sameResourcePreconditions(
  left: readonly import('@agent-core/effects').EffectResourcePrecondition[],
  right: readonly import('@agent-core/effects').EffectResourcePrecondition[]
): boolean {
  return hashJson(normalizeJsonSafe(left).value) === hashJson(normalizeJsonSafe(right).value);
}
class AgentOperationOwnershipLostError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} continued under a replacement driver after this process settled its exact external effect.`);
    this.name = 'AgentOperationOwnershipLostError';
  }
}
class AgentDispositionCommitInterruptedError extends Error {
  constructor(runId: string, override readonly cause: unknown) {
    super(`Run ${runId} was interrupted while durably committing its disposition decision: ${errorMessage(cause)}`);
    this.name = 'AgentDispositionCommitInterruptedError';
  }
}
function completedRunControl(runId: string, result: AgentRunResult): AgentRunControl {
  return Object.freeze({ runId, injectSteering() { throw new Error(`Run ${runId} is not active.`); }, abort: () => Promise.resolve(), result: Promise.resolve(result) });
}
function directProviderSession(provider: ModelProvider): ModelProviderSession {
  const stream = provider.stream?.bind(provider);
  return {
    complete: (request) => provider.complete(request),
    ...(stream ? { stream: (request: ModelRequest) => stream(request) } : {}),
  };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
