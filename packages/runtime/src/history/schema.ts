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
export const scopeSchema = z
  .strictObject({ sessionId: z.string().min(1), branchId: z.string().min(1) })
  .readonly();
export const noteRefSchema = z
  .strictObject({ scope: scopeSchema, noteId: z.string().min(1), revisionId: z.string().min(1) })
  .readonly();
