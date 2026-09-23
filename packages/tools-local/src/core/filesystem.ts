import { createHash } from 'node:crypto';
import { ToolInputError } from '@agent-core/tools';
import { canonicalFilePath, type FileAuthority } from './rooted-files.js';
import { openFileRead } from './file-read.js';
import type { FileRevision } from './file-transaction.js';

export type TextFileFailureReason = 'not_found' | 'not_file' | 'binary' | 'invalid_utf8' | 'too_large' | 'symlink' | 'path_outside_root' | 'unsafe_link';

export interface TextFileFailure {
  readonly path: string;
  readonly reason: TextFileFailureReason;
  readonly message: string;
  readonly bytes?: number;
}

export interface TextFileData extends FileRevision {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
}

export async function inspectTextFile(root: FileAuthority, requestedPath: string, maxBytes: number): Promise<
  | { readonly ok: true; readonly file: TextFileData }
  | { readonly ok: false; readonly failure: TextFileFailure }
> {
  let displayPath: string;
  try { displayPath = canonicalFilePath(root, requestedPath); }
  catch (error) {
    if (error instanceof ToolInputError) return { ok: false, failure: { path: requestedPath, reason: 'path_outside_root', message: error.message } };
    throw error;
  }
  let handle;
  try { handle = await openFileRead(root, displayPath); }
  catch (error) {
    const code = nodeCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ENOENT') return { ok: false, failure: { path: displayPath, reason: 'not_found', message } };
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
    const buffer = Buffer.alloc(handle.size);
    let position = 0;
    while (position < buffer.length) {
      const count = await handle.read(buffer, position, Math.min(64 * 1024, buffer.length - position), position);
      if (count === 0) throw new Error(`File ended while reading: ${requestedPath}`);
      position += count;
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (!await handle.verify(sha256))
      return { ok: false, failure: { path: displayPath, reason: 'not_file', message: `File changed while reading: ${requestedPath}` } };
    if (isProbablyBinary(buffer)) return { ok: false, failure: { path: displayPath, reason: 'binary', message: `Refusing probable binary file: ${requestedPath}`, bytes: handle.size } };
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { return { ok: false, failure: { path: displayPath, reason: 'invalid_utf8', message: `File is not valid UTF-8 text: ${requestedPath}`, bytes: handle.size } }; }
    return { ok: true, file: Object.freeze({
      path: displayPath, bytes: handle.size, mode: handle.mode, identity,
      sha256,
      content
    }) };
  } finally { await handle.close(); }
}

export function byteLengthUtf8(content: string): number { return Buffer.byteLength(content, 'utf8'); }
export function sha256Text(content: string): string { return createHash('sha256').update(content).digest('hex'); }

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
