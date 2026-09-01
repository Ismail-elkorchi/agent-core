import type { ObservationAction, ToolResultFact } from '@agent-core/tools';
import { requireToolService, throwIfAborted, ToolInputError, type ToolExecutionContext } from '@agent-core/tools';
import { PATCH_JOURNAL_SCOPE, fileScope, rootedFileResource } from '../../core/resources.js';
import type { ToolObservationInput } from '@agent-core/tools';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import type { RootedFileAuthority } from '../../core/rooted-file-authority.js';
import {
  byteLengthUtf8,
  inspectTextFile,
  isProbablyBinary,
  sha256Text
} from '../../core/filesystem.js';
import { invalidToolInputObservation } from '@agent-core/tools';
import { isTextPatchJournal, withTextFilePatchJournal, type TextPatchRemovePlan, type TextPatchWritePlan, type TextPatchJournal, type TextPatchJournalAuthority, type TextTransactionResult } from '../../core/text-write.js';
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

interface PlannedPatchOperation {
  output: ApplyPatchFileOutput;
  write?: TextPatchWritePlan;
  remove?: TextPatchRemovePlan;
  parentDirsToCreate: readonly string[];
  createdPath?: string;
  deletedPath?: string;
  move?: ApplyPatchPathPair;
  changedPaths: string[];
}

export async function applyPatch(input: CanonicalApplyPatchInput, context: ToolExecutionContext): Promise<ToolObservationInput<ApplyPatchOutput>> {
  throwIfAborted(context.signal);
  const root = requireRootedFileAuthority(context);
  const dryRun = input.dryRun;
  const journal = dryRun ? undefined : requireToolService<TextPatchJournal>(context, 'patchJournal', isTextPatchJournal, 'adopted TextPatchJournal');
  if (journal) return withTextFilePatchJournal(root, journal, (authority) => applyPatchWithAuthority(input, context, authority), context.signal);
  return applyPatchWithAuthority(input, context);
}

