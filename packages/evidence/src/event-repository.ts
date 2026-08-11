import { randomUUID } from 'node:crypto';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { AppendEventOptions, EventActor, EventAppendReceipt, EventEnvelope, LedgerIntegrityReport, TypedEvent } from './ledger.js';
import { hashJson, canonicalJsonString } from './ledger.js';

export interface RuntimeCodec<T> {
  encode(value: T): JsonObject;
  decode(value: unknown): T;
}

export interface EventAppendOptions extends AppendEventOptions { readonly idempotencyKey?: string }

interface EncodedEnvelope extends JsonObject {
  readonly eventId: string; readonly runId: string; readonly sequence: number; readonly timestamp: string;
  readonly schemaVersion: string; readonly actor: EventActor; readonly event: JsonObject; readonly hash: string;
  readonly causationId?: string; readonly correlationId?: string; readonly idempotencyKey?: string; readonly previousHash?: string;
}

export interface EventRepository<TEvent extends TypedEvent> {
  append(runId: string, event: TEvent, options?: EventAppendOptions): Promise<EventAppendReceipt>;
  read(runId: string): AsyncIterable<EventEnvelope<TEvent>>;
  listRunIds(): Promise<readonly string[]>;
  verifyIntegrity(runId: string): Promise<LedgerIntegrityReport>;
}

export class PersistenceCorruptionError extends Error {
  readonly code: 'invalid_json' | 'invalid_header' | 'invalid_record' | 'integrity';
  readonly storage: string;
  readonly line: number;
  readonly byteOffset: number;
  constructor(input: { code: PersistenceCorruptionError['code']; storage: string; line: number; byteOffset: number; message: string }) {
    super(`${input.message} (${input.storage}, line ${String(input.line)}, byte ${String(input.byteOffset)})`);
    this.name = 'PersistenceCorruptionError';
    this.code = input.code;
    this.storage = input.storage;
    this.line = input.line;
    this.byteOffset = input.byteOffset;
  }
}

export class PersistenceConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'PersistenceConflictError'; }
}

export class InMemoryEventRepository<TEvent extends TypedEvent> implements EventRepository<TEvent> {
  private readonly records = new Map<string, EncodedEnvelope[]>();
  private readonly decoded = new WeakMap<EncodedEnvelope, TEvent>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly codec: RuntimeCodec<TEvent>) {}

  append(runId: string, event: TEvent, options: EventAppendOptions = {}): Promise<EventAppendReceipt> {
    const operation = this.queue.then(() => {
      assertIdentifier(runId, 'runId');
      const encodedEvent = this.codec.encode(event);
      const records = this.records.get(runId) ?? [];
      const idempotencyKey = options.idempotencyKey;
      const existing = idempotencyKey ? records.find((record) => record.idempotencyKey === idempotencyKey) : undefined;
      if (existing && idempotencyKey) {
        if (canonicalJsonString(existing.event) !== canonicalJsonString(encodedEvent)) throw new PersistenceConflictError(`Conflicting event for ${idempotencyKey}.`);
        return receiptFromEncoded(existing);
      }
      const previous = records.at(-1);
      const base = Object.freeze({
        eventId: randomUUID(), runId, sequence: records.length, timestamp: options.timestamp ?? new Date().toISOString(),
        schemaVersion: '1', actor: options.actor ?? inferActor(event.type), event: encodedEvent,
        ...(options.causationId ? { causationId: options.causationId } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(previous ? { previousHash: previous.hash } : {})
      });
      const encodedEnvelope: EncodedEnvelope = Object.freeze({ ...base, hash: hashJson(base) });
      records.push(encodedEnvelope);
      this.records.set(runId, records);
      return receiptFromEncoded(encodedEnvelope);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async *read(runId: string): AsyncIterable<EventEnvelope<TEvent>> {
    await Promise.resolve();
    for (const record of this.records.get(runId) ?? []) yield envelopeFromEncoded(record, this.domainEvent(record));
  }
  listRunIds(): Promise<readonly string[]> { return Promise.resolve([...this.records.keys()].sort()); }
  verifyIntegrity(runId: string): Promise<LedgerIntegrityReport> {
    let previousHash: string | undefined;
    const errors: string[] = [];
    const records = this.records.get(runId) ?? [];
    for (const [index, encoded] of records.entries()) {
      try {
        this.domainEvent(encoded);
        if (encoded.runId !== runId) errors.push(`runId mismatch at sequence ${String(encoded.sequence)}`);
        if (encoded.sequence !== index) errors.push(`sequence mismatch at index ${String(index)}`);
        if (encoded.previousHash !== previousHash) errors.push(`previousHash mismatch at sequence ${String(encoded.sequence)}`);
        const { hash, ...base } = encoded;
        if (hash !== hashJson(base)) errors.push(`hash mismatch at sequence ${String(encoded.sequence)}`);
        previousHash = encoded.hash;
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
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
}

export const typedEventCodec: RuntimeCodec<TypedEvent> = {
  encode(value: TypedEvent) {
    const json = parseJsonObject(value, EVENT_LIMITS);
    if (typeof json.type !== 'string' || json.type.length === 0) throw new Error('Event must have a non-empty type.');
    return json;
  },
  decode(value: unknown): TypedEvent {
    const object = parseJsonObject(value, EVENT_LIMITS);
    if (typeof object.type !== 'string' || object.type.length === 0) throw new Error('Event must have a non-empty type.');
    return Object.freeze({ ...object, type: object.type });
  }
};

const EVENT_LIMITS = { maxDepth: 64, maxCollectionEntries: 50_000, maxStringBytes: 1_000_000, maxTotalBytes: 8_000_000 } as const;

function envelopeFromEncoded<TEvent extends TypedEvent>(encoded: EncodedEnvelope, event: TEvent): EventEnvelope<TEvent> {
  return Object.freeze({
    eventId: encoded.eventId, runId: encoded.runId, sequence: encoded.sequence,
    timestamp: encoded.timestamp, schemaVersion: encoded.schemaVersion, actor: encoded.actor,
    ...(encoded.causationId ? { causationId: encoded.causationId } : {}),
    ...(encoded.correlationId ? { correlationId: encoded.correlationId } : {}),
    ...(encoded.idempotencyKey ? { idempotencyKey: encoded.idempotencyKey } : {}),
    ...(encoded.previousHash ? { previousHash: encoded.previousHash } : {}),
    hash: encoded.hash, event
  });
}

function receiptFromEncoded(encoded: EncodedEnvelope): EventAppendReceipt {
  return Object.freeze({
    eventId: encoded.eventId, runId: encoded.runId, sequence: encoded.sequence, timestamp: encoded.timestamp,
    schemaVersion: encoded.schemaVersion, actor: encoded.actor, hash: encoded.hash,
    ...(encoded.causationId ? { causationId: encoded.causationId } : {}), ...(encoded.correlationId ? { correlationId: encoded.correlationId } : {}),
    ...(encoded.idempotencyKey ? { idempotencyKey: encoded.idempotencyKey } : {}), ...(encoded.previousHash ? { previousHash: encoded.previousHash } : {})
  });
}

function assertIdentifier(value: string, name: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) throw new Error(`${name} is invalid.`); }
function inferActor(type: string): EventActor {
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('check.')) return 'check';
  if (type.startsWith('input.')) return 'user';
  return 'runtime';
}
