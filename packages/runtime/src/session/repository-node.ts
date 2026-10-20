import type { MaterialAuthorityBoundary } from '../material/contracts.js';
import { materialRevocationSchema } from '../material/repository.js';
import { assertLocalMaterialOwner, decodeSessionMaterialRevocation, localMaterialRevocationReceipt, assertLocalMaterialRevocationRetry } from './material-revocation.js';
import { captureTriggeredSubmission, triggeredRunId, findTriggeredSubmissionReceipt, triggeredSubmissionId, triggeredSubmissionReceipt, assertTriggeredSubmissionRetry, ownSubmissionTrigger } from './triggered-submission.js';
import { materializedSessionInput } from './submission-lifecycle.js';
import { ownPeerContributionInput, samePeerContribution, decodePeerContributionEntry } from './peer-contribution.js';
import { decodeSessionToolCatalogSelection } from './tool-catalog.js';
import { parseToolCatalogSelection, type ToolCatalogSelectionState } from '@agent-core/tools';
import { createSessionRunFinalizationConfirmation, decodeSessionRunFinalizationConfirmation } from './finalization-confirmation.js';
import { recordedModelSelection } from '../orchestration/model-change.js';
import { protectedInferenceInput } from '../inference/input.js';
import type { ProtectedArtifactRef } from '@agent-core/persistence';
import { sessionStateBatchCommitSchema } from './session-state.js';
import { decodeSessionStateBatchEntry, stateReceipt, assertStateRetry } from './state-records.js';
import { decodeToolContent } from '@agent-core/tools';
import { parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { parseModelSelection, type ModelOutputItem, type ModelSelection } from '@agent-core/model';
import { hashJson, validateArtifactRef, type ArtifactRef } from '@agent-core/persistence';
import {
  PersistenceConflictError,
  PersistenceCorruptionError,
  readJsonlCommittedFile,
  withPersistenceFileLock,
  tryAcquirePersistenceFileLock,
  type JsonlLine
} from '@agent-core/persistence/node';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ContextTransitionCommit } from '../context/contracts.js';
import { historyEventSourceSchema } from '../history/schema.js';
import {
  createAgentTerminalSnapshot,
  decodeOwnedAgentTerminalSnapshot,
  terminalSnapshotFingerprint,
  type AgentEffectiveInstruction,
  type AgentTerminalSnapshot,
  type AgentToolCallAttemptIdentity,
  type AgentToolCallIdentity,
  type AgentTurnIdentity
} from '../run/contracts.js';
import { ownSessionAssistantOutput } from './assistant-output.js';
import {
  assertSessionBinding,
  createSessionBinding,
  decodeSessionBinding,
  type SessionBindingInput
} from './binding.js';
import { JsonlBranchIndex } from './branch-index-node.js';
import { SessionHistorySourceError, type HistoryIndexRebuildOptions, type HistoryIndexRecoveryOptions } from './history-index.js';
import {
  assertBranchEntry,
  readBranchPage,
  searchBranch
} from './branch-page.js';
import {
  decodeContextTransitionEntry,
  sessionReplayState
} from './context-records.js';
import type {
  BaseSessionEntry,
  CreateSessionOptions,
  SessionAssistantEntry,
  SessionBranchEntry,
  SessionBranchMarkerEntry,
  SessionBranchPoint,
  SessionContextTransitionEntry,
  SessionConversationItem,
  SessionDescriptor,
  SessionHeader,
  SessionInputEntry,
  SessionInputRelationship,
  SessionModelSettingsEntry,
  SessionObservationEntry,
  SessionObservationInput,
  SessionPendingSubmission,
  SessionReplayState,
  SessionRepository,
  SessionRunFinalization,
  SessionRunFinalizationConfirmation,
  SessionRunFinalizationConfirmationInput,
  SessionSteeringEntry,
  SessionSubmissionConfiguration,
  SessionSubmissionInput,
  SessionSubmissionRecord,
  SessionSummary,
  SessionToolCallEntry
} from './contracts.js';
import { parseSessionImages } from './images.js';
import { captureObservationInput } from './observation.js';
import { ownSessionSteeringInput, sameSessionSteering } from './steering-input.js';
import {
  createQueuedSubmissionUpdate,
  assertSessionAdmissionConfiguration,
  sessionSubmission,
  createSessionSubmissionTransition,
  ownSessionSubmissionInput,
  ownSessionSuspensionDescriptor,
  pendingSessionSubmissions
} from './submission-lifecycle.js';

export interface JsonlSessionRepositoryOptions {
  readonly rootDir: string;
  readonly lockTimeoutMs?: number;
}

export class JsonlSessionRepository implements SessionRepository {
  private readonly rootDir: string;
  private readonly lockTimeoutMs: number;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly branchIndexes = new Map<string, JsonlBranchIndex>();
  private fullScans = 0;
  private incrementalRefreshes = 0;

  constructor(options: JsonlSessionRepositoryOptions | string) {
    this.rootDir = path.resolve(typeof options === 'string' ? options : options.rootDir);
    this.lockTimeoutMs = positiveInteger(
      typeof options === 'string' ? 5_000 : (options.lockTimeoutMs ?? 5_000),
      'lockTimeoutMs'
    );
  }

  location(sessionId: string): string {
    return this.filePath(sessionId);
  }
  indexMetrics(): Readonly<{ fullScans: number; incrementalRefreshes: number }> {
    return Object.freeze({
      fullScans: this.fullScans,
      incrementalRefreshes: this.incrementalRefreshes
    });
  }

