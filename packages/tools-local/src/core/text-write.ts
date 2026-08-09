import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { hostname } from 'node:os';
import { throwIfAborted } from '@agent-core/tools';
import { assertPathIsNotSymlink, resolveInsideRoot } from './filesystem.js';

export interface PreparedTextPatchWrite {
  path: string;
  absolutePath: string;
  content: string;
  mode?: number;
  overwrite: boolean;
  expectedCurrentSha256?: string;
  expectedAbsent?: true;
}

export interface PreparedTextPatchRemove {
  path: string;
  absolutePath: string;
  expectedCurrentSha256: string;
}

export interface PreparedTextPatchTransaction {
  writes: PreparedTextPatchWrite[];
  removes: PreparedTextPatchRemove[];
  parentDirsToCreate?: string[];
}

export interface TextTransactionOptions {
  readonly signal?: AbortSignal;
  readonly fileSystem?: TextWriteFileSystem;
  readonly journalDirectory: string;
  readonly transactionId?: string;
}

export type TextWriteFileSystem = Pick<typeof fs, 'chmod' | 'lstat' | 'mkdir' | 'open' | 'readFile' | 'readdir' | 'rename' | 'rm' | 'rmdir' | 'writeFile'>;
export interface TextTransactionDiagnostic {
  readonly operation: string;
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}
export type TextTransactionRecovery =
  | { readonly status: 'succeeded'; readonly diagnostics: readonly []; readonly strandedPaths: readonly [] }
  | { readonly status: 'failed' | 'uncertain'; readonly diagnostics: readonly TextTransactionDiagnostic[]; readonly strandedPaths: readonly string[] };
export type TextTransactionResult =
  | { readonly outcome: 'committed'; readonly cleanup: TextTransactionRecovery }
  | { readonly outcome: 'committed_with_residue'; readonly cleanup: Exclude<TextTransactionRecovery, { status: 'succeeded' }> }
  | { readonly outcome: 'rolled_back'; readonly failure: TextTransactionDiagnostic; readonly rollback: Extract<TextTransactionRecovery, { status: 'succeeded' }> }
  | { readonly outcome: 'rollback_failed'; readonly failure: TextTransactionDiagnostic; readonly rollback: Exclude<TextTransactionRecovery, { status: 'succeeded' }> };

export async function commitTextFilePatchTransaction(rootDir: string, transaction: PreparedTextPatchTransaction, options: TextTransactionOptions): Promise<TextTransactionResult> {
  return withTextFilePatchJournal(rootDir, options.journalDirectory, async (authority) => authority.commit(transaction, options));
}

export interface TextPatchJournalAuthority {
  commit(transaction: PreparedTextPatchTransaction, options: Omit<TextTransactionOptions, 'journalDirectory'> & { readonly journalDirectory?: string }): Promise<TextTransactionResult>;
}

export async function withTextFilePatchJournal<T>(
  rootDir: string,
  journalDirectory: string,
  operation: (authority: TextPatchJournalAuthority) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return withJournalLock(journalDirectory, signal, async () => {
    await recoverTextFilePatchTransactionsUnlocked(rootDir, journalDirectory, fs);
    const authority: TextPatchJournalAuthority = Object.freeze({
      commit: (transaction: PreparedTextPatchTransaction, options: Omit<TextTransactionOptions, 'journalDirectory'> & { readonly journalDirectory?: string }) => commitTextFilePatchTransactionUnlocked(rootDir, transaction, { ...options, journalDirectory })
    });
    return operation(authority);
  });
}

