import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { EventActor, EventAppendReceipt, EventEnvelope, LedgerIntegrityReport, TypedEvent } from './ledger.js';
import { hashJson, canonicalJsonString } from './ledger.js';
import {
  PersistenceConflictError,
  PersistenceCorruptionError,
  type ConditionalEventAppendOptions,
  type ConditionalEventAppendResult,
  type EventAppendOptions,
  type EventLedgerTail,
  type EventRepository,
  type RuntimeCodec
} from './event-repository.js';
import {
  appendJsonlRecord,
  jsonlBoundaryMarker,
  jsonlCommittedBytes,
  jsonlStorageStamp,
  readJsonlLines,
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
  private readonly quarantined = new Map<string, PersistenceCorruptionError>();
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

  indexMetrics(): Readonly<{ fullScans: number; incrementalRefreshes: number; retainedTailRecords: number }> {
    return Object.freeze({
      fullScans: this.fullScans,
      incrementalRefreshes: this.incrementalRefreshes,
      retainedTailRecords: [...this.indexes.values()].filter((index) => index.tail !== undefined).length
    });
  }

  append(runId: string, event: TEvent, options: EventAppendOptions = {}): Promise<EventAppendReceipt> {
    return this.enqueue(runId, async () => withPersistenceFileLock(this.filePath(runId), this.lockTimeoutMs, this.staleLockMs, async (assertOwned) => {
      const encodedEvent = this.codec.encode(event);
      await this.ensureHeader(runId);
      const index = await this.refreshIndex(runId, true);
      if (options.idempotencyKey) {
        const existing = await this.idempotencyEntry(runId, options.idempotencyKey);
        if (existing) {
          if (existing.eventDigest !== hashJson(encodedEvent)) {
            throw new PersistenceConflictError(`Idempotency key ${options.idempotencyKey} already identifies a different event.`);
          }
          return existing.receipt;
        }
      }
      const previous = index.tail;
      const base = Object.freeze({
        eventId: randomUUID(),
        runId,
        sequence: index.recordCount,
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
      await assertOwned();
      await appendJsonlRecord(this.filePath(runId), encodedEnvelope);
      await this.acceptIndexedAppend(runId, index, encodedEnvelope);
      return receiptFromEncoded(encodedEnvelope);
    }));
  }

  appendConditional(runId: string, event: TEvent, options: ConditionalEventAppendOptions): Promise<ConditionalEventAppendResult> {
    return this.enqueue(runId, async () => {
      assertConditionalOptions(options);
      assertIdentifier(options.idempotencyKey, 'idempotencyKey');
      const encodedEvent = this.codec.encode(event);
      try {
        return await withPersistenceFileLock(this.filePath(runId), this.lockTimeoutMs, this.staleLockMs, async (assertOwned) => {
          await this.ensureHeader(runId);
          const index = await this.refreshIndex(runId, true);
          const currentTail = tailFromEncoded(index.tail);
          const existing = await this.idempotencyEntry(runId, options.idempotencyKey);
          if (existing !== undefined) {
            if (existing.eventDigest !== hashJson(encodedEvent)) {
              return Object.freeze({ kind: 'rejected', reason: 'idempotency_conflict', tail: currentTail });
            }
            return Object.freeze({ kind: 'already_committed', receipt: existing.receipt, tail: currentTail });
          }
          if (!sameTail(options.expectedTail, currentTail)) {
            return Object.freeze({ kind: 'rejected', reason: 'stale_tail', tail: currentTail });
          }
          if (options.driverGeneration !== currentTail.driverGeneration && options.driverGeneration !== currentTail.driverGeneration + 1) {
            return Object.freeze({ kind: 'rejected', reason: 'stale_driver', tail: currentTail });
          }
          const previous = index.tail;
          const base = Object.freeze({
            eventId: randomUUID(),
            runId,
            sequence: currentTail.sequence + 1,
            timestamp: options.timestamp ?? new Date().toISOString(),
            schemaVersion: '1' as const,
            actor: options.actor ?? inferActor(event.type),
            event: encodedEvent,
            ...(options.causationId ? { causationId: options.causationId } : {}),
            ...(options.correlationId ? { correlationId: options.correlationId } : {}),
            idempotencyKey: options.idempotencyKey,
            ...(previous ? { previousHash: previous.hash } : {}),
            driverGeneration: options.driverGeneration
          });
          const encodedEnvelope: EncodedEnvelope = Object.freeze({ ...base, hash: hashJson(base) });
          try {
            await assertOwned();
            await appendJsonlRecord(this.filePath(runId), encodedEnvelope);
          } catch (error) {
            return this.classifyFailedConditionalAppend(runId, encodedEnvelope, error);
          }
          try {
            await this.acceptIndexedAppend(runId, index, encodedEnvelope);
          } catch (error) {
            const tail = tailFromEncoded(encodedEnvelope);
            return Object.freeze({ kind: 'committed_index_unknown', receipt: receiptFromEncoded(encodedEnvelope), tail, failure: persistenceFailure(error) });
          }
          const tail = tailFromEncoded(encodedEnvelope);
          return Object.freeze({ kind: 'committed', receipt: receiptFromEncoded(encodedEnvelope), tail });
        });
      } catch (error) {
        if (error instanceof PersistenceCorruptionError) throw error;
        return Object.freeze({ kind: 'not_committed', failure: persistenceFailure(error) });
      }
    });
  }

  tail(runId: string): Promise<EventLedgerTail> {
    return this.enqueue(runId, async () => {
      try { return tailFromEncoded((await this.refreshIndex(runId, false)).tail); }
      catch (error) { if (nodeCode(error) === 'ENOENT') return tailFromEncoded(undefined); throw error; }
    });
  }

  latest(runId: string): Promise<EventEnvelope<TEvent> | undefined> {
    return this.enqueue(runId, async () => {
      let index: EventAppendIndex;
      try { index = await this.refreshIndex(runId, false); }
      catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
      if (index.tail === undefined) return undefined;
      let latest: EncodedEnvelope | undefined;
      for await (const line of readJsonlLines(this.filePath(runId), {
        startOffset: index.tail.byteOffset,
        endOffset: index.completeBytes,
        firstLine: index.recordCount + 1
      })) {
        if (latest !== undefined) throw new PersistenceCorruptionError({ code: 'integrity', storage: this.filePath(runId), line: line.line, byteOffset: line.byteOffset, message: 'Tail index spans more than one record.' });
        latest = parseEnvelopeLine(line, this.filePath(runId), runId);
      }
      if (latest?.hash !== index.tail.hash) throw new PersistenceCorruptionError({ code: 'integrity', storage: this.filePath(runId), line: index.recordCount + 1, byteOffset: index.tail.byteOffset, message: 'Tail index does not resolve to its ledger record.' });
      return domainEnvelope(latest, this.codec.decode(latest.event));
    });
  }

  latestOfType(runId: string, type: TEvent['type']): Promise<EventEnvelope<TEvent> | undefined> {
    return this.enqueue(runId, async () => {
      assertIdentifier(type, 'type');
      let index: EventAppendIndex;
      try { index = await this.refreshIndex(runId, false); }
      catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
      const pointer = index.latestByType.get(type);
      if (pointer === undefined) return undefined;
      const encoded = await this.readIndexedEnvelope(runId, index, pointer);
      if (encoded.event.type !== type) {
        const actualType = typeof encoded.event.type === 'string' ? encoded.event.type : 'a non-string event type';
        throw new PersistenceCorruptionError({ code: 'integrity', storage: this.filePath(runId), line: pointer.sequence + 2, byteOffset: pointer.byteOffset, message: `Event-type index for ${type} resolves to ${actualType}.` });
      }
      return domainEnvelope(encoded, this.codec.decode(encoded.event));
    });
  }

  async *read(runId: string): AsyncIterable<EventEnvelope<TEvent>> {
    let completeBytes: number;
    try { completeBytes = (await this.enqueue(runId, () => this.refreshIndex(runId, false))).completeBytes; }
    catch (error) { if (nodeCode(error) === 'ENOENT') return; throw error; }
    try {
      let first = true;
      for await (const line of readJsonlLines(this.filePath(runId), { endOffset: completeBytes })) {
        if (first) { first = false; continue; }
        const record = parseEnvelopeLine(line, this.filePath(runId), runId);
        yield domainEnvelope(record, this.codec.decode(record.event));
      }
    } catch (error) {
      if (error instanceof PersistenceCorruptionError) await this.quarantine(runId, error);
      throw error;
    }
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
    let corruption: PersistenceCorruptionError | undefined;
    try {
      const index = await this.refreshIndex(runId, false);
      let first = true;
      for await (const line of readJsonlLines(this.filePath(runId), { endOffset: index.completeBytes })) {
        if (first) { first = false; continue; }
        const record = parseEnvelopeLine(line, this.filePath(runId), runId);
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
      if (error instanceof PersistenceCorruptionError) corruption = error;
    }
    if (errors.length > 0) {
      await this.quarantine(runId, corruption ?? new PersistenceCorruptionError({
        code: 'integrity',
        storage: this.filePath(runId),
        line: 1,
        byteOffset: 0,
        message: `Event stream failed integrity verification: ${errors.join('; ')}`
      }));
    }
    return { ok: errors.length === 0, records, errors };
  }

  private filePath(runId: string): string {
    assertIdentifier(runId, 'runId');
    return path.join(this.rootDir, `run-${runId}.jsonl`);
  }

  private async ensureHeader(runId: string): Promise<void> {
    await ensurePrivateDirectory(this.rootDir);
    const filePath = this.filePath(runId);
    try {
      const handle = await fs.open(filePath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ type: 'event_stream', version: 1, runId, createdAt: new Date().toISOString() } satisfies EventStreamHeader)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectoryEntry(this.rootDir);
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
    }
    await fs.chmod(filePath, 0o600);
  }

  private async refreshIndex(runId: string, repairTornTail: boolean): Promise<EventAppendIndex> {
    const filePath = this.filePath(runId);
    const stamp = await jsonlStorageStamp(filePath);
    const committedBytes = await jsonlCommittedBytes(filePath, stamp.size);
    let index = this.indexes.get(runId) ?? await this.readPersistedTailIndex(runId);
    if (index !== undefined && (index.completeBytes > committedBytes
      || await jsonlBoundaryMarker(filePath, index.completeBytes) !== index.boundaryMarker
      || !(await this.persistedTailMatches(runId, index)))) {
      if (index.completeBytes > committedBytes) {
        throw new PersistenceCorruptionError({ code: 'integrity', storage: filePath, line: index.recordCount + 2, byteOffset: committedBytes, message: 'Event stream was truncated before its indexed tail.' });
      }
      index = undefined;
    }
    if (index === undefined) {
      index = await this.rebuildIndex(runId, committedBytes, stamp);
    } else if (committedBytes > index.completeBytes) {
      await this.ingestRange(runId, index, index.completeBytes, committedBytes, index.recordCount + 2);
      index.completeBytes = committedBytes;
      index.boundaryMarker = await jsonlBoundaryMarker(filePath, committedBytes);
      index.storageStamp = stamp;
      await this.writeTailIndex(runId, index);
      this.incrementalRefreshes += 1;
    } else {
      index.storageStamp = stamp;
    }
    this.indexes.set(runId, index);
    if (repairTornTail && stamp.size > committedBytes) {
      await fs.truncate(filePath, committedBytes);
      const handle = await fs.open(filePath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      index.storageStamp = await jsonlStorageStamp(filePath);
    }
    return index;
  }

  private async rebuildIndex(runId: string, completeBytes: number, storageStamp: JsonlStorageStamp): Promise<EventAppendIndex> {
    const filePath = this.filePath(runId);
    await fs.rm(this.indexDirectory(runId), { recursive: true, force: true });
    await ensurePrivateDirectory(this.keyDirectory(runId));
    let first = true;
    const index: EventAppendIndex = {
      recordCount: 0,
      completeBytes: 0,
      boundaryMarker: '',
      latestByType: new Map(),
      storageStamp
    };
    for await (const line of readJsonlLines(filePath, { endOffset: completeBytes })) {
      if (first) {
        first = false;
        const header = parseLine(line, filePath);
        if (!isEventHeader(header, runId)) throw corruption('invalid_header', filePath, line, 'Event stream header is invalid.');
        index.completeBytes = line.byteOffset + Buffer.byteLength(line.text, 'utf8') + 1;
        continue;
      }
      const envelope = parseEnvelopeLine(line, filePath, runId);
      validateNextEnvelope(index.tail, envelope, index.recordCount, filePath, line);
      await this.writeIdempotencyEntry(runId, envelope);
      index.tail = tailRecord(envelope, line.byteOffset);
      index.latestByType.set(eventType(envelope), index.tail);
      index.recordCount += 1;
      index.completeBytes = line.byteOffset + Buffer.byteLength(line.text, 'utf8') + 1;
    }
    if (first) throw new PersistenceCorruptionError({ code: 'invalid_header', storage: filePath, line: 1, byteOffset: 0, message: 'Event stream header is missing.' });
    index.completeBytes = completeBytes;
    index.boundaryMarker = await jsonlBoundaryMarker(filePath, completeBytes);
    await this.writeTailIndex(runId, index);
    this.fullScans += 1;
    return index;
  }

  private async ingestRange(runId: string, index: EventAppendIndex, startOffset: number, endOffset: number, firstLine: number): Promise<void> {
    const filePath = this.filePath(runId);
    for await (const line of readJsonlLines(filePath, { startOffset, endOffset, firstLine })) {
      const envelope = parseEnvelopeLine(line, filePath, runId);
      validateNextEnvelope(index.tail, envelope, index.recordCount, filePath, line);
      await this.writeIdempotencyEntry(runId, envelope);
      index.tail = tailRecord(envelope, line.byteOffset);
      index.latestByType.set(eventType(envelope), index.tail);
      index.recordCount += 1;
    }
  }

  private async acceptIndexedAppend(runId: string, index: EventAppendIndex, envelope: EncodedEnvelope): Promise<void> {
    const serializedBytes = Buffer.byteLength(`${canonicalJsonString(envelope)}\n`, 'utf8');
    await this.writeIdempotencyEntry(runId, envelope);
    index.tail = tailRecord(envelope, index.completeBytes);
    index.latestByType.set(eventType(envelope), index.tail);
    index.recordCount += 1;
    index.completeBytes += serializedBytes;
    index.boundaryMarker = await jsonlBoundaryMarker(this.filePath(runId), index.completeBytes);
    index.storageStamp = await jsonlStorageStamp(this.filePath(runId));
    await this.writeTailIndex(runId, index);
  }

  private indexDirectory(runId: string): string {
    return path.join(this.rootDir, `run-${runId}.index`);
  }

  private quarantinePath(runId: string): string {
    return path.join(this.rootDir, `run-${runId}.quarantine.json`);
  }

  private keyDirectory(runId: string): string {
    return path.join(this.indexDirectory(runId), 'keys');
  }

  private tailIndexPath(runId: string): string {
    return path.join(this.indexDirectory(runId), 'tail.json');
  }

  private idempotencyPath(runId: string, key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return path.join(this.keyDirectory(runId), `${digest}.json`);
  }

  private async readPersistedTailIndex(runId: string): Promise<EventAppendIndex | undefined> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.tailIndexPath(runId), 'utf8'));
      return parseTailIndex(raw, runId);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT' || error instanceof SyntaxError || error instanceof TypeError) return undefined;
      throw error;
    }
  }

  private async persistedTailMatches(runId: string, index: EventAppendIndex): Promise<boolean> {
    if (index.tail === undefined) return index.recordCount === 0;
    try {
      let found: EncodedEnvelope | undefined;
      for await (const line of readJsonlLines(this.filePath(runId), {
        startOffset: index.tail.byteOffset,
        endOffset: index.completeBytes,
        firstLine: index.recordCount + 1
      })) {
        if (found !== undefined) return false;
        found = parseEnvelopeLine(line, this.filePath(runId), runId);
      }
      return found?.sequence === index.tail.sequence
        && found.hash === index.tail.hash
        && found.driverGeneration === index.tail.driverGeneration;
    } catch {
      return false;
    }
  }

  private async writeTailIndex(runId: string, index: EventAppendIndex): Promise<void> {
    const content = {
      version: 1,
      runId,
      recordCount: index.recordCount,
      completeBytes: index.completeBytes,
      boundaryMarker: index.boundaryMarker,
      latestByType: Object.fromEntries([...index.latestByType.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
      ...(index.tail === undefined ? {} : { tail: index.tail })
    } as const;
    await atomicWritePrivateJson(this.tailIndexPath(runId), { ...content, contentHash: hashJson(content) });
  }

  private async readIndexedEnvelope(runId: string, index: EventAppendIndex, pointer: EventTailRecord): Promise<EncodedEnvelope> {
    let found: EncodedEnvelope | undefined;
    for await (const line of readJsonlLines(this.filePath(runId), {
      startOffset: pointer.byteOffset,
      endOffset: index.completeBytes,
      firstLine: pointer.sequence + 2
    })) {
      found = parseEnvelopeLine(line, this.filePath(runId), runId);
      break;
    }
    if (found?.sequence !== pointer.sequence || found.hash !== pointer.hash) {
      throw new PersistenceCorruptionError({ code: 'integrity', storage: this.filePath(runId), line: pointer.sequence + 2, byteOffset: pointer.byteOffset, message: 'Event index does not resolve to its ledger record.' });
    }
    return found;
  }

  private async idempotencyEntry(runId: string, key: string): Promise<IdempotencyIndexEntry | undefined> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.idempotencyPath(runId, key), 'utf8'));
      return parseIdempotencyEntry(raw, runId, key);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return undefined;
      this.indexes.delete(runId);
      await fs.rm(this.indexDirectory(runId), { recursive: true, force: true });
      await this.refreshIndex(runId, false);
      try {
        const raw: unknown = JSON.parse(await fs.readFile(this.idempotencyPath(runId, key), 'utf8'));
        return parseIdempotencyEntry(raw, runId, key);
      } catch (rebuildError) {
        if (nodeCode(rebuildError) === 'ENOENT') return undefined;
        throw new PersistenceCorruptionError({ code: 'integrity', storage: this.idempotencyPath(runId, key), line: 1, byteOffset: 0, message: `Idempotency index could not be rebuilt: ${errorMessage(rebuildError)}` });
      }
    }
  }

  private async writeIdempotencyEntry(runId: string, envelope: EncodedEnvelope): Promise<void> {
    if (envelope.idempotencyKey === undefined) return;
    const target = this.idempotencyPath(runId, envelope.idempotencyKey);
    const existing = await this.idempotencyEntry(runId, envelope.idempotencyKey);
    const entry: IdempotencyIndexEntry = {
      version: 1,
      runId,
      key: envelope.idempotencyKey,
      eventDigest: hashJson(envelope.event),
      receipt: receiptFromEncoded(envelope)
    };
    if (existing !== undefined) {
      if (existing.eventDigest !== entry.eventDigest || existing.receipt.hash !== entry.receipt.hash) {
        throw new PersistenceCorruptionError({ code: 'integrity', storage: target, line: 1, byteOffset: 0, message: 'Idempotency key identifies conflicting ledger records.' });
      }
      return;
    }
    await atomicWritePrivateJson(target, entry);
  }

  private enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(async () => {
      await this.assertNotQuarantined(runId);
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PersistenceCorruptionError) await this.quarantine(runId, error);
        throw error;
      }
    });
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(runId, tail);
    void tail.finally(() => { if (this.queues.get(runId) === tail) this.queues.delete(runId); });
    return result;
  }

  private async assertNotQuarantined(runId: string): Promise<void> {
    const known = this.quarantined.get(runId);
    if (known !== undefined) throw known;
    try {
      await fs.access(this.quarantinePath(runId));
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }
    const persisted = new PersistenceCorruptionError({
      code: 'integrity',
      storage: this.filePath(runId),
      line: 1,
      byteOffset: 0,
      message: `Event stream ${runId} is quarantined after a failed integrity verification.`
    });
    this.quarantined.set(runId, persisted);
    throw persisted;
  }

  private async quarantine(runId: string, error: PersistenceCorruptionError): Promise<void> {
    this.quarantined.set(runId, error);
    this.indexes.delete(runId);
    await atomicWritePrivateJson(this.quarantinePath(runId), {
      version: 1,
      runId,
      detectedAt: new Date().toISOString(),
      code: error.code,
      line: error.line,
      byteOffset: error.byteOffset,
      message: error.message
    });
  }

  private async classifyFailedConditionalAppend(runId: string, attempted: EncodedEnvelope, cause: unknown): Promise<ConditionalEventAppendResult> {
    this.indexes.delete(runId);
    try {
      const index = await this.refreshIndex(runId, true);
      const matching = attempted.idempotencyKey === undefined ? undefined : await this.idempotencyEntry(runId, attempted.idempotencyKey);
      if (matching?.eventDigest === hashJson(attempted.event)) {
        return Object.freeze({
          kind: 'committed_index_unknown',
          receipt: matching.receipt,
          tail: tailFromEncoded(index.tail),
          failure: persistenceFailure(cause)
        });
      }
      const tail = tailFromEncoded(index.tail);
      if (tail.sequence === attempted.sequence - 1 && tail.hash === attempted.previousHash) {
        return Object.freeze({ kind: 'not_committed', failure: persistenceFailure(cause) });
      }
      return Object.freeze({ kind: 'outcome_unknown', failure: persistenceFailure(cause) });
    } catch {
      return Object.freeze({ kind: 'outcome_unknown', failure: persistenceFailure(cause) });
    }
  }
}

