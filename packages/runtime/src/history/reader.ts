import { confirmCommittedSessionFinalization } from '../orchestration/finalization.js';
import { historyToolName, matchesHistoryMetadata } from './metadata.js';
import {
  HistorySearchIndex,
  type IndexedHistorySource
} from './search-index.js';
import { parseJsonObject } from '@agent-core/json';
import {
  encodeToolFailureOutput,
  serializeToolModelContent,
  ToolInputError
} from '@agent-core/tools';
import {
  hashJson,
  type ArtifactRepository,
  type EventRepository,
  type EventSourceMetadata,
  type EventEnvelope
} from '@agent-core/persistence';
import type { AgentEvent } from '../events.js';
import type {
  SessionBranchEntry,
  SessionDescriptor,
  SessionRepository
} from '../session/contracts.js';
import type {
  HistorySourceMetadata,
  HistorySearchPosition,
  HistoryMetadataPage,
  HistoryMetadataPageRequest,
  HistoryFilter,
  HistoryUnreadSource,
  HistoryItem,
  HistoryReadRequest,
  HistoryReadResult,
  HistorySearchRequest,
  HistorySearchResult,
  HistorySourceCut,
  HistorySourceRef,
  HistoryEntryPage,
  HistoryEntryPageRequest,
  HistoryLedgerHead
} from './contracts.js';
import { publicEventEntry, mergeMirror, entryIdentity } from './ledger.js';
import { historySearchContent } from './model-content.js';
import { historyCutSchema, sourceSchema } from './schema.js';
import { resolveToolObservation } from '../orchestration/observation-source.js';
import { assistantResponseKey, toolEventKey } from '../run/contracts.js';
import type { ContextWindowRecord } from '../context/contracts.js';
import type { SessionSourceMetadata, SessionSourceSnapshot } from '../session/contracts.js';

const MAX_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SCANNED = 1000;
const MAX_RESULTS = 100;

/** Host-bound source access. Routing metadata and immutable ledger boundaries precede body reads. */
export class HistoryReader {
  private searchIndex:
    | {
        filter: string;
        cut: HistorySourceCut;
        index: HistorySearchIndex;
        next?: string | undefined;
        complete: boolean;
        unread: HistoryUnreadSource[];
        partialStart: boolean;
        invalidAt?: number | undefined;
      }
    | undefined;
  private captureIndex:
    | {
        snapshot: SessionSourceSnapshot;
        /** Whether each unconfirmed run has been recorded in the session. */
        readonly pending: Map<string, boolean>;
        readonly ended: Set<string>;
        readonly inherited: ReadonlyMap<string, HistoryLedgerHead>;
      }
    | undefined;

  /** Refresh only new branch metadata. Confirmed terminal commits are immutable. */
  private async captureRuns(snapshot: SessionSourceSnapshot) {
    let index = this.captureIndex;
    const previous = index?.snapshot;
    const last = (await previous?.entries.at(-1));
    const extendsPrevious =
      previous?.branchId === snapshot.branchId &&
      previous.sourceRevision <= snapshot.sourceRevision &&
      previous.entries.length <= snapshot.entries.length &&
      (last === undefined ||
        ((await snapshot.entries.at(previous.entries.length - 1))?.entryId === last.entryId &&
          (await snapshot.entries.at(previous.entries.length - 1))?.sha256 === last.sha256));
    if (!index || !extendsPrevious) {
      index = {
        snapshot,
        pending: new Map(),
        ended: new Set(),
        inherited: await snapshot.inheritedHeads
      };
      this.captureIndex = index;
    }
    if (previous !== snapshot) {
      for await (const { runId, finalized } of snapshot.unconfirmedRuns()) {
        if (!index.ended.has(runId) && !index.inherited.has(runId))
          index.pending.set(runId, finalized);
      }
      // A durable confirmation removes a formerly outstanding run without querying its archive.
      for (const runId of index.pending.keys()) {
        if (await snapshot.confirmedHead(runId)) { index.pending.delete(runId); index.ended.add(runId); }
        else if (await snapshot.finalizedRuns.has(runId)) index.pending.set(runId, true);
      }
      index.snapshot = snapshot;
    }
    return index;
  }

  constructor(
    private readonly options: {
      readonly repository: SessionRepository;
      readonly session: SessionDescriptor;
      readonly events?: EventRepository<AgentEvent>;
      readonly artifacts?: ArtifactRepository;
    }
  ) {}

  async capture(): Promise<HistorySourceCut> {
    const snapshot = await this.options.repository.sourceSnapshot(this.options.session);
    const boundary = {
      format: 'agent-core.history/1' as const,
      sessionId: this.options.session.id,
      branchId: snapshot.branchId,
      throughEntryId: snapshot.boundary.leafId,
      sourceRevision: snapshot.sourceRevision
    };
    if (!this.options.events) return Object.freeze({ ...boundary, ledgerCoverage: 'session' });
    const index = await this.captureRuns(snapshot);
    const heads: HistoryLedgerHead[] = [...index.inherited.values()];
    // Own this capture's work before awaiting: another capture may observe a later boundary.
    const pending = [...index.pending];
    let repaired = false;
    for (const [runId, finalized] of pending) {
      if (finalized) {
        const committed = await this.options.events.latestOfType(runId, 'run.ended');
        if (committed?.event.type === 'run.ended') {
          const terminal = committed.event.terminal;
          if (terminal.runId !== runId) throw new Error('Authoritative terminal run identity mismatch.');
          const source = { runId, eventId: committed.eventId, sequence: committed.sequence, hash: committed.hash };
          const diagnostic = await confirmCommittedSessionFinalization({
            events: this.options.events,
            session: { repository: this.options.repository, descriptor: this.options.session },
            terminal, source, rejectConflicts: true
          });
          if (diagnostic) {
            heads.push({ runId, sequence: source.sequence, hash: source.hash });
            continue;
          }
          repaired = true;
          index.ended.add(runId);
          index.pending.delete(runId);
          continue;
        }
      }
      const tail = await this.options.events.tail(runId, { metadataOnly: true });
      heads.push(
        Object.freeze({
          runId,
          sequence: tail.sequence,
          ...(tail.hash ? { hash: tail.hash } : {})
        })
      );
    }

    if (repaired) {
      const refreshed = await this.options.repository.sourceSnapshot(this.options.session);
      if (refreshed.boundary.leafId === snapshot.boundary.leafId && refreshed.boundary.leafHash === snapshot.boundary.leafHash)
        boundary.sourceRevision = refreshed.sourceRevision;
    }
    return Object.freeze({
      ...boundary,
      ledgerCoverage: 'authoritative',
      ledgerHeads: Object.freeze(heads)
    });
  }

  async validateCut(cut: HistorySourceCut): Promise<void> {
    await this.snapshot(cut);
  }

  /** Whether an immutable cut can be incrementally extended to another authorized cut. */
  async extendsCut(previous: HistorySourceCut, next: HistorySourceCut): Promise<boolean> {
    if (
      previous.sessionId !== next.sessionId ||
      previous.sourceRevision > next.sourceRevision ||
      previous.ledgerCoverage !== next.ledgerCoverage
    )
      return false;
    const snapshot = await this.snapshot(next);
    if (previous.throughEntryId !== null && !(await snapshot.index.byId.has(previous.throughEntryId)))
      return false;
    await this.snapshot(previous);
    for (const head of previous.ledgerHeads ?? []) {
      const current = await this.head(head.runId, next, snapshot);
      if (
        current.sequence < head.sequence ||
        (current.sequence === head.sequence && current.hash !== head.hash)
      )
        return false;
    }
    return true;
  }

