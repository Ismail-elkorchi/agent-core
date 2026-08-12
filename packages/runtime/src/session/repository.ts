import { randomUUID } from 'node:crypto';
import { validateArtifactRef } from '@agent-core/evidence';
import { normalizeJsonSafe, type JsonObject, type JsonValue } from '@agent-core/json';
import { PersistenceConflictError } from '@agent-core/evidence';
import { createAgentTerminalSnapshot, terminalSnapshotFingerprint, type AgentEffectiveInstruction, type AgentTerminalSnapshot, type AgentToolCallAttemptIdentity, type AgentToolCallIdentity, type AgentTurnIdentity } from '../run/contracts.js';
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

export class InMemorySessionRepository implements SessionRepository {
  private readonly states = new Map<string, SessionState>();
  private queue: Promise<void> = Promise.resolve();

  create(options: CreateSessionOptions): Promise<AgentSession> {
    const id = options.id ?? randomUUID();
    return this.serial(() => {
      if (this.states.has(id)) throw new Error(`Session already exists: ${id}`);
      const header: SessionHeader = Object.freeze({
        type: 'session', version: 1, id, timestamp: new Date().toISOString(), workspaceRoot: options.workspaceRoot,
        ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
        ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {})
      });
      const state = { header, branchEntries: [], projections: [], contextProjections: [] };
      this.states.set(id, state);
      return sessionFromState(state);
    });
  }

  open(sessionId: string): Promise<AgentSession> { return this.serial(() => sessionFromState(this.require(sessionId))); }

  list(workspaceRoot?: string): Promise<readonly SessionSummary[]> {
    return this.serial(() => Object.freeze([...this.states.values()].filter((state) => workspaceRoot === undefined || state.header.workspaceRoot === workspaceRoot).map((state) => Object.freeze({
      id: state.header.id, workspaceRoot: state.header.workspaceRoot, timestamp: state.header.timestamp, updatedAt: sessionUpdatedAt(state),
      ...(state.header.provider ? { provider: state.header.provider } : {}), ...(state.header.model ? { model: state.header.model } : {})
    })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))));
  }

  loadReplayState(sessionId: string, leafId?: string | null): Promise<SessionReplayState> {
    return this.serial(() => {
      const state = this.require(sessionId); const session = sessionFromState(state);
      const branch = Object.freeze(activeBranch(state.branchEntries, leafId === undefined ? session.leafId : leafId));
      const branchIds = new Set(branch.map((entry) => entry.id));
      const contextProjection = [...state.contextProjections].reverse().find((projection) => branchIds.has(projection.throughEntryId));
      const latestEndedRunId = contextProjection?.recentTurns.at(-1)?.runId;
      const tailStart = contextProjection ? branch.findIndex((entry) => entry.id === contextProjection.throughEntryId) + 1 : 0;
      const tailRunIds = [...new Set(branch.slice(tailStart).flatMap((entry) => entry.type === 'input' ? [entry.runId] : []))];
      const relevantRunIds = new Set([...tailRunIds, ...(latestEndedRunId ? [latestEndedRunId] : [])]);
      const terminalProjections = Object.freeze(state.projections.filter((projection) => relevantRunIds.has(projection.runId)));
      const endedRunIds = new Set(terminalProjections.map((projection) => projection.runId));
      const openRunIds = tailRunIds.filter((runId) => !endedRunIds.has(runId));
      const ledgerRunIds = Object.freeze([...new Set([...openRunIds, ...(latestEndedRunId ? [latestEndedRunId] : [])])]);
      return Object.freeze({ session, branch, terminalProjections, ...(contextProjection ? { contextProjection } : {}), ledgerRunIds });
    });
  }

  appendInput(sessionId: string, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry> {
    return this.append(sessionId, (parentId) => Object.freeze({
      ...baseEntry(parentId), type: 'input', runId: input.runId, task: input.task,
      instructions: Object.freeze((input.instructions ?? []).map((instruction) => Object.freeze({ ...instruction })))
    }));
  }
  appendToolCall(sessionId: string, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry> {
    return this.append(sessionId, (parentId) => Object.freeze({ ...baseEntry(parentId), type: 'tool_call', runId: input.runId, ...input.identity, call: normalizeJsonSafe(input.call).value }));
  }
  appendObservation(sessionId: string, input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Promise<SessionObservationEntry> {
    return this.serial(() => {
      const state = this.require(sessionId);
      const normalized = normalizedObservationInput(input);
      const key = sessionObservationKey(normalized);
      const existing = key ? state.branchEntries.find((entry): entry is SessionObservationEntry => entry.type === 'observation' && sessionObservationKey(entry) === key) : undefined;
      if (existing) {
        if (!sameObservation(existing, normalized)) throw new PersistenceConflictError(`Conflicting session observation for ${String(key)}.`);
        return existing;
      }
      const entry: SessionObservationEntry = Object.freeze({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'observation', ...normalized });
      state.branchEntries.push(entry);
      return entry;
    });
  }
  appendModelSettings(sessionId: string, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry> {
    return this.append(sessionId, (parentId) => Object.freeze({ ...baseEntry(parentId), type: 'model_settings', provider: settings.provider, model: settings.model,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }), ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }) }));
  }
  branchFrom(sessionId: string, entryId: string, label?: string): Promise<SessionBranchMarkerEntry> {
    return this.serial(() => {
      const state = this.require(sessionId);
      if (!state.branchEntries.some((entry) => entry.id === entryId)) throw new Error(`Unknown entry: ${entryId}`);
      const entry: SessionBranchMarkerEntry = Object.freeze({ ...baseEntry(entryId), type: 'branch', fromEntryId: entryId, ...(label ? { label } : {}) });
      state.branchEntries.push(entry);
      return entry;
    });
  }
  projectFinal(sessionId: string, terminalInput: AgentTerminalSnapshot): Promise<SessionFinalProjection> {
    return this.serial(() => {
      const state = this.require(sessionId); const terminal = createAgentTerminalSnapshot(terminalInput);
      const existing = state.projections.find((projection) => projection.finalizationId === terminal.finalizationId);
      if (existing) {
        if (terminalSnapshotFingerprint(existing.terminal) !== terminalSnapshotFingerprint(terminal)) throw new PersistenceConflictError(`Conflicting finalization ${terminal.finalizationId}.`);
        if (!state.contextProjections.some((projection) => projection.throughFinalizationId === terminal.finalizationId)) {
          state.contextProjections.push(contextProjectionForTerminal(state, terminal));
        }
        return existing;
      }
      const contextProjection = contextProjectionForTerminal(state, terminal);
      const projection: SessionFinalProjection = Object.freeze({ type: 'final', id: randomUUID(), timestamp: new Date().toISOString(), runId: terminal.runId, finalizationId: terminal.finalizationId, terminal });
      state.projections.push(projection);
      state.contextProjections.push(contextProjection);
      return projection;
    });
  }

  private append<T extends SessionBranchEntry>(sessionId: string, create: (parentId: string | null) => T): Promise<T> {
    return this.serial(() => { const state = this.require(sessionId); const entry = create(branchLeaf(state.branchEntries)); state.branchEntries.push(entry); return entry; });
  }
  private require(sessionId: string): SessionState { const state = this.states.get(sessionId); if (!state) throw new Error(`Unknown session: ${sessionId}`); return state; }
  private serial<T>(operation: () => T | PromiseLike<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.then(() => undefined, () => undefined); return result; }
}