  async create(options: CreateSessionOptions): Promise<SessionDescriptor> {
    const id = options.id ?? randomUUID();
    const binding = createSessionBinding(options.binding);
    if (options.parent) {
      const parent = await this.open(options.parent.id, options.parent.header.binding);
      assertSessionBinding(binding, parent.header.binding);
    }
    return this.enqueue(id, () =>
      this.withSessionLock(id, async () => {
        const header: SessionHeader = Object.freeze({
          type: 'session',
          version: 1,
          format: 'agent-core.session/8',
          sessionStateStorage: 'session',
          id,
          timestamp: new Date().toISOString(),
          binding,
          ...(options.parent ? { parentSessionId: options.parent.id } : {}),
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.model ? { model: options.model } : {})
        });
        await fs.mkdir(this.rootDir, { recursive: true });
        const serialized = `${JSON.stringify(header)}\n`;
        await fs.writeFile(this.filePath(id), serialized, { encoding: 'utf8', flag: 'wx' });
        const session = Object.freeze({id, header, leafId: null});
        await this.branchIndex(id).rebuild(binding);
        return session;
      })
    );
  }

  async tryAcquireExecution(session: SessionDescriptor) {
    await this.branchIndex(session.id).checked(session);
    const ownership = await tryAcquirePersistenceFileLock(`${this.filePath(session.id)}.execution`);
    if (!ownership) return undefined;
    return Object.freeze({assertOwned:ownership.assertOwned,
      release:() => this.enqueue(session.id,() => withPersistenceFileLock(this.filePath(session.id),this.lockTimeoutMs,() => ownership.release()))});
  }

  async revision(session: SessionDescriptor): Promise<number> {
    return (await this.branchIndex(session.id).checked(session)).sourceRevision;
  }
  async acceptedCorrectionRevision(session: SessionDescriptor): Promise<number> {
    return (await this.branchIndex(session.id).checked(session)).acceptedCorrectionRevision;
  }
  withMaterialPublication<T>(session: SessionDescriptor, cut: import('../history/contracts.js').HistorySourceCut, operation: () => Promise<T>, boundaries:readonly MaterialAuthorityBoundary[]=[]): Promise<T> {
    return this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
      await this.branchIndex(session.id).validateMaterialSource(session, cut);
      await this.branchIndex(session.id).validateMaterialBoundaries(session,boundaries);
      return operation();
    }));
  }
  materialRevocationRevision(session:SessionDescriptor,owner:import('../material/contracts.js').MaterialOwner):Promise<number> {return this.branchIndex(session.id).materialRevocationRevision(session,owner);}
  isMaterialRevoked(session:SessionDescriptor,ref:import('../material/contracts.js').QualifiedMaterialRef):Promise<boolean> {return this.branchIndex(session.id).isMaterialRevoked(session,ref);}
  withMaterialRevocations<T>(session:SessionDescriptor,boundaries:readonly MaterialAuthorityBoundary[],operation:()=>Promise<T>):Promise<T> {
    return this.enqueue(session.id,()=>this.withSessionLock(session.id,async()=>{await this.branchIndex(session.id).validateMaterialBoundaries(session,boundaries);return operation();}));
  }
  revokeMaterial(session:SessionDescriptor,input:import('../material/contracts.js').MaterialRevocation) {
    const value=materialRevocationSchema.parse(input);assertLocalMaterialOwner(session.id,value.owner);
    return this.enqueue(session.id,()=>this.withSessionLock(session.id,async()=>{
      const index=this.branchIndex(session.id),state=await index.descriptor(session.header.binding);assertDescriptor(session,state);
      const previous=await index.findMaterialRevocation(session,value.operationId);if(previous)return assertLocalMaterialRevocationRetry(previous,value);
      await index.validateMaterialBoundaries(session,[{owner:value.owner,revocationRevision:value.expectedRevision}]);
      const revision=await index.materialRevocationRevision(session,value.owner);
      if(revision!==value.expectedRevision)throw new PersistenceConflictError('Session material revocation revision changed.');
      for(const ref of value.refs)if(!await index.isMaterialRevoked(session,{...ref,owner:value.owner}))await index.readStateItem(session,ref);
      const record=decodeSessionMaterialRevocation({...baseEntry(state.leafId),...value,type:'session_material_revocation',revision:revision+1});
      await this.appendRecord(session.id,state,record);return localMaterialRevocationReceipt(record);
    }));
  }
  async currentModelSettings(session: SessionDescriptor): Promise<ModelSelection | undefined> {
    const entry = await this.branchIndex(session.id).currentModelSettings(session);
    return entry === undefined ? this.branchIndex(session.id).initialModelSettings(session) : recordedModelSelection([entry]);
  }
  async currentToolCatalogSelection(session: SessionDescriptor): Promise<ToolCatalogSelectionState> {
    const state = await this.branchIndex(session.id).toolCatalogSelection(session);
    if (!state) throw new Error('Tool catalog selection is missing.');
    return state;
  }
  findToolCatalogSelection(session: SessionDescriptor, operationId: string): Promise<ToolCatalogSelectionState | undefined> {
    return this.branchIndex(session.id).toolCatalogSelection(session, operationId);
  }
  async saveToolCatalogSelection(session: SessionDescriptor, input: Parameters<SessionRepository['saveToolCatalogSelection']>[1], options: Parameters<SessionRepository['saveToolCatalogSelection']>[2] = {}): Promise<ToolCatalogSelectionState> {
    const selection = parseToolCatalogSelection(input.selection);
    if (options.withOwnership) {
      const previous = await this.findToolCatalogSelection(session,input.operationId);
      if (previous) {
        if (input.ownerId !== previous.ownerId) throw new PersistenceConflictError('Tool catalog branch changed.');
        if (previous.selection.revision !== selection.revision) throw new PersistenceConflictError('Tool catalog operation changed.');
        return previous;
      }
    }
    const publish = () => this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
      const state = await this.branchIndex(session.id).descriptor(session.header.binding);
      assertDescriptor(session, state);
      const current = await this.currentToolCatalogSelection(session);
      if (input.ownerId !== current.ownerId) throw new PersistenceConflictError('Tool catalog branch changed.');
      const previous = await this.findToolCatalogSelection(session, input.operationId);
      if (previous) {
        if (previous.selection.revision !== selection.revision) throw new PersistenceConflictError('Tool catalog operation changed.');
        return previous;
      }
      if (input.expectedRevision !== current.selection.revision) throw new PersistenceConflictError('Tool catalog selection changed.');
      const snapshot = await this.branchIndex(session.id).snapshot(session);
      const entry = decodeSessionToolCatalogSelection({ ...baseEntry(state.leafId), type: 'tool_catalog_selection',
        branchId: snapshot.branchId, operationId: input.operationId, selection });
      await this.appendRecord(session.id, state, entry);
      return Object.freeze({ ownerId: current.ownerId, selection });
    }));
    return options.withOwnership ? options.withOwnership(publish) : publish();
  }
  async committedRetainedStateBytes(session: SessionDescriptor): Promise<number> {
    return (await this.branchIndex(session.id).checked(session)).retainedStateBytes;
  }
  async findSessionStateBatch(session: SessionDescriptor, idempotencyKey: string) {
    const entry = await this.branchIndex(session.id).findStateBatch(session,idempotencyKey);
    return entry ? stateReceipt(entry) : undefined;
  }
  async saveSessionState(session: SessionDescriptor, input: Parameters<SessionRepository['saveSessionState']>[1], options: Parameters<SessionRepository['saveSessionState']>[2] = {}) {
    const batch = sessionStateBatchCommitSchema.parse(input);
    if (options.withOwnership) {
      const previous = await this.branchIndex(session.id).findStateBatch(session,batch.idempotencyKey);
      if (previous) return assertStateRetry(previous,batch);
    }
    const publish = () => this.enqueue(session.id,() => this.withSessionLock(session.id,async () => {
      const index = this.branchIndex(session.id);
      const state = await index.descriptor(session.header.binding);
      assertDescriptor(session,state);
      const previous = await index.findStateBatch(session,batch.idempotencyKey);
      if (previous) return assertStateRetry(previous,batch);
      await index.validateState(session,batch);
      if(options.materialPublication)await index.validateMaterialBoundaries(session,options.materialPublication.boundaries);
      const commit=async()=>{
      const entry = decodeSessionStateBatchEntry({...baseEntry(state.leafId),type:'session_state_batch',batch});
      await this.appendRecord(session.id,state,entry);
      return stateReceipt(entry);
      };
      return options.materialPublication?options.materialPublication.withAuthority(commit):commit();
    }));
    return options.withOwnership ? options.withOwnership(publish) : publish();
  }
  currentSessionStateItem(session: SessionDescriptor, itemId: string, leafId?: string | null) {
    return this.branchIndex(session.id).currentStateItem(session,itemId,leafId);
  }
  readSessionStateItem(session: SessionDescriptor, ref: Parameters<SessionRepository['readSessionStateItem']>[1], leafId?: string | null) {
    return this.branchIndex(session.id).readStateItem(session,ref,leafId);
  }
  listSessionState(session: SessionDescriptor, request?: Parameters<SessionRepository['listSessionState']>[1]) {
    return this.branchIndex(session.id).listState(session,request);
  }

  async open(sessionId: string, expectedBinding: SessionBindingInput): Promise<SessionDescriptor> {
    return this.enqueue(sessionId, () => this.branchIndex(sessionId).descriptor(expectedBinding));
  }

  async list(): Promise<readonly SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const id of await this.sessionIds())
      summaries.push(await this.enqueue(id, () => this.branchIndex(id).summary()));
    return Object.freeze(summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  /** Explicit application preflight: metadata-only when healthy, at most one recovery per ID. */
  async recoverHistoryIndexes(
    expectedBinding: SessionBindingInput,
    options: HistoryIndexRecoveryOptions = {}
  ): Promise<readonly SessionSummary[]> {
    const binding = createSessionBinding(expectedBinding);
    options.signal?.throwIfAborted();
    // Snapshot the directory once. Newly created sessions belong to the next preflight.
    const ids = options.sessionId === undefined ? await this.sessionIds() : [options.sessionId];
    const summaries: SessionSummary[] = [];
    for (const id of ids) {
      options.signal?.throwIfAborted();
      try {
        const progressState = {started: false};
        const summary = await this.enqueue(id, () => this.withSessionLock(id,
          () => this.branchIndex(id).summary(binding, options.signal, progress => {
            if (!progressState.started) {progressState.started = true; options.onProgress?.({phase: 'started', sessionId: id});}
            options.onProgress?.({phase: 'progress', sessionId: id, ...progress});
          }), options.signal === undefined ? {} : {signal: options.signal}
        ));
        summaries.push(summary);
        if (progressState.started) options.onProgress?.({phase: 'completed', sessionId: id});
      } catch (error) {
        // An unavailable original belongs to this one session. All-session views
        // keep independent sessions usable, while selecting this ID fails closed.
        if (options.sessionId !== undefined || !(error instanceof SessionHistorySourceError)) throw error;
        options.onProgress?.({ phase: 'failed', sessionId: id, message: error.message });
      }
    }
    return Object.freeze(summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  private async sessionIds(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.rootDir);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return [];
      throw error;
    }
    return names.sort().flatMap(name => /^session-(.+)\.jsonl$/u.exec(name)?.[1] ?? []);
  }

  async loadReplayState(
    session: SessionDescriptor,
    leafId?: string | null
  ): Promise<SessionReplayState> {
    const sessionId = session.id;
    const state = await this.enqueue(sessionId, () => this.withSessionLock(sessionId, async () => {
        // Source validity belongs to the projection owner, including deliberate full replay.
        await this.branchIndex(sessionId).checked(session);
        return readValidatedSessionBodies(this.filePath(sessionId), sessionId);
      }
    ));
    this.fullScans++;
    assertDescriptor(session, state);
    const current = sessionFromState(state);
    const branch = Object.freeze(
      activeBranch(state.branchEntries, leafId === undefined ? current.leafId : leafId)
    );
    return sessionReplayState(
      current,
      branch,
      state.finalizations,
      state.branchEntries.length + state.finalizations.length + state.submissionRecords.length + state.confirmations.length
    );
  }

  sourceSnapshot(session: SessionDescriptor, leafId?: string | null) {
    return this.enqueue(session.id, () => this.branchIndex(session.id).snapshot(session, leafId));
  }

  async readConversation(session: SessionDescriptor): Promise<readonly SessionConversationItem[]> {
    const replay = await this.loadReplayState(session);
    return Object.freeze(
      replay.branch.filter(
        (entry): entry is SessionConversationItem =>
          entry.type !== 'branch' &&
          entry.type !== 'model_settings' &&
          entry.type !== 'context_transition' &&
          entry.type !== 'session_state_batch' &&
          entry.type !== 'tool_catalog_selection'
      )
    );
  }

  readBranchPage(
    session: SessionDescriptor,
    request?: Parameters<SessionRepository['readBranchPage']>[1]
  ) {
    return this.enqueue(session.id, async () =>
      readBranchPage(await this.branchIndex(session.id).source(session), request)
    );
  }

  searchBranch(
    session: SessionDescriptor,
    request: Parameters<SessionRepository['searchBranch']>[1]
  ) {
    return this.enqueue(session.id, async () =>
      searchBranch(await this.branchIndex(session.id).source(session), request)
    );
  }

  readBranchEntry(
    session: SessionDescriptor,
    boundary: Parameters<SessionRepository['readBranchEntry']>[1],
    entryId: string
  ) {
    return this.enqueue(session.id, async () => {
      const source = await this.branchIndex(session.id).source(session);
      await assertBranchEntry(source, boundary, entryId);
      return source.read(entryId);
    });
  }

  /** Repair metadata without opening a session, selecting a provider, or trusting its index. */
  rebuildHistoryIndex(
    sessionId: string,
    expectedBinding: SessionBindingInput,
    options: HistoryIndexRebuildOptions = {}
  ): Promise<void> {
    return this.repairHistoryIndex(sessionId, createSessionBinding(expectedBinding), options);
  }

  private repairHistoryIndex(
    sessionId: string,
    binding: SessionBindingInput,
    options: HistoryIndexRebuildOptions
  ): Promise<void> {
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          options.signal?.throwIfAborted();
          await this.branchIndex(sessionId).rebuild(binding, options);
        },
        options.signal === undefined ? {} : { signal: options.signal }
      )
    );
  }

  historyReadMetrics(sessionId: string) {
    return this.branchIndex(sessionId).metrics();
  }

  private branchIndex(sessionId: string): JsonlBranchIndex {
    let index = this.branchIndexes.get(sessionId);
    if (index === undefined) {
      const filePath = this.filePath(sessionId);
      index = new JsonlBranchIndex(
        sessionId,
        filePath,
        (line) => {
          try {return parseSessionHeader(parseJson(line, filePath), sessionId);}
          catch (error) {throw corruption(filePath, line.line, line.byteOffset, errorMessage(error), 'invalid_header');}
        },
        (line) => {
          try {
          const value = parseJson(line, filePath);
          if (isJsonObject(value) && value.type === 'run_finalization_confirmed') return decodeSessionRunFinalizationConfirmation(value);
          if (isJsonObject(value) && value.type === 'run_finalization')
            return parseRunFinalization(value);
          if (
            isJsonObject(value) &&
            typeof value.type === 'string' &&
            value.type.startsWith('submission.')
          ) {
            return parseSubmissionRecord(value, sessionId);
          }
          return parseBranchEntry(value);
          } catch (error) {if (error instanceof PersistenceCorruptionError) throw error; throw corruption(filePath, line.line, line.byteOffset, errorMessage(error), 'invalid_record');}
        }
      );
      this.branchIndexes.set(sessionId, index);
    }
    return index;
  }

  listBranchPoints(session: SessionDescriptor): Promise<readonly SessionBranchPoint[]> {
    return this.enqueue(session.id, () => this.branchIndex(session.id).points(session));
  }

  appendInput(
    session: SessionDescriptor,
    input: Parameters<SessionRepository['appendInput']>[1]
  ): Promise<SessionInputEntry> {
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const candidate = await this.branchIndex(sessionId).find(session, `input:${input.runId}`);
          const existing = candidate?.type === 'input' ? candidate : undefined;
          if (existing) {
            if (!sameSessionInput(existing, input))
              throw new PersistenceConflictError(
                `Conflicting session input for run ${input.runId}.`
              );
            return existing;
          }
          const entry: SessionInputEntry = Object.freeze({
            ...baseEntry(state.leafId),
            type: 'input',
            runId: input.runId,
            task: input.task,
            ...(input.images === undefined ? {} : { images: parseSessionImages(input.images) }),
            ...materializedSessionInput(await this.branchIndex(sessionId).acceptedInput(session, input.runId), input),
            instructions: Object.freeze(
              (input.instructions ?? []).map((instruction) => Object.freeze({ ...instruction }))
            )
          });
          await this.appendRecord(sessionId, state, entry);
          return entry;
        }
      )
    );
  }

  appendSteering(
    session: SessionDescriptor,
    input: {
      runId: string;
      content: string;
      deliveryId?: string;
      relationship?: SessionInputRelationship;
      originalInput?: SessionSubmissionInput;
    }
  ): Promise<SessionSteeringEntry> {
    const owned = ownSessionSteeringInput(input);
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const candidate = owned.deliveryId === undefined ? undefined : await this.branchIndex(sessionId).find(session, `steering:${hashJson([owned.runId, owned.deliveryId])}`);
          const existing = candidate?.type === 'steering' ? candidate : undefined;
          if (existing) return sameSessionSteering(existing, owned);
          const entry: SessionSteeringEntry = Object.freeze({
            ...baseEntry(state.leafId),
            type: 'steering',
            ...owned
          });
          await this.appendRecord(sessionId, state, entry);
          return entry;
        }
      )
    );
  }

  async findPeerContribution(session: SessionDescriptor, deliveryId: string) {
    const entry = await this.branchIndex(session.id).find(session, `peer:${hashJson(deliveryId)}`);
    return entry?.type === 'peer_contribution' ? entry : undefined;
  }

  async appendPeerContribution(session: SessionDescriptor, input: Parameters<SessionRepository['appendPeerContribution']>[1], options: Parameters<SessionRepository['appendPeerContribution']>[2] = {}) {
    const owned = ownPeerContributionInput(input);
    if (owned.recipient.sessionId !== session.id) throw new Error('Peer contribution recipient session does not match.');
    if (options.withOwnership) {
      const existing = await this.findPeerContribution(session,owned.deliveryId);
      if (existing) return samePeerContribution(existing,owned);
    }
    const publish = () => this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
      const state = await this.branchIndex(session.id).descriptor(session.header.binding);
      assertDescriptor(session, state);
      const existing = await this.branchIndex(session.id).find(session, `peer:${hashJson(owned.deliveryId)}`);
      if (existing?.type === 'peer_contribution') return samePeerContribution(existing, owned);
      const entry = decodePeerContributionEntry({ ...baseEntry(state.leafId), type: 'peer_contribution', authorship: 'model', contribution: owned });
      await this.appendRecord(session.id, state, entry);
      return entry;
    }));
    return options.withOwnership ? options.withOwnership(publish) : publish();
  }

  appendAssistant(
    session: SessionDescriptor,
    input: {
      runId: string;
      identity: AgentTurnIdentity;
      content: string;
      reasoning?: string;
      reasoningSummary?: string;
      output?: readonly ModelOutputItem[];
      completeness?: SessionAssistantEntry['completeness'];
      contextRecovery?: true;
      inferenceInput?: ProtectedArtifactRef;
      source?: import('../history/contracts.js').HistoryEventSource;
    }
  ): Promise<SessionAssistantEntry> {
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const candidate = await this.branchIndex(sessionId).find(session, `assistant:${hashJson([input.runId, input.identity.turnId, input.identity.requestAttempt, input.source?.eventId ?? null])}`);
          const existing = candidate?.type === 'assistant' ? candidate : undefined;
          if (existing) {
            if (
              existing.turnIndex !== input.identity.turnIndex ||
              existing.content !== input.content ||
              existing.reasoning !== input.reasoning ||
              existing.reasoningSummary !== input.reasoningSummary ||
              hashJson(existing.output ?? null) !== hashJson(input.output ?? null) ||
              existing.completeness !== input.completeness ||
          existing.contextRecovery !== input.contextRecovery ||
              hashJson(existing.inferenceInput ?? null) !==
                hashJson(input.inferenceInput ?? null) ||
              hashJson(existing.source ?? null) !== hashJson(input.source ?? null)
            )
              throw new PersistenceConflictError(
                `Conflicting assistant finalization for ${input.runId}/${input.identity.turnId}/${String(input.identity.requestAttempt)}.`
              );
            return existing;
          }
          const entry: SessionAssistantEntry = Object.freeze({
            ...baseEntry(state.leafId),
            type: 'assistant',
            runId: input.runId,
            ...input.identity,
            content: input.content,
            ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
            ...(input.reasoningSummary === undefined
              ? {}
              : { reasoningSummary: input.reasoningSummary }),
            ...(input.source ? { source: historyEventSourceSchema.parse(input.source) } : {}),
            ...(input.output ? { output: ownSessionAssistantOutput(input.output) } : {}),
            ...(input.inferenceInput
              ? { inferenceInput: protectedInferenceInput(input.inferenceInput) }
              : {}),
            ...(input.completeness ? { completeness: input.completeness } : {}),
        ...(input.contextRecovery ? { contextRecovery: true as const } : {})
          });
          await this.appendRecord(sessionId, state, entry);
          return entry;
        }
      )
    );
  }

  appendToolCall(
    session: SessionDescriptor,
    input: { runId: string; identity: AgentToolCallIdentity; call: unknown }
  ): Promise<SessionToolCallEntry> {
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const call = parseJsonValue(input.call, {
            maxDepth: 32,
            maxCollectionEntries: 50_000,
            maxStringBytes: 4 * 1024 * 1024,
            maxTotalBytes: 8 * 1024 * 1024
          });
          const candidate = await this.branchIndex(sessionId).find(session, `tool_call:${hashJson([input.runId, input.identity.toolBatchId, input.identity.callIndex])}`);
          const existing = candidate?.type === 'tool_call' ? candidate : undefined;
          if (existing) {
            if (
              existing.turnId !== input.identity.turnId ||
              existing.requestAttempt !== input.identity.requestAttempt ||
              hashJson(existing.call) !== hashJson(call)
            ) {
              throw new PersistenceConflictError(
                `Conflicting tool call for ${input.runId}/${input.identity.toolBatchId}/${String(input.identity.callIndex)}.`
              );
            }
            return existing;
          }
          const entry: SessionToolCallEntry = Object.freeze({
            ...baseEntry(state.leafId),
            type: 'tool_call',
            runId: input.runId,
            ...input.identity,
            call
          });
          await this.appendRecord(sessionId, state, entry);
          return entry;
        }
      )
    );
  }

  appendObservation(
    session: SessionDescriptor,
    input: {
      runId: string;
      identity: AgentTurnIdentity &
        Partial<
          Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>
        >;
      toolName: string;
      observation: SessionObservationInput;
    }
  ): Promise<SessionObservationEntry> {
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const normalized = captureObservationInput(input);
          const key = sessionObservationKey(normalized);
          const candidate = key === undefined ? undefined : await this.branchIndex(sessionId).find(session, `observation:${hashJson([normalized.runId, normalized.turnId, normalized.requestAttempt, normalized.toolBatchId, normalized.callIndex, normalized.toolAttempt])}`);
          const existing = candidate?.type === 'observation' ? candidate : undefined;
          if (existing) {
            if (!sameObservation(existing, normalized))
              throw new PersistenceConflictError(
                `Conflicting session observation for ${String(key)}.`
              );
            return existing;
          }
          const entry: SessionObservationEntry = Object.freeze({
            ...baseEntry(state.leafId),
            type: 'observation',
            ...normalized
          });
          await this.appendRecord(sessionId, state, entry);
          return entry;
        }
      )
    );
  }

  appendModelSettings(session: SessionDescriptor, settings: ModelSelection): Promise<SessionModelSettingsEntry> {
    return this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
        const state = await this.branchIndex(session.id).descriptor(session.header.binding);
        assertDescriptor(session, state);
        await this.branchIndex(session.id).assertIdle(session);
        const entry: SessionModelSettingsEntry = Object.freeze({ ...baseEntry(state.leafId), type: 'model_settings', ...parseModelSelection(settings) });
        await this.appendRecord(session.id, state, entry);
        return entry;
      }
    ));
  }
  async commitContextTransition(
    session: SessionDescriptor,
    input: ContextTransitionCommit,
    options: Parameters<SessionRepository['commitContextTransition']>[2] = {}
  ): Promise<SessionContextTransitionEntry> {
    if (options.withOwnership) {
      const committed = await this.branchIndex(session.id).contextRetry(session,input);
      if (committed) return committed;
    }
    const publish = () => this.enqueue(session.id, () =>
      this.withSessionLock(session.id,
        async () => {
          const state = await this.branchIndex(session.id).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const existing = await this.branchIndex(session.id).contextRetry(session, input);
          if (existing) return existing;
          await this.branchIndex(session.id).validateContext(session, input);
          if (input.sessionState) await this.branchIndex(session.id).validateState(session,input.sessionState);
          if(options.materialPublication)await this.branchIndex(session.id).validateMaterialBoundaries(session,options.materialPublication.boundaries);
          const commit=async()=>{
          const entry = decodeContextTransitionEntry({
            ...baseEntry(state.leafId),
            type: 'context_transition',
            ...(input.sessionState ? {sessionState: input.sessionState} : {}),
            window: input.window,
            transition: input.transition
          });
          await this.appendRecord(session.id, state, entry);
          return entry;
          };
          return options.materialPublication?options.materialPublication.withAuthority(commit):commit();
        }
      )
    );
    return options.withOwnership ? options.withOwnership(publish) : publish();
  }
  branchFrom(
    session: SessionDescriptor,
    entryId: string,
    label?: string
  ): Promise<SessionBranchMarkerEntry> {
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          await this.branchIndex(session.id).assertIdle(session);
          const source = await this.branchIndex(sessionId).position(session, entryId);
          if (
            source.type !== 'context_transition' && source.type !== 'session_state_batch' &&
            !await this.branchIndex(sessionId).isFinalizedEntry(session, entryId)
          ) {
            throw new Error(
              `Session branches require a completed final, state batch, or context transition entry: ${entryId}`
            );
          }
          const entry: SessionBranchMarkerEntry = Object.freeze({
            ...baseEntry(entryId),
            type: 'branch',
            fromEntryId: entryId,
            ...(label ? { label } : {})
          });
          await this.appendRecord(sessionId, state, entry);
          return entry;
        }
      )
    );
  }

  recordRunFinalization(
    session: SessionDescriptor,
    terminalInput: AgentTerminalSnapshot
  ): Promise<SessionRunFinalization> {
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const terminal = createAgentTerminalSnapshot(terminalInput);
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const candidate = await this.branchIndex(sessionId).find(session, `finalization:${terminal.finalizationId}`);
          const existing = candidate?.type === 'run_finalization' ? candidate : undefined;
          if (existing) {
            if (
              terminalSnapshotFingerprint(existing.terminal) !==
              terminalSnapshotFingerprint(terminal)
            )
              throw new PersistenceConflictError(
                `Conflicting session finalization for finalization ${terminal.finalizationId}.`
              );
            return existing;
          }
          const throughEntryId = state.leafId;
          if (
            !throughEntryId ||
            !await this.branchIndex(sessionId).branchContainsInput(session, terminal.runId)
          ) {
            throw new Error(
              `Cannot record finalization ${terminal.finalizationId}: run ${terminal.runId} is not on the active session branch.`
            );
          }
          const finalization: SessionRunFinalization = Object.freeze({
            type: 'run_finalization',
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            throughEntryId,
            runId: terminal.runId,
            finalizationId: terminal.finalizationId,
            terminal
          });
          await this.appendRecord(sessionId, state, finalization);
          return finalization;
        }
      )
    );
  }

  confirmRunFinalization(session: SessionDescriptor, input: SessionRunFinalizationConfirmationInput): Promise<SessionRunFinalizationConfirmation> {
    return this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
      const state = await this.branchIndex(session.id).descriptor(session.header.binding);
      const final = await this.branchIndex(session.id).find(session, `finalization:${input.finalizationId}`);
      const previous = await this.branchIndex(session.id).find(session, `confirmation-run:${input.runId}`) ??
        await this.branchIndex(session.id).find(session, `confirmation:${input.finalizationId}`);
      const existing = previous?.type === 'run_finalization_confirmed' ? previous : undefined;
      const record = createSessionRunFinalizationConfirmation(final?.type === 'run_finalization' ? final : undefined, existing, input);
      if (existing) return existing;
      await this.appendRecord(session.id, state, record);
      return record;
    }));
  }

  admitSubmission(
    session: SessionDescriptor,
    input: Parameters<SessionRepository['admitSubmission']>[1]
  ): Promise<SessionPendingSubmission> {
    if (input.input.origin?.kind === 'host_wake') return Promise.reject(new Error('Host wakes require idempotent triggered admission.'));
    return this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
        const state = await this.branchIndex(session.id).descriptor(session.header.binding);
        assertDescriptor(session, state);
        const selection = await this.currentModelSettings(session);
      assertSessionAdmissionConfiguration(input.configuration, selection);
      const record = await this.branchIndex(session.id).admission(session, input);
        await this.appendRecord(session.id, state, record);
        const admitted = pendingSessionSubmissions([record])[0];
        if (!admitted) throw new Error('Committed admission is absent from the session projection.');
        return admitted;
      }
    ));
  }

  async admitTriggeredSubmission(session: SessionDescriptor, input: Parameters<SessionRepository['admitTriggeredSubmission']>[1]) {
    const captured = captureTriggeredSubmission(input);
    return this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
      const state = await this.branchIndex(session.id).descriptor(session.header.binding);
      assertDescriptor(session, state);
      const records = await this.branchIndex(session.id).submissionRecords(session, captured.submissionId);
      const existing = findTriggeredSubmissionReceipt(session, records, captured.trigger.key);
      if (existing) { assertTriggeredSubmissionRetry(existing, { key: captured.trigger.key, input: captured.input, configuration: captured.configuration }); return existing; }
      if ((await this.branchIndex(session.id).pending(session)).some(entry => entry.state === 'suspended'))
        throw new Error('Host wake cannot admit work while the session is suspended.');
      assertSessionAdmissionConfiguration(captured.configuration, await this.currentModelSettings(session));
      const record = Object.freeze({ ...await this.branchIndex(session.id).admission(session, {
        ...captured, runId: triggeredRunId(session.id, captured.trigger.key), configuration: captured.configuration,
        ...(captured.maximumQueuedInputs === undefined ? {} : { maximumQueuedInputs: captured.maximumQueuedInputs })
      }), trigger: captured.trigger });
      await this.appendRecord(session.id, state, record);
      return triggeredSubmissionReceipt(session, record);
    }));
  }
  readTriggeredSubmissionReceipt(session: SessionDescriptor, key: string) {
    return this.enqueue(session.id, async () => findTriggeredSubmissionReceipt(session,
      await this.branchIndex(session.id).submissionRecords(session, triggeredSubmissionId(key)), key));
  }

  claimNextSubmission(session: SessionDescriptor, claimId: string): Promise<SessionPendingSubmission | undefined> {
    return this.enqueue(session.id, () => this.withSessionLock(session.id, async () => {
        const state = await this.branchIndex(session.id).descriptor(session.header.binding);
        assertDescriptor(session, state);
        const nextId = await this.branchIndex(session.id).nextQueuedSubmission(session);
        if (nextId === undefined) return undefined;
        const records = await this.branchIndex(session.id).submissionRecords(session, nextId);
        const next = pendingSessionSubmissions(records)[0];
        if (!next) throw new Error('Queued submission is absent from the session projection.');
        await this.branchIndex(session.id).assertClaim(session, nextId);
        const record = createSessionSubmissionTransition(records, nextId, {state: 'claimed', claimId});
        if (record) {
          await this.appendRecord(session.id, state, record);
          }
        return Object.freeze({ ...next, state: 'claimed', claimId });
      }
    ));
  }

  transitionSubmission(
    session: SessionDescriptor,
    submissionId: string,
    outcome: import('./contracts.js').SessionSubmissionOutcome
  ): Promise<void> {
    const sessionId = session.id;
    return this.enqueue(sessionId, () =>
      this.withSessionLock(sessionId,
        async () => {
          const state = await this.branchIndex(sessionId).descriptor(session.header.binding);
          assertDescriptor(session, state);
          if (outcome.state === 'claimed') await this.branchIndex(session.id).assertClaim(session, submissionId);
          const record = createSessionSubmissionTransition(
            await this.branchIndex(session.id).submissionRecords(session, submissionId),
            submissionId,
            outcome
          );
          if (!record) return;
          await this.appendRecord(sessionId, state, record);
          }
      )
    );
  }

  pendingSubmissionSummaries(session: SessionDescriptor) {
    return this.enqueue(session.id, () => this.branchIndex(session.id).pending(session));
  }

  readSubmission(session: SessionDescriptor, submissionId: string) {
    return this.enqueue(session.id, async () => {
      return sessionSubmission(await this.branchIndex(session.id).submissionRecords(session, submissionId), submissionId);
    });
  }

  async loadPendingSubmissions(
    session: SessionDescriptor
  ): Promise<readonly SessionPendingSubmission[]> {
    const sessionId = session.id;
    return this.enqueue(sessionId, async () => pendingSessionSubmissions(await this.branchIndex(sessionId).submissionRecords(session)));
  }

  updateQueuedSubmission(
    session: SessionDescriptor,
    submissionId: string,
    change: Parameters<SessionRepository['updateQueuedSubmission']>[2]
  ): Promise<void> {
    return this.enqueue(session.id, () =>
      this.withSessionLock(session.id,
        async () => {
          const state = await this.branchIndex(session.id).descriptor(session.header.binding);
          assertDescriptor(session, state);
          const record = createQueuedSubmissionUpdate(
            await this.branchIndex(session.id).submissionRecords(session, submissionId),
            submissionId,
            change
          );
          await this.appendRecord(session.id, state, record);
          }
      )
    );
  }

  private withSessionLock<T>(sessionId: string, operation: () => Promise<T>, options: {readonly signal?: AbortSignal} = {}): Promise<T> {
    return withPersistenceFileLock(this.filePath(sessionId), this.lockTimeoutMs,
      () => this.branchIndex(sessionId).scope(operation, options.signal), options);
  }

  private async appendRecord(sessionId: string, state: SessionDescriptor, record: SessionBranchEntry | SessionSubmissionRecord | SessionRunFinalization | SessionRunFinalizationConfirmation): Promise<void> {
    await this.branchIndex(sessionId).append(state, 'submissionId' in record ? encodeSubmissionRecord(record) : parseJsonValue(record));
    this.incrementalRefreshes++;
  }

  private filePath(sessionId: string): string {
    assertIdentifier(sessionId);
    return path.join(this.rootDir, `session-${sessionId}.jsonl`);
  }
  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
    return result;
  }
}

