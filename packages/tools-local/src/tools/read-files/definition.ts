import { defineTool, requireWorkspaceRoot } from '@agent-core/tools';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { readFiles } from './run.js';
import { readFilesInputSchema, readFilesOutputSchema } from './schema.js';

export const readFilesTool = defineTool({
  name: 'read_files',
  implementationId: 'agent-core.read-files.v1',
  description: 'Read line ranges from one or more workspace text files without loading complete files.',
  schema: readFilesInputSchema,
  outputSchema: readFilesOutputSchema,
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  async canonicalizeInput(input, context) {
    const root = requireWorkspaceRoot(context);
    return { ...input, files: await Promise.all(input.files.map(async (file) => ({ ...file, path: await canonicalWorkspacePath(root, file.path) }))) };
  },
  deriveEffects(input) {
    return { accesses: input.files.map((file) => ({ mode: 'read' as const, scope: `workspace/files/${file.path}` })), lockScopes: [], idempotency: 'pure' };
  },
  invoke: readFiles
});
