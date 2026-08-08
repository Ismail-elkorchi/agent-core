import path from 'node:path';
import { promises as fs } from 'node:fs';
import { evidenceDelta, workspaceResource, type EvidenceAction, type ToolEvidenceItem } from '@agent-core/evidence';
import { requireToolService, requireWorkspaceRoot, throwIfAborted, ToolInputError, type ToolExecutionContext } from '@agent-core/tools';
import type { ToolObservation } from '@agent-core/tools';
import {
  byteLengthUtf8,
  inspectTextFile,
  isProbablyBinary,
  relativePath,
  resolveInsideRoot,
  sha256Text,
  validateParentDirectory
} from '../../core/filesystem.js';
import { invalidToolInputObservation, runtimeErrorObservation } from '@agent-core/tools';
import { commitTextFilePatchTransaction, recoverTextFilePatchTransactions, type PreparedTextPatchRemove, type PreparedTextPatchWrite, type TextTransactionResult } from '../../core/text-write.js';
import { splitLogicalLines } from '@agent-core/tools';
import { applyPatchUpdate, PatchApplyError } from './apply-diff.js';
import { PatchParseError, type ParsedApplyPatch, type ParsedPatchOperation } from './patch-parser.js';
import type {
  ApplyPatchFailure,
  ApplyPatchFileOutput,
  ApplyPatchInput,
  ApplyPatchOperation,
  ApplyPatchOutput,
  ApplyPatchPathPair
} from './schema.js';

export interface CanonicalApplyPatchInput extends ApplyPatchInput {
  readonly tree: ParsedApplyPatch;
  readonly limits: {
    readonly maxPatchBytes: number;
    readonly maxOperations: number;
    readonly maxFileBytes: number;
    readonly maxNewBytesPerFile: number;
  };
}

interface PreparedPatchOperation {
  output: ApplyPatchFileOutput;
  write?: PreparedTextPatchWrite;
  remove?: PreparedTextPatchRemove;
  parentDirsToCreate: string[];
  createdPath?: string;
  deletedPath?: string;
  move?: ApplyPatchPathPair;
  changedPaths: string[];
}

export async function applyPatch(input: CanonicalApplyPatchInput, context: ToolExecutionContext): Promise<ToolObservation<ApplyPatchOutput>> {
  throwIfAborted(context.signal);
  const rootDir = requireWorkspaceRoot(context);
  const dryRun = input.dryRun;
  const journalDirectory = dryRun ? undefined : requireToolService(context, 'patchTransactionDirectory', isNonEmptyString, 'non-empty patch transaction directory');
  if (journalDirectory) await recoverTextFilePatchTransactions(rootDir, journalDirectory);
  await context.emitProgress?.({ stage: 'prepare', message: 'Preparing patch transaction.', completed: 0, total: input.tree.operations.length });
  const { prepared, failures } = await preparePatch(rootDir, input);

  if (failures.length > 0) {
    return invalidToolInputObservation('apply_patch', summarizePatchFailures(failures), {
      failures
    });
  }
  await context.emitProgress?.({ stage: 'prepare', message: 'Patch transaction prepared.', completed: prepared.length, total: input.tree.operations.length });

  const changed = prepared.filter((operation) => operation.output.changed);
  if (!dryRun && changed.length > 0) {
    if (!journalDirectory) throw new Error('Patch journal directory is unavailable for a write transaction.');
    throwIfAborted(context.signal);
    await context.emitProgress?.({ stage: 'commit', message: 'Committing patch transaction.', completed: 0, total: changed.length });
    const transactionId = patchTransactionId(context);
    const transaction = await commitTextFilePatchTransaction(rootDir, {
      writes: changed.flatMap((operation) => operation.write ? [operation.write] : []),
      removes: changed.flatMap((operation) => operation.remove ? [operation.remove] : []),
      parentDirsToCreate: changed.flatMap((operation) => operation.parentDirsToCreate)
    }, {
      ...(context.signal ? { signal: context.signal } : {}),
      journalDirectory,
      ...(transactionId ? { transactionId } : {})
    });
    if (transaction.outcome !== 'committed') {
      await context.emitProgress?.({ stage: 'rollback', message: `Patch rollback ${transactionRecovery(transaction)}.` });
      const message = transactionFailureMessage(transaction);
      return runtimeErrorObservation('apply_patch', message, { transaction });
    }
    await context.emitProgress?.({ stage: 'commit', message: 'Patch transaction committed.', completed: changed.length, total: changed.length });
  }

  const wouldChangePaths = uniquePaths(changed.flatMap((operation) => operation.changedPaths));
  const changedPaths = dryRun ? [] : [...wouldChangePaths];
  const wouldCreatePaths = changed.flatMap((operation) => operation.createdPath ? [operation.createdPath] : []);
  const wouldDeletePaths = changed.flatMap((operation) => operation.deletedPath ? [operation.deletedPath] : []);
  const wouldMovePaths = changed.flatMap((operation) => operation.move ? [operation.move] : []);
  const output: ApplyPatchOutput = {
    dryRun,
    transactional: true,
    files: prepared.map((operation) => operation.output),
    changedPaths,
    wouldChangePaths,
    createdPaths: dryRun ? [] : [...wouldCreatePaths],
    wouldCreatePaths,
    deletedPaths: dryRun ? [] : [...wouldDeletePaths],
    wouldDeletePaths,
    movedPaths: dryRun ? [] : wouldMovePaths.map((item) => ({ ...item })),
    wouldMovePaths: wouldMovePaths.map((item) => ({ ...item })),
    totalOperationCount: prepared.length,
    totalHunkCount: prepared.reduce((total, operation) => total + operation.output.hunkCount, 0),
    totalAdditions: prepared.reduce((total, operation) => total + operation.output.additions, 0),
    totalDeletions: prepared.reduce((total, operation) => total + operation.output.deletions, 0)
  };
  return {
    kind: 'result',
    ok: true,
    summary: summarizePatchOutput(output),
    scope: { resources: uniquePaths(prepared.flatMap((operation) => operation.changedPaths)).map((item) => `workspace/files/${item}`), coverage: 'complete' },
    output,
    evidence: evidenceDelta(patchEvidenceItems(output)),
    ...(!dryRun ? { metadata: { changedPaths: output.changedPaths } } : {})
  };
}

