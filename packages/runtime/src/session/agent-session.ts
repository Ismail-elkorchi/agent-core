import { hashJson, type ArtifactRepository } from '@agent-core/persistence';
import {
  assertModelRequestSupported,
  type ModelProfile,
  type ModelSelection
} from '@agent-core/model';
import { parseModelChangeRequest, type ModelChangeOptions } from '../orchestration/model-change.js';
import { assertHistoryModelCompatibility } from '../orchestration/session-replay.js';
import { randomUUID } from 'node:crypto';
import { AgentRuntime, type AgentRunHandle, type AgentRunInput } from '../agent-runtime.js';
import type { ContextTransitionRequest } from '../context/contracts.js';
import type { ContextService } from '../context/service.js';
import type { AgentProgressEvent } from '../events.js';
import type { AgentRunResult } from '../run/contracts.js';
import { AgentRunConflictError, AgentRunCoordinator } from '../run/control/driver.js';
import { assertSessionBinding, decodeSessionBinding, type SessionBindingInput } from './binding.js';
import type {
  SessionBranchMarkerEntry,
  SessionContextTransitionEntry,
  SessionDescriptor,
  SessionInputRelationship,
  SessionPendingSubmission,
  SessionRepository,
  SessionSubmissionConfiguration,
  SessionSubmissionInput,
  SessionSuspensionAction,
  SessionSuspensionCategory,
  SessionSuspensionDescriptor
} from './contracts.js';
import { parseSessionImages } from './images.js';
import {
  SessionSubmissionOwnershipError,
  ownSessionSubmissionConfiguration,
  ownSessionSubmissionInput
} from './submission-lifecycle.js';

export type AgentSessionConfiguration = SessionSubmissionConfiguration;

export interface AgentSessionRuntimeContext {
  readonly submissionId: string;
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly resuming: boolean;
}

export interface AgentSessionState {
  readonly sessionId: string;
  readonly phase: 'idle' | 'running' | 'suspended';
  readonly configuration: AgentSessionConfiguration;
  readonly activeRunId?: string;
  readonly queuedInputs: number;
  readonly suspension?: AgentSessionSuspensionDescriptor;
}

export type AgentSessionSuspensionCategory = SessionSuspensionCategory;
export type AgentSessionSuspensionAction = SessionSuspensionAction;
export type AgentSessionSuspensionDescriptor = SessionSuspensionDescriptor;

export type AgentSessionEvent =
  | Extract<AgentProgressEvent, { readonly type: 'context.transition.rejected' }>
  | { readonly type: 'run.progress'; readonly runId: string; readonly event: AgentProgressEvent }
  | { readonly type: 'run.completed'; readonly runId: string; readonly result: AgentRunResult }
  | { readonly type: 'run.failed'; readonly runId: string; readonly error: Error }
  | { readonly type: 'configuration.changed'; readonly configuration: AgentSessionConfiguration }
  | { readonly type: 'input.queued'; readonly submissionId: string; readonly queuedInputs: number }
  | {
      readonly type: 'input.revised' | 'input.cancelled';
      readonly submissionId: string;
      readonly runId: string;
    }
  | {
      readonly type: 'context.transitioned';
      readonly window: SessionContextTransitionEntry['window'];
      readonly transition: SessionContextTransitionEntry['transition'];
    };

export type AgentSessionSubmissionResult =
  | {
      readonly kind: 'started';
      readonly submissionId: string;
      readonly runId: string;
      readonly completion: Promise<AgentRunResult>;
    }
  | {
      readonly kind: 'steered';
      readonly submissionId: string;
      readonly runId: string;
      readonly completion: Promise<AgentRunResult>;
    }
  | {
      readonly kind: 'queued';
      readonly submissionId: string;
      readonly runId: string;
      readonly completion: Promise<AgentRunResult>;
    }
  | { readonly kind: 'rejected'; readonly reason: 'no_active_run' | 'run_mismatch' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'session_suspended';
      readonly suspension: AgentSessionSuspensionDescriptor;
    };

export interface AgentSessionOptions {
  readonly descriptor: SessionDescriptor;
  readonly expectedBinding: SessionBindingInput;
  readonly repository: SessionRepository;
  readonly runs: AgentRunCoordinator;
  readonly configuration: AgentSessionConfiguration;
  readonly createRuntime: (
    configuration: AgentSessionConfiguration,
    onProgress: (event: AgentProgressEvent) => void | Promise<void>,
    context: AgentSessionRuntimeContext
  ) => AgentRuntime | Promise<AgentRuntime>;
  readonly context?: ContextService;
  readonly maximumQueuedInputs?: number;
  /** Manual scheduling leaves admitted input durable until its application starts it. */
  readonly scheduling?: 'automatic' | 'manual';
}