function sessionUpdatedAt(state: SessionState): string {
  return [...state.branchEntries, ...state.projections, ...state.contextProjections]
    .reduce((latest, entry) => entry.timestamp > latest ? entry.timestamp : latest, state.header.timestamp);
}

interface SessionState { readonly header: SessionHeader; readonly branchEntries: SessionBranchEntry[]; readonly projections: SessionFinalProjection[]; readonly contextProjections: SessionContextProjection[] }
function activeBranch(entries: readonly SessionBranchEntry[], leafId: string | null): SessionBranchEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const output: SessionBranchEntry[] = []; let cursor = leafId;
  while (cursor) { const entry = byId.get(cursor); if (!entry) throw new Error(`Session branch points to missing entry: ${cursor}`); output.push(entry); cursor = entry.parentId; }
  return output.reverse();
}
function contextProjectionForBranch(projections: readonly SessionContextProjection[], branch: readonly SessionBranchEntry[]): SessionContextProjection | undefined {
  const ids = new Set(branch.map((entry) => entry.id));
  return [...projections].reverse().find((projection) => ids.has(projection.throughEntryId));
}
function contextProjectionForTerminal(state: SessionState, terminal: AgentTerminalSnapshot): SessionContextProjection {
  const throughEntryId = branchLeaf(state.branchEntries);
  if (!throughEntryId) throw new Error('Cannot project a final without a session branch entry.');
  const branch = activeBranch(state.branchEntries, throughEntryId);
  if (!branch.some((entry) => entry.type === 'input' && entry.runId === terminal.runId)) {
    throw new Error(`Cannot project finalization ${terminal.finalizationId}: run ${terminal.runId} is not on the active session branch.`);
  }
  const previous = contextProjectionForBranch(state.contextProjections, branch);
  return createSessionContextProjection({ branchEntries: branch, terminal, throughEntryId, ...(previous ? { previous } : {}) });
}
function branchLeaf(entries: readonly SessionBranchEntry[]): string | null { return entries.at(-1)?.id ?? null; }
function sessionFromState(state: SessionState): AgentSession { return Object.freeze({ id: state.header.id, header: state.header, leafId: branchLeaf(state.branchEntries) }); }
function baseEntry(parentId: string | null): BaseSessionEntry { return { id: randomUUID(), parentId, timestamp: new Date().toISOString() }; }
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
function sessionObservationKey(value: Pick<SessionObservationEntry, 'runId' | 'turnId'> & Partial<Pick<SessionObservationEntry, 'requestAttempt' | 'toolBatchId' | 'callIndex' | 'toolAttempt'>>): string | undefined {
  return value.toolBatchId !== undefined && value.callIndex !== undefined && value.toolAttempt !== undefined
    ? `${value.runId}:${value.turnId}:${String(value.requestAttempt)}:${value.toolBatchId}:${String(value.callIndex)}:${String(value.toolAttempt)}`
    : undefined;
}
function sameObservation(existing: SessionObservationEntry, input: Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'>): boolean { return JSON.stringify(observationPayload(existing)) === JSON.stringify(input); }
function observationPayload(value: SessionObservationEntry): Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'> {
  return {
    runId: value.runId, turnIndex: value.turnIndex, turnId: value.turnId, requestAttempt: value.requestAttempt,
    ...(value.toolBatchId === undefined ? {} : { toolBatchId: value.toolBatchId }), ...(value.callIndex === undefined ? {} : { callIndex: value.callIndex }),
    ...(value.callId === undefined ? {} : { callId: value.callId }), ...(value.toolAttempt === undefined ? {} : { toolAttempt: value.toolAttempt }),
    toolName: value.toolName, ok: value.ok, summary: value.summary,
    ...(value.output === undefined ? {} : { output: value.output }), ...(value.artifacts === undefined ? {} : { artifacts: value.artifacts }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata })
  };
}

export type * from './contracts.js';
