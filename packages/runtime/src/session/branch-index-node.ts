import { assertSubmissionOwnership, assertSubmissionTransition } from './submission-lifecycle.js';
import * as z from 'zod';
import { canonicalJsonString, parseJsonObject, type JsonObject } from '@agent-core/json';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { historyCutSchema, historyEventSourceSchema } from '../history/schema.js';
import { workingStateEntrySchema, workingStateAtEntry } from './working-state.js';
import { hashJson } from '@agent-core/persistence';
import {
  atomicWritePrivateJson,
  appendJsonlRecord,
  withPersistenceFileLock,
  jsonlBoundaryMarker,
  jsonlCommittedBytes,
  jsonlStorageStamp,
  readJsonlBytes,
  readJsonlLines,
  sameJsonlStorageStamp,
  type JsonlLine,
  type JsonlStorageStamp
} from '@agent-core/persistence/node';
import { assertSessionBinding, type SessionBindingInput } from './binding.js';
import { SessionHistoryIndexError, SessionHistorySourceError, SessionHistoryIndexPublicationError, type HistoryIndexRebuildOptions } from './history-index.js';
import {
  branchEntryMetadata,
  sourceSnapshot,
  type BranchEntryPosition,
  type BranchPageSource
} from './branch-page.js';
import type {
  SessionBranchEntry,
  SessionBranchPoint,
  SessionDescriptor,
  SessionHeader,
  SessionPendingSubmission,
  SessionSubmissionState,
  SessionRunFinalization,
  SessionSubmissionRecord,
  SessionSummary
} from './contracts.js';

type FinalizationMetadata = Pick<SessionRunFinalization, 'runId' | 'finalizationId' | 'throughEntryId'>;

interface RecordPosition extends BranchEntryPosition {
  readonly offset: number;
  readonly line: number;
}

const idSchema = z.string().min(1);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const integerSchema = z.number().int().nonnegative();
const entryTypeSchema = z.enum(['input', 'steering', 'assistant', 'tool_call', 'observation',
  'branch', 'model_settings', 'context_transition', 'working_state']);
const positionSchema = z.strictObject({
  offset: integerSchema, line: z.number().int().min(2), bytes: z.number().int().positive(),
  parentId: idSchema.nullable(), hash: hashSchema, identity: idSchema,
  type: entryTypeSchema, timestamp: idSchema, runId: idSchema.optional(),
  toolName: idSchema.optional(), source: historyEventSourceSchema.optional(),
  fromEntryId: idSchema.nullable().optional(), historyPosition: historyCutSchema.optional(),
  workingState: workingStateEntrySchema.nullable().optional(),
  context: z.strictObject({
    type: entryTypeSchema, description: z.string().max(400), runId: idSchema.optional(),
    exchangeId: idSchema.optional(), callIndex: integerSchema.optional(), toolBatchId: idSchema.optional(),
    expectedCalls: integerSchema.optional(), prefixBound: z.boolean().optional(),
    contextRecovery: z.literal(true).optional()
  })
});
const submissionMetadataSchema = z.strictObject({
  submissionId: idSchema, runId: idSchema, claimId: idSchema.optional(), previousClaimId: idSchema.optional(),
  type: z.enum(['submission.queued', 'submission.claimed', 'submission.suspended',
    'submission.completed', 'submission.failed', 'submission.revised', 'submission.cancelled'])
});
type SubmissionMetadata = z.infer<typeof submissionMetadataSchema>;
type SubmissionSummary = Pick<SessionPendingSubmission, 'runId' | 'submissionId'> & {
  readonly state: 'queued' | SessionSubmissionState;
  readonly claimId?: string;
};
const metadataSchema = z.strictObject({
  format: z.literal('agent-core.session-branch-index/1'), previousSha256: hashSchema.nullable(), header: z.unknown(),
  summary: z.strictObject({
    id: idSchema, timestamp: idSchema, updatedAt: idSchema,
    preview: z.string().max(160).optional(), provider: idSchema.optional(), model: idSchema.optional(),
    bindingSchemaId: idSchema, bindingSchemaVersion: z.number().int().positive(), bindingSha256: hashSchema
  }),
  positions: z.array(z.tuple([idSchema, positionSchema])),
  submissions: z.array(submissionMetadataSchema),
  branchPoints: z.array(z.strictObject({
    entryId: idSchema, timestamp: idSchema, kind: z.enum(['run_finalization', 'context_transition']),
    runId: idSchema.optional(), finalizationId: idSchema.optional()
  })),
  finalizations: z.array(z.strictObject({runId: idSchema, finalizationId: idSchema, throughEntryId: idSchema})),
  leafId: idSchema.nullable(), sourceRevision: integerSchema,
  completeBytes: z.number().int().positive(), lineCount: z.number().int().positive(), marker: idSchema,
  stamp: z.strictObject({size: integerSchema, mtimeMs: z.number(), ctimeMs: z.number()})
});

