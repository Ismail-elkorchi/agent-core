import type { ObservedResource } from '@agent-core/tools';
import { validateResourceScope } from '@agent-core/tools';

export const FILES_SCOPE = 'files';
export const PROCESSES_SCOPE = 'processes';
export const PATCH_JOURNAL_SCOPE = 'files/internal/patch-journal';

export function fileScope(relativePath = ''): string { return scoped(FILES_SCOPE, relativePath); }
/** Selection reads ancestor ignore files as well as the requested subtree. */
export function fileSelectionScopes(relativePath: string, respectGitIgnore: boolean): string[] {
  const scopes = [fileScope(relativePath)];
  if (respectGitIgnore && relativePath !== '.') {
    const segments = relativePath.split('/');
    segments.pop();
    for (;;) {
      scopes.push(fileScope([...segments, '.gitignore'].join('/')));
      if (segments.length === 0) break;
      segments.pop();
    }
  }
  return scopes;
}
export function processScope(processId = ''): string { return scoped(PROCESSES_SCOPE, processId); }
export function rootedFileResource(path: string, options: Omit<ObservedResource, 'uri'> = {}): ObservedResource {
  const clean = path.replaceAll('\\', '/').replace(/^\.?\/+/u, '').replace(/\/+$/u, '');
  return { uri: clean.length === 0 || clean === '.' ? 'rooted-file:///' : `rooted-file:///${clean}`, ...options };
}

function scoped(parent: string, child: string): string {
  const clean = child.replaceAll('\\', '/').replace(/^\.?\/+/u, '').replace(/\/+$/u, '');
  return clean.length === 0 || clean === '.' ? parent : validateResourceScope(`${parent}/${clean}`);
}
