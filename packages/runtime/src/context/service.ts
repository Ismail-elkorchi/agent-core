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
  async inspect(cut?: HistorySourceCut) {
    cut ??= await this.history.capture();
    const pending = await this.options.repository.loadPendingSubmissions(this.options.session);
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
      window:
        window && selection
          ? Object.freeze({ ...window, selection: Object.freeze(selection) })
          : null,
      budget: Object.freeze({
        maxSourceBytes: this.options.policy.maxSourceBytes,
        quality: 'byte_bound' as const
      }),
      workingState: await this.inspectWorkingState(cut),
      pendingWork: Object.freeze(
        pending.map((item) =>
          Object.freeze({ runId: item.runId, submissionId: item.submissionId, state: item.state })
        )
      ),
      legalTransitions: Object.freeze([
        'sources',
        ...(this.runtime?.providerTransform ? ['provider'] : [])
      ]),
      ...(this.admission ? { admission: this.admission } : {}),
      protectedSources: await this.protectedSources(cut),
      ...(capacity ? { capacity } : {})
    });
  }
  private runtime:
    | {
        origin: (invocation: ToolInvocationContext) => Promise<{
          readonly revisionId: string | null;
          readonly inference: WorkingStateInference;
        }>;
        schedule: (request: ContextTransitionRequest) => Promise<{ readonly requestId: string }>;
        providerTransform: boolean;
      }
    | undefined;
  private admission:
    | {
        readonly status: 'admitted' | 'blocked';
        readonly inputIdentity: string;
        readonly accounting: import('@agent-core/model').RequestAccounting;
        readonly message?: string;
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
  async schedule(request: ContextTransitionRequest): Promise<{ readonly requestId: string }> {
    if (!this.runtime)
      throw new Error(
        'Context renewal requires an active run; use session selection controls while idle.'
      );
    return this.runtime.schedule(ownRequest(request));
  }
  async request(input: {
    readonly selection?: ContextSelection;
    readonly reason: string;
    readonly idempotencyKey: string;
  }) {
    const current = await this.inspect();
    const request: ContextTransitionRequest = {
      expectedWindowId: current.window?.windowId ?? null,
      expectedSourceRevision: current.cut.sourceRevision,
      selection: input.selection ?? {
        strategy: 'sources',
        retained: await this.protectedSources()
      },
      reason: input.reason,
      idempotencyKey: input.idempotencyKey
    };
    if (this.runtime) return { kind: 'scheduled' as const, ...(await this.schedule(request)) };
    return { kind: 'selected' as const, entry: await this.transition(request) };
  }
  /** Network work belongs outside session serialization; the final repository append alone commits the window. */
  async transition(
    requestInput: ContextTransitionRequest,
    options: {
      readonly signal?: AbortSignal;
      readonly admit?: ContextAdmission;
      readonly workingState?: WorkingStateChange;
      readonly expectedWorkingStateRevisionId?: string | null;
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
        snapshot.entries.some(
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
      options.expectedWorkingStateRevisionId === undefined
        ? (captured.revision?.id ?? null)
        : options.expectedWorkingStateRevisionId;
    assertWorkingStateRevision(captured.revision, expectedWorkingStateRevisionId);
    const workingState = options.workingState
      ? await this.snapshotForChange(options.workingState, cut.throughEntryId)
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
      ...(options.workingState ? { workingState: options.workingState } : {}),
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
    const range = await this.options.artifacts.readVerifiedRange(revision.contentRef, {
      offset: 0,
      length: maxBytes
    });
    const preview = textRange(
      new TextDecoder('utf-8', { fatal: true }).decode(range.bytes),
      0,
      maxBytes
    );
    // State remains generated material. The history reference authorizes recovering the exact original body.
    const snapshot = await this.options.repository.sourceSnapshot(
      this.options.session,
      cut.throughEntryId
    );
    const entry = snapshot.entries.find((entry) => entry.entryId === revision.id);
    if (!entry) throw new Error('Working-state index points outside the captured session branch.');
    return {
      revisionId: revision.id,
      text: preview.text,
      complete: preview.nextOffset === range.fullSize,
      totalBytes: range.fullSize,
      source: { sessionId: cut.sessionId, entryId: entry.entryId, sha256: entry.sha256 }
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
    const published = snapshot.entries.find((entry) => entry.entryId === input.id);
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
    return this.admission ? requestCapacity(this.admission.accounting) : undefined;
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
    const finalized = new Set(snapshot.finalizations.map((item) => item.runId));
    const active = snapshot.entries.filter(
      (entry) =>
        (entry.type === 'input' || entry.type === 'steering') &&
        entry.runId &&
        !finalized.has(entry.runId)
    );
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
    const item = snapshot.entries.find(
      (entry) => entry.identity === `context_transition:${idempotencyKey}`
    );
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
