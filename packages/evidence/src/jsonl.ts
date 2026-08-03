import { promises as fs } from 'node:fs';

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

export async function appendJsonlRecord(filePath: string, record: unknown): Promise<number> {
  const serialized = `${JSON.stringify(record)}\n`;
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
