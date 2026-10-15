import { createProjectionSnapshot, type SessionIndexState } from './projection-snapshot-node.js';
import { promises as fs } from 'node:fs';
import { parseModelSelection, type ModelSelection } from '@agent-core/model';
import { randomUUID } from 'node:crypto';
import { historyCutSchema, historyEventSourceSchema } from '../history/schema.js';
import { contextCommitRetry, validateContextCommitState } from './context-records.js';
import type { ContextTransitionCommit } from '../context/contracts.js';
import * as z from 'zod';
import { canonicalJsonString, parseJsonObject, type JsonValue } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import {
  appendJsonlRecord, withPersistenceFileLock, jsonlBoundaryMarker, jsonlCommittedBytes,
  jsonlStorageStamp, readJsonlBytes, readJsonlLines, sameJsonlStorageStamp,
  type JsonlLine, type JsonlStorageStamp
} from '@agent-core/persistence/node';
import { assertSessionBinding, type SessionBindingInput } from './binding.js';
import { SessionHistorySourceError, SessionHistoryIndexPublicationError, type HistoryIndexRebuildOptions } from './history-index.js';
import { branchNavigation, branchEntryMetadata, type BranchEntryPosition, type BranchPageSource } from './branch-page.js';
import { sessionStateAtEntry, sessionStateChangeSchema, type SessionStateRevision } from './session-state.js';
import { assertSubmissionOwnership, assertSubmissionTransition, createSessionAdmission } from './submission-lifecycle.js';
import { SessionIndexStore } from './projection-store-node.js';
import { SessionIndexTree, SessionIndexNodeError } from './projection-tree-node.js';
import type {
  SessionBranchEntry, SessionBranchPoint, SessionDescriptor, SessionHeader,
  SessionPendingSubmission, SessionSubmissionRecord, SessionRunFinalization, SessionRunFinalizationConfirmation, SessionSummary, SessionRepository
} from './contracts.js';

type Record = SessionBranchEntry | SessionRunFinalization | SessionRunFinalizationConfirmation | SessionSubmissionRecord;
const id = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative();
const locatorSchema = z.strictObject({offset: integer, bytes: z.number().int().positive().max(64 * 1024 * 1024), line: z.number().int().min(2), hash});
type Locator = z.infer<typeof locatorSchema>;
const stampSchema = z.strictObject({size: integer, mtimeMs: z.number(), ctimeMs: z.number()});
const rootSchema = z.strictObject({
  format: z.literal('agent-core.session-projection/7'), generation: id, lineage: z.uuid(), header: z.unknown(),
  summary: z.strictObject({id, timestamp: id, updatedAt: id, preview: z.string().max(160).optional(), provider: id.optional(), model: id.optional(), bindingSchemaId: id, bindingSchemaVersion: z.number().int().positive(), bindingSha256: hash}),
  tree: hash.nullable(), confirmedRunsRoot: hash.nullable(), leafId: id.nullable(), sourceRevision: integer, indexedRecords: integer,
  headerBytes: z.number().int().positive().max(16 * 1024 * 1024), completeBytes: integer, lineCount: integer, marker: z.string(), stamp: stampSchema,
  queueFirst: id.nullable(), queueLast: id.nullable(), occupied: id.nullable(), queuedCount: integer, capacity: integer.nullable()
});
type Root = Omit<z.infer<typeof rootSchema>, 'header'> & {header: SessionHeader};
const sessionStateSchema = sessionStateChangeSchema.omit({content: true}).extend({ parentId: id.nullable(), timestamp: id, contentSha256: hash, contentBytes: integer });
const positionSchema = locatorSchema.extend({
  depth: integer, ancestors: z.array(id).max(53), branchId: id,
  lookupRoot: hash.nullable(), inheritedHeadsRoot: hash.nullable(), activeRunsRoot: hash.nullable(), finalizedRunsRoot: hash.nullable(), unconfirmedRunsRoot: hash.nullable(), confirmedRunsRoot: hash.nullable(),
  parentId: id.nullable(), identity: id, type: z.enum(['input','steering','assistant','tool_call','observation','branch','model_settings','context_transition']),
  timestamp: id, runId: id.optional(), toolName: id.optional(), source: historyEventSourceSchema.optional(),
  fromEntryId: id.nullable().optional(), historyPosition: historyCutSchema.optional(),
  sessionStateId: id.nullable(), modelSourceId: id.nullable(), contextId: id.nullable(),
  context: z.strictObject({
    type: z.enum(['input','steering','assistant','tool_call','observation','branch','model_settings','context_transition']),
    description: z.string().max(400), runId: id.optional(), exchangeId: id.optional(),
    callIndex: integer.optional(), toolBatchId: id.optional(), expectedCalls: integer.optional(),
    prefixBound: z.boolean().optional(), contextRecovery: z.literal(true).optional()
  })
});
type Position = BranchEntryPosition & Locator & SessionIndexState & {readonly sessionStateId: string | null; readonly modelSourceId: string | null; readonly contextId: string | null;};
const submissionSchema = z.strictObject({
  submissionId: id, runId: id, state: z.enum(['queued','claimed','suspended','completed','failed','cancelled']),
  claimId: id.optional(), previous: id.nullable(), next: id.nullable(), admission: locatorSchema, input: locatorSchema, latest: locatorSchema
});
type Submission = z.infer<typeof submissionSchema>;