interface EventTailRecord extends JsonObject {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly actor: EventActor;
  readonly hash: string;
  readonly driverGeneration: number;
  readonly byteOffset: number;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly previousHash?: string;
}

interface EventAppendIndex {
  tail?: EventTailRecord;
  recordCount: number;
  completeBytes: number;
  boundaryMarker: string;
  latestByType: Map<string, EventTailRecord>;
  storageStamp: JsonlStorageStamp;
}

interface IdempotencyIndexEntry extends JsonObject {
  readonly version: 1;
  readonly runId: string;
  readonly key: string;
  readonly eventDigest: string;
  readonly receipt: EncodedReceipt;
}

interface EncodedReceipt extends EventAppendReceipt, JsonObject {}

interface EncodedEnvelope extends JsonObject {
  readonly eventId: string; readonly runId: string; readonly sequence: number; readonly timestamp: string; readonly schemaVersion: '1'; readonly actor: EventActor;
  readonly causationId?: string; readonly correlationId?: string; readonly idempotencyKey?: string; readonly previousHash?: string; readonly hash: string; readonly driverGeneration: number; readonly event: JsonObject;
}

function parseEnvelope(value: unknown, runId: string): EncodedEnvelope {
  const record = parseJsonObject(value, { maxDepth: 66, maxCollectionEntries: 50_020, maxStringBytes: 1_000_000, maxTotalBytes: 8_000_000 });
  if (typeof record.eventId !== 'string' || record.runId !== runId || !nonnegativeInteger(record.sequence)
    || typeof record.timestamp !== 'string' || record.schemaVersion !== '1' || !isEventActor(record.actor)
    || !nonnegativeInteger(record.driverGeneration)
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
    driverGeneration: record.driverGeneration,
    event: record.event
  });
}