  async toolSources(
    invocation: NonNullable<
      import('../context/contracts.js').ContextTransitionRequest['toolInvocation']
    >,
    cut: HistorySourceCut
  ): Promise<readonly HistorySourceRef[]> {
    const snapshot = await this.snapshot(cut);
    if (!(await snapshot.index.runs.has(invocation.runId)))
      throw new Error('Tool invocation is outside the authorized branch.');
    if (this.options.events && cut.ledgerCoverage === 'authoritative') {
      const head = await this.head(invocation.runId, cut, snapshot);
      const events = this.options.events;
      const keys = [
        assistantResponseKey(invocation.runId, invocation),
        ...['started', 'ended'].map((stage) => toolEventKey(invocation.runId, invocation, stage))
      ];
      return Promise.all(
        keys.map(async (key) => {
          const reference = await events.referenceByKey(invocation.runId, key, { metadataOnly: true });
          if (!reference || reference.sequence > head.sequence)
            throw new Error('Context operation has an unresolved tool exchange.');
          return {
            sessionId: cut.sessionId,
            entryId: `event:${reference.eventId}`,
            sha256: reference.hash,
            event: reference
          };
        })
      );
    }
    const identities = [
      `tool_call:${invocation.runId}:${invocation.toolBatchId}:${String(invocation.callIndex)}`,
      `observation:${invocation.runId}:${invocation.turnId}:${String(invocation.requestAttempt)}:${invocation.toolBatchId}:${String(invocation.callIndex)}:${String(invocation.toolAttempt)}`
    ];
    const assistant = (await Promise.all(['complete', 'partial', 'indeterminate', 'absent']
      .map(async (status) =>
        (await snapshot.index.byIdentity.get(
          `assistant:${invocation.runId}:${invocation.turnId}:${String(invocation.requestAttempt)}:${status}`
        ))
      )))
      .find((entry) => entry !== undefined);
    if (!assistant) throw new Error('Context operation has an unresolved assistant source.');
    return [
      metadataSource(cut.sessionId, assistant),
      ...await Promise.all(identities.map(async (identity) => {
        const metadata = (await snapshot.index.byIdentity.get(identity));
        if (!metadata) throw new Error('Context operation has an unresolved tool exchange.');
        return metadataSource(cut.sessionId, metadata);
      }))
    ];
  }

  private async snapshot(cut: HistorySourceCut): Promise<SessionSourceSnapshot> {
    cut = historyCutSchema.parse(cut);
    const current = await this.options.repository.sourceSnapshot(this.options.session);
    if (
      cut.sessionId !== this.options.session.id ||
      cut.sourceRevision > current.sourceRevision ||
      (cut.throughEntryId !== null && !(await current.index.byId.has(cut.throughEntryId)))
    )
      throw new Error('History cut is outside the authorized branch or incompatible.');
    const snapshot =
      cut.throughEntryId === current.boundary.leafId
        ? current
        : await this.options.repository.sourceSnapshot(this.options.session, cut.throughEntryId);
    if (cut.branchId !== snapshot.branchId)
      throw new Error('History cut does not identify the branch at its captured boundary.');
    const runs = snapshot.index.runs;
    const seen = new Set<string>();
    for (const head of cut.ledgerHeads ?? []) {
      if (
        !(await runs.has(head.runId)) ||
        seen.has(head.runId) ||
        (head.sequence < 0 ? head.hash !== undefined : head.hash === undefined)
      )
        throw new Error('History cut has an invalid or unauthorized run boundary.');
      seen.add(head.runId);
      const inherited = (await current.inheritedHeads).get(head.runId);
      if (
        inherited &&
        (head.sequence > inherited.sequence ||
          (head.sequence === inherited.sequence && head.hash !== inherited.hash))
      )
        throw new Error('History cut exceeds the inherited fork boundary.');
    }
    return snapshot;
  }

  private async head(
    runId: string,
    cut: HistorySourceCut,
    snapshot: SessionSourceSnapshot
  ): Promise<HistoryLedgerHead> {
    const explicit =
      cut.ledgerHeads?.find((head) => head.runId === runId) ?? (await snapshot.inheritedHeads).get(runId);
    if (explicit) return explicit;
    const confirmed = await snapshot.confirmedHead(runId);
    if (confirmed) return confirmed;
    if ((await snapshot.finalizedRuns.has(runId)) && this.options.events) {
      const ended = await this.options.events.latestReferenceOfType(runId, 'run.ended', { metadataOnly: true });
      if (ended) return { runId, sequence: ended.sequence, hash: ended.hash };
    }
    throw new Error('History cut is missing its run boundary.');
  }

  async selectedContext(cut?: HistorySourceCut): Promise<ContextWindowRecord | undefined> {
    cut ??= await this.capture();
    const snapshot = await this.snapshot(cut);
    const metadata = await snapshot.latestContext;
    if (!metadata) return undefined;
    const entry = await this.sessionEntry(metadata, snapshot, MAX_SOURCE_BYTES);
    return entry.type === 'context_transition' ? entry.window : undefined;
  }

  /** Original conversation order is branch position, then sequence within that run. */
  orderSources(
    sources: readonly HistorySourceRef[],
    cut: HistorySourceCut
  ): Promise<readonly HistorySourceRef[]> {
    return this.order(sources, (source) => source, cut);
  }

  orderEntries(
    entries: readonly SessionBranchEntry[],
    cut: HistorySourceCut
  ): Promise<readonly SessionBranchEntry[]> {
    return this.order(entries, (entry) => sourceRef(cut.sessionId, entry), cut);
  }

  private async order<T>(
    values: readonly T[],
    sourceOf: (value: T) => HistorySourceRef,
    cut: HistorySourceCut
  ): Promise<readonly T[]> {
    const snapshot = await this.snapshot(cut);
    const index = snapshot.index;
    const heads = new Map(cut.ledgerHeads?.map((head) => [head.runId, head]));
    const unique = new Map<
      string,
      { source: HistorySourceRef; value: T; position: number; sequence: number }
    >();
    for (const value of values) {
      const source = sourceOf(value);
      if (source.sessionId !== cut.sessionId)
        throw new Error('Selected source belongs to another session.');
      let position: number | undefined;
      let sequence = -1;
      if (source.event && cut.ledgerCoverage === 'authoritative') {
        const head =
          heads.get(source.event.runId) ?? (await this.head(source.event.runId, cut, snapshot));
        heads.set(source.event.runId, head);
        if (
          source.entryId !== `event:${source.event.eventId}` ||
          source.sha256 !== source.event.hash ||
          source.event.sequence > head.sequence
        )
          throw new Error('Selected event is outside its authorized history boundary.');
        position = (await index.inputs.get(source.event.runId));
        sequence = source.event.sequence;
      } else {
        const metadata = (await index.bySource.get(source.entryId));
        if (metadata && sameHistorySource(metadataSource(cut.sessionId, metadata), source))
          position = (await index.positions.get(metadata.entryId));
      }
      if (position === undefined)
        throw new Error('Selected source is outside the authorized branch.');
      const previous = unique.get(source.entryId);
      if (previous && !sameHistorySource(previous.source, source))
        throw new Error('Selected source identities conflict.');
      unique.set(source.entryId, { source, value, position, sequence });
    }
    return Object.freeze(
      [...unique.values()]
        .sort((a, b) => a.position - b.position || a.sequence - b.sequence)
        .map(({ value }) => value)
    );
  }

  async resolve(
    source: HistorySourceRef,
    cut?: HistorySourceCut,
    maxSourceBytes = MAX_SOURCE_BYTES
  ) {
    return (await this.resolveWithUsage(source, cut, maxSourceBytes))?.entry;
  }

  private async resolveWithUsage(
    source: HistorySourceRef,
    cut?: HistorySourceCut,
    maxSourceBytes = MAX_SOURCE_BYTES,
    maxRecords = Number.POSITIVE_INFINITY,
    enrich = true,
    captured?: SessionSourceSnapshot
  ): Promise<
    { entry: SessionBranchEntry | undefined; bytes: number; scanned: number } | undefined
  > {
    source = sourceSchema.parse(source);
    bound(maxSourceBytes, MAX_SOURCE_BYTES, MAX_SOURCE_BYTES, 'maxSourceBytes');
    if (source.sessionId !== this.options.session.id) return undefined;
    cut ??= await this.capture();
    const snapshot = captured ?? await this.snapshot(cut);
    if (source.event && this.options.events && cut.ledgerCoverage === 'authoritative') {
      if (source.entryId !== `event:${source.event.eventId}` || source.sha256 !== source.event.hash)
        throw new Error('History source identity mismatch.');
      if (!(await snapshot.index.runs.has(source.event.runId))) return undefined;
      const head = await this.head(source.event.runId, cut, snapshot);
      if (source.event.sequence > head.sequence) return undefined;
      const page = await this.options.events.readRange(source.event.runId, {
        afterSequence: source.event.sequence - 1,
        through: head,
        limit: 1,
        maxBytes: maxSourceBytes
      });
      if (page.oversized) throw new HistorySourceTooLargeError(source, page.oversized.bytes);
      const record = page.records[0];
      if (record?.eventId !== source.event.eventId || record.hash !== source.event.hash)
        throw new Error('History source identity mismatch.');
      const raw = !enrich ? publicEventEntry(record, null, new Map()) : undefined;
      if (!enrich) {
        const original = raw
          ? await this.originalEntry(raw, maxSourceBytes - page.bytes)
          : undefined;
        return {
          entry: original?.entry,
          bytes: page.bytes + (original?.bytes ?? 0),
          scanned: page.scanned
        };
      }
      const resolved = await this.eventEntry(
        record,
        snapshot,
        head,
        maxSourceBytes - page.bytes,
        true,
        maxRecords - page.scanned
      );
      return {
        entry: resolved.entry,
        bytes: page.bytes + resolved.bytes,
        scanned: page.scanned + resolved.scanned
      };
    }
    const metadata = (await snapshot.index.bySource.get(source.entryId));
    if (!metadata) return undefined;
    const entry = await this.sessionEntry(metadata, snapshot, maxSourceBytes);
    if (!sameHistorySource(sourceRef(source.sessionId, entry), source))
      throw new Error('History source identity mismatch.');
    const original = await this.originalEntry(entry, maxSourceBytes - metadata.bytes);
    return { entry: original.entry, bytes: metadata.bytes + original.bytes, scanned: 1 };
  }

