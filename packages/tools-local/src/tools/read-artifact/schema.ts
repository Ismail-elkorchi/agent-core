import * as z from 'zod';
import { artifactRefSchema } from '../process-output.js';

export const readArtifactInputSchema = z.strictObject({
  artifactId: z.string().trim().min(1),
  offset: z.int().nonnegative().default(0),
  byteCount: z.int().positive().optional()
});

export const readArtifactOutputSchema = z.strictObject({
  artifact: artifactRefSchema,
  fullSize: z.int().nonnegative(),
  returnedRange: z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() }),
  returnedBytes: z.int().nonnegative(),
  nextOffset: z.int().nonnegative().optional(),
  coverage: z.enum(['complete', 'partial']),
  text: z.string().optional(),
  contentType: z.enum(['text', 'image', 'artifact'])
});
