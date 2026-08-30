import { defineTool } from '@agent-core/tools';
import { fileScope } from '../../core/resources.js';
import { searchText } from './run.js';
import { presentSearchTextObservation } from '../../core/presenters.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { searchTextInputSchema, searchTextOutputSchema } from './schema.js';

export const searchTextTool = defineTool({
  name: 'search_text',
  implementationId: 'agent-core.search-text.v1',
  description: 'Search rooted text with ripgrep and report file, line, and occurrence counts.',
  schema: searchTextInputSchema,
  outputSchema: searchTextOutputSchema,
  presentObservation: presentSearchTextObservation,
  requirements: { services: ['rootedFileAuthority', 'localToolConfiguration', 'rootedFileSelector'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    return { ...input, path: requireRootedFileAuthority(context).canonicalPath(input.path) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: fileScope(input.path) }], lockScopes: [], recovery: { kind: 'unknown' } };
  },
  invoke: searchText
});
