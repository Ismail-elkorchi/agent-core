import { noteRemoveSchema, noteWriteSchema } from './schema.js';
import { LiteralHistoryIndex } from '../history/literal-index.js';
import { sourceSchema } from '../history/schema.js';
import { randomUUID } from 'node:crypto';
import {
  InMemoryArtifactRepository,
  InMemoryEventRepository,
  PersistenceConflictError,
  hashJson,
  validateArtifactRef,
  type ArtifactRepository,
  type EventLedgerTail,
  type EventRepository,
  type RuntimeCodec
} from '@agent-core/persistence';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { bound, textRange } from '../history/reader.js';
import type {
  NoteQuotas,
  NoteQuery,
  NoteQueryResult,
  NoteReadRequest,
  NoteReadResult,
  NoteRemoveRequest,
  NoteRepository,
  NoteRevision,
  NoteScope,
  NoteWriteRequest,
  NoteWriteResult
} from './contracts.js';

export type NoteEvent =
  | Readonly<{
      type: 'note.content_reserved';
      format: 'agent-core.notes/1';
      scope: NoteScope;
      noteId: string;
      idempotencyKey: string;
      fingerprint: string;
      bytes: number;
      revisionId: string;
      createdAt: string;
    }>
  | Readonly<{
      type: 'note.committed';
      format: 'agent-core.notes/1';
      revision: NoteRevision;
      idempotencyKey: string;
      fingerprint: string;
    }>
  | Readonly<{
      type: 'notes.forked';
      format: 'agent-core.notes/1';
      scope: NoteScope;
      parentScope: NoteScope;
      parentWatermark: number;
      inherited: readonly NoteRevision[];
    }>;
export const noteEventCodec: RuntimeCodec<NoteEvent> = {
  encode(value) {
    return parseJsonObject(value, NOTE_LIMITS);
  },
  decode(value) {
    const record = parseJsonObject(value, NOTE_LIMITS);
    if (record.format !== 'agent-core.notes/1')
      throw new Error(
        'Incompatible notes format. Start a new session; existing data has not been changed.'
      );
    if (record.type === 'note.content_reserved') {
      if (
        typeof record.bytes !== 'number' ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 0
      )
        throw new Error('Invalid note content reservation.');
      return Object.freeze({
        type: record.type,
        format: record.format,
        scope: ownScope(record.scope),
        noteId: requiredString(record.noteId),
        idempotencyKey: requiredString(record.idempotencyKey),
        fingerprint: requiredString(record.fingerprint),
        bytes: record.bytes,
        revisionId: requiredString(record.revisionId),
        createdAt: requiredString(record.createdAt)
      });
    }
    if (
      record.type === 'note.committed' &&
      typeof record.idempotencyKey === 'string' &&
      typeof record.fingerprint === 'string'
    ) {
      return Object.freeze({
        type: record.type,
        format: record.format,
        revision: decodeRevision(record.revision),
        idempotencyKey: record.idempotencyKey,
        fingerprint: record.fingerprint
      });
    }
    if (
      record.type === 'notes.forked' &&
      Array.isArray(record.inherited) &&
      typeof record.parentWatermark === 'number' &&
      Number.isSafeInteger(record.parentWatermark) &&
      record.parentWatermark >= -1
    )
      return Object.freeze({
        type: record.type,
        format: record.format,
        scope: ownScope(record.scope),
        parentScope: ownScope(record.parentScope),
        parentWatermark: record.parentWatermark,
        inherited: Object.freeze(record.inherited.map(decodeRevision))
      });
    throw new Error('Invalid note event.');
  }
};
const NOTE_LIMITS = {
  maxDepth: 64,
  maxCollectionEntries: 100_000,
  maxStringBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024
} as const;
const DEFAULT_QUOTAS: NoteQuotas = Object.freeze({
  maxIndexBytes: 32 * 1024 * 1024,
  maxNotes: 256,
  maxNoteBytes: 256 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRevisions: 4096,
  maxQueryScanned: 1000,
  maxQueryBytes: 256 * 1024
});
export interface EventNoteRepositoryOptions {
  readonly events: EventRepository<NoteEvent>;
  readonly artifacts: ArtifactRepository;
  readonly quotas?: Partial<NoteQuotas>;
  readonly jsonSchemas?: Readonly<Record<string, (value: JsonValue) => JsonValue>>;
}
interface State {
  tail: EventLedgerTail;
  readonly reservations: Map<string, Extract<NoteEvent, { type: 'note.content_reserved' }>>;
  readonly committed: Map<string, Extract<NoteEvent, { type: 'note.committed' }>>;
  readonly forks: Map<string, Extract<NoteEvent, { type: 'notes.forked' }>>;
  readonly branches: Map<string, Map<string, { sequence: number; revision: NoteRevision }[]>>;
  readonly revisions: Map<string, Map<string, NoteRevision>>;
  readonly noteIds: Set<string>;
  storedBytes: number;
  indexBytes: number;
}
function emptyState(): State {
  return {
    tail: { sequence: -1, driverGeneration: 0 },
    reservations: new Map(),
    committed: new Map(),
    forks: new Map(),
    branches: new Map(),
    revisions: new Map(),
    noteIds: new Set(),
    storedBytes: 0,
    indexBytes: 0
  };
}

