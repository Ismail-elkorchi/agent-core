import { createHash } from 'node:crypto';
import { rootedFileIdentitiesEqual, type RootedFileAuthority } from './rooted-file-authority.js';

/** Read an exact UTF-8 snapshot through the caller's adopted file authority. */
export async function readRootedText(
  root: RootedFileAuthority,
  requestedPath: string,
  maxBytes: number,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const file = await root.openFile(requestedPath);
  try {
    const bytes = await file.readAll(maxBytes);
    signal?.throwIfAborted();
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (
      !rootedFileIdentitiesEqual(file.identity, await file.identityNow()) ||
      !rootedFileIdentitiesEqual(file.identity, await root.fileIdentity(requestedPath))
    )
      throw new Error(`File changed while it was being read: ${file.path}`);
    return { path: file.path, content, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await file.close();
  }
}
