import { randomUUID } from 'node:crypto';
import { type ContextHistoryReduction, type ContextItemInput, ContextManager } from './context/manager.js';
import { hashJson } from '@agent-core/evidence';
import { normalizeJsonSafe, parseJsonValue } from '@agent-core/json';
import {
  createModelRequest,
  ModelContractError,
  type ModelProfile,
  type ModelProvider,
  type ModelProviderErrorDiagnostic,
  type ModelProviderSession,
  type ModelProviderSessionRetryDisposition,
  type ModelReasoningRequest,
  type ModelRequest,
  type ModelResponse,
  type ModelResponseFormat,
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
  type AgentPresentCandidate,
  type AgentRequestSnapshotRecord,
  type AgentRunLimits,
  type AgentRunResult,
  type AgentRunRetryPolicy,
  type AgentTerminalSnapshot,
  type AgentTurnIdentity,
  type AgentTurnSnapshotRecord,
  type AgentVerificationExecutionContext
} from './run/contracts.js';
import {
  isToolAvailable,
  prepareToolCall,
  parseToolPolicy,
  READ_ONLY_TOOL_POLICY,
  ResourceLeaseCoordinator,
  toolRequirementsSatisfied,
  ToolRegistry,
  type ToolAuthorizer,
  type ToolCall,
  type ToolDefinition,
  type ToolAuthorizationBoundary,
  type ToolExecutionContext,
  type ToolPreparationContext,
  type ToolPolicy
} from '@agent-core/tools';
import type { AgentEvent, AgentProgressEvent } from './events.js';
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
import { storeProviderStateArtifact } from './orchestration/provider-state-artifacts.js';
import { AgentLimitExceededError, AgentRunController } from './orchestration/run-controller.js';
import { rebuildContextFromRepositories } from './orchestration/session-replay.js';
import { executeAssistantToolCalls, type ToolAuthorizationOverride, type ToolCallRecoveryState } from './orchestration/tool-execution.js';

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
  readonly tools?: readonly ToolDefinition[];
  readonly toolBoundary: ToolAuthorizationBoundary;
  readonly toolContext?: Omit<ToolExecutionContext, 'policy' | 'signal'>;
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
  readonly retryPolicy?: Partial<AgentRunRetryPolicy>;
  readonly clock?: AgentClock;
  readonly onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
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

export interface AgentQueuedSteer { readonly id: string; readonly runId: string; readonly timestamp: string; readonly instruction: string }
export interface AgentQueuedFollowUp { readonly id: string; readonly runId: string; readonly timestamp: string; readonly task: string; readonly instructions?: readonly string[] }
export interface AgentQueuedControl { readonly id: string; readonly runId: string; readonly timestamp: string; readonly reason?: string }
export interface AgentRuntimeState {
  readonly active: boolean;
  readonly model: string;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly queuedSteers: number;
  readonly queuedFollowUps: number;
  readonly queuedRetries: number;
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
  readonly tools: readonly ToolDefinition[];
  readonly configuration: RuntimeModelConfiguration;
  readonly instructions: readonly AgentEffectiveInstruction[];
}

interface ResolvedContextInputs {
  readonly configured: readonly ContextItemInput[];
  readonly provider: readonly ContextItemInput[];
  readonly run: readonly ContextItemInput[];
}

interface AssistantTurnRequest {
  readonly input: AgentRunInput;
  readonly runNotes: readonly string[];
  readonly turnIndex: number;
  readonly toolBatchId: string;
  readonly snapshot: TurnSnapshot;
  readonly modelSession: ModelProviderSession;
  readonly signal: AbortSignal;
  readonly contextManager: ContextManager;
  readonly controller: AgentRunController;
}

interface AssistantTurnResult { readonly response: ModelResponse; readonly toolCalls: readonly ToolCall[]; readonly candidate: AgentCandidate }
interface CompletedModelAttempt { readonly response: ModelResponse; readonly identity: AgentTurnIdentity }
type RequestAssemblyResult = { readonly ok: true; readonly request: ModelRequest; readonly estimate: RequestCostEstimate; readonly snapshot: AgentRequestSnapshotRecord } | { readonly ok: false; readonly diagnostic: OverflowDiagnostic };

type TerminalDecision =
  | { readonly executionStatus: 'completed'; readonly terminationReason: 'model_completed' | 'model_output_limit' | 'content_filtered' | 'unknown_model_termination'; readonly candidate: AgentPresentCandidate; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly modelTerminationReason: ModelResponse['terminationReason']; readonly providerTerminationReason?: string; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } }
  | { readonly executionStatus: 'failed'; readonly terminationReason: 'model_output_limit' | 'content_filtered' | 'unknown_model_termination' | 'empty_response' | 'malformed_response' | 'provider_error' | 'runtime_error' | 'stream_interrupted' | 'request_too_large' | 'limit_exhausted' | 'uncertain_tool_effect'; readonly candidate: AgentCandidate; readonly errorMessage: string; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly modelTerminationReason?: ModelResponse['terminationReason']; readonly providerTerminationReason?: string; readonly exhaustedLimit?: AgentLimitExceededError['limit']; readonly diagnostic?: ModelProviderErrorDiagnostic & { readonly turnIndex?: number }; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } }
  | { readonly executionStatus: 'aborted'; readonly terminationReason: 'aborted'; readonly candidate: AgentCandidate; readonly errorMessage: string; readonly turnCount: number; readonly checkResults: readonly AgentCheckResult[]; readonly diagnostic?: ModelProviderErrorDiagnostic & { readonly turnIndex?: number }; readonly cleanupDiagnostic?: { readonly kind: 'process_cleanup'; readonly message: string } };
