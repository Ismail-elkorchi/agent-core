import { createHash } from 'node:crypto';
import type { ToolEvidenceItem } from '@agent-core/evidence';
import { parseJsonObject } from '@agent-core/json';
import {
  invalidToolInputObservation,
  requireToolService,
  throwIfAborted,
  type ToolExecutionContext,
  type ToolObservationInput
} from '@agent-core/tools';
import { inspectTextFile, sha256Text, type TextFileData } from '../../core/filesystem.js';
import { PATCH_JOURNAL_SCOPE, fileScope, rootedFileResource } from '../../core/resources.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import {
  isTextPatchJournal,
  withTextFilePatchJournal,
  type PreparedTextPatchWrite,
  type TextPatchJournal,
  type TextTransactionResult
} from '../../core/text-write.js';
import {
  editTextRecoveryPayloadSchema,
  type EditTextFileOutput,
  type EditTextOutput,
  type EditTextRange,
  type EditTextRecoveryPayload
} from './schema.js';

export interface CanonicalEditTextInput {
  readonly files: readonly {
    readonly path: string;
    readonly expectedSha256: string;
    readonly edits: readonly {
      readonly range: EditTextRange;
      readonly expectedText: string;
      readonly replacementText: string;
    }[];
  }[];
  readonly dryRun: boolean;
  readonly transactionId: string;
  readonly limits: {
    readonly maxFiles: number;
    readonly maxEditsPerFile: number;
    readonly maxFileBytes: number;
    readonly maxNewBytesPerFile: number;
    readonly maxTotalReplacementBytes: number;
    readonly maxDiffSummaryBytes: number;
  };
}

interface PreparedFileEdit {
  readonly output: EditTextFileOutput;
  readonly write?: PreparedTextPatchWrite;
  readonly diffLines: readonly string[];
}

export async function editText(input: CanonicalEditTextInput, context: ToolExecutionContext): Promise<ToolObservationInput<EditTextOutput>> {
  throwIfAborted(context.signal);
  const root = requireRootedFileAuthority(context);
  const prepared: PreparedFileEdit[] = [];
  const failures: { path: string; reason: string; message: string; editIndex?: number }[] = [];
  for (const file of input.files) {
    const result = await prepareFile(root, file, input.limits);
    if (result.ok) prepared.push(result.prepared);
    else failures.push(...result.failures);
  }
  if (failures.length > 0) {
    return invalidToolInputObservation('edit_text', `Text edit validation failed for ${String(failures.length)} item${failures.length === 1 ? '' : 's'}; no files were written.`, { failures });
  }

  const summary = boundedDiffSummary(prepared.flatMap((file) => file.diffLines), input.limits.maxDiffSummaryBytes);
  const recoveryPayload: EditTextRecoveryPayload = {
    kind: 'agent-core.edit-text-recovery',
    version: 1,
    transactionId: input.transactionId,
    files: prepared.map((file) => file.output),
    wouldChangePaths: prepared.filter((file) => file.output.changed).map((file) => file.output.path),
    diffSummary: summary
  };
  if (input.dryRun) return observationFromPlan(recoveryPayload, true);

  const journal = requireToolService<TextPatchJournal>(context, 'patchJournal', isTextPatchJournal, 'adopted TextPatchJournal');
  await checkpoint(context, { type: 'status', stage: 'text_edit_prepared', message: 'Text edit transaction prepared.', completed: prepared.length, total: prepared.length });
  throwIfAborted(context.signal);
  const transaction = await withTextFilePatchJournal(root, journal, (authority) => authority.commit({
    writes: prepared.flatMap((file) => file.write ? [file.write] : []),
    removes: []
  }, {
    transactionId: input.transactionId,
    recoveryPayload: parseJsonObject(recoveryPayload),
    ...(context.signal ? { signal: context.signal } : {})
  }), context.signal);
  await checkpoint(context, { type: 'status', stage: 'text_edit_transaction_finished', message: `Text edit transaction ${transaction.outcome}.` });
  return observationFromPlan(recoveryPayload, false, transaction);
}

