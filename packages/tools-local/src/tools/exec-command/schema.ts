import * as z from 'zod';
import { processOutputSchema } from '../process-output.js';

export function execCommandSchema(ptySupported: boolean) {
  return z.strictObject({
    command: z.string().trim().min(1),
    workdir: z
      .string()
      .trim()
      .min(1)
      .default('.')
      .describe(
        'Directory relative to the workspace root. Use "." for the root; absolute paths are not accepted.'
      ),
    ...(ptySupported ? { pty: z.boolean().default(false) } : {}),
    yieldMs: z.int().min(0).default(30_000).describe(
      'Observation wait limit, defaulting to 30 seconds and clamped to the configured limit; returns on fresh output, termination, steering, or this limit. Use 0 for an immediate snapshot. A running result includes the process handle for later control.'
    ),
    timeoutMs: z.int().min(1).default(60_000).describe(
      'Maximum process lifetime, independent of observation waits. The runtime enforces its limits and returns the effective deadline for an active process.'
    ),
    outputTokenBudget: z.int().min(64).default(4_000).describe('Approximate output bound. Large results may be excerpts or pages; returned coverage and inline gaps identify omissions.')
  });
}
export const execCommandOutputSchema = processOutputSchema;
