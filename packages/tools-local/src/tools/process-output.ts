import * as z from 'zod';
import type { ProcessPollResult } from '../core/process-manager.js';

export const artifactRefSchema = z.strictObject({
  artifactId: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.int().nonnegative(),
  mediaType: z.string(),
  label: z.string().optional(),
  description: z.string().optional()
});

const streamOutputSchema = z.strictObject({
  text: z.string(),
  observedBytes: z.int().nonnegative(),
  capturedBytes: z.int().nonnegative(),
  omittedBytes: z.int().nonnegative(),
  startsAtOutputStart: z.boolean(),
  endsAtOutputEnd: z.boolean()
});

export const processOutputSchema = z.strictObject({
  processId: z.string(),
  status: z.enum(['running', 'exited', 'stopped', 'timed_out', 'failed']),
  cursorStart: z.int().nonnegative(),
  cursorEnd: z.int().nonnegative(),
  stdout: streamOutputSchema,
  stderr: streamOutputSchema,
  combined: streamOutputSchema,
  artifact: artifactRefSchema,
  exitCode: z.int().nullable().optional(),
  signal: z.string().nullable().optional(),
  diagnostic: z.string().optional()
});

export function isSuccessfulProcessResult(result: ProcessPollResult): boolean {
  return result.status === 'running' || result.status === 'exited' && result.exitCode === 0;
}