  private async sessionEntry(
    metadata: SessionSourceMetadata,
    snapshot: SessionSourceSnapshot,
    maxBytes: number
  ): Promise<SessionBranchEntry> {
    const source = metadataSource(this.options.session.id, metadata);
    if (metadata.bytes > maxBytes) throw new HistorySourceTooLargeError(source, metadata.bytes);
    const entry = await this.options.repository.readBranchEntry(
      this.options.session,
      snapshot.boundary,
      metadata.entryId
    );
    if (hashJson(entry) !== metadata.sha256)
      throw new Error('Session history source identity changed.');
    return entry;
  }

  private async originalEntry(
    entry: SessionBranchEntry,
    maxBytes: number
  ): Promise<{ entry: SessionBranchEntry; bytes: number }> {
    if (entry.type !== 'observation' || !entry.originalArtifact) return { entry, bytes: 0 };
    if (entry.originalArtifact.size > maxBytes)
      throw new HistorySourceTooLargeError(
        sourceRef(this.options.session.id, entry),
        entry.originalArtifact.size
      );
    const observation = await resolveToolObservation(
      {
        storage: 'artifact',
        kind: entry.kind,
        summary: entry.summary,
        artifact: entry.originalArtifact
      },
      this.options.artifacts
    );
    const hydrated = Object.freeze({
      ...entry,
      output: observation.kind === 'result' ? observation.output : encodeToolFailureOutput(observation.output)
    });
    // Hydration is a representation of the persisted original, never a new source identity.
    sourceReferences.set(hydrated, new Map([
      [this.options.session.id, sourceRef(this.options.session.id, entry)]
    ]));
    return { entry: hydrated, bytes: entry.originalArtifact.size };
  }

  private async eventEntry(
    record: EventEnvelope<AgentEvent>,
    snapshot: SessionSourceSnapshot,
    head: HistoryLedgerHead,
    maxBytes: number,
    original = false,
    maxRecords = Number.POSITIVE_INFINITY
  ): Promise<{ entry?: SessionBranchEntry; bytes: number; scanned: number }> {
    let entry = publicEventEntry(record, null, new Map());
    if (!entry) return { bytes: 0, scanned: 0 };
    let bytes = 0,
      scanned = 0;
    const mirror =
      (await snapshot.index.bySource.get(`event:${record.eventId}`)) ??
      (await snapshot.index.byIdentity.get(entryIdentity(entry)));
    if (mirror) {
      if (scanned >= maxRecords)
        throw new HistorySourceWorkLimitError(
          sourceRef(this.options.session.id, entry),
          bytes,
          scanned
        );
      entry = mergeMirror(entry, await this.sessionEntry(mirror, snapshot, maxBytes));
      bytes += mirror.bytes;
      scanned++;
    }
    if (
      record.event.type === 'tool.ended' &&
      record.idempotencyKey?.endsWith(':ended') &&
      this.options.events
    ) {
      const reference = await this.options.events.referenceByKey(
        record.runId,
        `${record.idempotencyKey.slice(0, -6)}:observation`
      );
      if (reference && reference.sequence <= head.sequence) {
        if (scanned >= maxRecords)
          throw new HistorySourceWorkLimitError(
            sourceRef(this.options.session.id, entry),
            bytes,
            scanned
          );
        const page = await this.options.events.readRange(record.runId, {
          afterSequence: reference.sequence - 1,
          through: head,
          limit: 1,
          maxBytes: Math.max(1, maxBytes - bytes)
        });
        if (page.oversized)
          throw new HistorySourceTooLargeError(
            sourceRef(this.options.session.id, entry),
            page.oversized.bytes + bytes
          );
        const content = page.records[0];
        if (content?.event.type !== 'observation.record.created' || content.hash !== reference.hash)
          throw new Error('Observation content reference has an incompatible source.');
        const representation = publicEventEntry(content, null, new Map());
        if (!representation || entryIdentity(representation) !== entryIdentity(entry))
          throw new Error('Observation content belongs to a different invocation.');
        if (entry.type === 'observation')
          entry = Object.freeze({
            ...entry,
            ...(content.event.modelContent ? { modelContent: content.event.modelContent } : {}),
            ...(content.event.modelContentRef
              ? { modelContentRef: content.event.modelContentRef }
              : {})
          });
        bytes += page.bytes;
        scanned += page.scanned;
      }
    }
    if (original) {
      const hydrated = await this.originalEntry(entry, maxBytes - bytes);
      entry = hydrated.entry;
      bytes += hydrated.bytes;
    }
    return { entry, bytes, scanned };
  }

  /** Bounded original-source enumeration, suitable for selected-context tail admission. */
  page(request: HistoryEntryPageRequest = {}): Promise<HistoryEntryPage> {
    return this.entryPage(request);
  }

