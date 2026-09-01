import { randomUUID } from 'node:crypto';
import { hashJson, PersistenceConflictError, validateArtifactRef } from '@agent-core/persistence';
import { normalizeJsonSafe, type JsonObject, type JsonValue } from '@agent-core/json';
import { createAgentTerminalSnapshot, terminalSnapshotFingerprint, type AgentEffectiveInstruction, type AgentTerminalSnapshot, type AgentToolCallAttemptIdentity, type AgentToolCallIdentity, type AgentTurnIdentity } from '../run/contracts.js';
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
  SessionRunFinalization,
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
  SessionSummary,
  SessionSteeringEntry,
  SessionToolCallEntry
} from './contracts.js';
import { createSessionSubmissionTransition, ownSessionSubmissionConfiguration, ownSessionSubmissionInput, pendingSessionSubmissions } from './submission-lifecycle.js';
import { assertSessionBinding, createSessionBinding, decodeSessionBinding, type SessionBindingInput } from './binding.js';

export class InMemorySessionRepository implements SessionRepository {
  private readonly states = new Map<string, SessionState>();
  private queue: Promise<void> = Promise.resolve();

  create(options: CreateSessionOptions): Promise<SessionDescriptor> {
    const id = options.id ?? randomUUID();
    return this.serial(() => {
      if (this.states.has(id)) throw new Error(`Session already exists: ${id}`);
      const binding = createSessionBinding(options.binding);
      if (options.parent) {
        const parent = this.requireDescriptor(options.parent);
        assertSessionBinding(binding, parent.header.binding);
      }
      const header: SessionHeader = Object.freeze({
        type: 'session', version: 1, id, timestamp: new Date().toISOString(), binding,
        ...(options.parent ? { parentSessionId: options.parent.id } : {}),
        ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {})
      });
      const state = { header, branchEntries: [], finalizations: [], submissionRecords: [] };
      this.states.set(id, state);
      return sessionFromState(state);
    });
  }

  open(sessionId: string, expectedBinding: SessionBindingInput): Promise<SessionDescriptor> {
    return this.serial(() => {
      const state = this.require(sessionId);
      assertSessionBinding(expectedBinding, state.header.binding);
      return sessionFromState(state);
    });
  }

  list(): Promise<readonly SessionSummary[]> {
    return this.serial(() => Object.freeze([...this.states.values()].map((state) => Object.freeze({
      id: state.header.id, timestamp: state.header.timestamp, updatedAt: sessionUpdatedAt(state),
      ...(state.header.provider ? { provider: state.header.provider } : {}), ...(state.header.model ? { model: state.header.model } : {}),
      bindingSchemaId: state.header.binding.schemaId, bindingSchemaVersion: state.header.binding.schemaVersion, bindingSha256: state.header.binding.bindingSha256
    })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))));
  }

  loadReplayState(session: SessionDescriptor, leafId?: string | null): Promise<SessionReplayState> {
    return this.serial(() => {
      const state = this.requireDescriptor(session); const current = sessionFromState(state);
      const branch = Object.freeze(activeBranch(state.branchEntries, leafId === undefined ? current.leafId : leafId));
      const compaction = [...branch].reverse().find((entry): entry is SessionCompactionEntry => entry.type === 'compaction');
      const compactionIndex = compaction ? branch.findIndex((entry) => entry.id === compaction.id) : -1;
      const tailStart = compactionIndex + 1;
      const tailRunIds = [...new Set(branch.slice(tailStart).flatMap((entry) => entry.type === 'input' ? [entry.runId] : []))];
      const branchIds = new Set(branch.slice(tailStart).map((entry) => entry.id));
      const runFinalizations = Object.freeze(state.finalizations.filter((finalization) => branchIds.has(finalization.throughEntryId)));
      const endedRunIds = new Set(runFinalizations.map((finalization) => finalization.runId));
      const openRunIds = tailRunIds.filter((runId) => !endedRunIds.has(runId));
      const latestEndedRunId = runFinalizations.at(-1)?.runId;
      const ledgerRunIds = Object.freeze([...openRunIds, ...(latestEndedRunId ? [latestEndedRunId] : [])]);
      return Object.freeze({ session: current, branch, runFinalizations, ...(compaction ? { compaction } : {}), ledgerRunIds });
    });
  }

  async readConversation(session: SessionDescriptor): Promise<readonly SessionConversationItem[]> {
    const replay = await this.loadReplayState(session);
    return Object.freeze(replay.branch.filter((entry): entry is SessionConversationItem => entry.type !== 'branch' && entry.type !== 'model_settings'));
  }

  listBranchPoints(session: SessionDescriptor): Promise<readonly SessionBranchPoint[]> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const points: SessionBranchPoint[] = state.finalizations.map((finalization) => Object.freeze({
        entryId: finalization.throughEntryId, timestamp: finalization.timestamp, kind: 'run_finalization' as const,
        finalizationId: finalization.finalizationId, runId: finalization.runId
      }));
      for (const entry of state.branchEntries) {
        if (entry.type === 'compaction') points.push(Object.freeze({ entryId: entry.id, timestamp: entry.timestamp, kind: 'compaction' }));
      }
      return Object.freeze(points);
    });
  }

  appendInput(session: SessionDescriptor, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const existing = state.branchEntries.find((entry): entry is SessionInputEntry => entry.type === 'input' && entry.runId === input.runId);
      if (existing) {
        if (!sameSessionInput(existing, input)) throw new PersistenceConflictError(`Conflicting session input for run ${input.runId}.`);
        return existing;
      }
      const entry = Object.freeze({
        ...baseEntry(branchLeaf(state.branchEntries)), type: 'input' as const, runId: input.runId, task: input.task,
        instructions: Object.freeze((input.instructions ?? []).map((instruction) => Object.freeze({ ...instruction })))
      });
      state.branchEntries.push(entry);
      return entry;
    });
  }
  appendSteering(session: SessionDescriptor, input: { runId: string; content: string }): Promise<SessionSteeringEntry> {
    return this.append(session, (parentId) => Object.freeze({ ...baseEntry(parentId), type: 'steering', runId: input.runId, content: input.content }));
  }
  appendAssistant(session: SessionDescriptor, input: { runId: string; identity: AgentTurnIdentity; content: string }): Promise<SessionAssistantEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const existing = state.branchEntries.find((entry): entry is SessionAssistantEntry => entry.type === 'assistant'
        && entry.runId === input.runId && entry.turnId === input.identity.turnId && entry.requestAttempt === input.identity.requestAttempt);
      if (existing) {
        if (existing.turnIndex !== input.identity.turnIndex || existing.content !== input.content) throw new PersistenceConflictError(`Conflicting assistant finalization for ${input.runId}/${input.identity.turnId}/${String(input.identity.requestAttempt)}.`);
        return existing;
      }
      const entry: SessionAssistantEntry = Object.freeze({
        ...baseEntry(branchLeaf(state.branchEntries)), type: 'assistant', runId: input.runId, ...input.identity, content: input.content
      });
      state.branchEntries.push(entry);
      return entry;
    });
  }
  appendToolCall(session: SessionDescriptor, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
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
      state.branchEntries.push(entry);
      return entry;
    });
  }
  appendObservation(session: SessionDescriptor, input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Promise<SessionObservationEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
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
  appendModelSettings(session: SessionDescriptor, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry> {
    return this.append(session, (parentId) => Object.freeze({ ...baseEntry(parentId), type: 'model_settings', provider: settings.provider, model: settings.model,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }), ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }) }));
  }
  appendCompaction(session: SessionDescriptor, input: { summary: string; provider: string; model: string }): Promise<SessionCompactionEntry> {
    return this.serial(() => {
    const state = this.requireDescriptor(session);
    assertStableBranch(state);
    const summary = input.summary.trim();
    if (summary.length === 0) throw new Error('Session compaction summary must not be empty.');
    if (Buffer.byteLength(summary, 'utf8') > 64 * 1024) throw new Error('Session compaction summary exceeds 64 KiB.');
      const entry: SessionCompactionEntry = Object.freeze({
        ...baseEntry(branchLeaf(state.branchEntries)), type: 'compaction', summary, provider: input.provider, model: input.model
      });
      state.branchEntries.push(entry);
      return entry;
    });
  }
  branchFrom(session: SessionDescriptor, entryId: string, label?: string): Promise<SessionBranchMarkerEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const source = state.branchEntries.find((entry) => entry.id === entryId);
      if (!source) throw new Error(`Unknown entry: ${entryId}`);
      if (source.type !== 'compaction' && !state.finalizations.some((finalization) => finalization.throughEntryId === entryId)) {
        throw new Error(`Session branches require a completed final or compaction entry: ${entryId}`);
      }
      const entry: SessionBranchMarkerEntry = Object.freeze({ ...baseEntry(entryId), type: 'branch', fromEntryId: entryId, ...(label ? { label } : {}) });
      state.branchEntries.push(entry);
      return entry;
    });
  }
  recordRunFinalization(session: SessionDescriptor, terminalInput: AgentTerminalSnapshot): Promise<SessionRunFinalization> {
    return this.serial(() => {
      const state = this.requireDescriptor(session); const terminal = createAgentTerminalSnapshot(terminalInput);
      const existing = state.finalizations.find((finalization) => finalization.finalizationId === terminal.finalizationId);
      if (existing) {
        if (terminalSnapshotFingerprint(existing.terminal) !== terminalSnapshotFingerprint(terminal)) throw new PersistenceConflictError(`Conflicting finalization ${terminal.finalizationId}.`);
        return existing;
      }
      const throughEntryId = branchLeaf(state.branchEntries);
      if (!throughEntryId || !activeBranch(state.branchEntries, throughEntryId).some((entry) => entry.type === 'input' && entry.runId === terminal.runId)) {
        throw new Error(`Cannot record finalization ${terminal.finalizationId}: run ${terminal.runId} is not on the active session branch.`);
      }
      const finalization: SessionRunFinalization = Object.freeze({ type: 'run_finalization', id: randomUUID(), timestamp: new Date().toISOString(), throughEntryId, runId: terminal.runId, finalizationId: terminal.finalizationId, terminal });
      state.finalizations.push(finalization);
      return finalization;
    });
  }

  enqueueSubmission(session: SessionDescriptor, input: { submissionId: string; runId: string; input: SessionSubmissionInput; configuration: SessionSubmissionConfiguration }): Promise<void> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      if (state.submissionRecords.some((record) => record.submissionId === input.submissionId)) throw new Error(`Duplicate session submission: ${input.submissionId}`);
      state.submissionRecords.push(Object.freeze({
        type: 'submission.queued', submissionId: input.submissionId, runId: input.runId,
        timestamp: new Date().toISOString(), input: ownSessionSubmissionInput(input.input), configuration: ownSessionSubmissionConfiguration(input.configuration)
      }));
    });
  }
  transitionSubmission(session: SessionDescriptor, submissionId: string, outcome:
    | { readonly state: 'claimed' | 'completed' }
    | { readonly state: 'suspended'; readonly suspension: import('./contracts.js').SessionSuspensionDescriptor }
    | { readonly state: 'failed'; readonly errorMessage: string }): Promise<void> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const record = createSessionSubmissionTransition(state.submissionRecords, submissionId, outcome);
      if (record) state.submissionRecords.push(record);
    });
  }
  loadPendingSubmissions(session: SessionDescriptor): Promise<readonly SessionPendingSubmission[]> {
    return this.serial(() => pendingSessionSubmissions(this.requireDescriptor(session).submissionRecords));
  }

  private append<T extends SessionBranchEntry>(session: SessionDescriptor, create: (parentId: string | null) => T): Promise<T> {
    return this.serial(() => { const state = this.requireDescriptor(session); const entry = create(branchLeaf(state.branchEntries)); state.branchEntries.push(entry); return entry; });
  }
  private require(sessionId: string): SessionState { const state = this.states.get(sessionId); if (!state) throw new Error(`Unknown session: ${sessionId}`); return state; }
  private requireDescriptor(session: SessionDescriptor): SessionState {
    const state = this.require(session.id);
    assertSessionBinding(decodeSessionBinding(session.header.binding), state.header.binding);
    return state;
  }
  private serial<T>(operation: () => T | PromiseLike<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.then(() => undefined, () => undefined); return result; }
}

