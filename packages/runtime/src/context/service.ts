import { contextTransformSources } from '../inference/context-transform.js';
import type { PromptContextItemInput } from '../inference/prompt-material.js';
import { contextSourceManifest, readSelectedHistoryMetadata, type ContextInspectionPage } from './inspection.js';
import {
  SELECTED_SOURCE_LIMITS,
  assertPortableHistoryCompatibility
} from '../orchestration/session-replay.js';
import { contextMetadataGroups, assertContextProtocolClosure } from './selection.js';
import type { CompiledModelRequest, ModelProfile, ModelSelection } from '@agent-core/model';
import { ContextSourceCapacityError } from '../run/context-admission.js';
import { HistorySourceTooLargeError } from '../history/reader.js';
import { requestCapacity } from '../inference/request-admission.js';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  hashArtifactBytes,
  hashJson,
  PersistenceConflictError,
  type ArtifactRepository
} from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';
import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import { HistoryReader, sameHistorySource, textRange } from '../history/reader.js';
import type { ToolInvocationContext } from '@agent-core/tools';
import {
  assertWorkingStateRevision,
  type WorkingStateChange,
  type WorkingStateSnapshot,
  type WorkingStateInference
} from '../session/working-state.js';
import type {
  SessionBranchEntry,
  SessionContextTransitionEntry,
  SessionDescriptor,
  SessionRepository
} from '../session/contracts.js';
import type { ContextSelection, ContextTransitionRequest } from './contracts.js';
import { contextTransitionRequestSchema } from './schema.js';

export interface ContextPolicy {
  /** Bounds source material read; provider compiled accounting alone decides token fit. */
  readonly maxSourceBytes: number;
  readonly historyRead?: {
    readonly history: HistoryReader;
    readonly isAvailable: () => boolean | Promise<boolean>;
  };
  readonly selfContained?: boolean;
  readonly protectedSources?: () =>
    | readonly HistorySourceRef[]
    | Promise<readonly HistorySourceRef[]>;
}
export interface ContextAdmissionInput {
  readonly cut: HistorySourceCut;
  readonly entries: readonly SessionBranchEntry[];
  readonly window?: import('./contracts.js').ContextWindowRecord | undefined;
  readonly selection: ContextSelection;
  readonly workingState: WorkingStateSnapshot;
  readonly signal?: AbortSignal;
}
export type ContextAdmission = (input: ContextAdmissionInput) => Promise<{
  readonly compiledInputIdentity: string;
  readonly capabilityRevision: string;
  readonly providerState?: JsonObject;
}>;
export interface ContextServiceOptions {
  readonly repository: SessionRepository;
  readonly session: SessionDescriptor;
  readonly history?: HistoryReader;
  readonly artifacts: ArtifactRepository;
  readonly policy: ContextPolicy;
}

export class ContextService {
  readonly history: HistoryReader;
  private selectedMetadataCache: {
    readonly identity: string;
    readonly view: ReturnType<typeof readSelectedHistoryMetadata>;
  } | undefined;

