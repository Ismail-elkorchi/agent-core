import { createHash } from 'node:crypto';
import type { ToolEvidenceItem } from '@agent-core/evidence';
import { throwIfAborted, type ToolExecutionContext, type ToolObservationInput } from '@agent-core/tools';
import { workspaceFileScope, workspaceResource } from '../../core/resources.js';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import { requireWorkspaceFileRoot } from '../../core/workspace.js';
import type { WorkspaceFileIdentity, WorkspaceFileRoot } from '../../core/workspace-file-root.js';
import type { ReadFileFailure, ReadFileResult, ReadFilesInput, ReadFilesOutput } from './schema.js';

export async function readFiles(input: ReadFilesInput, context: ToolExecutionContext): Promise<ToolObservationInput<ReadFilesOutput>> {
  const root = requireWorkspaceFileRoot(context);
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
async function readRange(root: WorkspaceFileRoot, requestedPath: string, startLine: number, lineCount: number, maxBytes: number, batchLimited: boolean, context: ToolExecutionContext): Promise<RangeRead> {
  let displayPath: string;
  try { displayPath = root.canonicalPath(requestedPath); }
  catch (error) { return failure(requestedPath, 'path_outside_workspace', errorMessage(error)); }
  let handle;
  try { handle = await root.openFile(displayPath); }
  catch (error) { return failure(displayPath, nodeCode(error) === 'ENOENT' ? 'not_found' : 'unreadable', errorMessage(error)); }
  try {
    const initialIdentity = handle.identity;
    const fileBytes = handle.size;
    await context.emitProgress?.({ type: 'status', stage: 'file_reading', message: `Reading stable file ${displayPath}.` });
    const selected: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let currentLine = 1;
    let selectedLines = 0;
    let selectedBytes = 0;
    let selectionEnd = 0;
    let lastByte: number | undefined;
    while (position < fileBytes && selectedLines < lineCount) {
      throwIfAborted(context.signal);
      const bytesRead = await handle.read(chunk, 0, Math.min(chunk.length, fileBytes - position), position);
      if (bytesRead === 0) break;
      let cursor = 0;
      while (cursor < bytesRead && selectedLines < lineCount) {
        throwIfAborted(context.signal);
        const newlineIndex = chunk.indexOf(0x0a, cursor);
        const hasNewline = newlineIndex >= 0 && newlineIndex < bytesRead;
        const end = hasNewline ? newlineIndex + 1 : bytesRead;
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
      position += bytesRead;
    }
    const fileHasUnterminatedLine = fileBytes > 0 && lastByte !== 0x0a && position >= fileBytes;
    if (fileHasUnterminatedLine && currentLine >= startLine && selectedLines < lineCount) selectedLines += 1;
    const totalLines = fileBytes === 0 ? 0 : lastByte === 0x0a && position >= fileBytes ? currentLine - 1 : currentLine;
    if (!sameIdentity(await handle.identityNow(), initialIdentity)) return failure(displayPath, 'file_changed', 'File changed while it was being read: ' + requestedPath);
    try {
      if (!sameIdentity(await root.fileIdentity(displayPath), initialIdentity)) return failure(displayPath, 'file_changed', 'File was replaced while it was being read: ' + requestedPath);
    } catch { return failure(displayPath, 'file_changed', 'File was replaced while it was being read: ' + requestedPath); }
    if (fileBytes === 0 && startLine === 1) {
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
    const eof = selectionEnd >= fileBytes;
    const rangeSha256 = createHash('sha256').update(raw).digest('hex');
    const fullFile = startLine === 1 && eof && raw.byteLength === fileBytes;
    return {
      ok: true,
      value: {
        path: displayPath, startLine, lineCount: selectedLines, content, bytes: raw.byteLength, fileBytes, eof,
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
function sameIdentity(left: WorkspaceFileIdentity, right: WorkspaceFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode && left.links === right.links
    && left.size === right.size && left.modifiedNanoseconds === right.modifiedNanoseconds && left.changedNanoseconds === right.changedNanoseconds;
}
