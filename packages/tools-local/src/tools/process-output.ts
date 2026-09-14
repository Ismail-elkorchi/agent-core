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

const streamOutputSchema = z.strictObject({
  text: z.string(),
  observedBytes: z.int().nonnegative(),
  capturedBytes: z.int().nonnegative(),
  omittedBytes: z.int().nonnegative(),
  startsAtOutputStart: z.boolean(),
  endsAtOutputEnd: z.boolean()
});

export const processOutputSchema = z.strictObject({
  processId: z.string(),
  owner: z.strictObject({
    ownerId: z.string(),
    runId: z.string(),
    turnId: z.string(),
    toolBatchId: z.string(),
    callIndex: z.int().nonnegative()
  }),
  status: z.enum(['running', 'exited', 'stopped', 'timed_out', 'failed']),
  cursorStart: z.int().nonnegative(),
  cursorEnd: z.int().nonnegative(),
  cursorExpired: z.boolean().optional(),
  stdout: streamOutputSchema,
  stderr: streamOutputSchema,
  combined: streamOutputSchema,
  artifact: artifactRefSchema.optional(),
  originalOutput: z
    .discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('captured'),
        cursorEnd: z.int().nonnegative(),
        omittedBytes: z.int().nonnegative()
      }),
      z.strictObject({
        kind: z.literal('unavailable'),
        cursorEnd: z.int().nonnegative(),
        diagnostic: z.string()
      })
    ])
    .optional(),
  exitCode: z.int().nullable().optional(),
  signal: z.string().nullable().optional(),
  diagnostic: z.string().optional(),
  progressDroppedEvents: z.int().nonnegative().optional(),
  progressDeliveryErrors: z.int().nonnegative().optional()
});

export type ProcessOutput = z.output<typeof processOutputSchema>;