  /** Cache only immutable source facts at one exact authorized cut, never policy decisions. */
  private selectedMetadata(cut: HistorySourceCut) {
    const identity = hashJson(cut);
    if (this.selectedMetadataCache?.identity === identity) return this.selectedMetadataCache.view;
    const view = readSelectedHistoryMetadata(this.history, cut);
    this.selectedMetadataCache = { identity, view };
    void view.catch(() => {
      if (this.selectedMetadataCache?.view === view) this.selectedMetadataCache = undefined;
    });
    return view;
  }
  constructor(private readonly options: ContextServiceOptions) {
    this.history =
      options.history ??
      new HistoryReader({
        repository: options.repository,
        session: options.session,
        artifacts: options.artifacts
      });
    if (!Number.isSafeInteger(options.policy.maxSourceBytes) || options.policy.maxSourceBytes < 1)
      throw new Error('Context source selection maxSourceBytes must be positive.');
  }
  async inspect(cut?: HistorySourceCut, page?: ContextInspectionPage) {
    cut ??= await this.history.capture();
    const pending = await this.options.repository.pendingSubmissionSummaries(this.options.session);
    const window = await this.history.selectedContext(cut);
    const capacity = this.capacity();
    const selection = window
      ? {
          retained: window.selection.retained,
          strategy: window.selection.strategy,
          ...(window.selection.protected ? { protected: window.selection.protected } : {}),
          ...(window.selection.continuity ? { continuity: window.selection.continuity } : {})
        }
      : undefined;
    return Object.freeze({
      cut,
      activeSelection: await this.inspectSelection(cut, page),
      window:
        window && selection
          ? Object.freeze({ ...window, selection: Object.freeze(selection) })
          : null,
      budget: Object.freeze({
        maxSourceBytes: this.options.policy.maxSourceBytes,
        quality: 'byte_bound' as const
      }),
      workingState: await this.inspectWorkingState(cut, page ? 0 : undefined),
      pendingWork: Object.freeze(
        pending.map((item) =>
          Object.freeze({ runId: item.runId, submissionId: item.submissionId, state: item.state })
        )
      ),
      legalTransitions: Object.freeze([
        'sources',
        ...((await this.runtime?.providerTransform()) ? ['provider'] : [])
      ]),
      ...(this.admission ? { admission: this.admission } : {}),
      protectedSources: await this.protectedSources(cut),
      ...(capacity ? { capacity } : {})
    });
  }
  private async inspectSelection(cut: HistorySourceCut, page?: ContextInspectionPage): Promise<
    | {
        readonly status: 'available';
        readonly selection?: ContextSelection;
        readonly manifest?: Awaited<ReturnType<typeof contextSourceManifest>>;
      }
    | { readonly status: 'unavailable'; readonly conflict: ContextSourceCapacityError['conflict'] }
  > {
    try {
      if (page) return {
        status: 'available',
        manifest: await contextSourceManifest(this.history, cut, await this.protectedSources(cut), page)
      };
      return { status: 'available', selection: await this.selectSources(cut, {}) };
    } catch (error) {
      if (!(error instanceof ContextSourceCapacityError)) throw error;
      return { status: 'unavailable' as const, conflict: error.conflict };
    }
  }
  private runtime:
    | {
        origin: (invocation: ToolInvocationContext) => Promise<{
          readonly revisionId: string | null;
          readonly inference: WorkingStateInference;
        }>;
        schedule: (request: ContextTransitionRequest) => Promise<{ readonly requestId: string }>;
        providerTransform: () => Promise<boolean>;
        modelSelection?: () => ModelSelection;
      }
    | undefined;
  private admission:
    | {
        readonly status: 'admitted' | 'blocked';
        readonly inputIdentity: string;
        readonly accounting: import('@agent-core/model').RequestAccounting;
        readonly continuityHeadroomTokens?: number;
        readonly message?: string;
        readonly feedback?: {
          readonly key: string;
          readonly notice: PromptContextItemInput;
        };
      }
    | undefined;
  bindRuntime(runtime: NonNullable<ContextService['runtime']>): () => void {
    this.runtime = runtime;
    return () => {
      if (this.runtime === runtime) this.runtime = undefined;
    };
  }
  recordAdmission(value: NonNullable<ContextService['admission']>): void {
    this.admission = Object.freeze(value);
  }
  async assertSourceCapacity(cut?: HistorySourceCut): Promise<void> {
    cut ??= await this.history.capture();
    const view = await this.selectedMetadata(cut);
    let bytes = 0;
    for (const item of contextMetadataGroups(view.items).filter((group) => !group.some((item) => item.contextRecovery)).flat()) {
      bytes += item.sourceBytes;
      if (bytes > this.options.policy.maxSourceBytes)
        throw new ContextSourceCapacityError(cut, {
          unit: 'bytes', limit: this.options.policy.maxSourceBytes, observedAtLeast: bytes
        }, item.source);
    }
  }