/** A single conditional event stream per session makes CAS and storage quota reservation atomic. */
export class EventNoteRepository implements NoteRepository {
  private readonly quotas: NoteQuotas;
  private readonly cache = new Map<string, State>();
  private readonly lexicalIndex = new LiteralHistoryIndex();
  constructor(private readonly options: EventNoteRepositoryOptions) {
    this.quotas = Object.freeze({ ...DEFAULT_QUOTAS, ...options.quotas });
    for (const [key, value] of Object.entries(this.quotas))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`Invalid notes quota: ${key}.`);
  }
  write(input: NoteWriteRequest): Promise<NoteWriteResult> {
    return this.commit(input, false);
  }
  remove(input: NoteRemoveRequest): Promise<NoteWriteResult> {
    return this.commit(input, true);
  }

  async fork(input: {
    readonly scope: NoteScope;
    readonly parentScope: NoteScope;
    readonly throughRevision?: number;
  }): Promise<void> {
    const scope = ownScope(input.scope);
    const parentScope = ownScope(input.parentScope);
    if (scopeKey(scope) === scopeKey(parentScope))
      throw new Error('A note branch cannot inherit itself.');
    if (scope.sessionId !== parentScope.sessionId)
      throw new Error(
        'Note inheritance requires a common session; cross-session sharing needs an explicit application repository grant.'
      );
    const state = await this.state(scope.sessionId);
    const existing = state.forks.get(scopeKey(scope));
    if (existing?.type === 'notes.forked') {
      if (
        scopeKey(existing.parentScope) !== scopeKey(parentScope) ||
        (input.throughRevision !== undefined && existing.parentWatermark !== input.throughRevision)
      )
        throw new PersistenceConflictError('Note branch already has a different parent.');
      return;
    }
    if (state.branches.has(scopeKey(scope)))
      throw new PersistenceConflictError(
        'Cannot inherit notes into a branch with committed writes.'
      );
    if (state.tail.sequence + 1 >= this.quotas.maxRevisions * 3)
      throw new Error('Notes branch storage quota exceeded.');
    const parentWatermark = input.throughRevision ?? state.tail.sequence;
    if (
      !Number.isSafeInteger(parentWatermark) ||
      parentWatermark < -1 ||
      parentWatermark > state.tail.sequence
    )
      throw new Error('Invalid note inheritance source revision.');
    const inherited = Object.freeze([...visible(state, parentScope, parentWatermark).values()]);
    const event: NoteEvent = Object.freeze({
      type: 'notes.forked',
      format: 'agent-core.notes/1',
      scope,
      parentScope,
      parentWatermark,
      inherited
    });
    await this.append(scope.sessionId, state, event, `fork:${hashJson(scope)}`);
  }

  async read(input: NoteReadRequest): Promise<NoteReadResult> {
    const scope = ownScope(input.scope);
    identifier(input.noteId, 'noteId');
    const maxBytes = bound(input.maxBytes, 16 * 1024, this.quotas.maxQueryBytes, 'maxBytes');
    const state = await this.state(scope.sessionId);
    const revision = input.revisionId
      ? state.revisions.get(scopeKey(scope))?.get(input.revisionId)
      : currentNoteRevision(state, scope, input.noteId);
    if (revision && revision.noteId !== input.noteId) return Object.freeze({ status: 'missing' });
    if (!revision) return Object.freeze({ status: 'missing' });
    if (revision.tombstone) return Object.freeze({ status: 'tombstone', revision });
    if (!revision.contentArtifact)
      throw new Error('Committed note is missing its artifact reference.');
    let bytes: Uint8Array;
    try {
      bytes = await this.options.artifacts.readVerified(revision.contentArtifact);
    } catch {
      return Object.freeze({ status: 'artifact_unavailable', revision });
    }
    const range = textRange(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      input.offset ?? 0,
      maxBytes
    );
    return Object.freeze({
      status: 'available',
      revision,
      ...range,
      truncated: range.offset > 0 || range.nextOffset < range.totalBytes
    });
  }
  list(input: NoteQuery): Promise<NoteQueryResult> {
    return this.query(input, false);
  }
  search(input: NoteQuery): Promise<NoteQueryResult> {
    return this.query(input, true);
  }

  private async query(input: NoteQuery, search: boolean): Promise<NoteQueryResult> {
    const scope = ownScope(input.scope);
    const limit = bound(input.limit, 20, 100, 'limit');
    const maxBytes = bound(
      input.maxBytes,
      Math.min(32 * 1024, this.quotas.maxQueryBytes),
      this.quotas.maxQueryBytes,
      'maxBytes'
    );
    const maxScanned = bound(
      input.maxScanned,
      Math.min(1000, this.quotas.maxQueryScanned),
      this.quotas.maxQueryScanned,
      'maxScanned'
    );
    if ((input.query?.length ?? 0) > 4096) throw new Error('Note query exceeds 4096 characters.');
    const state = await this.state(scope.sessionId);
    const fingerprint = hashJson({ scope, query: input.query ?? '', search });
    const cursor = input.cursor
      ? decodeCursor(input.cursor, fingerprint, state.tail.sequence)
      : undefined;
    const watermark = cursor?.watermark ?? state.tail.sequence;
    const notes = [...visible(state, scope, watermark).values()]
      .filter((note) => !note.tombstone)
      .sort((a, b) => a.noteId.localeCompare(b.noteId));
    let at = cursor?.at ?? 0;
    let scanned = 0;
    let bytes = 0;
    let incompleteArtifact = false;
    let scannedBytes = 0;
    const maxScannedBytes = bound(
      input.maxScannedBytes,
      this.quotas.maxQueryBytes,
      64 * 1024 * 1024,
      'maxScannedBytes'
    );
    const unavailable: NonNullable<NoteQueryResult['unavailable']>[number][] = [];
    if (at > notes.length) throw new Error('Invalid note cursor position.');
    const items: NoteRevision[] = [];
    while (at < notes.length && scanned < maxScanned && items.length < limit && bytes < maxBytes) {
      const note = notes[at++];
      scanned++;
      if (!note) continue;
      const metadataBytes = Buffer.byteLength(JSON.stringify(note));
      if (scannedBytes + metadataBytes > maxScannedBytes) {
        if (metadataBytes > maxScannedBytes) {
          unavailable.push({ revision: note, reason: 'source_too_large' });
          incompleteArtifact = true;
        } else {
          at--;
          scanned--;
        }
        break;
      }
      scannedBytes += metadataBytes;
      if (input.query) {
        let found = note.title.includes(input.query);
        if (!found && search && note.contentArtifact) {
          if (scannedBytes + note.contentArtifact.size > maxScannedBytes) {
            if (note.contentArtifact.size + metadataBytes > maxScannedBytes) {
              unavailable.push({ revision: note, reason: 'source_too_large' });
              incompleteArtifact = true;
            } else {
              at--;
              scanned--;
            }
            break;
          }
          scannedBytes += note.contentArtifact.size;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
              await this.options.artifacts.readVerified(note.contentArtifact)
            );
            this.lexicalIndex.add(note.revisionId, text);
            found =
              this.lexicalIndex.matches(note.revisionId, input.query) ?? text.includes(input.query);
          } catch {
            unavailable.push({ revision: note, reason: 'artifact_unavailable' });
            incompleteArtifact = true;
          }
        }
        if (!found) continue;
      }
      const size = Buffer.byteLength(JSON.stringify(note));
      if (bytes + size > maxBytes) {
        at--;
        scanned--;
        if (items.length === 0) throw new Error('Note result byte budget cannot fit one revision.');
        break;
      }
      items.push(note);
      bytes += size;
    }
    const complete = at === notes.length;
    return Object.freeze({
      items: Object.freeze(items),
      watermark,
      scannedBytes,
      ...(unavailable.length ? { unavailable: Object.freeze(unavailable) } : {}),
      coverage: complete && !incompleteArtifact ? 'complete' : 'partial',
      scanned,
      bytes,
      index: Object.freeze({ ...this.lexicalIndex.inspect(), coverage: 'partial' as const }),
      ...(!complete
        ? {
            cursor: Buffer.from(
              JSON.stringify({ format: 'agent-core.note-cursor/1', fingerprint, watermark, at })
            ).toString('base64url')
          }
        : {})
    });
  }

  private async commit(
    input: NoteWriteRequest | NoteRemoveRequest,
    remove: boolean
  ): Promise<NoteWriteResult> {
    const write = remove ? undefined : noteWriteSchema.readonly().parse(input);
    input = write ?? noteRemoveSchema.readonly().parse(input);
    const scope = ownScope(input.scope);
    identifier(input.noteId, 'noteId');
    identifier(input.idempotencyKey, 'idempotencyKey');
    identifier(input.authorId, 'authorId');
    identifier(input.invocationId, 'invocationId');
    if (input.expectedRevision !== null) identifier(input.expectedRevision, 'expectedRevision');
    const owned = parseJsonObject(input, NOTE_LIMITS);
    const fingerprint = hashJson({ remove, input: owned });
    const key = hashJson({
      scope,
      invocationId: input.invocationId,
      idempotencyKey: input.idempotencyKey
    });
    let state = await this.state(scope.sessionId);
    const retry = state.committed.get(key);
    if (retry?.type === 'note.committed') {
      if (retry.fingerprint !== fingerprint)
        throw new PersistenceConflictError('Note idempotency key has conflicting content.');
      return Object.freeze({ status: 'committed', revision: retry.revision });
    }
    const current = currentNoteRevision(state, scope, input.noteId);
    if ((current?.revisionId ?? null) !== input.expectedRevision)
      return Object.freeze({ status: 'conflict', currentRevision: current?.revisionId ?? null });
    if (remove && !current) return Object.freeze({ status: 'conflict', currentRevision: null });
    if (
      !remove &&
      (!write ||
        typeof write.title !== 'string' ||
        write.title.length === 0 ||
        Buffer.byteLength(write.title) > 4096 ||
        !['text/plain', 'text/markdown', 'application/json'].includes(write.mediaType))
    )
      throw new Error('Invalid note title or media type.');
    if (write && write.mediaType !== 'application/json' && typeof write.content !== 'string')
      throw new Error('Text notes require string content.');
    if (write?.schemaId !== undefined && write.mediaType !== 'application/json')
      throw new Error('Only JSON notes can bind a schema.');
    const json =
      write?.mediaType === 'application/json'
        ? parseJsonValue(write.content, NOTE_LIMITS)
        : undefined;
    const schema =
      write?.schemaId === undefined ? undefined : this.options.jsonSchemas?.[write.schemaId];
    if (write?.schemaId !== undefined && !schema) throw new Error('Unknown note JSON schema.');
    const validatedJson =
      schema && json !== undefined ? parseJsonValue(schema(json), NOTE_LIMITS) : json;
    const text = write
      ? write.mediaType === 'application/json'
        ? JSON.stringify(validatedJson)
        : typeof write.content === 'string'
          ? write.content
          : ''
      : '';
    const size = Buffer.byteLength(text);
    let reservation = state.reservations.get(key);
    if (reservation?.type === 'note.content_reserved' && reservation.fingerprint !== fingerprint)
      throw new PersistenceConflictError(
        'Note reservation idempotency key has conflicting content.'
      );
    if (!reservation) {
      const storedBytes = state.storedBytes;
      const noteIds = state.noteIds;
      if (
        size > this.quotas.maxNoteBytes ||
        storedBytes + size > this.quotas.maxTotalBytes ||
        state.reservations.size >= this.quotas.maxRevisions ||
        (!current && noteIds.size >= this.quotas.maxNotes)
      )
        throw new Error('Notes storage quota exceeded.');
      reservation = Object.freeze({
        type: 'note.content_reserved',
        format: 'agent-core.notes/1',
        scope,
        noteId: input.noteId,
        idempotencyKey: key,
        fingerprint,
        bytes: size,
        revisionId: randomUUID(),
        createdAt: new Date().toISOString()
      });
      try {
        await this.append(scope.sessionId, state, reservation, `reserve:${hashJson(key)}`);
      } catch (error) {
        if (!(error instanceof PersistenceConflictError)) throw error;
        const refreshed = await this.state(scope.sessionId);
        const committed = refreshed.committed.get(key);
        if (committed?.type === 'note.committed' && committed.fingerprint === fingerprint)
          return Object.freeze({ status: 'committed', revision: committed.revision });
        const staged = refreshed.reservations.get(key);
        if (staged?.type === 'note.content_reserved') {
          if (staged.fingerprint !== fingerprint)
            throw new PersistenceConflictError('Note idempotency key has conflicting content.');
          reservation = staged;
        } else {
          return Object.freeze({
            status: 'conflict',
            currentRevision: currentNoteRevision(refreshed, scope, input.noteId)?.revisionId ?? null
          });
        }
      }
      state = await this.state(scope.sessionId);
    }
    const concurrentCommit = state.committed.get(key);
    if (concurrentCommit?.type === 'note.committed') {
      if (concurrentCommit.fingerprint !== fingerprint)
        throw new PersistenceConflictError('Note idempotency key has conflicting content.');
      return Object.freeze({ status: 'committed', revision: concurrentCommit.revision });
    }
    const latestRevision = currentNoteRevision(state, scope, input.noteId)?.revisionId ?? null;
    if (latestRevision !== input.expectedRevision)
      return Object.freeze({ status: 'conflict', currentRevision: latestRevision });
    const artifact = write
      ? await this.options.artifacts.storeProtected({
          label: `note-${input.noteId}`,
          mediaType: write.mediaType,
          content: Buffer.from(text)
        })
      : undefined;
    const revision = decodeRevision({
      format: 'agent-core.note/1',
      scope,
      noteId: input.noteId,
      revisionId: reservation.revisionId,
      title: write?.title ?? current?.title,
      mediaType: write?.mediaType ?? current?.mediaType,
      ...(write?.schemaId
        ? { schemaId: write.schemaId }
        : remove && current?.schemaId
          ? { schemaId: current.schemaId }
          : {}),
      ...(artifact ? { contentArtifact: artifact } : {}),
      parentRevision: current?.revisionId ?? null,
      authorId: input.authorId,
      invocationId: input.invocationId,
      sources: write?.sources ?? current?.sources ?? [],
      tombstone: remove,
      createdAt: reservation.createdAt
    });
    const event: NoteEvent = Object.freeze({
      type: 'note.committed',
      format: 'agent-core.notes/1',
      revision,
      idempotencyKey: key,
      fingerprint
    });
    try {
      await this.append(scope.sessionId, state, event, `write:${hashJson(key)}`);
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
      const refreshed = await this.state(scope.sessionId);
      const committed = refreshed.committed.get(key);
      if (committed?.type === 'note.committed') {
        if (committed.fingerprint !== fingerprint)
          throw new PersistenceConflictError('Note idempotency key has conflicting content.');
        return Object.freeze({ status: 'committed', revision: committed.revision });
      }
      return Object.freeze({
        status: 'conflict',
        currentRevision: currentNoteRevision(refreshed, scope, input.noteId)?.revisionId ?? null
      });
    }
    return Object.freeze({ status: 'committed', revision });
  }
  private readonly refreshes = new Map<string, Promise<State>>();
  private state(sessionId: string): Promise<State> {
    const previous = this.refreshes.get(sessionId) ?? Promise.resolve(undefined);
    const pending = previous
      .catch(() => undefined)
      .then(async () => ({ ...(await this.refresh(sessionId)) }));
    this.refreshes.set(sessionId, pending);
    void pending
      .finally(() => {
        if (this.refreshes.get(sessionId) === pending) this.refreshes.delete(sessionId);
      })
      .catch(() => undefined);
    return pending;
  }
  async rebuildIndex(
    sessionId: string,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: { records: number; throughSequence: number }) => void;
    } = {}
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await this.refreshes.get(sessionId);
    this.cache.delete(sessionId);
    await this.refresh(sessionId, options);
  }
  private async refresh(
    sessionId: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: { records: number; throughSequence: number }) => void;
    }
  ): Promise<State> {
    const stream = streamId(sessionId);
    const tail = await this.options.events.tail(stream);
    const state = this.cache.get(sessionId) ?? emptyState();
    if (
      state.tail.sequence > tail.sequence ||
      (state.tail.sequence === tail.sequence && state.tail.hash !== tail.hash)
    )
      throw new Error('Notes source boundary changed; stored data has not been modified.');
    if (state.tail.sequence === tail.sequence) return state;
    // Each refresh validates and indexes only newly committed metadata, under storage quotas.
    try {
      while (state.tail.sequence < tail.sequence) {
        options?.signal?.throwIfAborted();
        const page = await this.options.events.readRange(stream, {
          afterSequence: state.tail.sequence,
          through: tail
        });
        if (page.oversized) throw new Error('Note record exceeds the bounded index read.');
        if (page.records.length === 0) throw new Error('Notes event stream is incomplete.');
        for (const envelope of page.records) {
          if (
            envelope.sequence !== state.tail.sequence + 1 ||
            envelope.previousHash !== state.tail.hash
          )
            throw new Error('Notes event stream lost its committed hash chain.');
          if (envelope.sequence >= this.quotas.maxRevisions * 3)
            throw new Error('Notes index storage quota exceeded.');
          const eventBytes = Buffer.byteLength(JSON.stringify(envelope.event));
          if (state.indexBytes + eventBytes > this.quotas.maxIndexBytes)
            throw new Error('Notes metadata index byte quota exceeded.');
          acceptNoteEvent(state, envelope.event, sessionId, envelope.sequence);
          state.indexBytes += eventBytes;
          if (
            state.reservations.size > this.quotas.maxRevisions ||
            state.storedBytes > this.quotas.maxTotalBytes ||
            state.noteIds.size > this.quotas.maxNotes
          )
            throw new Error('Persisted notes exceed configured storage quotas.');
          state.tail = {
            sequence: envelope.sequence,
            hash: envelope.hash,
            driverGeneration: envelope.driverGeneration
          };
          options?.onProgress?.({ records: envelope.sequence + 1, throughSequence: tail.sequence });
        }
      }
    } catch (error) {
      this.cache.delete(sessionId);
      throw error;
    }
    this.cache.delete(sessionId);
    this.cache.set(sessionId, state);
    while (this.cache.size > 4) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return state;
  }
  private async append(
    sessionId: string,
    state: State,
    event: NoteEvent,
    idempotencyKey: string
  ): Promise<void> {
    if (state.indexBytes + Buffer.byteLength(JSON.stringify(event)) > this.quotas.maxIndexBytes)
      throw new Error('Notes metadata index byte quota exceeded.');
    const result = await this.options.events.appendConditional(streamId(sessionId), event, {
      expectedTail: state.tail,
      driverGeneration: state.tail.driverGeneration,
      idempotencyKey,
      actor: 'model'
    });
    if (result.kind === 'rejected')
      throw new PersistenceConflictError(`Notes commit rejected: ${result.reason}.`);
    if (result.kind === 'not_committed' || result.kind === 'outcome_unknown')
      throw new Error(`Notes commit ${result.kind}: ${result.failure.message}`);
  }
}
export class InMemoryNoteRepository extends EventNoteRepository {
  constructor(
    options: {
      readonly artifacts?: ArtifactRepository;
      readonly quotas?: Partial<NoteQuotas>;
      readonly jsonSchemas?: Readonly<Record<string, (value: JsonValue) => JsonValue>>;
    } = {}
  ) {
    super({
      events: new InMemoryEventRepository(noteEventCodec),
      artifacts: options.artifacts ?? new InMemoryArtifactRepository(),
      ...(options.quotas ? { quotas: options.quotas } : {}),
      ...(options.jsonSchemas ? { jsonSchemas: options.jsonSchemas } : {})
    });
  }
}
function currentNoteRevision(
  state: State,
  scope: NoteScope,
  noteId: string,
  watermark = state.tail.sequence
): NoteRevision | undefined {
  const history = state.branches.get(scopeKey(scope))?.get(noteId);
  if (!history) return undefined;
  let low = 0,
    high = history.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((history[middle]?.sequence ?? Number.POSITIVE_INFINITY) <= watermark) low = middle + 1;
    else high = middle;
  }
  return history[low - 1]?.revision;
}
function visible(
  state: State,
  scope: NoteScope,
  watermark = state.tail.sequence
): Map<string, NoteRevision> {
  const notes = new Map<string, NoteRevision>();
  for (const noteId of state.branches.get(scopeKey(scope))?.keys() ?? []) {
    const revision = currentNoteRevision(state, scope, noteId, watermark);
    if (revision) notes.set(noteId, revision);
  }
  return notes;
}
export function ownScope(value: unknown): NoteScope {
  const scope = parseJsonObject(value);
  identifier(scope.sessionId, 'sessionId');
  identifier(scope.branchId, 'branchId');
  return Object.freeze({ sessionId: scope.sessionId, branchId: scope.branchId });
}
function scopeKey(scope: NoteScope): string {
  return JSON.stringify([scope.sessionId, scope.branchId]);
}
function streamId(sessionId: string): string {
  return `notes:${hashJson(sessionId)}`;
}
function identifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    hasControlCharacter(value)
  )
    throw new Error(`Invalid ${name}.`);
}
function decodeRevision(value: unknown): NoteRevision {
  const item = parseJsonObject(value, NOTE_LIMITS);
  const scope = ownScope(item.scope);
  if (
    item.format !== 'agent-core.note/1' ||
    !(
      item.mediaType === 'text/plain' ||
      item.mediaType === 'text/markdown' ||
      item.mediaType === 'application/json'
    ) ||
    typeof item.tombstone !== 'boolean' ||
    !(item.parentRevision === null || typeof item.parentRevision === 'string') ||
    !Array.isArray(item.sources)
  )
    throw new Error('Invalid note revision.');
  if (item.tombstone ? item.contentArtifact !== undefined : item.contentArtifact === undefined)
    throw new Error('Invalid note content/tombstone.');
  const artifact = item.contentArtifact;
  if (artifact !== undefined) validateArtifactRef(artifact);
  if (artifact !== undefined && artifact.visibility !== 'protected')
    throw new Error('Notes require protected artifacts.');
  const mediaType = item.mediaType;
  if (item.schemaId !== undefined && mediaType !== 'application/json')
    throw new Error('Only JSON notes can bind a schema.');
  return Object.freeze({
    format: 'agent-core.note/1',
    scope,
    noteId: requiredString(item.noteId),
    revisionId: requiredString(item.revisionId),
    title: requiredString(item.title),
    mediaType,
    ...(item.schemaId === undefined ? {} : { schemaId: requiredString(item.schemaId) }),
    ...(artifact ? { contentArtifact: Object.freeze({ ...artifact }) } : {}),
    parentRevision: item.parentRevision === null ? null : requiredString(item.parentRevision),
    authorId: requiredString(item.authorId),
    invocationId: requiredString(item.invocationId),
    sources: Object.freeze(item.sources.map((source) => sourceSchema.parse(source))),
    tombstone: item.tombstone,
    createdAt: requiredString(item.createdAt)
  });
}
function decodeCursor(
  value: string,
  fingerprint: string,
  latest: number
): { at: number; watermark: number } {
  if (value.length > 4096) throw new Error('Note cursor too large.');
  const cursor: JsonObject = parseJsonObject(
    JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  );
  if (
    cursor.format !== 'agent-core.note-cursor/1' ||
    cursor.fingerprint !== fingerprint ||
    typeof cursor.at !== 'number' ||
    !Number.isSafeInteger(cursor.at) ||
    cursor.at < 0 ||
    typeof cursor.watermark !== 'number' ||
    !Number.isSafeInteger(cursor.watermark) ||
    cursor.watermark < -1 ||
    cursor.watermark > latest
  )
    throw new Error('Invalid note cursor or scope.');
  return { at: cursor.at, watermark: cursor.watermark };
}

