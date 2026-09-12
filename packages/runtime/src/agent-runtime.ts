import {
  closeExternalEffect,
  issueEffectStartTicket,
  knownEffectExposure,
  settleExternalEffect,
  unknownEffectExposure
} from '@agent-core/effects';
import {
  CompleteRequestEstimator,
  ModelContractError,
  parseModelProfile,
  type CompiledModelRequest,
  type ModelProfile,
  type ModelProvider,
  type ModelProviderErrorDiagnostic,
  type ModelProviderSession,
  type ModelReasoningRequest,
  type ModelRequest,
  type ModelResponse,
  type ModelResponseFormat,
  type RequestEstimator
} from '@agent-core/model';
import { hashJson, type EventAppendReceipt } from '@agent-core/persistence';
import {
  READ_ONLY_TOOL_POLICY,
  ResourceLeaseCoordinator,
  ToolRegistry,
  isToolAvailable,
  parseToolPolicy,
  planToolCall,
  recoverToolCallPlan,
  releaseToolCallPlan,
  toolRequirementsSatisfied,
  type CompiledToolDefinition,
  type ExecutionResources,
  type ToolAuthorizationBoundary,
  type ToolAuthorizer,
  type ToolCall,
  type ToolExecutionContext,
  type ToolPlanningContext,
  type ToolPolicy
} from '@agent-core/tools';
import { randomUUID } from 'node:crypto';
import type { ContextTransitionRequest } from './context/contracts.js';
import type { ContextService } from './context/service.js';
import {
  encodeAgentEvent,
  type AgentAuditEvent,
  type AgentEvent,
  type AgentProgressEvent
} from './events.js';
import { sourceRef } from './history/reader.js';
import { ModelRequestAssembler, type PromptInstruction } from './inference/model-request-assembler.js';
import { ModelWindow } from './inference/model-window.js';
import type { NativeGenerationContext } from './inference/native-inference.js';
import { NativeSteeringCoordinator } from './inference/native-steering.js';
import { decodePromptContextItemInput, type PromptContextItemInput } from './inference/prompt-material.js';
import {
  createRunInferenceLifecycle,
  invokeRunInference,
  providerUsageQuantities
} from './inference/run-lifecycle.js';
import { InferenceService } from './inference/service.js';
import type { NoteRepository } from './notes/contracts.js';
import {
  BudgetAccountant,
  type RequestCostEstimate,
  type RequestWindow
} from './orchestration/budget-accountant.js';
import {
  summarizeModelRequest,
  summarizeModelResponse,
  summarizeProviderState,
  summarizeRunConfiguration
} from './orchestration/event-summaries.js';
import { AgentRunFinalizer } from './orchestration/finalization.js';
import {
  finalMessageFromResponse,
  modelToolCallFromToolCall,
  normalizeModelToolCall,
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
import { NativeToolDelivery } from './orchestration/native-tool-delivery.js';
import { ObservationStore } from './orchestration/observation-store.js';
import { createOverflowDiagnostic, type OverflowDiagnostic } from './orchestration/overflow-recovery.js';
import { readProviderStateArtifact } from './orchestration/provider-state-artifacts.js';
import { AgentLimitExceededError, AgentRunController } from './orchestration/run-controller.js';
import {
  activeObservationRepresentations,
  rebuildModelWindowFromRepositories
} from './orchestration/session-replay.js';
import { ToolCallExecutor } from './orchestration/tool-execution.js';
import { ToolWorkPump, toolObservationsComplete, type ToolWorkStatus } from './orchestration/tool-work.js';
import type { AgentRuntimeRepositories } from './ports.js';
import { RunContextTransitions } from './run/context-transitions.js';
import {
  createAgentTerminalSnapshot,
  type AgentApprovalRequest,
  type AgentClock,
  type AgentEffectiveInstruction,
  type AgentModelOutput,
  type AgentPresentModelOutput,
  type AgentRunLimits,
  type AgentRunResult,
  type AgentTerminalSnapshot,
  type AgentTurnIdentity,
  type AgentTurnSnapshotRecord,
  type InferenceRequestFingerprintRecord,
  type LogicalModelRequestRecord
} from './run/contracts.js';
import {
  nextAgentRunInstruction,
  providerWork,
  type AgentProviderPhase,
  type AgentRunProcedure,
  type AgentRunState,
  type AgentToolPhase
} from './run/control/contracts.js';
import {
  AgentRunConflictError,
  AgentRunCoordinator,
  type AgentRunAdvance,
  type AgentRunDriver
} from './run/control/driver.js';
import type { AgentToolCallPlanRecord, AgentToolCallState } from './run/control/tool-state.js';
import { PendingCallCoordinator } from './run/pending-calls.js';
import { assertToolCatalogCurrent, captureToolCatalog } from './run/tool-catalog.js';

export type {} from './run/contracts.js';

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

export type AgentContextProvider = (
  request: AgentContextRequest
) => readonly PromptContextItemInput[] | Promise<readonly PromptContextItemInput[]>;

export interface AgentRuntimeOptions {
  readonly provider: ModelProvider;
  readonly inferenceService?: InferenceService;
  readonly model: string;
  readonly repositories: AgentRuntimeRepositories;
  readonly tools?: readonly CompiledToolDefinition[];
  readonly toolCatalogProvider?: () =>
    | readonly CompiledToolDefinition[]
    | Promise<readonly CompiledToolDefinition[]>;
  readonly toolBoundary: ToolAuthorizationBoundary;
  readonly toolContext?: Omit<ToolExecutionContext, 'policy' | 'signal'>;
  readonly toolResourceLeases?: ResourceLeaseCoordinator;
  readonly resources?: ExecutionResources;
  readonly inferenceOwnerId?: string;
  readonly toolPolicy?: ToolPolicy;
  readonly toolAuthorizer?: ToolAuthorizer;
  readonly toolContextPrerequisite?: import('./orchestration/tool-execution.js').ToolContextPrerequisite;
  readonly instructions?: readonly AgentInstruction[];
  readonly contextItems?: readonly PromptContextItemInput[];
  readonly contextProvider?: AgentContextProvider;
  readonly context?: ContextService;
  readonly notes?: NoteRepository;
  readonly contextPressurePolicy?: (input: {
    readonly context: Awaited<ReturnType<ContextService['inspect']>>;
    readonly estimate: RequestCostEstimate;
    readonly signal: AbortSignal;
  }) => ContextTransitionRequest | undefined | Promise<ContextTransitionRequest | undefined>;
  readonly estimator?: RequestEstimator;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly responseFormat?: ModelResponseFormat;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly limits?: Partial<AgentRunLimits>;
  readonly clock?: AgentClock;
  readonly onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
  readonly recordLogicalRequest?: (record: LogicalModelRequestRecord) => void | Promise<void>;
  /** Releases application-owned execution resources after this runtime settles or suspends. */
  readonly release?: () => void | Promise<void>;
}

export interface AgentRunInput {
  readonly task: string;
  readonly runId?: string;
  readonly finalizationId?: string;
  readonly instructions?: readonly string[];
  readonly contextItems?: readonly PromptContextItemInput[];
  readonly signal?: AbortSignal;
}
type ResolvedAgentRunInput = AgentRunInput & {
  readonly runId: string;
  readonly finalizationId: string;
};

export interface AgentSteeringInput {
  readonly instruction: string;
  readonly deliveryId?: string;
}
export interface AgentSteeringReceipt {
  readonly id: string;
  readonly runId: string;
  readonly timestamp: string;
}
export interface AgentRunHandle {
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
  readonly configured: readonly PromptContextItemInput[];
  readonly provider: readonly PromptContextItemInput[];
  readonly run: readonly PromptContextItemInput[];
}

interface AssistantTurnRequest {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly turnIndex: number;
  readonly toolBatchId: string;
  readonly snapshot: TurnSnapshot;
  readonly modelSession: ModelProviderSession;
  readonly signal: AbortSignal;
  readonly modelWindow: ModelWindow;
  readonly controller: AgentRunController;
  readonly run: AgentRunDriver;
}

type AssistantTurnResult =
  | {
      readonly kind: 'settled';
      readonly response: ModelResponse;
      readonly toolCalls: readonly ToolCall[];
      readonly modelOutput: AgentModelOutput;
      readonly nativeTurn?: { readonly snapshot: TurnSnapshot; readonly toolBatchId: string };
    }
  | { readonly kind: 'waiting'; readonly decision: ExecutionDecision }
  | { readonly kind: 'outcome_unknown'; readonly effectId: string };
type RequestAssemblyResult =
  | {
      readonly ok: true;
      readonly request: ModelRequest;
      readonly compiled: CompiledModelRequest;
      readonly estimate: RequestCostEstimate;
      readonly fingerprint: InferenceRequestFingerprintRecord;
    }
  | { readonly ok: false; readonly diagnostic: OverflowDiagnostic };

type TerminalDecision =
  | {
      readonly executionStatus: 'completed';
      readonly terminationReason:
        | 'model_completed'
        | 'model_output_limit'
        | 'content_filtered'
        | 'unknown_model_termination';
      readonly modelOutput: AgentPresentModelOutput;
      readonly turnCount: number;
      readonly modelTerminationReason: ModelResponse['terminationReason'];
      readonly providerTerminationReason?: string;
      readonly cleanupDiagnostic?: {
        readonly kind: 'resource_cleanup';
        readonly message: string;
      };
    }
  | {
      readonly executionStatus: 'failed';
      readonly terminationReason:
        | 'model_output_limit'
        | 'content_filtered'
        | 'unknown_model_termination'
        | 'empty_response'
        | 'malformed_response'
        | 'provider_error'
        | 'runtime_error'
        | 'stream_interrupted'
        | 'request_too_large'
        | 'limit_exhausted';
      readonly modelOutput: AgentModelOutput;
      readonly errorMessage: string;
      readonly turnCount: number;
      readonly modelTerminationReason?: ModelResponse['terminationReason'];
      readonly providerTerminationReason?: string;
      readonly exhaustedLimit?: AgentLimitExceededError['limit'];
      readonly diagnostic?: ModelProviderErrorDiagnostic & {
        readonly turnIndex?: number;
      };
      readonly cleanupDiagnostic?: {
        readonly kind: 'resource_cleanup';
        readonly message: string;
      };
    }
  | {
      readonly executionStatus: 'aborted';
      readonly terminationReason: 'aborted';
      readonly modelOutput: AgentModelOutput;
      readonly errorMessage: string;
      readonly turnCount: number;
      readonly diagnostic?: ModelProviderErrorDiagnostic & {
        readonly turnIndex?: number;
      };
      readonly cleanupDiagnostic?: {
        readonly kind: 'resource_cleanup';
        readonly message: string;
      };
    };
type ExecutionDecision =
  | TerminalDecision
  | {
      readonly executionStatus: 'waiting_for_approval';
      readonly approvals: readonly AgentApprovalRequest[];
    }
  | {
      readonly executionStatus: 'waiting_for_recovery';
      readonly reason: 'provider_outcome_unknown' | 'tool_outcome_unknown';
      readonly effectId: string;
    };

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
  readonly run: AgentRunDriver;
  readonly append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<EventAppendReceipt>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}

interface RunFailureContext {
  readonly lastStartedTurnIndex: number;
  readonly activeModelOutput: AgentModelOutput;
  readonly activeTurnIdentity?: AgentTurnIdentity;
}

class AgentExecutionError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly context: RunFailureContext
  ) {
    super(errorMessage(cause));
    this.name = 'AgentExecutionError';
  }
}