  private async entryPage(request: HistoryEntryPageRequest, captured?: SessionSourceSnapshot): Promise<HistoryEntryPage> {
    const limit = bound(request.limit, 100, MAX_SCANNED, 'limit');
    const maxBytes = bound(request.maxBytes, MAX_SOURCE_BYTES, MAX_SOURCE_BYTES, 'maxBytes');
    const fingerprint = hashJson({
      after: request.after ?? null,
      filter: request.filter ?? null
    });
    const cursor = request.cursor ? decodeEntryCursor(request.cursor) : undefined;
    if (cursor && cursor.fingerprint !== fingerprint)
      throw new Error('History source cursor filter mismatch.');
    if (cursor && request.cut && hashJson(cursor.cut) !== hashJson(request.cut))
      throw new Error('History source cursor cut mismatch.');
    const cut = cursor?.cut ?? request.cut ?? (await this.capture());
    const snapshot = captured ?? await this.snapshot(cut);
    if (request.after && !(await this.extendsCut(request.after, cut)))
      throw new Error('History page boundary is not an ancestor of its cut.');
    const afterSnapshot = request.after ? await this.snapshot(request.after) : undefined;
    const oldIds = afterSnapshot
      ? afterSnapshot.index.byId
      : new Map<string, SessionSourceMetadata>();
    let at =
      cursor?.at ??
      (request.filter?.runId ? ((await snapshot.index.inputs.get(request.filter.runId)) ?? 0) : 0);
    if (!cursor && request.after) {
      const positions = snapshot.index;
      const boundary =
        request.after.throughEntryId === null
          ? -1
          : (await positions.positions.get(request.after.throughEntryId));
      if (boundary !== undefined) {
        at = boundary + 1;
        // Previously open runs can acquire new records behind the session-entry boundary.
        for (const head of request.after.ledgerHeads ?? []) {
          const input = (await positions.inputs.get(head.runId));
          if (input !== undefined) at = Math.min(at, input);
        }
      }
    }

    const end = request.filter?.runId
      ? ((await snapshot.index.runs.lastPosition(request.filter.runId)) ?? -1) + 1
      : snapshot.entries.length;
    let sequence = cursor?.sequence;
    if (at > snapshot.entries.length)
      throw new Error('History source cursor is beyond its boundary.');
    let scanned = 0,
      bytes = 0;
    const entries: SessionBranchEntry[] = [];
    const unread: NonNullable<HistoryEntryPage['unread']>[number][] = [];
    while (at < end && scanned < limit && bytes < maxBytes) {
      const metadata = (await snapshot.entries.at(at));
      if (!metadata) break;
      const runId = metadata.runId;
      if (sequence !== undefined && metadata.type !== 'input')
        throw new Error('History source cursor has an invalid run position.');
      if (request.filter?.runId && runId !== request.filter.runId) {
        at++;
        sequence = undefined;
        scanned++;
        continue;
      }
      const authoritative = this.options.events && cut.ledgerCoverage === 'authoritative' && runId;
      if (authoritative && metadata.type === 'input' && sequence !== undefined) {
        const head = await this.head(runId, cut, snapshot);
        const afterHead =
          request.after && afterSnapshot && (await afterSnapshot.index.runs.has(runId))
            ? await this.head(runId, request.after, afterSnapshot)
            : undefined;
        sequence = Math.max(sequence, afterHead?.sequence ?? -1);
        if (sequence >= head.sequence) {
          at++;
          sequence = undefined;
          continue;
        }
        const page = await this.options.events.readRange(runId, {
          afterSequence: sequence,
          through: head,
          limit: 1,
          maxBytes: maxBytes - bytes,
          types: eventTypes(request.filter),
          ...(request.filter?.toolName ? { metadata: { toolName: request.filter.toolName } } : {}),
          ...(request.filter?.afterTime ? { afterTime: request.filter.afterTime } : {}),
          ...(request.filter?.beforeTime ? { beforeTime: request.filter.beforeTime } : {})
        });
        scanned += page.scanned;
        bytes += page.bytes;
        let pausedSequence: number | undefined;
        for (const record of page.records) {
          try {
            const raw = publicEventEntry(record, null, new Map());
            if (!raw || !matchesMetadata(raw, request.filter)) continue;
            const original =
              request.enrich === false && request.originals
                ? await this.originalEntry(raw, maxBytes - bytes)
                : undefined;
            const joined =
              request.enrich === false
                ? { entry: original?.entry ?? raw, bytes: original?.bytes ?? 0, scanned: 0 }
                : await this.eventEntry(
                    record,
                    snapshot,
                    head,
                    maxBytes - bytes,
                    request.originals === true,
                    limit - scanned
                  );
            bytes += joined.bytes;
            scanned += joined.scanned;
            if (joined.entry && matches(joined.entry, request.filter)) entries.push(joined.entry);
          } catch (error) {
            if (error instanceof HistorySourceWorkLimitError) {
              bytes += error.bytes;
              scanned += error.scanned;
              if (entries.length) pausedSequence = record.sequence - 1;
              else
                unread.push({
                  source: error.source,
                  reason: 'source_record_limit',
                  bytes: error.bytes,
                  records: limit + 1
                });
              break;
            }
            if (!(error instanceof HistorySourceTooLargeError)) throw error;
            unread.push({
              source: error.source,
              reason: 'source_byte_limit',
              bytes: error.bytes
            });
          }
        }
        sequence = pausedSequence ?? page.nextSequence;
        if (page.oversized) {
          const source = {
            sessionId: cut.sessionId,
            entryId: `event:${page.oversized.reference.eventId}`,
            sha256: page.oversized.reference.hash,
            event: page.oversized.reference
          };
          unread.push({ source, reason: 'source_byte_limit', bytes: page.oversized.bytes });
          sequence = page.oversized.reference.sequence;
          scanned++;
        }
        if (page.complete && pausedSequence === undefined) {
          at++;
          sequence = undefined;
        }
        if (pausedSequence !== undefined || unread.length || (page.scanned === 0 && !page.complete))
          break;
        continue;
      }
      // A run's ledger replaces its completed mirrors; session-only repositories retain their originals.
      if (authoritative && metadata.type !== 'input') {
        const head = await this.head(runId, cut, snapshot);
        if (head.sequence >= 0) {
          at++;
          scanned++;
          continue;
        }
      }
      if (metadata.type === 'input' && authoritative) sequence = -1;
      else at++;
      scanned++;
      if (await oldIds.has(metadata.entryId) || !matchesHistoryMetadata(metadata, request.filter)) continue;
      if (metadata.bytes > maxBytes - bytes) {
        if (metadata.bytes > maxBytes)
          unread.push({
            source: metadataSource(cut.sessionId, metadata),
            reason: 'source_byte_limit',
            bytes: metadata.bytes
          });
        else {
          if (metadata.type === 'input' && authoritative) sequence = undefined;
          else at--;
          scanned--;
        }
        break;
      }
      let entry = await this.sessionEntry(metadata, snapshot, maxBytes - bytes);
      bytes += metadata.bytes;
      if (request.originals) {
        try {
          const original = await this.originalEntry(entry, maxBytes - bytes);
          entry = original.entry;
          bytes += original.bytes;
        } catch (error) {
          if (!(error instanceof HistorySourceTooLargeError)) throw error;
          unread.push({ source: error.source, reason: 'source_byte_limit', bytes: error.bytes });
          break;
        }
      }
      if (matches(entry, request.filter)) entries.push(entry);
    }
    const complete = at >= end;
    return Object.freeze({
      entries: Object.freeze(entries),
      cut,
      scanned,
      bytes,
      coverage: complete && unread.length === 0 ? 'complete' : 'partial',
      ...(unread.length ? { unread: Object.freeze(unread) } : {}),
      ...(!complete
        ? {
            cursor: encodeEntryCursor({
              cut,
              at,
              ...(sequence === undefined ? {} : { sequence }),
              fingerprint
            })
          }
        : {})
    });
  }

  entriesAfter(
    after: HistorySourceCut,
    through?: HistorySourceCut,
    bounds: Omit<HistoryEntryPageRequest, 'cut' | 'after'> = {}
  ): Promise<HistoryEntryPage> {
    return this.page({ ...bounds, after, ...(through ? { cut: through } : {}) });
  }

