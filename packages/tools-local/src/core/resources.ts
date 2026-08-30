import type { EvidenceResource } from '@agent-core/evidence';
import { validateResourceScope } from '@agent-core/tools';

export const FILES_SCOPE = 'files';
export const PROCESSES_SCOPE = 'processes';
export const PATCH_JOURNAL_SCOPE = 'files/internal/patch-journal';

export function fileScope(relativePath = ''): string { return scoped(FILES_SCOPE, relativePath); }
export function processScope(processId = ''): string { return scoped(PROCESSES_SCOPE, processId); }
export function rootedFileResource(path: string, options: Omit<EvidenceResource, 'uri'> = {}): EvidenceResource {
  const clean = path.replaceAll('\\', '/').replace(/^\.?\/+/u, '').replace(/\/+$/u, '');
  return { uri: clean.length === 0 || clean === '.' ? 'rooted-file:///' : `rooted-file:///${clean}`, ...options };
}

function scoped(parent: string, child: string): string {
  const clean = child.replaceAll('\\', '/').replace(/^\.?\/+/u, '').replace(/\/+$/u, '');
  return clean.length === 0 || clean === '.' ? parent : validateResourceScope(`${parent}/${clean}`);
}
