import { randomUUID } from 'node:crypto';
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
  SessionSubmissionConfiguration,
  SessionSubmissionInput
} from './contracts.js';
import { ownSessionSubmissionConfiguration } from './submission-lifecycle.js';

export type AgentSessionConfiguration = SessionSubmissionConfiguration;

export interface AgentSessionState {
  readonly sessionId: string;
  readonly phase: 'idle' | 'running' | 'waiting_for_user' | 'compacting';
  readonly configuration: AgentSessionConfiguration;
  readonly activeRunId?: string;
  readonly queuedInputs: number;
  readonly suspensionReason?: Exclude<AgentRunResult, { readonly state: 'ended' }>['reason'];
}

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
  | { readonly kind: 'rejected'; readonly reason: 'no_active_run' | 'run_mismatch' };

export interface AgentSessionOptions {
  readonly descriptor: SessionDescriptor;
  readonly repository: SessionRepository;
  readonly operations: AgentOperationCoordinator;
  readonly configuration: AgentSessionConfiguration;
  readonly createRuntime: (configuration: AgentSessionConfiguration, onProgress: (event: AgentProgressEvent) => void | Promise<void>) => AgentRuntime;
  readonly summarizeConversation?: (request: AgentSessionCompactionRequest) => Promise<string>;
  readonly maximumQueuedInputs?: number;
}

