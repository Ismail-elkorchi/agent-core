import {
  isWorkspaceFiles,
  type WorkspaceFiles,
  requireToolService,
  type ToolExecutionContext
} from '@agent-core/tools';
import { isRootedFileAuthority, type RootedFileAuthority } from './rooted-file-authority.js';

export type FileAuthority = RootedFileAuthority | WorkspaceFiles;

export function canonicalFilePath(root: FileAuthority, pathname: string): string {
  return isWorkspaceFiles(root) ? root.normalize(pathname) : root.canonicalPath(pathname);
}

export function requireRootedFileAuthority(context: ToolExecutionContext): RootedFileAuthority {
  return requireToolService(
    context,
    'rootedFileAuthority',
    isRootedFileAuthority,
    'adopted RootedFileAuthority'
  );
}

/** A tool composition has exactly one filesystem authority. */
export function requireFileAuthority(
  context: ToolExecutionContext
): FileAuthority {
  const workspace = context.services?.workspaceFiles;
  if (workspace === undefined) return requireRootedFileAuthority(context);
  if (context.services?.rootedFileAuthority !== undefined)
    throw new TypeError('Tool composition supplies competing file authorities.');
  if (!isWorkspaceFiles(workspace)) throw new TypeError('Workspace file authority is invalid.');
  return workspace;
}
export function normalizeFilePath(context: ToolExecutionContext, pathname: string): string {
  const root = requireFileAuthority(context);
  return canonicalFilePath(root, pathname);
}