function sessionUpdatedAt(state: SessionState): string {
  return [...state.branchEntries, ...state.finalizations, ...state.submissionRecords]
    .reduce((latest, entry) => entry.timestamp > latest ? entry.timestamp : latest, state.header.timestamp);
}

interface SessionState { readonly header: SessionHeader; readonly branchEntries: SessionBranchEntry[]; readonly finalizations: SessionRunFinalization[]; readonly submissionRecords: SessionSubmissionRecord[] }
function activeBranch(entries: readonly SessionBranchEntry[], leafId: string | null): SessionBranchEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const output: SessionBranchEntry[] = []; let cursor = leafId;
  while (cursor) { const entry = byId.get(cursor); if (!entry) throw new Error(`Session branch points to missing entry: ${cursor}`); output.push(entry); cursor = entry.parentId; }
  return output.reverse();
}
function branchLeaf(entries: readonly SessionBranchEntry[]): string | null { return entries.at(-1)?.id ?? null; }
function sessionFromState(state: SessionState): SessionDescriptor { return Object.freeze({ id: state.header.id, header: state.header, leafId: branchLeaf(state.branchEntries) }); }
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
function sameSessionInput(existing: SessionInputEntry, input: { readonly runId: string; readonly task: string; readonly instructions?: readonly AgentEffectiveInstruction[] }): boolean {
  return existing.task === input.task && JSON.stringify(existing.instructions) === JSON.stringify(input.instructions ?? []);
}
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

function assertStableBranch(state: SessionState): void {
  const branch = activeBranch(state.branchEntries, branchLeaf(state.branchEntries));
  const completed = new Set(state.finalizations.map((finalization) => finalization.runId));
  if (branch.some((entry) => entry.type === 'input' && !completed.has(entry.runId))) {
    throw new Error('Session compaction requires every run on the active branch to be finalized.');
  }
}

export type * from './contracts.js';
