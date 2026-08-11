import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { EventActor, EventAppendReceipt, EventEnvelope, LedgerIntegrityReport, TypedEvent } from './ledger.js';
import { hashJson, canonicalJsonString } from './ledger.js';
import {
  PersistenceConflictError,
  PersistenceCorruptionError,
  type EventAppendOptions,
  type EventRepository,
  type RuntimeCodec
} from './event-repository.js';
import {
  appendJsonlRecord,
  jsonlBoundaryMarker,
  jsonlStorageStamp,
  readJsonlBytes,
  readJsonlCommittedFile,
  sameJsonlStorageStamp,
  splitJsonlLines,
  type JsonlLine,
  type JsonlStorageStamp
} from './jsonl.js';

export interface EventStreamHeader {
  readonly type: 'event_stream';
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
}

export interface JsonlEventRepositoryOptions<TEvent extends TypedEvent> {
  readonly rootDir: string;
  readonly codec: RuntimeCodec<TEvent>;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

export class JsonlEventRepository<TEvent extends TypedEvent> implements EventRepository<TEvent> {
  private readonly rootDir: string;
  private readonly codec: RuntimeCodec<TEvent>;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly indexes = new Map<string, EventAppendIndex>();
  private fullScans = 0;
  private incrementalRefreshes = 0;

  constructor(options: JsonlEventRepositoryOptions<TEvent>) {
    this.rootDir = path.resolve(options.rootDir);
    this.codec = options.codec;
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 5_000, 'lockTimeoutMs');
    this.staleLockMs = positiveInteger(options.staleLockMs ?? 30_000, 'staleLockMs');
  }

  location(runId: string): string {
    return this.filePath(runId);
  }

  indexMetrics(): Readonly<{ fullScans: number; incrementalRefreshes: number }> {
    return Object.freeze({ fullScans: this.fullScans, incrementalRefreshes: this.incrementalRefreshes });
  }