export async function recoverEditText(
  input: CanonicalEditTextInput,
  effect: Extract<import('@agent-core/effects').EffectExecutionState, { readonly phase: 'started' }>,
  context: ToolExecutionContext
): Promise<import('@agent-core/tools').ToolEffectRecoveryResult<EditTextOutput>> {
  if (input.dryRun) return { status: 'unavailable', reason: 'Dry-run text edits have no external mutation to reconcile.' };
  const capability = effect.intent.recovery;
  if (capability.kind !== 'buffered_mutation' || capability.transactionId !== input.transactionId || capability.reconcilerId !== 'agent-core.edit-text@1') {
    return { status: 'parameter_mismatch', reason: 'The text edit recovery capability does not match this transaction.' };
  }
  const root = requireRootedFileAuthority(context);
  const journal = requireToolService<TextPatchJournal>(context, 'patchJournal', isTextPatchJournal, 'adopted TextPatchJournal');
  if (capability.authority !== journal.recoveryIdentity) return { status: 'parameter_mismatch', reason: 'The text edit journal authority changed.' };
  return withTextFilePatchJournal(root, journal, async (authority) => {
    const receipt = await authority.receipt(input.transactionId);
    if (!receipt) return { status: 'not_found' as const, reason: 'No durable text edit transaction receipt exists.' };
    const parsed = editTextRecoveryPayloadSchema.safeParse(receipt.recoveryPayload);
    if (!parsed.success || parsed.data.transactionId !== input.transactionId) {
      return { status: 'parameter_mismatch' as const, reason: 'The durable text edit receipt payload does not match this transaction.' };
    }
    if (receipt.result.outcome === 'rollback_failed') {
      return { status: 'unavailable' as const, reason: 'Text edit rollback is uncertain and requires explicit external reconciliation.' };
    }
    return { status: 'settled' as const, observation: observationFromPlan(parsed.data, false, receipt.result) };
  }, context.signal);
}

