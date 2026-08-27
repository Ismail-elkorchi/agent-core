import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { throwIfAborted } from '@agent-core/tools';
import { openHostDirectoryWithoutAliases, openWorkspaceMutationDirectory, workspaceFileIdentitiesEqual, type WorkspaceFileIdentity, type WorkspaceFileRoot, type WorkspaceMutationDirectory } from './workspace-file-root.js';

const ownedJournals = new WeakSet<TextPatchJournal>();
const MAX_JOURNAL_MANIFEST_BYTES = 16 * 1024 * 1024;

interface PreparedTextPatchWriteBase {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

export type PreparedTextPatchWrite =
  | PreparedTextPatchWriteBase & {
    readonly overwrite: true;
    readonly expectedCurrentSha256: string;
    readonly expectedCurrentIdentity: WorkspaceFileIdentity;
  }
  | PreparedTextPatchWriteBase & {
    readonly overwrite: false;
    readonly expectedAbsent: true;
  };

export interface PreparedTextPatchRemove {
  readonly path: string;
  readonly expectedCurrentSha256: string;
  readonly expectedCurrentIdentity: WorkspaceFileIdentity;
}

export interface PreparedTextPatchTransaction {
  readonly writes: readonly PreparedTextPatchWrite[];
  readonly removes: readonly PreparedTextPatchRemove[];
  readonly parentDirsToCreate?: readonly string[];
}

export interface TextTransactionOptions { readonly signal?: AbortSignal; readonly transactionId?: string }
export interface TextTransactionDiagnostic { readonly operation: string; readonly path: string; readonly message: string; readonly code?: string }
export type TextTransactionRecovery =
  | { readonly status: 'succeeded'; readonly diagnostics: readonly []; readonly strandedPaths: readonly [] }
  | { readonly status: 'failed' | 'uncertain'; readonly diagnostics: readonly TextTransactionDiagnostic[]; readonly strandedPaths: readonly string[] };
export type TextTransactionResult =
  | { readonly outcome: 'committed'; readonly cleanup: TextTransactionRecovery }
  | { readonly outcome: 'committed_with_residue'; readonly cleanup: Exclude<TextTransactionRecovery, { status: 'succeeded' }> }
  | { readonly outcome: 'rolled_back'; readonly failure: TextTransactionDiagnostic; readonly rollback: Extract<TextTransactionRecovery, { status: 'succeeded' }> }
  | { readonly outcome: 'rollback_failed'; readonly failure: TextTransactionDiagnostic; readonly rollback: Exclude<TextTransactionRecovery, { status: 'succeeded' }> };

export interface TextPatchJournalAuthority {
  commit(transaction: PreparedTextPatchTransaction, options?: TextTransactionOptions): Promise<TextTransactionResult>;
}

export class TextPatchJournal {
  readonly #directory: string;
  readonly #descriptor: number;
  readonly #device: bigint;
  readonly #inode: bigint;
  #closed = false;
  #activeOperations = 0;

  private constructor(directory: string, descriptor: number, device: bigint, inode: bigint) {
    this.#directory = directory; this.#descriptor = descriptor; this.#device = device; this.#inode = inode; ownedJournals.add(this);
  }