  append(runId: string, event: TEvent, options: EventAppendOptions = {}): Promise<EventAppendReceipt> {
    return this.enqueue(runId, async () => withPersistenceFileLock(this.filePath(runId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const encodedEvent = this.codec.encode(event);
      await this.ensureHeader(runId);
      const index = await this.refreshIndex(runId, true);
      const records = index.records;
      if (options.idempotencyKey) {
        const existing = records.find((record) => record.idempotencyKey === options.idempotencyKey);
        if (existing) {
          if (canonicalJsonString(existing.event) !== canonicalJsonString(encodedEvent)) {
            throw new PersistenceConflictError(`Idempotency key ${options.idempotencyKey} already identifies a different event.`);
          }
          return receiptFromEncoded(existing);
        }
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
        ...(previous ? { previousHash: previous.hash } : {})
      });
      const encodedEnvelope: EncodedEnvelope = Object.freeze({ ...base, hash: hashJson(base) });
      await appendJsonlRecord(this.filePath(runId), encodedEnvelope);
      records.push(encodedEnvelope);
      index.completeBytes += Buffer.byteLength(`${canonicalJsonString(encodedEnvelope)}\n`, 'utf8');
      index.boundaryMarker = await jsonlBoundaryMarker(this.filePath(runId), index.completeBytes);
      index.storageStamp = await jsonlStorageStamp(this.filePath(runId));
      return receiptFromEncoded(encodedEnvelope);
    }));
  }

  async *read(runId: string): AsyncIterable<EventEnvelope<TEvent>> {
    const records = await this.enqueue(runId, async () => {
      try { return [...(await this.refreshIndex(runId, false)).records]; }
      catch (error) { if (nodeCode(error) === 'ENOENT') return []; throw error; }
    });
    for (const record of records) yield domainEnvelope(record, this.codec.decode(record.event));
  }

  async listRunIds(): Promise<readonly string[]> {
    try {
      return (await fs.readdir(this.rootDir))
        .flatMap((name) => /^run-(.+)\.jsonl$/u.exec(name)?.[1] ?? [])
        .sort();
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  async verifyIntegrity(runId: string): Promise<LedgerIntegrityReport> {
    const errors: string[] = [];
    let records = 0;
    let previousHash: string | undefined;
    try {
      for (const record of (await this.refreshIndex(runId, false)).records) {
        this.codec.decode(record.event);
        if (record.sequence !== records) errors.push(`sequence mismatch at index ${String(records)}: got ${String(record.sequence)}`);
        if (record.previousHash !== previousHash) errors.push(`previousHash mismatch at sequence ${String(record.sequence)}`);
        const { hash, ...base } = record;
        if (hash !== hashJson(base)) errors.push(`hash mismatch at sequence ${String(record.sequence)}`);
        previousHash = record.hash;
        records += 1;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { ok: errors.length === 0, records, errors };
  }

  private filePath(runId: string): string {
    assertIdentifier(runId, 'runId');
    return path.join(this.rootDir, `run-${runId}.jsonl`);
  }

  private async ensureHeader(runId: string): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const filePath = this.filePath(runId);
    try {
      await fs.writeFile(filePath, `${JSON.stringify({ type: 'event_stream', version: 1, runId, createdAt: new Date().toISOString() } satisfies EventStreamHeader)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
    }
  }

  private async refreshIndex(runId: string, repairTornTail: boolean): Promise<EventAppendIndex> {
    const filePath = this.filePath(runId);
    let index = this.indexes.get(runId);
    if (!index) {
      const committed = await readEventFile(filePath, runId);
      const records = committed.records;
      this.fullScans += 1;
      validateEnvelopeChain(records, filePath);
      const completeBytes = committed.completeBytes;
      index = { records, completeBytes, boundaryMarker: await jsonlBoundaryMarker(filePath, completeBytes), storageStamp: await jsonlStorageStamp(filePath) };
      this.indexes.set(runId, index);
      const size = (await fs.stat(filePath)).size;
      if (repairTornTail && size > index.completeBytes) { await fs.truncate(filePath, index.completeBytes); index.storageStamp = await jsonlStorageStamp(filePath); }
      return index;
    }
    const stamp = await jsonlStorageStamp(filePath);
    const size = stamp.size;
    if (size < index.completeBytes) throw new PersistenceCorruptionError({ code: 'integrity', storage: filePath, line: index.records.length + 2, byteOffset: size, message: 'Event stream was truncated after it was indexed.' });
    if (size === index.completeBytes && sameJsonlStorageStamp(stamp, index.storageStamp)) return index;
    if (size === index.completeBytes || await jsonlBoundaryMarker(filePath, index.completeBytes) !== index.boundaryMarker) {
      const committed = await readEventFile(filePath, runId);
      const records = committed.records;
      this.fullScans += 1;
      validateEnvelopeChain(records, filePath);
      index.records.splice(0, index.records.length, ...records);
      index.completeBytes = committed.completeBytes;
      index.boundaryMarker = await jsonlBoundaryMarker(filePath, index.completeBytes);
      if (repairTornTail && size > index.completeBytes) await fs.truncate(filePath, index.completeBytes);
      index.storageStamp = await jsonlStorageStamp(filePath);
      return index;
    }
    const bytes = await readJsonlBytes(filePath, index.completeBytes, size - index.completeBytes);
    const lines = splitJsonlLines(bytes, index.records.length + 2, index.completeBytes);
    let consumed = 0;
    for (const line of lines) {
      consumed = line.byteOffset - index.completeBytes + Buffer.byteLength(line.text, 'utf8') + 1;
      if (line.text.trim().length === 0) continue;
      const located = { ...line, line: index.records.length + 2 };
      let raw: unknown;
      try { raw = JSON.parse(line.text); } catch (error) { throw corruption('invalid_json', filePath, located, `Invalid JSON: ${errorMessage(error)}`); }
      let envelope: EncodedEnvelope;
      try { envelope = parseEnvelope(raw, runId); } catch (error) { throw corruption('invalid_record', filePath, located, errorMessage(error)); }
      validateNextEnvelope(index.records.at(-1), envelope, index.records.length, filePath, located);
      index.records.push(envelope);
    }
    index.completeBytes += consumed;
    index.boundaryMarker = await jsonlBoundaryMarker(filePath, index.completeBytes);
    this.incrementalRefreshes += 1;
    if (repairTornTail && size > index.completeBytes) await fs.truncate(filePath, index.completeBytes);
    index.storageStamp = await jsonlStorageStamp(filePath);
    return index;
  }

  private enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(runId, tail);
    void tail.finally(() => { if (this.queues.get(runId) === tail) this.queues.delete(runId); });
    return result;
  }
}

interface EventAppendIndex { readonly records: EncodedEnvelope[]; completeBytes: number; boundaryMarker: string; storageStamp: JsonlStorageStamp }

interface EncodedEnvelope extends JsonObject {
  readonly eventId: string; readonly runId: string; readonly sequence: number; readonly timestamp: string; readonly schemaVersion: '1'; readonly actor: EventActor;
  readonly causationId?: string; readonly correlationId?: string; readonly idempotencyKey?: string; readonly previousHash?: string; readonly hash: string; readonly event: JsonObject;
}

async function readEventFile(
  filePath: string,
  runId: string,
  missingIsEmpty = false
): Promise<{ readonly records: EncodedEnvelope[]; readonly completeBytes: number }> {
  let committed;
  try { committed = await readJsonlCommittedFile(filePath); }
  catch (error) { if (missingIsEmpty && nodeCode(error) === 'ENOENT') return { records: [], completeBytes: 0 }; throw error; }
  const lines = committed.lines;
  if (lines.length === 0) return { records: [], completeBytes: committed.completeBytes };
  const headerLine = lines[0];
  if (headerLine === undefined) return { records: [], completeBytes: committed.completeBytes };
  const header = parseLine(headerLine, filePath);
  if (!isEventHeader(header, runId)) throw corruption('invalid_header', filePath, headerLine, 'Event stream header is invalid.');
  const output: EncodedEnvelope[] = [];
  for (const line of lines.slice(1)) {
    if (line.text.trim().length === 0) continue;
    let raw: unknown;
    try { raw = JSON.parse(line.text); }
    catch (error) { throw corruption('invalid_json', filePath, line, `Invalid JSON: ${errorMessage(error)}`); }
    try { output.push(parseEnvelope(raw, runId)); }
    catch (error) { throw corruption('invalid_record', filePath, line, errorMessage(error)); }
  }
  return { records: output, completeBytes: committed.completeBytes };
}

function parseEnvelope(value: unknown, runId: string): EncodedEnvelope {
  const record = parseJsonObject(value, { maxDepth: 66, maxCollectionEntries: 50_020, maxStringBytes: 1_000_000, maxTotalBytes: 8_000_000 });
  if (typeof record.eventId !== 'string' || record.runId !== runId || !nonnegativeInteger(record.sequence)
    || typeof record.timestamp !== 'string' || record.schemaVersion !== '1' || !isEventActor(record.actor)
    || typeof record.hash !== 'string' || !jsonObject(record.event)) throw new Error('Event envelope fields are invalid.');
  if (record.causationId !== undefined && typeof record.causationId !== 'string') throw new Error('causationId is invalid.');
  if (record.correlationId !== undefined && typeof record.correlationId !== 'string') throw new Error('correlationId is invalid.');
  if (record.previousHash !== undefined && typeof record.previousHash !== 'string') throw new Error('previousHash is invalid.');
  if (record.idempotencyKey !== undefined && typeof record.idempotencyKey !== 'string') throw new Error('idempotencyKey is invalid.');
  return Object.freeze({
    eventId: record.eventId,
    runId,
    sequence: record.sequence,
    timestamp: record.timestamp,
    schemaVersion: '1',
    actor: record.actor,
    ...(record.causationId === undefined ? {} : { causationId: record.causationId }),
    ...(record.correlationId === undefined ? {} : { correlationId: record.correlationId }),
    ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
    ...(record.previousHash === undefined ? {} : { previousHash: record.previousHash }),
    hash: record.hash,
    event: record.event
  });
}

function isEventActor(value: unknown): value is EventActor {
  return value === 'user' || value === 'runtime' || value === 'model' || value === 'tool' || value === 'system' || value === 'check';
}

function validateEnvelopeChain(records: readonly EncodedEnvelope[], filePath: string): void {
  let previous: EncodedEnvelope | undefined;
  for (const [index, record] of records.entries()) {
    validateNextEnvelope(previous, record, index, filePath, { text: '', line: index + 2, byteOffset: 0, terminated: true });
    previous = record;
  }
}

function validateNextEnvelope(previous: EncodedEnvelope | undefined, record: EncodedEnvelope, expectedSequence: number, filePath: string, line: JsonlLine): void {
  if (record.sequence !== expectedSequence) throw corruption('integrity', filePath, line, `Event sequence mismatch: expected ${String(expectedSequence)}, got ${String(record.sequence)}.`);
  if (record.previousHash !== previous?.hash) throw corruption('integrity', filePath, line, 'Event previousHash does not match the indexed leaf.');
  const { hash, ...base } = record;
  if (hash !== hashJson(base)) throw corruption('integrity', filePath, line, 'Event hash does not match its record bytes.');
}

function domainEnvelope<TEvent extends TypedEvent>(encoded: EncodedEnvelope, event: TEvent): EventEnvelope<TEvent> {
  return Object.freeze({
    eventId: encoded.eventId, runId: encoded.runId, sequence: encoded.sequence, timestamp: encoded.timestamp, schemaVersion: encoded.schemaVersion, actor: encoded.actor,
    ...(encoded.causationId === undefined ? {} : { causationId: encoded.causationId }), ...(encoded.correlationId === undefined ? {} : { correlationId: encoded.correlationId }),
    ...(encoded.idempotencyKey === undefined ? {} : { idempotencyKey: encoded.idempotencyKey }), ...(encoded.previousHash === undefined ? {} : { previousHash: encoded.previousHash }),
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

function jsonObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function parseLine(line: JsonlLine, storage: string): unknown {
  try { return JSON.parse(line.text); }
  catch (error) { throw corruption('invalid_json', storage, line, errorMessage(error)); }
}
function corruption(code: PersistenceCorruptionError['code'], storage: string, line: JsonlLine, message: string): PersistenceCorruptionError {
  return new PersistenceCorruptionError({ code, storage, line: line.line, byteOffset: line.byteOffset, message });
}
function isEventHeader(value: unknown, runId: string): value is EventStreamHeader {
  return isRecord(value) && value.type === 'event_stream' && value.version === 1 && value.runId === runId && typeof value.createdAt === 'string';
}

export async function withPersistenceFileLock<T>(filePath: string, timeoutMs: number, staleMs: number, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      break;
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
      if (await staleLock(lockPath, staleMs)) { await fs.rm(lockPath, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring persistence lock: ${lockPath}`, { cause: error });
      await delay(10);
    }
  }
  try { return await operation(); }
  finally { await fs.rm(lockPath, { recursive: true, force: true }); }
}

async function staleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let stat;
  try { stat = await fs.stat(lockPath); } catch { return false; }
  if (Date.now() - stat.mtimeMs < staleMs) return false;
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };
    if (typeof owner.pid === 'number' && processAlive(owner.pid)) return false;
  } catch { /* stale incomplete owner */ }
  return true;
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return nodeCode(error) !== 'ESRCH'; } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assertIdentifier(value: string, name: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) throw new Error(`${name} is invalid.`); }
function positiveInteger(value: number, name: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive.`); return value; }
function nonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nodeCode(error: unknown): string | undefined { return isRecord(error) && typeof error.code === 'string' ? error.code : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function inferActor(type: string): EventActor {
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('check.')) return 'check';
  if (type.startsWith('input.')) return 'user';
  return 'runtime';
}
