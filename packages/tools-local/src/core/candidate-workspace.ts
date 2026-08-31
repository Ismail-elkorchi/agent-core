import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentCandidateWorkspace,
  AgentCandidateWorkspaceCheckpoint,
  AgentCandidateWorkspaceDescriptor,
  AgentCandidateWorkspaceDiff,
  AgentCandidateWorkspaceDiffEntry,
  AgentCandidateWorkspacePromotionResult,
  AgentPreparedCandidateWorkspacePromotion
} from '@agent-core/runtime';
import { RootedFileAuthority, rootedFileIdentitiesEqual, type RootedFileIdentity } from './rooted-file-authority.js';
import {
  TextPatchJournal,
  type PreparedTextPatchRemove,
  type PreparedTextPatchTransaction,
  type PreparedTextPatchWrite,
  type TextTransactionReceipt,
  type TextTransactionResult
} from './text-write.js';
import {
  captureWorkspaceSnapshot,
  changedWorkspacePaths,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEntry
} from './workspace-snapshot.js';

const IMPLEMENTATION_ID = 'agent-core.local-candidate-workspace@1';
const PROMOTION_RECONCILER_ID = 'agent-core.local-candidate-workspace-promotion@1';

interface CandidateManifest {
  readonly version: 1;
  readonly runId: string;
  readonly sourceId: string;
  readonly baselineDigest: string;
}

/** Persistent private candidate copy with exact checkpoints and journaled text promotion. */
export class LocalCandidateWorkspace implements AgentCandidateWorkspace {
  readonly descriptor: AgentCandidateWorkspaceDescriptor;
  readonly baseline: AgentCandidateWorkspaceCheckpoint;
  readonly root: RootedFileAuthority;
  readonly #source: RootedFileAuthority;
  readonly #baselineSnapshot: WorkspaceSnapshot;
  readonly #directory: string;
  readonly #promotionJournal: TextPatchJournal;
  readonly #candidateJournal: TextPatchJournal;
  #released = false;

  private constructor(input: {
    source: RootedFileAuthority;
    baseline: WorkspaceSnapshot;
    directory: string;
    root: RootedFileAuthority;
    promotionJournal: TextPatchJournal;
    candidateJournal: TextPatchJournal;
    descriptor: AgentCandidateWorkspaceDescriptor;
    baselineCheckpointId: string;
  }) {
    this.#source = input.source;
    this.#baselineSnapshot = input.baseline;
    this.#directory = input.directory;
    this.root = input.root;
    this.#promotionJournal = input.promotionJournal;
    this.#candidateJournal = input.candidateJournal;
    this.descriptor = input.descriptor;
    this.baseline = checkpoint(input.baselineCheckpointId, input.baseline);
  }