async function prepareFile(
  root: import('../../core/rooted-file-authority.js').RootedFileAuthority,
  request: CanonicalEditTextInput['files'][number],
  limits: CanonicalEditTextInput['limits']
): Promise<{ ok: true; prepared: PreparedFileEdit } | { ok: false; failures: { path: string; reason: string; message: string; editIndex?: number }[] }> {
  const inspected = await inspectTextFile(root, request.path, limits.maxFileBytes);
  if (!inspected.ok) return { ok: false, failures: [{ path: inspected.failure.path, reason: inspected.failure.reason, message: inspected.failure.message }] };
  const file = inspected.file;
  if (file.sha256 !== request.expectedSha256) return { ok: false, failures: [{
    path: file.path, reason: 'sha256_mismatch', message: `Expected SHA-256 does not match the current file: ${file.path}`
  }] };
  const lines = indexLines(file.content);
  const replacements: { start: number; end: number; replacement: string }[] = [];
  const changedRanges: EditTextFileOutput['changedRanges'] = [];
  const diffLines: string[] = [];
  const failures: { path: string; reason: string; message: string; editIndex?: number }[] = [];
  let previousStart = -1;
  let previousEnd = -1;
  const convention = newlineConvention(file.content);
  for (const [editIndex, edit] of request.edits.entries()) {
    if (!wellFormedUnicode(edit.expectedText) || !wellFormedUnicode(edit.replacementText)) {
      failures.push({ path: file.path, editIndex, reason: 'invalid_unicode', message: 'Expected and replacement text must contain well-formed Unicode scalar values.' });
      continue;
    }
    let start: number;
    let end: number;
    try {
      start = positionOffset(file.content, lines, edit.range.start.line, edit.range.start.column);
      end = positionOffset(file.content, lines, edit.range.end.line, edit.range.end.column);
    } catch (error) {
      failures.push({ path: file.path, editIndex, reason: 'range_out_of_bounds', message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (end < start) {
      failures.push({ path: file.path, editIndex, reason: 'reversed_range', message: 'The half-open range end precedes its start.' });
      continue;
    }
    if (start < previousStart || start < previousEnd) {
      failures.push({ path: file.path, editIndex, reason: 'overlapping_or_unordered_range', message: 'Edit ranges must be ordered and non-overlapping.' });
      continue;
    }
    const actual = file.content.slice(start, end);
    if (actual !== edit.expectedText) {
      failures.push({ path: file.path, editIndex, reason: 'expected_text_mismatch', message: `Expected text does not match range ${formatRange(edit.range)} in ${file.path}.` });
      continue;
    }
    const newlineFailure = validateReplacementNewlines(convention, edit.expectedText, edit.replacementText);
    if (newlineFailure) {
      failures.push({ path: file.path, editIndex, reason: 'newline_convention_mismatch', message: newlineFailure });
      continue;
    }
    previousStart = start;
    previousEnd = end;
    replacements.push({ start, end, replacement: edit.replacementText });
    if (edit.expectedText !== edit.replacementText) {
      changedRanges.push({
        range: edit.range,
        expectedTextSha256: sha256Text(edit.expectedText),
        replacementTextSha256: sha256Text(edit.replacementText),
        expectedScalars: Array.from(edit.expectedText).length,
        replacementScalars: Array.from(edit.replacementText).length
      });
      diffLines.push(`${file.path} ${formatRange(edit.range)} ${preview(edit.expectedText)} -> ${preview(edit.replacementText)}`);
    }
  }
  if (failures.length > 0) return { ok: false, failures };
  const content = compose(file.content, replacements);
  const newBytes = Buffer.byteLength(content, 'utf8');
  if (newBytes > limits.maxNewBytesPerFile) return { ok: false, failures: [{
    path: file.path, reason: 'result_too_large', message: `Edited file would contain ${String(newBytes)} bytes; the host maximum is ${String(limits.maxNewBytesPerFile)}.`
  }] };
  const changed = content !== file.content;
  const output: EditTextFileOutput = {
    path: file.path,
    oldSha256: file.sha256,
    newSha256: sha256Text(content),
    oldBytes: file.bytes,
    newBytes,
    changed,
    finalState: 'unchanged',
    newlineConvention: convention,
    changedRanges
  };
  return {
    ok: true,
    prepared: {
      output,
      ...(changed ? { write: preparedWrite(file, content) } : {}),
      diffLines
    }
  };
}

function preparedWrite(file: TextFileData, content: string): PreparedTextPatchWrite {
  return {
    path: file.path,
    content,
    mode: file.mode,
    overwrite: true,
    expectedCurrentSha256: file.sha256,
    expectedCurrentIdentity: file.identity
  };
}

function observationFromPlan(payload: EditTextRecoveryPayload, dryRun: boolean, transaction?: TextTransactionResult): ToolObservationInput<EditTextOutput> {
  const wouldChangePaths = [...payload.wouldChangePaths];
  const transactionOutcome = transaction?.outcome;
  const operationStatus: EditTextOutput['operationStatus'] = dryRun
    ? 'dry_run'
    : !transaction
      ? 'no_change'
      : transaction.outcome === 'committed' || transaction.outcome === 'committed_with_residue'
        ? wouldChangePaths.length === 0 ? 'no_change' : 'applied'
        : transaction.outcome === 'rolled_back'
          ? 'not_applied'
          : 'uncertain';
  const changedPaths = operationStatus === 'applied' ? wouldChangePaths : [];
  const potentiallyAffectedPaths = operationStatus === 'uncertain' ? wouldChangePaths : [];
  const output: EditTextOutput = {
    operationStatus,
    ...(transactionOutcome ? { transactionOutcome } : {}),
    rootState: operationStatus === 'uncertain' ? 'uncertain' : 'known',
    dryRun,
    files: payload.files.map((file) => ({
      ...file,
      finalState: !file.changed || dryRun || operationStatus === 'no_change' || operationStatus === 'not_applied'
        ? 'unchanged' as const
        : operationStatus === 'uncertain' ? 'uncertain' as const : 'changed' as const
    })),
    changedPaths,
    wouldChangePaths,
    potentiallyAffectedPaths,
    diffSummary: payload.diffSummary,
    ...(transaction ? { transaction: mutableTransaction(transaction) } : {})
  };
  const residue = transaction?.outcome === 'committed_with_residue';
  const ok = operationStatus === 'dry_run' || operationStatus === 'no_change' || operationStatus === 'applied';
  return {
    kind: 'result',
    ok,
    summary: summarize(output),
    scope: {
      resources: [...wouldChangePaths.map(fileScope), ...(residue ? [PATCH_JOURNAL_SCOPE] : [])],
      coverage: residue || operationStatus === 'uncertain' ? 'partial' : 'complete',
      ...(residue ? { causes: ['journal_residue'], omitted: { cleanup: transaction.cleanup.strandedPaths.length } } : {}),
      ...(operationStatus === 'uncertain' ? { causes: ['rooted_file_state_uncertain'], omitted: { potentiallyAffectedPaths: potentiallyAffectedPaths.length } } : {}),
      truncated: payload.diffSummary.truncated
    },
    output,
    evidence: { items: editEvidence(output) },
    ...(!dryRun ? { metadata: { changedPaths } } : {})
  };
}

function mutableTransaction(transaction: TextTransactionResult): NonNullable<EditTextOutput['transaction']> {
  if (transaction.outcome === 'committed' || transaction.outcome === 'committed_with_residue') {
    return {
      outcome: transaction.outcome,
      cleanup: {
        status: transaction.cleanup.status,
        diagnostics: transaction.cleanup.diagnostics.map((item) => ({ ...item })),
        strandedPaths: [...transaction.cleanup.strandedPaths]
      }
    };
  }
  return {
    outcome: transaction.outcome,
    failure: { ...transaction.failure },
    rollback: {
      status: transaction.rollback.status,
      diagnostics: transaction.rollback.diagnostics.map((item) => ({ ...item })),
      strandedPaths: [...transaction.rollback.strandedPaths]
    }
  };
}

function editEvidence(output: EditTextOutput): ToolEvidenceItem[] {
  if (output.operationStatus === 'not_applied' || output.operationStatus === 'no_change') return [];
  return output.files.filter((file) => file.changed).map((file) => ({
    action: 'update',
    outcome: output.operationStatus === 'uncertain' ? 'failure' : 'success',
    resources: [rootedFileResource(file.path, { sha256: file.newSha256, fullSha256: file.newSha256, mediaType: 'text/plain' })],
    scope: {
      limits: { dryRun: output.dryRun, changedRanges: file.changedRanges.length, oldSha256: file.oldSha256 },
      truncated: output.diffSummary.truncated,
      confidence: output.dryRun || output.operationStatus === 'uncertain' ? 'unverified' : 'verified'
    },
    summary: `${output.dryRun ? 'Would update' : 'Updated'} ${file.path} with ${String(file.changedRanges.length)} localized replacement${file.changedRanges.length === 1 ? '' : 's'}.`
  }));
}

interface IndexedLine { readonly start: number; readonly contentEnd: number }
function indexLines(content: string): IndexedLine[] {
  const lines: IndexedLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 0x0a) continue;
    const contentEnd = index > start && content.charCodeAt(index - 1) === 0x0d ? index - 1 : index;
    lines.push({ start, contentEnd });
    start = index + 1;
  }
  lines.push({ start, contentEnd: content.length });
  return lines;
}

function positionOffset(content: string, lines: readonly IndexedLine[], lineNumber: number, column: number): number {
  const line = lines[lineNumber - 1];
  if (!line) throw new Error(`Line ${String(lineNumber)} is outside the file.`);
  const text = content.slice(line.start, line.contentEnd);
  const scalars = Array.from(text);
  if (column > scalars.length + 1) throw new Error(`Column ${String(column)} is outside line ${String(lineNumber)}; maximum is ${String(scalars.length + 1)}.`);
  let width = 0;
  for (let index = 0; index < column - 1; index += 1) width += scalars[index]?.length ?? 0;
  return line.start + width;
}

function compose(source: string, replacements: readonly { start: number; end: number; replacement: string }[]): string {
  let output = '';
  let cursor = 0;
  for (const replacement of replacements) {
    output += source.slice(cursor, replacement.start) + replacement.replacement;
    cursor = replacement.end;
  }
  return output + source.slice(cursor);
}

function newlineConvention(content: string): EditTextFileOutput['newlineConvention'] {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 0x0a) continue;
    if (index > 0 && content.charCodeAt(index - 1) === 0x0d) crlf += 1;
    else lf += 1;
  }
  return lf > 0 && crlf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'none';
}