  /** Reuse unchanged facts; pressure does not create a recurring maintenance instruction. */
  async capacityFeedback(compiled: CompiledModelRequest, continuityHeadroomTokens?: number) {
    const view = await this.selectedMetadata(await this.history.capture());
    const sourceBytes = view.items.reduce((sum, item) => sum + item.sourceBytes, 0);
    const capacity = requestCapacity(compiled.accounting, continuityHeadroomTokens);
    const sourcePressure =
      sourceBytes >= SELECTED_SOURCE_LIMITS.bytes * 0.8 ||
      view.items.length >= SELECTED_SOURCE_LIMITS.entries * 0.8;
    if (capacity.pressure !== 'continuity' && !sourcePressure) return undefined;
    const key = hashJson({
      pressure: capacity.pressure,
      continuityHeadroomTokens: capacity.continuityHeadroomTokens,
      continuityHeadroomPolicy: capacity.continuityHeadroomPolicy,
      sourcePressure,
      branch: view.cut.branchId,
      window: view.contextWindow?.windowId ?? null,
      provider: compiled.provider,
      model: compiled.model,
      capabilities: compiled.capabilityRevision,
      limits: compiled.accounting.limits,
      output: compiled.accounting.outputReservation,
      reasoning: compiled.accounting.reasoningReservation
    });
    if (this.admission?.feedback?.key === key) return this.admission.feedback;
    const boundary = { inputIdentity: compiled.inputIdentity };
    return {
      key,
      notice: {
        id: `context-capacity-${hashJson(boundary)}`,
        sourceUri: `runtime://context-capacity/${compiled.inputIdentity}`,
        sourceKind: 'generated' as const,
        representation: 'full' as const,
        mediaType: 'text/plain',
        title: 'Context capacity notice',
        purpose: 'Factual capacity at a captured request boundary, not a user instruction or maintenance requirement.',
        content: JSON.stringify({
          ...boundary,
          capacity,
          sourceRead: {
            cut: view.cut,
            bytes: sourceBytes,
            entries: view.items.length,
            limits: SELECTED_SOURCE_LIMITS,
            pressure: sourcePressure ? 'near_bound' : 'normal'
          },
          meaning: 'These measurements describe the compiled candidate before this notice. They are not settled token usage or the session allowance, and do not establish that later results fit. The final request including this notice must pass admission.',
          options: 'Inspect the live source selection and available operations with context inspection. Release unneeded complete exchanges or explicitly choose a supported context transition when useful. Working-state updates are optional; no summary or history eviction has occurred.'
        })
      }
    };
  }

  currentModel(): ModelSelection {
    const selection = this.runtime?.modelSelection?.();
    if (!selection) throw new Error('Fresh continuation requires the active model selection.');
    return selection;
  }

  /** Resolve a model's source choices once against the authorized boundary. */
  async selectSources(
    cut: HistorySourceCut,
    change: {
      readonly retain?: readonly HistorySourceRef[] | undefined;
      readonly add?: readonly HistorySourceRef[] | undefined;
      readonly release?: readonly HistorySourceRef[] | undefined;
    }
  ): Promise<ContextSelection> {
    // An explicit replacement must not read the originals it is discarding.
    // Complete exchanges and transition admission still validate the chosen sources.
    const view =
      change.retain === undefined || change.release?.length
        ? await this.selectedMetadata(cut)
        : { items: [], contextWindow: await this.history.selectedContext(cut) };
    const groups = contextMetadataGroups(view.items);
    const released = new Set(change.release?.map((source) => source.entryId));
    for (const source of change.release ?? []) {
      const item = view.items.find((item) => item.source.entryId === source.entryId);
      if (!item || !sameHistorySource(item.source, source))
        throw new Error('Released source is not in the active context.');
    }
    const retained = new Map<string, HistorySourceRef>();
    if (change.retain === undefined)
      for (const group of groups)
        if (!group.some((item) => released.has(item.source.entryId)))
          for (const item of group) retained.set(item.source.entryId, item.source);
    for (const source of [...(change.retain ?? []), ...(change.add ?? [])]) {
      const group = groups.find((items) =>
        items.some((item) => sameHistorySource(item.source, source))
      );
      const items = group ?? (await this.history.exchangeSources(source, cut));
      for (const item of items) retained.set(item.source.entryId, item.source);
    }
    for (const source of await this.protectedSources(cut)) retained.set(source.entryId, source);
    return {
      strategy: 'sources',
      retained: await this.history.orderSources([...retained.values()], cut),
      ...(view.contextWindow?.selection.protected
        ? { protected: view.contextWindow.selection.protected }
        : {})
    };
  }

