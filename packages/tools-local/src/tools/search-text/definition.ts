import { defineTool, requireWorkspaceRoot } from '@agent-core/tools';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { searchText } from './run.js';
import { searchTextInputSchema, searchTextOutputSchema } from './schema.js';

export const searchTextTool = defineTool({
  name: 'search_text',
  implementationId: 'agent-core.search-text.v1',
  description: 'Search workspace text with ripgrep and report file, line, and occurrence counts.',
  schema: searchTextInputSchema,
  outputSchema: searchTextOutputSchema,
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  async canonicalizeInput(input, context) {
    return { ...input, path: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.path) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: `workspace/files/${input.path}` }], lockScopes: [], idempotency: 'pure' };
  },
  invoke: searchText
});
