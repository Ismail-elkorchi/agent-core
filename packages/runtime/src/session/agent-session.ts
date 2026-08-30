import { randomUUID } from 'node:crypto';
import { hashJson } from '@agent-core/evidence';
import { normalizeJsonSafe } from '@agent-core/json';
import { AgentRuntime, type AgentRunControl, type AgentRunInput } from '../agent-runtime.js';
import { AgentOperationCoordinator } from '../operation/driver.js';
import type { AgentProgressEvent } from '../events.js';
import type { AgentRunResult } from '../run/contracts.js';
import type {
  SessionCompactionEntry,
  SessionBranchMarkerEntry,
  SessionConversationItem,
  SessionDescriptor,
  SessionPendingSubmission,
  SessionRepository,
  SessionSuspensionAction,
  SessionSuspensionCategory,
  SessionSuspensionDescriptor,
  SessionSubmissionConfiguration,
  SessionSubmissionInput
} from './contracts.js';
import { assertSessionBinding, decodeSessionBinding, type SessionBindingInput } from './binding.js';
import { ownSessionSubmissionConfiguration } from './submission-lifecycle.js';

export type AgentSessionConfiguration = SessionSubmissionConfiguration;

export interface AgentSessionRuntimeContext {
  readonly submissionId: string;
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly resuming: boolean;
}

export interface AgentSessionState {
  readonly sessionId: string;
  readonly phase: 'idle' | 'running' | 'suspended' | 'compacting';
  readonly configuration: AgentSessionConfiguration;
  readonly activeRunId?: string;
  readonly queuedInputs: number;
  readonly suspension?: AgentSessionSuspensionDescriptor;
}

export type AgentSessionSuspensionCategory = SessionSuspensionCategory;
export type AgentSessionSuspensionAction = SessionSuspensionAction;
export type AgentSessionDecisionRequest = NonNullable<SessionSuspensionDescriptor['decisionRequest']>;
export type AgentSessionSuspensionDescriptor = SessionSuspensionDescriptor;

export interface AgentSessionCompactionRequest {
  readonly configuration: AgentSessionConfiguration;
  readonly conversation: readonly SessionConversationItem[];
}

export type AgentSessionEvent =
  | { readonly type: 'run.progress'; readonly runId: string; readonly event: AgentProgressEvent }
  | { readonly type: 'run.completed'; readonly runId: string; readonly result: AgentRunResult }
  | { readonly type: 'run.failed'; readonly runId: string; readonly error: Error }
  | { readonly type: 'configuration.changed'; readonly configuration: AgentSessionConfiguration }
  | { readonly type: 'input.queued'; readonly submissionId: string; readonly queuedInputs: number }
  | { readonly type: 'compaction.completed'; readonly compaction: SessionCompactionEntry };

export type AgentSessionSubmissionResult =
  | { readonly kind: 'started'; readonly submissionId: string; readonly runId: string; readonly completion: Promise<AgentRunResult> }
  | { readonly kind: 'steered'; readonly submissionId: string; readonly runId: string; readonly completion: Promise<AgentRunResult> }
  | { readonly kind: 'queued'; readonly submissionId: string; readonly completion: Promise<AgentRunResult> }
  | { readonly kind: 'rejected'; readonly reason: 'no_active_run' | 'run_mismatch' }
  | { readonly kind: 'rejected'; readonly reason: 'session_suspended'; readonly suspension: AgentSessionSuspensionDescriptor };

export interface AgentSessionOptions {
  readonly descriptor: SessionDescriptor;
  readonly expectedBinding: SessionBindingInput;
  readonly repository: SessionRepository;
  readonly operations: AgentOperationCoordinator;
  readonly configuration: AgentSessionConfiguration;
  readonly createRuntime: (
    configuration: AgentSessionConfiguration,
    onProgress: (event: AgentProgressEvent) => void | Promise<void>,
    context: AgentSessionRuntimeContext
  ) => AgentRuntime | Promise<AgentRuntime>;
  readonly summarizeConversation?: (request: AgentSessionCompactionRequest) => Promise<string>;
  readonly maximumQueuedInputs?: number;
}

