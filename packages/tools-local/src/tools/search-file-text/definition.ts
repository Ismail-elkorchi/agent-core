import { defineTool, requireWorkspaceRoot } from '@agent-core/tools';
import { toolFailurePresentation, toJsonValue, type JsonValue, type ToolObservationPresentation } from '@agent-core/tools';
import { searchFileText } from './run.js';
import { searchFileTextInputSchema, type SearchFileTextOutput } from './schema.js';
import { canonicalWorkspacePath, validateRelativePatterns } from '../../core/filesystem.js';

export const searchFileTextTool = defineTool({
  name: 'search_file_text',
  implementationId: '@agent-core/tools-local/search-file-text@1',
  description: 'Search text content inside files under a directory and return structured evidence within explicit result limits. First call shape: {"query":"text"} searches "." literally, excludes hidden files, applies no ignore-file conventions, and returns matching files. Excluded, hidden, non-included, and oversized files are outside the searched subset. Partial coverage means the result limit stopped the search; truncation means returned details were shortened to the byte limit. Absence claims apply only to the exact searched scope. To check hidden files, call with hidden:"include" or hidden:"only".',
  schema: searchFileTextInputSchema,
  risk: 'read',
  declaredEffects: { kind: 'read', resourceScopes: ['workspace/files'], idempotency: 'pure', reversible: true },
  async canonicalizeInput(input, context) {
    validateRelativePatterns(input.include, 'include'); validateRelativePatterns(input.exclude, 'exclude');
    return { ...input, path: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.path) };
  },
  deriveEffects(input) { return { kind: 'read', resourceScopes: [`workspace/files/${input.path}`], idempotency: 'pure', reversible: true }; },
  invoke: searchFileText,
  presentObservation: ({ observation }): ToolObservationPresentation => {
    if (!observation.ok) {
      return toolFailurePresentation('search_file_text', observation);
    }
    const output = observation.output;
    const hiddenNote = output.filters.hidden === 'exclude'
      ? ' Hidden files were excluded; absence claims do not cover hidden paths.'
      : '';
    return {
      ok: true,
      title: 'File text search',
      summary: `${observation.summary}${hiddenNote}`,
      scope: {
        path: output.path,
        query: output.query,
        mode: output.mode,
        resultMode: output.resultMode
      },
      filters: {
        hidden: output.filters.hidden,
        include: output.filters.include,
        exclude: output.filters.exclude,
        caseSensitive: output.filters.caseSensitive
      },
      limits: {
        contextLines: output.filters.contextLines,
        maxResults: output.filters.maxResults,
        maxMatchesPerFile: output.filters.maxMatchesPerFile,
        maxFileBytes: output.filters.maxFileBytes,
        maxResultBytes: output.filters.maxResultBytes
      },
      results: searchResultsForPresentation(output),
      omitted: {
        files: output.omitted.files,
        matches: output.omitted.matches,
        bytes: output.omitted.bytes
      },
      coverage: output.coverage,
      truncated: output.truncated,
      next: output.coverage === 'partial' || output.truncated ? 'Narrow the search scope before making completeness claims.' : 'Read returned paths or run a narrower follow-up search when more evidence is needed.'
    };
  }
});

function searchResultsForPresentation(output: SearchFileTextOutput): JsonValue {
  if (output.resultMode === 'count') {
    return {
      counts: toJsonValue(output.counts ?? { filesWithMatches: 0, totalMatches: 0 })
    };
  }
  if (output.resultMode === 'matches') {
    return {
      matches: toJsonValue(output.matches ?? [])
    };
  }
  return {
    files: toJsonValue(output.files ?? [])
  };
}
