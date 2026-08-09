import * as z from 'zod';
import { processOutputSchema } from '../process-output.js';

export function execCommandSchema(ptySupported: boolean) {
  return z.strictObject({
    command: z.string().trim().min(1),
    workdir: z.string().trim().min(1).default('.'),
    ...(ptySupported ? { pty: z.boolean().default(false) } : {}),
    yieldMs: z.int().min(0).default(10_000),
    timeoutMs: z.int().min(1).default(60_000),
    outputTokenBudget: z.int().min(64).default(4_000)
  });
}
export const execCommandInputSchema = execCommandSchema(false);
export const execCommandOutputSchema = processOutputSchema;
export type ExecCommandInput = z.output<ReturnType<typeof execCommandSchema>>;
