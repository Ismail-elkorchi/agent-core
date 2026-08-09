import { defineTool, requireWorkspaceRoot, workspaceFileScope } from '@agent-core/tools';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { workspaceFileSelector } from '../../core/workspace-file-selection.js';
import { presentListDirectoryObservation } from '../../core/presenters.js';
import { listDirectoryInputSchema, listDirectoryOutputSchema, type ListDirectoryInput } from './schema.js';

interface CanonicalListDirectoryInput extends ListDirectoryInput { readonly path: string }

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  implementationId: 'agent-core.list-directory.v1',
  description: 'List a workspace directory as a sorted flat collection with explicit coverage.',
  schema: listDirectoryInputSchema,
  outputSchema: listDirectoryOutputSchema,
  presentObservation: presentListDirectoryObservation,
  requirements: { services: ['workspaceRoot', 'localToolConfiguration', 'workspaceFileSelector'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  async canonicalizeInput(input, context): Promise<CanonicalListDirectoryInput> {
    return {
      ...input,
      path: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.path),
      depth: clampRequestedLimit(input.depth, requireLocalToolConfiguration(context).fileSelection.maxDepth)
    };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: workspaceFileScope(input.path) }], lockScopes: [], idempotency: 'pure' };
  },
  async invoke(input, context) {
    const patterns = Array.from({ length: input.depth }, (_unused, index) => `${'*/'.repeat(index)}*`);
    const selected = await workspaceFileSelector(context).select({
      startPath: input.path,
      patterns,
      type: 'any',
      respectGitIgnore: input.respectGitIgnore,
      includeHidden: input.includeHidden,
      exclude: input.exclude,
      ...(input.resultLimit === undefined ? {} : { requestedLimit: input.resultLimit }),
      includeMetadata: input.includeMetadata,
      ...(context.signal ? { signal: context.signal } : {})
    });
    const output = {
      path: selected.startPath,
      entries: [...selected.entries],
      coverage: selected.coverage,
      causes: [...selected.causes],
      counts: { visited: selected.visitedEntries, returned: selected.returnedEntries, omitted: selected.omittedEntries },
      omitted: { ignoreFiles: selected.omittedIgnoreFiles },
      omissionSamples: [...selected.omissionSamples]
    };
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Listed ${String(output.counts.returned)} entries under ${output.path}${output.coverage === 'partial' ? ' with partial coverage' : ''}.`,
      scope: { resources: [workspaceFileScope(output.path)], coverage: output.coverage, ...(output.causes.length > 0 ? { causes: output.causes, omitted: { entries: output.counts.omitted } } : {}) },
      output
    };
  }
});