/** One derived owner: bounded root and immutable point-lookup metadata. Original bodies stay in JSONL. */
export class JsonlBranchIndex {
  private root: Root | undefined;
  private sourceCache: {lineage: string; positions: Map<string, Position>} | undefined;
  private rootStamp: JsonlStorageStamp | undefined;
  private readonly tree: SessionIndexTree;
  private readonly store: SessionIndexStore;
  private mainTree: {lineage: string; tree: SessionIndexTree} | undefined;
  private metadataBytesRead = 0;
  private metadataRecordsRead = 0;
  private scannedBytes = 0;
  private headerBytesRead = 0;
  private bodyBytesRead = 0;
  private bodyRecordsRead = 0;
  constructor(private readonly sessionId: string, private readonly filePath: string,
    private readonly decodeHeader: (line: JsonlLine) => SessionHeader,
    private readonly decodeRecord: (line: JsonlLine) => Record) {
    this.store = new SessionIndexStore(`${filePath}.index`);
    this.tree = new SessionIndexTree(this.store, 'values', bytes => {
      this.metadataBytesRead += bytes; this.metadataRecordsRead++;
    }, operation => this.store.inScope ? operation() : this.lock(operation), true);
  }
  private main(root: Root): SessionIndexTree {
    if (this.mainTree?.lineage !== root.lineage) this.mainTree = {lineage: root.lineage,
      tree: new SessionIndexTree(this.store, `main-${root.lineage}`, bytes => {
        this.metadataBytesRead += bytes; this.metadataRecordsRead++;
      }, operation => operation())};
    return this.mainTree.tree;
  }
  metrics() {return Object.freeze({indexedRecords: this.root?.indexedRecords ?? 0, metadataBytesRead: this.metadataBytesRead,
    metadataRecordsRead: this.metadataRecordsRead, scannedBytes: this.scannedBytes, headerBytesRead: this.headerBytesRead, bodyBytesRead: this.bodyBytesRead, bodyRecordsRead: this.bodyRecordsRead});}
  async summary(expectedBinding?: SessionBindingInput, signal?: AbortSignal, onProgress?: HistoryIndexRebuildOptions['onProgress']): Promise<SessionSummary> {
    const value = (await this.refresh(expectedBinding, signal, onProgress)).summary;
    return {id: value.id, timestamp: value.timestamp, updatedAt: value.updatedAt, bindingSchemaId: value.bindingSchemaId, bindingSchemaVersion: value.bindingSchemaVersion, bindingSha256: value.bindingSha256, ...(value.preview === undefined ? {} : {preview: value.preview}), ...(value.provider === undefined ? {} : {provider: value.provider}), ...(value.model === undefined ? {} : {model: value.model})};
  }
  async descriptor(expectedBinding?: SessionBindingInput): Promise<SessionDescriptor> {
    const root = await this.refresh(expectedBinding);
    return Object.freeze({id: this.sessionId, header: root.header, leafId: root.leafId});
  }
  async checked(session: SessionDescriptor): Promise<Root> {
    if (session.id !== this.sessionId) throw new Error('Session descriptor identity mismatch.');
    return this.refresh(session.header.binding);
  }
  /** The repository holds the source lock across validation, source append and root publication. */
  async append(session: SessionDescriptor, encoded: JsonValue): Promise<void> {
    await this.checked(session);
    await this.lock(async () => {
      let current = await this.refreshLocked(session.header.binding);
      const text = canonicalJsonString(encoded);
      const record = this.decodeRecord({text, line: current.lineCount + 1, byteOffset: current.completeBytes, terminated: true});
      const prepare = async (base: Root) => {
        const main = this.main(base);
        main.begin(); this.tree.begin();
        try {
          const candidate = {...base};
          if (!('submissionId' in record) && record.type !== 'run_finalization' && record.type !== 'run_finalization_confirmed' && record.type !== 'branch' && record.parentId !== base.leafId)
            throw new Error('Session leaf changed before append.');
          await this.consume(candidate, record, {offset: base.completeBytes, bytes: Buffer.byteLength(text) + 1, line: base.lineCount + 1, hash: hashJson(record)});
          return candidate;
        } catch (error) {main.discard(); this.tree.discard(); throw error;}
      };
      let candidate: Root;
      try {candidate = await prepare(current);} catch (error) {
        if (!(error instanceof SessionIndexNodeError) && !(error instanceof z.ZodError)) throw error;
        await this.rebuildLocked(session.header.binding);
        current = await this.refreshLocked(session.header.binding);
        candidate = await prepare(current);
      }
      const main = this.main(current);
      try {
        const stamp = await jsonlStorageStamp(this.filePath);
        if (!sameJsonlStorageStamp(stamp, current.stamp)) throw new SessionHistorySourceError(this.sessionId, 'Original history changed before append.');
        const committed = await jsonlCommittedBytes(this.filePath, stamp.size);
        if (committed !== current.completeBytes) throw new SessionHistorySourceError(this.sessionId, 'Original committed boundary changed before append.');
        const retired = await main.retired(current.tree, candidate.tree);
        await this.store.commit(async () => {
          await main.flush(); await this.tree.flush();
          // Destructive tail repair derives its boundary from the original, never from a sidecar.
          if (stamp.size > committed) await fs.truncate(this.filePath, committed);
          const bytes = await appendJsonlRecord(this.filePath, encoded);
          candidate.completeBytes = committed + bytes; candidate.lineCount = current.lineCount + 1;
          candidate.stamp = await jsonlStorageStamp(this.filePath);
          candidate.marker = await jsonlBoundaryMarker(this.filePath, candidate.completeBytes);
          await main.removeNodes(retired);
          this.publish(candidate);
        });
        await this.verifyPublication(candidate);

      } finally {
        main.discard(); this.tree.discard();
      }
    });
  }
  async rebuild(expectedBinding: SessionBindingInput, options: HistoryIndexRebuildOptions = {}): Promise<void> {
    await this.lock(() => this.rebuildLocked(expectedBinding, options), options.signal);
  }
  async source(session: SessionDescriptor): Promise<BranchPageSource> {
    return this.query(session, async root => {
      const leaf = root.leafId === null ? undefined : this.positionValue(await this.main(root).get(root.tree, `entry:${root.leafId}`));
      return this.sourceFor(root, leaf?.hash ?? null);
    });
  }
  private sourceFor(captured: Root, leafHash: string | null): BranchPageSource {
    if (this.sourceCache?.lineage !== captured.lineage) this.sourceCache = {lineage: captured.lineage, positions: new Map()};
    const positions = this.sourceCache.positions;
    let lineage = captured.lineage;
    let verifiedStamp = captured.stamp;
    const validate = async (): Promise<void> => {
      if (sameJsonlStorageStamp(await jsonlStorageStamp(this.filePath), verifiedStamp)) return;
      await this.query({id: this.sessionId, header: captured.header, leafId: captured.leafId}, async current => {
        if (captured.leafId !== null) {
          const currentLeaf = this.positionValue(await this.main(current).get(current.tree, `entry:${captured.leafId}`));
          if (leafHash !== currentLeaf.hash) throw new SessionHistorySourceError(this.sessionId, 'Captured history boundary changed.');
        }
        if (current.lineage !== lineage) positions.clear();
        lineage = current.lineage; verifiedStamp = current.stamp;
      });
    };
    const readPosition = async (entryId: string): Promise<Position | undefined> => {
      const known = positions.get(entryId);
      // Public operations validate their captured boundary once; ancestry navigation then
      // reuses owned immutable metadata without repeating the same filesystem observation.
      if (known && known.offset + known.bytes <= captured.completeBytes) return known;
      return this.query({id: this.sessionId, header: captured.header, leafId: captured.leafId}, async current => {
        if (current.lineage !== lineage && captured.leafId !== null) {
          positions.clear();
          const currentLeaf = this.positionValue(await this.main(current).get(current.tree, `entry:${captured.leafId}`));
          if (leafHash !== currentLeaf.hash) throw new SessionHistorySourceError(this.sessionId, 'Captured history boundary changed.');
          lineage = current.lineage;
        }
        verifiedStamp = current.stamp;
        const cached = positions.get(entryId);
        if (cached && current.lineage === lineage && cached.offset + cached.bytes <= captured.completeBytes) return cached;
        const value = await this.main(current).get(current.tree, `entry:${entryId}`);
        if (value === undefined) return undefined;
        const position = this.positionValue(value);
        if (position.offset + position.bytes > captured.completeBytes) return undefined;
        if (positions.size >= 1024) {
          const oldest = positions.keys().next().value;
          if (oldest !== undefined) positions.delete(oldest);
        }
        positions.set(entryId, position);
        return position;
      });
    };
    return {sessionId: this.sessionId, leafId: captured.leafId, positions, readPosition, validate,
      read: async entryId => {
        const position = await readPosition(entryId);
        if (!position) throw new Error(`Unknown session history entry: ${entryId}`);
        return this.branchRecord(position, entryId, captured);
      }};
  }
  async points(session: SessionDescriptor): Promise<readonly SessionBranchPoint[]> {
    return this.query(session, async root => {
      const points: {point: SessionBranchPoint; offset: number}[] = [];
      for await (const [key, value] of this.main(root).entries(root.tree)) {
        if (!key.startsWith('point:')) continue;
        const item = z.strictObject({offset: integer, entryId: id, timestamp: id, kind: z.enum(['run_finalization','context_transition']), runId: id.optional(), finalizationId: id.optional()}).parse(value);
        points.push({offset: item.offset, point: {entryId: item.entryId, timestamp: item.timestamp, kind: item.kind,
          ...(item.runId === undefined ? {} : {runId: item.runId}),
          ...(item.finalizationId === undefined ? {} : {finalizationId: item.finalizationId})}});
      }
      return Object.freeze(points.sort((a,b) => a.offset - b.offset).map(item => Object.freeze(item.point)));
    });
  }
  async snapshot(session: SessionDescriptor, leafId?: string | null) {
    const captured = await this.query(session, async root => {
      const selected = leafId === undefined ? root.leafId : leafId;
      const position = selected === null ? undefined : this.positionValue(await this.main(root).get(root.tree, `entry:${selected}`));
      return {root, selected, position, source: this.sourceFor({...root, leafId: selected}, position?.hash ?? null)};
    });
    const {root, selected, position, source} = captured;
    const state = position === undefined ? undefined : {...position, confirmedRunsRoot: root.confirmedRunsRoot};
    return createProjectionSnapshot(source, root.sourceRevision, selected, state, {
      get: (tree, key) => this.readProjection(tree, key, session.header.binding),
      entries: tree => this.projectionEntries(tree, session.header.binding)
    });
  }
  private async readProjection(root: string | null, key: string, binding: SessionBindingInput): Promise<unknown> {
    const cached = this.tree.cached(root, key);
    if (cached.found) return cached.value;
    try {return await this.lock(() => this.tree.get(root, key));} catch (error) {
      if (!(error instanceof SessionIndexNodeError)) throw error;
      await this.rebuild(binding);
      return this.lock(() => this.tree.get(root, key));
    }
  }
  private async *projectionEntries(root: string | null, binding: SessionBindingInput): AsyncGenerator<readonly [string, unknown]> {
    const seen = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const entry of this.tree.entries(root)) if (!seen.has(entry[0])) {seen.add(entry[0]); yield entry;}
        return;
      } catch (error) {
        if (attempt > 0 || !(error instanceof SessionIndexNodeError)) throw error;
        await this.rebuild(binding);
      }
    }
  }
  async find(session: SessionDescriptor, key: string): Promise<Record | undefined> {
    return this.query(session, async root => {
      const value = await this.main(root).get(root.tree, key);
      return value === undefined ? undefined : this.readRecord(locatorSchema.parse(value), root);
    });
  }
  async entry(session: SessionDescriptor, entryId: string): Promise<SessionBranchEntry> {
    return this.query(session, async root => this.branchRecord(await this.locate(root, `entry:${entryId}`), entryId, root));
  }
  async position(session: SessionDescriptor, entryId: string): Promise<Position> {
    return this.query(session, async root => {
      const value = await this.main(root).get(root.tree, `entry:${entryId}`);
      if (value === undefined) throw new Error(`Unknown session history entry: ${entryId}`);
      return this.positionValue(value);
    });
  }
  async branchContainsInput(session: SessionDescriptor, runId: string): Promise<boolean> {
    return this.query(session, async root => {
      if (root.leafId === null) return false;
      const leaf = this.positionValue(await this.main(root).get(root.tree, `entry:${root.leafId}`));
      return await this.tree.get(leaf.lookupRoot, `input:${runId}`) !== undefined;
    });
  }
  async contextRetry(session: SessionDescriptor, input: ContextTransitionCommit) {
    return this.query(session, async root => {
      if (root.leafId === null) return undefined;
      const leaf = this.positionValue(await this.main(root).get(root.tree, `entry:${root.leafId}`));
      const pointer = await this.tree.get(leaf.lookupRoot, `context:${input.transition.idempotencyKey}`);
      if (pointer === undefined) return undefined;
      const target = z.strictObject({entryId: id}).parse(pointer);
      const record = await this.branchRecord(await this.locate(root, `entry:${target.entryId}`), target.entryId, root);
      if (record.type !== 'context_transition') throw new Error('Invalid context retry projection.');
      return contextCommitRetry([record], input);
    });
  }
  async sessionState(session: SessionDescriptor, leafId?: string | null): Promise<SessionStateRevision | null> {
    return this.query(session, async root => {
      const selected = leafId === undefined ? root.leafId : leafId;
      const leaf = selected === null ? undefined : this.positionValue(await this.main(root).get(root.tree, `entry:${selected}`));
      return this.stateAt(root, leaf?.sessionStateId ?? null);
    });
  }
  private async stateAt(root: Root, stateId: string | null): Promise<SessionStateRevision | null> {
    return stateId === null ? null : Object.freeze(sessionStateSchema.parse(
      await this.main(root).get(root.tree, `session-state:${stateId}`)
    ));
  }
  async validateContext(session: SessionDescriptor, input: ContextTransitionCommit): Promise<void> {
    return this.query(session, async root => {
      const positions = new Map<string, Position>();
      const readPosition = async (entryId: string) => {
        const cached = positions.get(entryId);
        if (cached) return cached;
        const value = await this.main(root).get(root.tree, `entry:${entryId}`);
        if (value === undefined) return undefined;
        const position = this.positionValue(value); positions.set(entryId, position); return position;
      };
      const leaf = root.leafId === null ? undefined : await readPosition(root.leafId);
      const source: BranchPageSource = {sessionId: this.sessionId, leafId: root.leafId, positions, readPosition, validate: () => Promise.resolve(),
        read: async entryId => this.branchRecord(await this.locate(root, `entry:${entryId}`), entryId, root)};
      const navigation = await branchNavigation(source, {sessionId: this.sessionId, leafId: root.leafId, leafHash: leaf?.hash ?? null});
      const refs = new Map<string, string>();
      const finalizations: {runId: string; throughEntryId: string}[] = [];
      const runs = new Set<string>();
      const selectedRefs = new Map([
        ...input.window.selection.retained,
        ...(input.window.selection.excerpts ?? []).map(excerpt => excerpt.source)
      ].map(ref => [hashJson(ref), ref]));
      for (const ref of selectedRefs.values()) {
        const position = await readPosition(ref.entryId);
        if (position && await navigation.contains(ref.entryId)) refs.set(ref.entryId, position.hash);
        if (!ref.event || runs.has(ref.event.runId)) continue;
        runs.add(ref.event.runId);
        const value = await this.tree.get(leaf?.finalizedRunsRoot ?? null, ref.event.runId);
        if (value === undefined) continue;
        const finalization = z.strictObject({runId: id, throughEntryId: id, finalizationId: id}).parse(value);
        const through = await readPosition(finalization.throughEntryId);
        if (through && await navigation.contains(finalization.throughEntryId)) {
          refs.set(finalization.throughEntryId, through.hash);
          finalizations.push(finalization);
        }
      }
      const context = leaf?.contextId ? await this.branchRecord(await this.locate(root, `entry:${leaf.contextId}`), leaf.contextId, root) : undefined;
      validateContextCommitState(this.sessionId, {
        leafId: root.leafId, windowId: context?.type === 'context_transition' ? context.window.windowId : null,
        sessionState: await this.stateAt(root, leaf?.sessionStateId ?? null), refs, finalizations
      }, root.sourceRevision, input);
    });
  }
  async currentModelSettings(session: SessionDescriptor) {
    return this.query(session, async root => {
      if (root.leafId === null) return undefined;
      const position = this.positionValue(await this.main(root).get(root.tree, `entry:${root.leafId}`));
      if (position.modelSourceId === null) return undefined;
      const entry = await this.branchRecord(await this.locate(root, `entry:${position.modelSourceId}`), position.modelSourceId, root);
      if (entry.type !== 'model_settings' && entry.type !== 'context_transition') throw new Error('Invalid model-settings projection.');
      return entry;
    });
  }
  async initialModelSettings(session: SessionDescriptor): Promise<ModelSelection | undefined> {
    return this.query(session, async root => {
      const value = await this.main(root).get(root.tree, 'initial-model');
      return value === undefined ? undefined : parseModelSelection(value);
    });
  }
  async isFinalizedEntry(session: SessionDescriptor, entryId: string): Promise<boolean> {
    return this.query(session, async root => await this.main(root).get(root.tree, `finalized-entry:${entryId}`) !== undefined);
  }
  async nextQueuedSubmission(session: SessionDescriptor): Promise<string | undefined> {
    const root = await this.checked(session);
    return root.occupied === null ? root.queueFirst ?? undefined : undefined;
  }
  async assertClaim(session: SessionDescriptor, submissionId: string): Promise<void> {
    const root = await this.checked(session);
    if (root.occupied !== null && root.occupied !== submissionId) throw new Error(`Session is occupied by submission ${root.occupied}.`);
    if (root.occupied === null && root.queueFirst !== submissionId) throw new Error('Session submissions must be claimed in durable admission order.');
  }
  async assertIdle(session: SessionDescriptor): Promise<void> {
    const root = await this.checked(session);
    if (root.occupied !== null || root.queuedCount > 0) throw new Error('Session mutation requires an idle session with no pending submissions.');
  }
  async admission(session: SessionDescriptor, input: Parameters<SessionRepository['admitSubmission']>[1]) {
    return this.query(session, async root => {
      const maximum = input.maximumQueuedInputs ?? 1024;
      if (root.capacity !== null && root.capacity !== maximum) throw new Error('Session queue capacity differs from its durable admission policy.');
      if (await this.main(root).get(root.tree, `submission:${input.submissionId}`) !== undefined) throw new Error(`Duplicate session submission: ${input.submissionId}`);
      if (await this.main(root).get(root.tree, `submission-run:${input.runId}`) !== undefined) throw new Error(`Duplicate session submission run: ${input.runId}`);
      const claimId = root.occupied === null && root.queuedCount === 0 ? input.claimId : undefined;
      if (claimId === undefined && root.queuedCount >= maximum) throw new Error(`Session input queue limit of ${String(maximum)} was reached.`);
      const candidate = createSessionAdmission([], input);
      if (claimId !== undefined) return candidate;
      const {claimId: ignored, ...queued} = candidate;
      void ignored;
      return Object.freeze(queued);
    });
  }
  async acceptedInput(session: SessionDescriptor, runId: string) {
    return this.query(session, async root => {
      const value = await this.main(root).get(root.tree, `submission-run:${runId}`);
      if (value === undefined) return {};
      const target = z.strictObject({submissionId: id}).parse(value);
      const submission = submissionSchema.parse(await this.main(root).get(root.tree, `submission:${target.submissionId}`));
      const record = await this.readRecord(submission.input, root);
      if (record.type !== 'submission.admitted' && record.type !== 'submission.revised') throw new Error('Invalid submission input projection.');
      return {originalInput: record.input};
    });
  }
  async pending(session: SessionDescriptor) {
    return this.query(session, async root => Object.freeze((await this.submissionMetadata(root))
      .filter(item => item.state === 'queued' || item.state === 'claimed' || item.state === 'suspended')
      .map(item => Object.freeze({runId: item.runId, submissionId: item.submissionId, state: item.state as SessionPendingSubmission['state']}))));
  }
  async submissionRecords(session: SessionDescriptor, submissionId?: string): Promise<readonly SessionSubmissionRecord[]> {
    return this.query(session, async root => {
      const items = submissionId === undefined ? await this.submissionMetadata(root) :
        await this.main(root).get(root.tree, `submission:${submissionId}`).then(value => value === undefined ? [] : [submissionSchema.parse(value)]);
      const records: SessionSubmissionRecord[] = [];
      for (const item of items) {
        const admitted = await this.readRecord(item.admission, root);
        if (admitted.type !== 'submission.admitted') throw new Error('Invalid admission projection.');
        const input = item.input.offset === item.admission.offset ? admitted : await this.readRecord(item.input, root);
        if (input.type !== 'submission.admitted' && input.type !== 'submission.revised') throw new Error('Invalid submission input projection.');
        // A compact fold is reconstructed from the original admission, latest input and current claim.
        records.push({...admitted, input: input.input, ...(item.claimId === undefined ? {} : {claimId: item.claimId})});
        if (item.state !== 'queued' && item.state !== 'claimed') {
          const latest = await this.readRecord(item.latest, root);
          if (!('submissionId' in latest)) throw new Error('Invalid submission state projection.');
          records.push(latest);
        }
      }
      return records;
    });
  }
  private async submissionMetadata(root: Root): Promise<Submission[]> {
    const items: Submission[] = [];
    if (root.occupied) items.push(submissionSchema.parse(await this.main(root).get(root.tree, `submission:${root.occupied}`)));
    let cursor = root.queueFirst;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error('Projection queue cycle.');
      seen.add(cursor);
      const item = submissionSchema.parse(await this.main(root).get(root.tree, `submission:${cursor}`));
      if (item.state !== 'queued') throw new Error('Projection queue contains a nonqueued submission.');
      items.push(item); cursor = item.next;
    }
    if (seen.size !== root.queuedCount) throw new Error('Projection queue count mismatch.');
    return items;
  }
  private async query<T>(session: SessionDescriptor, operation: (root: Root) => Promise<T>): Promise<T> {
    if (session.id !== this.sessionId) throw new Error('Session descriptor identity mismatch.');
    return this.lock(async () => {
      let root = await this.refreshLocked(session.header.binding);
      try {return await operation(root);} catch (error) {
        if (!(error instanceof SessionIndexNodeError) && !(error instanceof z.ZodError)) throw error;
        await this.rebuildLocked(session.header.binding);
        root = await this.refreshLocked(session.header.binding);
        return operation(root);
      }
    });
  }
  private async locate(root: Root, key: string): Promise<Locator> {
    const value = await this.main(root).get(root.tree, key);
    if (value === undefined) throw new Error(`Unknown session history key: ${key}`);
    const position = this.positionValue(value);
    return {offset: position.offset, bytes: position.bytes, line: position.line, hash: position.hash};
  }
  private positionValue(value: unknown): Position {
    const parsed = positionSchema.parse(value);
    // The source metadata decoder is shared by rebuild and source-body verification.
    const context = parsed.context;
    return {
      depth: parsed.depth, ancestors: Object.freeze(parsed.ancestors), branchId: parsed.branchId,
      lookupRoot: parsed.lookupRoot, inheritedHeadsRoot: parsed.inheritedHeadsRoot, activeRunsRoot: parsed.activeRunsRoot, finalizedRunsRoot: parsed.finalizedRunsRoot, unconfirmedRunsRoot: parsed.unconfirmedRunsRoot, confirmedRunsRoot: parsed.confirmedRunsRoot,
      offset: parsed.offset, bytes: parsed.bytes, line: parsed.line, hash: parsed.hash,
      parentId: parsed.parentId, identity: parsed.identity, type: parsed.type, timestamp: parsed.timestamp,
      sessionStateId: parsed.sessionStateId, modelSourceId: parsed.modelSourceId, contextId: parsed.contextId,
      ...(parsed.runId === undefined ? {} : {runId: parsed.runId}),
      ...(parsed.toolName === undefined ? {} : {toolName: parsed.toolName}),
      ...(parsed.source === undefined ? {} : {source: parsed.source}),
      ...(parsed.fromEntryId === undefined ? {} : {fromEntryId: parsed.fromEntryId}),
      ...(parsed.historyPosition === undefined ? {} : {historyPosition: parsed.historyPosition}),
      context: {type: context.type, description: context.description,
        ...(context.runId === undefined ? {} : {runId: context.runId}),
        ...(context.exchangeId === undefined ? {} : {exchangeId: context.exchangeId}),
        ...(context.callIndex === undefined ? {} : {callIndex: context.callIndex}),
        ...(context.toolBatchId === undefined ? {} : {toolBatchId: context.toolBatchId}),
        ...(context.expectedCalls === undefined ? {} : {expectedCalls: context.expectedCalls}),
        ...(context.prefixBound === undefined ? {} : {prefixBound: context.prefixBound}),
        ...(context.contextRecovery === undefined ? {} : {contextRecovery: context.contextRecovery})}
    };
  }
  /** One repository source transaction owns one index lock and one SQLite connection. */
  scope<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {return this.lock(operation, signal);}
  private lock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.store.inScope) return operation();
    return withPersistenceFileLock(`${this.filePath}.index`, 5_000, () => this.store.scope(async () => {await this.store.prepare(); return operation();}), signal ? {signal} : {});
  }
  private async refresh(expectedBinding?: SessionBindingInput, signal?: AbortSignal, onProgress?: HistoryIndexRebuildOptions['onProgress']): Promise<Root> {
    return this.lock(() => this.refreshLocked(expectedBinding, signal, onProgress), signal);
  }
  private async refreshLocked(expectedBinding?: SessionBindingInput, signal?: AbortSignal, onProgress?: HistoryIndexRebuildOptions['onProgress']): Promise<Root> {
      signal?.throwIfAborted();
      try {
        const stamp = await jsonlStorageStamp(`${this.filePath}.index`);
        if (!this.root || !this.rootStamp || !sameJsonlStorageStamp(stamp, this.rootStamp)) {
          const file = this.store.root();
          this.metadataBytesRead += file.bytes; this.metadataRecordsRead++;
          const envelope = z.strictObject({metadata: z.unknown(), sha256: hash}).parse(file.value);
          if (hashJson(envelope.metadata) !== envelope.sha256) throw new Error('Projection root checksum mismatch.');
          const data = rootSchema.parse(envelope.metadata);
          if (!sameJsonlStorageStamp(await jsonlStorageStamp(this.filePath), data.stamp)) throw new Error('Original source changed.');
          const header = this.decodeHeader({text: JSON.stringify(data.header), line: 1, byteOffset: 0, terminated: true});
          if ((data.indexedRecords === 0) !== (data.leafId === null) || data.sourceRevision < data.indexedRecords ||
              (data.tree === null && data.sourceRevision > 0) || data.headerBytes < 1 || data.lineCount < 1 ||
              data.completeBytes !== await jsonlCommittedBytes(this.filePath, data.stamp.size) ||
              data.marker !== await jsonlBoundaryMarker(this.filePath, data.completeBytes))
            throw new Error('Projection does not match the original committed boundary.');
          let original: SessionHeader;
          try {original = await this.originalHeader(signal, data.headerBytes);} catch (cause) {
            if (signal?.aborted) throw signal.reason;
            await this.originalHeader(signal);
            throw new Error('Projection header locator is invalid.', {cause});
          }
          if (hashJson(header) !== hashJson(original)) throw new Error('Projection header differs from original.');
          if (data.summary.id !== header.id || data.summary.bindingSha256 !== header.binding.bindingSha256 || data.completeBytes > data.stamp.size)
            throw new Error('Projection boundary is invalid.');
          this.root = {...data, header}; this.rootStamp = stamp;
        }
        if (!sameJsonlStorageStamp(await jsonlStorageStamp(this.filePath), this.root.stamp)) throw new Error('Source changed.');
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof SessionHistorySourceError) throw error;
        const sqliteCode = (error as {errcode?: number}).errcode;
        const code = (error as NodeJS.ErrnoException).code;
        if ((sqliteCode !== undefined && (sqliteCode & 255) !== 11 && (sqliteCode & 255) !== 26) ||
            (code !== undefined && sqliteCode === undefined && code !== 'ENOENT')) throw error;
        await this.rebuildLocked(expectedBinding, {...(signal ? {signal} : {}), ...(onProgress ? {onProgress} : {})});
      }
      const root = this.root;
      if (!root) throw new Error('Projection has no committed root.');
      if (expectedBinding) assertSessionBinding(expectedBinding, root.header.binding);
      return root;
  }
  private async originalHeader(signal?: AbortSignal, length?: number): Promise<SessionHeader> {
    try {
      if (length !== undefined) {
        signal?.throwIfAborted();
        const bytes = await readJsonlBytes(this.filePath, 0, length);
        this.headerBytesRead += bytes.length;
        if (bytes.length !== length || bytes.at(-1) !== 10) throw new Error('Original header boundary changed.');
        return this.decodeHeader({text: Buffer.from(bytes.subarray(0,-1)).toString('utf8'), line: 1, byteOffset: 0, terminated: true});
      }
      for await (const line of readJsonlLines(this.filePath, {maxLineBytes: 64 * 1024 * 1024})) {
        signal?.throwIfAborted();
        this.headerBytesRead += Buffer.byteLength(line.text) + 1;
        return this.decodeHeader(line);
      }
      throw new Error('No committed session header.');
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      throw new SessionHistorySourceError(this.sessionId, 'Original header validation failed.', {cause});
    }
  }
  private async rebuildLocked(expectedBinding?: SessionBindingInput, options: HistoryIndexRebuildOptions = {}): Promise<void> {
    this.tree.clearReadCache();
    try {await this.rebuildProjection(expectedBinding, options);} finally {this.tree.clearReadCache();}
  }
  private async rebuildProjection(expectedBinding?: SessionBindingInput, options: HistoryIndexRebuildOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const header = await this.originalHeader(options.signal);
    if (expectedBinding) {try {assertSessionBinding(expectedBinding, header.binding);} catch (cause) {throw new SessionHistorySourceError(this.sessionId, 'Original header binding validation failed.', {cause});}}
    await this.store.repairStorage();
    const stamp = await jsonlStorageStamp(this.filePath);
    const lineage = randomUUID();
    const root: Root = {format: 'agent-core.session-projection/7', generation: randomUUID(), lineage, header, summary: {
      id: header.id, timestamp: header.timestamp, updatedAt: header.timestamp,
      ...(header.provider ? {provider: header.provider} : {}), ...(header.model ? {model: header.model} : {}),
      bindingSchemaId: header.binding.schemaId, bindingSchemaVersion: header.binding.schemaVersion, bindingSha256: header.binding.bindingSha256
    }, tree: null, confirmedRunsRoot: null, queueFirst: null, queueLast: null, occupied: null, queuedCount: 0, capacity: null, leafId: null, sourceRevision: 0, indexedRecords: 0, headerBytes: 0, completeBytes: 0, lineCount: 0, marker: '', stamp};
    await this.store.commit(async () => {
      await this.scan(root, stamp, options);
      this.store.retireNamespaces(`main-${lineage}`);
    }, options.signal);
    try {await this.store.completeRepair(options.signal);} catch (cause) {
      this.root = undefined; this.rootStamp = undefined;
      try {
        const actual = this.store.root();
        if (actual.value.sha256 === hashJson(parseJsonObject(root))) throw new SessionHistoryIndexPublicationError(this.sessionId, cause);
      } catch (error) {if (error instanceof SessionHistoryIndexPublicationError) throw error;}
      throw cause;
    }
    await this.verifyPublication(root);
  }

  private async scan(root: Root, stamp: JsonlStorageStamp, options: HistoryIndexRebuildOptions = {}): Promise<void> {
    const endOffset = await jsonlCommittedBytes(this.filePath, stamp.size);
    for await (const line of readJsonlLines(this.filePath, {startOffset: root.completeBytes, firstLine: root.lineCount + 1, endOffset, maxLineBytes: 64 * 1024 * 1024})) {
      options.signal?.throwIfAborted();
      this.scannedBytes += Buffer.byteLength(line.text) + 1;
      root.lineCount = line.line;
      if (line.line === 1) {
        root.headerBytes = Buffer.byteLength(line.text) + 1;
        if (hashJson(this.decodeHeader(line)) !== hashJson(root.header)) throw new SessionHistorySourceError(this.sessionId, 'Original header changed during validation.');
      }
      if (line.line > 1 && line.text.trim().length > 0) {
        try {
          const record = this.decodeRecord(line);
          const main = this.main(root);
          const previous = root.tree;
          main.begin(); this.tree.begin();
          try {
            await this.consume(root, record, {offset: line.byteOffset, bytes: Buffer.byteLength(line.text) + 1, line: line.line, hash: hashJson(record)});
            const retired = await main.retired(previous, root.tree);
            await main.flush(); await this.tree.flush();
            await main.removeNodes(retired);
          } finally {main.discard(); this.tree.discard();}
        } catch (cause) {
          if (options.signal?.aborted) throw options.signal.reason;
          throw new SessionHistorySourceError(this.sessionId, `Invalid source record at line ${String(line.line)}.`, {cause});
        }
      }
      options.onProgress?.({records: root.sourceRevision, bytes: line.byteOffset + Buffer.byteLength(line.text) + 1, totalBytes: endOffset});
    }
    options.signal?.throwIfAborted();
    if (!sameJsonlStorageStamp(stamp, await jsonlStorageStamp(this.filePath))) throw new SessionHistorySourceError(this.sessionId, 'Original history changed during projection validation.');
    root.completeBytes = endOffset; root.stamp = stamp;
    root.marker = await jsonlBoundaryMarker(this.filePath, endOffset);
    this.publish(root);
  }
  private publish(root: Root): void {
    root.generation = randomUUID();
    const metadata = parseJsonObject(root);
    this.store.publish({metadata, sha256: hashJson(metadata)});
  }
  private async verifyPublication(root: Root): Promise<void> {
    try {
      const actual = this.store.root(), sha256 = hashJson(parseJsonObject(root));
      if (actual.value.sha256 !== sha256 || hashJson(actual.value.metadata) !== sha256) throw new Error('Published projection generation changed.');
      this.root = root; this.rootStamp = await jsonlStorageStamp(`${this.filePath}.index`);
    } catch (cause) {this.root = undefined; this.rootStamp = undefined; throw new SessionHistoryIndexPublicationError(this.sessionId, cause);}
  }
  private async consume(root: Root, record: Record, locator: Locator): Promise<void> {
    const changes = new Map<string, import('@agent-core/json').JsonObject>();
    const set = (key: string, value: unknown) => {changes.set(key, parseJsonObject(value));};
    const flush = async () => {if (changes.size > 0) root.tree = await this.main(root).setMany(root.tree, [...changes]);};
    root.sourceRevision++;
    root.summary = {...root.summary, updatedAt: record.timestamp > root.summary.updatedAt ? record.timestamp : root.summary.updatedAt,
      ...(root.summary.preview === undefined && record.type === 'input' ? {preview: record.task.replace(/\s+/gu, ' ').slice(0,160)} : {})};
    if ('submissionId' in record) {
      const raw = await this.main(root).get(root.tree, `submission:${record.submissionId}`);
      let current: Submission;
      if (record.type === 'submission.admitted') {
        if (await this.main(root).get(root.tree, 'initial-model') === undefined) {
          const config = record.configuration;
          set('initial-model', parseModelSelection({provider: config.provider, model: config.model, ...(config.temperature === undefined ? {} : {temperature: config.temperature}), ...(config.reasoning === undefined ? {} : {reasoning: config.reasoning})}));
        }
        if (raw !== undefined || await this.main(root).get(root.tree, `submission-run:${record.runId}`) !== undefined) throw new Error('Duplicate submission identity.');
        current = {submissionId: record.submissionId, runId: record.runId, state: record.claimId ? 'claimed' : 'queued',
          ...(record.claimId ? {claimId: record.claimId} : {}), previous: null, next: null, admission: locator, input: locator, latest: locator};
        set(`submission-run:${record.runId}`, {submissionId: record.submissionId});
      } else {
        current = submissionSchema.parse(raw);
        if (current.runId !== record.runId) throw new Error('Submission identity changed.');
        if (record.type === 'submission.revised' || record.type === 'submission.cancelled') {
          if (current.state !== 'queued') throw new Error('Only queued submissions can change.');
          current = {...current, latest: locator, ...(record.type === 'submission.revised' ? {input: locator} : {state: 'cancelled'})};
        } else {
          assertSubmissionOwnership({submissionId: current.submissionId, ...(current.claimId === undefined ? {} : {claimId: current.claimId})}, record);
          const state = record.type === 'submission.claimed' ? 'claimed' : record.type === 'submission.suspended' ? 'suspended' : record.type === 'submission.completed' ? 'completed' : 'failed';
          assertSubmissionTransition(current.state, state, record.submissionId);
          current = {...current, state, claimId: record.claimId, latest: locator};
        }
      }
      if (record.type === 'submission.admitted') {
        if (root.capacity !== null && root.capacity !== record.maximumQueuedInputs) throw new Error('Session queue capacity changed.');
        root.capacity = record.maximumQueuedInputs;
        if (current.state === 'claimed') {
          if (root.occupied !== null || root.queuedCount > 0) throw new Error('Session admission bypassed an occupied slot or queued input.');
          root.occupied = current.submissionId;
        } else {
          if (root.queuedCount >= record.maximumQueuedInputs) throw new Error('Session admission exceeds queue capacity.');
          current = {...current, previous: root.queueLast};
          if (root.queueLast) {
            const prior = submissionSchema.parse(await this.main(root).get(root.tree, `submission:${root.queueLast}`));
            set(`submission:${prior.submissionId}`, {...prior, next: current.submissionId});
          } else root.queueFirst = current.submissionId;
          root.queueLast = current.submissionId; root.queuedCount++;
        }
      } else {
        const prior = submissionSchema.parse(raw);
        if (prior.state === 'queued' && current.state !== 'queued') {
          if (current.state === 'claimed' && (root.occupied !== null || root.queueFirst !== current.submissionId)) throw new Error('Session claim is not the next available input.');
          if (prior.previous) {
            const previous = submissionSchema.parse(await this.main(root).get(root.tree, `submission:${prior.previous}`));
            set(`submission:${previous.submissionId}`, {...previous, next: prior.next});
          } else root.queueFirst = prior.next;
          if (prior.next) {
            const next = submissionSchema.parse(await this.main(root).get(root.tree, `submission:${prior.next}`));
            set(`submission:${next.submissionId}`, {...next, previous: prior.previous});
          } else root.queueLast = prior.previous;
          root.queuedCount--; current = {...current, previous: null, next: null};
          if (current.state === 'claimed') root.occupied = current.submissionId;
        }
        if ((prior.state === 'claimed' || prior.state === 'suspended') && (current.state === 'completed' || current.state === 'failed')) {
          if (root.occupied !== current.submissionId) throw new Error('Session occupied slot changed.');
          root.occupied = null;
        }
      }
      set(`submission:${record.submissionId}`, current);
      await flush();
      return;
    }
    if (record.type === 'run_finalization') {
      if (record.throughEntryId !== root.leafId) throw new Error('Finalization is outside the active source boundary.');
      const leaf = this.positionValue(await this.main(root).get(root.tree, `entry:${record.throughEntryId}`));
      if (await this.tree.get(leaf.lookupRoot, `input:${record.runId}`) === undefined) throw new Error('Finalized run is outside the active branch.');
      if (await this.main(root).get(root.tree, `finalization:${record.finalizationId}`) !== undefined) throw new Error('Duplicate finalization.');
      set(`finalization:${record.finalizationId}`, locator);
      set(`finalization-meta:${record.finalizationId}`, {runId: record.runId, finalizationId: record.finalizationId, throughEntryId: record.throughEntryId, terminalSha256: hashJson(record.terminal)});
      set(`finalized-entry:${record.throughEntryId}`, {entryId: record.throughEntryId});
      set(`point:finalization:${record.finalizationId}`, {offset: locator.offset, entryId: record.throughEntryId, timestamp: record.timestamp, kind: 'run_finalization', runId: record.runId, finalizationId: record.finalizationId});
      set(`entry:${record.throughEntryId}`, {...leaf,
        activeRunsRoot: await this.tree.delete(leaf.activeRunsRoot, record.runId),
        finalizedRunsRoot: await this.tree.set(leaf.finalizedRunsRoot, record.runId, {runId: record.runId, throughEntryId: record.throughEntryId, finalizationId: record.finalizationId}),
        unconfirmedRunsRoot: await this.tree.set(leaf.unconfirmedRunsRoot, record.runId, {runId: record.runId, finalized: true})
      });
      await flush(); return;
    }
    if (record.type === 'run_finalization_confirmed') {
      const finalization = z.strictObject({runId: id, finalizationId: id, throughEntryId: id, terminalSha256: hash}).parse(await this.main(root).get(root.tree, `finalization-meta:${record.finalizationId}`));
      if (record.runId !== finalization.runId || record.source.runId !== record.runId || record.terminalSha256 !== finalization.terminalSha256) throw new Error('Terminal confirmation does not match its recorded finalization.');
      if (await this.main(root).get(root.tree, `confirmation-run:${record.runId}`) !== undefined || await this.main(root).get(root.tree, `confirmation:${record.finalizationId}`) !== undefined) throw new Error('Duplicate terminal confirmation.');
      set(`confirmation-run:${record.runId}`, locator); set(`confirmation:${record.finalizationId}`, locator);
      const head = {runId: record.runId, sequence: record.source.sequence, hash: record.source.hash};
      root.confirmedRunsRoot = await this.tree.set(root.confirmedRunsRoot, record.runId, head);
      const targets = new Set([finalization.throughEntryId, ...(root.leafId === null ? [] : [root.leafId])]);
      for (const target of targets) {
        const position = this.positionValue(await this.main(root).get(root.tree, `entry:${target}`));
        if (await this.tree.get(position.finalizedRunsRoot, record.runId) === undefined) continue;
        set(`entry:${target}`, {...position,
          unconfirmedRunsRoot: await this.tree.delete(position.unconfirmedRunsRoot, record.runId),
          confirmedRunsRoot: await this.tree.set(position.confirmedRunsRoot, record.runId, head)});
      }
      await flush(); return;
    }
    if (await this.main(root).get(root.tree, `entry:${record.id}`) !== undefined) throw new Error('Duplicate history entry.');
    const parent = record.parentId === null ? undefined : this.positionValue(await this.main(root).get(root.tree, `entry:${record.parentId}`));
    const ancestors = record.parentId === null ? [] : [record.parentId];
    for (let level = 0; ; level++) {
      const ancestorId = ancestors[level];
      if (ancestorId === undefined) break;
      const ancestor = this.positionValue(await this.main(root).get(root.tree, `entry:${ancestorId}`)).ancestors[level];
      if (ancestor === undefined) break;
      ancestors.push(ancestor);
    }
    const metadata = branchEntryMetadata(record);
    const lookupChanges: [string, import('@agent-core/json').JsonObject][] = [
      [`identity:${metadata.identity}`, {entryId: record.id}],
      [`source:${record.source ? `event:${record.source.eventId}` : record.id}`, {entryId: record.id}]
    ];
    if ('runId' in record) lookupChanges.push([`run:${record.runId}`, {entryId: record.id}]);
    if (record.type === 'input') lookupChanges.push([`input:${record.runId}`, {entryId: record.id}]);
    let modelSourceId = record.type === 'model_settings' ? record.id : parent?.modelSourceId ?? null;
    if (record.type === 'context_transition') {
      if (await this.tree.get(parent?.lookupRoot ?? null, `context:${record.transition.idempotencyKey}`) !== undefined) throw new Error('Duplicate context transition idempotency key.');
      lookupChanges.push([`context:${record.transition.idempotencyKey}`, {entryId: record.id}]);
      const continuity = record.window.selection.continuity;
      if (continuity && await this.tree.get(parent?.lookupRoot ?? null, `reset:${continuity.resetId}`) === undefined) {
        modelSourceId = record.id; lookupChanges.push([`reset:${continuity.resetId}`, {entryId: record.id}]);
      }
    }
    if (metadata.context.exchangeId) {
      const key = `exchange-count:${metadata.context.exchangeId}`;
      const value = await this.tree.get(parent?.lookupRoot ?? null, key);
      const count = value === undefined ? 0 : z.strictObject({count: integer}).parse(value).count;
      lookupChanges.push([key, {count: count + 1}], [`exchange-entry:${metadata.context.exchangeId}:${String(count)}`, {entryId: record.id}]);
    }
    let inheritedHeadsRoot = parent?.inheritedHeadsRoot ?? null;
    if (record.type === 'branch' && parent?.historyPosition?.ledgerHeads?.length)
      inheritedHeadsRoot = await this.tree.setMany(inheritedHeadsRoot, parent.historyPosition.ledgerHeads.map(head => [head.runId, parseJsonObject(head)]));
    let activeRunsRoot = parent?.activeRunsRoot ?? null;
    let unconfirmedRunsRoot = parent?.unconfirmedRunsRoot ?? null;
    const finalizedRunsRoot = parent?.finalizedRunsRoot ?? null;
    if ((record.type === 'input' || record.type === 'steering') && await this.tree.get(finalizedRunsRoot, record.runId) === undefined) {
      const prior = await this.tree.get(activeRunsRoot, record.runId);
      const entriesRoot = prior === undefined ? null : z.strictObject({entriesRoot: hash.nullable()}).parse(prior).entriesRoot;
      const updated = await this.tree.set(entriesRoot, record.id, {entryId: record.id, depth: (parent?.depth ?? -1) + 1});
      activeRunsRoot = await this.tree.set(activeRunsRoot, record.runId, {entriesRoot: updated});
      unconfirmedRunsRoot = await this.tree.set(unconfirmedRunsRoot, record.runId, {runId: record.runId, finalized: false});
    }
    const sessionState = sessionStateAtEntry(record);
    if (sessionState) set(`session-state:${sessionState.id}`, sessionState);
    const position: Position = {...metadata, ...locator, parentId: record.parentId,
      depth: (parent?.depth ?? -1) + 1, ancestors, branchId: record.type === 'branch' ? record.id : parent?.branchId ?? this.sessionId,
      lookupRoot: await this.tree.setMany(parent?.lookupRoot ?? null, lookupChanges), inheritedHeadsRoot, activeRunsRoot, unconfirmedRunsRoot, finalizedRunsRoot,
      confirmedRunsRoot: parent?.confirmedRunsRoot ?? null,
      sessionStateId: sessionState?.id ?? parent?.sessionStateId ?? null, modelSourceId,
      contextId: record.type === 'context_transition' ? record.id : parent?.contextId ?? null};
    set(`entry:${record.id}`, position);
    const key = sessionRetryKey(record);
    if (key !== undefined) {
      if (record.type !== 'context_transition' && await this.main(root).get(root.tree, key) !== undefined) throw new Error('Duplicate session retry identity.');
      set(key, locator);
    }
    if (record.type === 'context_transition') set(`point:context:${record.id}`, {offset: locator.offset, entryId: record.id, timestamp: record.timestamp, kind: 'context_transition'});
    root.indexedRecords++; root.leafId = record.id;
    await flush();
  }
  private async branchRecord(locator: Locator, entryId: string, root: Root): Promise<SessionBranchEntry> {
    const entry = await this.readRecord(locator, root);
    if ('submissionId' in entry || (entry.type === 'run_finalization' || entry.type === 'run_finalization_confirmed') || entry.id !== entryId) throw new Error('Projection entry identity changed.');
    return entry;
  }
  private async readRecord(locator: Locator, root: Root): Promise<Record> {
    if (locator.offset < root.headerBytes || locator.offset + locator.bytes > root.completeBytes || locator.line > root.lineCount) throw new SessionIndexNodeError('Projection record range lies outside its committed source boundary.');
    const bytes = await readJsonlBytes(this.filePath, locator.offset, locator.bytes);
    this.bodyBytesRead += bytes.length; this.bodyRecordsRead++;
    try {
      if (bytes.length !== locator.bytes || bytes.at(-1) !== 10) throw new Error('Source record boundary changed.');
      const record = this.decodeRecord({text: Buffer.from(bytes.subarray(0,-1)).toString('utf8'), line: locator.line, byteOffset: locator.offset, terminated: true});
      if (hashJson(record) !== locator.hash) throw new Error('Source record hash changed.');
      return record;
    } catch (cause) {throw new SessionHistorySourceError(this.sessionId, 'Original record verification failed.', {cause});}
  }
}

function sessionRetryKey(record: SessionBranchEntry): string | undefined {
  switch (record.type) {
    case 'input': return `input:${record.runId}`;
    case 'steering': return record.deliveryId === undefined ? undefined : `steering:${hashJson([record.runId,record.deliveryId])}`;
    case 'assistant': return `assistant:${hashJson([record.runId,record.turnId,record.requestAttempt,record.source?.eventId ?? null])}`;
    case 'tool_call': return `tool_call:${hashJson([record.runId,record.toolBatchId,record.callIndex])}`;
    case 'observation': return record.toolBatchId === undefined || record.callIndex === undefined || record.toolAttempt === undefined ? undefined
      : `observation:${hashJson([record.runId,record.turnId,record.requestAttempt,record.toolBatchId,record.callIndex,record.toolAttempt])}`;
    case 'context_transition': return undefined;
    default: return undefined;
  }
}