export class AgentSession {
  private configuration: AgentSessionConfiguration;
  private readonly maximumQueuedInputs: number;
  private readonly queued: PendingSubmission[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  private active: ActiveSubmission | undefined;
  private suspended: SuspendedSubmission | undefined;
  private operations: Promise<void> = Promise.resolve();
  private restored = false;
  private compacting = false;

  constructor(private readonly options: AgentSessionOptions) {
    assertSessionBinding(options.expectedBinding, decodeSessionBinding(options.descriptor.header.binding));
    const maximumQueuedInputs = options.maximumQueuedInputs ?? 1024;
    if (!Number.isSafeInteger(maximumQueuedInputs) || maximumQueuedInputs < 0) throw new Error('maximumQueuedInputs must be a non-negative safe integer.');
    this.maximumQueuedInputs = maximumQueuedInputs;
    this.configuration = ownConfiguration(options.configuration);
  }

  state(): AgentSessionState {
    return Object.freeze({
      sessionId: this.options.descriptor.id,
      phase: this.active ? 'running' : this.suspended ? 'suspended' : this.compacting ? 'compacting' : 'idle',
      configuration: this.configuration,
      ...(this.active ? { activeRunId: this.active.control.runId } : this.suspended ? { activeRunId: this.suspended.runId } : {}),
      queuedInputs: this.queued.length,
      ...(this.suspended ? { suspension: this.suspended.descriptor } : {})
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  restore(): Promise<void> {
    return this.serial(() => this.restorePending());
  }

  private startReadyWork(): Promise<void> {
    return this.serial(async () => {
      await this.restorePending();
      if (!this.active && !this.suspended && !this.compacting) await this.launchNext();
    });
  }

  configure(settings: Partial<AgentSessionConfiguration>): Promise<AgentSessionState> {
    return this.serial(async () => {
      this.configuration = ownConfiguration({ ...this.configuration, ...settings });
      await this.emit({ type: 'configuration.changed', configuration: this.configuration });
      return this.state();
    });
  }

  submit(input: AgentRunInput, options: { readonly delivery?: 'default' | 'steer' | 'follow_up'; readonly expectedRunId?: string } = {}): Promise<AgentSessionSubmissionResult> {
    return this.serial(async () => {
      await this.restorePending();
      const task = input.task.trim();
      if (task.length === 0) throw new Error('Session input must not be empty.');
      const submissionId = randomUUID();
      const delivery = options.delivery ?? 'default';
      if (delivery === 'steer') {
        if (!this.active) return { kind: 'rejected', reason: 'no_active_run' };
        if (options.expectedRunId !== undefined && options.expectedRunId !== this.active.control.runId) return { kind: 'rejected', reason: 'run_mismatch' };
        await this.options.repository.appendSteering(this.options.descriptor, { runId: this.active.control.runId, content: task });
        this.active.control.injectSteering({ instruction: task });
        return { kind: 'steered', submissionId, runId: this.active.control.runId, completion: this.active.pending.completion };
      }
      if (input.signal !== undefined) throw new Error('Durable session submissions cannot retain an AbortSignal; abort the active run through AgentSession.abort().');
      if (this.suspended) return { kind: 'rejected', reason: 'session_suspended', suspension: this.suspended.descriptor };
      const pending = pendingSubmission(submissionId, input.runId ?? randomUUID(), { ...input, task }, this.configuration);
      if ((this.active || this.compacting) && this.queued.length >= this.maximumQueuedInputs) {
        throw new Error(`Session input queue limit of ${String(this.maximumQueuedInputs)} was reached.`);
      }
      await this.options.repository.enqueueSubmission(this.options.descriptor, {
        submissionId, runId: pending.runId, input: submissionInput(pending.input), configuration: pending.configuration
      });
      if (this.active || this.compacting || this.queued.length > 0) {
        this.enqueue(pending);
        if (!this.active && !this.compacting) await this.launchNext();
        return { kind: 'queued', submissionId, completion: pending.completion };
      }
      return this.launch(pending);
    });
  }

  async compact(): Promise<SessionCompactionEntry> {
    return this.serial(async () => {
      await this.restorePending();
      if (!this.options.summarizeConversation) throw new Error('This session has no semantic compaction provider.');
      if (this.active || this.suspended || this.queued.length > 0) throw new Error('Session compaction requires an idle session with no queued work.');
      this.compacting = true;
      try {
        const entireConversation = await this.options.repository.readConversation(this.options.descriptor);
        let previousCompaction = -1;
        for (let index = entireConversation.length - 1; index >= 0; index -= 1) {
          if (entireConversation[index]?.type === 'compaction') { previousCompaction = index; break; }
        }
        if (entireConversation.length === 0 || previousCompaction === entireConversation.length - 1) throw new Error('Session compaction requires new completed conversation history.');
        const conversation = Object.freeze(entireConversation.slice(Math.max(0, previousCompaction)));
        const summary = await this.options.summarizeConversation({ configuration: this.configuration, conversation });
        const compaction = await this.options.repository.appendCompaction(this.options.descriptor, {
          summary, provider: this.configuration.provider, model: this.configuration.model
        });
        await this.emit({ type: 'compaction.completed', compaction });
        return compaction;
      } finally {
        this.compacting = false;
      }
    });
  }

  branchFrom(entryId: string, label?: string): Promise<SessionBranchMarkerEntry> {
    return this.serial(async () => {
      await this.restorePending();
      if (this.active || this.suspended || this.compacting || this.queued.length > 0) throw new Error('Session branching requires an idle session with no queued work.');
      return this.options.repository.branchFrom(this.options.descriptor, entryId, label);
    });
  }

  inspectSuspension(): AgentSessionSuspensionDescriptor | undefined {
    return this.suspended?.descriptor;
  }

  async reconcileExternal(expectedRunId: string): Promise<AgentRunResult> {
    return this.continueSuspension('external_recovery', expectedRunId);
  }

  async resumeImplementation(expectedRunId: string): Promise<AgentRunResult> {
    return this.continueSuspension('implementation', expectedRunId);
  }

  async resolveDecision(input: {
    readonly runId: string;
    readonly decisionRequestId: string;
    readonly choice: string;
    readonly fingerprint: string;
    readonly expectedOperationRevision: number;
  }): Promise<AgentRunResult> {
    const started = await this.serial(async () => {
      await this.restorePending();
      if (this.active) throw new Error(`Session ${this.options.descriptor.id} already has an active run.`);
      const suspended = this.requireSuspension('user_decision', input.runId);
      const operation = await this.options.operations.inspect(input.runId);
      const phase = operation.state.phase;
      if (phase.kind !== 'suspended' || phase.reason !== 'user_decision') throw new Error(`Run ${input.runId} is not waiting for a user decision.`);
      const request = phase.decisionRequest;
      if (request.id !== input.decisionRequestId || request.fingerprint !== input.fingerprint
        || request.operationRevision !== input.expectedOperationRevision
        || (operation.state.control.status !== 'abort_requested' && operation.state.revision !== input.expectedOperationRevision)) {
        throw new Error(`Decision request for run ${input.runId} is stale.`);
      }
      if (!request.choices.includes(input.choice)) throw new Error(`Decision choice ${input.choice} is not permitted for ${request.id}.`);
      if (input.choice !== 'abort') throw new Error(`Decision choice ${input.choice} has no implemented continuation.`);
      await this.options.operations.requestAbort(input.runId, request.reason);
      return this.startSuspendedSubmission(suspended);
    });
    return started.completion;
  }

  async resolveApproval(input: { readonly runId: string; readonly approvalId: string; readonly fingerprint: string; readonly decision: 'allow' | 'deny'; readonly signal?: AbortSignal }): Promise<AgentRunResult> {
    const started = await this.serial(async () => {
      await this.restorePending();
      if (this.active) throw new Error(`Session ${this.options.descriptor.id} already has an active run.`);
      if (this.suspended?.descriptor.reason !== 'approval_required') throw new Error(`Session ${this.options.descriptor.id} is not waiting for approval.`);
      if (this.suspended.runId !== input.runId) throw new Error(`Session is suspended on run ${this.suspended.runId}, not ${input.runId}.`);
      const suspended = this.suspended;
      const configuration = suspended.configuration;
      await this.options.repository.transitionSubmission(this.options.descriptor, suspended.submissionId, { state: 'claimed' });
      try {
        const runtime = await this.createRuntime(suspended.submissionId, input.runId, suspended.input, configuration, true);
        const control = await runtime.resolveApproval(input);
        const pending = pendingSubmission(suspended.submissionId, input.runId, suspended.input, configuration);
        this.suspended = undefined;
        this.observe({ control, pending, configuration });
        return { completion: pending.completion };
      } catch (error) {
        this.suspended = undefined;
        await this.options.repository.transitionSubmission(this.options.descriptor, suspended.submissionId, { state: 'failed', errorMessage: errorMessage(error) });
        await this.launchNext();
        throw error;
      }
    });
    return started.completion;
  }

  async abort(reason = 'Agent run aborted.', expectedRunId?: string): Promise<boolean> {
    return this.serial(async () => {
      await this.restorePending();
      if (this.active) {
        if (expectedRunId !== undefined && this.active.control.runId !== expectedRunId) return false;
        await this.active.control.abort(reason);
        return true;
      }
      const suspended = this.suspended;
      if (!suspended || (expectedRunId !== undefined && suspended.runId !== expectedRunId)) return false;
      await this.options.operations.requestAbort(suspended.runId, reason);
      await this.options.repository.transitionSubmission(this.options.descriptor, suspended.submissionId, { state: 'claimed' });
      const runtime = await this.createRuntime(suspended.submissionId, suspended.runId, suspended.input, suspended.configuration, true);
      const control = runtime.resume(suspended.runId);
      const pending = pendingSubmission(suspended.submissionId, suspended.runId, suspended.input, suspended.configuration);
      this.suspended = undefined;
      this.observe({ control, pending, configuration: suspended.configuration });
      return true;
    });
  }

  async waitForIdle(): Promise<void> {
    await this.startReadyWork();
    while (this.active || (!this.suspended && this.queued.length > 0)) {
      if (this.active) await this.active.pending.completion.catch(() => undefined);
      await this.operations;
    }
  }

  private async continueSuspension(category: 'external_recovery' | 'implementation', expectedRunId: string): Promise<AgentRunResult> {
    const started = await this.serial(async () => {
      await this.restorePending();
      if (this.active) throw new Error(`Session ${this.options.descriptor.id} already has an active run.`);
      return this.startSuspendedSubmission(this.requireSuspension(category, expectedRunId));
    });
    return started.completion;
  }

  private requireSuspension(category: AgentSessionSuspensionCategory, expectedRunId: string): SuspendedSubmission {
    const suspended = this.suspended;
    if (!suspended) throw new Error(`Session ${this.options.descriptor.id} is not suspended.`);
    if (suspended.runId !== expectedRunId) throw new Error(`Session is suspended on run ${suspended.runId}, not ${expectedRunId}.`);
    if (suspended.descriptor.category !== category) throw new Error(`Session suspension ${suspended.descriptor.reason} does not permit this action.`);
    return suspended;
  }

  private async startSuspendedSubmission(suspended: SuspendedSubmission): Promise<{ readonly completion: Promise<AgentRunResult> }> {
    await this.options.repository.transitionSubmission(this.options.descriptor, suspended.submissionId, { state: 'claimed' });
    try {
      const runtime = await this.createRuntime(suspended.submissionId, suspended.runId, suspended.input, suspended.configuration, true);
      const control = runtime.resume(suspended.runId);
      const pending = pendingSubmission(suspended.submissionId, suspended.runId, suspended.input, suspended.configuration);
      this.suspended = undefined;
      this.observe({ control, pending, configuration: suspended.configuration });
      return { completion: pending.completion };
    } catch (error) {
      this.suspended = undefined;
      await this.options.repository.transitionSubmission(this.options.descriptor, suspended.submissionId, { state: 'failed', errorMessage: errorMessage(error) });
      await this.launchNext();
      throw error;
    }
  }

  private async restorePending(): Promise<void> {
    if (this.restored) return;
    const pending = await this.options.repository.loadPendingSubmissions(this.options.descriptor);
    for (const submission of pending) {
      if (submission.state === 'claimed') {
        const operation = await this.options.operations.inspect(submission.runId);
        if (operation.state.phase.kind === 'approval') {
          this.suspended = suspendedSubmission(submission, requireOperationSuspensionDescriptor(submission.submissionId, operation.state));
        } else {
          const descriptor = operationSuspensionDescriptor(submission.submissionId, operation.state);
          if (descriptor) this.suspended = suspendedSubmission(submission, descriptor);
          else this.queued.push(pendingFromRecord(submission, true));
        }
      } else if (submission.state === 'suspended') {
        if (this.suspended) throw new Error(`Session has multiple suspended submissions: ${this.suspended.submissionId} and ${submission.submissionId}.`);
        if (!submission.suspension) throw new Error(`Suspended submission ${submission.submissionId} has no durable suspension descriptor.`);
        const operation = await this.options.operations.inspect(submission.runId);
        const current = operationSuspensionDescriptor(submission.submissionId, operation.state);
        if (submission.suspension.reason !== 'missing_implementation' && (!current || !sameSuspension(submission.suspension, current))) {
          throw new Error(`Suspended submission ${submission.submissionId} contradicts its operation suspension.`);
        }
        this.suspended = suspendedSubmission(submission, submission.suspension);
      } else {
        this.queued.push(pendingFromRecord(submission, false));
      }
    }
    this.restored = true;
  }

  private async launch(pending: PendingSubmission): Promise<Extract<AgentSessionSubmissionResult, { kind: 'started' }>> {
    if (!pending.resumeExisting) await this.options.repository.transitionSubmission(this.options.descriptor, pending.id, { state: 'claimed' });
    try {
      const configuration = pending.configuration;
      const runtime = await this.createRuntime(pending.id, pending.runId, pending.input, configuration, pending.resumeExisting);
      const control = pending.resumeExisting ? runtime.resume(pending.runId) : runtime.run({ ...pending.input, runId: pending.runId });
      this.observe({ control, pending, configuration });
      return { kind: 'started', submissionId: pending.id, runId: control.runId, completion: pending.completion };
    } catch (error) {
      await this.options.repository.transitionSubmission(this.options.descriptor, pending.id, { state: 'failed', errorMessage: errorMessage(error) });
      throw error;
    }
  }

  private observe(active: ActiveSubmission): void {
    this.active = active;
    void active.control.result
      .then(
        (result) => this.serial(() => this.settle(active, result)).catch((error: unknown) => this.serial(() => this.fail(active, error))),
        (error: unknown) => this.serial(() => this.fail(active, error))
      )
      .catch(() => undefined);
  }

  private createRuntime(
    submissionId: string,
    runId: string,
    input: AgentRunInput,
    configuration: AgentSessionConfiguration,
    resuming: boolean
  ): Promise<AgentRuntime> {
    return Promise.resolve(this.options.createRuntime(
      configuration,
      (event) => this.emit({ type: 'run.progress', runId, event }),
      Object.freeze({ submissionId, runId, input, resuming })
    ));
  }

  private async settle(active: ActiveSubmission, result: AgentRunResult): Promise<void> {
    if (this.active !== active) return;
    let suspension: AgentSessionSuspensionDescriptor | undefined;
    if (result.state === 'suspended') {
      const operation = await this.options.operations.inspect(result.runId);
      suspension = result.reason === 'missing_implementation'
        ? suspensionFromResult(active.pending.id, result)
        : requireOperationSuspensionDescriptor(active.pending.id, operation.state);
      await this.options.repository.transitionSubmission(this.options.descriptor, active.pending.id, { state: 'suspended', suspension });
    } else await this.options.repository.transitionSubmission(this.options.descriptor, active.pending.id, { state: 'completed' });
    this.active = undefined;
    this.suspended = suspension ? { runId: suspension.runId, submissionId: active.pending.id, input: active.pending.input, configuration: active.configuration, descriptor: suspension } : undefined;
    active.pending.resolve(result);
    await this.emit({ type: 'run.completed', runId: active.control.runId, result });
    if (!this.suspended) await this.launchNext();
  }

  private async fail(active: ActiveSubmission, error: unknown): Promise<void> {
    if (this.active !== active) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    let failure = cause;
    let persisted = true;
    try {
      await this.options.repository.transitionSubmission(this.options.descriptor, active.pending.id, { state: 'failed', errorMessage: cause.message });
    } catch (persistenceError) {
      persisted = false;
      failure = new AggregateError([cause, persistenceError], 'The run and its durable session admission both failed.', { cause });
    }
    this.active = undefined;
    active.pending.reject(failure);
    await this.emit({ type: 'run.failed', runId: active.pending.runId, error: failure });
    if (persisted) await this.launchNext();
    else for (const queued of this.queued.splice(0)) queued.reject(failure);
  }

  private async launchNext(): Promise<void> {
    while (!this.active && !this.suspended) {
      const next = this.queued.shift();
      if (!next) return;
      try { await this.launch(next); }
      catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        next.reject(failure);
        await this.emit({ type: 'run.failed', runId: next.runId, error: failure });
      }
    }
  }

  private enqueue(pending: PendingSubmission): void {
    this.queued.push(pending);
    void this.emit({ type: 'input.queued', submissionId: pending.id, queuedInputs: this.queued.length });
  }

  private async emit(event: AgentSessionEvent): Promise<void> {
    for (const listener of this.listeners) {
      try { await listener(event); }
      catch { /* Delivery observers cannot change authoritative session state. */ }
    }
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface PendingSubmission {
  readonly id: string;
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly configuration: AgentSessionConfiguration;
  readonly resumeExisting: boolean;
  readonly completion: Promise<AgentRunResult>;
  readonly resolve: (result: AgentRunResult) => void;
  readonly reject: (error: unknown) => void;
}

interface ActiveSubmission {
  readonly control: AgentRunControl;
  readonly pending: PendingSubmission;
  readonly configuration: AgentSessionConfiguration;
}

interface SuspendedSubmission {
  readonly runId: string;
  readonly submissionId: string;
  readonly input: AgentRunInput;
  readonly configuration: AgentSessionConfiguration;
  readonly descriptor: AgentSessionSuspensionDescriptor;
}

function suspendedSubmission(record: SessionPendingSubmission, descriptor: AgentSessionSuspensionDescriptor): SuspendedSubmission {
  return Object.freeze({
    runId: record.runId, submissionId: record.submissionId, input: record.input,
    configuration: record.configuration, descriptor
  });
}

function pendingFromRecord(record: SessionPendingSubmission, resumeExisting: boolean): PendingSubmission {
  return pendingSubmission(record.submissionId, record.runId, record.input, record.configuration, resumeExisting);
}

function pendingSubmission(id: string, runId: string, input: SessionSubmissionInput | AgentRunInput, configuration: AgentSessionConfiguration, resumeExisting = false): PendingSubmission {
  let resolve!: (result: AgentRunResult) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<AgentRunResult>((resolveResult, rejectResult) => { resolve = resolveResult; reject = rejectResult; });
  void completion.catch(() => undefined);
  const ownedInput: AgentRunInput = Object.freeze({
    task: input.task, runId,
    ...(input.instructions === undefined ? {} : { instructions: Object.freeze([...input.instructions]) }),
    ...(input.contextItems === undefined ? {} : { contextItems: Object.freeze(input.contextItems.map((item) => Object.freeze({
      ...item, ...(item.range === undefined ? {} : { range: Object.freeze({ ...item.range }) })
    }))) })
  });
  return { id, runId, input: ownedInput, configuration: ownSessionSubmissionConfiguration(configuration), resumeExisting, completion, resolve, reject };
}

function submissionInput(input: AgentRunInput): SessionSubmissionInput {
  return Object.freeze({ task: input.task,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.contextItems === undefined ? {} : { contextItems: input.contextItems }) });
}

function ownConfiguration(configuration: AgentSessionConfiguration): AgentSessionConfiguration {
  return ownSessionSubmissionConfiguration(configuration);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requireOperationSuspensionDescriptor(submissionId: string, state: import('../operation/contracts.js').AgentOperationState): AgentSessionSuspensionDescriptor {
  const descriptor = operationSuspensionDescriptor(submissionId, state);
  if (!descriptor) throw new Error(`Run ${state.runId} has no durable suspension state.`);
  return descriptor;
}

function operationSuspensionDescriptor(submissionId: string, state: import('../operation/contracts.js').AgentOperationState): AgentSessionSuspensionDescriptor | undefined {
  const phase = state.phase;
  if (phase.kind === 'approval') return Object.freeze({
    runId: state.runId, submissionId, category: 'approval', reason: 'approval_required', actions: suspensionActions('approval', 'abort')
  });
  if (phase.kind === 'provider' && phase.stage === 'outcome_unknown') return externalSuspension(submissionId, state.runId, 'provider_outcome_unknown', phase.effect.intent.effectId);
  if (phase.kind === 'tools') {
    const unknown = phase.callStates.find((call) => call.stage === 'outcome_unknown');
    if (unknown?.stage === 'outcome_unknown') return externalSuspension(submissionId, state.runId, 'tool_outcome_unknown', unknown.effect.intent.effectId);
  }
  if (phase.kind === 'disposition' && phase.stage === 'outcome_unknown') return externalSuspension(submissionId, state.runId, 'disposition_outcome_unknown', phase.effect.intent.effectId);
  if (phase.kind !== 'suspended') return undefined;
  if (phase.reason === 'missing_implementation') return Object.freeze({
    runId: state.runId, submissionId, category: 'implementation', reason: phase.reason,
    ...(phase.effectId ? { effectId: phase.effectId } : {}), actions: suspensionActions('resume', 'abort')
  });
  if (phase.reason === 'user_decision') return Object.freeze({
    runId: state.runId, submissionId, category: 'user_decision', reason: phase.reason,
    ...(phase.effectId ? { effectId: phase.effectId } : {}), actions: suspensionActions('decide', 'abort'), decisionRequest: phase.decisionRequest
  });
  return externalSuspension(submissionId, state.runId, phase.reason, phase.effectId);
}

function suspensionFromResult(submissionId: string, result: Extract<AgentRunResult, { readonly state: 'suspended' }>): AgentSessionSuspensionDescriptor {
  if (result.reason !== 'missing_implementation') throw new Error(`Suspension ${result.reason} must be derived from durable operation state.`);
  return Object.freeze({
    runId: result.runId, submissionId, category: 'implementation', reason: result.reason,
    ...(result.effectId ? { effectId: result.effectId } : {}), actions: suspensionActions('resume', 'abort')
  });
}

function externalSuspension(
  submissionId: string,
  runId: string,
  reason: 'provider_outcome_unknown' | 'tool_outcome_unknown' | 'disposition_outcome_unknown',
  effectId?: string
): AgentSessionSuspensionDescriptor {
  return Object.freeze({
    runId, submissionId, category: 'external_recovery', reason,
    ...(effectId ? { effectId } : {}), actions: suspensionActions('reconcile', 'abort')
  });
}

function suspensionActions(...actions: AgentSessionSuspensionAction[]): readonly AgentSessionSuspensionAction[] {
  return Object.freeze(actions);
}

function sameSuspension(left: AgentSessionSuspensionDescriptor, right: AgentSessionSuspensionDescriptor): boolean {
  return hashJson(normalizeJsonSafe(left).value) === hashJson(normalizeJsonSafe(right).value);
}
