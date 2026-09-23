import * as z from 'zod';
import { processOutputSchema } from '../process-output.js';

export function execCommandSchema(ptySupported: boolean, environmentLifetimeSupported = false) {
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
    lifetime: (environmentLifetimeSupported
      ? z.enum(['job', 'environment'])
      : z.literal('job')
    ).default('job'),
    yieldMs: z.int().min(0).default(10_000),
    timeoutMs: z.int().min(1).default(60_000),
    outputTokenBudget: z.int().min(64).default(4_000)
  });
}
export const execCommandOutputSchema = processOutputSchema;