  static adopt(directoryPath: string): TextPatchJournal {
    if (typeof directoryPath !== 'string' || directoryPath.trim().length === 0) throw new TypeError('Patch journal path must be non-empty.');
    const directory = path.resolve(directoryPath);
    const fd = openHostDirectoryWithoutAliases(directory);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isDirectory()) throw new Error(`Patch journal must be a real directory: ${directory}`);
      fchmodSync(fd, 0o700);
      return new TextPatchJournal(directory, fd, opened.dev, opened.ino);
    } catch (error) { closeSync(fd); throw error; }
  }

  async withAuthority<T>(root: WorkspaceFileRoot, operation: (authority: TextPatchJournalAuthority) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#assertOpen();
    this.#activeOperations += 1;
    try {
      const authorityPath = `/proc/self/fd/${String(this.#descriptor)}`;
      return await withJournalLock(authorityPath, signal, async (assertOwned) => {
        this.#assertIdentity();
        await assertOwned();
        await recoverTransactions(root, authorityPath);
        let active = true;
        const authority: TextPatchJournalAuthority = Object.freeze({
          commit: async (transaction: PreparedTextPatchTransaction, options: TextTransactionOptions = {}) => {
            this.#assertOpen();
            if (!active) throw new Error('Patch journal operation authority has expired.');
            await assertOwned();
            return commitTransaction(root, authorityPath, transaction, options);
          }
        });
        try { return await operation(authority); }
        finally { active = false; }
      });
    } finally {
      this.#activeOperations -= 1;
      if (this.#closed && this.#activeOperations === 0) closeSync(this.#descriptor);
    }
  }

  async recover(root: WorkspaceFileRoot): Promise<void> {
    await this.withAuthority(root, () => Promise.resolve(undefined));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeOperations === 0) closeSync(this.#descriptor);
  }
  #assertOpen(): void { if (this.#closed) throw new Error('Patch journal has been released.'); }
  #assertIdentity(): void {
    const current = fstatSync(this.#descriptor, { bigint: true });
    if (!current.isDirectory() || current.dev !== this.#device || current.ino !== this.#inode) throw new Error(`Patch journal authority no longer names its adopted directory: ${this.#directory}`);
  }
}

export function isTextPatchJournal(value: unknown): value is TextPatchJournal {
  return typeof value === 'object' && value !== null && ownedJournals.has(value as TextPatchJournal);
}

export function withTextFilePatchJournal<T>(root: WorkspaceFileRoot, journal: TextPatchJournal, operation: (authority: TextPatchJournalAuthority) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!isTextPatchJournal(journal)) throw new TypeError('Patch writes require an adopted TextPatchJournal.');
  return journal.withAuthority(root, operation, signal);
}

export function commitTextFilePatchTransaction(root: WorkspaceFileRoot, journal: TextPatchJournal, transaction: PreparedTextPatchTransaction, options: TextTransactionOptions = {}): Promise<TextTransactionResult> {
  return journal.withAuthority(root, (authority) => authority.commit(transaction, options), options.signal);
}

export function recoverTextFilePatchTransactions(root: WorkspaceFileRoot, journal: TextPatchJournal): Promise<void> { return journal.recover(root); }

interface JournalWriteBase {
  readonly path: string;
  readonly stageName: string;
  readonly newSha256: string;
  readonly mode: number;
}
type JournalWrite =
  | JournalWriteBase & {
    readonly overwrite: true;
    readonly backupName: string;
    readonly expectedCurrentSha256: string;
    readonly expectedCurrentIdentity: WorkspaceFileIdentity;
  }
  | JournalWriteBase & {
    readonly overwrite: false;
    readonly expectedAbsent: true;
  };
interface JournalRemove {
  readonly path: string;
  readonly backupName: string;
  readonly expectedCurrentSha256: string;
  readonly expectedCurrentIdentity: WorkspaceFileIdentity;
}
interface JournalCreatedDirectory { readonly path: string; readonly identity?: WorkspaceFileIdentity }
interface JournalManifest {
  readonly version: 1;
  readonly transactionId: string;
  readonly phase: 'prepared' | 'committed';
  readonly createdDirectories: readonly JournalCreatedDirectory[];
  readonly writes: readonly JournalWrite[];
  readonly removes: readonly JournalRemove[];
}