/** Rebuildable offsets into the session ledger; document bodies are never retained here. */
export class JsonlBranchIndex {
  private loaded = false;
  private metadataHash: string | null = null;
  private metadataStamp: JsonlStorageStamp | undefined;
  private metadataBytesRead = 0;
  private metadataRecordsRead = 0;
  private submissions = new Map<string, SubmissionSummary>();
  private pendingSubmissions = new Map<string, SubmissionSummary>();
  private summaryValue: SessionSummary | undefined;
  private positions = new Map<string, RecordPosition>();
  private readonly branchPoints: SessionBranchPoint[] = [];
  private header: SessionHeader | undefined;
  private leafId: string | null = null;
  private sourceRevision = 0;
  private readonly finalizations: Pick<
    SessionRunFinalization,
    'runId' | 'finalizationId' | 'throughEntryId'
  >[] = [];
  private completeBytes = 0;
  private lineCount = 0;
  private marker = '';
  private stamp: JsonlStorageStamp | undefined;
  private scannedBytes = 0;
  private bodyBytesRead = 0;
  private bodyRecordsRead = 0;

  constructor(
    private readonly sessionId: string,
    private readonly filePath: string,
    private readonly decodeHeader: (line: JsonlLine) => SessionHeader,
    private readonly decodeRecord: (
      line: JsonlLine
    ) => SessionBranchEntry | SessionRunFinalization | SessionSubmissionRecord,
    private readonly writeCheckpoint?: (record: JsonObject) => Promise<void>
  ) {}

  metrics() {
    return Object.freeze({
      indexedRecords: this.positions.size,
      metadataBytesRead: this.metadataBytesRead,
      metadataRecordsRead: this.metadataRecordsRead,
      scannedBytes: this.scannedBytes,
      bodyBytesRead: this.bodyBytesRead,
      bodyRecordsRead: this.bodyRecordsRead
    });
  }

  async advance(): Promise<void> {
    await this.refresh({ allowSourceAppend: true });
  }

  async summary(expectedBinding?: SessionBindingInput, signal?: AbortSignal): Promise<SessionSummary> {
    await this.refresh({
      ...(expectedBinding === undefined ? {} : { expectedBinding }),
      ...(signal === undefined ? {} : { signal })
    });
    if (this.summaryValue === undefined)
      throw new Error('Session history has no committed header.');
    return this.summaryValue;
  }

  async source(session: SessionDescriptor): Promise<BranchPageSource> {
    await this.refresh();
    const header = this.header;
    if (header === undefined) throw new Error('Session history has no committed header.');
    if (session.id !== header.id)
      throw new Error('Session history descriptor does not match its header.');
    assertSessionBinding(session.header.binding, header.binding);
    return {
      sessionId: session.id,
      leafId: this.leafId,
      positions: this.positions,
      read: (entryId) => this.read(entryId)
    };
  }