export class AgentSession {
  private configuration: AgentSessionConfiguration;
  private readonly maximumQueuedInputs: number;
  private readonly queued: PendingSubmission[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  private active: ActiveSubmission | undefined;
  private suspended: { readonly runId: string; readonly submissionId: string; readonly input: AgentRunInput; readonly configuration: AgentSessionConfiguration; readonly reason: Exclude<AgentRunResult, { readonly state: 'ended' }>['reason'] } | undefined;
  private operations: Promise<void> = Promise.resolve();
  private restored = false;
  private compacting = false;

  constructor(private readonly options: AgentSessionOptions) {
    const maximumQueuedInputs = options.maximumQueuedInputs ?? 1024;
    if (!Number.isSafeInteger(maximumQueuedInputs) || maximumQueuedInputs < 0) throw new Error('maximumQueuedInputs must be a non-negative safe integer.');
    this.maximumQueuedInputs = maximumQueuedInputs;
    this.configuration = ownConfiguration(options.configuration);
  }

  state(): AgentSessionState {
    return Object.freeze({
      sessionId: this.options.descriptor.id,
      phase: this.active ? 'running' : this.suspended ? 'waiting_for_user' : this.compacting ? 'compacting' : 'idle',
      configuration: this.configuration,
      ...(this.active ? { activeRunId: this.active.control.runId } : this.suspended ? { activeRunId: this.suspended.runId } : {}),
      queuedInputs: this.queued.length,
      ...(this.suspended ? { suspensionReason: this.suspended.reason } : {})
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  restore(): Promise<void> {
    return this.serial(() => this.restorePending());
  }

  resumePending(): Promise<void> {
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
        await this.options.repository.appendSteering(this.options.descriptor.id, { runId: this.active.control.runId, content: task });
        this.active.control.injectSteering({ instruction: task });
        return { kind: 'steered', submissionId, runId: this.active.control.runId, completion: this.active.pending.completion };
      }
      if (input.signal !== undefined) throw new Error('Durable session submissions cannot retain an AbortSignal; abort the active run through AgentSession.abort().');
      const pending = pendingSubmission(submissionId, input.runId ?? randomUUID(), { ...input, task }, this.configuration);
      if ((this.active || this.suspended || this.compacting) && this.queued.length >= this.maximumQueuedInputs) {
        throw new Error(`Session input queue limit of ${String(this.maximumQueuedInputs)} was reached.`);
      }
      await this.options.repository.enqueueSubmission(this.options.descriptor.id, {
        submissionId, runId: pending.runId, input: submissionInput(pending.input), configuration: pending.configuration
      });
      if (this.active || this.suspended || this.compacting || this.queued.length > 0) {
        this.enqueue(pending);
        if (!this.active && !this.suspended && !this.compacting) await this.launchNext();
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
        const entireConversation = await this.options.repository.readConversation(this.options.descriptor.id);
        let previousCompaction = -1;
        for (let index = entireConversation.length - 1; index >= 0; index -= 1) {
          if (entireConversation[index]?.type === 'compaction') { previousCompaction = index; break; }
        }
        if (entireConversation.length === 0 || previousCompaction === entireConversation.length - 1) throw new Error('Session compaction requires new completed conversation history.');
        const conversation = Object.freeze(entireConversation.slice(Math.max(0, previousCompaction)));
        const summary = await this.options.summarizeConversation({ configuration: this.configuration, conversation });
        const compaction = await this.options.repository.appendCompaction(this.options.descriptor.id, {
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
      return this.options.repository.branchFrom(this.options.descriptor.id, entryId, label);
    });
  }

  async resolveApproval(input: { readonly runId: string; readonly approvalId: string; readonly fingerprint: string; readonly decision: 'allow' | 'deny'; readonly signal?: AbortSignal }): Promise<AgentRunResult> {
    const started = await this.serial(async () => {
      await this.restorePending();
      if (this.active) throw new Error(`Session ${this.options.descriptor.id} already has an active run.`);
      if (this.suspended?.reason !== 'approval_required') throw new Error(`Session ${this.options.descriptor.id} is not waiting for approval.`);
      if (this.suspended.runId !== input.runId) throw new Error(`Session is suspended on run ${this.suspended.runId}, not ${input.runId}.`);
      const suspended = this.suspended;
      const configuration = suspended.configuration;
      await this.options.repository.transitionSubmission(this.options.descriptor.id, suspended.submissionId, { state: 'claimed' });
      try {
        const runtime = this.options.createRuntime(configuration, (event) => this.emit({ type: 'run.progress', runId: input.runId, event }));
        const control = await runtime.resumeApproval(input);
        const pending = pendingSubmission(suspended.submissionId, input.runId, suspended.input, configuration);
        this.suspended = undefined;
        this.observe({ control, pending, configuration });
        return { completion: pending.completion };
      } catch (error) {
        this.suspended = undefined;
        await this.options.repository.transitionSubmission(this.options.descriptor.id, suspended.submissionId, { state: 'failed', errorMessage: errorMessage(error) });
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
      await this.options.repository.transitionSubmission(this.options.descriptor.id, suspended.submissionId, { state: 'claimed' });
      const runtime = this.options.createRuntime(suspended.configuration, (event) => this.emit({ type: 'run.progress', runId: suspended.runId, event }));
      const control = runtime.resume(suspended.runId);
      const pending = pendingSubmission(suspended.submissionId, suspended.runId, suspended.input, suspended.configuration);
      this.suspended = undefined;
      this.observe({ control, pending, configuration: suspended.configuration });
      return true;
    });
  }

  async waitForIdle(): Promise<void> {
    await this.resumePending();
    while (this.active || (!this.suspended && this.queued.length > 0)) {
      if (this.active) await this.active.pending.completion.catch(() => undefined);
      await this.operations;
    }
  }

  private async restorePending(): Promise<void> {
    if (this.restored) return;
    const pending = await this.options.repository.loadPendingSubmissions(this.options.descriptor.id);
    for (const submission of pending) {
      if (submission.state === 'claimed') {
        const operation = await this.options.operations.inspect(submission.runId);
        if (operation.state.phase.kind === 'approval') {
          this.suspended = { runId: submission.runId, submissionId: submission.submissionId, input: submission.input, configuration: submission.configuration, reason: 'approval_required' };
        } else if (operation.state.phase.kind === 'suspended') {
          this.suspended = { runId: submission.runId, submissionId: submission.submissionId, input: submission.input, configuration: submission.configuration, reason: operation.state.phase.reason };
        } else {
          this.queued.push(pendingFromRecord(submission, true));
        }
      } else if (submission.state === 'suspended') {
        if (this.suspended) throw new Error(`Session has multiple suspended submissions: ${this.suspended.submissionId} and ${submission.submissionId}.`);
        const operation = await this.options.operations.inspect(submission.runId);
        const reason = operation.state.phase.kind === 'approval'
          ? 'approval_required'
          : operation.state.phase.kind === 'suspended'
            ? operation.state.phase.reason
            : undefined;
        if (!reason) throw new Error(`Suspended submission ${submission.submissionId} has no matching operation suspension.`);
        this.suspended = { runId: submission.runId, submissionId: submission.submissionId, input: submission.input, configuration: submission.configuration, reason };
      } else {
        this.queued.push(pendingFromRecord(submission, false));
      }
    }
    this.restored = true;
  }

  private async launch(pending: PendingSubmission): Promise<Extract<AgentSessionSubmissionResult, { kind: 'started' }>> {
    if (!pending.resumeExisting) await this.options.repository.transitionSubmission(this.options.descriptor.id, pending.id, { state: 'claimed' });
    try {
      const configuration = pending.configuration;
      const runtime = this.options.createRuntime(configuration, (event) => this.emit({ type: 'run.progress', runId: pending.runId, event }));
      const control = pending.resumeExisting ? runtime.resume(pending.runId) : runtime.run({ ...pending.input, runId: pending.runId });
      this.observe({ control, pending, configuration });
      return { kind: 'started', submissionId: pending.id, runId: control.runId, completion: pending.completion };
    } catch (error) {
      await this.options.repository.transitionSubmission(this.options.descriptor.id, pending.id, { state: 'failed', errorMessage: errorMessage(error) });
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

  private async settle(active: ActiveSubmission, result: AgentRunResult): Promise<void> {
    if (this.active !== active) return;
    await this.options.repository.transitionSubmission(this.options.descriptor.id, active.pending.id, { state: result.state === 'suspended' ? 'suspended' : 'completed' });
    this.active = undefined;
    this.suspended = result.state === 'suspended' ? { runId: result.runId, submissionId: active.pending.id, input: active.pending.input, configuration: active.configuration, reason: result.reason } : undefined;
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
      await this.options.repository.transitionSubmission(this.options.descriptor.id, active.pending.id, { state: 'failed', errorMessage: cause.message });
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
