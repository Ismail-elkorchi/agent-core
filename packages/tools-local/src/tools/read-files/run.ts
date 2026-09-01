import { createHash } from 'node:crypto';
import type { ToolResultFact } from '@agent-core/tools';
import { throwIfAborted, type ToolExecutionContext, type ToolObservationInput } from '@agent-core/tools';
import { fileScope, rootedFileResource } from '../../core/resources.js';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import type { RootedFileIdentity, RootedFileAuthority } from '../../core/rooted-file-authority.js';
import type { ReadFileFailure, ReadFileResult, ReadFilesInput, ReadFilesOutput } from './schema.js';

export async function readFiles(input: ReadFilesInput, context: ToolExecutionContext): Promise<ToolObservationInput<ReadFilesOutput>> {
  const root = requireRootedFileAuthority(context);
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
    resources: [...new Set(input.files.map((file) => fileScope(file.path)))], coverage,
    limits: { maxFiles: limits.maxFiles, maxTotalBytes: limits.maxTotalBytes, maxBytesPerFile: limits.maxBytesPerFile },
    ...(coverage === 'partial' ? { causes: [...new Set(failures.map((failure) => failure.reason))], omitted: { files: failures.length } } : {})
  } as const;
  return {
    kind: 'result', ok: failures.length === 0,
    summary: 'Read ' + String(files.length) + ' of ' + String(input.files.length) + ' requested files' + (coverage === 'partial' ? ' with partial coverage.' : '.'),
    scope,
    observedFacts: { items: readFileObservedFacts(files, failures, scope) },
    output
  };
}

function readFileObservedFacts(files: readonly ReadFileResult[], failures: readonly ReadFileFailure[], scope: { readonly filters?: import('@agent-core/json').JsonObject; readonly limits?: import('@agent-core/json').JsonObject }): ToolResultFact[] {
  return [
    ...files.map((file): ToolResultFact => ({
      action: 'read',
      outcome: 'success',
      resources: [rootedFileResource(file.path, {
        ...(file.lineCount > 0 ? { range: { kind: 'line', start: file.startLine, end: file.startLine + file.lineCount - 1 } } : {}),
        sha256: file.rangeSha256,
        fullSha256: file.fullFileSha256,
        mediaType: 'text/plain'
      })],
      scope: {
        ...(scope.filters ? { filters: scope.filters } : {}),
        coverage: 'complete', truncated: false, actuality: 'observed',
        limits: { ...(scope.limits ?? {}), returnedBytes: file.bytes, fileBytes: file.fileBytes, eof: file.eof }
      },
      summary: `Read ${String(file.lineCount)} lines (${String(file.bytes)} bytes) from ${file.path}.`
    })),
    ...failures.map((failure): ToolResultFact => ({
      action: 'read',
      outcome: 'failure',
      resources: [rootedFileResource(failure.path)],
      scope: {
        ...(scope.filters ? { filters: scope.filters } : {}), ...(scope.limits ? { limits: scope.limits } : {}),
        coverage: 'absent', truncated: false, actuality: 'observed', omitted: { reason: failure.reason }
      },
      summary: `Failed to read ${failure.path}: ${failure.reason}.`
    }))
  ];
}

