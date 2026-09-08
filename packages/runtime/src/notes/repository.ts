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
      throw new Error('Incompatible notes format. Start a new session; existing data has not been changed.');
    if (record.type === 'note.content_reserved') {
      if (typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0)
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
  readonly tail: EventLedgerTail;
  readonly events: readonly NoteEvent[];
}

/** A single conditional event stream per session makes CAS and storage quota reservation atomic. */
export class EventNoteRepository implements NoteRepository {
  private readonly quotas: NoteQuotas;
  private readonly cache = new Map<string, State>();
  private readonly lexicalIndex = new LiteralHistoryIndex();
  constructor(private readonly options: EventNoteRepositoryOptions) {
    this.quotas = Object.freeze({ ...DEFAULT_QUOTAS, ...options.quotas });
    for (const [key, value] of Object.entries(this.quotas))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid notes quota: ${key}.`);
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
    if (scopeKey(scope) === scopeKey(parentScope)) throw new Error('A note branch cannot inherit itself.');
    if (scope.sessionId !== parentScope.sessionId)
      throw new Error(
        'Note inheritance requires a common session; cross-session sharing needs an explicit application repository grant.'
      );
    const state = await this.state(scope.sessionId);
    const existing = state.events.find(
      (event) => event.type === 'notes.forked' && scopeKey(event.scope) === scopeKey(scope)
    );
    if (existing?.type === 'notes.forked') {
      if (
        scopeKey(existing.parentScope) !== scopeKey(parentScope) ||
        (input.throughRevision !== undefined && existing.parentWatermark !== input.throughRevision)
      )
        throw new PersistenceConflictError('Note branch already has a different parent.');
      return;
    }
    if (
      state.events.some(
        (event) => event.type === 'note.committed' && scopeKey(event.revision.scope) === scopeKey(scope)
      )
    )
      throw new PersistenceConflictError('Cannot inherit notes into a branch with committed writes.');
    if (state.events.length >= this.quotas.maxRevisions * 3)
      throw new Error('Notes branch storage quota exceeded.');
    const parentWatermark = input.throughRevision ?? state.tail.sequence;
    if (
      !Number.isSafeInteger(parentWatermark) ||
      parentWatermark < -1 ||
      parentWatermark > state.tail.sequence
    )
      throw new Error('Invalid note inheritance source revision.');
    const inherited = Object.freeze([
      ...visible(state.events.slice(0, parentWatermark + 1), parentScope).values()
    ]);
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
    const revisions = visibleRevisions(state.events, scope);
    const revision = input.revisionId
      ? revisions.find((item) => item.noteId === input.noteId && item.revisionId === input.revisionId)
      : visible(state.events, scope).get(input.noteId);
    if (!revision) return Object.freeze({ status: 'missing' });
    if (revision.tombstone) return Object.freeze({ status: 'tombstone', revision });
    if (!revision.contentArtifact) throw new Error('Committed note is missing its artifact reference.');
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
    const cursor = input.cursor ? decodeCursor(input.cursor, fingerprint, state.tail.sequence) : undefined;
    const watermark = cursor?.watermark ?? state.tail.sequence;
    const notes = [...visible(state.events.slice(0, watermark + 1), scope).values()]
      .filter((note) => !note.tombstone)
      .sort((a, b) => a.noteId.localeCompare(b.noteId));
    let at = cursor?.at ?? 0;
    let scanned = 0;
    let bytes = 0;
    let incompleteArtifact = false;
    if (at > notes.length) throw new Error('Invalid note cursor position.');
    const items: NoteRevision[] = [];
    while (at < notes.length && scanned < maxScanned && items.length < limit && bytes < maxBytes) {
      const note = notes[at++];
      scanned++;
      if (!note) continue;
      if (input.query) {
        let found = note.title.includes(input.query);
        if (!found && search && note.contentArtifact) {
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
              await this.options.artifacts.readVerified(note.contentArtifact)
            );
            this.lexicalIndex.add(note.revisionId, text);
            found = this.lexicalIndex.matches(note.revisionId, input.query) ?? text.includes(input.query);
          } catch {
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
    const key = hashJson(
      { scope, invocationId: input.invocationId, idempotencyKey: input.idempotencyKey }
    );
    let state = await this.state(scope.sessionId);
    const retry = state.events.find(
      (event) => event.type === 'note.committed' && event.idempotencyKey === key
    );
    if (retry?.type === 'note.committed') {
      if (retry.fingerprint !== fingerprint)
        throw new PersistenceConflictError('Note idempotency key has conflicting content.');
      return Object.freeze({ status: 'committed', revision: retry.revision });
    }
    const current = visible(state.events, scope).get(input.noteId);
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
      write?.mediaType === 'application/json' ? parseJsonValue(write.content, NOTE_LIMITS) : undefined;
    const schema = write?.schemaId === undefined ? undefined : this.options.jsonSchemas?.[write.schemaId];
    if (write?.schemaId !== undefined && !schema) throw new Error('Unknown note JSON schema.');
    const validatedJson = schema && json !== undefined ? parseJsonValue(schema(json), NOTE_LIMITS) : json;
    const text = write
      ? write.mediaType === 'application/json'
        ? JSON.stringify(validatedJson)
        : typeof write.content === 'string'
          ? write.content
          : ''
      : '';
    const size = Buffer.byteLength(text);
    let reservation = state.events.find(
      (event) => event.type === 'note.content_reserved' && event.idempotencyKey === key
    );
    if (reservation?.type === 'note.content_reserved' && reservation.fingerprint !== fingerprint)
      throw new PersistenceConflictError('Note reservation idempotency key has conflicting content.');
    if (!reservation) {
      const reservations = state.events.filter((event) => event.type === 'note.content_reserved');
      const storedBytes = reservations.reduce((total, event) => total + event.bytes, 0);
      const noteIds = new Set(reservations.map((event) => `${scopeKey(event.scope)}:${event.noteId}`));
      if (
        size > this.quotas.maxNoteBytes ||
        storedBytes + size > this.quotas.maxTotalBytes ||
        reservations.length >= this.quotas.maxRevisions ||
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
        const committed = refreshed.events.find(
          (event) => event.type === 'note.committed' && event.idempotencyKey === key
        );
        if (committed?.type === 'note.committed' && committed.fingerprint === fingerprint)
          return Object.freeze({ status: 'committed', revision: committed.revision });
        const staged = refreshed.events.find(
          (event) => event.type === 'note.content_reserved' && event.idempotencyKey === key
        );
        if (staged?.type === 'note.content_reserved') {
          if (staged.fingerprint !== fingerprint)
            throw new PersistenceConflictError('Note idempotency key has conflicting content.');
          reservation = staged;
        } else {
          return Object.freeze({
            status: 'conflict',
            currentRevision: visible(refreshed.events, scope).get(input.noteId)?.revisionId ?? null
          });
        }
      }
      state = await this.state(scope.sessionId);
    }
    const concurrentCommit = state.events.find(
      (event) => event.type === 'note.committed' && event.idempotencyKey === key
    );
    if (concurrentCommit?.type === 'note.committed') {
      if (concurrentCommit.fingerprint !== fingerprint)
        throw new PersistenceConflictError('Note idempotency key has conflicting content.');
      return Object.freeze({ status: 'committed', revision: concurrentCommit.revision });
    }
    if (reservation.type !== 'note.content_reserved') throw new Error('Invalid note reservation state.');
    const latestRevision = visible(state.events, scope).get(input.noteId)?.revisionId ?? null;
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
      const committed = refreshed.events.find(
        (item) => item.type === 'note.committed' && item.idempotencyKey === key
      );
      if (committed?.type === 'note.committed') {
        if (committed.fingerprint !== fingerprint)
          throw new PersistenceConflictError('Note idempotency key has conflicting content.');
        return Object.freeze({ status: 'committed', revision: committed.revision });
      }
      return Object.freeze({
        status: 'conflict',
        currentRevision: visible(refreshed.events, scope).get(input.noteId)?.revisionId ?? null
      });
    }
    return Object.freeze({ status: 'committed', revision });
  }
  private async state(sessionId: string): Promise<State> {
    const stream = streamId(sessionId);
    const tail = await this.options.events.tail(stream);
    const cached = this.cache.get(sessionId);
    if (cached?.tail.hash === tail.hash && cached?.tail.sequence === tail.sequence) return cached;
    const events: NoteEvent[] = [];
    for await (const envelope of this.options.events.read(stream)) {
      if (envelope.sequence > tail.sequence) break;
      events.push(noteEventCodec.decode(envelope.event));
    }
    if (events.length !== tail.sequence + 1) throw new Error('Notes event stream is incomplete.');
    validateNoteStream(events, sessionId);
    const state = { tail, events: Object.freeze(events) };
    this.cache.set(sessionId, state);
    return state;
  }
  private async append(
    sessionId: string,
    state: State,
    event: NoteEvent,
    idempotencyKey: string
  ): Promise<void> {
    const result = await this.options.events.appendConditional(streamId(sessionId), event, {
      expectedTail: state.tail,
      driverGeneration: state.tail.driverGeneration,
      idempotencyKey,
      actor: 'model'
    });
    this.cache.delete(sessionId);
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
function visibleRevisions(events: readonly NoteEvent[], scope: NoteScope): NoteRevision[] {
  return events.flatMap((event) =>
    event.type === 'notes.forked' && scopeKey(event.scope) === scopeKey(scope)
      ? event.inherited
      : event.type === 'note.committed' && scopeKey(event.revision.scope) === scopeKey(scope)
        ? [event.revision]
        : []
  );
}
function visible(events: readonly NoteEvent[], scope: NoteScope): Map<string, NoteRevision> {
  return new Map(visibleRevisions(events, scope).map((revision) => [revision.noteId, revision]));
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
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || hasControlCharacter(value))
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
function decodeCursor(value: string, fingerprint: string, latest: number): { at: number; watermark: number } {
  if (value.length > 4096) throw new Error('Note cursor too large.');
  const cursor: JsonObject = parseJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
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

function validateNoteStream(events: readonly NoteEvent[], sessionId: string): void {
  const reservations = new Map<string, Extract<NoteEvent, { type: 'note.content_reserved' }>>();
  const branches = new Map<string, Map<string, NoteRevision>>();
  const committedKeys = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.type === 'note.content_reserved') {
      if (event.scope.sessionId !== sessionId || reservations.has(event.idempotencyKey))
        throw new Error('Invalid or duplicate note content reservation.');
      reservations.set(event.idempotencyKey, event);
      continue;
    }
    if (event.type === 'notes.forked') {
      if (
        event.scope.sessionId !== sessionId ||
        event.parentScope.sessionId !== sessionId ||
        event.parentWatermark >= index ||
        branches.has(scopeKey(event.scope))
      )
        throw new Error('Invalid note branch source cut.');
      const inherited = [...visible(events.slice(0, event.parentWatermark + 1), event.parentScope).values()];
      if (hashJson(inherited) !== hashJson(event.inherited))
        throw new Error('Note branch inheritance does not match its pinned parent revisions.');
      branches.set(
        scopeKey(event.scope),
        new Map(event.inherited.map((revision) => [revision.noteId, revision]))
      );
      continue;
    }
    const reservation = reservations.get(event.idempotencyKey);
    const revision = event.revision;
    if (
      !reservation ||
      committedKeys.has(event.idempotencyKey) ||
      reservation.fingerprint !== event.fingerprint ||
      reservation.revisionId !== revision.revisionId ||
      reservation.noteId !== revision.noteId ||
      scopeKey(reservation.scope) !== scopeKey(revision.scope) ||
      reservation.createdAt !== revision.createdAt ||
      reservation.bytes !== (revision.contentArtifact?.size ?? 0)
    )
      throw new Error('Note commit has no matching content reservation.');
    const branch = branches.get(scopeKey(revision.scope)) ?? new Map<string, NoteRevision>();
    if ((branch.get(revision.noteId)?.revisionId ?? null) !== revision.parentRevision)
      throw new Error('Note revision violates its committed compare-and-swap boundary.');
    branch.set(revision.noteId, revision);
    branches.set(scopeKey(revision.scope), branch);
    committedKeys.add(event.idempotencyKey);
  }
}