  static async open(input: {
    readonly source: RootedFileAuthority;
    readonly baseline: WorkspaceSnapshot;
    readonly runtimeDirectory: string;
    readonly runId: string;
  }): Promise<LocalCandidateWorkspace> {
    if (input.baseline.coverage !== 'complete') throw new Error('A candidate workspace requires a complete source snapshot.');
    const directory = path.join(input.runtimeDirectory, 'candidate-workspaces', identity(input.runId));
    const workspaceDirectory = path.join(directory, 'workspace');
    const manifestPath = path.join(directory, 'manifest.json');
    const sourceId = sourceIdentity(input.source);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = await readManifest(manifestPath);
    const initializing = existing === undefined;
    if (existing === undefined) {
      await materializeWorkspaceSnapshot(input.source, input.baseline, workspaceDirectory);
      const initializedRoot = RootedFileAuthority.adopt(workspaceDirectory);
      try {
        const initialized = await captureWorkspaceSnapshot(initializedRoot);
        if (initialized.coverage !== 'complete' || initialized.digest !== input.baseline.digest) {
          throw new Error(`Candidate workspace ${input.runId} did not reproduce its exact admitted baseline.`);
        }
      } finally { initializedRoot.close(); }
    } else if (existing.runId !== input.runId || existing.sourceId !== sourceId || existing.baselineDigest !== input.baseline.digest) {
      throw new Error(`Candidate workspace identity conflicts with run ${input.runId}.`);
    }
    const promotionJournalDirectory = path.join(directory, 'promotion-transactions');
    const candidateJournalDirectory = path.join(directory, 'candidate-transactions');
    await Promise.all([
      mkdir(promotionJournalDirectory, { recursive: true, mode: 0o700 }),
      mkdir(candidateJournalDirectory, { recursive: true, mode: 0o700 })
    ]);
    const promotionJournal = TextPatchJournal.adopt(promotionJournalDirectory);
    const candidateJournal = TextPatchJournal.adopt(candidateJournalDirectory);
    const root = RootedFileAuthority.adopt(workspaceDirectory);
    try {
      const actual = await captureWorkspaceSnapshot(root);
      if (actual.coverage !== 'complete') throw new Error(`Candidate workspace ${input.runId} cannot be observed completely: ${actual.causes.join(', ')}.`);
      const descriptor = Object.freeze({ implementationId: IMPLEMENTATION_ID, workspaceId: identity(`${input.runId}:${input.baseline.digest}`), runId: input.runId, sourceId });
      const baselineCheckpointId = identity(`${descriptor.workspaceId}:baseline:${input.baseline.digest}`);
      const baselineWorkspace = path.join(directory, 'checkpoints', baselineCheckpointId, 'workspace');
      const baselineSnapshot = path.join(directory, 'checkpoints', baselineCheckpointId, 'snapshot.json');
      if (initializing) {
        await materializeWorkspaceSnapshot(root, input.baseline, baselineWorkspace);
        await writeJsonIfAbsent(baselineSnapshot, input.baseline);
        await writeExclusiveJson(manifestPath, { version: 1, runId: input.runId, sourceId, baselineDigest: input.baseline.digest });
      } else {
        if (!await directoryExists(baselineWorkspace)) throw new Error(`Candidate workspace ${input.runId} has no durable baseline checkpoint.`);
        const storedBaseline = decodeSnapshot(JSON.parse(await readFile(baselineSnapshot, 'utf8')));
        if (storedBaseline.coverage !== 'complete' || storedBaseline.digest !== input.baseline.digest) {
          throw new Error(`Candidate workspace ${input.runId} has a conflicting baseline checkpoint.`);
        }
      }
      return new LocalCandidateWorkspace({
        source: input.source,
        baseline: input.baseline,
        directory,
        root,
        promotionJournal,
        candidateJournal,
        descriptor,
        baselineCheckpointId
      });
    } catch (error) {
      root.close();
      promotionJournal.close();
      candidateJournal.close();
      throw error;
    }
  }

