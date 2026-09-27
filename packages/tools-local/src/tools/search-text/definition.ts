import { defineTool } from '@agent-core/tools';
import { fileSelectionScopes } from '../../core/resources.js';
import { searchText } from './run.js';
import { buildSearchTextContent } from '../../core/model-content.js';
import { normalizeFilePath } from '../../core/rooted-files.js';
import { searchTextInputSchema, searchTextOutputSchema } from './schema.js';

export const searchTextTool = defineTool({
  name: 'search_text',
  implementationId: 'agent-core.search-text.v1',
  description: 'Search rooted text with ripgrep and report file, line, and occurrence counts.',
  schema: searchTextInputSchema,
  outputSchema: searchTextOutputSchema,
  buildModelContent: buildSearchTextContent,
  requirements: {
    services: ['localToolConfiguration']
  },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    return { ...input, path: normalizeFilePath(context, input.path) };
  },
  deriveEffects(input) {
    return {
      accesses: fileSelectionScopes(input.path, input.respectGitIgnore).map((scope) => ({
        mode: 'read' as const, scope
      })),
      lockScopes: [],
      recovery: { kind: 'unknown' }
    };
  },
  invoke: searchText
});