async function commitTransaction(root: WorkspaceFileRoot, journalDirectory: string, transaction: PreparedTextPatchTransaction, options: TextTransactionOptions): Promise<TextTransactionResult> {
  throwIfAborted(options.signal);
  const transactionId = safeTransactionId(options.transactionId ?? randomUUID());
  const token = createHash('sha256').update(transactionId).digest('hex').slice(0, 20);
  const transactionDirectory = path.join(journalDirectory, transactionId);
  const manifestPath = path.join(transactionDirectory, 'transaction.json');
  const writes = transaction.writes.map((write, index): JournalWrite => {
    const common = {
      path: root.canonicalPath(write.path),
      stageName: temporaryName(token, index, 'stage'),
      newSha256: sha256(write.content),
      mode: write.mode ?? 0o600
    };
    return write.overwrite
      ? {
        ...common,
        overwrite: true,
        backupName: temporaryName(token, index, 'backup-write'),
        expectedCurrentSha256: write.expectedCurrentSha256,
        expectedCurrentIdentity: write.expectedCurrentIdentity
      }
      : { ...common, overwrite: false, expectedAbsent: true };
  });
  const removes = transaction.removes.map((remove, index): JournalRemove => ({
    path: root.canonicalPath(remove.path), backupName: temporaryName(token, index, 'backup-remove'),
    expectedCurrentSha256: remove.expectedCurrentSha256, expectedCurrentIdentity: remove.expectedCurrentIdentity
  }));
  const createdDirectories = [...new Set(transaction.parentDirsToCreate ?? [])].map((item): JournalCreatedDirectory => ({ path: root.canonicalPath(item) }));
  let manifest: JournalManifest = { version: 1, transactionId, phase: 'prepared', createdDirectories, writes, removes };
  validateManifest(root, manifest);
  let journalCreated = false;
  try {
    await mkdir(transactionDirectory, { mode: 0o700 });
    journalCreated = true;
    await syncDirectory(journalDirectory);
    await writeManifest(manifestPath, manifest);
    manifest = await createParents(root, manifestPath, manifest);
    for (const [index, write] of writes.entries()) {
      const source = transaction.writes[index];
      if (!source) throw new Error(`Missing prepared patch write ${String(index)}.`);
      await withParent(root, write.path, async (directory) => { await directory.writeExclusive(write.stageName, source.content, write.mode); await directory.sync(); });
    }
    await validatePreconditions(root, writes, removes);
    for (const remove of removes) await moveCurrentToBackup(root, remove.path, remove.backupName, remove.expectedCurrentSha256, remove.expectedCurrentIdentity);
    for (const write of writes) {
      if (write.overwrite) await moveCurrentToBackup(root, write.path, write.backupName, write.expectedCurrentSha256, write.expectedCurrentIdentity);
      else if ((await root.inspectPath(write.path)).kind !== 'absent') throw new Error(`Patch destination appeared before commit: ${write.path}`);
      await withParent(root, write.path, async (directory, leaf) => {
        await directory.link(write.stageName, leaf);
        await directory.sync();
      });
    }
    manifest = { ...manifest, phase: 'committed' };
    await writeManifest(manifestPath, manifest);
    const cleanup = await cleanupCommitted(root, transactionDirectory, manifest);
    return cleanup.status === 'succeeded' ? { outcome: 'committed', cleanup } : { outcome: 'committed_with_residue', cleanup };
  } catch (error) {
    if (!journalCreated) {
      return { outcome: 'rolled_back', failure: diagnostic('create_patch_journal', transactionId, error), rollback: { status: 'succeeded', diagnostics: [], strandedPaths: [] } };
    }
    const rollback = await rollbackPrepared(root, transactionDirectory, manifest);
    const failure = diagnostic('commit_patch', transactionId, error);
    return rollback.status === 'succeeded' ? { outcome: 'rolled_back', failure, rollback } : { outcome: 'rollback_failed', failure, rollback };
  }
}

async function validatePreconditions(root: WorkspaceFileRoot, writes: readonly JournalWrite[], removes: readonly JournalRemove[]): Promise<void> {
  for (const remove of removes) await assertCurrentFile(root, remove.path, remove.expectedCurrentSha256, remove.expectedCurrentIdentity);
  for (const write of writes) {
    if (write.overwrite) await assertCurrentFile(root, write.path, write.expectedCurrentSha256, write.expectedCurrentIdentity);
    else if ((await root.inspectPath(write.path)).kind !== 'absent') throw new Error(`Patch destination appeared before commit: ${write.path}`);
  }
}

async function createParents(root: WorkspaceFileRoot, manifestPath: string, initial: JournalManifest): Promise<JournalManifest> {
  let manifest = initial;
  for (const [index, item] of manifest.createdDirectories.entries()) {
    const { parent, leaf } = splitParent(item.path);
    const directory = await openWorkspaceMutationDirectory(root, parent);
    try {
      await directory.createDirectory(leaf, 0o700);
      await directory.sync();
      const status = await directory.status(leaf);
      if (status.kind !== 'directory') throw new Error(`Created patch parent is not a directory: ${item.path}`);
      const createdDirectories = manifest.createdDirectories.map((entry, entryIndex) => entryIndex === index ? { ...entry, identity: status.identity } : entry);
      manifest = { ...manifest, createdDirectories };
      await writeManifest(manifestPath, manifest);
    }
    finally { await directory.close(); }
  }
  return manifest;
}