export class AgentRuntime {
  private readonly metadata: Readonly<Record<string, string>> | undefined;
  private readonly estimator: RequestEstimator;
  private readonly maxOutputTokens: number | undefined;
  private readonly toolPolicy: ToolPolicy;
  private tools: readonly CompiledToolDefinition[];
  private readonly resourceLeases: ResourceLeaseCoordinator;
  private readonly requestAssembler: ModelRequestAssembler;
  private readonly inferenceService: InferenceService;
  private pendingCalls = new PendingCallCoordinator();
  private readonly catalogTools = new Map<string, readonly CompiledToolDefinition[]>();
  private contextTransitions: RunContextTransitions | undefined;
  private activeContextIdentity: string | null | undefined;
  private nativeSteering: NativeSteeringCoordinator | undefined;
  private steeringWrites: Promise<void> = Promise.resolve();
  private readonly steeringReceipts = new Map<
    string,
    AgentSteeringReceipt & { readonly instruction: string }
  >();
  private readonly steerQueue: (AgentSteeringReceipt & {
    readonly instruction: string;
  })[] = [];
  private activeAbortController: AbortController | undefined;
  private activeRunId: string | undefined;
  private activeRuns: AgentRunCoordinator | undefined;
  private activeRunDriver: AgentRunDriver | undefined;
  private activeRunReady: Promise<void> | undefined;
  private activeAbortRequest: Promise<void> | undefined;
  private releasePromise: Promise<void> | undefined;
  private static readonly MAX_STEERING_ITEMS = 1024;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.metadata = options.metadata === undefined ? undefined : Object.freeze({ ...options.metadata });
    this.estimator = options.estimator ?? new CompleteRequestEstimator();
    this.requestAssembler = new ModelRequestAssembler(this.estimator);
    this.inferenceService =
      options.inferenceService ?? InferenceService.inMemory({ provider: options.provider });
    this.maxOutputTokens = validateOptionalPositiveInteger(options.maxOutputTokens, 'maxOutputTokens');
    this.toolPolicy = parseToolPolicy(options.toolPolicy ?? READ_ONLY_TOOL_POLICY);
    this.tools = Object.freeze(new ToolRegistry(options.tools ?? []).list());
    this.resourceLeases =
      options.toolResourceLeases ?? options.resources?.resourceLeases ?? new ResourceLeaseCoordinator();
    validateToolBoundary(options.toolBoundary);
  }

  run(input: AgentRunInput): AgentRunHandle {
    const runId = input.runId ?? randomUUID();
    const finalizationId = input.finalizationId ?? randomUUID();
    return this.startRun({ ...input, runId, finalizationId });
  }

  inspectRun(runId: string) {
    return new AgentRunCoordinator(this.options.repositories.events).inspect(runId);
  }

  resume(runId: string, signal?: AbortSignal): AgentRunHandle {
    if (this.activeAbortController) throw new Error('AgentRuntime already has an active run.');
    const runs = new AgentRunCoordinator(this.options.repositories.events);
    const abortController = new AbortController();
    const runReady = Promise.resolve();
    this.activeAbortController = abortController;
    this.activeRunId = runId;
    this.activeRuns = runs;
    this.activeRunReady = runReady;
    const result = this.resumeActive(runId, signal, runs, abortController, runReady);
    return Object.freeze({
      runId,
      injectSteering: (steering: AgentSteeringInput) => this.injectSteering(runId, steering),
      abort: (reason?: string) => this.scheduleAbortRun(runId, reason),
      result
    });
  }

  async resolveApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly fingerprint: string;
    readonly decision: 'allow' | 'deny';
    readonly signal?: AbortSignal;
  }): Promise<AgentRunHandle> {
    try {
      return await this.resolveApprovalActive(input);
    } catch (error) {
      if (this.releasePromise !== undefined) throw error;
      try {
        await this.releaseResources();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'Approval resolution and runtime resource release both failed.',
          { cause: releaseError }
        );
      }
      throw error;
    }
  }

  private async resolveApprovalActive(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly fingerprint: string;
    readonly decision: 'allow' | 'deny';
    readonly signal?: AbortSignal;
  }): Promise<AgentRunHandle> {
    const terminal = await this.options.repositories.events.latestOfType(input.runId, 'run.ended');
    if (terminal?.event.type === 'run.ended') {
      await this.releaseResources();
      return completedRunControl(
        input.runId,
        Object.freeze({
          state: 'ended',
          terminal: terminal.event.terminal,
          deliveryDiagnostics: Object.freeze([])
        })
      );
    }
    const run = await new AgentRunCoordinator(this.options.repositories.events).attach(input.runId);
    if (this.hasToolImplementationMismatch(run)) {
      await this.releaseResources();
      return completedRunControl(input.runId, missingImplementationSuspension(run.state()));
    }
    this.assertRuntimeMatchesRun(run);
    const pendingApproval = findPendingApproval(run.state(), input.approvalId);
    if (!pendingApproval)
      throw new Error(`Run ${input.runId} is not waiting for approval ${input.approvalId}.`);
    const { approval } = pendingApproval;
    if (approval.fingerprint !== input.fingerprint)
      throw new Error(`Approval fingerprint mismatch for ${input.approvalId}.`);
    if (
      approval.binding.authorizationPolicyId !== this.options.toolBoundary.authorizationPolicyId ||
      approval.binding.executionTargetId !== this.options.toolBoundary.executionTargetId
    ) {
      throw new Error(`Approval boundary changed for ${input.approvalId}; a new approval is required.`);
    }
    const call = pendingApproval.batch.calls[pendingApproval.callIndex];
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
    const current = await planToolCall(call, this.tools, authorizationContext);
    if (!current.ok)
      throw new Error(`Approved tool call is no longer valid: ${current.observation.summary}`);
    const validationFailure =
      current.plan.toolImplementationId !== approval.binding.toolImplementationId
        ? new Error(
            `Approved tool implementation changed for ${input.approvalId}; a new approval is required.`
          )
        : current.plan.fingerprint !== approval.fingerprint
          ? new Error(`Approval fingerprint changed for ${input.approvalId}; a new approval is required.`)
          : undefined;
    try {
      await releaseToolCallPlan(current.plan);
    } catch (releaseFailure) {
      if (validationFailure !== undefined)
        throw new AggregateError(
          [validationFailure, releaseFailure],
          'Approval validation and plan release both failed.',
          { cause: releaseFailure }
        );
      throw releaseFailure;
    }
    if (validationFailure !== undefined) throw validationFailure;
    await run.append(
      {
        type: 'approval.resolved',
        runId: input.runId,
        turnIndex: approval.turnIndex,
        turnId: approval.turnId,
        requestAttempt: approval.requestAttempt,
        toolBatchId: approval.toolBatchId,
        callIndex: approval.callIndex,
        ...(approval.callId ? { callId: approval.callId } : {}),
        approvalId: approval.approvalId,
        fingerprint: approval.fingerprint,
        binding: approval.binding,
        decision: input.decision
      },
      `${input.runId}:approval:${input.approvalId}:resolved`
    );
    await run.decideApproval(input);
    const recoverySignal = input.signal ?? new AbortController().signal;
    if (!(await this.reconcileDurableToolBatch(run, recoverySignal))) {
      await this.releaseResources();
      return completedRunControl(input.runId, runSuspension(run.state()));
    }
    return this.startRun(runInput(run.state(), input.signal), undefined, run);
  }

  private startRun(
    input: ResolvedAgentRunInput,
    providerContinuation?: ProviderExecutionContinuation,
    run?: AgentRunDriver
  ): AgentRunHandle {
    const result = this.runActive(input, providerContinuation, run);
    return Object.freeze({
      runId: input.runId,
      injectSteering: (steering: AgentSteeringInput) => this.injectSteering(input.runId, steering),
      abort: (reason?: string) => this.scheduleAbortRun(input.runId, reason),
      result
    });
  }

  private async runActive(
    input: ResolvedAgentRunInput,
    providerContinuation?: ProviderExecutionContinuation,
    attachedRun?: AgentRunDriver
  ): Promise<AgentRunResult> {
    if (this.activeAbortController) throw new Error('AgentRuntime already has an active run.');
    const { runId } = input;
    const abortController = new AbortController();
    const runs = new AgentRunCoordinator(this.options.repositories.events);
    const runReady = attachedRun
      ? Promise.resolve()
      : runs.accept(this.runAcceptance(input)).then(() => undefined);
    this.activeAbortController = abortController;
    this.activeRunId = runId;
    this.activeRuns = runs;
    this.activeRunReady = runReady;
    let cleanupExternalAbort: () => void = () => undefined;
    try {
      await runReady;
      const run = attachedRun ?? (await runs.attach(runId));
      this.activeRunDriver = run;
      this.assertRuntimeMatchesRun(run);
      if (input.signal?.aborted) await this.scheduleAbortRun(runId, abortReason(input.signal.reason));
      else
        cleanupExternalAbort = bindExternalAbort(
          input.signal,
          () => this.scheduleAbortRun(runId, abortReason(input.signal?.reason)),
          abortController
        );
      return await this.runInternal(
        input,
        abortController.signal,
        run,
        providerContinuation,
        attachedRun !== undefined
      );
    } finally {
      cleanupExternalAbort();
      removeRunItems(this.steerQueue, runId);
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      if (this.activeRunId === runId) this.activeRunId = undefined;
      if (this.activeRuns === runs) {
        this.activeRuns = undefined;
        this.activeRunDriver = undefined;
      }
      if (this.activeRunReady === runReady) this.activeRunReady = undefined;
      await this.releaseResources();
    }
  }

  private async resumeActive(
    runId: string,
    signal: AbortSignal | undefined,
    runs: AgentRunCoordinator,
    abortController: AbortController,
    runReady: Promise<void>
  ): Promise<AgentRunResult> {
    let cleanupExternalAbort: () => void = () => undefined;
    try {
      const inspection = await runs.inspect(runId);
      const terminal =
        inspection.state.phase.kind === 'terminal'
          ? await this.options.repositories.events.latestOfType(runId, 'run.ended')
          : undefined;
      if (terminal?.event.type === 'run.ended') {
        return Object.freeze({
          state: 'ended',
          terminal: terminal.event.terminal,
          deliveryDiagnostics: Object.freeze([])
        });
      }
      const run = await runs.attach(runId);
      this.pendingCalls = await PendingCallCoordinator.recover(this.options.repositories.events, runId);
      this.activeRunDriver = run;
      if (this.hasToolImplementationMismatch(run)) return missingImplementationSuspension(run.state());
      this.assertRuntimeMatchesRun(run);
      if (signal?.aborted) await this.scheduleAbortRun(runId, abortReason(signal.reason));
      else
        cleanupExternalAbort = bindExternalAbort(
          signal,
          () => this.scheduleAbortRun(runId, abortReason(signal?.reason)),
          abortController
        );
      const staged = await this.options.repositories.events.latestOfType(runId, 'run.finalization.staged');
      if (staged?.event.type === 'run.finalization.staged')
        return await this.resumeFinalization(run, staged.event, abortController.signal);
      const runState = run.state();
      if (runState.control.status === 'abort_requested') {
        abortController.abort(runState.control.reason);
        return await this.runInternal(runInput(runState), abortController.signal, run, undefined, true);
      }
      if (findPendingApproval(runState)) return this.approvalSuspension(runState);
      if (runState.phase.kind === 'suspended') return runSuspension(runState);
      const phase = currentProviderRequest(runState);
      if (phase?.stage === 'outcome_unknown') return runSuspension(run.state());
      if (phase?.stage === 'effect_ready') {
        const closed = closeExternalEffect(phase.effect, 'cancelled_before_start');
        const decisionRequest = cancelledProviderStartDecisionRequest(run.state(), closed.intent.effectId);
        await this.advanceRun(run, 'start_provider_request', {
          phase: {
            kind: 'suspended',
            reason: 'user_decision',
            effectId: closed.intent.effectId,
            decisionRequest,
            continuation: {
              kind: 'cancelled_provider_start',
              blockedProvider: {
                kind: 'provider',
                identity: phase.identity,
                toolBatchId: phase.toolBatchId,
                requestEventId: phase.requestEventId,
                responseId: phase.responseId,
                effect: closed
              }
            }
          },
          ...(run.state().budget ? { budget: run.state().budget } : {})
        });
        return runSuspension(run.state());
      }
      if (phase?.stage === 'effect_pending') {
        const settlement = await this.findProviderSettlement(
          runId,
          phase.effect.intent.effectId,
          phase.responseId
        );
        if (settlement) {
          const settled = settleExternalEffect(phase.effect, phase.effect.settlementPermit, {
            outcome: 'succeeded',
            resultDigest: hashJson(settlement.event),
            exposure: settlement.event.response.usage
              ? knownEffectExposure(providerUsageQuantities(settlement.event.response.usage))
              : unknownEffectExposure(phase.effect.intent.exposure)
          });
          if (settled.status !== 'settled' && settled.status !== 'already_settled')
            throw new Error(
              `Persisted provider settlement ${settlement.event.responseId} cannot settle effect ${phase.effect.intent.effectId}.`
            );
          await run.transitionProvider(
            'reconcile_provider_request',
            phase.identity,
            () => ({
              ...phase,
              stage: 'settled',
              effect: settled.state,
              settlementEventId: settlement.eventId
            }),
            run.state().budget
          );
        } else {
          const closed = closeExternalEffect(phase.effect, 'unknown_outcome');
          await run.transitionProvider(
            'reconcile_provider_request',
            phase.identity,
            () => ({ ...phase, stage: 'outcome_unknown', effect: closed }),
            run.state().budget
          );
          return runSuspension(run.state());
        }
      }
      const reconciledState = run.state();
      if (currentProviderRequest(reconciledState)?.stage === 'settled') {
        const continuation = await this.providerExecutionContinuation(reconciledState);
        return await this.runInternal(
          runInput(reconciledState),
          abortController.signal,
          run,
          continuation,
          true
        );
      }
      if (
        run
          .state()
          .toolBatches.some((batch) =>
            batch.callStates.some((call) => call.stage !== 'recorded' && call.stage !== 'cancelled')
          ) &&
        !(await this.reconcileDurableToolBatch(run, abortController.signal))
      ) {
        return runSuspension(run.state());
      }
      const recoverablePhase = run.state().phase;
      if (
        recoverablePhase.kind !== 'accepted' &&
        recoverablePhase.kind !== 'initializing' &&
        recoverablePhase.kind !== 'active'
      ) {
        throw new Error(
          `Run ${runId} requires ${nextAgentRunInstruction(run.state()).kind === 'wait' ? 'an explicit recovery decision' : 'a phase-specific recovery implementation'} before it can resume.`
        );
      }
      const input: ResolvedAgentRunInput = {
        task: run.state().input.task,
        runId,
        finalizationId: run.state().finalizationId,
        instructions: run.state().input.instructions,
        contextItems: run.state().input.contextItems
      };
      return await this.runInternal(input, abortController.signal, run, undefined, true);
    } finally {
      cleanupExternalAbort();
      removeRunItems(this.steerQueue, runId);
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      if (this.activeRunId === runId) this.activeRunId = undefined;
      if (this.activeRuns === runs) {
        this.activeRuns = undefined;
        this.activeRunDriver = undefined;
      }
      if (this.activeRunReady === runReady) this.activeRunReady = undefined;
      await this.releaseResources();
    }
  }

  private releaseResources(): Promise<void> {
    this.releasePromise ??= Promise.resolve(this.options.release?.()).then(() => undefined);
    return this.releasePromise;
  }

  private async runInternal(
    input: ResolvedAgentRunInput,
    signal: AbortSignal,
    run: AgentRunDriver,
    providerContinuation?: ProviderExecutionContinuation,
    restoring = false
  ): Promise<AgentRunResult> {
    const { runId, finalizationId } = input;
    const durableState = run.state();
    const controller = new AgentRunController({
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(durableState.budget ? { initialBudget: durableState.budget } : {})
    });
    const deliveryDiagnostics: {
      eventType: string;
      message: string;
      persisted: boolean;
    }[] = [];
    const append = (event: AgentAuditEvent, idempotencyKey?: string) =>
      run.append(event, idempotencyKey ?? `${runId}:event:${hashJson(encodeAgentEvent(event))}`);
    const emit = (event: AgentProgressEvent) =>
      this.emitProgress(finalizationId, event, deliveryDiagnostics, append);
    const finalizer = new AgentRunFinalizer({
      runId,
      finalizationId,
      events: this.options.repositories.events,
      append,
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}),
      ...(this.options.onProgress ? { deliver: this.options.onProgress } : {}),
      deliveryDiagnostics
    });
    let decision: ExecutionDecision;
    try {
      if (run.state().phase.kind === 'accepted' && run.state().control.status === 'owned') {
        await this.advanceRun(run, 'initialize_run', {
          phase: {
            kind: 'initializing',
            step: 'assemble_turn',
            turnIndex: providerContinuation?.identity.turnIndex ?? 1
          },
          budget: controller.snapshot()
        });
      }
      decision = await this.executeRun({
        runId,
        input,
        signal,
        controller,
        run,
        append,
        emit,
        ...(providerContinuation ? { providerContinuation } : {}),
        ...(restoring ? { restoring: true } : {})
      });
    } catch (error) {
      if (error instanceof AgentRunOwnershipLostError) throw error;
      decision = await this.decisionFromError({
        error,
        signal,
        runId,
        controller,
        append,
        emit
      });
    }
    if (decision.executionStatus === 'waiting_for_approval') {
      const cleanupError = await this.releaseOwnedResources(runId, append);
      if (!cleanupError) {
        controller.waitForApproval();
        const budget = controller.snapshot();
        await append({
          type: 'run.phase.changed',
          runId,
          phase: 'waiting_for_approval',
          budget
        });
        await emit({
          type: 'run.phase.changed',
          phase: 'waiting_for_approval',
          budget
        });
        return Object.freeze({
          state: 'suspended',
          reason: 'approval_required',
          runId,
          finalizationId,
          pendingApprovals: decision.approvals,
          budget
        });
      }
      decision = cleanupFailureDecision(undefined, cleanupError);
    } else if (decision.executionStatus === 'waiting_for_recovery') {
      const cleanupError = await this.releaseOwnedResources(runId, append);
      return Object.freeze({
        state: 'suspended',
        reason: decision.reason,
        runId,
        finalizationId,
        effectId: decision.effectId,
        ...(cleanupError
          ? {
              cleanupDiagnostic: {
                kind: 'resource_cleanup' as const,
                message: cleanupError.message
              }
            }
          : {}),
        budget: controller.snapshot()
      });
    } else {
      const cleanupError = await this.releaseOwnedResources(runId, append);
      if (cleanupError) decision = cleanupFailureDecision(decision, cleanupError);
    }
    await this.enterPhase(runId, controller, 'finalizing', append, emit);
    await this.waitForAbortRequest(runId);
    decision = decisionBeforeFinalization(decision, signal);
    if (
      decision.executionStatus !== 'aborted' &&
      run.state().providerRequests.some((request) => request.stage === 'effect_pending')
    )
      throw new Error('An unresolved started provider effect must be reconciled before terminal staging.');
    const terminal = terminalSnapshot(runId, finalizationId, decision, controller);
    await finalizer.stage(terminal, 'diagnostic' in decision ? decision.diagnostic : undefined);
    await this.enterRunFinalization(run, controller.snapshot());
    if (this.options.context && !signal.aborted && this.pendingCalls.pending().length === 0) {
      await this.contextTransitions?.drain({
        context: this.options.context,
        admit: (request) => this.retainActiveSources(request, runId),
        committed: (entry) =>
          emit({
            type: 'context.transitioned',
            window: entry.window,
            transition: entry.transition
          }),
        signal
      });
    }

    const result = await finalizer.finalize(
      terminal,
      'diagnostic' in decision ? decision.diagnostic : undefined
    );
    const terminalRecord = await this.options.repositories.events.latestOfType(runId, 'run.ended');
    if (terminalRecord?.event.type !== 'run.ended')
      throw new Error(`Run ${runId} finalized without a durable terminal event.`);
    const terminalInstruction = nextAgentRunInstruction(run.state());
    if (
      terminalInstruction.kind !== 'execute' ||
      (terminalInstruction.procedure !== 'finalize' && terminalInstruction.procedure !== 'finalize_abort')
    ) {
      throw new Error(`Run ${runId} cannot publish its durable terminal run from the current phase.`);
    }
    await this.advanceRun(run, terminalInstruction.procedure, {
      phase: { kind: 'terminal', resultEventId: terminalRecord.eventId },
      budget: controller.snapshot()
    });
    controller.commitTerminal();
    return result;
  }

  private async resumeFinalization(
    run: AgentRunDriver,
    staged: Extract<AgentEvent, { readonly type: 'run.finalization.staged' }>,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const runId = run.state().runId;
    await this.enterRunFinalization(run, staged.terminal.budget);
    const deliveryDiagnostics: { eventType: string; message: string; persisted: boolean }[] = [];
    const append = (event: AgentAuditEvent, key?: string) =>
      run.append(event, key ?? `${runId}:event:${hashJson(encodeAgentEvent(event))}`);
    this.contextTransitions = new RunContextTransitions({
      runId,
      events: this.options.repositories.events,
      append
    });
    await this.contextTransitions.restore();
    if (this.options.context && !signal.aborted)
      await this.contextTransitions.drain({
        context: this.options.context,
        admit: (request) => this.retainActiveSources(request, runId),
        signal,
        committed: (entry) =>
          this.emitProgress(
            staged.terminal.finalizationId,
            {
              type: 'context.transitioned',
              window: entry.window,
              transition: entry.transition
            },
            deliveryDiagnostics,
            append
          )
      });
    const finalizer = new AgentRunFinalizer({
      runId,
      finalizationId: staged.terminal.finalizationId,
      events: this.options.repositories.events,
      append,
      deliveryDiagnostics,
      ...(this.options.onProgress ? { deliver: this.options.onProgress } : {}),
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {})
    });
    const result = await finalizer.finalize(staged.terminal, staged.diagnostic);
    const committed = await this.options.repositories.events.latestOfType(runId, 'run.ended');
    if (committed?.event.type !== 'run.ended')
      throw new Error('Recovered finalization has no terminal commit.');
    const instruction = nextAgentRunInstruction(run.state());
    if (
      instruction.kind !== 'execute' ||
      !['finalize', 'reconcile_finalization', 'finalize_abort'].includes(instruction.procedure)
    )
      throw new Error('Recovered terminal has no legal finalization transition.');
    await this.advanceRun(run, instruction.procedure, {
      phase: { kind: 'terminal', resultEventId: committed.eventId },
      budget: staged.terminal.budget
    });
    return result;
  }

  private async executeRun(runtime: RunExecutionRuntime): Promise<ExecutionDecision> {
    throwIfAborted(runtime.signal);
    this.steeringReceipts.clear();
    this.nativeSteering = new NativeSteeringCoordinator({
      runId: runtime.runId,
      events: this.options.repositories.events,
      append: (event, key) => runtime.run.append(event, key)
    });
    await this.nativeSteering.restore();
    this.contextTransitions = new RunContextTransitions({
      runId: runtime.runId,
      events: this.options.repositories.events,
      append: (event, key) => runtime.run.append(event, key)
    });
    await this.contextTransitions.restore();
    this.pendingCalls = await PendingCallCoordinator.recover(
      this.options.repositories.events,
      runtime.runId
    );
    const initialPhase = runtime.run.state().phase;
    const initialToolPhase = currentToolBatch(runtime.run.state());
    const durableInstructions = initialToolPhase?.instructions;
    const recordedInput =
      this.options.repositories.session && (runtime.restoring || runtime.providerContinuation)
        ? (
            await this.options.repositories.session.repository.loadReplayState(
              this.options.repositories.session.descriptor
            )
          ).branch.find((entry) => entry.type === 'input' && entry.runId === runtime.runId)
        : undefined;
    const originalInstructions = recordedInput?.type === 'input' ? recordedInput.instructions : undefined;
    const effectiveInstructions = durableInstructions
      ? [...durableInstructions]
      : runtime.providerContinuation
        ? [...runtime.providerContinuation.instructions]
        : originalInstructions
          ? [...originalInstructions]
          : [
              ...applicationInstructions(this.options.instructions),
              ...runInstructions(runtime.input.instructions)
            ];
    if (!(await this.options.repositories.events.latestOfType(runtime.runId, 'run.started'))) {
      await runtime.append(
        {
          type: 'run.started',
          runId: runtime.runId,
          finalizationId: runtime.input.finalizationId,
          task: runtime.input.task,
          model: this.options.model,
          toolPolicy: this.toolPolicy,
          ...(this.metadata ? { metadata: this.metadata } : {})
        },
        `${runtime.runId}:started`
      );
      await runtime.append({
        type: 'run.phase.changed',
        runId: runtime.runId,
        phase: 'initializing',
        budget: runtime.controller.snapshot()
      });
    }
    if (!(await this.options.repositories.events.latestOfType(runtime.runId, 'input.received')))
      await runtime.append({ type: 'input.received', task: runtime.input.task });
    let sessionEntryId: string | undefined;
    if (this.options.repositories.session) {
      const { repository, descriptor } = this.options.repositories.session;
      const inputEntry = await repository.appendInput(descriptor, {
        runId: runtime.runId,
        task: runtime.input.task,
        instructions: originalInstructions ?? [
          ...applicationInstructions(this.options.instructions),
          ...runInstructions(runtime.input.instructions)
        ]
      });
      sessionEntryId = inputEntry.id;
    }
    const replay = await rebuildModelWindowFromRepositories({
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}),
      events: this.options.repositories.events,
      ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}),
      estimator: this.estimator,
      modelWindowImageLimits: {
        maxCount: runtime.controller.limits.activeImageCount,
        maxBytes: runtime.controller.limits.activeImageBytes,
        maxEstimatedTokens: runtime.controller.limits.activeImageTokens
      },
      providerId: this.options.provider.id,
      model: this.options.model,
      ...protocolTarget(await this.options.provider.describeModel(this.options.model)),
      currentRunId: runtime.runId,
      ...(runtime.restoring || runtime.providerContinuation ? { runIds: [runtime.runId] } : {})
    });
    const modelWindow = replay.modelWindow;
    const observationStore = new ObservationStore({
      estimator: this.estimator,
      ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {})
    });
    for (const invalidated of replay.invalidatedProviderStates)
      await runtime.append({
        type: 'provider.state.invalidated',
        state: summarizeProviderState(invalidated.state),
        reason: invalidated.reason
      });
    if (this.options.repositories.session && !runtime.restoring) {
      const replayEvent = {
        type: 'context.replay.created' as const,
        sessionId: this.options.repositories.session.descriptor.id,
        replayedLedgers: replay.replayedLedgers,
        replayedTurns: replay.replayedTurns,
        replayedSessionEntries: replay.replayedSessionEntries,
        replayedToolResults: replay.replayedToolResults,
        ...(replay.providerStateSummary ? { restoredProviderState: replay.providerStateSummary } : {}),
        ...(replay.providerStateRef ? { restoredProviderStateRef: replay.providerStateRef } : {})
      };
      await runtime.append(replayEvent);
      await runtime.emit({ ...replayEvent, type: 'context.replay.restored' });
    }
    throwIfAborted(runtime.signal);

    let turnIndex = initialToolPhase
      ? initialToolPhase.identity.turnIndex
      : (runtime.providerContinuation?.identity.turnIndex ??
        (initialPhase.kind === 'initializing' ? initialPhase.turnIndex : 1));
    let lastStartedTurnIndex = 0;
    let activeModelOutput: AgentModelOutput = { status: 'absent' };
    let activeTurnIdentity: AgentTurnIdentity | undefined;
    let modelSession: ModelProviderSession | undefined;
    let sessionModel: string | undefined;
    let replayRestored = false;
    try {
      if (initialToolPhase) {
        const resumeDecision = await this.resumeDurableToolBatch(runtime, modelWindow, observationStore);
        if (resumeDecision) return resumeDecision;
        turnIndex += 1;
      }
      let providerResume = runtime.providerContinuation;
      const availableTurnEntries =
        runtime.controller.limits.modelTurns - runtime.controller.snapshot().modelTurns + 1;
      for (let turnEntry = 0; turnEntry < availableTurnEntries; turnEntry += 1) {
        runtime.controller.assertElapsed();
        throwIfAborted(runtime.signal);
        const steering = await this.consumeSteeringInstructions(runtime.runId);
        if (steering.length > 0) {
          const delivered = steeringInstructions(steering, effectiveInstructions.length);
          effectiveInstructions.push(...delivered);
          for (const instruction of delivered)
            modelWindow.recordInput(
              instruction.id,
              { role: 'user', content: instruction.content },
              turnIndex
            );
        }
        let snapshot: TurnSnapshot;
        let toolBatchId: string;
        let assistant: AssistantTurnResult;
        if (providerResume) {
          snapshot = await this.restoreTurnSnapshot(
            providerResume.turnSnapshot,
            providerResume.requestEstimate
          );
          toolBatchId = providerResume.toolBatchId;
          activeTurnIdentity = providerResume.identity;
          lastStartedTurnIndex = turnIndex;
          runtime.controller.transition('requesting_model');
          runtime.controller.recordProviderSuccess();
          modelSession = this.inferenceService.createSession();
          sessionModel = snapshot.configuration.model;
          if (
            providerResume.providerState &&
            this.options.repositories.artifacts &&
            modelSession.restoreProviderState
          ) {
            const storedState = await readProviderStateArtifact({
              artifacts: this.options.repositories.artifacts,
              ref: providerResume.providerState.artifact
            });
            if (!storedState)
              throw new Error(
                `Provider continuation state for settled response ${providerResume.providerState.artifact.artifactId} is unavailable.`
              );
            modelSession.restoreProviderState(storedState);
            replayRestored = true;
          }
          assistant = await this.consumeProviderSettlement({
            request: {
              runId: runtime.runId,
              turnIndex,
              snapshot,
              controller: runtime.controller,
              run: runtime.run
            },
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
          if (this.options.toolCatalogProvider)
            this.tools = Object.freeze(new ToolRegistry(await this.options.toolCatalogProvider()).list());
          const tools = Object.freeze(this.availableTools(profile));
          validateModelRun(
            providerInfo.id,
            profile,
            [...tools],
            configuration.temperature,
            configuration.reasoning
          );
          const requestWindow = requestWindowForModel(profile, this.maxOutputTokens);
          observationStore.setTokenBudgets({
            immediate: Math.max(256, Math.min(4_000, Math.floor(requestWindow.maxPromptTokens * 0.12))),
            retained: Math.max(128, Math.min(1_000, Math.floor(requestWindow.maxPromptTokens * 0.03)))
          });
          const continuationEligible = modelSession !== undefined && sessionModel === configuration.model;
          if (!continuationEligible) {
            if (modelSession) {
              modelSession.resetContinuation?.('Model changed between immutable turn snapshots.');
              await modelSession.close?.();
            }
            modelSession = this.inferenceService.createSession();
            sessionModel = configuration.model;
            const restoreProviderState = modelSession.restoreProviderState?.bind(modelSession);
            if (
              !replayRestored &&
              replay.providerState?.model === configuration.model &&
              restoreProviderState
            ) {
              restoreProviderState(replay.providerState);
              replayRestored = true;
              const restoredSummary =
                replay.providerStateSummary ?? summarizeProviderState(replay.providerState);
              await runtime.append({
                type: 'provider.state.restored',
                state: restoredSummary,
                ...(replay.providerStateRef ? { stateRef: replay.providerStateRef } : {})
              });
              await runtime.emit({
                type: 'provider.state.restored',
                state: restoredSummary,
                ...(replay.providerStateRef ? { stateRef: replay.providerStateRef } : {})
              });
            }
          }
          const turnId = randomUUID();
          toolBatchId = randomUUID();
          snapshot = this.createTurnSnapshot({
            turnIndex,
            turnId,
            requestAttempt: 1,
            configuration,
            profile,
            requestWindow,
            tools,
            instructions: effectiveInstructions,
            controller: runtime.controller,
            continuationEligible
          });
          activeTurnIdentity = turnIdentity(snapshot.record);
          const turnStarted = {
            type: 'turn.started' as const,
            runId: runtime.runId,
            task: runtime.input.task,
            ...activeTurnIdentity,
            ...(this.options.repositories.session
              ? { sessionId: this.options.repositories.session.descriptor.id }
              : {}),
            ...(sessionEntryId ? { sessionEntryId } : {})
          };
          await runtime.append(turnStarted);
          await runtime.emit(turnStarted);
          if (this.options.repositories.session && turnIndex === 1) {
            await this.options.repositories.session.repository.appendModelSettings(
              this.options.repositories.session.descriptor,
              {
                provider: providerInfo.id,
                model: configuration.model,
                ...(configuration.temperature === undefined
                  ? {}
                  : { temperature: configuration.temperature }),
                ...(configuration.reasoning?.strategy === 'effort'
                  ? { reasoningEffort: configuration.reasoning.effort }
                  : {})
              }
            );
          }
          if (turnIndex === 1) {
            const configuredEvent = {
              type: 'run.configured' as const,
              configuration: summarizeRunConfiguration({
                provider: providerInfo,
                model: profile,
                tools: [...tools],
                toolPolicy: this.toolPolicy,
                requestWindow,
                ...(this.maxOutputTokens === undefined
                  ? {}
                  : { requestedMaxOutputTokens: this.maxOutputTokens }),
                ...(configuration.temperature === undefined
                  ? {}
                  : { temperature: configuration.temperature }),
                ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
                ...(this.metadata === undefined ? {} : { metadata: this.metadata })
              })
            };
            await runtime.append(configuredEvent);
            await runtime.emit(configuredEvent);
          }
          await this.advanceRun(runtime.run, 'assemble_turn', (state) => ({
            phase: { kind: 'active' },
            providerRequests: [
              ...state.providerRequests,
              { kind: 'provider', stage: 'ready', identity: turnIdentity(snapshot.record), toolBatchId }
            ],
            budget: runtime.controller.snapshot()
          }));
          await this.enterPhase(
            runtime.runId,
            runtime.controller,
            'requesting_model',
            runtime.append,
            runtime.emit
          );
          lastStartedTurnIndex = turnIndex;
          const currentModelSession = modelSession;
          if (!currentModelSession)
            throw new Error('Model session was not initialized for the turn snapshot.');
          this.nativeSteering.bind(
            currentModelSession,
            snapshot.profile.capabilities.protocol?.steering === 'native'
          );
          assistant = await this.requestAssistantTurn(
            {
              runId: runtime.runId,
              input: runtime.input,
              turnIndex,
              toolBatchId,
              snapshot,
              modelSession: currentModelSession,
              signal: runtime.signal,
              modelWindow,
              controller: runtime.controller,
              run: runtime.run
            },
            runtime.append,
            runtime.emit,
            { runtime, observationStore }
          );
        }
        if (assistant.kind === 'waiting') return assistant.decision;
        if (assistant.kind === 'settled' && assistant.nativeTurn) {
          snapshot = assistant.nativeTurn.snapshot;
          toolBatchId = assistant.nativeTurn.toolBatchId;
          activeTurnIdentity = turnIdentity(snapshot.record);
          turnIndex = snapshot.record.turnIndex;
          lastStartedTurnIndex = turnIndex;
        }
        if (assistant.kind === 'outcome_unknown')
          return {
            executionStatus: 'waiting_for_recovery',
            reason: 'provider_outcome_unknown',
            effectId: assistant.effectId
          };
        activeModelOutput = assistant.modelOutput;
        const { response, toolCalls } = assistant;

        if (response.terminationReason === 'tool_calls') {
          if (toolCalls.length === 0) {
            return failedDecision(
              'malformed_response',
              partialOrAbsent(activeModelOutput),
              'Model reported tool-call termination without usable native tool calls.',
              turnIndex,
              response
            );
          }
        } else if (toolCalls.length > 0) {
          return failedDecision(
            'malformed_response',
            partialOrAbsent(activeModelOutput),
            'Model returned native tool calls with a non-tool termination reason.',
            turnIndex,
            response
          );
        }

        if (toolCalls.length === 0) {
          if (!assistant.nativeTurn)
            modelWindow.recordModelOutput({
              turnIndex,
              content: response.content,
              toolCalls: [],
              ...(response.output ? { output: response.output } : {})
            });
          if (activeModelOutput.status === 'absent') {
            const emptyMessage = [
              `Model returned no native tool calls and no visible modelOutput at turnIndex ${String(turnIndex)}.`,
              response.reasoning ? 'Raw private reasoning is not a modelOutput.' : ''
            ]
              .filter(Boolean)
              .join(' ');
            await this.options.repositories.session?.repository.appendObservation(
              this.options.repositories.session.descriptor,
              {
                runId: runtime.runId,
                identity: turnIdentity(snapshot.record),
                toolName: 'assistant_response',
                observation: {
                  ok: false,
                  summary: emptyMessage,
                  output: { content: response.content }
                }
              }
            );
            return failedDecision('empty_response', activeModelOutput, emptyMessage, turnIndex, response);
          }
          const providerSettlement = providerWork(runtime.run.state(), snapshot.record);
          if (providerSettlement.stage !== 'settled')
            throw new Error('Completion requires a settled provider response.');
          return completedDecision(activeModelOutput, turnIndex, response);
        }

        runtime.controller.recordToolCalls(toolCalls);
        modelWindow.recordModelOutput({
          turnIndex,
          content: response.content,
          toolCalls: toolCalls.map(modelToolCallFromToolCall),
          ...(response.output ? { output: response.output } : {})
        });
        if (this.options.repositories.session) {
          for (const [callIndex, call] of toolCalls.entries()) {
            await this.options.repositories.session.repository.appendToolCall(
              this.options.repositories.session.descriptor,
              {
                runId: runtime.runId,
                identity: {
                  ...activeTurnIdentity,
                  toolBatchId,
                  callIndex,
                  ...(call.id ? { callId: call.id } : {})
                },
                call
              }
            );
          }
        }
        const sourceRequest = providerWork(runtime.run.state(), activeTurnIdentity);
        if (sourceRequest.stage !== 'settled')
          throw new Error('Tool calls require a known provider settlement.');
        const group: AgentToolPhase = {
          kind: 'tools',
          identity: activeTurnIdentity,
          toolBatchId,
          calls: toolCalls,
          modelCalls: response.toolCalls ?? [],
          source: {
            responseId: response.requestId ?? response.transport?.responseId ?? sourceRequest.responseId,
            catalog: snapshot.record.toolCatalog
          },
          callStates: toolCalls.map(() => ({ stage: 'ready' })),
          maxConcurrency: runtime.controller.limits.maxConcurrentToolCalls,
          instructions: effectiveInstructions,
          modelInputModalities: snapshot.profile.modalities.input
        };
        this.catalogTools.set(snapshot.record.toolCatalog.revision, snapshot.tools);
        await this.advanceRun(runtime.run, 'consume_provider_settlement', (state) => ({
          phase: { kind: 'active' },
          providerRequests: state.providerRequests.map((record) =>
            sameTurnIdentity(record.identity, group.identity)
              ? { ...sourceRequest, stage: 'consumed' }
              : record
          ),
          toolBatches: [...state.toolBatches, group],
          budget: runtime.controller.snapshot()
        }));
        await this.enterPhase(
          runtime.runId,
          runtime.controller,
          'executing_tools',
          runtime.append,
          runtime.emit
        );
        const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
        let toolResult;
        try {
          toolResult = await this.executeToolWork(
            runtime,
            modelWindow,
            observationStore,
            toolDeadline.signal
          );
        } finally {
          toolDeadline.dispose();
        }
        if (toolResult.outcome === 'waiting_for_approval') {
          return {
            executionStatus: 'waiting_for_approval',
            approvals: toolResult.approvals
          };
        }
        if (toolResult.outcome === 'ownership_lost') throw new AgentRunOwnershipLostError(runtime.runId);
        if (toolResult.outcome === 'waiting_for_recovery') return toolRecoveryDecision(runtime.run.state());
        await this.advanceRun(runtime.run, 'advance_after_tools', {
          phase: {
            kind: 'initializing',
            step: 'assemble_turn',
            turnIndex: turnIndex + 1
          },
          budget: runtime.controller.snapshot()
        });
        turnIndex += 1;
      }
      throw new Error(
        'Model-turn execution exhausted its available entries without a terminal or limit decision.'
      );
    } catch (error) {
      if (error instanceof AgentRunOwnershipLostError || error instanceof AgentExecutionError) throw error;
      throw new AgentExecutionError(error, {
        lastStartedTurnIndex,
        activeModelOutput,
        ...(activeTurnIdentity ? { activeTurnIdentity } : {})
      });
    } finally {
      await modelSession?.close?.();
    }
  }

  private createToolExecutor(
    runtime: RunExecutionRuntime,
    modelWindow: ModelWindow,
    observationStore: ObservationStore,
    signal: AbortSignal
  ): ToolCallExecutor {
    return new ToolCallExecutor({
      runId: runtime.runId,
      driverGeneration: runtime.run.state().driverGeneration,
      resolveTools: (catalog) => this.catalogTools.get(catalog.revision) ?? this.tools,
      currentTools: async () => {
        if (this.options.toolCatalogProvider)
          this.tools = Object.freeze(new ToolRegistry(await this.options.toolCatalogProvider()).list());
        return this.tools;
      },
      toolContext: this.toolContext(signal),
      resourceLeases: this.resourceLeases,
      ...(this.options.toolAuthorizer ? { authorizer: this.options.toolAuthorizer } : {}),
      ...(this.options.toolContextPrerequisite
        ? { contextPrerequisite: this.options.toolContextPrerequisite }
        : {}),
      modelWindow,
      observationStore,
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}),
      controller: runtime.controller,
      state: () => runtime.run.state(),
      transitionTool: async (procedure, target, update) => {
        await runtime.run.transitionTool(procedure, target, update, runtime.controller.snapshot());
        this.pendingCalls.observeState(runtime.run.state());
      },
      settle: (settlement) => this.settleToolEffect(runtime.run, settlement),
      append: runtime.append,
      emit: runtime.emit
    });
  }

  private async executeToolWork(
    runtime: RunExecutionRuntime,
    modelWindow: ModelWindow,
    observationStore: ObservationStore,
    signal: AbortSignal
  ): Promise<ToolWorkStatus> {
    const pump = new ToolWorkPump(
      this.createToolExecutor(runtime, modelWindow, observationStore, signal),
      () => runtime.run.state(),
      signal
    );
    try {
      return await pump.waitUntil(toolObservationsComplete);
    } finally {
      await pump.close();
    }
  }

  private async resumeDurableToolBatch(
    runtime: RunExecutionRuntime,
    modelWindow: ModelWindow,
    observationStore: ObservationStore
  ): Promise<ExecutionDecision | undefined> {
    const initial = currentToolBatch(runtime.run.state());
    if (!initial) throw new Error('Run does not have a durable tool batch to resume.');
    runtime.controller.transition('requesting_model');
    runtime.controller.transition('executing_tools');
    const resumedBudget = runtime.controller.snapshot();
    await runtime.append({
      type: 'run.phase.changed',
      runId: runtime.runId,
      phase: 'executing_tools',
      budget: resumedBudget
    });
    await runtime.emit({
      type: 'run.phase.changed',
      phase: 'executing_tools',
      budget: resumedBudget
    });
    const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
    let resumedTools;
    try {
      resumedTools = await this.executeToolWork(
        runtime,
        modelWindow,
        observationStore,
        toolDeadline.signal
      );
    } finally {
      toolDeadline.dispose();
    }
    if (resumedTools.outcome === 'ownership_lost') throw new AgentRunOwnershipLostError(runtime.runId);
    if (resumedTools.outcome === 'waiting_for_approval')
      return {
        executionStatus: 'waiting_for_approval',
        approvals: resumedTools.approvals
      };
    if (resumedTools.outcome === 'waiting_for_recovery') return toolRecoveryDecision(runtime.run.state());
    await this.advanceRun(runtime.run, 'advance_after_tools', {
      phase: {
        kind: 'initializing',
        step: 'assemble_turn',
        turnIndex: initial.identity.turnIndex + 1
      },
      budget: runtime.controller.snapshot()
    });
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
    const turnCount =
      attached?.lastStartedTurnIndex ??
      (cause instanceof ModelStreamInterruptedError ? cause.turnIndex : 0);
    const attachedIdentity = attached?.activeTurnIdentity ?? {
      turnIndex: Math.max(1, turnCount),
      turnId: `unidentified-turn-${String(Math.max(1, turnCount))}`,
      requestAttempt: 1
    };
    const existingModelOutput = attached?.activeModelOutput ?? {
      status: 'absent' as const
    };
    const diagnostic = providerFailureDiagnostic(
      cause instanceof ModelStreamInterruptedError ? cause.cause : cause
    );
    let recoveredModelOutput: AgentModelOutput = existingModelOutput;
    if (cause instanceof ModelStreamInterruptedError) {
      const content = cause.content.trim();
      const summary = cause.reasoningSummary?.trim() ?? '';
      const visible = content.length > 0 ? content : summary;
      recoveredModelOutput = visible
        ? {
            status: 'partial',
            message: visible,
            source: 'stream_recovery',
            turnIndex: attachedIdentity.turnIndex
          }
        : { status: 'absent' };
      const interrupted = {
        type: 'assistant.interrupted' as const,
        ...attachedIdentity,
        content: cause.content,
        modelOutput: recoveredModelOutput,
        ...(cause.reasoningSummary !== undefined ? { reasoningSummary: cause.reasoningSummary } : {}),
        finalResponseReceived: cause.finalResponseReceived,
        ...(diagnostic ? { diagnostic } : {})
      };
      await safePersist(runtime.append, interrupted);
      await runtime.emit(interrupted);
    }
    if (diagnostic && turnCount > 0) {
      const failed = {
        type: 'model.failed' as const,
        ...attachedIdentity,
        turnIndex: Math.max(1, turnCount),
        diagnostic
      };
      await safePersist(runtime.append, failed);
      await runtime.emit(failed);
    }
    const message = errorMessage(cause);
    const terminalDiagnostic = diagnostic
      ? { ...diagnostic, ...(turnCount > 0 ? { turnIndex: turnCount } : {}) }
      : undefined;
    if (runtime.signal.aborted) {
      return {
        executionStatus: 'aborted',
        terminationReason: 'aborted',
        modelOutput: partialOrAbsent(recoveredModelOutput),
        errorMessage: message,
        turnCount,
        ...(terminalDiagnostic ? { diagnostic: terminalDiagnostic } : {})
      };
    }
    const failureModelOutput = partialOrAbsent(recoveredModelOutput);
    if (cause instanceof AgentLimitExceededError) {
      return {
        executionStatus: 'failed',
        terminationReason: 'limit_exhausted',
        modelOutput: failureModelOutput,
        errorMessage: message,
        turnCount,
        exhaustedLimit: cause.limit
      };
    }
    const boundaryError = cause instanceof ModelStreamInterruptedError ? cause.cause : cause;
    const terminationReason =
      boundaryError instanceof ModelContractError
        ? 'malformed_response'
        : cause instanceof ModelStreamInterruptedError
          ? 'stream_interrupted'
          : cause instanceof RequestAssemblyError
            ? 'request_too_large'
            : diagnostic
              ? 'provider_error'
              : 'runtime_error';
    return {
      executionStatus: 'failed',
      terminationReason,
      modelOutput: failureModelOutput,
      errorMessage: message,
      turnCount,
      ...(terminalDiagnostic ? { diagnostic: terminalDiagnostic } : {})
    };
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
      turnIndex: input.turnIndex,
      turnId: input.turnId,
      requestAttempt: input.requestAttempt,
      provider: this.options.provider.id,
      model: input.configuration.model,
      profileHash: hashJson(input.profile),
      continuationEligible: input.continuationEligible,
      ...(input.configuration.temperature === undefined
        ? {}
        : { temperature: input.configuration.temperature }),
      ...(input.configuration.reasoning === undefined ? {} : { reasoning: input.configuration.reasoning }),
      ...(input.configuration.responseFormat === undefined
        ? {}
        : { responseFormat: input.configuration.responseFormat }),
      toolCatalog: captureToolCatalog(input.tools),
      toolNames: input.tools.map((tool) => tool.name),
      toolPolicyHash: hashJson(this.toolPolicy),
      instructions: [...input.instructions],
      configuredContextSourceIds: contextSourceIds(this.options.contextItems, 'configured'),
      limits: input.controller.limits,
      budget: input.controller.snapshot()
    });
    this.pendingCalls.bindCatalog(record);
    return Object.freeze({
      record,
      profile: input.profile,
      requestWindow: Object.freeze({ ...input.requestWindow }),
      budgetAccountant: new BudgetAccountant(input.requestWindow),
      tools: Object.freeze([...input.tools]),
      configuration: input.configuration,
      instructions: Object.freeze([...input.instructions])
    });
  }

  private async restoreTurnSnapshot(
    record: AgentTurnSnapshotRecord,
    requestEstimate: RequestCostEstimate
  ): Promise<TurnSnapshot> {
    if (record.provider !== this.options.provider.id || record.model !== this.options.model)
      throw new Error(`Persisted turn ${record.turnId} does not match the configured provider and model.`);
    const profile = parseModelProfile(await this.options.provider.describeModel(record.model));
    if (hashJson(profile) !== record.profileHash)
      throw new Error(`Provider model profile changed for persisted turn ${record.turnId}.`);
    if (this.options.toolCatalogProvider)
      this.tools = Object.freeze(new ToolRegistry(await this.options.toolCatalogProvider()).list());
    const available = new Map(this.availableTools(profile).map((tool) => [tool.name, tool]));
    const tools = record.toolNames.map((name) => {
      const tool = available.get(name);
      if (!tool)
        throw new Error(`Tool ${name} required by persisted turn ${record.turnId} is unavailable.`);
      return tool;
    });
    assertToolCatalogCurrent(record.toolCatalog, tools);
    const requestWindow = requestWindowForModel(profile, this.maxOutputTokens);
    const budgetAccountant = new BudgetAccountant(requestWindow);
    budgetAccountant.recordSent(requestEstimate);
    const configuration: RuntimeModelConfiguration = Object.freeze({
      model: record.model,
      ...(record.temperature === undefined ? {} : { temperature: record.temperature }),
      ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
      ...(record.responseFormat === undefined ? {} : { responseFormat: record.responseFormat })
    });
    return Object.freeze({
      record,
      profile,
      requestWindow,
      budgetAccountant,
      tools: Object.freeze(tools),
      configuration,
      instructions: record.instructions
    });
  }

  private async requestNativeTurns(
    initial: AssistantTurnRequest,
    assembly: Extract<RequestAssemblyResult, { readonly ok: true }>,
    runtime: RunExecutionRuntime,
    observationStore: ObservationStore
  ): Promise<AssistantTurnResult> {
    const session = initial.modelSession;
    if (
      !session.streamCompiled ||
      !session.continueNative ||
      !session.deliverToolResults ||
      !session.toolResultStatus
    ) {
      throw new Error(
        'Native execution requires compiled streaming, continuation and result-delivery reconciliation.'
      );
    }
    const deliverToolResults = session.deliverToolResults.bind(session);
    const continueNative = session.continueNative.bind(session);
    const pump = new ToolWorkPump(
      this.createToolExecutor(runtime, initial.modelWindow, observationStore, initial.signal),
      () => runtime.run.state(),
      initial.signal
    );
    const deliveries = new NativeToolDelivery(runtime.run, initial.modelWindow);
    interface Generation {
      readonly generationDeliveryId: string;
      readonly request: AssistantTurnRequest;
      estimate: RequestCostEstimate;
      readonly governed: ReturnType<typeof createRunInferenceLifecycle>;
    }
    const generations = new Map<string, Generation>();
    let active: Generation | undefined;
    let final: Extract<AssistantTurnResult, { readonly kind: 'settled' }> | undefined;
    let paused: ExecutionDecision | undefined;
    let unknownEffect: string | undefined;
    let nextTools = initial.snapshot.tools;
    const pause = new Error('Native execution reached a durable suspension boundary.');
    const pauseFor = (status: ToolWorkStatus): void => {
      if (status.outcome === 'completed') return;
      if (status.outcome === 'ownership_lost') throw new AgentRunOwnershipLostError(runtime.runId);
      paused =
        status.outcome === 'waiting_for_approval'
          ? { executionStatus: 'waiting_for_approval', approvals: status.approvals }
          : toolRecoveryDecision(runtime.run.state());
      throw pause;
    };
    const generation = (context: NativeGenerationContext): Generation => {
      const value = generations.get(context.invocationId);
      if (!value) throw new Error('Native response has no original run authority.');
      return value;
    };
    const createGeneration = async (context: NativeGenerationContext): Promise<Generation> => {
      const first = context.generationDeliveryId === 'initial';
      if (!first) runtime.controller.beginModelTurn();
      const request = context.compiled.logicalRequest;
      const tools =
        context.dispatch?.kind === 'steering' ? (active?.request.snapshot.tools ?? nextTools) : nextTools;
      if (hashJson(toolsForModel([...tools], context.profile)) !== hashJson(request.tools ?? [])) {
        throw new Error('Native dispatch changed the captured tool catalog.');
      }
      const snapshot = first
        ? initial.snapshot
        : this.createTurnSnapshot({
            turnIndex: runtime.controller.snapshot().modelTurns,
            turnId: randomUUID(),
            requestAttempt: 1,
            configuration: initial.snapshot.configuration,
            profile: context.profile,
            requestWindow: initial.snapshot.requestWindow,
            tools,
            instructions: initial.snapshot.instructions,
            controller: runtime.controller,
            continuationEligible: true
          });
      const turn: AssistantTurnRequest = first
        ? initial
        : {
            ...initial,
            turnIndex: snapshot.record.turnIndex,
            snapshot,
            toolBatchId: randomUUID()
          };
      this.catalogTools.set(snapshot.record.toolCatalog.revision, snapshot.tools);
      if (!first) {
        await this.advanceRun(runtime.run, 'assemble_turn', (state) => ({
          phase: { kind: 'active' },
          providerRequests: [
            ...state.providerRequests,
            {
              kind: 'provider',
              stage: 'ready',
              identity: turnIdentity(snapshot.record),
              toolBatchId: turn.toolBatchId
            }
          ],
          budget: runtime.controller.snapshot()
        }));
        const started = {
          type: 'turn.started' as const,
          runId: runtime.runId,
          task: runtime.input.task,
          ...turnIdentity(snapshot.record)
        };
        await runtime.append(started);
        await runtime.emit(started);
      }
      const estimate = snapshot.budgetAccountant.estimateRequest({
        accounting: context.compiled.accounting,
        modelWindowTokens: 0,
        contextTokens: 0
      });
      snapshot.budgetAccountant.recordSent(estimate);
      const fingerprint: InferenceRequestFingerprintRecord = first
        ? assembly.fingerprint
        : {
            ...turnIdentity(snapshot.record),
            requestId: context.invocationId,
            compiledInputIdentity: context.compiled.inputIdentity,
            capabilityRevision: context.compiled.capabilityRevision,
            configuredContextIds: assembly.fingerprint.configuredContextIds,
            providerContextIds: assembly.fingerprint.providerContextIds,
            runContextIds: assembly.fingerprint.runContextIds,
            effectiveInstructionHash: assembly.fingerprint.effectiveInstructionHash,
            modelWindowHistoryHash: hashJson(request.messages),
            modelToolSchemasHash: hashJson(request.tools ?? []),
            modelWindowHash: hashJson(request.messages),
            reductions: []
          };
      await runtime.append({
        type: 'budget.estimate.created',
        ...turnIdentity(snapshot.record),
        attempt: 1,
        estimate,
        snapshot: snapshot.budgetAccountant.snapshot()
      });
      const started = { type: 'assistant.started' as const, ...turnIdentity(snapshot.record) };
      await runtime.append(started);
      await runtime.emit(started);
      const governed = createRunInferenceLifecycle({
        service: this.inferenceService,
        options: this.options,
        request,
        compiled: context.compiled,
        requestEstimate: estimate,
        requestFingerprint: fingerprint,
        requestSummary: summarizeModelRequest(request),
        turnRequest: turn,
        append: runtime.append,
        emit: runtime.emit,
        advanceRun: (driver, procedure, advance) => this.advanceRun(driver, procedure, advance)
      });
      const value = {
        generationDeliveryId: context.generationDeliveryId,
        request: turn,
        estimate,
        governed
      };
      generations.set(context.invocationId, value);
      await governed.lifecycle.start();
      if (context.dispatch) await deliveries.admit(context.dispatch);
      return value;
    };
    try {
      await this.inferenceService.invokeNative({
        invocationId: assembly.fingerprint.requestId,
        ownerId: this.options.inferenceOwnerId ?? runtime.runId,
        purpose: 'agent_step',
        request: assembly.request,
        compiled: assembly.compiled,
        profile: initial.snapshot.profile,
        session,
        signal: initial.signal,
        start: async (context) => {
          await createGeneration(context);
        },
        extended: async (context, dispatch) => {
          const item = generation(context);
          const estimate = item.request.snapshot.budgetAccountant.estimateRequest({
            accounting: dispatch.compiled.accounting,
            modelWindowTokens: 0,
            contextTokens: 0
          });
          item.request.snapshot.budgetAccountant.recordSent(estimate);
          item.estimate = estimate;
          await runtime.append({
            type: 'budget.estimate.created',
            ...turnIdentity(item.request.snapshot.record),
            attempt: 1,
            estimate,
            snapshot: item.request.snapshot.budgetAccountant.snapshot()
          });
          await deliveries.admit(dispatch);
        },
        uncertain: async (context, cause) => {
          const result = await generation(context).governed.lifecycle.uncertain(cause);
          if (result.kind === 'outcome_unknown') unknownEffect = result.effectId;
        },
        onStreamEvent: async (event) => {
          await this.nativeSteering?.observe(event);
          if (event.type === 'response_started') {
            if (!event.native) throw new Error('Native response is missing its admission manifest.');
            if (active) {
              const prior = providerWork(runtime.run.state(), active.request.snapshot.record);
              if (prior.stage === 'settled') {
                await runtime.run.transitionProvider(
                  'consume_provider_settlement',
                  prior.identity,
                  () => ({ ...prior, stage: 'consumed' }),
                  runtime.controller.snapshot()
                );
              }
            }
            const deliveryId = event.native.generationDeliveryId ?? 'initial';
            active = [...generations.values()].find((item) => item.generationDeliveryId === deliveryId);
            if (!active) throw new Error('Native response started without matching run authority.');
          }
          if (event.type === 'tool_result_delivery') await deliveries.observe(event.delivery);
          await active?.governed.onStreamEvent(event);
        },
        settled: async ({ context, boundary, result }) => {
          const item = generation(context);
          const settled = await item.governed.lifecycle.settle(result.response);
          if (settled.kind !== 'settled') throw new Error('Native response did not settle.');
          const response = settled.response;
          const assistant = await this.consumeProviderSettlement({
            request: item.request,
            requestEstimate: item.estimate,
            response,
            identity: turnIdentity(item.request.snapshot.record),
            append: runtime.append,
            emit: runtime.emit
          });
          final = {
            ...assistant,
            nativeTurn: { snapshot: item.request.snapshot, toolBatchId: item.request.toolBatchId }
          };
          const calls = assistant.toolCalls;
          if (calls.length && response.terminationReason !== 'tool_calls') {
            throw new Error('Native response returned calls with an incompatible termination reason.');
          }
          initial.modelWindow.recordModelOutput({
            turnIndex: item.request.turnIndex,
            content: response.content,
            toolCalls: response.toolCalls ?? [],
            ...(response.output ? { output: response.output } : {})
          });
          if (calls.length) {
            runtime.controller.recordToolCalls(calls);
            const source = providerWork(runtime.run.state(), item.request.snapshot.record);
            if (source.stage !== 'settled') throw new Error('Native tool source is not durably settled.');
            const batch: AgentToolPhase = {
              kind: 'tools',
              identity: source.identity,
              toolBatchId: item.request.toolBatchId,
              calls,
              modelCalls: response.toolCalls ?? [],
              callStates: calls.map(() => ({ stage: 'ready' })),
              source: {
                responseId: boundary.responseId,
                nativeCatalogIdentity: boundary.catalogIdentity,
                catalog: item.request.snapshot.record.toolCatalog
              },
              maxConcurrency: runtime.controller.limits.maxConcurrentToolCalls,
              instructions: item.request.snapshot.instructions,
              modelInputModalities: context.profile.modalities.input
            };
            await this.advanceRun(runtime.run, 'consume_provider_settlement', (state) => ({
              phase: { kind: 'active' },
              providerRequests: state.providerRequests.map((record) =>
                sameTurnIdentity(record.identity, source.identity)
                  ? { ...source, stage: 'consumed' }
                  : record
              ),
              toolBatches: [...state.toolBatches, batch],
              budget: runtime.controller.snapshot()
            }));
          }
          await pump.advance();
          pauseFor(
            await pump.waitUntil((state) =>
              boundary.requiredToolCallIds.every((id) =>
                state.toolBatches.some((batch) =>
                  batch.callStates.some(
                    (call, index) => batch.modelCalls[index]?.id === id && call.stage === 'recorded'
                  )
                )
              )
            )
          );
          let ready = deliveries.available();
          if (!calls.length && boundary.pendingToolCalls.length && !ready.results.length) {
            pauseFor(await pump.waitUntil(() => deliveries.available().results.length > 0));
            ready = deliveries.available();
          }
          if (!ready.results.length && !calls.length) return;
          if (this.options.toolCatalogProvider) {
            this.tools = Object.freeze(new ToolRegistry(await this.options.toolCatalogProvider()).list());
          }
          nextTools = Object.freeze(this.availableTools(context.profile));
          const tools = toolsForModel([...nextTools], context.profile);
          // A text response that still waits for an async result is consumed before its successor.
          const source = providerWork(runtime.run.state(), item.request.snapshot.record);
          if (source.stage === 'settled') {
            await runtime.run.transitionProvider(
              'consume_provider_settlement',
              source.identity,
              () => ({ ...source, stage: 'consumed' }),
              runtime.controller.snapshot()
            );
          }
          if (ready.results.length) {
            const delivery = await deliverToolResults({
              deliveryId: randomUUID(),
              responseId: boundary.responseId,
              ...ready,
              tools,
              signal: initial.signal
            });
            await deliveries.observe(delivery);
          } else if (boundary.continuation === 'client') {
            await continueNative({
              deliveryId: randomUUID(),
              responseId: boundary.responseId,
              input: [],
              tools,
              signal: initial.signal
            });
          }
        }
      });
      await this.nativeSteering?.finishResponse();
      if (!final || final.toolCalls.length)
        throw new Error('Native execution ended with unresolved model work.');
      return final;
    } catch (error) {
      if (paused) return { kind: 'waiting', decision: paused };
      if (unknownEffect) return { kind: 'outcome_unknown', effectId: unknownEffect };
      throw error;
    } finally {
      await pump.close();
    }
  }

  private async requestAssistantTurn(
    request: AssistantTurnRequest,
    append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>,
    emit: (event: AgentProgressEvent) => Promise<void>,
    nativeWork: { readonly runtime: RunExecutionRuntime; readonly observationStore: ObservationStore }
  ): Promise<AssistantTurnResult> {
    const deadline = runSignalDeadline(request.controller, request.signal);
    request = { ...request, signal: deadline.signal };
    try {
      const identity = turnIdentity(request.snapshot.record);
      const assembly = await this.assembleModelRequest(request, append, emit);
      if (!assembly.ok) throw new RequestAssemblyError(formatOverflowDiagnostic(assembly.diagnostic));
      const protocol = request.snapshot.profile.capabilities.protocol;
      if (
        request.modelSession.continueNative &&
        (protocol?.asyncTools || protocol?.steering === 'native')
      ) {
        return await this.requestNativeTurns(
          request,
          assembly,
          nativeWork.runtime,
          nativeWork.observationStore
        );
      }
      request.snapshot.budgetAccountant.recordSent(assembly.estimate);
      const ledgerModelRequest = { ...assembly.request };
      delete ledgerModelRequest.signal;
      await append({ type: 'assistant.started', ...identity });
      await emit({ type: 'assistant.started', ...identity });
      const completedAttempt = await invokeRunInference({
        service: this.inferenceService,
        ...(this.nativeSteering ? { steering: this.nativeSteering } : {}),
        options: this.options,
        request: assembly.request,
        compiled: assembly.compiled,
        requestEstimate: assembly.estimate,
        requestFingerprint: assembly.fingerprint,
        requestSummary: summarizeModelRequest(ledgerModelRequest),
        turnRequest: request,
        append,
        emit,
        advanceRun: (driver, procedure, advance) => this.advanceRun(driver, procedure, advance)
      });
      if (completedAttempt.kind === 'outcome_unknown') return completedAttempt;
      return await this.consumeProviderSettlement({
        request,
        requestEstimate: assembly.estimate,
        response: completedAttempt.response,
        identity: completedAttempt.identity,
        append,
        emit
      });
    } finally {
      deadline.dispose();
    }
  }

  private async consumeProviderSettlement(input: {
    readonly request: Pick<AssistantTurnRequest, 'runId' | 'turnIndex' | 'snapshot' | 'controller' | 'run'>;
    readonly requestEstimate: RequestCostEstimate;
    readonly response: ModelResponse;
    readonly identity: AgentTurnIdentity;
    readonly append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>;
    readonly emit: (event: AgentProgressEvent) => Promise<void>;
  }): Promise<Extract<AssistantTurnResult, { readonly kind: 'settled' }>> {
    const { request, response, identity: responseIdentity, append, emit } = input;
    const providerPhase = providerWork(request.run.state(), input.identity);
    if (providerPhase.stage !== 'settled') throw new Error('Provider response is not durably settled.');
    const settlementRecord = await this.findProviderSettlement(
      request.runId,
      providerPhase.effect.intent.effectId,
      providerPhase.responseId
    );
    if (settlementRecord?.eventId !== providerPhase.settlementEventId)
      throw new Error('Provider response settlement is missing or contradictory.');
    const providerState = settlementRecord.event.providerState;
    await append({
      type: 'model.responded',
      ...responseIdentity,
      response: summarizeModelResponse(response, providerState)
    });
    if (providerState)
      await append({
        type: 'provider.state.updated',
        ...responseIdentity,
        state: providerState.summary,
        stateRef: providerState.artifact
      });
    if (response.usage) {
      const budget = request.snapshot.budgetAccountant.recordProviderUsage(response.usage);
      await append({
        type: 'budget.provider_usage.recorded',
        ...responseIdentity,
        usage: response.usage,
        snapshot: budget
      });
      request.controller.recordUsage(response.usage, request.snapshot.profile.pricing);
    } else {
      const completionTokens = this.estimateAssistantOutput(response);
      request.snapshot.budgetAccountant.recordEstimatedResponse(completionTokens);
      request.controller.recordUsage(
        {
          promptTokens: input.requestEstimate.totalPromptTokens,
          completionTokens,
          totalTokens: input.requestEstimate.totalPromptTokens + completionTokens
        },
        request.snapshot.profile.pricing
      );
    }
    const toolCalls = Object.freeze((response.toolCalls ?? []).map(normalizeModelToolCall));
    const modelOutput = modelOutputFromResponse(response, request.turnIndex, toolCalls.length > 0);
    const assistantEnded = {
      type: 'assistant.ended' as const,
      ...responseIdentity,
      content: response.content,
      modelOutput,
      ...(toolCalls.length > 0 ? { toolCalls } : {})
    };
    const assistantReceipt = await append(assistantEnded);
    await emit(assistantEnded);
    if (this.options.repositories.session) {
      await this.options.repositories.session.repository.appendAssistant(
        this.options.repositories.session.descriptor,
        {
          runId: request.runId,
          identity: responseIdentity,
          source: {
            runId: request.runId,
            eventId: assistantReceipt.eventId,
            sequence: assistantReceipt.sequence,
            hash: assistantReceipt.hash
          },
          content: response.content,
          completeness: modelOutput.status,
          ...(response.output ? { output: response.output } : {})
        }
      );
    }
    return { kind: 'settled', response, toolCalls, modelOutput };
  }

  private async assembleModelRequest(
    request: AssistantTurnRequest,
    append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>,
    emit: (event: AgentProgressEvent) => Promise<void>
  ): Promise<RequestAssemblyResult> {
    const identity = turnIdentity(request.snapshot.record);
    if (this.options.context) {
      this.pendingCalls.assertTransitionBoundary();
      await this.contextTransitions?.drain({
        context: this.options.context,
        admit: (transition) => this.retainActiveSources(transition, request.runId),
        committed: (entry) =>
          emit({
            type: 'context.transitioned',
            window: entry.window,
            transition: entry.transition
          }),
        signal: request.signal
      });
    }
    await this.activateCommittedContext(request.modelWindow, request.runId);
    for (const invalidated of request.modelWindow.invalidateProviderState({
      provider: this.options.provider.id,
      model: request.snapshot.configuration.model,
      ...protocolTarget(request.snapshot.profile)
    }))
      await append({
        type: 'provider.state.invalidated',
        state: summarizeProviderState(invalidated.state),
        reason: invalidated.reason
      });
    const contextInputs = await this.collectContextItems(
      request.input,
      request.turnIndex,
      request.snapshot.instructions
    );
    const allContextInputs = [
      ...contextInputs.configured,
      ...contextInputs.provider,
      ...contextInputs.run,
      ...(await this.selectedNoteContext())
    ];
    let attempt = 1;
    let transitionAttempted = false;
    const modelTools = toolsForModel([...request.snapshot.tools], request.snapshot.profile);
    const outputReserveTokens = request.snapshot.requestWindow.maxOutputTokens;
    const reductionRecords: {
      kind: string;
      reason: string;
      sequence: number;
    }[] = [];
    const recordedWindowReductions = new Set<string>();
    const runInstructions = request.snapshot.instructions
      .filter((item) => item.provenance === 'run')
      .map((item) => item.content);
    for (;;) {
      const assembly = this.requestAssembler.assemble({
        window: request.modelWindow,
        task: request.input.task,
        instructions: promptInstructionsForRequest({
          runInstructions,
          configuredInstructions: request.snapshot.instructions
            .filter((instruction) => instruction.provenance === 'application')
            .map((instruction) => ({
              id: instruction.id,
              content: instruction.content,
              role: promptInstructionRole(instruction.role),
              ...(instruction.priority === undefined ? {} : { priority: instruction.priority }),
              ...(instruction.sourceUri ? { sourceUri: instruction.sourceUri } : {})
            }))
        }),
        contextItems: allContextInputs,
        tools: promptToolSpecs(
          [...request.snapshot.tools],
          request.snapshot.profile,
          this.options.toolContext
        ),
        modelProfile: request.snapshot.profile
      });
      const newWindowReductions = assembly.reductions.filter((reduction) => {
        const key = JSON.stringify([
          reduction.itemId,
          reduction.kind,
          reduction.beforeBytes,
          reduction.afterBytes
        ]);
        if (recordedWindowReductions.has(key)) return false;
        recordedWindowReductions.add(key);
        return true;
      });
      if (newWindowReductions.length > 0) {
        const firstSequence = reductionRecords.length + 1;
        reductionRecords.push(
          ...newWindowReductions.map((reduction, index) => ({
            kind: reduction.kind,
            reason: 'selected representation',
            sequence: firstSequence + index
          }))
        );
        await append({
          type: 'context.history.reduced',
          ...identity,
          reductions: newWindowReductions
        });
        await emit({
          type: 'context.history.reduced',
          ...identity,
          reductions: newWindowReductions
        });
      }
      await append({
        type: 'prompt.context.delivered',
        delivery: assembly.context
      });
      await append({
        type: 'prompt.material.selected',
        material: assembly.material
      });
      const modelRequest: ModelRequest = {
        model: request.snapshot.configuration.model,
        messages: [...assembly.messages],
        ...(supportsParameter(request.snapshot.profile, 'maxOutputTokens')
          ? { maxOutputTokens: outputReserveTokens }
          : {}),
        ...(modelTools.length > 0 ? { tools: modelTools } : {}),
        signal: request.signal,
        ...(request.snapshot.configuration.temperature !== undefined
          ? { temperature: request.snapshot.configuration.temperature }
          : {}),
        ...(request.snapshot.configuration.reasoning !== undefined &&
        supportsParameter(request.snapshot.profile, 'reasoning')
          ? { reasoning: request.snapshot.configuration.reasoning }
          : {}),
        ...(request.snapshot.configuration.responseFormat !== undefined
          ? { responseFormat: request.snapshot.configuration.responseFormat }
          : {})
      };
      const compiled = await this.inferenceService.compile(modelRequest, request.snapshot.profile, {
        outputReservation: outputReserveTokens
      });
      const estimate = request.snapshot.budgetAccountant.estimateRequest({
        accounting: compiled.accounting,
        modelWindowTokens: assembly.estimate.modelWindowTokens,
        contextTokens: assembly.estimate.contextTokens
      });
      await append({
        type: 'budget.estimate.created',
        ...identity,
        attempt,
        estimate,
        snapshot: request.snapshot.budgetAccountant.snapshot()
      });
      if (
        !transitionAttempted &&
        this.options.context &&
        this.options.contextPressurePolicy &&
        request.snapshot.budgetAccountant.pressureAfter(estimate) !== 'normal'
      ) {
        transitionAttempted = true;
        const context = await this.options.context.inspect();
        const transition = await this.options.contextPressurePolicy({
          context,
          estimate,
          signal: request.signal
        });
        if (transition) {
          const committed = await this.options.context.transition(
            await this.retainActiveSources(transition, request.runId),
            { signal: request.signal }
          );
          await emit({
            type: 'context.transitioned',
            window: committed.window,
            transition: committed.transition
          });
          await this.activateCommittedContext(request.modelWindow, request.runId);
          allContextInputs.splice(
            0,
            allContextInputs.length,
            ...contextInputs.configured,
            ...contextInputs.provider,
            ...contextInputs.run,
            ...(await this.selectedNoteContext())
          );
          attempt++;
          continue;
        }
      }
      if (request.snapshot.budgetAccountant.canSend(estimate)) {
        const requestFingerprint: InferenceRequestFingerprintRecord = Object.freeze({
          ...identity,
          requestId: randomUUID(),
          compiledInputIdentity: compiled.inputIdentity,
          capabilityRevision: compiled.capabilityRevision,
          configuredContextIds: contextSourceIds(contextInputs.configured, 'configured'),
          providerContextIds: contextSourceIds(contextInputs.provider, 'provider'),
          runContextIds: contextSourceIds(contextInputs.run, 'run'),
          effectiveInstructionHash: hashJson(request.snapshot.instructions),
          modelWindowHistoryHash: hashJson(assembly.historyMessages),
          modelToolSchemasHash: hashJson(modelTools),
          modelWindowHash: hashJson(assembly.messages),
          reductions: reductionRecords
        });
        return {
          ok: true,
          request: modelRequest,
          compiled,
          estimate,
          fingerprint: requestFingerprint
        };
      }
      await append({
        type: 'overflow.recovery.started',
        ...identity,
        attempt,
        estimate,
        snapshot: request.snapshot.budgetAccountant.snapshot()
      });
      const diagnostic = createOverflowDiagnostic(estimate);
      await append({
        type: 'overflow.recovery.ended',
        ...identity,
        attempt,
        result: { kind: 'diagnostic', diagnostic }
      });
      return { ok: false, diagnostic };
    }
  }

  private async activateCommittedContext(window: ModelWindow, runId: string): Promise<void> {
    if (!this.options.context || !this.options.repositories.session) return;
    this.pendingCalls.assertTransitionBoundary();
    const context = await this.options.context.inspect();
    const windowId = context.window?.windowId ?? null;
    const profile = await this.options.provider.describeModel(this.options.model);
    const identity = hashJson({
      windowId,
      provider: this.options.provider.id,
      model: this.options.model,
      protocol: profile.capabilities.protocol ?? null
    });
    if (this.activeContextIdentity === identity) return;
    const replay = await rebuildModelWindowFromRepositories({
      session: this.options.repositories.session,
      events: this.options.repositories.events,
      ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}),
      estimator: this.estimator,
      providerId: this.options.provider.id,
      model: this.options.model,
      ...protocolTarget(profile),
      currentRunId: runId
    });
    for (const invalidated of replay.invalidatedProviderStates) {
      const event = {
        type: 'provider.state.invalidated' as const,
        state: summarizeProviderState(invalidated.state),
        reason: invalidated.reason
      };
      await this.activeRunDriver?.append(
        event,
        `${runId}:native-invalidation:${hashJson(encodeAgentEvent(event))}`
      );
    }
    window.activateSources(replay.modelWindow);
    window.selectToolResultPresentations(
      activeObservationRepresentations(await this.options.context.history.view(), runId)
    );
    this.activeContextIdentity = identity;
  }

  async scheduleContextTransition(
    request: ContextTransitionRequest
  ): Promise<{ readonly requestId: string }> {
    if (!this.options.context || !this.activeRunDriver || !this.contextTransitions)
      throw new Error('Context scheduling requires an active runtime with a context service.');
    return this.contextTransitions.schedule(request);
  }

  private async retainActiveSources(
    transition: ContextTransitionRequest,
    runId: string
  ): Promise<ContextTransitionRequest> {
    if (!this.options.context) throw new Error('Context service is unavailable.');
    const view = await this.options.context.history.view();
    const retained = new Map(
      transition.selection.retained.map((reference) => [reference.entryId, reference])
    );
    for (const entry of view.entries)
      if ('runId' in entry && entry.runId === runId) {
        const source = sourceRef(view.cut.sessionId, entry);
        retained.set(source.entryId, source);
      }
    return {
      ...transition,
      selection: { ...transition.selection, retained: [...retained.values()] }
    };
  }

  pendingToolCalls() {
    return this.pendingCalls.pending();
  }

  private async selectedNoteContext(): Promise<readonly PromptContextItemInput[]> {
    if (!this.options.context || !this.options.notes) return [];
    const context = await this.options.context.inspect();
    const items: PromptContextItemInput[] = [];
    for (const reference of context.window?.selection.notes ?? []) {
      const note = await this.options.notes.read({
        scope: {
          sessionId: context.cut.sessionId,
          branchId: context.cut.branchId
        },
        noteId: reference.noteId,
        revisionId: reference.revisionId,
        maxBytes: 256 * 1024
      });
      if (
        note.status !== 'available' ||
        note.truncated ||
        note.revision.scope.sessionId !== reference.scope.sessionId ||
        note.revision.scope.branchId !== reference.scope.branchId
      )
        throw new Error('Selected note revision is unavailable for the committed context window.');
      items.push({
        id: `note:${reference.noteId}:${reference.revisionId}`,
        sourceUri: `note://${reference.scope.sessionId}/${reference.noteId}/${reference.revisionId}`,
        sourceKind: 'generated',
        representation: 'full',
        mediaType: note.revision.mediaType,
        title: note.revision.title,
        content: note.text,
        purpose: 'selected model note'
      });
    }
    return items;
  }

  private async enterPhase(
    runId: string,
    controller: AgentRunController,
    phase: Parameters<AgentRunController['transition']>[0],
    append: (event: AgentAuditEvent) => Promise<unknown>,
    emit: (event: AgentProgressEvent) => Promise<void>
  ): Promise<void> {
    controller.transition(phase);
    const budget = controller.snapshot();
    await append({ type: 'run.phase.changed', runId, phase, budget });
    await emit({ type: 'run.phase.changed', phase, budget });
  }
  private async emitProgress(
    finalizationId: string,
    event: AgentProgressEvent,
    diagnostics: { eventType: string; message: string; persisted: boolean }[],
    append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<EventAppendReceipt>
  ): Promise<void> {
    if (!this.options.onProgress) return;
    try {
      await this.options.onProgress(event);
    } catch (error) {
      const base = { eventType: event.type, message: errorMessage(error) };
      try {
        const diagnostic = { ...base, persisted: true };
        await append(
          { type: 'delivery.failed', finalizationId, diagnostic },
          `${finalizationId}:delivery:${event.type}:${String(diagnostics.length)}`
        );
        diagnostics.push(diagnostic);
      } catch {
        diagnostics.push({ ...base, persisted: false });
      }
    }
  }
  private async advanceRun(
    run: AgentRunDriver,
    procedure: AgentRunProcedure,
    advance:
      | AgentRunAdvance
      | ((state: import('./run/control/contracts.js').AgentRunState) => AgentRunAdvance)
  ): Promise<void> {
    await run.transition(procedure, typeof advance === 'function' ? advance : () => advance);
    this.pendingCalls.observeState(run.state());
  }
  private async settleToolEffect(
    run: AgentRunDriver,
    input: Parameters<AgentRunCoordinator['settleToolEffect']>[1]
  ): Promise<'owned' | 'ownership_lost'> {
    const synchronized = await run.settleToolEffect(input);
    this.pendingCalls.observeState(synchronized.state);
    const control = synchronized.state.control;
    return (control.status === 'owned' || control.status === 'abort_requested') &&
      control.driverId === run.driverId
      ? 'owned'
      : 'ownership_lost';
  }
  private approvalSuspension(state: import('./run/control/contracts.js').AgentRunState): AgentRunResult {
    const approval = findPendingApproval(state);
    if (!approval) throw new Error(`Run ${state.runId} is not waiting for approval.`);
    if (!state.budget)
      throw new Error(`Run ${state.runId} has no durable budget at its approval boundary.`);
    return Object.freeze({
      state: 'suspended',
      reason: 'approval_required',
      runId: state.runId,
      finalizationId: state.finalizationId,
      pendingApprovals: Object.freeze([approval.approval]),
      budget: state.budget
    });
  }
  private async findProviderSettlement(
    runId: string,
    effectId: string,
    responseId: string
  ): Promise<
    | {
        readonly eventId: string;
        readonly event: Extract<AgentEvent, { readonly type: 'provider.attempt.settled' }>;
      }
    | undefined
  > {
    let match:
      | {
          readonly eventId: string;
          readonly event: Extract<AgentEvent, { readonly type: 'provider.attempt.settled' }>;
        }
      | undefined;
    for await (const record of this.options.repositories.events.read(runId)) {
      if (
        record.event.type !== 'provider.attempt.settled' ||
        record.event.effectId !== effectId ||
        record.event.responseId !== responseId
      )
        continue;
      if (match) throw new Error(`Run ${runId} contains duplicate provider settlements for ${responseId}.`);
      match = Object.freeze({ eventId: record.eventId, event: record.event });
    }
    return match;
  }
  private async reconcileDurableToolBatch(run: AgentRunDriver, signal: AbortSignal): Promise<boolean> {
    const attempted = new Set<string>();
    for (;;) {
      const eligible = run.state().toolBatches.flatMap((batch) =>
        batch.callStates.flatMap((call, callIndex) => {
          if (attempted.has(`${batch.toolBatchId}:${String(callIndex)}`)) return [];
          if (
            ((call.stage === 'effect_ready' || call.stage === 'effect_pending') &&
              call.effect.ticket.driverGeneration !== run.state().driverGeneration) ||
            (call.stage === 'outcome_unknown' &&
              call.effect.phase === 'started' &&
              call.effect.intent.recovery.kind !== 'unknown')
          )
            return [{ phase: batch, callIndex }];
          return [];
        })
      )[0];
      if (!eligible)
        return !run
          .state()
          .toolBatches.some((batch) => batch.callStates.some((call) => call.stage === 'outcome_unknown'));
      const { phase, callIndex } = eligible;
      const callState = phase.callStates[callIndex];
      if (callState?.stage === 'effect_ready') {
        closeExternalEffect(callState.effect, 'cancelled_before_start');
        const generation = run.state().driverGeneration;
        const reissued = issueEffectStartTicket({
          intent: callState.effect.intent,
          ticketId: `${callState.effect.intent.effectId}:start:${String(generation)}`,
          settlementPermitId: `${callState.effect.intent.effectId}:settle:${String(generation)}`,
          driverGeneration: generation,
          currentDriverGeneration: generation
        });
        if (reissued.status !== 'issued')
          throw new Error(
            `Run ${run.state().runId} could not reissue tool effect ${callState.effect.intent.effectId}.`
          );
        try {
          await run.transitionTool(
            'reconcile_tool_call',
            { toolBatchId: phase.toolBatchId, callIndex },
            () => ({
              stage: 'effect_ready',
              plan: callState.plan,
              toolAttempt: callState.toolAttempt,
              effect: reissued.state
            }),
            run.state().budget
          );
        } catch (error) {
          if (!(error instanceof AgentRunConflictError) || error.reason !== 'stale_tail') throw error;
        }
        continue;
      }
      if (callState?.stage !== 'effect_pending' && callState?.stage !== 'outcome_unknown')
        throw new Error(`Run ${run.state().runId} has contradictory tool recovery state.`);
      const startedEffect = callState.effect;
      if (startedEffect.phase !== 'started')
        throw new Error(`Run ${run.state().runId} selected a closed tool outcome for recovery.`);
      const startedCallState = Object.freeze({
        stage: callState.stage,
        plan: callState.plan,
        toolAttempt: callState.toolAttempt,
        effect: startedEffect
      });
      try {
        if (await this.reconcileStartedToolEffect(run, phase, callIndex, startedCallState, signal))
          continue;
      } catch (error) {
        if (!(error instanceof AgentRunConflictError) || error.reason !== 'stale_tail') throw error;
        continue;
      }
      attempted.add(`${phase.toolBatchId}:${String(callIndex)}`);
      if (callState.stage === 'effect_pending') {
        try {
          await run.transitionTool(
            'reconcile_tool_call',
            { toolBatchId: phase.toolBatchId, callIndex },
            () => ({
              stage: 'outcome_unknown',
              plan: callState.plan,
              toolAttempt: callState.toolAttempt,
              effect: callState.effect
            }),
            run.state().budget
          );
        } catch (error) {
          if (!(error instanceof AgentRunConflictError) || error.reason !== 'stale_tail') throw error;
          const current = run.state().toolBatches.find((batch) => batch.toolBatchId === phase.toolBatchId)
            ?.callStates[callIndex];
          if (current?.stage === 'effect_pending')
            attempted.delete(`${phase.toolBatchId}:${String(callIndex)}`);
        }
      }
    }
  }

  private async reconcileStartedToolEffect(
    run: AgentRunDriver,
    phase: AgentToolPhase,
    callIndex: number,
    callState: Readonly<{
      readonly stage: 'effect_pending' | 'outcome_unknown';
      readonly plan: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect: Extract<
        import('@agent-core/effects').EffectExecutionState,
        { readonly phase: 'started' }
      >;
    }>,
    signal: AbortSignal
  ): Promise<boolean> {
    if (callState.effect.intent.recovery.kind === 'unknown') return false;
    const call = phase.calls[callIndex];
    if (!call)
      throw new Error(
        `Run ${run.state().runId} has no tool call for effect ${callState.effect.intent.effectId}.`
      );
    const context = Object.freeze({
      ...this.toolContext(signal),
      invocation: Object.freeze({
        runId: run.state().runId,
        ...phase.identity,
        toolBatchId: phase.toolBatchId,
        callIndex,
        ...(call.id ? { callId: call.id } : {}),
        toolAttempt: callState.toolAttempt
      })
    });
    const planningResult = await planToolCall(call, this.tools, context);
    if (!planningResult.ok) return false;
    const plan = planningResult.plan;
    try {
      if (
        plan.toolImplementationId !== callState.plan.toolImplementationId ||
        plan.fingerprint !== callState.plan.fingerprint
      )
        return false;
      const recovery = await recoverToolCallPlan(plan, callState.effect, {
        ...context,
        invocation: context.invocation
      });
      if (recovery.status === 'settled') {
        if (callState.effect.intent.recovery.kind === 'preconditioned_reexecution') {
          throw new Error(
            'A preconditioned re-execution capability cannot claim a previous external settlement.'
          );
        }
        const observationStore = new ObservationStore({
          estimator: this.estimator,
          ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {})
        });
        const tool = this.tools.find(
          (modelOutput) =>
            modelOutput.name === call.name && modelOutput.implementationId === plan.toolImplementationId
        );
        const committed = await observationStore.commitToolObservation({
          turnIndex: phase.identity.turnIndex,
          call,
          canonicalSnapshot: plan.canonicalSnapshot,
          tool,
          observation: recovery.observation
        });
        const settlement = {
          observationId: committed.id,
          observation: committed.durableObservation,
          createdAt: committed.createdAt
        };
        try {
          await run.settleToolEffect({
            effectId: callState.effect.intent.effectId,
            permit: callState.effect.settlementPermit,
            settlement
          });
        } catch (error) {
          if (
            !(error instanceof AgentRunConflictError) ||
            (error.reason !== 'stale_tail' && error.reason !== 'idempotency_conflict')
          )
            throw error;
          const synchronized = await run.synchronize();
          const current = synchronized.state.toolBatches.find(
            (batch) => batch.toolBatchId === phase.toolBatchId
          )?.callStates[callIndex];
          if (
            (current?.stage !== 'settled' &&
              current?.stage !== 'recording' &&
              current?.stage !== 'recorded') ||
            current.effect?.intent.effectId !== callState.effect.intent.effectId
          )
            throw error;
        }
        return true;
      }
      if (recovery.status !== 'reexecute') return false;
      const capability = callState.effect.intent.recovery;
      if (
        capability.kind !== 'preconditioned_reexecution' ||
        !sameResourcePreconditions(recovery.preconditions, capability.preconditions)
      )
        return false;
      closeExternalEffect(callState.effect, 'unknown_outcome');
      const toolAttempt = callState.toolAttempt + 1;
      const effectId = `${run.state().runId}:${phase.identity.turnId}:${phase.toolBatchId}:${String(callIndex)}:${String(toolAttempt)}`;
      const generation = run.state().driverGeneration;
      const issued = issueEffectStartTicket({
        intent: { ...callState.effect.intent, effectId },
        ticketId: `${effectId}:start:${String(generation)}`,
        settlementPermitId: `${effectId}:settle:${String(generation)}`,
        driverGeneration: generation,
        currentDriverGeneration: generation
      });
      if (issued.status !== 'issued')
        throw new Error(`Run ${run.state().runId} could not issue a recovered tool effect.`);
      await run.transitionTool(
        'reconcile_tool_call',
        { toolBatchId: phase.toolBatchId, callIndex },
        () => ({
          stage: 'effect_ready',
          plan: callState.plan,
          toolAttempt,
          effect: issued.state
        }),
        run.state().budget
      );
      return true;
    } finally {
      await releaseToolCallPlan(plan);
    }
  }
  private async providerExecutionContinuation(
    state: import('./run/control/contracts.js').AgentRunState
  ): Promise<ProviderExecutionContinuation> {
    const phase = currentProviderRequest(state);
    if (phase?.stage !== 'settled')
      throw new Error(`Run ${state.runId} has no settled provider response to resume.`);
    if (!state.budget)
      throw new Error(`Run ${state.runId} has no durable budget at its provider settlement.`);
    const settlement = await this.findProviderSettlement(
      state.runId,
      phase.effect.intent.effectId,
      phase.responseId
    );
    if (settlement?.eventId !== phase.settlementEventId)
      throw new Error(
        `Run ${state.runId} is missing its exact provider settlement ${phase.settlementEventId}.`
      );
    let turnSnapshot: AgentTurnSnapshotRecord | undefined;
    let requestEstimate: RequestCostEstimate | undefined;
    for await (const record of this.options.repositories.events.read(state.runId)) {
      const event = record.event;
      if (
        event.type === 'turn.snapshot.created' &&
        sameTurnIdentity(turnIdentity(event.snapshot), phase.identity)
      )
        turnSnapshot = event.snapshot;
      else if (event.type === 'budget.estimate.created' && sameTurnIdentity(event, phase.identity))
        requestEstimate = event.estimate;
    }
    if (!turnSnapshot)
      throw new Error(
        `Run ${state.runId} is missing the immutable snapshot for provider response ${phase.responseId}.`
      );
    if (!requestEstimate)
      throw new Error(
        `Run ${state.runId} is missing the request estimate for provider response ${phase.responseId}.`
      );
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
  private async enterRunFinalization(
    run: AgentRunDriver,
    budget: import('./run/contracts.js').AgentRunBudgetState
  ): Promise<void> {
    for (let transitions = 0; transitions < 4; transitions += 1) {
      const state = run.state();
      if (state.phase.kind === 'finalization') return;
      if (state.phase.kind === 'terminal') throw new Error(`Run ${state.runId} is already terminal.`);
      const next = nextAgentRunInstruction(state);
      if (next.kind !== 'execute')
        throw new Error(
          `Run ${state.runId} requires ${next.kind === 'wait' ? next.reason : 'completion'} instead of finalization.`
        );
      const instruction = next.procedure;
      if (
        state.toolBatches.some((batch) =>
          batch.callStates.some((call) => call.stage !== 'recorded' && call.stage !== 'cancelled')
        ) &&
        state.phase.kind !== 'cancelling'
      ) {
        await this.advanceRun(run, 'finalize_abort', {
          phase: {
            kind: 'cancelling',
            stage: 'requested'
          },
          toolBatches: state.toolBatches.map(closeOpenToolCalls),
          budget
        });
        continue;
      }
      switch (instruction) {
        case 'consume_provider_settlement': {
          const settled = currentProviderRequest(state);
          if (settled?.stage !== 'settled')
            throw new Error('Finalization requires its settled provider response.');
          await this.advanceRun(run, instruction, {
            phase: { kind: 'finalization', stage: 'ready' },
            providerRequests: state.providerRequests.map((request) =>
              sameTurnIdentity(request.identity, settled.identity)
                ? { ...settled, stage: 'consumed' }
                : request
            ),
            budget
          });
          continue;
        }
        case 'initialize_run':
        case 'assemble_turn':
        case 'authorize_provider_request':
        case 'plan_tool_call':
        case 'reconcile_tool_call':
        case 'begin_observation_recording':
        case 'record_tool_observation':
        case 'advance_after_tools':
        case 'finalize_abort':
          await this.advanceRun(run, instruction, {
            phase: { kind: 'finalization', stage: 'ready' },
            budget
          });
          continue;
        case 'start_provider_request': {
          const provider = currentProviderRequest(state);
          if (provider?.stage !== 'effect_ready')
            throw new Error(`Run ${state.runId} has contradictory provider start state.`);
          closeExternalEffect(provider.effect, 'cancelled_before_start');
          await this.advanceRun(run, instruction, {
            phase: { kind: 'finalization', stage: 'ready' },
            budget
          });
          continue;
        }
        case 'start_tool_call':
          throw new Error(`Run ${state.runId} has a tool start instruction outside a tool batch.`);
        case 'reconcile_provider_request':
          throw new Error(
            `Run ${state.runId} has an unresolved started provider effect and cannot finalize it as a local failure.`
          );
        case 'finalize':
          return;
        case 'reconcile_finalization':
          return;
      }
    }
    throw new Error(
      `Run ${run.state().runId} could not enter finalization within its bounded transition path: ${JSON.stringify(run.state().phase)}.`
    );
  }
  private runAcceptance(input: ResolvedAgentRunInput) {
    return Object.freeze({
      runId: input.runId,
      finalizationId: input.finalizationId,
      input: Object.freeze({
        task: input.task,
        instructions: Object.freeze([...(input.instructions ?? [])]),
        contextItems: Object.freeze(
          (input.contextItems ?? []).map((item) => decodePromptContextItemInput(item))
        )
      }),
      configuration: this.currentRunConfiguration()
    });
  }
  private assertRuntimeMatchesRun(run: AgentRunDriver): void {
    const captured = run.state().configuration;
    const current = this.currentRunConfiguration();
    if (hashJson(captured) !== hashJson(current)) {
      throw new Error(
        `Run ${run.state().runId} was captured for a different runtime implementation or configuration.`
      );
    }
  }
  private hasToolImplementationMismatch(run: AgentRunDriver): boolean {
    if (!currentToolBatch(run.state())) return false;
    const captured = run.state().configuration;
    const current = this.currentRunConfiguration();
    const nonToolConfigurationMatches =
      captured.providerId === current.providerId &&
      captured.providerImplementationId === current.providerImplementationId &&
      captured.model === current.model &&
      captured.runtimeImplementationId === current.runtimeImplementationId &&
      captured.policyHash === current.policyHash;
    return (
      nonToolConfigurationMatches &&
      !sameStrings(captured.toolImplementationIds, current.toolImplementationIds)
    );
  }
  private currentRunConfiguration() {
    return Object.freeze({
      providerId: this.options.provider.id,
      providerImplementationId: this.options.provider.implementationId,
      model: this.options.model,
      runtimeImplementationId: 'agent-core.runtime.run-v1',
      toolImplementationIds: Object.freeze(this.tools.map((tool) => tool.implementationId)),
      policyHash: hashJson({
        policy: this.toolPolicy,
        resourceLifetime: this.options.resources?.lifetime ?? { kind: 'run' },
        inferenceOwnerId: this.options.inferenceOwnerId ?? null
      })
    });
  }
  private captureRuntimeConfiguration(): RuntimeModelConfiguration {
    return Object.freeze({
      model: this.options.model,
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      ...(this.options.reasoning === undefined ? {} : { reasoning: this.options.reasoning }),
      ...(this.options.responseFormat === undefined ? {} : { responseFormat: this.options.responseFormat })
    });
  }
  private toolContext(signal: AbortSignal): ToolPlanningContext {
    const services = {
      ...(this.options.toolContext?.services ?? {}),
      ...(this.options.repositories.artifacts
        ? { artifactRepository: this.options.repositories.artifacts }
        : {})
    };
    return {
      ...(this.options.toolContext ?? {}),
      ...(Object.keys(services).length > 0 ? { services } : {}),
      policy: this.toolPolicy,
      signal,
      boundary: this.options.toolBoundary,
      ...(this.options.resources?.lifetime.kind === 'owner'
        ? { resourceOwnerId: this.options.resources.lifetime.ownerId }
        : {})
    };
  }
  private async collectContextItems(
    input: AgentRunInput,
    turnIndex: number,
    instructions: readonly AgentEffectiveInstruction[]
  ): Promise<ResolvedContextInputs> {
    const providerItems = this.options.contextProvider
      ? await this.options.contextProvider({
          task: input.task,
          turnIndex,
          instructions
        })
      : [];
    return Object.freeze({
      configured: Object.freeze([...(this.options.contextItems ?? [])]),
      provider: Object.freeze([...providerItems]),
      run: Object.freeze([...(input.contextItems ?? [])])
    });
  }
  private estimateAssistantOutput(response: ModelResponse): number {
    const toolText = response.toolCalls?.length ? `\n${JSON.stringify(response.toolCalls)}` : '';
    return this.estimator.estimateText(`${response.content}${response.reasoningSummary ?? ''}${toolText}`);
  }
  private availableTools(profile?: ModelProfile): CompiledToolDefinition[] {
    const context = this.toolContext(new AbortController().signal);
    return this.tools.filter(
      (tool) =>
        isToolAvailable(tool, this.toolPolicy) &&
        toolRequirementsSatisfied(tool, {
          ...(context.services ? { services: context.services } : {}),
          ...(profile ? { modelInputModalities: profile.modalities.input } : {}),
          hostCapabilities: this.options.resources?.capabilities ?? []
        })
    );
  }
  private async releaseOwnedResources(
    runId: string,
    append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>
  ): Promise<Error | undefined> {
    const resources = this.options.resources;
    if (!resources || resources.lifetime.kind === 'owner') return undefined;
    try {
      for (const report of await resources.release(runId)) {
        await append(
          {
            type: 'resource.released',
            runId,
            resourceId: report.resourceId,
            outcome: report.outcome,
            details: report.details
          },
          `${runId}:resource:${report.resourceId}:released`
        );
        if (report.outcome === 'unknown')
          return new Error(`Resource ${report.resourceId} release outcome is unknown.`);
        await resources.acknowledge(report.resourceId);
      }
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  private async consumeSteeringInstructions(runId: string): Promise<string[]> {
    await this.steeringWrites;
    const selected = this.steerQueue.filter((item) => item.runId === runId);
    removeRunItems(this.steerQueue, runId);
    if (!this.nativeSteering) return selected.map((item) => item.instruction);
    for (const item of selected) await this.nativeSteering.accept(item.id, item.instruction);
    return (await this.nativeSteering.nextRequestInputs()).map((item) => item.content);
  }
  private injectSteering(runId: string, input: AgentSteeringInput): AgentSteeringReceipt {
    if (this.activeRunId !== runId) throw new Error(`Run ${runId} is not active.`);
    if (input.instruction.trim().length === 0) throw new Error('Steering instruction must not be empty.');
    if (input.deliveryId !== undefined && !input.deliveryId)
      throw new Error('Steering delivery identity must not be empty.');
    const previous = input.deliveryId ? this.steeringReceipts.get(input.deliveryId) : undefined;
    if (previous) {
      if (previous.instruction !== input.instruction)
        throw new Error('Steering identity has conflicting original input.');
      return previous;
    }
    assertQueueCapacity(this.steerQueue, AgentRuntime.MAX_STEERING_ITEMS, 'steering');
    const receipt = Object.freeze({
      id: input.deliveryId ?? randomUUID(),
      runId,
      timestamp: new Date().toISOString()
    });
    this.steeringReceipts.set(receipt.id, { ...receipt, instruction: input.instruction });
    this.steerQueue.push({ ...receipt, instruction: input.instruction });
    const steering = this.nativeSteering;
    if (steering)
      this.steeringWrites = this.steeringWrites.then(() => steering.accept(receipt.id, input.instruction));
    return receipt;
  }
  private async abortRun(runId: string, reason = 'Agent run aborted.'): Promise<void> {
    const runs = this.activeRuns;
    const runReady = this.activeRunReady;
    if (this.activeRunId !== runId || !runs || !runReady) return;
    const driver = this.activeRunDriver;
    if (driver?.state().runId === runId) {
      await driver.requestAbort(reason);
    } else {
      await runReady;
      if (this.activeRunId !== runId || this.activeRuns !== runs) return;
      const attachedDriver = this.activeRunDriver;
      if (attachedDriver?.state().runId === runId) await attachedDriver.requestAbort(reason);
      else await runs.requestAbort(runId, reason);
    }
    if (this.activeRunId === runId) this.activeAbortController?.abort(reason);
  }
  private scheduleAbortRun(runId: string, reason = 'Agent run aborted.'): Promise<void> {
    const request = this.abortRun(runId, reason);
    this.activeAbortRequest = request;
    void request
      .finally(() => {
        if (this.activeAbortRequest === request) this.activeAbortRequest = undefined;
      })
      .catch(() => undefined);
    return request;
  }
  private async waitForAbortRequest(runId: string): Promise<void> {
    const request = this.activeRunId === runId ? this.activeAbortRequest : undefined;
    if (request) await request;
  }
}

function cleanupFailureDecision(previous: TerminalDecision | undefined, error: Error): TerminalDecision {
  const cleanupDiagnostic = {
    kind: 'resource_cleanup' as const,
    message: error.message
  };
  if (!previous)
    return {
      executionStatus: 'failed',
      terminationReason: 'runtime_error',
      modelOutput: { status: 'absent' },
      errorMessage: `Resource cleanup failed: ${error.message}`,
      turnCount: 0,
      cleanupDiagnostic
    };
  return {
    ...previous,
    executionStatus: 'failed',
    terminationReason: 'runtime_error',
    errorMessage: `${'errorMessage' in previous ? `${previous.errorMessage} ` : ''}Resource cleanup failed: ${error.message}`,
    cleanupDiagnostic
  };
}

function runSignalDeadline(
  controller: AgentRunController,
  parentSignal: AbortSignal
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const timeout = new AbortController();
  const checkDeadline = (): void => {
    try {
      // A host timer is a wake-up, not elapsed-time evidence. Recheck the owning
      // monotonic clock, including when an application supplies that clock.
      timer = setTimeout(checkDeadline, controller.remainingElapsedMs() + 1);
    } catch (error) {
      timeout.abort(error);
    }
  };
  let timer = setTimeout(checkDeadline, controller.remainingElapsedMs() + 1);
  return {
    signal: AbortSignal.any([parentSignal, timeout.signal]),
    dispose: () => {
      clearTimeout(timer);
    }
  };
}

function terminalSnapshot(
  runId: string,
  finalizationId: string,
  decision: TerminalDecision,
  controller: AgentRunController
): AgentTerminalSnapshot {
  const common = {
    runId,
    finalizationId,
    phase: 'ended' as const,
    turnCount: decision.turnCount,
    modelOutput: decision.modelOutput,
    budget: controller.snapshot(),
    ...('modelTerminationReason' in decision
      ? { modelTerminationReason: decision.modelTerminationReason }
      : {}),
    ...('providerTerminationReason' in decision
      ? { providerTerminationReason: decision.providerTerminationReason }
      : {}),
    ...('exhaustedLimit' in decision ? { exhaustedLimit: decision.exhaustedLimit } : {}),
    ...(decision.cleanupDiagnostic ? { cleanupDiagnostic: decision.cleanupDiagnostic } : {})
  };
  if (decision.executionStatus === 'completed') {
    if (common.modelOutput.status === 'absent')
      throw new Error('Completed execution requires a present modelOutput.');
    return createAgentTerminalSnapshot({
      ...common,
      modelOutput: common.modelOutput,
      executionStatus: 'completed',
      terminationReason: decision.terminationReason
    });
  }
  if (decision.executionStatus === 'aborted') {
    const modelOutput = common.modelOutput;
    if (modelOutput.status !== 'absent' && modelOutput.status !== 'partial')
      throw new Error('Aborted execution can only preserve a partial modelOutput.');
    const abortedModelOutput: import('./run/contracts.js').AgentAbortedTerminalSnapshot['modelOutput'] =
      modelOutput.status === 'absent' ? modelOutput : Object.freeze({ ...modelOutput, status: 'partial' });
    return createAgentTerminalSnapshot({
      ...common,
      modelOutput: abortedModelOutput,
      executionStatus: 'aborted',
      terminationReason: 'aborted',
      errorMessage: decision.errorMessage
    });
  }
  return createAgentTerminalSnapshot({
    ...common,
    executionStatus: 'failed',
    terminationReason: decision.terminationReason,
    errorMessage: decision.errorMessage
  });
}

function modelOutputFromResponse(
  response: ModelResponse,
  turnIndex: number,
  continuingWithTools: boolean
): AgentModelOutput {
  if (continuingWithTools) return { status: 'absent' };
  const message = finalMessageFromResponse(response);
  if (!message) return { status: 'absent' };
  const source = response.content.trim().length > 0 ? ('content' as const) : ('reasoning_summary' as const);
  const status =
    response.terminationReason === 'stop'
      ? ('complete' as const)
      : response.terminationReason === 'output_limit' ||
          response.terminationReason === 'content_filter' ||
          response.terminationReason === 'tool_calls'
        ? ('partial' as const)
        : ('indeterminate' as const);
  return { status, message, source, turnIndex };
}
function completedDecision(
  modelOutput: AgentPresentModelOutput,
  turnCount: number,
  response: ModelResponse
): TerminalDecision {
  const terminationReason =
    response.terminationReason === 'stop'
      ? 'model_completed'
      : response.terminationReason === 'output_limit'
        ? 'model_output_limit'
        : response.terminationReason === 'content_filter'
          ? 'content_filtered'
          : 'unknown_model_termination';
  return {
    executionStatus: 'completed',
    terminationReason,
    modelOutput,
    turnCount,
    modelTerminationReason: response.terminationReason,
    ...(response.providerTerminationReason
      ? { providerTerminationReason: response.providerTerminationReason }
      : {})
  };
}
function failedDecision(
  reason: Extract<TerminalDecision, { executionStatus: 'failed' }>['terminationReason'],
  modelOutput: AgentModelOutput,
  errorMessage: string,
  turnCount: number,
  response: ModelResponse
): TerminalDecision {
  return {
    executionStatus: 'failed',
    terminationReason: reason,
    modelOutput: partialOrAbsent(modelOutput),
    errorMessage,
    turnCount,
    modelTerminationReason: response.terminationReason,
    ...(response.providerTerminationReason
      ? { providerTerminationReason: response.providerTerminationReason }
      : {})
  };
}
function partialOrAbsent(modelOutput: AgentModelOutput): AgentModelOutput {
  return modelOutput.status === 'absent' ? modelOutput : { ...modelOutput, status: 'partial' };
}
function decisionBeforeFinalization(decision: TerminalDecision, signal: AbortSignal): TerminalDecision {
  if (!signal.aborted || decision.executionStatus === 'aborted' || decision.cleanupDiagnostic)
    return decision;
  return {
    executionStatus: 'aborted',
    terminationReason: 'aborted',
    modelOutput: partialOrAbsent(decision.modelOutput),
    errorMessage: abortReason(signal.reason),
    turnCount: decision.turnCount
  };
}
function applicationInstructions(
  input: readonly AgentInstruction[] | undefined
): AgentEffectiveInstruction[] {
  return (input ?? []).map((item, index) => ({
    id: item.id.length > 0 ? item.id : `application-${String(index + 1)}`,
    content: item.content,
    provenance: 'application',
    ...(item.role ? { role: item.role } : {}),
    ...(item.sourceUri ? { sourceUri: item.sourceUri } : {}),
    ...(item.priority === undefined ? {} : { priority: item.priority })
  }));
}
function runInstructions(input: readonly string[] | undefined): AgentEffectiveInstruction[] {
  return (input ?? []).map((content, index) => ({
    id: `run-${String(index + 1)}`,
    content,
    provenance: 'run'
  }));
}
function steeringInstructions(input: readonly string[], offset: number): AgentEffectiveInstruction[] {
  return input.map((content, index) => ({
    id: `steering-${String(offset + index + 1)}`,
    content,
    provenance: 'steering'
  }));
}
function contextSourceIds(
  items: readonly PromptContextItemInput[] | undefined,
  provenance: 'configured' | 'provider' | 'run'
): string[] {
  return (items ?? []).map((item, index) =>
    isRecord(item) && typeof item.id === 'string' && item.id.length > 0
      ? item.id
      : `${provenance}-context-${String(index + 1)}-${hashJson(item).slice(0, 12)}`
  );
}
function turnIdentity(snapshot: AgentTurnSnapshotRecord): AgentTurnIdentity {
  return {
    turnIndex: snapshot.turnIndex,
    turnId: snapshot.turnId,
    requestAttempt: snapshot.requestAttempt
  };
}
function sameTurnIdentity(left: AgentTurnIdentity, right: AgentTurnIdentity): boolean {
  return (
    left.turnIndex === right.turnIndex &&
    left.turnId === right.turnId &&
    left.requestAttempt === right.requestAttempt
  );
}
function formatOverflowDiagnostic(diagnostic: OverflowDiagnostic): string {
  return [
    'Request assembly exceeded budget after overflow recovery.',
    `Reason: ${diagnostic.reason}.`,
    `Components: messages=${String(diagnostic.messageTokens)}, contextHistory=${String(diagnostic.modelWindowTokens)}, context=${String(diagnostic.contextTokens)}, toolSchemas=${String(diagnostic.toolSchemaTokens)}, outputReserve=${String(diagnostic.outputReserveTokens)}.`,
    `Total request tokens=${String(diagnostic.totalRequestTokens)}.`
  ].join(' ');
}
class RequestAssemblyError extends Error {}
function runInput(
  state: import('./run/control/contracts.js').AgentRunState,
  signal?: AbortSignal
): ResolvedAgentRunInput {
  return {
    task: state.input.task,
    runId: state.runId,
    finalizationId: state.finalizationId,
    instructions: state.input.instructions,
    contextItems: state.input.contextItems,
    ...(signal ? { signal } : {})
  };
}
function bindExternalAbort(
  external: AbortSignal | undefined,
  requestAbort: () => Promise<void>,
  controller: AbortController
): () => void {
  if (!external) return () => undefined;
  const abort = () => {
    void requestAbort().catch((error: unknown) => {
      controller.abort(error);
    });
  };
  external.addEventListener('abort', abort, { once: true });
  return () => {
    external.removeEventListener('abort', abort);
  };
}
function abortReason(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : typeof reason === 'string' && reason.length > 0
      ? reason
      : 'Agent run aborted.';
}
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'Agent run aborted.');
}
async function safePersist(
  append: (event: AgentAuditEvent) => Promise<unknown>,
  event: AgentAuditEvent
): Promise<void> {
  try {
    await append(event);
  } catch {
    /* Terminal finalization will report its own persistence state. */
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateToolBoundary(value: unknown): asserts value is ToolAuthorizationBoundary {
  if (!isRecord(value)) throw new Error('toolBoundary must be an object.');
  for (const [name, member] of Object.entries(value)) {
    if (typeof member !== 'string' || member.trim().length === 0)
      throw new Error(`toolBoundary.${name} must be a non-empty string.`);
  }
  if (typeof value.authorizationPolicyId !== 'string' || typeof value.executionTargetId !== 'string')
    throw new Error('toolBoundary requires authorizationPolicyId and executionTargetId.');
}
function removeRunItems(items: { readonly runId: string }[], runId: string): void {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (items[index]?.runId === runId) items.splice(index, 1);
}
function assertQueueCapacity(items: readonly unknown[], maximum: number, label: string): void {
  if (items.length >= maximum) throw new Error(`${label} queue limit of ${String(maximum)} was reached.`);
}
function runSuspension(state: AgentRunState): AgentRunResult {
  if (!state.budget) throw new Error(`Run ${state.runId} has no durable budget at suspension.`);
  const shared = { runId: state.runId, finalizationId: state.finalizationId, budget: state.budget };
  const approval = findPendingApproval(state);
  if (approval)
    return {
      state: 'suspended',
      reason: 'approval_required',
      ...shared,
      pendingApprovals: [approval.approval]
    };
  const provider = state.providerRequests.find((request) => request.stage === 'outcome_unknown');
  if (provider?.stage === 'outcome_unknown')
    return {
      state: 'suspended',
      reason: 'provider_outcome_unknown',
      ...shared,
      effectId: provider.effect.intent.effectId
    };
  const tool = state.toolBatches
    .flatMap((batch) => batch.callStates)
    .find((call) => call.stage === 'outcome_unknown');
  if (tool?.stage === 'outcome_unknown')
    return {
      state: 'suspended',
      reason: 'tool_outcome_unknown',
      ...shared,
      effectId: tool.effect.intent.effectId
    };
  const phase = state.phase;
  if (phase.kind !== 'suspended' || phase.reason === 'approval')
    throw new Error(`Run ${state.runId} has no recoverable suspension.`);
  return {
    state: 'suspended',
    reason: phase.reason,
    ...shared,
    ...(phase.effectId ? { effectId: phase.effectId } : {}),
    ...(phase.reason === 'user_decision' ? { decisionRequest: phase.decisionRequest } : {})
  };
}
function cancelledProviderStartDecisionRequest(
  state: import('./run/control/contracts.js').AgentRunState,
  effectId: string
): import('./run/control/contracts.js').AgentDecisionRequest {
  const runRevision = state.revision + 1;
  const id = `${state.runId}:decision:${effectId}`;
  const reason =
    'The provider effect was durably plan but cannot be started after restoration. Aborting is the only safe continuation.';
  const choices = Object.freeze(['abort']);
  const fingerprint = hashJson({ id, reason, choices, runRevision, effectId });
  return Object.freeze({ id, reason, choices, fingerprint, runRevision });
}
function toolRecoveryDecision(
  state: import('./run/control/contracts.js').AgentRunState
): Extract<ExecutionDecision, { readonly executionStatus: 'waiting_for_recovery' }> {
  const unknown = state.toolBatches
    .flatMap((batch) => batch.callStates)
    .find((call) => call.stage === 'outcome_unknown');
  if (unknown?.stage !== 'outcome_unknown')
    throw new Error(`Run ${state.runId} has no unknown tool outcome.`);
  return Object.freeze({
    executionStatus: 'waiting_for_recovery',
    reason: 'tool_outcome_unknown',
    effectId: unknown.effect.intent.effectId
  });
}
function closeOpenToolCalls(phase: AgentToolPhase): AgentToolPhase {
  return Object.freeze({
    ...phase,
    callStates: Object.freeze(
      phase.callStates.map((call): AgentToolCallState => {
        if (call.stage === 'ready') return Object.freeze({ stage: 'cancelled', toolAttempt: 1 });
        if (call.stage === 'effect_ready')
          return Object.freeze({
            stage: 'cancelled',
            plan: call.plan,
            toolAttempt: call.toolAttempt,
            effect: closeExternalEffect(call.effect, 'cancelled_before_start')
          });
        if (call.stage === 'effect_pending')
          return Object.freeze({
            stage: 'outcome_unknown',
            plan: call.plan,
            toolAttempt: call.toolAttempt,
            effect: closeExternalEffect(call.effect, 'unknown_outcome')
          });
        if (call.stage === 'outcome_unknown' && call.effect.phase === 'started')
          return Object.freeze({
            stage: 'outcome_unknown',
            plan: call.plan,
            toolAttempt: call.toolAttempt,
            effect: closeExternalEffect(call.effect, 'unknown_outcome')
          });
        return call;
      })
    )
  });
}
function missingImplementationSuspension(
  state: import('./run/control/contracts.js').AgentRunState
): AgentRunResult {
  if (!state.budget)
    throw new Error(`Run ${state.runId} has no durable budget at its tool implementation boundary.`);
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
function sameResourcePreconditions(
  left: readonly import('@agent-core/effects').EffectResourcePrecondition[],
  right: readonly import('@agent-core/effects').EffectResourcePrecondition[]
): boolean {
  return hashJson(left) === hashJson(right);
}
class AgentRunOwnershipLostError extends Error {
  constructor(runId: string) {
    super(
      `Run ${runId} continued under a replacement driver after this process settled its exact external effect.`
    );
    this.name = 'AgentRunOwnershipLostError';
  }
}
function completedRunControl(runId: string, result: AgentRunResult): AgentRunHandle {
  return Object.freeze({
    runId,
    injectSteering() {
      throw new Error(`Run ${runId} is not active.`);
    },
    abort: () => Promise.resolve(),
    result: Promise.resolve(result)
  });
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promptInstructionRole(role: string | undefined): PromptInstruction['role'] {
  if (role === undefined) return 'developer';
  if (role === 'system' || role === 'developer' || role === 'user') return role;
  throw new Error(`Unsupported declared instruction authority: ${role}.`);
}

function currentProviderRequest(state: AgentRunState): AgentProviderPhase | undefined {
  return state.providerRequests.find((request) => request.stage !== 'consumed');
}
function currentToolBatch(state: AgentRunState): AgentToolPhase | undefined {
  return state.toolBatches.find((batch) =>
    batch.callStates.some((call) => call.stage !== 'recorded' && call.stage !== 'cancelled')
  );
}
function findPendingApproval(
  state: AgentRunState,
  approvalId?: string
):
  | { readonly batch: AgentToolPhase; readonly callIndex: number; readonly approval: AgentApprovalRequest }
  | undefined {
  for (const batch of state.toolBatches)
    for (const [callIndex, call] of batch.callStates.entries())
      if (call.stage === 'approval' && (!approvalId || call.approval.approvalId === approvalId))
        return { batch, callIndex, approval: call.approval };
  return undefined;
}

function protocolTarget(profile: ModelProfile): {
  readonly protocol?: import('@agent-core/model').ModelProtocolCapabilities;
} {
  return profile.capabilities.protocol ? { protocol: profile.capabilities.protocol } : {};
}
