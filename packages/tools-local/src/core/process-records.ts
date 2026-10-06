import {
  validateArtifactRef,
  validatePublicArtifactRef,
  type ProtectedArtifactRef,
  type PublicArtifactRef
} from '@agent-core/persistence';
import * as z from 'zod';
import { CommandProcessOperationRejectedError, type CommandExecutionReport } from '@agent-core/tools';

export const commandOwnerSchema = z.strictObject({
  ownerId: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
  toolBatchId: z.string().min(1),
  callIndex: z.int().nonnegative()
});

// Recovery validates supervision identity independently of unrelated output payloads.
const processLedgerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  processId: z.string().regex(/^proc_[a-f0-9-]+$/u),
  mode: z.enum(['foreground', 'background']),
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
const terminalRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  processId: z.string().regex(/^proc_[a-f0-9-]+$/u),
  rootPath: z.string().min(1),
  executionTargetId: z.string().min(1),
  owner: commandOwnerSchema.readonly(),
  status: z.enum(['exited', 'stopped', 'timed_out', 'failed']),
  exitCode: z.int().nullable(),
  signal: z.string().nullable(),
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

export type ProcessTerminalRecord = Omit<z.output<typeof terminalRecordSchema>, 'artifact' | 'protectedArtifact'> &
  Readonly<{ artifact?: PublicArtifactRef; protectedArtifact?: ProtectedArtifactRef }>;

export function parseTerminalRecord(value: unknown): ProcessTerminalRecord {
  const receipt = terminalRecordSchema.parse(value);
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
    processId: receipt.processId,
    rootPath: receipt.rootPath,
    executionTargetId: receipt.executionTargetId,
    owner: receipt.owner,
    status: receipt.status,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    cursorEnd: receipt.cursorEnd,
    stdout: receipt.stdout,
    stderr: receipt.stderr,
    combined: receipt.combined,
    ...(artifact ? { artifact } : {}),
    ...(protectedArtifact ? { protectedArtifact } : {}),
    ...(receipt.diagnostic === undefined ? {} : { diagnostic: receipt.diagnostic })
  });
}

/** Terminal identity survives output-buffer retention; original output lives in artifacts. */
export function terminalRecordReport(
  record: ProcessTerminalRecord,
  afterCursor = 0
): CommandExecutionReport {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > record.cursorEnd)
    throw new CommandProcessOperationRejectedError(record.processId, 'invalid_cursor');
  const stream = (observedBytes: number) => Object.freeze({
    segments: Object.freeze([]),
    observedBytes,
    capturedBytes: 0,
    omittedBytes: observedBytes,
    startsAtOutputStart: observedBytes === 0,
    endsAtOutputEnd: observedBytes === 0
  });
  return Object.freeze({
    result: Object.freeze({
      processId: record.processId,
      owner: record.owner,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      cursorStart: record.cursorEnd,
      cursorEnd: record.cursorEnd,
      ...(afterCursor < record.cursorEnd ? { cursorExpired: true } : {}),
      stdout: stream(record.stdout.observedBytes),
      stderr: stream(record.stderr.observedBytes),
      combined: stream(record.combined.observedBytes),
      originalOutput: record.artifact || record.protectedArtifact
        ? { kind: 'captured' as const, cursorEnd: record.cursorEnd,
            omittedBytes: record.combined.observedBytes - record.combined.capturedBytes }
        : { kind: 'unavailable' as const, cursorEnd: record.cursorEnd,
            diagnostic: record.diagnostic ?? 'Original process output could not be retained.' },
      ...(record.artifact ? { artifact: record.artifact } : {}),
      ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic })
    }),
    ...(record.protectedArtifact ? { protectedArtifact: record.protectedArtifact } : {})
  });
}