function isEventActor(value: unknown): value is EventActor {
  return value === 'user' || value === 'runtime' || value === 'model' || value === 'tool' || value === 'system' || value === 'check';
}

function validateNextEnvelope(previous: EventTailRecord | undefined, record: EncodedEnvelope, expectedSequence: number, filePath: string, line: JsonlLine): void {
  if (record.sequence !== expectedSequence) throw corruption('integrity', filePath, line, `Event sequence mismatch: expected ${String(expectedSequence)}, got ${String(record.sequence)}.`);
  if (record.previousHash !== previous?.hash) throw corruption('integrity', filePath, line, 'Event previousHash does not match the indexed leaf.');
  const { hash, ...base } = record;
  if (hash !== hashJson(base)) throw corruption('integrity', filePath, line, 'Event hash does not match its record bytes.');
}

function parseEnvelopeLine(line: JsonlLine, storage: string, runId: string): EncodedEnvelope {
  let raw: unknown;
  try { raw = JSON.parse(line.text); }
  catch (error) { throw corruption('invalid_json', storage, line, `Invalid JSON: ${errorMessage(error)}`); }
  try { return parseEnvelope(raw, runId); }
  catch (error) { throw corruption('invalid_record', storage, line, errorMessage(error)); }
}

function tailRecord(envelope: EncodedEnvelope, byteOffset: number): EventTailRecord {
  return Object.freeze({
    eventId: envelope.eventId,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    actor: envelope.actor,
    hash: envelope.hash,
    driverGeneration: envelope.driverGeneration,
    byteOffset,
    ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
    ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }),
    ...(envelope.idempotencyKey === undefined ? {} : { idempotencyKey: envelope.idempotencyKey }),
    ...(envelope.previousHash === undefined ? {} : { previousHash: envelope.previousHash })
  });
}

