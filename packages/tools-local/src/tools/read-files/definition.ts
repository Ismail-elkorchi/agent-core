import { defineTool } from '@agent-core/tools';
import { workspaceFileScope } from '../../core/resources.js';
import { readFiles } from './run.js';
import { presentReadFilesObservation } from '../../core/presenters.js';
import { requireWorkspaceFileRoot } from '../../core/workspace.js';
import { readFilesInputSchema, readFilesOutputSchema } from './schema.js';

export const readFilesTool = defineTool({
  name: 'read_files',
  implementationId: 'agent-core.read-files.v1',
  description: 'Read line ranges from one or more workspace text files without loading complete files.',
  schema: readFilesInputSchema,
  outputSchema: readFilesOutputSchema,
  presentObservation: presentReadFilesObservation,
  requirements: { services: ['workspaceFileRoot', 'localToolConfiguration'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    const root = requireWorkspaceFileRoot(context);
    return { ...input, files: input.files.map((file) => ({ ...file, path: root.canonicalPath(file.path) })) };
  },
  deriveEffects(input) {
    return { accesses: [...new Set(input.files.map((file) => workspaceFileScope(file.path)))].map((scope) => ({ mode: 'read' as const, scope })), lockScopes: [], recovery: { kind: 'unknown' } };
  },
  invoke: readFiles
});
