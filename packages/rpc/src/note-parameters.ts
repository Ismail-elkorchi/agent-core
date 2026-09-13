import * as z from 'zod';
export const noteListParameters = z.strictObject({ cursor: z.string().min(1).optional() });
export const noteReadParameters = z.strictObject({
  noteId: z.string().min(1),
  revisionId: z.string().min(1),
  offset: z.number().int().nonnegative().optional()
});
