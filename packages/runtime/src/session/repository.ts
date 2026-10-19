import { ownPeerContributionInput, samePeerContribution, decodePeerContributionEntry } from './peer-contribution.js';
import { decodeSessionToolCatalogSelection, emptySessionToolCatalogSelection, toolCatalogSelectionOwner } from './tool-catalog.js';
import { parseToolCatalogSelection, type ToolCatalogSelectionState } from '@agent-core/tools';
import { createSessionRunFinalizationConfirmation } from './finalization-confirmation.js';
import { recordedModelSelection } from '../orchestration/model-change.js';
import { protectedInferenceInput } from '../inference/input.js';
import type { ProtectedArtifactRef } from '@agent-core/persistence';
import { sessionStateBatchCommitSchema, sessionStateBatchStorageBytes, sessionStateItemRefSchema, validateSessionStateCommit } from './session-state.js';
import { assertStateSelection, decodeSessionStateBatchEntry, stateReceipt, stateBatch, assertStateRetry, advanceMemoryState, emptyMemoryStateIndex, type MemoryStateIndex, assertStateSourceCut, stateItemMetadata, statePageLimits, statePageResult, decodeStatePageCursor } from './state-records.js';
import { parseJsonValue } from '@agent-core/json';
import { parseModelSelection, type ModelOutputItem, type ModelSelection } from '@agent-core/model';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';
import type { ContextTransitionCommit } from '../context/contracts.js';
import { historyEventSourceSchema } from '../history/schema.js';
import {
  createAgentTerminalSnapshot,
  terminalSnapshotFingerprint,
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
import {
  sourceSnapshot,
  settleMemorySource,
  assertBranchEntry,
  memoryBranchSource,
  readBranchPage,
  searchBranch
} from './branch-page.js';
import {
  contextCommitRetry,
  decodeContextTransitionEntry,
  sessionReplayState,
  validateContextCommit
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
  SessionExecutionOwnership,
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
  SessionSteeringEntry,
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
  isAcceptedUserCorrection,
  createSessionAdmission,
  sessionSubmission,
  initialSessionModelSelection,
  assertSessionIdle,
  assertSessionModelSettings,
  assertSessionAdmissionConfiguration,
  createSessionSubmissionTransition,
  originalAcceptedInput,
  materializedSessionInput,
  pendingSessionSubmissions
} from './submission-lifecycle.js';

export class InMemorySessionRepository implements SessionRepository {
  private readonly states = new Map<string, SessionState>();
  private queue: Promise<void> = Promise.resolve();
  private readonly executionOwners = new Map<string, symbol>();

  tryAcquireExecution(session: SessionDescriptor): Promise<SessionExecutionOwnership | undefined> {
    return this.serial(() => {
      this.requireDescriptor(session);
      if (this.executionOwners.has(session.id)) return undefined;
      const token = Symbol(session.id);
      this.executionOwners.set(session.id, token);
      let released = false;
      const assertOwned = (): Promise<void> =>
        released || this.executionOwners.get(session.id) !== token
          ? Promise.reject(new PersistenceConflictError('Session execution ownership was lost.'))
          : Promise.resolve();
      return Object.freeze({ assertOwned, release: () => this.serial(() => {
        if (released) return Promise.resolve();
        if (this.executionOwners.get(session.id) !== token)
          return Promise.reject(new PersistenceConflictError('Session execution ownership was lost.'));
        this.executionOwners.delete(session.id);
        released = true;
        return Promise.resolve();
      }) });
    });
  }


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
        type: 'session',
        version: 1,
        format: 'agent-core.session/7',
        sessionStateStorage: 'session',
        id,
        timestamp: new Date().toISOString(),
        binding,
        ...(options.parent ? { parentSessionId: options.parent.id } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {})
      });
      const state = { header, branchEntries: [], finalizations: [], confirmations: [], submissionRecords: [], acceptedInputRevision: 0, acceptedCorrectionRevision: 0, retainedStateBytes: 0, peerDeliveries: new Map<string, import('./contracts.js').SessionPeerContributionEntry>(), stateIndexes: new Map<string,MemoryStateIndex>(), catalogIndexes: new Map<string, MemoryCatalogIndex>() };
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
    return this.serial(() =>
      Object.freeze(
        [...this.states.values()]
          .map((state) => {
            const firstInput = state.branchEntries.find((entry) => entry.type === 'input');
            return Object.freeze({
              ...(firstInput === undefined
                ? {}
                : { preview: firstInput.task.replace(/\s+/gu, ' ').slice(0, 160) }),
              id: state.header.id,
              timestamp: state.header.timestamp,
              updatedAt: sessionUpdatedAt(state),
              ...(state.header.provider ? { provider: state.header.provider } : {}),
              ...(state.header.model ? { model: state.header.model } : {}),
              bindingSchemaId: state.header.binding.schemaId,
              bindingSchemaVersion: state.header.binding.schemaVersion,
              bindingSha256: state.header.binding.bindingSha256
            });
          })
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      )
    );
  }

  loadReplayState(session: SessionDescriptor, leafId?: string | null): Promise<SessionReplayState> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const current = sessionFromState(state);
      const branch = Object.freeze(
        activeBranch(state.branchEntries, leafId === undefined ? current.leafId : leafId)
      );
      return sessionReplayState(
        current,
        branch,
        state.finalizations,
        state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length
      );
    });
  }

  revision(session: SessionDescriptor): Promise<number> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      return state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length;
    });
  }
  acceptedCorrectionRevision(session: SessionDescriptor): Promise<number> {
    return this.serial(() => this.requireDescriptor(session).acceptedCorrectionRevision);
  }
  currentModelSettings(session: SessionDescriptor): Promise<ModelSelection | undefined> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      return recordedModelSelection(activeBranch(state.branchEntries, branchLeaf(state.branchEntries)))
        ?? initialSessionModelSelection(state.submissionRecords);
    });
  }
  committedRetainedStateBytes(session: SessionDescriptor): Promise<number> {
    return this.serial(() => this.requireDescriptor(session).retainedStateBytes);
  }
  findSessionStateBatch(session: SessionDescriptor, idempotencyKey: string) {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const entry = stateItems(state,branchLeaf(state.branchEntries)).batches.get(idempotencyKey);
      return entry ? stateReceipt(entry) : undefined;
    });
  }
  async saveSessionState(session: SessionDescriptor, input: Parameters<SessionRepository['saveSessionState']>[1], options: Parameters<SessionRepository['saveSessionState']>[2] = {}) {
    const batch = sessionStateBatchCommitSchema.parse(input);
    if (options.withOwnership) {
      const committed = await this.serial(() => {
        const state = this.requireDescriptor(session);
        const previous = stateItems(state,branchLeaf(state.branchEntries)).batches.get(batch.idempotencyKey);
        return previous ? assertStateRetry(previous,batch) : undefined;
      });
      if (committed) return committed;
    }
    const publish = () => this.serial(async () => {
      const state = this.requireDescriptor(session);
      const branch = activeBranch(state.branchEntries, branchLeaf(state.branchEntries));
      const items = stateItems(state,branchLeaf(state.branchEntries));
      const previous = items.batches.get(batch.idempotencyKey);
      if (previous) return assertStateRetry(previous, batch);
      if (batch.capturedHistoryCut.sourceRevision < state.acceptedInputRevision) throw new PersistenceConflictError('Accepted input changed after the state inference.');
      assertStateSourceCut(session.id, branch, batch, state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length);
      await validateSessionStateCommit(batch, itemId => Promise.resolve(items.heads.get(itemId)), state.retainedStateBytes);
      const entry = decodeSessionStateBatchEntry({...baseEntry(branchLeaf(state.branchEntries)), type: 'session_state_batch', batch});
      appendBranchRecord(state, entry);
      return stateReceipt(entry);
    });
    return options.withOwnership ? options.withOwnership(publish) : publish();
  }
  currentSessionStateItem(session: SessionDescriptor, itemId: string, leafId?: string | null) {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      return stateItems(state,leafId === undefined ? branchLeaf(state.branchEntries) : leafId).heads.get(itemId);
    });
  }
  readSessionStateItem(session: SessionDescriptor, input: Parameters<SessionRepository['readSessionStateItem']>[1], leafId?: string | null) {
    const ref = sessionStateItemRefSchema.parse(input);
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const item = stateItems(state,leafId === undefined ? branchLeaf(state.branchEntries) : leafId).revisions.get(ref.revisionId);
      if (item?.itemId !== ref.itemId) throw new Error('Session-state revision is unavailable on this branch.');
      if (ref.range && ref.range.offset + ref.range.bytes > item.contentBytes) throw new Error('Session-state range exceeds the immutable revision.');
      return item;
    });
  }
  listSessionState(session: SessionDescriptor, request: Parameters<SessionRepository['listSessionState']>[1] = {}) {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const {limit,maxBytes} = statePageLimits(request);
      const cursor = decodeStatePageCursor(session.id,request);
      const leaf = cursor?.leafId ?? (request.leafId === undefined ? branchLeaf(state.branchEntries) : request.leafId);
      const values = stateItems(state,leaf).orderedItems;
      const items: import('./session-state.js').SessionStateItemMetadata[] = [];
      let after = cursor?.after, partial = false;
      let start = 0;
      if (cursor) {
        const hash = hashJson(cursor.after);
        let end = values.length;
        while (start < end) {
          const middle = Math.floor((start + end) / 2), value = values[middle];
          if (value && (hashJson(value.itemId) < hash || (hashJson(value.itemId) === hash && value.itemId <= cursor.after))) start = middle + 1;
          else end = middle;
        }
      }
      for (let index = start; index < values.length; index++) {
        const value = values[index];
        if (!value) break;
        const metadata = stateItemMetadata(value);
        if (items.length >= limit) {partial = true; break;}
        try {if (statePageResult(session.id,leaf,[...items,metadata],index + 1 < values.length,value.itemId,maxBytes).items.length <= items.length) {partial = true;break;}}
        catch (error) {if (items.length === 0) throw error;partial = true;break;}
        items.push(metadata); after = value.itemId;
      }
      return statePageResult(session.id,leaf,items,partial,after,maxBytes);
    });
  }

  currentToolCatalogSelection(session: SessionDescriptor): Promise<ToolCatalogSelectionState> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      return catalogState(state, branchLeaf(state.branchEntries)).state;
    });
  }
  findToolCatalogSelection(session: SessionDescriptor, operationId: string): Promise<ToolCatalogSelectionState | undefined> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const current = catalogState(state, branchLeaf(state.branchEntries));
      const selection = current.operations.get(operationId);
      return selection ? Object.freeze({ ownerId: current.state.ownerId, selection }) : undefined;
    });
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
    const publish = () => this.serial(() => {
      const state = this.requireDescriptor(session);
      const current = catalogState(state, branchLeaf(state.branchEntries));
      if (input.ownerId !== current.state.ownerId) throw new PersistenceConflictError('Tool catalog branch changed.');
      const previous = current.operations.get(input.operationId);
      if (previous) {
        if (previous.revision !== selection.revision) throw new PersistenceConflictError('Tool catalog operation changed.');
        return Object.freeze({ ownerId: current.state.ownerId, selection: previous });
      }
      if (input.expectedRevision !== current.state.selection.revision) throw new PersistenceConflictError('Tool catalog selection changed.');
      const entry = decodeSessionToolCatalogSelection({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'tool_catalog_selection',
        branchId: current.branchId, operationId: input.operationId, selection });
      appendBranchRecord(state, entry);
      return catalogState(state, entry.id).state;
    });
    return options.withOwnership ? options.withOwnership(publish) : publish();
  }
  sourceSnapshot(session: SessionDescriptor, leafId?: string | null) {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      return sourceSnapshot(
        memoryBranchSource(session.id, state.branchEntries),
        state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length,
        state.finalizations,
        leafId,
        state.confirmations
      );
    });
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
    return this.serial(() =>
      readBranchPage(
        memoryBranchSource(session.id, this.requireDescriptor(session).branchEntries),
        request
      )
    );
  }

  searchBranch(
    session: SessionDescriptor,
    request: Parameters<SessionRepository['searchBranch']>[1]
  ) {
    return this.serial(() =>
      searchBranch(
        memoryBranchSource(session.id, this.requireDescriptor(session).branchEntries),
        request
      )
    );
  }

  readBranchEntry(
    session: SessionDescriptor,
    boundary: Parameters<SessionRepository['readBranchEntry']>[1],
    entryId: string
  ) {
    return this.serial(async () => {
      const source = memoryBranchSource(session.id, this.requireDescriptor(session).branchEntries);
      await assertBranchEntry(source, boundary, entryId);
      return source.read(entryId);
    });
  }

  listBranchPoints(session: SessionDescriptor): Promise<readonly SessionBranchPoint[]> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const points: SessionBranchPoint[] = state.finalizations.map((finalization) =>
        Object.freeze({
          entryId: finalization.throughEntryId,
          timestamp: finalization.timestamp,
          kind: 'run_finalization' as const,
          finalizationId: finalization.finalizationId,
          runId: finalization.runId
        })
      );
      for (const entry of state.branchEntries) {
        if (entry.type === 'context_transition' || entry.type === 'session_state_batch')
          points.push(
            Object.freeze({
              entryId: entry.id,
              timestamp: entry.timestamp,
              kind: entry.type
            })
          );
      }
      return Object.freeze(points);
    });
  }

  appendInput(
    session: SessionDescriptor,
    input: Parameters<SessionRepository['appendInput']>[1]
  ): Promise<SessionInputEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const existing = state.branchEntries.find(
        (entry): entry is SessionInputEntry => entry.type === 'input' && entry.runId === input.runId
      );
      if (existing) {
        if (!sameSessionInput(existing, input))
          throw new PersistenceConflictError(`Conflicting session input for run ${input.runId}.`);
        return existing;
      }
      const entry = Object.freeze({
        ...baseEntry(branchLeaf(state.branchEntries)),
        type: 'input' as const,
        runId: input.runId,
        task: input.task,
        ...(input.images === undefined ? {} : { images: parseSessionImages(input.images) }),
        ...materializedSessionInput(originalAcceptedInput(state.submissionRecords, input.runId), input),
        instructions: Object.freeze(
          (input.instructions ?? []).map((instruction) => Object.freeze({ ...instruction }))
        )
      });
      appendBranchRecord(state, entry);
      return entry;
    });
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
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const existing =
        owned.deliveryId === undefined
          ? undefined
          : state.branchEntries.find(
              (entry): entry is SessionSteeringEntry =>
                entry.type === 'steering' &&
                entry.runId === owned.runId &&
                entry.deliveryId === owned.deliveryId
            );
      if (existing) return sameSessionSteering(existing, owned);
      const entry: SessionSteeringEntry = Object.freeze({
        ...baseEntry(branchLeaf(state.branchEntries)),
        type: 'steering',
        ...owned
      });
      appendBranchRecord(state, entry);
      return entry;
    });
  }

  findPeerContribution(session: SessionDescriptor, deliveryId: string) {
    return this.serial(() => this.requireDescriptor(session).peerDeliveries.get(deliveryId));
  }

  async appendPeerContribution(session: SessionDescriptor, input: Parameters<SessionRepository['appendPeerContribution']>[1], options: Parameters<SessionRepository['appendPeerContribution']>[2] = {}) {
    const owned = ownPeerContributionInput(input);
    if (owned.recipient.sessionId !== session.id) throw new Error('Peer contribution recipient session does not match.');
    if (options.withOwnership) {
      const existing = await this.findPeerContribution(session,owned.deliveryId);
      if (existing) return samePeerContribution(existing,owned);
    }
    const publish = () => this.serial(() => {
      const state = this.requireDescriptor(session);
      const existing = state.peerDeliveries.get(owned.deliveryId);
      if (existing?.type === 'peer_contribution') return samePeerContribution(existing, owned);
      const entry = decodePeerContributionEntry({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'peer_contribution', authorship: 'model', contribution: owned });
      appendBranchRecord(state, entry);
      return entry;
    });
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
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const existing = state.branchEntries.find(
        (entry): entry is SessionAssistantEntry =>
          entry.type === 'assistant' &&
          entry.runId === input.runId &&
          entry.turnId === input.identity.turnId &&
          entry.requestAttempt === input.identity.requestAttempt &&
          entry.source?.eventId === input.source?.eventId
      );
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
        ...baseEntry(branchLeaf(state.branchEntries)),
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
      appendBranchRecord(state, entry);
      return entry;
    });
  }
  appendToolCall(
    session: SessionDescriptor,
    input: { runId: string; identity: AgentToolCallIdentity; call: unknown }
  ): Promise<SessionToolCallEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const call = parseJsonValue(input.call, {
        maxDepth: 32,
        maxCollectionEntries: 50_000,
        maxStringBytes: 4 * 1024 * 1024,
        maxTotalBytes: 8 * 1024 * 1024
      });
      const existing = state.branchEntries.find(
        (entry): entry is SessionToolCallEntry =>
          entry.type === 'tool_call' &&
          entry.runId === input.runId &&
          entry.toolBatchId === input.identity.toolBatchId &&
          entry.callIndex === input.identity.callIndex
      );
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
        ...baseEntry(branchLeaf(state.branchEntries)),
        type: 'tool_call',
        runId: input.runId,
        ...input.identity,
        call
      });
      appendBranchRecord(state, entry);
      return entry;
    });
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
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const normalized = captureObservationInput(input);
      const key = sessionObservationKey(normalized);
      const existing = key
        ? state.branchEntries.find(
            (entry): entry is SessionObservationEntry =>
              entry.type === 'observation' && sessionObservationKey(entry) === key
          )
        : undefined;
      if (existing) {
        if (!sameObservation(existing, normalized))
          throw new PersistenceConflictError(`Conflicting session observation for ${String(key)}.`);
        return existing;
      }
      const entry: SessionObservationEntry = Object.freeze({
        ...baseEntry(branchLeaf(state.branchEntries)),
        type: 'observation',
        ...normalized
      });
      appendBranchRecord(state, entry);
      return entry;
    });
  }
  appendModelSettings(session: SessionDescriptor, settings: ModelSelection): Promise<SessionModelSettingsEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      assertSessionModelSettings(pendingSessionSubmissions(state.submissionRecords));
      const branch = activeBranch(state.branchEntries, branchLeaf(state.branchEntries));
      let previous: SessionModelSettingsEntry | undefined;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry?.type === 'model_settings') {
          previous = entry;
          break;
        }
      }
      const selection = parseModelSelection(settings);
      if (previous && hashJson(recordedModelSelection([previous])) === hashJson(selection) &&
          hashJson(recordedModelSelection(branch)) === hashJson(selection)) return previous;
      const entry: SessionModelSettingsEntry = Object.freeze({ ...baseEntry(branchLeaf(state.branchEntries)), type: 'model_settings', ...selection });
      appendBranchRecord(state, entry);
      return entry;
    });
  }
  async commitContextTransition(
    session: SessionDescriptor,
    input: ContextTransitionCommit,
    options: Parameters<SessionRepository['commitContextTransition']>[2] = {}
  ): Promise<SessionContextTransitionEntry> {
    if (options.withOwnership) {
      const committed = await this.serial(() => {
        const state = this.requireDescriptor(session);
        return contextCommitRetry(activeBranch(state.branchEntries,branchLeaf(state.branchEntries)),input);
      });
      if (committed) return committed;
    }
    const publish = () => this.serial(async () => {
      const state = this.requireDescriptor(session);
      const branch = activeBranch(state.branchEntries, branchLeaf(state.branchEntries));
      const existing = contextCommitRetry(branch, input);
      if (existing) return existing;
      validateContextCommit(
        session.id,
        branch,
        state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length,
        input,
        state.finalizations
      );
      if (input.sessionState) {
        const items = stateItems(state,branchLeaf(state.branchEntries));
        if (items.batches.has(input.sessionState.idempotencyKey)) throw new PersistenceConflictError('State batch was already committed.');
        if (input.sessionState.capturedHistoryCut.sourceRevision < state.acceptedInputRevision) throw new PersistenceConflictError('Accepted input changed after the state inference.');
        assertStateSourceCut(session.id, branch, input.sessionState, state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length);
        await validateSessionStateCommit(input.sessionState, itemId => Promise.resolve(items.heads.get(itemId)), state.retainedStateBytes);
      }
      const selectedItems = new Map(stateItems(state,branchLeaf(state.branchEntries)).revisions);
      for (const revision of input.sessionState?.revisions ?? []) selectedItems.set(revision.revisionId,revision);
      for (const ref of input.window.selection.sessionState ?? []) assertStateSelection(ref,selectedItems.get(ref.revisionId));
      const entry = decodeContextTransitionEntry({
        ...baseEntry(branchLeaf(state.branchEntries)),
        type: 'context_transition',
        ...(input.sessionState ? { sessionState: input.sessionState } : {}),
        window: input.window,
        transition: input.transition
      });
      appendBranchRecord(state, entry);
      return entry;
    });
    return options.withOwnership ? options.withOwnership(publish) : publish();
  }
  branchFrom(
    session: SessionDescriptor,
    entryId: string,
    label?: string
  ): Promise<SessionBranchMarkerEntry> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      assertSessionIdle(state.submissionRecords);
      const source = state.branchEntries.find((entry) => entry.id === entryId);
      if (!source) throw new Error(`Unknown entry: ${entryId}`);
      if (
        source.type !== 'context_transition' && source.type !== 'session_state_batch' &&
        !state.finalizations.some((finalization) => finalization.throughEntryId === entryId)
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
      appendBranchRecord(state, entry);
      return entry;
    });
  }
  recordRunFinalization(
    session: SessionDescriptor,
    terminalInput: AgentTerminalSnapshot
  ): Promise<SessionRunFinalization> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const terminal = createAgentTerminalSnapshot(terminalInput);
      const existing = state.finalizations.find(
        (finalization) => finalization.finalizationId === terminal.finalizationId
      );
      if (existing) {
        if (
          terminalSnapshotFingerprint(existing.terminal) !== terminalSnapshotFingerprint(terminal)
        )
          throw new PersistenceConflictError(
            `Conflicting finalization ${terminal.finalizationId}.`
          );
        return existing;
      }
      const throughEntryId = branchLeaf(state.branchEntries);
      if (
        !throughEntryId ||
        !activeBranch(state.branchEntries, throughEntryId).some(
          (entry) => entry.type === 'input' && entry.runId === terminal.runId
        )
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
      state.finalizations.push(finalization);
      settleMemorySource(memoryBranchSource(state.header.id, state.branchEntries), state.finalizations, state.confirmations);
      return finalization;
    });
  }

  confirmRunFinalization(
    session: SessionDescriptor,
    input: Parameters<SessionRepository['confirmRunFinalization']>[1]
  ): Promise<SessionRunFinalizationConfirmation> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const finalization = state.finalizations.find((entry) => entry.finalizationId === input.finalizationId);
      const existing = state.confirmations.find((entry) => entry.runId === input.runId || entry.finalizationId === input.finalizationId);
      const confirmation = createSessionRunFinalizationConfirmation(finalization, existing, input);
      if (!existing) {
        state.confirmations.push(confirmation);
        settleMemorySource(memoryBranchSource(state.header.id, state.branchEntries), state.finalizations, state.confirmations);
      }
      return confirmation;
    });
  }

  admitSubmission(
    session: SessionDescriptor,
    input: Parameters<SessionRepository['admitSubmission']>[1]
  ): Promise<SessionPendingSubmission> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const selection = recordedModelSelection(activeBranch(state.branchEntries, branchLeaf(state.branchEntries)))
        ?? initialSessionModelSelection(state.submissionRecords);
      assertSessionAdmissionConfiguration(input.configuration, selection);
      const record = createSessionAdmission(state.submissionRecords, input);
      state.submissionRecords.push(record);
      state.acceptedInputRevision = state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length;
      if (isAcceptedUserCorrection(record)) state.acceptedCorrectionRevision = state.acceptedInputRevision;
      const admitted = sessionSubmission(state.submissionRecords, record.submissionId);
      if (!admitted || (admitted.state !== 'claimed' && admitted.state !== 'queued'))
        throw new Error('Committed admission has no pending submission.');
      return Object.freeze({ ...admitted, state: admitted.state });
    });
  }

  claimNextSubmission(session: SessionDescriptor, claimId: string): Promise<SessionPendingSubmission | undefined> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const pending = pendingSessionSubmissions(state.submissionRecords);
      if (pending.some((entry) => entry.state !== 'queued')) return undefined;
      const next = pending[0];
      if (!next) return undefined;
      const record = createSessionSubmissionTransition(state.submissionRecords, next.submissionId, { state: 'claimed', claimId });
      if (record) state.submissionRecords.push(record);
      return Object.freeze({ ...next, state: 'claimed', claimId });
    });
  }

  transitionSubmission(
    session: SessionDescriptor,
    submissionId: string,
    outcome: import('./contracts.js').SessionSubmissionOutcome
  ): Promise<void> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      const record = createSessionSubmissionTransition(
        state.submissionRecords,
        submissionId,
        outcome
      );
      if (record) state.submissionRecords.push(record);
    });
  }
  async pendingSubmissionSummaries(session: SessionDescriptor) {
    const pending = await this.loadPendingSubmissions(session);
    return Object.freeze(pending.map(({runId, submissionId, state}) => Object.freeze({runId, submissionId, state})));
  }

  readSubmission(session: SessionDescriptor, submissionId: string) {
    return this.serial(() => sessionSubmission(this.requireDescriptor(session).submissionRecords, submissionId));
  }

  loadPendingSubmissions(session: SessionDescriptor): Promise<readonly SessionPendingSubmission[]> {
    return this.serial(() =>
      pendingSessionSubmissions(this.requireDescriptor(session).submissionRecords)
    );
  }

  updateQueuedSubmission(
    session: SessionDescriptor,
    submissionId: string,
    change: Parameters<SessionRepository['updateQueuedSubmission']>[2]
  ): Promise<void> {
    return this.serial(() => {
      const state = this.requireDescriptor(session);
      state.submissionRecords.push(
        createQueuedSubmissionUpdate(state.submissionRecords, submissionId, change)
      );
      if (change.kind === 'replace') {
        state.acceptedInputRevision = state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length;
        state.acceptedCorrectionRevision = state.acceptedInputRevision;
      }
    });
  }

  private require(sessionId: string): SessionState {
    const state = this.states.get(sessionId);
    if (!state) throw new Error(`Unknown session: ${sessionId}`);
    return state;
  }
  private requireDescriptor(session: SessionDescriptor): SessionState {
    const state = this.require(session.id);
    assertSessionBinding(decodeSessionBinding(session.header.binding), state.header.binding);
    return state;
  }
  private serial<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function sessionUpdatedAt(state: SessionState): string {
  return [...state.branchEntries, ...state.finalizations, ...state.confirmations, ...state.submissionRecords].reduce(
    (latest, entry) => (entry.timestamp > latest ? entry.timestamp : latest),
    state.header.timestamp
  );
}

