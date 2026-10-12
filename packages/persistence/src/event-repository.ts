import { canonicalJsonString } from '@agent-core/json';
import { randomUUID } from 'node:crypto';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type {
  AppendEventOptions,
  EventActor,
  EventAppendReceipt,
  EventEnvelope,
  LedgerIntegrityReport,
  TypedEvent
} from './ledger.js';
import { hashJson } from './ledger.js';

export interface RuntimeCodec<T> {
  encode(value: T): JsonObject;
  decode(value: unknown): T;
}

/** Small, rebuildable routing facts derived from validated domain events. */
export type EventMetadataIndex = Readonly<{ type?: string }> & (
  | Readonly<{ field: string }>
  | Readonly<{ metadata: Readonly<Record<string, string>> }>
);

export interface EventCodec<T extends TypedEvent> extends RuntimeCodec<T> {
  /** Small, declared equality indexes over routing facts, never event bodies. */
  readonly metadataIndexes?: readonly EventMetadataIndex[];
  metadata?(value: T): Readonly<Record<string, string>>;
}

export function parseEventMetadata(value: unknown): Readonly<Record<string, string>> {
  const object = parseJsonObject(value, {
    maxCollectionEntries: 64,
    maxStringBytes: 4096,
    maxTotalBytes: 16384
  });
  return Object.freeze(Object.fromEntries(Object.entries(object).map(([key, value]) => {
    if (typeof value !== 'string') throw new TypeError('Event metadata values must be strings.');
    return [key, value];
  })));
}

