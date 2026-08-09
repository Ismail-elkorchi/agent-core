import { defineTool, requireWorkspaceRoot, workspaceFileScope } from '@agent-core/tools';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { searchText } from './run.js';
import { presentSearchTextObservation } from '../../core/presenters.js';
import { searchTextInputSchema, searchTextOutputSchema } from './schema.js';

export const searchTextTool = defineTool({
  name: 'search_text',
  implementationId: 'agent-core.search-text.v1',
  description: 'Search workspace text with ripgrep and report file, line, and occurrence counts.',
  schema: searchTextInputSchema,
  outputSchema: searchTextOutputSchema,
  presentObservation: presentSearchTextObservation,
  requirements: { services: ['workspaceRoot', 'localToolConfiguration'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  async canonicalizeInput(input, context) {
    return { ...input, path: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.path) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: workspaceFileScope(input.path) }], lockScopes: [], idempotency: 'pure' };
  },
  invoke: searchText
});
