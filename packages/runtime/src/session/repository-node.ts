import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  hashJson,
  type ArtifactRef,
  validateArtifactRef
} from '@agent-core/evidence';
import { normalizeJsonSafe, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import {
  PersistenceConflictError,
  PersistenceCorruptionError,
  appendJsonlRecord,
  jsonlBoundaryMarker,
  jsonlStorageStamp,
  readJsonlBytes,
  readJsonlCommittedFile,
  sameJsonlStorageStamp,
  splitJsonlLines,
  withPersistenceFileLock,
  type JsonlLine,
  type JsonlStorageStamp
} from '@agent-core/evidence/node';
import {
  createAgentTerminalSnapshot,
  decodeOwnedAgentTerminalSnapshot,
  terminalSnapshotFingerprint,
  type AgentEffectiveInstruction,
  type AgentToolCallAttemptIdentity,
  type AgentToolCallIdentity,
  type AgentTurnIdentity,
  type AgentTerminalSnapshot
} from '../run/contracts.js';
import { decodeContextItemInput } from '../context/manager.js';
import type {
  SessionDescriptor,
  BaseSessionEntry,
  CreateSessionOptions,
  SessionAssistantEntry,
  SessionBranchEntry,
  SessionBranchMarkerEntry,
  SessionBranchPoint,
  SessionCompactionEntry,
  SessionConversationItem,
  SessionFinalProjection,
  SessionHeader,
  SessionInputEntry,
  SessionModelSettingsEntry,
  SessionObservationEntry,
  SessionObservationInput,
  SessionPendingSubmission,
  SessionReplayState,
  SessionRepository,
  SessionSubmissionInput,
  SessionSubmissionConfiguration,
  SessionSubmissionRecord,
  SessionSubmissionState,
  SessionSummary,
  SessionSteeringEntry,
  SessionToolCallEntry
} from './contracts.js';
import { createSessionSubmissionTransition, ownSessionSubmissionConfiguration, ownSessionSubmissionInput, pendingSessionSubmissions } from './submission-lifecycle.js';

export interface JsonlSessionRepositoryOptions {
  readonly rootDir: string;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

export class JsonlSessionRepository implements SessionRepository {
  private readonly rootDir: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly indexes = new Map<string, SessionAppendIndex>();
  private fullScans = 0;
  private incrementalRefreshes = 0;

  constructor(options: JsonlSessionRepositoryOptions | string) {
    this.rootDir = path.resolve(typeof options === 'string' ? options : options.rootDir);
    this.lockTimeoutMs = positiveInteger(typeof options === 'string' ? 5_000 : options.lockTimeoutMs ?? 5_000, 'lockTimeoutMs');
    this.staleLockMs = positiveInteger(typeof options === 'string' ? 30_000 : options.staleLockMs ?? 30_000, 'staleLockMs');
  }

  location(sessionId: string): string { return this.filePath(sessionId); }
  indexMetrics(): Readonly<{ fullScans: number; incrementalRefreshes: number }> { return Object.freeze({ fullScans: this.fullScans, incrementalRefreshes: this.incrementalRefreshes }); }

  async create(options: CreateSessionOptions): Promise<SessionDescriptor> {
    const id = options.id ?? randomUUID();
    return this.enqueue(id, () => withPersistenceFileLock(this.filePath(id), this.lockTimeoutMs, this.staleLockMs, async () => {
      const header: SessionHeader = Object.freeze({
        type: 'session', version: 1, id, timestamp: new Date().toISOString(),
        ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {})
      });
      await fs.mkdir(this.rootDir, { recursive: true });
      const serialized = `${JSON.stringify(header)}\n`;
      await fs.writeFile(this.filePath(id), serialized, { encoding: 'utf8', flag: 'wx' });
      const completeBytes = Buffer.byteLength(serialized, 'utf8');
      const state: SessionAppendIndex = { header, branchEntries: [], projections: [], submissionRecords: [], completeBytes, boundaryMarker: Buffer.from(serialized).subarray(-256).toString('base64'), storageStamp: await jsonlStorageStamp(this.filePath(id)) };
      this.indexes.set(id, state);
      return sessionFromState(state);
    }));
  }

  async open(sessionId: string): Promise<SessionDescriptor> {
    const state = await this.enqueue(sessionId, () => this.refreshIndex(sessionId, false));
    return sessionFromState(state);
  }

  async list(): Promise<readonly SessionSummary[]> {
    let names: string[];
    try { names = await fs.readdir(this.rootDir); }
    catch (error) { if (nodeCode(error) === 'ENOENT') return []; throw error; }
    const summaries: SessionSummary[] = [];
    for (const name of names.sort()) {
      const id = /^session-(.+)\.jsonl$/u.exec(name)?.[1];
      if (!id) continue;
      const state = await this.enqueue(id, () => this.refreshIndex(id, false));
      const session = sessionFromState(state);
      summaries.push(Object.freeze({
        id, timestamp: session.header.timestamp, updatedAt: sessionUpdatedAt(state),
        ...(session.header.provider ? { provider: session.header.provider } : {}),
        ...(session.header.model ? { model: session.header.model } : {})
      }));
    }
    return Object.freeze(summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  async loadReplayState(sessionId: string, leafId?: string | null): Promise<SessionReplayState> {
    const state = await this.enqueue(sessionId, () => this.refreshIndex(sessionId, false));
    const session = sessionFromState(state);
    const branch = Object.freeze(activeBranch(state.branchEntries, leafId === undefined ? session.leafId : leafId));
    const compaction = [...branch].reverse().find((entry): entry is SessionCompactionEntry => entry.type === 'compaction');
    const compactionIndex = compaction ? branch.findIndex((entry) => entry.id === compaction.id) : -1;
    const tailStart = compactionIndex + 1;
    const tailRunIds = [...new Set(branch.slice(tailStart).flatMap((entry) => entry.type === 'input' ? [entry.runId] : []))];
    const branchIds = new Set(branch.slice(tailStart).map((entry) => entry.id));
    const terminalProjections = Object.freeze(state.projections.filter((projection) => branchIds.has(projection.throughEntryId)));
    const endedRunIds = new Set(terminalProjections.map((projection) => projection.runId));
    const openRunIds = tailRunIds.filter((runId) => !endedRunIds.has(runId));
    const latestEndedRunId = terminalProjections.at(-1)?.runId;
    const ledgerRunIds = Object.freeze([...openRunIds, ...(latestEndedRunId ? [latestEndedRunId] : [])]);
    return Object.freeze({ session, branch, terminalProjections, ...(compaction ? { compaction } : {}), ledgerRunIds });
  }

  async readConversation(sessionId: string): Promise<readonly SessionConversationItem[]> {
    const replay = await this.loadReplayState(sessionId);
    return Object.freeze(replay.branch.filter((entry): entry is SessionConversationItem => entry.type !== 'branch' && entry.type !== 'model_settings'));
  }

  async listBranchPoints(sessionId: string): Promise<readonly SessionBranchPoint[]> {
    const state = await this.enqueue(sessionId, () => this.refreshIndex(sessionId, false));
    const points: SessionBranchPoint[] = state.projections.map((projection) => Object.freeze({
      entryId: projection.throughEntryId, timestamp: projection.timestamp, kind: 'final' as const,
      finalizationId: projection.finalizationId, runId: projection.runId
    }));
    for (const entry of state.branchEntries) if (entry.type === 'compaction') points.push(Object.freeze({ entryId: entry.id, timestamp: entry.timestamp, kind: 'compaction' }));
    return Object.freeze(points);
  }

  appendInput(sessionId: string, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      const existing = state.branchEntries.find((entry): entry is SessionInputEntry => entry.type === 'input' && entry.runId === input.runId);
      if (existing) {
        if (!sameSessionInput(existing, input)) throw new PersistenceConflictError(`Conflicting session input for run ${input.runId}.`);
        return existing;
      }
      const entry: SessionInputEntry = Object.freeze({
        ...baseEntry(branchLeaf(state.branchEntries)), type: 'input', runId: input.runId, task: input.task,
        instructions: Object.freeze((input.instructions ?? []).map((instruction) => Object.freeze({ ...instruction })))
      });
      await this.appendRecord(sessionId, state, entry);
      state.branchEntries.push(entry);
      return entry;
    }));
  }

  appendSteering(sessionId: string, input: { runId: string; content: string }): Promise<SessionSteeringEntry> {
    return this.appendBranchEntry(sessionId, (parentId) => Object.freeze({ ...baseEntry(parentId), type: 'steering', runId: input.runId, content: input.content }));
  }

  appendAssistant(sessionId: string, input: { runId: string; identity: AgentTurnIdentity; content: string }): Promise<SessionAssistantEntry> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      const existing = state.branchEntries.find((entry): entry is SessionAssistantEntry => entry.type === 'assistant'
        && entry.runId === input.runId && entry.turnId === input.identity.turnId && entry.requestAttempt === input.identity.requestAttempt);
      if (existing) {
        if (existing.turnIndex !== input.identity.turnIndex || existing.content !== input.content) throw new PersistenceConflictError(`Conflicting assistant projection for ${input.runId}/${input.identity.turnId}/${String(input.identity.requestAttempt)}.`);
        return existing;
      }
      const entry: SessionAssistantEntry = Object.freeze({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'assistant', runId: input.runId, ...input.identity, content: input.content });
      await this.appendRecord(sessionId, state, entry);
      state.branchEntries.push(entry);
      return entry;
    }));
  }

  appendToolCall(sessionId: string, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      const call = normalizeJsonSafe(input.call).value;
      const existing = state.branchEntries.find((entry): entry is SessionToolCallEntry => entry.type === 'tool_call'
        && entry.runId === input.runId && entry.toolBatchId === input.identity.toolBatchId && entry.callIndex === input.identity.callIndex);
      if (existing) {
        if (existing.turnId !== input.identity.turnId || existing.requestAttempt !== input.identity.requestAttempt || hashJson(existing.call) !== hashJson(call)) {
          throw new PersistenceConflictError(`Conflicting tool call for ${input.runId}/${input.identity.toolBatchId}/${String(input.identity.callIndex)}.`);
        }
        return existing;
      }
      const entry: SessionToolCallEntry = Object.freeze({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'tool_call', runId: input.runId, ...input.identity, call });
      await this.appendRecord(sessionId, state, entry);
      state.branchEntries.push(entry);
      return entry;
    }));
  }

  appendObservation(sessionId: string, input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Promise<SessionObservationEntry> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      const normalized = normalizedObservationInput(input);
      const key = sessionObservationKey(normalized);
      const existing = key ? state.branchEntries.find((entry): entry is SessionObservationEntry => entry.type === 'observation' && sessionObservationKey(entry) === key) : undefined;
      if (existing) {
        if (!sameObservation(existing, normalized)) throw new PersistenceConflictError(`Conflicting session observation for ${String(key)}.`);
        return existing;
      }
      const entry: SessionObservationEntry = Object.freeze({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'observation', ...normalized });
      await appendJsonlRecord(this.filePath(sessionId), entry);
      state.branchEntries.push(entry);
      state.completeBytes += recordBytes(entry);
      state.boundaryMarker = await jsonlBoundaryMarker(this.filePath(sessionId), state.completeBytes);
      state.storageStamp = await jsonlStorageStamp(this.filePath(sessionId));
      return entry;
    }));
  }

  appendModelSettings(sessionId: string, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry> {
    return this.appendBranchEntry(sessionId, (parentId) => Object.freeze({
      ...baseEntry(parentId), type: 'model_settings', provider: settings.provider, model: settings.model,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
      ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort })
    }));
  }

  appendCompaction(sessionId: string, input: { summary: string; provider: string; model: string }): Promise<SessionCompactionEntry> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      assertStableBranch(state);
      const summary = input.summary.trim();
      if (summary.length === 0) throw new Error('Session compaction summary must not be empty.');
      if (Buffer.byteLength(summary, 'utf8') > 64 * 1024) throw new Error('Session compaction summary exceeds 64 KiB.');
      const entry: SessionCompactionEntry = Object.freeze({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'compaction', summary, provider: input.provider, model: input.model });
      await this.appendRecord(sessionId, state, entry);
      state.branchEntries.push(entry);
      return entry;
    }));
  }

  branchFrom(sessionId: string, entryId: string, label?: string): Promise<SessionBranchMarkerEntry> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      const source = state.branchEntries.find((entry) => entry.id === entryId);
      if (!source) throw new Error(`Cannot branch from unknown entry: ${entryId}`);
      if (source.type !== 'compaction' && !state.projections.some((projection) => projection.throughEntryId === entryId)) {
        throw new Error(`Session branches require a completed final or compaction entry: ${entryId}`);
      }
      const entry: SessionBranchMarkerEntry = Object.freeze({ ...baseEntry(entryId), type: 'branch', fromEntryId: entryId, ...(label ? { label } : {}) });
      await appendJsonlRecord(this.filePath(sessionId), entry);
      state.branchEntries.push(entry);
      state.completeBytes += recordBytes(entry);
      state.boundaryMarker = await jsonlBoundaryMarker(this.filePath(sessionId), state.completeBytes);
      state.storageStamp = await jsonlStorageStamp(this.filePath(sessionId));
      return entry;
    }));
  }

  projectFinal(sessionId: string, terminalInput: AgentTerminalSnapshot): Promise<SessionFinalProjection> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const terminal = createAgentTerminalSnapshot(terminalInput);
      const state = await this.refreshIndex(sessionId, true);
      const existing = state.projections.find((projection) => projection.finalizationId === terminal.finalizationId);
      if (existing) {
        if (terminalSnapshotFingerprint(existing.terminal) !== terminalSnapshotFingerprint(terminal)) throw new PersistenceConflictError(`Conflicting session projection for finalization ${terminal.finalizationId}.`);
        return existing;
      }
      const throughEntryId = branchLeaf(state.branchEntries);
      if (!throughEntryId || !activeBranch(state.branchEntries, throughEntryId).some((entry) => entry.type === 'input' && entry.runId === terminal.runId)) {
        throw new Error(`Cannot project finalization ${terminal.finalizationId}: run ${terminal.runId} is not on the active session branch.`);
      }
      const projection: SessionFinalProjection = Object.freeze({
        type: 'final', id: randomUUID(), timestamp: new Date().toISOString(), throughEntryId, runId: terminal.runId,
        finalizationId: terminal.finalizationId, terminal
      });
      await appendJsonlRecord(this.filePath(sessionId), projection);
      state.projections.push(projection);
      state.completeBytes += recordBytes(projection);
      state.boundaryMarker = await jsonlBoundaryMarker(this.filePath(sessionId), state.completeBytes);
      state.storageStamp = await jsonlStorageStamp(this.filePath(sessionId));
      return projection;
    }));
  }

  enqueueSubmission(sessionId: string, input: { submissionId: string; runId: string; input: SessionSubmissionInput; configuration: SessionSubmissionConfiguration }): Promise<void> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      if (state.submissionRecords.some((record) => record.submissionId === input.submissionId)) throw new Error(`Duplicate session submission: ${input.submissionId}`);
      const record: SessionSubmissionRecord = Object.freeze({ type: 'submission.queued', submissionId: input.submissionId, runId: input.runId,
        timestamp: new Date().toISOString(), input: ownSessionSubmissionInput(input.input), configuration: ownSessionSubmissionConfiguration(input.configuration) });
      await this.appendRecord(sessionId, state, record);
      state.submissionRecords.push(record);
    }));
  }

  transitionSubmission(sessionId: string, submissionId: string, outcome: { state: SessionSubmissionState; errorMessage?: string }): Promise<void> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      const record = createSessionSubmissionTransition(state.submissionRecords, submissionId, outcome.state, outcome.errorMessage);
      if (!record) return;
      await this.appendRecord(sessionId, state, record);
      state.submissionRecords.push(record);
    }));
  }

  async loadPendingSubmissions(sessionId: string): Promise<readonly SessionPendingSubmission[]> {
    const state = await this.enqueue(sessionId, () => this.refreshIndex(sessionId, false));
    return pendingSessionSubmissions(state.submissionRecords);
  }

  private async appendRecord(sessionId: string, state: SessionAppendIndex, record: SessionBranchEntry | SessionSubmissionRecord): Promise<void> {
    await appendJsonlRecord(this.filePath(sessionId), 'submissionId' in record ? encodeSubmissionRecord(record) : record);
    state.completeBytes += recordBytes(record);
    state.boundaryMarker = await jsonlBoundaryMarker(this.filePath(sessionId), state.completeBytes);
    state.storageStamp = await jsonlStorageStamp(this.filePath(sessionId));
  }

  private appendBranchEntry<T extends SessionBranchEntry>(sessionId: string, create: (parentId: string | null) => T): Promise<T> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      const entry = create(branchLeaf(state.branchEntries));
      await appendJsonlRecord(this.filePath(sessionId), entry);
      state.branchEntries.push(entry);
      state.completeBytes += recordBytes(entry);
      state.boundaryMarker = await jsonlBoundaryMarker(this.filePath(sessionId), state.completeBytes);
      state.storageStamp = await jsonlStorageStamp(this.filePath(sessionId));
      return entry;
    }));
  }

  private async refreshIndex(sessionId: string, repairTornTail: boolean): Promise<SessionAppendIndex> {
    const filePath = this.filePath(sessionId);
    let index = this.indexes.get(sessionId);
    if (!index) {
      const committed = await readSessionFile(filePath, sessionId);
      const state = committed.state;
      this.fullScans += 1;
      const completeBytes = committed.completeBytes;
      index = { ...state, completeBytes, boundaryMarker: await jsonlBoundaryMarker(filePath, completeBytes), storageStamp: await jsonlStorageStamp(filePath) };
      this.indexes.set(sessionId, index);
      const size = (await fs.stat(filePath)).size;
      if (repairTornTail && size > index.completeBytes) { await fs.truncate(filePath, index.completeBytes); index.storageStamp = await jsonlStorageStamp(filePath); }
      return index;
    }
    const stamp = await jsonlStorageStamp(filePath);
    const size = stamp.size;
    if (size < index.completeBytes) throw corruption(filePath, sessionRecordCount(index) + 2, size, 'Session was truncated after it was indexed.', 'integrity');
    if (size === index.completeBytes && sameJsonlStorageStamp(stamp, index.storageStamp)) return index;
    if (size === index.completeBytes || await jsonlBoundaryMarker(filePath, index.completeBytes) !== index.boundaryMarker) {
      const committed = await readSessionFile(filePath, sessionId);
      const state = committed.state;
      this.fullScans += 1;
      index.branchEntries.splice(0, index.branchEntries.length, ...state.branchEntries);
      index.projections.splice(0, index.projections.length, ...state.projections);
      index.submissionRecords.splice(0, index.submissionRecords.length, ...state.submissionRecords);
      index.completeBytes = committed.completeBytes;
      index.boundaryMarker = await jsonlBoundaryMarker(filePath, index.completeBytes);
      if (repairTornTail && size > index.completeBytes) await fs.truncate(filePath, index.completeBytes);
      index.storageStamp = await jsonlStorageStamp(filePath);
      return index;
    }
    const bytes = await readJsonlBytes(filePath, index.completeBytes, size - index.completeBytes);
    const lines = splitJsonlLines(bytes, sessionRecordCount(index) + 2, index.completeBytes);
    let consumed = 0;
    for (const line of lines) {
      consumed = line.byteOffset - index.completeBytes + Buffer.byteLength(line.text, 'utf8') + 1;
      if (line.text.trim().length === 0) continue;
      const actualLine = sessionRecordCount(index) + 2;
      const value = parseJson({ ...line, line: actualLine }, filePath);
      try {
        if (isJsonObject(value) && value.type === 'final') index.projections.push(parseFinalProjection(value));
        else if (isJsonObject(value) && typeof value.type === 'string' && value.type.startsWith('submission.')) index.submissionRecords.push(parseSubmissionRecord(value));
        else {
          const entry = parseBranchEntry(value);
          if (entry.parentId !== null && !index.branchEntries.some((candidate) => candidate.id === entry.parentId)) throw new Error(`Unknown parent ${entry.parentId}.`);
          if (index.branchEntries.some((candidate) => candidate.id === entry.id)) throw new Error(`Duplicate session entry ${entry.id}.`);
          index.branchEntries.push(entry);
        }
      } catch (error) { throw corruption(filePath, actualLine, line.byteOffset, errorMessage(error), 'invalid_record'); }
    }
    try { pendingSessionSubmissions(index.submissionRecords); }
    catch (error) {
      const last = lines.at(-1);
      throw corruption(filePath, last?.line ?? sessionRecordCount(index) + 1, last?.byteOffset ?? index.completeBytes, errorMessage(error), 'invalid_record');
    }
    index.completeBytes += consumed;
    index.boundaryMarker = await jsonlBoundaryMarker(filePath, index.completeBytes);
    this.incrementalRefreshes += 1;
    if (repairTornTail && size > index.completeBytes) await fs.truncate(filePath, index.completeBytes);
    index.storageStamp = await jsonlStorageStamp(filePath);
    return index;
  }

  private filePath(sessionId: string): string { assertIdentifier(sessionId); return path.join(this.rootDir, `session-${sessionId}.jsonl`); }
  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(sessionId, tail);
    void tail.finally(() => { if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId); });
    return result;
  }
}