function validateReplacementNewlines(convention: EditTextFileOutput['newlineConvention'], expected: string, replacement: string): string | undefined {
  const replacementTokens = newlineTokens(replacement);
  if (replacementTokens.includes('cr')) return 'Replacement text contains an unsupported lone carriage return.';
  if (convention === 'none' && replacementTokens.length > 0) return 'A file without a newline convention cannot receive new line breaks implicitly.';
  if (convention === 'lf' && replacementTokens.includes('crlf')) return 'Replacement text must preserve the file LF newline convention.';
  if (convention === 'crlf' && replacementTokens.includes('lf')) return 'Replacement text must preserve the file CRLF newline convention.';
  if (convention === 'mixed' && JSON.stringify(replacementTokens) !== JSON.stringify(newlineTokens(expected))) {
    return 'Replacement text in a mixed-newline file must preserve the exact newline sequence of the replaced text.';
  }
  return undefined;
}
function newlineTokens(value: string): ('lf' | 'crlf' | 'cr')[] {
  const tokens: ('lf' | 'crlf' | 'cr')[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) { tokens.push('crlf'); index += 1; }
      else tokens.push('cr');
    } else if (code === 0x0a) tokens.push('lf');
  }
  return tokens;
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function boundedDiffSummary(lines: readonly string[], maxBytes: number): EditTextOutput['diffSummary'] {
  const source = lines.join('\n');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return { text: source, bytes: Buffer.byteLength(source, 'utf8'), truncated: false, totalChangedRanges: lines.length };
  let text = '';
  for (const scalar of source) {
    if (Buffer.byteLength(text + scalar, 'utf8') > maxBytes) break;
    text += scalar;
  }
  return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: true, totalChangedRanges: lines.length };
}
function preview(value: string): string {
  const scalars = Array.from(value);
  return JSON.stringify(scalars.length <= 80 ? value : scalars.slice(0, 80).join('') + '…');
}
function formatRange(range: EditTextRange): string {
  return `L${String(range.start.line)}:C${String(range.start.column)}-L${String(range.end.line)}:C${String(range.end.column)}`;
}
function summarize(output: EditTextOutput): string {
  if (output.operationStatus === 'dry_run') return `Validated ${String(output.diffSummary.totalChangedRanges)} localized text replacement${output.diffSummary.totalChangedRanges === 1 ? '' : 's'}; ${String(output.wouldChangePaths.length)} file${output.wouldChangePaths.length === 1 ? '' : 's'} would change.`;
  if (output.operationStatus === 'no_change') return 'Text edit transaction completed with no content changes.';
  if (output.operationStatus === 'applied') return `Applied ${String(output.diffSummary.totalChangedRanges)} localized text replacement${output.diffSummary.totalChangedRanges === 1 ? '' : 's'} across ${String(output.changedPaths.length)} file${output.changedPaths.length === 1 ? '' : 's'}.`;
  if (output.operationStatus === 'not_applied') return 'Text edit transaction was rolled back; no requested content changes remain.';
  return `Text edit rollback is uncertain for: ${output.potentiallyAffectedPaths.join(', ') || 'unknown paths'}.`;
}
function checkpoint(context: ToolExecutionContext, progress: import('@agent-core/tools').ToolProgress): Promise<void> {
  return Promise.resolve(context.persistProgressCheckpoint ? context.persistProgressCheckpoint(progress) : context.emitProgress?.(progress));
}

export function editTransactionId(context: Pick<ToolExecutionContext, 'invocation'>): string {
  const invocation = context.invocation;
  if (!invocation) throw new Error('Durable text edits require a runtime invocation identity.');
  return `edit-${createHash('sha256').update([
    invocation.runId, invocation.turnId, invocation.toolBatchId, String(invocation.callIndex), String(invocation.toolAttempt)
  ].join('\0')).digest('hex')}`;
}
