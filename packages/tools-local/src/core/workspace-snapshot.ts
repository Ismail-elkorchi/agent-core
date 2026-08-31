import { createHash } from 'node:crypto';
import { rootedFileIdentitiesEqual, type RootedFileAuthority } from './rooted-file-authority.js';

const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 64;

export interface WorkspaceSnapshotEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly mode?: number;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly content?: 'text' | 'binary';
}

export interface WorkspaceSnapshot {
  readonly digest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly entries: readonly WorkspaceSnapshotEntry[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

/** Captures an exact root-bound file state, excluding authority-reserved metadata. */
export async function captureWorkspaceSnapshot(root: RootedFileAuthority, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  const entries: WorkspaceSnapshotEntry[] = [];
  const causes = new Set<string>();
  let totalBytes = 0;
  let stopped = false;

  const walk = async (directoryPath: string, depth: number): Promise<void> => {
    if (stopped) return;
    throwIfAborted(signal);
    if (depth > MAX_DEPTH) { causes.add('depth_limit'); return; }
    const directory = await root.openDirectory(directoryPath);
    let children;
    try { children = [...await directory.entries()].sort((left, right) => compareCodeUnits(left.name, right.name)); }
    finally { await directory.close(); }
    for (const child of children) {
      throwIfAborted(signal);
      const childPath = directoryPath === '.' ? child.name : `${directoryPath}/${child.name}`;
      if (root.isReservedPath(childPath)) continue;
      if (entries.length >= MAX_ENTRIES) { causes.add('entry_limit'); stopped = true; break; }
      if (child.type === 'directory') {
        const handle = await root.openDirectory(childPath);
        try { entries.push(Object.freeze({ path: childPath, kind: 'directory', mode: handle.mode })); }
        finally { await handle.close(); }
        await walk(childPath, depth + 1);
        continue;
      }
      if (child.type !== 'file') {
        entries.push(Object.freeze({ path: childPath, kind: child.type }));
        causes.add(child.type === 'symlink' ? 'symbolic_link' : 'special_file');
        continue;
      }
      const file = await root.openFile(childPath);
      try {
        if (file.size > MAX_FILE_BYTES) {
          entries.push(Object.freeze({ path: childPath, kind: 'file', mode: file.mode, bytes: file.size }));
          causes.add('file_size_limit');
          continue;
        }
        if (totalBytes + file.size > MAX_TOTAL_BYTES) {
          entries.push(Object.freeze({ path: childPath, kind: 'file', mode: file.mode, bytes: file.size }));
          causes.add('total_byte_limit');
          stopped = true;
          break;
        }
        const identity = file.identity;
        const content = await file.readAll(MAX_FILE_BYTES);
        if (!rootedFileIdentitiesEqual(identity, await file.identityNow())
          || !rootedFileIdentitiesEqual(identity, await root.fileIdentity(childPath))) {
          causes.add('concurrent_change');
          continue;
        }
        totalBytes += content.byteLength;
        entries.push(Object.freeze({
          path: childPath,
          kind: 'file',
          mode: file.mode,
          bytes: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'),
          content: fileContentKind(content)
        }));
      } catch {
        if (signal?.aborted) throwIfAborted(signal);
        causes.add('unreadable_file');
      } finally { await file.close(); }
    }
  };

  try { await walk('.', 1); }
  catch {
    if (signal?.aborted) throwIfAborted(signal);
    causes.add('unreadable_directory');
  }
  const ownedEntries = Object.freeze([...entries]);
  return Object.freeze({
    digest: createHash('sha256').update(JSON.stringify(ownedEntries)).digest('hex'),
    coverage: causes.size === 0 ? 'complete' : 'partial',
    causes: Object.freeze([...causes].sort(compareCodeUnits)),
    entries: ownedEntries,
    fileCount: ownedEntries.filter((entry) => entry.kind === 'file' && entry.sha256 !== undefined).length,
    totalBytes
  });
}

export function changedWorkspacePaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): readonly string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  return Object.freeze([...paths]
    .filter((entryPath) => JSON.stringify(beforeByPath.get(entryPath)) !== JSON.stringify(afterByPath.get(entryPath)))
    .sort(compareCodeUnits));
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Workspace snapshot aborted.');
}
function fileContentKind(content: Uint8Array): 'text' | 'binary' {
  if (content.includes(0)) return 'binary';
  try { new TextDecoder('utf-8', { fatal: true }).decode(content); return 'text'; }
  catch { return 'binary'; }
}