interface SessionState {
  acceptedInputRevision: number;
  acceptedCorrectionRevision: number;
  retainedStateBytes: number;
  readonly peerDeliveries: Map<string, import('./contracts.js').SessionPeerContributionEntry>;
  readonly stateIndexes: Map<string,MemoryStateIndex>;
  readonly catalogIndexes: Map<string, MemoryCatalogIndex>;
  readonly header: SessionHeader;
  readonly branchEntries: SessionBranchEntry[];
  readonly finalizations: SessionRunFinalization[];
  readonly confirmations: SessionRunFinalizationConfirmation[];
  readonly submissionRecords: SessionSubmissionRecord[];
}
function stateItems(state: SessionState, leafId: string | null): MemoryStateIndex {
  if (leafId === null) return emptyMemoryStateIndex;
  const items = state.stateIndexes.get(leafId);
  if (!items) throw new Error(`Unknown session-state boundary: ${leafId}`);
  return items;
}
interface MemoryCatalogIndex {
  readonly branchId: string;
  readonly state: ToolCatalogSelectionState;
  readonly operations: ReadonlyMap<string, import('@agent-core/tools').ToolCatalogSelection>;
}
function catalogState(state: SessionState, leafId: string | null): MemoryCatalogIndex {
  if (leafId === null) return { branchId: state.header.id, state: emptySessionToolCatalogSelection(state.header.id), operations: new Map() };
  const current = state.catalogIndexes.get(leafId);
  if (!current) throw new Error('Unknown tool catalog branch boundary.');
  return current;
}
function appendBranchRecord(state: SessionState, entry: SessionBranchEntry): void {
  const parent = catalogState(state, entry.parentId);
  const branchId = entry.type === 'branch' ? entry.id : parent.branchId;
  state.catalogIndexes.set(entry.id, {
    branchId,
    state: Object.freeze({ ownerId: toolCatalogSelectionOwner(state.header.id, branchId),
      selection: entry.type === 'tool_catalog_selection' ? entry.selection : parent.state.selection }),
    operations: entry.type === 'tool_catalog_selection' ? new Map([...parent.operations, [entry.operationId, entry.selection]]) : parent.operations
  });
  state.stateIndexes.set(entry.id,advanceMemoryState(stateItems(state,entry.parentId),entry));
  const batch = stateBatch(entry);
  if (batch) state.retainedStateBytes += sessionStateBatchStorageBytes(batch);
  state.branchEntries.push(entry);
  if (entry.type === 'peer_contribution') state.peerDeliveries.set(entry.contribution.deliveryId, entry);
  if (entry.type === 'input' || entry.type === 'steering') state.acceptedInputRevision = state.branchEntries.length + state.finalizations.length + state.confirmations.length + state.submissionRecords.length;
  if (isAcceptedUserCorrection(entry)) state.acceptedCorrectionRevision = state.acceptedInputRevision;
  memoryBranchSource(state.header.id, state.branchEntries);
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
function sessionFromState(state: SessionState): SessionDescriptor {
  return Object.freeze({
    id: state.header.id,
    header: state.header,
    leafId: branchLeaf(state.branchEntries)
  });
}
function baseEntry(parentId: string | null): BaseSessionEntry {
  return { id: randomUUID(), parentId, timestamp: new Date().toISOString() };
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
  return JSON.stringify(observationPayload(existing)) === JSON.stringify(input);
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

export type * from './contracts.js';
