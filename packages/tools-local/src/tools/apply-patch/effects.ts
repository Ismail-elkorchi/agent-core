import { fileScope } from '../../core/resources.js';
import type { ParsedApplyPatch } from './patch-parser.js';

export function normalizePatchPath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/u, '');
}

interface PatchAccess {
  readonly mode: 'read' | 'write' | 'delete';
  readonly scope: string;
}

export function operationAccesses(
  operation: ParsedApplyPatch['operations'][number],
  dryRun: boolean
): PatchAccess[] {
  const source = fileScope(normalizePatchPath(operation.path));
  if (dryRun) {
    return operation.kind === 'update' && operation.moveTo
      ? [
          { mode: 'read', scope: source },
          { mode: 'read', scope: fileScope(normalizePatchPath(operation.moveTo)) }
        ]
      : [{ mode: 'read', scope: source }];
  }
  if (operation.kind === 'add')
    return [
      { mode: 'read', scope: source },
      { mode: 'write', scope: source }
    ];
  if (operation.kind === 'delete')
    return [
      { mode: 'read', scope: source },
      { mode: 'delete', scope: source }
    ];
  if (operation.moveTo) {
    const destination = fileScope(normalizePatchPath(operation.moveTo));
    return [
      { mode: 'read', scope: source },
      { mode: 'delete', scope: source },
      { mode: 'read', scope: destination },
      { mode: 'write', scope: destination }
    ];
  }
  return [
    { mode: 'read', scope: source },
    { mode: 'write', scope: source }
  ];
}

export function uniqueAccesses(accesses: readonly PatchAccess[]): PatchAccess[] {
  const unique = new Map(accesses.map((access) => [`${access.mode}\0${access.scope}`, access]));
  return [...unique.values()].sort(
    (left, right) =>
      left.scope.localeCompare(right.scope, 'en') || left.mode.localeCompare(right.mode, 'en')
  );
}