/** Builds the one transaction plan used by both dry-run and commit execution. */
export async function preparePatch(rootDir: string, input: CanonicalApplyPatchInput): Promise<{
  readonly prepared: PreparedPatchOperation[];
  readonly failures: ApplyPatchFailure[];
}> {
  const prepared: PreparedPatchOperation[] = [];
  const failures: ApplyPatchFailure[] = [];
  const reservedPaths = new Set<string>();
  for (const operation of input.tree.operations) {
    const result = await prepareOperation(rootDir, operation, input, reservedPaths);
    if (result.ok) prepared.push(result.operation);
    else failures.push(result.failure);
  }
  return { prepared, failures };
}

function patchTransactionId(context: ToolExecutionContext): string | undefined {
  const invocation = context.invocation;
  return invocation
    ? `${invocation.runId}-${invocation.turnId}-${invocation.toolBatchId}-${String(invocation.callIndex)}-${String(invocation.toolAttempt)}`
    : undefined;
}

function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

function transactionRecovery(result: Exclude<TextTransactionResult, { outcome: 'committed' }>): 'succeeded' | 'failed' | 'uncertain' {
  return result.outcome === 'committed_with_residue' ? result.cleanup.status : result.rollback.status;
}
function transactionFailureMessage(result: Exclude<TextTransactionResult, { outcome: 'committed' }>): string {
  if (result.outcome === 'committed_with_residue') return `Patch contents were committed, but cleanup ${result.cleanup.status}; residue may remain at: ${result.cleanup.strandedPaths.join(', ') || 'unknown paths'}.`;
  return `Patch commit failed and rollback ${result.rollback.status}: ${result.failure.message}`;
}

