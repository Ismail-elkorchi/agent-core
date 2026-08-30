import { createHash } from 'node:crypto';
import { splitLogicalLines, ToolInputError } from '@agent-core/tools';
import { rootedFileIdentitiesEqual, type RootedFileIdentity, type RootedFileAuthority } from './rooted-file-authority.js';

export type TextFileFailureReason = 'not_found' | 'not_file' | 'binary' | 'invalid_utf8' | 'too_large' | 'symlink' | 'path_outside_root' | 'unsafe_link';

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
  readonly identity: RootedFileIdentity;
  readonly sha256: string;
  readonly content: string;
  readonly lines: readonly string[];
}

export async function inspectTextFile(root: RootedFileAuthority, requestedPath: string, maxBytes: number): Promise<
  | { readonly ok: true; readonly file: TextFileData }
  | { readonly ok: false; readonly failure: TextFileFailure }
> {
  let displayPath: string;
  try { displayPath = root.canonicalPath(requestedPath); }
  catch (error) {
    if (error instanceof ToolInputError) return { ok: false, failure: { path: requestedPath, reason: 'path_outside_root', message: error.message } };
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
    if (!rootedFileIdentitiesEqual(await handle.identityNow(), identity)) {
      return { ok: false, failure: { path: displayPath, reason: 'not_file', message: `File changed while it was being read: ${requestedPath}` } };
    }
    try {
      if (!rootedFileIdentitiesEqual(await root.fileIdentity(displayPath), identity)) return { ok: false, failure: { path: displayPath, reason: 'not_file', message: `File was replaced while it was being read: ${requestedPath}` } };
    } catch { return { ok: false, failure: { path: displayPath, reason: 'not_file', message: `File was replaced while it was being read: ${requestedPath}` } }; }
    if (isProbablyBinary(buffer)) return { ok: false, failure: { path: displayPath, reason: 'binary', message: `Refusing probable binary file: ${requestedPath}`, bytes: handle.size } };
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { return { ok: false, failure: { path: displayPath, reason: 'invalid_utf8', message: `File is not valid UTF-8 text: ${requestedPath}`, bytes: handle.size } }; }
    return { ok: true, file: Object.freeze({
      path: displayPath, bytes: handle.size, mode: handle.mode, identity,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      content, lines: Object.freeze(splitTextLines(content))
    }) };
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
