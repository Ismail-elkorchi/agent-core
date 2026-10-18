import * as z from 'zod';
import { commandOwnerSchema } from '../core/process-records.js';

import { artifactRefSchema } from '@agent-core/tools';

const streamOutputSchema = z.strictObject({
  segments: z.array(z.string()).readonly(),
  observedBytes: z.int().nonnegative(),
  capturedBytes: z.int().nonnegative(),
  omittedBytes: z.int().nonnegative(),
  startsAtOutputStart: z.boolean(),
  endsAtOutputEnd: z.boolean()
});

export const processOutputSchema = z.strictObject({
  processId: z.string().min(1),
  owner: commandOwnerSchema,
  status: z.enum(['running', 'exited', 'stopped', 'timed_out', 'failed']),
  finalizationPending: z.literal(true).optional(),
  cursorStart: z.int().nonnegative(),
  cursorEnd: z.int().nonnegative(),
  cursorExpired: z.boolean().optional(),
  deadline: z.iso.datetime().optional(),
  stdout: streamOutputSchema,
  stderr: streamOutputSchema,
  terminal: streamOutputSchema.optional(),
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
