import { defineTool, requireWorkspaceRoot } from '@agent-core/tools';
import { toolFailurePresentation, toJsonValue, type JsonObject, type JsonValue, type ToolObservationPresentation } from '@agent-core/tools';
import { readTextFiles } from './run.js';
import { readTextFilesInputSchema, type ReadTextFilesInput, type ReadTextFilesOutput } from './schema.js';
import { canonicalWorkspacePath } from '../../core/filesystem.js';

export const readTextFilesTool = defineTool({
  name: 'read_text_files',
  implementationId: '@agent-core/tools-local/read-text-files@1',
  description: 'Read line windows from one or more text files within explicit byte limits. First call shape: {"files":[{"path":"relative/path.txt"}]}. Results are scoped to requested paths and line windows; use search_file_text first if paths are unknown, and call again when coverage is partial.',
  schema: readTextFilesInputSchema,
  risk: 'read',
  declaredEffects: { kind: 'read', resourceScopes: ['workspace/files'], idempotency: 'pure', reversible: true },
  async canonicalizeInput(input, context) {
    const root = requireWorkspaceRoot(context);
    return { ...input, files: await Promise.all(input.files.map(async (file) => ({ ...file, path: await canonicalWorkspacePath(root, file.path) }))) };
  },
  deriveEffects(input) { return { kind: 'read', resourceScopes: input.files.map((file) => `workspace/files/${file.path}`), idempotency: 'pure', reversible: true }; },
  invoke: readTextFiles,
  presentObservation: ({ input, observation, limit }): ToolObservationPresentation => {
    if (!observation.ok) {
      return toolFailurePresentation('read_text_files', observation);
    }
    const output = observation.output;
    const requested = readRequestsForPresentation(input);
    const results = readResultsForPresentation(output, limit.maxBytes);
    return {
      ok: true,
      title: 'Text file windows',
      summary: observation.summary,
      scope: {
        requested
      },
      limits: {
        maxBytesPerFile: input.maxBytesPerFile,
        maxTotalBytes: input.maxTotalBytes
      },
      results: results.results,
      failures: toJsonValue(output.failures),
      omitted: {
        ...output.omitted,
        presentationBytes: results.omittedBytes
      },
      coverage: output.coverage,
      truncated: results.omittedBytes > 0,
      next: output.coverage === 'partial' || results.omittedBytes > 0 ? 'Call read_text_files again with narrower or later line windows for omitted content.' : 'Use the returned file paths and line ranges as the evidence scope.'
    };
  }
});

function readRequestsForPresentation(input: ReadTextFilesInput): JsonValue {
  return input.files.map((item): JsonObject => {
    const request: JsonObject = { path: item.path, startLine: item.startLine };
    if (item.endLine !== undefined) {
      request.endLine = item.endLine;
    }
    return request;
  });
}

function readResultsForPresentation(output: ReadTextFilesOutput, maxBytes: number): { results: JsonValue; omittedBytes: number } {
  const maxContentBytes = Math.max(500, Math.floor(maxBytes * 0.55 / Math.max(1, output.files.length)));
  let omittedBytes = 0;
  return {
    results: {
      files: output.files.map((file) => {
        const limited = limitTextBytes(file.content, maxContentBytes);
        omittedBytes += limited.omittedBytes;
        const result: JsonObject = {
          path: file.path,
          sha256: file.sha256,
          lineEndings: file.lineEndings,
          hasFinalNewline: file.hasFinalNewline,
          totalBytes: file.totalBytes,
          returned: {
            startLine: file.startLine,
            endLine: file.endLine,
            totalLines: file.totalLines
          },
          content: limited.text,
          coverage: file.coverage,
          contentTruncated: limited.omittedBytes > 0
        };
        if (limited.omittedBytes > 0) {
          result.contentOmittedBytes = limited.omittedBytes;
        }
        return result;
      })
    },
    omittedBytes
  };
}

function limitTextBytes(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) {
    return { text, omittedBytes: 0 };
  }
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end = Math.floor(end * 0.8);
  }
  const prefix = text.slice(0, end);
  return {
    text: `${prefix}\n[content truncated for observation presentation]`,
    omittedBytes: Math.max(0, bytes - Buffer.byteLength(prefix, 'utf8'))
  };
}
