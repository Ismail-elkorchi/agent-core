import { defineTool } from '@agent-core/tools';
import { workspaceFileScope } from '../../core/resources.js';
import { searchText } from './run.js';
import { presentSearchTextObservation } from '../../core/presenters.js';
import { requireWorkspaceFileRoot } from '../../core/workspace.js';
import { searchTextInputSchema, searchTextOutputSchema } from './schema.js';

export const searchTextTool = defineTool({
  name: 'search_text',
  implementationId: 'agent-core.search-text.v1',
  description: 'Search workspace text with ripgrep and report file, line, and occurrence counts.',
  schema: searchTextInputSchema,
  outputSchema: searchTextOutputSchema,
  presentObservation: presentSearchTextObservation,
  requirements: { services: ['workspaceFileRoot', 'localToolConfiguration', 'workspaceFileSelector'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    return { ...input, path: requireWorkspaceFileRoot(context).canonicalPath(input.path) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: workspaceFileScope(input.path) }], lockScopes: [], recovery: { kind: 'unknown' } };
  },
  invoke: searchText
});
