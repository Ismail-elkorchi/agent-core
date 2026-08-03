import { promises as fs } from 'node:fs';
import path from 'node:path';
export interface WorkspaceLayout {
  readonly workspaceRoot: string;
  readonly workspaceName: string;
  readonly runtimeDir: string;
  readonly runsDir: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
}

export interface LoadWorkspaceOptions {
  storageDirName?: string;
}

export async function loadWorkspace(rootDir: string, options: LoadWorkspaceOptions = {}): Promise<WorkspaceLayout> {
  const resolvedRoot = path.resolve(rootDir);
  const stat = await fs.stat(resolvedRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${resolvedRoot}`);
  }
  const canonicalRoot = await fs.realpath(resolvedRoot);
  return describeWorkspace(canonicalRoot, options);
}

export function describeWorkspace(rootDir: string, options: LoadWorkspaceOptions = {}): WorkspaceLayout {
  const root = path.resolve(rootDir);
  const runtimeDir = path.join(root, options.storageDirName ?? '.agent-core');
  return {
    workspaceRoot: root,
    workspaceName: path.basename(root),
    runtimeDir,
    runsDir: path.join(runtimeDir, 'runs'),
    sessionsDir: path.join(runtimeDir, 'sessions'),
    artifactsDir: path.join(runtimeDir, 'artifacts')
  };
}