type ExecutionDecision = TerminalDecision | { readonly executionStatus: 'waiting_for_approval'; readonly approvals: readonly AgentApprovalRequest[] };

interface ResumeExecutionState {
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
interface RunExecutionRuntime {
  readonly runId: string;
  readonly input: ResolvedAgentRunInput;
  readonly signal: AbortSignal;
  readonly controller: AgentRunController;
  readonly resume?: ResumeExecutionState;
  readonly append: (event: AgentEvent, idempotencyKey?: string) => Promise<unknown>;
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
  private readonly tools: readonly ToolDefinition[];
  private readonly resourceLeases: ResourceLeaseCoordinator;
  private readonly checks: readonly AgentCheckDefinition[];
  private readonly steerQueue: AgentQueuedSteer[] = [];
  private readonly followUpQueue: AgentQueuedFollowUp[] = [];
  private readonly retryQueue: AgentQueuedControl[] = [];
  private runtimeModel: string;
  private runtimeTemperature: number | undefined;
  private runtimeReasoning: ModelReasoningRequest | undefined;
  private runtimeResponseFormat: ModelResponseFormat | undefined;
  private activeAbortController: AbortController | undefined;
  private activeRunId: string | undefined;
  private static readonly MAX_CONTROL_QUEUE_ITEMS = 1024;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.estimator = options.estimator ?? new SimpleTokenEstimator();
    this.maxOutputTokens = validateOptionalPositiveInteger(options.maxOutputTokens, 'maxOutputTokens');
    this.toolPolicy = parseToolPolicy(options.toolPolicy ?? READ_ONLY_TOOL_POLICY);
    this.tools = Object.freeze(new ToolRegistry(options.tools ?? []).list());
    this.resourceLeases = processLeaseCoordinator(options.toolContext?.services?.processManager) ?? new ResourceLeaseCoordinator();
    validateToolBoundary(options.toolBoundary);
    this.checks = validateAgentCheckDefinitions(options.checks);
    this.runtimeModel = options.model;
    this.runtimeTemperature = options.temperature;
    this.runtimeReasoning = options.reasoning;
    this.runtimeResponseFormat = options.responseFormat;
  }

  configureModel(settings: { readonly model?: string; readonly temperature?: number; readonly reasoning?: ModelReasoningRequest; readonly responseFormat?: ModelResponseFormat }): AgentRuntimeState {
    if (settings.model !== undefined) this.runtimeModel = settings.model;
    if (settings.temperature !== undefined) this.runtimeTemperature = settings.temperature;
    if (settings.reasoning !== undefined) this.runtimeReasoning = settings.reasoning;
    if (settings.responseFormat !== undefined) this.runtimeResponseFormat = settings.responseFormat;
    return this.runtimeState();
  }

  steer(instruction: string): AgentQueuedSteer { const runId = this.requireActiveRunId('steer'); assertQueueCapacity(this.steerQueue, AgentRuntime.MAX_CONTROL_QUEUE_ITEMS, 'steering'); const item = { id: randomUUID(), runId, timestamp: new Date().toISOString(), instruction }; this.steerQueue.push(item); return item; }
  enqueueFollowUp(task: string, instructions?: readonly string[]): AgentQueuedFollowUp {
    const runId = this.requireActiveRunId('enqueue a follow-up');
    assertQueueCapacity(this.followUpQueue, AgentRuntime.MAX_CONTROL_QUEUE_ITEMS, 'follow-up');
    const item = { id: randomUUID(), runId, timestamp: new Date().toISOString(), task, ...(instructions?.length ? { instructions: Object.freeze([...instructions]) } : {}) };
    this.followUpQueue.push(item); return item;
  }
  takeFollowUps(runId: string): AgentQueuedFollowUp[] { const selected = this.followUpQueue.filter((item) => item.runId === runId); removeRunItems(this.followUpQueue, runId); return selected; }
  requestRetry(reason?: string): AgentQueuedControl { assertQueueCapacity(this.retryQueue, AgentRuntime.MAX_CONTROL_QUEUE_ITEMS, 'retry'); const item = this.controlRequest(this.requireActiveRunId('request a retry'), reason); this.retryQueue.push(item); return item; }
  abort(reason = 'Agent run aborted.'): void { this.activeAbortController?.abort(reason); }
  runtimeState(): AgentRuntimeState {
    return { active: this.activeAbortController !== undefined, model: this.runtimeModel,
      ...(this.runtimeTemperature !== undefined ? { temperature: this.runtimeTemperature } : {}),
      ...(this.runtimeReasoning !== undefined ? { reasoning: this.runtimeReasoning } : {}),
      queuedSteers: this.countForActiveRun(this.steerQueue), queuedFollowUps: this.countForActiveRun(this.followUpQueue), queuedRetries: this.countForActiveRun(this.retryQueue) };
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const runId = input.runId ?? randomUUID();
    const finalizationId = input.finalizationId ?? randomUUID();
    return this.runActive({ ...input, runId, finalizationId });
  }