interface SessionFileState { readonly header: SessionHeader; readonly branchEntries: SessionBranchEntry[]; readonly projections: SessionFinalProjection[]; readonly submissionRecords: SessionSubmissionRecord[] }
interface SessionAppendIndex extends SessionFileState { completeBytes: number; boundaryMarker: string; storageStamp: JsonlStorageStamp }
function sessionUpdatedAt(state: SessionFileState): string {
  return [...state.branchEntries, ...state.projections, ...state.submissionRecords]
    .reduce((latest, entry) => entry.timestamp > latest ? entry.timestamp : latest, state.header.timestamp);
}
function sessionRecordCount(state: SessionFileState): number { return state.branchEntries.length + state.projections.length + state.submissionRecords.length; }

async function readSessionFile(filePath: string, sessionId: string): Promise<{ readonly state: SessionFileState; readonly completeBytes: number }> {
  const committed = await readJsonlCommittedFile(filePath);
  const lines = committed.lines;
  if (lines.length === 0) throw corruption(filePath, 1, 0, 'Session is empty.', 'invalid_header');
  const headerLine = lines[0];
  if (headerLine === undefined) throw corruption(filePath, 1, 0, 'Session is empty.', 'invalid_header');
  let header: SessionHeader;
  try { header = parseSessionHeader(parseJson(headerLine, filePath), sessionId); }
  catch (error) { throw corruption(filePath, 1, 0, errorMessage(error), 'invalid_header'); }
  const branchEntries: SessionBranchEntry[] = [];
  const projections: SessionFinalProjection[] = [];
  const submissionRecords: SessionSubmissionRecord[] = [];
  for (const line of lines.slice(1)) {
    if (line.text.trim().length === 0) continue;
    const value = parseJson(line, filePath);
    try {
      if (isJsonObject(value) && value.type === 'final') projections.push(parseFinalProjection(value));
      else if (isJsonObject(value) && typeof value.type === 'string' && value.type.startsWith('submission.')) submissionRecords.push(parseSubmissionRecord(value));
      else branchEntries.push(parseBranchEntry(value));
    } catch (error) { throw corruption(filePath, line.line, line.byteOffset, errorMessage(error), 'invalid_record'); }
  }
  validateParents(branchEntries, filePath);
  try { pendingSessionSubmissions(submissionRecords); }
  catch (error) {
    const last = lines.at(-1);
    throw corruption(filePath, last?.line ?? 1, last?.byteOffset ?? 0, errorMessage(error), 'invalid_record');
  }
  return { state: { header, branchEntries, projections, submissionRecords }, completeBytes: committed.completeBytes };
}