export async function applyPatchWithAuthority(input: CanonicalApplyPatchInput, context: ToolExecutionContext, authority?: TextPatchJournalAuthority): Promise<ToolObservationInput<ApplyPatchOutput>> {
  const root = requireRootedFileAuthority(context);
  const dryRun = input.dryRun;
  await context.emitProgress?.({ type: 'status', stage: 'patch_staging', message: 'Staging patch transaction.', completed: 0, total: input.tree.operations.length });
  const { planned, failures } = await planPatch(root, input);

  if (failures.length > 0) {
    return invalidToolInputObservation('apply_patch', summarizePatchFailures(failures), {
      failures
    });
  }
  await emitCheckpoint(context, { type: 'status', stage: 'patch_planned', message: 'Patch transaction planned.', completed: planned.length, total: input.tree.operations.length });

  const changed = planned.filter((operation) => operation.output.plannedChange);
  let transactionOutcome: ApplyPatchOutput['transactionOutcome'];
  let transaction: TextTransactionResult | undefined;
  if (!dryRun && changed.length > 0) {
    if (!authority) throw new Error('Patch journal authority is unavailable for a write transaction.');
    throwIfAborted(context.signal);
    await context.emitProgress?.({ type: 'status', stage: 'patch_committing', message: 'Committing patch transaction.', completed: 0, total: changed.length });
    const transactionId = patchTransactionId(context);
    transaction = await authority.commit({
      writes: changed.flatMap((operation) => operation.write ? [operation.write] : []),
      removes: changed.flatMap((operation) => operation.remove ? [operation.remove] : []),
      parentDirsToCreate: changed.flatMap((operation) => operation.parentDirsToCreate)
    }, {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(transactionId ? { transactionId } : {})
    });
    transactionOutcome = transaction.outcome;
    if (transaction.outcome === 'rolled_back' || transaction.outcome === 'rollback_failed') {
      await emitCheckpoint(context, { type: 'status', stage: 'rollback_completed', message: `Patch rollback ${transactionRecovery(transaction)}.` });
    } else {
      await emitCheckpoint(context, {
        type: 'status', stage: 'patch_committed', completed: changed.length, total: changed.length,
        message: transaction.outcome === 'committed' ? 'Patch transaction committed.' : transactionFailureMessage(transaction)
      });
    }
  }

  const wouldChangePaths = uniquePaths(changed.flatMap((operation) => operation.changedPaths));
  const applicationStatus: ApplyPatchOutput['applicationStatus'] = dryRun
    ? 'dry_run'
    : changed.length === 0
      ? 'no_change'
      : transactionOutcome === 'committed' || transactionOutcome === 'committed_with_residue'
        ? 'applied'
        : transactionOutcome === 'rolled_back'
          ? 'not_applied'
          : 'uncertain';
  const contentsCommitted = applicationStatus === 'applied';
  const changedPaths = dryRun || !contentsCommitted ? [] : [...wouldChangePaths];
  const wouldCreatePaths = changed.flatMap((operation) => operation.createdPath ? [operation.createdPath] : []);
  const wouldDeletePaths = changed.flatMap((operation) => operation.deletedPath ? [operation.deletedPath] : []);
  const wouldMovePaths = changed.flatMap((operation) => operation.move ? [operation.move] : []);
  const output: ApplyPatchOutput = {
    applicationStatus,
    ...(transactionOutcome ? { transactionOutcome } : {}),
    rootState: applicationStatus === 'uncertain' ? 'uncertain' : 'known',
    dryRun,
    files: planned.map((operation) => ({
      ...operation.output,
      finalState: !operation.output.plannedChange || dryRun || applicationStatus === 'no_change' || applicationStatus === 'not_applied'
        ? 'unchanged' as const
        : applicationStatus === 'uncertain'
          ? 'uncertain' as const
          : 'changed' as const
    })),
    changedPaths,
    wouldChangePaths,
    createdPaths: dryRun || !contentsCommitted ? [] : [...wouldCreatePaths],
    wouldCreatePaths,
    deletedPaths: dryRun || !contentsCommitted ? [] : [...wouldDeletePaths],
    wouldDeletePaths,
    movedPaths: dryRun || !contentsCommitted ? [] : wouldMovePaths.map((item) => ({ ...item })),
    wouldMovePaths: wouldMovePaths.map((item) => ({ ...item })),
    potentiallyAffectedPaths: applicationStatus === 'uncertain' ? [...wouldChangePaths] : [],
    ...(transaction ? { transaction } : {}),
    totalOperationCount: planned.length,
    totalHunkCount: planned.reduce((total, operation) => total + operation.output.hunkCount, 0),
    totalAdditions: planned.reduce((total, operation) => total + operation.output.additions, 0),
    totalDeletions: planned.reduce((total, operation) => total + operation.output.deletions, 0)
  };
  return {
    kind: 'result',
    ok: applicationStatus === 'dry_run' || applicationStatus === 'no_change' || applicationStatus === 'applied',
    summary: applicationStatus === 'dry_run' || applicationStatus === 'no_change' || transactionOutcome === 'committed'
      ? summarizePatchOutput(output)
      : transactionOutcome === 'committed_with_residue'
        ? transactionFailureMessage(transaction as Extract<TextTransactionResult, { outcome: 'committed_with_residue' }>)
        : transactionOutcome === 'rolled_back'
          ? 'Patch transaction was rolled back; no requested file changes remain.'
          : 'Patch rollback failed; rooted file state is uncertain for: ' + (wouldChangePaths.join(', ') || 'unknown paths') + '.',
    scope: {
      resources: transactionOutcome === 'committed_with_residue'
        ? [...uniquePaths(planned.flatMap((operation) => operation.changedPaths)).map((item) => fileScope(item)), PATCH_JOURNAL_SCOPE]
        : uniquePaths(planned.flatMap((operation) => operation.changedPaths)).map((item) => fileScope(item)),
      coverage: transactionOutcome === 'committed_with_residue' || applicationStatus === 'uncertain' ? 'partial' : 'complete',
      ...(transactionOutcome === 'committed_with_residue' ? { causes: ['journal_residue'], omitted: { cleanup: transaction?.outcome === 'committed_with_residue' ? transaction.cleanup.strandedPaths.length : 0 } } : {}),
      ...(applicationStatus === 'uncertain' ? { causes: ['rooted_file_state_uncertain'], omitted: { potentiallyAffectedPaths: wouldChangePaths.length } } : {})
    },
    output,
    observedFacts: { items: patchObservedFacts(output) },
    ...(!dryRun ? { metadata: { changedPaths: output.changedPaths } } : {})
  };
}

/** Builds the one transaction plan used by both dry-run and commit execution. */
export async function planPatch(root: RootedFileAuthority, input: CanonicalApplyPatchInput): Promise<{
  readonly planned: PlannedPatchOperation[];
  readonly failures: ApplyPatchFailure[];
}> {
  const planned: PlannedPatchOperation[] = [];
  const failures: ApplyPatchFailure[] = [];
  const reservedPaths = new Set<string>();
  for (const operation of input.tree.operations) {
    const result = await planOperation(root, operation, input, reservedPaths);
    if (result.ok) planned.push(result.operation);
    else failures.push(result.failure);
  }
  return { planned, failures };
}

function patchTransactionId(context: ToolExecutionContext): string | undefined {
  const invocation = context.invocation;
  return invocation
    ? `${invocation.runId}-${invocation.turnId}-${invocation.toolBatchId}-${String(invocation.callIndex)}-${String(invocation.toolAttempt)}`
    : undefined;
}

