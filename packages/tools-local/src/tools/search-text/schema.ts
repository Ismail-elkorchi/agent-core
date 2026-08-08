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
  resultLimit: z.int().min(1).optional()
});

const matchSchema = z.strictObject({
  path: z.string(),
  lineNumber: z.int().positive(),
  text: z.string(),
  occurrences: z.array(z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative(), text: z.string() }))
});

const countSchema = z.strictObject({
  path: z.string(),
  matchingLineCount: z.int().nonnegative(),
  occurrenceCount: z.int().nonnegative()
});

const common = {
  query: z.string(),
  status: z.enum(['completed', 'invalid_pattern', 'partial']),
  diagnostic: z.string().optional(),
  coverage: z.enum(['complete', 'partial']),
  examinedFileCount: z.int().nonnegative(),
  matchingFileCount: z.int().nonnegative(),
  matchingLineCount: z.int().nonnegative(),
  occurrenceCount: z.int().nonnegative(),
  omittedResultCount: z.int().nonnegative()
};

export const searchTextOutputSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...common, mode: z.literal('files'), results: z.array(z.string()) }),
  z.strictObject({ ...common, mode: z.literal('matches'), results: z.array(matchSchema) }),
  z.strictObject({ ...common, mode: z.literal('count'), results: z.array(countSchema) })
]);

export type SearchTextInput = z.output<typeof searchTextInputSchema>;
export type SearchTextOutput = z.output<typeof searchTextOutputSchema>;
