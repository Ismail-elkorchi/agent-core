import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  isJsonObject,
  normalizeJsonSafe,
  type ArtifactRef,
  type JsonObject,
  type JsonValue,
  validateArtifactRef
} from '@agent-core/evidence';
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
  parseAgentTerminalSnapshot,
  terminalSnapshotFingerprint,
  type AgentEffectiveInstruction,
  type AgentToolCallAttemptIdentity,
  type AgentToolCallIdentity,
  type AgentTurnIdentity,
  type AgentTerminalSnapshot
} from '../run/contracts.js';
import type {
  AgentSession,
  BaseSessionEntry,
  CreateSessionOptions,
  SessionBranchEntry,
  SessionBranchMarkerEntry,
  SessionContextProjection,
  SessionFinalProjection,
  SessionHeader,
  SessionInputEntry,
  SessionModelSettingsEntry,
  SessionObservationEntry,
  SessionObservationInput,
  SessionReplayState,
  SessionRepository,
  SessionSummary,
  SessionToolCallEntry
} from './contracts.js';
import { createSessionContextProjection } from './context-projection.js';

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

  async create(options: CreateSessionOptions): Promise<AgentSession> {
    const id = options.id ?? randomUUID();
    return this.enqueue(id, () => withPersistenceFileLock(this.filePath(id), this.lockTimeoutMs, this.staleLockMs, async () => {
      const header: SessionHeader = {
        type: 'session', version: 1, id, timestamp: new Date().toISOString(),
        workspaceRoot: await canonicalWorkspaceRoot(options.workspaceRoot),
        ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {})
      };
      await fs.mkdir(this.rootDir, { recursive: true });
      const serialized = `${JSON.stringify(header)}\n`;
      await fs.writeFile(this.filePath(id), serialized, { encoding: 'utf8', flag: 'wx' });
      const completeBytes = Buffer.byteLength(serialized, 'utf8');
      this.indexes.set(id, { header, branchEntries: [], projections: [], contextProjections: [], completeBytes, boundaryMarker: Buffer.from(serialized).subarray(-256).toString('base64'), storageStamp: await jsonlStorageStamp(this.filePath(id)) });
      return { id, header, leafId: null };
    }));
  }

  async open(sessionId: string): Promise<AgentSession> {
    const state = await this.enqueue(sessionId, () => this.refreshIndex(sessionId, false));
    return sessionFromState(state);
  }

  async list(workspaceRoot?: string): Promise<readonly SessionSummary[]> {
    const wanted = workspaceRoot ? await canonicalWorkspaceRoot(workspaceRoot) : undefined;
    let names: string[];
    try { names = await fs.readdir(this.rootDir); }
    catch (error) { if (nodeCode(error) === 'ENOENT') return []; throw error; }
    const summaries: SessionSummary[] = [];
    for (const name of names.sort()) {
      const id = /^session-(.+)\.jsonl$/u.exec(name)?.[1];
      if (!id) continue;
      const session = await this.open(id);
      if (wanted && session.header.workspaceRoot !== wanted) continue;
      summaries.push({
        id, workspaceRoot: session.header.workspaceRoot, timestamp: session.header.timestamp,
        ...(session.header.provider ? { provider: session.header.provider } : {}),
        ...(session.header.model ? { model: session.header.model } : {})
      });
    }
    return summaries.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  }

  async loadReplayState(sessionId: string, leafId?: string | null): Promise<SessionReplayState> {
    const state = await this.enqueue(sessionId, () => this.refreshIndex(sessionId, false));
    const session = sessionFromState(state);
    const branch = activeBranch(state.branchEntries, leafId === undefined ? session.leafId : leafId);
    const branchIds = new Set(branch.map((entry) => entry.id));
    const contextProjection = [...state.contextProjections].reverse().find((projection) => branchIds.has(projection.throughEntryId));
    const latestEndedRunId = contextProjection?.recentTurns.at(-1)?.runId;
    const tailStart = contextProjection ? branch.findIndex((entry) => entry.id === contextProjection.throughEntryId) + 1 : 0;
    const tailRunIds = [...new Set(branch.slice(tailStart).flatMap((entry) => entry.type === 'input' ? [entry.runId] : []))];
    const relevantRunIds = new Set([...tailRunIds, ...(latestEndedRunId ? [latestEndedRunId] : [])]);
    const terminalProjections = state.projections.filter((projection) => relevantRunIds.has(projection.runId));
    const endedRunIds = new Set(terminalProjections.map((projection) => projection.runId));
    const openRunIds = tailRunIds.filter((runId) => !endedRunIds.has(runId));
    const ledgerRunIds = [...new Set([...openRunIds, ...(latestEndedRunId ? [latestEndedRunId] : [])])];
    return { session, branch, terminalProjections, ...(contextProjection ? { contextProjection } : {}), ledgerRunIds };
  }

  appendInput(sessionId: string, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry> {
    return this.appendBranchEntry(sessionId, (parentId) => ({
      ...baseEntry(parentId), type: 'input', runId: input.runId, task: input.task, instructions: Object.freeze([...(input.instructions ?? [])])
    }));
  }

  appendToolCall(sessionId: string, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry> {
    return this.appendBranchEntry(sessionId, (parentId) => ({
      ...baseEntry(parentId), type: 'tool_call', runId: input.runId, ...input.identity, call: normalizeJsonSafe(input.call).value
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
      const entry: SessionObservationEntry = { ...baseEntry(branchLeaf(state.branchEntries)), type: 'observation', ...normalized };
      await appendJsonlRecord(this.filePath(sessionId), entry);
      state.branchEntries.push(entry);
      state.completeBytes += recordBytes(entry);
      state.boundaryMarker = await jsonlBoundaryMarker(this.filePath(sessionId), state.completeBytes);
      state.storageStamp = await jsonlStorageStamp(this.filePath(sessionId));
      return entry;
    }));
  }

  appendModelSettings(sessionId: string, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry> {
    return this.appendBranchEntry(sessionId, (parentId) => ({
      ...baseEntry(parentId), type: 'model_settings', provider: settings.provider, model: settings.model,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
      ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort })
    }));
  }

  branchFrom(sessionId: string, entryId: string, label?: string): Promise<SessionBranchMarkerEntry> {
    return this.enqueue(sessionId, () => withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs, this.staleLockMs, async () => {
      const state = await this.refreshIndex(sessionId, true);
      if (!state.branchEntries.some((entry) => entry.id === entryId)) throw new Error(`Cannot branch from unknown entry: ${entryId}`);
      const entry: SessionBranchMarkerEntry = { ...baseEntry(entryId), type: 'branch', fromEntryId: entryId, ...(label ? { label } : {}) };
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
      const terminal = parseAgentTerminalSnapshot(terminalInput);
      const state = await this.refreshIndex(sessionId, true);
      const existing = state.projections.find((projection) => projection.finalizationId === terminal.finalizationId);
      if (existing) {
        if (terminalSnapshotFingerprint(existing.terminal) !== terminalSnapshotFingerprint(terminal)) throw new PersistenceConflictError(`Conflicting session projection for finalization ${terminal.finalizationId}.`);
        if (!state.contextProjections.some((projection) => projection.throughFinalizationId === terminal.finalizationId)) {
          await this.appendContextProjection(sessionId, state, contextProjectionForTerminal(state, terminal));
        }
        return existing;
      }
      const contextProjection = contextProjectionForTerminal(state, terminal);
      const projection: SessionFinalProjection = {
        type: 'final', id: randomUUID(), timestamp: new Date().toISOString(), runId: terminal.runId,
        finalizationId: terminal.finalizationId, terminal
      };
      await appendJsonlRecord(this.filePath(sessionId), projection);
      state.projections.push(projection);
      state.completeBytes += recordBytes(projection);
      await this.appendContextProjection(sessionId, state, contextProjection);
      state.boundaryMarker = await jsonlBoundaryMarker(this.filePath(sessionId), state.completeBytes);
      state.storageStamp = await jsonlStorageStamp(this.filePath(sessionId));
      return projection;
    }));
  }

  private async appendContextProjection(sessionId: string, state: SessionAppendIndex, projection: SessionContextProjection): Promise<void> {
    await appendJsonlRecord(this.filePath(sessionId), projection);
    state.contextProjections.push(projection);
    state.completeBytes += recordBytes(projection);
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
      index.contextProjections.splice(0, index.contextProjections.length, ...state.contextProjections);
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
      let value: unknown;
      try { value = JSON.parse(line.text); } catch (error) { throw corruption(filePath, actualLine, line.byteOffset, `Invalid JSON: ${errorMessage(error)}`, 'invalid_json'); }
      try {
        if (isRecord(value) && value.type === 'final') index.projections.push(parseFinalProjection(value));
        else if (isRecord(value) && value.type === 'context') index.contextProjections.push(parseContextProjection(value));
        else {
          const entry = parseBranchEntry(value);
          if (entry.parentId !== null && !index.branchEntries.some((candidate) => candidate.id === entry.parentId)) throw new Error(`Unknown parent ${entry.parentId}.`);
          if (index.branchEntries.some((candidate) => candidate.id === entry.id)) throw new Error(`Duplicate session entry ${entry.id}.`);
          index.branchEntries.push(entry);
        }
      } catch (error) { throw corruption(filePath, actualLine, line.byteOffset, errorMessage(error), 'invalid_record'); }
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

interface SessionFileState { readonly header: SessionHeader; readonly branchEntries: SessionBranchEntry[]; readonly projections: SessionFinalProjection[]; readonly contextProjections: SessionContextProjection[] }
interface SessionAppendIndex extends SessionFileState { completeBytes: number; boundaryMarker: string; storageStamp: JsonlStorageStamp }
function sessionRecordCount(state: SessionFileState): number { return state.branchEntries.length + state.projections.length + state.contextProjections.length; }

async function readSessionFile(filePath: string, sessionId: string): Promise<{ readonly state: SessionFileState; readonly completeBytes: number }> {
  const committed = await readJsonlCommittedFile(filePath);
  const lines = committed.lines;
  if (lines.length === 0) throw corruption(filePath, 1, 0, 'Session is empty.', 'invalid_header');
  const headerLine = lines[0];
  if (headerLine === undefined) throw corruption(filePath, 1, 0, 'Session is empty.', 'invalid_header');
  const header = parseJson(headerLine, filePath);
  if (!isSessionHeader(header, sessionId)) throw corruption(filePath, 1, 0, 'Session header is invalid.', 'invalid_header');
  const branchEntries: SessionBranchEntry[] = [];
  const projections: SessionFinalProjection[] = [];
  const contextProjections: SessionContextProjection[] = [];
  for (const line of lines.slice(1)) {
    if (line.text.trim().length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(line.text); }
    catch (error) { throw corruption(filePath, line.line, line.byteOffset, `Invalid JSON: ${errorMessage(error)}`, 'invalid_json'); }
    try {
      if (isRecord(value) && value.type === 'final') projections.push(parseFinalProjection(value));
      else if (isRecord(value) && value.type === 'context') contextProjections.push(parseContextProjection(value));
      else branchEntries.push(parseBranchEntry(value));
    } catch (error) { throw corruption(filePath, line.line, line.byteOffset, errorMessage(error), 'invalid_record'); }
  }
  validateParents(branchEntries, filePath);
  return { state: { header, branchEntries, projections, contextProjections }, completeBytes: committed.completeBytes };
}

function parseBranchEntry(value: unknown): SessionBranchEntry {
  if (!isRecord(value) || !validBaseEntry(value)) throw new Error('Session entry base is invalid.');
  if (isSessionInputEntry(value)) return value;
  if (isSessionToolCallEntry(value)) return value;
  if (isSessionObservationEntry(value)) return value;
  if (isSessionBranchMarkerEntry(value)) return value;
  if (isSessionModelSettingsEntry(value)) return value;
  throw new Error(`Unsupported or malformed session entry: ${String(value.type)}`);
}
function parseFinalProjection(value: Record<string, unknown>): SessionFinalProjection {
  if (typeof value.id !== 'string' || typeof value.timestamp !== 'string' || typeof value.runId !== 'string' || typeof value.finalizationId !== 'string') throw new Error('Final projection identity is invalid.');
  const terminal = parseAgentTerminalSnapshot(value.terminal);
  if (terminal.runId !== value.runId || terminal.finalizationId !== value.finalizationId) throw new Error('Final projection identity conflicts with terminal snapshot.');
  return { type: 'final', id: value.id, timestamp: value.timestamp, runId: value.runId, finalizationId: value.finalizationId, terminal };
}
function parseContextProjection(value: Record<string, unknown>): SessionContextProjection {
  if (typeof value.id !== 'string' || typeof value.timestamp !== 'string' || typeof value.throughEntryId !== 'string' || typeof value.throughFinalizationId !== 'string' || typeof value.historyDigest !== 'string') throw new Error('Context projection identity is invalid.');
  if (!Array.isArray(value.recentTurns)) throw new Error('Context projection turn digests are invalid.');
  return {
    type: 'context',
    id: value.id,
    timestamp: value.timestamp,
    throughEntryId: value.throughEntryId,
    throughFinalizationId: value.throughFinalizationId,
    historyDigest: value.historyDigest,
    recentTurns: value.recentTurns.map(parseSessionTurnDigest)
  };
}
function parseSessionTurnDigest(value: unknown): SessionContextProjection['recentTurns'][number] {
  if (!isRecord(value) || typeof value.runId !== 'string' || typeof value.finalizationId !== 'string' || typeof value.task !== 'string' || typeof value.status !== 'string' || (value.result !== undefined && typeof value.result !== 'string')) {
    throw new Error('Context projection turn digest is invalid.');
  }
  return {
    runId: value.runId,
    finalizationId: value.finalizationId,
    task: value.task,
    status: value.status,
    ...(typeof value.result === 'string' ? { result: value.result } : {})
  };
}
function activeBranch(entries: readonly SessionBranchEntry[], leafId: string | null): SessionBranchEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const output: SessionBranchEntry[] = []; let cursor = leafId;
  while (cursor) { const entry = byId.get(cursor); if (!entry) throw new Error(`Session branch points to missing entry: ${cursor}`); output.push(entry); cursor = entry.parentId; }
  return output.reverse();
}
function branchLeaf(entries: readonly SessionBranchEntry[]): string | null { return entries.at(-1)?.id ?? null; }
function contextProjectionForTerminal(state: SessionFileState, terminal: AgentTerminalSnapshot): SessionContextProjection {
  const throughEntryId = branchLeaf(state.branchEntries);
  if (!throughEntryId) throw new Error('Cannot project a final without a session branch entry.');
  const branch = activeBranch(state.branchEntries, throughEntryId);
  if (!branch.some((entry) => entry.type === 'input' && entry.runId === terminal.runId)) {
    throw new Error(`Cannot project finalization ${terminal.finalizationId}: run ${terminal.runId} is not on the active session branch.`);
  }
  const branchIds = new Set(branch.map((entry) => entry.id));
  const previous = [...state.contextProjections].reverse().find((projection) => branchIds.has(projection.throughEntryId));
  return createSessionContextProjection({ branchEntries: branch, terminal, throughEntryId, ...(previous ? { previous } : {}) });
}
function sessionFromState(state: SessionFileState): AgentSession { return { id: state.header.id, header: state.header, leafId: branchLeaf(state.branchEntries) }; }
function baseEntry(parentId: string | null): BaseSessionEntry { return { id: randomUUID(), parentId, timestamp: new Date().toISOString() }; }
function validateParents(entries: readonly SessionBranchEntry[], filePath: string): void {
  const ids = new Set<string>();
  for (const entry of entries) { if (ids.has(entry.id)) throw new Error(`Duplicate session entry ${entry.id} in ${filePath}.`); if (entry.parentId !== null && !ids.has(entry.parentId)) throw new Error(`Unknown parent ${entry.parentId} in ${filePath}.`); ids.add(entry.id); }
}
function isSessionHeader(value: unknown, sessionId: string): value is SessionHeader {
  return isRecord(value) && value.type === 'session' && value.version === 1 && value.id === sessionId && typeof value.timestamp === 'string' && typeof value.workspaceRoot === 'string';
}
function recordBytes(record: unknown): number { return Buffer.byteLength(`${JSON.stringify(record)}\n`, 'utf8'); }
function normalizedObservationInput(input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'> {
  const artifacts = input.observation.artifacts?.map((artifact) => { validateArtifactRef(artifact); return Object.freeze({ ...artifact }); });
  return {
    runId: input.runId, ...input.identity, toolName: input.toolName, ok: input.observation.ok, summary: input.observation.summary,
    ...(input.observation.output === undefined ? {} : { output: normalizeJsonSafe(input.observation.output).value }),
    ...(artifacts && artifacts.length > 0 ? { artifacts: Object.freeze(artifacts) } : {}),
    ...(input.observation.metadata ? { metadata: normalizeMetadata(input.observation.metadata) } : {})
  };
}
function normalizeMetadata(value: unknown): JsonObject {
  const normalized = normalizeJsonSafe(value).value;
  return isJsonObject(normalized) ? normalized : Object.freeze({ value: normalized });
}
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
function parseJson(line: JsonlLine, storage: string): unknown { try { return JSON.parse(line.text); } catch (error) { throw corruption(storage, line.line, line.byteOffset, errorMessage(error), 'invalid_json'); } }
function corruption(storage: string, line: number, byteOffset: number, message: string, code: PersistenceCorruptionError['code']): PersistenceCorruptionError { return new PersistenceCorruptionError({ code, storage, line, byteOffset, message }); }
async function canonicalWorkspaceRoot(rootDir: string): Promise<string> { return fs.realpath(path.resolve(rootDir)); }
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
    && (value.provenance === 'application' || value.provenance === 'run' || value.provenance === 'steering')
    && (value.role === undefined || typeof value.role === 'string') && (value.sourceUri === undefined || typeof value.sourceUri === 'string')
    && (value.priority === undefined || (typeof value.priority === 'number' && Number.isFinite(value.priority)));
}
function isSessionInputEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionInputEntry {
  return value.type === 'input' && typeof value.runId === 'string' && value.runId.length > 0 && typeof value.task === 'string'
    && Array.isArray(value.instructions) && value.instructions.every(isEffectiveInstruction);
}
function isSessionToolCallEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionToolCallEntry {
  return value.type === 'tool_call' && validTurnIdentity(value) && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.toolBatchId === 'string' && value.toolBatchId.length > 0 && nonnegativeInteger(value.callIndex)
    && (value.callId === undefined || typeof value.callId === 'string') && isJson(value.call);
}
function isSessionObservationEntry(value: Record<string, unknown> & BaseSessionEntry): value is Record<string, unknown> & SessionObservationEntry {
  return value.type === 'observation' && validTurnIdentity(value) && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.toolName === 'string' && value.toolName.length > 0 && typeof value.ok === 'boolean' && typeof value.summary === 'string'
    && (value.output === undefined || isJson(value.output)) && (value.metadata === undefined || isJsonObject(value.metadata))
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
function isJson(value: unknown): value is JsonValue { if (value === null || typeof value === 'string' || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (Array.isArray(value)) return value.every(isJson); return isRecord(value) && Object.values(value).every(isJson); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nodeCode(error: unknown): string | undefined { return isRecord(error) && typeof error.code === 'string' ? error.code : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
