import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { requireWorkspaceRoot, type ToolExecutionContext, type ToolObservation } from '@agent-core/tools';
import { assertRealPathInsideRoot, relativePath, resolveInsideRoot } from '../../core/filesystem.js';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import type { ReadFileFailure, ReadFileResult, ReadFilesInput, ReadFilesOutput } from './schema.js';

export async function readFiles(input: ReadFilesInput, context: ToolExecutionContext): Promise<ToolObservation<ReadFilesOutput>> {
  const root = requireWorkspaceRoot(context);
  const limits = requireLocalToolConfiguration(context).readFiles;
  const requested = input.files.slice(0, limits.maxFiles);
  const files: ReadFileResult[] = [];
  const failures: ReadFileFailure[] = [];
  let remainingBytes = limits.maxTotalBytes;

  for (const request of requested) {
    const lineCount = Math.min(request.lineCount ?? limits.maxLinesPerFile, limits.maxLinesPerFile);
    const result = await readRange(root, request.path, request.startLine, lineCount, Math.min(limits.maxBytesPerFile, remainingBytes));
    if (result.ok) {
      files.push(result.value);
      remainingBytes -= result.value.bytes;
    } else {
      failures.push(result.failure);
    }
  }
  for (const request of input.files.slice(limits.maxFiles)) {
    failures.push({ path: request.path, reason: 'range_too_large', message: `The host accepts at most ${String(limits.maxFiles)} files in one batch.` });
  }
  const returnedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const coverage = failures.length === 0 ? 'complete' : 'partial';
  const output: ReadFilesOutput = {
    files,
    failures,
    coverage,
    requestedFiles: input.files.length,
    returnedFiles: files.length,
    failedFiles: failures.length,
    returnedBytes
  };
  return {
    kind: 'result',
    ok: failures.length === 0,
    summary: `Read ${String(files.length)} of ${String(input.files.length)} requested files${coverage === 'partial' ? ' with partial coverage' : ''}.`,
    scope: {
      resources: input.files.map((file) => `workspace/files/${file.path}`),
      coverage,
      ...(coverage === 'partial' ? { cause: `${String(failures.length)} file ranges could not be returned` } : {})
    },
    output
  };
}

type RangeRead = { ok: true; value: ReadFileResult } | { ok: false; failure: ReadFileFailure };

async function readRange(root: string, requestedPath: string, startLine: number, lineCount: number, maxBytes: number): Promise<RangeRead> {
  let absolute: string;
  try { absolute = resolveInsideRoot(root, requestedPath); }
  catch (error) { return failure(requestedPath, 'path_outside_workspace', errorMessage(error)); }
  const displayPath = relativePath(root, absolute);
  let handle: FileHandle;
  let stat;
  try {
    stat = await fs.stat(absolute);
    if (!stat.isFile()) return failure(displayPath, 'not_file', `Path is not a regular file: ${requestedPath}`);
    await assertRealPathInsideRoot(root, absolute, requestedPath);
    handle = await fs.open(absolute, 'r');
  } catch (error) {
    const code = nodeCode(error);
    return failure(displayPath || requestedPath, code === 'ENOENT' ? 'not_found' : 'unreadable', errorMessage(error));
  }

  try {
    const selected: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let line = 1;
    let selectedLines = 0;
    let selectedBytes = 0;
    let selectionComplete = false;
    let selectionEndPosition = 0;
    let unterminatedLineHasBytes = false;

    while (position < stat.size && !selectionComplete) {
      const read = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (read.bytesRead === 0) break;
      const chunkStart = position;
      position += read.bytesRead;
      let cursor = 0;
      while (cursor < read.bytesRead) {
        const newline = chunk.indexOf(0x0a, cursor);
        const end = newline >= 0 && newline < read.bytesRead ? newline + 1 : read.bytesRead;
        const segment = chunk.subarray(cursor, end);
        if (line >= startLine && selectedLines < lineCount) {
          if (selectedBytes + segment.byteLength > maxBytes) return failure(displayPath, 'range_too_large', 'Requested range exceeds the host byte limit for one result.');
          selected.push(Buffer.from(segment));
          selectedBytes += segment.byteLength;
        }
        unterminatedLineHasBytes ||= segment.byteLength > 0;
        cursor = end;
        if (newline < 0 || newline >= read.bytesRead) break;
        if (line >= startLine && selectedLines < lineCount) selectedLines += 1;
        line += 1;
        unterminatedLineHasBytes = false;
        if (selectedLines >= lineCount) {
          selectionComplete = true;
          selectionEndPosition = chunkStart + cursor;
          break;
        }
      }
    }

    if (!selectionComplete && position >= stat.size && unterminatedLineHasBytes && line >= startLine && selectedLines < lineCount) selectedLines += 1;
    if (!selectionComplete) selectionEndPosition = position;

    const raw = Buffer.concat(selected, selectedBytes);
    if (raw.includes(0)) return failure(displayPath, 'binary', `Requested range contains binary data: ${requestedPath}`);
    const decoder = new StringDecoder('utf8');
    const content = decoder.write(raw) + decoder.end();
    if (content.includes('\uFFFD')) return failure(displayPath, 'binary', `Requested range is not valid UTF-8 text: ${requestedPath}`);
    const eof = selectionEndPosition >= stat.size;
    const rangeSha256 = createHash('sha256').update(raw).digest('hex');
    const fullFile = startLine === 1 && eof && raw.byteLength === stat.size;
    return {
      ok: true,
      value: {
        path: displayPath,
        startLine,
        lineCount: selectedLines,
        content,
        bytes: raw.byteLength,
        eof,
        ...(!eof ? { nextStartLine: startLine + selectedLines } : {}),
        rangeSha256,
        ...(fullFile ? { fullFileSha256: rangeSha256 } : {}),
        lineEnding: detectLineEnding(raw)
      }
    };
  } finally {
    await handle.close();
  }
}

function detectLineEnding(bytes: Buffer): ReadFileResult['lineEnding'] {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1;
    else lf += 1;
  }
  if (lf > 0 && crlf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

function failure(path: string, reason: ReadFileFailure['reason'], message: string): RangeRead {
  return { ok: false, failure: { path, reason, message } };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nodeCode(error: unknown): string | undefined { return isRecord(error) && typeof error.code === 'string' ? error.code : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
