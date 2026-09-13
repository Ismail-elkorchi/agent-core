import { hashJson } from '@agent-core/persistence';
import {
  jsonlBoundaryMarker,
  jsonlCommittedBytes,
  jsonlStorageStamp,
  readJsonlBytes,
  readJsonlLines,
  sameJsonlStorageStamp,
  type JsonlLine,
  type JsonlStorageStamp
} from '@agent-core/persistence/node';
import { assertSessionBinding } from './binding.js';
import type { BranchEntryPosition, BranchPageSource } from './branch-page.js';
import type {
  SessionBranchEntry,
  SessionBranchPoint,
  SessionDescriptor,
  SessionHeader,
  SessionRunFinalization,
  SessionSubmissionRecord,
  SessionSummary
} from './contracts.js';

interface RecordPosition extends BranchEntryPosition {
  readonly offset: number;
  readonly line: number;
}

/** Rebuildable offsets into the session ledger; document bodies are never retained here. */
export class JsonlBranchIndex {
  private summaryValue: SessionSummary | undefined;
  private positions = new Map<string, RecordPosition>();
  private readonly branchPoints: SessionBranchPoint[] = [];
  private header: SessionHeader | undefined;
  private leafId: string | null = null;
  private completeBytes = 0;
  private lineCount = 0;
  private marker = '';
  private stamp: JsonlStorageStamp | undefined;
  private scannedBytes = 0;
  private bodyBytesRead = 0;
  private bodyRecordsRead = 0;

  constructor(
    private readonly filePath: string,
    private readonly decodeHeader: (line: JsonlLine) => SessionHeader,
    private readonly decodeRecord: (
      line: JsonlLine
    ) => SessionBranchEntry | SessionRunFinalization | SessionSubmissionRecord
  ) {}

  metrics() {
    return Object.freeze({
      indexedRecords: this.positions.size,
      scannedBytes: this.scannedBytes,
      bodyBytesRead: this.bodyBytesRead,
      bodyRecordsRead: this.bodyRecordsRead
    });
  }

  async summary(): Promise<SessionSummary> {
    await this.refresh();
    if (this.summaryValue === undefined) throw new Error('Session history has no committed header.');
    return this.summaryValue;
  }

  async source(session: SessionDescriptor): Promise<BranchPageSource> {
    await this.refresh();
    const header = this.header;
    if (header === undefined) throw new Error('Session history has no committed header.');
    if (session.id !== header.id) throw new Error('Session history descriptor does not match its header.');
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

  private async refresh(): Promise<void> {
    const stamp = await jsonlStorageStamp(this.filePath);
    if (this.stamp !== undefined && sameJsonlStorageStamp(stamp, this.stamp)) return;
    if (stamp.size < this.completeBytes) throw new Error('Session history was truncated after indexing.');
    if (
      this.completeBytes > 0 &&
      (stamp.size === this.completeBytes ||
        (await jsonlBoundaryMarker(this.filePath, this.completeBytes)) !== this.marker)
    ) {
      this.positions = new Map();
      this.branchPoints.length = 0;
      this.header = undefined;
      this.summaryValue = undefined;
      this.leafId = null;
      this.completeBytes = 0;
      this.lineCount = 0;
    }
    const endOffset = await jsonlCommittedBytes(this.filePath, stamp.size);
    const additions = new Map<string, RecordPosition>();
    const points: SessionBranchPoint[] = [];
    let header = this.header;
    let summary = this.summaryValue;
    let leafId = this.leafId;
    let lineCount = this.lineCount;
    for await (const line of readJsonlLines(this.filePath, {
      startOffset: this.completeBytes,
      firstLine: this.lineCount + 1,
      endOffset,
      maxLineBytes: 64 * 1024 * 1024
    })) {
      lineCount = line.line;
      const bytes = Buffer.byteLength(line.text) + 1;
      this.scannedBytes += bytes;
      if (line.line === 1) {
        header = this.decodeHeader(line);
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
        continue;
      }
      if (line.text.trim().length === 0) continue;
      const entry = this.decodeRecord(line);
      if (summary === undefined) throw new Error('Session record precedes its header.');
      summary = {
        ...summary,
        updatedAt: entry.timestamp > summary.updatedAt ? entry.timestamp : summary.updatedAt,
        ...(summary.preview === undefined && entry.type === 'input'
          ? { preview: entry.task.replace(/\s+/gu, ' ').slice(0, 160) }
          : {})
      };
      if ('submissionId' in entry) continue;
      if (entry.type === 'run_finalization') {
        points.push(
          Object.freeze({
            entryId: entry.throughEntryId,
            timestamp: entry.timestamp,
            kind: 'run_finalization',
            finalizationId: entry.finalizationId,
            runId: entry.runId
          })
        );
        continue;
      }
      if (this.positions.has(entry.id) || additions.has(entry.id))
        throw new Error(`Duplicate session history entry: ${entry.id}`);
      if (entry.parentId !== null && !this.positions.has(entry.parentId) && !additions.has(entry.parentId))
        throw new Error(`Missing session history parent: ${entry.parentId}`);
      additions.set(entry.id, {
        offset: line.byteOffset,
        bytes,
        line: line.line,
        parentId: entry.parentId,
        hash: hashJson(entry)
      });
      if (entry.type === 'context_transition')
        points.push(
          Object.freeze({ entryId: entry.id, timestamp: entry.timestamp, kind: 'context_transition' })
        );
      leafId = entry.id;
    }
    const marker = await jsonlBoundaryMarker(this.filePath, endOffset);
    for (const [id, entry] of additions) this.positions.set(id, entry);
    this.branchPoints.push(...points);
    this.header = header;
    this.summaryValue = summary === undefined ? undefined : Object.freeze(summary);
    this.leafId = leafId;
    this.lineCount = lineCount;
    this.completeBytes = endOffset;
    this.marker = marker;
    this.stamp = stamp;
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
