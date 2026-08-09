import * as z from 'zod';
import { processOutputSchema } from '../process-output.js';

export const stopProcessInputSchema = z.strictObject({
  processId: z.string().trim().min(1),
  afterCursor: z.int().nonnegative().default(0),
  outputTokenBudget: z.int().min(64).default(2_000)
});
export const stopProcessOutputSchema = processOutputSchema;
