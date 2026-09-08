import { contextTransitionRequestSchema } from './schema.js';
import { randomUUID } from 'node:crypto';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { HistoryReader, sourceRef, sameHistorySource } from '../history/reader.js';
import type { HistorySourceCut, HistorySourceRef, HistoryView } from '../history/contracts.js';
import type { NoteReadResult, NoteRepository } from '../notes/contracts.js';
import type {
  SessionBranchEntry,
  SessionContextTransitionEntry,
  SessionDescriptor,
  SessionRepository
} from '../session/contracts.js';
import type { ContextSelection, ContextTransitionRequest } from './contracts.js';

export interface ContextBootstrapPolicy {
  /** Byte bound is a deterministic bootstrap bound, never an exact token estimate. */
  readonly maxBytes: number;
  /** The host checks the next admitted catalog and its authorization, not merely registration. */
  readonly historyRead?: {
    readonly history: HistoryReader;
    readonly isAvailable: () => boolean | Promise<boolean>;
  };
  readonly selfContained?: boolean;
  readonly mandatorySources?: () => readonly HistorySourceRef[] | Promise<readonly HistorySourceRef[]>;
  /** Discovery only; the governed validator still proves each native transformation. */
  readonly providerStrategyAvailable?: () => boolean | Promise<boolean>;
  /** Host compiles/counts the actual next request and validates its provider obligations. */
  readonly validate: (input: {
    readonly view: HistoryView;
    readonly selection: ContextSelection;
    readonly notes: readonly NoteReadResult[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly providerState: JsonObject } | undefined>;
  /** Model handlers delegate to the application's existing legal-boundary queue. */
  readonly schedule?: (request: ContextTransitionRequest) => Promise<{ readonly requestId: string }>;
}
export interface ContextServiceOptions {
  readonly repository: SessionRepository;
  readonly session: SessionDescriptor;
  readonly history?: HistoryReader;
  readonly notes?: NoteRepository;
  readonly bootstrap: ContextBootstrapPolicy;
}

export class ContextService {
  readonly history: HistoryReader;
  constructor(private readonly options: ContextServiceOptions) {
    this.history =
      options.history ?? new HistoryReader({ repository: options.repository, session: options.session });
    if (typeof options.bootstrap.validate !== 'function')
      throw new Error(
        'Context transitions require host provider/protocol and complete request-fit validation.'
      );
    if (!Number.isSafeInteger(options.bootstrap.maxBytes) || options.bootstrap.maxBytes < 1)
      throw new Error('Context bootstrap maxBytes must be positive.');
  }
  async inspect(cut?: HistorySourceCut) {
    const view = await this.history.view(cut);
    const pending = await this.options.repository.loadPendingSubmissions(this.options.session);
    const window = view.contextWindow;
    const selection = window
      ? {
          retained: window.selection.retained,
          notes: window.selection.notes,
          omitted: window.selection.omitted,
          strategy: window.selection.strategy
        }
      : undefined;
    return Object.freeze({
      cut: view.cut,
      window: window && selection ? Object.freeze({ ...window, selection: Object.freeze(selection) }) : null,
      budget: Object.freeze({ maxBytes: this.options.bootstrap.maxBytes, quality: 'byte_bound' as const }),
      pendingWork: Object.freeze(
        pending.map((item) =>
          Object.freeze({ runId: item.runId, submissionId: item.submissionId, state: item.state })
        )
      ),
      legalTransitions: Object.freeze([
        'retain',
        ...((await this.retrievalAvailable()) || this.options.bootstrap.selfContained ? ['notes'] : []),
        ...((await this.options.bootstrap.providerStrategyAvailable?.()) ? ['provider'] : [])
      ])
    });
  }
  async schedule(request: ContextTransitionRequest): Promise<{ readonly requestId: string }> {
    if (!this.options.bootstrap.schedule)
      throw new Error(
        'Context transitions have no host legal-boundary scheduler. Use the host transition API.'
      );
    return this.options.bootstrap.schedule(ownRequest(request));
  }
  /** Network work belongs outside session serialization; the final repository append alone commits the window. */
  async transition(
    requestInput: ContextTransitionRequest,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<SessionContextTransitionEntry> {
    const request = ownRequest(requestInput);
    throwIfAborted(options.signal);
    if (request.selection.providerState !== undefined)
      throw new Error(
        'Context provider state must come from governed host validation, not the transition request.'
      );
    const fingerprint = hashJson(request);
    const view = await this.history.view();
    const previous = view.entries.find(
      (entry): entry is SessionContextTransitionEntry =>
        entry.type === 'context_transition' && entry.transition.idempotencyKey === request.idempotencyKey
    );
    if (previous) {
      if (previous.transition.requestFingerprint !== fingerprint)
        throw new PersistenceConflictError('Context transition idempotency key has conflicting content.');
      return previous;
    }
    if (
      (view.contextWindow?.windowId ?? null) !== request.expectedWindowId ||
      (request.expectedSourceRevision !== undefined &&
        request.expectedSourceRevision !== view.cut.sourceRevision)
    )
      throw new PersistenceConflictError('Context transition expected boundary is stale.');
    const retained = new Map(request.selection.retained.map((ref) => [ref.entryId, ref]));
    const selected: SessionBranchEntry[] = [];
    for (const entry of view.entries) {
      const ref = retained.get(sourceRef(view.cut.sessionId, entry).entryId);
      if (!ref) continue;
      if (
        ref.sessionId !== view.cut.sessionId ||
        !sameHistorySource(ref, sourceRef(view.cut.sessionId, entry))
      )
        throw new Error('Context source identity mismatch.');
      selected.push(entry);
    }
    if (selected.length !== retained.size)
      throw new Error('Context retained source is outside the authorized branch.');
    const finalizedRuns = new Set(view.runFinalizations.map((record) => record.runId));
    for (const entry of view.entries) {
      if (entry.type !== 'input' || finalizedRuns.has(entry.runId)) continue;
      if (!retained.has(sourceRef(view.cut.sessionId, entry).entryId))
        throw new Error('context_admission_failed: active accepted input is mandatory.');
    }
    if (request.selection.strategy !== 'provider') {
      for (const entry of selected) {
        if (entry.type !== 'observation' || entry.toolBatchId === undefined || entry.callIndex === undefined)
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
          throw new Error('context_admission_failed: selected tool result has no matching original call.');
      }
    }
    for (const ref of (await this.options.bootstrap.mandatorySources?.()) ?? []) {
      if (retained.get(ref.entryId)?.sha256 !== ref.sha256 || ref.sessionId !== view.cut.sessionId)
        throw new Error('context_admission_failed: mandatory source is omitted.');
    }
    // Every omission has a bounded source range and reason; overlap is structural and deduplicated.
    const positions = new Map<string, number>();
    for (const [index, entry] of view.entries.entries()) {
      positions.set(entry.id, index);
      positions.set(sourceRef(view.cut.sessionId, entry).entryId, index);
    }
    const ranges = request.selection.omitted.map((range) => {
      const from = positions.get(range.fromEntryId);
      const to = positions.get(range.toEntryId);
      if (from === undefined || to === undefined || from > to)
        throw new Error('Context omitted range is outside the authorized branch.');
      return { from, to };
    });
    const omitted = view.entries.filter(
      (entry, index) =>
        entry.type !== 'branch' &&
        entry.type !== 'model_settings' &&
        entry.type !== 'context_transition' &&
        !retained.has(sourceRef(view.cut.sessionId, entry).entryId) &&
        !ranges.some((range) => index >= range.from && index <= range.to)
    );
    if (omitted.length > 0)
      throw new Error('Context selection must retain each source or declare its omitted range.');
    const evicts = view.entries.some(
      (entry) =>
        !['branch', 'model_settings', 'context_transition'].includes(entry.type) &&
        !retained.has(sourceRef(view.cut.sessionId, entry).entryId)
    );
    if (evicts && !this.options.bootstrap.selfContained && !(await this.retrievalAvailable()))
      throw new Error(
        'context_admission_failed: omitted history has no authorized available read capability.'
      );
    const notes: NoteReadResult[] = [];
    for (const ref of request.selection.notes) {
      if (!this.options.notes || ref.scope.sessionId !== view.cut.sessionId)
        throw new Error('context_admission_failed: note scope is unavailable.');
      const note = await this.options.notes.read({
        scope: { sessionId: view.cut.sessionId, branchId: view.cut.branchId },
        noteId: ref.noteId,
        revisionId: ref.revisionId,
        maxBytes: Math.min(this.options.bootstrap.maxBytes, 256 * 1024)
      });
      if (
        note.status !== 'available' ||
        note.revision.scope.sessionId !== ref.scope.sessionId ||
        note.revision.scope.branchId !== ref.scope.branchId
      )
        throw new Error('context_admission_failed: note revision or artifact is unavailable.');
      if (note.truncated)
        throw new Error('context_admission_failed: selected note exceeds bootstrap byte budget.');
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
    if (bytes > this.options.bootstrap.maxBytes)
      throw new Error('context_admission_failed: mandatory or selected bootstrap exceeds byte budget.');
    const validation = await this.options.bootstrap.validate({
      view,
      selection: request.selection,
      notes,
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (request.selection.strategy === 'provider' && !validation?.providerState)
      throw new Error('context_admission_failed: provider transform did not return validated state.');
    if (request.selection.strategy !== 'provider' && validation?.providerState)
      throw new Error('Unexpected provider transform state for an original-history transition.');
    const selection: ContextSelection = Object.freeze({
      ...request.selection,
      ...(validation?.providerState ? { providerState: parseJsonObject(validation.providerState) } : {})
    });
    throwIfAborted(options.signal);
    // Exact note reads repeat after host work; staged/missing artifacts cannot become an active bootstrap.
    for (const note of notes) {
      if (note.status !== 'available') continue;
      const verified = await this.options.notes?.read({
        scope: { sessionId: view.cut.sessionId, branchId: view.cut.branchId },
        noteId: note.revision.noteId,
        revisionId: note.revision.revisionId,
        maxBytes: Math.max(1, note.totalBytes)
      });
      if (verified?.status !== 'available')
        throw new Error('context_admission_failed: selected note became unavailable.');
    }
    const timestamp = new Date().toISOString();
    const windowId = randomUUID();
    return this.options.repository.commitContextTransition(this.options.session, {
      expectedLeafId: view.cut.throughEntryId,
      expectedSourceRevision: view.cut.sourceRevision,
      expectedWindowId: request.expectedWindowId,
      window: {
        windowId,
        parentWindowId: request.expectedWindowId,
        historyPosition: view.cut,
        selection,
        reason: request.reason,
        createdAt: timestamp
      },
      transition: {
        transitionId: randomUUID(),
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
  private async retrievalAvailable(): Promise<boolean> {
    const capability = this.options.bootstrap.historyRead;
    if (!capability || !(await capability.isAvailable())) return false;
    const [local, granted] = await Promise.all([this.history.capture(), capability.history.capture()]);
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
