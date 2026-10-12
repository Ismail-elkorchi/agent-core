import { randomUUID } from 'node:crypto';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import * as z from 'zod';
import { historyEventSourceSchema } from '../history/schema.js';
import type {
  SessionRunFinalization,
  SessionRunFinalizationConfirmation,
  SessionRunFinalizationConfirmationInput
} from './contracts.js';

const confirmationInputSchema = z.strictObject({
  runId: z.string().min(1),
  finalizationId: z.string().min(1),
  terminalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: historyEventSourceSchema
});
const confirmationSchema = confirmationInputSchema.extend({
  type: z.literal('run_finalization_confirmed'),
  id: z.string().min(1),
  timestamp: z.string().min(1)
}).readonly();

export function decodeSessionRunFinalizationConfirmation(value: unknown): SessionRunFinalizationConfirmation {
  return confirmationSchema.parse(value);
}

/** The caller verifies the event envelope; the session checks its recorded terminal binding. */
export function createSessionRunFinalizationConfirmation(
  finalization: SessionRunFinalization | undefined,
  existing: SessionRunFinalizationConfirmation | undefined,
  input: SessionRunFinalizationConfirmationInput
): SessionRunFinalizationConfirmation {
  const owned = confirmationInputSchema.parse(input);
  if (finalization?.runId !== owned.runId || finalization.finalizationId !== owned.finalizationId ||
      owned.source.runId !== owned.runId || hashJson(finalization.terminal) !== owned.terminalSha256)
    throw new PersistenceConflictError('Terminal confirmation does not match its recorded session finalization.');
  if (existing) {
    if (existing.runId !== owned.runId || existing.finalizationId !== owned.finalizationId ||
        existing.terminalSha256 !== owned.terminalSha256 || hashJson(existing.source) !== hashJson(owned.source))
      throw new PersistenceConflictError('Conflicting terminal confirmation for a recorded run.');
    return existing;
  }
  return confirmationSchema.parse({ ...owned, type: 'run_finalization_confirmed', id: randomUUID(), timestamp: new Date().toISOString() });
}