async function moveCurrentToBackup(root: WorkspaceFileRoot, filePath: string, backupName: string, expectedSha256: string, expectedIdentity: WorkspaceFileIdentity): Promise<void> {
  await withParent(root, filePath, async (directory, leaf) => {
    const backup = await directory.status(backupName);
    if (backup.kind !== 'absent') throw new Error(`Patch backup already exists: ${backup.path}`);
    await directory.rename(leaf, backupName);
    await directory.sync();
    const moved = await directory.status(backupName);
    if (moved.kind !== 'file' || !sameFileObject(moved.identity, expectedIdentity)) throw new Error(`Patch source identity changed before publication: ${filePath}`);
    const actual = sha256(await directory.readFile(backupName, Number.MAX_SAFE_INTEGER));
    if (actual !== expectedSha256) throw new Error(`Patch source changed before publication: ${filePath}`);
  });
}

async function cleanupCommitted(root: WorkspaceFileRoot, transactionDirectory: string, manifest: JournalManifest): Promise<TextTransactionRecovery> {
  return recoverThenRemoveJournal(transactionDirectory, [
    ...manifest.writes.flatMap((write) => [write.stageName, ...(write.overwrite ? [write.backupName] : [])].map((name) => operation('remove_patch_temporary', joinParent(write.path, name), () => removeSibling(root, write.path, name)))),
    ...manifest.removes.map((remove) => operation('remove_patch_backup', joinParent(remove.path, remove.backupName), () => removeSibling(root, remove.path, remove.backupName)))
  ]);
}

async function rollbackPrepared(root: WorkspaceFileRoot, transactionDirectory: string, manifest: JournalManifest): Promise<TextTransactionRecovery> {
  const operations: RecoveryOperation[] = [];
  for (const write of [...manifest.writes].reverse()) {
    operations.push(operation('rollback_patch_write', write.path, async () => {
      const backupPresent = write.overwrite ? await siblingExists(root, write.path, write.backupName) : false;
      const stageStatus = await siblingStatus(root, write.path, write.stageName);
      const status = await siblingStatus(root, write.path, splitParent(write.path).leaf);
      if (status.kind === 'file') {
        const publishedByTransaction = stageStatus.kind === 'file' && stageStatus.identity.device === status.identity.device && stageStatus.identity.inode === status.identity.inode;
        if (publishedByTransaction) await removeTarget(root, write.path);
        else if (backupPresent) throw new Error(`Refusing to remove a changed patch result: ${write.path}`);
      } else if (status.kind !== 'absent') throw new Error(`Patch result has an unsafe type: ${write.path}`);
      if (write.overwrite) await restoreSibling(root, write.path, write.backupName, write.expectedCurrentIdentity);
      await removeSibling(root, write.path, write.stageName);
    }));
  }
  for (const remove of [...manifest.removes].reverse()) operations.push(operation('restore_patch_remove', remove.path, () => restoreSibling(root, remove.path, remove.backupName, remove.expectedCurrentIdentity)));
  for (const directory of [...manifest.createdDirectories].reverse()) {
    operations.push(operation('remove_patch_directory', directory.path, () => removeCreatedDirectory(root, directory)));
  }
  return recoverThenRemoveJournal(transactionDirectory, operations);
}

