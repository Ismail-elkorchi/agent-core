import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readlinkSync, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ToolInputError } from '@agent-core/tools';

const ownedRoots = new WeakSet<RootedFileAuthority>();
const DEFAULT_DENIED_ROOT_ENTRIES = Object.freeze(['.agent-core']);
const RESERVED_ENTRY_PREFIX = '.agent-core-';
const openMutationDirectory = Symbol('agent-core.rooted-file-authority.open-mutation-directory');

export interface RootedFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly links: string;
  readonly size: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
}

export interface RootedFileHandle {
  readonly path: string;
  readonly identity: RootedFileIdentity;
  readonly size: number;
  readonly mode: number;
  /** Descriptor may be inherited by a child only while this handle is open. */
  readonly descriptor: number;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  readAll(maxBytes: number): Promise<Buffer>;
  identityNow(): Promise<RootedFileIdentity>;
  close(): Promise<void>;
}

export interface RootedDirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
}

export interface RootedDirectoryHandle {
  readonly path: string;
  readonly identity: RootedFileIdentity;
  readonly size: number;
  readonly mode: number;
  entries(): Promise<readonly RootedDirectoryEntry[]>;
  close(): Promise<void>;
}

export interface RootedMutationDirectory {
  readonly path: string;
  status(name: string): Promise<RootedPathStatus>;
  writeExclusive(name: string, content: string, mode: number): Promise<void>;
  readFile(name: string, maxBytes: number): Promise<Buffer>;
  createDirectory(name: string, mode: number): Promise<void>;
  rename(sourceName: string, destinationName: string): Promise<void>;
  link(sourceName: string, destinationName: string): Promise<void>;
  removeFile(name: string): Promise<void>;
  removeDirectory(name: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface RootedFileAuthorityOptions {
  readonly additionalDeniedEntries?: readonly string[];
}

export interface RootIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly mountId: string;
}

export type RootedPathStatus =
  | { readonly kind: 'absent'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string; readonly identity: RootedFileIdentity; readonly size: number; readonly mode: number }
  | { readonly kind: 'directory'; readonly path: string; readonly identity: RootedFileIdentity; readonly mode: number }
  | { readonly kind: 'symlink' | 'other'; readonly path: string };

/**
 * Adopted host-file authority for one physical root directory.
 *
 * Node does not expose directory-relative open primitives on every supported
 * platform. The current implementation therefore admits file access only on
 * Linux, where held directory descriptors and /proc/self/fd let every path
 * component be opened without following aliases. Unsupported platforms fail
 * at adoption instead of silently weakening confinement.
 */
export class RootedFileAuthority {
  readonly #displayPath: string;
  readonly #rootFd: number;
  readonly #rootMountId: string;
  readonly #identity: RootIdentity;
  readonly #deniedRootEntries: ReadonlySet<string>;
  #closed = false;

  private constructor(displayPath: string, rootFd: number, rootMountId: string, rootIdentity: RootIdentity, deniedRootEntries: ReadonlySet<string>) {
    this.#displayPath = displayPath;
    this.#rootFd = rootFd;
    this.#rootMountId = rootMountId;
    this.#identity = rootIdentity;
    this.#deniedRootEntries = deniedRootEntries;
    ownedRoots.add(this);
  }

  static adopt(rootPath: string, options: RootedFileAuthorityOptions = {}): RootedFileAuthority {
    if (process.platform !== 'linux') {
      throw new Error(`Root-bound host file access is unavailable on ${process.platform}; this platform lacks the required package-owned handle-relative resolver.`);
    }
    if (typeof rootPath !== 'string' || rootPath.trim().length === 0) throw new TypeError('Root directory must be a non-empty path.');
    const displayPath = path.resolve(rootPath);
    let rootFd: number | undefined;
    try {
      rootFd = openHostDirectoryWithoutAliases(displayPath);
      const stat = fstatSync(rootFd, { bigint: true });
      if (!stat.isDirectory()) throw new Error(`Root path is not a directory: ${displayPath}`);
      const openedPath = readlinkSync(`/proc/self/fd/${String(rootFd)}`);
      if (openedPath.endsWith(' (deleted)')) throw new Error(`Root directory was removed during adoption: ${displayPath}`);
      const denied = ownDeniedEntries([...DEFAULT_DENIED_ROOT_ENTRIES, ...(options.additionalDeniedEntries ?? [])]);
      const mountId = readMountId(rootFd);
      const rootIdentity = Object.freeze({ canonicalPath: displayPath, device: String(stat.dev), inode: String(stat.ino), mountId });
      return new RootedFileAuthority(displayPath, rootFd, mountId, rootIdentity, denied);
    } catch (error) {
      if (rootFd !== undefined) closeSync(rootFd);
      throw error;
    }
  }