function parseTailIndex(value: unknown, runId: string): EventAppendIndex {
  const record = parseJsonObject(value, { maxDepth: 5, maxCollectionEntries: 1_024, maxStringBytes: 65_536, maxTotalBytes: 262_144 });
  const allowed = new Set(['version', 'runId', 'recordCount', 'completeBytes', 'boundaryMarker', 'latestByType', 'tail', 'contentHash']);
  const unsupported = Object.keys(record).filter((field) => !allowed.has(field));
  const { contentHash, ...content } = record;
  if (unsupported.length > 0 || typeof contentHash !== 'string' || contentHash !== hashJson(content)
    || record.version !== 1 || record.runId !== runId || !nonnegativeInteger(record.recordCount)
    || !nonnegativeInteger(record.completeBytes) || typeof record.boundaryMarker !== 'string') {
    throw new TypeError('Event tail index fields are invalid.');
  }
  let tail: EventTailRecord | undefined;
  if (record.tail !== undefined) {
    tail = parseEventTailRecord(record.tail, 'Event tail index');
  }
  const latestByType = new Map<string, EventTailRecord>();
  const encodedTypes = parseJsonObject(record.latestByType, { maxDepth: 3, maxCollectionEntries: 1_000, maxStringBytes: 65_536, maxTotalBytes: 196_608 });
  for (const [type, encodedPointer] of Object.entries(encodedTypes)) {
    assertIdentifier(type, 'event type');
    const pointer = parseEventTailRecord(encodedPointer, `Event-type index ${type}`);
    if (pointer.sequence >= record.recordCount) throw new TypeError(`Event-type index ${type} points beyond the ledger tail.`);
    latestByType.set(type, pointer);
  }
  if (record.recordCount === 0) {
    if (tail !== undefined) throw new TypeError('Empty event tail index contains a tail.');
  } else if (tail?.sequence !== record.recordCount - 1) {
    throw new TypeError('Event tail index count does not match its tail.');
  }
  const index: EventAppendIndex = {
    recordCount: record.recordCount,
    completeBytes: record.completeBytes,
    boundaryMarker: record.boundaryMarker,
    latestByType,
    storageStamp: Object.freeze({ size: 0, mtimeMs: 0, ctimeMs: 0 })
  };
  if (tail !== undefined) index.tail = tail;
  return index;
}

