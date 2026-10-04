import * as z from 'zod';
export const historyEventSourceSchema = z
  .strictObject({
    runId: z.string().min(1),
    eventId: z.string().min(1),
    sequence: z.number().int().min(0),
    hash: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .readonly();
export const sourceSchema = z
  .strictObject({
    sessionId: z.string().min(1),
    entryId: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    event: historyEventSourceSchema.optional()
  })
  .readonly();
export const historyCutSchema = z
  .strictObject({
    format: z.literal('agent-core.history/1'),
    sessionId: z.string().min(1),
    branchId: z.string().min(1),
    throughEntryId: z.string().min(1).nullable(),
    sourceRevision: z.number().int().min(0),
    ledgerCoverage: z.enum(['authoritative', 'session']),
    ledgerHeads: z
      .array(
        z
          .strictObject({
            runId: z.string().min(1),
            sequence: z.number().int().min(-1),
            hash: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .optional()
          })
          .readonly()
      )
      .readonly()
      .optional()
  })
  .readonly();
export const historyReadRequestSchema = z.strictObject({
  source: sourceSchema,
  cut: historyCutSchema.optional(),
  offset: z.number().int().min(0).optional(),
  maxSourceBytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024)
    .optional(),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .optional(),
  neighbors: z.number().int().min(0).max(32).optional()
});
