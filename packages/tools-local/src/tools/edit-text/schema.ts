import * as z from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const positionSchema = z.strictObject({
  line: z.int().min(1).meta({ description: 'One-based line number.' }),
  column: z.int().min(1).meta({ description: 'One-based Unicode-scalar column.' })
});
const rangeSchema = z.strictObject({
  start: positionSchema,
  end: positionSchema
}).meta({ description: 'Half-open range [start, end).' });

export const editTextInputSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: z.string().trim().min(1),
    expectedSha256: sha256Schema,
    edits: z.array(z.strictObject({
      range: rangeSchema,
      expectedText: z.string(),
      replacementText: z.string()
    })).min(1)
  })).min(1),
  dryRun: z.boolean().default(false)
});

const changedRangeSchema = z.strictObject({
  range: rangeSchema,
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
const transactionDiagnosticSchema = z.strictObject({
  operation: z.string(), path: z.string(), message: z.string(), code: z.string().optional()
});
const recoverySchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'uncertain']),
  diagnostics: z.array(transactionDiagnosticSchema),
  strandedPaths: z.array(z.string())
});
const transactionSchema = z.union([
  z.strictObject({ outcome: z.literal('committed'), cleanup: recoverySchema }),
  z.strictObject({ outcome: z.literal('committed_with_residue'), cleanup: recoverySchema }),
  z.strictObject({ outcome: z.literal('rolled_back'), failure: transactionDiagnosticSchema, rollback: recoverySchema }),
  z.strictObject({ outcome: z.literal('rollback_failed'), failure: transactionDiagnosticSchema, rollback: recoverySchema })
]);

export const editTextOutputSchema = z.strictObject({
  operationStatus: z.enum(['dry_run', 'no_change', 'applied', 'not_applied', 'uncertain']),
  transactionOutcome: z.enum(['committed', 'committed_with_residue', 'rolled_back', 'rollback_failed']).optional(),
  rootState: z.enum(['known', 'uncertain']),
  dryRun: z.boolean(),
  files: z.array(editTextFileOutputSchema),
  changedPaths: z.array(z.string()),
  wouldChangePaths: z.array(z.string()),
  potentiallyAffectedPaths: z.array(z.string()),
  diffSummary: z.strictObject({ text: z.string(), bytes: z.int().nonnegative(), truncated: z.boolean(), totalChangedRanges: z.int().nonnegative() }),
  transaction: transactionSchema.optional()
});

export const editTextRecoveryPayloadSchema = z.strictObject({
  kind: z.literal('agent-core.edit-text-recovery'),
  version: z.literal(1),
  transactionId: z.string().min(1),
  files: z.array(editTextFileOutputSchema),
  wouldChangePaths: z.array(z.string()),
  diffSummary: z.strictObject({ text: z.string(), bytes: z.int().nonnegative(), truncated: z.boolean(), totalChangedRanges: z.int().nonnegative() })
});

export type EditTextInput = z.output<typeof editTextInputSchema>;
export type EditTextOutput = z.output<typeof editTextOutputSchema>;
export type EditTextFileOutput = EditTextOutput['files'][number];
export type EditTextRange = EditTextInput['files'][number]['edits'][number]['range'];
export type EditTextRecoveryPayload = z.output<typeof editTextRecoveryPayloadSchema>;
