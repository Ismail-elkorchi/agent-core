import * as z from 'zod';

export const artifactRefSchema = z.strictObject({
  artifactId: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.int().nonnegative(),
  mediaType: z.string(),
  visibility: z.literal('public'),
  label: z.string().optional(),
  description: z.string().optional()
});
