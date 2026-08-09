import * as z from 'zod';
import { processOutputSchema } from '../process-output.js';

export const writeStdinInputSchema = z.strictObject({
  processId: z.string().trim().min(1),
  text: z.string().optional(),
  closeStdin: z.boolean().default(false),
  afterCursor: z.int().nonnegative().default(0),
  yieldMs: z.int().min(0).default(1_000),
  outputTokenBudget: z.int().min(64).default(4_000)
});
export const writeStdinOutputSchema = processOutputSchema;