async function recoverTransactions(root: WorkspaceFileRoot, journalDirectory: string): Promise<void> {
  for (const entry of await readdir(journalDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.lock') continue;
    const transactionDirectory = path.join(journalDirectory, entry.name);
    const manifest = await readManifest(path.join(transactionDirectory, 'transaction.json'));
    if (manifest.transactionId !== entry.name) throw new Error(`Patch journal identity mismatch: ${transactionDirectory}`);
    validateManifest(root, manifest);
    const recovery = manifest.phase === 'committed' ? await cleanupCommitted(root, transactionDirectory, manifest) : await rollbackPrepared(root, transactionDirectory, manifest);
    if (recovery.status !== 'succeeded') throw new Error(`Patch recovery ${recovery.status}: ${recovery.diagnostics.map((item) => item.message).join('; ')}`);
  }
}

async function restoreSibling(root: WorkspaceFileRoot, targetPath: string, backupName: string, expectedIdentity: WorkspaceFileIdentity): Promise<void> {
  await withParent(root, targetPath, async (directory, leaf) => {
    const backup = await directory.status(backupName);
    if (backup.kind === 'absent') return;
    if (backup.kind !== 'file' || !sameFileObject(backup.identity, expectedIdentity)) throw new Error(`Patch backup identity changed: ${joinParent(targetPath, backupName)}`);
    if ((await directory.status(leaf)).kind !== 'absent') throw new Error(`Refusing to overwrite a changed path during recovery: ${targetPath}`);
    await directory.rename(backupName, leaf); await directory.sync();
  });
}
async function removeTarget(root: WorkspaceFileRoot, targetPath: string): Promise<void> { await withParent(root, targetPath, async (directory, leaf) => { await directory.removeFile(leaf); await directory.sync(); }); }
async function removeSibling(root: WorkspaceFileRoot, targetPath: string, name: string): Promise<void> { await withParent(root, targetPath, async (directory) => { await directory.removeFile(name); await directory.sync(); }); }
async function siblingExists(root: WorkspaceFileRoot, targetPath: string, name: string): Promise<boolean> { return withParent(root, targetPath, async (directory) => (await directory.status(name)).kind !== 'absent'); }
async function siblingStatus(root: WorkspaceFileRoot, targetPath: string, name: string) { return withParent(root, targetPath, async (directory) => directory.status(name)); }
async function removeCreatedDirectory(root: WorkspaceFileRoot, item: JournalCreatedDirectory): Promise<void> {
  const { parent, leaf } = splitParent(item.path); const directory = await openWorkspaceMutationDirectory(root, parent);
  try {
    const status = await directory.status(leaf);
    if (status.kind === 'absent') return;
    if (item.identity === undefined) throw new Error(`Cannot prove ownership of a patch parent created before its receipt was durable: ${item.path}`);
    if (status.kind !== 'directory' || !sameFileObject(status.identity, item.identity)) throw new Error(`Patch-created directory identity changed: ${item.path}`);
    await directory.removeDirectory(leaf); await directory.sync();
  } finally { await directory.close(); }
}
async function withParent<T>(root: WorkspaceFileRoot, targetPath: string, operationValue: (directory: WorkspaceMutationDirectory, leaf: string) => Promise<T>): Promise<T> {
  const { parent, leaf } = splitParent(targetPath); const directory = await openWorkspaceMutationDirectory(root, parent);
  try { return await operationValue(directory, leaf); } finally { await directory.close(); }
}

function splitParent(filePath: string): { readonly parent: string; readonly leaf: string } {
  const index = filePath.lastIndexOf('/');
  return index < 0 ? { parent: '.', leaf: filePath } : { parent: filePath.slice(0, index), leaf: filePath.slice(index + 1) };
}
function joinParent(filePath: string, sibling: string): string { const { parent } = splitParent(filePath); return parent === '.' ? sibling : `${parent}/${sibling}`; }
async function assertCurrentFile(root: WorkspaceFileRoot, filePath: string, expectedSha256: string, expectedIdentity: WorkspaceFileIdentity): Promise<void> {
  const file = await root.openFile(filePath);
  try {
    if (!workspaceFileIdentitiesEqual(file.identity, expectedIdentity)) throw new Error(`Patch source identity changed before commit: ${filePath}`);
    if (sha256(await file.readAll(Number.MAX_SAFE_INTEGER)) !== expectedSha256) throw new Error(`Patch source changed before commit: ${filePath}`);
    if (!workspaceFileIdentitiesEqual(await file.identityNow(), expectedIdentity)) throw new Error(`Patch source changed while validating the commit: ${filePath}`);
  } finally { await file.close(); }
}
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function temporaryName(token: string, index: number, role: string): string { return `.agent-core-patch-${token}-${String(index)}-${role}`; }

async function writeManifest(manifestPath: string, manifest: JournalManifest): Promise<void> {
  const temporary = `${manifestPath}.tmp`;
  const payload = JSON.stringify(manifest);
  const envelope = JSON.stringify({ version: 1, payload: manifest, sha256: sha256(payload) });
  if (Buffer.byteLength(envelope, 'utf8') > MAX_JOURNAL_MANIFEST_BYTES) throw new Error('Patch journal manifest exceeds its retained byte limit.');
  await writeFile(temporary, envelope, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, manifestPath); await syncDirectory(path.dirname(manifestPath));
}
async function readManifest(manifestPath: string): Promise<JournalManifest> {
  const metadata = await stat(manifestPath);
  if (!metadata.isFile() || metadata.size > MAX_JOURNAL_MANIFEST_BYTES) throw new Error(`Patch journal manifest exceeds its admitted form: ${manifestPath}`);
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!record(value) || value.version !== 1 || !isManifest(value.payload) || !sha256Value(value.sha256)) {
    throw new Error(`Invalid patch journal manifest: ${manifestPath}`);
  }
  if (sha256(JSON.stringify(value.payload)) !== value.sha256) throw new Error(`Patch journal checksum failed: ${manifestPath}`);
  return value.payload;
}
function isManifest(value: unknown): value is JournalManifest {
  return record(value) && value.version === 1 && typeof value.transactionId === 'string' && (value.phase === 'prepared' || value.phase === 'committed')
    && Array.isArray(value.createdDirectories) && value.createdDirectories.every((item) => record(item) && typeof item.path === 'string' && (item.identity === undefined || isFileIdentity(item.identity)))
    && Array.isArray(value.writes) && value.writes.every((item) => {
      if (!record(item) || typeof item.path !== 'string' || typeof item.stageName !== 'string' || !sha256Value(item.newSha256)
        || !Number.isInteger(item.mode) || Number(item.mode) < 0 || Number(item.mode) > 0o7777) return false;
      return item.overwrite === true
        ? typeof item.backupName === 'string' && sha256Value(item.expectedCurrentSha256) && isFileIdentity(item.expectedCurrentIdentity)
          && item.expectedAbsent === undefined
        : item.overwrite === false && item.expectedAbsent === true && item.backupName === undefined
          && item.expectedCurrentSha256 === undefined && item.expectedCurrentIdentity === undefined;
    })
    && Array.isArray(value.removes) && value.removes.every((item) => record(item) && typeof item.path === 'string'
      && typeof item.backupName === 'string' && sha256Value(item.expectedCurrentSha256) && isFileIdentity(item.expectedCurrentIdentity));
}

