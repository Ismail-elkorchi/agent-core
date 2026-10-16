import { contextToolDefinitions } from './tools.js';
import { stagedSessionState } from './session-state.js';
import type { PromptContextItemInput } from '../inference/prompt-material.js';
import { contextSourceManifest, selectedHistoryMetadata, SELECTED_METADATA_LIMITS, SelectedHistoryMetadata, type ContextInspectionPage } from './inspection.js';
import {
  SELECTED_SOURCE_LIMITS
} from '../orchestration/session-replay.js';
import { contextMetadataGroups, assertContextProtocolClosure } from './selection.js';
import type { CompiledModelRequest } from '@agent-core/model';
import { ContextSourceCapacityError } from '../run/context-admission.js';
import { HistorySourceTooLargeError } from '../history/reader.js';
import { contextCapacityExceeded, requestCapacity } from '../inference/request-admission.js';
import {
  hashJson,
  PersistenceConflictError,
  type ArtifactRepository
} from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';
import type { HistorySourceCut, HistorySourceRef, HistorySourceExcerpt } from '../history/contracts.js';
import { HistoryReader, sameHistorySource, textRange } from '../history/reader.js';
import type { ToolInvocationContext } from '@agent-core/tools';
import {
  assertSessionStateRevision,
  type SessionStateContent,
  type SessionStateSnapshot,
  type SessionStateInference
} from '../session/session-state.js';
import type {
  SessionBranchEntry,
  SessionContextTransitionEntry,
  SessionDescriptor,
  SessionRepository
} from '../session/contracts.js';
import { createContextStateNotice } from './state-notice.js';
import type { ContextStateSequence, ContextTransitionUnchanged, ContextSourceSelection, ContextSelection, ContextTransitionRequest } from './contracts.js';
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
  readonly excerpts: Awaited<ReturnType<HistoryReader['readExcerpts']>>;
  readonly window?: import('./contracts.js').ContextWindowRecord | undefined;
  readonly selection: ContextSelection;
  readonly sessionState: SessionStateSnapshot;
  readonly checkpointState: SessionStateSnapshot;
  readonly stateSequence: ContextStateSequence;
  readonly strategy: 'append' | 'fresh';
  readonly signal?: AbortSignal;
}
export type ContextAdmission = (input: ContextAdmissionInput) => Promise<{
  readonly compiledInputIdentity: string;
  readonly capabilityRevision: string;
  readonly selection?: ContextSelection;
  readonly renewal?: { readonly selection: ContextSelection; readonly stateSequence: ContextStateSequence; readonly cause: 'capacity' | 'prefix_incompatibility' };
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
  private readonly selectedMetadataCache: SelectedHistoryMetadata;

  private selectedMetadata(cut: HistorySourceCut) {
    return this.selectedMetadataCache.read(cut);
  }
  constructor(private readonly options: ContextServiceOptions) {
    this.history =
      options.history ??
      new HistoryReader({
        repository: options.repository,
        session: options.session,
        artifacts: options.artifacts
      });
    this.selectedMetadataCache = new SelectedHistoryMetadata(this.history);
    if (!Number.isSafeInteger(options.policy.maxSourceBytes) || options.policy.maxSourceBytes < 1)
      throw new Error('Context source selection maxSourceBytes must be positive.');
  }
  /** Construct governed context capabilities with this service's owned storage. */
  toolDefinitions(prefix?: string) {
    return contextToolDefinitions({ context: this, artifacts: this.options.artifacts,
      maxSourceBytes: this.options.policy.maxSourceBytes, ...(prefix ? { prefix } : {}) });
  }
  async inspect(cut?: HistorySourceCut, page?: ContextInspectionPage) {
    cut ??= await this.history.capture();
    const pending = await this.options.repository.pendingSubmissionSummaries(this.options.session);
    const window = await this.history.selectedContext(cut);
    const capacity = this.capacity();
    const selection = window
      ? {
          retained: window.selection.retained,
          ...(window.selection.excerpts ? { excerpts: window.selection.excerpts } : {}),
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
      sessionState: await this.inspectSessionState(cut, page ? 0 : undefined),
      pendingWork: Object.freeze(
        pending.map((item) =>
          Object.freeze({ runId: item.runId, submissionId: item.submissionId, state: item.state })
        )
      ),
      legalTransitions: Object.freeze(['unchanged', 'append', 'fresh']),
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
          readonly inference: SessionStateInference;
          readonly capturedHistoryCut: HistorySourceCut;
        }>;
        schedule: (request: ContextTransitionRequest) => Promise<{ readonly requestId: string }>;
      }
    | undefined;
  private admission:
    | {
        readonly status: 'admitted' | 'blocked';
        readonly inputIdentity: string;
        readonly accounting: import('@agent-core/model').RequestAccounting;
        readonly continuityHeadroomTokens?: number;
        readonly message?: string;
        readonly providerRejected?: boolean;
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
          options: 'Inspect the live source selection and available operations with context inspection. Release unneeded complete exchanges or explicitly choose a supported context transition when useful. Session-state updates are optional; no summary or history eviction has occurred.'
        })
      }
    };
  }

  private requiresRenewal(): boolean {
    return this.admission?.status === 'blocked' && contextCapacityExceeded(
      this.admission.accounting, this.admission.continuityHeadroomTokens, this.admission.providerRejected);
  }

  /** Resolve a model's source choices once against the authorized boundary. */
  async selectSources(
    cut: HistorySourceCut,
    change: {
      readonly excerpts?: readonly HistorySourceExcerpt[] | undefined;
      readonly recentFrom?: HistorySourceRef | undefined;
      readonly retain?: readonly HistorySourceRef[] | undefined;
      readonly add?: readonly HistorySourceRef[] | undefined;
      readonly release?: readonly HistorySourceRef[] | undefined;
    }
  ): Promise<ContextSourceSelection> {
    if (change.retain !== undefined && (change.release !== undefined || change.recentFrom !== undefined))
      throw new Error('Use retain for replacement or recentFrom/add/release to edit sources.');
    // An explicit replacement must not read the originals it is discarding.
    // Complete exchanges and transition admission still validate the chosen sources.
    const view =
      change.retain === undefined || change.release?.length
        ? await this.selectedMetadata(cut)
        : { items: [], contextWindow: await this.history.selectedContext(cut) };
    const groups = contextMetadataGroups(view.items, true);
    const recentFrom = change.recentFrom;
    const recentIndex = recentFrom === undefined ? 0 : view.items.findIndex(item => sameHistorySource(item.source, recentFrom));
    if (recentIndex < 0) throw new Error('Recent boundary is not in the active context.');
    const recentIds = new Set(view.items.slice(recentIndex).map(item => item.source.entryId));
    const released = new Set(change.release?.map((source) => source.entryId));
    for (const source of change.release ?? []) {
      const item = view.items.find((item) => item.source.entryId === source.entryId);
      if (!item || !sameHistorySource(item.source, source))
        throw new Error('Released source is not in the active context.');
    }
    const retained = new Map<string, HistorySourceRef>();
    if (change.retain === undefined)
      for (const group of groups)
        if (group.some(item => recentIds.has(item.source.entryId)) && !group.some((item) => released.has(item.source.entryId)))
          for (const item of group) retained.set(item.source.entryId, item.source);
    for (const source of [...(change.retain ?? []), ...(change.add ?? [])]) {
      const group = groups.find((items) =>
        items.some((item) => sameHistorySource(item.source, source))
      );
      const items = group ?? (await this.history.exchangeSources(source, cut));
      for (const item of items) retained.set(item.source.entryId, item.source);
    }
    for (const source of await this.protectedSources(cut)) retained.set(source.entryId, source);
    const excerpts = await this.selectionExcerpts(
      change.excerpts ?? view.contextWindow?.selection.excerpts ?? [], [...retained.values()], cut);
    return {
      ...(excerpts.length ? { excerpts } : {}),
      retained: await this.history.orderSources([...retained.values()], cut),
      ...(view.contextWindow?.selection.protected
        ? { protected: view.contextWindow.selection.protected }
        : {})
    };
  }

  /** Compare canonical source identities without hydrating or ordering discarded history. */
  private async sameCurrentSelection(
    selection: ContextSourceSelection,
    window: import('./contracts.js').ContextWindowRecord | undefined,
    cut: HistorySourceCut,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (hashJson(selection.protected ?? []) !== hashJson(window?.selection.protected ?? [])) return false;
    const expected = new Map(selection.retained.map(source => [source.entryId, source]));
    const matched = new Set<string>();
    const match = (source: HistorySourceRef) => {
      const candidate = expected.get(source.entryId);
      if (!candidate || !sameHistorySource(candidate, source)) return false;
      matched.add(source.entryId);
      return true;
    };
    for (const source of await this.protectedSources(cut)) if (!match(source)) return false;
    let examined = 0;
    let bytes = 0;
    for await (const item of selectedHistoryMetadata(this.history, cut)) {
      throwIfAborted(signal);
      examined++;
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (examined > SELECTED_METADATA_LIMITS.records || bytes > SELECTED_METADATA_LIMITS.bytes)
        throw new ContextSourceCapacityError(cut, bytes > SELECTED_METADATA_LIMITS.bytes
          ? { unit: 'bytes', limit: SELECTED_METADATA_LIMITS.bytes, observedAtLeast: bytes }
          : { unit: 'records', limit: SELECTED_METADATA_LIMITS.records, observedAtLeast: examined });
      // Match the conversational contributions selected by complete-exchange grouping.
      if (item.type !== 'input' && item.type !== 'steering' && !item.exchangeId) continue;
      if (!match(item.source)) return false;
    }
    if (matched.size !== expected.size) return false;
    const excerpts = await this.selectionExcerpts(window?.selection.excerpts ?? [], selection.retained, cut);
    // Both retained sets are now proven equal and the proposal was already ordered by history.
    return hashJson(excerpts) === hashJson(selection.excerpts ?? []);
  }

  private async selectionExcerpts(
    excerpts: readonly HistorySourceExcerpt[], retained: readonly HistorySourceRef[], cut: HistorySourceCut
  ): Promise<readonly HistorySourceExcerpt[]> {
    if (!excerpts.length) return [];
    const normalized = await this.history.canonicalizeExcerpts(excerpts, cut, this.options.policy.maxSourceBytes);
    const originals = new Map(retained.map(source => [source.entryId, source]));
    return normalized.filter(excerpt => {
      const original = originals.get(excerpt.source.entryId);
      return !original || !sameHistorySource(original, excerpt.source);
    });
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
    const result = await this.transition(request, options);
    return 'status' in result ? { kind: 'unchanged' as const, windowId: result.windowId } : { kind: 'selected' as const, entry: result };
  }
  /** Network work belongs outside session serialization; the final repository append alone commits the window. */
  async transition(
    requestInput: ContextTransitionRequest,
    options: {
      readonly signal?: AbortSignal;
      readonly admit?: ContextAdmission;
      readonly renewalReason?: 'capacity' | 'prefix_incompatibility';
    } = {}
  ): Promise<SessionContextTransitionEntry | ContextTransitionUnchanged> {
    let request = ownRequest(requestInput);
    throwIfAborted(options.signal);
    if (!options.admit)
      throw new Error('Context publication requires compiled next-request admission.');
    const cut = await this.history.capture();
    const window = await this.history.selectedContext(cut);
    const captured = await this.sessionState(cut);
    const previous = await this.findTransition(request.idempotencyKey);
    const normalizationState = previous ? await this.sessionState(previous.window.historyPosition) : captured;
    if (request.sessionState) assertSessionStateRevision(normalizationState.revision, request.sessionState.previousRevisionId);
    if (request.sessionState && hashJson(request.sessionState.content) === hashJson(normalizationState.content)) {
      const unchanged = { ...request };
      delete unchanged.sessionState;
      request = ownRequest(unchanged);
    }
    // Reconcile against the original committed selection, never a later live window.
    const normalizationWindow = previous?.window ?? window;
    if (request.selection.protected === undefined && normalizationWindow?.selection.protected)
      request = ownRequest({
        ...request,
        selection: { ...request.selection, protected: normalizationWindow.selection.protected }
      });
    request = ownRequest({
      ...request,
      selection: {
        ...request.selection,
        retained: await this.history.orderSources(request.selection.retained, cut),
        ...(request.selection.excerpts ? { excerpts: await this.selectionExcerpts(request.selection.excerpts, request.selection.retained, cut) } : {})
      }
    });
    const selectionRequest = { ...request };
    delete selectionRequest.toolInvocation;
    delete selectionRequest.expectedCut;
    const fingerprint = hashJson(selectionRequest);
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
    let renewalReason = options.renewalReason ?? (this.requiresRenewal() ? 'capacity' : undefined);
    const requiredRenewal = request.renewal === true || renewalReason !== undefined;
    let sameSelection = false;
    if (!requiredRenewal) {
      try {
        sameSelection = await this.sameCurrentSelection(request.selection, window, cut, options.signal);
      } catch (error) {
        // A bounded replacement must not hydrate the over-capacity history it releases.
        if (!(error instanceof ContextSourceCapacityError)) throw error;
        renewalReason = 'capacity';
      }
    }
    const freshReset = requiredRenewal || !sameSelection;
    const plannedSelection: ContextSelection = {
      ...request.selection,
      ...(!freshReset && window?.selection.continuity ? { continuity: window.selection.continuity } : {})
    };
    const portableSources = new Set((freshReset ? request.selection.retained : window?.selection.continuity?.sources ?? []).map(source => source.entryId));
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
      if (entry.type === 'context_transition')
        throw new Error(
          'context_admission_failed: session state and window records are not selectable conversational contributions.'
        );
      selected.push(entry);
    }
    const excerpts = request.selection.excerpts?.length
      ? await this.history.readExcerpts(request.selection.excerpts, cut, Math.max(1, this.options.policy.maxSourceBytes - sourceBytes))
      : [];
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
    {
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
      if (!sameHistorySource(retained.get(ref.entryId) ?? { sessionId: '', entryId: '', sha256: '' }, ref))
        throw new Error('context_admission_failed: mandatory source is omitted.');
    }
    if (!this.options.policy.selfContained && !(await this.retrievalAvailable())) {
      const snapshot = await this.options.repository.sourceSnapshot(
        this.options.session,
        cut.throughEntryId
      );
      for await (const entry of snapshot.entries)
        if (!['branch', 'model_settings', 'context_transition'].includes(entry.type) &&
            !retained.has(entry.entryId))
          throw new Error(
            'context_admission_failed: omitted history has no authorized available read capability.'
          );
    }
    const expectedSessionStateRevisionId =
      request.expectedSessionStateRevisionId === undefined
        ? (captured.revision?.id ?? null)
        : request.expectedSessionStateRevisionId;
    assertSessionStateRevision(captured.revision, expectedSessionStateRevisionId);
    const sessionState = request.sessionState
      ? stagedSessionState(this.options.policy.maxSourceBytes, request.sessionState, cut.throughEntryId)
      : captured;
    if (request.sessionState) {
      if (!await this.history.extendsCut(request.sessionState.capturedHistoryCut, cut))
        throw new Error('Session-state capture is not an ancestor of the transition boundary.');
      await this.validateSessionStateSources(sessionState.content, request.sessionState.capturedHistoryCut);
      if (request.sessionState.declaredHistoryCut &&
          !await this.history.extendsCut(request.sessionState.declaredHistoryCut, request.sessionState.capturedHistoryCut))
        throw new Error('Declared session-state history cut exceeds its captured boundary.');
    }
    const pending = await this.options.repository.loadPendingSubmissions(this.options.session);
    const bytes = Buffer.byteLength(
      JSON.stringify({
        selected,
        excerpts,
        sessionState: sessionState.content,
        acceptedInput: pending.map((item) => item.input)
      })
    );
    if (bytes > this.options.policy.maxSourceBytes)
      throw new ContextSourceCapacityError(cut, {
        unit: 'bytes',
        limit: this.options.policy.maxSourceBytes,
        observedAtLeast: bytes
      });
    const stateChanged = hashJson(sessionState.content) !== hashJson(captured.content);
    if (!stateChanged && sameSelection && !freshReset && !request.renewal) {
      throwIfAborted(options.signal);
      if (hashJson(await this.history.capture()) !== hashJson(cut))
        throw new PersistenceConflictError('Context source boundary changed during unchanged admission.');
      return Object.freeze({ status: 'unchanged', windowId: window?.windowId ?? null });
    }
    let strategy: 'fresh' | 'append' = freshReset ? 'fresh' : 'append';
    const snapshot = await this.options.repository.sourceSnapshot(this.options.session, cut.throughEntryId);
    const prior = await snapshot.latestContext;
    const checkpointRevisionId = freshReset ? sessionState.revision?.id ?? null
      : window ? window.stateSequence.checkpointRevisionId : captured.revision?.id ?? null;
    let stateSequence: ContextStateSequence = {
      checkpointRevisionId,
      lineage: freshReset ? cut : window?.stateSequence.lineage ?? null,
      parent: freshReset || !prior ? null : { sessionId: cut.sessionId, entryId: prior.entryId, sha256: prior.sha256 },
      ...(!freshReset && stateChanged && sessionState.revision ? {
        notice: createContextStateNotice(captured.revision?.id ?? null, sessionState.revision.id, sessionState.content, cut)
      } : {})
    };
    const checkpointState = freshReset ? sessionState : await this.checkpointState(stateSequence, cut);
    const validation = await options.admit({
      cut,
      entries: selected,
      excerpts,
      window,
      selection: plannedSelection,
      sessionState,
      checkpointState,
      stateSequence,
      strategy,
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (validation.renewal) {
      if (strategy !== 'append' || effectiveSelectionIdentity(validation.renewal.selection) !== effectiveSelectionIdentity(request.selection))
        throw new Error('Renewal fallback may not change the admitted source proposal.');
      strategy = 'fresh';
      stateSequence = validation.renewal.stateSequence;
    }
    const selection: ContextSelection = Object.freeze({ ...(validation.renewal?.selection ?? validation.selection ?? plannedSelection) });
    if (effectiveSelectionIdentity(selection) !== effectiveSelectionIdentity(request.selection))
      throw new Error('Admission changed the requested evidence selection.');
    if (strategy === 'fresh' && (!selection.continuity ||
        selection.continuity.resetId === window?.selection.continuity?.resetId ||
        hashJson(selection.continuity.sources) !== hashJson(selection.retained)))
      throw new Error('Fresh admission must establish a new continuation over the exact selected originals.');
    if (strategy === 'append' && hashJson(selection.continuity ?? null) !== hashJson(window?.selection.continuity ?? null))
      throw new Error('Append admission cannot change provider continuation lineage.');
    throwIfAborted(options.signal);
    if (hashJson(await this.history.capture()) !== hashJson(cut))
      throw new PersistenceConflictError(
        'Context source boundary changed during request admission.'
      );
    const timestamp = new Date().toISOString();
    const windowId = randomUUID();
    return this.options.repository.commitContextTransition(this.options.session, {
      expectedSessionStateRevisionId,
      ...(stateChanged && request.sessionState ? { sessionState: request.sessionState } : {}),
      expectedLeafId: cut.throughEntryId,
      expectedSourceRevision: cut.sourceRevision,
      expectedWindowId: request.expectedWindowId,
      window: {
        stateSequence,
        windowId,
        parentWindowId: request.expectedWindowId,
        historyPosition: cut,
        selection,
        reason: request.reason,
        createdAt: timestamp
      },
      transition: {
        strategy,
        cause: validation.renewal?.cause ?? renewalReason ?? (request.renewal ? 'explicit_renewal' : freshReset ? 'selection_change' : 'state_update'),
        ...(request.renewal === undefined ? {} : { requestedRenewal: request.renewal }),
        transitionId: randomUUID(),
        admission: { status: 'admitted', compiledInputIdentity: validation.compiledInputIdentity,
          capabilityRevision: validation.capabilityRevision },
        idempotencyKey: request.idempotencyKey,
        previousWindowId: request.expectedWindowId,
        windowId,
        requestFingerprint: fingerprint,
        ...(request.expectedSessionStateRevisionId === undefined
          ? {}
          : {
              requestedSessionStateRevisionId: request.expectedSessionStateRevisionId
            }),
        selectionFingerprint: hashJson(selection),
        stateSequenceFingerprint: hashJson(stateSequence),
        ...(request.expectedSourceRevision === undefined
          ? {}
          : { requestedSourceRevision: request.expectedSourceRevision }),
        committedAt: timestamp
      }
    });
  }
  /** Read the immutable checkpoint referenced by a continuation, never the latest mutable state. */
  async checkpointState(stateSequence: ContextStateSequence, cut?: HistorySourceCut): Promise<SessionStateSnapshot> {
    if (stateSequence.checkpointRevisionId === null) return { revision: null, content: { blocks: [] } };
    cut ??= await this.history.capture();
    const snapshot = await this.options.repository.sourceSnapshot(this.options.session, cut.throughEntryId);
    const entry = await this.options.repository.readBranchEntry(this.options.session, snapshot.boundary, stateSequence.checkpointRevisionId);
    if (entry.type !== 'context_transition' || !entry.sessionState)
      throw new Error('Continuation checkpoint does not reference an immutable state revision.');
    return stagedSessionState(this.options.policy.maxSourceBytes, { id: entry.id, ...entry.sessionState }, entry.parentId);
  }

  async validateSessionStateSources(content: SessionStateContent, cut: HistorySourceCut): Promise<void> {
    await this.history.validateCut(cut);
    for (const block of content.blocks)
      for (const source of block.sources ?? [])
        if (!await this.history.metadata(source, cut))
          throw new Error('Session-state citation is unavailable at its captured history cut.');
  }

  async sessionState(cut?: HistorySourceCut): Promise<SessionStateSnapshot> {
    cut ??= await this.history.capture();
    const revision = await this.options.repository.currentSessionState(this.options.session, cut.throughEntryId);
    if (!revision) return Object.freeze({ revision: null, content: Object.freeze({ blocks: Object.freeze([]) }) });
    if (revision.contentBytes > this.options.policy.maxSourceBytes)
      throw new ContextSourceCapacityError(cut, {
        unit: 'bytes', limit: this.options.policy.maxSourceBytes, observedAtLeast: revision.contentBytes
      });
    const snapshot = await this.options.repository.sourceSnapshot(this.options.session, cut.throughEntryId);
    return Object.freeze({ revision, content: await this.sessionStateBody(revision, snapshot.boundary) });
  }

  private async sessionStateBody(
    revision: NonNullable<SessionStateSnapshot['revision']>,
    boundary: import('../session/contracts.js').SessionBranchBoundary
  ): Promise<SessionStateContent> {
    const entry = await this.options.repository.readBranchEntry(this.options.session, boundary, revision.id);
    if (entry.type !== 'context_transition' || !entry.sessionState ||
        hashJson(entry.sessionState.content) !== revision.contentSha256 ||
        Buffer.byteLength(JSON.stringify(entry.sessionState.content)) !== revision.contentBytes)
      throw new Error('Session-state metadata differs from its committed original.');
    return entry.sessionState.content;
  }

  async inspectSessionState(cut?: HistorySourceCut, maxBytes = 32 * 1024) {
    cut ??= await this.history.capture();
    const revision = await this.options.repository.currentSessionState(this.options.session, cut.throughEntryId);
    if (!revision) return { revisionId: null, content: { blocks: [] }, complete: true };
    const snapshot = await this.options.repository.sourceSnapshot(this.options.session, cut.throughEntryId);
    const entry = await snapshot.index.byId.get(revision.id);
    if (!entry) throw new Error('Session-state index points outside the captured session branch.');
    const source = { sessionId: cut.sessionId, entryId: entry.entryId, sha256: entry.sha256 };
    const totalBytes = revision.contentBytes;
    if (maxBytes === 0) return { revisionId: revision.id, complete: false, totalBytes, source };
    const content = await this.sessionStateBody(revision, snapshot.boundary);
    const preview = textRange(JSON.stringify(content), 0, maxBytes);
    return {
      revisionId: revision.id,
      ...(preview.nextOffset === totalBytes ? { content } : { preview: preview.text }),
      complete: preview.nextOffset === totalBytes, totalBytes, source
    };
  }

  async sessionStateOrigin(invocation: ToolInvocationContext) {
    if (!this.runtime)
      throw new Error('Session-state updates require an originating admitted inference.');
    const origin = await this.runtime.origin(invocation);
    await this.history.validateCut(origin.capturedHistoryCut);
    return {
      ...origin,
      sessionId: origin.capturedHistoryCut.sessionId,
      branchId: origin.capturedHistoryCut.branchId
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
    const active: HistorySourceRef[] = [];
    for await (const entry of snapshot.activeInputs()) active.push({
      sessionId: cut.sessionId,
      entryId: entry.entryId,
      sha256: entry.sha256,
      ...(entry.source ? { event: entry.source } : {})
    });
    return Object.freeze([
      ...active,
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
    const item = await snapshot.index.byIdentity.get(`context_transition:${idempotencyKey}`);
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
  const unique = (items: readonly HistorySourceRef[]): readonly HistorySourceRef[] => {
    const refs = new Map<string, HistorySourceRef>();
    for (const source of items) {
      const prior = refs.get(source.entryId);
      if (prior && !sameHistorySource(prior, source))
        throw new Error('Conflicting source references name the same entry.');
      refs.set(source.entryId, source);
    }
    return Object.freeze([...refs.values()]);
  };
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

function effectiveSelectionIdentity(selection: ContextSelection): string {
  return hashJson({ retained: selection.retained, excerpts: selection.excerpts ?? [], protected: selection.protected ?? [] });
}
