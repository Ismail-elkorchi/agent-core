import { parseJsonObject } from '@agent-core/json';
import { encodeToolFailureOutput } from '@agent-core/tools';
import {
  hashJson,
  type ArtifactRepository,
  type EventRepository,
  type EventEnvelope
} from '@agent-core/persistence';
import type { AgentEvent } from '../events.js';
import type {
  SessionBranchEntry,
  SessionDescriptor,
  SessionRepository
} from '../session/contracts.js';
import type {
  HistoryFilter,
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
import { LiteralHistoryIndex } from './literal-index.js';
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
  private readonly lexicalIndex = new LiteralHistoryIndex();
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
    const finalized = finalizedRuns(snapshot);
    const inherited = inheritedHeads(snapshot);
    const heads: HistoryLedgerHead[] = [];
    for (const runId of new Set(
      snapshot.entries.flatMap((entry) => (entry.runId ? [entry.runId] : []))
    )) {
      const pinned = inherited.get(runId);
      if (pinned) {
        heads.push(pinned);
        continue;
      }
      if (this.options.events) {
        if (
          finalized.has(runId) &&
          (await this.options.events.latestReferenceOfType(runId, 'run.ended'))
        )
          continue;
        const tail = await this.options.events.tail(runId);
        heads.push(
          Object.freeze({
            runId,
            sequence: tail.sequence,
            ...(tail.hash ? { hash: tail.hash } : {})
          })
        );
      } else {
        const sources = snapshot.entries.filter((entry) => entry.source?.runId === runId);
        const last = sources.at(-1)?.source;
        heads.push(
          Object.freeze({
            runId,
            sequence: last?.sequence ?? -1,
            ...(last ? { hash: last.hash } : {})
          })
        );
      }
    }
    return Object.freeze({
      format: 'agent-core.history/1',
      sessionId: this.options.session.id,
      branchId: snapshot.branchId,
      throughEntryId: snapshot.boundary.leafId,
      sourceRevision: snapshot.sourceRevision,
      ledgerCoverage: this.options.events ? 'authoritative' : 'session',
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
      previous.branchId !== next.branchId ||
      previous.sourceRevision > next.sourceRevision ||
      previous.ledgerCoverage !== next.ledgerCoverage
    )
      return false;
    const snapshot = await this.snapshot(next);
    if (
      previous.throughEntryId !== null &&
      !metadataIndex(snapshot).byId.has(previous.throughEntryId)
    )
      return false;
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
    if (!metadataIndex(snapshot).runs.has(invocation.runId))
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
          const reference = await events.referenceByKey(invocation.runId, key);
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
    const assistant = ['complete', 'partial', 'indeterminate', 'absent']
      .map((status) =>
        metadataIndex(snapshot).byIdentity.get(
          `assistant:${invocation.runId}:${invocation.turnId}:${String(invocation.requestAttempt)}:${status}`
        )
      )
      .find((entry) => entry !== undefined);
    if (!assistant) throw new Error('Context operation has an unresolved assistant source.');
    return [
      metadataSource(cut.sessionId, assistant),
      ...identities.map((identity) => {
        const metadata = metadataIndex(snapshot).byIdentity.get(identity);
        if (!metadata) throw new Error('Context operation has an unresolved tool exchange.');
        return metadataSource(cut.sessionId, metadata);
      })
    ];
  }

  private async snapshot(cut: HistorySourceCut): Promise<SessionSourceSnapshot> {
    cut = historyCutSchema.parse(cut);
    const current = await this.options.repository.sourceSnapshot(this.options.session);
    if (
      cut.sessionId !== this.options.session.id ||
      cut.branchId !== current.branchId ||
      cut.sourceRevision > current.sourceRevision ||
      (cut.throughEntryId !== null && !metadataIndex(current).byId.has(cut.throughEntryId))
    )
      throw new Error('History cut is outside the authorized branch or incompatible.');
    const snapshot =
      cut.throughEntryId === current.boundary.leafId
        ? current
        : await this.options.repository.sourceSnapshot(this.options.session, cut.throughEntryId);
    const runs = metadataIndex(snapshot).runs;
    const seen = new Set<string>();
    for (const head of cut.ledgerHeads ?? []) {
      if (
        !runs.has(head.runId) ||
        seen.has(head.runId) ||
        (head.sequence < 0 ? head.hash !== undefined : head.hash === undefined)
      )
        throw new Error('History cut has an invalid or unauthorized run boundary.');
      seen.add(head.runId);
      const inherited = inheritedHeads(snapshot).get(head.runId);
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
      cut.ledgerHeads?.find((head) => head.runId === runId) ?? inheritedHeads(snapshot).get(runId);
    if (explicit) return explicit;
    if (finalizedRuns(snapshot).has(runId) && this.options.events) {
      const ended = await this.options.events.latestReferenceOfType(runId, 'run.ended');
      if (ended) return { runId, sequence: ended.sequence, hash: ended.hash };
    }
    throw new Error('History cut is missing its run boundary.');
  }

  async selectedContext(cut?: HistorySourceCut): Promise<ContextWindowRecord | undefined> {
    cut ??= await this.capture();
    const snapshot = await this.snapshot(cut);
    const metadata = [...snapshot.entries]
      .reverse()
      .find((entry) => entry.type === 'context_transition');
    if (!metadata) return undefined;
    const entry = await this.sessionEntry(metadata, snapshot, MAX_SOURCE_BYTES);
    return entry.type === 'context_transition' ? entry.window : undefined;
  }

  async resolve(
    source: HistorySourceRef,
    cut?: HistorySourceCut,
    maxSourceBytes = MAX_SOURCE_BYTES
  ): Promise<SessionBranchEntry | undefined> {
    source = sourceSchema.parse(source);
    bound(maxSourceBytes, MAX_SOURCE_BYTES, MAX_SOURCE_BYTES, 'maxSourceBytes');
    if (source.sessionId !== this.options.session.id) return undefined;
    cut ??= await this.capture();
    const snapshot = await this.snapshot(cut);
    if (source.event && this.options.events && cut.ledgerCoverage === 'authoritative') {
      if (source.entryId !== `event:${source.event.eventId}` || source.sha256 !== source.event.hash)
        throw new Error('History source identity mismatch.');
      if (!metadataIndex(snapshot).runs.has(source.event.runId)) return undefined;
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
      const resolved = await this.eventEntry(
        record,
        snapshot,
        head,
        maxSourceBytes - page.bytes,
        true
      );
      return resolved.entry;
    }
    const metadata = metadataIndex(snapshot).bySource.get(source.entryId);
    if (!metadata) return undefined;
    const entry = await this.sessionEntry(metadata, snapshot, maxSourceBytes);
    if (!sameHistorySource(sourceRef(source.sessionId, entry), source))
      throw new Error('History source identity mismatch.');
    return (await this.originalEntry(entry, maxSourceBytes - metadata.bytes)).entry;
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
    return {
      entry: Object.freeze({
        ...entry,
        output:
          observation.kind === 'result'
            ? observation.output
            : encodeToolFailureOutput(observation.output)
      }),
      bytes: entry.originalArtifact.size
    };
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
      metadataIndex(snapshot).bySource.get(`event:${record.eventId}`) ??
      metadataIndex(snapshot).byIdentity.get(entryIdentity(entry));
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
  async page(request: HistoryEntryPageRequest = {}): Promise<HistoryEntryPage> {
    const limit = bound(request.limit, 100, MAX_SCANNED, 'limit');
    const maxBytes = bound(request.maxBytes, MAX_SOURCE_BYTES, MAX_SOURCE_BYTES, 'maxBytes');
    const fingerprint = hashJson({ after: request.after ?? null, filter: request.filter ?? null });
    const cursor = request.cursor ? decodeEntryCursor(request.cursor) : undefined;
    if (cursor && cursor.fingerprint !== fingerprint)
      throw new Error('History source cursor filter mismatch.');
    if (cursor && request.cut && hashJson(cursor.cut) !== hashJson(request.cut))
      throw new Error('History source cursor cut mismatch.');
    const cut = cursor?.cut ?? request.cut ?? (await this.capture());
    const snapshot = await this.snapshot(cut);
    const afterSnapshot = request.after ? await this.snapshot(request.after) : undefined;
    const oldIds = afterSnapshot
      ? metadataIndex(afterSnapshot).byId
      : new Map<string, SessionSourceMetadata>();
    let at = cursor?.at ?? 0;
    if (!cursor && request.after?.branchId === cut.branchId) {
      const positions = metadataIndex(snapshot);
      const boundary =
        request.after.throughEntryId === null
          ? -1
          : positions.positions.get(request.after.throughEntryId);
      if (boundary !== undefined) {
        at = boundary + 1;
        // Previously open runs can acquire new records behind the session-entry boundary.
        for (const head of request.after.ledgerHeads ?? []) {
          const input = positions.inputs.get(head.runId);
          if (input !== undefined) at = Math.min(at, input);
        }
      }
    }

    let sequence = cursor?.sequence;
    if (at > snapshot.entries.length)
      throw new Error('History source cursor is beyond its boundary.');
    let scanned = 0,
      bytes = 0;
    const entries: SessionBranchEntry[] = [];
    const unavailable: NonNullable<HistoryEntryPage['unavailable']>[number][] = [];
    while (at < snapshot.entries.length && scanned < limit && bytes < maxBytes) {
      const metadata = snapshot.entries[at];
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
          request.after && afterSnapshot && metadataIndex(afterSnapshot).runs.has(runId)
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
          types: eventTypes(request.filter)
        });
        scanned += page.scanned;
        bytes += page.bytes;
        let pausedSequence: number | undefined;
        for (const record of page.records) {
          if (record.event.type === 'observation.record.created') continue;
          try {
            const raw = publicEventEntry(record, null, new Map());
            const original =
              request.enrich === false && request.originals && raw
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
                unavailable.push({ source: error.source, bytes: error.bytes, records: limit + 1 });
              break;
            }
            if (!(error instanceof HistorySourceTooLargeError)) throw error;
            unavailable.push({ source: error.source, bytes: error.bytes });
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
          unavailable.push({ source, bytes: page.oversized.bytes });
          sequence = page.oversized.reference.sequence;
          scanned++;
        }
        if (page.complete && pausedSequence === undefined) {
          at++;
          sequence = undefined;
        }
        if (
          pausedSequence !== undefined ||
          unavailable.length ||
          (page.scanned === 0 && !page.complete)
        )
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
      if (oldIds.has(metadata.entryId) || !metadataMatches(metadata, request.filter)) continue;
      if (metadata.bytes > maxBytes - bytes) {
        if (metadata.bytes > maxBytes)
          unavailable.push({
            source: metadataSource(cut.sessionId, metadata),
            bytes: metadata.bytes
          });
        else {
          if (metadata.type === 'input' && authoritative) sequence = undefined;
          else at--;
          scanned--;
        }
        break;
      }
      const entry = await this.sessionEntry(metadata, snapshot, maxBytes - bytes);
      bytes += metadata.bytes;
      if (matches(entry, request.filter)) entries.push(entry);
    }
    const complete = at === snapshot.entries.length;
    return Object.freeze({
      entries: Object.freeze(entries),
      cut,
      scanned,
      bytes,
      coverage: complete && unavailable.length === 0 ? 'complete' : 'partial',
      ...(unavailable.length ? { unavailable: Object.freeze(unavailable) } : {}),
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
    const range = textRange(publicText(entry), request.offset ?? 0, maxBytes);
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
        const at = snapshot.entries.findIndex((item) => item.entryId === entry.id);
        for (
          let i = Math.max(0, at - count);
          i <= Math.min(snapshot.entries.length - 1, at + count) && remaining > 0;
          i++
        ) {
          if (i === at) continue;
          const metadata = snapshot.entries[i];
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
      ...range,
      neighbors: Object.freeze(neighbors),
      cut
    });
  }

  async search(request: HistorySearchRequest = {}): Promise<HistorySearchResult> {
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
    const queryFingerprint = hashJson({ query: request.query ?? '', filter: request.filter ?? {} });
    const cursor = request.cursor ? decodeCursor(request.cursor) : undefined;
    if (cursor && cursor.queryFingerprint !== queryFingerprint)
      throw new Error('History cursor query mismatch.');
    if (cursor && request.cut && hashJson(cursor.cut) !== hashJson(request.cut))
      throw new Error('History cursor source cut mismatch.');
    const cut = cursor?.cut ?? request.cut ?? (await this.capture());
    let position = cursor?.position;
    let scanned = 0,
      scannedBytes = 0,
      bytes = 0;
    const items: HistoryItem[] = [];
    const unavailableSources: NonNullable<HistorySearchResult['unavailable']>[number][] = [];
    let complete = false;
    while (scanned < maxScanned && scannedBytes < maxScannedBytes && items.length < limit) {
      const prior = position;
      const page = await this.page({
        cut,
        ...(position ? { cursor: position } : {}),
        filter: request.filter,
        limit: 1,
        maxBytes: maxScannedBytes - scannedBytes,
        enrich: false,
        originals: true
      });
      scanned += page.scanned;
      scannedBytes += page.bytes;
      position = page.cursor;
      if (page.unavailable) unavailableSources.push(...page.unavailable);
      for (const entry of page.entries) {
        const source = sourceRef(cut.sessionId, entry);
        const key = `${source.entryId}:${source.sha256}`;
        const fullText = this.lexicalIndex.text(key) ?? publicText(entry);
        this.lexicalIndex.add(key, fullText);
        const match = request.query ? fullText.indexOf(request.query) : 0;
        if (match < 0) continue;
        const room = maxBytes - bytes;
        const metadata = historyItem(cut.sessionId, entry, 0);
        const excerpt = textRange(
          fullText,
          Buffer.byteLength(fullText.slice(0, Math.max(0, match - 128))),
          Math.min(Math.max(0, room - Buffer.byteLength(JSON.stringify(metadata)) - 32), 16 * 1024)
        );
        const item = Object.freeze({
          ...metadata,
          text: excerpt.text,
          truncated: excerpt.offset > 0 || excerpt.nextOffset < excerpt.totalBytes
        });
        const size = Buffer.byteLength(JSON.stringify(item));
        if (size > room) {
          if (!items.length)
            throw new Error('History result byte budget cannot fit one source reference.');
          position = prior;
          break;
        }
        items.push(item);
        bytes += size;
      }
      if (position === prior && page.entries.length > 0) break;
      if (!page.cursor) {
        complete = true;
        break;
      }
    }
    return Object.freeze({
      items: Object.freeze(items),
      cut,
      indexWatermark: cut,
      scanned,
      scannedBytes,
      bytes,
      coverage: complete && unavailableSources.length === 0 ? 'complete' : 'partial',
      index: Object.freeze({
        ...this.lexicalIndex.inspect(),
        coverage: complete ? 'complete' : 'partial'
      }),
      ...(unavailableSources.length ? { unavailable: Object.freeze(unavailableSources) } : {}),
      ...(!complete
        ? { cursor: encodeCursor({ cut, ...(position ? { position } : {}), queryFingerprint }) }
        : {})
    });
  }

  async rebuildIndex(
    options: {
      readonly maxScanned?: number;
      readonly cursor?: string;
      readonly signal?: AbortSignal;
    } = {}
  ) {
    options.signal?.throwIfAborted();
    const result = await this.search({
      maxScanned: options.maxScanned,
      cursor: options.cursor,
      limit: MAX_RESULTS
    });
    options.signal?.throwIfAborted();
    return Object.freeze({
      ...this.lexicalIndex.inspect(),
      cut: result.cut,
      coverage: result.coverage,
      ...(result.cursor ? { cursor: result.cursor } : {})
    });
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
        parseJsonObject(entry, { maxStringBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 })
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
function matches(entry: SessionBranchEntry, filter?: HistoryFilter): boolean {
  if (!filter) return true;
  if (filter.sourceType && entry.type !== filter.sourceType) return false;
  if (filter.role && historyRole(entry) !== filter.role) return false;
  if (filter.runId && (!('runId' in entry) || entry.runId !== filter.runId)) return false;
  if (
    filter.toolName &&
    (entry.type !== 'observation' || entry.toolName !== filter.toolName) &&
    (entry.type !== 'tool_call' ||
      typeof entry.call !== 'object' ||
      entry.call === null ||
      Array.isArray(entry.call) ||
      !('name' in entry.call) ||
      entry.call.name !== filter.toolName)
  )
    return false;
  if (
    filter.resource &&
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
  readonly cut: HistorySourceCut;
  readonly position?: string;
  readonly queryFingerprint: string;
}
function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify({ format: 'agent-core.history-cursor/1', ...cursor })).toString(
    'base64url'
  );
}
function decodeCursor(value: string): SearchCursor {
  if (value.length > 256 * 1024) throw new Error('History cursor too large.');
  const parsed = parseJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  if (
    parsed.format !== 'agent-core.history-cursor/1' ||
    typeof parsed.queryFingerprint !== 'string' ||
    (parsed.position !== undefined && typeof parsed.position !== 'string')
  )
    throw new Error('Invalid history cursor.');
  return {
    ...(typeof parsed.position === 'string' ? { position: parsed.position } : {}),
    queryFingerprint: parsed.queryFingerprint,
    cut: historyCutSchema.parse(parsed.cut)
  };
}

export function sameHistorySource(left: HistorySourceRef, right: HistorySourceRef): boolean {
  return hashJson(left) === hashJson(right);
}

class HistorySourceTooLargeError extends Error {
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
const inheritedCache = new WeakMap<
  readonly SessionSourceMetadata[],
  ReadonlyMap<string, HistoryLedgerHead>
>();
function inheritedHeads(snapshot: SessionSourceSnapshot): ReadonlyMap<string, HistoryLedgerHead> {
  const cached = inheritedCache.get(snapshot.entries);
  if (cached) return cached;
  const heads = new Map<string, HistoryLedgerHead>();
  for (const entry of snapshot.entries) {
    if (entry.type !== 'branch') continue;
    const source = snapshot.entries.find((item) => item.entryId === entry.fromEntryId);
    for (const head of source?.historyPosition?.ledgerHeads ?? []) heads.set(head.runId, head);
  }
  inheritedCache.set(snapshot.entries, heads);
  return heads;
}
function metadataMatches(metadata: SessionSourceMetadata, filter?: HistoryFilter): boolean {
  if (filter?.sourceType && filter.sourceType !== metadata.type) return false;
  if (filter?.runId && metadata.runId !== filter.runId) return false;
  const role =
    metadata.type === 'input' || metadata.type === 'steering'
      ? 'user'
      : metadata.type === 'assistant' || metadata.type === 'tool_call'
        ? 'assistant'
        : metadata.type === 'observation'
          ? 'tool'
          : 'control';
  return !filter?.role || filter.role === role;
}
function eventTypes(filter?: HistoryFilter): readonly string[] {
  const mapping = [
    ['input.steering.accepted', 'steering', 'user'],
    ['assistant.ended', 'assistant', 'assistant'],
    ['assistant.interrupted', 'assistant', 'assistant'],
    ['tool.started', 'tool_call', 'assistant'],
    ['tool.ended', 'observation', 'tool'],
    ['observation.record.created', 'observation', 'tool']
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
  const record = parseJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  if (
    record.format !== 'agent-core.history-sources/1' ||
    typeof record.at !== 'number' ||
    !Number.isSafeInteger(record.at) ||
    record.at < 0 ||
    typeof record.fingerprint !== 'string' ||
    (record.sequence !== undefined &&
      (typeof record.sequence !== 'number' ||
        !Number.isSafeInteger(record.sequence) ||
        record.sequence < -1))
  )
    throw new Error('Invalid history source cursor.');
  return {
    cut: historyCutSchema.parse(record.cut),
    at: record.at,
    fingerprint: record.fingerprint,
    ...(typeof record.sequence === 'number' ? { sequence: record.sequence } : {})
  };
}

const metadataIndexes = new WeakMap<
  readonly SessionSourceMetadata[],
  {
    byId: Map<string, SessionSourceMetadata>;
    bySource: Map<string, SessionSourceMetadata>;
    byIdentity: Map<string, SessionSourceMetadata>;
    runs: Set<string>;
    positions: Map<string, number>;
    inputs: Map<string, number>;
  }
>();
function metadataIndex(snapshot: SessionSourceSnapshot) {
  let index = metadataIndexes.get(snapshot.entries);
  if (!index) {
    index = {
      byId: new Map(),
      bySource: new Map(),
      byIdentity: new Map(),
      runs: new Set(),
      positions: new Map(),
      inputs: new Map()
    };
    for (const [position, entry] of snapshot.entries.entries()) {
      index.positions.set(entry.entryId, position);
      if (entry.type === 'input' && entry.runId) index.inputs.set(entry.runId, position);
      index.byId.set(entry.entryId, entry);
      index.byIdentity.set(entry.identity, entry);
      index.bySource.set(entry.source ? `event:${entry.source.eventId}` : entry.entryId, entry);
      if (entry.runId) index.runs.add(entry.runId);
    }
    metadataIndexes.set(snapshot.entries, index);
  }
  return index;
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

const finalizedRunIndexes = new WeakMap<SessionSourceSnapshot, ReadonlySet<string>>();
function finalizedRuns(snapshot: SessionSourceSnapshot): ReadonlySet<string> {
  let runs = finalizedRunIndexes.get(snapshot);
  if (!runs) {
    runs = new Set(snapshot.finalizations.map((entry) => entry.runId));
    finalizedRunIndexes.set(snapshot, runs);
  }
  return runs;
}