async function commitTextFilePatchTransactionUnlocked(rootDir: string, transaction: PreparedTextPatchTransaction, options: TextTransactionOptions): Promise<TextTransactionResult> {
  throwIfAborted(options.signal);
  const io = options.fileSystem ?? fs;
  const parentDirs = [...new Set(transaction.parentDirsToCreate ?? [])];
  const transactionId = safeTransactionId(options.transactionId ?? randomUUID());
  const transactionDirectory = path.join(options.journalDirectory, transactionId);
  const manifestPath = path.join(transactionDirectory, 'transaction.json');
  const writes: PatchJournalWrite[] = transaction.writes.map((write, index) => ({
    path: write.path,
    absolutePath: write.absolutePath,
    stagedPath: path.join(transactionDirectory, `write-${String(index)}.tmp`),
    ...(write.overwrite ? { backupPath: path.join(transactionDirectory, `backup-write-${String(index)}`) } : {}),
    newSha256: sha256(write.content),
    overwrite: write.overwrite,
    ...(write.expectedCurrentSha256 ? { expectedCurrentSha256: write.expectedCurrentSha256 } : {}),
    ...(write.expectedAbsent ? { expectedAbsent: true as const } : {})
  }));
  const removes: PatchJournalRemove[] = transaction.removes.map((remove, index) => ({
    path: remove.path,
    absolutePath: remove.absolutePath,
    backupPath: path.join(transactionDirectory, `backup-remove-${String(index)}`),
    expectedCurrentSha256: remove.expectedCurrentSha256
  }));
  const manifest: PatchJournalManifest = { version: 1, transactionId, phase: 'prepared', parentDirs, writes, removes };
  let mutationStarted = false;

  try {
    for (const remove of transaction.removes) {
      await assertPathIsNotSymlink(rootDir, remove.path);
    }
    for (const write of transaction.writes) {
      await assertPathIsNotSymlink(rootDir, write.path);
    }
    await io.mkdir(transactionDirectory);
    await syncDirectory(options.journalDirectory, io);
    for (const [index, write] of transaction.writes.entries()) {
      const journalWrite = writes[index];
      if (!journalWrite) throw new Error(`Missing journal write ${String(index)}.`);
      await io.writeFile(journalWrite.stagedPath, write.content, { encoding: 'utf8', ...(write.mode !== undefined ? { mode: write.mode } : {}) });
      if (write.mode !== undefined) await io.chmod(journalWrite.stagedPath, write.mode);
      await syncFile(journalWrite.stagedPath, io);
    }
    await writePatchJournalManifest(manifestPath, manifest, io);
    await validateCommitPreconditions(transaction, parentDirs, io);
    mutationStarted = true;
    for (const dir of parentDirs) {
      await ensureDurableDirectory(dir, io);
    }
    for (const remove of removes) {
      await assertStagedPathIsFile(remove.path, remove.absolutePath, io);
      await io.rename(remove.absolutePath, remove.backupPath);
      await syncDirectories([path.dirname(remove.absolutePath), transactionDirectory], io);
    }
    for (const write of writes) {
      if (write.backupPath) {
        await assertStagedPathIsFile(write.path, write.absolutePath, io);
        await io.rename(write.absolutePath, write.backupPath);
        await syncDirectories([path.dirname(write.absolutePath), transactionDirectory], io);
      } else {
        await assertDestinationDoesNotExist(write.absolutePath, io);
      }
      await io.rename(write.stagedPath, write.absolutePath);
      await syncDirectories([transactionDirectory, path.dirname(write.absolutePath)], io);
    }
    await writePatchJournalManifest(manifestPath, { ...manifest, phase: 'committed' }, io);
    const cleanup = await recoveryResult([recoveryOperation('remove_patch_journal', transactionDirectory, () => removeJournal(transactionDirectory, io))], io);
    return cleanup.status === 'succeeded' ? { outcome: 'committed', cleanup } : { outcome: 'committed_with_residue', cleanup };
  } catch (error) {
    const rollback = mutationStarted
      ? await recoverPreparedPatchTransaction(transactionDirectory, manifest, io)
      : await recoveryResult([recoveryOperation('remove_patch_journal', transactionDirectory, () => removeJournal(transactionDirectory, io))], io);
    return failedResult(error, 'commit_patch', rollback);
  }
}

