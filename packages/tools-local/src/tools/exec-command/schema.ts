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
    ).default('job').describe('Environment lifetime keeps a service across jobs and implies background execution.'),
    background: z.boolean().default(false).describe(
      'Return a process handle only when the task requires interactive input or work while this command remains active. Otherwise wait for exit or timeout.'
    ),
    timeoutMs: z.int().min(1).default(60_000),
    outputTokenBudget: z.int().min(64).default(4_000)
  });
}
export const execCommandOutputSchema = processOutputSchema;
