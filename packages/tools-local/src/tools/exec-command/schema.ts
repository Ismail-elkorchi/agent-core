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
    background: z.boolean().default(false).describe(
      'Return a process handle only when the task requires interactive input or work while this command remains active. Otherwise wait for exit or timeout.'
    ),
    timeoutMs: z.int().min(1).default(60_000).describe(
      'Maximum process lifetime, including background execution. The runtime enforces its limits and returns the effective deadline for an active process.'
    ),
    outputTokenBudget: z.int().min(64).default(4_000).describe('Approximate output bound. Large results may be excerpts or pages; returned coverage and inline gaps identify omissions.')
  });
}
export const execCommandOutputSchema = processOutputSchema;
