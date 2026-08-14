import { defineTool, workspaceFileScope } from '@agent-core/tools';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { workspaceFileSelector } from '../../core/workspace-file-selection.js';
import { presentListDirectoryObservation } from '../../core/presenters.js';
import { builtInReadEvidence } from '../../core/read-evidence.js';
import { requireWorkspaceRoot } from '../../core/workspace.js';
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
      depth: input.depth
    };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: workspaceFileScope(input.path) }], lockScopes: [], idempotency: 'pure' };
  },
  async invoke(input, context) {
    const selected = await workspaceFileSelector(context).select({
      startPath: input.path,
      patterns: ['**/*'],
      type: 'any',
      respectGitIgnore: input.respectGitIgnore,
      includeHidden: input.includeHidden,
      exclude: input.exclude,
      ...(input.resultLimit === undefined ? {} : { requestedLimit: input.resultLimit }),
      traversalDepth: input.depth,
      includeMetadata: input.includeMetadata,
      ...(context.signal ? { signal: context.signal } : {})
    });
    const output = {
      path: selected.startPath,
      depth: { requested: input.depth, effective: selected.effectiveDepth, hostMaximum: selected.hostMaximumDepth },
      entries: [...selected.entries],
      coverage: selected.coverage,
      causes: [...selected.causes],
      counts: { visited: selected.visitedEntries, returned: selected.returnedEntries, omitted: selected.omittedEntries },
      omitted: { ignoreFiles: selected.omittedIgnoreFiles },
      omissions: [...selected.omissions],
      omissionSamples: [...selected.omissionSamples]
    };
    const scope = {
      resources: [workspaceFileScope(output.path)], coverage: output.coverage,
      filters: { requestedDepth: input.depth },
      limits: { effectiveDepth: selected.effectiveDepth, hostMaximumDepth: selected.hostMaximumDepth },
      ...(output.causes.length > 0 ? { causes: output.causes, omitted: {
        entries: { count: output.counts.omitted.count, relation: output.counts.omitted.relation },
        causes: output.omissions.map((item) => ({ cause: item.cause, count: item.count, relation: item.relation }))
      } } : {})
    } as const;
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Listed ${String(output.counts.returned)} entries under ${output.path}${output.coverage === 'partial' ? ' with partial coverage' : ''}.`,
      scope,
      evidence: builtInReadEvidence('list', scope, `Listed ${String(output.counts.returned)} directory entries.`),
      output
    };
  }
});
