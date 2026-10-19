import { parseSessionSubmissionOrigin } from './submission-origin.js';
import { hashJson, type ArtifactRepository } from '@agent-core/persistence';
import {
  assertModelRequestSupported,
  parseModelSelection,
  type ModelProfile,
  type ModelProvider,
  type ModelSelection
} from '@agent-core/model';
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
  SessionExecutionOwnership,
  SessionInputRelationship,
  SessionPendingSubmission,
  SessionRepository,
  SessionSubmissionConfiguration,
  SessionSubmissionInput,
  SessionSuspensionAction,
  SessionSuspensionCategory,
  SessionSuspensionDescriptor
} from './contracts.js';
import type { SessionProviderBinding } from './provider-binding.js';
import { parseSessionImages } from './images.js';
import { ApplicationEvents, type ApplicationDeliveryEvent } from './event-delivery.js';
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
  | ApplicationDeliveryEvent
  | Extract<AgentProgressEvent, { readonly type: 'context.transition.rejected' | 'context.transition.unchanged' }>
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
  readonly providerBinding?: SessionProviderBinding;
  readonly createRuntime: (
    configuration: AgentSessionConfiguration,
    onProgress: (event: AgentProgressEvent) => void | Promise<void>,
    context: AgentSessionRuntimeContext
  ) => AgentRuntime | Promise<AgentRuntime>;
  readonly context?: ContextService;
  readonly maximumQueuedInputs?: number;
  /** Manual scheduling leaves admitted input durable until its application starts it. */
  readonly scheduling?: 'automatic' | 'manual';
  /** Serialize durable user-input admission with the host's participant effect-start authority.
   * The guard surrounds only the repository write, never runtime dispatch or completion.
   * Accepted input remains authoritative even if the guard loses its return acknowledgement.
   */
  readonly withSubmissionAdmission?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export class AgentSession {
  private configuration: AgentSessionConfiguration;
  private readonly maximumQueuedInputs: number;
  private readonly handles = new Map<string, PendingSubmission>();
  private pendingSnapshot: readonly SessionPendingSubmission[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly events = new ApplicationEvents<AgentSessionEvent>();
  private active: ActiveSubmission | undefined;
  private suspended: SuspendedSubmission | undefined;
  private serialQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private execution: SessionExecutionOwnership | undefined;
  private observedRevision: number | undefined;
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

  /** Last observed durable scheduling state; inspect() refreshes it. */
  state(): AgentSessionState {
    const occupying = this.pendingSnapshot.find((submission) => submission.state !== 'queued');
    const suspension = occupying?.state === 'suspended' ? occupying.suspension
      : this.suspended?.submissionId === occupying?.submissionId ? this.suspended?.descriptor : undefined;
    return Object.freeze({
      sessionId: this.options.descriptor.id,
      phase: occupying ? suspension ? 'suspended' : 'running' : 'idle',
      configuration: this.configuration,
      ...(occupying ? { activeRunId: occupying.runId } : {}),
      queuedInputs: this.pendingSnapshot.filter((submission) => submission.state === 'queued').length,
      ...(suspension ? { suspension } : {})
    });
  }

  subscribe(
    listener: (event: AgentSessionEvent) => void | Promise<void>,
    onFailure: (error: Error) => void | Promise<void>
  ): () => void {
    return this.events.subscribe(listener, onFailure);
  }

  restore(): Promise<void> {
    return this.serial(() => this.restorePending());
  }

  /** Observe submission admission and run controls at one session scheduling boundary. */
  inspect() {
    return this.serial(async () => {
      await this.restorePending();
      const pendingSubmissions = this.pendingSnapshot;
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

  /** Inspect the current durable selection without replacing an executing binding. */
  inspectProviderBinding() {
    return this.serial(async () => {
      await this.restorePending();
      if (!this.options.providerBinding) throw new Error('Session provider binding is not configured.');
      return this.options.providerBinding.resolve(this.configuration);
    });
  }

  startNextSubmission(): Promise<AgentSessionSubmissionResult | undefined> {
    return this.serial(async () => {
      await this.restorePending();
      if (this.active || this.suspended) return undefined;
      return this.claimAndLaunchNext();
    });
  }

  private startReadyWork(): Promise<void> {
    return this.serial(async () => {
      await this.restorePending();
      if (!this.active && !this.suspended) await this.launchNext();
    });
  }

  /** Per-client defaults for future response formatting; model changes use changeModel(). */
  configure(settings: Partial<Pick<AgentSessionConfiguration, 'responseFormat'>>): Promise<AgentSessionState> {
    return this.serial(async () => {
      this.assertOpen();
      if (Object.keys(settings).some((key) => key !== 'responseFormat'))
        throw new Error('Model settings must be changed through changeModel().');
      await this.restorePending();
      const configuration = ownConfiguration({ ...this.configuration, ...settings });
      await this.options.providerBinding?.resolve(configuration);
      this.configuration = configuration;
      this.emit({ type: 'configuration.changed', configuration: this.configuration });
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
        const active = this.active;
        if (!active) return { kind: 'rejected', reason: 'no_active_run' };
        if (
          options.expectedRunId !== undefined &&
          options.expectedRunId !== active.control.runId
        )
          return { kind: 'rejected', reason: 'run_mismatch' };
        await this.withSubmissionAdmission(() => this.options.repository.appendSteering(this.options.descriptor, {
          runId: active.control.runId,
          content: task,
          deliveryId: submissionId,
          originalInput: submissionInput(input),
          ...(options.relationship ? { relationship: options.relationship } : {})
        }));
        active.control.injectSteering({ instruction: task, deliveryId: submissionId });
        return {
          kind: 'steered',
          submissionId,
          runId: active.control.runId,
          completion: active.pending.completion
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
      const binding = await this.options.providerBinding?.resolve(this.configuration, submissionInput(input));
      const immediate = this.options.scheduling !== 'manual' && !this.active
        ? await this.acquireExecution() : false;
      const claimId = randomUUID();
      let admitted: SessionPendingSubmission;
      try {
        admitted = await this.withSubmissionAdmission(() => this.options.repository.admitSubmission(this.options.descriptor, {
          submissionId,
          runId: input.runId ?? randomUUID(),
          input: { ...submissionInput(input), ...(options.relationship ? { relationship: options.relationship } : {}) },
          configuration: this.configuration,
          maximumQueuedInputs: this.maximumQueuedInputs,
          ...(immediate ? { claimId } : {})
        }));
      } catch (error) {
        if (immediate) await this.releaseExecution();
        throw error;
      }
      if (immediate && admitted.state !== 'claimed') await this.releaseExecution();
      if (binding && this.options.providerBinding) this.options.providerBinding.commit(binding);
      this.configuration = ownConfiguration(admitted.configuration);
      const pending = pendingFromRecord(admitted, false, admitted.claimId);
      this.handles.set(submissionId, pending);
      this.pendingSnapshot = [...this.pendingSnapshot, admitted];
      this.scheduleRefresh();
      if (admitted.state === 'claimed') return this.launch(pending, true);
      this.emit({ type: 'input.queued', submissionId, queuedInputs: this.state().queuedInputs });
      if (this.options.scheduling !== 'manual') await this.launchNext();
      return { kind: 'queued', submissionId, runId: pending.runId, completion: pending.completion };
    });
  }

  /** Changes future inference only after durable pending work has reached a lawful boundary. */
  changeModel(
    input: {
      readonly selection: ModelSelection;
      readonly profile: ModelProfile;
      readonly provider?: ModelProvider;
      readonly artifacts: ArtifactRepository;
    }
  ): Promise<AgentSessionState> {
    if (Object.keys(input).some(key => !['selection', 'profile', 'provider', 'artifacts'].includes(key)))
      throw new TypeError('Unknown model change option.');
    const selection = parseModelSelection(input.selection);
    return this.serial(async () => {
      this.assertOpen();
      await this.restorePending();
      if (this.active || this.suspended || this.pendingSnapshot.length > 0)
        throw new Error(
          'Settle or reconcile pending work and native result deliveries before changing models. Unknown effects remain unresolved.'
        );
      if (input.provider && !this.options.providerBinding)
        throw new Error('Explicit provider replacement requires a session provider binding.');
      const binding = await this.options.providerBinding?.resolve({
        ...selection,
        ...(this.configuration.responseFormat === undefined ? {} : { responseFormat: this.configuration.responseFormat })
      }, undefined, input.provider);
      const profile = binding?.profile ?? input.profile;
      if (profile.provider !== selection.provider || profile.id !== selection.model)
        throw new Error('The target model profile does not match the selected configuration.');
      assertModelRequestSupported(profile, {
        model: selection.model,
        messages: [],
        ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
        ...(selection.temperature === undefined ? {} : { temperature: selection.temperature })
      });
      const context = this.options.context;
      if (!context) throw new Error('Model changes require the session context service.');
      // A model choice is not an admitted inference. Validate portable evidence now;
      // only the actual successor request can commit its fresh source transition.
      await assertHistoryModelCompatibility({
        history: context.history,
        artifacts: input.artifacts,
        profile,
        representation: 'portable'
      });
      await this.options.repository.appendModelSettings(this.options.descriptor, selection);
      if (binding && this.options.providerBinding) this.options.providerBinding.commit(binding);
      this.configuration = ownConfiguration({
        provider: selection.provider,
        model: selection.model,
        ...(selection.endpoint === undefined ? {} : { endpoint: selection.endpoint }),
        ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
        ...(selection.temperature === undefined ? {} : { temperature: selection.temperature }),
        ...(this.configuration.responseFormat === undefined
          ? {}
          : { responseFormat: this.configuration.responseFormat })
      });
      this.emit({ type: 'configuration.changed', configuration: this.configuration });
      return this.state();
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
      this.emit({
        type: 'context.transitioned',
        window: result.entry.window,
        transition: result.entry.transition
      });
    if (result.kind === 'unchanged') this.emit({ type: 'context.transition.unchanged', idempotencyKey: request.idempotencyKey, windowId: result.windowId });
    return result;
  }

  updateQueuedSubmission(
    submissionId: string,
    change: Parameters<SessionRepository['updateQueuedSubmission']>[2]
  ): Promise<void> {
    return this.serial(async () => {
      await this.restorePending();
      const record = this.pendingSnapshot.find((submission) => submission.submissionId === submissionId && submission.state === 'queued');
      if (!record) throw new Error(`Submission is no longer queued: ${submissionId}`);
      const pending = this.handles.get(submissionId);
      const owned =
        change.kind === 'replace'
          ? { ...change, input: ownSessionSubmissionInput(change.input) }
          : change;
      await this.withSubmissionAdmission(() => this.options.repository.updateQueuedSubmission(
        this.options.descriptor,
        submissionId,
        owned
      ));
      if (owned.kind === 'replace' && pending) this.handles.set(submissionId, { ...pending, input: owned.input });
      else if (owned.kind === 'cancel') {
        this.handles.delete(submissionId);
        pending?.reject(new AgentSubmissionCancelledError(submissionId, record.runId));
      }
      await this.restorePending();
      this.emit({
        type: owned.kind === 'replace' ? 'input.revised' : 'input.cancelled',
        submissionId,
        runId: record.runId
      });
    });
  }

  branchFrom(entryId: string, label?: string): Promise<SessionBranchMarkerEntry> {
    return this.serial(async () => {
      await this.restorePending();
      if (this.active || this.suspended || this.pendingSnapshot.length > 0)
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
    return this.state().suspension;
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
    while (!this.closed) {
      await this.serial(() => this.restorePending());
      if (this.suspended || (this.options.scheduling === 'manual' && !this.active) || this.pendingSnapshot.length === 0) return;
      if (this.active) await this.active.pending.completion.catch(() => undefined);
      else await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (this.options.scheduling !== 'manual') await this.startReadyWork();
    }
  }

  /** Stops this instance without dispatching or discarding durable queued input. */
  close(): Promise<void> {
    if (this.closeCompletion) return this.closeCompletion;
    this.closed = true;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.closeCompletion = this.serial(async () => {
      for (const pending of this.handles.values())
        if (pending !== this.active?.pending) pending.reject(new Error('Session instance closed; input remains recorded.'));
      this.handles.clear();
      const completion = this.active?.pending.completion;
      await this.active?.control.abort('Session instance closed.');
      return { completion };
    })
      .then(async ({ completion }) => {
        // Settlement runs on the serial queue; await it outside the close transaction.
        await completion?.catch(() => undefined);
        await this.serial(() => this.releaseExecution());
      })
      .finally(() => {
        this.events.close();
      })
      .catch((error: unknown) => {
        // Retained execution ownership must remain releasable after a failed close.
        if (this.execution) this.closeCompletion = undefined;
        throw error;
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
    if (!await this.acquireExecution()) throw new Error('Session execution is owned by another client.');
    const pending = pendingSubmission(
      suspended.submissionId, suspended.runId, suspended.input, suspended.configuration,
      true, suspended.claimId
    );
    try {
      await this.claim(pending);
      this.pendingSnapshot = this.pendingSnapshot.map((entry) => entry.submissionId === pending.id
        ? { ...entry, state: 'claimed' as const, claimId: pending.claimId } : entry);
      this.suspended = undefined;
    } catch (error) {
      this.rejectDispatch(pending, error);
      await this.releaseExecution();
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
      this.observe({ control, pending, configuration: suspended.configuration });
      return { completion: pending.completion };
    } catch (error) {
      pending.reject(error);
      try {
        await this.restoreContinuation(suspended, pending);
      } catch (restoreError) {
        this.rejectDispatch(pending, restoreError);
      }
      await this.releaseExecution();
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
      this.pendingSnapshot = this.pendingSnapshot.map((entry) => entry.submissionId === pending.id
        ? { ...entry, state: 'suspended' as const, claimId: pending.claimId, suspension: descriptor } : entry);
    } else {
      this.suspended = undefined;
      this.handles.delete(previous.submissionId);
      await this.restorePending();

    }
  }

  private async restorePending(): Promise<void> {
    this.assertOpen();
    const revision = await this.options.repository.revision(this.options.descriptor);
    if (revision === this.observedRevision) {
      this.scheduleRefresh();
      return;
    }
    this.pendingSnapshot = await this.options.repository.loadPendingSubmissions(this.options.descriptor);
    const selection = await this.options.repository.currentModelSettings(this.options.descriptor);
    if (selection) this.configuration = ownConfiguration({
      provider: selection.provider, model: selection.model,
      ...(selection.endpoint === undefined ? {} : { endpoint: selection.endpoint }),
      ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
      ...(selection.temperature === undefined ? {} : { temperature: selection.temperature }),
      ...(this.configuration.responseFormat === undefined ? {} : { responseFormat: this.configuration.responseFormat })
    });
    const occupying = this.pendingSnapshot.find((submission) => submission.state !== 'queued');
    if (!this.active) {
      this.suspended = undefined;
      if (occupying) {
        const run = await this.options.runs.find(occupying.runId);
        const current = run && runSuspensionDescriptor(occupying.submissionId, run.state);
        if (occupying.state === 'suspended') {
          if (!occupying.suspension) throw new Error(`Suspended submission ${occupying.submissionId} has no durable suspension descriptor.`);
          if (occupying.suspension.reason !== 'missing_implementation' && occupying.suspension.reason !== 'runtime_failed' &&
              (!current || !sameSuspension(occupying.suspension, current)))
            throw new Error(`Suspended submission ${occupying.submissionId} contradicts its run suspension.`);
          if (run?.state.phase.kind !== 'terminal')
            this.suspended = suspendedSubmission(occupying, current ?? occupying.suspension);

        } else if (current) this.suspended = suspendedSubmission(occupying, current);
      }
    }
    for (const [id, pending] of this.handles) {
      if (this.active?.pending === pending) continue;
      const record = this.pendingSnapshot.find((submission) => submission.submissionId === id)
        ?? await this.options.repository.readSubmission(this.options.descriptor, id);
      if (!record) throw new Error(`Accepted submission disappeared: ${id}`);
      if (record.state === 'queued' || record.state === 'claimed') continue;
      if (record.state === 'cancelled') pending.reject(new AgentSubmissionCancelledError(id, pending.runId));
      else if (record.state === 'failed' || (record.state === 'suspended' && record.suspension?.reason === 'runtime_failed')) {
        const error = new Error(record.state === 'failed' ? record.errorMessage : record.suspension?.diagnostic);
        pending.reject(error);
        this.emit({ type: 'run.failed', runId: record.runId, error });
      }
      else {
        const run = await this.options.runs.inspect(record.runId);
        const result: AgentRunResult = record.state === 'completed'
          ? { state: 'ended', terminal: await this.options.runs.readTerminal(run), deliveryDiagnostics: [] }
          : suspendedRunResult(run.state, record.suspension);
        pending.resolve(result);
        this.emit({ type: 'run.completed', runId: record.runId, result });
      }
      this.handles.delete(id);
    }
    this.observedRevision = revision;
    this.scheduleRefresh();
  }

  /** One non-overlapping durable refresh per open client; no queued polling work. */
  private scheduleRefresh(): void {
    if (this.closed) return;
    const waitingOnOtherClient = this.handles.size > 0 && !this.active;
    if (this.refreshTimer) {
      if (waitingOnOtherClient) this.refreshTimer.ref();
      else this.refreshTimer.unref();
      return;
    }
    if (this.options.scheduling === 'manual' && this.handles.size === 0) return;
    this.refreshTimer = setTimeout(() => {
      void this.serial(async () => {
        if (this.closed) return;
        await this.restorePending();
        if (this.options.scheduling !== 'manual') await this.launchNext();
      }).catch((cause: unknown) => {
        this.closed = true;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        for (const pending of this.handles.values()) if (pending !== this.active?.pending) pending.reject(error);
        this.events.fail(error);
      }).finally(() => {
        this.refreshTimer = undefined;
        this.scheduleRefresh();
      });
    }, 100);
    if (!waitingOnOtherClient) this.refreshTimer.unref();
  }

  private async claim(pending: PendingSubmission): Promise<void> {
    if (!this.execution) throw new Error('Session execution ownership is required.');
    await this.execution.assertOwned();
    return this.options.repository.transitionSubmission(this.options.descriptor, pending.id, {
      state: 'claimed',
      claimId: pending.claimId,
      ...(pending.expectedClaimId === undefined ? {} : { expectedClaimId: pending.expectedClaimId })
    });
  }

  private async assertClaim(pending: PendingSubmission): Promise<void> {
    if (!this.execution) throw new Error('Session execution ownership is required.');
    await this.execution.assertOwned();
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
    for (const pending of this.handles.values()) pending.reject(failure);
    this.handles.clear();
  }

  private async launch(
    pending: PendingSubmission,
    alreadyClaimed = false
  ): Promise<Extract<AgentSessionSubmissionResult, { kind: 'started' }>> {
    try {
      if (!alreadyClaimed) await this.claim(pending);
      this.handles.set(pending.id, pending);
      this.pendingSnapshot = await this.options.repository.loadPendingSubmissions(this.options.descriptor);
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
      await this.releaseExecution();
      throw error;
    }
  }

  private observe(active: ActiveSubmission): void {
    this.active = active;
    this.scheduleRefresh();
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
    return Promise.resolve(this.options.providerBinding?.resolve(configuration, submissionInput(input))).then((binding) => {
      if (binding && this.options.providerBinding) this.options.providerBinding.commit(binding);
      return this.options.createRuntime(
        configuration,
        (event) => {
          this.emit({ type: 'run.progress', runId, event });
          if (event.type === 'context.transition.rejected' || event.type === 'context.transition.unchanged') this.emit(event);
          if (event.type === 'context.transitioned')
            this.emit({
              type: 'context.transitioned',
              window: event.window,
              transition: event.transition
            });
        },
        Object.freeze({ submissionId, runId, input, resuming })
      );
    });
  }

  private async settle(active: ActiveSubmission, result: AgentRunResult): Promise<void> {
    if (this.active !== active) return;
    await this.assertClaim(active.pending);
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
    this.pendingSnapshot = this.pendingSnapshot.flatMap((entry) => entry.submissionId !== active.pending.id ? [entry]
      : suspension ? [{ ...entry, state: 'suspended' as const, suspension }] : []);
    this.handles.delete(active.pending.id);
    this.emit({ type: 'run.completed', runId: active.control.runId, result });
    active.pending.resolve(result);
    await this.releaseExecution();
    if (!this.suspended) await this.launchNext();
  }

  private async fail(active: ActiveSubmission, error: unknown): Promise<void> {
    if (this.active !== active) return;
    this.active = undefined;
    await this.failSubmission(active.pending, active.configuration, error);
    await this.releaseExecution();
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
        this.pendingSnapshot = this.pendingSnapshot.filter((entry) => entry.submissionId !== pending.id);
        this.handles.delete(pending.id);
        pending.resolve(result);
        this.emit({ type: 'run.completed', runId: pending.runId, result });
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
      for (const pending of this.handles.values()) pending.reject(failure);
    this.handles.clear();
    }
    if (!this.closed) this.pendingSnapshot = this.pendingSnapshot.flatMap((entry) => entry.submissionId !== pending.id ? [entry]
      : this.suspended ? [{ ...entry, state: 'suspended' as const, suspension: this.suspended.descriptor }] : []);
    pending.reject(failure);
    this.handles.delete(pending.id);
    this.emit({ type: 'run.failed', runId: pending.runId, error: failure });
  }

  private async acquireExecution(): Promise<boolean> {
    if (this.execution) {
      await this.execution.assertOwned();
      return true;
    }
    this.execution = await this.options.repository.tryAcquireExecution(this.options.descriptor);
    return this.execution !== undefined;
  }

  private async releaseExecution(): Promise<void> {
    const ownership = this.execution;
    if (!ownership) return;
    try {
      await ownership.release();
      this.execution = undefined;
    } catch (cause) {
      this.closed = true;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      for (const pending of this.handles.values()) pending.reject(error);
      this.handles.clear();
      this.events.fail(error);
      throw error;
    }
  }

  private async claimAndLaunchNext(): Promise<Extract<AgentSessionSubmissionResult, { kind: 'started' }> | undefined> {
    if (this.closed || this.active || this.suspended || this.pendingSnapshot.length === 0 || !await this.acquireExecution()) return undefined;
    try {
      const pending = await this.options.repository.loadPendingSubmissions(this.options.descriptor);
      const occupying = pending.find(entry => entry.state !== 'queued');
      const run = occupying && await this.options.runs.find(occupying.runId);
      if (occupying?.state === 'claimed' || (occupying && run?.state.phase.kind === 'terminal')) {
        const recovered = pendingFromRecord(occupying, run !== undefined);
        const local = this.handles.get(occupying.submissionId);
        return await this.launch(local ? { ...recovered, completion: local.completion, resolve: local.resolve, reject: local.reject } : recovered);
      }
      const claimed = occupying ? undefined : await this.options.repository.claimNextSubmission(this.options.descriptor, randomUUID());
      if (!claimed) {
        await this.releaseExecution();
        return undefined;
      }
      const local = this.handles.get(claimed.submissionId);
      const next = local
        ? { ...local, input: claimed.input, configuration: claimed.configuration, claimId: requireSubmissionClaim(claimed) }
        : pendingFromRecord(claimed, false, requireSubmissionClaim(claimed));
      return await this.launch(next, true);
    } catch (error) {
      this.closed = true;
      for (const pending of this.handles.values()) pending.reject(error);
      this.handles.clear();
      await this.releaseExecution();
      throw error;
    }
  }

  private async launchNext(): Promise<void> {
    if (this.options.scheduling === 'manual' || this.closed || this.active) return;
    await this.claimAndLaunchNext();
  }

  private withSubmissionAdmission<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.withSubmissionAdmission?.(operation) ?? operation();
  }

  private emit(event: AgentSessionEvent): void {
    this.events.publish(event);
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
  resumeExisting: boolean,
  claimId?: string
): PendingSubmission {
  return pendingSubmission(
    record.submissionId,
    record.runId,
    record.input,
    record.configuration,
    resumeExisting,
    record.claimId,
    claimId
  );
}

function pendingSubmission(
  id: string,
  runId: string,
  input: SessionSubmissionInput | AgentRunInput,
  configuration: AgentSessionConfiguration,
  resumeExisting = false,
  expectedClaimId?: string,
  claimId: string = randomUUID()
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
    ...(input.origin === undefined ? {} : { origin: parseSessionSubmissionOrigin(input.origin) }),
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
    claimId,
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
    ...(input.origin === undefined ? {} : { origin: parseSessionSubmissionOrigin(input.origin) }),
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
      actions: phase.conflict.kind === 'request_preparation'
        ? suspensionActions('resume', 'context', 'abort')
        : suspensionActions('context', 'abort')
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

function suspendedRunResult(
  state: import('../run/control/contracts.js').AgentRunState,
  suspension: SessionSuspensionDescriptor | undefined
): AgentRunResult {
  if (!suspension || suspension.reason === 'runtime_failed' || !state.budget)
    throw new Error(`Run ${state.runId} has no recoverable suspension result.`);
  const base = { state: 'suspended' as const, runId: state.runId, finalizationId: state.finalizationId, budget: state.budget };
  if (suspension.reason === 'approval_required') {
    const pendingApprovals = state.toolBatches.flatMap((batch) => batch.callStates.flatMap((call) => call.stage === 'approval' ? [call.approval] : []));
    if (pendingApprovals.length === 0) throw new Error(`Run ${state.runId} has no pending approval.`);
    return Object.freeze({ ...base, reason: suspension.reason, pendingApprovals: Object.freeze(pendingApprovals) });
  }
  return Object.freeze({ ...base, reason: suspension.reason,
    ...(suspension.effectId === undefined ? {} : { effectId: suspension.effectId }),
    ...(suspension.contextAdmission === undefined ? {} : { contextAdmission: suspension.contextAdmission }) });
}
