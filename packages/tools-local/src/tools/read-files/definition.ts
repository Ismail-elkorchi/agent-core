import { defineTool } from '@agent-core/tools';
import { fileScope } from '../../core/resources.js';
import { readFiles } from './run.js';
import { buildReadFilesContent } from '../../core/model-content.js';
import { canonicalFilePath, requireFileAuthority } from '../../core/rooted-files.js';
import { readFilesInputSchema, readFilesOutputSchema } from './schema.js';

export const readFilesTool = defineTool({
  name: 'read_files',
  implementationId: 'agent-core.read-files.v1',
  description:
    'Read line ranges from one or more rooted text files with complete-file integrity metadata.',
  schema: readFilesInputSchema,
  outputSchema: readFilesOutputSchema,
  buildModelContent: buildReadFilesContent,
  requirements: { services: ['localToolConfiguration'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    const root = requireFileAuthority(context);
    return {
      ...input,
      files: input.files.map((file) => ({ ...file, path: canonicalFilePath(root, file.path) }))
    };
  },
  deriveEffects(input) {
    return {
      accesses: [...new Set(input.files.map((file) => fileScope(file.path)))].map((scope) => ({
        mode: 'read' as const,
        scope
      })),
      lockScopes: [],
      recovery: { kind: 'unknown' }
    };
  },
  invoke: readFiles
});
