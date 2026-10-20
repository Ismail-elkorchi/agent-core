import { collectOptionalContext, contextRecallNotice, type AgentContextProvider, type AgentContextPolicy } from './context/recall.js';
import { parseSessionSubmissionOrigin } from './session/submission-origin.js';
import { parseNativeToolExposure, type NativeToolExposure } from './orchestration/native-tool-exposure.js';
import { toolInvocationCaller } from './run/control/tool-state.js';
import { settledProgramReceiptsThrough, programCompletionContext } from './orchestration/program-observations.js';
import { createToolCatalogTools, authorizeToolCatalogEffects, resolveRuntimeToolCatalog } from './run/tool-discovery.js';
import { SessionToolCatalogSelectionStore } from './session/tool-catalog.js';
import type { RuntimeProgramRunner } from './orchestration/program-contracts.js';
import { captureRequestCapabilities } from './inference/capability-capture.js';
import { captureContextCapabilities } from './context/service.js';
import { inspectSessionOperational, type ContextOperationalInspectionPage } from './session/operational.js';
import { commitResourceRelease } from './orchestration/resource-settlement.js';
import { resolveEffectiveToolCatalog, resolveToolHostEligibility, type EffectiveCapabilitySnapshot } from './run/capabilities.js';
import { NativeContextIncompatibilityError } from './orchestration/model-change.js';
import { parseContextControlPolicy, parseOutputReservationPolicy, resolveOutputReservation, contextControlRole, type ContextControlPolicy, type OutputReservationPolicy, assembleContextControlRequest, contextControlReserve, contextControlPreview, contextControlSteering } from './context/recovery.js';
import { resolveToolModelContent } from './orchestration/observation-source.js';
import { NativeContextTransitionRequired, type RequestPresentation } from './inference/input.js';
import type { SessionStateSnapshot } from './session/session-state.js';
import { providerSettlementKey } from './inference/run-lifecycle.js';
import { ContextSourceCapacityError, ContextContinuityError, type ContextAdmissionConflict } from './run/context-admission.js';
import { agentRunActivity } from './run/control/contracts.js';
import { decodeToolCall, describeError as errorMessage } from '@agent-core/tools';
import {
  closeExternalEffect,
  issueEffectStartTicket,
  knownEffectExposure,
  settleExternalEffect,
  unknownEffectExposure
} from '@agent-core/effects';
import {
  RequestTokenEstimator,
  modelOutputToInput,
  modelResponseOutput,
  ModelContractError,
  parseModelProfile,
  providerContextIncompatibility,
  type CompiledModelRequest,
  type ModelOutputItem,
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
import { hashJson, PersistenceDriverOwnershipLostError, type EventAppendReceipt } from '@agent-core/persistence';
import {
  READ_ONLY_TOOL_POLICY,
  POLICY_TOOL_AUTHORIZER,
  serializeToolModelContent,
  ResourceLeaseCoordinator,
  ToolRegistry,
  ToolCatalog,
  parseToolPolicy,
  planToolCall,
  recoverToolCallPlan,
  releaseToolCallPlan,
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
import { setTimeout as delay } from 'node:timers/promises';
import type { ContextTransitionRequest } from './context/contracts.js';
import { type ContextAdmissionInput, type ContextService } from './context/service.js';
import {
  encodeAgentEvent,
  type AgentAuditEvent,
  type AgentEvent,
  type AgentProgressEvent
} from './events.js';
import { HistoryReader, textRange } from './history/reader.js';
import {
  ModelRequestAssembler,
  type PromptInstruction
} from './inference/model-request-assembler.js';
import {
  RequestAdmission,
  ContextAdmissionError,
  requestCapacity
} from './inference/request-admission.js';
import {
  assertPortableHistoryCompatibility,
  rebuildModelWindowFromRepositories,
  replaySourceEntries,
  type CapturedHistorySourceAccess,
  recordContextExcerpts,
  type ModelWindowReplayResult
} from './orchestration/session-replay.js';
import { ModelWindow } from './inference/model-window.js';
import type { NativeGenerationContext } from './inference/native-inference.js';
import { NativeSteeringCoordinator } from './inference/native-steering.js';
import {
  decodePromptContextItemInput,
  type PromptContextItemInput,
  type PromptContextItem
} from './inference/prompt-material.js';
import {
  createRunInferenceLifecycle,
  invokeRunInference,
  providerUsageQuantities
} from './inference/run-lifecycle.js';
import { InferenceService, InferenceBudgetExceededError, InferenceNotSentError } from './inference/service.js';
import {
  summarizeModelRequest,
  summarizeModelResponse,
  summarizeProviderState,
  summarizeRunConfiguration
} from './orchestration/event-summaries.js';
import { AgentRunFinalizer, confirmCommittedSessionFinalization } from './orchestration/finalization.js';
import {
  finalMessageFromResponse,
  modelToolCallFromToolCall,
  normalizeModelToolCall,
  promptInstructionsForRequest,
  promptToolSpecs,
  providerFailureDiagnostic,
  requestWindowForModel,
  requestTokenEstimate,
  type RequestTokenEstimate,
  type RequestWindow,
  supportsParameter,
  toolsForModel,
  validateModelRun
} from './orchestration/model-request.js';
import { ModelStreamInterruptedError } from './orchestration/model-stream.js';
import { NativeToolDelivery } from './orchestration/native-tool-delivery.js';
import { ObservationStore, type CommittedToolObservation } from './orchestration/observation-store.js';
import { readProviderStateArtifact } from './orchestration/provider-state-artifacts.js';
import { AgentLimitExceededError, AgentRunBudget } from './run/budget.js';
import { ToolCallExecutor } from './orchestration/tool-execution.js';
import {
  ToolWorkPump,
  toolObservationsComplete,
  type ToolWorkStatus
} from './orchestration/tool-work.js';
import type { AgentRuntimeRepositories } from './ports.js';
import { RunContextTransitions } from './run/context-transitions.js';
import {
  createAgentTerminalSnapshot,
  assistantResponseKey,
  toolCallReceivedKey,
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
import { pendingToolCalls, assertToolTransitionBoundary } from './run/pending-calls.js';
import { assertToolCatalogCurrent, captureToolCatalog } from './run/tool-catalog.js';
import { parseSessionImages } from './session/images.js';
import type { ParticipantExecutionBinding } from './collaboration/contracts.js';
import { authorizeCollaborationToolEffects } from './collaboration/tools.js';

export type {} from './run/contracts.js';

export interface AgentInstruction {
  readonly id: string;
  readonly content: string;
  readonly role?: PromptInstruction['role'];
  readonly sourceUri?: string;
  readonly priority?: number;
}

export type { AgentContextRequest, AgentContextProvider, AgentContextResult, AgentContextPolicy, AgentContextBoundary } from './context/recall.js';

export interface AgentRuntimeOptions {
  readonly provider: ModelProvider;
  readonly inferenceService?: InferenceService;
  readonly model: string;
  readonly repositories: AgentRuntimeRepositories;
  readonly tools?: readonly CompiledToolDefinition[];
  readonly toolCatalog?: ToolCatalog;
  readonly programRunner?: RuntimeProgramRunner;
  readonly nativeToolExposure?: NativeToolExposure;
  readonly toolBoundary: ToolAuthorizationBoundary;
  readonly toolContext?: Omit<ToolExecutionContext, 'policy' | 'signal' | 'observationSignal'>;
  readonly toolResourceLeases?: ResourceLeaseCoordinator;
  readonly resources?: ExecutionResources;
  readonly inferenceOwnerId?: string;
  /** Continuing-owner accounting for a supervised root or ordinary scoped invocation. */
  readonly inferenceScope?: Readonly<{ participantId: string; budgetScopeId: string }>;
  /** Host-owned participant authority, checked at admission and effect start boundaries. */
  readonly participant?: ParticipantExecutionBinding;
  /** Shared-host ownership fence for the supervising session, without a child assignment. */
  readonly supervisor?: Readonly<{ groupId: string; withCurrent: <T>(operation: () => Promise<T>) => Promise<T> }>;
  readonly authorizePeerContribution?: (entry: import('./session/contracts.js').SessionPeerContributionEntry, stage: 'read' | 'admit') => Promise<void>;
  readonly modelBindingId?: string;
  readonly toolPolicy?: ToolPolicy;
  readonly toolAuthorizer?: ToolAuthorizer;
  readonly toolContextPrerequisite?: import('./orchestration/tool-execution.js').ToolContextPrerequisite;
  readonly instructions?:
    | readonly AgentInstruction[]
    | (() => readonly AgentInstruction[] | Promise<readonly AgentInstruction[]>);
  readonly contextItems?: readonly PromptContextItemInput[];
  readonly contextProvider?: AgentContextProvider;
  readonly contextProviderPolicy?: Partial<AgentContextPolicy>;
  readonly context?: ContextService;
  readonly contextControlPolicy?: Partial<ContextControlPolicy>;
  readonly outputReservationPolicy?: OutputReservationPolicy;
  readonly contextRenewal?: { readonly automatic: boolean };
  readonly onRequestAdmitted?: (input: {
    readonly requestId: string;
    readonly sourceIds: readonly string[];
  }) => void | Promise<void>;
  readonly estimator?: RequestEstimator;
  readonly maxOutputTokens: number;
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
  readonly origin?: import('./session/contracts.js').SessionSubmissionOrigin;
  readonly task: string;
  readonly images?: readonly import('./session/images.js').SessionImageInput[];
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
  readonly tools: readonly CompiledToolDefinition[];
  readonly configuration: RuntimeModelConfiguration;
  readonly instructions: readonly AgentEffectiveInstruction[];
}

class ContextPreparationChanged extends Error {}

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
  readonly replaceModelSession?: () => Promise<ModelProviderSession>;
  readonly signal: AbortSignal;
  readonly modelWindow: ModelWindow;
  readonly controller: AgentRunBudget;
  readonly run: AgentRunDriver;
}

type AssistantTurnResult =
  | {
      readonly kind: 'settled';
      readonly response: ModelResponse;
      readonly toolCalls: readonly ToolCall[];
      readonly modelOutput: AgentModelOutput;
      readonly turn: { readonly snapshot: TurnSnapshot; readonly toolBatchId: string };
      readonly native: boolean;
      readonly source: import('@agent-core/persistence').EventReference;
    }
  | { readonly kind: 'transition_context' }
  | { readonly kind: 'decision'; readonly decision: ExecutionDecision }
  | { readonly kind: 'outcome_unknown'; readonly effectId: string };
interface RequestAssemblyResult {
  readonly contextBoundaryRevision?: number;
  readonly capturedHistoryCut?: import('./history/contracts.js').HistorySourceCut;
  readonly sourceAccess?: CapturedHistorySourceAccess | undefined;
  readonly freshContext?: boolean;
  readonly recoveryAttempt?: number;
  readonly request: ModelRequest;
  readonly compiled: CompiledModelRequest;
  readonly estimate: RequestTokenEstimate;
  readonly fingerprint: InferenceRequestFingerprintRecord;
}

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
  readonly requestEstimate: RequestTokenEstimate;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly budget: import('./run/contracts.js').AgentRunBudgetState;
}
interface RunExecutionRuntime {
  readonly runId: string;
  readonly input: ResolvedAgentRunInput;
  readonly signal: AbortSignal;
  readonly controller: AgentRunBudget;
  readonly providerContinuation?: ProviderExecutionContinuation;
  readonly restoring?: boolean;
  readonly sessionInput?: import('./session/contracts.js').SessionInputEntry;
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
  private static readonly MAX_PROVIDER_RETRIES = 2;
  private readonly metadata: Readonly<Record<string, string>> | undefined;
  private readonly estimator: RequestEstimator;
  private readonly maxOutputTokens: number;
  private readonly contextControlPolicy: ContextControlPolicy;
  private readonly outputReservationPolicy: OutputReservationPolicy | undefined;
  private readonly toolPolicy: ToolPolicy;
  private tools: readonly CompiledToolDefinition[];
  private readonly toolCatalog: ToolCatalog;
  private readonly resourceLeases: ResourceLeaseCoordinator;
  private readonly requestAssembler: ModelRequestAssembler;
  private readonly history: HistoryReader | undefined;
  private readonly requestAdmission: RequestAdmission;
  private readonly unbindContext: (() => void) | undefined;
  private readonly inferenceService: InferenceService;
  private readonly catalogTools = new Map<string, readonly CompiledToolDefinition[]>();
  private contextTransitions: RunContextTransitions | undefined;
  private readonly recoveryActions = new Set<string>();
  private recoveryActionBoundary: string | undefined;
  private contextControlReserve: { readonly identity: string; readonly tokens: number } | undefined;
  private presentationSnapshot: TurnSnapshot | undefined;
  private lastAdmittedCapabilities: { readonly inputIdentity: string; readonly protocolCapabilityRevision: string;
    readonly snapshot: EffectiveCapabilitySnapshot } | undefined;
  private activeContextIdentity: string | null | undefined;
  private activeHistorySourceAccess: CapturedHistorySourceAccess | undefined;
  private pendingCompatibilityTransition = false;
  private nativeSteering: NativeSteeringCoordinator | undefined;
  private steeringWrites: Promise<void> = Promise.resolve();
  private readonly steeringReceipts = new Map<
    string,
    AgentSteeringReceipt & { readonly instruction: string }
  >();
  private readonly steerQueue: (AgentSteeringReceipt & {
    readonly instruction: string;
  })[] = [];
  private observationController = new AbortController();
  private activeAbortController: AbortController | undefined;
  private activeRunId: string | undefined;
  private activeRunDriver: AgentRunDriver | undefined;
  private activeRunReady: Promise<AgentRunDriver | undefined> | undefined;
  private activeAbortRequest: Promise<void> | undefined;
  private releasePromise: Promise<void> | undefined;
  private resolvingApproval = false;
  private closed = false;
  private static readonly MAX_STEERING_ITEMS = 1024;

  constructor(private readonly options: AgentRuntimeOptions) {
    const participant = options.participant;
    if (participant && options.supervisor) throw new TypeError('An execution has one collaboration authority owner.');
    if (options.supervisor) {
      const supervisor = options.supervisor;
      if (!supervisor.groupId.trim() || typeof supervisor.withCurrent !== 'function')
        throw new TypeError('A supervisor requires its exact group and host-owned execution fence.');
      options = { ...options, supervisor: Object.freeze({ groupId: supervisor.groupId, withCurrent: supervisor.withCurrent.bind(supervisor) }) };
    }
    if (participant) {
      if (!options.inferenceService || options.repositories.session?.descriptor.id !== participant.sessionId ||
          (options.inferenceOwnerId !== undefined && options.inferenceOwnerId !== participant.budgetOwnerId) ||
          (options.inferenceScope && (options.inferenceScope.participantId !== participant.participantId ||
            options.inferenceScope.budgetScopeId !== participant.budgetScopeId)))
        throw new TypeError('A participant requires its bound session and shared inference owner.');
      if (typeof participant.assertCurrent !== 'function' || typeof participant.withCurrent !== 'function')
        throw new TypeError('A participant requires host-owned execution boundary guards.');
      options = { ...options, participant: Object.freeze({ ...participant,
        capabilities: Object.freeze({ ...participant.capabilities,
          toolNames: Object.freeze([...participant.capabilities.toolNames]),
          ...(participant.capabilities.collaboration ? { collaboration: Object.freeze({
            actions: Object.freeze([...participant.capabilities.collaboration.actions]),
            participantIds: Object.freeze([...participant.capabilities.collaboration.participantIds]) }) } : {}) }),
        assertCurrent: participant.assertCurrent.bind(participant), withCurrent: participant.withCurrent.bind(participant) }),
        inferenceOwnerId: participant.budgetOwnerId,
        inferenceScope: Object.freeze({ participantId: participant.participantId, budgetScopeId: participant.budgetScopeId }) };
    } else if (options.inferenceScope) {
      if (!options.inferenceService || !options.inferenceOwnerId ||
          !options.inferenceScope.participantId.trim() || !options.inferenceScope.budgetScopeId.trim())
        throw new TypeError('Scoped inference requires an explicit shared service, owner and scope identity.');
      options = { ...options, inferenceScope: Object.freeze({ ...options.inferenceScope }) };
    }
    const runner = options.programRunner;
    const runnerRevision = runner?.configurationRevision;
    // Capture once before validation, then bind below without rereading a potentially mutable getter.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const runnerRun = runner?.run;
    if (runner && (typeof runnerRevision !== 'string' || !runnerRevision.trim() || runnerRevision.length > 512))
      throw new TypeError('Program runner requires an explicit bounded configurationRevision.');
    if (runner && typeof runnerRun !== 'function')
      throw new TypeError('Program runner requires a run function.');
    this.options = options = { ...options,
      ...(options.nativeToolExposure === undefined ? {} : { nativeToolExposure: parseNativeToolExposure(options.nativeToolExposure) }),
      ...(runner && runnerRevision && runnerRun ? { programRunner: Object.freeze({ toolName: runner.toolName, configurationRevision: runnerRevision,
        ...(runner.maxConcurrentPrograms === undefined ? {} : { maxConcurrentPrograms: runner.maxConcurrentPrograms }),
        run: runnerRun.bind(runner) }) } : {}) };

    this.metadata =
      options.metadata === undefined ? undefined : Object.freeze({ ...options.metadata });
    this.estimator = options.estimator ?? new RequestTokenEstimator();
    this.history =
      options.context?.history ??
      (options.repositories.session
        ? new HistoryReader({
            repository: options.repositories.session.repository,
            session: options.repositories.session.descriptor,
            events: options.repositories.events,
            ...(options.authorizePeerContribution ? { authorizePeerContribution: options.authorizePeerContribution } : {}),
            ...(options.repositories.artifacts ? { artifacts: options.repositories.artifacts } : {})
          })
        : undefined);
    this.requestAssembler = new ModelRequestAssembler(
      this.estimator,
      options.repositories.artifacts
    );
    this.inferenceService =
      options.inferenceService ?? InferenceService.inMemory({ provider: options.provider });
    this.requestAdmission = new RequestAdmission(this.requestAssembler, this.inferenceService);
    this.unbindContext = options.context?.bindRuntime({
      inspectOperational: (page) => this.inspectOperational(page),
      withStateOwnership: (operation) => this.withStateOwnership(operation),
      assertStateWrite: async (batch) => {
        const run = this.activeRunDriver;
        if (run?.state().control.status !== 'owned' || run.state().runId !== this.activeRunId)
          throw new Error('Session-state publication requires the current run owner.');
        const ownerId = this.options.inferenceOwnerId ?? run.state().runId;
        if (batch.inference.ownerId !== ownerId) throw new Error('Session-state inference belongs to another owner.');
        const origin = await this.inferenceService.sessionStateOrigin(ownerId, batch.inference.invocationId);
        if (hashJson(origin.inference) !== hashJson(batch.inference) ||
            hashJson(origin.capturedHistoryCut) !== hashJson(batch.capturedHistoryCut))
          throw new Error('Session-state publication does not match its admitted inference.');
        const tail = await this.options.repositories.events.tail(run.state().runId);
        if (tail.driverGeneration !== run.state().driverGeneration || run.state().control.status !== 'owned')
          throw new AgentRunOwnershipLostError(run.state().runId);
      },
      origin: async (invocation) => {
        const run = this.activeRunDriver;
        if (run?.state().runId !== invocation.runId)
          throw new Error('Working-state update belongs to another run.');
        const work = providerWork(run.state(), invocation);
        if (work.stage === 'ready')
          throw new Error('Working-state update has no admitted inference.');
        return this.inferenceService.sessionStateOrigin(
          this.options.inferenceOwnerId ?? invocation.runId,
          work.invocationId
        );
      },
      schedule: (request) => this.scheduleContextTransition(request),
    });
    if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)
      throw new TypeError('AgentRuntime requires an explicit positive maxOutputTokens allowance.');
    this.maxOutputTokens = options.maxOutputTokens;
    this.contextControlPolicy = parseContextControlPolicy(options.contextControlPolicy);
    this.outputReservationPolicy = options.outputReservationPolicy === undefined ? undefined : parseOutputReservationPolicy(options.outputReservationPolicy);
    if (this.outputReservationPolicy) {
      const { minimum, maximum } = this.outputReservationPolicy;
      if (!Number.isSafeInteger(minimum) || minimum < 1 || !Number.isSafeInteger(maximum) || maximum < minimum || maximum > this.maxOutputTokens)
        throw new TypeError('Output reservation policy must be positive, ordered and within the configured output allowance.');
    }
    if (options.programRunner?.maxConcurrentPrograms !== undefined && (!Number.isSafeInteger(options.programRunner.maxConcurrentPrograms) || options.programRunner.maxConcurrentPrograms < 1))
      throw new TypeError('Program runner maxConcurrentPrograms must be a positive safe integer.');
    this.toolPolicy = parseToolPolicy(options.toolPolicy ?? READ_ONLY_TOOL_POLICY);
    if (options.tools !== undefined && options.toolCatalog !== undefined)
      throw new TypeError('Supply tools or a toolCatalog, not two catalog owners.');
    this.toolCatalog = options.toolCatalog ?? new ToolCatalog({ tools: options.tools ?? [] });
    if (options.repositories.session) this.toolCatalog.bindSelectionStore(new SessionToolCatalogSelectionStore(
      options.repositories.session.repository, options.repositories.session.descriptor,
      operation => this.withStateOwnership(operation)));
    this.tools = Object.freeze(new ToolRegistry([...this.toolCatalog.current(),
      ...(this.toolCatalog.hasSelectionControls() ? createToolCatalogTools({ catalog: this.toolCatalog }) : [])]).list());
    this.assertParticipantTools(this.tools);
    this.resourceLeases =
      options.toolResourceLeases ??
      options.resources?.resourceLeases ??
      new ResourceLeaseCoordinator();
    validateToolBoundary(options.toolBoundary);
  }

  run(input: AgentRunInput): AgentRunHandle {
    this.assertOpen();
    const runId = input.runId ?? this.options.participant?.runId ?? randomUUID();
    if (this.options.participant && runId !== this.options.participant.runId)
      throw new TypeError('Participant run does not match its admitted assignment.');
    const finalizationId = input.finalizationId ?? randomUUID();
    return this.startRun({ ...input, ...(input.origin === undefined ? {} : { origin: parseSessionSubmissionOrigin(input.origin) }), runId, finalizationId });
  }

  /** Release an idle runtime, including one whose session dispatch was superseded. */
  close(): Promise<void> {
    if (this.activeAbortController || this.resolvingApproval)
      return Promise.reject(new Error('Cannot close an active AgentRuntime; settle its run first.'));
    this.closed = true;
    return this.releaseResources();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AgentRuntime has been closed.');
  }

  private async withStateOwnership<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.activeRunDriver;
    if (run?.state().control.status !== 'owned' || run.state().runId !== this.activeRunId)
      throw new Error('Session-state publication requires the current run owner.');
    const runId = run.state().runId;
    const generation = run.state().driverGeneration;
    try {
      return await this.withParticipantBoundary(() => this.options.repositories.events.withDriverGeneration(runId, generation, async () => {
        if (this.activeRunDriver !== run || run.state().control.status !== 'owned' ||
            run.state().driverGeneration !== generation || this.activeRunId !== runId)
          throw new AgentRunOwnershipLostError(runId);
        return operation();
      }));
    } catch (cause) {
      if (cause instanceof PersistenceDriverOwnershipLostError) throw new AgentRunOwnershipLostError(runId);
      throw cause;
    }
  }

  private withParticipantBoundary<T>(operation: () => Promise<T>): Promise<T> {
    const authority = this.options.participant ?? this.options.supervisor;
    return authority ? authority.withCurrent(operation) : operation();
  }

  private async assertHistorySourceAccess(access?: CapturedHistorySourceAccess): Promise<void> {
    if (this.history && access) await this.history.assertPeerContributions(access.peerContributions, 'admit');
  }

  /** These facts are observations; only the actual request/effect admission grants authority. */
  async inspectOperational(page: ContextOperationalInspectionPage = {}) {
    await this.refreshTools();
    const profile = parseModelProfile(await this.options.provider.describeModel(this.options.model));
    const ownerId = this.options.inferenceOwnerId ?? this.activeRunId;
    return inspectSessionOperational({ configured: this.capabilityCatalog(profile).snapshot, profile,
      outputReservation: await this.selectedOutputReservation(), configuredOutputReservation: this.maxOutputTokens,
      contextControlPolicy: this.contextControlPolicy,
      ...(this.outputReservationPolicy ? { outputReservationPolicy: this.outputReservationPolicy } : {}),
      inference: this.inferenceService,
      ...(ownerId ? { ownerId } : {}),
      ...(this.lastAdmittedCapabilities ? { contextAdmission: this.lastAdmittedCapabilities } : {}),
      resources: this.resourceLeases.inspect(), page });
  }

  inspectRun(runId: string) {
    return new AgentRunCoordinator(
      this.options.repositories.events,
      this.options.repositories.artifacts ?? this.inferenceService.options.artifacts
    ).inspect(runId);
  }

  resume(runId: string, signal?: AbortSignal): AgentRunHandle {
    this.assertOpen();
    if (this.options.participant && runId !== this.options.participant.runId)
      throw new TypeError('Participant resume does not match its admitted assignment.');
    if (this.activeAbortController) throw new Error('AgentRuntime already has an active run.');
    const runs = new AgentRunCoordinator(
      this.options.repositories.events,
      this.options.repositories.artifacts ?? this.inferenceService.options.artifacts
    );
    const abortController = new AbortController();
    const runReady = runs
      .inspect(runId)
      .then((inspection) => {
        this.assertRunImplementation(inspection.state);
        return inspection.state.phase.kind === 'terminal' ? undefined : runs.attach(runId);
      });
    this.activeAbortController = abortController;
    this.activeRunId = runId;
    this.activeRunReady = runReady;
    const result = this.resumeActive(runId, signal, abortController, runReady);
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
    this.assertOpen();
    if (this.resolvingApproval) throw new Error('AgentRuntime already has an active approval resolution.');
    this.resolvingApproval = true;
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
    } finally {
      this.resolvingApproval = false;
    }
  }

  private async resolveApprovalActive(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly fingerprint: string;
    readonly decision: 'allow' | 'deny';
    readonly signal?: AbortSignal;
  }): Promise<AgentRunHandle> {
    const runs = new AgentRunCoordinator(
      this.options.repositories.events,
      this.options.repositories.artifacts ?? this.inferenceService.options.artifacts
    );
    this.assertRunImplementation((await runs.inspect(input.runId)).state);
    const terminal = await this.options.repositories.events.latestOfType(input.runId, 'run.ended');
    if (terminal?.event.type === 'run.ended') {
      const confirmationDiagnostic = this.options.repositories.session
        ? await confirmCommittedSessionFinalization({
            events: this.options.repositories.events,
            session: this.options.repositories.session,
            terminal: terminal.event.terminal,
            source: terminal
          })
        : undefined;
      await this.releaseResources();
      return completedRunControl(
        input.runId,
        Object.freeze({
          state: 'ended',
          terminal: terminal.event.terminal,
          deliveryDiagnostics: Object.freeze(confirmationDiagnostic ? [confirmationDiagnostic] : [])
        })
      );
    }
    const run = await runs.attach(input.runId);
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
      throw new Error(
        `Approval boundary changed for ${input.approvalId}; a new approval is required.`
      );
    }
    const call = pendingApproval.batch.calls[pendingApproval.callIndex];
    if (!call) throw new Error(`Approval ${input.approvalId} has no durable tool call.`);
    const caller = toolInvocationCaller(pendingApproval.batch, pendingApproval.callIndex);
    const authorizationContext = Object.freeze({
      ...this.toolContext(input.signal ?? new AbortController().signal),
      recordedCanonicalInput: approval.input,
      invocation: Object.freeze({
        runId: input.runId,
        turnId: approval.turnId,
        requestAttempt: approval.requestAttempt,
        toolBatchId: approval.toolBatchId,
        callIndex: approval.callIndex,
        ...(approval.callId ? { callId: approval.callId } : {}),
        toolAttempt: 1,
        ...(caller ? { caller } : {})
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
          ? new Error(
              `Approval fingerprint changed for ${input.approvalId}; a new approval is required.`
            )
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
    const runs = new AgentRunCoordinator(
      this.options.repositories.events,
      this.options.repositories.artifacts ?? this.inferenceService.options.artifacts
    );
    const runReady = attachedRun
      ? Promise.resolve(attachedRun)
      : this.withParticipantBoundary(() => runs.accept(this.runAcceptance(input)).then(() => runs.attach(runId)));
    this.activeAbortController = abortController;
    this.activeRunId = runId;
    this.activeRunReady = runReady;
    let cleanupExternalAbort: () => void = () => undefined;
    try {
      const run = await runReady;
      this.activeRunDriver = run;
      this.assertRuntimeMatchesRun(run);
      if (input.signal?.aborted)
        await this.scheduleAbortRun(runId, abortReason(input.signal.reason));
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
      if (this.activeRunId === runId) {
        this.activeRunId = undefined;
        // A run may end after accepting steering without another model boundary.
        // Its observation yield belongs to that run, never to the next one.
        this.observationController = new AbortController();
      }
      if (this.activeRunReady === runReady) {
        this.activeRunDriver = undefined;
        this.activeRunReady = undefined;
      }
      await this.releaseResources();
    }
  }

  private async resumeActive(
    runId: string,
    signal: AbortSignal | undefined,
    abortController: AbortController,
    runReady: Promise<AgentRunDriver | undefined>
  ): Promise<AgentRunResult> {
    let cleanupExternalAbort: () => void = () => undefined;
    try {
      const run = await runReady;
      const terminal =
        run === undefined
          ? await this.options.repositories.events.latestOfType(runId, 'run.ended')
          : undefined;
      if (terminal?.event.type === 'run.ended') {
        const confirmationDiagnostic = this.options.repositories.session
          ? await confirmCommittedSessionFinalization({
              events: this.options.repositories.events,
              session: this.options.repositories.session,
              terminal: terminal.event.terminal,
              source: terminal
            })
          : undefined;
        return Object.freeze({
          state: 'ended',
          terminal: terminal.event.terminal,
          deliveryDiagnostics: Object.freeze(confirmationDiagnostic ? [confirmationDiagnostic] : [])
        });
      }
      if (!run) throw new Error(`Terminal run ${runId} has no committed result.`);
      this.activeRunDriver = run;
      if (this.hasToolImplementationMismatch(run))
        return missingImplementationSuspension(run.state());
      this.assertRuntimeMatchesRun(run);
      if (signal?.aborted) await this.scheduleAbortRun(runId, abortReason(signal.reason));
      else
        cleanupExternalAbort = bindExternalAbort(
          signal,
          () => this.scheduleAbortRun(runId, abortReason(signal?.reason)),
          abortController
        );
      const staged = await this.options.repositories.events.latestOfType(
        runId,
        'run.finalization.staged'
      );
      if (staged?.event.type === 'run.finalization.staged')
        return await this.resumeFinalization(run, staged.event);
      const runState = run.state();
      if (runState.control.status === 'abort_requested') {
        abortController.abort(runState.control.reason);
        return await this.runInternal(
          runInput(runState),
          abortController.signal,
          run,
          undefined,
          true
        );
      }
      if (findPendingApproval(runState)) return this.approvalSuspension(runState);
      if (runState.phase.kind === 'suspended' && runState.phase.reason === 'context_admission') {
        if (!(await this.admitContextResumption(run, abortController.signal)))
          return runSuspension(run.state());
        return await this.runInternal(
          runInput(run.state()),
          abortController.signal,
          run,
          undefined,
          true
        );
      }
      if (runState.phase.kind === 'suspended') return runSuspension(runState);
      const phase = currentProviderRequest(runState);
      if (phase?.stage === 'outcome_unknown') return runSuspension(run.state());
      if (phase?.stage === 'effect_ready') {
        await this.scheduleAbortRun(
          runId,
          'The run was interrupted before its provider request started.'
        );
        return await this.runInternal(
          runInput(run.state()),
          abortController.signal,
          run,
          undefined,
          true
        );
      }
      if (phase?.stage === 'effect_pending') {
        const settlement = await this.readProviderSettlement(
          runId,
          phase.effect.intent.effectId,
          phase.responseId
        );
        if (settlement) {
          const failed = settlement.event.type === 'provider.attempt.failed';
          const settled = settleExternalEffect(phase.effect, phase.effect.settlementPermit, {
            outcome: failed ? 'failed' : 'succeeded',
            resultDigest: hashJson(settlement.event),
            exposure:
              settlement.event.type === 'provider.attempt.settled' &&
              settlement.event.response.usage
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
              stage: failed ? 'failed' : 'settled',
              effect: settled.state,
              settlementReference: settlement.reference
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
            batch.callStates.some(
              (call) =>
                call.stage !== 'recorded' && call.stage !== 'resolved' && call.stage !== 'cancelled'
            )
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
        ...(run.state().input.origin === undefined ? {} : { origin: run.state().input.origin }),
        ...(run.state().input.images === undefined ? {} : { images: run.state().input.images }),
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
      if (this.activeRunId === runId) {
        this.activeRunId = undefined;
        // A run may end after accepting steering without another model boundary.
        // Its observation yield belongs to that run, never to the next one.
        this.observationController = new AbortController();
      }
      if (this.activeRunReady === runReady) {
        this.activeRunDriver = undefined;
        this.activeRunReady = undefined;
      }
      await this.releaseResources();
    }
  }

  private releaseResources(): Promise<void> {
    this.releasePromise ??= Promise.resolve().then(async () => {
      this.unbindContext?.();
      await this.options.release?.();
    });
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
    const controller = new AgentRunBudget({
      run,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.limits ? { limits: this.options.limits } : {})
    });
    const deliveryDiagnostics: {
      eventType: string;
      message: string;
      persisted: boolean;
    }[] = [];
    const append = async (event: AgentAuditEvent, idempotencyKey?: string) => {
      const receipt = await run.append(
        event,
        idempotencyKey ?? `${runId}:event:${hashJson(encodeAgentEvent(event))}`
      );
      if (event.type === 'assistant.interrupted')
        await this.recordSessionAssistant(runId, event, receipt);
      return receipt;
    };
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
      const sessionInput = await this.recordSessionInput(
        input,
        restoring || providerContinuation !== undefined
      );
      throwIfAborted(signal);
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
        ...(restoring ? { restoring: true } : {}),
        ...(sessionInput ? { sessionInput } : {})
      });
    } catch (error) {
      if (error instanceof AgentRunOwnershipLostError) throw error;
      const admissionError = error instanceof AgentExecutionError ? error.cause : error;
      if (
        (admissionError instanceof ContextAdmissionError ||
          admissionError instanceof ContextSourceCapacityError ||
          admissionError instanceof ContextContinuityError || admissionError instanceof ContextRecoveryStoppedError) &&
        !signal.aborted
      ) {
        const instruction = nextAgentRunInstruction(run.state());
        if (instruction.kind !== 'execute') throw admissionError;
        const conflict =
          (admissionError instanceof ContextSourceCapacityError || admissionError instanceof ContextContinuityError || admissionError instanceof ContextRecoveryStoppedError)
            ? admissionError.conflict
            : requestCapacityConflict(admissionError, this.outputReservationPolicy);
        await this.advanceRun(run, instruction.procedure, {
          phase: {
            kind: 'suspended',
            reason: 'context_admission',
            conflict,
            turnIndex: currentProviderRequest(run.state())?.identity.turnIndex ?? 1
          },
          budget: controller.snapshot()
        });
        return {
          state: 'suspended',
          reason: 'context_admission',
          runId,
          finalizationId,
          contextAdmission: conflict,
          budget: controller.snapshot()
        };
      }
      decision = await this.decisionFromError({
        error,
        signal,
        runId,
        run,
        controller,
        append,
        emit
      });
    }
    if (decision.executionStatus === 'waiting_for_approval') {
      const cleanupError = await this.releaseOwnedResources(runId, append);
      if (!cleanupError) {
        const budget = controller.snapshot();
        await append({
          type: 'run.phase.changed',
          runId,
          phase: agentRunActivity(run.state()),
          budget
        });
        await emit({
          type: 'run.phase.changed',
          phase: agentRunActivity(run.state()),
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
      await this.steeringWrites;
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
    await this.waitForAbortRequest(runId);
    decision = decisionBeforeFinalization(decision, signal);
    if (
      decision.executionStatus !== 'aborted' &&
      run.state().providerRequests.some((request) => request.stage === 'effect_pending')
    )
      throw new Error(
        'An unresolved started provider effect must be reconciled before terminal staging.'
      );
    await this.contextTransitions?.closePending(
      this.options.context,
      'Run ended before the requested context selection reached an admissible boundary; inspect and retry while idle.',
      async (requestId, message, idempotencyKey) => {
        await emit({ type: 'context.transition.rejected', requestId, idempotencyKey, message });
      }
    );
    const terminal = terminalSnapshot(runId, finalizationId, decision, controller);
    await finalizer.stage(terminal, 'diagnostic' in decision ? decision.diagnostic : undefined);
    await this.enterRunFinalization(run, controller.snapshot());
    await this.reportActivity(runId, controller, append, emit);
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
      (terminalInstruction.procedure !== 'finalize' &&
        terminalInstruction.procedure !== 'finalize_abort')
    ) {
      throw new Error(
        `Run ${runId} cannot publish its durable terminal run from the current phase.`
      );
    }
    await this.advanceRun(run, terminalInstruction.procedure, {
      phase: { kind: 'terminal', resultEventId: terminalRecord.eventId },
      budget: controller.snapshot()
    });
    return result;
  }

  private async resumeFinalization(
    run: AgentRunDriver,
    staged: Extract<AgentEvent, { readonly type: 'run.finalization.staged' }>
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
    await this.contextTransitions.closePending(
      this.options.context,
      'Run ended before the requested context selection reached an admissible boundary; inspect and retry while idle.',
      async (requestId, message, idempotencyKey) => {
        await this.emitProgress(staged.terminal.finalizationId,
          { type: 'context.transition.rejected', requestId, idempotencyKey, message },
          deliveryDiagnostics, append);
      }
    );
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

  /** Record accepted input before cancellation or execution can produce a terminal outcome. */
  private async recordSessionInput(input: ResolvedAgentRunInput, restoring: boolean) {
    const session = this.options.repositories.session;
    if (!session) return undefined;
    const { repository, descriptor } = session;
    const original = restoring
      ? (await repository.loadReplayState(descriptor)).branch.find(
          (entry) => entry.type === 'input' && entry.runId === input.runId
        )
      : undefined;
    return repository.appendInput(descriptor, {
      runId: input.runId,
      task: input.task,
      ...(input.origin === undefined ? {} : { origin: parseSessionSubmissionOrigin(input.origin) }),
      ...(input.images === undefined ? {} : { images: input.images }),
      instructions:
        original?.type === 'input'
          ? original.instructions
          : [
              ...(await this.currentApplicationInstructions()),
              ...runInstructions(input.instructions)
            ]
    });
  }

  /** Accepted calls are durable history even when prerequisites prevent execution. */
  private async recordAcceptedToolCalls(
    runtime: RunExecutionRuntime,
    identity: AgentTurnIdentity,
    toolBatchId: string,
    calls: readonly ToolCall[],
    modelWindow: ModelWindow
  ): Promise<void> {
    for (const [callIndex, call] of calls.entries()) {
      const received = {
        type: 'tool.call.received' as const,
        ...identity,
        toolBatchId,
        callIndex,
        ...(call.id ? { callId: call.id } : {}),
        toolCall: call
      };
      const receipt = await runtime.append(received, toolCallReceivedKey(runtime.runId, received));
      await runtime.emit(received);
      if (this.options.repositories.session) {
        await this.options.repositories.session.repository.appendToolCall(
          this.options.repositories.session.descriptor,
          {
            runId: runtime.runId,
            identity: {
              ...identity,
              toolBatchId,
              callIndex,
              ...(call.id ? { callId: call.id } : {})
            },
            call
          }
        );
      }
      modelWindow.recordAppliedSource({ runId: runtime.runId, eventId: receipt.eventId,
        sequence: receipt.sequence, hash: receipt.hash });
    }
  }

  private async executeRun(runtime: RunExecutionRuntime): Promise<ExecutionDecision> {
    const providerPhase = currentProviderRequest(runtime.run.state());
    const failedAttempt =
      providerPhase?.stage === 'failed'
        ? providerPhase
        : providerPhase?.stage === 'ready'
          ? runtime.run
              .state()
              .providerRequests.find(
                (request): request is Extract<AgentProviderPhase, { readonly stage: 'consumed' }> =>
                  request.stage === 'consumed' &&
                  request.effect.settlement.outcome === 'failed' &&
                  request.identity.turnId === providerPhase.identity.turnId &&
                  request.identity.requestAttempt + 1 === providerPhase.identity.requestAttempt
              )
          : undefined;
    if (failedAttempt) {
      const settlement = await this.readProviderSettlement(
        runtime.runId,
        failedAttempt.effect.intent.effectId,
        failedAttempt.responseId,
        failedAttempt.settlementReference
      );
      if (settlement?.event.type !== 'provider.attempt.failed')
        throw new Error('Failed provider attempt has no matching failure record.');
      return failedGenerationDecision(
        settlement.event.diagnostic,
        failedAttempt.identity.turnIndex
      );
    }
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
    const initialPhase = runtime.run.state().phase;
    const initialToolPhase = currentToolBatch(runtime.run.state());
    const durableInstructions = initialToolPhase?.instructions;
    const originalInstructions = runtime.sessionInput?.instructions;
    const effectiveInstructions = durableInstructions
      ? [...durableInstructions]
      : runtime.providerContinuation
        ? [...runtime.providerContinuation.instructions]
        : originalInstructions
          ? [...originalInstructions]
          : [
              ...(await this.currentApplicationInstructions()),
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
      await runtime.append({
        type: 'input.received',
        task: runtime.input.task,
        ...(runtime.input.origin === undefined ? {} : { origin: runtime.input.origin }),
        ...(runtime.input.images === undefined ? {} : { images: runtime.input.images })
      });
    const sessionEntryId = runtime.sessionInput?.id;
    const rebuild = async () =>
      rebuildModelWindowFromRepositories({
        readInferenceInput: (runId, invocationId) =>
          this.inferenceService.admittedInput(this.options.inferenceOwnerId ?? runId, invocationId),
        ...(this.history ? { history: this.history } : {}),
        events: this.options.repositories.events,
        ...(this.options.repositories.artifacts
          ? { artifacts: this.options.repositories.artifacts }
          : {}),
        estimator: this.estimator,
        modelWindowImageLimits: {
          maxCount: runtime.controller.limits.activeImageCount,
          maxBytes: runtime.controller.limits.activeImageBytes,
          maxEstimatedTokens: runtime.controller.limits.activeImageTokens
        },
        profile: await this.options.provider.describeModel(this.options.model),
        currentRunId: runtime.runId,
        ...(runtime.restoring || runtime.providerContinuation ? { runIds: [runtime.runId] } : {})
      });
    let replay: ModelWindowReplayResult;
    try {
      await this.options.context?.assertSourceCapacity();
      replay = await rebuild();
    } catch (error) {
      if (error instanceof NativeContextIncompatibilityError) {
        await this.scheduleModelCompatibilityTransition(runtime.runId);
      } else if (!(error instanceof ContextSourceCapacityError) || !this.options.contextRenewal?.automatic)
        throw error;
      // This empty staging window is never dispatched as application context.
      // assembleModelRequest still verifies the selected originals and the bounded
      // recovery path below is the only request admitted while they overflow.
      replay = {
        modelWindow: new ModelWindow(this.estimator), invalidatedProviderStates: [],
        replayedLedgers: 0, replayedTurns: 0, replayedSessionEntries: 0, replayedToolResults: 0
      };
    }
    const modelWindow = replay.modelWindow;
    this.activeHistorySourceAccess = replay.historySourceAccess;
    const observationStore = new ObservationStore({
      ...(this.options.context && this.options.contextRenewal?.automatic
        ? { maxPresentationBytes: this.contextControlPolicy.resultBytes } : {}),
      ...(this.options.repositories.artifacts
        ? { artifacts: this.options.repositories.artifacts }
        : {})
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
        ...(replay.providerStateSummary
          ? { restoredProviderState: replay.providerStateSummary }
          : {}),
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
        const resumeDecision = await this.resumeDurableToolBatch(
          runtime,
          modelWindow,
          observationStore
        );
        if (resumeDecision) return resumeDecision;
        turnIndex += 1;
      }
      let providerResume = runtime.providerContinuation;
      for (;;) {
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
          snapshot = await this.restoreTurnSnapshot(providerResume.turnSnapshot, providerResume.requestEstimate.outputReserveTokens);
          toolBatchId = providerResume.toolBatchId;
          activeTurnIdentity = providerResume.identity;
          lastStartedTurnIndex = turnIndex;
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
            signal: runtime.signal,
            request: {
              runId: runtime.runId,
              turnIndex,
              snapshot,
              toolBatchId,
              controller: runtime.controller,
              run: runtime.run
            },
            requestEstimate: providerResume.requestEstimate,
            response: providerResume.response,
            identity: providerResume.identity,
            append: runtime.append,
            emit: snapshotRecoveryEmitter(snapshot, runtime.emit)
          });
          providerResume = undefined;
          if (snapshot.record.contextRecovery) {
            await modelSession.close?.();
            modelSession = undefined;
            sessionModel = undefined;
            replayRestored = false;
          }
        } else {
          runtime.controller.reserveModelTurn();
          const configuration = this.captureRuntimeConfiguration();
          const profile = parseModelProfile(
            await this.options.provider.describeModel(configuration.model)
          );
          const providerInfo = this.options.provider.describe();
          await this.refreshTools(runtime.signal);
          const tools = Object.freeze(this.availableTools(profile));
          validateModelRun(
            providerInfo.id,
            profile,
            [...tools],
            configuration.temperature,
            configuration.reasoning
          );
          const requestWindow = requestWindowForModel(profile, await this.selectedOutputReservation());
          const continuationEligible =
            modelSession !== undefined && sessionModel === configuration.model;
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
          effectiveInstructions.splice(
            0,
            effectiveInstructions.length,
            ...(await this.currentApplicationInstructions()),
            ...effectiveInstructions.filter((item) => item.provenance !== 'application')
          );
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
            ...(runtime.input.origin === undefined ? {} : { origin: runtime.input.origin }),
            ...activeTurnIdentity,
            ...(this.options.repositories.session
              ? { sessionId: this.options.repositories.session.descriptor.id }
              : {}),
            ...(sessionEntryId ? { sessionEntryId } : {})
          };
          await runtime.append(turnStarted);
          await runtime.emit(turnStarted);
          if (turnIndex === 1) {
            const configuredEvent = {
              type: 'run.configured' as const,
              configuration: summarizeRunConfiguration({
                provider: providerInfo,
                model: profile,
                tools: [...tools],
                toolPolicy: this.toolPolicy,
                requestWindow,
                requestedMaxOutputTokens: this.maxOutputTokens,
                ...(configuration.temperature === undefined
                  ? {}
                  : { temperature: configuration.temperature }),
                ...(configuration.reasoning === undefined
                  ? {}
                  : { reasoning: configuration.reasoning }),
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
              {
                kind: 'provider',
                stage: 'ready',
                identity: turnIdentity(snapshot.record),
                toolBatchId
              }
            ],
            budget: runtime.controller.reserveModelTurn()
          }));
          await this.reportActivity(
            runtime.runId,
            runtime.controller,
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
              replaceModelSession: async () => {
                await modelSession?.close?.();
                modelSession = this.inferenceService.createSession();
                replayRestored = true;
                this.nativeSteering?.bind(modelSession, profile.capabilities.protocol?.steering === 'native');
                return modelSession;
              },
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
        if (assistant.kind === 'decision') return assistant.decision;
        if (assistant.kind === 'transition_context') {
          // The shared successor planner decides whether the settled native session is renewed.
          turnIndex++;
          continue;
        }
        if (assistant.kind === 'settled') {
          const admitted = assistant.turn;
          snapshot = admitted.snapshot;
          for (const instruction of snapshot.instructions) if (instruction.provenance === 'steering' && !effectiveInstructions.some(value => value.id === instruction.id)) effectiveInstructions.push(instruction);
          toolBatchId = admitted.toolBatchId;
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
        if (!snapshot.record.contextRecovery) activeModelOutput = assistant.modelOutput;
        const { response, toolCalls } = assistant;
        if (snapshot.record.contextRecovery) {
          const repeated = toolCalls.some((call) => this.recoveryActions.has(`${runtime.runId}:${snapshot.record.contextRecovery?.recoveryBoundary ?? "unbound"}:${hashJson({name: call.name, input: call.input})}`));
          const unsupported = response.terminationReason !== 'tool_calls' || toolCalls.length === 0 || toolCalls.length > this.contextControlPolicy.toolCalls ||
            toolCalls.some((call) => !snapshot.tools.some((tool) => tool.name === call.name && isContextCheckpointTool(tool))) ||
            toolCalls.some((call) => !isContextMutationTool(snapshot.tools.find((tool) => tool.name === call.name)) &&
              (call.input.kind !== 'json' || typeof call.input.value.maxBytes !== 'number' ||
               !Number.isSafeInteger(call.input.value.maxBytes) || call.input.value.maxBytes < 1 ||
               call.input.value.maxBytes > this.contextControlPolicy.resultBytes));
          if (repeated || unsupported) {
            const settled = providerWork(runtime.run.state(), snapshot.record);
            if (settled.stage !== 'settled') throw new Error('Recovery response has no durable settlement.');
            await runtime.run.transitionProvider('consume_provider_settlement', settled.identity,
              () => ({ ...settled, stage: 'consumed' }), runtime.controller.snapshot());
            throw new ContextRecoveryStoppedError(snapshot.record.contextRecovery,
              repeated ? 'Context recovery repeated an unchanged action; no source selection was committed.'
                : 'Context recovery returned an unsupported action or final answer; application work remains suspended.',
              repeated ? 'unchanged_action' : 'unsupported_action');
          }
        }

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
          if (!assistant.native)
            modelWindow.recordModelOutput({
              source: assistant.source,
              turnIndex,
              content: response.content,
              toolCalls: [],
              ...(response.output ? { output: response.output } : {})
            });
          if (response.terminationReason === 'continuation') {
            const providerSettlement = providerWork(runtime.run.state(), assistant.turn.snapshot.record);
            if (providerSettlement.stage !== 'settled')
              throw new Error('Program continuation requires a settled provider response.');
            await runtime.run.transitionProvider('consume_provider_settlement', providerSettlement.identity,
              () => ({ ...providerSettlement, stage: 'consumed' }), runtime.controller.snapshot());
            await this.advanceRun(runtime.run, 'continue_provider_program', {
              phase: { kind: 'initializing', step: 'assemble_turn', turnIndex: turnIndex + 1 },
              budget: runtime.controller.snapshot()
            });
            turnIndex += 1;
            continue;
          }
          if (activeModelOutput.status === 'absent') {
            const emptyMessage = [
              `Model returned no native tool calls and no visible modelOutput at turnIndex ${String(turnIndex)}.`,
              response.reasoning ? 'Raw private reasoning is not a modelOutput.' : ''
            ]
              .filter(Boolean)
              .join(' ');
            return failedDecision(
              'empty_response',
              activeModelOutput,
              emptyMessage,
              turnIndex,
              response
            );
          }
          const providerSettlement = providerWork(runtime.run.state(), snapshot.record);
          if (providerSettlement.stage !== 'settled')
            throw new Error('Completion requires a settled provider response.');
          return completedDecision(activeModelOutput, turnIndex, response);
        }

        this.assertProgrammaticCallsAdvertised(response, snapshot);
        runtime.controller.reserveToolCalls(toolCalls);
        if (!snapshot.record.contextRecovery) modelWindow.recordModelOutput({
          source: assistant.source,
          turnIndex,
          content: response.content,
          toolCalls: response.toolCalls ?? toolCalls.map(modelToolCallFromToolCall),
          ...(response.output ? { output: response.output } : {})
        });
        await this.recordAcceptedToolCalls(runtime, activeTurnIdentity, toolBatchId, toolCalls, modelWindow);
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
            responseId:
              response.requestId ?? response.transport?.responseId ?? sourceRequest.responseId,
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
          budget: runtime.controller.reserveToolCalls(group.calls)
        }));
        await this.reportActivity(runtime.runId, runtime.controller, runtime.append, runtime.emit);
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
        if (toolResult.outcome === 'ownership_lost')
          throw new AgentRunOwnershipLostError(runtime.runId);
        if (toolResult.outcome === 'waiting_for_recovery')
          return toolRecoveryDecision(runtime.run.state());
        if (snapshot.record.contextRecovery) this.activeContextIdentity = undefined;
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
    } catch (error) {
      if (error instanceof AgentRunOwnershipLostError || error instanceof AgentExecutionError)
        throw error;
      throw new AgentExecutionError(error, {
        lastStartedTurnIndex,
        activeModelOutput,
        ...(activeTurnIdentity ? { activeTurnIdentity } : {})
      });
    } finally {
      await modelSession?.close?.();
    }
  }

  private programTool(): CompiledToolDefinition | undefined {
    return this.options.programRunner ? this.tools.find(tool => tool.name === this.options.programRunner?.toolName) : undefined;
  }

  private assertProgrammaticCallsAdvertised(response: ModelResponse, snapshot: { readonly tools: readonly CompiledToolDefinition[]; readonly profile: ModelProfile }): void {
    for (const call of response.toolCalls ?? []) {
      if (!call.caller) continue;
      if (!this.options.nativeToolExposure?.programmatic || !snapshot.profile.capabilities.protocol?.programmaticTools ||
          !snapshot.tools.some(tool => tool.name === call.name && tool.invocationModes.includes('programmatic')))
        throw new Error('Provider program call was not authorized by its admitted tool catalog.');
    }
  }

  private createToolExecutor(
    runtime: RunExecutionRuntime,
    modelWindow: ModelWindow,
    observationStore: ObservationStore,
    signal: AbortSignal
  ): ToolCallExecutor {
    return new ToolCallExecutor({
      events: this.options.repositories.events,
      runId: runtime.runId,
      driverGeneration: runtime.run.state().driverGeneration,
      resolveTools: (catalog) => this.catalogTools.get(catalog.revision) ?? this.tools,
      currentTools: async phase => {
        await this.options.participant?.assertCurrent();
        await this.refreshTools(signal);
        return resolveToolHostEligibility({ tools: this.tools, policy: this.toolPolicy, host: this.toolHostRequirements(phase.modelInputModalities) });
      },
      toolContext: this.toolContext(signal),
      nativeProgrammaticTools: this.options.nativeToolExposure?.programmatic === true,
      ...(this.options.programRunner ? { programRunner: this.options.programRunner } : {}),
      ...(this.options.repositories.artifacts ? { artifactRepository: this.options.repositories.artifacts } : {}),
      admitProgramCall: async (batch, tools) => {
        this.catalogTools.set(batch.source.catalog.revision, tools);
        await this.advanceRun(runtime.run, 'admit_program_call', state => {
          signal.throwIfAborted();
          this.observationController.signal.throwIfAborted();
          if (state.phase.kind !== 'active' || state.control.status !== 'owned')
            throw new Error('Program child admission is quiesced.');
          return { phase: state.phase, toolBatches: [...state.toolBatches, batch],
            budget: runtime.controller.reserveToolCalls(batch.calls) };
        });
      },
      yieldProgramCall: async target => {
        await runtime.run.transitionTool('reconcile_tool_call', target, call => call.stage === 'effect_pending'
          ? { ...call, stage: 'outcome_unknown' } : call, runtime.controller.snapshot());
      },
      interruptProgramCall: async target => {
        await runtime.run.transitionTool('interrupt_program_call', target, call => {
          if (call.stage === 'ready') return { stage: 'cancelled', toolAttempt: 1 };
          if (call.stage === 'effect_ready') return { stage: 'cancelled', toolAttempt: call.toolAttempt,
            plan: call.plan, effect: closeExternalEffect(call.effect, 'cancelled_before_start') };
          throw new Error('Only unstarted program children can be cancelled.');
        }, runtime.controller.snapshot());
      },
      resourceLeases: this.resourceLeases,
      ...(this.options.participant || this.options.supervisor ? { withStartBoundary: <T>(operation: () => Promise<T>) => this.withParticipantBoundary(operation) } : {}),
      authorizer: this.authorizeTool,
      ...(this.options.toolContextPrerequisite
        ? { contextPrerequisite: this.options.toolContextPrerequisite }
        : {}),
      modelWindow,
      observationStore,
      ...(this.options.context && this.options.contextRenewal?.automatic ? {
        stagePresentations: (phase: AgentToolPhase) => !phase.source.program && !phase.source.nativeCatalogIdentity &&
          (this.catalogTools.get(phase.source.catalog.revision) ?? this.tools).some(tool => isContextActivationTool(tool)) &&
          providerWork(runtime.run.state(), phase.identity).stage === 'consumed',
        selectPresentations: (phase: AgentToolPhase, observations: readonly {
          readonly callIndex: number; readonly committed: CommittedToolObservation; readonly published: boolean;
        }[]) => this.selectToolPresentations(runtime, phase, observations, observationStore)
      } : {}),
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}),
      state: () => runtime.run.state(),
      transitionTool: async (procedure, target, update) => {
        await runtime.run.transitionTool(procedure, target, update, runtime.controller.snapshot());
      },
      settle: (settlement) => this.settleToolEffect(runtime.run, settlement),
      append: runtime.append,
      emit: runtime.emit
    });
  }

  private async recordedTurnSnapshot(runId: string, identity: Pick<AgentTurnIdentity, 'turnId' | 'requestAttempt'>): Promise<AgentTurnSnapshotRecord> {
    const records = await this.options.repositories.events.readMetadataRange(runId, {
      types: ['turn.snapshot.created'], metadata: { exchangeId: `assistant:${identity.turnId}:${String(identity.requestAttempt)}:ended` },
      limit: 1, maxBytes: 1024 * 1024
    });
    const reference = records.records[0]?.reference;
    const event = reference ? (await this.options.repositories.events.readReference(reference)).event : undefined;
    if (event?.type !== 'turn.snapshot.created' || event.snapshot.turnId !== identity.turnId ||
        event.snapshot.requestAttempt !== identity.requestAttempt)
      throw new Error('Tool operation is missing its exact admitted turn snapshot.');
    return event.snapshot;
  }

  /** Admit a complete settled ordinary batch before publishing its selected presentations. */
  private async selectToolPresentations(
    runtime: RunExecutionRuntime,
    phase: AgentToolPhase,
    observations: readonly { readonly callIndex: number; readonly committed: CommittedToolObservation; readonly published: boolean }[],
    store: ObservationStore
  ): Promise<readonly CommittedToolObservation[]> {
    const source = providerWork(runtime.run.state(), phase.identity);
    if (source.stage !== 'consumed') return observations.map(item => item.committed);
    const admitted = await this.inferenceService.admittedInput(this.options.inferenceOwnerId ?? runtime.runId, source.invocationId);
    let snapshot = this.presentationSnapshot;
    if (!snapshot || !sameTurnIdentity(snapshot.record, phase.identity)) {
      snapshot = await this.restoreTurnSnapshot(await this.recordedTurnSnapshot(runtime.runId, phase.identity), admitted.outputReservation);
    }
    if (snapshot.record.contextRecovery) return observations.map(item => item.committed);
    if (observations.length !== phase.calls.length)
      throw new ContextContinuityError('unsupported', 'A settled tool batch lacks a complete recorded result for every original call; its protocol cannot be reconstructed for context recovery.');
    const settled = await this.readProviderSettlement(runtime.runId, source.effect.intent.effectId, source.responseId, source.settlementReference);
    if (settled?.event.type !== 'provider.attempt.settled') throw new Error('Tool batch source response is unavailable.');
    const original = observations.map(item => item.committed);
    let selected: readonly CommittedToolObservation[] = original;
    let failure: ContextAdmissionError | undefined;
    for (const maxBytes of [undefined, 4096, 2048, 1024, 0]) {
      if (maxBytes !== undefined)
        selected = await Promise.all(original.map(async (item, index) => observations[index]?.published
          ? item : store.resizeToolObservation(item, maxBytes)));
      const results = await Promise.all(selected.map(item => store.projectToolObservation(item)));
      const logical: ModelRequest = { ...admitted.request, messages: [
        ...admitted.request.messages,
        ...modelOutputToInput(modelResponseOutput(settled.event.response)),
        ...results.map(item => ({ role: 'tool' as const, content: item.modelText, toolName: item.toolName,
          toolCallType: item.call.input.kind === 'text' ? 'custom' as const : 'function' as const,
          ...(item.call.id ? { toolCallId: item.call.id } : {}),
          ...(item.modelImages.length ? { images: item.modelImages } : {}) }))
      ] };
      const compiled = await this.requestAdmission.compile(logical, snapshot.profile, admitted.outputReservation, admitted.presentation);
      const probe = await this.assembleContextRecovery({ runId: runtime.runId, input: runtime.input, snapshot,
        signal: runtime.signal, run: runtime.run }, new ContextAdmissionError(compiled,
        new Error('Settled tool presentations must leave an admissible context-management request.')), runtime.append, true);
      try {
        await this.requestAdmission.admit(probe.assembly.compiled, snapshot.profile);
        return selected;
      } catch (error) {
        if (!(error instanceof ContextAdmissionError)) throw error;
        failure = error;
      }
    }
    if (!failure) throw new Error('Tool presentation admission did not produce a candidate.');
    throw new ContextRecoveryStoppedError(requestCapacityConflict(failure, this.outputReservationPolicy),
      'Settled tool results are preserved, but even their artifact-backed presentations cannot fit a context-management request.');
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
    const resumedBudget = runtime.controller.snapshot();
    await runtime.append({
      type: 'run.phase.changed',
      runId: runtime.runId,
      phase: agentRunActivity(runtime.run.state()),
      budget: resumedBudget
    });
    await runtime.emit({
      type: 'run.phase.changed',
      phase: agentRunActivity(runtime.run.state()),
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
    if (resumedTools.outcome === 'ownership_lost')
      throw new AgentRunOwnershipLostError(runtime.runId);
    if (resumedTools.outcome === 'waiting_for_approval')
      return {
        executionStatus: 'waiting_for_approval',
        approvals: resumedTools.approvals
      };
    if (resumedTools.outcome === 'waiting_for_recovery')
      return toolRecoveryDecision(runtime.run.state());
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
    readonly run: AgentRunDriver;
    readonly controller: AgentRunBudget;
    readonly append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>;
    readonly emit: (event: AgentProgressEvent) => Promise<void>;
  }): Promise<TerminalDecision> {
    await this.waitForAbortRequest(runtime.runId);
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
      const visible = content;
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
        ...(cause.reasoning === undefined ? {} : { reasoning: cause.reasoning }),
        ...(cause.reasoningSummary !== undefined
          ? { reasoningSummary: cause.reasoningSummary }
          : {}),
        finalResponseReceived: cause.finalResponseReceived,
        ...(diagnostic ? { diagnostic } : {})
      };
      await runtime.append(interrupted);
      await runtime.emit(interrupted);
    }
    const failedRequest = runtime.run
      .state()
      .providerRequests.find((request) => sameTurnIdentity(request.identity, attachedIdentity));
    if (
      diagnostic &&
      turnCount > 0 &&
      failedRequest &&
      failedRequest.stage !== 'ready' &&
      failedRequest.stage !== 'effect_ready'
    ) {
      const failed = {
        type: 'model.failed' as const,
        ...attachedIdentity,
        turnIndex: Math.max(1, turnCount),
        diagnostic
      };
      await runtime.append(failed);
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
    if (cause instanceof AgentLimitExceededError || cause instanceof InferenceBudgetExceededError) {
      return {
        executionStatus: 'failed',
        terminationReason: 'limit_exhausted',
        modelOutput: failureModelOutput,
        errorMessage: message,
        turnCount,
        exhaustedLimit: cause instanceof AgentLimitExceededError ? cause.limit :
          cause.resource === 'invocations' ? 'inference_invocations' : cause.resource
      };
    }
    const boundaryError = cause instanceof ModelStreamInterruptedError ? cause.cause : cause;
    const terminationReason =
      boundaryError instanceof ModelContractError
        ? 'malformed_response'
        : cause instanceof ModelStreamInterruptedError
          ? 'stream_interrupted'
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
    readonly controller: AgentRunBudget;
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
      ...(input.configuration.reasoning === undefined
        ? {}
        : { reasoning: input.configuration.reasoning }),
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
    return Object.freeze({
      record,
      profile: input.profile,
      requestWindow: Object.freeze({ ...input.requestWindow }),
      tools: Object.freeze([...input.tools]),
      configuration: input.configuration,
      instructions: Object.freeze([...input.instructions])
    });
  }

  private async restoreTurnSnapshot(record: AgentTurnSnapshotRecord, outputReservation: number): Promise<TurnSnapshot> {
    if (record.provider !== this.options.provider.id || record.model !== this.options.model)
      throw new Error(
        `Persisted turn ${record.turnId} does not match the configured provider and model.`
      );
    const profile = parseModelProfile(await this.options.provider.describeModel(record.model));
    if (hashJson(profile) !== record.profileHash)
      throw new Error(`Provider model profile changed for persisted turn ${record.turnId}.`);
    await this.refreshTools();
    const available = new Map(this.availableTools(profile).map((tool) => [tool.name, tool]));
    const tools = record.toolNames.map((name) => {
      const tool = available.get(name);
      if (!tool)
        throw new Error(`Tool ${name} required by persisted turn ${record.turnId} is unavailable.`);
      return tool;
    });
    assertToolCatalogCurrent(record.toolCatalog, tools);
    const requestWindow = requestWindowForModel(profile, outputReservation);
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
      tools: Object.freeze(tools),
      configuration,
      instructions: record.instructions
    });
  }

  private async requestNativeTurns(
    initial: AssistantTurnRequest,
    assembly: RequestAssemblyResult,
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
    const nativeStateSelectionId = assembly.fingerprint.stateSelectionId;
    this.nativeSteering?.bind(session, true);
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
      estimate: RequestTokenEstimate;
      readonly governed: ReturnType<typeof createRunInferenceLifecycle>;
    }
    const generations = new Map<string, Generation>();
    let active: Generation | undefined;
    let final: Extract<AssistantTurnResult, { readonly kind: 'settled' }> | undefined;
    let paused: ExecutionDecision | undefined;
    let unknownEffect: string | undefined;
    const transition = { pending: false };
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
    const admitNativeSuccessor = async (
      context: NativeGenerationContext,
      turn: AssistantTurnRequest
    ): Promise<void> => {
      if (context.compiled.accounting.outputReservation !== await this.selectedOutputReservation())
        throw new RangeError('Native successor changed the selected output reservation without an admitted context transition.');
      // Exact result delivery is mandatory while synchronous native obligations remain.
      // It admits real capacity, but discretionary control room waits for a legal boundary.
      if (context.dispatch?.sourceCalls.length) {
        await this.requestAdmission.admit(context.compiled, context.profile);
        this.stageAdmittedCapabilities(context.compiled, turn);
      }
      else await this.admitContextRequest(context.compiled, turn, runtime.append);
      this.publishAdmittedCapabilities(context.compiled, turn);
    };
    const nativeTools = (context: NativeGenerationContext) => {
      const tools =
        context.dispatch?.kind === 'steering'
          ? (active?.request.snapshot.tools ?? nextTools)
          : nextTools;
      if (hashJson(toolsForModel([...tools], context.profile, this.options.nativeToolExposure, this.programTool())) !== hashJson(context.compiled.logicalRequest.tools ?? [])) {
        throw new Error('Native dispatch changed the captured tool catalog.');
      }
      return tools;
    };
    const createGeneration = async (context: NativeGenerationContext): Promise<Generation> => {
      const first = context.generationDeliveryId === 'initial';
      if (!first) runtime.controller.reserveModelTurn();
      const request = context.compiled.logicalRequest;
      const tools = nativeTools(context);
      const snapshot = first
        ? initial.snapshot
        : this.createTurnSnapshot({
            turnIndex: runtime.controller.snapshot().modelTurns + 1,
            turnId: randomUUID(),
            requestAttempt: 1,
            configuration: {
              model: request.model,
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
              ...(request.responseFormat === undefined
                ? {}
                : { responseFormat: request.responseFormat })
            },
            profile: context.profile,
            requestWindow: requestWindowForModel(context.profile, context.compiled.accounting.outputReservation),
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
      await admitNativeSuccessor(context, turn);
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
          budget: runtime.controller.reserveModelTurn()
        }));
        const started = {
          type: 'turn.started' as const,
          runId: runtime.runId,
          task: runtime.input.task,
          ...(runtime.input.origin === undefined ? {} : { origin: runtime.input.origin }),
          ...turnIdentity(snapshot.record)
        };
        await runtime.append(started);
        await runtime.emit(started);
      }
      const estimate = requestTokenEstimate({
        accounting: context.compiled.accounting,
        modelWindowTokens: 0,
        contextTokens: 0
      });
      const fingerprint: InferenceRequestFingerprintRecord = first
        ? assembly.fingerprint
        : {
            ...turnIdentity(snapshot.record),
            requestId: context.invocationId,
            stateSelectionId: nativeStateSelectionId,
            compiledInputIdentity: context.compiled.inputIdentity,
            capabilityRevision: context.compiled.capabilityRevision,
            ...(context.parentInvocationId ? { parentRequestId: context.parentInvocationId } : {}),
            configuredContextIds: [],
            providerContextIds: [],
            runContextIds: [],
            ...await this.programReceiptCursor(runtime.runId),
            effectiveInstructionHash: hashJson(
              request.messages.filter((item) => item.role === 'system' || item.role === 'developer')
            ),
            modelWindowHistoryHash: hashJson(request.messages),
            modelToolSchemasHash: hashJson(request.tools ?? []),
            modelWindowHash: hashJson(request.messages)
          };
      await runtime.append({
        type: 'budget.estimate.created',
        ...turnIdentity(snapshot.record),
        attempt: 1,
        estimate
      });
      if (!first && context.dispatch) {
        const deliveredIds = new Set(context.dispatch.sourceCalls.map((call) => call.toolCallId));
        const sourceIds: string[] = [];
        for (const batch of runtime.run.state().toolBatches)
          for (const [index, call] of batch.callStates.entries()) {
            if (call.stage !== 'recorded' || !deliveredIds.has(batch.modelCalls[index]?.id ?? ''))
              continue;
            const observation = call.settlement.observation;
            if (!observation) continue;
            const output = observation.output;
            if (
              observation.execution?.state !== 'not_started' ||
              typeof output !== 'object' ||
              output === null ||
              !('status' in output) ||
              output.status !== 'context_required' ||
              !('context' in output) ||
              !Array.isArray(output.context)
            )
              continue;
            for (const value of output.context) {
              const item = decodePromptContextItemInput(value);
              if (item.id) sourceIds.push(item.id);
            }
          }
        await this.options.onRequestAdmitted?.({ requestId: context.invocationId, sourceIds });
      }
      const started = { type: 'assistant.started' as const, ...turnIdentity(snapshot.record) };
      await runtime.append(started);
      await runtime.emit(started);
      const sourceAccess = first ? assembly.sourceAccess : this.activeHistorySourceAccess;
      const governed = createRunInferenceLifecycle({
        operation: 'native_generation',
        assertSources: () => this.assertHistorySourceAccess(sourceAccess),
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
        stateSelectionId: () => nativeStateSelectionId,
        capturedHistoryCut: () => this.options.context?.history.capture(),
        ownerId: this.options.inferenceOwnerId ?? runtime.runId,
        ...this.options.inferenceScope,
        purpose: 'agent_step',
        runId: runtime.runId,
        request: assembly.request,
        compiled: assembly.compiled,
        profile: initial.snapshot.profile,
        capabilities: context => this.boundCapabilitySnapshot({ profile: context.profile, tools: nativeTools(context) }),
        session,
        signal: initial.signal,
        start: async (context) => {
          await createGeneration(context);
        },
        extended: async (context, dispatch) => {
          const item = generation(context);
          await admitNativeSuccessor(
            { ...context, compiled: dispatch.compiled, dispatch },
            item.request
          );
          const estimate = requestTokenEstimate({
            accounting: dispatch.compiled.accounting,
            modelWindowTokens: 0,
            contextTokens: 0
          });
          item.estimate = estimate;
          await runtime.append({
            type: 'budget.estimate.created',
            ...turnIdentity(item.request.snapshot.record),
            attempt: 1,
            estimate
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
            if (!event.native)
              throw new Error('Native response is missing its admission manifest.');
            const previous = active?.request.snapshot.record;
            const prior =
              previous &&
              runtime.run
                .state()
                .providerRequests.find((request) => sameTurnIdentity(request.identity, previous));
            if (prior?.stage === 'settled') {
              await runtime.run.transitionProvider(
                'consume_provider_settlement',
                prior.identity,
                () => ({ ...prior, stage: 'consumed' }),
                runtime.controller.snapshot()
              );
            }
            const deliveryId = event.native.generationDeliveryId ?? 'initial';
            active = [...generations.values()].find(
              (item) => item.generationDeliveryId === deliveryId
            );
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
            signal: runtime.signal,
            request: item.request,
            requestEstimate: item.estimate,
            response,
            identity: turnIdentity(item.request.snapshot.record),
            append: runtime.append,
            emit: runtime.emit
          });
          final = {
            ...assistant,
            native: true
          };
          const calls = assistant.toolCalls;
          if (
            !calls.length &&
            !boundary.pendingToolCalls.length &&
            this.contextTransitions?.hasPending()
          ) {
            const source = providerWork(runtime.run.state(), item.request.snapshot.record);
            if (source.stage !== 'settled')
              throw new Error('Native context transition requires settled provider work.');
            assertToolTransitionBoundary(runtime.run.state());
            await runtime.run.transitionProvider(
              'consume_provider_settlement',
              source.identity,
              () => ({ ...source, stage: 'consumed' })
            );
            await this.advanceRun(runtime.run, 'advance_after_tools', {
              phase: {
                kind: 'initializing',
                step: 'assemble_turn',
                turnIndex: item.request.turnIndex + 1
              }
            });
            transition.pending = true;
            return;
          }

          if (calls.length && response.terminationReason !== 'tool_calls') {
            throw new Error(
              'Native response returned calls with an incompatible termination reason.'
            );
          }
          initial.modelWindow.recordModelOutput({
            source: assistant.source,
            turnIndex: item.request.turnIndex,
            content: response.content,
            toolCalls: response.toolCalls ?? [],
            ...(response.output ? { output: response.output } : {})
          });
          if (calls.length) {
            this.assertProgrammaticCallsAdvertised(response, item.request.snapshot);
            runtime.controller.reserveToolCalls(calls);
            const source = providerWork(runtime.run.state(), item.request.snapshot.record);
            if (source.stage !== 'settled')
              throw new Error('Native tool source is not durably settled.');
            await this.recordAcceptedToolCalls(runtime, source.identity, item.request.toolBatchId, calls, initial.modelWindow);
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
              budget: runtime.controller.reserveToolCalls(batch.calls)
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
          if (!ready.results.length && !calls.length &&
              (response.terminationReason !== 'continuation' || boundary.continuation !== 'client')) return;
          await this.refreshTools(initial.signal);
          nextTools = Object.freeze(this.availableTools(context.profile));
          const tools = toolsForModel([...nextTools], context.profile, this.options.nativeToolExposure, this.programTool());
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
              input: [],
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
      if (transition.pending) return { kind: 'transition_context' };
      if (!final || final.toolCalls.length)
        throw new Error('Native execution ended with unresolved model work.');
      return final;
    } catch (error) {
      if (paused) return { kind: 'decision', decision: paused };
      if (unknownEffect) return { kind: 'outcome_unknown', effectId: unknownEffect };
      // A rejected dispatch was never sent. Preserve its typed admission conflict
      // after prior provider effects settle; mandatory tool results remain owned.
      const boundaryFailure = error instanceof ModelStreamInterruptedError ? error.cause : error;
      const admissionFailure = boundaryFailure instanceof InferenceNotSentError
        ? boundaryFailure.cause : boundaryFailure;
      if (admissionFailure instanceof ContextAdmissionError &&
          !runtime.run.state().providerRequests.some((request) =>
            request.stage === 'effect_pending' || request.stage === 'outcome_unknown')) {
        if (pendingToolCalls(runtime.run.state()).some((call) => call.protocol === 'synchronous'))
          throw new ContextAdmissionError(admissionFailure.compiled,
            new Error(`${admissionFailure.message} Mandatory native results remain recorded and undelivered; context selection cannot bypass them. Cancel if no lawful continuation can fit.`));
        throw admissionFailure;
      }
      throw error;
    } finally {
      await pump.close();
    }
  }

  private async requestAssistantTurn(
    request: AssistantTurnRequest,
    append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>,
    emit: (event: AgentProgressEvent) => Promise<void>,
    nativeWork: {
      readonly runtime: RunExecutionRuntime;
      readonly observationStore: ObservationStore;
    }
  ): Promise<AssistantTurnResult> {
    const deadline = runSignalDeadline(request.controller, request.signal);
    request = { ...request, signal: deadline.signal };
    try {
      let rejected: CompiledModelRequest | undefined;
      let contextRetries = 0;
      let generationRetries = 0;
      let recoveryAssembly: RequestAssemblyResult | undefined;
      for (;;) {
        const identity = turnIdentity(request.snapshot.record);
        let assembly: RequestAssemblyResult;
        // A generation retry owns the same captured candidate. Preparation retries
        // instead revalidate sources and admission before any provider effect exists.
        if (recoveryAssembly) assembly = recoveryAssembly;
        else {
          const prepared = await this.prepareModelRequest(request, append, emit, rejected);
          request = prepared.request;
          assembly = prepared.assembly;
          if (request.snapshot.record.contextRecovery) recoveryAssembly = assembly;
        }
        if (assembly.contextBoundaryRevision !== undefined && assembly.contextBoundaryRevision !== this.contextBoundaryRevision) {
          request = await this.applyPreparingSteering(request);
          continue;
        }
        if (assembly.freshContext && request.replaceModelSession) {
          request = { ...request, modelSession: await request.replaceModelSession() };
        }
        await request.controller.recordUsage(
          await this.inferenceService.settledRunUsage(
            this.options.inferenceOwnerId ?? request.runId,
            request.runId
          )
        );
        if (!request.snapshot.record.contextRecovery &&
            await this.refreshAdvancedHistory(request.modelWindow, request.runId, assembly.capturedHistoryCut))
          continue;
        const protocol = request.snapshot.profile.capabilities.protocol;
        if (
          !request.snapshot.record.contextRecovery && request.modelSession.continueNative &&
          !this.requestHasRevocableMaterial(assembly.compiled) &&
          (protocol?.asyncTools || protocol?.steering === 'native')
        ) {
          return await this.requestNativeTurns(
            request,
            assembly,
            nativeWork.runtime,
            nativeWork.observationStore
          );
        }
        // This ordinary launch preserves the complete compiled prefix. Steering is
        // applied at the next request boundary because native transport cannot hold its source guard.
        if (this.requestHasRevocableMaterial(assembly.compiled)) this.nativeSteering?.bind(request.modelSession, false);
        const ledgerModelRequest = { ...assembly.request };
        delete ledgerModelRequest.signal;
        await append({ type: 'assistant.started', ...identity });
        await emit({ type: 'assistant.started', ...identity });
        const recoverySession = request.snapshot.record.contextRecovery ? this.inferenceService.createSession() : undefined;
        let completedAttempt;
        try { completedAttempt = await invokeRunInference({
          service: this.inferenceService,
          assertSources: () => this.assertHistorySourceAccess(assembly.sourceAccess),
          withDispatchAuthority: operation => this.withRequestMaterial(assembly.compiled, () => {
            if (assembly.contextBoundaryRevision !== undefined && assembly.contextBoundaryRevision !== this.contextBoundaryRevision)
              throw new ContextPreparationChanged('A newer accepted instruction invalidated the request before dispatch.');
            return operation();
          }),
          ...(assembly.capturedHistoryCut ? { capturedHistoryCut: assembly.capturedHistoryCut } : {}),
          ...(this.nativeSteering ? { steering: this.nativeSteering } : {}),
          options: this.options,
          request: assembly.request,
          compiled: assembly.compiled,
          requestEstimate: assembly.estimate,
          requestFingerprint: assembly.fingerprint,
          requestSummary: summarizeModelRequest(ledgerModelRequest),
          turnRequest: recoverySession ? { ...request, modelSession: recoverySession } : request,
          append,
          emit: snapshotRecoveryEmitter(request.snapshot, emit),
          advanceRun: (driver, procedure, advance) => this.advanceRun(driver, procedure, advance)
        }); } catch (cause) {
          if (!(cause instanceof InferenceNotSentError) || !(cause.cause instanceof ContextPreparationChanged)) throw cause;
          const phase = providerWork(request.run.state(), identity);
          if (phase.stage !== 'failed') throw cause;
          request = await this.applyPreparingSteering(request);
          const snapshot = { ...request.snapshot, record: { ...request.snapshot.record, requestAttempt: request.snapshot.record.requestAttempt + 1 } };
          request = { ...request, snapshot };
          recoveryAssembly = undefined;
          await this.advanceRun(request.run, 'consume_provider_settlement', {
            phase: { kind: 'active' },
            providerRequests: [...request.run.state().providerRequests.map(previous =>
              sameTurnIdentity(previous.identity, phase.identity) ? { ...phase, stage: 'consumed' as const } : previous),
              { kind: 'provider', stage: 'ready', identity: turnIdentity(snapshot.record), toolBatchId: request.toolBatchId }]
          });
          continue;
        } finally { await recoverySession?.close?.(); }
        if (completedAttempt.kind === 'outcome_unknown') return completedAttempt;
        if (completedAttempt.kind === 'failed') {
          const capacityFailure = completedAttempt.diagnostic.code === 'context_overflow';
          if (capacityFailure && request.snapshot.record.contextRecovery)
            throw new ContextRecoveryStoppedError(request.snapshot.record.contextRecovery,
              'Provider rejected the checkpoint request. Original history and committed state remain intact.');
          if (
            capacityFailure &&
            (contextRetries === 1 ||
              !this.options.contextRenewal?.automatic ||
              !this.options.context)
          )
            throw new ContextAdmissionError(
              assembly.compiled,
              new Error(
                'Provider rejected context capacity; adjust selected sources, reservations, or model capacity.'
              ),
              true
            );
          const phase = providerWork(request.run.state(), completedAttempt.identity);
          if (phase.stage !== 'failed')
            throw new Error('Provider failure has no durable settlement.');
          if (capacityFailure) {
            contextRetries++;
            rejected = assembly.compiled;
          } else {
            if (!completedAttempt.diagnostic.retryable || generationRetries === AgentRuntime.MAX_PROVIDER_RETRIES)
              return {
                kind: 'decision',
                decision: failedGenerationDecision(completedAttempt.diagnostic, request.turnIndex)
              };
            if (recoveryAssembly?.recoveryAttempt !== undefined &&
                recoveryAssembly.recoveryAttempt >= this.contextControlPolicy.requestsPerBoundary && request.snapshot.record.contextRecovery)
              throw new ContextRecoveryStoppedError(request.snapshot.record.contextRecovery,
                'Context recovery exhausted its configured request allowance without progress.', 'attempt_limit');
            generationRetries++;
            await this.waitForProviderRetry(request, completedAttempt.diagnostic,
              generationRetries, 'Generation', emit);
          }
          const snapshot = {
            ...request.snapshot,
            record: {
              ...request.snapshot.record,
              requestAttempt: request.snapshot.record.requestAttempt + 1
            }
          };
          request = { ...request, snapshot };
          if (recoveryAssembly) {
            recoveryAssembly = {
              ...recoveryAssembly,
              ...(recoveryAssembly.recoveryAttempt === undefined ? {} : { recoveryAttempt: recoveryAssembly.recoveryAttempt + 1 }),
              fingerprint: { ...recoveryAssembly.fingerprint, ...turnIdentity(snapshot.record), requestId: randomUUID() }
            };
            await append({ type: 'budget.estimate.created', ...turnIdentity(snapshot.record),
              attempt: 1, estimate: recoveryAssembly.estimate });
          }
          await this.advanceRun(request.run, 'consume_provider_settlement', {
            phase: { kind: 'active' },
            providerRequests: [
              ...request.run
                .state()
                .providerRequests.map((previous) =>
                  sameTurnIdentity(previous.identity, phase.identity)
                    ? { ...phase, stage: 'consumed' as const }
                    : previous
                ),
              {
                kind: 'provider',
                stage: 'ready',
                identity: turnIdentity(snapshot.record),
                toolBatchId: request.toolBatchId
              }
            ]
          });
          continue;
        }

        const settled = await this.consumeProviderSettlement({
          signal: request.signal,
          request,
          requestEstimate: assembly.estimate,
          response: completedAttempt.response,
          identity: completedAttempt.identity,
          append,
          emit: snapshotRecoveryEmitter(request.snapshot, emit)
        });
        return settled;
      }
    } finally {
      deadline.dispose();
    }
  }

  private async consumeProviderSettlement(input: {
    readonly signal: AbortSignal;
    readonly request: Pick<
      AssistantTurnRequest,
      'runId' | 'turnIndex' | 'snapshot' | 'controller' | 'run' | 'toolBatchId'
    >;
    readonly requestEstimate: RequestTokenEstimate;
    readonly response: ModelResponse;
    readonly identity: AgentTurnIdentity;
    readonly append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>;
    readonly emit: (event: AgentProgressEvent) => Promise<void>;
  }): Promise<Extract<AssistantTurnResult, { readonly kind: 'settled' }>> {
    const { request, response, identity: responseIdentity, append, emit } = input;
    const providerPhase = providerWork(request.run.state(), input.identity);
    if (providerPhase.stage !== 'settled')
      throw new Error('Provider response is not durably settled.');
    const settlementRecord = await this.readProviderSettlement(
      request.runId,
      providerPhase.effect.intent.effectId,
      providerPhase.responseId,
      providerPhase.settlementReference
    );
    if (settlementRecord?.event.type !== 'provider.attempt.settled')
      throw new Error('Provider response settlement is missing or contradictory.');
    const providerState = settlementRecord.event.providerState;
    await request.controller.recordUsage(
      await this.inferenceService.settledRunUsage(
        this.options.inferenceOwnerId ?? request.runId,
        request.runId
      )
    );
    throwIfAborted(input.signal);
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
    const toolCalls = Object.freeze((response.toolCalls ?? []).map(normalizeModelToolCall));
    const modelOutput = modelOutputFromResponse(response, request.turnIndex, toolCalls.length > 0);
    const assistantEnded = {
      type: 'assistant.ended' as const,
      ...(request.snapshot.record.contextRecovery ? { contextRecovery: true as const } : {}),
      ...(response.output?.some((item) => item.type === 'protocol' && item.state.compatibility.requiresExactPrefix) ? { nativePrefixBound: true as const } : {}),
      ...responseIdentity,
      content: response.content,
      ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
      ...(response.reasoningSummary === undefined
        ? {}
        : { reasoningSummary: response.reasoningSummary }),
      modelOutput,
      ...(toolCalls.length > 0 ? { toolCalls } : {})
    };
    const assistantReceipt = await request.run.append(
      assistantEnded,
      assistantResponseKey(request.runId, responseIdentity)
    );
    // Ordinary fallback text and direct calls already have canonical session
    // records. Only synthesize ordered output when it carries additional
    // provider protocol or caller identity that those records cannot express.
    const sessionOutput = response.output?.length ? response.output :
      response.providerState || response.toolCalls?.some(call => call.caller !== undefined)
        ? modelResponseOutput(response) : undefined;
    await this.recordSessionAssistant(
      request.runId,
      assistantEnded,
      assistantReceipt,
      sessionOutput
    );
    await emit(assistantEnded);
    return {
      kind: 'settled',
      response,
      toolCalls,
      modelOutput,
      native: false,
      source: { runId: request.runId, eventId: assistantReceipt.eventId,
        sequence: assistantReceipt.sequence, hash: assistantReceipt.hash },
      turn: { snapshot: request.snapshot, toolBatchId: request.toolBatchId }
    };
  }

  private async recordSessionAssistant(
    runId: string,
    event: Extract<AgentAuditEvent, { readonly type: 'assistant.ended' | 'assistant.interrupted' }>,
    receipt: EventAppendReceipt,
    output?: readonly ModelOutputItem[]
  ): Promise<void> {
    if (this.options.repositories.session) {
      const source = this.activeRunDriver
        ? providerWork(this.activeRunDriver.state(), event)
        : undefined;
      const inferenceInput =
        source && source.stage !== 'ready'
          ? await this.inferenceService.inputReference(
              this.options.inferenceOwnerId ?? runId,
              source.invocationId
            )
          : undefined;
      await this.options.repositories.session.repository.appendAssistant(
        this.options.repositories.session.descriptor,
        {
          runId,
          identity: {
            turnId: event.turnId,
            turnIndex: event.turnIndex,
            requestAttempt: event.requestAttempt
          },
          source: {
            runId,
            eventId: receipt.eventId,
            sequence: receipt.sequence,
            hash: receipt.hash
          },
          content: event.content,
          ...(event.contextRecovery ? { contextRecovery: true as const } : {}),
          ...(inferenceInput ? { inferenceInput } : {}),
          ...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }),
          ...(event.reasoningSummary === undefined
            ? {}
            : { reasoningSummary: event.reasoningSummary }),
          completeness: event.modelOutput.status,
          ...(output ? { output } : {})
        }
      );
    }
  }

  private async applyPreparingSteering(request: AssistantTurnRequest): Promise<AssistantTurnRequest> {
    if (!this.steerQueue.some(item => item.runId === request.runId)) return request;
    const steering = await this.consumeSteeringInstructions(request.runId);
    const delivered = steeringInstructions(steering, request.snapshot.instructions.length);
    for (const instruction of delivered) request.modelWindow.recordInput(instruction.id, { role: 'user', content: instruction.content }, request.turnIndex);
    const instructions = Object.freeze([...request.snapshot.instructions, ...delivered]);
    return { ...request, snapshot: { ...request.snapshot, instructions, record: { ...request.snapshot.record, instructions } } };
  }

  /** Pre-dispatch preparation has no provider effect to settle or replay. */
  private async prepareModelRequest(
    request: AssistantTurnRequest,
    append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>,
    emit: (event: AgentProgressEvent) => Promise<void>,
    rejected?: CompiledModelRequest
  ): Promise<{ request: AssistantTurnRequest; assembly: RequestAssemblyResult }> {
    for (let retries = 0; ; retries++) {
      request = await this.applyPreparingSteering(request);
      this.preserveRecoveryFailure(undefined, request);
      request.controller.assertElapsed();
      const tail = await this.options.repositories.events.tail(request.runId, { metadataOnly: true });
      if (tail.driverGeneration !== request.run.state().driverGeneration)
        throw new AgentRunOwnershipLostError(request.runId);
      try {
        try {
          // Assembly refreshes the selected source cut. Never cache a failed probe
          // or carry an unverified continuity reserve across a preparation retry.
          return { request, assembly: await this.assembleModelRequest(request, append, emit, rejected) };
        } catch (error) {
          if (!(error instanceof ContextAdmissionError || error instanceof ContextSourceCapacityError) ||
              !this.options.contextRenewal?.automatic || !this.options.context) throw error;
          const phase = request.run.state().phase;
          if (phase.kind === 'suspended' && phase.reason === 'context_admission' &&
              phase.conflict.recovery === 'unchanged_action') throw error;
          return await this.assembleContextRecovery(request, error, append);
        }
      } catch (error) {
        if (error instanceof ContextPreparationChanged) {
          request = await this.applyPreparingSteering(request);
          continue;
        }
        this.preserveRecoveryFailure(error, request);
        const diagnostic = providerFailureDiagnostic(error);
        if (!diagnostic?.retryable) throw error;
        if (retries === AgentRuntime.MAX_PROVIDER_RETRIES)
          throw new ContextRecoveryStoppedError({
            kind: 'request_preparation',
            message: 'Model request preparation is temporarily unavailable.',
            actions: ['retry', 'change_model', 'cancel']
          }, `Model request preparation is temporarily unavailable: ${errorMessage(error)}`);
        await this.waitForProviderRetry(request, diagnostic, retries + 1, 'Request preparation', emit);
      }
    }
  }

  /** Shared bounded provider retry timing; cancellation and run limits remain authoritative. */
  private async waitForProviderRetry(
    request: Pick<AssistantTurnRequest, 'runId' | 'signal' | 'run' | 'controller' | 'snapshot'>,
    diagnostic: ModelProviderErrorDiagnostic,
    retry: number,
    stage: string,
    emit: (event: AgentProgressEvent) => Promise<void>
  ): Promise<void> {
    const retryAt = Math.max(Date.now() + 500 * retry, diagnostic.retryNotBefore ?? 0);
    await emit({
      type: 'assistant.status',
      ...turnIdentity(request.snapshot.record),
      message: `${stage} failed. Retrying in ${String(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)))}s (${String(retry)}/${String(AgentRuntime.MAX_PROVIDER_RETRIES)}).`
    });
    const deadline = runSignalDeadline(request.controller, request.signal);
    try {
      for (let remaining = retryAt - Date.now(); remaining > 0; remaining = retryAt - Date.now())
        await delay(Math.min(remaining, 2_147_483_647), undefined, { signal: deadline.signal });
    } catch (error) {
      deadline.signal.throwIfAborted();
      throw error;
    } finally {
      deadline.dispose();
    }
    this.preserveRecoveryFailure(undefined, request);
    request.controller.assertElapsed();
  }

  private async prepareContextAdmission(
    run: AgentRunDriver,
    signal: AbortSignal,
    turnIndex: number
  ): Promise<RequestAssemblyResult> {
    const input = runInput(run.state(), signal);
    const controller = new AgentRunBudget({
      run,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.limits ? { limits: this.options.limits } : {})
    });
    const configuration = this.captureRuntimeConfiguration();
    const profile = parseModelProfile(
      await this.options.provider.describeModel(configuration.model)
    );
    await this.refreshTools(signal);
    const tools = this.availableTools(profile);
    const snapshot = this.createTurnSnapshot({
      turnIndex: turnIndex,
      turnId: randomUUID(),
      requestAttempt: 1,
      configuration,
      profile,
      requestWindow: requestWindowForModel(profile, await this.selectedOutputReservation()),
      tools,
      instructions: [
        ...(await this.currentApplicationInstructions()),
        ...runInstructions(input.instructions)
      ],
      controller,
      continuationEligible: false
    });
    const session = this.inferenceService.createSession();
    try {
      const request: AssistantTurnRequest = {
        runId: input.runId,
        input,
        turnIndex: turnIndex,
        toolBatchId: randomUUID(),
        snapshot,
        modelSession: session,
        signal,
        modelWindow: new ModelWindow(this.estimator),
        controller,
        run
      };
      const append = (event: AgentAuditEvent) =>
        run.append(event, `${input.runId}:context-resume:${hashJson(encodeAgentEvent(event))}`);
      return (await this.prepareModelRequest(request, append, () => Promise.resolve(undefined))).assembly;
    } finally {
      await session.close?.();
    }
  }

  private async admitContextResumption(run: AgentRunDriver, signal: AbortSignal): Promise<boolean> {
    const phase = run.state().phase;
    if (phase.kind !== 'suspended' || phase.reason !== 'context_admission') return false;
    if (pendingToolCalls(run.state()).some((call) => call.protocol === 'synchronous')) return false;
    try {
      const assembly = await this.prepareContextAdmission(run, signal, phase.turnIndex);
      // Admission records its own audit events. Fence against the current owned tail,
      // while preserving the exact suspension that authorized this resumption.
      if (hashJson(run.state().phase) !== hashJson(phase))
        throw new Error('Context suspension changed during request admission.');
      const resumed = await run.resumeContextAdmission({
        expectedRevision: run.state().revision,
        inputIdentity: assembly.compiled.inputIdentity
      });
      if (resumed.state.phase.kind === 'suspended') {
        this.options.context?.recordAdmission({
          status: 'blocked',
          inputIdentity: assembly.compiled.inputIdentity,
          accounting: assembly.compiled.accounting,
          message: phase.conflict.message
        });
        return false;
      }
      return true;
    } catch (cause) {
      if (cause instanceof ContextAdmissionError || cause instanceof ContextSourceCapacityError || cause instanceof ContextContinuityError || cause instanceof ContextRecoveryStoppedError)
        return false;
      throw cause;
    }
  }

  /** Recovery retains the bound catalog and native prefix, with host-granted control execution only. */
  private async assembleContextRecovery<T extends Pick<AssistantTurnRequest, 'runId' | 'input' | 'snapshot' | 'signal' | 'run'>>(
    ordinary: T & { readonly modelWindow?: ModelWindow },
    failure: ContextAdmissionError | ContextSourceCapacityError,
    append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>,
    probe = false,
    cut?: import('./history/contracts.js').HistorySourceCut
  ): Promise<{ request: T; assembly: RequestAssemblyResult }> {
    const context = this.options.context;
    if (!context || !ordinary.snapshot.profile.capabilities.toolCalling || !(failure instanceof ContextAdmissionError)) throw failure;
    cut ??= await context.history.capture();
    let recoveryOriginal = failure.compiled;
    let recoveryTools = ordinary.snapshot.tools;
    const continuation = ordinary.snapshot.tools.some(tool => contextControlRole(tool) === 'catalog')
      ? ordinary.modelWindow?.continuation() : undefined;
    if (continuation) {
      const accepted = continuation.input;
      const configuration = ordinary.snapshot.configuration;
      const selectedSettings = { model: configuration.model, temperature: configuration.temperature ?? null,
        reasoning: configuration.reasoning ?? null, responseFormat: configuration.responseFormat ?? null };
      const acceptedSettings = { model: accepted.request.model, temperature: accepted.request.temperature ?? null,
        reasoning: accepted.request.reasoning ?? null, responseFormat: accepted.request.responseFormat ?? null };
      if (hashJson(selectedSettings) !== hashJson(acceptedSettings))
        throw new ContextContinuityError('unsupported', 'Recovery cannot replace the configuration bound to an admitted native prefix.');
      const candidatePresentation = this.inferenceService.presentationFor(failure.compiled);
      if (candidatePresentation?.authority !== accepted.presentation.authority)
        throw new ContextContinuityError('unsupported', 'Recovery cannot substitute changed authority into an admitted native prefix.');
      const messages = [...accepted.request.messages, ...continuation.prior, ...continuation.current];
      for (const message of messages) {
        if (message.role !== 'protocol') continue;
        const incompatibility = providerContextIncompatibility(message.state, { provider: this.options.provider.id,
          model: configuration.model, ...(ordinary.snapshot.profile.capabilities.protocol ? { protocol: ordinary.snapshot.profile.capabilities.protocol } : {}) });
        if (incompatibility) throw new ContextContinuityError('unsupported', `Admitted native recovery source is incompatible: ${incompatibility}.`);
      }
      const identity = hashJson(accepted.request.tools ?? []);
      const matches = [...this.catalogTools.values()].filter(tools =>
        hashJson(toolsForModel([...tools], ordinary.snapshot.profile, this.options.nativeToolExposure, this.programTool())) === identity);
      const matched = matches[0];
      if (!matched || matches.length !== 1)
        throw new ContextContinuityError('unsupported', 'The exact admitted native tool definitions are unavailable or ambiguous for recovery.');
      recoveryTools = matched;
      recoveryOriginal = await this.requestAdmission.compile({ ...accepted.request, messages, signal: ordinary.signal },
        ordinary.snapshot.profile, accepted.outputReservation, continuation.materialDependencies
          ? { ...accepted.presentation, materialDependencies: continuation.materialDependencies } : accepted.presentation);
    }
    const originalConflict = requestCapacityConflict(failure, this.outputReservationPolicy);
    const inspection = await context.inspect(cut, { limit: this.contextControlPolicy.inventoryItems, maxBytes: this.contextControlPolicy.inventoryBytes });
    const conflict = {
      ...originalConflict,
      // Audit writes, inspections, and rejection notices are not progress. A new
      // committed window has already admitted the original work and starts its
      // own no-progress allowance, under the unchanged owner/run budgets.
      recoveryBoundary: hashJson({
        windowId: inspection.window?.windowId ?? null,
        stateSelectionId: inspection.sessionState.selectionId,
        task: ordinary.input.task, origin: ordinary.input.origin ?? null, images: ordinary.input.images ?? null,
        configuration: ordinary.snapshot.configuration, profile: ordinary.snapshot.profile,
        instructions: ordinary.snapshot.instructions, catalog: ordinary.snapshot.record.toolCatalog.revision,
        outputReservation: failure.compiled.accounting.outputReservation
      })
    } satisfies ContextAdmissionConflict;
    // Exact native prefixes retain their bound schemas. Portable catalog recovery
    // may admit only exact host-granted controls, so loaded schema growth cannot
    // prevent selecting a smaller inventory. Original messages remain complete.
    const exactPrefix = continuation !== undefined || recoveryOriginal.logicalRequest.messages.some(message =>
      message.role === 'protocol' && message.state.compatibility.requiresExactPrefix);
    const restrictCatalog = !exactPrefix && recoveryTools.some(tool => contextControlRole(tool) === 'catalog');
    const tools = restrictCatalog ? Object.freeze(recoveryTools.filter(isContextCheckpointTool)) : recoveryTools;
    if (!tools.some(tool => isContextActivationTool(tool) || contextControlRole(tool) === 'catalog')) throw failure;
    // Probes compile bounded material only. Durable no-progress accounting is
    // read exactly when entering recovery, indexed to this unchanged boundary.
    const events = this.options.repositories.events;
    let attempts = 0;
    const recoveryResults: { tool: string; content: string; original: string; coverage: 'complete' | 'partial' }[] = [];
    const rejectionMessages: string[] = [];
    if (!probe) {
      const actionBoundary = `${ordinary.runId}:${conflict.recoveryBoundary}`;
      if (this.recoveryActionBoundary !== actionBoundary) {
        this.recoveryActions.clear();
        this.recoveryActionBoundary = actionBoundary;
      }
      const tail = await events.tail(ordinary.runId, { metadataOnly: true });
      const snapshots = await events.readMetadataRange(ordinary.runId, {
        through: tail, types: ['turn.snapshot.created'], metadata: { recoveryBoundary: conflict.recoveryBoundary },
        limit: this.contextControlPolicy.requestsPerBoundary + 1, maxBytes: 2 * this.contextControlPolicy.resultBytes
      });
      if (snapshots.oversized || !snapshots.complete)
        throw new ContextRecoveryStoppedError(conflict, 'Context recovery exhausted its bounded durable request inventory.', 'attempt_limit');
      attempts = snapshots.records.length;
      if (attempts >= this.contextControlPolicy.requestsPerBoundary)
        throw new ContextRecoveryStoppedError(conflict, 'Context renewal could not prepare an admissible successor within its request allowance. Original history and committed state remain intact.', 'attempt_limit');
      for (const snapshot of snapshots.records) {
        const exchangeId = snapshot.metadata.exchangeId;
        if (!exchangeId) throw new Error('Recovery snapshot is missing its exchange identity.');
        const records = await events.readMetadataRange(ordinary.runId, {
          through: tail, types: ['assistant.ended', 'observation.record.created'],
          metadata: { exchangeId }, limit: this.contextControlPolicy.exchangeRecords, maxBytes: 2 * this.contextControlPolicy.resultBytes
        });
        if (!records.complete || records.oversized)
          throw new ContextRecoveryStoppedError(conflict, 'Recovery exchange exceeds its bounded control protocol.');
        for (const metadata of records.records) {
          if (metadata.bytes > this.contextControlPolicy.sourceReadBytes) {
            recoveryResults.push({ tool: metadata.metadata.toolName ?? 'context', content: 'Recorded recovery result exceeds the bounded presentation read. Use its original history source.', original: metadata.reference.eventId, coverage: 'partial' });
          } else {
            const event = (await events.readReference(metadata.reference)).event;
            if (event.type === 'assistant.ended' && event.contextRecovery && snapshot.metadata.recoveryBoundary === conflict.recoveryBoundary)
              for (const call of event.toolCalls ?? []) this.recoveryActions.add(`${ordinary.runId}:${conflict.recoveryBoundary}:${hashJson({name: call.name, input: call.input})}`);
            if (event.type === 'observation.record.created') {
              const sourceBytes = event.modelContentRef?.size ?? Buffer.byteLength(JSON.stringify(event.modelContent));
              const content = sourceBytes <= this.contextControlPolicy.sourceReadBytes
                ? serializeToolModelContent(await resolveToolModelContent(event, this.options.repositories.artifacts))
                : 'Recovery presentation exceeds its byte bound; the original remains recorded.';
              const bounded = textRange(content, 0, this.contextControlPolicy.resultBytes);
              recoveryResults.push({tool: event.toolName, content: bounded.text, original: metadata.reference.eventId,
                coverage: sourceBytes <= this.contextControlPolicy.sourceReadBytes && bounded.nextOffset >= Buffer.byteLength(content) ? 'complete' : 'partial'});
            }
          }
          if (recoveryResults.length > this.contextControlPolicy.recentResults) recoveryResults.shift();
        }
      }
      const rejection = await events.latestReferenceOfType(ordinary.runId, 'context.transition.rejected', { metadataOnly: true });
      if (rejection) {
        const metadata = await events.readMetadataRange(ordinary.runId, { afterSequence: rejection.sequence - 1, through: tail, limit: 1 });
        if (metadata.records[0] && metadata.records[0].bytes <= this.contextControlPolicy.rejectionBytes) {
          const event = (await events.readReference(rejection)).event;
          if (event.type === 'context.transition.rejected') rejectionMessages.push(textRange(event.message, 0, this.contextControlPolicy.rejectionPreviewBytes).text);
        }
      }
    }
    const manifest = inspection.activeSelection.status === 'available'
      ? inspection.activeSelection.manifest : inspection.activeSelection;
    // The live request and steering are independent of the oldest-first inventory page.
    // These are bounded presentations of the existing request, never additional authority.
    const currentRequest = contextControlPreview(ordinary.input.task, this.contextControlPolicy.currentRequestBytes);
    const steering = contextControlSteering(ordinary.snapshot.instructions.filter(item => item.provenance === 'steering'), this.contextControlPolicy);
    const sessionState = await context.inspectSessionState(inspection.cut, this.contextControlPolicy.statePreviewBytes);
    const content = JSON.stringify({
      currentRequest: { ...currentRequest, runId: ordinary.runId,
        sourceIdentity: { kind: 'accepted_run_input', runId: ordinary.runId } },
      steering: { ...steering, sourceIdentity: { kind: 'effective_steering', runId: ordinary.runId, turnId: ordinary.snapshot.record.turnId } },
      conflict, attempt: attempts + 1, maximumAttempts: this.contextControlPolicy.requestsPerBoundary, inventory: manifest,
      sessionState: { ...sessionState, authority: 'fallible_model_interpretation' },
      legalTransitions: inspection.legalTransitions,
      sourceBudget: inspection.budget,
      recentRecoveryResults: probe ? [] : recoveryResults,
      controlPolicy: this.contextControlPolicy,
      controlTools: tools.flatMap(tool => { const role = contextControlRole(tool); return role ? [{ name: tool.name, role }] : []; }),
      outputReservationPolicy: this.outputReservationPolicy ?? { fixed: this.maxOutputTokens },
      rejectedTransitions: rejectionMessages
    });
    const outputReservation = Math.min(this.contextControlPolicy.outputTokens, failure.compiled.accounting.outputReservation);
    const snapshot: TurnSnapshot = {
      ...ordinary.snapshot,
      record: {
        ...ordinary.snapshot.record, contextRecovery: conflict,
        resumeInstructions: ordinary.snapshot.instructions, continuationEligible: false,
        toolCatalog: captureToolCatalog(tools), toolNames: tools.map((tool) => tool.name),
        instructions: ordinary.snapshot.instructions
      },
      tools, instructions: ordinary.snapshot.instructions,
      requestWindow: requestWindowForModel(ordinary.snapshot.profile, outputReservation)
    };
    const request = { ...ordinary, snapshot };
    let assembled: Awaited<ReturnType<typeof assembleContextControlRequest>>;
    try {
      assembled = await assembleContextControlRequest(this.requestAdmission, {
        policy: this.contextControlPolicy, original: recoveryOriginal,
        profile: snapshot.profile,
        task: content, maxOutputTokens: outputReservation, signal: request.signal,
        ...(restrictCatalog ? { tools: toolsForModel([...tools], snapshot.profile, this.options.nativeToolExposure, this.programTool()) } : {})
      });
    } catch (error) {
      this.preserveRecoveryFailure(error, ordinary);
      if (!(error instanceof RangeError)) throw error;
      throw new ContextRecoveryStoppedError(conflict, error.message);
    }
    try {
      // A probe measures the explicit reserve, including when that reserve
      // cannot fit. Only a dispatched control candidate needs its own admission.
      if (!probe) await this.requestAdmission.admit(assembled.compiled, snapshot.profile);
    } catch (error) {
      this.preserveRecoveryFailure(error, ordinary);
      if (!(error instanceof ContextAdmissionError)) throw error;
      throw new ContextRecoveryStoppedError(conflict,
        `Even the bounded context-management request cannot be admitted: ${error.message}`);
    }
    const estimate = requestTokenEstimate({
      accounting: assembled.compiled.accounting,
      modelWindowTokens: 0, contextTokens: assembled.assembly.estimate.contextTokens
    });
    const fingerprint: InferenceRequestFingerprintRecord = {
      ...turnIdentity(snapshot.record), requestId: randomUUID(),
      stateSelectionId: inspection.sessionState.selectionId,
      compiledInputIdentity: assembled.compiled.inputIdentity,
      capabilityRevision: assembled.compiled.capabilityRevision,
      // No application/provider context is recollected: original compiled messages are preserved below.
      configuredContextIds: [], providerContextIds: [], runContextIds: [],
      ...await this.programReceiptCursor(request.runId),
      effectiveInstructionHash: hashJson(snapshot.instructions), modelWindowHistoryHash: hashJson(recoveryOriginal.logicalRequest.messages),
      modelToolSchemasHash: hashJson(assembled.request.tools ?? []),
      modelWindowHash: hashJson(assembled.assembly.messages)
    };
    if (!probe) {
      this.publishAdmittedCapabilities(assembled.compiled, request);
      this.presentationSnapshot = snapshot;
      await append({ type: 'prompt.context.delivered', delivery: assembled.assembly.context });
      await append({ type: 'prompt.material.selected', material: assembled.assembly.material });
      await append({ type: 'budget.estimate.created', ...turnIdentity(snapshot.record), attempt: 1, estimate });
    }
    return { request, assembly: { capturedHistoryCut: cut, sourceAccess: this.activeHistorySourceAccess,
      request: assembled.request, compiled: assembled.compiled, estimate, fingerprint, recoveryAttempt: attempts + 1 } };
  }

  private validateOutputReservation(value: number | undefined): number {
    return resolveOutputReservation(this.maxOutputTokens, this.outputReservationPolicy, value);
  }

  private async selectedOutputReservation(): Promise<number> {
    const window = await this.options.context?.history.selectedContext();
    return this.validateOutputReservation(window?.outputReservation);
  }

  private async assembleModelRequest(
    request: AssistantTurnRequest,
    append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>,
    emit: (event: AgentProgressEvent) => Promise<void>,
    rejected?: CompiledModelRequest
  ): Promise<RequestAssemblyResult> {
    this.presentationSnapshot = request.snapshot;
    const identity = turnIdentity(request.snapshot.record);
    let sourceConflict: ContextSourceCapacityError | undefined;
    try {
      await this.options.context?.assertSourceCapacity();
      await this.activateCommittedContext(request.modelWindow, request.runId);
      // Incrementally recorded tool turns may have advanced the source boundary.
      // Refresh before compiling; the same fence runs again before dispatch for races.
      await this.refreshAdvancedHistory(request.modelWindow, request.runId, this.activeHistorySourceAccess?.cut);
    } catch (error) {
      if (!(error instanceof ContextSourceCapacityError)) throw error;
      sourceConflict = error;
    }
    const prefix = request.modelWindow.continuation();
    if (prefix?.input.presentation.materialDependencies?.some(value => value.ref.owner.kind === 'session') && this.options.context) {
      const current = await this.options.context.materials.currentSessionOwner();
      const dependencies = prefix.materialDependencies ?? prefix.input.presentation.materialDependencies;
      if (dependencies.some(value => value.ref.owner.kind === 'session' && value.ref.owner.branchId !== current.branchId))
        request.modelWindow.bindContinuationMaterialAuthority(await this.options.context.materials.captureInheritedPrefixDependencies(dependencies));
    }
    const preparationRevision = this.contextBoundaryRevision;
    const collectedContext = await this.collectContextItems(
      request.input,
      request.turnIndex,
      request.snapshot.instructions, request
    );
    if (preparationRevision !== this.contextBoundaryRevision) throw new ContextPreparationChanged('Accepted steering changed the optional recall boundary.');
    const programReceipts = await programCompletionContext(request.runId, this.options.repositories.events, this.options.repositories.artifacts);
    const contextInputs = { ...collectedContext, run: [ ...collectedContext.run, ...programReceipts.items ] };
    const capturedContext = [
      ...contextInputs.configured,
      ...contextInputs.provider,
      ...contextInputs.run
    ];
    let capacityNotice: PromptContextItemInput | undefined;
    const assemble = async (
      window: ModelWindow,
      sessionState: SessionStateSnapshot,
      artifacts: readonly PromptContextItemInput[] = [],
      proposedOutputReservation?: number,
      use?: Pick<RequestPresentation, 'materialDependencies' | 'skillReferences'>
    ) => {
      const outputReservation = this.validateOutputReservation(proposedOutputReservation ?? await this.selectedOutputReservation());
      const result = await this.requestAdmission.assemble(
        {
          window,
          runId: request.runId,
          task: request.input.task,
          ...(request.input.origin === undefined ? {} : { origin: request.input.origin }),
          ...(request.input.images === undefined ? {} : { images: request.input.images }),
          instructions: promptInstructionsForRequest({
            runInstructions: request.snapshot.instructions
              .filter((item) => item.provenance === 'run')
              .map((item) => item.content),
            configuredInstructions: request.snapshot.instructions
              .filter((item) => item.provenance === 'application')
              .map((item) => ({
                id: item.id,
                content: item.content,
                role: promptInstructionRole(item.role),
                ...(item.priority === undefined ? {} : { priority: item.priority }),
                ...(item.sourceUri ? { sourceUri: item.sourceUri } : {})
              }))
          }),
          contextItems: [...capturedContext, ...sessionStateContext(sessionState), ...artifacts],
          ...(use?.materialDependencies ? { materialDependencies: use.materialDependencies } : {}),
          ...(use?.skillReferences ? { skillReferences: use.skillReferences } : {}),
          ...(capacityNotice ? { capacityNotice } : {}),
          tools: promptToolSpecs(
            [...request.snapshot.tools],
            request.snapshot.profile,
            this.options.toolContext
          ),
          modelProfile: request.snapshot.profile,
          ...(this.metadata ? { metadata: this.metadata } : {})
        },
        {
          model: request.snapshot.configuration.model,
          tools: toolsForModel([...request.snapshot.tools], request.snapshot.profile, this.options.nativeToolExposure, this.programTool()),
          ...(supportsParameter(request.snapshot.profile, 'maxOutputTokens')
            ? { maxOutputTokens: outputReservation }
            : {}),
          signal: request.signal,
          ...(request.snapshot.configuration.temperature === undefined
            ? {}
            : { temperature: request.snapshot.configuration.temperature }),
          ...(request.snapshot.configuration.reasoning === undefined
            ? {}
            : { reasoning: request.snapshot.configuration.reasoning }),
          ...(request.snapshot.configuration.responseFormat === undefined
            ? {}
            : { responseFormat: request.snapshot.configuration.responseFormat })
        },
        outputReservation
      );
      await this.assertRequestMaterial(result.compiled);
      return { ...result, stateSelectionId: sessionState.id };
    };
    const contextPublication = { committed: false, fresh: false, candidateAdmitted: false };
    let rejectedCompatibilityAdmission: ContextAdmissionError | undefined;
    const controlReserves = new Map<string, number>();
    const admitOrdinary = async (compiled: CompiledModelRequest) => {
      const reserve = await this.admitContextRequest(compiled, request, append);
      if (reserve !== undefined) controlReserves.set(compiled.inputIdentity, reserve);
    };
    const validate = async (input: ContextAdmissionInput) => {
      assertToolTransitionBoundary(request.run.state());
      const boundary = request.run.state().revision;
      let proposed;
      let result;
      let renewal;
      try {
        proposed = await this.contextWindowForAdmission(input, request);
        result = await assemble(proposed.window, input.sessionState, input.artifacts, input.outputReservation, input);
        await admitOrdinary(result.compiled);
      } catch (error) {
        if (input.strategy !== 'append' ||
            (!(error instanceof NativeContextTransitionRequired) &&
              !(error instanceof ContextAdmissionError && error.capacityExceeded) &&
              !(error instanceof AppendContextRenewalRequired))) throw error;
        if (!this.options.context) throw error;
        proposed = await this.contextWindowForAdmission({ ...input, strategy: 'fresh' }, request);
        renewal = { selection: proposed.selection,
          cause: error instanceof ContextAdmissionError ? 'capacity' as const : 'prefix_incompatibility' as const };
        result = await assemble(proposed.window, input.sessionState, input.artifacts, input.outputReservation, input);
        await admitOrdinary(result.compiled);
      }
      if (result.compiled.inputIdentity === rejected?.inputIdentity)
        throw new ContextAdmissionError(
          result.compiled,
          new Error('Renewal retained the provider-rejected input.'),
          true
        );
      const tail = await this.options.repositories.events.tail(request.runId);
      if (tail.driverGeneration !== request.run.state().driverGeneration ||
          request.run.state().control.status !== 'owned')
        throw new AgentRunOwnershipLostError(request.runId);
      if (request.run.state().revision !== boundary)
        throw new Error('Context admission boundary changed during compilation.');
      request.signal.throwIfAborted();
      contextPublication.candidateAdmitted = true;
      return {
        compiledInputIdentity: result.compiled.inputIdentity,
        capabilityRevision: result.compiled.capabilityRevision,
        selection: proposed.selection,
        ...(input.outputReservation === undefined ? {} : { outputReservation: input.outputReservation }),
        ...(renewal ? { renewal } : {})
      };
    };
    if (this.options.context) {
      {
        await this.contextTransitions?.drain({
          context: this.options.context,
          preserveFailure: (error) => {
            if (error instanceof ContextAdmissionError) rejectedCompatibilityAdmission = error;
            this.preserveRecoveryFailure(error, request);
          },
          admit: (transition) => this.retainPendingSources(transition, request.runId),
          validate,
          ...(sourceConflict ? { renewalReason: 'capacity' as const } :
            this.pendingCompatibilityTransition ? { renewalReason: 'prefix_incompatibility' as const } : {}),
          unchanged: async (result, idempotencyKey) => {
            await emit({ type: 'context.transition.unchanged', idempotencyKey, windowId: result.windowId });
          },
          committed: async (entry) => {
            await this.activateCommittedContext(request.modelWindow, request.runId);
            contextPublication.committed = true;
            contextPublication.fresh ||= entry.transition.strategy === 'fresh';
            await emit({
              type: 'context.transitioned',
              window: entry.window,
              transition: entry.transition
            });
          },
          rejected: async (requestId, message, idempotencyKey, details) => {
            // Admission alone is not publication. A failed commit must not dispatch its candidate.
            contextPublication.candidateAdmitted = false;
            capturedContext.push({
              id: requestId,
              sourceUri: `runtime://context-selection/${requestId}`,
              sourceKind: 'generated',
              representation: 'full',
              mediaType: 'text/plain',
              title: 'Context selection rejected',
              content: details ? JSON.stringify({ message, details }) : message,
              purpose:
                'The requested selection was not committed; the preceding window remains active.'
            });
            await emit({ type: 'context.transition.rejected', requestId, idempotencyKey, message, ...(details ? { details } : {}) });
          },
          signal: request.signal
        });
      }
    }
    if (this.pendingCompatibilityTransition) {
      const accepted = request.modelWindow.continuation();
      const canSelectCatalog = request.snapshot.tools.some(tool => contextControlRole(tool) === 'catalog');
      const restoredCatalog = accepted && hashJson(accepted.input.request.tools ?? []) ===
        hashJson(toolsForModel([...request.snapshot.tools], request.snapshot.profile, this.options.nativeToolExposure, this.programTool()));
      if (canSelectCatalog && restoredCatalog) {
        // No reset was published. Resume ordinary validation of the restored native
        // inventory; changed authority/configuration still requires its own transition.
        this.pendingCompatibilityTransition = false;
      } else if (canSelectCatalog && accepted && rejectedCompatibilityAdmission) {
        throw rejectedCompatibilityAdmission;
      } else {
        throw new ContextContinuityError('unsupported', 'Fresh successor context could not be admitted; the prior context remains committed.');
      }
    }
    if (sourceConflict && !contextPublication.candidateAdmitted) {
      if (!contextPublication.committed) throw sourceConflict;
      // A later rejected proposal cannot invalidate the preceding committed repair.
      await this.options.context?.assertSourceCapacity();
    }
    if (contextPublication.committed) await this.activateCommittedContext(request.modelWindow, request.runId, true);
    // Admission must describe the source boundary actually replayed, not a later
    // capture that could silently claim an unseen correction. The dispatch fence
    // refreshes the window if accepted sources advanced during validation/replay.
    const sourceAccess = this.activeHistorySourceAccess;
    const cut = sourceAccess?.cut ?? await this.options.context?.history.capture();
    const sessionState = (await this.options.context?.sessionState(cut)) ?? {
      id: null, items: []
    };
    const optionalMaterial = await this.options.context?.selectedMaterialContext(cut, request.signal);
    const selectedArtifacts = await this.options.context?.selectedArtifactContext(cut) ?? [];
    const selectedReferenceItems = [...selectedArtifacts, ...(optionalMaterial?.items ?? [])];
    let result: Awaited<ReturnType<typeof assemble>>;
    try {
      result = await assemble(request.modelWindow, sessionState, selectedReferenceItems, undefined, optionalMaterial);
    } catch (error) {
      if (!(error instanceof NativeContextTransitionRequired)) throw error;
      await this.scheduleModelCompatibilityTransition(request.runId);
      return this.assembleModelRequest(request, append, emit, rejected);
    }
    let admissionFailure: ContextAdmissionError | undefined;
    try {
      await admitOrdinary(result.compiled);
      if (rejected)
        throw new ContextAdmissionError(
          rejected,
          new Error('Provider rejected context capacity.'),
          true
        );
    } catch (cause) {
      if (!(cause instanceof ContextAdmissionError)) throw cause;
      admissionFailure = cause;
    }
    if (admissionFailure) {
      this.options.context?.recordAdmission({
        status: 'blocked',
        inputIdentity: result.compiled.inputIdentity,
        accounting: result.compiled.accounting,
        message: admissionFailure.message,
        ...(admissionFailure.providerRejected ? { providerRejected: true } : {}),
        ...(admissionFailure.continuityHeadroomTokens === undefined ? {} :
          { continuityHeadroomTokens: admissionFailure.continuityHeadroomTokens })
      });
      throw admissionFailure;
    }

    // A warning is optional request material. Compile and admit its exact request;
    // failure to prepare it must not invalidate an already admitted ordinary candidate.
    let feedback: Awaited<ReturnType<ContextService['capacityFeedback']>>;
    let feedbackFailure: string | undefined;
    if (this.options.context) {
      try {
        feedback = await this.options.context.capacityFeedback(result.compiled, controlReserves.get(result.compiled.inputIdentity), this.contextControlPolicy.reserveMode);
        if (feedback) {
          capacityNotice = feedback.notice;
          const withFeedback = await assemble(
            request.modelWindow,
            await this.options.context.sessionState(), selectedReferenceItems, undefined, optionalMaterial
          );
          await admitOrdinary(withFeedback.compiled);
          result = withFeedback;
        }
      } catch (error) {
        this.preserveRecoveryFailure(error, request);
        feedback = undefined;
        feedbackFailure = `Capacity notice was not delivered: ${errorMessage(error)}`;
      }
    }

    const { assembly, compiled } = result;
    if (programReceipts.items.some(receipt => !assembly.context.items.some(item => item.id === receipt.id)))
      throw new Error('Admitted request omitted a pending program receipt contribution.');
    const continuityHeadroomTokens = controlReserves.get(compiled.inputIdentity);
    const estimate = requestTokenEstimate({
      accounting: compiled.accounting,
      modelWindowTokens: assembly.estimate.modelWindowTokens,
      contextTokens: assembly.estimate.contextTokens
    });
    const fingerprint: InferenceRequestFingerprintRecord = Object.freeze({
      ...identity,
      requestId: randomUUID(),
      stateSelectionId: result.stateSelectionId,
      compiledInputIdentity: compiled.inputIdentity,
      capabilityRevision: compiled.capabilityRevision,
      configuredContextIds: contextSourceIds(contextInputs.configured, 'configured'),
      providerContextIds: contextSourceIds(contextInputs.provider, 'provider'),
      runContextIds: contextSourceIds(contextInputs.run, 'run'),
      ...(programReceipts.through === undefined ? {} : { programReceiptsThrough: programReceipts.through }),
      effectiveInstructionHash: hashJson(request.snapshot.instructions),
      modelWindowHistoryHash: hashJson(assembly.historyMessages),
      modelToolSchemasHash: hashJson(result.request.tools ?? []),
      modelWindowHash: hashJson(assembly.messages)
    });
    await append({ type: 'prompt.context.delivered', delivery: assembly.context });
    await append({ type: 'prompt.material.selected', material: assembly.material });
    await append({
      type: 'budget.estimate.created',
      ...identity,
      attempt: 1,
      estimate
    });
    this.publishAdmittedCapabilities(compiled, request);
    this.options.context?.recordAdmission({
      status: 'admitted',
      inputIdentity: compiled.inputIdentity,
      accounting: compiled.accounting,
      ...(continuityHeadroomTokens === undefined ? {} : { continuityHeadroomTokens, continuityHeadroomPolicy: this.contextControlPolicy.reserveMode }),
      ...(feedback ? { feedback } : {}),
      ...(feedbackFailure ? { message: feedbackFailure } : {}),
      ...(!feedbackFailure && requestCapacity(result.compiled.accounting, controlReserves.get(result.compiled.inputIdentity), this.contextControlPolicy.reserveMode).pressure === 'continuity'
        ? {
            message:
              'Context is near capacity. Select sources or explicitly renew native continuity; session-state maintenance is not required.'
          }
        : {})
    });
    await this.options.onRequestAdmitted?.({
      requestId: fingerprint.requestId,
      sourceIds: [
        ...request.snapshot.instructions.map((item) => item.id),
        ...assembly.context.items.map((item) => item.id)
      ]
    });
    request.modelWindow.recordAdmission({
      runId: request.runId,
      request: compiled.logicalRequest,
      outputReservation: compiled.accounting.outputReservation,
      presentation: assembly.presentation
    });
    return { request: result.request, compiled, estimate, fingerprint, contextBoundaryRevision: preparationRevision, freshContext: contextPublication.fresh,
      sourceAccess, ...(cut ? { capturedHistoryCut: cut } : {}) };
  }

  private async programReceiptCursor(runId: string): Promise<{ readonly programReceiptsThrough?: number }> {
    const through = await settledProgramReceiptsThrough(runId, this.options.repositories.events);
    return through === undefined ? {} : { programReceiptsThrough: through };
  }

  private boundCapabilitySnapshot(snapshot: Pick<TurnSnapshot, 'profile' | 'tools'>): EffectiveCapabilitySnapshot {
    return this.capabilityCatalog(snapshot.profile, snapshot.profile.modalities.input, snapshot.tools).snapshot;
  }

  private stageAdmittedCapabilities(compiled: CompiledModelRequest, request: Pick<AssistantTurnRequest, 'snapshot'>) {
    const captured = Object.freeze({ inputIdentity: compiled.inputIdentity,
      protocolCapabilityRevision: compiled.capabilityRevision, snapshot: this.boundCapabilitySnapshot(request.snapshot) });
    captureRequestCapabilities(compiled, captured.snapshot);
    return captured;
  }

  /** Publish only after candidate selection and its source/publication fences succeed. */
  private publishAdmittedCapabilities(compiled: CompiledModelRequest, request: Pick<AssistantTurnRequest, 'snapshot'>): void {
    this.lastAdmittedCapabilities = this.stageAdmittedCapabilities(compiled, request);
    if (this.options.context) captureContextCapabilities(this.options.context, this.lastAdmittedCapabilities);
  }

  private async admitContextRequest(
    compiled: CompiledModelRequest,
    request: AssistantTurnRequest,
    append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>
  ): Promise<number | undefined> {
    await this.options.participant?.assertCurrent();
    await this.requestAdmission.admit(compiled, request.snapshot.profile);
    const context = this.options.context;
    if (!this.options.contextRenewal?.automatic || !context ||
        !request.snapshot.tools.some((tool) => isContextActivationTool(tool) || contextControlRole(tool) === 'catalog')) {
      this.stageAdmittedCapabilities(compiled, request);
      return;
    }
    const cut = await context.history.capture();
    const identity = hashJson({
      cut, inputIdentity: compiled.inputIdentity, accounting: compiled.accounting,
      capabilityRevision: compiled.capabilityRevision, provider: compiled.provider,
      profile: request.snapshot.profile,
      configuration: request.snapshot.configuration,
      tools: promptToolSpecs([...request.snapshot.tools], request.snapshot.profile, this.options.toolContext),
      outputReservation: compiled.accounting.outputReservation,
      protectedSources: await context.protectedSources(cut)
    });
    let reserve = this.contextControlReserve?.identity === identity ? this.contextControlReserve.tokens : undefined;
    if (reserve === undefined) {
      const probe = await this.assembleContextRecovery(request,
        new ContextAdmissionError(compiled, new Error('Compiled capacity must leave room for the current bounded context-management request.')),
        append, true, cut);
      reserve = contextControlReserve(compiled, probe.assembly.compiled);
      this.contextControlReserve = { identity, tokens: reserve };
    }
    const remaining = requestCapacity(compiled.accounting, reserve).remainingTokens;
    if (remaining !== undefined && remaining < reserve && this.contextControlPolicy.reserveMode === 'required')
      throw new ContextAdmissionError(compiled,
        new Error(`Compiled request leaves ${String(remaining)} input tokens; the current bounded context-management request requires ${String(reserve)} tokens of continuity room.`),
        false, reserve);
    this.stageAdmittedCapabilities(compiled, request);
    return reserve;
  }

  private preserveRecoveryFailure(error: unknown, request: Pick<AssistantTurnRequest, 'runId' | 'signal' | 'run'>): void {
    request.signal.throwIfAborted();
    if (error instanceof AgentRunOwnershipLostError || error instanceof AgentLimitExceededError ||
        error instanceof InferenceBudgetExceededError) throw error;
    if (request.run.state().control.status !== 'owned')
      throw new AgentRunOwnershipLostError(request.runId);
  }

  private async currentApplicationInstructions(): Promise<AgentEffectiveInstruction[]> {
    const source = this.options.instructions;
    return applicationInstructions(typeof source === 'function' ? await source() : source);
  }

  private async contextWindowForAdmission(
    input: ContextAdmissionInput,
    request: AssistantTurnRequest
  ) {
    if (input.strategy === 'append') {
      if (input.excerpts.length && !request.modelWindow.continuation())
        throw new AppendContextRenewalRequired('Historical excerpts require a fresh request without an exact bound request.');
      const window = new ModelWindow(this.estimator);
      window.replaceWith(request.modelWindow);
      return { window, selection: input.selection };
    }
    if (request.snapshot.profile.capabilities.protocol?.contextReset !== 'fresh_request')
      throw new ContextContinuityError('unsupported', 'The selected provider does not support fresh context renewal.');
    await assertPortableHistoryCompatibility({ sessionId: input.cut.sessionId, entries: input.entries,
      profile: request.snapshot.profile, artifacts: this.options.repositories.artifacts });
    const selection = { ...input.selection, continuity: {
      kind: 'fresh' as const,
      historyPosition: input.cut,
      resetId: `renewal-${hashJson({ cut: input.cut, state: input.sessionState.id, model: request.snapshot.configuration.model })}`,
      model: { provider: request.snapshot.profile.provider, model: request.snapshot.configuration.model,
        ...(request.snapshot.configuration.reasoning === undefined ? {} : { reasoning: request.snapshot.configuration.reasoning }),
        ...(request.snapshot.configuration.temperature === undefined ? {} : { temperature: request.snapshot.configuration.temperature }) },
      sources: input.selection.retained
    } };
    const window = new ModelWindow(this.estimator);
    await replaySourceEntries(window, input.cut.sessionId, input.entries,
      this.options.repositories.artifacts,
      new Set(selection.retained.map(source => source.entryId)), request.runId);
    recordContextExcerpts(window, input.excerpts);
    return { window, selection };
  }

  /** Reconcile committed sources against the contributions already applied to this window. */
  private async refreshAdvancedHistory(
    window: ModelWindow,
    runId: string,
    captured: import('./history/contracts.js').HistorySourceCut | undefined
  ): Promise<boolean> {
    if (!captured || !this.options.context) return false;
    const history = this.options.context.history;
    const current = await history.capture();
    if (hashJson(current) === hashJson(captured)) return false;
    if (current.branchId === captured.branchId && await history.extendsCut(captured, current) &&
        (await history.selectedContext(current))?.windowId === (await history.selectedContext(captured))?.windowId) {
      let cursor: string | undefined;
      let applied = true;
      do {
        const page = await history.metadataPage({ cut: current, after: captured, cursor, limit: 1000 });
        for (const item of page.items) {
          if (item.source.event?.runId !== runId ||
              !window.hasAppliedSource(item.source.event)) {
            applied = false;
            break;
          }
        }
        if (!applied) break;
        cursor = page.cursor;
      } while (cursor);
      if (applied) {
        // Never acknowledge an arbitrary fresh capture: every intervening source
        // must have an exact committed identity already delivered to the window.
        if (!this.activeHistorySourceAccess || hashJson(this.activeHistorySourceAccess.cut) !== hashJson(captured))
          throw new Error('Incremental history advancement requires the captured model-window sources.');
        this.activeHistorySourceAccess = Object.freeze({ ...this.activeHistorySourceAccess, cut: current });
        return false;
      }
    }
    await this.activateCommittedContext(window, runId, true);
    return true;
  }

  private async activateCommittedContext(window: ModelWindow, runId: string, refresh = false): Promise<void> {
    if (!this.options.context || !this.options.repositories.session) return;
    if (this.activeRunDriver) assertToolTransitionBoundary(this.activeRunDriver.state());
    // An unchanged committed window needs no source planning or session-state read.
    const contextWindow = await this.options.context.history.selectedContext();
    const windowId = contextWindow?.windowId ?? null;
    const profile = await this.options.provider.describeModel(this.options.model);
    const identity = hashJson({
      windowId,
      provider: this.options.provider.id,
      model: this.options.model,
      protocol: profile.capabilities.protocol ?? null
    });
    if (!refresh && this.activeContextIdentity === identity) return;
    let replay;
    try {
      replay = await rebuildModelWindowFromRepositories({
        readInferenceInput: (runId, invocationId) =>
          this.inferenceService.admittedInput(this.options.inferenceOwnerId ?? runId, invocationId),
        ...(this.history ? { history: this.history } : {}),
        events: this.options.repositories.events,
        ...(this.options.repositories.artifacts
          ? { artifacts: this.options.repositories.artifacts }
          : {}),
        estimator: this.estimator,
        profile,
        currentRunId: runId,
        runIds: [runId]
      });
    } catch (error) {
      if (!(error instanceof NativeContextIncompatibilityError)) throw error;
      await this.scheduleModelCompatibilityTransition(runId);
      return;
    }
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
    window.replaceWith(replay.modelWindow);
    this.activeHistorySourceAccess = replay.historySourceAccess;
    this.activeContextIdentity = identity;
    this.pendingCompatibilityTransition = false;
  }

  /** A model choice requests fresh source replay; publication still requires its actual successor. */
  private async scheduleModelCompatibilityTransition(runId: string): Promise<void> {
    const context = this.options.context;
    if (!context || !this.contextTransitions)
      throw new Error('Incompatible native context requires source-backed successor admission.');
    this.pendingCompatibilityTransition = true;
    // A restored or explicit proposal is resolved before ordinary context may be dispatched.
    if (this.contextTransitions.hasPending()) return;
    const cut = await context.history.capture();
    const window = await context.history.selectedContext(cut);
    const model = { provider: this.options.provider.id, model: this.options.model,
      ...(this.options.reasoning === undefined ? {} : { reasoning: this.options.reasoning }),
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }) };
    const resetId = `model-${hashJson({ runId, model, windowId: window?.windowId ?? null })}`;
    const selection = await context.selectSources(cut, {});
    await this.contextTransitions.schedule({
      expectedWindowId: window?.windowId ?? null,
      idempotencyKey: resetId,
      reason: 'Admit original sources for the selected model.',
      renewal: true,
      selection
    });
  }

  async scheduleContextTransition(
    request: ContextTransitionRequest
  ): Promise<{ readonly requestId: string }> {
    if (!this.options.context || !this.activeRunDriver || !this.contextTransitions)
      throw new Error('Context scheduling requires an active runtime with a context service.');
    return this.contextTransitions.schedule(request);
  }

  private async retainPendingSources(
    transition: ContextTransitionRequest,
    runId: string
  ): Promise<ContextTransitionRequest> {
    if (!this.options.context) throw new Error('Context service is unavailable.');
    const cut = await this.options.context.history.capture();
    const window = await this.options.context.history.selectedContext(cut);
    if ((window?.windowId ?? null) !== transition.expectedWindowId)
      throw new Error('Context selection window is stale.');
    if (!transition.toolInvocation && transition.expectedSourceRevision !== undefined &&
        transition.expectedSourceRevision !== cut.sourceRevision)
      throw new Error('Context selection source revision is stale.');
    const retained = new Map(
      transition.selection.retained.map((reference) => [reference.entryId, reference])
    );
    for (const source of await this.options.context.protectedSources(cut))
      retained.set(source.entryId, source);
    if (transition.toolInvocation) {
      if (transition.toolInvocation.runId !== runId)
        throw new Error('Context operation belongs to another run.');
      if (!transition.expectedCut || transition.expectedCut.sourceRevision !== transition.expectedSourceRevision)
        throw new Error('Context tool operation is missing its exact authorized source boundary.');
      const expected = transition.expectedCut;
      const exchangeId = assistantResponseKey(runId, transition.toolInvocation);
      const toolSources = await this.options.context.history.toolSources(transition.toolInvocation, cut);
      const originCatalog = (await this.recordedTurnSnapshot(runId, transition.toolInvocation)).toolCatalog;
      const originTools = this.catalogTools.get(originCatalog.revision) ?? this.tools;
      let toolCallId: string | undefined;
      let originInput: import('@agent-core/persistence').ProtectedArtifactRef | undefined;
      for (const source of toolSources) {
        retained.set(source.entryId, source);
        const entry = await this.options.context.history.resolve(source, cut, 1024 * 1024);
        if (entry?.type === 'tool_call' && entry.callIndex === transition.toolInvocation.callIndex) {
          const name = decodeToolCall(entry.call).name;
          const definition = originTools.find(tool => tool.name === name);
          const captured = originCatalog.entries.find(tool => tool.name === name);
          const current = definition ? captureToolCatalog([definition]).entries[0] : undefined;
          if (isContextActivationTool(definition) && current && captured && hashJson(current) === hashJson(captured))
            toolCallId = entry.callId;
        }
        if (entry?.type === 'assistant') originInput = entry.inferenceInput;
      }
      let acknowledged = false;
      let cursor: string | undefined;
      let scanned = 0;
      do {
        const page = await this.options.context.history.metadataPage({
          cut, after: expected, ...(cursor ? { cursor } : {}), limit: 100, maxBytes: 32768
        });
        scanned += page.scanned;
        if (scanned > 1000)
          throw new Error('Context source boundary exceeds its bounded validation.');
        for (const item of page.items) {
          if (item.type === 'context_transition' || (item.runId === runId && item.exchangeId === exchangeId)) continue;
          // A mandatory native tool receipt can settle one response before the connection
          // reaches a fresh-request boundary. Only its exact durable causal successor is allowed.
          const entry = item.type === 'assistant' && item.runId === runId && !acknowledged
            ? await this.options.context.history.resolve(item.source, cut, 1024 * 1024)
            : undefined;
          if (entry?.type !== 'assistant' || entry.completeness !== 'complete' ||
              entry.output?.some(output => output.type === 'tool_call' || output.type === 'media') ||
              !toolCallId || !originInput || !entry.inferenceInput ||
              !await this.inferenceService.isNativeAcknowledgement(
                this.options.inferenceOwnerId ?? runId,
                await this.inferenceService.inputInvocationId(this.options.inferenceOwnerId ?? runId, entry.inferenceInput),
                await this.inferenceService.inputInvocationId(this.options.inferenceOwnerId ?? runId, originInput),
                toolCallId))
            throw new Error('Context source boundary changed beyond the originating tool exchange.');
          retained.set(item.source.entryId, item.source);
          acknowledged = true;
        }
        cursor = page.cursor;
      } while (cursor);
    }
    const completed = await this.options.context.selectSources(cut, {
      retain: [...retained.values()]
    });
    for (const source of completed.retained) retained.set(source.entryId, source);
    const candidate = {
      ...transition.selection,
      retained: await this.options.context.history.orderSources([...retained.values()], cut)
    };
    return {
      ...transition,
      expectedSourceRevision: cut.sourceRevision,
      selection: candidate
    };
  }

  pendingToolCalls() {
    return this.activeRunDriver ? pendingToolCalls(this.activeRunDriver.state()) : [];
  }

  private async reportActivity(
    runId: string,
    controller: AgentRunBudget,
    append: (event: AgentAuditEvent) => Promise<unknown>,
    emit: (event: AgentProgressEvent) => Promise<void>
  ): Promise<void> {
    if (!this.activeRunDriver) throw new Error('Run activity requires its current driver.');
    const phase = agentRunActivity(this.activeRunDriver.state());
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
    const requiredCatalogs = new Set(
      run.state().toolBatches.map((batch) => batch.source.catalog.revision)
    );
    const latestCatalog = [...this.catalogTools.keys()].at(-1);
    if (latestCatalog) requiredCatalogs.add(latestCatalog);
    for (const revision of this.catalogTools.keys())
      if (!requiredCatalogs.has(revision)) this.catalogTools.delete(revision);
  }
  private async settleToolEffect(
    run: AgentRunDriver,
    input: Parameters<AgentRunCoordinator['settleToolEffect']>[1]
  ): Promise<'owned' | 'ownership_lost'> {
    const synchronized = await run.settleToolEffect(input);
    const control = synchronized.state.control;
    return (control.status === 'owned' || control.status === 'abort_requested') &&
      control.driverId === run.driverId
      ? 'owned'
      : 'ownership_lost';
  }
  private approvalSuspension(
    state: import('./run/control/contracts.js').AgentRunState
  ): AgentRunResult {
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
  private async readProviderSettlement(
    runId: string,
    effectId: string,
    responseId: string,
    reference?: import('@agent-core/persistence').EventReference
  ) {
    const source =
      reference ??
      (await this.options.repositories.events.referenceByKey(
        runId,
        providerSettlementKey(effectId, responseId)
      ));
    if (!source) return undefined;
    if (source.runId !== runId) throw new Error('Provider settlement belongs to another run.');
    const record = await this.options.repositories.events.readReference(source);
    if (
      (record.event.type !== 'provider.attempt.settled' &&
        record.event.type !== 'provider.attempt.failed') ||
      record.event.effectId !== effectId ||
      record.event.responseId !== responseId
    )
      throw new Error(
        'Provider settlement reference does not match its effect and response identity.'
      );
    return Object.freeze({ reference: source, event: record.event });
  }
  private async reconcileDurableToolBatch(
    run: AgentRunDriver,
    signal: AbortSignal
  ): Promise<boolean> {
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
          .toolBatches.some((batch) =>
            batch.callStates.some((call) => call.stage === 'outcome_unknown')
          );
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
          if (!(error instanceof AgentRunConflictError) || error.reason !== 'stale_tail')
            throw error;
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
          if (!(error instanceof AgentRunConflictError) || error.reason !== 'stale_tail')
            throw error;
          const current = run
            .state()
            .toolBatches.find((batch) => batch.toolBatchId === phase.toolBatchId)?.callStates[
            callIndex
          ];
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
    if (callState.effect.intent.recovery.kind === 'unknown' ||
        (!phase.source.program && phase.calls[callIndex]?.name === this.options.programRunner?.toolName)) return false;
    const call = phase.calls[callIndex];
    if (!call)
      throw new Error(
        `Run ${run.state().runId} has no tool call for effect ${callState.effect.intent.effectId}.`
      );
    const caller = toolInvocationCaller(phase, callIndex);
    const context = Object.freeze({
      ...this.toolContext(signal),
      recordedCanonicalInput: callState.plan.canonicalInput,
      invocation: Object.freeze({
        runId: run.state().runId,
        ...phase.identity,
        toolBatchId: phase.toolBatchId,
        callIndex,
        ...(call.id ? { callId: call.id } : {}),
        toolAttempt: callState.toolAttempt,
        ...(caller ? { caller } : {})
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
          ...(this.options.context && this.options.contextRenewal?.automatic
            ? { maxPresentationBytes: this.contextControlPolicy.resultBytes } : {}),
          ...(this.options.repositories.artifacts
            ? { artifacts: this.options.repositories.artifacts }
            : {})
        });
        const tool = this.tools.find(
          (modelOutput) =>
            modelOutput.name === call.name &&
            modelOutput.implementationId === plan.toolImplementationId
        );
        const committed = await observationStore.commitToolObservation({
          turnIndex: phase.identity.turnIndex,
          call,
          canonicalSnapshot: plan.canonicalSnapshot,
          tool,
          observation: recovery.observation,
          modelInputModalities: phase.modelInputModalities
        });
        const settlement = {
          observationId: committed.id,
          ...(committed.durableObservation ? { observation: committed.durableObservation } : {}),
          original: committed.original,
          modelContent: committed.modelContent,
          ...(committed.modelContentRef ? { modelContentRef: committed.modelContentRef } : {}),
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
    const settlement = await this.readProviderSettlement(
      state.runId,
      phase.effect.intent.effectId,
      phase.responseId,
      phase.settlementReference
    );
    if (settlement?.event.type !== 'provider.attempt.settled')
      throw new Error(
        `Run ${state.runId} is missing its exact provider settlement ${phase.settlementReference.eventId}.`
      );
    let turnSnapshot: AgentTurnSnapshotRecord | undefined;
    let requestEstimate: RequestTokenEstimate | undefined;
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
      instructions: turnSnapshot.resumeInstructions ?? turnSnapshot.instructions,
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
      if (state.phase.kind === 'terminal')
        throw new Error(`Run ${state.runId} is already terminal.`);
      const next = nextAgentRunInstruction(state);
      if (next.kind !== 'execute')
        throw new Error(
          `Run ${state.runId} requires ${next.kind === 'wait' ? next.reason : 'completion'} instead of finalization.`
        );
      const instruction = next.procedure;
      if (
        state.toolBatches.some((batch) =>
          batch.callStates.some(
            (call) =>
              call.stage !== 'recorded' && call.stage !== 'resolved' && call.stage !== 'cancelled'
          )
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
          if (settled?.stage !== 'settled' && settled?.stage !== 'failed')
            throw new Error('Finalization requires its settled provider attempt.');
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
          await this.advanceRun(run, instruction, {
            phase: { kind: 'finalization', stage: 'ready' },
            budget
          });
          continue;
        case 'finalize_abort':
        case 'start_provider_request': {
          const providerRequests = await Promise.all(
            state.providerRequests.map(async (request) => {
              if (request.stage !== 'effect_ready') return request;
              await this.inferenceService.cancelBeforeDispatch(
                {
                  ownerId: this.options.inferenceOwnerId ?? state.runId,
                  ...this.options.inferenceScope,
                  invocationId: request.invocationId,
                  runId: state.runId
                },
                'Run ended before provider dispatch.'
              );
              return {
                ...request,
                stage: 'cancelled' as const,
                effect: closeExternalEffect(request.effect, 'cancelled_before_start')
              };
            })
          );
          await this.advanceRun(run, instruction, {
            phase: { kind: 'finalization', stage: 'ready' },
            providerRequests,
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
        ...(input.origin === undefined ? {} : { origin: parseSessionSubmissionOrigin(input.origin) }),
        ...(input.images === undefined ? {} : { images: parseSessionImages(input.images) }),
        instructions: Object.freeze([...(input.instructions ?? [])]),
        contextItems: Object.freeze(
          (input.contextItems ?? []).map((item) => decodePromptContextItemInput(item))
        )
      }),
      configuration: this.currentRunConfiguration()
    });
  }
  private assertRunImplementation(state: AgentRunState): void {
    const current = this.currentRunConfiguration();
    if (state.configuration.runtimeImplementationId !== current.runtimeImplementationId)
      throw new Error(`Run ${state.runId} uses an incompatible runtime implementation; its records were not changed.`);
    if (state.phase.kind !== 'terminal' && !this.nonToolConfigurationMatches(state.configuration, current))
      throw new Error(`Run ${state.runId} was captured for a different runtime configuration; its records were not changed.`);
  }
  private nonToolConfigurationMatches(captured: AgentRunState['configuration'], current: AgentRunState['configuration']): boolean {
    return hashJson({ ...captured, toolImplementationIds: [] }) === hashJson({ ...current, toolImplementationIds: [] });
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
    const nonToolConfigurationMatches = this.nonToolConfigurationMatches(captured, current);
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
      runtimeImplementationId: 'agent-core.runtime.run-v2',
      toolImplementationIds: Object.freeze(this.tools.map((tool) => tool.implementationId)),
      policyHash: hashJson({
        policy: this.toolPolicy,
        resourceLifetime: this.options.resources?.lifetime ?? { kind: 'run' },
        inferenceOwnerId: this.options.inferenceOwnerId ?? null,
        inferenceScope: this.options.inferenceScope ?? null,
        supervisorGroupId: this.options.supervisor?.groupId ?? null,
        participant: this.options.participant ? {
          groupId: this.options.participant.groupId,
          participantId: this.options.participant.participantId,
          sessionId: this.options.participant.sessionId,
          assignmentId: this.options.participant.assignmentId,
          assignmentRevision: this.options.participant.assignmentRevision,
          correctionEpoch: this.options.participant.correctionEpoch,
          capabilityRevision: this.options.participant.capabilityRevision
        } : null,
        nativeToolExposure: this.options.nativeToolExposure ?? null,
        programRunner: this.options.programRunner ? { toolName: this.options.programRunner.toolName, configurationRevision: this.options.programRunner.configurationRevision, maxConcurrentPrograms: this.options.programRunner.maxConcurrentPrograms ?? 1 } : null
      })
    });
  }
  private captureRuntimeConfiguration(): RuntimeModelConfiguration {
    return Object.freeze({
      model: this.options.model,
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      ...(this.options.reasoning === undefined ? {} : { reasoning: this.options.reasoning }),
      ...(this.options.responseFormat === undefined
        ? {}
        : { responseFormat: this.options.responseFormat })
    });
  }
  private toolContext(signal: AbortSignal): ToolPlanningContext {
    const services = {
      ...(this.options.toolContext?.services ?? {}),
      ...(this.options.programRunner && this.options.repositories.artifacts ? {
        programExecution: Object.freeze({ execute() {
          throw new Error('Program execution requires its bound tool invocation.');
        } })
      } : {}),
      ...(this.options.repositories.artifacts
        ? { artifactRepository: this.options.repositories.artifacts }
        : {})
    };
    return {
      ...(this.options.toolContext ?? {}),
      ...(Object.keys(services).length > 0 ? { services } : {}),
      policy: this.toolPolicy,
      signal,
      observationSignal: this.observationController.signal,
      boundary: this.options.toolBoundary,
      ...(this.options.resources?.lifetime.kind === 'owner'
        ? { resourceOwnerId: this.options.resources.lifetime.ownerId }
        : {})
    };
  }
  private requestHasRevocableMaterial(compiled: CompiledModelRequest): boolean {
    const use = this.inferenceService.presentationFor(compiled);
    return (use?.materialDependencies?.length ?? 0) > 0 || (use?.skillReferences?.length ?? 0) > 0;
  }
  private async assertRequestMaterial(compiled: CompiledModelRequest): Promise<void> {
    const use = this.inferenceService.presentationFor(compiled);
    if (!use || !this.requestHasRevocableMaterial(compiled)) return;
    if (!this.options.context) throw new Error('Retained request material no longer has a host context authority.');
    await this.options.context.assertMaterialUse(use);
  }
  private async withRequestMaterial<T>(compiled: CompiledModelRequest, operation: () => Promise<T>): Promise<T> {
    const use = this.inferenceService.presentationFor(compiled);
    if (!use || !this.requestHasRevocableMaterial(compiled)) return operation();
    if (!this.options.context) throw new Error('Retained request material no longer has a host context authority.');
    return this.options.context.withMaterialUse(use, operation);
  }
  private contextBoundaryRevision = 0;
  private readonly contextCollectionOwner = {};
  private async collectContextItems(
    input: AgentRunInput,
    turnIndex: number,
    instructions: readonly AgentEffectiveInstruction[],
    request: AssistantTurnRequest
  ): Promise<ResolvedContextInputs> {
    const contextRevision = this.contextBoundaryRevision;
    const cut = await this.options.context?.history.capture();
    const boundary = Object.freeze({ runId: request.runId, ...turnIdentity(request.snapshot.record), instructionHash: hashJson(instructions), ...(cut ? { historyCut: cut } : {}) });
    const collection = this.options.contextProvider ? await collectOptionalContext({
      owner: this.contextCollectionOwner, provider: this.options.contextProvider, request: { task: input.task, turnIndex, instructions, boundary }, signal: request.signal, obsoleteSignal: this.observationController.signal,
      ...(this.options.contextProviderPolicy ? { policy: this.options.contextProviderPolicy } : {}),
      isCurrent: async () => contextRevision === this.contextBoundaryRevision && this.activeRunId === request.runId && (!cut || hashJson(await this.options.context?.history.capture()) === hashJson(cut)),
      validateCandidates: async (candidates, signal) => {
        signal.throwIfAborted();
        if (candidates.materials?.length) {
          if (!this.options.context?.materials) throw new Error('No material scopes are granted.');
          await this.options.context.materials.captureDependencies(candidates.materials);
        }
        if (candidates.skills?.length) {
          if (!this.options.context?.skills) throw new Error('No skill sources are granted.');
          await this.options.context.skills.assertAvailable(candidates.skills, signal);
        }
      }
    }) : { result: { items: [] } };
    const providerItems: PromptContextItemInput[] = [...collection.result.items];
    const candidates = collection.result.candidates ? contextRecallNotice(collection.result.candidates) : undefined;
    if (candidates) providerItems.push(candidates);
    if (collection.diagnostic) providerItems.push({ id: `context-diagnostic:${hashJson(boundary)}`, sourceUri: 'runtime://optional-context-diagnostic', sourceKind: 'generated', representation: 'full', mediaType: 'text/plain', title: 'Optional context unavailable',
      purpose: 'Bounded retrieval status, not evidence that no relevant retained material exists.', content: `Optional retrieval ${collection.diagnostic}; committed selections and mandatory current input are unchanged.` });
    return Object.freeze({ configured: Object.freeze([...(this.options.contextItems ?? [])]), provider: Object.freeze(providerItems), run: Object.freeze([...(input.contextItems ?? [])]) });
  }
  private readonly authorizeTool: ToolAuthorizer = request => {
    const tool = this.tools.find(tool => tool.name === request.call.name && tool.implementationId === request.toolImplementationId);
    return authorizeCollaborationToolEffects(request, tool) ?? authorizeToolCatalogEffects(request, tool) ?? (this.options.toolAuthorizer ?? POLICY_TOOL_AUTHORIZER)(request);
  };
  private async refreshTools(signal?: AbortSignal): Promise<void> {
    const tools = await resolveRuntimeToolCatalog(this.toolCatalog, signal);
    this.assertParticipantTools(tools);
    this.tools = tools;
  }

  private assertParticipantTools(tools: readonly CompiledToolDefinition[]): void {
    const grant = this.options.participant?.capabilities;
    if (grant && tools.some(tool => !grant.toolNames.includes(tool.name)))
      throw new Error('Participant tool catalog exceeds its admitted capability grant.');
  }
  private toolHostRequirements(modelInputModalities?: ModelProfile['modalities']['input']) {
    const context = this.toolContext(new AbortController().signal);
    return { ...(context.services ? { services: context.services } : {}),
      ...(modelInputModalities ? { modelInputModalities } : {}),
      hostCapabilities: this.options.resources?.capabilities ?? [] };
  }
  private capabilityCatalog(profile?: ModelProfile, modelInputModalities = profile?.modalities.input,
    tools: readonly CompiledToolDefinition[] = this.tools) {
    const host = this.toolHostRequirements(modelInputModalities);
    const programTool = this.programTool();
    return resolveEffectiveToolCatalog({
      bindingId: this.options.modelBindingId ?? hashJson({ provider: this.options.provider.id, implementationId: this.options.provider.implementationId,
        model: this.options.model, profile: profile ?? null }),
      tools, policy: this.toolPolicy, host,
      programmaticRunner: !!programTool && resolveToolHostEligibility({ tools: [programTool], policy: this.toolPolicy, host }).length === 1,
      ...(this.options.nativeToolExposure ? { nativeToolExposure: this.options.nativeToolExposure } : {}),
      ...(profile ? { modelProfile: profile } : {}),
      ...(programTool ? { eagerTool: programTool } : {})
    });
  }
  private availableTools(profile?: ModelProfile, modelInputModalities = profile?.modalities.input): CompiledToolDefinition[] {
    return [...this.capabilityCatalog(profile, modelInputModalities).tools];
  }
  private async releaseOwnedResources(
    runId: string,
    append: (event: AgentAuditEvent, idempotencyKey?: string) => Promise<unknown>
  ): Promise<Error | undefined> {
    const resources = this.options.resources;
    if (!resources || resources.lifetime.kind === 'owner') return undefined;
    try {
      for (const report of await resources.release(runId)) {
        await commitResourceRelease({
          runId, report, events: this.options.repositories.events, append,
          acknowledge: (resourceId) => resources.acknowledge(resourceId)
        });
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
    // Rotate only at the model boundary. Calls dispatched after steering was accepted
    // must still see the latched yield, including calls in the same ordinary batch.
    if (selected.length > 0) this.observationController = new AbortController();
    if (!this.nativeSteering) return selected.map((item) => item.instruction);
    for (const item of selected) await this.nativeSteering.accept(item.id, item.instruction);
    return (await this.nativeSteering.nextRequestInputs()).map((item) => item.content);
  }
  private injectSteering(runId: string, input: AgentSteeringInput): AgentSteeringReceipt {
    if (this.activeRunId !== runId) throw new Error(`Run ${runId} is not active.`);
    if (input.instruction.trim().length === 0)
      throw new Error('Steering instruction must not be empty.');
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
    this.contextBoundaryRevision++;
    this.observationController.abort('Steering accepted; yield the current observation.');
    const steering = this.nativeSteering;
    if (steering)
      this.steeringWrites = this.steeringWrites.then(() =>
        steering.accept(receipt.id, input.instruction)
      );
    return receipt;
  }
  private async abortRun(runId: string, reason = 'Agent run aborted.'): Promise<void> {
    const runReady = this.activeRunReady;
    if (this.activeRunId !== runId || !runReady) return;
    const driver = await runReady;
    if (this.activeRunId !== runId || this.activeRunReady !== runReady || !driver) return;
    await driver.requestAbort(reason);
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

function cleanupFailureDecision(
  previous: TerminalDecision | undefined,
  error: Error
): TerminalDecision {
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
  controller: AgentRunBudget,
  parentSignal: AbortSignal
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const remaining = controller.remainingElapsedMs();
  if (remaining === undefined) return { signal: parentSignal, dispose: () => undefined };
  const timeout = new AbortController();
  const schedule = (milliseconds: number) =>
    setTimeout(checkDeadline, Math.min(milliseconds + 1, 2_147_483_647));
  const checkDeadline = (): void => {
    try {
      const next = controller.remainingElapsedMs();
      if (next !== undefined) timer = schedule(next);
    } catch (error) {
      timeout.abort(error);
    }
  };
  let timer = schedule(remaining);
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
  controller: AgentRunBudget
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
      modelOutput.status === 'absent'
        ? modelOutput
        : Object.freeze({ ...modelOutput, status: 'partial' });
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
  const source = 'content' as const;
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
function failedGenerationDecision(
  diagnostic: import('@agent-core/model').ModelProviderErrorDiagnostic,
  turnIndex: number
): TerminalDecision {
  return {
    executionStatus: 'failed',
    terminationReason: 'provider_error',
    modelOutput: { status: 'absent' },
    errorMessage:
      typeof diagnostic.causeSummary?.message === 'string'
        ? diagnostic.causeSummary.message
        : 'Provider generation failed.',
    turnCount: turnIndex,
    diagnostic: { ...diagnostic, turnIndex }
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
function decisionBeforeFinalization(
  decision: TerminalDecision,
  signal: AbortSignal
): TerminalDecision {
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
function steeringInstructions(
  input: readonly string[],
  offset: number
): AgentEffectiveInstruction[] {
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
function runInput(
  state: import('./run/control/contracts.js').AgentRunState,
  signal?: AbortSignal
): ResolvedAgentRunInput {
  return {
    task: state.input.task,
    ...(state.input.origin === undefined ? {} : { origin: state.input.origin }),
    ...(state.input.images === undefined ? {} : { images: state.input.images }),
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateToolBoundary(value: unknown): asserts value is ToolAuthorizationBoundary {
  if (!isRecord(value)) throw new Error('toolBoundary must be an object.');
  for (const [name, member] of Object.entries(value)) {
    if (typeof member !== 'string' || member.trim().length === 0)
      throw new Error(`toolBoundary.${name} must be a non-empty string.`);
  }
  if (
    typeof value.authorizationPolicyId !== 'string' ||
    typeof value.executionTargetId !== 'string'
  )
    throw new Error('toolBoundary requires authorizationPolicyId and executionTargetId.');
}
function removeRunItems(items: { readonly runId: string }[], runId: string): void {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (items[index]?.runId === runId) items.splice(index, 1);
}
function assertQueueCapacity(items: readonly unknown[], maximum: number, label: string): void {
  if (items.length >= maximum)
    throw new Error(`${label} queue limit of ${String(maximum)} was reached.`);
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
    ...('effectId' in phase && phase.effectId ? { effectId: phase.effectId } : {}),
    ...(phase.reason === 'context_admission' ? { contextAdmission: phase.conflict } : {})
  };
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
    throw new Error(
      `Run ${state.runId} has no durable budget at its tool implementation boundary.`
    );
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

function promptInstructionRole(role: string | undefined): PromptInstruction['role'] {
  if (role === undefined) return 'developer';
  if (role === 'system' || role === 'developer' || role === 'user') return role;
  throw new Error(`Unsupported declared instruction authority: ${role}.`);
}

function currentProviderRequest(state: AgentRunState): AgentProviderPhase | undefined {
  return state.providerRequests.find(
    (request) => request.stage !== 'consumed' && request.stage !== 'cancelled'
  );
}
function currentToolBatch(state: AgentRunState): AgentToolPhase | undefined {
  return state.toolBatches.find((batch) =>
    batch.callStates.some(
      (call) => call.stage !== 'recorded' && call.stage !== 'resolved' && call.stage !== 'cancelled'
    )
  );
}
function findPendingApproval(
  state: AgentRunState,
  approvalId?: string
):
  | {
      readonly batch: AgentToolPhase;
      readonly callIndex: number;
      readonly approval: AgentApprovalRequest;
    }
  | undefined {
  for (const batch of state.toolBatches)
    for (const [callIndex, call] of batch.callStates.entries())
      if (call.stage === 'approval' && (!approvalId || call.approval.approvalId === approvalId))
        return { batch, callIndex, approval: call.approval };
  return undefined;
}

function requestCapacityConflict(
  error: ContextAdmissionError,
  reservationPolicy?: { readonly minimum: number; readonly maximum: number }
): import('./run/context-admission.js').ContextAdmissionConflict {
  const { inputIdentity, accounting } = error.compiled;
  return {
    kind: error.providerRejected ? 'provider_capacity' : 'request_capacity',
    message: textRange(error.message, 0, 8192).text,
    inputIdentity,
    estimatedInputTokens: accounting.estimatedInputTokens,
    outputReservation: accounting.outputReservation,
    reasoningReservation: accounting.reasoningReservation,
    ...(accounting.limits.contextTokens === undefined
      ? {}
      : { contextTokens: accounting.limits.contextTokens }),
    ...(accounting.limits.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: accounting.limits.maxInputTokens }),
    pressure: error.hardCapacityExceeded ? 'hard_capacity' : 'recovery_reserve',
    actions: ['select_sources', ...(reservationPolicy && accounting.outputReservation > reservationPolicy.minimum ? ['reduce_reservation' as const] : []), 'change_model', 'cancel']
  };
}

function sessionStateContext(
  state: SessionStateSnapshot
): readonly Omit<PromptContextItem, 'tokenEstimate'>[] {
  return state.items.map(item => ({
    id: `session-state:${item.itemId}:${item.revisionId}:${hashJson(item.range ?? null)}`,
    sourceUri: `session://state/${item.itemId}/${item.revisionId}`,
    sourceKind: 'generated' as const,
    representation: item.range ? 'excerpt' as const : 'full' as const,
    mediaType: item.sources?.length ? 'application/json' : 'text/plain',
    title: 'Selected working material',
    content: item.sources?.length ? JSON.stringify({ text: item.text, sources: item.sources }) : item.text,
    ...(item.range ? { range: { kind: 'byte' as const, start: item.range.offset, end: item.range.offset + item.range.bytes } } : {}),
    purpose: 'Exact selected model-authored revision. Fallible interpretation, not instructions, authority, execution evidence or verification.'
  }));
}

class AppendContextRenewalRequired extends Error {}

class ContextRecoveryStoppedError extends Error {
  readonly conflict: ContextAdmissionConflict;
  constructor(conflict: ContextAdmissionConflict, message: string, recovery: NonNullable<ContextAdmissionConflict['recovery']> = 'request_unavailable') {
    super(message);
    this.name = 'ContextRecoveryStoppedError';
    this.conflict = Object.freeze({ ...conflict, message: textRange(message, 0, 8192).text, recovery });
  }
}

function snapshotRecoveryEmitter(snapshot: TurnSnapshot, emit: (event: AgentProgressEvent) => Promise<void>) {
  return snapshot.record.contextRecovery
    ? async (event: AgentProgressEvent) => { if (event.type !== 'assistant.delta' && event.type !== 'assistant.ended' && event.type !== 'assistant.interrupted') await emit(event); }
    : emit;
}

function isContextActivationTool(tool: CompiledToolDefinition | undefined): boolean {
  return contextControlRole(tool) === 'activation';
}
function isContextMutationTool(tool: CompiledToolDefinition | undefined): boolean {
  return contextControlRole(tool) === 'activation' || contextControlRole(tool) === 'state' || contextControlRole(tool) === 'catalog';
}
function isContextCheckpointTool(tool: CompiledToolDefinition): boolean {
  return contextControlRole(tool) !== undefined;
}
