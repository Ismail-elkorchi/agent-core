import { createHash } from 'node:crypto';
import {
  defineTool,
  isRiskAllowed,
  requireToolService,
  ToolInputError
} from '@agent-core/tools';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import { FILES_SCOPE, PATCH_JOURNAL_SCOPE, fileScope } from '../../core/resources.js';
import { presentEditTextObservation } from '../../core/presenters.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { isTextPatchJournal, type TextPatchJournal } from '../../core/text-write.js';
import { editText, editTransactionId, recoverEditText, type CanonicalEditTextInput } from './run.js';
import { editTextInputSchema, editTextOutputSchema } from './schema.js';

export const editTextTool = defineTool({
  name: 'edit_text',
  implementationId: 'agent-core.edit-text.v1',
  description: 'Atomically replace exact half-open Unicode-scalar ranges in one or more rooted UTF-8 text files.',
  promptGuide: 'Ranges use one-based lines and one-based Unicode-scalar columns with an excluded end position. Supply the exact complete-file SHA-256 and exact expected text for every replacement.',
  schema: editTextInputSchema,
  outputSchema: editTextOutputSchema,
  presentObservation: presentEditTextObservation,
  requirements: { services: ['rootedFileAuthority', 'localToolConfiguration'] },
  effectEnvelope: {
    accesses: [{ mode: 'read', scope: FILES_SCOPE }, { mode: 'write', scope: FILES_SCOPE }],
    lockScopes: [FILES_SCOPE, PATCH_JOURNAL_SCOPE]
  },
  canonicalizeInput(input, context): CanonicalEditTextInput {
    const root = requireRootedFileAuthority(context);
    const limits = requireLocalToolConfiguration(context).editText;
    if (input.files.length > limits.maxFiles) throw new ToolInputError(`edit_text accepts at most ${String(limits.maxFiles)} files per transaction.`);
    const files = input.files.map((file) => {
      if (file.edits.length > limits.maxEditsPerFile) throw new ToolInputError(`File ${file.path} exceeds the host limit of ${String(limits.maxEditsPerFile)} localized edits.`);
      return Object.freeze({ ...file, path: root.canonicalPath(file.path), edits: Object.freeze(file.edits.map((edit) => Object.freeze({
        ...edit,
        range: Object.freeze({ start: Object.freeze({ ...edit.range.start }), end: Object.freeze({ ...edit.range.end }) })
      }))) });
    });
    const duplicates = duplicatePaths(files.map((file) => file.path));
    if (duplicates.length > 0) throw new ToolInputError(`edit_text file paths must be unique after normalization: ${duplicates.join(', ')}.`, { duplicatePaths: duplicates });
    const replacementBytes = files.reduce((total, file) => total + file.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.replacementText, 'utf8'), 0), 0);
    if (replacementBytes > limits.maxTotalReplacementBytes) throw new ToolInputError(`Replacement text contains ${String(replacementBytes)} bytes; the host maximum is ${String(limits.maxTotalReplacementBytes)}.`);
    const dryRun = input.dryRun || context.policy.dryRunWrites === true;
    const transactionId = dryRun ? dryRunTransactionId(files) : editTransactionId(context);
    return Object.freeze({ files: Object.freeze(files), dryRun, transactionId, limits });
  },
  snapshotInput(input) {
    return Object.freeze({ files: input.files, dryRun: input.dryRun, transactionId: input.transactionId });
  },
  deriveEffects(input, context) {
    const accesses = input.files.flatMap((file) => input.dryRun
      ? [{ mode: 'read' as const, scope: fileScope(file.path) }]
      : [{ mode: 'read' as const, scope: fileScope(file.path) }, { mode: 'write' as const, scope: fileScope(file.path) }]);
    if (input.dryRun) return { accesses, lockScopes: [], recovery: { kind: 'unknown' as const } };
    const journal = requireToolService<TextPatchJournal>(context, 'patchJournal', isTextPatchJournal, 'adopted TextPatchJournal');
    return {
      accesses,
      lockScopes: [...new Set([...input.files.map((file) => fileScope(file.path)), PATCH_JOURNAL_SCOPE])].sort(),
      recovery: {
        kind: 'buffered_mutation' as const,
        authority: journal.recoveryIdentity,
        reconcilerId: 'agent-core.edit-text@1',
        transactionId: input.transactionId
      }
    };
  },
  recover: recoverEditText,
  isAvailable: (policy) => isRiskAllowed(policy, 'read') || isRiskAllowed(policy, 'write'),
  invoke: editText
});

function duplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of paths) { if (seen.has(path)) duplicates.add(path); else seen.add(path); }
  return [...duplicates].sort();
}
function dryRunTransactionId(files: CanonicalEditTextInput['files']): string {
  return `edit-dry-${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
}
