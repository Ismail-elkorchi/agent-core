import { requestCapacity } from '../inference/request-admission.js';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';
import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import { HistoryReader, sameHistorySource } from '../history/reader.js';
import type { NoteReadResult, NoteRepository } from '../notes/contracts.js';
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
    readonly HistorySourceRef[] | Promise<readonly HistorySourceRef[]>;
}
export interface ContextAdmissionInput {
  readonly cut: HistorySourceCut;
  readonly entries: readonly SessionBranchEntry[];
  readonly window?: import('./contracts.js').ContextWindowRecord | undefined;
  readonly selection: ContextSelection;
  readonly notes: readonly NoteReadResult[];
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
  readonly notes?: NoteRepository;
  readonly policy: ContextPolicy;
}

export class ContextService {
  readonly history: HistoryReader;
  constructor(private readonly options: ContextServiceOptions) {
    this.history =
      options.history ??
      new HistoryReader({ repository: options.repository, session: options.session });
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
          notes: window.selection.notes,
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
        retained: await this.protectedSources(),
        notes: []
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
    options: { readonly signal?: AbortSignal; readonly admit?: ContextAdmission } = {}
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
      const entry = await this.history.resolve(
        ref,
        cut,
        Math.max(1, this.options.policy.maxSourceBytes - sourceBytes)
      );
      if (!entry) throw new Error('Context source is unavailable on the authorized branch.');
      sourceBytes += Buffer.byteLength(JSON.stringify(entry));
      if (sourceBytes > this.options.policy.maxSourceBytes)
        throw new Error('Selected sources exceed the source byte bound.');
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
            !['branch', 'model_settings', 'context_transition'].includes(entry.type) &&
            !retained.has(entry.entryId)
        )
      )
        throw new Error(
          'context_admission_failed: omitted history has no authorized available read capability.'
        );
    }
    const notes: NoteReadResult[] = [];
    for (const ref of request.selection.notes) {
      if (!this.options.notes || ref.scope.sessionId !== cut.sessionId)
        throw new Error('context_admission_failed: note scope is unavailable.');
      const note = await this.options.notes.read({
        scope: { sessionId: cut.sessionId, branchId: cut.branchId },
        noteId: ref.noteId,
        revisionId: ref.revisionId,
        maxBytes: Math.min(this.options.policy.maxSourceBytes, 256 * 1024)
      });
      if (
        note.status !== 'available' ||
        note.revision.scope.sessionId !== ref.scope.sessionId ||
        note.revision.scope.branchId !== ref.scope.branchId
      )
        throw new Error('context_admission_failed: note revision or artifact is unavailable.');
      if (note.truncated)
        throw new Error(
          'context_admission_failed: selected note exceeds source selection byte budget.'
        );
      notes.push(note);
    }
    const pending = await this.options.repository.loadPendingSubmissions(this.options.session);
    const bytes = Buffer.byteLength(
      JSON.stringify({
        selected: request.selection.strategy === 'provider' ? [] : selected,
        notes,
        acceptedInput: pending.map((item) => item.input)
      })
    );
    if (bytes > this.options.policy.maxSourceBytes)
      throw new Error(
        'context_admission_failed: mandatory or selected source selection exceeds byte budget.'
      );
    const validation = await options.admit?.({
      cut,
      entries: selected,
      window,
      selection: request.selection,
      notes,
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
    // Exact note reads repeat after host work; staged/missing artifacts cannot become an active source selection.
    for (const note of notes) {
      if (note.status !== 'available') continue;
      const verified = await this.options.notes?.read({
        scope: { sessionId: cut.sessionId, branchId: cut.branchId },
        noteId: note.revision.noteId,
        revisionId: note.revision.revisionId,
        maxBytes: Math.max(1, note.totalBytes)
      });
      if (verified?.status !== 'available')
        throw new Error('context_admission_failed: selected note became unavailable.');
    }
    if (hashJson(await this.history.capture()) !== hashJson(cut))
      throw new PersistenceConflictError(
        'Context source boundary changed during request admission.'
      );
    const timestamp = new Date().toISOString();
    const windowId = randomUUID();
    return this.options.repository.commitContextTransition(this.options.session, {
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
      retained: unique(value.selection.retained),
      notes: unique(value.selection.notes)
    })
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Context transition aborted.');
}
