import { defineTool, requireWorkspaceRoot, ToolInputError } from '@agent-core/tools';
import type { ToolObservation } from '@agent-core/tools';
import { toolFailurePresentation, toJsonValue, type ToolObservationPresentation } from '@agent-core/tools';
import { isRiskAllowed } from '@agent-core/tools';
import { APPLY_PATCH_LARK_GRAMMAR } from './grammar.js';
import { APPLY_PATCH_PROMPT_GUIDE } from './prompt-guide.js';
import { applyPatch, patchFailureFromError } from './run.js';
import { applyPatchInputSchema, type ApplyPatchOutput } from './schema.js';
import { canonicalWorkspacePath } from '../../core/filesystem.js';
import { parseApplyPatch } from './patch-parser.js';

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  implementationId: '@agent-core/tools-local/apply-patch@1',
  description: 'Apply one Codex-style patch document transactionally. First call shape: {"patch":"*** Begin Patch\\n*** Update File: relative/path.txt\\n@@\\n-old\\n+new\\n*** End Patch"}. Supports *** Add File, *** Update File, *** Delete File, and *** Move to inside an Update File section. Do not pass raw git/unified diffs; use this patch wrapper.',
  schema: applyPatchInputSchema,
  textInput: {
    description: 'Use the apply_patch tool to edit files. This is a freeform patch tool: pass the patch document directly, without JSON wrapping. The patch must start with *** Begin Patch and end with *** End Patch.',
    promptGuide: APPLY_PATCH_PROMPT_GUIDE,
    format: {
      type: 'grammar',
      syntax: 'lark',
      definition: APPLY_PATCH_LARK_GRAMMAR
    },
    decode(text) {
      return { patch: text };
    }
  },
  risk: 'write',
  declaredEffects: { kind: 'write', resourceScopes: ['workspace/files'], idempotency: 'non_idempotent', reversible: true, compensation: { kind: 'reverse_patch' } },
  async canonicalizeInput(input, context) {
    const root = requireWorkspaceRoot(context);
    let parsed;
    try {
      parsed = parseApplyPatch(input.patch, { maxPatchBytes: input.maxPatchBytes });
    } catch (error) {
      const failure = patchFailureFromError('', error);
      throw new ToolInputError(failure.message, { failures: [failure] });
    }
    const requested = parsed.operations.flatMap((operation) => operation.kind === 'update' && operation.moveTo ? [operation.path, operation.moveTo] : [operation.path]);
    for (const item of [...requested, ...Object.keys(input.expectedOldSha256 ?? {})]) {
      const canonical = await canonicalWorkspacePath(root, item);
      if (canonical !== normalizePatchPath(item)) throw new ToolInputError(`Patch path is not canonical inside the workspace: ${item}`, { path: item, canonical });
    }
    return input;
  },
  async deriveEffects(input, context) {
    const root = requireWorkspaceRoot(context);
    const parsed = parseApplyPatch(input.patch, { maxPatchBytes: input.maxPatchBytes });
    const paths = parsed.operations.flatMap((operation) => operation.kind === 'update' && operation.moveTo ? [operation.path, operation.moveTo] : [operation.path]);
    const scopes = await Promise.all(paths.map(async (item) => `workspace/files/${await canonicalWorkspacePath(root, item)}`));
    return { kind: 'write', resourceScopes: [...new Set(scopes)].sort(), idempotency: 'non_idempotent', reversible: true, compensation: { kind: 'reverse_patch' } };
  },
  isAvailable: (policy) => isRiskAllowed(policy, 'write') || policy.dryRunWrites === true,
  invoke: applyPatch,
  presentObservation: ({ input, observation }): ToolObservationPresentation => {
    if (!observation.ok) {
      return applyPatchFailurePresentation(observation);
    }
    const output = observation.output;
    return {
      ok: true,
      title: 'Patch result',
      summary: observation.summary,
      scope: {
        patchBytes: Buffer.byteLength(input.patch, 'utf8'),
        operationCount: output.totalOperationCount
      },
      limits: {
        maxPatchBytes: input.maxPatchBytes,
        maxBytesPerFile: input.maxBytesPerFile,
        maxNewBytesPerFile: input.maxNewBytesPerFile
      },
      results: toJsonValue({
        dryRun: output.dryRun,
        transactional: output.transactional,
        files: output.files,
        changedPaths: output.changedPaths,
        wouldChangePaths: output.wouldChangePaths,
        createdPaths: output.createdPaths,
        wouldCreatePaths: output.wouldCreatePaths,
        deletedPaths: output.deletedPaths,
        wouldDeletePaths: output.wouldDeletePaths,
        movedPaths: output.movedPaths,
        wouldMovePaths: output.wouldMovePaths,
        totalOperationCount: output.totalOperationCount,
        totalHunkCount: output.totalHunkCount,
        totalAdditions: output.totalAdditions,
        totalDeletions: output.totalDeletions
      }),
      truncated: false,
      next: output.dryRun ? 'Dry run only: call apply_patch with dryRun:false or omitted when real edits are intended and policy allows them.' : 'Use changedPaths as the changed path set, then run checks or inspect changed regions if verification is needed.'
    };
  }
});

function applyPatchFailurePresentation(observation: ToolObservation<ApplyPatchOutput>): ToolObservationPresentation {
  const output: Record<string, unknown> = isRecord(observation.output) ? observation.output : {};
  const details: Record<string, unknown> = isRecord(output.details) ? output.details : {};
  const rawFailures = Array.isArray(details.failures) ? details.failures.filter(isRecord) : [];
  if (output.reason !== 'invalid_arguments' || rawFailures.length === 0) {
    return toolFailurePresentation('apply_patch', observation);
  }

  const visibleFailures = rawFailures.slice(0, 5).map(patchFailureForPresentation);
  const omittedFailures = Math.max(0, rawFailures.length - visibleFailures.length);
  return {
    ok: false,
    title: 'Patch validation failed',
    summary: observation.summary,
    failures: toJsonValue({
      reason: 'invalid_arguments',
      transactional: true,
      written: false,
      failureCount: rawFailures.length,
      items: visibleFailures
    }),
    ...(omittedFailures > 0 ? { omitted: { failures: omittedFailures } } : {}),
    coverage: omittedFailures > 0 ? 'partial' : 'complete',
    next: stringValue(visibleFailures[0]?.nextAction)
      ?? 'Fix the patch and call apply_patch again. No files were written.'
  };
}

function patchFailureForPresentation(failure: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries({
    path: stringValue(failure.path),
    operation: stringValue(failure.operation),
    hunk: typeof failure.hunkIndex === 'number' ? failure.hunkIndex + 1 : undefined,
    reason: stringValue(failure.reason),
    message: stringValue(failure.message),
    header: stringValue(failure.header),
    failingLine: shortText(stringValue(failure.failingLine)),
    oldPreview: shortText(stringValue(failure.oldPreview)),
    matchCount: typeof failure.matchCount === 'number' ? failure.matchCount : undefined,
    candidateLines: numberArray(failure.candidateLines),
    possiblyAlreadyApplied: typeof failure.possiblyAlreadyApplied === 'boolean' ? failure.possiblyAlreadyApplied : undefined,
    nextAction: stringValue(failure.nextAction)
  }).filter((entry) => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

function shortText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length <= 500 ? value : `${value.slice(0, 500)}\n[preview truncated]`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return numbers.length > 0 ? numbers : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePatchPath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/u, ''); }