function emitCheckpoint(context: ToolExecutionContext, progress: import('@agent-core/tools').ToolProgress): Promise<void> {
  return Promise.resolve(context.persistProgressCheckpoint ? context.persistProgressCheckpoint(progress) : context.emitProgress?.(progress));
}

function transactionRecovery(result: Exclude<TextTransactionResult, { outcome: 'committed' }>): 'succeeded' | 'failed' | 'uncertain' {
  return result.outcome === 'committed_with_residue' ? result.cleanup.status : result.rollback.status;
}
function transactionFailureMessage(result: Exclude<TextTransactionResult, { outcome: 'committed' }>): string {
  if (result.outcome === 'committed_with_residue') return `Patch contents were committed, but cleanup ${result.cleanup.status}; residue may remain at: ${result.cleanup.strandedPaths.join(', ') || 'unknown paths'}.`;
  return `Patch commit failed and rollback ${result.rollback.status}: ${result.failure.message}`;
}

function patchObservedFacts(output: ApplyPatchOutput): ToolResultFact[] {
  if (output.applicationStatus === 'not_applied' || output.applicationStatus === 'no_change') return [];
  return output.files
    .filter((file) => file.plannedChange)
    .map((file) => {
      const action = observationActionForPatch(file.operation);
      const resources = [rootedFileResource(file.path, {
        ...(file.newSha256 ? { sha256: file.newSha256 } : {}),
        mediaType: 'text/plain'
      })];
      if (file.destinationPath && file.destinationPath !== file.path) {
        resources.push(rootedFileResource(file.destinationPath, {
          ...(file.newSha256 ? { sha256: file.newSha256 } : {}),
          mediaType: 'text/plain'
        }));
      }
      return {
        action,
        outcome: output.applicationStatus === 'uncertain' ? 'failure' as const : 'success' as const,
        resources,
        scope: {
          limits: {
            dryRun: output.dryRun,
            applicationStatus: output.applicationStatus,
            ...(output.transactionOutcome ? { transactionOutcome: output.transactionOutcome } : {}),
            hunkCount: file.hunkCount,
            additions: file.additions,
            deletions: file.deletions
          },
          truncated: false,
          actuality: output.dryRun || output.applicationStatus === 'uncertain' ? 'predicted' : 'observed'
        },
        summary: `${output.dryRun ? 'Would ' : ''}${action} ${file.destinationPath ?? file.path}.`
      };
    });
}

function observationActionForPatch(operation: ApplyPatchFileOutput['operation']): ObservationAction {
  if (operation === 'add') return 'create';
  if (operation === 'delete') return 'delete';
  if (operation === 'move') return 'move';
  return 'update';
}

async function planOperation(
  root: RootedFileAuthority,
  operation: ParsedPatchOperation,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PlannedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  if (operation.kind === 'add') {
    return planAdd(root, operation.path, operation.content, operation.additions, input, reservedPaths);
  }
  if (operation.kind === 'delete') {
    return planDelete(root, operation.path, input, reservedPaths);
  }
  return planUpdate(root, operation, input, reservedPaths);
}

async function planAdd(
  root: RootedFileAuthority,
  requestedPath: string,
  content: string,
  additions: number,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PlannedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  const target = await inspectNewTarget(root, requestedPath, 'already_exists');
  if (!target.ok) {
    return { ok: false, failure: withFailureContext(target.failure, 'add') };
  }
  const duplicate = reservePath(reservedPaths, target.path);
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
        plannedChange: true,
        finalState: 'unchanged'
      },
      write: {
        path: target.path,
        content,
        overwrite: false,
        expectedAbsent: true
      },
      parentDirsToCreate: target.parentDirsToCreate,
      createdPath: target.path,
      changedPaths: [target.path]
    }
  };
}

async function planDelete(
  root: RootedFileAuthority,
  requestedPath: string,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PlannedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  const inspected = await inspectTextFile(root, requestedPath, input.limits.maxFileBytes);
  if (!inspected.ok) {
    return { ok: false, failure: textFileFailure(inspected.failure.path, inspected.failure.reason, inspected.failure.message, 'delete') };
  }
  const duplicate = reservePath(reservedPaths, inspected.file.path);
  if (duplicate) {
    return { ok: false, failure: withFailureContext(duplicate, 'delete') };
  }
  const oldSha256 = inspected.file.sha256;
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
        plannedChange: true,
        finalState: 'unchanged'
      },
      remove: {
        path: inspected.file.path,
        expectedCurrentSha256: oldSha256,
        expectedCurrentIdentity: inspected.file.identity
      },
      parentDirsToCreate: [],
      deletedPath: inspected.file.path,
      changedPaths: [inspected.file.path]
    }
  };
}

