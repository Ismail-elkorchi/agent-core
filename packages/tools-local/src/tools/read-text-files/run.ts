import { evidenceDelta, workspaceResource } from '@agent-core/evidence';
import { requireWorkspaceRoot, type ToolExecutionContext } from '@agent-core/tools';
import type { ToolObservation } from '@agent-core/tools';
import { inspectTextFile, sha256Text } from '../../core/filesystem.js';
import { splitLogicalLines } from '@agent-core/tools';
import type {
  ReadTextFilesFailureOutput,
  ReadTextFilesFileOutput,
  ReadTextFilesInput,
  ReadTextFilesOutput
} from './schema.js';

const DEFAULT_WINDOW_LINE_COUNT = 100;

export async function readTextFiles(input: ReadTextFilesInput, context: ToolExecutionContext): Promise<ToolObservation<ReadTextFilesOutput>> {
  const rootDir = requireWorkspaceRoot(context);
  const files: ReadTextFilesFileOutput[] = [];
  const failures: ReadTextFilesFailureOutput[] = [];
  let omittedBytes = 0;
  let remainingBytes = input.maxTotalBytes;

  for (const request of input.files) {
    if (remainingBytes === 0) {
      failures.push({ path: request.path, reason: 'total_limit', message: `Aggregate read limit ${String(input.maxTotalBytes)} bytes was reached before this file.` });
      continue;
    }
    const effectiveFileLimit = Math.min(input.maxBytesPerFile, remainingBytes);
    const inspected = await inspectTextFile(rootDir, request.path, effectiveFileLimit);
    if (!inspected.ok) {
      const totalLimitReached = inspected.failure.reason === 'too_large' && effectiveFileLimit < input.maxBytesPerFile;
      failures.push({
        path: inspected.failure.path,
        reason: totalLimitReached ? 'total_limit' : inspected.failure.reason,
        message: totalLimitReached
          ? `File would exceed the aggregate read limit of ${String(input.maxTotalBytes)} bytes.`
          : inspected.failure.message
      });
      omittedBytes += inspected.failure.bytes ?? 0;
      continue;
    }
    remainingBytes -= inspected.file.bytes;

    const totalLines = inspected.file.lines.length;
    const textShape = splitLogicalLines(inspected.file.content);
    const startLine = request.startLine;
    if (startLine > Math.max(totalLines, 1)) {
      failures.push({
        path: inspected.file.path,
        reason: 'invalid_range',
        message: `startLine ${String(startLine)} is beyond the end of ${inspected.file.path} (${String(totalLines)} lines).`
      });
      continue;
    }
    const defaultEndLine = startLine + DEFAULT_WINDOW_LINE_COUNT - 1;
    const requestedEndLine = request.endLine ?? defaultEndLine;
    const endLine = totalLines === 0 ? 0 : Math.min(totalLines, requestedEndLine);
    const hasLinesInWindow = totalLines > 0 && startLine <= totalLines && endLine >= startLine;
    const selectedLines = hasLinesInWindow ? inspected.file.lines.slice(startLine - 1, endLine) : [];

    files.push({
      path: inspected.file.path,
      sha256: sha256Text(inspected.file.content),
      lineEndings: textShape.lineEndings,
      hasFinalNewline: textShape.hasFinalNewline,
      totalBytes: inspected.file.bytes,
      totalLines,
      startLine,
      endLine,
      content: selectedLines.join('\n'),
      coverage: startLine > 1 || requestedEndLine < totalLines ? 'partial' : 'complete'
    });
  }

  const output: ReadTextFilesOutput = {
    files,
    failures,
    omitted: {
      files: failures.length,
      bytes: omittedBytes
    },
    limits: { maxBytesPerFile: input.maxBytesPerFile, maxTotalBytes: input.maxTotalBytes },
    coverage: files.some((file) => file.coverage === 'partial') || failures.length > 0 ? 'partial' : 'complete'
  };

  return {
    kind: 'result',
    ok: true,
    summary: summarizeRead(output),
    output,
    evidence: evidenceDelta(output.files.map((file) => ({
      action: 'read',
      resources: [workspaceResource(file.path, {
        range: { kind: 'line', start: file.startLine, end: file.endLine },
        sha256: file.sha256,
        mediaType: 'text/plain'
      })],
      scope: {
        limits: { maxBytesPerFile: input.maxBytesPerFile, maxTotalBytes: input.maxTotalBytes },
        omitted: { bytes: output.omitted.bytes, files: output.omitted.files },
        coverage: file.coverage,
        confidence: 'verified'
      },
      summary: `Read ${file.path} lines ${String(file.startLine)}-${String(file.endLine)}.`
    })))
  };
}

function summarizeRead(output: ReadTextFilesOutput): string {
  const readCount = output.files.length;
  const failureSuffix = output.failures.length > 0 ? ` ${String(output.failures.length)} file${output.failures.length === 1 ? '' : 's'} failed.` : '';
  const coverageSuffix = output.coverage === 'partial' ? ' The requested reads have partial coverage.' : '';
  return `Read ${String(readCount)} text file window${readCount === 1 ? '' : 's'}.${failureSuffix}${coverageSuffix}`;
}
