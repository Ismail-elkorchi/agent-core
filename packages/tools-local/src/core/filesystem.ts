import { createHash } from 'node:crypto';
import { splitLogicalLines, ToolInputError } from '@agent-core/tools';
import { workspaceFileIdentitiesEqual, type WorkspaceFileIdentity, type WorkspaceFileRoot } from './workspace-file-root.js';

export type TextFileFailureReason = 'not_found' | 'not_file' | 'binary' | 'too_large' | 'symlink' | 'path_outside_workspace' | 'unsafe_link';

export interface TextFileFailure {
  readonly path: string;
  readonly reason: TextFileFailureReason;
  readonly message: string;
  readonly bytes?: number;
}

export interface TextFileData {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly identity: WorkspaceFileIdentity;
  readonly content: string;
  readonly lines: readonly string[];
}

export async function inspectTextFile(root: WorkspaceFileRoot, requestedPath: string, maxBytes: number): Promise<
  | { readonly ok: true; readonly file: TextFileData }
  | { readonly ok: false; readonly failure: TextFileFailure }
> {
  let displayPath: string;
  try { displayPath = root.canonicalPath(requestedPath); }
  catch (error) {
    if (error instanceof ToolInputError) return { ok: false, failure: { path: requestedPath, reason: 'path_outside_workspace', message: error.message } };
    throw error;
  }
  let handle;
  try { handle = await root.openFile(displayPath); }
  catch (error) {
    const code = nodeCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (/symbolic-link/iu.test(message)) return { ok: false, failure: { path: displayPath, reason: 'symlink', message } };
    if (/multiply linked/iu.test(message)) return { ok: false, failure: { path: displayPath, reason: 'unsafe_link', message } };
    if (/not a regular file/iu.test(message)) return { ok: false, failure: { path: displayPath, reason: 'not_file', message } };
    return { ok: false, failure: { path: displayPath, reason: code === 'ENOENT' ? 'not_found' : 'not_file', message } };
  }
  try {
    if (handle.size > maxBytes) {
      return { ok: false, failure: { path: displayPath, reason: 'too_large', message: `File is too large to read inline (${String(handle.size)} bytes, max ${String(maxBytes)}): ${requestedPath}`, bytes: handle.size } };
    }
    const identity = handle.identity;
    const buffer = await handle.readAll(maxBytes);
    if (!workspaceFileIdentitiesEqual(await handle.identityNow(), identity)) {
      return { ok: false, failure: { path: displayPath, reason: 'not_file', message: `File changed while it was being read: ${requestedPath}` } };
    }
    try {
      if (!workspaceFileIdentitiesEqual(await root.fileIdentity(displayPath), identity)) return { ok: false, failure: { path: displayPath, reason: 'not_file', message: `File was replaced while it was being read: ${requestedPath}` } };
    } catch { return { ok: false, failure: { path: displayPath, reason: 'not_file', message: `File was replaced while it was being read: ${requestedPath}` } }; }
    if (isProbablyBinary(buffer)) return { ok: false, failure: { path: displayPath, reason: 'binary', message: `Refusing probable binary file: ${requestedPath}`, bytes: handle.size } };
    const content = buffer.toString('utf8');
    return { ok: true, file: Object.freeze({ path: displayPath, bytes: handle.size, mode: handle.mode, identity, content, lines: Object.freeze(splitTextLines(content)) }) };
  } finally { await handle.close(); }
}

export function byteLengthUtf8(content: string): number { return Buffer.byteLength(content, 'utf8'); }
export function sha256Text(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export function splitTextLines(content: string): string[] { return splitLogicalLines(content).lines; }

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  return sample.length > 0 && suspicious / sample.length > 0.2;
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