export class AgentSession {
  private configuration: AgentSessionConfiguration;
  private readonly maximumQueuedInputs: number;
  private readonly queued: PendingSubmission[] = [];
  private readonly listeners = new Set<
    Readonly<{
      listener: (event: AgentSessionEvent) => void | Promise<void>;
      onFailure: (error: Error) => void | Promise<void>;
    }>
  >();
  private active: ActiveSubmission | undefined;
  private suspended: SuspendedSubmission | undefined;
  private serialQueue: Promise<void> = Promise.resolve();
  private restored = false;
  private closed = false;
  private closeCompletion: Promise<void> | undefined;

  constructor(private readonly options: AgentSessionOptions) {
    assertSessionBinding(
      options.expectedBinding,
      decodeSessionBinding(options.descriptor.header.binding)
    );
    const maximumQueuedInputs = options.maximumQueuedInputs ?? 1024;
    if (!Number.isSafeInteger(maximumQueuedInputs) || maximumQueuedInputs < 0)
      throw new Error('maximumQueuedInputs must be a non-negative safe integer.');
    this.maximumQueuedInputs = maximumQueuedInputs;
    this.configuration = ownConfiguration(options.configuration);
  }

  state(): AgentSessionState {
    return Object.freeze({
      sessionId: this.options.descriptor.id,
      phase: this.active ? 'running' : this.suspended ? 'suspended' : 'idle',
      configuration: this.configuration,
      ...(this.active
        ? { activeRunId: this.active.control.runId }
        : this.suspended
          ? { activeRunId: this.suspended.runId }
          : {}),
      queuedInputs: this.queued.length,
      ...(this.suspended ? { suspension: this.suspended.descriptor } : {})
    });
  }

  subscribe(
    listener: (event: AgentSessionEvent) => void | Promise<void>,
    onFailure: (error: Error) => void | Promise<void>
  ): () => void {
    const subscription = Object.freeze({ listener, onFailure });
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }

  restore(): Promise<void> {
    return this.serial(() => this.restorePending());
  }

  /** Observe submission admission and run controls at one session scheduling boundary. */
  inspect() {
    return this.serial(async () => {
      await this.restorePending();
      const pendingSubmissions = await this.options.repository.loadPendingSubmissions(
        this.options.descriptor
      );
      const inspections = await Promise.all(
        pendingSubmissions
          .filter((submission) => submission.state !== 'queued')
          .map((submission) => this.options.runs.find(submission.runId))
      );
      const runs = inspections.filter((run) => run !== undefined);
      const toolDiagnostics = (
        await Promise.all(runs.map(({ state }) => this.options.runs.readToolDiagnostics(state)))
      ).flat();
      return { session: this.state(), pendingSubmissions, runs, toolDiagnostics };
    });
  }

  startNextSubmission(): Promise<AgentSessionSubmissionResult | undefined> {
    return this.serial(async () => {
      await this.restorePending();
      if (this.active || this.suspended) return undefined;
      const next = this.queued.shift();
      if (!next) return undefined;
      return this.launch(next);
    });
  }

  private startReadyWork(): Promise<void> {
    return this.serial(async () => {
      await this.restorePending();
      if (!this.active && !this.suspended) await this.launchNext();
    });
  }

  configure(settings: Partial<AgentSessionConfiguration>): Promise<AgentSessionState> {
    return this.serial(async () => {
      this.assertOpen();
      this.configuration = ownConfiguration({ ...this.configuration, ...settings });
      await this.emit({ type: 'configuration.changed', configuration: this.configuration });
      return this.state();
    });
  }

  submit(
    input: AgentRunInput,
    options: {
      readonly delivery?: 'default' | 'steer' | 'follow_up';
      readonly expectedRunId?: string;
      readonly relationship?: SessionInputRelationship;
    } = {}
  ): Promise<AgentSessionSubmissionResult> {
    return this.serial(async () => {
      await this.restorePending();
      const task = input.task;
      if (task.trim().length === 0) throw new Error('Session input must not be empty.');
      const submissionId = randomUUID();
      const delivery = options.delivery ?? 'default';
      if (delivery === 'steer') {
        if (input.images?.length || input.contextItems?.length || input.instructions?.length)
          throw new Error(
            'Steering accepts instruction text. Send attachments as a follow-up input.'
          );
        if (!this.active) return { kind: 'rejected', reason: 'no_active_run' };
        if (
          options.expectedRunId !== undefined &&
          options.expectedRunId !== this.active.control.runId
        )
          return { kind: 'rejected', reason: 'run_mismatch' };
        await this.options.repository.appendSteering(this.options.descriptor, {
          runId: this.active.control.runId,
          content: task,
          deliveryId: submissionId,
          originalInput: submissionInput(input),
          ...(options.relationship ? { relationship: options.relationship } : {})
        });
        this.active.control.injectSteering({ instruction: task, deliveryId: submissionId });
        return {
          kind: 'steered',
          submissionId,
          runId: this.active.control.runId,
          completion: this.active.pending.completion
        };
      }
      if (input.signal !== undefined)
        throw new Error(
          'Durable session submissions cannot retain an AbortSignal; abort the active run through AgentSession.abort().'
        );
      if (this.suspended)
        return {
          kind: 'rejected',
          reason: 'session_suspended',
          suspension: this.suspended.descriptor
        };
      const pending = pendingSubmission(
        submissionId,
        input.runId ?? randomUUID(),
        { ...input, task },
        this.configuration
      );
      if (
        (this.active || this.options.scheduling === 'manual') &&
        this.queued.length >= this.maximumQueuedInputs
      ) {
        throw new Error(
          `Session input queue limit of ${String(this.maximumQueuedInputs)} was reached.`
        );
      }
      await this.options.repository.enqueueSubmission(this.options.descriptor, {
        submissionId,
        runId: pending.runId,
        input: {
          ...submissionInput(pending.input),
          ...(options.relationship ? { relationship: options.relationship } : {})
        },
        configuration: pending.configuration
      });
      if (this.options.scheduling === 'manual' || this.active || this.queued.length > 0) {
        this.enqueue(pending);
        if (!this.active) await this.launchNext();
        return {
          kind: 'queued',
          submissionId,
          runId: pending.runId,
          completion: pending.completion
        };
      }
      return this.launch(pending);
    });
  }