  /** Enumerate routing facts without reading any original source body. */
  async metadataPage(request: HistoryMetadataPageRequest = {}): Promise<HistoryMetadataPage> {
    const limit = bound(request.limit, 100, MAX_SCANNED, 'limit');
    const maxBytes = bound(request.maxBytes, 64 * 1024, MAX_SOURCE_BYTES, 'maxBytes');
    const fingerprint = hashJson({ metadata: true, after: request.after ?? null, filter: request.filter ?? null });
    if (request.cursor && !request.cut) throw new Error('A history metadata cursor requires its captured cut.');
    const cut = request.cut ?? await this.capture();
    const cursor = request.cursor ? decodeMetadataCursor(request.cursor, cut) : undefined;
    if (cursor && cursor.fingerprint !== fingerprint) throw new Error('History metadata cursor filter mismatch.');
    const snapshot = await this.snapshot(cut);
    if (request.after && !(await this.extendsCut(request.after, cut))) throw new Error('History metadata boundary is not an ancestor of its cut.');
    const previous = request.after ? await this.snapshot(request.after) : undefined;
    let at = cursor?.at ?? (request.filter?.runId ? (await snapshot.index.inputs.get(request.filter.runId)) ?? 0 : 0);
    if (!cursor && request.after) {
      at = request.after.throughEntryId === null ? 0 : ((await snapshot.index.positions.get(request.after.throughEntryId)) ?? -1) + 1;
      for (const head of request.after.ledgerHeads ?? []) at = Math.min(at, (await snapshot.index.inputs.get(head.runId)) ?? at);
    }
    const end = request.filter?.runId ? ((await snapshot.index.runs.lastPosition(request.filter.runId)) ?? -1) + 1 : snapshot.entries.length;
    if (at > snapshot.entries.length) throw new Error('History metadata cursor is beyond its boundary.');
    let sequence = cursor?.sequence;
    let scanned = 0, bytes = 0;
    const items: HistorySourceMetadata[] = [];
    const append = (item: HistorySourceMetadata) => {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > maxBytes) return false;
      items.push(item); bytes += size; return true;
    };
    while (at < end && scanned < limit) {
      const metadata = (await snapshot.entries.at(at));
      if (!metadata) break;
      const runId = metadata.runId;
      if (sequence !== undefined && metadata.type !== 'input') throw new Error('History metadata cursor has an invalid run position.');
      if (request.filter?.runId && request.filter.runId !== runId) { at++; scanned++; sequence = undefined; continue; }
      const events = this.options.events;
      const authoritative = events && cut.ledgerCoverage === 'authoritative' && runId;
      if (authoritative && metadata.type === 'input' && sequence !== undefined) {
        const head = await this.head(runId, cut, snapshot);
        if (request.after && previous && (await previous.index.runs.has(runId))) sequence = Math.max(sequence, (await this.head(runId, request.after, previous)).sequence);
        if (sequence >= head.sequence) { at++; sequence = undefined; continue; }
        const page = await events.readMetadataRange(runId, {
          afterSequence: sequence, through: head, limit: 1, maxBytes: MAX_SOURCE_BYTES,
          types: eventTypes(request.filter),
          ...(request.filter?.toolName ? { metadata: { toolName: request.filter.toolName } } : {}),
          ...(request.filter?.afterTime ? { afterTime: request.filter.afterTime } : {}),
          ...(request.filter?.beforeTime ? { beforeTime: request.filter.beforeTime } : {})
        });
        const record = page.records[0];
        const item = record ? await this.eventMetadata(record, snapshot) : undefined;
        if (item && !append(item)) break;
        scanned += page.scanned;
        sequence = page.nextSequence;
        if (page.complete) { at++; sequence = undefined; }
        if (!page.scanned && !page.complete) throw new Error('History metadata record exceeds its access bound.');
        continue;
      }
      if (authoritative && metadata.type !== 'input' && (await this.head(runId, cut, snapshot)).sequence >= 0) { at++; scanned++; continue; }
      if (!(await previous?.index.byId.has(metadata.entryId)) && matchesHistoryMetadata(metadata, request.filter)) {
        if (!append({ ...metadata.context, source: metadataSource(cut.sessionId, metadata), sourceBytes: metadata.bytes })) break;
      }
      scanned++;
      if (authoritative && metadata.type === 'input') sequence = -1;
      else at++;
    }
    if (scanned === 0 && at < end) throw new ToolInputError('History metadata cannot fit maxBytes; increase maxBytes.');
    return {
      items, cut, scanned, bytes, coverage: at >= end ? 'complete' : 'partial',
      ...(at < end ? { cursor: encodeMetadataCursor({ cut, at, ...(sequence === undefined ? {} : { sequence }), fingerprint }) } : {})
    };
  }

  private async eventMetadata(record: EventSourceMetadata, snapshot: SessionSourceSnapshot): Promise<HistorySourceMetadata | undefined> {
    const facts = record.metadata;
    const type = facts.sourceType;
    if (type !== 'assistant' && type !== 'tool_call' && type !== 'observation' && type !== 'steering') return undefined;
    const runId = record.reference.runId;
    const identity = facts.identity?.replace(':', `:${runId}:`);
    const mirror = (await snapshot.index.bySource.get(`event:${record.reference.eventId}`)) ?? (identity ? (await snapshot.index.byIdentity.get(identity)) : undefined);
    return {
      ...mirror?.context,
      type, runId,
      ...(facts.contextRecovery === 'true' ? { prefixBound: false } : facts.prefixBound === 'true' ? { prefixBound: true } : {}),
      ...(facts.contextRecovery === 'true' ? { contextRecovery: true as const } : {}),
      description: facts.description ?? type,
      source: { sessionId: this.options.session.id, entryId: `event:${record.reference.eventId}`, sha256: record.reference.hash, event: record.reference },
      sourceBytes: record.bytes,
      ...(facts.exchangeId ? { exchangeId: `${runId}:${facts.exchangeId}` } : {}),
      ...(facts.callIndex !== undefined ? { callIndex: Number(facts.callIndex) } : {}),
      ...(facts.toolBatchId ? { toolBatchId: facts.toolBatchId } : {}),
      ...(facts.expectedCalls !== undefined ? { expectedCalls: Math.max(Number(facts.expectedCalls), mirror?.context.expectedCalls ?? 0) } : {})
    };
  }

  async metadata(source: HistorySourceRef, cut: HistorySourceCut): Promise<HistorySourceMetadata | undefined> {
    source = sourceSchema.parse(source);
    if (source.sessionId !== this.options.session.id) return undefined;
    const snapshot = await this.snapshot(cut);
    if (source.event && this.options.events && cut.ledgerCoverage === 'authoritative') {
      if (source.entryId !== `event:${source.event.eventId}` || source.sha256 !== source.event.hash) throw new Error('History source identity mismatch.');
      if (!(await snapshot.index.runs.has(source.event.runId))) return undefined;
      const head = await this.head(source.event.runId, cut, snapshot);
      if (source.event.sequence > head.sequence) return undefined;
      const page = await this.options.events.readMetadataRange(source.event.runId, { afterSequence: source.event.sequence - 1, through: head, limit: 1 });
      const record = page.records[0];
      if (record?.reference.eventId !== source.event.eventId || record.reference.hash !== source.sha256) throw new Error('History source identity mismatch.');
      return this.eventMetadata(record, snapshot);
    }
    const metadata = (await snapshot.index.bySource.get(source.entryId));
    if (!metadata) return undefined;
    if (!sameHistorySource(metadataSource(source.sessionId, metadata), source)) throw new Error('History source identity mismatch.');
    return { ...metadata.context, source: metadataSource(source.sessionId, metadata), sourceBytes: metadata.bytes };
  }

  /** One bounded indexed exchange inventory, independent of the run's other sources. */
  async exchangeMetadata(source: HistorySourceRef, cut: HistorySourceCut) {
    const selected = await this.metadata(source, cut);
    if (!selected) throw new Error('History source is unavailable on this branch.');
    if (!selected.exchangeId) return { items: [selected], coverage: 'complete' as const };
    const snapshot = await this.snapshot(cut);
    const items: HistorySourceMetadata[] = [];
    if (selected.runId && this.options.events && cut.ledgerCoverage === 'authoritative' &&
        (await this.head(selected.runId, cut, snapshot)).sequence >= 0) {
      const page = await this.options.events.readMetadataRange(selected.runId, {
        through: await this.head(selected.runId, cut, snapshot), limit: MAX_SCANNED, maxBytes: MAX_SOURCE_BYTES,
        metadata: { exchangeId: selected.exchangeId.slice(selected.runId.length + 1) }, types: eventTypes()
      });
      for (const record of page.records) {
        const item = await this.eventMetadata(record, snapshot);
        if (item) items.push(item);
      }
      return { items, coverage: page.complete ? 'complete' as const : 'partial' as const };
    }
    let bytes = 0;
    for await (const metadata of snapshot.index.exchange(selected.exchangeId)) {
      const item = { ...metadata.context, source: metadataSource(cut.sessionId, metadata), sourceBytes: metadata.bytes };
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (items.length >= MAX_SCANNED || bytes > MAX_SOURCE_BYTES) return { items, coverage: 'partial' as const };
      items.push(item);
    }
    return { items, coverage: 'complete' as const };
  }

  async exchangeSources(source: HistorySourceRef, cut: HistorySourceCut): Promise<readonly HistorySourceMetadata[]> {
    const page = await this.exchangeMetadata(source, cut);
    if (page.coverage !== 'complete') throw new Error('Complete history exchange exceeds the source access allowance.');
    return page.items;
  }

  async exchange(source: HistorySourceRef, cut: HistorySourceCut): Promise<readonly SessionBranchEntry[]> {
    const members = await this.exchangeSources(source, cut);
    const entries: SessionBranchEntry[] = [];
    let bytes = 0;
    for (const member of members) {
      const resolved = await this.resolveWithUsage(member.source, cut, Math.max(1, MAX_SOURCE_BYTES - bytes));
      if (!resolved?.entry) throw new Error('History exchange source is unavailable.');
      bytes += resolved.bytes;
      entries.push(resolved.entry);
    }
    return entries;
  }

  async read(request: HistoryReadRequest): Promise<HistoryReadResult> {
    const maxBytes = bound(request.maxBytes, 16 * 1024, MAX_BYTES, 'maxBytes');
    const count = bound(request.neighbors, 0, 32, 'neighbors', true);
    const cut = request.cut ?? (await this.capture());
    if (request.source.sessionId !== this.options.session.id)
      return unavailable(request.source, 'outside_scope');
    let entry: SessionBranchEntry | undefined;
    try {
      entry = await this.resolve(request.source, cut, request.maxSourceBytes);
    } catch (error) {
      if (error instanceof HistorySourceTooLargeError)
        return {
          status: 'unavailable',
          source: request.source,
          reason: 'source_too_large',
          bytes: error.bytes
        };
      if (error instanceof Error && error.message === 'History source identity mismatch.')
        return unavailable(request.source, 'identity_mismatch');
      throw error;
    }
    if (!entry) return unavailable(request.source, 'missing');
    const stateRef =
      entry.type === 'context_transition'
          ? entry.workingState?.contentRef
          : undefined;
    const range = stateRef
      ? await this.workingStateRange(stateRef, request.offset ?? 0, maxBytes)
      : textRange(publicText(entry), request.offset ?? 0, maxBytes);
    const neighbors: HistoryItem[] = [];
    let remaining = maxBytes - Buffer.byteLength(range.text);
    if (count && remaining > 0) {
      const snapshot = await this.snapshot(cut);
      if (entry.source && this.options.events) {
        const head = await this.head(entry.source.runId, cut, snapshot);
        const page = await this.options.events.readRange(entry.source.runId, {
          afterSequence: Math.max(-1, entry.source.sequence - count - 1),
          through: head,
          limit: count * 2 + 1,
          maxBytes: request.maxSourceBytes ?? MAX_SOURCE_BYTES,
          types: eventTypes()
        });
        for (const record of page.records) {
          if (record.eventId === entry.source.eventId || remaining <= 0) continue;
          const neighbor = publicEventEntry(record, null, new Map());
          if (!neighbor) continue;
          const item = historyItem(cut.sessionId, neighbor, remaining);
          neighbors.push(item);
          remaining -= Buffer.byteLength(item.text);
        }
      } else {
        const at = (await snapshot.index.positions.get(entry.id)) ?? -1;
        for (
          let i = Math.max(0, at - count);
          i <= Math.min(snapshot.entries.length - 1, at + count) && remaining > 0;
          i++
        ) {
          if (i === at) continue;
          const metadata = (await snapshot.entries.at(i));
          if (!metadata) break;
          if (metadata.bytes > remaining) break;
          const neighbor = await this.sessionEntry(metadata, snapshot, remaining);
          const item = historyItem(cut.sessionId, neighbor, remaining);
          neighbors.push(item);
          remaining -= Buffer.byteLength(item.text);
        }
      }
    }
    return Object.freeze({
      status: 'available',
      item: Object.freeze({
        ...historyItem(cut.sessionId, entry, 0),
        text: range.text,
        truncated: range.offset > 0 || range.nextOffset < range.totalBytes
      }),
      offset: range.offset,
      nextOffset: range.nextOffset,
      totalBytes: range.totalBytes,
      neighbors: Object.freeze(neighbors),
      cut
    });
  }

  private async workingStateRange(
    ref: import('@agent-core/persistence').ProtectedArtifactRef,
    offset: number,
    length: number
  ) {
    if (!this.options.artifacts)
      throw new Error('Working-state history requires authorized artifact access.');
    const range = await this.options.artifacts.readVerifiedRange(ref, { offset, length });
    const bounded = textRange(
      new TextDecoder('utf-8', { fatal: true }).decode(range.bytes),
      offset - range.offset,
      length
    );
    return {
      text: bounded.text,
      offset: range.offset + bounded.offset,
      nextOffset: range.offset + bounded.nextOffset,
      totalBytes: range.fullSize
    };
  }

  async search(request: HistorySearchRequest = {}): Promise<HistorySearchResult> {
    request.signal?.throwIfAborted();
    const work = { postings: 0, candidates: 0,
      maxPostings: bound(request.maxPostings, 1000, 10000, 'maxPostings'),
      maxCandidates: bound(request.maxCandidates, 1000, 10000, 'maxCandidates') };
    const maxIndexEntries = bound(request.maxIndexEntries, 1000, 1000, 'maxIndexEntries');
    const maxIndexBytes = bound(request.maxIndexBytes, MAX_SOURCE_BYTES, MAX_SOURCE_BYTES, 'maxIndexBytes');
    let indexed = 0, indexBytes = 0;
    let exhausted = false;
    const limit = bound(request.limit, 20, MAX_RESULTS, 'limit');
    const maxBytes = bound(request.maxBytes, 32 * 1024, MAX_BYTES, 'maxBytes');
    const maxScanned = bound(request.maxScanned, MAX_SCANNED, MAX_SCANNED, 'maxScanned');
    const maxScannedBytes = bound(
      request.maxScannedBytes,
      MAX_SOURCE_BYTES,
      MAX_SOURCE_BYTES,
      'maxScannedBytes'
    );
    if ((request.query?.length ?? 0) > 4096)
      throw new Error('History query exceeds 4096 characters.');
    const filter = hashJson(request.filter ?? {});
    const queryFingerprint = hashJson({ query: request.query ?? '', filter: request.filter ?? {} });
    const cursor = request.cursor ? decodeCursor(request.cursor) : undefined;
    if (cursor && cursor.queryFingerprint !== queryFingerprint)
      throw new Error('History cursor query mismatch.');
    if (cursor && request.cut && hashJson(cursor.cut) !== hashJson(request.cut))
      throw new Error('History cursor source cut mismatch.');
    const cut = cursor?.cut ?? request.cut ?? (await this.capture());
    const snapshot = await this.snapshot(cut);
    let state = this.searchIndex;
    const sameCut = state && hashJson(state.cut) === hashJson(cut);
    if (
      state?.filter !== filter ||
      (!cursor && (state.partialStart || state.unread.length > 0)) ||
      (!sameCut && !(await this.extendsCut(state.cut, cut)))
    ) {
      state = {
        filter,
        cut,
        index: new HistorySearchIndex(),
        complete: false,
        unread: [],
        partialStart: cursor?.position !== undefined,
        ...(cursor?.position ? { next: cursor.position } : {})
      };
      this.searchIndex = state;
    } else if (!sameCut) {
      let at =
        state.cut.throughEntryId === null
          ? 0
          : ((await snapshot.index.positions.get(state.cut.throughEntryId)) ?? -1) + 1;
      for (const head of state.cut.ledgerHeads ?? [])
        at = Math.min(at, (await snapshot.index.inputs.get(head.runId)) ?? at);
      const previous = state.next ? decodeEntryCursor(state.next) : undefined;
      if (previous) at = Math.min(at, previous.at);
      state.invalidAt = Math.min(state.invalidAt ?? at, at);
      state.cut = cut;
      state.next = encodeEntryCursor({
        cut,
        at,
        fingerprint: hashJson({ after: null, filter: request.filter ?? null })
      });
      state.complete = false;
    }
    let scanned = 0,
      scannedBytes = 0;
    const loaded = new Map<string, { entry: SessionBranchEntry; text: string }>();
    const unread: HistoryUnreadSource[] = cursor ? [] : [...state.unread];
    const materialFor = async (candidate: IndexedHistorySource) => {
      let material = loaded.get(candidate.source.entryId);
      if (!material) {
        if (scanned >= maxScanned || scannedBytes >= maxScannedBytes) return undefined;
        let resolved;
        try {
          resolved = await this.resolveWithUsage(
            candidate.source,
            cut,
            maxScannedBytes - scannedBytes,
            maxScanned - scanned,
            false,
            snapshot
          );
        } catch (error) {
          if (!(error instanceof HistorySourceTooLargeError)) throw error;
          unread.push({
            source: candidate.source,
            reason: 'source_byte_limit',
            bytes: error.bytes
          });
          return undefined;
        }
        if (!resolved?.entry)
          throw new Error('Indexed source is unavailable at its authorized boundary.');
        scanned += resolved.scanned;
        scannedBytes += resolved.bytes;
        const entry = resolved.entry;
        const stateRef =
          entry.type === 'context_transition'
              ? entry.workingState?.contentRef
              : undefined;
        if (stateRef && stateRef.size > maxScannedBytes - scannedBytes) {
          unread.push({
            source: candidate.source,
            reason: 'source_byte_limit',
            bytes: stateRef.size
          });
          return undefined;
        }
        const text = stateRef
          ? (await this.workingStateRange(stateRef, 0, Math.max(1, stateRef.size))).text
          : publicText(entry);
        if (stateRef) scannedBytes += stateRef.size;
        material = { entry, text };
        loaded.set(candidate.source.entryId, material);
      }
      return material;
    };
    const populate = async () => {
      request.signal?.throwIfAborted();
      indexed++;
      const page = await this.entryPage({
        cut,
        ...(state.next ? { cursor: state.next } : {}),
        filter: request.filter,
        limit: 1,
        maxBytes: Math.min(maxScannedBytes - scannedBytes, maxIndexBytes - indexBytes),
        enrich: false,
        originals: true
      }, snapshot);
      scanned += page.scanned;
      scannedBytes += page.bytes;
      indexBytes += page.bytes;
      for (const entry of page.entries) {
        const source = sourceRef(cut.sessionId, entry);
        const stateRef =
          entry.type === 'context_transition'
              ? entry.workingState?.contentRef
              : undefined;
        if (stateRef && stateRef.size > Math.min(maxScannedBytes - scannedBytes, maxIndexBytes - indexBytes)) {
          const gap = { source, reason: 'source_byte_limit' as const, bytes: stateRef.size };
          state.unread.push(gap);
          unread.push(gap);
          continue;
        }
        const text = stateRef
          ? (await this.workingStateRange(stateRef, 0, Math.max(1, stateRef.size))).text
          : publicText(entry);
        if (stateRef) { scannedBytes += stateRef.size; indexBytes += stateRef.size; }
        const at = source.event
          ? (await snapshot.index.inputs.get(source.event.runId))
          : (await snapshot.index.positions.get(entry.id));
        if (at === undefined) throw new Error('Indexed history source has no branch position.');
        loaded.set(source.entryId, { entry, text });
        state.index.add(
          {
            source,
            position: { at, sequence: source.event?.sequence ?? -1, entryId: source.entryId }
          },
          text
        );
      }
      const previous = state.next;
      state.next = page.cursor;
      state.complete = page.cursor === undefined;
      if (page.unread?.length) {
        state.unread.push(...page.unread);
        unread.push(...page.unread);
      }
      return !page.unread?.length && (page.entries.length > 0 || state.complete || previous !== page.cursor);
    };
    const items: HistoryItem[] = [];
    let after = cursor?.after;
    let remaining = false;
    let resume = state.next;
    const result = (): HistorySearchResult => ({
      items,
      cut,
      scanned,
      scannedBytes,
      bytes: 0,
      postings: work.postings, candidates: work.candidates, indexed, indexBytes,
      coverage: exhausted && !unread.length ? 'complete' : 'partial',
      ...(unread.length ? { unread } : {}),
      ...(!exhausted
        ? {
            cursor: encodeCursor({
              cut,
              queryFingerprint,
              ...(resume ? { position: resume } : {}),
              ...(after ? { after } : {})
            })
          }
        : {})
    });
    const presentationBytes = () =>
      Buffer.byteLength(serializeToolModelContent(historySearchContent(parseJsonObject(result()))));
    const fit = () => {
      const excess = presentationBytes() - maxBytes;
      if (excess <= 0) return true;
      const last = items.at(-1);
      if (!last || Buffer.byteLength(last.text) < excess) return false;
      const available = Buffer.byteLength(last.text) - excess;
      items[items.length - 1] = Object.freeze({
        ...last,
        text: available < 4 ? '' : textRange(last.text, 0, available).text,
        truncated: true
      });
      return presentationBytes() <= maxBytes;
    };
    for (;;) {
      request.signal?.throwIfAborted();
      if (state.invalidAt !== undefined) {
        const cleared = state.index.truncate(state.invalidAt, maxIndexEntries - indexed, maxIndexBytes - indexBytes);
        indexed += cleared.entries;
        indexBytes += cleared.bytes;
        if (!cleared.complete) {
          // No retained-prefix result has been returned yet. A cache-free continuation must
          // reconstruct that prefix too, rather than start at the invalidated tail frontier.
          remaining = true;
          resume = encodeEntryCursor({ cut, at: after?.at ?? 0,
            ...(after && after.sequence >= 0 ? { sequence: after.sequence } : {}),
            fingerprint: hashJson({ after: null, filter: request.filter ?? null }) });
          break;
        }
        state.invalidAt = undefined;
      }
      const traversal = state.index.traversal(request.query ?? '', after);
      if (traversal.complete) {
        if (state.complete) { exhausted = true; break; }
        if (indexed >= maxIndexEntries || indexBytes >= maxIndexBytes || scanned >= maxScanned || scannedBytes >= maxScannedBytes) break;
        if (!(await populate())) break;
        continue;
      }
      const candidate = traversal.next(work);
      if (!candidate) {
        remaining = true;
        if (after) resume = encodeEntryCursor({ cut, at: after.at,
          ...(after.sequence >= 0 ? { sequence: after.sequence } : {}),
          fingerprint: hashJson({ after: null, filter: request.filter ?? null }) });
        break;
      }
      // On restart this position rereads the unreturned candidate and nothing before it.
      const position = candidate.position;
      resume = encodeEntryCursor({
        cut,
        at: position.at,
        ...(position.sequence >= 0 ? { sequence: position.sequence - 1 } : {}),
        fingerprint: hashJson({ after: null, filter: request.filter ?? null })
      });
      remaining = true;
      if (items.length >= limit) break;
      const material = await materialFor(candidate);
      if (!material) break;
      const { entry, text: fullText } = material;
      const match = request.query ? fullText.indexOf(request.query) : 0;
      if (match < 0) {
        after = position;
        remaining = false;
        continue;
      }
      const excerpt = textRange(
        fullText,
        Buffer.byteLength(fullText.slice(0, Math.max(0, match - 128))),
        16 * 1024
      );
      const priorAfter = after;
      after = position;
      items.push(
        Object.freeze({
          ...historyItem(cut.sessionId, entry, 0),
          text: excerpt.text,
          truncated: excerpt.offset > 0 || excerpt.nextOffset < excerpt.totalBytes
        })
      );
      if (!fit()) {
        if (items.length > 1) {
          items.pop();
          after = priorAfter;
          break;
        }
        throw new ToolInputError(
          'History result byte budget cannot fit source references and coverage.',
          { maxBytes, requiredBytes: presentationBytes() }
        );
      }
      remaining = false;
    }
    if (!remaining) resume = state.next;
    request.signal?.throwIfAborted();
    if (!fit())
      throw new ToolInputError('History result byte budget cannot fit coverage.', {
        maxBytes,
        requiredBytes: presentationBytes()
      });
    return Object.freeze({ ...result(), items: Object.freeze(items), bytes: presentationBytes() });
  }
}