function parseEventTailRecord(value: unknown, label: string): EventTailRecord {
  const candidate = parseJsonObject(value, { maxDepth: 2, maxCollectionEntries: 20, maxStringBytes: 16_384, maxTotalBytes: 32_768 });
  if (typeof candidate.eventId !== 'string' || !nonnegativeInteger(candidate.sequence)
    || typeof candidate.timestamp !== 'string' || !isEventActor(candidate.actor)
    || typeof candidate.hash !== 'string' || !nonnegativeInteger(candidate.driverGeneration) || !nonnegativeInteger(candidate.byteOffset)) {
    throw new TypeError(`${label} record is invalid.`);
  }
  for (const field of ['causationId', 'correlationId', 'idempotencyKey', 'previousHash'] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') throw new TypeError(`${label} ${field} is invalid.`);
  }
  const causationId = optionalString(candidate, 'causationId');
  const correlationId = optionalString(candidate, 'correlationId');
  const idempotencyKey = optionalString(candidate, 'idempotencyKey');
  const previousHash = optionalString(candidate, 'previousHash');
  return Object.freeze({
    eventId: candidate.eventId,
    sequence: candidate.sequence,
    timestamp: candidate.timestamp,
    actor: candidate.actor,
    hash: candidate.hash,
    driverGeneration: candidate.driverGeneration,
    byteOffset: candidate.byteOffset,
    ...(causationId === undefined ? {} : { causationId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(previousHash === undefined ? {} : { previousHash })
  });
}

function eventType(envelope: EncodedEnvelope): string {
  const type = envelope.event.type;
  if (typeof type !== 'string') throw new TypeError('Encoded event type is invalid.');
  return type;
}

function parseIdempotencyEntry(value: unknown, runId: string, key: string): IdempotencyIndexEntry {
  const record = parseJsonObject(value, { maxDepth: 4, maxCollectionEntries: 40, maxStringBytes: 65_536, maxTotalBytes: 131_072 });
  if (record.version !== 1 || record.runId !== runId || record.key !== key || typeof record.eventDigest !== 'string' || !jsonObject(record.receipt)) {
    throw new TypeError('Idempotency index fields are invalid.');
  }
  const receiptRecord = record.receipt;
  if (typeof receiptRecord.eventId !== 'string' || receiptRecord.runId !== runId || !nonnegativeInteger(receiptRecord.sequence)
    || typeof receiptRecord.timestamp !== 'string' || receiptRecord.schemaVersion !== '1' || !isEventActor(receiptRecord.actor)
    || typeof receiptRecord.hash !== 'string' || !nonnegativeInteger(receiptRecord.driverGeneration)) {
    throw new TypeError('Idempotency receipt fields are invalid.');
  }
  for (const field of ['causationId', 'correlationId', 'idempotencyKey', 'previousHash'] as const) {
    if (receiptRecord[field] !== undefined && typeof receiptRecord[field] !== 'string') throw new TypeError(`Idempotency receipt ${field} is invalid.`);
  }
  const causationId = optionalString(receiptRecord, 'causationId');
  const correlationId = optionalString(receiptRecord, 'correlationId');
  const idempotencyKey = optionalString(receiptRecord, 'idempotencyKey');
  const previousHash = optionalString(receiptRecord, 'previousHash');
  const receipt: EncodedReceipt = Object.freeze({
    eventId: receiptRecord.eventId,
    runId,
    sequence: receiptRecord.sequence,
    timestamp: receiptRecord.timestamp,
    schemaVersion: '1',
    actor: receiptRecord.actor,
    hash: receiptRecord.hash,
    driverGeneration: receiptRecord.driverGeneration,
    ...(causationId === undefined ? {} : { causationId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(previousHash === undefined ? {} : { previousHash })
  });
  return Object.freeze({ version: 1, runId, key, eventDigest: record.eventDigest, receipt });
}

function domainEnvelope<TEvent extends TypedEvent>(encoded: EncodedEnvelope, event: TEvent): EventEnvelope<TEvent> {
  return Object.freeze({
    eventId: encoded.eventId, runId: encoded.runId, sequence: encoded.sequence, timestamp: encoded.timestamp, schemaVersion: encoded.schemaVersion, actor: encoded.actor,
    ...(encoded.causationId === undefined ? {} : { causationId: encoded.causationId }), ...(encoded.correlationId === undefined ? {} : { correlationId: encoded.correlationId }),
    ...(encoded.idempotencyKey === undefined ? {} : { idempotencyKey: encoded.idempotencyKey }), ...(encoded.previousHash === undefined ? {} : { previousHash: encoded.previousHash }),
    hash: encoded.hash, driverGeneration: encoded.driverGeneration, event
  });
}

function receiptFromEncoded(encoded: EncodedEnvelope): EncodedReceipt {
  return Object.freeze({
    eventId: encoded.eventId, runId: encoded.runId, sequence: encoded.sequence, timestamp: encoded.timestamp,
    schemaVersion: encoded.schemaVersion, actor: encoded.actor, hash: encoded.hash, driverGeneration: encoded.driverGeneration,
    ...(encoded.causationId ? { causationId: encoded.causationId } : {}), ...(encoded.correlationId ? { correlationId: encoded.correlationId } : {}),
    ...(encoded.idempotencyKey ? { idempotencyKey: encoded.idempotencyKey } : {}), ...(encoded.previousHash ? { previousHash: encoded.previousHash } : {})
  });
}

function optionalString(record: JsonObject, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${field} is invalid.`);
  return value;
}

function tailFromEncoded(encoded: EventTailRecord | EncodedEnvelope | undefined): EventLedgerTail {
  return Object.freeze(encoded === undefined
    ? { sequence: -1, driverGeneration: 0 }
    : { sequence: encoded.sequence, hash: encoded.hash, driverGeneration: encoded.driverGeneration });
}

function sameTail(left: EventLedgerTail, right: EventLedgerTail): boolean {
  return left.sequence === right.sequence && left.hash === right.hash && left.driverGeneration === right.driverGeneration;
}

function assertConditionalOptions(options: unknown): void {
  if (!isRecord(options) || typeof options.idempotencyKey !== 'string' || !isRecord(options.expectedTail)) {
    throw new TypeError('Conditional event append options are invalid.');
  }
  const expected = options.expectedTail;
  if (!Number.isSafeInteger(expected.sequence) || typeof expected.sequence !== 'number' || expected.sequence < -1
    || !Number.isSafeInteger(expected.driverGeneration) || typeof expected.driverGeneration !== 'number' || expected.driverGeneration < 0
    || (expected.sequence === -1 ? expected.hash !== undefined : typeof expected.hash !== 'string')
    || !Number.isSafeInteger(options.driverGeneration) || typeof options.driverGeneration !== 'number' || options.driverGeneration < 0
    || (options.actor !== undefined && !isEventActor(options.actor))
    || !optionalStringFields(options, ['causationId', 'correlationId', 'timestamp'])) {
    throw new TypeError('Conditional event append options are invalid.');
  }
}

function optionalStringFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => record[field] === undefined || typeof record[field] === 'string');
}

function persistenceFailure(error: unknown): Readonly<{ code?: string; message: string }> {
  const code = nodeCode(error);
  return Object.freeze({ ...(code === undefined ? {} : { code }), message: errorMessage(error) });
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

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function atomicWritePrivateJson(filePath: string, value: JsonObject): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJsonString(value)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, filePath);
    await syncDirectoryEntry(directory);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectoryEntry(directory: string): Promise<void> {
  // Node does not expose a Windows directory handle that FileHandle.sync() can
  // flush. Regular files are still synchronized before publication, but the
  // Windows implementation therefore makes no OS-restart or power-loss claim
  // for creation and rename directory entries.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function withPersistenceFileLock<T>(filePath: string, timeoutMs: number, staleMs: number, operation: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
      if (await staleLock(lockPath, staleMs)) { await fs.rm(lockPath, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring persistence lock: ${lockPath}`, { cause: error });
      await delay(10);
    }
  }
  const assertOwned = async (): Promise<void> => {
    let owner: unknown;
    try { owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')); }
    catch { throw new PersistenceConflictError('Persistence lock ownership was lost.'); }
    if (!isRecord(owner) || owner.token !== token || owner.pid !== process.pid) throw new PersistenceConflictError('Persistence lock ownership was lost.');
  };
  try { return await operation(assertOwned); }
  finally {
    try {
      await assertOwned();
      await fs.rm(lockPath, { recursive: true, force: true });
    } catch {
      // A replaced lock belongs to another writer and must not be removed.
    }
  }
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