interface PatchJournalWrite {
  readonly path: string;
  readonly absolutePath: string;
  readonly stagedPath: string;
  readonly backupPath?: string;
  readonly newSha256: string;
  readonly overwrite: boolean;
  readonly expectedCurrentSha256?: string;
  readonly expectedAbsent?: true;
}
interface PatchJournalRemove { readonly path: string; readonly absolutePath: string; readonly backupPath: string; readonly expectedCurrentSha256: string }
interface PatchJournalManifest {
  readonly version: 1;
  readonly transactionId: string;
  readonly phase: 'prepared' | 'committed';
  readonly parentDirs: readonly string[];
  readonly writes: readonly PatchJournalWrite[];
  readonly removes: readonly PatchJournalRemove[];
}

export async function recoverTextFilePatchTransactions(rootDir: string, journalDirectory: string, io: TextWriteFileSystem = fs): Promise<void> {
  if (io !== fs) {
    await recoverTextFilePatchTransactionsUnlocked(rootDir, journalDirectory, io);
    return;
  }
  await withJournalLock(journalDirectory, undefined, () => recoverTextFilePatchTransactionsUnlocked(rootDir, journalDirectory, io));
}

async function recoverTextFilePatchTransactionsUnlocked(rootDir: string, journalDirectory: string, io: TextWriteFileSystem): Promise<void> {
  await ensureDurableDirectory(journalDirectory, io);
  const entries = await io.readdir(journalDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionDirectory = path.join(journalDirectory, entry.name);
    const manifest = await readPatchJournalManifest(path.join(transactionDirectory, 'transaction.json'), io);
    validatePatchJournalPaths(rootDir, transactionDirectory, manifest);
    const recovery = manifest.phase === 'committed'
      ? await recoveryResult([recoveryOperation('remove_committed_patch_journal', transactionDirectory, () => removeJournal(transactionDirectory, io))], io)
      : await recoverPreparedPatchTransaction(transactionDirectory, manifest, io);
    if (recovery.status !== 'succeeded') {
      throw new Error(`Patch transaction recovery ${recovery.status}: ${recovery.diagnostics.map((item) => item.message).join('; ')}`);
    }
  }
}

function validatePatchJournalPaths(rootDir: string, transactionDirectory: string, manifest: PatchJournalManifest): void {
  if (manifest.transactionId !== path.basename(transactionDirectory)) throw new Error(`Patch journal transaction identity does not match its directory: ${transactionDirectory}`);
  for (const [index, write] of manifest.writes.entries()) {
    const expectedAbsolutePath = resolveInsideRoot(rootDir, write.path);
    const expectedStagedPath = path.join(transactionDirectory, `write-${String(index)}.tmp`);
    const expectedBackupPath = write.overwrite ? path.join(transactionDirectory, `backup-write-${String(index)}`) : undefined;
    if (path.resolve(write.absolutePath) !== expectedAbsolutePath || path.resolve(write.stagedPath) !== path.resolve(expectedStagedPath) || resolveOptionalPath(write.backupPath) !== resolveOptionalPath(expectedBackupPath)) {
      throw new Error(`Patch journal write paths are invalid for: ${write.path}`);
    }
  }
  for (const [index, remove] of manifest.removes.entries()) {
    if (path.resolve(remove.absolutePath) !== resolveInsideRoot(rootDir, remove.path) || path.resolve(remove.backupPath) !== path.resolve(transactionDirectory, `backup-remove-${String(index)}`)) {
      throw new Error(`Patch journal removal paths are invalid for: ${remove.path}`);
    }
  }
  for (const directory of manifest.parentDirs) assertAbsolutePathInsideRoot(rootDir, directory);
}

function resolveOptionalPath(value: string | undefined): string | undefined { return value === undefined ? undefined : path.resolve(value); }