const sourceReferences = new WeakMap<SessionBranchEntry, Map<string, HistorySourceRef>>();
export function sourceRef(sessionId: string, entry: SessionBranchEntry): HistorySourceRef {
  const cached = sourceReferences.get(entry)?.get(sessionId);
  if (cached) return cached;
  const source = Object.freeze({
    sessionId,
    entryId: entry.source ? `event:${entry.source.eventId}` : entry.id,
    ...(entry.source ? { event: entry.source } : {}),
    sha256:
      entry.source?.hash ??
      hashJson(
        parseJsonObject(entry, {
          maxStringBytes: 8 * 1024 * 1024,
          maxTotalBytes: 16 * 1024 * 1024
        })
      )
  });
  const cache = sourceReferences.get(entry) ?? new Map<string, HistorySourceRef>();
  cache.set(sessionId, source);
  sourceReferences.set(entry, cache);
  return source;
}
export function historyRole(entry: SessionBranchEntry): HistoryItem['role'] {
  return entry.type === 'input' || entry.type === 'steering'
    ? 'user'
    : entry.type === 'assistant' || entry.type === 'tool_call'
      ? 'assistant'
      : entry.type === 'observation'
        ? 'tool'
        : 'control';
}
function historyItem(sessionId: string, entry: SessionBranchEntry, maxBytes: number): HistoryItem {
  const text = publicText(entry);
  const range = textRange(text, 0, maxBytes);
  return Object.freeze({
    source: sourceRef(sessionId, entry),
    type: entry.type,
    role: historyRole(entry),
    ...(entry.type === 'context_transition' && entry.workingState
      ? { generated: true as const }
      : {}),
    ...('runId' in entry ? { runId: entry.runId } : {}),
    text: range.text,
    truncated: range.nextOffset < range.totalBytes,
    ...(entry.type === 'assistant' && entry.completeness
      ? { completeness: entry.completeness }
      : {})
  });
}