interface SessionFileState {
  readonly header: SessionHeader;
  readonly branchEntries: SessionBranchEntry[];
  readonly finalizations: SessionRunFinalization[];
  readonly confirmations: SessionRunFinalizationConfirmation[];
  readonly submissionRecords: SessionSubmissionRecord[];
}
async function readValidatedSessionBodies(
  filePath: string,
  sessionId: string
): Promise<SessionFileState> {
  const committed = await readJsonlCommittedFile(filePath);
  const lines = committed.lines;
  if (lines.length === 0) throw corruption(filePath, 1, 0, 'Session is empty.', 'invalid_header');
  const headerLine = lines[0];
  if (headerLine === undefined)
    throw corruption(filePath, 1, 0, 'Session is empty.', 'invalid_header');
  let header: SessionHeader;
  try {
    header = parseSessionHeader(parseJson(headerLine, filePath), sessionId);
  } catch (error) {
    throw corruption(filePath, 1, 0, errorMessage(error), 'invalid_header');
  }
  const branchEntries: SessionBranchEntry[] = [];
  const finalizations: SessionRunFinalization[] = [];
  const confirmations: SessionRunFinalizationConfirmation[] = [];
  const submissionRecords: SessionSubmissionRecord[] = [];
  for (const line of lines.slice(1)) {
    if (line.text.trim().length === 0) continue;
    const value = parseJson(line, filePath);
    try {
      if (isJsonObject(value) && value.type === 'run_finalization_confirmed') {
        const confirmation = decodeSessionRunFinalizationConfirmation(value);
        confirmations.push(confirmation);
      } else if (isJsonObject(value) && value.type === 'run_finalization')
        finalizations.push(parseRunFinalization(value));
      else if (
        isJsonObject(value) &&
        typeof value.type === 'string' &&
        value.type.startsWith('submission.')
      )
        submissionRecords.push(parseSubmissionRecord(value, sessionId));
      else branchEntries.push(parseBranchEntry(value));
    } catch (error) {
      throw corruption(filePath, line.line, line.byteOffset, errorMessage(error), 'invalid_record');
    }
  }
  return { header, branchEntries, finalizations, confirmations, submissionRecords };
}