function validateManifest(root: WorkspaceFileRoot, manifest: JournalManifest): void {
  const transactionId = safeTransactionId(manifest.transactionId);
  const token = createHash('sha256').update(transactionId).digest('hex').slice(0, 20);
  const paths = new Set<string>();
  for (const item of manifest.createdDirectories) {
    const canonical = root.canonicalPath(item.path);
    if (canonical !== item.path || canonical === '.' || paths.has(canonical)) throw new Error(`Invalid patch-created directory in journal: ${item.path}`);
    paths.add(canonical);
  }
  for (const [index, write] of manifest.writes.entries()) {
    const canonical = root.canonicalPath(write.path);
    if (canonical !== write.path || paths.has(canonical)) throw new Error(`Duplicate or non-canonical patch path in journal: ${write.path}`);
    paths.add(canonical);
    if (write.stageName !== temporaryName(token, index, 'stage')) throw new Error(`Invalid patch stage name in journal: ${write.stageName}`);
    if (write.overwrite && write.backupName !== temporaryName(token, index, 'backup-write')) throw new Error(`Invalid patch backup name in journal: ${write.backupName}`);
  }
  for (const [index, remove] of manifest.removes.entries()) {
    const canonical = root.canonicalPath(remove.path);
    if (canonical !== remove.path || paths.has(canonical)) throw new Error(`Duplicate or non-canonical patch path in journal: ${remove.path}`);
    paths.add(canonical);
    if (remove.backupName !== temporaryName(token, index, 'backup-remove')) throw new Error(`Invalid patch backup name in journal: ${remove.backupName}`);
  }
}

interface RecoveryOperation { readonly operation: string; readonly path: string; run(): Promise<void> }
function operation(name: string, pathValue: string, run: () => Promise<void>): RecoveryOperation { return { operation: name, path: pathValue, run }; }
async function recoverOperations(operations: readonly RecoveryOperation[]): Promise<TextTransactionRecovery> {
  const diagnostics: TextTransactionDiagnostic[] = [];
  for (const item of operations) try { await item.run(); } catch (error) { diagnostics.push(diagnostic(item.operation, item.path, error)); }
  return diagnostics.length === 0
    ? { status: 'succeeded', diagnostics: [], strandedPaths: [] }
    : { status: 'uncertain', diagnostics, strandedPaths: [...new Set(diagnostics.map((item) => item.path))] };
}
async function recoverThenRemoveJournal(transactionDirectory: string, operations: readonly RecoveryOperation[]): Promise<TextTransactionRecovery> {
  const result = await recoverOperations(operations);
  if (result.status !== 'succeeded') return result;
  return recoverOperations([operation('remove_patch_journal', transactionDirectory, () => removeJournal(transactionDirectory))]);
}
function diagnostic(operationValue: string, pathValue: string, error: unknown): TextTransactionDiagnostic {
  const code = nodeCode(error);
  return { operation: operationValue, path: pathValue, message: error instanceof Error ? error.message : String(error), ...(code === undefined ? {} : { code }) };
}
async function removeJournal(directory: string): Promise<void> { await rm(directory, { recursive: true, force: true }); await syncDirectory(path.dirname(directory)); }
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