function publicText(entry: SessionBranchEntry): string {
  switch (entry.type) {
    case 'input':
      return entry.originalInput ? JSON.stringify(entry.originalInput) : entry.task;
    case 'steering':
      return entry.originalInput ? JSON.stringify(entry.originalInput) : entry.content;
    case 'assistant': {
      const media = entry.output?.filter((item) => item.type === 'media');
      return media && media.length > 0
        ? JSON.stringify({ content: entry.content, media })
        : entry.content;
    }
    case 'tool_call':
      return JSON.stringify(entry.call);
    case 'observation':
      return JSON.stringify({
        kind: entry.kind,
        ...(entry.originalUnavailable ? { originalUnavailable: entry.originalUnavailable } : {}),
        summary: entry.summary,
        output: entry.output,
        ...(entry.originalArtifact ? { originalArtifact: entry.originalArtifact } : {}),
        artifacts: entry.artifacts?.filter((ref) => ref.visibility === 'public')
      });
    case 'model_settings':
      return JSON.stringify({
        provider: entry.provider,
        model: entry.model,
        temperature: entry.temperature,
        reasoning: entry.reasoning,
        endpoint: entry.endpoint
      });
    case 'branch':
      return JSON.stringify({ fromEntryId: entry.fromEntryId, label: entry.label });
    case 'context_transition':
      return JSON.stringify({
        windowId: entry.window.windowId,
        reason: entry.window.reason,
        historyPosition: entry.window.historyPosition
      });
  }
}
function matchesMetadata(entry: SessionBranchEntry, filter?: HistoryFilter): boolean {
  const toolName = historyToolName(entry);
  return matchesHistoryMetadata({ ...entry, ...(toolName ? { toolName } : {}) }, filter);
}
function matches(entry: SessionBranchEntry, filter?: HistoryFilter): boolean {
  if (!matchesMetadata(entry, filter)) return false;
  if (
    filter?.resource &&
    (entry.type !== 'observation' ||
      !entry.artifacts?.some(
        (ref) => ref.visibility === 'public' && ref.artifactId === filter.resource
      ))
  )
    return false;
  return true;
}
function unavailable(
  source: HistorySourceRef,
  reason: Extract<HistoryReadResult, { status: 'unavailable' }>['reason']
): HistoryReadResult {
  return Object.freeze({ status: 'unavailable', reason, source });
}
export function bound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
  zero = false
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (zero ? 0 : 1) || result > maximum)
    throw new Error(
      `${name} must be ${zero ? 'nonnegative' : 'positive'} and at most ${String(maximum)}.`
    );
  return result;
}
function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative integer.`);
  return value;
}
/** UTF-8 byte ranges, aligned to code-point boundaries. */
export function textRange(
  text: string,
  offset: number,
  maxBytes: number
): { text: string; offset: number; nextOffset: number; totalBytes: number } {
  nonnegative(offset, 'offset');
  const bytes = Buffer.from(text);
  let start = Math.min(offset, bytes.length);
  let end = Math.min(start + maxBytes, bytes.length);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  if (maxBytes > 0 && start < bytes.length && end <= start)
    throw new Error(
      'Byte budget cannot fit the next UTF-8 character; request at least four bytes.'
    );
  return {
    text: bytes.subarray(start, Math.max(start, end)).toString('utf8'),
    offset: start,
    nextOffset: Math.max(start, end),
    totalBytes: bytes.length
  };
}
interface SearchCursor {
  readonly after?: HistorySearchPosition;
  readonly cut: HistorySourceCut;
  readonly position?: string;
  readonly queryFingerprint: string;
}
function encodeCursor(cursor: SearchCursor): string {
  const position = cursor.position ? decodeEntryCursor(cursor.position) : undefined;
  return Buffer.from(
    JSON.stringify({
      format: 'agent-core.history-cursor/1',
      cut: cursor.cut,
      queryFingerprint: cursor.queryFingerprint,
      ...(cursor.after ? { after: cursor.after } : {}),
      ...(position
        ? {
            position: {
              at: position.at,
              sequence: position.sequence,
              fingerprint: position.fingerprint
            }
          }
        : {})
    })
  ).toString('base64url');
}
function decodeCursor(value: string): SearchCursor {
  if (value.length > 256 * 1024) throw new Error('History cursor too large.');
  const parsed = parseJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  if (
    parsed.format !== 'agent-core.history-cursor/1' ||
    typeof parsed.queryFingerprint !== 'string'
  )
    throw new Error('Invalid history cursor.');
  return {
    ...(parsed.position !== undefined
      ? {
          position: encodeEntryCursor(
            parseEntryCursor({
              ...parseJsonObject(parsed.position),
              cut: parseJsonObject(parsed.cut),
              format: 'agent-core.history-sources/1'
            })
          )
        }
      : {}),
    queryFingerprint: parsed.queryFingerprint,
    ...(parsed.after === undefined ? {} : { after: decodeSearchPosition(parsed.after) }),
    cut: historyCutSchema.parse(parsed.cut)
  };
}

function decodeSearchPosition(value: unknown): HistorySearchPosition {
  const input = parseJsonObject(value);
  if (
    !Number.isSafeInteger(input.at) ||
    Number(input.at) < 0 ||
    !Number.isSafeInteger(input.sequence) ||
    Number(input.sequence) < -1 ||
    typeof input.entryId !== 'string'
  )
    throw new Error('Invalid history search position.');
  return { at: Number(input.at), sequence: Number(input.sequence), entryId: input.entryId };
}

export function sameHistorySource(left: HistorySourceRef, right: HistorySourceRef): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.entryId === right.entryId &&
    left.sha256 === right.sha256 &&
    left.event?.runId === right.event?.runId &&
    left.event?.eventId === right.event?.eventId &&
    left.event?.sequence === right.event?.sequence &&
    left.event?.hash === right.event?.hash
  );
}

export class HistorySourceTooLargeError extends Error {
  constructor(
    readonly source: HistorySourceRef,
    readonly bytes: number
  ) {
    super('History source exceeds the admitted source byte limit.');
  }
}
function metadataSource(sessionId: string, metadata: SessionSourceMetadata): HistorySourceRef {
  return Object.freeze({
    sessionId,
    entryId: metadata.source ? `event:${metadata.source.eventId}` : metadata.entryId,
    sha256: metadata.source?.hash ?? metadata.sha256,
    ...(metadata.source ? { event: metadata.source } : {})
  });
}
function eventTypes(filter?: HistoryFilter): readonly string[] {
  const mapping = [
    ['input.steering.accepted', 'steering', 'user'],
    ['assistant.ended', 'assistant', 'assistant'],
    ['assistant.interrupted', 'assistant', 'assistant'],
    ['tool.started', 'tool_call', 'assistant'],
    ['tool.ended', 'observation', 'tool']
  ] as const;
  return mapping
    .filter(
      ([, type, role]) =>
        (!filter?.sourceType || filter.sourceType === type) &&
        (!filter?.role || filter.role === role)
    )
    .map(([type]) => type);
}
interface EntryCursor {
  readonly cut: HistorySourceCut;
  readonly at: number;
  readonly sequence?: number;
  readonly fingerprint: string;
}
function encodeEntryCursor(cursor: EntryCursor): string {
  return Buffer.from(
    JSON.stringify({ format: 'agent-core.history-sources/1', ...cursor })
  ).toString('base64url');
}
function decodeEntryCursor(value: string): EntryCursor {
  if (value.length > 256 * 1024) throw new Error('History source cursor is too large.');
  return parseEntryCursor(
    parseJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  );
}
function parseEntryCursor(record: import('@agent-core/json').JsonObject): EntryCursor {
  if (record.format !== 'agent-core.history-sources/1') throw new Error('Invalid history source cursor.');
  return { cut: historyCutSchema.parse(record.cut), ...parseCursorPosition(record) };
}
function parseCursorPosition(record: import('@agent-core/json').JsonObject): Omit<EntryCursor, 'cut'> {
  if (
    typeof record.at !== 'number' || !Number.isSafeInteger(record.at) || record.at < 0 ||
    typeof record.fingerprint !== 'string' ||
    (record.sequence !== undefined && (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < -1))
  ) throw new Error('Invalid history source cursor.');
  return { at: record.at, fingerprint: record.fingerprint,
    ...(typeof record.sequence === 'number' ? { sequence: record.sequence } : {}) };
}
/** The page's explicit cut owns the capture; nested continuations carry only its fingerprint. */
function encodeMetadataCursor(cursor: EntryCursor): string {
  const { cut, ...position } = cursor;
  return Buffer.from(JSON.stringify({ format: 'agent-core.history-metadata/1', cutHash: hashJson(cut), ...position })).toString('base64url');
}
function decodeMetadataCursor(value: string, cut: HistorySourceCut): Omit<EntryCursor, 'cut'> {
  if (value.length > 4096) throw new Error('History metadata cursor is too large.');
  const record = parseJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  if (record.format !== 'agent-core.history-metadata/1' || record.cutHash !== hashJson(cut))
    throw new Error('History metadata cursor cut mismatch.');
  return parseCursorPosition(record);
}

class HistorySourceWorkLimitError extends Error {
  constructor(
    readonly source: HistorySourceRef,
    readonly bytes: number,
    readonly scanned: number
  ) {
    super('Related history records exceed the scanned record allowance.');
  }
}
