import { defineTool } from '@agent-core/tools';
import { fileScope } from '../../core/resources.js';
import { readFiles } from './run.js';
import { presentReadFilesObservation } from '../../core/presenters.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { readFilesInputSchema, readFilesOutputSchema } from './schema.js';

export const readFilesTool = defineTool({
  name: 'read_files',
  implementationId: 'agent-core.read-files.v1',
  description: 'Read line ranges from one or more rooted text files with complete-file integrity metadata.',
  schema: readFilesInputSchema,
  outputSchema: readFilesOutputSchema,
  presentObservation: presentReadFilesObservation,
  requirements: { services: ['rootedFileAuthority', 'localToolConfiguration'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    const root = requireRootedFileAuthority(context);
    return { ...input, files: input.files.map((file) => ({ ...file, path: root.canonicalPath(file.path) })) };
  },
  deriveEffects(input) {
    return { accesses: [...new Set(input.files.map((file) => fileScope(file.path)))].map((scope) => ({ mode: 'read' as const, scope })), lockScopes: [], recovery: { kind: 'unknown' } };
  },
  invoke: readFiles
});