function parseBranchEntry(value: JsonValue): SessionBranchEntry {
  if (!isRecord(value) || !validBaseEntry(value)) throw new Error('Session entry base is invalid.');
  if (isSessionInputEntry(value)) return value;
  if (isSessionSteeringEntry(value)) return value;
  if (isSessionAssistantEntry(value)) return value;
  if (isSessionToolCallEntry(value)) return value;
  if (isSessionObservationEntry(value)) return value;
  if (isSessionBranchMarkerEntry(value)) return value;
  if (isSessionModelSettingsEntry(value)) return value;
  if (isSessionCompactionEntry(value)) return value;
  throw new Error(`Unsupported or malformed session entry: ${typeof value.type === 'string' ? value.type : 'unknown'}`);
}
function parseFinalProjection(value: JsonObject): SessionFinalProjection {
  if (typeof value.id !== 'string' || typeof value.timestamp !== 'string' || typeof value.throughEntryId !== 'string' || typeof value.runId !== 'string' || typeof value.finalizationId !== 'string') throw new Error('Final projection identity is invalid.');
  if (!isJsonObject(value.terminal)) throw new Error('Final projection terminal is invalid.');
  const terminal = decodeOwnedAgentTerminalSnapshot(value.terminal);
  if (terminal.runId !== value.runId || terminal.finalizationId !== value.finalizationId) throw new Error('Final projection identity conflicts with terminal snapshot.');
  return Object.freeze({ type: 'final', id: value.id, timestamp: value.timestamp, throughEntryId: value.throughEntryId, runId: value.runId, finalizationId: value.finalizationId, terminal });
}
function activeBranch(entries: readonly SessionBranchEntry[], leafId: string | null): SessionBranchEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const output: SessionBranchEntry[] = []; let cursor = leafId;
  while (cursor) { const entry = byId.get(cursor); if (!entry) throw new Error(`Session branch points to missing entry: ${cursor}`); output.push(entry); cursor = entry.parentId; }
  return output.reverse();
}
function branchLeaf(entries: readonly SessionBranchEntry[]): string | null { return entries.at(-1)?.id ?? null; }
function sessionFromState(state: SessionFileState): SessionDescriptor { return Object.freeze({ id: state.header.id, header: state.header, leafId: branchLeaf(state.branchEntries) }); }
function baseEntry(parentId: string | null): BaseSessionEntry { return { id: randomUUID(), parentId, timestamp: new Date().toISOString() }; }
function validateParents(entries: readonly SessionBranchEntry[], filePath: string): void {
  const ids = new Set<string>();
  for (const entry of entries) { if (ids.has(entry.id)) throw new Error(`Duplicate session entry ${entry.id} in ${filePath}.`); if (entry.parentId !== null && !ids.has(entry.parentId)) throw new Error(`Unknown parent ${entry.parentId} in ${filePath}.`); ids.add(entry.id); }
}
const SESSION_HEADER_FIELDS = new Set(['type', 'version', 'id', 'timestamp', 'parentSessionId', 'provider', 'model']);

