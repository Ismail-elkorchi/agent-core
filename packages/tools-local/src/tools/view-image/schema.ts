import * as z from 'zod';
import { artifactRefSchema } from '../process-output.js';

export const viewImageInputSchema = z.strictObject({
  path: z.string().trim().min(1),
  detail: z.enum(['high', 'original']).default('high')
});

export const viewImageOutputSchema = z.strictObject({
  path: z.string(),
  detail: z.enum(['high', 'original']),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  encodedBytes: z.int().nonnegative(),
  artifact: artifactRefSchema
});