  /** Changes future inference only after durable pending work has reached a lawful boundary. */
  changeModel(
    input: ModelChangeOptions & {
      readonly selection: ModelSelection;
      readonly profile: ModelProfile;
      readonly artifacts: ArtifactRepository;
    }
  ): Promise<AgentSessionState> {
    const { selection, options } = parseModelChangeRequest({
      ...input.selection,
      ...(input.continuation === undefined ? {} : { continuation: input.continuation })
    });
    return this.serial(async () => {
      this.assertOpen();
      await this.restorePending();
      if (this.active || this.suspended || this.queued.length > 0)
        throw new Error(
          'Settle or reconcile pending work and native result deliveries before changing models. Unknown effects remain unresolved.'
        );
      if (input.profile.provider !== selection.provider || input.profile.id !== selection.model)
        throw new Error('The target model profile does not match the selected configuration.');
      assertModelRequestSupported(input.profile, {
        model: selection.model,
        messages: [],
        ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
        ...(selection.temperature === undefined ? {} : { temperature: selection.temperature })
      });
      const context = this.options.context;
      if (!context) throw new Error('Model changes require the session context service.');
      if (options.continuation === 'fresh') {
        const entry = await this.selectFreshContinuation(selection, input.profile);
        await this.emit({
          type: 'context.transitioned',
          window: entry.window,
          transition: entry.transition
        });
      } else {
        await assertHistoryModelCompatibility({
          history: context.history,
          artifacts: input.artifacts,
          profile: input.profile
        });
        await this.options.repository.appendModelSettings(this.options.descriptor, selection);
      }
      // Fresh targets are committed with their source selection in one record. An interrupted
      // observer/default write cannot leave a reset governed by the old target model.
      this.configuration = ownConfiguration({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
        ...(selection.temperature === undefined ? {} : { temperature: selection.temperature }),
        ...(this.configuration.responseFormat === undefined
          ? {}
          : { responseFormat: this.configuration.responseFormat })
      });
      await this.emit({ type: 'configuration.changed', configuration: this.configuration });
      return this.state();
    });
  }

  /** Explicitly restart model reasoning in this session without resetting effects or budgets. */
  freshContinuation(input: {
    readonly profile: ModelProfile;
    readonly retained?: readonly import('../history/contracts.js').HistorySourceRef[];
  }): Promise<AgentSessionState> {
    return this.serial(async () => {
      this.assertOpen();
      await this.restorePending();
      if (this.active || this.suspended || this.queued.length > 0)
        throw new Error('Settle or reconcile pending work before a fresh continuation.');
      const entry = await this.selectFreshContinuation(
        this.configuration,
        input.profile,
        input.retained
      );
      await this.emit({
        type: 'context.transitioned',
        window: entry.window,
        transition: entry.transition
      });
      return this.state();
    });
  }

  private async selectFreshContinuation(
    model: ModelSelection,
    profile: ModelProfile,
    retained?: readonly import('../history/contracts.js').HistorySourceRef[]
  ) {
    const context = this.options.context;
    if (!context) throw new Error('Fresh continuation requires a session context service.');
    if (model.provider !== profile.provider || model.model !== profile.id)
      throw new Error('Fresh continuation model does not match its profile.');
    const cut = await context.history.capture();
    const window = await context.history.selectedContext(cut);
    const selection = await context.freshSelection({
      selection: await context.selectSources(cut, { retain: retained }),
      model,
      profile,
      cut,
      resetId: randomUUID()
    });
    return context.transition({
      expectedWindowId: window?.windowId ?? null,
      expectedSourceRevision: cut.sourceRevision,
      idempotencyKey: randomUUID(),
      reason: 'Explicit fresh inference continuation.',
      selection
    });
  }