function assertAbsolutePathInsideRoot(rootDir: string, candidate: string): void {
  const root = path.resolve(rootDir);
  const absolute = path.resolve(candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Patch journal directory escapes the workspace: ${candidate}`);
}

async function recoverPreparedPatchTransaction(transactionDirectory: string, manifest: PatchJournalManifest, io: TextWriteFileSystem): Promise<TextTransactionRecovery> {
  const operations: RecoveryOperation[] = [];
  for (const write of [...manifest.writes].reverse()) {
    const backupPath = write.backupPath;
    if (backupPath) {
      operations.push(recoveryOperation('restore_write_backup', write.absolutePath, async () => {
        if (!await pathExists(backupPath, io)) return;
        if (await pathExists(write.absolutePath, io)) {
          const actual = sha256(await io.readFile(write.absolutePath));
          if (actual !== write.newSha256) throw new Error(`Refusing to overwrite changed path during recovery: ${write.path}`);
          await io.rm(write.absolutePath, { force: true });
          await syncDirectory(path.dirname(write.absolutePath), io);
        }
        await io.rename(backupPath, write.absolutePath);
        await syncDirectories([path.dirname(backupPath), path.dirname(write.absolutePath)], io);
      }, backupPath));
    } else {
      operations.push(recoveryOperation('remove_incomplete_write', write.absolutePath, async () => {
        if (!await pathExists(write.absolutePath, io)) return;
        const actual = sha256(await io.readFile(write.absolutePath));
        if (actual !== write.newSha256) throw new Error(`Refusing to remove changed path during recovery: ${write.path}`);
        await io.rm(write.absolutePath, { force: true });
        await syncDirectory(path.dirname(write.absolutePath), io);
      }));
    }
  }
  for (const remove of [...manifest.removes].reverse()) {
    operations.push(recoveryOperation('restore_remove_backup', remove.absolutePath, async () => {
      if (!await pathExists(remove.backupPath, io)) return;
      if (await pathExists(remove.absolutePath, io)) throw new Error(`Refusing to overwrite changed path during recovery: ${remove.path}`);
      await io.rename(remove.backupPath, remove.absolutePath);
      await syncDirectories([path.dirname(remove.backupPath), path.dirname(remove.absolutePath)], io);
    }, remove.backupPath));
  }
  operations.push(...[...manifest.parentDirs].sort((left, right) => right.length - left.length).map((dir) => recoveryOperation('remove_created_directory', dir, async () => {
    await io.rmdir(dir);
    await syncDirectory(path.dirname(dir), io);
  })));
  const recovery = await recoveryResult(operations, io);
  if (recovery.status === 'succeeded') {
    await removeJournal(transactionDirectory, io);
  }
  return recovery;
}

async function writePatchJournalManifest(manifestPath: string, manifest: PatchJournalManifest, io: TextWriteFileSystem): Promise<void> {
  const temporaryPath = `${manifestPath}.tmp`;
  await io.writeFile(temporaryPath, JSON.stringify(manifest), 'utf8');
  await syncFile(temporaryPath, io);
  await io.rename(temporaryPath, manifestPath);
  await syncDirectory(path.dirname(manifestPath), io);
}

async function removeJournal(transactionDirectory: string, io: TextWriteFileSystem): Promise<void> {
  await io.rm(transactionDirectory, { recursive: true, force: true });
  await syncDirectory(path.dirname(transactionDirectory), io);
}

async function syncFile(filePath: string, io: TextWriteFileSystem): Promise<void> {
  const handle = await io.open(filePath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectories(directories: readonly string[], io: TextWriteFileSystem): Promise<void> {
  for (const directory of new Set(directories)) await syncDirectory(directory, io);
}

async function syncDirectory(directory: string, io: TextWriteFileSystem): Promise<void> {
  let handle: Awaited<ReturnType<TextWriteFileSystem['open']>> | undefined;
  try {
    handle = await io.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = nodeCode(error) ?? '';
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(code) && !(process.platform === 'win32' && code === 'EPERM')) throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureDurableDirectory(directory: string, io: TextWriteFileSystem): Promise<void> {
  const missing: string[] = [];
  let cursor = path.resolve(directory);
  while (!await pathExists(cursor, io)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot find an existing ancestor for directory: ${directory}`);
    cursor = parent;
  }
  for (const item of missing.reverse()) {
    try { await io.mkdir(item); }
    catch (error) { if (nodeCode(error) !== 'EEXIST') throw error; }
    await syncDirectory(path.dirname(item), io);
  }
}

