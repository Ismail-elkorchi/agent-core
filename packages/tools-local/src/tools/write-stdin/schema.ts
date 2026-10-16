import * as z from 'zod';
import { processOutputSchema } from '../process-output.js';

export const writeStdinInputSchema = z.strictObject({
  processId: z.string().trim().min(1),
  text: z.string().optional(),
  closeStdin: z.boolean().default(false),
  afterCursor: z.int().nonnegative().default(0).describe(
    'Use the prior result cursorEnd to receive only fresh output and wait when none is available. Zero replays retained output from the beginning.'
  ),
  yieldMs: z.int().min(0).default(1_000).describe(
    'Maximum wait for fresh output or process termination, clamped to the configured limit (30 seconds by default). Returns immediately when output after afterCursor is already available. Prefer 30000 for a quiet running process instead of repeated short polls; use 0 for an immediate snapshot. This does not extend the process deadline.'
  ),
  outputTokenBudget: z.int().min(64).default(4_000)
});
export const writeStdinOutputSchema = processOutputSchema;