  /** A fresh inference continuation ends native reasoning, while preserving selected originals. */
  async freshSelection(input: {
    readonly selection: ContextSelection;
    readonly model: ModelSelection;
    readonly profile: ModelProfile;
    readonly cut: HistorySourceCut;
    readonly resetId: string;
  }): Promise<ContextSelection> {
    const entries: SessionBranchEntry[] = [];
    for (const source of input.selection.retained) {
      const entry = await this.history.resolve(source, input.cut);
      if (!entry) throw new Error('Fresh continuation source is unavailable.');
      entries.push(entry);
    }
    await assertPortableHistoryCompatibility({
      sessionId: input.cut.sessionId,
      entries,
      profile: input.profile,
      artifacts: this.options.artifacts
    });
    return {
      strategy: 'sources',
      retained: input.selection.retained,
      ...(input.selection.protected ? { protected: input.selection.protected } : {}),
      continuity: {
        kind: 'fresh',
        resetId: input.resetId,
        model: input.model,
        sources: input.selection.retained
      }
    };
  }

  async schedule(request: ContextTransitionRequest): Promise<{ readonly requestId: string }> {
    if (!this.runtime)
      throw new Error(
        'Context transition scheduling requires an active run; use session selection controls while idle.'
      );
    return this.runtime.schedule(ownRequest(request));
  }
  async dispatch(
    request: ContextTransitionRequest,
    options: Parameters<ContextService['transition']>[1] = {}
  ) {
    throwIfAborted(options.signal);
    if (this.runtime) return { kind: 'scheduled' as const, ...(await this.schedule(request)) };
    return { kind: 'selected' as const, entry: await this.transition(request, options) };
  }
  /** Network work belongs outside session serialization; the final repository append alone commits the window. */
  async transition(
    requestInput: ContextTransitionRequest,
    options: {
      readonly signal?: AbortSignal;
      readonly admit?: ContextAdmission;
    } = {}
  ): Promise<SessionContextTransitionEntry> {
    let request = ownRequest(requestInput);
    throwIfAborted(options.signal);
    if (request.selection.providerState !== undefined)
      throw new Error(
        'Context provider state must come from governed host validation, not the transition request.'
      );
    const cut = await this.history.capture();
    const window = await this.history.selectedContext(cut);
    if (request.selection.protected === undefined && window?.selection.protected)
      request = ownRequest({
        ...request,
        selection: { ...request.selection, protected: window.selection.protected }
      });
    if (!request.selection.continuity && window?.selection.continuity) {
      const retained = new Set(request.selection.retained.map((source) => source.entryId));
      request = ownRequest({
        ...request,
        selection: {
          ...request.selection,
          continuity: {
            ...window.selection.continuity,
            sources: window.selection.continuity.sources.filter((source) =>
              retained.has(source.entryId)
            )
          }
        }
      });
    }
    request = ownRequest({
      ...request,
      selection: {
        ...request.selection,
        retained: await this.history.orderSources(request.selection.retained, cut)
      }
    });
    const selectionRequest = { ...request };
    delete selectionRequest.toolInvocation;
    delete selectionRequest.expectedCut;
    const fingerprint = hashJson(selectionRequest);
    const previous = await this.findTransition(request.idempotencyKey);
    if (previous) {
      if (previous.transition.requestFingerprint !== fingerprint)
        throw new PersistenceConflictError(
          'Context transition idempotency key has conflicting content.'
        );
      return previous;
    }
    if (
      (window?.windowId ?? null) !== request.expectedWindowId ||
      (request.expectedSourceRevision !== undefined &&
        request.expectedSourceRevision !== cut.sourceRevision)
    )
      throw new PersistenceConflictError('Context transition expected boundary is stale.');
    const freshReset = request.selection.continuity !== undefined &&
      request.selection.continuity.resetId !== window?.selection.continuity?.resetId;
    if (request.selection.continuity && !freshReset) {
      const previous = window?.selection.continuity;
      if (!previous || hashJson(previous.model) !== hashJson(request.selection.continuity.model) ||
          request.selection.continuity.sources.some((source) => !previous.sources.some((prior) => sameHistorySource(prior, source))))
        throw new Error('Preserved fresh-continuation provenance cannot be expanded to new native sources.');
    }
    if (window?.selection.strategy === 'provider' && request.selection.strategy === 'sources' && !freshReset)
      throw new Error('Replacing transformed native continuity requires an explicit fresh continuation.');
    const portableSources = new Set([
      ...(window?.selection.continuity?.sources ?? []),
      ...(request.selection.continuity?.sources ?? []),
      ...(window && request.selection.strategy === 'provider' && options.admit
        ? contextTransformSources(window) : [])
    ].map((source) => source.entryId));
    await assertContextProtocolClosure(this.history, cut, request.selection.retained,
      portableSources, options.signal, freshReset);
    const retained = new Map(request.selection.retained.map((ref) => [ref.entryId, ref]));
    const selected: SessionBranchEntry[] = [];
    let sourceBytes = 0;
    for (const ref of retained.values()) {
      let entry;
      try {
        entry = await this.history.resolve(
          ref,
          cut,
          Math.max(1, this.options.policy.maxSourceBytes - sourceBytes)
        );
      } catch (error) {
        if (!(error instanceof HistorySourceTooLargeError)) throw error;
        throw new ContextSourceCapacityError(
          cut,
          {
            unit: 'bytes',
            limit: this.options.policy.maxSourceBytes,
            observedAtLeast: Math.max(
              this.options.policy.maxSourceBytes + 1,
              sourceBytes + error.bytes
            )
          },
          ref
        );
      }
      if (!entry) throw new Error('Context source is unavailable on the authorized branch.');
      sourceBytes += Buffer.byteLength(JSON.stringify(entry));
      if (sourceBytes > this.options.policy.maxSourceBytes)
        throw new ContextSourceCapacityError(cut, {
          unit: 'bytes',
          limit: this.options.policy.maxSourceBytes,
          observedAtLeast: sourceBytes
        });
      if (entry.type === 'working_state' || entry.type === 'context_transition')
        throw new Error(
          'context_admission_failed: working state and window records are not selectable conversational contributions.'
        );
      selected.push(entry);
    }
    for (const source of await this.protectedSources(cut, false)) {
      if (
        !sameHistorySource(
          retained.get(source.entryId) ?? { sessionId: '', entryId: '', sha256: '' },
          source
        )
      )
        throw new Error(
          'context_admission_failed: active accepted or protected input is mandatory.'
        );
    }
    if (request.selection.strategy !== 'provider') {
      for (const entry of selected) {
        if (
          entry.type !== 'observation' ||
          entry.toolBatchId === undefined ||
          entry.callIndex === undefined
        )
          continue;
        const call = selected.find(
          (item) =>
            item.type === 'tool_call' &&
            item.runId === entry.runId &&
            item.toolBatchId === entry.toolBatchId &&
            item.callIndex === entry.callIndex &&
            item.callId === entry.callId
        );
        if (!call)
          throw new Error(
            'context_admission_failed: selected tool result has no matching original call.'
          );
      }
    }
    for (const ref of request.selection.protected ?? []) {
      if (retained.get(ref.entryId)?.sha256 !== ref.sha256 || ref.sessionId !== cut.sessionId)
        throw new Error('context_admission_failed: mandatory source is omitted.');
    }
    if (!this.options.policy.selfContained && !(await this.retrievalAvailable())) {
      const snapshot = await this.options.repository.sourceSnapshot(
        this.options.session,
        cut.throughEntryId
      );
      if (
        [...snapshot.entries].some(
          (entry) =>
            !['branch', 'model_settings', 'context_transition', 'working_state'].includes(
              entry.type
            ) && !retained.has(entry.entryId)
        )
      )
        throw new Error(
          'context_admission_failed: omitted history has no authorized available read capability.'
        );
    }
    const captured = await this.workingState(cut);
    const expectedWorkingStateRevisionId =
      request.expectedWorkingStateRevisionId === undefined
        ? (captured.revision?.id ?? null)
        : request.expectedWorkingStateRevisionId;
    assertWorkingStateRevision(captured.revision, expectedWorkingStateRevisionId);
    const workingState = request.workingState
      ? await this.snapshotForChange(request.workingState, cut.throughEntryId)
      : captured;
    const pending = await this.options.repository.loadPendingSubmissions(this.options.session);
    const bytes = Buffer.byteLength(
      JSON.stringify({
        selected: request.selection.strategy === 'provider' ? [] : selected,
        workingState,
        acceptedInput: pending.map((item) => item.input)
      })
    );
    if (bytes > this.options.policy.maxSourceBytes)
      throw new ContextSourceCapacityError(cut, {
        unit: 'bytes',
        limit: this.options.policy.maxSourceBytes,
        observedAtLeast: bytes
      });
    const validation = await options.admit?.({
      cut,
      entries: selected,
      window,
      selection: request.selection,
      workingState,
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (request.selection.strategy === 'provider' && !validation?.providerState)
      throw new Error(
        'context_admission_failed: provider transform did not return validated state.'
      );
    if (request.selection.strategy !== 'provider' && validation?.providerState)
      throw new Error('Unexpected provider transform state for an original-history transition.');
    const selection: ContextSelection = Object.freeze({
      ...request.selection,
      ...(validation?.providerState
        ? { providerState: parseJsonObject(validation.providerState) }
        : {})
    });
    throwIfAborted(options.signal);
    if (workingState.revision)
      await this.options.artifacts.readVerified(workingState.revision.contentRef);
    if (hashJson(await this.history.capture()) !== hashJson(cut))
      throw new PersistenceConflictError(
        'Context source boundary changed during request admission.'
      );
    const timestamp = new Date().toISOString();
    const windowId = randomUUID();
    return this.options.repository.commitContextTransition(this.options.session, {
      expectedWorkingStateRevisionId,
      ...(request.workingState ? { workingState: request.workingState } : {}),
      expectedLeafId: cut.throughEntryId,
      expectedSourceRevision: cut.sourceRevision,
      expectedWindowId: request.expectedWindowId,
      window: {
        windowId,
        parentWindowId: request.expectedWindowId,
        historyPosition: cut,
        selection,
        reason: request.reason,
        createdAt: timestamp
      },
      transition: {
        transitionId: randomUUID(),
        ...(validation
          ? {
              compiledInputIdentity: validation.compiledInputIdentity,
              capabilityRevision: validation.capabilityRevision
            }
          : {}),
        idempotencyKey: request.idempotencyKey,
        previousWindowId: request.expectedWindowId,
        windowId,
        requestFingerprint: fingerprint,
        ...(request.expectedWorkingStateRevisionId === undefined
          ? {}
          : {
              requestedWorkingStateRevisionId: request.expectedWorkingStateRevisionId
            }),
        selectionFingerprint: hashJson(selection),
        ...(request.expectedSourceRevision === undefined
          ? {}
          : { requestedSourceRevision: request.expectedSourceRevision }),
        committedAt: timestamp
      }
    });
  }
  async workingState(cut?: HistorySourceCut): Promise<WorkingStateSnapshot> {
    const revision = await this.options.repository.currentWorkingState(
      this.options.session,
      cut?.throughEntryId
    );
    if (!revision) return { revision: null, text: '' };
    if (revision.contentRef.size > this.options.policy.maxSourceBytes)
      throw new ContextSourceCapacityError(cut ?? (await this.history.capture()), {
        unit: 'bytes',
        limit: this.options.policy.maxSourceBytes,
        observedAtLeast: revision.contentRef.size
      });
    return {
      revision,
      text: new TextDecoder('utf-8', { fatal: true }).decode(
        await this.options.artifacts.readVerified(revision.contentRef)
      )
    };
  }

  async inspectWorkingState(cut?: HistorySourceCut, maxBytes = 32 * 1024) {
    cut ??= await this.history.capture();
    const revision = await this.options.repository.currentWorkingState(
      this.options.session,
      cut.throughEntryId
    );
    if (!revision) return { revisionId: null, text: '', complete: true };
    // State remains generated material. The history reference authorizes recovering the exact original body.
    const snapshot = await this.options.repository.sourceSnapshot(
      this.options.session,
      cut.throughEntryId
    );
    const entry = snapshot.index.byId.get(revision.id);
    if (!entry) throw new Error('Working-state index points outside the captured session branch.');
    const source = { sessionId: cut.sessionId, entryId: entry.entryId, sha256: entry.sha256 };
    if (maxBytes === 0)
      return { revisionId: revision.id, text: '', complete: revision.contentRef.size === 0,
        totalBytes: revision.contentRef.size, source };
    const range = await this.options.artifacts.readVerifiedRange(revision.contentRef, {
      offset: 0,
      length: maxBytes
    });
    const preview = textRange(
      new TextDecoder('utf-8', { fatal: true }).decode(range.bytes),
      0,
      maxBytes
    );
    return {
      revisionId: revision.id,
      text: preview.text,
      complete: preview.nextOffset === range.fullSize,
      totalBytes: range.fullSize,
      source
    };
  }

  async workingStateOrigin(invocation: ToolInvocationContext) {
    if (!this.runtime)
      throw new Error('Working-state updates require an originating admitted inference.');
    const cut = await this.history.capture();
    return {
      ...(await this.runtime.origin(invocation)),
      sessionId: cut.sessionId,
      branchId: cut.branchId
    };
  }

  async stageWorkingState(input: {
    readonly id: string;
    readonly revisionId: string | null;
    readonly inference: WorkingStateInference;
    readonly text: string;
  }): Promise<
    | WorkingStateChange
    | { readonly status: 'unchanged' }
    | {
        readonly status: 'conflict';
        readonly current: Awaited<ReturnType<ContextService['inspectWorkingState']>>;
      }
    | {
        readonly status: 'invalid';
        readonly failures: readonly {
          readonly reason: string;
          readonly message: string;
          readonly editIndex?: number;
        }[];
      }
  > {
    const current = await this.workingState();
    if ((current.revision?.id ?? null) !== input.revisionId)
      return { status: 'conflict', current: await this.inspectWorkingState() };
    if (input.text === current.text) return { status: 'unchanged' };
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.byteLength > this.options.policy.maxSourceBytes)
      return {
        status: 'invalid',
        failures: [
          {
            reason: 'result_too_large',
            message:
              'Working state exceeds the available source byte capacity; no revision was published.'
          }
        ]
      };
    const contentRef = await this.options.artifacts.storeProtected({
      label: 'working-state',
      mediaType: 'text/plain; charset=utf-8',
      content: bytes
    });
    return {
      id: input.id,
      previousRevisionId: input.revisionId,
      contentRef,
      inference: input.inference
    };
  }

  async updateWorkingState(
    input: Parameters<ContextService['stageWorkingState']>[0] & {
      readonly sessionId: string;
      readonly branchId: string;
    }
  ) {
    const cut = await this.history.capture();
    if (input.sessionId !== cut.sessionId || input.branchId !== cut.branchId)
      throw new Error('Working-state branch changed after authorization.');
    const snapshot = await this.options.repository.sourceSnapshot(
      this.options.session,
      cut.throughEntryId
    );
    const published = snapshot.index.byId.get(input.id);
    if (published) {
      const entry = await this.history.resolve(
        { sessionId: cut.sessionId, entryId: published.entryId, sha256: published.sha256 },
        cut
      );
      if (
        entry?.type !== 'working_state' ||
        hashJson(entry.inference) !== hashJson(input.inference) ||
        entry.previousRevisionId !== input.revisionId
      )
        throw new PersistenceConflictError('Working-state retry does not match its publication.');
      if (hashArtifactBytes(new TextEncoder().encode(input.text)) !== entry.contentRef.sha256)
        throw new PersistenceConflictError('Working-state retry has different content.');
      // Reconcile the receipt before looking at today's head: later revisions do not invalidate a committed update.
      return { status: 'committed' as const, revisionId: entry.id };
    }
    const prepared = await this.stageWorkingState(input);
    if ('status' in prepared) return prepared;
    try {
      const revision = await this.options.repository.commitWorkingState(
        this.options.session,
        prepared,
        input.branchId
      );
      return { status: 'committed' as const, revisionId: revision.id };
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
      return { status: 'conflict' as const, current: await this.inspectWorkingState() };
    }
  }

  private async snapshotForChange(
    change: WorkingStateChange,
    parentId: string | null
  ): Promise<WorkingStateSnapshot> {
    if (change.contentRef.size > this.options.policy.maxSourceBytes)
      throw new Error('Proposed working state exceeds the context source byte bound.');
    return {
      revision: { ...change, type: 'working_state', parentId, timestamp: new Date().toISOString() },
      text: new TextDecoder('utf-8', { fatal: true }).decode(
        await this.options.artifacts.readVerified(change.contentRef)
      )
    };
  }

  private capacity() {
    return this.admission ? requestCapacity(this.admission.accounting, this.admission.continuityHeadroomTokens) : undefined;
  }
  async protectedSources(
    cut?: HistorySourceCut,
    includeSelection = true
  ): Promise<readonly HistorySourceRef[]> {
    cut ??= await this.history.capture();
    const snapshot = await this.options.repository.sourceSnapshot(
      this.options.session,
      cut.throughEntryId
    );
    const active = [...snapshot.activeInputs()];
    return Object.freeze([
      ...active.map((entry) => ({
        sessionId: cut.sessionId,
        entryId: entry.entryId,
        sha256: entry.sha256,
        ...(entry.source ? { event: entry.source } : {})
      })),
      ...(includeSelection
        ? ((await this.history.selectedContext(cut))?.selection.protected ?? [])
        : []),
      ...((await this.options.policy.protectedSources?.()) ?? [])
    ]);
  }
  async findTransition(idempotencyKey: string): Promise<SessionContextTransitionEntry | undefined> {
    const cut = await this.history.capture();
    const snapshot = await this.options.repository.sourceSnapshot(
      this.options.session,
      cut.throughEntryId
    );
    const item = snapshot.index.byIdentity.get(`context_transition:${idempotencyKey}`);
    if (!item) return undefined;
    const entry = await this.history.resolve(
      { sessionId: cut.sessionId, entryId: item.entryId, sha256: item.sha256 },
      cut
    );
    if (entry?.type !== 'context_transition' || entry.transition.idempotencyKey !== idempotencyKey)
      throw new Error('Context transition index contradicts its original source.');
    return entry;
  }

  private async retrievalAvailable(): Promise<boolean> {
    const capability = this.options.policy.historyRead;
    if (!capability || !(await capability.isAvailable())) return false;
    const [local, granted] = await Promise.all([
      this.history.capture(),
      capability.history.capture()
    ]);
    return local.sessionId === granted.sessionId && local.branchId === granted.branchId;
  }
}
function ownRequest(input: ContextTransitionRequest): ContextTransitionRequest {
  const value = contextTransitionRequestSchema.parse(input);
  const unique = <T>(items: readonly T[]): readonly T[] =>
    Object.freeze([...new Map(items.map((item) => [JSON.stringify(item), item])).values()]);
  return Object.freeze({
    ...value,
    selection: Object.freeze({
      ...value.selection,
      retained: unique(value.selection.retained)
    })
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Context transition aborted.');
}