async function readPatchJournalManifest(manifestPath: string, io: TextWriteFileSystem): Promise<PatchJournalManifest> {
  const value: unknown = JSON.parse(await io.readFile(manifestPath, 'utf8'));
  if (!isPatchJournalManifest(value)) throw new Error(`Invalid patch transaction journal: ${manifestPath}`);
  return value;
}

function isPatchJournalManifest(value: unknown): value is PatchJournalManifest {
  if (!isRecord(value) || value.version !== 1 || typeof value.transactionId !== 'string' || (value.phase !== 'prepared' && value.phase !== 'committed')) return false;
  return Array.isArray(value.parentDirs) && value.parentDirs.every((item) => typeof item === 'string')
    && Array.isArray(value.writes) && value.writes.every((item) => isRecord(item) && typeof item.path === 'string' && typeof item.absolutePath === 'string' && typeof item.stagedPath === 'string' && (item.backupPath === undefined || typeof item.backupPath === 'string') && typeof item.newSha256 === 'string' && typeof item.overwrite === 'boolean' && (item.expectedCurrentSha256 === undefined || typeof item.expectedCurrentSha256 === 'string') && (item.expectedAbsent === undefined || item.expectedAbsent === true))
    && Array.isArray(value.removes) && value.removes.every((item) => isRecord(item) && typeof item.path === 'string' && typeof item.absolutePath === 'string' && typeof item.backupPath === 'string' && typeof item.expectedCurrentSha256 === 'string');
}

async function pathExists(pathValue: string, io: TextWriteFileSystem): Promise<boolean> {
  try { await io.lstat(pathValue); return true; }
  catch (error) { if (nodeCode(error) === 'ENOENT') return false; throw error; }
}

async function validateCommitPreconditions(transaction: PreparedTextPatchTransaction, parentDirs: readonly string[], io: TextWriteFileSystem): Promise<void> {
  for (const remove of transaction.removes) await assertCurrentSha256(remove.path, remove.absolutePath, remove.expectedCurrentSha256, io);
  for (const write of transaction.writes) {
    if (write.expectedCurrentSha256) await assertCurrentSha256(write.path, write.absolutePath, write.expectedCurrentSha256, io);
    if (write.expectedAbsent) await assertDestinationDoesNotExist(write.absolutePath, io);
  }
  for (const directory of parentDirs) {
    if (await pathExists(directory, io)) throw new Error('Patch parent state changed before commit: ' + directory);
    let ancestor = path.dirname(directory);
    while (!await pathExists(ancestor, io)) {
      const next = path.dirname(ancestor);
      if (next === ancestor) throw new Error('Patch parent has no existing ancestor: ' + directory);
      ancestor = next;
    }
    const stat = await io.lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Patch parent state is not a real directory: ' + ancestor);
  }
}
async function assertCurrentSha256(filePath: string, absolutePath: string, expected: string, io: TextWriteFileSystem): Promise<void> {
  const stat = await io.lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Patch source type changed before commit: ' + filePath);
  const actual = sha256(await io.readFile(absolutePath));
  if (actual !== expected) throw new Error('Patch source changed before commit: ' + filePath);
}