function parseBranchEntry(value: JsonValue): SessionBranchEntry {
  if (!isRecord(value) || !validBaseEntry(value)) throw new Error('Session entry base is invalid.');
  if (isSessionInputEntry(value)) {
    return Object.freeze({
      ...value,
      ...(value.images === undefined ? {} : { images: parseSessionImages(value.images) }),
      ...(value.originalInput === undefined
        ? {}
        : { originalInput: ownSessionSubmissionInput(value.originalInput) })
    });
  }
  if (isSessionSteeringEntry(value))
    return Object.freeze({
      ...value,
      ...ownSessionSteeringInput(value),
      ...(value.source ? { source: historyEventSourceSchema.parse(value.source) } : {})
    });
  if (isSessionAssistantEntry(value))
    return Object.freeze({
      ...value,
      ...(value.source ? { source: historyEventSourceSchema.parse(value.source) } : {}),
      ...(value.output === undefined
        ? {}
        : { output: ownSessionAssistantOutput(value.output) }),
      ...(value.inferenceInput === undefined
        ? {}
        : { inferenceInput: protectedInferenceInput(value.inferenceInput) })
    });
  if (isSessionToolCallEntry(value)) return value;
  if (isSessionObservationEntry(value)) {
    const { modelContent, ...entry } = value;
    return Object.freeze({
      ...entry,
      ...(modelContent === undefined ? {} : { modelContent: decodeToolContent(modelContent) })
    });
  }
  if (isSessionBranchMarkerEntry(value)) {
    return Object.freeze(value);
  }
  if (value.type === 'model_settings') {
    const { type, id, parentId, timestamp, source, ...settings } = value;
    return Object.freeze({
      type,
      id,
      parentId,
      timestamp,
      ...parseModelSelection(settings),
      ...(source === undefined ? {} : { source: historyEventSourceSchema.parse(source) })
    });
  }
  if (value.type === 'peer_contribution') return decodePeerContributionEntry(value);
  if (value.type === 'context_transition') return decodeContextTransitionEntry(value);
  if (value.type === 'session_state_batch') return decodeSessionStateBatchEntry(value);
  if (value.type === 'session_material_revocation') return decodeSessionMaterialRevocation(value);
  if (value.type === 'tool_catalog_selection') return decodeSessionToolCatalogSelection(value);
  throw new Error(
    `Unsupported or malformed session entry: ${typeof value.type === 'string' ? value.type : 'unknown'}`
  );
}
function parseRunFinalization(value: JsonObject): SessionRunFinalization {
  if (
    typeof value.id !== 'string' ||
    typeof value.timestamp !== 'string' ||
    typeof value.throughEntryId !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.finalizationId !== 'string'
  )
    throw new Error('Final finalization identity is invalid.');
  if (!isJsonObject(value.terminal)) throw new Error('Final finalization terminal is invalid.');
  const terminal = decodeOwnedAgentTerminalSnapshot(value.terminal);
  if (terminal.runId !== value.runId || terminal.finalizationId !== value.finalizationId)
    throw new Error('Final finalization identity conflicts with terminal snapshot.');
  return Object.freeze({
    type: 'run_finalization',
    id: value.id,
    timestamp: value.timestamp,
    throughEntryId: value.throughEntryId,
    runId: value.runId,
    finalizationId: value.finalizationId,
    terminal
  });
}
function activeBranch(
  entries: readonly SessionBranchEntry[],
  leafId: string | null
): SessionBranchEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const output: SessionBranchEntry[] = [];
  let cursor = leafId;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry) throw new Error(`Session branch points to missing entry: ${cursor}`);
    output.push(entry);
    cursor = entry.parentId;
  }
  return output.reverse();
}
function branchLeaf(entries: readonly SessionBranchEntry[]): string | null {
  return entries.at(-1)?.id ?? null;
}
function sessionFromState(state: SessionFileState): SessionDescriptor {
  return Object.freeze({
    id: state.header.id,
    header: state.header,
    leafId: branchLeaf(state.branchEntries)
  });
}
function baseEntry(parentId: string | null): BaseSessionEntry {
  return { id: randomUUID(), parentId, timestamp: new Date().toISOString() };
}
const SESSION_HEADER_FIELDS = new Set([
  'type',
  'version',
  'format',
  'sessionStateStorage',
  'id',
  'timestamp',
  'binding',
  'parentSessionId',
  'provider',
  'model'
]);

