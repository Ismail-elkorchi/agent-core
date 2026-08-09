import * as z from 'zod';
export const searchTextInputSchema = z.strictObject({
  query: z.string().min(1).meta({ description: 'Regular expression, or literal text when fixedStrings is true.' }),
  path: z.string().trim().min(1).default('.'),
  patterns: z.array(z.string().trim().min(1)).min(1).default(['**/*']),
  mode: z.enum(['files', 'matches', 'count']).default('matches'),
  fixedStrings: z.boolean().default(false),
  caseSensitive: z.boolean().default(true),
  respectGitIgnore: z.boolean().default(true),
  includeHidden: z.boolean().default(false),
  exclude: z.array(z.string().trim().min(1)).default([]),
  contextLines: z.int().nonnegative().default(0),
  perFileLimit: z.int().positive().optional(),
  resultLimit: z.int().min(1).optional()
});
const matchSchema = z.strictObject({
  path: z.string(), lineNumber: z.int().positive(), text: z.string(),
  occurrences: z.array(z.strictObject({ startByte: z.int().nonnegative(), endByte: z.int().nonnegative(), text: z.string() })),
  context: z.strictObject({
    before: z.array(z.strictObject({ lineNumber: z.int().positive(), text: z.string() })),
    after: z.array(z.strictObject({ lineNumber: z.int().positive(), text: z.string() }))
  }).optional()
});
const countSchema = z.strictObject({ path: z.string(), matchingLineCount: z.int().nonnegative(), occurrenceCount: z.int().nonnegative() });
const perFileOmissionSchema = z.strictObject({
  path: z.string(), cause: z.literal('per_file_limit'), retainedMatches: z.int().nonnegative(), omittedAtLeast: z.int().positive()
});
const common = {
  query: z.string(),
  status: z.enum(['completed', 'partial', 'invalid_pattern', 'missing_ripgrep', 'io_error', 'aborted', 'output_limit', 'failed']),
  diagnostic: z.string().optional(), resultCoverage: z.enum(['complete', 'partial']), countCoverage: z.enum(['complete', 'partial']),
  examinedFileCount: z.int().nonnegative(), matchingFileCount: z.int().nonnegative(), matchingLineCount: z.int().nonnegative(),
  occurrenceCount: z.int().nonnegative(), omittedResultCount: z.int().nonnegative(),
  countsCapped: z.boolean(), omittedResultCountIsLowerBound: z.boolean(), outputTruncated: z.boolean(), perFileOmissions: z.array(perFileOmissionSchema)
};
export const searchTextOutputSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...common, mode: z.literal('files'), results: z.array(z.string()) }),
  z.strictObject({ ...common, mode: z.literal('matches'), results: z.array(matchSchema) }),
  z.strictObject({ ...common, mode: z.literal('count'), results: z.array(countSchema) })
]);
export type SearchTextInput = z.output<typeof searchTextInputSchema>;
export type SearchTextOutput = z.output<typeof searchTextOutputSchema>;