async function withJournalLock<T>(journalDirectory: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const lockPath = journalDirectory + '.lock';
  await fs.mkdir(path.dirname(journalDirectory), { recursive: true });
  const started = Date.now();
  const owner = { pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), nonce: randomUUID() };
  for (;;) {
    throwIfAborted(signal);
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
      if (await staleJournalLock(lockPath)) { await fs.rm(lockPath, { recursive: true, force: true }); continue; }
      if (Date.now() - started > 30_000) throw new Error('Timed out acquiring patch journal lock: ' + lockPath, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await operation(); }
  finally {
    try {
      const current = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { nonce?: unknown };
      if (current.nonce === owner.nonce) await fs.rm(lockPath, { recursive: true, force: true });
    } catch { /* A missing lock is already released. */ }
  }
}
async function staleJournalLock(lockPath: string): Promise<boolean> {
  let stat;
  try { stat = await fs.stat(lockPath); } catch { return false; }
  const age = Date.now() - stat.mtimeMs;
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown; hostname?: unknown };
    if (owner.hostname !== hostname()) return age > 60 * 60_000;
    if (typeof owner.pid === 'number') {
      try { process.kill(owner.pid, 0); return false; }
      catch (error) { return nodeCode(error) === 'ESRCH'; }
    }
  } catch { return age > 10 * 60_000; }
  return age > 10 * 60_000;
}

function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function safeTransactionId(value: string): string { return value.replace(/[^A-Za-z0-9._-]/gu, '_'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

async function assertDestinationDoesNotExist(absolutePath: string, io: TextWriteFileSystem): Promise<void> {
  try {
    await io.lstat(absolutePath);
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error('Refusing to overwrite existing destination during commit.');
}

async function assertStagedPathIsFile(filePath: string, absolutePath: string, io: TextWriteFileSystem): Promise<void> {
  const stat = await io.lstat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${filePath}`);
  }
}

interface RecoveryOperation { readonly operation: string; readonly path: string; readonly strandedPath: string; readonly run: () => Promise<unknown> }
function recoveryOperation(operation: string, pathValue: string, run: () => Promise<unknown>, strandedPath = pathValue): RecoveryOperation { return { operation, path: pathValue, strandedPath, run }; }
async function recoveryResult(operations: readonly RecoveryOperation[], io: TextWriteFileSystem): Promise<TextTransactionRecovery> {
  const diagnostics: TextTransactionDiagnostic[] = [];
  const strandedPaths: string[] = [];
  let uncertain = false;
  for (const operation of operations) {
    try { await operation.run(); }
    catch (error) {
      const stranded = await probePath(operation.strandedPath, io);
      if (stranded === false) continue;
      diagnostics.push(diagnostic(error, operation.operation, operation.path));
      strandedPaths.push(operation.strandedPath);
      if (stranded === 'unknown') uncertain = true;
    }
  }
  return diagnostics.length === 0
    ? { status: 'succeeded', diagnostics: [], strandedPaths: [] }
    : { status: uncertain ? 'uncertain' : 'failed', diagnostics: Object.freeze(diagnostics), strandedPaths: Object.freeze([...new Set(strandedPaths)]) };
}
async function probePath(pathValue: string, io: TextWriteFileSystem): Promise<boolean | 'unknown'> {
  try { await io.lstat(pathValue); return true; }
  catch (error) { return nodeCode(error) === 'ENOENT' ? false : 'unknown'; }
}
function failedResult(error: unknown, operation: string, rollback: TextTransactionRecovery): TextTransactionResult {
  const failure = diagnostic(error, operation, '');
  return rollback.status === 'succeeded' ? { outcome: 'rolled_back', failure, rollback } : { outcome: 'rollback_failed', failure, rollback };
}
function diagnostic(error: unknown, operation: string, pathValue: string): TextTransactionDiagnostic {
  const code = nodeCode(error);
  return { operation, path: pathValue, message: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) };
}
function nodeCode(error: unknown): string | undefined { return typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string' ? String(Reflect.get(error, 'code')) : undefined; }