function requiredString(value: unknown): string {
  identifier(value, 'note field');
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32) return true;
  return false;
}

function acceptNoteEvent(
  state: State,
  event: NoteEvent,
  sessionId: string,
  sequence: number
): void {
  if (event.type === 'note.content_reserved') {
    if (event.scope.sessionId !== sessionId || state.reservations.has(event.idempotencyKey))
      throw new Error('Invalid or duplicate note content reservation.');
    state.reservations.set(event.idempotencyKey, event);
    state.storedBytes += event.bytes;
    state.noteIds.add(`${scopeKey(event.scope)}:${event.noteId}`);
    return;
  }
  if (event.type === 'notes.forked') {
    if (
      event.scope.sessionId !== sessionId ||
      event.parentScope.sessionId !== sessionId ||
      event.parentWatermark >= sequence ||
      state.branches.has(scopeKey(event.scope)) ||
      state.forks.has(scopeKey(event.scope)) ||
      scopeKey(event.scope) === scopeKey(event.parentScope)
    )
      throw new Error('Invalid note branch source cut.');
    const inherited = [...visible(state, event.parentScope, event.parentWatermark).values()];
    if (hashJson(inherited) !== hashJson(event.inherited))
      throw new Error('Note branch inheritance does not match its pinned parent revisions.');
    state.forks.set(scopeKey(event.scope), event);
    for (const revision of event.inherited) indexRevision(state, event.scope, revision, sequence);
    return;
  }
  const reservation = state.reservations.get(event.idempotencyKey);
  const revision = event.revision;
  if (
    !reservation ||
    state.committed.has(event.idempotencyKey) ||
    reservation.fingerprint !== event.fingerprint ||
    reservation.revisionId !== revision.revisionId ||
    reservation.noteId !== revision.noteId ||
    scopeKey(reservation.scope) !== scopeKey(revision.scope) ||
    reservation.createdAt !== revision.createdAt ||
    reservation.bytes !== (revision.contentArtifact?.size ?? 0)
  )
    throw new Error('Note commit has no matching content reservation.');
  if (
    (currentNoteRevision(state, revision.scope, revision.noteId)?.revisionId ?? null) !==
    revision.parentRevision
  )
    throw new Error('Note revision violates its committed compare-and-swap boundary.');
  state.committed.set(event.idempotencyKey, event);
  indexRevision(state, revision.scope, revision, sequence);
}
function indexRevision(
  state: State,
  scope: NoteScope,
  revision: NoteRevision,
  sequence: number
): void {
  const key = scopeKey(scope);
  const branch =
    state.branches.get(key) ?? new Map<string, { sequence: number; revision: NoteRevision }[]>();
  const history = branch.get(revision.noteId) ?? [];
  history.push({ sequence, revision });
  branch.set(revision.noteId, history);
  state.branches.set(key, branch);
  const revisions = state.revisions.get(key) ?? new Map<string, NoteRevision>();
  revisions.set(revision.revisionId, revision);
  state.revisions.set(key, revisions);
}