  async checkpoint(label: string, signal?: AbortSignal): Promise<AgentCandidateWorkspaceCheckpoint> {
    this.#assertOpen();
    const normalizedLabel = requiredLabel(label);
    const snapshot = await captureWorkspaceSnapshot(this.root, signal);
    const checkpointId = identity(`${this.descriptor.workspaceId}:${normalizedLabel}:${snapshot.digest}`);
    if (snapshot.coverage === 'complete') {
      const destination = path.join(this.#directory, 'checkpoints', checkpointId, 'workspace');
      if (!await directoryExists(destination)) await materializeWorkspaceSnapshot(this.root, snapshot, destination);
      await writeJsonIfAbsent(path.join(this.#directory, 'checkpoints', checkpointId, 'snapshot.json'), snapshot);
    }
    return checkpoint(checkpointId, snapshot);
  }

  async diff(signal?: AbortSignal): Promise<AgentCandidateWorkspaceDiff> {
    this.#assertOpen();
    return workspaceDiff(this.#baselineSnapshot, await captureWorkspaceSnapshot(this.root, signal));
  }

  async rollback(checkpointId: string, signal?: AbortSignal): Promise<AgentCandidateWorkspaceCheckpoint> {
    this.#assertOpen();
    const safeId = safeIdentity(checkpointId, 'checkpoint');
    const snapshotPath = path.join(this.#directory, 'checkpoints', safeId, 'snapshot.json');
    const workspacePath = path.join(this.#directory, 'checkpoints', safeId, 'workspace');
    const target = decodeSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8')));
    const source = RootedFileAuthority.adopt(workspacePath);
    try {
      const current = await captureWorkspaceSnapshot(this.root, signal);
      const unsupported = unsupportedPromotionChanges(current, target);
      if (unsupported.length > 0) throw new Error(`Checkpoint rollback cannot safely represent: ${unsupported.join(', ')}.`);
      const transaction = await prepareTextTransaction(source, this.root, current, target);
      const transactionId = `rollback-${identity(`${safeId}:${current.digest}:${target.digest}`)}`;
      const result = await this.#candidateJournal.withAuthority(this.root, (authority) => authority.commit(transaction, {
        ...(signal === undefined ? {} : { signal }),
        transactionId,
        recoveryPayload: { contract: 'agent-core.candidate-workspace-rollback@1', workspaceId: this.descriptor.workspaceId, checkpointId: safeId }
      }), signal);
      if (!committed(result)) throw new Error(`Checkpoint rollback failed: ${transactionFailure(result)}.`);
      const restored = await captureWorkspaceSnapshot(this.root, signal);
      if (restored.digest !== target.digest || restored.coverage !== 'complete') throw new Error('Checkpoint rollback did not reproduce the exact checkpoint.');
      return checkpoint(safeId, restored);
    } finally { source.close(); }
  }

  async preparePromotion(signal?: AbortSignal): Promise<AgentPreparedCandidateWorkspacePromotion | AgentCandidateWorkspacePromotionResult> {
    this.#assertOpen();
    const candidate = await captureWorkspaceSnapshot(this.root, signal);
    const diff = workspaceDiff(this.#baselineSnapshot, candidate);
    if (diff.coverage !== 'complete') return notPromoted(`Candidate diff is incomplete: ${diff.causes.join(', ')}.`);
    const unsupported = unsupportedPromotionChanges(this.#baselineSnapshot, candidate);
    if (unsupported.length > 0) return notPromoted(`Candidate publication cannot safely represent: ${unsupported.join(', ')}.`);
    const transactionId = `promote-${identity(`${this.descriptor.workspaceId}:${this.#baselineSnapshot.digest}:${candidate.digest}`)}`;
    const prior = await this.#promotionJournal.withAuthority(this.#source, (authority) => authority.receipt(transactionId), signal);
    let transaction: PreparedTextPatchTransaction | undefined;
    let preparationFailure: string | undefined;
    if (prior === undefined) {
      const currentSource = await captureWorkspaceSnapshot(this.#source, signal);
      if (currentSource.coverage !== 'complete' || currentSource.digest !== this.#baselineSnapshot.digest) {
        preparationFailure = 'The source workspace changed after candidate isolation; publication was not started.';
      } else {
        transaction = await prepareTextTransaction(this.root, this.#source, this.#baselineSnapshot, candidate);
      }
    }
    const authorization = Object.freeze({
      contract: 'agent-core.candidate-workspace-promotion@1',
      workspaceId: this.descriptor.workspaceId,
      sourceId: this.descriptor.sourceId,
      runId: this.descriptor.runId,
      baselineDigest: this.#baselineSnapshot.digest,
      candidateDigest: candidate.digest,
      changedPaths: Object.freeze(diff.entries.map((entry) => entry.path)),
      transactionId
    });
    const receiptResult = (receipt: TextTransactionReceipt | undefined) => receipt === undefined
      ? undefined
      : promotionResult(receipt.result, this.#baselineSnapshot, candidate, diff, transactionId);
    const existingResult = receiptResult(prior);
    return Object.freeze({
      authorization,
      recovery: Object.freeze({ kind: 'buffered_mutation' as const, authority: this.#promotionJournal.recoveryIdentity, reconcilerId: PROMOTION_RECONCILER_ID, transactionId }),
      start: async (startSignal: AbortSignal) => {
        if (existingResult) return existingResult;
        if (!transaction) return notPromoted(preparationFailure ?? 'Candidate publication has no prepared transaction.');
        const preparedTransaction = transaction;
        const result = await this.#promotionJournal.withAuthority(this.#source, (authority) => authority.commit(preparedTransaction, {
          signal: startSignal,
          transactionId,
          recoveryPayload: authorization
        }), startSignal);
        const promotion = promotionResult(result, this.#baselineSnapshot, candidate, diff, transactionId);
        if (promotion.status === 'promoted') {
          const published = await captureWorkspaceSnapshot(this.#source, startSignal);
          if (published.coverage !== 'complete' || published.digest !== candidate.digest) return notPromoted('Publication committed but the source workspace no longer matches the exact candidate.');
        }
        return promotion;
      },
      reconcile: async (reconcileSignal: AbortSignal) => {
        const receipt = await this.#promotionJournal.withAuthority(this.#source, (authority) => authority.receipt(transactionId), reconcileSignal);
        const result = receiptResult(receipt);
        if (result === undefined) return Object.freeze({ status: 'unknown' as const });
        if (result.status === 'promoted') {
          const published = await captureWorkspaceSnapshot(this.#source, reconcileSignal);
          if (published.coverage !== 'complete' || published.digest !== candidate.digest) {
            return Object.freeze({ status: 'settled' as const, result: notPromoted('Publication has a durable commit receipt, but the source workspace no longer matches the exact candidate.') });
          }
        }
        return Object.freeze({ status: 'settled' as const, result });
      },
      release: () => Promise.resolve()
    });
  }

  release(): Promise<void> {
    if (this.#released) return Promise.resolve();
    this.#released = true;
    this.root.close();
    this.#promotionJournal.close();
    this.#candidateJournal.close();
    return Promise.resolve();
  }

  #assertOpen(): void { if (this.#released) throw new Error('Candidate workspace has been released.'); }
}

export async function deleteCandidateWorkspace(runtimeDirectory: string, runId: string): Promise<void> {
  await rm(path.join(runtimeDirectory, 'candidate-workspaces', identity(runId)), { recursive: true, force: true });
}

function workspaceDiff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): AgentCandidateWorkspaceDiff {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const entries = changedWorkspacePaths(before, after).map((entryPath): AgentCandidateWorkspaceDiffEntry => {
    const initial = beforeByPath.get(entryPath);
    const final = afterByPath.get(entryPath);
    return Object.freeze({
      path: entryPath,
      kind: initial === undefined ? 'added' : final === undefined ? 'deleted' : initial.kind === final.kind ? 'modified' : 'replaced',
      content: diffContent(initial, final),
      ...(initial?.sha256 ? { beforeSha256: initial.sha256 } : {}),
      ...(final?.sha256 ? { afterSha256: final.sha256 } : {})
    });
  });
  const causes = [...before.causes.map((cause) => `baseline:${cause}`), ...after.causes.map((cause) => `candidate:${cause}`)];
  return Object.freeze({
    baselineDigest: before.digest,
    candidateDigest: after.digest,
    coverage: before.coverage === 'complete' && after.coverage === 'complete' ? 'complete' : 'partial',
    causes: Object.freeze(causes),
    entries: Object.freeze(entries)
  });
}

function unsupportedPromotionChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): readonly string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changed = changedWorkspacePaths(before, after);
  const unsupported: string[] = [];
  for (const changedPath of changed) {
    const initial = beforeByPath.get(changedPath);
    const final = afterByPath.get(changedPath);
    if (initial?.kind === 'file' && initial.content !== 'text') { unsupported.push(`${changedPath} (binary or unbounded source file)`); continue; }
    if (final?.kind === 'file' && final.content !== 'text') { unsupported.push(`${changedPath} (binary or unbounded candidate file)`); continue; }
    if (initial?.kind === 'directory' && final === undefined) { unsupported.push(`${changedPath} (directory removal)`); continue; }
    if (initial === undefined && final?.kind === 'directory') {
      const hasAddedFile = changed.some((candidatePath) => candidatePath.startsWith(`${changedPath}/`) && afterByPath.get(candidatePath)?.kind === 'file');
      if (!hasAddedFile || (final.mode ?? 0) % 0o1000 !== 0o700) unsupported.push(`${changedPath} (empty or non-private directory addition)`);
      continue;
    }
    if (initial?.kind === 'directory' && final?.kind === 'directory') {
      unsupported.push(`${changedPath} (directory metadata change)`);
      continue;
    }
    if ((initial !== undefined && initial.kind !== 'file') || (final !== undefined && final.kind !== 'file')) unsupported.push(`${changedPath} (non-file replacement)`);
  }
  return Object.freeze(unsupported);
}

async function prepareTextTransaction(contentRoot: RootedFileAuthority, targetRoot: RootedFileAuthority, before: WorkspaceSnapshot, after: WorkspaceSnapshot): Promise<PreparedTextPatchTransaction> {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const writes: PreparedTextPatchWrite[] = [];
  const removes: PreparedTextPatchRemove[] = [];
  for (const changedPath of changedWorkspacePaths(before, after)) {
    const initial = beforeByPath.get(changedPath);
    const final = afterByPath.get(changedPath);
    if (final?.kind === 'directory' || initial?.kind === 'directory') continue;
    if (final?.kind === 'file') {
      if (final.content !== 'text' || final.sha256 === undefined || final.mode === undefined) throw new Error(`Candidate file is not promotable text: ${changedPath}`);
      const content = await readExactText(contentRoot, final);
      if (initial?.kind === 'file') {
        if (initial.sha256 === undefined || initial.bytes === undefined) throw new Error(`Baseline file is incomplete: ${changedPath}`);
        const expectedIdentity = await assertExactTarget(targetRoot, changedPath, initial.sha256, initial.bytes);
        writes.push(Object.freeze({ path: changedPath, content, mode: final.mode, overwrite: true, expectedCurrentSha256: initial.sha256, expectedCurrentIdentity: expectedIdentity }));
      } else {
        if ((await targetRoot.inspectPath(changedPath)).kind !== 'absent') throw new Error(`Target appeared before transaction preparation: ${changedPath}`);
        writes.push(Object.freeze({ path: changedPath, content, mode: final.mode, overwrite: false, expectedAbsent: true }));
      }
      continue;
    }
    if (initial?.kind === 'file') {
      if (initial.sha256 === undefined || initial.bytes === undefined) throw new Error(`Baseline file is incomplete: ${changedPath}`);
      const expectedIdentity = await assertExactTarget(targetRoot, changedPath, initial.sha256, initial.bytes);
      removes.push(Object.freeze({ path: changedPath, expectedCurrentSha256: initial.sha256, expectedCurrentIdentity: expectedIdentity }));
    }
  }
  const parentDirsToCreate = changedWorkspacePaths(before, after)
    .filter((changedPath) => beforeByPath.get(changedPath) === undefined && afterByPath.get(changedPath)?.kind === 'directory')
    .sort((left, right) => left.split('/').length - right.split('/').length || compareCodeUnits(left, right));
  return Object.freeze({ writes: Object.freeze(writes), removes: Object.freeze(removes), parentDirsToCreate: Object.freeze(parentDirsToCreate) });
}

async function assertExactTarget(root: RootedFileAuthority, filePath: string, expectedSha256: string, expectedBytes: number): Promise<RootedFileIdentity> {
  const file = await root.openFile(filePath);
  try {
    const identity = file.identity;
    const content = await file.readAll(expectedBytes + 1);
    if (content.byteLength !== expectedBytes || sha256(content) !== expectedSha256
      || !rootedFileIdentitiesEqual(identity, await file.identityNow())
      || !rootedFileIdentitiesEqual(identity, await root.fileIdentity(filePath))) {
      throw new Error(`Target changed before transaction preparation: ${filePath}`);
    }
    return identity;
  } finally { await file.close(); }
}

async function readExactText(root: RootedFileAuthority, entry: WorkspaceSnapshotEntry): Promise<string> {
  const file = await root.openFile(entry.path);
  try {
    const bytes = await file.readAll((entry.bytes ?? 0) + 1);
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Candidate content changed during preparation: ${entry.path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await file.close(); }
}

function promotionResult(result: TextTransactionResult, baseline: WorkspaceSnapshot, candidate: WorkspaceSnapshot, diff: AgentCandidateWorkspaceDiff, transactionId: string): AgentCandidateWorkspacePromotionResult {
  return committed(result)
    ? Object.freeze({ status: 'promoted' as const, baselineDigest: baseline.digest, candidateDigest: candidate.digest, changedPaths: Object.freeze(diff.entries.map((entry) => entry.path)), transactionId })
    : notPromoted(`Candidate publication transaction ${transactionId} did not commit: ${transactionFailure(result)}.`);
}
function committed(result: TextTransactionResult): boolean { return result.outcome === 'committed' || result.outcome === 'committed_with_residue'; }
function transactionFailure(result: TextTransactionResult): string {
  return result.outcome === 'rolled_back' || result.outcome === 'rollback_failed'
    ? `${result.outcome}: ${result.failure.message}`
    : result.outcome;
}
function notPromoted(reason: string): AgentCandidateWorkspacePromotionResult { return Object.freeze({ status: 'not_promoted' as const, reason }); }
function checkpoint(checkpointId: string, snapshot: WorkspaceSnapshot): AgentCandidateWorkspaceCheckpoint {
  return Object.freeze({ checkpointId, digest: snapshot.digest, coverage: snapshot.coverage, causes: snapshot.causes, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes });
}
function diffContent(before: WorkspaceSnapshotEntry | undefined, after: WorkspaceSnapshotEntry | undefined): AgentCandidateWorkspaceDiffEntry['content'] {
  const entry = after ?? before;
  if (entry?.kind === 'directory') return 'directory';
  if (entry?.kind !== 'file') return 'other';
  return entry.content ?? 'binary';
}

/** Publishes an exact private copy of a complete snapshot without following filesystem aliases. */
export async function materializeWorkspaceSnapshot(source: RootedFileAuthority, snapshot: WorkspaceSnapshot, destination: string): Promise<void> {
  if (snapshot.coverage !== 'complete') throw new Error('Only complete workspace snapshots can be materialized.');
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.workspace.${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const directories = snapshot.entries.filter((entry) => entry.kind === 'directory');
    for (const entry of directories) await mkdir(path.join(staging, ...entry.path.split('/')), { recursive: true, mode: 0o700 });
    for (const entry of snapshot.entries) {
      if (entry.kind === 'directory') continue;
      if (entry.kind !== 'file' || entry.sha256 === undefined || entry.bytes === undefined || entry.mode === undefined) throw new Error(`Snapshot contains an unmaterializable entry: ${entry.path}`);
      const sourceFile = await source.openFile(entry.path);
      try {
        const content = await sourceFile.readAll(entry.bytes + 1);
        if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) throw new Error(`Source changed before materialization: ${entry.path}`);
        const target = path.join(staging, ...entry.path.split('/'));
        const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(content); await handle.chmod(entry.mode & 0o7777); await handle.sync(); }
        finally { await handle.close(); }
      } finally { await sourceFile.close(); }
    }
    for (const entry of [...directories].sort((left, right) => right.path.split('/').length - left.path.split('/').length)) {
      if (entry.mode !== undefined) await chmod(path.join(staging, ...entry.path.split('/')), entry.mode & 0o7777);
    }
    await syncDirectories(staging, directories.map((entry) => entry.path));
    try { await rename(staging, destination); }
    catch (error) {
      if (nodeCode(error) !== 'EEXIST' && nodeCode(error) !== 'ENOTEMPTY') throw error;
      await rm(staging, { recursive: true, force: true });
    }
    await syncDirectory(parent);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

async function syncDirectories(root: string, directories: readonly string[]): Promise<void> {
  for (const relative of [...directories].sort((left, right) => right.split('/').length - left.split('/').length)) await syncDirectory(path.join(root, ...relative.split('/')));
  await syncDirectory(root);
}
async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function directoryExists(directory: string): Promise<boolean> {
  try { const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); try { return (await handle.stat()).isDirectory(); } finally { await handle.close(); } }
  catch (error) { if (nodeCode(error) === 'ENOENT') return false; throw error; }
}
async function readManifest(filePath: string): Promise<CandidateManifest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!record(value) || value.version !== 1 || typeof value.runId !== 'string' || typeof value.sourceId !== 'string' || !digest(value.baselineDigest)) throw new Error(`Invalid candidate workspace manifest: ${filePath}`);
    return Object.freeze({ version: 1, runId: value.runId, sourceId: value.sourceId, baselineDigest: value.baselineDigest });
  } catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
}
async function writeExclusiveJson(filePath: string, value: unknown): Promise<void> { await writeFile(filePath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
async function writeJsonIfAbsent(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { await writeExclusiveJson(filePath, value); }
  catch (error) { if (nodeCode(error) !== 'EEXIST') throw error; }
}
function decodeSnapshot(value: unknown): WorkspaceSnapshot {
  if (!record(value) || !digest(value.digest) || (value.coverage !== 'complete' && value.coverage !== 'partial') || !Array.isArray(value.causes) || !Array.isArray(value.entries) || !nonnegative(value.fileCount) || !nonnegative(value.totalBytes)) throw new Error('Candidate checkpoint snapshot is invalid.');
  const entries = value.entries.map((entry): WorkspaceSnapshotEntry => {
    if (!record(entry) || typeof entry.path !== 'string' || !snapshotKind(entry.kind)) throw new Error('Candidate checkpoint entry is invalid.');
    return Object.freeze({ path: entry.path, kind: entry.kind, ...(nonnegative(entry.mode) ? { mode: entry.mode } : {}), ...(nonnegative(entry.bytes) ? { bytes: entry.bytes } : {}), ...(digest(entry.sha256) ? { sha256: entry.sha256 } : {}), ...(entry.content === 'text' || entry.content === 'binary' ? { content: entry.content } : {}) });
  });
  if (createHash('sha256').update(JSON.stringify(entries)).digest('hex') !== value.digest) throw new Error('Candidate checkpoint digest is invalid.');
  return Object.freeze({ digest: value.digest, coverage: value.coverage, causes: Object.freeze(value.causes.map(String)), entries: Object.freeze(entries), fileCount: value.fileCount, totalBytes: value.totalBytes });
}
function sourceIdentity(root: RootedFileAuthority): string { return identity(JSON.stringify(root.identity)); }
function identity(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function safeIdentity(value: string, label: string): string { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Invalid ${label} identity.`); return value; }
function requiredLabel(value: string): string { const normalized = value.trim(); if (normalized.length === 0 || normalized.length > 200) throw new Error('Checkpoint label must be non-empty and bounded.'); return normalized; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function snapshotKind(value: unknown): value is WorkspaceSnapshotEntry['kind'] { return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other'; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nodeCode(error: unknown): string | undefined { return record(error) && typeof error.code === 'string' ? error.code : undefined; }
function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