  async points(session: SessionDescriptor): Promise<readonly SessionBranchPoint[]> {
    await this.source(session);
    return Object.freeze([...this.branchPoints]);
  }

  async pending(session: SessionDescriptor): Promise<readonly Pick<SessionPendingSubmission, 'runId' | 'submissionId' | 'state'>[]> {
    await this.source(session);
    return Object.freeze([...this.pendingSubmissions.values()].flatMap(item =>
      item.state === 'queued' || item.state === 'claimed' || item.state === 'suspended'
        ? [Object.freeze({runId: item.runId, submissionId: item.submissionId, state: item.state})] : []));
  }

  async snapshot(session: SessionDescriptor, leafId?: string | null) {
    const source = await this.source(session);
    return sourceSnapshot(source, this.sourceRevision, this.finalizations, leafId);
  }

  async rebuild(
    expectedBinding: SessionBindingInput,
    options: HistoryIndexRebuildOptions = {}
  ): Promise<void> {
    await this.replaceIndex(expectedBinding, options, false);
  }

  async recover(expectedBinding: SessionBindingInput, options: HistoryIndexRebuildOptions): Promise<void> {
    await this.replaceIndex(expectedBinding, options, true);
  }

  private async replaceIndex(
    expectedBinding: SessionBindingInput,
    options: HistoryIndexRebuildOptions,
    incremental: boolean
  ): Promise<void> {
    return withPersistenceFileLock(`${this.filePath}.index`, 5_000, 30_000, async () => {
      options.signal?.throwIfAborted();
      const destination = `${this.filePath}.index`;
      const stagedPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
      const staged = await fs.open(stagedPath, 'wx', 0o600);
      let published = false;
      let offset = 0;
      const writeLine = async (text: string): Promise<void> => {
        const bytes = Buffer.from(`${text}\n`);
        let consumed = 0;
        while (consumed < bytes.length) {
          const { bytesWritten } = await staged.write(bytes, consumed, bytes.length - consumed, offset);
          if (bytesWritten === 0) throw new Error('Staged history index write made no progress.');
          consumed += bytesWritten;
          offset += bytesWritten;
        }
      };
      const createCandidate = () => new JsonlBranchIndex(
        this.sessionId, this.filePath, this.decodeHeader, this.decodeRecord,
        async (record) => { await writeLine(canonicalJsonString(record)); }
      );
      try {
        let candidate = createCandidate();
        // Only admission of the prior checkpoint/source prefix may fall back to a
        // full rebuild. No exception after publication retries the operation.
        if (incremental) {
          try {
            await candidate.restore(async (line) => {
              options.signal?.throwIfAborted();
              await writeLine(line.text);
            }, options.signal);
            await candidate.validateOriginalHeader(expectedBinding, options.signal);
            await candidate.refreshLocked({ ...options, allowSourceAppend: true, expectedBinding });
          } catch (error) {
            if (!(error instanceof SessionHistoryIndexError)) throw error;
            options.signal?.throwIfAborted();
            await staged.truncate(0);
            offset = 0;
            candidate = createCandidate();
            candidate.loaded = true;
            await candidate.refreshLocked({ ...options, allowSourceAppend: true, expectedBinding });
          }
        } else {
          candidate.loaded = true;
          await candidate.refreshLocked({ ...options, allowSourceAppend: true, expectedBinding });
        }
        await staged.sync();
        await staged.close();
        options.signal?.throwIfAborted();
        await fs.rename(stagedPath, destination);
        published = true;
        if (process.platform !== 'win32') {
          const directory = await fs.open(path.dirname(destination), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
        this.scannedBytes += candidate.scannedBytes;
        await this.restore();
      } catch (cause) {
        if (published) throw new SessionHistoryIndexPublicationError(this.sessionId, cause);
        throw cause;
      } finally {
        await staged.close();
        await fs.rm(stagedPath, { force: true });
      }
    }, options.signal === undefined ? {} : { signal: options.signal });
  }

  private validatedOriginalHeader(line: JsonlLine, expectedBinding?: SessionBindingInput): SessionHeader {
    try {
      const header = this.decodeHeader(line);
      if (expectedBinding !== undefined) assertSessionBinding(expectedBinding, header.binding);
      return header;
    } catch (cause) {
      throw new SessionHistorySourceError(this.sessionId, `Original header validation failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }

  private async validateOriginalHeader(expectedBinding: SessionBindingInput, signal?: AbortSignal): Promise<void> {
    for await (const line of readJsonlLines(this.filePath, { maxLineBytes: 64 * 1024 * 1024 })) {
      signal?.throwIfAborted();
      this.validatedOriginalHeader(line, expectedBinding);
      this.scannedBytes += Buffer.byteLength(line.text) + 1;
      return;
    }
    throw new SessionHistorySourceError(this.sessionId, 'No committed session header.');
  }

  private async refresh(options?: HistoryIndexRebuildOptions & {
    readonly allowSourceAppend?: boolean;
    readonly expectedBinding?: SessionBindingInput;
  }): Promise<void> {
    return withPersistenceFileLock(
      `${this.filePath}.index`, 5_000, 30_000,
      () => this.refreshLocked(options),
      options?.signal === undefined ? {} : { signal: options.signal }
    );
  }

  private async refreshLocked(options?: HistoryIndexRebuildOptions & {
    readonly allowSourceAppend?: boolean;
    readonly expectedBinding?: SessionBindingInput;
  }): Promise<void> {
    options?.signal?.throwIfAborted();
    if (this.loaded && this.metadataStamp !== undefined) {
      try {
        if (!sameJsonlStorageStamp(await jsonlStorageStamp(`${this.filePath}.index`), this.metadataStamp))
          this.loaded = false;
      } catch (cause) {
        throw new SessionHistoryIndexError(this.sessionId, 'is unavailable', { cause });
      }
    }
    if (!this.loaded) await this.restore(undefined, options?.signal);
    if (options?.expectedBinding !== undefined && this.header !== undefined) {
      try {
        assertSessionBinding(options.expectedBinding, this.header.binding);
      } catch (cause) {
        throw new SessionHistoryIndexError(this.sessionId, 'has a different workspace binding', { cause });
      }
    }
    const stamp = await jsonlStorageStamp(this.filePath);
    if (this.stamp !== undefined && sameJsonlStorageStamp(stamp, this.stamp)) return;
    if (!options?.allowSourceAppend)
      throw new SessionHistoryIndexError(this.sessionId, 'does not match its original history');
    if (stamp.size < this.completeBytes)
      throw new SessionHistorySourceError(this.sessionId, 'Original history was truncated after indexing.');
    if (
      this.completeBytes > 0 &&
      (stamp.size === this.completeBytes ||
        (await jsonlBoundaryMarker(this.filePath, this.completeBytes)) !== this.marker)
    ) {
      throw new SessionHistoryIndexError(this.sessionId, 'does not match its original history');
    }
    const endOffset = await jsonlCommittedBytes(this.filePath, stamp.size);
    if (endOffset === this.completeBytes) {
      if (this.header === undefined)
        throw new SessionHistorySourceError(this.sessionId, 'No committed session header.');
      this.stamp = stamp;
      return;
    }
    const additions = new Map<string, RecordPosition>();
    const points: SessionBranchPoint[] = [];
    const submissions: SubmissionMetadata[] = [];
    let header = this.header;
    let summary = this.summaryValue;
    let leafId = this.leafId;
    let lineCount = this.lineCount;
    let revision = this.sourceRevision;
    const finalizations: FinalizationMetadata[] = [];
    const consume = (line: JsonlLine): void => {
      lineCount = line.line;
      const bytes = Buffer.byteLength(line.text) + 1;
      this.scannedBytes += bytes;
      if (line.line === 1) {
        header = this.validatedOriginalHeader(line, options.expectedBinding);
        summary = {
          id: header.id,
          timestamp: header.timestamp,
          updatedAt: header.timestamp,
          ...(header.provider === undefined ? {} : { provider: header.provider }),
          ...(header.model === undefined ? {} : { model: header.model }),
          bindingSchemaId: header.binding.schemaId,
          bindingSchemaVersion: header.binding.schemaVersion,
          bindingSha256: header.binding.bindingSha256
        };
        return;
      }
      if (line.text.trim().length === 0) return;
      let entry: SessionBranchEntry | SessionRunFinalization | SessionSubmissionRecord;
      try {
        entry = this.decodeRecord(line);
      } catch (cause) {
        throw new SessionHistorySourceError(this.sessionId, `Invalid record at line ${String(line.line)}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      revision++;
      if (summary === undefined) throw new SessionHistorySourceError(this.sessionId, 'Session record precedes its header.');
      summary = {
        ...summary,
        updatedAt: entry.timestamp > summary.updatedAt ? entry.timestamp : summary.updatedAt,
        ...(summary.preview === undefined && entry.type === 'input'
          ? { preview: entry.task.replace(/\s+/gu, ' ').slice(0, 160) }
          : {})
      };
      if ('submissionId' in entry) {
        submissions.push({type: entry.type, submissionId: entry.submissionId, runId: entry.runId,
          ...('claimId' in entry ? { claimId: entry.claimId } : {}),
          ...(entry.type === 'submission.claimed' && entry.previousClaimId !== undefined
            ? { previousClaimId: entry.previousClaimId } : {})});
        return;
      }
      if (entry.type === 'run_finalization') {
        finalizations.push({
          runId: entry.runId,
          finalizationId: entry.finalizationId,
          throughEntryId: entry.throughEntryId
        });
        points.push(
          Object.freeze({
            entryId: entry.throughEntryId,
            timestamp: entry.timestamp,
            kind: 'run_finalization',
            finalizationId: entry.finalizationId,
            runId: entry.runId
          })
        );
        return;
      }
      if (this.positions.has(entry.id) || additions.has(entry.id))
        throw new SessionHistorySourceError(this.sessionId, `Duplicate entry: ${entry.id}.`);
      if (
        entry.parentId !== null &&
        !this.positions.has(entry.parentId) &&
        !additions.has(entry.parentId)
      )
        throw new SessionHistorySourceError(this.sessionId, `Missing parent: ${entry.parentId}.`);
      additions.set(entry.id, {
        workingState: workingStateAtEntry(
          entry,
          entry.parentId === null
            ? null
            : ((additions.get(entry.parentId) ?? this.positions.get(entry.parentId))
                ?.workingState ?? null)
        ),
        ...branchEntryMetadata(entry),
        offset: line.byteOffset,
        bytes,
        line: line.line,
        parentId: entry.parentId,
        hash: hashJson(entry)
      });
      if (entry.type === 'context_transition')
        points.push(
          Object.freeze({
            entryId: entry.id,
            timestamp: entry.timestamp,
            kind: 'context_transition'
          })
        );
      leafId = entry.id;
    };
    const checkpoint = async (checkpointBytes: number): Promise<void> => {
      if (header === undefined)
        throw new SessionHistorySourceError(this.sessionId, 'No committed session header.');
      if (finalizations.some(item => !this.positions.has(item.throughEntryId) && !additions.has(item.throughEntryId)))
        throw new SessionHistorySourceError(this.sessionId, 'Finalization refers to an unknown history entry.');
      const marker = await jsonlBoundaryMarker(this.filePath, checkpointBytes);
      try {
        for (const submission of submissions) applySubmissionMetadata(this.submissions, this.pendingSubmissions, submission);
      } catch (cause) {
        throw new SessionHistorySourceError(this.sessionId, `Invalid submission lifecycle: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      for (const [id, entry] of additions) this.positions.set(id, entry);
      this.branchPoints.push(...points);
      this.finalizations.push(...finalizations);
      this.sourceRevision = revision;
      options.signal?.throwIfAborted();
      this.header = header;
      this.summaryValue = summary === undefined ? undefined : Object.freeze(summary);
      this.leafId = leafId;
      this.lineCount = lineCount;
      this.completeBytes = checkpointBytes;
      this.marker = marker;
      this.stamp = stamp;
      try {
        await this.persist(additions, points, finalizations, submissions);
      } catch (error) {
        this.loaded = false;
        throw error;
      }
      additions.clear();
      points.length = 0;
      finalizations.length = 0;
      submissions.length = 0;
    };
    for await (const line of readJsonlLines(this.filePath, {
      startOffset: this.completeBytes,
      firstLine: this.lineCount + 1,
      endOffset,
      maxLineBytes: 64 * 1024 * 1024
    })) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ records: revision, bytes: line.byteOffset, totalBytes: endOffset });
      consume(line);
      if (this.writeCheckpoint !== undefined)
        await checkpoint(line.byteOffset + Buffer.byteLength(line.text) + 1);
    }
    options.onProgress?.({ records: revision, bytes: endOffset, totalBytes: endOffset });
    options.signal?.throwIfAborted();
    if (this.completeBytes < endOffset) await checkpoint(endOffset);
  }

  private async persist(
    additions: Map<string, RecordPosition>,
    points: readonly SessionBranchPoint[],
    finalizations: FinalizationMetadata[],
    submissions: SubmissionMetadata[]
  ): Promise<void> {
    const metadata = parseJsonObject({
      format: 'agent-core.session-branch-index/1', previousSha256: this.metadataHash,
      header: this.header, summary: this.summaryValue,
      positions: [...additions], branchPoints: points, finalizations, submissions,
      leafId: this.leafId, sourceRevision: this.sourceRevision, completeBytes: this.completeBytes,
      lineCount: this.lineCount, marker: this.marker, stamp: this.stamp
    });
    if (this.writeCheckpoint !== undefined) {
      try {
        metadataSchema.parse(metadata);
      } catch (cause) {
        throw new SessionHistorySourceError(this.sessionId, `An original record cannot produce valid history metadata: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
    }
    const sha256 = hashJson(metadata);
    const record = { metadata, sha256 };
    if (this.writeCheckpoint !== undefined) await this.writeCheckpoint(record);
    else {
      if (this.metadataHash === null) await atomicWritePrivateJson(`${this.filePath}.index`, record);
      else await appendJsonlRecord(`${this.filePath}.index`, record);
      this.metadataStamp = await jsonlStorageStamp(`${this.filePath}.index`);
    }
    this.metadataHash = sha256;
  }

  private async restore(copyLine?: (line: JsonlLine) => Promise<void>, signal?: AbortSignal): Promise<void> {
    try {
      const file = `${this.filePath}.index`;
      const stamp = await jsonlStorageStamp(file);
      if (await jsonlCommittedBytes(file, stamp.size) !== stamp.size)
        throw new Error('Index contains an incomplete checkpoint.');
      let metadataHash: string | null = null;
      let latest: z.infer<typeof metadataSchema> | undefined;
      let header: SessionHeader | undefined;
      const positions = new Map<string, RecordPosition>();
      const submissions = new Map<string, SubmissionSummary>();
      const pendingSubmissions = new Map<string, SubmissionSummary>();
      let previousEnd = 0;
      let previousLine = 1;
      let leafId: string | null = null;
      const points: SessionBranchPoint[] = [];
      const finalizations: FinalizationMetadata[] = [];
      for await (const line of readJsonlLines(file, {maxLineBytes: 64 * 1024 * 1024})) {
        signal?.throwIfAborted();
        this.metadataBytesRead += Buffer.byteLength(line.text) + 1;
        this.metadataRecordsRead++;
        const envelope = z.strictObject({ metadata: z.unknown(), sha256: hashSchema }).parse(JSON.parse(line.text));
        if (hashJson(parseJsonObject(envelope.metadata)) !== envelope.sha256)
          throw new Error('Index checksum does not match.');
        const data = metadataSchema.parse(envelope.metadata);
        if (data.previousSha256 !== metadataHash || (latest !== undefined &&
            (data.completeBytes <= latest.completeBytes || data.sourceRevision < latest.sourceRevision)))
          throw new Error('Index checkpoint chain does not match.');
        header = this.decodeHeader({text: JSON.stringify(data.header), line: 1, byteOffset: 0, terminated: true});
        for (const [id, entry] of data.positions) {
          if (positions.has(id) || (entry.parentId !== null && !positions.has(entry.parentId)) ||
              entry.offset < previousEnd || entry.offset + entry.bytes > data.completeBytes ||
              entry.line <= previousLine || entry.line > data.lineCount || entry.type !== entry.context.type)
            throw new Error('Invalid index entry structure.');
          positions.set(id, ownPosition(entry));
          previousEnd = entry.offset + entry.bytes;
          previousLine = entry.line;
          leafId = id;
        }
        for (const point of data.branchPoints) points.push({
          entryId: point.entryId, timestamp: point.timestamp, kind: point.kind,
          ...(point.runId === undefined ? {} : {runId: point.runId}),
          ...(point.finalizationId === undefined ? {} : {finalizationId: point.finalizationId})
        });
        finalizations.push(...data.finalizations);
        for (const submission of data.submissions) applySubmissionMetadata(submissions, pendingSubmissions, submission);
        if (data.summary.id !== header.id || data.summary.bindingSha256 !== header.binding.bindingSha256 ||
            data.completeBytes > data.stamp.size || data.sourceRevision < positions.size + finalizations.length ||
            data.leafId !== leafId ||
            data.finalizations.some(item => !positions.has(item.throughEntryId)) ||
            data.branchPoints.some(item => !positions.has(item.entryId)))
          throw new Error('Invalid index boundary.');
        latest = data;
        metadataHash = envelope.sha256;
        await copyLine?.(line);
      }
      if (!latest || !header) throw new Error('Index contains no checkpoint.');
      const data = latest;
      this.header = header;
      this.summaryValue = Object.freeze({
        id: data.summary.id, timestamp: data.summary.timestamp, updatedAt: data.summary.updatedAt,
        bindingSchemaId: data.summary.bindingSchemaId, bindingSchemaVersion: data.summary.bindingSchemaVersion,
        bindingSha256: data.summary.bindingSha256,
        ...(data.summary.preview === undefined ? {} : {preview: data.summary.preview}),
        ...(data.summary.provider === undefined ? {} : {provider: data.summary.provider}),
        ...(data.summary.model === undefined ? {} : {model: data.summary.model})
      });
      this.positions = positions;
      this.submissions = submissions;
      this.pendingSubmissions = pendingSubmissions;
      this.branchPoints.length = 0;
      this.branchPoints.push(...points);
      this.finalizations.length = 0;
      this.finalizations.push(...finalizations);
      this.leafId = data.leafId;
      this.sourceRevision = data.sourceRevision;
      this.completeBytes = data.completeBytes;
      this.lineCount = data.lineCount;
      this.marker = data.marker;
      this.stamp = data.stamp;
      this.metadataStamp = stamp;
      this.metadataHash = metadataHash;
      this.loaded = true;
    } catch (cause) {
      if (signal?.aborted && cause === signal.reason) throw cause;
      throw new SessionHistoryIndexError(this.sessionId, 'is missing, corrupt, or incompatible', { cause });
    }
  }

  private async read(entryId: string): Promise<SessionBranchEntry> {
    const position = this.positions.get(entryId);
    if (position === undefined) throw new Error(`Unknown session history entry: ${entryId}`);
    const bytes = await readJsonlBytes(this.filePath, position.offset, position.bytes);
    this.bodyBytesRead += bytes.length;
    this.bodyRecordsRead++;
    if (bytes.length !== position.bytes || bytes.at(-1) !== 10)
      throw new Error('Session history record changed after indexing.');
    const entry = this.decodeRecord({
      text: Buffer.from(bytes.subarray(0, -1)).toString('utf8'),
      line: position.line,
      byteOffset: position.offset,
      terminated: true
    });
    if (
      'submissionId' in entry ||
      entry.type === 'run_finalization' ||
      entry.id !== entryId ||
      hashJson(entry) !== position.hash
    )
      throw new Error('Session history record changed after indexing.');
    return entry;
  }
}

function ownPosition(value: z.infer<typeof positionSchema>): RecordPosition {
  const context = value.context;
  return {
    offset: value.offset, line: value.line, bytes: value.bytes, parentId: value.parentId,
    hash: value.hash, identity: value.identity, type: value.type, timestamp: value.timestamp,
    ...(value.runId === undefined ? {} : {runId: value.runId}),
    ...(value.toolName === undefined ? {} : {toolName: value.toolName}),
    ...(value.source === undefined ? {} : {source: value.source}),
    ...(value.fromEntryId === undefined ? {} : {fromEntryId: value.fromEntryId}),
    ...(value.historyPosition === undefined ? {} : {historyPosition: value.historyPosition}),
    ...(value.workingState === undefined ? {} : {workingState: value.workingState}),
    context: Object.freeze({
      type: context.type, description: context.description,
      ...(context.runId === undefined ? {} : {runId: context.runId}),
      ...(context.exchangeId === undefined ? {} : {exchangeId: context.exchangeId}),
      ...(context.callIndex === undefined ? {} : {callIndex: context.callIndex}),
      ...(context.toolBatchId === undefined ? {} : {toolBatchId: context.toolBatchId}),
      ...(context.expectedCalls === undefined ? {} : {expectedCalls: context.expectedCalls}),
      ...(context.prefixBound === undefined ? {} : {prefixBound: context.prefixBound}),
      ...(context.contextRecovery === undefined ? {} : {contextRecovery: context.contextRecovery})
    })
  };
}

function applySubmissionMetadata(
  submissions: Map<string, SubmissionSummary>, pending: Map<string, SubmissionSummary>, record: SubmissionMetadata
): void {
  const save = (summary: SubmissionSummary) => {
    submissions.set(record.submissionId, summary);
    if (summary.state === 'queued' || summary.state === 'claimed' || summary.state === 'suspended')
      pending.set(record.submissionId, summary);
    else pending.delete(record.submissionId);
  };
  const current = submissions.get(record.submissionId);
  if (record.type === 'submission.queued') {
    if (current) throw new Error('Duplicate queued submission metadata.');
    save({runId: record.runId, submissionId: record.submissionId, state: 'queued'});
    return;
  }
  if (current?.runId !== record.runId) throw new Error('Submission metadata identity does not match.');
  if (record.type === 'submission.revised' || record.type === 'submission.cancelled') {
    if (current.state !== 'queued') throw new Error('Only queued submission metadata can change.');
    if (record.type === 'submission.cancelled') save({...current, state: 'cancelled'});
    return;
  }
  const state = record.type === 'submission.claimed' ? 'claimed'
    : record.type === 'submission.suspended' ? 'suspended'
    : record.type === 'submission.completed' ? 'completed' : 'failed';
  if (!record.claimId) throw new Error('Submission metadata has no claim identity.');
  assertSubmissionOwnership(current, { type: record.type, claimId: record.claimId,
    ...(record.previousClaimId === undefined ? {} : { previousClaimId: record.previousClaimId }) });
  assertSubmissionTransition(current.state, state, record.submissionId);
  save({...current, state, claimId: record.claimId});
}