type RangeRead = { ok: true; value: ReadFileResult } | { ok: false; failure: ReadFileFailure };
async function readRange(root: RootedFileAuthority, requestedPath: string, startLine: number, lineCount: number, maxBytes: number, batchLimited: boolean, context: ToolExecutionContext): Promise<RangeRead> {
  let displayPath: string;
  try { displayPath = root.canonicalPath(requestedPath); }
  catch (error) { return failure(requestedPath, 'path_outside_root', errorMessage(error)); }
  let handle;
  try { handle = await root.openFile(displayPath); }
  catch (error) { return failure(displayPath, nodeCode(error) === 'ENOENT' ? 'not_found' : 'unreadable', errorMessage(error)); }
  try {
    const initialIdentity = handle.identity;
    const fileBytes = handle.size;
    await context.emitProgress?.({ type: 'status', stage: 'file_reading', message: `Reading stable file ${displayPath}.` });
    const selected: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const fullHash = createHash('sha256');
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    let position = 0;
    let currentLine = 1;
    let selectedLines = 0;
    let selectedBytes = 0;
    let selectionEnd = 0;
    let previousByte: number | undefined;
    let lf = 0;
    let crlf = 0;
    let binary = false;
    let validUtf8 = true;
    while (position < fileBytes) {
      throwIfAborted(context.signal);
      const bytesRead = await handle.read(chunk, 0, Math.min(chunk.length, fileBytes - position), position);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      fullHash.update(bytes);
      if (bytes.includes(0)) binary = true;
      try { utf8.decode(bytes, { stream: true }); }
      catch { validUtf8 = false; }
      let cursor = 0;
      while (cursor < bytesRead) {
        throwIfAborted(context.signal);
        const newlineIndex = chunk.indexOf(0x0a, cursor);
        const hasNewline = newlineIndex >= 0 && newlineIndex < bytesRead;
        const end = hasNewline ? newlineIndex + 1 : bytesRead;
        const segment = chunk.subarray(cursor, end);
        if (currentLine >= startLine && selectedLines < lineCount) {
          if (selectedBytes + segment.byteLength > maxBytes) {
            const reason = batchLimited ? 'batch_byte_limit' : 'range_too_large';
            return failure(displayPath, reason, reason === 'batch_byte_limit' ? 'The global read_files byte budget is exhausted.' : 'Requested range exceeds the host byte limit for one result.');
          }
          selected.push(Buffer.from(segment));
          selectedBytes += segment.byteLength;
          selectionEnd = position + end;
        }
        cursor = end;
        if (hasNewline) {
          const byteBeforeLf = newlineIndex > 0 ? chunk[newlineIndex - 1] : previousByte;
          if (byteBeforeLf === 0x0d) crlf += 1;
          else lf += 1;
          if (currentLine >= startLine && selectedLines < lineCount) selectedLines += 1;
          currentLine += 1;
        }
      }
      previousByte = bytes.at(-1);
      position += bytesRead;
    }
    try { utf8.decode(); }
    catch { validUtf8 = false; }
    const fileHasUnterminatedLine = fileBytes > 0 && previousByte !== 0x0a && position >= fileBytes;
    if (fileHasUnterminatedLine && currentLine >= startLine && selectedLines < lineCount) selectedLines += 1;
    const totalLines = fileBytes === 0 ? 0 : previousByte === 0x0a && position >= fileBytes ? currentLine - 1 : currentLine;
    if (!sameIdentity(await handle.identityNow(), initialIdentity)) return failure(displayPath, 'file_changed', 'File changed while it was being read: ' + requestedPath);
    try {
      if (!sameIdentity(await root.fileIdentity(displayPath), initialIdentity)) return failure(displayPath, 'file_changed', 'File was replaced while it was being read: ' + requestedPath);
    } catch { return failure(displayPath, 'file_changed', 'File was replaced while it was being read: ' + requestedPath); }
    if (fileBytes === 0 && startLine === 1) {
      const emptySha256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
      return { ok: true, value: {
        path: displayPath, startLine, lineCount: 0, content: '', bytes: 0, fileBytes: 0, eof: true, truncated: false,
        rangeSha256: emptySha256, fullFileSha256: emptySha256, newlineConvention: 'none', utf8Validation: 'valid'
      } };
    }
    if (startLine > totalLines) return failure(displayPath, 'start_after_eof', 'Requested start line ' + String(startLine) + ' is after EOF at line ' + String(totalLines) + '.');
    if (binary) return failure(displayPath, 'binary', 'File contains binary data: ' + requestedPath);
    if (!validUtf8) return failure(displayPath, 'invalid_utf8', 'File is not valid UTF-8 text: ' + requestedPath);
    const raw = Buffer.concat(selected, selectedBytes);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    const eof = selectionEnd >= fileBytes;
    const rangeSha256 = createHash('sha256').update(raw).digest('hex');
    return {
      ok: true,
      value: {
        path: displayPath, startLine, lineCount: selectedLines, content, bytes: raw.byteLength, fileBytes, eof, truncated: !eof,
        ...(!eof ? { nextStartLine: startLine + selectedLines } : {}), rangeSha256,
        fullFileSha256: fullHash.digest('hex'), newlineConvention: lineEnding(lf, crlf), utf8Validation: 'valid'
      }
    };
  } finally { await handle.close(); }
}
function lineEnding(lf: number, crlf: number): ReadFileResult['newlineConvention'] {
  return lf > 0 && crlf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'none';
}
function failure(path: string, reason: ReadFileFailure['reason'], message: string): RangeRead { return { ok: false, failure: { path, reason, message } }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nodeCode(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
function sameIdentity(left: RootedFileIdentity, right: RootedFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode && left.links === right.links
    && left.size === right.size && left.modifiedNanoseconds === right.modifiedNanoseconds && left.changedNanoseconds === right.changedNanoseconds;
}
