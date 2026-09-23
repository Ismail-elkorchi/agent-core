import { isWorkspaceFiles, type WorkspaceFileRevision } from '@agent-core/tools';
import { rootedFileIdentitiesEqual, type RootedFileIdentity } from './rooted-file-authority.js';
import type { FileAuthority } from './rooted-files.js';

export type FileReadIdentity =
  | { readonly kind: 'rooted'; readonly value: RootedFileIdentity }
  | { readonly kind: 'workspace'; readonly value: WorkspaceFileRevision };

/** A bounded reader whose verification binds all returned bytes to one source. */
export interface FileRead {
  readonly size: number;
  readonly mode: number;
  readonly identity: FileReadIdentity;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  verify(digest: string): Promise<boolean>;
  close(): Promise<void>;
}

export class FileChangedError extends Error {
  constructor(pathname: string) {
    super(`File changed while reading: ${pathname}`);
    this.name = 'FileChangedError';
  }
}

export async function openFileRead(root: FileAuthority, pathname: string): Promise<FileRead> {
  if (!isWorkspaceFiles(root)) {
    const handle = await root.openFile(pathname);
    return {
      size: handle.size,
      mode: handle.mode,
      identity: { kind: 'rooted', value: handle.identity },
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      async verify() {
        return rootedFileIdentitiesEqual(handle.identity, await handle.identityNow())
          && rootedFileIdentitiesEqual(handle.identity, await root.fileIdentity(pathname));
      },
      close: () => handle.close()
    };
  }
  const status = await root.stat(pathname);
  if (status.kind !== 'file')
    throw Object.assign(new Error(`Not a regular file: ${pathname}`), {
      code: status.kind === 'absent' ? 'ENOENT' : 'EINVAL'
    });
  return {
    size: status.revision.size,
    mode: status.mode,
    identity: { kind: 'workspace', value: status.revision },
    async read(buffer, offset, length, position) {
      const range = await root.readRange(pathname, { offset: position, length });
      if (!sameRevision(range.revision, status.revision)) throw new FileChangedError(pathname);
      buffer.set(range.bytes, offset);
      return range.bytes.byteLength;
    },
    async verify(digest) {
      const current = await root.stat(pathname);
      return digest === status.revision.digest && current.kind === 'file'
        && current.mode === status.mode && sameRevision(current.revision, status.revision);
    },
    close: () => Promise.resolve()
  };
}

function sameRevision(left: WorkspaceFileRevision, right: WorkspaceFileRevision): boolean {
  return left.size === right.size && left.digest === right.digest;
}
