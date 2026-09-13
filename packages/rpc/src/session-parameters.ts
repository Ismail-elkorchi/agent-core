import type { SessionBranchPageRequest, SessionBranchSearchRequest } from '@agent-core/runtime';
import * as z from 'zod';

export const sessionBranchBoundary = z.strictObject({
  sessionId: z.string(),
  leafId: z.string().nullable(),
  leafHash: z.string().nullable()
});
const cursor = z.strictObject({ boundary: sessionBranchBoundary, entryId: z.string() });
const limits = {
  limit: z.number().int().min(1).max(256).optional(),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024)
    .optional()
};
const pageSchema = z.union([
  z.strictObject({
    ...limits,
    direction: z.enum(['older', 'newer']).optional(),
    leafId: z.string().nullable().optional()
  }),
  z.strictObject({ ...limits, direction: z.enum(['older', 'newer']).optional(), cursor })
]);
export const sessionBranchPageParameters: z.ZodType<
  SessionBranchPageRequest,
  z.input<typeof pageSchema>
> = pageSchema.transform(
  (value): SessionBranchPageRequest => ({
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.maxBytes === undefined ? {} : { maxBytes: value.maxBytes }),
    ...(value.direction === undefined ? {} : { direction: value.direction }),
    ...('cursor' in value
      ? { cursor: value.cursor }
      : value.leafId === undefined
        ? {}
        : { leafId: value.leafId })
  })
);
const searchSchema = z.union([
  z.strictObject({ ...limits, query: z.string().min(1), leafId: z.string().nullable().optional() }),
  z.strictObject({ ...limits, query: z.string().min(1), cursor: cursor.extend({ query: z.string() }) })
]);
export const sessionBranchSearchParameters: z.ZodType<
  SessionBranchSearchRequest,
  z.input<typeof searchSchema>
> = searchSchema.transform(
  (value): SessionBranchSearchRequest => ({
    query: value.query,
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.maxBytes === undefined ? {} : { maxBytes: value.maxBytes }),
    ...('cursor' in value
      ? { cursor: value.cursor }
      : value.leafId === undefined
        ? {}
        : { leafId: value.leafId })
  })
);
