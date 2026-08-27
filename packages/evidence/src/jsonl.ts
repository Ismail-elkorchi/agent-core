import { promises as fs } from 'node:fs';
import type { JsonValue } from '@agent-core/json';
import { canonicalJsonString } from './ledger.js';

const SCAN_CHUNK_BYTES = 64 * 1024;

export interface JsonlLine {
  readonly text: string;
  readonly line: number;
  readonly byteOffset: number;
  readonly terminated: true;
}

export interface JsonlCommittedFile {
  readonly completeBytes: number;
  readonly storageBytes: number;
  readonly lines: readonly JsonlLine[];
}

export interface JsonlStorageStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface JsonlLineReadOptions {
  readonly startOffset?: number;
  readonly firstLine?: number;
  readonly endOffset?: number;
  readonly maxLineBytes?: number;
}

/** Reads only newline-committed records. A trailing fragment is never parsed. */
export async function readJsonlCommittedFile(filePath: string): Promise<JsonlCommittedFile> {
  const storageBytes = (await fs.stat(filePath)).size;
  const completeBytes = await jsonlCommittedBytes(filePath, storageBytes);
  const bytes = await readJsonlBytes(filePath, 0, completeBytes);
  return Object.freeze({ completeBytes, storageBytes, lines: Object.freeze(splitJsonlLines(bytes)) });
}

/** Finds the final newline by scanning backwards in bounded chunks without a distance cutoff. */
export async function jsonlCommittedBytes(filePath: string, knownSize?: number): Promise<number> {
  const size = knownSize ?? (await fs.stat(filePath)).size;
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - SCAN_CHUNK_BYTES);
    const chunk = await readJsonlBytes(filePath, start, cursor - start);
    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      if (chunk[index] === 10) return start + index + 1;
    }
    cursor = start;
  }
  return 0;
}

export async function appendJsonlRecord(filePath: string, record: JsonValue): Promise<number> {
  const serialized = `${canonicalJsonString(record)}\n`;
  const handle = await fs.open(filePath, 'a');
  try {
    await handle.write(serialized, null, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Buffer.byteLength(serialized, 'utf8');
}

export async function readJsonlBytes(filePath: string, offset: number, length: number): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array();
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Streams complete JSONL lines with bounded retained memory. Offsets must be record boundaries. */
export async function* readJsonlLines(filePath: string, options: JsonlLineReadOptions = {}): AsyncIterable<JsonlLine> {
  const startOffset = options.startOffset ?? 0;
  const firstLine = options.firstLine ?? 1;
  const endOffset = options.endOffset ?? await jsonlCommittedBytes(filePath);
  const maxLineBytes = options.maxLineBytes ?? 8_500_000;
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || !Number.isSafeInteger(endOffset) || endOffset < startOffset) {
    throw new RangeError('JSONL stream offsets are invalid.');
  }
  if (!Number.isSafeInteger(firstLine) || firstLine < 1 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError('JSONL stream bounds are invalid.');
  }
  const handle = await fs.open(filePath, 'r');
  let cursor = startOffset;
  let line = firstLine;
  let pending = Buffer.alloc(0);
  try {
    while (cursor < endOffset) {
      const length = Math.min(SCAN_CHUNK_BYTES, endOffset - cursor);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, cursor);
      if (bytesRead === 0) throw new Error(`JSONL file ended before committed offset ${String(endOffset)}.`);
      cursor += bytesRead;
      pending = pending.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      if (pending.length > maxLineBytes && pending.indexOf(10) < 0) throw new Error(`JSONL line exceeds ${String(maxLineBytes)} bytes.`);
      let start = 0;
      for (;;) {
        const newline = pending.indexOf(10, start);
        if (newline < 0) break;
        const byteOffset = cursor - pending.length + start;
        yield Object.freeze({ text: pending.subarray(start, newline).toString('utf8'), line, byteOffset, terminated: true });
        line += 1;
        start = newline + 1;
      }
      pending = pending.subarray(start);
      if (pending.length > maxLineBytes) throw new Error(`JSONL line exceeds ${String(maxLineBytes)} bytes.`);
    }
    if (pending.length !== 0) throw new Error('JSONL committed range did not end at a line boundary.');
  } finally {
    await handle.close();
  }
}

export function splitJsonlLines(bytes: Uint8Array, firstLine = 1, baseOffset = 0): JsonlLine[] {
  const output: JsonlLine[] = [];
  let start = 0;
  let line = firstLine;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    output.push({
      text: new TextDecoder().decode(bytes.slice(start, index)),
      line,
      byteOffset: baseOffset + start,
      terminated: true
    });
    start = index + 1;
    line += 1;
  }
  return output;
}

export async function jsonlBoundaryMarker(filePath: string, offset: number): Promise<string> {
  const start = Math.max(0, offset - 256);
  return Buffer.from(await readJsonlBytes(filePath, start, offset - start)).toString('base64');
}

export async function jsonlStorageStamp(filePath: string): Promise<JsonlStorageStamp> {
  const stat = await fs.stat(filePath);
  return Object.freeze({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
}

export function sameJsonlStorageStamp(left: JsonlStorageStamp, right: JsonlStorageStamp): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
