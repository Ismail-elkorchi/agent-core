import {
  validateArtifactRef,
  validatePublicArtifactRef,
  type ProtectedArtifactRef,
  type PublicArtifactRef
} from '@agent-core/persistence';
import * as z from 'zod';

export const commandOwnerSchema = z.strictObject({
  ownerId: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
  toolBatchId: z.string().min(1),
  callIndex: z.int().nonnegative()
});

// Recovery validates supervision identity independently of unrelated output payloads.
const processLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  processId: z.string().regex(/^proc_[a-f0-9-]+$/u),
  supervisorPid: z.int().positive(),
  supervisorIdentity: z.string().regex(/^supervisor_[a-f0-9-]+$/u),
  supervisorEndpoint: z.string().min(1),
  owner: commandOwnerSchema.readonly(),
  startedAt: z.iso.datetime(),
  rootPath: z.string().min(1),
  command: z.string().optional(),
  terminationReason: z.enum(['stopped', 'timed_out']).optional(),
  terminalReported: z.boolean()
}).readonly();

export type ProcessLedgerEntry = z.output<typeof processLedgerSchema>;
export const parseLedgerEntry = (value: unknown): ProcessLedgerEntry => processLedgerSchema.parse(value);

const countsSchema = z.strictObject({
  observedBytes: z.int().nonnegative(),
  capturedBytes: z.int().nonnegative()
}).refine((value) => value.capturedBytes <= value.observedBytes, 'Capture exceeds observed output.').readonly();
const outputReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cursorEnd: z.int().nonnegative(),
  stdout: countsSchema,
  stderr: countsSchema,
  combined: countsSchema,
  artifact: z.unknown().optional(),
  protectedArtifact: z.unknown().optional(),
  diagnostic: z.string().optional()
}).refine((receipt) =>
  receipt.cursorEnd === receipt.combined.observedBytes &&
  receipt.stdout.observedBytes + receipt.stderr.observedBytes === receipt.combined.observedBytes &&
  receipt.stdout.capturedBytes + receipt.stderr.capturedBytes === receipt.combined.capturedBytes,
  'Process output counts do not cover the same source.'
).readonly();

export type ProcessOutputReceipt = Omit<z.output<typeof outputReceiptSchema>, 'artifact' | 'protectedArtifact'> &
  Readonly<{ artifact?: PublicArtifactRef; protectedArtifact?: ProtectedArtifactRef }>;

export function parseOutputReceipt(value: unknown): ProcessOutputReceipt {
  const receipt = outputReceiptSchema.parse(value);
  let artifact: PublicArtifactRef | undefined;
  let protectedArtifact: ProtectedArtifactRef | undefined;
  if (receipt.artifact !== undefined) {
    validatePublicArtifactRef(receipt.artifact);
    artifact = receipt.artifact;
  }
  if (receipt.protectedArtifact !== undefined) {
    validateArtifactRef(receipt.protectedArtifact);
    if (receipt.protectedArtifact.visibility !== 'protected')
      throw new Error('Process output requires a protected artifact.');
    protectedArtifact = receipt.protectedArtifact;
  }
  return Object.freeze({
    schemaVersion: 1,
    cursorEnd: receipt.cursorEnd,
    stdout: receipt.stdout,
    stderr: receipt.stderr,
    combined: receipt.combined,
    ...(artifact ? { artifact } : {}),
    ...(protectedArtifact ? { protectedArtifact } : {}),
    ...(receipt.diagnostic === undefined ? {} : { diagnostic: receipt.diagnostic })
  });
}
