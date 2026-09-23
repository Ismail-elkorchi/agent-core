/** Provider-neutral file authority used by tools that operate inside a workspace. */
export interface WorkspaceFileDescriptor {
  readonly implementationId: string;
  readonly workspaceId: string;
  readonly displayRoot: string;
  readonly capabilities: readonly ('read' | 'write' | 'transaction')[];
}

export interface WorkspaceFileRevision {
  readonly size: number;
  readonly digest: string;
}

export type WorkspacePathStatus =
  | { readonly kind: 'absent'; readonly path: string }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly mode: number;
      readonly revision: WorkspaceFileRevision;
    }
  | { readonly kind: 'directory'; readonly path: string; readonly mode: number }
  | { readonly kind: 'symlink' | 'other'; readonly path: string };

export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
}

export type WorkspaceFileExpectation =
  | { readonly kind: 'any' }
  | { readonly kind: 'absent' }
  | ({ readonly kind: 'matches' } & WorkspaceFileRevision);

export type WorkspaceFileMutation =
  | {
      readonly kind: 'write';
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly mode: number;
      readonly expected: WorkspaceFileExpectation;
    }
  | {
      readonly kind: 'remove';
      readonly path: string;
      readonly expected: WorkspaceFileExpectation;
    };

export interface WorkspaceFiles {
  readonly descriptor: WorkspaceFileDescriptor;
  /** Return a normalized path relative to this workspace or reject it. */
  normalize(path: string): string;
  stat(path: string): Promise<WorkspacePathStatus>;
  list(path: string): AsyncIterable<WorkspaceDirectoryEntry>;
  /** Read at most length bytes from offset, identifying the complete source revision. */
  readRange(
    path: string,
    range: { readonly offset: number; readonly length: number }
  ): Promise<{ readonly bytes: Uint8Array; readonly revision: WorkspaceFileRevision }>;
  readFile(
    path: string,
    options?: { readonly maximumBytes?: number }
  ): Promise<{ readonly bytes: Uint8Array; readonly revision: WorkspaceFileRevision }>;
  transaction(mutations: readonly WorkspaceFileMutation[]): Promise<void>;
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number }
  ): Promise<void>;
  remove(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  close(): void | Promise<void>;
}

const adoptedWorkspaceFiles = new WeakSet();

export function adoptWorkspaceFiles(value: unknown): WorkspaceFiles {
  if (isWorkspaceFiles(value)) return value;
  if (typeof value !== 'object' || value === null)
    throw new TypeError('Workspace file authority must be an object.');
  const candidate = value as Record<string, unknown>;
  const suppliedDescriptor = candidate.descriptor;
  if (typeof suppliedDescriptor !== 'object' || suppliedDescriptor === null || Array.isArray(suppliedDescriptor))
    throw new TypeError('Workspace file descriptor is invalid.');
  const descriptor = suppliedDescriptor as Record<string, unknown>;
  if (
    !validIdentity(descriptor.implementationId) ||
    !validIdentity(descriptor.workspaceId) ||
    typeof descriptor.displayRoot !== 'string' ||
    descriptor.displayRoot.length === 0 ||
    !Array.isArray(descriptor.capabilities) ||
    descriptor.capabilities.some(
      (item: unknown) => item !== 'read' && item !== 'write' && item !== 'transaction'
    ) ||
    new Set(descriptor.capabilities).size !== descriptor.capabilities.length ||
    !Object.isFrozen(descriptor) ||
    !Object.isFrozen(descriptor.capabilities)
  )
    throw new TypeError('Workspace file descriptor is invalid.');
  for (const method of [
    'normalize',
    'stat',
    'list',
    'readRange',
    'readFile',
    'transaction',
    'mkdir',
    'remove',
    'close'
  ] as const)
    if (typeof candidate[method] !== 'function')
      throw new TypeError(`Workspace file authority is missing ${method}.`);
  adoptedWorkspaceFiles.add(value);
  return value as WorkspaceFiles;
}

export function isWorkspaceFiles(value: unknown): value is WorkspaceFiles {
  return typeof value === 'object' && value !== null && adoptedWorkspaceFiles.has(value);
}

function validIdentity(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  )
    return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return false;
  }
  return true;
}
