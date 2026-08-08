import { defineTool, isRiskAllowed, requireWorkspaceRoot, ToolInputError } from '@agent-core/tools';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import { APPLY_PATCH_LARK_GRAMMAR } from './grammar.js';
import { parseApplyPatch, type ParsedApplyPatch } from './patch-parser.js';
import { APPLY_PATCH_PROMPT_GUIDE } from './prompt-guide.js';
import { applyPatch, patchFailureFromError, type CanonicalApplyPatchInput } from './run.js';
import { applyPatchInputSchema, applyPatchOutputSchema } from './schema.js';

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  implementationId: 'agent-core.apply-patch.v1',
  description: 'Apply one Codex-style text patch transactionally, including add, update, delete, and move operations.',
  schema: applyPatchInputSchema,
  outputSchema: applyPatchOutputSchema,
  textInput: {
    description: 'Pass the patch document directly, starting with *** Begin Patch and ending with *** End Patch.',
    promptGuide: APPLY_PATCH_PROMPT_GUIDE,
    format: { type: 'grammar', syntax: 'lark', definition: APPLY_PATCH_LARK_GRAMMAR },
    decode: (text) => ({ patch: text })
  },
  effectEnvelope: {
    accesses: [{ mode: 'read', scope: 'workspace/files' }, { mode: 'write', scope: 'workspace/files' }, { mode: 'delete', scope: 'workspace/files' }],
    lockScopes: ['workspace/files']
  },
  async canonicalizeInput(input, context): Promise<CanonicalApplyPatchInput> {
    const root = requireWorkspaceRoot(context);
    const limits = requireLocalToolConfiguration(context).applyPatch;
    let tree: ParsedApplyPatch;
    await context.emitProgress?.({ stage: 'parse', message: 'Parsing patch.' });
    try { tree = parseApplyPatch(input.patch, { maxPatchBytes: limits.maxPatchBytes }); }
    catch (error) {
      const failure = patchFailureFromError('', error);
      throw new ToolInputError(failure.message, { failures: [failure] });
    }
    if (tree.operations.length > limits.maxOperations) {
      throw new ToolInputError(`Patch contains ${String(tree.operations.length)} operations; the host limit is ${String(limits.maxOperations)}.`);
    }
    await context.emitProgress?.({ stage: 'parse', message: 'Patch parsed.', completed: tree.operations.length, total: tree.operations.length });
    const requested = patchPaths(tree);
    for (const item of [...requested, ...Object.keys(input.expectedOldSha256 ?? {})]) {
      const canonical = await canonicalWorkspacePath(root, item);
      if (canonical !== normalizePatchPath(item)) throw new ToolInputError(`Patch path is not canonical inside the workspace: ${item}`, { path: item, canonical });
    }
    return { ...input, dryRun: input.dryRun || context.policy.dryRunWrites === true, tree, limits };
  },
  deriveEffects(input) {
    const accesses = uniqueAccesses(input.tree.operations.flatMap((operation) => operationAccesses(operation, input.dryRun)));
    const lockScopes = input.dryRun ? [] : [...new Set(accesses.filter((access) => access.mode !== 'read').map((access) => access.scope))].sort();
    return { accesses, lockScopes, idempotency: input.dryRun ? 'pure' : 'non_idempotent' };
  },
  isAvailable: (policy) => isRiskAllowed(policy, 'read') || isRiskAllowed(policy, 'write'),
  invoke: applyPatch
});

function patchPaths(tree: ParsedApplyPatch): string[] {
  return tree.operations.flatMap((operation) => operation.kind === 'update' && operation.moveTo ? [operation.path, operation.moveTo] : [operation.path]);
}

function normalizePatchPath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/u, ''); }

interface PatchAccess { readonly mode: 'read' | 'write' | 'delete'; readonly scope: string }

function operationAccesses(operation: ParsedApplyPatch['operations'][number], dryRun: boolean): PatchAccess[] {
  const source = `workspace/files/${normalizePatchPath(operation.path)}`;
  if (dryRun) {
    return operation.kind === 'update' && operation.moveTo
      ? [{ mode: 'read', scope: source }, { mode: 'read', scope: `workspace/files/${normalizePatchPath(operation.moveTo)}` }]
      : [{ mode: 'read', scope: source }];
  }
  if (operation.kind === 'add') return [{ mode: 'read', scope: source }, { mode: 'write', scope: source }];
  if (operation.kind === 'delete') return [{ mode: 'read', scope: source }, { mode: 'delete', scope: source }];
  if (operation.moveTo) {
    const destination = `workspace/files/${normalizePatchPath(operation.moveTo)}`;
    return [{ mode: 'read', scope: source }, { mode: 'delete', scope: source }, { mode: 'read', scope: destination }, { mode: 'write', scope: destination }];
  }
  return [{ mode: 'read', scope: source }, { mode: 'write', scope: source }];
}

function uniqueAccesses(accesses: readonly PatchAccess[]): PatchAccess[] {
  const unique = new Map(accesses.map((access) => [`${access.mode}\0${access.scope}`, access]));
  return [...unique.values()].sort((left, right) => left.scope.localeCompare(right.scope, 'en') || left.mode.localeCompare(right.mode, 'en'));
}
