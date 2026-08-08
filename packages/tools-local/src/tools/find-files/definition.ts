import { defineTool, requireWorkspaceRoot } from '@agent-core/tools';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { workspaceFileSelector } from '../../core/workspace-file-selection.js';
import { findFilesInputSchema, findFilesOutputSchema, type FindFilesInput } from './schema.js';

interface CanonicalFindFilesInput extends FindFilesInput { readonly path: string }

export const findFilesTool = defineTool({
  name: 'find_files',
  implementationId: 'agent-core.find-files.v1',
  description: 'Find workspace files or directories using the common glob and ignore semantics.',
  schema: findFilesInputSchema,
  outputSchema: findFilesOutputSchema,
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  async canonicalizeInput(input, context): Promise<CanonicalFindFilesInput> {
    return { ...input, path: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.path) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: `workspace/files/${input.path}` }], lockScopes: [], idempotency: 'pure' };
  },
  async invoke(input, context) {
    const selected = await workspaceFileSelector(context).select({
      startPath: input.path,
      patterns: input.patterns,
      type: input.type,
      respectGitIgnore: input.respectGitIgnore,
      includeHidden: input.includeHidden,
      exclude: input.exclude,
      ...(input.resultLimit === undefined ? {} : { requestedLimit: input.resultLimit })
    });
    const output = {
      path: selected.startPath,
      patterns: [...input.patterns],
      entries: selected.entries.map(({ path, type }) => ({ path, type })),
      coverage: selected.coverage,
      causes: [...selected.causes],
      counts: { visited: selected.visitedEntries, returned: selected.returnedEntries, omitted: selected.omittedEntries },
      omissionSamples: [...selected.omissionSamples]
    };
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Found ${String(output.counts.returned)} paths under ${output.path}${output.coverage === 'partial' ? ' with partial coverage' : ''}.`,
      scope: { resources: [`workspace/files/${output.path}`], coverage: output.coverage, ...(output.causes.length > 0 ? { cause: output.causes.join('; ') } : {}) },
      output
    };
  }
});
