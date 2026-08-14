import type { EvidenceResource } from '@agent-core/evidence';
import { validateResourceScope } from '@agent-core/tools';

export const WORKSPACE_FILES_SCOPE = 'workspace/files';
export const WORKSPACE_PROCESSES_SCOPE = 'workspace/processes';
export const PATCH_JOURNAL_SCOPE = 'workspace/internal/patch-journal';

export function workspaceFileScope(relativePath = ''): string { return scoped(WORKSPACE_FILES_SCOPE, relativePath); }
export function workspaceProcessScope(processId = ''): string { return scoped(WORKSPACE_PROCESSES_SCOPE, processId); }
export function workspaceResource(path: string, options: Omit<EvidenceResource, 'uri'> = {}): EvidenceResource {
  return { uri: `workspace://${path}`, ...options };
}

function scoped(parent: string, child: string): string {
  const clean = child.replaceAll('\\', '/').replace(/^\.?\/+/u, '').replace(/\/+$/u, '');
  return clean.length === 0 || clean === '.' ? parent : validateResourceScope(`${parent}/${clean}`);
}