function patchEvidenceItems(output: ApplyPatchOutput): ToolEvidenceItem[] {
  return output.files
    .filter((file) => file.changed)
    .map((file) => {
      const action = evidenceActionForPatch(file.operation);
      const resources = [workspaceResource(file.path, {
        ...(file.newSha256 ? { sha256: file.newSha256 } : {}),
        mediaType: 'text/plain'
      })];
      if (file.destinationPath && file.destinationPath !== file.path) {
        resources.push(workspaceResource(file.destinationPath, {
          ...(file.newSha256 ? { sha256: file.newSha256 } : {}),
          mediaType: 'text/plain'
        }));
      }
      return {
        action,
        resources,
        scope: {
          limits: {
            dryRun: output.dryRun,
            hunkCount: file.hunkCount,
            additions: file.additions,
            deletions: file.deletions
          },
          truncated: false,
          confidence: output.dryRun ? 'unverified' : 'verified'
        },
        summary: `${output.dryRun ? 'Would ' : ''}${action} ${file.destinationPath ?? file.path}.`
      };
    });
}

function evidenceActionForPatch(operation: ApplyPatchFileOutput['operation']): EvidenceAction {
  if (operation === 'add') return 'create';
  if (operation === 'delete') return 'delete';
  if (operation === 'move') return 'move';
  return 'update';
}

async function prepareOperation(
  rootDir: string,
  operation: ParsedPatchOperation,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PreparedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  if (operation.kind === 'add') {
    return prepareAdd(rootDir, operation.path, operation.content, operation.additions, input, reservedPaths);
  }
  if (operation.kind === 'delete') {
    return prepareDelete(rootDir, operation.path, input, reservedPaths);
  }
  return prepareUpdate(rootDir, operation, input, reservedPaths);
}

async function prepareAdd(
  rootDir: string,
  requestedPath: string,
  content: string,
  additions: number,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PreparedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  const target = await inspectNewTarget(rootDir, requestedPath, 'already_exists');
  if (!target.ok) {
    return { ok: false, failure: withFailureContext(target.failure, 'add') };
  }
  const duplicate = reservePath(reservedPaths, target.absolutePath, target.path);
  if (duplicate) {
    return { ok: false, failure: withFailureContext(duplicate, 'add') };
  }
  const bytes = byteLengthUtf8(content);
  if (bytes > input.limits.maxNewBytesPerFile) {
    return {
      ok: false,
      failure: {
        path: target.path,
        operation: 'add',
        reason: 'result_too_large',
        message: `Created file would be too large (${String(bytes)} bytes, host max ${String(input.limits.maxNewBytesPerFile)}): ${target.path}`,
        nextAction: 'Reduce the added file content.'
      }
    };
  }
  if (isProbablyBinary(Buffer.from(content, 'utf8'))) {
    return {
      ok: false,
      failure: {
        path: target.path,
        operation: 'add',
        reason: 'binary',
        message: `Refusing probable binary content for text file: ${target.path}`,
        nextAction: 'Use apply_patch only for text files; use a different mechanism for binary content.'
      }
    };
  }
  return {
    ok: true,
    operation: {
      output: {
        path: target.path,
        operation: 'add',
        hunkCount: 0,
        additions,
        deletions: 0,
        newSha256: sha256Text(content),
        oldBytes: 0,
        newBytes: bytes,
        changed: true
      },
      write: {
        path: target.path,
        absolutePath: target.absolutePath,
        content,
        overwrite: false
      },
      parentDirsToCreate: target.parentDirsToCreate,
      createdPath: target.path,
      changedPaths: [target.path]
    }
  };
}

async function prepareDelete(
  rootDir: string,
  requestedPath: string,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PreparedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  const inspected = await inspectTextFile(rootDir, requestedPath, input.limits.maxFileBytes, { rejectSymlink: true });
  if (!inspected.ok) {
    return { ok: false, failure: textFileFailure(inspected.failure.path, inspected.failure.reason, inspected.failure.message, 'delete') };
  }
  const duplicate = reservePath(reservedPaths, inspected.file.absolutePath, inspected.file.path);
  if (duplicate) {
    return { ok: false, failure: withFailureContext(duplicate, 'delete') };
  }
  const oldSha256 = sha256Text(inspected.file.content);
  const shaFailure = validateExpectedSha(input, requestedPath, inspected.file.path, oldSha256, 'delete');
  if (shaFailure) {
    return { ok: false, failure: shaFailure };
  }
  const deletions = splitLogicalLines(inspected.file.content).lines.length;
  return {
    ok: true,
    operation: {
      output: {
        path: inspected.file.path,
        operation: 'delete',
        hunkCount: 0,
        additions: 0,
        deletions,
        oldSha256,
        oldBytes: inspected.file.bytes,
        newBytes: 0,
        changed: true
      },
      remove: {
        path: inspected.file.path,
        absolutePath: inspected.file.absolutePath
      },
      parentDirsToCreate: [],
      deletedPath: inspected.file.path,
      changedPaths: [inspected.file.path]
    }
  };
}