export function matchesEventMetadata(
  actual: Readonly<Record<string, string>>,
  expected?: Readonly<Record<string, string>>
): boolean {
  return !expected || Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export interface EventAppendOptions extends AppendEventOptions {
  readonly idempotencyKey?: string;
}

export interface EventLedgerTail {
  readonly sequence: number;
  readonly hash?: string;
  readonly driverGeneration: number;
}

export interface ConditionalEventAppendOptions extends AppendEventOptions {
  readonly idempotencyKey: string;
  readonly expectedTail: EventLedgerTail;
  readonly driverGeneration: number;
}

export interface PersistenceFailure {
  readonly code?: string;
  readonly message: string;
}

export type ConditionalEventAppendResult =
  | Readonly<{ kind: 'committed'; receipt: EventAppendReceipt; tail: EventLedgerTail }>
  | Readonly<{ kind: 'already_committed'; receipt: EventAppendReceipt; tail: EventLedgerTail }>
  | Readonly<{
      kind: 'rejected';
      reason: 'stale_tail' | 'stale_driver' | 'idempotency_conflict';
      tail: EventLedgerTail;
    }>
  | Readonly<{ kind: 'not_committed'; failure: PersistenceFailure }>
  | Readonly<{
      kind: 'committed_index_unknown';
      receipt: EventAppendReceipt;
      tail: EventLedgerTail;
      failure: PersistenceFailure;
    }>
  | Readonly<{ kind: 'outcome_unknown'; failure: PersistenceFailure }>;

interface EncodedEnvelope extends JsonObject {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly schemaVersion: string;
  readonly actor: EventActor;
  readonly event: JsonObject;
  readonly hash: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly previousHash?: string;
  readonly driverGeneration: number;
}

export interface EventReference {
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly hash: string;
}
export interface EventIndexReadOptions {
  /** Never hydrate ledger bodies to validate or recover a derived index. */
  readonly metadataOnly?: boolean;
}
export interface EventRangeRequest {
  readonly afterSequence?: number;
  readonly through?: {
    readonly sequence: number;
    readonly hash?: string | undefined;
    readonly driverGeneration?: number | undefined;
  };
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly types?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly afterTime?: string;
  readonly beforeTime?: string;
}
export interface EventSourceMetadata {
  readonly reference: EventReference;
  readonly type: string;
  readonly timestamp: string;
  /** Bytes in the original stored source, including its record delimiter. */
  readonly bytes: number;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface EventPage<T> {
  readonly records: readonly T[];
  readonly tail: EventLedgerTail;
  /** Last scanned sequence; use as the next request's afterSequence. */
  readonly nextSequence: number;
  readonly complete: boolean;
  readonly scanned: number;
  readonly bytes: number;
  readonly oversized?: Readonly<{ reference: EventReference; bytes: number }>;
}

export type EventRangePage<TEvent extends TypedEvent> = EventPage<EventEnvelope<TEvent>>;
/** Page bytes count serialized metadata records, never original event payloads. */
export type EventMetadataPage = EventPage<EventSourceMetadata>;

export function eventRangeBounds(request: EventRangeRequest): {
  after: number;
  limit: number;
  maxBytes: number;
  through?: NonNullable<EventRangeRequest['through']>;
  types?: readonly string[];
  metadata?: Readonly<Record<string, string>>;
  afterTime?: string;
  beforeTime?: string;
} {
  const after = request.afterSequence ?? -1;
  const limit = request.limit ?? 256;
  const maxBytes = request.maxBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(after) ||
    after < -1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 4096 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024
  )
    throw new RangeError('Invalid event sequence range or resource bounds.');
  if (
    request.through &&
    (!Number.isSafeInteger(request.through.sequence) ||
      request.through.sequence < -1 ||
      (request.through.driverGeneration !== undefined &&
        (!Number.isSafeInteger(request.through.driverGeneration) ||
          request.through.driverGeneration < 0)) ||
      (request.through.sequence === -1
        ? request.through.hash !== undefined
        : typeof request.through.hash !== 'string'))
  )
    throw new TypeError('Invalid event range boundary.');
  if (
    request.types &&
    (request.types.length > 256 ||
      request.types.some((type) => typeof type !== 'string' || !type.length))
  )
    throw new TypeError('Invalid event range type filter.');
  for (const time of [request.afterTime, request.beforeTime])
    if (time !== undefined && !Number.isFinite(Date.parse(time)))
      throw new TypeError('Invalid event time filter.');
  return Object.freeze({
    ...(request.metadata ? { metadata: parseEventMetadata(request.metadata) } : {}),
    ...(request.afterTime ? { afterTime: request.afterTime } : {}),
    ...(request.beforeTime ? { beforeTime: request.beforeTime } : {}),
    after,
    limit,
    maxBytes,
    ...(request.through ? { through: Object.freeze({ ...request.through }) } : {}),
    ...(request.types ? { types: Object.freeze([...request.types]) } : {})
  });
}
export function assertEventReference(reference: EventReference): void {
  assertIdentifier(reference.runId, 'runId');
  if (
    !Number.isSafeInteger(reference.sequence) ||
    reference.sequence < 0 ||
    typeof reference.eventId !== 'string' ||
    !reference.eventId.length ||
    typeof reference.hash !== 'string' ||
    !reference.hash.length
  )
    throw new TypeError('Invalid event reference.');
}

export interface EventRepository<TEvent extends TypedEvent> {
  append(runId: string, event: TEvent, options?: EventAppendOptions): Promise<EventAppendReceipt>;
  appendConditional(
    runId: string,
    event: TEvent,
    options: ConditionalEventAppendOptions
  ): Promise<ConditionalEventAppendResult>;
  tail(runId: string, options?: EventIndexReadOptions): Promise<EventLedgerTail>;
  latest(runId: string): Promise<EventEnvelope<TEvent> | undefined>;
  latestOfType(runId: string, type: TEvent['type']): Promise<EventEnvelope<TEvent> | undefined>;
  latestReferenceOfType(runId: string, type: TEvent['type'], options?: EventIndexReadOptions): Promise<EventReference | undefined>;
  referenceByKey(runId: string, idempotencyKey: string, options?: EventIndexReadOptions): Promise<EventReference | undefined>;
  readReference(reference: EventReference): Promise<EventEnvelope<TEvent>>;
  readRange(runId: string, request?: EventRangeRequest): Promise<EventRangePage<TEvent>>;
  readMetadataRange(runId: string, request?: EventRangeRequest): Promise<EventMetadataPage>;
  read(runId: string): AsyncIterable<EventEnvelope<TEvent>>;
  listRunIds(): Promise<readonly string[]>;
  verifyIntegrity(runId: string): Promise<LedgerIntegrityReport>;
}

export class PersistenceCorruptionError extends Error {
  readonly code: 'invalid_json' | 'invalid_header' | 'invalid_record' | 'integrity';
  readonly storage: string;
  readonly line: number;
  readonly byteOffset: number;
  constructor(input: {
    code: PersistenceCorruptionError['code'];
    storage: string;
    line: number;
    byteOffset: number;
    message: string;
  }) {
    super(
      `${input.message} (${input.storage}, line ${String(input.line)}, byte ${String(input.byteOffset)})`
    );
    this.name = 'PersistenceCorruptionError';
    this.code = input.code;
    this.storage = input.storage;
    this.line = input.line;
    this.byteOffset = input.byteOffset;
  }
}

export class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceConflictError';
  }
}