  get displayPath(): string { return this.#displayPath; }
  get identity(): RootIdentity { this.#assertOpen(); return this.#identity; }

  canonicalPath(requestedPath: string): string {
    this.#assertOpen();
    return normalizeRootedPath(requestedPath, this.#deniedRootEntries);
  }

  isReservedPath(requestedPath: string): boolean {
    this.#assertOpen();
    const segments = requestedPath.split('/').filter((segment) => segment !== '' && segment !== '.');
    return segments.some((segment) => this.#deniedRootEntries.has(segment) || segment.startsWith(RESERVED_ENTRY_PREFIX));
  }

  async openFile(requestedPath: string): Promise<RootedFileHandle> {
    const rootedDirectory = this.canonicalPath(requestedPath);
    if (rootedDirectory === '.') throw new ToolInputError('Root directory is not a regular file.', { path: requestedPath });
    const segments = rootedDirectory.split('/');
    const leaf = segments.pop();
    if (!leaf) throw new ToolInputError('Path does not identify a file.', { path: requestedPath });
    const parent = await this.#openDirectorySegments(segments, requestedPath);
    try {
      const handle = await open(`${fdPath(parent.handle.fd)}/${leaf}`, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
      try {
        this.#assertMount(handle.fd, requestedPath);
        const stat: BigIntStats = await handle.stat({ bigint: true });
        if (!stat.isFile()) throw new ToolInputError(`Path is not a regular file: ${requestedPath}`, { path: requestedPath });
        if (stat.nlink !== 1n) throw new ToolInputError(`Refusing a multiply linked file: ${requestedPath}`, { path: requestedPath, links: String(stat.nlink) });
        return makeRootedFileHandle(rootedDirectory, handle, stat, () => { this.#assertOpen(); });
      } catch (error) {
        await handle.close();
        throw error;
      }
    } catch (error) {
      if (nodeCode(error) === 'ELOOP') throw new ToolInputError(`Refusing a symbolic-link file path: ${requestedPath}`, { path: requestedPath });
      throw error;
    } finally {
      await parent.close();
    }
  }

  async fileIdentity(requestedPath: string): Promise<RootedFileIdentity> {
    const file = await this.openFile(requestedPath);
    try { return file.identity; }
    finally { await file.close(); }
  }

  async inspectPath(requestedPath: string): Promise<RootedPathStatus> {
    const rootedDirectory = this.canonicalPath(requestedPath);
    if (rootedDirectory === '.') {
      const directory = await this.openDirectory('.');
      try { return Object.freeze({ kind: 'directory', path: '.', identity: directory.identity, mode: directory.mode }); }
      finally { await directory.close(); }
    }
    const segments = rootedDirectory.split('/');
    const leaf = segments.pop();
    if (!leaf) throw new Error(`Invalid canonical rooted path: ${rootedDirectory}`);
    let parent;
    try { parent = await this.#openDirectorySegments(segments, requestedPath); }
    catch (error) {
      if (nodeCode(error) === 'ENOENT') return Object.freeze({ kind: 'absent', path: rootedDirectory });
      throw error;
    }
    try {
      let stat: BigIntStats;
      try { stat = await lstat(`${fdPath(parent.handle.fd)}/${leaf}`, { bigint: true }); }
      catch (error) {
        if (nodeCode(error) === 'ENOENT') return Object.freeze({ kind: 'absent', path: rootedDirectory });
        throw error;
      }
      if (stat.isSymbolicLink()) return Object.freeze({ kind: 'symlink', path: rootedDirectory });
      if (stat.isFile()) {
        const file = await this.openFile(rootedDirectory);
        try { return Object.freeze({ kind: 'file', path: rootedDirectory, identity: file.identity, size: file.size, mode: file.mode }); }
        finally { await file.close(); }
      }
      if (stat.isDirectory()) {
        const directory = await this.openDirectory(rootedDirectory);
        try { return Object.freeze({ kind: 'directory', path: rootedDirectory, identity: directory.identity, mode: directory.mode }); }
        finally { await directory.close(); }
      }
      return Object.freeze({ kind: 'other', path: rootedDirectory });
    } finally { await parent.close(); }
  }

  async missingParentDirectories(requestedFilePath: string): Promise<readonly string[]> {
    const rootedDirectory = this.canonicalPath(requestedFilePath);
    const segments = rootedDirectory.split('/');
    segments.pop();
    const missing: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = segments.slice(0, index + 1).join('/');
      if (missing.length > 0) { missing.push(candidate); continue; }
      try {
        const directory = await this.openDirectory(candidate);
        await directory.close();
      } catch (error) {
        if (nodeCode(error) === 'ENOENT') { missing.push(candidate); continue; }
        throw error;
      }
    }
    return Object.freeze(missing);
  }

  async openDirectory(requestedPath: string): Promise<RootedDirectoryHandle> {
    const rootedDirectory = this.canonicalPath(requestedPath);
    const opened = await this.#openDirectorySegments(rootedDirectory === '.' ? [] : rootedDirectory.split('/'), requestedPath);
    const stat: BigIntStats = await opened.handle.stat({ bigint: true });
    let closed = false;
    const assertOpen = () => {
      this.#assertOpen();
      if (closed) throw new Error(`Rooted directory handle is closed: ${rootedDirectory}`);
    };
    const authority: RootedDirectoryHandle = Object.freeze({
      path: rootedDirectory,
      identity: identity(stat),
      size: numberFromBigInt(stat.size, 'directory size'),
      mode: Number(stat.mode),
      async entries() {
        assertOpen();
        const dirents = await import('node:fs/promises').then(({ readdir }) => readdir(fdPath(opened.handle.fd), { withFileTypes: true }));
        return Object.freeze(dirents.map((entry) => Object.freeze({
          name: entry.name,
          type: entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : entry.isSymbolicLink() ? 'symlink' as const : 'other' as const
        })));
      },
      async close() {
        if (closed) return;
        closed = true;
        await opened.close();
      }
    });
    return authority;
  }

  /** Stable procfs path used only to hand a held directory to a child process. */
  async commandDirectory(requestedPath: string): Promise<{ readonly path: string; close(): Promise<void> }> {
    const rootedDirectory = this.canonicalPath(requestedPath);
    const directory = await this.#openDirectorySegments(rootedDirectory === '.' ? [] : rootedDirectory.split('/'), requestedPath);
    const commandPath = `/proc/${String(process.pid)}/fd/${String(directory.handle.fd)}`;
    let closed = false;
    const assertOpen = () => {
      this.#assertOpen();
      if (closed) throw new Error(`Rooted command directory is closed: ${rootedDirectory}`);
    };
    const authority: { readonly path: string; close(): Promise<void> } = Object.freeze({
      get path() {
        assertOpen();
        return commandPath;
      },
      async close() {
        if (closed) return;
        closed = true;
        await directory.close();
      }
    });
    return authority;
  }

  async [openMutationDirectory](requestedPath: string): Promise<RootedMutationDirectory> {
    const rootedDirectory = normalizeRootedPath(requestedPath, this.#deniedRootEntries, true);
    const directory = await this.#openDirectorySegments(rootedDirectory === '.' ? [] : rootedDirectory.split('/'), requestedPath);
    const base = fdPath(directory.handle.fd);
    let closed = false;
    const assertOpen = () => {
      this.#assertOpen();
      if (closed) throw new Error(`Rooted mutation directory is closed: ${rootedDirectory}`);
    };
    const entryPath = (name: string) => `${base}/${normalizeLeafName(name)}`;
    const authority: RootedMutationDirectory = Object.freeze({
      path: rootedDirectory,
      async status(name: string) {
        assertOpen();
        const leaf = normalizeLeafName(name);
        let stat: BigIntStats;
        try { stat = await lstat(entryPath(leaf), { bigint: true }); }
        catch (error) { if (nodeCode(error) === 'ENOENT') return Object.freeze({ kind: 'absent', path: joinPath(rootedDirectory, leaf) }); throw error; }
        const resultPath = joinPath(rootedDirectory, leaf);
        if (stat.isSymbolicLink()) return Object.freeze({ kind: 'symlink', path: resultPath });
        if (stat.isFile()) return Object.freeze({ kind: 'file', path: resultPath, identity: identity(stat), size: numberFromBigInt(stat.size, 'file size'), mode: Number(stat.mode) });
        if (stat.isDirectory()) return Object.freeze({ kind: 'directory', path: resultPath, identity: identity(stat), mode: Number(stat.mode) });
        return Object.freeze({ kind: 'other', path: resultPath });
      },
      async writeExclusive(name: string, content: string, mode: number) {
        assertOpen();
        const handle = await open(entryPath(name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode & 0o777);
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
      },
      async readFile(name: string, maxBytes: number) {
        assertOpen();
        const handle = await open(entryPath(name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const stat: BigIntStats = await handle.stat({ bigint: true });
          if (!stat.isFile()) throw new Error(`Rooted transaction entry is not a regular file: ${name}`);
          if (stat.size > BigInt(maxBytes)) throw new Error(`Rooted transaction entry exceeds the read limit: ${name}`);
          return await handle.readFile();
        } finally { await handle.close(); }
      },
      async createDirectory(name: string, mode: number) { assertOpen(); await mkdir(entryPath(name), { mode: mode & 0o777 }); },
      async rename(sourceName: string, destinationName: string) { assertOpen(); await rename(entryPath(sourceName), entryPath(destinationName)); },
      async link(sourceName: string, destinationName: string) { assertOpen(); await link(entryPath(sourceName), entryPath(destinationName)); },
      async removeFile(name: string) { assertOpen(); try { await unlink(entryPath(name)); } catch (error) { if (nodeCode(error) !== 'ENOENT') throw error; } },
      async removeDirectory(name: string) { assertOpen(); await rmdir(entryPath(name)); },
      async sync() { assertOpen(); await directory.handle.sync(); },
      async close() { if (closed) return; closed = true; await directory.close(); }
    });
    return authority;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#rootFd);
  }

  async #openDirectorySegments(segments: readonly string[], requestedPath: string): Promise<{ readonly handle: FileHandle; close(): Promise<void> }> {
    this.#assertOpen();
    // This path is the package-owned descriptor reference itself. Following
    // that one procfs magic link duplicates the held authority; every
    // caller-controlled component opened below it still uses O_NOFOLLOW.
    let current = await open(fdPath(this.#rootFd), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      this.#assertMount(current.fd, requestedPath);
      for (const segment of segments) {
        let next: FileHandle;
        try {
          next = await open(`${fdPath(current.fd)}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        } catch (error) {
          if (nodeCode(error) === 'ELOOP' || nodeCode(error) === 'ENOTDIR') {
            throw new ToolInputError(`Refusing an aliased or non-directory path component: ${requestedPath}`, { path: requestedPath, segment });
          }
          throw error;
        }
        try { this.#assertMount(next.fd, requestedPath); }
        catch (error) { await next.close(); throw error; }
        await current.close();
        current = next;
      }
      let closed = false;
      return {
        handle: current,
        async close() {
          if (closed) return;
          closed = true;
          await current.close();
        }
      };
    } catch (error) {
      await current.close();
      throw error;
    }
  }

  #assertMount(fd: number, requestedPath: string): void {
    const mountId = readMountId(fd);
    if (mountId !== this.#rootMountId) {
      throw new ToolInputError(`Path crosses the adopted root mount: ${requestedPath}`, { path: requestedPath });
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Rooted file authority has been released.');
  }
}

/** Package-internal mutation authority. It is deliberately absent from the package entrypoint. */
export function openRootedMutationDirectory(root: RootedFileAuthority, requestedPath: string): Promise<RootedMutationDirectory> {
  if (!isRootedFileAuthority(root)) throw new TypeError('Rooted mutations require an adopted RootedFileAuthority.');
  return root[openMutationDirectory](requestedPath);
}

export function isRootedFileAuthority(value: unknown): value is RootedFileAuthority {
  return typeof value === 'object' && value !== null && ownedRoots.has(value as RootedFileAuthority);
}

export function rootedFileIdentitiesEqual(left: RootedFileIdentity, right: RootedFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode && left.links === right.links
    && left.size === right.size && left.modifiedNanoseconds === right.modifiedNanoseconds && left.changedNanoseconds === right.changedNanoseconds;
}

function makeRootedFileHandle(pathValue: string, handle: FileHandle, stat: BigIntStats, assertRootOpen: () => void): RootedFileHandle {
  let closed = false;
  const initial = identity(stat);
  const assertOpen = () => {
    assertRootOpen();
    if (closed) throw new Error(`Rooted file handle is closed: ${pathValue}`);
  };
  return Object.freeze({
    path: pathValue,
    identity: initial,
    size: numberFromBigInt(stat.size, 'file size'),
    mode: Number(stat.mode),
    descriptor: handle.fd,
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      assertOpen();
      return (await handle.read(buffer, offset, length, position)).bytesRead;
    },
    async readAll(maxBytes: number) {
      assertOpen();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Maximum read bytes must be a non-negative safe integer.');
      const current: BigIntStats = await handle.stat({ bigint: true });
      if (current.size > BigInt(maxBytes)) throw new ToolInputError(`File exceeds the read limit: ${pathValue}`, { path: pathValue, bytes: String(current.size), maxBytes });
      return handle.readFile();
    },
    async identityNow() {
      assertOpen();
      const current: BigIntStats = await handle.stat({ bigint: true });
      return identity(current);
    },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    }
  });
}

function identity(stat: BigIntStats): RootedFileIdentity {
  return Object.freeze({
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), links: String(stat.nlink), size: String(stat.size),
    modifiedNanoseconds: String(stat.mtimeNs), changedNanoseconds: String(stat.ctimeNs)
  });
}

function normalizeRootedPath(requestedPath: string, deniedRootEntries: ReadonlySet<string>, allowReservedInternal = false): string {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) throw new ToolInputError('Path cannot be empty.', { path: requestedPath });
  if (requestedPath.includes('\0')) throw new ToolInputError('Path contains a null byte.', { path: requestedPath });
  if (requestedPath.includes('\\')) throw new ToolInputError('Backslash path separators are not accepted.', { path: requestedPath });
  if (path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath) || requestedPath.startsWith('//')) {
    throw new ToolInputError(`Absolute, UNC, and device paths are not allowed: ${requestedPath}`, { path: requestedPath });
  }
  const segments = requestedPath.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) throw new ToolInputError(`Path escapes configured root: ${requestedPath}`, { path: requestedPath });
  if (!allowReservedInternal && segments.some((segment) => deniedRootEntries.has(segment) || segment.startsWith(RESERVED_ENTRY_PREFIX))) {
    throw new ToolInputError(`Path is reserved by the host application: ${requestedPath}`, { path: requestedPath });
  }
  return segments.join('/') || '.';
}

function normalizeLeafName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new TypeError(`Invalid rooted mutation entry name: ${name}`);
  }
  return name;
}

function joinPath(parent: string, name: string): string { return parent === '.' ? name : `${parent}/${name}`; }

function ownDeniedEntries(values: readonly string[]): ReadonlySet<string> {
  const entries = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
      throw new TypeError(`Invalid denied root entry: ${value}`);
    }
    entries.add(value);
  }
  return entries;
}

function fdPath(fd: number): string { return `/proc/self/fd/${String(fd)}`; }

/** Package-internal adoption primitive. It is deliberately absent from the package entrypoint. */
export function openHostDirectoryWithoutAliases(absolutePath: string): number {
  if (process.platform !== 'linux') throw new Error(`Handle-relative host directory adoption is unavailable on ${process.platform}.`);
  let current = openSync('/', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    for (const segment of absolutePath.split('/').filter(Boolean)) {
      let next: number;
      try {
        next = openSync(`${fdPath(current)}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      } catch (error) {
        if (nodeCode(error) === 'ELOOP' || nodeCode(error) === 'ENOTDIR') throw new Error(`Root path contains an aliased or non-directory component: ${absolutePath}`, { cause: error });
        throw error;
      }
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

function readMountId(fd: number): string {
  const info = readFileSyncUtf8(`/proc/self/fdinfo/${String(fd)}`);
  const match = /^mnt_id:\s*(\d+)$/mu.exec(info);
  if (!match?.[1]) throw new Error(`Cannot establish mount identity for file descriptor ${String(fd)}.`);
  return match[1];
}

function readFileSyncUtf8(filePath: string): string { return readFileSync(filePath, 'utf8'); }

function numberFromBigInt(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} exceeds the supported safe-integer range.`);
  return number;
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
