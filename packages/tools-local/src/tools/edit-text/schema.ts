import * as z from 'zod';
import { fileTransactionResultSchema } from '../../core/file-transaction.js';

import { textEditSchema, textRangeSchema } from '@agent-core/tools';
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const editTextInputSchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: z.string().trim().min(1),
        expectedSha256: sha256Schema,
        edits: z.array(textEditSchema).min(1)
      })
    )
    .min(1),
  dryRun: z.boolean().default(false)
});

const changedRangeSchema = z.strictObject({
  range: textRangeSchema,
  expectedTextSha256: sha256Schema,
  replacementTextSha256: sha256Schema,
  expectedScalars: z.int().nonnegative(),
  replacementScalars: z.int().nonnegative()
});
export const editTextFileOutputSchema = z.strictObject({
  path: z.string(),
  oldSha256: sha256Schema,
  newSha256: sha256Schema,
  oldBytes: z.int().nonnegative(),
  newBytes: z.int().nonnegative(),
  changed: z.boolean(),
  finalState: z.enum(['unchanged', 'changed', 'uncertain']),
  newlineConvention: z.enum(['lf', 'crlf', 'mixed', 'none']),
  changedRanges: z.array(changedRangeSchema)
});
export const editTextOutputSchema = z.strictObject({
  applicationStatus: z.enum(['dry_run', 'no_change', 'applied', 'not_applied', 'uncertain']),
  transactionOutcome: z
    .enum(['committed', 'committed_with_residue', 'rolled_back', 'rollback_failed'])
    .optional(),
  rootState: z.enum(['known', 'uncertain']),
  dryRun: z.boolean(),
  files: z.array(editTextFileOutputSchema),
  changedPaths: z.array(z.string()),
  wouldChangePaths: z.array(z.string()),
  potentiallyAffectedPaths: z.array(z.string()),
  diffSummary: z.strictObject({
    text: z.string(),
    bytes: z.int().nonnegative(),
    truncated: z.boolean(),
    totalChangedRanges: z.int().nonnegative()
  }),
  transaction: fileTransactionResultSchema.optional()
});

export const editTextRecoveryPayloadSchema = z.strictObject({
  kind: z.literal('agent-core.edit-text-recovery'),
  version: z.literal(1),
  transactionId: z.string().min(1),
  files: z.array(editTextFileOutputSchema),
  wouldChangePaths: z.array(z.string()),
  diffSummary: z.strictObject({
    text: z.string(),
    bytes: z.int().nonnegative(),
    truncated: z.boolean(),
    totalChangedRanges: z.int().nonnegative()
  })
});

export type EditTextInput = z.output<typeof editTextInputSchema>;
export type EditTextOutput = z.output<typeof editTextOutputSchema>;
export type EditTextFileOutput = EditTextOutput['files'][number];
export type EditTextRange = EditTextInput['files'][number]['edits'][number]['range'];
export type EditTextRecoveryPayload = z.output<typeof editTextRecoveryPayloadSchema>;