async function planUpdate(
  root: RootedFileAuthority,
  operation: Extract<ParsedPatchOperation, { kind: 'update' }>,
  input: CanonicalApplyPatchInput,
  reservedPaths: Set<string>
): Promise<
  | { ok: true; operation: PlannedPatchOperation }
  | { ok: false; failure: ApplyPatchFailure }
> {
  const inspected = await inspectTextFile(root, operation.path, input.limits.maxFileBytes);
  if (!inspected.ok) {
    return { ok: false, failure: textFileFailure(inspected.failure.path, inspected.failure.reason, inspected.failure.message, 'update') };
  }
  const sourceDuplicate = reservePath(reservedPaths, inspected.file.path);
  if (sourceDuplicate) {
    return { ok: false, failure: withFailureContext(sourceDuplicate, operation.moveTo ? 'move' : 'update') };
  }

  const oldSha256 = inspected.file.sha256;
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
    const target = await inspectNewTarget(root, operation.moveTo, 'destination_exists');
    if (!target.ok) {
      return { ok: false, failure: withFailureContext(target.failure, 'move') };
    }
    const targetDuplicate = reservePath(reservedPaths, target.path);
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
          plannedChange: true,
          finalState: 'unchanged',
          matchModes: patched.matchModes,
          exact: patched.exact
        },
        write: {
          path: target.path,
          content: patched.content,
          mode: inspected.file.mode,
          overwrite: false,
          expectedAbsent: true
        },
        remove: {
          path: inspected.file.path,
          expectedCurrentSha256: oldSha256,
          expectedCurrentIdentity: inspected.file.identity
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
        plannedChange: patched.changed,
        finalState: 'unchanged',
        matchModes: patched.matchModes,
        exact: patched.exact
      },
      ...(patched.changed ? {
        write: {
          path: inspected.file.path,
          content: patched.content,
          mode: inspected.file.mode,
          overwrite: true,
          expectedCurrentSha256: oldSha256,
          expectedCurrentIdentity: inspected.file.identity
        }
      } : {}),
      parentDirsToCreate: [],
      changedPaths: patched.changed ? [inspected.file.path] : []
    }
  };
}

async function inspectNewTarget(
  root: RootedFileAuthority,
  requestedPath: string,
  existsReason: 'already_exists' | 'destination_exists'
): Promise<
  | { ok: true; path: string; parentDirsToCreate: readonly string[] }
  | { ok: false; failure: ApplyPatchFailure }
> {
  let normalizedPath: string;
  try {
    normalizedPath = root.canonicalPath(requestedPath);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { ok: false, failure: { path: requestedPath, reason: 'path_outside_root', message: error.message } };
    }
    throw error;
  }
  try {
    const status = await root.inspectPath(normalizedPath);
    if (status.kind === 'symlink') {
      return { ok: false, failure: { path: normalizedPath, reason: 'symlink', message: `Refusing to write through symlink path: ${requestedPath}` } };
    }
    if (status.kind !== 'absent') return {
      ok: false,
      failure: {
        path: normalizedPath,
        reason: existsReason,
        message: existsReason === 'already_exists' ? `File already exists: ${requestedPath}` : `Destination already exists: ${requestedPath}`
      }
    };
    const parentDirsToCreate = await root.missingParentDirectories(normalizedPath);
    return {
      ok: true,
      path: normalizedPath,
      parentDirsToCreate
    };
  } catch (error) {
    return { ok: false, failure: { path: normalizedPath, reason: 'parent_not_directory', message: error instanceof Error ? error.message : String(error) } };
  }
}

function reservePath(paths: Set<string>, displayPath: string): ApplyPatchFailure | undefined {
  if (paths.has(displayPath)) {
    return {
      path: displayPath,
      reason: 'duplicate_path',
      message: `Duplicate patch target after path normalization: ${displayPath}`
    };
  }
  paths.add(displayPath);
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
    return 'Inspect the matching region lines, then add more surrounding context or a narrower @@ header so this hunk matches exactly one location.';
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
  if (failure.reason === 'path_outside_root') {
    return 'Use a relative path that stays inside the adopted root.';
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
  const verb = output.applicationStatus === 'dry_run' ? 'Validated' : output.applicationStatus === 'no_change' ? 'Completed' : 'Applied';
  const changed = output.applicationStatus === 'dry_run' ? output.wouldChangePaths.length : output.changedPaths.length;
  const outcome = output.applicationStatus === 'dry_run' ? 'would change' : output.applicationStatus === 'no_change' ? 'changed' : 'changed';
  return `${verb} ${String(output.totalOperationCount)} patch operation${output.totalOperationCount === 1 ? '' : 's'}; ${String(changed)} path${changed === 1 ? '' : 's'} ${outcome}.`;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