function parseSessionHeader(value: JsonValue, sessionId: string): SessionHeader {
  if (!isJsonObject(value) || value.type !== 'session' || value.version !== 1 || value.id !== sessionId
    || Object.keys(value).some((key) => !SESSION_HEADER_FIELDS.has(key))
    || typeof value.timestamp !== 'string'
    || (value.parentSessionId !== undefined && typeof value.parentSessionId !== 'string')
    || (value.provider !== undefined && typeof value.provider !== 'string')
    || (value.model !== undefined && typeof value.model !== 'string')) throw new Error('Session header is invalid.');
  return Object.freeze({
    type: 'session', version: 1, id: value.id, timestamp: value.timestamp,
    ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.model === undefined ? {} : { model: value.model })
  });
}
function recordBytes(record: unknown): number { return Buffer.byteLength(`${JSON.stringify(record)}\n`, 'utf8'); }
function normalizedObservationInput(input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'> {
  const artifacts = input.observation.artifacts?.map((artifact) => { validateArtifactRef(artifact); return Object.freeze({ ...artifact }); });
  return {
    runId: input.runId, ...input.identity, toolName: input.toolName, ok: input.observation.ok, summary: input.observation.summary,
    ...(input.observation.output === undefined ? {} : { output: normalizeObservationOutput(input.observation.output) }),
    ...(artifacts && artifacts.length > 0 ? { artifacts: Object.freeze(artifacts) } : {}),
    ...(input.observation.metadata ? { metadata: normalizeMetadata(input.observation.metadata) } : {})
  };
}
function normalizeObservationOutput(value: unknown): JsonValue {
  return normalizeJsonSafe(value, { maxDepth: 16, maxCollectionEntries: 20_000, maxStringBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }).value;
}
function normalizeMetadata(value: unknown): JsonObject {
  const normalized = normalizeJsonSafe(value).value;
  return isOwnedJsonObject(normalized) ? normalized : Object.freeze({ value: normalized });
}
function isOwnedJsonObject(value: JsonValue): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validArtifactRefs(value: unknown): value is readonly ArtifactRef[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  try { for (const artifact of value) validateArtifactRef(artifact); return true; }
  catch { return false; }
}
function sessionObservationKey(value: Pick<SessionObservationEntry, 'runId' | 'turnId'> & Partial<Pick<SessionObservationEntry, 'requestAttempt' | 'toolBatchId' | 'callIndex' | 'toolAttempt'>>): string | undefined {
  return value.toolBatchId !== undefined && value.callIndex !== undefined && value.toolAttempt !== undefined
    ? `${value.runId}:${value.turnId}:${String(value.requestAttempt)}:${value.toolBatchId}:${String(value.callIndex)}:${String(value.toolAttempt)}`
    : undefined;
}
function sameObservation(existing: SessionObservationEntry, input: Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'>): boolean {
  const persisted = observationPayload(existing);
  return JSON.stringify(persisted) === JSON.stringify(input);
}

