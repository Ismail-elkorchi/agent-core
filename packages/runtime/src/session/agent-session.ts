import { randomUUID } from 'node:crypto';
import type { ModelReasoningRequest, ModelResponseFormat } from '@agent-core/model';
import {
  AgentRuntime,
  type AgentRunControl,
  type AgentRunInput
} from '../agent-runtime.js';
import type { AgentProgressEvent } from '../events.js';
import type { AgentRunResult } from '../run/contracts.js';
import type { SessionDescriptor } from './contracts.js';

export interface AgentSessionConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly responseFormat?: ModelResponseFormat;
}

export interface AgentSessionState {
  readonly sessionId: string;
  readonly phase: 'idle' | 'running' | 'waiting_for_approval';
  readonly configuration: AgentSessionConfiguration;
  readonly activeRunId?: string;
  readonly queuedInputs: number;
}

export type AgentSessionEvent =
  | { readonly type: 'run.progress'; readonly runId: string; readonly event: AgentProgressEvent }
  | { readonly type: 'run.completed'; readonly runId: string; readonly result: AgentRunResult }
  | { readonly type: 'run.failed'; readonly runId: string; readonly error: Error }
  | { readonly type: 'configuration.changed'; readonly configuration: AgentSessionConfiguration }
  | { readonly type: 'input.queued'; readonly submissionId: string; readonly queuedInputs: number };

export type AgentSessionSubmissionResult =
  | { readonly kind: 'started'; readonly submissionId: string; readonly runId: string; readonly completion: Promise<AgentRunResult> }
  | { readonly kind: 'steered'; readonly submissionId: string; readonly runId: string; readonly completion: Promise<AgentRunResult> }
  | { readonly kind: 'queued'; readonly submissionId: string; readonly completion: Promise<AgentRunResult> }
  | { readonly kind: 'rejected'; readonly reason: 'no_active_run' | 'run_mismatch' };

export interface AgentSessionOptions {
  readonly descriptor: SessionDescriptor;
  readonly configuration: AgentSessionConfiguration;
  readonly createRuntime: (configuration: AgentSessionConfiguration, onProgress: (event: AgentProgressEvent) => void | Promise<void>) => AgentRuntime;
  readonly maximumQueuedInputs?: number;
}

export class AgentSession {
  private configuration: AgentSessionConfiguration;
  private readonly maximumQueuedInputs: number;
  private readonly queued: PendingSubmission[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  private active: ActiveSubmission | undefined;
  private suspended: { readonly runId: string; readonly configuration: AgentSessionConfiguration } | undefined;
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentSessionOptions) {
    const maximumQueuedInputs = options.maximumQueuedInputs ?? 1024;
    if (!Number.isSafeInteger(maximumQueuedInputs) || maximumQueuedInputs < 0) throw new Error('maximumQueuedInputs must be a non-negative safe integer.');
    this.maximumQueuedInputs = maximumQueuedInputs;
    this.configuration = ownConfiguration(options.configuration);
  }