  async transitionContext(
    request: Omit<ContextTransitionRequest, 'toolInvocation' | 'expectedCut'>,
    options: { readonly signal?: AbortSignal } = {}
  ) {
    if ('toolInvocation' in request || 'expectedCut' in request)
      throw new Error('Session context transitions cannot supply internal tool provenance.');
    if (request.expectedSourceRevision === undefined)
      throw new Error('Session context transitions require the inspected source revision.');
    if (!this.options.context) throw new Error('This session has no context transition service.');
    await this.restore();
    const result = await this.options.context.dispatch(request, options);
    if (result.kind === 'selected')
      await this.emit({
        type: 'context.transitioned',
        window: result.entry.window,
        transition: result.entry.transition
      });
    return result;
  }

  updateQueuedSubmission(
    submissionId: string,
    change: Parameters<SessionRepository['updateQueuedSubmission']>[2]
  ): Promise<void> {
    return this.serial(async () => {
      await this.restorePending();
      const index = this.queued.findIndex(
        (pending) => pending.id === submissionId && !pending.resumeExisting
      );
      const pending = this.queued[index];
      if (pending === undefined) throw new Error(`Submission is no longer queued: ${submissionId}`);
      const owned =
        change.kind === 'replace'
          ? { ...change, input: ownSessionSubmissionInput(change.input) }
          : change;
      await this.options.repository.updateQueuedSubmission(
        this.options.descriptor,
        submissionId,
        owned
      );
      if (owned.kind === 'replace') this.queued[index] = { ...pending, input: owned.input };
      else {
        this.queued.splice(index, 1);
        pending.reject(new AgentSubmissionCancelledError(submissionId, pending.runId));
      }
      await this.emit({
        type: owned.kind === 'replace' ? 'input.revised' : 'input.cancelled',
        submissionId,
        runId: pending.runId
      });
    });
  }

  branchFrom(entryId: string, label?: string): Promise<SessionBranchMarkerEntry> {
    return this.serial(async () => {
      await this.restorePending();
      if (this.active || this.suspended || this.queued.length > 0)
        throw new Error('Session branching requires an idle session with no queued work.');
      const branch = await this.options.repository.branchFrom(
        this.options.descriptor,
        entryId,
        label
      );
      return branch;
    });
  }

  inspectSuspension(): AgentSessionSuspensionDescriptor | undefined {
    return this.suspended?.descriptor;
  }

  async reconcileExternal(expectedRunId: string): Promise<AgentRunResult> {
    return this.continueSuspension('external_recovery', expectedRunId);
  }

  async resumeContextAdmission(expectedRunId: string): Promise<AgentRunResult> {
    return this.continueSuspension('context_admission', expectedRunId);
  }

  async resumeRuntime(expectedRunId: string): Promise<AgentRunResult> {
    return this.continueSuspension('runtime', expectedRunId);
  }

