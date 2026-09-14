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
}
export interface EventRangePage<TEvent extends TypedEvent> {
  readonly records: readonly EventEnvelope<TEvent>[];
  readonly tail: EventLedgerTail;
  /** Last scanned sequence; use as the next request's afterSequence. */
  readonly nextSequence: number;
  readonly complete: boolean;
  readonly scanned: number;
  readonly bytes: number;
  readonly oversized?: Readonly<{ reference: EventReference; bytes: number }>;
}

export function eventRangeBounds(request: EventRangeRequest): {
  after: number;
  limit: number;
  maxBytes: number;
  through?: NonNullable<EventRangeRequest['through']>;
  types?: readonly string[];
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
  return Object.freeze({
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
  tail(runId: string): Promise<EventLedgerTail>;
  latest(runId: string): Promise<EventEnvelope<TEvent> | undefined>;
  latestOfType(runId: string, type: TEvent['type']): Promise<EventEnvelope<TEvent> | undefined>;
  latestReferenceOfType(runId: string, type: TEvent['type']): Promise<EventReference | undefined>;
  referenceByKey(runId: string, idempotencyKey: string): Promise<EventReference | undefined>;
  readReference(reference: EventReference): Promise<EventEnvelope<TEvent>>;
  readRange(runId: string, request?: EventRangeRequest): Promise<EventRangePage<TEvent>>;
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

export class InMemoryEventRepository<TEvent extends TypedEvent> implements EventRepository<TEvent> {
  private readonly records = new Map<string, EncodedEnvelope[]>();
  private readonly byKey = new Map<string, Map<string, EncodedEnvelope>>();
  private readonly latestByType = new Map<string, Map<string, EncodedEnvelope>>();
  private readonly decoded = new WeakMap<EncodedEnvelope, TEvent>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly codec: RuntimeCodec<TEvent>) {}

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

  tail(runId: string): Promise<EventLedgerTail> {
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
    type: TEvent['type']
  ): Promise<EventReference | undefined> {
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

  async referenceByKey(runId: string, idempotencyKey: string): Promise<EventReference | undefined> {
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

  async readRange(runId: string, request: EventRangeRequest = {}): Promise<EventRangePage<TEvent>> {
    assertIdentifier(runId, 'runId');
    const { after, limit, maxBytes, through, types } = eventRangeBounds(request);
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
    const records: EventEnvelope<TEvent>[] = [];
    let nextSequence = after,
      scanned = 0,
      bytes = 0;
    let oversized: EventRangePage<TEvent>['oversized'];
    while (nextSequence < tail.sequence && scanned < limit) {
      const record = stored[nextSequence + 1];
      if (!record) throw new PersistenceConflictError('Event sequence is missing.');
      if (!types || types.some((type) => type === record.event.type)) {
        const size = Buffer.byteLength(canonicalJsonString(record)) + 1;
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
        records.push(envelopeFromEncoded(record, this.domainEvent(record)));
        bytes += size;
      }
      nextSequence++;
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
    if (encoded.idempotencyKey) {
      const keys = this.byKey.get(runId) ?? new Map<string, EncodedEnvelope>();
      keys.set(encoded.idempotencyKey, encoded);
      this.byKey.set(runId, keys);
    }
    const type = encoded.event.type;
    if (typeof type !== 'string') throw new TypeError('Encoded event type is invalid.');
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