function sameSessionInput(existing: SessionInputEntry, input: { readonly runId: string; readonly task: string; readonly instructions?: readonly AgentEffectiveInstruction[] }): boolean {
  return existing.task === input.task && JSON.stringify(existing.instructions) === JSON.stringify(input.instructions ?? []);
}
function observationPayload(value: SessionObservationEntry): Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'> {
  return {
    runId: value.runId, turnIndex: value.turnIndex, turnId: value.turnId, requestAttempt: value.requestAttempt,
    ...(value.toolBatchId === undefined ? {} : { toolBatchId: value.toolBatchId }),
    ...(value.callIndex === undefined ? {} : { callIndex: value.callIndex }),
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.toolAttempt === undefined ? {} : { toolAttempt: value.toolAttempt }),
    toolName: value.toolName, ok: value.ok, summary: value.summary,
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.artifacts === undefined ? {} : { artifacts: value.artifacts }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata })
  };
}
function parseJson(line: JsonlLine, storage: string): JsonValue {
  try { return parseJsonValue(JSON.parse(line.text), { maxDepth: 32, maxCollectionEntries: 50_000, maxStringBytes: 4 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 }); }
  catch (error) { throw corruption(storage, line.line, line.byteOffset, errorMessage(error), 'invalid_json'); }
}
function corruption(storage: string, line: number, byteOffset: number, message: string, code: PersistenceCorruptionError['code']): PersistenceCorruptionError { return new PersistenceCorruptionError({ code, storage, line, byteOffset, message }); }
function assertIdentifier(value: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) throw new Error('Invalid session id.'); }
function positiveInteger(value: number, name: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive.`); return value; }
function nonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function positiveOptionalAttempt(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function validTurnIdentity(value: Record<string, unknown>): value is Record<string, unknown> & AgentTurnIdentity { return typeof value.turnId === 'string' && value.turnId.length > 0 && typeof value.turnIndex === 'number' && Number.isInteger(value.turnIndex) && value.turnIndex > 0 && typeof value.requestAttempt === 'number' && Number.isInteger(value.requestAttempt) && value.requestAttempt > 0; }
function validBaseEntry(value: Record<string, unknown>): value is Record<string, unknown> & BaseSessionEntry {
  return typeof value.id === 'string' && value.id.length > 0 && (typeof value.parentId === 'string' || value.parentId === null) && typeof value.timestamp === 'string' && value.timestamp.length > 0;
}
function isEffectiveInstruction(value: unknown): value is AgentEffectiveInstruction {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && typeof value.content === 'string'
    && (value.provenance === 'application' || value.provenance === 'run' || value.provenance === 'steering' || value.provenance === 'disposition')
    && (value.role === undefined || typeof value.role === 'string') && (value.sourceUri === undefined || typeof value.sourceUri === 'string')
    && (value.priority === undefined || (typeof value.priority === 'number' && Number.isFinite(value.priority)));
}
function isSessionInputEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionInputEntry {
  return value.type === 'input' && typeof value.runId === 'string' && value.runId.length > 0 && typeof value.task === 'string'
    && Array.isArray(value.instructions) && value.instructions.every(isEffectiveInstruction);
}
function isSessionSteeringEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionSteeringEntry {
  return value.type === 'steering' && typeof value.runId === 'string' && value.runId.length > 0 && typeof value.content === 'string' && value.content.length > 0;
}
function isSessionAssistantEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionAssistantEntry {
  return value.type === 'assistant' && validTurnIdentity(value) && typeof value.runId === 'string' && value.runId.length > 0 && typeof value.content === 'string';
}
function isSessionToolCallEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionToolCallEntry {
  return value.type === 'tool_call' && validTurnIdentity(value) && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.toolBatchId === 'string' && value.toolBatchId.length > 0 && nonnegativeInteger(value.callIndex)
    && (value.callId === undefined || typeof value.callId === 'string') && value.call !== undefined;
}
function isSessionObservationEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionObservationEntry {
  return value.type === 'observation' && validTurnIdentity(value) && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.toolName === 'string' && value.toolName.length > 0 && typeof value.ok === 'boolean' && typeof value.summary === 'string'
    && (value.metadata === undefined || isRecord(value.metadata))
    && validArtifactRefs(value.artifacts) && (value.callId === undefined || typeof value.callId === 'string')
    && (value.toolBatchId === undefined
      ? value.callIndex === undefined && value.callId === undefined && value.toolAttempt === undefined
      : typeof value.toolBatchId === 'string' && value.toolBatchId.length > 0 && nonnegativeInteger(value.callIndex) && positiveOptionalAttempt(value.toolAttempt));
}
function isSessionBranchMarkerEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionBranchMarkerEntry {
  return value.type === 'branch' && typeof value.fromEntryId === 'string' && value.fromEntryId.length > 0 && (value.label === undefined || typeof value.label === 'string');
}
function isSessionModelSettingsEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionModelSettingsEntry {
  return value.type === 'model_settings' && typeof value.provider === 'string' && value.provider.length > 0 && typeof value.model === 'string' && value.model.length > 0
    && (value.temperature === undefined || (typeof value.temperature === 'number' && Number.isFinite(value.temperature)))
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string');
}
function isSessionCompactionEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionCompactionEntry {
  return value.type === 'compaction' && typeof value.summary === 'string' && value.summary.length > 0
    && typeof value.provider === 'string' && value.provider.length > 0 && typeof value.model === 'string' && value.model.length > 0;
}

function parseSubmissionRecord(value: JsonObject): SessionSubmissionRecord {
  if (typeof value.submissionId !== 'string' || value.submissionId.length === 0 || typeof value.runId !== 'string' || value.runId.length === 0 || typeof value.timestamp !== 'string') {
    throw new Error('Session submission identity is invalid.');
  }
  if (value.type === 'submission.queued') {
    if (!isJsonObject(value.input) || !isJsonObject(value.configuration)) throw new Error('Queued session submission input is invalid.');
    return Object.freeze({ type: 'submission.queued', submissionId: value.submissionId, runId: value.runId, timestamp: value.timestamp,
      input: parseSubmissionInput(value.input), configuration: parseSubmissionConfiguration(value.configuration) });
  }
  if (value.type !== 'submission.claimed' && value.type !== 'submission.suspended' && value.type !== 'submission.completed' && value.type !== 'submission.failed') throw new Error('Session submission state is invalid.');
  if (value.errorMessage !== undefined && typeof value.errorMessage !== 'string') throw new Error('Session submission error is invalid.');
  return Object.freeze({ type: value.type, submissionId: value.submissionId, runId: value.runId, timestamp: value.timestamp,
    ...(value.errorMessage === undefined ? {} : { errorMessage: value.errorMessage }) });
}

function parseSubmissionInput(value: JsonObject): SessionSubmissionInput {
  if (typeof value.task !== 'string' || !isOptionalStringArray(value.instructions)
    || (value.contextItems !== undefined && !Array.isArray(value.contextItems))) throw new Error('Session submission input is invalid.');
  return Object.freeze({ task: value.task,
    ...(value.instructions === undefined ? {} : { instructions: Object.freeze([...value.instructions]) }),
    ...(value.contextItems === undefined ? {} : { contextItems: Object.freeze(value.contextItems.map((item) => decodeContextItemInput(item))) }) });
}

function parseSubmissionConfiguration(value: JsonObject): SessionSubmissionConfiguration {
  if (typeof value.provider !== 'string' || value.provider.length === 0 || typeof value.model !== 'string' || value.model.length === 0
    || (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)))) throw new Error('Session submission configuration is invalid.');
  return Object.freeze({ provider: value.provider, model: value.model,
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.reasoning === undefined ? {} : { reasoning: parseSubmissionReasoning(value.reasoning) }),
    ...(value.responseFormat === undefined ? {} : { responseFormat: parseSubmissionResponseFormat(value.responseFormat) }) });
}

function parseSubmissionReasoning(value: JsonValue): NonNullable<SessionSubmissionConfiguration['reasoning']> {
  if (!isJsonObject(value)) throw new Error('Session submission reasoning is invalid.');
  if (value.strategy === 'disabled') return Object.freeze({ strategy: 'disabled' });
  const summary = value.summary;
  if (summary !== undefined && summary !== 'auto' && summary !== 'concise' && summary !== 'detailed') throw new Error('Session submission reasoning summary is invalid.');
  if (value.strategy === 'enabled') return Object.freeze({ strategy: 'enabled', ...(summary === undefined ? {} : { summary }) });
  if (value.strategy === 'effort') {
    if (value.effort !== 'minimal' && value.effort !== 'low' && value.effort !== 'medium' && value.effort !== 'high' && value.effort !== 'xhigh' && value.effort !== 'max') throw new Error('Session submission reasoning effort is invalid.');
    if (value.mode !== undefined && value.mode !== 'standard' && value.mode !== 'pro') throw new Error('Session submission reasoning mode is invalid.');
    return Object.freeze({ strategy: 'effort', effort: value.effort, ...(value.mode === undefined ? {} : { mode: value.mode }), ...(summary === undefined ? {} : { summary }) });
  }
  if (value.strategy === 'budget' && typeof value.maxTokens === 'number' && Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0) {
    return Object.freeze({ strategy: 'budget', maxTokens: value.maxTokens, ...(summary === undefined ? {} : { summary }) });
  }
  throw new Error('Session submission reasoning strategy is invalid.');
}

function parseSubmissionResponseFormat(value: JsonValue): NonNullable<SessionSubmissionConfiguration['responseFormat']> {
  if (value === 'text' || value === 'json') return value;
  if (!isJsonObject(value) || value.type !== 'json_schema' || !isJsonObject(value.schema)) throw new Error('Session submission response format is invalid.');
  return Object.freeze({ type: 'json_schema', schema: value.schema });
}

function isOptionalStringArray(value: JsonValue | undefined): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}


function encodeSubmissionRecord(record: SessionSubmissionRecord): JsonObject {
  if (record.type === 'submission.queued') return Object.freeze({
    type: record.type, submissionId: record.submissionId, runId: record.runId, timestamp: record.timestamp,
    input: encodeSubmissionInput(record.input), configuration: encodeSubmissionConfiguration(record.configuration)
  });
  return Object.freeze({ type: record.type, submissionId: record.submissionId, runId: record.runId, timestamp: record.timestamp,
    ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }) });
}

function encodeSubmissionConfiguration(configuration: SessionSubmissionConfiguration): JsonObject {
  return Object.freeze({ provider: configuration.provider, model: configuration.model,
    ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
    ...(configuration.reasoning === undefined ? {} : { reasoning: encodeSubmissionReasoning(configuration.reasoning) }),
    ...(configuration.responseFormat === undefined ? {} : { responseFormat: typeof configuration.responseFormat === 'string'
      ? configuration.responseFormat
      : Object.freeze({ type: 'json_schema', schema: configuration.responseFormat.schema }) }) });
}

function encodeSubmissionReasoning(reasoning: NonNullable<SessionSubmissionConfiguration['reasoning']>): JsonObject {
  switch (reasoning.strategy) {
    case 'disabled': return Object.freeze({ strategy: 'disabled' });
    case 'enabled': return Object.freeze({ strategy: 'enabled', ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary }) });
    case 'effort': return Object.freeze({ strategy: 'effort', effort: reasoning.effort,
      ...(reasoning.mode === undefined ? {} : { mode: reasoning.mode }), ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary }) });
    case 'budget': return Object.freeze({ strategy: 'budget', maxTokens: reasoning.maxTokens,
      ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary }) });
  }
}

function encodeSubmissionInput(input: SessionSubmissionInput): JsonObject {
  return Object.freeze({ task: input.task,
    ...(input.instructions === undefined ? {} : { instructions: Object.freeze([...input.instructions]) }),
    ...(input.contextItems === undefined ? {} : { contextItems: Object.freeze(input.contextItems.map(encodeContextItem)) }) });
}

function encodeContextItem(item: NonNullable<SessionSubmissionInput['contextItems']>[number]): JsonObject {
  return Object.freeze({ sourceUri: item.sourceUri, sourceKind: item.sourceKind,
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }), representation: item.representation,
    mediaType: item.mediaType, title: item.title, content: item.content,
    ...(item.range === undefined ? {} : { range: Object.freeze({ kind: item.range.kind,
      ...(item.range.start === undefined ? {} : { start: item.range.start }), ...(item.range.end === undefined ? {} : { end: item.range.end }) }) }),
    selectionReason: item.selectionReason, score: item.score,
    ...(item.id === undefined ? {} : { id: item.id }), ...(item.tokenEstimate === undefined ? {} : { tokenEstimate: item.tokenEstimate }) });
}

function assertStableBranch(state: SessionFileState): void {
  const branch = activeBranch(state.branchEntries, branchLeaf(state.branchEntries));
  const completed = new Set(state.projections.map((projection) => projection.runId));
  if (branch.some((entry) => entry.type === 'input' && !completed.has(entry.runId))) throw new Error('Session compaction requires every run on the active branch to be finalized.');
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nodeCode(error: unknown): string | undefined { return isRecord(error) && typeof error.code === 'string' ? error.code : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