  async resolveApproval(input: { readonly runId: string; readonly approvalId: string; readonly fingerprint: string; readonly decision: 'allow' | 'deny'; readonly signal?: AbortSignal }): Promise<AgentRunResult> {
    const records: AgentEvent[] = [];
    for await (const envelope of this.options.repositories.events.read(input.runId)) records.push(envelope.event);
    const committed = [...records].reverse().find((event): event is Extract<AgentEvent, { type: 'run.ended' }> => event.type === 'run.ended');
    if (committed) {
      const deliveryDiagnostics = records.flatMap((event) => event.type === 'delivery.failed' ? [event.diagnostic] : []);
      return Object.freeze({ state: 'ended', terminal: committed.terminal, deliveryDiagnostics: Object.freeze(deliveryDiagnostics) });
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
    if (currentPreparation.prepared.toolImplementationId !== target.binding.toolImplementationId) throw new Error(`Approved tool implementation changed for ${input.approvalId}; a new approval is required.`);
    if (currentPreparation.prepared.fingerprint !== target.fingerprint) throw new Error(`Approval fingerprint changed for ${input.approvalId}; a new approval is required.`);
    const priorResolutions = records.filter((event): event is Extract<AgentEvent, { type: 'approval.resolved' }> => event.type === 'approval.resolved');
    const existing = priorResolutions.find((resolution) => resolution.approvalId === input.approvalId);
    if (existing && (existing.decision !== input.decision || existing.fingerprint !== input.fingerprint)) throw new Error(`Conflicting approval resolution for ${input.approvalId}.`);
    if (!existing) {
      await this.options.repositories.events.append(input.runId, { type: 'approval.resolved', runId: input.runId, turnIndex: target.turnIndex, turnId: target.turnId, requestAttempt: target.requestAttempt, toolBatchId: target.toolBatchId, callIndex: target.callIndex, ...(target.callId ? { callId: target.callId } : {}), approvalId: target.approvalId, fingerprint: target.fingerprint, binding: target.binding, decision: input.decision }, { idempotencyKey: `${input.runId}:approval:${input.approvalId}` });
    }
    const resolutions = new Map([...priorResolutions, ...(!existing ? [{ ...target, type: 'approval.resolved' as const, decision: input.decision }] : [])].map((resolution) => [resolution.approvalId, resolution]));
    const batchRequests = requests.filter((request) => request.toolBatchId === target.toolBatchId);
    const pending = batchRequests.filter((request) => !resolutions.has(request.approvalId));
    const phase = [...records].reverse().find((event): event is Extract<AgentEvent, { type: 'run.phase.changed' }> => event.type === 'run.phase.changed');
    if (!phase) throw new Error(`Run ${input.runId} has no persisted phase budget.`);
    if (pending.length > 0) return Object.freeze({ state: 'suspended', reason: 'approval_required', runId: input.runId, finalizationId: started.finalizationId, pendingApprovals: Object.freeze(pending.map(approvalFromEvent)), budget: phase.budget });
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
    const resume: ResumeExecutionState = { identity: { turnIndex: target.turnIndex, turnId: target.turnId, requestAttempt: target.requestAttempt }, toolBatchId: target.toolBatchId, toolCalls: assistant.toolCalls, overrides, instructions: snapshot.snapshot.instructions, budget: phase.budget, approvalIds: batchRequests.map((request) => request.approvalId), callHistory, recovery: toolRecoveryState(records, target.toolBatchId, assistant.toolCalls.length) };
    return this.runActive({ task: started.task, runId: input.runId, finalizationId: started.finalizationId, ...(input.signal ? { signal: input.signal } : {}) }, resume);
  }

  private async runActive(input: ResolvedAgentRunInput, resume?: ResumeExecutionState): Promise<AgentRunResult> {
    if (this.activeAbortController) throw new Error('AgentRuntime already has an active run.');
    const { runId } = input;
    const abortController = new AbortController();
    const cleanupExternalAbort = bindExternalAbort(input.signal, abortController);
    this.activeAbortController = abortController;
    this.activeRunId = runId;
    try { return await this.runInternal(input, abortController.signal, resume); }
    finally {
      cleanupExternalAbort();
      removeRunItems(this.steerQueue, runId);
      removeRunItems(this.retryQueue, runId);
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      if (this.activeRunId === runId) this.activeRunId = undefined;
    }
  }

  private async runInternal(input: ResolvedAgentRunInput, signal: AbortSignal, resume?: ResumeExecutionState): Promise<AgentRunResult> {
    const { runId, finalizationId } = input;
    const controller = new AgentRunController({
      runId,
      finalizationId,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(this.options.retryPolicy ? { retryPolicy: this.options.retryPolicy } : {}),
      ...(resume ? { initialBudget: resume.budget, initialToolCalls: resume.callHistory } : {})
    });
    const deliveryDiagnostics: { eventType: string; message: string; persisted: boolean }[] = [];
    const append = (event: AgentEvent, idempotencyKey?: string) => this.options.repositories.events.append(runId, event, idempotencyKey ? { idempotencyKey } : {});
    const emit = (event: AgentProgressEvent) => this.emitProgress(runId, finalizationId, event, deliveryDiagnostics);
    const finalizer = new AgentRunFinalizer({
      runId,
      finalizationId,
      events: this.options.repositories.events,
      ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}),
      ...(this.options.onProgress ? { deliver: this.options.onProgress } : {}),
      deliveryDiagnostics
    });
    let decision: ExecutionDecision;
    try {
      decision = await this.executeRun({ runId, input, signal, controller, append, emit, ...(resume ? { resume } : {}) });
    } catch (error) {
      decision = await this.decisionFromError({ error, signal, runId, controller, append, emit });
    }
    if (decision.executionStatus === 'waiting_for_approval') {
      const cleanupError = await this.disposeOwnedProcesses(runId, append);
      if (!cleanupError) {
        controller.waitForApproval(decision.approvals.map((approval) => approval.approvalId));
        const budget = controller.snapshot();
        await append({ type: 'run.phase.changed', runId, phase: 'waiting_for_approval', budget });
        await emit({ type: 'run.phase.changed', phase: 'waiting_for_approval', budget });
        return Object.freeze({ state: 'suspended', reason: 'approval_required', runId, finalizationId, pendingApprovals: decision.approvals, budget });
      }
      decision = cleanupFailureDecision(undefined, cleanupError);
    } else {
      const cleanupError = await this.disposeOwnedProcesses(runId, append);
      if (cleanupError) decision = cleanupFailureDecision(decision, cleanupError);
    }
    await this.enterPhase(runId, controller, 'finalizing', append, emit);
    decision = decisionBeforeFinalization(decision, signal);
    const terminal = terminalSnapshot(runId, finalizationId, decision, controller, this.checks);
    const result = await finalizer.finalize(terminal, 'diagnostic' in decision ? decision.diagnostic : undefined);
    controller.commitTerminal(result.terminal);
    return result;
  }

  private async executeRun(runtime: RunExecutionRuntime): Promise<ExecutionDecision> {
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
      model: this.runtimeModel,
      ...(runtime.resume ? { runIds: [runtime.runId] } : {})
    });
    const contextManager = replay.contextManager;
    const observationStore = new ObservationStore({ estimator: this.estimator, ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}) });
    if (!runtime.resume) {
      await runtime.append({ type: 'run.started', runId: runtime.runId, finalizationId: runtime.input.finalizationId, task: runtime.input.task, model: this.runtimeModel, toolPolicy: this.toolPolicy, ...(this.options.metadata ? { metadata: this.options.metadata } : {}) }, `${runtime.runId}:started`);
      await runtime.append({ type: 'run.phase.changed', runId: runtime.runId, phase: 'preparing', budget: runtime.controller.snapshot() });
    }
    if (this.options.repositories.session && !runtime.resume) {
      const replayEvent = { type: 'context.replay.created' as const, sessionId: this.options.repositories.session.sessionId,
        replayedLedgers: replay.replayedLedgers, replayedTurns: replay.replayedTurns, replayedSessionEntries: replay.replayedSessionEntries,
        replayedCheckpoints: replay.replayedCheckpoints, replayedToolResults: replay.replayedToolResults, replayedEvidenceRecords: replay.replayedEvidenceRecords,
        ...(replay.providerStateSummary ? { restoredProviderState: replay.providerStateSummary } : {}), ...(replay.providerStateRef ? { restoredProviderStateRef: replay.providerStateRef } : {}) };
      await runtime.append(replayEvent);
      await runtime.emit({ ...replayEvent, type: 'context.replay.restored' });
    }
    if (!runtime.resume) await runtime.append({ type: 'input.received', task: runtime.input.task });
    let sessionEntryId: string | undefined;
    if (this.options.repositories.session && !runtime.resume) {
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
      if (runtime.resume) {
        const resumeDecision = await this.resumeToolBatch({ ...runtime, resume: runtime.resume }, contextManager, observationStore, checkResults);
        if (resumeDecision) return resumeDecision;
        turnIndex += 1;
      }
      const availableTurnEntries = runtime.controller.limits.modelTurns - runtime.controller.snapshot().modelTurns + 1;
      for (let turnEntry = 0; turnEntry < availableTurnEntries; turnEntry += 1) {
        runtime.controller.assertElapsed();
        throwIfAborted(runtime.signal);
        const steering = this.consumeSteeringInstructions(runtime.runId);
        if (steering.length > 0) {
          effectiveInstructions.push(...steeringInstructions(steering, effectiveInstructions.length));
          runNotes.push(`User steering added before turnIndex ${String(turnIndex)}:\n${steering.map((instruction) => `- ${instruction}`).join('\n')}`);
        }
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
        const toolBatchId = randomUUID();
        const snapshot = this.createTurnSnapshot({ turnIndex, turnId, requestAttempt: 1, configuration, profile, requestWindow, tools, instructions: effectiveInstructions, controller: runtime.controller, continuationEligible });
        activeTurnIdentity = turnIdentity(snapshot.record);
        const turnStarted = { type: 'turn.started' as const, runId: runtime.runId, task: runtime.input.task, ...activeTurnIdentity,
          ...(this.options.repositories.session ? { sessionId: this.options.repositories.session.sessionId } : {}), ...(sessionEntryId ? { sessionEntryId } : {}) };
        await runtime.append(turnStarted);
        await runtime.emit(turnStarted);
        if (this.options.repositories.session) {
          await this.options.repositories.session.repository.appendModelSettings(this.options.repositories.session.sessionId, {
            provider: providerInfo.id, model: configuration.model,
            ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
            ...(configuration.reasoning?.strategy === 'effort' ? { reasoningEffort: configuration.reasoning.effort } : {})
          });
        }
        const configuredEvent = { type: 'run.configured' as const, configuration: summarizeRunConfiguration({
          provider: providerInfo, model: profile, tools: [...tools], toolPolicy: this.toolPolicy, requestWindow,
          ...(this.maxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: this.maxOutputTokens }),
          ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
          ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning }),
          ...(this.options.metadata === undefined ? {} : { metadata: this.options.metadata })
        }) };
        await runtime.append(configuredEvent);
        await runtime.emit(configuredEvent);
        await this.enterPhase(runtime.runId, runtime.controller, 'requesting_model', runtime.append, runtime.emit, snapshot.record);
        lastStartedTurnIndex = turnIndex;
        const currentModelSession = modelSession;
        if (!currentModelSession) throw new Error('Model session was not initialized for the turn snapshot.');
        const assistant = await this.requestAssistantTurn({ input: runtime.input, runNotes, turnIndex, toolBatchId, snapshot, modelSession: currentModelSession, signal: runtime.signal, contextManager, controller: runtime.controller }, runtime.append, runtime.emit);
        activeCandidate = assistant.candidate;
        const { response, toolCalls } = assistant;

        if (response.terminationReason === 'tool_calls') {
          if (toolCalls.length === 0) {
            return failedDecision('malformed_response', partialOrAbsent(activeCandidate), 'Model reported tool-call termination without usable native tool calls.', turnIndex, checkResults, response);
          }
        } else if (toolCalls.length > 0) {
          return failedDecision('malformed_response', partialOrAbsent(activeCandidate), 'Model returned native tool calls with a non-tool termination reason.', turnIndex, checkResults, response);
        }

        if (toolCalls.length === 0) {
          if (activeCandidate.status === 'absent') {
            const emptyMessage = [`Model returned no native tool calls and no visible candidate at turnIndex ${String(turnIndex)}.`, response.reasoning ? 'Raw private reasoning is not a candidate.' : ''].filter(Boolean).join(' ');
            await this.options.repositories.session?.repository.appendObservation(this.options.repositories.session.sessionId, { runId: runtime.runId, identity: turnIdentity(snapshot.record), toolName: 'assistant_response', observation: { ok: false, summary: emptyMessage, output: { content: response.content } } });
            return failedDecision('empty_response', activeCandidate, emptyMessage, turnIndex, checkResults, response);
          }
          await this.enterPhase(runtime.runId, runtime.controller, 'verifying', runtime.append, runtime.emit);
          checkResults.push(...await runAgentChecks({ runId: runtime.runId, checks: this.checks, task: runtime.input.task, instructions: snapshot.instructions, candidate: activeCandidate, ...turnIdentity(snapshot.record), signal: runtime.signal,
            ...(this.options.metadata ? { metadata: this.options.metadata } : {}), execution: contextEvidenceExecution({ contextManager, ...(this.options.repositories.artifacts ? { artifacts: this.options.repositories.artifacts } : {}), ...(this.options.verification ? { configured: this.options.verification } : {}) }),
            append: runtime.append, emit: runtime.emit }));
          return completedDecision(activeCandidate, turnIndex, checkResults, response);
        }

        runtime.controller.recordToolCalls(toolCalls);
        contextManager.recordModelOutput({ turnIndex, content: response.content, toolCalls: toolCalls.map(modelToolCallFromToolCall) });
        await this.enterPhase(runtime.runId, runtime.controller, 'executing_tools', runtime.append, runtime.emit, { ...snapshot.record, toolBatchId });
        const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
        let toolResult;
        try {
          toolResult = await executeAssistantToolCalls({ runId: runtime.runId, ...turnIdentity(snapshot.record), toolBatchId, toolCalls, tools: this.tools, toolContext: this.toolContext(toolDeadline.signal), resourceLeases: this.resourceLeases, modelInputModalities: snapshot.profile.modalities.input,
            ...(this.options.toolAuthorizer ? { authorizer: this.options.toolAuthorizer } : {}), contextManager, observationStore,
            ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}), controller: runtime.controller, append: runtime.append, emit: runtime.emit });
        } finally { toolDeadline.dispose(); }
        if (toolResult.outcome === 'waiting_for_approval') return { executionStatus: 'waiting_for_approval', approvals: toolResult.approvals };
        if (toolResult.outcome === 'uncertain_effect') return { executionStatus: 'failed', terminationReason: 'uncertain_tool_effect', candidate: { status: 'absent' }, errorMessage: `Tool ${toolResult.toolName} attempt ${String(toolResult.toolAttempt)} has an uncertain non-idempotent side effect.`, turnCount: turnIndex, checkResults };
        if (toolResult.failedTool && this.consumeRetryRequest(runtime.runId)) {
          if (!toolResult.retrySafe) return { executionStatus: 'failed', terminationReason: 'uncertain_tool_effect', candidate: { status: 'absent' }, errorMessage: 'Agent-turn retry was refused because a failed tool may have produced a non-idempotent side effect.', turnCount: turnIndex, checkResults };
          await runtime.append({ type: 'run.retry.scheduled', ...turnIdentity(snapshot.record), kind: 'agent_turn', attempt: 1, delayMs: 0 });
          runNotes.push(`Agent-turn retry requested after a failed idempotent tool call at turnIndex ${String(turnIndex)}.`);
        } else turnIndex += 1;
      }
      throw new Error('Model-turn execution exhausted its available entries without a terminal or limit decision.');
    } catch (error) {
      throw new AgentExecutionError(error, { lastStartedTurnIndex, activeCandidate, checkResults: [...checkResults], ...(activeTurnIdentity ? { activeTurnIdentity } : {}) });
    } finally {
      await modelSession?.close?.();
    }
  }

  private async resumeToolBatch(runtime: RunExecutionRuntime & { readonly resume: ResumeExecutionState }, contextManager: ContextManager, observationStore: ObservationStore, checkResults: readonly AgentCheckResult[]): Promise<TerminalDecision | undefined> {
    const profile = parseModelProfile(await this.options.provider.describeModel(this.runtimeModel));
    const batchIdentity = { ...runtime.resume.identity, toolBatchId: runtime.resume.toolBatchId };
    runtime.controller.transition('requesting_model', runtime.resume.identity);
    runtime.controller.transition('executing_tools', batchIdentity);
    runtime.controller.waitForApproval(runtime.resume.approvalIds);
    runtime.controller.resumeApprovedTools();
    const resumedBudget = runtime.controller.snapshot();
    await runtime.append({ type: 'run.phase.changed', runId: runtime.runId, phase: 'executing_tools', budget: resumedBudget });
    await runtime.emit({ type: 'run.phase.changed', phase: 'executing_tools', budget: resumedBudget });
    const toolDeadline = runSignalDeadline(runtime.controller, runtime.signal);
    let resumedTools;
    try {
      resumedTools = await executeAssistantToolCalls({ runId: runtime.runId, ...batchIdentity, toolCalls: runtime.resume.toolCalls, tools: this.tools, toolContext: this.toolContext(toolDeadline.signal), resourceLeases: this.resourceLeases, modelInputModalities: profile.modalities.input, authorizationOverrides: runtime.resume.overrides, recovery: runtime.resume.recovery, resuming: true,
        ...(this.options.toolAuthorizer ? { authorizer: this.options.toolAuthorizer } : {}), contextManager, observationStore,
        ...(this.options.repositories.session ? { session: this.options.repositories.session } : {}), controller: runtime.controller, append: runtime.append, emit: runtime.emit });
    } finally { toolDeadline.dispose(); }
    if (resumedTools.outcome === 'uncertain_effect') return { executionStatus: 'failed', terminationReason: 'uncertain_tool_effect', candidate: { status: 'absent' }, errorMessage: `Tool ${resumedTools.toolName} attempt ${String(resumedTools.toolAttempt)} may have produced a non-idempotent side effect before the process stopped; automatic replay is forbidden.`, turnCount: batchIdentity.turnIndex, checkResults };
    if (resumedTools.outcome !== 'completed') throw new Error('Resolved approval batch requested another approval.');
    return undefined;
  }

  private async decisionFromError(runtime: {
    readonly error: unknown;
    readonly signal: AbortSignal;
    readonly runId: string;
    readonly controller: AgentRunController;
    readonly append: (event: AgentEvent) => Promise<unknown>;
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
    readonly tools: readonly ToolDefinition[];
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

  private async requestAssistantTurn(request: AssistantTurnRequest, append: (event: AgentEvent) => Promise<unknown>, emit: (event: AgentProgressEvent) => Promise<void>): Promise<AssistantTurnResult> {
    const identity = turnIdentity(request.snapshot.record);
    const assembly = await this.assembleModelRequest(request, append, emit);
    if (!assembly.ok) throw new RequestAssemblyError(formatOverflowDiagnostic(assembly.diagnostic));
    request.snapshot.budgetAccountant.recordSent(assembly.estimate);
    const ledgerModelRequest = { ...assembly.request }; delete ledgerModelRequest.signal;
    await append({ type: 'assistant.started', ...identity });
    await emit({ type: 'assistant.started', ...identity });
    const completedAttempt = await this.completeWithRetries(assembly.request, assembly.snapshot, summarizeModelRequest(ledgerModelRequest), request, append, emit);
    const { response, identity: responseIdentity } = completedAttempt;
    const providerState = response.providerState && this.options.repositories.artifacts
      ? await storeProviderStateArtifact({ artifacts: this.options.repositories.artifacts, turnIndex: request.turnIndex, state: response.providerState })
      : undefined;
    await append({ type: 'model.responded', ...responseIdentity, response: summarizeModelResponse(response, providerState) });
    if (providerState) await append({ type: 'provider.state.updated', ...responseIdentity, state: providerState.summary, stateRef: providerState.artifact });
    if (response.usage) {
      const budget = request.snapshot.budgetAccountant.recordProviderUsage(response.usage);
      await append({ type: 'budget.provider_usage.recorded', ...responseIdentity, usage: response.usage, snapshot: budget });
      request.controller.recordUsage(response.usage, request.snapshot.profile.pricing);
    } else {
      const completionTokens = this.estimateAssistantOutput(response);
      request.snapshot.budgetAccountant.recordEstimatedResponse(completionTokens);
      request.controller.recordUsage({ promptTokens: assembly.estimate.totalPromptTokens, completionTokens, totalTokens: assembly.estimate.totalPromptTokens + completionTokens }, request.snapshot.profile.pricing);
    }
    const toolCalls = Object.freeze((response.toolCalls ?? []).map(normalizeModelToolCall));
    const candidate = candidateFromResponse(response, request.turnIndex, toolCalls.length > 0);
    const assistantEnded = { type: 'assistant.ended' as const, ...responseIdentity, content: response.content, candidate, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
    await append(assistantEnded);
    await emit(assistantEnded);
    return { response, toolCalls, candidate };
  }

  private async completeWithRetries(request: ModelRequest, requestSnapshot: AgentRequestSnapshotRecord, requestSummary: ReturnType<typeof summarizeModelRequest>, turnRequest: AssistantTurnRequest, append: (event: AgentEvent) => Promise<unknown>, emit: (event: AgentProgressEvent) => Promise<void>): Promise<CompletedModelAttempt> {
    for (let attempt = 0; attempt <= turnRequest.controller.retryPolicy.retriesPerRequest; attempt += 1) {
      const identity = { ...turnIdentity(turnRequest.snapshot.record), requestAttempt: attempt + 1 };
      await append({ type: 'turn.snapshot.created', snapshot: { ...turnRequest.snapshot.record, requestAttempt: identity.requestAttempt } });
      await append({ type: 'request.snapshot.created', snapshot: { ...requestSnapshot, requestAttempt: identity.requestAttempt } });
      await append({ type: 'model.requested', ...identity, request: requestSummary });
      const deadline = runDeadline(turnRequest.controller, request);
      try {
        const response = await this.completeModelOnce(deadline.request, identity, turnRequest.toolBatchId, turnRequest.snapshot.profile, turnRequest.modelSession, emit);
        turnRequest.controller.recordProviderSuccess();
        return Object.freeze({ response, identity: Object.freeze(identity) });
      } catch (error) {
        if (deadline.error) throw deadline.error;
        if (turnRequest.signal.aborted) throw error;
        const interruptedVisible = error instanceof ModelStreamInterruptedError && (error.content.trim().length > 0 || (error.reasoningSummary?.trim().length ?? 0) > 0);
        const failedValue = error instanceof ModelStreamInterruptedError ? error.cause : error;
        const diagnostic = providerFailureDiagnostic(failedValue) ?? { provider: this.options.provider.id, code: 'unknown', retryable: false };
        const disposition = providerRetryDisposition(turnRequest.modelSession, failedValue);
        turnRequest.controller.recordProviderFailure();
        const retry = !interruptedVisible && diagnostic.retryable && attempt < turnRequest.controller.retryPolicy.retriesPerRequest;
        const delayMs = retry ? Math.min(turnRequest.controller.retryPolicy.maximumDelayMs, Math.round(turnRequest.controller.retryPolicy.initialDelayMs * turnRequest.controller.retryPolicy.multiplier ** attempt)) : 0;
        if (!retry) throw error;
        turnRequest.controller.recordProviderRetry();
        if (disposition !== 'reusable') turnRequest.modelSession.resetContinuation?.(`Retry disposition: ${disposition}.`);
        await append({ type: 'run.retry.scheduled', ...identity, kind: error instanceof ModelStreamInterruptedError ? 'transport' : 'provider_request', attempt: attempt + 1, delayMs, diagnostic });
        await abortableDelay(delayMs, turnRequest.signal);
      } finally {
        deadline.dispose();
      }
    }
    throw new Error('Provider retry execution exhausted its attempts without a response or terminal failure.');
  }

  private async assembleModelRequest(request: AssistantTurnRequest, append: (event: AgentEvent) => Promise<unknown>, emit: (event: AgentProgressEvent) => Promise<void>): Promise<RequestAssemblyResult> {
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
      let latestReductions: ContextHistoryReduction[] = [];
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

  private async enterPhase(runId: string, controller: AgentRunController, phase: Parameters<AgentRunController['transition']>[0], append: (event: AgentEvent) => Promise<unknown>, emit: (event: AgentProgressEvent) => Promise<void>, identity?: AgentTurnSnapshotRecord & { readonly toolBatchId?: string }): Promise<void> {
    controller.transition(phase, identity); const budget = controller.snapshot(); await append({ type: 'run.phase.changed', runId, phase, budget }); await emit({ type: 'run.phase.changed', phase, budget });
  }
  private async emitProgress(runId: string, finalizationId: string, event: AgentProgressEvent, diagnostics: { eventType: string; message: string; persisted: boolean }[]): Promise<void> {
    if (!this.options.onProgress) return;
    try { await this.options.onProgress(event); }
    catch (error) {
      const base = { eventType: event.type, message: errorMessage(error) };
      try { const diagnostic = { ...base, persisted: true }; await this.options.repositories.events.append(runId, { type: 'delivery.failed', finalizationId, diagnostic }, { idempotencyKey: `${finalizationId}:delivery:${event.type}:${String(diagnostics.length)}` }); diagnostics.push(diagnostic); }
      catch { diagnostics.push({ ...base, persisted: false }); }
    }
  }
  private captureRuntimeConfiguration(): RuntimeModelConfiguration { return Object.freeze({ model: this.runtimeModel, ...(this.runtimeTemperature === undefined ? {} : { temperature: this.runtimeTemperature }), ...(this.runtimeReasoning === undefined ? {} : { reasoning: this.runtimeReasoning }), ...(this.runtimeResponseFormat === undefined ? {} : { responseFormat: this.runtimeResponseFormat }) }); }
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
  private availableTools(profile?: ModelProfile): ToolDefinition[] {
    const context = this.toolContext(new AbortController().signal);
    return this.tools.filter((tool) => isToolAvailable(tool, this.toolPolicy) && toolRequirementsSatisfied(tool, {
      ...(context.services ? { services: context.services } : {}),
      ...(profile ? { modelInputModalities: profile.modalities.input } : {}),
      hostCapabilities: processCapabilities(context.services?.processManager)
    }));
  }
  private async disposeOwnedProcesses(runId: string, append: (event: AgentEvent, idempotencyKey?: string) => Promise<unknown>): Promise<Error | undefined> {
    const service = this.options.toolContext?.services?.processManager;
    if (!isProcessDisposer(service)) return undefined;
    try {
      const results = await service.disposeRun(runId);
      for (const report of results) {
        const durable = durableProcessTermination(report);
        await append(
          { type: 'process.ended', runId, processId: durable.processId, status: durable.status, result: durable.result },
          `${runId}:process:${durable.processId}:ended`
        );
        await service.markTerminalReported?.(durable.processId);
      }
      return undefined;
    }
    catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }
  private controlRequest(runId: string, reason?: string): AgentQueuedControl { return { id: randomUUID(), runId, timestamp: new Date().toISOString(), ...(reason ? { reason } : {}) }; }
  private consumeSteeringInstructions(runId: string): string[] { const selected = this.steerQueue.filter((item) => item.runId === runId); removeRunItems(this.steerQueue, runId); return selected.map((item) => item.instruction); }
  private consumeRetryRequest(runId: string): AgentQueuedControl | undefined { const index = this.retryQueue.findIndex((item) => item.runId === runId); return index < 0 ? undefined : this.retryQueue.splice(index, 1)[0]; }
  private requireActiveRunId(action: string): string { if (!this.activeRunId) throw new Error(`Cannot ${action} without an active run.`); return this.activeRunId; }
  private countForActiveRun(items: readonly { runId: string }[]): number { return this.activeRunId ? items.filter((item) => item.runId === this.activeRunId).length : 0; }
}

function isProcessDisposer(value: unknown): value is { readonly disposeRun: (runId: string) => Promise<readonly unknown[]>; readonly markTerminalReported?: (processId: string) => Promise<void> } {
  if (typeof value !== 'object' || value === null || !('disposeRun' in value)) return false;
  return typeof (value as { readonly disposeRun?: unknown }).disposeRun === 'function';
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
function processLeaseCoordinator(value: unknown): ResourceLeaseCoordinator | undefined {
  if (typeof value !== 'object' || value === null || !('resourceLeases' in value)) return undefined;
  const coordinator = (value as { readonly resourceLeases?: unknown }).resourceLeases;
  return coordinator instanceof ResourceLeaseCoordinator ? coordinator : undefined;
}
function processCapabilities(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || !('capabilities' in value)) return [];
  const capabilities = (value as { readonly capabilities?: unknown }).capabilities;
  return typeof capabilities === 'function' ? (capabilities as (this: unknown) => readonly string[]).call(value) : [];
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
function formatOverflowDiagnostic(diagnostic: OverflowDiagnostic): string { return ['Request assembly exceeded budget after overflow recovery.', `Reason: ${diagnostic.reason}.`, `Components: messages=${String(diagnostic.messageTokens)}, contextHistory=${String(diagnostic.contextHistoryTokens)}, context=${String(diagnostic.contextTokens)}, evidence=${String(diagnostic.evidenceTokens)}, toolSchemas=${String(diagnostic.toolSchemaTokens)}, outputReserve=${String(diagnostic.outputReserveTokens)}.`, `Total request tokens=${String(diagnostic.totalRequestTokens)}.`, `Recovery actions attempted=${diagnostic.reductionsAttempted.map(formatOverflowAction).join(', ') || 'none'}.`].join(' '); }
function formatOverflowAction(action: OverflowRecoveryAction): string { if (action.kind === 'reduce_context_history') return `reduce_context_history(${String(action.reductions)})`; if (action.kind === 'reduce_context') return `reduce_context(${String(action.removedItems)})`; if (action.kind === 'install_checkpoint') return `install_checkpoint(${String(action.compactedToolResults)})`; return action.kind; }
class RequestAssemblyError extends Error {}
function modelStreamInterrupted(input: { turnIndex: number; cause: unknown; content: string; reasoningSummary: string; finalResponseReceived: boolean }): ModelStreamInterruptedError { return new ModelStreamInterruptedError({ turnIndex: input.turnIndex, cause: input.cause, content: input.content, finalResponseReceived: input.finalResponseReceived, ...(input.reasoningSummary.length > 0 ? { reasoningSummary: input.reasoningSummary } : {}) }); }
function bindExternalAbort(external: AbortSignal | undefined, controller: AbortController): () => void { if (!external) return () => undefined; if (external.aborted) { controller.abort(external.reason); return () => undefined; } const abort = () => { controller.abort(external.reason); }; external.addEventListener('abort', abort, { once: true }); return () => { external.removeEventListener('abort', abort); }; }
function abortReason(reason: unknown): string { return reason instanceof Error ? reason.message : typeof reason === 'string' && reason.length > 0 ? reason : 'Agent run aborted.'; }
function throwIfAborted(signal: AbortSignal): void { if (!signal.aborted) return; throw signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Agent run aborted.'); }
async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> { if (delayMs === 0) return; await new Promise<void>((resolve, reject) => { const timeout = setTimeout(resolve, delayMs); const abort = () => { clearTimeout(timeout); reject(signal.reason instanceof Error ? signal.reason : new Error('Retry aborted.')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }); }
async function safePersist(append: (event: AgentEvent) => Promise<unknown>, event: AgentEvent): Promise<void> { try { await append(event); } catch { /* Terminal finalization will report its own persistence state. */ } }
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
function approvalFromEvent(event: Extract<AgentEvent, { type: 'approval.requested' }>): AgentApprovalRequest {
  const effects = normalizeJsonSafe(event.effects).value;
  if (!isRecord(effects)) throw new Error(`Approval ${event.approvalId} effects are malformed.`);
  return Object.freeze({ runId: event.runId, turnIndex: event.turnIndex, turnId: event.turnId, requestAttempt: event.requestAttempt, toolBatchId: event.toolBatchId, callIndex: event.callIndex, ...(event.callId ? { callId: event.callId } : {}), approvalId: event.approvalId, status: 'pending', toolName: event.toolName, fingerprint: event.fingerprint, input: event.input, effects, binding: event.binding, policyHash: event.policyHash, reason: event.reason });
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
function providerRetryDisposition(session: ModelProviderSession, error: unknown): ModelProviderSessionRetryDisposition {
  if (typeof session.retryDisposition !== 'function') return 'unknown';
  const disposition = session.retryDisposition(error);
  return disposition === 'reusable' || disposition === 'reset_required' ? disposition : 'unknown';
}
function directProviderSession(provider: ModelProvider): ModelProviderSession {
  const stream = provider.stream?.bind(provider);
  return {
    complete: (request) => provider.complete(request),
    ...(stream ? { stream: (request: ModelRequest) => stream(request) } : {}),
    retryDisposition: () => 'unknown'
  };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