function parseSessionHeader(value: JsonValue, sessionId: string): SessionHeader {
  if (
    !isJsonObject(value) ||
    value.format !== 'agent-core.session/8' ||
    value.sessionStateStorage !== 'session'
  )
    throw new Error(
      'Incompatible session format. Start a new session; existing data has not been changed.'
    );
  if (
    !isJsonObject(value) ||
    value.type !== 'session' ||
    value.version !== 1 ||
    value.id !== sessionId ||
    Object.keys(value).some((key) => !SESSION_HEADER_FIELDS.has(key)) ||
    typeof value.timestamp !== 'string' ||
    (value.parentSessionId !== undefined && typeof value.parentSessionId !== 'string') ||
    (value.provider !== undefined && typeof value.provider !== 'string') ||
    (value.model !== undefined && typeof value.model !== 'string')
  )
    throw new Error('Session header is invalid.');
  const binding = decodeSessionBinding(value.binding);
  return Object.freeze({
    type: 'session',
    version: 1,
    format: 'agent-core.session/8',
    sessionStateStorage: 'session',
    id: value.id,
    timestamp: value.timestamp,
    binding,
    ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.model === undefined ? {} : { model: value.model })
  });
}
function assertDescriptor(session: SessionDescriptor, state: {readonly header: SessionHeader}): void {
  if (session.id !== state.header.id)
    throw new Error(`Session descriptor identity mismatch for ${session.id}.`);
  assertSessionBinding(decodeSessionBinding(session.header.binding), state.header.binding);
}
function validArtifactRefs(value: unknown): value is readonly ArtifactRef[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  try {
    for (const artifact of value) validateArtifactRef(artifact);
    return true;
  } catch {
    return false;
  }
}
function sessionObservationKey(
  value: Pick<SessionObservationEntry, 'runId' | 'turnId'> &
    Partial<
      Pick<SessionObservationEntry, 'requestAttempt' | 'toolBatchId' | 'callIndex' | 'toolAttempt'>
    >
): string | undefined {
  return value.toolBatchId !== undefined &&
    value.callIndex !== undefined &&
    value.toolAttempt !== undefined
    ? `${value.runId}:${value.turnId}:${String(value.requestAttempt)}:${value.toolBatchId}:${String(value.callIndex)}:${String(value.toolAttempt)}`
    : undefined;
}
function sameObservation(
  existing: SessionObservationEntry,
  input: Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'>
): boolean {
  const persisted = observationPayload(existing);
  return JSON.stringify(persisted) === JSON.stringify(input);
}