/** Metadata-only reads cannot repair derived indexes by hydrating event bodies. */
export class PersistenceIndexRecoveryRequiredError extends PersistenceConflictError {
  readonly code = 'index_recovery_required';
  constructor(readonly runId: string) {
    super(`Event metadata index for ${runId} is unavailable; explicit index recovery is required.`);
    this.name = 'PersistenceIndexRecoveryRequiredError';
  }
}

export class InMemoryEventRepository<TEvent extends TypedEvent> implements EventRepository<TEvent> {
  private readonly records = new Map<string, EncodedEnvelope[]>();
  private readonly byKey = new Map<string, Map<string, EncodedEnvelope>>();
  private readonly latestByType = new Map<string, Map<string, EncodedEnvelope>>();
  private readonly routing = new WeakMap<EncodedEnvelope, EventSourceMetadata>();
  private readonly metadataRoutes = new Map<string, Map<string, number[]>>();
  private readonly decoded = new WeakMap<EncodedEnvelope, TEvent>();
  private queue: Promise<void> = Promise.resolve();
  private readonly metadataIndexes: readonly EventMetadataIndex[];
  constructor(private readonly codec: EventCodec<TEvent>) {
    this.metadataIndexes = ownEventMetadataIndexes(codec.metadataIndexes);
  }

