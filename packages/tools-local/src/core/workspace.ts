import { requireToolService, type ToolExecutionContext } from '@agent-core/tools';
import { isWorkspaceFileRoot, type WorkspaceFileRoot } from './workspace-file-root.js';

export function requireWorkspaceFileRoot(context: ToolExecutionContext): WorkspaceFileRoot {
  return requireToolService(
    context,
    'workspaceFileRoot',
    isWorkspaceFileRoot,
    'adopted WorkspaceFileRoot'
  );
}