async function prepareUpdate(
  rootDir: string,
  operation: Extract<ParsedPatchOperation, { kind: 'update' }>,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PreparedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  const inspected = await inspectTextFile(rootDir, operation.path, input.limits.maxFileBytes, { rejectSymlink: true });
  if (!inspected.ok) {
    return { ok: false, failure: textFileFailure(inspected.failure.path, inspected.failure.reason, inspected.failure.message, 'update') };
  }
  const sourceDuplicate = reservePath(reservedPaths, inspected.file.absolutePath, inspected.file.path);
  if (sourceDuplicate) {
    return { ok: false, failure: withFailureContext(sourceDuplicate, operation.moveTo ? 'move' : 'update') };
  }

  const oldSha256 = sha256Text(inspected.file.content);
  const shaFailure = validateExpectedSha(input, operation.path, inspected.file.path, oldSha256, operation.moveTo ? 'move' : 'update');
  if (shaFailure) {
    return { ok: false, failure: shaFailure };
  }

  let patched;
  try {
    patched = applyPatchUpdate(inspected.file.content, operation);
  } catch (error) {
    return { ok: false, failure: patchFailureFromError(inspected.file.path, error, operation.moveTo ? 'move' : 'update') };
  }

  const newBytes = byteLengthUtf8(patched.content);
  if (newBytes > input.limits.maxNewBytesPerFile) {
    return {
      ok: false,
      failure: {
        path: inspected.file.path,
        operation: operation.moveTo ? 'move' : 'update',
        reason: 'result_too_large',
        message: `Patched file would be too large (${String(newBytes)} bytes, host max ${String(input.limits.maxNewBytesPerFile)}): ${inspected.file.path}`,
        nextAction: 'Reduce the patch result size.'
      }
    };
  }

  if (operation.moveTo) {
    const target = await inspectNewTarget(rootDir, operation.moveTo, 'destination_exists');
    if (!target.ok) {
      return { ok: false, failure: withFailureContext(target.failure, 'move') };
    }
    const targetDuplicate = reservePath(reservedPaths, target.absolutePath, target.path);
    if (targetDuplicate) {
      return { ok: false, failure: withFailureContext(targetDuplicate, 'move') };
    }
    return {
      ok: true,
      operation: {
        output: {
          path: inspected.file.path,
          operation: 'move',
          destinationPath: target.path,
          hunkCount: patched.hunkCount,
          additions: patched.additions,
          deletions: patched.deletions,
          oldSha256,
          newSha256: sha256Text(patched.content),
          oldBytes: inspected.file.bytes,
          newBytes,
          changed: true,
          matchModes: patched.matchModes,
          exact: patched.exact
        },
        write: {
          path: target.path,
          absolutePath: target.absolutePath,
          content: patched.content,
          mode: inspected.file.mode,
          overwrite: false
        },
        remove: {
          path: inspected.file.path,
          absolutePath: inspected.file.absolutePath
        },
        parentDirsToCreate: target.parentDirsToCreate,
        move: { sourcePath: inspected.file.path, destinationPath: target.path },
        changedPaths: [inspected.file.path, target.path]
      }
    };
  }

  return {
    ok: true,
    operation: {
      output: {
        path: inspected.file.path,
        operation: 'update',
        hunkCount: patched.hunkCount,
        additions: patched.additions,
        deletions: patched.deletions,
        oldSha256,
        newSha256: sha256Text(patched.content),
        oldBytes: inspected.file.bytes,
        newBytes,
        changed: patched.changed,
        matchModes: patched.matchModes,
        exact: patched.exact
      },
      ...(patched.changed ? {
        write: {
          path: inspected.file.path,
          absolutePath: inspected.file.absolutePath,
          content: patched.content,
          mode: inspected.file.mode,
          overwrite: true
        }
      } : {}),
      parentDirsToCreate: [],
      changedPaths: patched.changed ? [inspected.file.path] : []
    }
  };
}