  append(
    runId: string,
    event: TEvent,
    options: EventAppendOptions = {}
  ): Promise<EventAppendReceipt> {
    const operation = this.queue.then(() => {
      assertIdentifier(runId, 'runId');
      const encodedEvent = this.codec.encode(event);
      const records = this.records.get(runId) ?? [];
      const idempotencyKey = options.idempotencyKey;
      const existing = idempotencyKey
        ? records.find((record) => record.idempotencyKey === idempotencyKey)
        : undefined;
      if (existing && idempotencyKey) {
        if (canonicalJsonString(existing.event) !== canonicalJsonString(encodedEvent))
          throw new PersistenceConflictError(`Conflicting event for ${idempotencyKey}.`);
        return receiptFromEncoded(existing);
      }
      const previous = records.at(-1);
      const base = Object.freeze({
        eventId: randomUUID(),
        runId,
        sequence: records.length,
        timestamp: options.timestamp ?? new Date().toISOString(),
        schemaVersion: '1',
        actor: options.actor ?? inferActor(event.type),
        event: encodedEvent,
        ...(options.causationId ? { causationId: options.causationId } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(previous ? { previousHash: previous.hash } : {}),
        driverGeneration: previous?.driverGeneration ?? 0
      });
      const encodedEnvelope: EncodedEnvelope = Object.freeze({ ...base, hash: hashJson(base) });
      records.push(encodedEnvelope);
      this.records.set(runId, records);
      this.rememberType(runId, encodedEnvelope);
      return receiptFromEncoded(encodedEnvelope);
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  appendConditional(
    runId: string,
    event: TEvent,
    options: ConditionalEventAppendOptions
  ): Promise<ConditionalEventAppendResult> {
    const operation = this.queue.then(() => {
      assertIdentifier(runId, 'runId');
      assertConditionalOptions(options);
      assertIdentifier(options.idempotencyKey, 'idempotencyKey');
      const encodedEvent = this.codec.encode(event);
      const records = this.records.get(runId) ?? [];
      const currentTail = tailFromEncoded(records.at(-1));
      const existing = records.find((record) => record.idempotencyKey === options.idempotencyKey);
      if (existing !== undefined) {
        if (canonicalJsonString(existing.event) !== canonicalJsonString(encodedEvent)) {
          return Object.freeze({
            kind: 'rejected' as const,
            reason: 'idempotency_conflict' as const,
            tail: currentTail
          });
        }
        return Object.freeze({
          kind: 'already_committed' as const,
          receipt: receiptFromEncoded(existing),
          tail: currentTail
        });
      }
      if (!sameTail(options.expectedTail, currentTail)) {
        return Object.freeze({
          kind: 'rejected' as const,
          reason: 'stale_tail' as const,
          tail: currentTail
        });
      }
      if (
        options.driverGeneration !== currentTail.driverGeneration &&
        options.driverGeneration !== currentTail.driverGeneration + 1
      ) {
        return Object.freeze({
          kind: 'rejected' as const,
          reason: 'stale_driver' as const,
          tail: currentTail
        });
      }
      const previous = records.at(-1);
      const base = Object.freeze({
        eventId: randomUUID(),
        runId,
        sequence: records.length,
        timestamp: options.timestamp ?? new Date().toISOString(),
        schemaVersion: '1',
        actor: options.actor ?? inferActor(event.type),
        event: encodedEvent,
        ...(options.causationId ? { causationId: options.causationId } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        idempotencyKey: options.idempotencyKey,
        ...(previous ? { previousHash: previous.hash } : {}),
        driverGeneration: options.driverGeneration
      });
      const encodedEnvelope: EncodedEnvelope = Object.freeze({ ...base, hash: hashJson(base) });
      records.push(encodedEnvelope);
      this.records.set(runId, records);
      this.rememberType(runId, encodedEnvelope);
      const tail = tailFromEncoded(encodedEnvelope);
      return Object.freeze({
        kind: 'committed' as const,
        receipt: receiptFromEncoded(encodedEnvelope),
        tail
      });
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  tail(runId: string, _options?: EventIndexReadOptions): Promise<EventLedgerTail> {
    void _options;
    const operation = this.queue.then(() => {
      assertIdentifier(runId, 'runId');
      return tailFromEncoded(this.records.get(runId)?.at(-1));
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  latest(runId: string): Promise<EventEnvelope<TEvent> | undefined> {
    const operation = this.queue.then(() => {
      assertIdentifier(runId, 'runId');
      const encoded = this.records.get(runId)?.at(-1);
      return encoded === undefined
        ? undefined
        : envelopeFromEncoded(encoded, this.domainEvent(encoded));
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  latestOfType(runId: string, type: TEvent['type']): Promise<EventEnvelope<TEvent> | undefined> {
    const operation = this.queue.then(() => {
      assertIdentifier(runId, 'runId');
      assertIdentifier(type, 'type');
      const encoded = this.latestByType.get(runId)?.get(type);
      return encoded === undefined
        ? undefined
        : envelopeFromEncoded(encoded, this.domainEvent(encoded));
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  async latestReferenceOfType(
    runId: string,
    type: TEvent['type'],
    _options?: EventIndexReadOptions
  ): Promise<EventReference | undefined> {
    void _options;
    assertIdentifier(runId, 'runId');
    assertIdentifier(type, 'type');
    await this.queue;
    const record = this.latestByType.get(runId)?.get(type);
    return record
      ? Object.freeze({
          runId,
          eventId: record.eventId,
          sequence: record.sequence,
          hash: record.hash
        })
      : undefined;
  }

  async referenceByKey(runId: string, idempotencyKey: string, _options?: EventIndexReadOptions): Promise<EventReference | undefined> {
    void _options;
    assertIdentifier(runId, 'runId');
    assertIdentifier(idempotencyKey, 'idempotencyKey');
    await this.queue;
    const record = this.byKey.get(runId)?.get(idempotencyKey);
    return record
      ? Object.freeze({
          runId,
          eventId: record.eventId,
          sequence: record.sequence,
          hash: record.hash
        })
      : undefined;
  }

  async readReference(reference: EventReference): Promise<EventEnvelope<TEvent>> {
    assertEventReference(reference);
    reference = Object.freeze({ ...reference });
    await this.queue;
    const record = this.records.get(reference.runId)?.[reference.sequence];
    if (record?.eventId !== reference.eventId || record.hash !== reference.hash)
      throw new PersistenceConflictError('Event reference is missing or its identity changed.');
    return envelopeFromEncoded(record, this.domainEvent(record));
  }

  readRange(runId: string, request: EventRangeRequest = {}): Promise<EventRangePage<TEvent>> {
    return this.readRangePage(runId, request, false, (record) =>
      envelopeFromEncoded(record, this.domainEvent(record)));
  }

  readMetadataRange(runId: string, request: EventRangeRequest = {}): Promise<EventMetadataPage> {
    return this.readRangePage(runId, request, true, (_record, source) => source);
  }

  private async readRangePage<T>(
    runId: string,
    request: EventRangeRequest,
    metadataOnly: boolean,
    project: (record: EncodedEnvelope, source: EventSourceMetadata) => T
  ): Promise<EventPage<T>> {
    assertIdentifier(runId, 'runId');
    const { after, limit, maxBytes, through, types, metadata, afterTime, beforeTime } = eventRangeBounds(request);
    await this.queue;
    const stored = this.records.get(runId) ?? [];
    const tail = through
      ? tailFromEncoded(stored[through.sequence])
      : tailFromEncoded(stored.at(-1));
    if (
      through &&
      (through.sequence !== tail.sequence ||
        through.hash !== tail.hash ||
        (through.driverGeneration !== undefined &&
          through.driverGeneration !== tail.driverGeneration))
    )
      throw new PersistenceConflictError(
        'Event range boundary is missing or its identity changed.'
      );
    if (after > tail.sequence) throw new RangeError('Event range starts beyond its boundary.');
    const records: T[] = [];
    let nextSequence = after,
      scanned = 0,
      bytes = 0;
    const routeKey = metadataOnly ? eventMetadataRouteKey(this.metadataIndexes, types, metadata) : undefined;
    const candidates = routeKey ? this.metadataRoutes.get(runId)?.get(routeKey) ?? [] : undefined;
    let candidateAt = candidates ? firstSequenceAfter(candidates, after) : 0;
    let oversized: EventRangePage<TEvent>['oversized'];
    while (nextSequence < tail.sequence && scanned < limit) {
      const sequence = candidates ? candidates[candidateAt++] : nextSequence + 1;
      if (sequence === undefined || sequence > tail.sequence) { nextSequence = tail.sequence; break; }
      const record = stored[sequence];
      if (!record) throw new PersistenceConflictError('Event sequence is missing.');
      const source = this.routing.get(record);
      if (!source) throw new PersistenceConflictError('Event routing metadata is missing.');
      if (
        (!types || types.some(type => type === record.event.type)) &&
        (!afterTime || Date.parse(record.timestamp) >= Date.parse(afterTime)) &&
        (!beforeTime || Date.parse(record.timestamp) < Date.parse(beforeTime)) &&
        matchesEventMetadata(source.metadata, metadata)
      ) {
        const size = metadataOnly ? Buffer.byteLength(canonicalJsonString(source)) : source.bytes;
        if (bytes + size > maxBytes) {
          if (size > maxBytes)
            oversized = {
              reference: {
                runId,
                eventId: record.eventId,
                sequence: record.sequence,
                hash: record.hash
              },
              bytes: size
            };
          break;
        }
        records.push(project(record, source));
        bytes += size;
      }
      nextSequence = sequence;
      scanned++;
    }
    return Object.freeze({
      records: Object.freeze(records),
      tail,
      nextSequence,
      complete: nextSequence === tail.sequence,
      scanned,
      bytes,
      ...(oversized ? { oversized: Object.freeze(oversized) } : {})
    });
  }

  async *read(runId: string): AsyncIterable<EventEnvelope<TEvent>> {
    await Promise.resolve();
    for (const record of this.records.get(runId) ?? [])
      yield envelopeFromEncoded(record, this.domainEvent(record));
  }
  listRunIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.records.keys()].sort());
  }
  verifyIntegrity(runId: string): Promise<LedgerIntegrityReport> {
    let previousHash: string | undefined;
    const errors: string[] = [];
    const records = this.records.get(runId) ?? [];
    for (const [index, encoded] of records.entries()) {
      try {
        this.domainEvent(encoded);
        if (encoded.runId !== runId)
          errors.push(`runId mismatch at sequence ${String(encoded.sequence)}`);
        if (encoded.sequence !== index) errors.push(`sequence mismatch at index ${String(index)}`);
        if (encoded.previousHash !== previousHash)
          errors.push(`previousHash mismatch at sequence ${String(encoded.sequence)}`);
        const { hash, ...base } = encoded;
        if (hash !== hashJson(base))
          errors.push(`hash mismatch at sequence ${String(encoded.sequence)}`);
        previousHash = encoded.hash;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return Promise.resolve({ ok: errors.length === 0, records: records.length, errors });
  }

  private domainEvent(record: EncodedEnvelope): TEvent {
    const cached = this.decoded.get(record);
    if (cached) return cached;
    const event = this.codec.decode(record.event);
    this.decoded.set(record, event);
    return event;
  }

  private rememberType(runId: string, encoded: EncodedEnvelope): void {
    const type = encoded.event.type;
    if (typeof type !== 'string') throw new TypeError('Encoded event type is invalid.');
    this.routing.set(encoded, Object.freeze({
      reference: Object.freeze({ runId, eventId: encoded.eventId, sequence: encoded.sequence, hash: encoded.hash }),
      type,
      timestamp: encoded.timestamp,
      bytes: Buffer.byteLength(canonicalJsonString(encoded)) + 1,
      metadata: parseEventMetadata(this.codec.metadata?.(this.domainEvent(encoded)) ?? {})
    }));
    for (const routeKey of eventMetadataRouteKeys(this.metadataIndexes, type, this.routing.get(encoded)?.metadata ?? {})) {
      const routes = this.metadataRoutes.get(runId) ?? new Map<string, number[]>();
      const sequences = routes.get(routeKey) ?? [];
      sequences.push(encoded.sequence);
      routes.set(routeKey, sequences);
      this.metadataRoutes.set(runId, routes);
    }
    if (encoded.idempotencyKey) {
      const keys = this.byKey.get(runId) ?? new Map<string, EncodedEnvelope>();
      keys.set(encoded.idempotencyKey, encoded);
      this.byKey.set(runId, keys);
    }
    const index = this.latestByType.get(runId) ?? new Map<string, EncodedEnvelope>();
    index.set(type, encoded);
    this.latestByType.set(runId, index);
  }
}

export const typedEventCodec: RuntimeCodec<TypedEvent> = {
  encode(value: TypedEvent) {
    const json = parseJsonObject(value, EVENT_LIMITS);
    if (typeof json.type !== 'string' || json.type.length === 0)
      throw new Error('Event must have a non-empty type.');
    return json;
  },
  decode(value: unknown): TypedEvent {
    const object = parseJsonObject(value, EVENT_LIMITS);
    if (typeof object.type !== 'string' || object.type.length === 0)
      throw new Error('Event must have a non-empty type.');
    return Object.freeze({ ...object, type: object.type });
  }
};

const EVENT_LIMITS = {
  maxDepth: 64,
  maxCollectionEntries: 50_000,
  maxStringBytes: 1_000_000,
  maxTotalBytes: 8_000_000
} as const;

function envelopeFromEncoded<TEvent extends TypedEvent>(
  encoded: EncodedEnvelope,
  event: TEvent
): EventEnvelope<TEvent> {
  return Object.freeze({
    eventId: encoded.eventId,
    runId: encoded.runId,
    sequence: encoded.sequence,
    timestamp: encoded.timestamp,
    schemaVersion: encoded.schemaVersion,
    actor: encoded.actor,
    ...(encoded.causationId ? { causationId: encoded.causationId } : {}),
    ...(encoded.correlationId ? { correlationId: encoded.correlationId } : {}),
    ...(encoded.idempotencyKey ? { idempotencyKey: encoded.idempotencyKey } : {}),
    ...(encoded.previousHash ? { previousHash: encoded.previousHash } : {}),
    hash: encoded.hash,
    driverGeneration: encoded.driverGeneration,
    event
  });
}

function receiptFromEncoded(encoded: EncodedEnvelope): EventAppendReceipt {
  return Object.freeze({
    eventId: encoded.eventId,
    runId: encoded.runId,
    sequence: encoded.sequence,
    timestamp: encoded.timestamp,
    schemaVersion: encoded.schemaVersion,
    actor: encoded.actor,
    hash: encoded.hash,
    driverGeneration: encoded.driverGeneration,
    ...(encoded.causationId ? { causationId: encoded.causationId } : {}),
    ...(encoded.correlationId ? { correlationId: encoded.correlationId } : {}),
    ...(encoded.idempotencyKey ? { idempotencyKey: encoded.idempotencyKey } : {}),
    ...(encoded.previousHash ? { previousHash: encoded.previousHash } : {})
  });
}

function tailFromEncoded(encoded: EncodedEnvelope | undefined): EventLedgerTail {
  return Object.freeze(
    encoded === undefined
      ? { sequence: -1, driverGeneration: 0 }
      : {
          sequence: encoded.sequence,
          hash: encoded.hash,
          driverGeneration: encoded.driverGeneration
        }
  );
}

function sameTail(left: EventLedgerTail, right: EventLedgerTail): boolean {
  return (
    left.sequence === right.sequence &&
    left.hash === right.hash &&
    left.driverGeneration === right.driverGeneration
  );
}

function assertConditionalOptions(options: unknown): void {
  if (
    !isRecord(options) ||
    typeof options.idempotencyKey !== 'string' ||
    !isRecord(options.expectedTail)
  ) {
    throw new TypeError('Conditional event append options are invalid.');
  }
  const expected = options.expectedTail;
  if (
    !Number.isSafeInteger(expected.sequence) ||
    typeof expected.sequence !== 'number' ||
    expected.sequence < -1 ||
    !Number.isSafeInteger(expected.driverGeneration) ||
    typeof expected.driverGeneration !== 'number' ||
    expected.driverGeneration < 0 ||
    (expected.sequence === -1 ? expected.hash !== undefined : typeof expected.hash !== 'string') ||
    !Number.isSafeInteger(options.driverGeneration) ||
    typeof options.driverGeneration !== 'number' ||
    options.driverGeneration < 0 ||
    (options.actor !== undefined && !isEventActor(options.actor)) ||
    !optionalStringFields(options, ['causationId', 'correlationId', 'timestamp'])
  ) {
    throw new TypeError('Conditional event append options are invalid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalStringFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => record[field] === undefined || typeof record[field] === 'string');
}
function isEventActor(value: unknown): value is EventActor {
  return (
    value === 'user' ||
    value === 'runtime' ||
    value === 'model' ||
    value === 'tool' ||
    value === 'system' ||
    value === 'check'
  );
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) throw new Error(`${name} is invalid.`);
}
function inferActor(type: string): EventActor {
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('check.')) return 'check';
  if (type.startsWith('input.')) return 'user';
  return 'runtime';
}

/** Lower bound in an ordered derived sequence index. */
export function firstSequenceAfter(sequences: readonly number[], after: number): number {
  let low = 0, high = sequences.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((sequences[middle] ?? Infinity) <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Capture a small immutable index declaration at the codec boundary. */
export function ownEventMetadataIndexes(indexes: readonly EventMetadataIndex[] = []): readonly EventMetadataIndex[] {
  if (!Array.isArray(indexes) || indexes.length > 16) throw new TypeError('Invalid event metadata indexes.');
  const seen = new Set<string>();
  return Object.freeze(indexes.map((value) => {
    const index = parseJsonObject(value, { maxTotalBytes: 16384, maxCollectionEntries: 64, maxStringBytes: 4096 });
    if (Object.keys(index).some(key => !['type', 'field', 'metadata'].includes(key)) ||
        (index.type !== undefined && (typeof index.type !== 'string' || !index.type.length)) ||
        (index.field === undefined) === (index.metadata === undefined))
      throw new TypeError('Invalid event metadata index.');
    const key = canonicalJsonString(index);
    if (seen.has(key)) throw new TypeError('Duplicate event metadata index.');
    seen.add(key);
    const type = typeof index.type === 'string' ? { type: index.type } : {};
    if (index.field !== undefined) {
      if (typeof index.field !== 'string' || !index.field.length) throw new TypeError('Invalid indexed metadata field.');
      return Object.freeze({ ...type, field: index.field });
    }
    const metadata = parseEventMetadata(index.metadata);
    if (!Object.keys(metadata).length) throw new TypeError('An indexed metadata predicate cannot be empty.');
    return Object.freeze({ ...type, metadata });
  }));
}

function metadataIndexKey(index: EventMetadataIndex, metadata: Readonly<Record<string, string>>): string | undefined {
  if ('field' in index) {
    const value = metadata[index.field];
    return value === undefined ? undefined : canonicalJsonString({ index, value });
  }
  return matchesEventMetadata(metadata, index.metadata) ? canonicalJsonString({ index }) : undefined;
}

export function eventMetadataRouteKey(indexes: readonly EventMetadataIndex[], types?: readonly string[], metadata?: Readonly<Record<string, string>>): string | undefined {
  for (const index of indexes) {
    if (index.type && (types?.length !== 1 || types[0] !== index.type)) continue;
    const key = metadataIndexKey(index, metadata ?? {});
    if (key !== undefined) return key;
  }
  return undefined;
}

export function eventMetadataRouteKeys(indexes: readonly EventMetadataIndex[], type: string, metadata: Readonly<Record<string, string>>): readonly string[] {
  return indexes.flatMap(index => {
    if (index.type && index.type !== type) return [];
    const key = metadataIndexKey(index, metadata);
    return key === undefined ? [] : [key];
  });
}

export function fixedEventMetadataRouteKeys(indexes: readonly EventMetadataIndex[]): readonly string[] {
  return indexes.flatMap(index => 'metadata' in index ? [canonicalJsonString({ index })] : []);
}