async function withJournalLock<T>(journalDirectory: string, signal: AbortSignal | undefined, operationValue: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  const lockPath = path.join(journalDirectory, '.lock');
  const nonce = randomUUID();
  const processIdentity = linuxProcessIdentity(process.pid);
  if (processIdentity === undefined) throw new Error('Cannot establish the patch-journal owner process identity.');
  for (;;) {
    throwIfAborted(signal);
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ nonce, pid: process.pid, hostname: hostname(), processIdentity }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const ownerHandle = await open(path.join(lockPath, 'owner.json'), 'r+'); try { await ownerHandle.sync(); } finally { await ownerHandle.close(); }
      await syncDirectory(lockPath); await syncDirectory(journalDirectory);
      break;
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
      const owner = await readLockOwner(lockPath);
      if (!owner) {
        const lockStat = await statIfPresent(lockPath);
        if (lockStat === undefined) continue;
        if (Date.now() - lockStat.mtimeMs < 30_000) { await wait(signal); continue; }
        throw new Error(`Patch journal lock has no valid owner: ${lockPath}`, { cause: error });
      }
      if (owner.hostname !== hostname()) throw new Error(`Patch journal lock belongs to another host and cannot be proven stale: ${lockPath}`, { cause: error });
      if (linuxProcessIdentity(owner.pid) === owner.processIdentity) { await wait(signal); continue; }
      await rm(lockPath, { recursive: true, force: true }); await syncDirectory(journalDirectory);
    }
  }
  const assertOwned = async () => {
    const owner = await readLockOwner(lockPath);
    if (owner?.nonce !== nonce || owner.pid !== process.pid || owner.hostname !== hostname() || owner.processIdentity !== processIdentity) throw new Error('Patch journal lock ownership was lost.');
  };
  try { return await operationValue(assertOwned); }
  finally {
    const owner = await readLockOwner(lockPath);
    if (owner?.nonce === nonce) { await rm(lockPath, { recursive: true, force: true }); await syncDirectory(journalDirectory); }
  }
}
async function statIfPresent(targetPath: string) {
  try { return await stat(targetPath); }
  catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
}
async function readLockOwner(lockPath: string): Promise<{ nonce?: string; pid: number; hostname: string; processIdentity: string } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    if (!record(value) || !Number.isSafeInteger(value.pid) || typeof value.hostname !== 'string' || typeof value.processIdentity !== 'string') return undefined;
    return { ...(typeof value.nonce === 'string' ? { nonce: value.nonce } : {}), pid: Number(value.pid), hostname: value.hostname, processIdentity: value.processIdentity };
  } catch { return undefined; }
}
function linuxProcessIdentity(pid: number): string | undefined {
  try {
    const statValue = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const closingParenthesis = statValue.lastIndexOf(')');
    if (closingParenthesis < 0) return undefined;
    const fields = statValue.slice(closingParenthesis + 2).trim().split(/\s+/u);
    const startTicks = fields[19];
    if (!startTicks) return undefined;
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return `${bootId}:${startTicks}`;
  } catch { return undefined; }
}
function wait(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 20);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Patch journal wait was aborted.', { cause: signal.reason }));
    }, { once: true });
  });
}
function safeTransactionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value) || value === '.lock') throw new Error('Patch transaction identity is invalid.');
  return value;
}
function sha256Value(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function isFileIdentity(value: unknown): value is WorkspaceFileIdentity {
  return record(value) && typeof value.device === 'string' && typeof value.inode === 'string' && typeof value.mode === 'string'
    && typeof value.links === 'string' && typeof value.size === 'string' && typeof value.modifiedNanoseconds === 'string'
    && typeof value.changedNanoseconds === 'string';
}
function sameFileObject(left: WorkspaceFileIdentity, right: WorkspaceFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nodeCode(error: unknown): string | undefined { return record(error) && typeof error.code === 'string' ? error.code : undefined; }
