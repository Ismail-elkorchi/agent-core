import { defineTool, requireWorkspaceRoot } from '@agent-core/tools';
import { toolFailurePresentation, toJsonValue, type ToolObservationPresentation } from '@agent-core/tools';
import { listDirectoryTree } from './run.js';
import { listDirectoryTreeInputSchema } from './schema.js';
import { canonicalWorkspacePath } from '../../core/filesystem.js';

export const listDirectoryTreeTool = defineTool({
  name: 'list_directory_tree',
  implementationId: '@agent-core/tools-local/list-directory-tree@1',
  description: 'List files and directories under a directory within an explicit traversal limit. First call shape: {} lists the configured root at depth 1, including hidden entries. Use caller-chosen exclude patterns for deeper follow-up calls.',
  schema: listDirectoryTreeInputSchema,
  risk: 'read',
  declaredEffects: { kind: 'read', resourceScopes: ['workspace/files'], idempotency: 'pure', reversible: true },
  async canonicalizeInput(input, context) { return { ...input, path: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.path) }; },
  deriveEffects(input) { return { kind: 'read', resourceScopes: [`workspace/files/${input.path}`], idempotency: 'pure', reversible: true }; },
  invoke: listDirectoryTree,
  presentObservation: ({ observation }): ToolObservationPresentation => {
    if (!observation.ok) {
      return toolFailurePresentation('list_directory_tree', observation);
    }
    const output = observation.output;
    return {
      ok: true,
      title: 'Directory tree listing',
      summary: observation.summary,
      scope: {
        path: output.scope.path
      },
      filters: {
        hidden: output.filters.hidden,
        exclude: output.filters.exclude
      },
      limits: {
        depth: output.limits.depth,
        maxVisitedEntries: output.limits.maxVisitedEntries
      },
      results: {
        entries: toJsonValue(output.entries),
        counts: toJsonValue(output.counts)
      },
      omitted: {
        entries: output.omitted.length,
        details: toJsonValue(output.omitted)
      },
      coverage: output.coverage,
      next: output.coverage === 'partial' ? 'Call list_directory_tree again with a narrower path or exclusions if more entries are needed.' : 'Use returned paths exactly when reading or searching.'
    };
  }
});