async function inspectNewTarget(
  rootDir: string,
  requestedPath: string,
  existsReason: 'already_exists' | 'destination_exists'
): Promise<
  | { ok: true; path: string; absolutePath: string; parentDirsToCreate: string[] }
  | { ok: false; failure: ApplyPatchFailure }
> {
  let absolutePath;
  try {
    absolutePath = resolveInsideRoot(rootDir, requestedPath, { emptyPathMessage: 'Path cannot be empty.' });
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { ok: false, failure: { path: requestedPath, reason: 'path_outside_workspace', message: error.message } };
    }
    throw error;
  }
  const normalizedPath = relativePath(rootDir, absolutePath);
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      return { ok: false, failure: { path: normalizedPath, reason: 'symlink', message: `Refusing to write through symlink path: ${requestedPath}` } };
    }
    return {
      ok: false,
      failure: {
        path: normalizedPath,
        reason: existsReason,
        message: existsReason === 'already_exists' ? `File already exists: ${requestedPath}` : `Destination already exists: ${requestedPath}`
      }
    };
  } catch {
    const parent = await validateParentDirectory(rootDir, absolutePath, requestedPath, true);
    if (!parent.ok) {
      return {
        ok: false,
        failure: {
          path: parent.failure.path,
          reason: parent.failure.reason,
          message: parent.failure.message
        }
      };
    }
    return {
      ok: true,
      path: normalizedPath,
      absolutePath: path.resolve(absolutePath),
      parentDirsToCreate: parent.parentDirsToCreate
    };
  }
}

function reservePath(paths: Set<string>, absolutePath: string, displayPath: string): ApplyPatchFailure | undefined {
  const resolved = path.resolve(absolutePath);
  if (paths.has(resolved)) {
    return {
      path: displayPath,
      reason: 'duplicate_path',
      message: `Duplicate patch target after path normalization: ${displayPath}`
    };
  }
  paths.add(resolved);
  return undefined;
}

function validateExpectedSha(input: CanonicalApplyPatchInput, requestedPath: string, displayPath: string, actualSha256: string, operation: ApplyPatchOperation): ApplyPatchFailure | undefined {
  const expected = input.expectedOldSha256?.[requestedPath] ?? input.expectedOldSha256?.[displayPath];
  if (expected && expected !== actualSha256) {
    return {
      path: displayPath,
      operation,
      reason: 'sha256_mismatch',
      message: `Expected SHA-256 did not match current file content for ${displayPath}.`,
      nextAction: 'Read the current file, refresh expectedOldSha256, and rebuild the patch against the current content.'
    };
  }
  return undefined;
}

function textFileFailure(path: string, reason: ApplyPatchFailure['reason'], message: string, operation: ApplyPatchOperation): ApplyPatchFailure {
  return withFailureContext({ path, reason, message }, operation);
}

export function patchFailureFromError(filePath: string, error: unknown, operation?: ApplyPatchOperation): ApplyPatchFailure {
  if (error instanceof PatchParseError) {
    return withFailureContext({
      path: error.path ?? filePath,
      reason: 'patch_parse_error',
      message: error.message,
      ...(error.hunkIndex !== undefined ? { hunkIndex: error.hunkIndex } : {}),
      ...(error.header ? { header: error.header } : {}),
      ...(error.failingLine !== undefined ? { failingLine: error.failingLine } : {}),
      ...(error.oldPreview ? { oldPreview: error.oldPreview } : {}),
      nextAction: nextActionForParseError(error)
    }, operation);
  }
  if (error instanceof PatchApplyError) {
    return withFailureContext({
      path: filePath,
      reason: error.reason,
      message: error.message,
      hunkIndex: error.hunkIndex,
      ...(error.header ? { header: error.header } : {}),
      ...(error.failingLine ? { failingLine: error.failingLine } : {}),
      oldPreview: error.oldPreview,
      ...(error.matchCount !== undefined ? { matchCount: error.matchCount } : {}),
      ...(error.candidateLines ? { candidateLines: error.candidateLines } : {}),
      ...(error.possiblyAlreadyApplied ? { possiblyAlreadyApplied: true } : {})
    }, operation);
  }
  return withFailureContext({
    path: filePath,
    reason: 'patch_parse_error',
    message: error instanceof Error ? error.message : String(error)
  }, operation);
}