  state(): AgentSessionState {
    return Object.freeze({
      sessionId: this.options.descriptor.id,
      phase: this.active ? 'running' : this.suspended ? 'waiting_for_approval' : 'idle',
      configuration: this.configuration,
      ...(this.active ? { activeRunId: this.active.control.runId } : this.suspended ? { activeRunId: this.suspended.runId } : {}),
      queuedInputs: this.queued.length
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  configure(settings: Partial<AgentSessionConfiguration>): Promise<AgentSessionState> {
    return this.serial(async () => {
      this.configuration = ownConfiguration({ ...this.configuration, ...settings });
      await this.emit({ type: 'configuration.changed', configuration: this.configuration });
      return this.state();
    });
  }

  submit(input: AgentRunInput, options: { readonly delivery?: 'default' | 'steer' | 'follow_up'; readonly expectedRunId?: string } = {}): Promise<AgentSessionSubmissionResult> {
    return this.serial(() => {
      const task = input.task.trim();
      if (task.length === 0) throw new Error('Session input must not be empty.');
      const submissionId = randomUUID();
      const delivery = options.delivery ?? 'default';
      if (delivery === 'steer') {
        if (!this.active) return { kind: 'rejected', reason: 'no_active_run' };
        if (options.expectedRunId !== undefined && options.expectedRunId !== this.active.control.runId) return { kind: 'rejected', reason: 'run_mismatch' };
        this.active.control.injectSteering({ instruction: task });
        return { kind: 'steered', submissionId, runId: this.active.control.runId, completion: this.active.pending.completion };
      }
      const pending = pendingSubmission(submissionId, { ...input, task });
      if (this.active || this.suspended) {
        this.enqueue(pending);
        return { kind: 'queued', submissionId, completion: pending.completion };
      }
      return this.launch(pending, this.configuration);
    });
  }

  async resolveApproval(input: { readonly runId: string; readonly approvalId: string; readonly fingerprint: string; readonly decision: 'allow' | 'deny'; readonly signal?: AbortSignal }): Promise<AgentRunResult> {
    const started = await this.serial(async () => {
      if (this.active) throw new Error(`Session ${this.options.descriptor.id} already has an active run.`);
      if (this.suspended && this.suspended.runId !== input.runId) throw new Error(`Session is suspended on run ${this.suspended.runId}, not ${input.runId}.`);
      const configuration = this.suspended?.configuration ?? this.configuration;
      const runtime = this.options.createRuntime(configuration, (event) => this.emit({ type: 'run.progress', runId: input.runId, event }));
      const control = await runtime.resumeApproval(input);
      const pending = pendingSubmission(randomUUID(), { task: `resume approval ${input.approvalId}`, runId: input.runId });
      this.suspended = undefined;
      this.observe({ control, pending, configuration });
      return { completion: pending.completion };
    });
    return started.completion;
  }

  abort(reason = 'Agent run aborted.', expectedRunId?: string): boolean {
    if (!this.active || (expectedRunId !== undefined && this.active.control.runId !== expectedRunId)) return false;
    this.active.control.abort(reason);
    return true;
  }

  async waitForIdle(): Promise<void> {
    while (this.active || (!this.suspended && this.queued.length > 0)) {
      if (this.active) await this.active.pending.completion.catch(() => undefined);
      await this.operations;
    }
  }

  private launch(pending: PendingSubmission, configuration: AgentSessionConfiguration): Extract<AgentSessionSubmissionResult, { kind: 'started' }> {
    const runtime = this.options.createRuntime(configuration, (event) => this.emit({ type: 'run.progress', runId: pending.runId, event }));
    const control = runtime.run({ ...pending.input, runId: pending.runId });
    this.observe({ control, pending, configuration });
    return { kind: 'started', submissionId: pending.id, runId: control.runId, completion: pending.completion };
  }

  private observe(active: ActiveSubmission): void {
    this.active = active;
    void active.control.result.then(
      (result) => this.serial(() => this.settle(active, result)),
      (error: unknown) => this.serial(() => this.fail(active, error))
    );
  }

  private async settle(active: ActiveSubmission, result: AgentRunResult): Promise<void> {
    if (this.active !== active) return;
    this.active = undefined;
    this.suspended = result.state === 'suspended' ? { runId: result.runId, configuration: active.configuration } : undefined;
    active.pending.resolve(result);
    await this.emit({ type: 'run.completed', runId: active.control.runId, result });
    if (!this.suspended) await this.launchNext();
  }

  private async fail(active: ActiveSubmission, error: unknown): Promise<void> {
    if (this.active !== active) return;
    this.active = undefined;
    await this.rejectAccepted(active.pending, error);
  }

  private async launchNext(): Promise<void> {
    const next = this.queued.shift();
    if (!next) return;
    try {
      this.launch(next, this.configuration);
    } catch (error) {
      await this.rejectAccepted(next, error);
    }
  }

  private async rejectAccepted(pending: PendingSubmission, error: unknown): Promise<void> {
    const failure = error instanceof Error ? error : new Error(String(error));
    pending.reject(failure);
    for (const queued of this.queued.splice(0)) queued.reject(failure);
    await this.emit({ type: 'run.failed', runId: pending.runId, error: failure });
  }

  private enqueue(pending: PendingSubmission): void {
    if (this.queued.length >= this.maximumQueuedInputs) throw new Error(`Session input queue limit of ${String(this.maximumQueuedInputs)} was reached.`);
    this.queued.push(pending);
    void this.emit({ type: 'input.queued', submissionId: pending.id, queuedInputs: this.queued.length });
  }

  private async emit(event: AgentSessionEvent): Promise<void> {
    for (const listener of this.listeners) {
      try { await listener(event); }
      catch {
        // Delivery observers cannot change authoritative session state.
      }
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
  readonly completion: Promise<AgentRunResult>;
  readonly resolve: (result: AgentRunResult) => void;
  readonly reject: (error: unknown) => void;
}

interface ActiveSubmission {
  readonly control: AgentRunControl;
  readonly pending: PendingSubmission;
  readonly configuration: AgentSessionConfiguration;
}

function pendingSubmission(id: string, input: AgentRunInput): PendingSubmission {
  const runId = input.runId ?? randomUUID();
  let resolve!: (result: AgentRunResult) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<AgentRunResult>((resolveResult, rejectResult) => { resolve = resolveResult; reject = rejectResult; });
  void completion.catch(() => undefined);
  const ownedInput = Object.freeze({
    ...input,
    runId,
    ...(input.instructions === undefined ? {} : { instructions: Object.freeze([...input.instructions]) }),
    ...(input.contextItems === undefined ? {} : {
      contextItems: Object.freeze(input.contextItems.map((item) => Object.freeze({
        ...item,
        ...(item.range === undefined ? {} : { range: Object.freeze({ ...item.range }) })
      })))
    })
  });
  return { id, runId, input: ownedInput, completion, resolve, reject };
}

function ownConfiguration(configuration: AgentSessionConfiguration): AgentSessionConfiguration {
  if (configuration.provider.trim().length === 0 || configuration.model.trim().length === 0) throw new Error('Session provider and model must be non-empty.');
  const { reasoning, responseFormat, ...scalars } = configuration;
  return Object.freeze({
    ...scalars,
    ...(reasoning === undefined ? {} : { reasoning: Object.freeze({ ...reasoning }) }),
    ...(responseFormat === undefined ? {} : {
      responseFormat: typeof responseFormat === 'string' ? responseFormat : Object.freeze({ ...responseFormat })
    })
  });
}
