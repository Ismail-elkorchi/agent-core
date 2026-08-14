import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { ToolEvidenceItem } from '@agent-core/evidence';
import { throwIfAborted, type ToolExecutionContext, type ToolObservationInput } from '@agent-core/tools';
import { workspaceFileScope, workspaceResource } from '../../core/resources.js';
import { assertRealPathInsideRoot, relativePath, resolveInsideRoot } from '../../core/filesystem.js';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import { requireWorkspaceRoot } from '../../core/workspace.js';
import type { ReadFileFailure, ReadFileResult, ReadFilesInput, ReadFilesOutput } from './schema.js';

export async function readFiles(input: ReadFilesInput, context: ToolExecutionContext): Promise<ToolObservationInput<ReadFilesOutput>> {
  const root = requireWorkspaceRoot(context);
  const limits = requireLocalToolConfiguration(context).readFiles;
  const files: ReadFileResult[] = [];
  const failures: ReadFileFailure[] = [];
  let remainingBytes = limits.maxTotalBytes;
  for (const [index, request] of input.files.entries()) {
    throwIfAborted(context.signal);
    if (index >= limits.maxFiles) {
      failures.push({ path: request.path, reason: 'batch_file_limit', message: 'The host accepts at most ' + String(limits.maxFiles) + ' files in one batch.' });
      continue;
    }
    if (remainingBytes <= 0) {
      failures.push({ path: request.path, reason: 'batch_byte_limit', message: 'The global read_files byte budget is exhausted.' });
      continue;
    }
    const lineCount = Math.min(request.lineCount ?? limits.maxLinesPerFile, limits.maxLinesPerFile);
    const result = await readRange(root, request.path, request.startLine, lineCount, Math.min(limits.maxBytesPerFile, remainingBytes), remainingBytes < limits.maxBytesPerFile, context);
    if (result.ok) { files.push(result.value); remainingBytes -= result.value.bytes; }
    else failures.push(result.failure);
  }
  const returnedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const coverage = failures.length === 0 ? 'complete' as const : 'partial' as const;
  const output: ReadFilesOutput = {
    files, failures, coverage, requestedFiles: input.files.length, returnedFiles: files.length, failedFiles: failures.length, returnedBytes
  };
  const scope = {
    resources: [...new Set(input.files.map((file) => workspaceFileScope(file.path)))], coverage,
    limits: { maxFiles: limits.maxFiles, maxTotalBytes: limits.maxTotalBytes, maxBytesPerFile: limits.maxBytesPerFile },
    ...(coverage === 'partial' ? { causes: [...new Set(failures.map((failure) => failure.reason))], omitted: { files: failures.length } } : {})
  } as const;
  return {
    kind: 'result', ok: failures.length === 0,
    summary: 'Read ' + String(files.length) + ' of ' + String(input.files.length) + ' requested files' + (coverage === 'partial' ? ' with partial coverage.' : '.'),
    scope,
    evidence: { items: readFileEvidence(files, failures, scope) },
    output
  };
}

function readFileEvidence(files: readonly ReadFileResult[], failures: readonly ReadFileFailure[], scope: { readonly filters?: import('@agent-core/json').JsonObject; readonly limits?: import('@agent-core/json').JsonObject }): ToolEvidenceItem[] {
  return [
    ...files.map((file): ToolEvidenceItem => ({
      action: 'read',
      outcome: 'success',
      resources: [workspaceResource(file.path, {
        ...(file.lineCount > 0 ? { range: { kind: 'line', start: file.startLine, end: file.startLine + file.lineCount - 1 } } : {}),
        sha256: file.rangeSha256,
        ...(file.fullFileSha256 ? { fullSha256: file.fullFileSha256 } : {}),
        mediaType: 'text/plain'
      })],
      scope: {
        ...(scope.filters ? { filters: scope.filters } : {}),
        coverage: 'complete', truncated: false, confidence: 'verified',
        limits: { ...(scope.limits ?? {}), returnedBytes: file.bytes, fileBytes: file.fileBytes, eof: file.eof }
      },
      summary: `Read ${String(file.lineCount)} lines (${String(file.bytes)} bytes) from ${file.path}.`
    })),
    ...failures.map((failure): ToolEvidenceItem => ({
      action: 'read',
      outcome: 'failure',
      resources: [workspaceResource(failure.path)],
      scope: {
        ...(scope.filters ? { filters: scope.filters } : {}), ...(scope.limits ? { limits: scope.limits } : {}),
        coverage: 'absent', truncated: false, confidence: 'verified', omitted: { reason: failure.reason }
      },
      summary: `Failed to read ${failure.path}: ${failure.reason}.`
    }))
  ];
}