function nextActionForParseError(error: PatchParseError): string {
  if (error.reason === 'hunk_without_change') {
    return 'This hunk only has context lines. Add at least one + or - line, or remove the hunk if no change is needed.';
  }
  if (error.reason === 'invalid_hunk_line') {
    return 'Every update hunk line must start with exactly one of: space for context, - for removal, or + for addition.';
  }
  if (error.reason === 'missing_hunk_header' || error.reason === 'empty_update') {
    return 'Start each Update File change block with @@, then include context/removal/addition lines.';
  }
  if (error.reason === 'unsupported_header') {
    return 'Rewrite the edit using the supported *** Begin Patch wrapper; do not send raw git/unified diff headers.';
  }
  if (error.reason === 'missing_wrapper') {
    return 'Wrap the patch with *** Begin Patch at the start and *** End Patch at the end.';
  }
  if (error.reason === 'empty_add_file') {
    return 'Add File operations need at least one content line prefixed with +.';
  }
  if (error.reason === 'invalid_operation') {
    return 'Use only supported operation headers: *** Add File, *** Update File, *** Delete File, and *** Move to inside Update File.';
  }
  if (error.reason === 'patch_too_large') {
    return 'Split the edit into a smaller patch.';
  }
  return 'Rewrite the patch using the supported *** Begin Patch wrapper and valid operation/hunk lines.';
}

function withFailureContext(failure: ApplyPatchFailure, operation: ApplyPatchOperation | undefined): ApplyPatchFailure {
  return {
    ...failure,
    ...(operation && !failure.operation ? { operation } : {}),
    nextAction: failure.nextAction ?? nextActionForFailure({ ...failure, ...(operation && !failure.operation ? { operation } : {}) })
  };
}

function nextActionForFailure(failure: ApplyPatchFailure): string {
  if (failure.reason === 'context_not_found') {
    return failure.possiblyAlreadyApplied
      ? 'Inspect the current file; the hunk may already be applied or the patch context is stale.'
      : 'Inspect the exact current region again with unnumbered output, then rebuild this hunk from that current text.';
  }
  if (failure.reason === 'ambiguous_context') {
    return 'Inspect the candidate region lines, then add more surrounding context or a narrower @@ header so this hunk matches exactly one location.';
  }
  if (failure.reason === 'patch_parse_error') {
    return 'Rewrite the patch using the supported *** Begin Patch wrapper and valid operation/hunk lines.';
  }
  if (failure.reason === 'duplicate_path') {
    return 'Merge duplicate edits for the same resolved path into one operation.';
  }
  if (failure.reason === 'already_exists' || failure.reason === 'destination_exists') {
    return 'Choose a path that does not already exist, or update/move a different target.';
  }
  if (failure.reason === 'not_found') {
    return 'Check the path and use an existing text file for update, delete, or move operations.';
  }
  if (failure.reason === 'path_outside_workspace') {
    return 'Use a workspace-relative path that stays inside the configured workspace root.';
  }
  if (failure.reason === 'binary') {
    return 'Use apply_patch only for text files.';
  }
  return 'Fix the patch input and call apply_patch again; no files were written.';
}

function summarizePatchFailures(failures: ApplyPatchFailure[]): string {
  const first = failures[0];
  if (!first) {
    return 'Patch validation failed. No files were written.';
  }
  const location = [
    first.operation ? `operation=${first.operation}` : '',
    first.path ? `path=${first.path}` : '',
    first.hunkIndex !== undefined ? `hunk=${String(first.hunkIndex + 1)}` : ''
  ].filter((item) => item.length > 0).join(', ');
  return [
    'Patch validation failed. No files were written.',
    `${first.reason}${location ? ` (${location})` : ''}: ${first.message}`,
    first.nextAction ? `Next: ${first.nextAction}` : ''
  ].filter((item) => item.length > 0).join(' ');
}

function summarizePatchOutput(output: ApplyPatchOutput): string {
  const verb = output.dryRun ? 'Validated' : 'Applied';
  const changed = output.dryRun ? output.wouldChangePaths.length : output.changedPaths.length;
  return `${verb} ${String(output.totalOperationCount)} patch operation${output.totalOperationCount === 1 ? '' : 's'}; ${String(changed)} path${changed === 1 ? '' : 's'} ${output.dryRun ? 'would change' : 'changed'}.`;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
