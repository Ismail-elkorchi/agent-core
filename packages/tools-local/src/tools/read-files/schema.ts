import * as z from 'zod';

export const readFilesInputSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: z.string().trim().min(1),
    startLine: z.int().min(1).default(1),
    lineCount: z.int().min(1).optional()
  })).min(1).meta({ description: 'Files and one-based line ranges to read.' })
});

const readFileResultSchema = z.strictObject({
  path: z.string(),
  startLine: z.int().min(1),
  lineCount: z.int().nonnegative(),
  content: z.string(),
  bytes: z.int().nonnegative(),
  fileBytes: z.int().nonnegative(),
  eof: z.boolean(),
  nextStartLine: z.int().min(1).optional(),
  rangeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  fullFileSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lineEnding: z.enum(['lf', 'crlf', 'mixed', 'none']).optional()
});

const readFileFailureSchema = z.strictObject({
  path: z.string(),
  reason: z.enum(['not_found', 'not_file', 'binary', 'invalid_utf8', 'range_too_large', 'start_after_eof', 'batch_file_limit', 'batch_byte_limit', 'path_outside_workspace', 'unreadable']),
  message: z.string()
});

export const readFilesOutputSchema = z.strictObject({
  files: z.array(readFileResultSchema),
  failures: z.array(readFileFailureSchema),
  coverage: z.enum(['complete', 'partial']),
  requestedFiles: z.int().positive(),
  returnedFiles: z.int().nonnegative(),
  failedFiles: z.int().nonnegative(),
  returnedBytes: z.int().nonnegative()
});

export type ReadFilesInput = z.output<typeof readFilesInputSchema>;
export type ReadFilesOutput = z.output<typeof readFilesOutputSchema>;
export type ReadFileResult = z.output<typeof readFileResultSchema>;
export type ReadFileFailure = z.output<typeof readFileFailureSchema>;