type RangeRead = { ok: true; value: ReadFileResult } | { ok: false; failure: ReadFileFailure };
async function readRange(root: string, requestedPath: string, startLine: number, lineCount: number, maxBytes: number, batchLimited: boolean, context: ToolExecutionContext): Promise<RangeRead> {
  let absolute: string;
  try { absolute = resolveInsideRoot(root, requestedPath); }
  catch (error) { return failure(requestedPath, 'path_outside_workspace', errorMessage(error)); }
  const displayPath = relativePath(root, absolute);
  let handle: FileHandle;
  try { handle = await fs.open(absolute, 'r'); }
  catch (error) { return failure(displayPath || requestedPath, nodeCode(error) === 'ENOENT' ? 'not_found' : 'unreadable', errorMessage(error)); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return failure(displayPath, 'not_file', 'Path is not a regular file: ' + requestedPath);
    const initialIdentity = fileIdentity(stat);
    try { await assertRealPathInsideRoot(root, absolute, requestedPath); }
    catch (error) { return failure(displayPath, 'path_outside_workspace', errorMessage(error)); }
    await context.emitProgress?.({ type: 'status', stage: 'file_reading', message: `Reading stable file ${displayPath}.` });
    const selected: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let currentLine = 1;
    let selectedLines = 0;
    let selectedBytes = 0;
    let selectionEnd = 0;
    let lastByte: number | undefined;
    while (position < stat.size && selectedLines < lineCount) {
      throwIfAborted(context.signal);
      const read = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (read.bytesRead === 0) break;
      let cursor = 0;
      while (cursor < read.bytesRead && selectedLines < lineCount) {
        throwIfAborted(context.signal);
        const newlineIndex = chunk.indexOf(0x0a, cursor);
        const hasNewline = newlineIndex >= 0 && newlineIndex < read.bytesRead;
        const end = hasNewline ? newlineIndex + 1 : read.bytesRead;
        const segment = chunk.subarray(cursor, end);
        if (currentLine >= startLine) {
          if (selectedBytes + segment.byteLength > maxBytes) {
            const reason = batchLimited ? 'batch_byte_limit' : 'range_too_large';
            return failure(displayPath, reason, reason === 'batch_byte_limit' ? 'The global read_files byte budget is exhausted.' : 'Requested range exceeds the host byte limit for one result.');
          }
          selected.push(Buffer.from(segment));
          selectedBytes += segment.byteLength;
        }
        lastByte = segment.at(-1);
        cursor = end;
        selectionEnd = position + cursor;
        if (hasNewline) {
          if (currentLine >= startLine) selectedLines += 1;
          currentLine += 1;
        }
      }
      position += read.bytesRead;
    }
    const fileHasUnterminatedLine = stat.size > 0 && lastByte !== 0x0a && position >= stat.size;
    if (fileHasUnterminatedLine && currentLine >= startLine && selectedLines < lineCount) selectedLines += 1;
    const totalLines = stat.size === 0 ? 0 : lastByte === 0x0a && position >= stat.size ? currentLine - 1 : currentLine;
    const finalHandleStat = await handle.stat();
    let finalPathStat;
    try { finalPathStat = await fs.stat(absolute); }
    catch { return failure(displayPath, 'file_changed', 'File changed or was replaced while it was being read: ' + requestedPath); }
    if (fileIdentity(finalHandleStat) !== initialIdentity || fileIdentity(finalPathStat) !== initialIdentity) {
      return failure(displayPath, 'file_changed', 'File changed or was replaced while it was being read: ' + requestedPath);
    }
    if (stat.size === 0 && startLine === 1) {
      const emptySha256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
      return { ok: true, value: {
        path: displayPath, startLine, lineCount: 0, content: '', bytes: 0, fileBytes: 0, eof: true,
        rangeSha256: emptySha256, fullFileSha256: emptySha256, rangeLineEnding: 'none'
      } };
    }
    if (startLine > totalLines) return failure(displayPath, 'start_after_eof', 'Requested start line ' + String(startLine) + ' is after EOF at line ' + String(totalLines) + '.');
    const raw = Buffer.concat(selected, selectedBytes);
    if (raw.includes(0)) return failure(displayPath, 'binary', 'Requested range contains binary data: ' + requestedPath);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { return failure(displayPath, 'invalid_utf8', 'Requested range is not valid UTF-8 text: ' + requestedPath); }
    const eof = selectionEnd >= stat.size;
    const rangeSha256 = createHash('sha256').update(raw).digest('hex');
    const fullFile = startLine === 1 && eof && raw.byteLength === stat.size;
    return {
      ok: true,
      value: {
        path: displayPath, startLine, lineCount: selectedLines, content, bytes: raw.byteLength, fileBytes: stat.size, eof,
        ...(!eof ? { nextStartLine: startLine + selectedLines } : {}), rangeSha256,
        ...(fullFile ? { fullFileSha256: rangeSha256 } : {}), rangeLineEnding: detectLineEnding(raw)
      }
    };
  } finally { await handle.close(); }
}
function detectLineEnding(bytes: Buffer): ReadFileResult['rangeLineEnding'] {
  let lf = 0; let crlf = 0;
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0x0a) { if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1; else lf += 1; }
  return lf > 0 && crlf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'none';
}
function failure(path: string, reason: ReadFileFailure['reason'], message: string): RangeRead { return { ok: false, failure: { path, reason, message } }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nodeCode(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
function fileIdentity(stat: { readonly dev: number | bigint; readonly ino: number | bigint; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number }): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].map(String).join(':');
}
