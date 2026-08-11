import { randomUUID } from 'node:crypto';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { AppendEventOptions, EventActor, EventEnvelope, LedgerIntegrityReport, TypedEvent } from './ledger.js';
import { hashJson, canonicalJsonString } from './ledger.js';

export interface RuntimeCodec<T> {
  readonly name: string;
  decode(value: unknown): T & JsonObject;
}

export interface EventAppendOptions extends AppendEventOptions { readonly idempotencyKey?: string }

export interface EventRepository<TEvent extends TypedEvent> {
  append(runId: string, event: TEvent, options?: EventAppendOptions): Promise<EventEnvelope<TEvent>>;
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
  private readonly records = new Map<string, EventEnvelope<TEvent>[]>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly codec: RuntimeCodec<TEvent>) {}

  append(runId: string, event: TEvent, options: EventAppendOptions = {}): Promise<EventEnvelope<TEvent>> {
    const operation = this.queue.then(() => {
      assertIdentifier(runId, 'runId');
      const parsed = this.codec.decode(event);
      const records = this.records.get(runId) ?? [];
      const idempotencyKey = options.idempotencyKey;
      const existing = idempotencyKey ? records.find((record) => record.idempotencyKey === idempotencyKey) : undefined;
      if (existing && idempotencyKey) {
        if (canonicalJsonString(existing.event) !== canonicalJsonString(parsed)) throw new PersistenceConflictError(`Conflicting event for ${idempotencyKey}.`);
        return existing;
      }
      const previous = records.at(-1);
      const base: Omit<EventEnvelope<TEvent>, 'hash'> & { idempotencyKey?: string } = Object.freeze({
        eventId: randomUUID(), runId, sequence: records.length, timestamp: options.timestamp ?? new Date().toISOString(),
        schemaVersion: '1', actor: options.actor ?? inferActor(parsed.type), event: parsed,
        ...(options.causationId ? { causationId: options.causationId } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(previous ? { previousHash: previous.hash } : {})
      });
      const envelope: EventEnvelope<TEvent> = Object.freeze({ ...base, hash: hashJson(base) });
      records.push(envelope);
      this.records.set(runId, records);
      return envelope;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async *read(runId: string): AsyncIterable<EventEnvelope<TEvent>> { await Promise.resolve(); yield* [...(this.records.get(runId) ?? [])]; }
  listRunIds(): Promise<readonly string[]> { return Promise.resolve([...this.records.keys()].sort()); }
  verifyIntegrity(runId: string): Promise<LedgerIntegrityReport> {
    let previousHash: string | undefined;
    const errors: string[] = [];
    const records = this.records.get(runId) ?? [];
    for (const [index, record] of records.entries()) {
      if (record.sequence !== index) errors.push(`sequence mismatch at index ${String(index)}`);
      if (record.previousHash !== previousHash) errors.push(`previousHash mismatch at sequence ${String(record.sequence)}`);
      const { hash, ...base } = record;
      if (hash !== hashJson(base)) errors.push(`hash mismatch at sequence ${String(record.sequence)}`);
      previousHash = record.hash;
    }
    return Promise.resolve({ ok: errors.length === 0, records: records.length, errors });
  }
}

export const typedEventCodec: RuntimeCodec<TypedEvent> = {
  name: 'TypedEvent',
  decode(value: unknown): TypedEvent & JsonObject {
    const object = parseJsonObject(value, { maxDepth: 64, maxCollectionEntries: 50_000, maxStringBytes: 1_000_000, maxTotalBytes: 8_000_000 });
    if (typeof object.type !== 'string' || object.type.length === 0) throw new Error('Event must have a non-empty type.');
    return Object.freeze({ ...object, type: object.type });
  }
};

function assertIdentifier(value: string, name: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) throw new Error(`${name} is invalid.`); }
function inferActor(type: string): EventActor {
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('check.')) return 'check';
  if (type.startsWith('input.')) return 'user';
  return 'runtime';
}