  async resolveApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly fingerprint: string;
    readonly decision: 'allow' | 'deny';
    readonly signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    const started = await this.serial(async () => {
      await this.restorePending();
      if (this.active)
        throw new Error(`Session ${this.options.descriptor.id} already has an active run.`);
      if (this.suspended?.descriptor.reason !== 'approval_required')
        throw new Error(`Session ${this.options.descriptor.id} is not waiting for approval.`);
      if (this.suspended.runId !== input.runId)
        throw new Error(`Session is suspended on run ${this.suspended.runId}, not ${input.runId}.`);
      return this.startSuspendedSubmission(this.suspended, (runtime) => runtime.resolveApproval(input));
    });
    return started.completion;
  }

  async abort(reason = 'Agent run aborted.', expectedRunId?: string): Promise<boolean> {
    return this.serial(async () => {
      await this.restorePending();
      if (this.active) {
        if (expectedRunId !== undefined && this.active.control.runId !== expectedRunId)
          return false;
        await this.active.control.abort(reason);
        return true;
      }
      const suspended = this.suspended;
      if (!suspended || (expectedRunId !== undefined && suspended.runId !== expectedRunId))
        return false;
      await this.startSuspendedSubmission(suspended, async (runtime) => {
        await this.options.runs.requestAbort(suspended.runId, reason);
        return runtime.resume(suspended.runId);
      });
      return true;
    });
  }

  async waitForIdle(): Promise<void> {
    if (!this.closed && this.options.scheduling !== 'manual') await this.startReadyWork();
    while (
      this.active ||
      (!this.closed &&
        this.options.scheduling !== 'manual' &&
        !this.suspended &&
        this.queued.length > 0)
    ) {
      if (this.active) await this.active.pending.completion.catch(() => undefined);
      await this.serialQueue;
    }
  }

  /** Stops this instance without dispatching or discarding durable queued input. */
  close(): Promise<void> {
    if (this.closeCompletion) return this.closeCompletion;
    this.closed = true;
    this.closeCompletion = this.serial(async () => {
      for (const pending of this.queued.splice(0))
        pending.reject(new Error('Session instance closed; queued input remains recorded.'));
      const completion = this.active?.pending.completion;
      await this.active?.control.abort('Session instance closed.');
      return { completion };
    })
      .then(async ({ completion }) => {
        // Settlement runs on the serial queue; await it outside the close transaction.
        await completion?.catch(() => undefined);
      })
      .finally(() => {
        this.listeners.clear();
      });
    return this.closeCompletion;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Session instance is closed.');
  }

  private async continueSuspension(
    category: 'external_recovery' | 'runtime' | 'context_admission',
    expectedRunId: string
  ): Promise<AgentRunResult> {
    const started = await this.serial(async () => {
      await this.restorePending();
      if (this.active)
        throw new Error(`Session ${this.options.descriptor.id} already has an active run.`);
      return this.startSuspendedSubmission(this.requireSuspension(category, expectedRunId));
    });
    return started.completion;
  }

  private requireSuspension(
    category: AgentSessionSuspensionCategory,
    expectedRunId: string
  ): SuspendedSubmission {
    const suspended = this.suspended;
    if (!suspended) throw new Error(`Session ${this.options.descriptor.id} is not suspended.`);
    if (suspended.runId !== expectedRunId)
      throw new Error(`Session is suspended on run ${suspended.runId}, not ${expectedRunId}.`);
    if (suspended.descriptor.category !== category)
      throw new Error(
        `Session suspension ${suspended.descriptor.reason} does not permit this action.`
      );
    return suspended;
  }

  private async startSuspendedSubmission(
    suspended: SuspendedSubmission,
    start: (runtime: AgentRuntime) => AgentRunHandle | Promise<AgentRunHandle> =
      (runtime) => runtime.resume(suspended.runId)
  ): Promise<{ readonly completion: Promise<AgentRunResult> }> {
    const pending = pendingSubmission(
      suspended.submissionId, suspended.runId, suspended.input, suspended.configuration,
      true, suspended.claimId
    );
    try {
      await this.claim(pending);
    } catch (error) {
      this.rejectDispatch(pending, error);
      throw error;
    }
    try {
      const runtime = await this.createRuntime(
        suspended.submissionId,
        suspended.runId,
        suspended.input,
        suspended.configuration,
        true
      );
      await this.assertRuntimeClaim(pending, runtime);
      const control = await start(runtime);
      this.suspended = undefined;
      this.observe({ control, pending, configuration: suspended.configuration });
      return { completion: pending.completion };
    } catch (error) {
      pending.reject(error);
      try {
        await this.restoreContinuation(suspended, pending);
      } catch (restoreError) {
        this.rejectDispatch(pending, restoreError);
      }
      throw error;
    }
  }

  /** A rejected continuation is not a failed submission; the run still owns its durable outcome. */
  private async restoreContinuation(previous: SuspendedSubmission, pending: PendingSubmission): Promise<void> {
    await this.assertClaim(pending);
    const run = await this.options.runs.inspect(previous.runId);
    const descriptor = runSuspensionDescriptor(previous.submissionId, run.state) ??
      (run.state.phase.kind !== 'terminal' &&
        (previous.descriptor.reason === 'missing_implementation' || previous.descriptor.reason === 'runtime_failed')
        ? previous.descriptor : undefined);
    if (descriptor !== undefined) {
      await this.options.repository.transitionSubmission(
        this.options.descriptor,
        previous.submissionId,
        {
          state: 'suspended',
          claimId: pending.claimId,
          suspension: descriptor
        }
      );
      this.suspended = { ...previous, claimId: pending.claimId, descriptor };
    } else {
      this.suspended = undefined;
      this.queued.unshift(
        pendingSubmission(
          previous.submissionId,
          previous.runId,
          previous.input,
          previous.configuration,
          true,
          pending.claimId
        )
      );
    }
  }

  private async restorePending(): Promise<void> {
    this.assertOpen();
    if (this.restored) return;
    const pending = await this.options.repository.loadPendingSubmissions(this.options.descriptor);
    for (const submission of pending) {
      if (submission.state === 'claimed') {
        const run = await this.options.runs.find(submission.runId);
        const descriptor = run && runSuspensionDescriptor(submission.submissionId, run.state);
        if (descriptor) this.suspended = suspendedSubmission(submission, descriptor);
        else this.queued.push(pendingFromRecord(submission, run !== undefined));
      } else if (submission.state === 'suspended') {
        if (this.suspended)
          throw new Error(
            `Session has multiple suspended submissions: ${this.suspended.submissionId} and ${submission.submissionId}.`
          );
        if (!submission.suspension)
          throw new Error(
            `Suspended submission ${submission.submissionId} has no durable suspension descriptor.`
          );
        const run = await this.options.runs.inspect(submission.runId);
        const current = runSuspensionDescriptor(submission.submissionId, run.state);
        if (
          submission.suspension.reason !== 'missing_implementation' &&
          submission.suspension.reason !== 'runtime_failed' &&
          (!current || !sameSuspension(submission.suspension, current))
        ) {
          throw new Error(
            `Suspended submission ${submission.submissionId} contradicts its run suspension.`
          );
        }
        if (
          submission.suspension.reason === 'runtime_failed' &&
          run.state.phase.kind === 'terminal'
        ) {
          this.queued.push(pendingFromRecord(submission, true));
          continue;
        }
        const descriptor = current ?? submission.suspension;
        this.suspended = suspendedSubmission(submission, descriptor);
      } else {
        this.queued.push(pendingFromRecord(submission, false));
      }
    }
    this.restored = true;
  }

  private claim(pending: PendingSubmission): Promise<void> {
    return this.options.repository.transitionSubmission(this.options.descriptor, pending.id, {
      state: 'claimed',
      claimId: pending.claimId,
      ...(pending.expectedClaimId === undefined ? {} : { expectedClaimId: pending.expectedClaimId })
    });
  }

  private async assertClaim(pending: PendingSubmission): Promise<void> {
    const current = (await this.options.repository.loadPendingSubmissions(this.options.descriptor))
      .find((submission) => submission.submissionId === pending.id);
    if (current?.state !== 'claimed' || current.claimId !== pending.claimId)
      throw new SessionSubmissionOwnershipError(pending.id);
  }

  private async assertRuntimeClaim(pending: PendingSubmission, runtime: AgentRuntime): Promise<void> {
    try {
      await this.assertClaim(pending);
    } catch (error) {
      try {
        await runtime.close();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'Dispatch lost ownership and its runtime could not be released.', { cause: releaseError });
      }
      throw error;
    }
  }

  /** A dispatcher that never acquired, or lost, ownership cannot settle another dispatcher. */
  private rejectDispatch(pending: PendingSubmission, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    pending.reject(failure);
    for (const queued of this.queued.splice(0)) queued.reject(failure);
  }

  private async launch(
    pending: PendingSubmission
  ): Promise<Extract<AgentSessionSubmissionResult, { kind: 'started' }>> {
    try {
      await this.claim(pending);
      const configuration = pending.configuration;
      const runtime = await this.createRuntime(
        pending.id,
        pending.runId,
        pending.input,
        configuration,
        pending.resumeExisting
      );
      await this.assertRuntimeClaim(pending, runtime);
      const control = pending.resumeExisting
        ? runtime.resume(pending.runId)
        : runtime.run({ ...pending.input, runId: pending.runId });
      this.observe({ control, pending, configuration });
      return {
        kind: 'started',
        submissionId: pending.id,
        runId: control.runId,
        completion: pending.completion
      };
    } catch (error) {
      // No run control was obtained. A prior admission can still be in flight in
      // another dispatcher, so keep the durable claim recoverable.
      this.rejectDispatch(pending, error);
      throw error;
    }
  }

  private observe(active: ActiveSubmission): void {
    this.active = active;
    void active.control.result
      .then(
        (result) =>
          this.serial(() => this.settle(active, result)).catch((error: unknown) =>
            this.serial(() => this.fail(active, error))
          ),
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
    return Promise.resolve(
      this.options.createRuntime(
        configuration,
        async (event) => {
          await this.emit({ type: 'run.progress', runId, event });
          if (event.type === 'context.transition.rejected') await this.emit(event);
          if (event.type === 'context.transitioned')
            await this.emit({
              type: 'context.transitioned',
              window: event.window,
              transition: event.transition
            });
        },
        Object.freeze({ submissionId, runId, input, resuming })
      )
    );
  }

  private async settle(active: ActiveSubmission, result: AgentRunResult): Promise<void> {
    if (this.active !== active) return;
    let suspension: AgentSessionSuspensionDescriptor | undefined;
    if (result.state === 'suspended') {
      const run = await this.options.runs.inspect(result.runId);
      suspension =
        result.reason === 'missing_implementation'
          ? suspensionFromResult(active.pending.id, result)
          : requireRunSuspensionDescriptor(active.pending.id, run.state);
      await this.options.repository.transitionSubmission(
        this.options.descriptor,
        active.pending.id,
        {
          state: 'suspended',
          claimId: active.pending.claimId,
          suspension
        }
      );
    } else
      await this.options.repository.transitionSubmission(
        this.options.descriptor,
        active.pending.id,
        {
          state: 'completed',
          claimId: active.pending.claimId
        }
      );
    this.active = undefined;
    this.suspended = suspension
      ? {
          claimId: active.pending.claimId,
          runId: suspension.runId,
          submissionId: active.pending.id,
          input: active.pending.input,
          configuration: active.configuration,
          descriptor: suspension
        }
      : undefined;
    await this.emit({ type: 'run.completed', runId: active.control.runId, result });
    active.pending.resolve(result);
    if (!this.suspended) await this.launchNext();
  }

  private async fail(active: ActiveSubmission, error: unknown): Promise<void> {
    if (this.active !== active) return;
    this.active = undefined;
    await this.failSubmission(active.pending, active.configuration, error);
    if (!this.suspended) await this.launchNext();
  }

  private async failSubmission(
    pending: PendingSubmission,
    configuration: AgentSessionConfiguration,
    error: unknown
  ): Promise<void> {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (cause instanceof AgentRunConflictError || cause instanceof SessionSubmissionOwnershipError) {
      this.rejectDispatch(pending, cause);
      return;
    }
    let failure = cause;
    try {
      await this.assertClaim(pending);
      const run = await this.options.runs.find(pending.runId);
      if (run?.state.phase.kind === 'terminal') {
        const result: AgentRunResult = Object.freeze({
          state: 'ended',
          terminal: await this.options.runs.readTerminal(run),
          deliveryDiagnostics: Object.freeze([
            Object.freeze({
              eventType: 'run.result',
              message: cause.message,
              persisted: false
            })
          ])
        });
        await this.options.repository.transitionSubmission(this.options.descriptor, pending.id, {
          state: 'completed',
          claimId: pending.claimId
        });
        pending.resolve(result);
        await this.emit({ type: 'run.completed', runId: pending.runId, result });
        return;
      }
      if (run) {
        const descriptor: AgentSessionSuspensionDescriptor =
          runSuspensionDescriptor(pending.id, run.state) ??
          Object.freeze({
            runId: pending.runId,
            submissionId: pending.id,
            category: 'runtime',
            reason: 'runtime_failed',
            diagnostic: cause.message || cause.name,
            actions: suspensionActions('resume', 'abort')
          });
        this.suspended = {
          claimId: pending.claimId,
          runId: pending.runId,
          submissionId: pending.id,
          input: pending.input,
          configuration,
          descriptor
        };
      }
      await this.options.repository.transitionSubmission(
        this.options.descriptor,
        pending.id,
        this.suspended
          ? { state: 'suspended', claimId: pending.claimId, suspension: this.suspended.descriptor }
          : { state: 'failed', claimId: pending.claimId, errorMessage: cause.message || cause.name }
      );
    } catch (persistenceError) {
      this.suspended = undefined;
      if (persistenceError instanceof SessionSubmissionOwnershipError) {
        this.rejectDispatch(pending, persistenceError);
        return;
      }
      failure = new AggregateError(
        [cause, persistenceError],
        'Run dispatch failed and its session state could not be recorded.',
        { cause }
      );
      // A failed persistence boundary cannot authorize dispatch of another submission.
      this.closed = true;
      for (const queued of this.queued.splice(0)) queued.reject(failure);
    }
    pending.reject(failure);
    await this.emit({ type: 'run.failed', runId: pending.runId, error: failure });
  }

  private async launchNext(): Promise<void> {
    if (this.options.scheduling === 'manual') return;
    while (!this.closed && !this.active && !this.suspended) {
      const next = this.queued.shift();
      if (!next) return;
      try {
        await this.launch(next);
      } catch {
        // launch records the admission or recovery obligation and delivers the failure once.
      }
    }
  }

  private enqueue(pending: PendingSubmission): void {
    this.queued.push(pending);
    void this.emit({
      type: 'input.queued',
      submissionId: pending.id,
      queuedInputs: this.queued.length
    });
  }

  private async emit(event: AgentSessionEvent): Promise<void> {
    for (const subscription of this.listeners) {
      try {
        await subscription.listener(event);
      } catch (cause) {
        this.listeners.delete(subscription);
        try {
          await subscription.onFailure(cause instanceof Error ? cause : new Error(String(cause)));
        } catch {
          /* The detached owner has no remaining delivery authority. */
        }
      }
    }
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.serialQueue.then(operation);
    this.serialQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

interface PendingSubmission {
  readonly claimId: string;
  readonly expectedClaimId?: string;
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
  readonly control: AgentRunHandle;
  readonly pending: PendingSubmission;
  readonly configuration: AgentSessionConfiguration;
}

interface SuspendedSubmission {
  readonly claimId: string;
  readonly runId: string;
  readonly submissionId: string;
  readonly input: AgentRunInput;
  readonly configuration: AgentSessionConfiguration;
  readonly descriptor: AgentSessionSuspensionDescriptor;
}

function suspendedSubmission(
  record: SessionPendingSubmission,
  descriptor: AgentSessionSuspensionDescriptor
): SuspendedSubmission {
  return Object.freeze({
    claimId: requireSubmissionClaim(record),
    runId: record.runId,
    submissionId: record.submissionId,
    input: record.input,
    configuration: record.configuration,
    descriptor
  });
}

function pendingFromRecord(
  record: SessionPendingSubmission,
  resumeExisting: boolean
): PendingSubmission {
  return pendingSubmission(
    record.submissionId,
    record.runId,
    record.input,
    record.configuration,
    resumeExisting,
    record.claimId
  );
}

function pendingSubmission(
  id: string,
  runId: string,
  input: SessionSubmissionInput | AgentRunInput,
  configuration: AgentSessionConfiguration,
  resumeExisting = false,
  expectedClaimId?: string
): PendingSubmission {
  let resolve!: (result: AgentRunResult) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<AgentRunResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  void completion.catch(() => undefined);
  const ownedInput: AgentRunInput = Object.freeze({
    task: input.task,
    ...(input.images === undefined ? {} : { images: parseSessionImages(input.images) }),
    runId,
    ...(input.instructions === undefined
      ? {}
      : { instructions: Object.freeze([...input.instructions]) }),
    ...(input.contextItems === undefined
      ? {}
      : {
          contextItems: Object.freeze(
            input.contextItems.map((item) =>
              Object.freeze({
                ...item,
                ...(item.range === undefined ? {} : { range: Object.freeze({ ...item.range }) })
              })
            )
          )
        })
  });
  return {
    claimId: randomUUID(),
    ...(expectedClaimId === undefined ? {} : { expectedClaimId }),
    id,
    runId,
    input: ownedInput,
    configuration: ownSessionSubmissionConfiguration(configuration),
    resumeExisting,
    completion,
    resolve,
    reject
  };
}

function submissionInput(input: AgentRunInput): SessionSubmissionInput {
  return Object.freeze({
    task: input.task,
    ...(input.images === undefined ? {} : { images: parseSessionImages(input.images) }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.contextItems === undefined ? {} : { contextItems: input.contextItems })
  });
}

function ownConfiguration(configuration: AgentSessionConfiguration): AgentSessionConfiguration {
  return ownSessionSubmissionConfiguration(configuration);
}

function requireRunSuspensionDescriptor(
  submissionId: string,
  state: import('../run/control/contracts.js').AgentRunState
): AgentSessionSuspensionDescriptor {
  const descriptor = runSuspensionDescriptor(submissionId, state);
  if (!descriptor) throw new Error(`Run ${state.runId} has no durable suspension state.`);
  return descriptor;
}

function runSuspensionDescriptor(
  submissionId: string,
  state: import('../run/control/contracts.js').AgentRunState
): AgentSessionSuspensionDescriptor | undefined {
  const phase = state.phase;
  if (phase.kind === 'suspended' && phase.reason === 'approval')
    return Object.freeze({
      runId: state.runId,
      submissionId,
      category: 'approval',
      reason: 'approval_required',
      actions: suspensionActions('approval', 'abort')
    });
  if (phase.kind === 'active') {
    for (const request of state.providerRequests) {
      if (request.stage === 'outcome_unknown')
        return externalSuspension(
          submissionId,
          state.runId,
          'provider_outcome_unknown',
          request.effect.intent.effectId
        );
    }
    for (const batch of state.toolBatches) {
      const unknown = batch.callStates.find((call) => call.stage === 'outcome_unknown');
      if (unknown?.stage === 'outcome_unknown')
        return externalSuspension(
          submissionId,
          state.runId,
          'tool_outcome_unknown',
          unknown.effect.intent.effectId
        );
    }
    if (
      state.toolBatches.some((batch) => batch.callStates.some((call) => call.stage === 'approval'))
    )
      return Object.freeze({
        runId: state.runId,
        submissionId,
        category: 'approval',
        reason: 'approval_required',
        actions: suspensionActions('approval', 'abort')
      });
  }
  if (phase.kind !== 'suspended') return undefined;
  if (phase.reason === 'context_admission')
    return Object.freeze({
      runId: state.runId,
      submissionId,
      category: 'context_admission',
      reason: phase.reason,
      contextAdmission: phase.conflict,
      actions: suspensionActions('context', 'abort')
    });
  if (phase.reason === 'missing_implementation')
    return Object.freeze({
      runId: state.runId,
      submissionId,
      category: 'runtime',
      reason: phase.reason,
      ...(phase.effectId ? { effectId: phase.effectId } : {}),
      actions: suspensionActions('resume', 'abort')
    });
  return externalSuspension(submissionId, state.runId, phase.reason, phase.effectId);
}

function suspensionFromResult(
  submissionId: string,
  result: Extract<AgentRunResult, { readonly state: 'suspended' }>
): AgentSessionSuspensionDescriptor {
  if (result.reason !== 'missing_implementation')
    throw new Error(`Suspension ${result.reason} must be derived from durable run state.`);
  return Object.freeze({
    runId: result.runId,
    submissionId,
    category: 'runtime',
    reason: result.reason,
    ...(result.effectId ? { effectId: result.effectId } : {}),
    actions: suspensionActions('resume', 'abort')
  });
}

function externalSuspension(
  submissionId: string,
  runId: string,
  reason: 'provider_outcome_unknown' | 'tool_outcome_unknown',
  effectId?: string
): AgentSessionSuspensionDescriptor {
  return Object.freeze({
    runId,
    submissionId,
    category: 'external_recovery',
    reason,
    ...(effectId ? { effectId } : {}),
    actions: suspensionActions('reconcile', 'abort')
  });
}

function suspensionActions(
  ...actions: AgentSessionSuspensionAction[]
): readonly AgentSessionSuspensionAction[] {
  return Object.freeze(actions);
}

function sameSuspension(
  left: AgentSessionSuspensionDescriptor,
  right: AgentSessionSuspensionDescriptor
): boolean {
  return hashJson(left) === hashJson(right);
}

export class AgentSubmissionCancelledError extends Error {
  constructor(
    readonly submissionId: string,
    readonly runId: string
  ) {
    super(`Queued submission cancelled: ${submissionId}`);
    this.name = 'AgentSubmissionCancelledError';
  }
}

function requireSubmissionClaim(record: SessionPendingSubmission): string {
  if (!record.claimId) throw new Error(`Session submission has no durable claim: ${record.submissionId}`);
  return record.claimId;
}