function sameSessionInput(
  existing: SessionInputEntry,
  input: Parameters<SessionRepository['appendInput']>[1]
): boolean {
  return (
    existing.task === input.task &&
    hashJson(existing.originalInput?.origin ?? null) === hashJson(input.origin ?? null) &&
    JSON.stringify(existing.images ?? []) === JSON.stringify(input.images ?? []) &&
    JSON.stringify(existing.instructions) === JSON.stringify(input.instructions ?? [])
  );
}
function observationPayload(
  value: SessionObservationEntry
): Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'> {
  return {
    runId: value.runId,
    turnIndex: value.turnIndex,
    turnId: value.turnId,
    requestAttempt: value.requestAttempt,
    ...(value.toolBatchId === undefined ? {} : { toolBatchId: value.toolBatchId }),
    ...(value.callIndex === undefined ? {} : { callIndex: value.callIndex }),
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.toolAttempt === undefined ? {} : { toolAttempt: value.toolAttempt }),
    toolName: value.toolName,
    kind: value.kind,
    ...(value.originalUnavailable ? { originalUnavailable: value.originalUnavailable } : {}),
    ...(value.modelContentRef === undefined ? {} : { modelContentRef: value.modelContentRef }),
    ...(value.originalArtifact === undefined ? {} : { originalArtifact: value.originalArtifact }),
    ...(value.modelContent === undefined ? {} : { modelContent: value.modelContent }),
    summary: value.summary,
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.artifacts === undefined ? {} : { artifacts: value.artifacts }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata })
  };
}
function parseJson(line: JsonlLine, storage: string): JsonValue {
  try {
    return parseJsonValue(JSON.parse(line.text), {
      maxDepth: 32,
      maxCollectionEntries: 50_000,
      maxStringBytes: 4 * 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024
    });
  } catch (error) {
    throw corruption(storage, line.line, line.byteOffset, errorMessage(error), 'invalid_json');
  }
}
function corruption(
  storage: string,
  line: number,
  byteOffset: number,
  message: string,
  code: PersistenceCorruptionError['code']
): PersistenceCorruptionError {
  return new PersistenceCorruptionError({ code, storage, line, byteOffset, message });
}
function assertIdentifier(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) throw new Error('Invalid session id.');
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive.`);
  return value;
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function positiveOptionalAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function validTurnIdentity(
  value: Record<string, unknown>
): value is Record<string, unknown> & AgentTurnIdentity {
  return (
    typeof value.turnId === 'string' &&
    value.turnId.length > 0 &&
    typeof value.turnIndex === 'number' &&
    Number.isInteger(value.turnIndex) &&
    value.turnIndex > 0 &&
    typeof value.requestAttempt === 'number' &&
    Number.isInteger(value.requestAttempt) &&
    value.requestAttempt > 0
  );
}
function validBaseEntry(
  value: Record<string, unknown>
): value is Record<string, unknown> & BaseSessionEntry {
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (typeof value.parentId === 'string' || value.parentId === null) &&
    typeof value.timestamp === 'string' &&
    value.timestamp.length > 0
  );
}
function isEffectiveInstruction(value: unknown): value is AgentEffectiveInstruction {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.content === 'string' &&
    (value.provenance === 'application' ||
      value.provenance === 'run' ||
      value.provenance === 'steering') &&
    (value.role === undefined || typeof value.role === 'string') &&
    (value.sourceUri === undefined || typeof value.sourceUri === 'string') &&
    (value.priority === undefined ||
      (typeof value.priority === 'number' && Number.isFinite(value.priority)))
  );
}
function isSessionInputEntry(
  value: Record<string, unknown> & BaseSessionEntry
): value is Record<string, unknown> & SessionInputEntry {
  return (
    value.type === 'input' &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.task === 'string' &&
    Array.isArray(value.instructions) &&
    value.instructions.every(isEffectiveInstruction)
  );
}
function isSessionSteeringEntry(
  value: Record<string, unknown> & BaseSessionEntry
): value is Record<string, unknown> & SessionSteeringEntry {
  return (
    value.type === 'steering' &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.content === 'string' &&
    value.content.length > 0 &&
    (value.deliveryId === undefined ||
      (typeof value.deliveryId === 'string' && value.deliveryId.length > 0))
  );
}
function isSessionAssistantEntry(
  value: Record<string, unknown> & BaseSessionEntry
): value is Record<string, unknown> & SessionAssistantEntry {
  return (
    value.type === 'assistant' &&
    validTurnIdentity(value) &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.content === 'string' &&
    (value.contextRecovery === undefined || value.contextRecovery === true) &&
    (value.reasoning === undefined || typeof value.reasoning === 'string') &&
    (value.reasoningSummary === undefined || typeof value.reasoningSummary === 'string') &&
    (value.completeness === undefined ||
      value.completeness === 'complete' ||
      value.completeness === 'partial' ||
      value.completeness === 'indeterminate' ||
      value.completeness === 'absent')
  );
}
function isSessionToolCallEntry(
  value: Record<string, unknown> & BaseSessionEntry
): value is Record<string, unknown> & SessionToolCallEntry {
  return (
    value.type === 'tool_call' &&
    validTurnIdentity(value) &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.toolBatchId === 'string' &&
    value.toolBatchId.length > 0 &&
    nonnegativeInteger(value.callIndex) &&
    (value.callId === undefined || typeof value.callId === 'string') &&
    value.call !== undefined
  );
}
function isSessionObservationEntry(
  value: Record<string, unknown> & BaseSessionEntry
): value is Record<string, unknown> & Omit<SessionObservationEntry, 'modelContent'> {
  return (
    value.type === 'observation' &&
    validTurnIdentity(value) &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.toolName === 'string' &&
    value.toolName.length > 0 &&
    (value.originalArtifact === undefined || validArtifactRefs([value.originalArtifact])) &&
    (value.originalUnavailable === undefined ||
      (value.originalArtifact === undefined &&
        value.output === undefined &&
        isRecord(value.originalUnavailable) &&
        Object.keys(value.originalUnavailable).every((key) =>
          ['message', 'bytes', 'digest'].includes(key)
        ) &&
        typeof value.originalUnavailable.message === 'string' &&
        nonnegativeInteger(value.originalUnavailable.bytes) &&
        typeof value.originalUnavailable.digest === 'string' &&
        /^[a-f0-9]{64}$/u.test(value.originalUnavailable.digest))) &&
    (value.modelContentRef === undefined ||
      (value.modelContent === undefined && validArtifactRefs([value.modelContentRef]))) &&
    !('ok' in value) &&
    (value.kind === 'result' || value.kind === 'failure') &&
    typeof value.summary === 'string' &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    validArtifactRefs(value.artifacts) &&
    (value.callId === undefined || typeof value.callId === 'string') &&
    (value.toolBatchId === undefined
      ? value.callIndex === undefined &&
        value.callId === undefined &&
        value.toolAttempt === undefined
      : typeof value.toolBatchId === 'string' &&
        value.toolBatchId.length > 0 &&
        nonnegativeInteger(value.callIndex) &&
        positiveOptionalAttempt(value.toolAttempt))
  );
}
function isSessionBranchMarkerEntry(
  value: Record<string, unknown> & BaseSessionEntry
): value is Record<string, unknown> & SessionBranchMarkerEntry {
  return (
    value.type === 'branch' &&
    typeof value.fromEntryId === 'string' &&
    value.fromEntryId.length > 0 &&
    (value.label === undefined || typeof value.label === 'string')
  );
}
function parseSubmissionRecord(value: JsonObject, sessionId: string): SessionSubmissionRecord {
  if (
    typeof value.submissionId !== 'string' ||
    value.submissionId.length === 0 ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    typeof value.timestamp !== 'string'
  ) {
    throw new Error('Session submission identity is invalid.');
  }
  if (value.type === 'submission.admitted') {
    if (!isJsonObject(value.input) || !isJsonObject(value.configuration) ||
        typeof value.maximumQueuedInputs !== 'number' || !Number.isSafeInteger(value.maximumQueuedInputs) || value.maximumQueuedInputs < 0 ||
        (value.claimId !== undefined && (typeof value.claimId !== 'string' || value.claimId.length === 0)))
      throw new Error('Admitted session submission is invalid.');
    if (value.trigger !== undefined) {
      const trigger = ownSubmissionTrigger(value.trigger);
      const captured = ownSessionSubmissionInput(value.input);
      if (captured.origin?.kind !== 'host_wake' || trigger.payloadDigest !== hashJson(captured) || value.submissionId !== triggeredSubmissionId(trigger.key) || value.runId !== triggeredRunId(sessionId, trigger.key))
        throw new Error('Host-trigger admission identity or payload digest is invalid.');
    } else if (ownSessionSubmissionInput(value.input).origin?.kind === 'host_wake') throw new Error('Host wake has no durable trigger identity.');
    return Object.freeze({
      type: 'submission.admitted',
      ...(value.trigger === undefined ? {} : { trigger: ownSubmissionTrigger(value.trigger) }),
      maximumQueuedInputs: value.maximumQueuedInputs,
      ...(value.claimId === undefined ? {} : { claimId: value.claimId }),
      submissionId: value.submissionId,
      runId: value.runId,
      timestamp: value.timestamp,
      input: ownSessionSubmissionInput(value.input),
      configuration: parseSubmissionConfiguration(value.configuration)
    });
  }
  if (
    value.type !== 'submission.claimed' &&
    value.type !== 'submission.revised' &&
    value.type !== 'submission.cancelled' &&
    value.type !== 'submission.suspended' &&
    value.type !== 'submission.completed' &&
    value.type !== 'submission.failed'
  )
    throw new Error('Session submission state is invalid.');
  const base = { submissionId: value.submissionId, runId: value.runId, timestamp: value.timestamp };
  if (value.type === 'submission.revised') {
    if (!isJsonObject(value.input)) throw new Error('Revised session input is invalid.');
    if (ownSessionSubmissionInput(value.input).origin?.kind === 'host_wake') throw new Error('Queued replacement cannot forge a host wake.');
    return Object.freeze({
      ...base,
      type: value.type,
      input: ownSessionSubmissionInput(value.input)
    });
  }
  if (value.type === 'submission.cancelled') return Object.freeze({ ...base, type: value.type });
  if (typeof value.claimId !== 'string' || value.claimId.length === 0)
    throw new Error('Session submission claim identity is invalid.');
  const owned = { ...base, claimId: value.claimId };
  if (value.type === 'submission.claimed') {
    if (value.previousClaimId !== undefined &&
        (typeof value.previousClaimId !== 'string' || value.previousClaimId.length === 0))
      throw new Error('Session submission previous claim identity is invalid.');
    return Object.freeze({ ...owned, type: value.type,
      ...(value.previousClaimId === undefined ? {} : { previousClaimId: value.previousClaimId }) });
  }
  if (value.previousClaimId !== undefined)
    throw new Error('Only a submission claim may replace previous ownership.');
  if (value.type === 'submission.suspended')
    return Object.freeze({
      ...owned,
      type: value.type,
      suspension: parseSuspension(value.suspension, value.submissionId, value.runId)
    });
  if (value.type === 'submission.failed') {
    if (typeof value.errorMessage !== 'string' || value.errorMessage.length === 0)
      throw new Error('Session submission error is invalid.');
    return Object.freeze({ ...owned, type: value.type, errorMessage: value.errorMessage });
  }
  if (value.errorMessage !== undefined || value.suspension !== undefined)
    throw new Error('Session submission transition has unsupported state data.');
  return Object.freeze({ ...owned, type: value.type });
}

function parseSuspension(
  value: JsonValue | undefined,
  submissionId: string,
  runId: string
): import('./contracts.js').SessionSuspensionDescriptor {
  const suspension = ownSessionSuspensionDescriptor(value);
  if (suspension.submissionId !== submissionId || suspension.runId !== runId)
    throw new Error('Session suspension identity does not match its submission.');
  return suspension;
}

function parseSubmissionConfiguration(value: JsonObject): SessionSubmissionConfiguration {
  if (
    typeof value.provider !== 'string' ||
    value.provider.length === 0 ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    (value.endpoint !== undefined && (typeof value.endpoint !== 'string' || !value.endpoint.trim())) ||
    (value.temperature !== undefined &&
      (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)))
  )
    throw new Error('Session submission configuration is invalid.');
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    ...(value.endpoint === undefined ? {} : { endpoint: value.endpoint }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.reasoning === undefined
      ? {}
      : { reasoning: parseSubmissionReasoning(value.reasoning) }),
    ...(value.responseFormat === undefined
      ? {}
      : { responseFormat: parseSubmissionResponseFormat(value.responseFormat) })
  });
}

function parseSubmissionReasoning(
  value: JsonValue
): NonNullable<SessionSubmissionConfiguration['reasoning']> {
  if (!isJsonObject(value)) throw new Error('Session submission reasoning is invalid.');
  if (value.strategy === 'disabled') return Object.freeze({ strategy: 'disabled' });
  const summary = value.summary;
  if (
    summary !== undefined &&
    summary !== 'auto' &&
    summary !== 'concise' &&
    summary !== 'detailed'
  )
    throw new Error('Session submission reasoning summary is invalid.');
  if (value.strategy === 'enabled')
    return Object.freeze({ strategy: 'enabled', ...(summary === undefined ? {} : { summary }) });
  if (value.strategy === 'effort') {
    if (
      value.effort !== 'minimal' &&
      value.effort !== 'low' &&
      value.effort !== 'medium' &&
      value.effort !== 'high' &&
      value.effort !== 'xhigh' &&
      value.effort !== 'max'
    )
      throw new Error('Session submission reasoning effort is invalid.');
    if (value.mode !== undefined && value.mode !== 'standard' && value.mode !== 'pro')
      throw new Error('Session submission reasoning mode is invalid.');
    return Object.freeze({
      strategy: 'effort',
      effort: value.effort,
      ...(value.mode === undefined ? {} : { mode: value.mode }),
      ...(summary === undefined ? {} : { summary })
    });
  }
  if (
    value.strategy === 'budget' &&
    typeof value.maxTokens === 'number' &&
    Number.isSafeInteger(value.maxTokens) &&
    value.maxTokens > 0
  ) {
    return Object.freeze({
      strategy: 'budget',
      maxTokens: value.maxTokens,
      ...(summary === undefined ? {} : { summary })
    });
  }
  throw new Error('Session submission reasoning strategy is invalid.');
}

function parseSubmissionResponseFormat(
  value: JsonValue
): NonNullable<SessionSubmissionConfiguration['responseFormat']> {
  if (value === 'text' || value === 'json') return value;
  if (!isJsonObject(value) || value.type !== 'json_schema' || !isJsonObject(value.schema))
    throw new Error('Session submission response format is invalid.');
  return Object.freeze({ type: 'json_schema', schema: value.schema });
}

function encodeSubmissionRecord(record: SessionSubmissionRecord): JsonObject {
  if (record.type === 'submission.revised')
    return Object.freeze({ ...record, input: encodeSubmissionInput(record.input) });
  if (record.type === 'submission.admitted')
    return Object.freeze({
      type: record.type,
      maximumQueuedInputs: record.maximumQueuedInputs,
      ...(record.trigger === undefined ? {} : { trigger: { key: record.trigger.key, payloadDigest: record.trigger.payloadDigest } }),
      ...(record.claimId === undefined ? {} : { claimId: record.claimId }),
      submissionId: record.submissionId,
      runId: record.runId,
      timestamp: record.timestamp,
      input: encodeSubmissionInput(record.input),
      configuration: encodeSubmissionConfiguration(record.configuration)
    });
  if (record.type === 'submission.suspended')
    return Object.freeze({
      type: record.type,
      submissionId: record.submissionId,
      runId: record.runId,
      timestamp: record.timestamp,
      claimId: record.claimId,
      suspension: encodeSuspension(record.suspension)
    });
  return Object.freeze({
    type: record.type,
    submissionId: record.submissionId,
    runId: record.runId,
    timestamp: record.timestamp,
    ...(record.type === 'submission.cancelled' ? {} : { claimId: record.claimId }),
    ...(record.type === 'submission.claimed' && record.previousClaimId !== undefined
      ? { previousClaimId: record.previousClaimId } : {}),
    ...(record.type === 'submission.failed' ? { errorMessage: record.errorMessage } : {})
  });
}

function encodeSuspension(
  suspension: import('./contracts.js').SessionSuspensionDescriptor
): JsonObject {
  return Object.freeze({
    runId: suspension.runId,
    submissionId: suspension.submissionId,
    category: suspension.category,
    reason: suspension.reason,
    ...(suspension.reason === 'runtime_failed' ? { diagnostic: suspension.diagnostic } : {}),
    ...(suspension.effectId === undefined ? {} : { effectId: suspension.effectId }),
    ...(suspension.contextAdmission === undefined
      ? {}
      : { contextAdmission: parseJsonValue(suspension.contextAdmission) }),
    actions: Object.freeze([...suspension.actions])
  });
}

function encodeSubmissionConfiguration(configuration: SessionSubmissionConfiguration): JsonObject {
  return Object.freeze({
    provider: configuration.provider,
    model: configuration.model,
    ...(configuration.endpoint === undefined ? {} : { endpoint: configuration.endpoint }),
    ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
    ...(configuration.reasoning === undefined
      ? {}
      : { reasoning: encodeSubmissionReasoning(configuration.reasoning) }),
    ...(configuration.responseFormat === undefined
      ? {}
      : {
          responseFormat:
            typeof configuration.responseFormat === 'string'
              ? configuration.responseFormat
              : Object.freeze({ type: 'json_schema', schema: configuration.responseFormat.schema })
        })
  });
}

function encodeSubmissionReasoning(
  reasoning: NonNullable<SessionSubmissionConfiguration['reasoning']>
): JsonObject {
  switch (reasoning.strategy) {
    case 'disabled':
      return Object.freeze({ strategy: 'disabled' });
    case 'enabled':
      return Object.freeze({
        strategy: 'enabled',
        ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary })
      });
    case 'effort':
      return Object.freeze({
        strategy: 'effort',
        effort: reasoning.effort,
        ...(reasoning.mode === undefined ? {} : { mode: reasoning.mode }),
        ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary })
      });
    case 'budget':
      return Object.freeze({
        strategy: 'budget',
        maxTokens: reasoning.maxTokens,
        ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary })
      });
  }
}

function encodeSubmissionInput(input: SessionSubmissionInput): JsonObject {
  return Object.freeze({
    task: input.task,
    ...(input.origin === undefined ? {} : { origin: parseJsonValue(input.origin) }),
    ...(input.images === undefined ? {} : { images: parseJsonValue(input.images) }),
    ...(input.relationship ? { relationship: parseJsonValue(input.relationship) } : {}),
    ...(input.instructions === undefined
      ? {}
      : { instructions: Object.freeze([...input.instructions]) }),
    ...(input.contextItems === undefined
      ? {}
      : { contextItems: Object.freeze(input.contextItems.map(encodeContextItem)) })
  });
}

function encodeContextItem(
  item: NonNullable<SessionSubmissionInput['contextItems']>[number]
): JsonObject {
  return Object.freeze({
    sourceUri: item.sourceUri,
    sourceKind: item.sourceKind,
    ...(item.integrity === undefined ? {} : { integrity: item.integrity }),
    representation: item.representation,
    mediaType: item.mediaType,
    title: item.title,
    content: item.content,
    ...(item.range === undefined
      ? {}
      : {
          range: Object.freeze({
            kind: item.range.kind,
            ...(item.range.start === undefined ? {} : { start: item.range.start }),
            ...(item.range.end === undefined ? {} : { end: item.range.end })
          })
        }),
    purpose: item.purpose,
    ...(item.id === undefined ? {} : { id: item.id }),
    ...(item.tokenEstimate === undefined ? {} : { tokenEstimate: item.tokenEstimate })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nodeCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
