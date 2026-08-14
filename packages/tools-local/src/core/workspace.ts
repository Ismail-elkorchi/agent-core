import { requireToolService, type ToolExecutionContext } from '@agent-core/tools';

export function requireWorkspaceRoot(context: ToolExecutionContext): string {
  return requireToolService(
    context,
    'workspaceRoot',
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
    'non-empty string workspace root'
  );
}
