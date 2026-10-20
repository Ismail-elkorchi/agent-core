import { hashJson } from '@agent-core/persistence';
import * as z from 'zod';
import type { SessionAdmittedSubmission, SessionDescriptor, SessionSubmissionInput, SessionSubmissionRecord, SessionSubmissionTrigger, SessionTriggeredSubmissionAdmission, SessionTriggeredSubmissionReceipt } from './contracts.js';
import { ownSessionSubmissionInput, ownSessionSubmissionConfiguration } from './submission-lifecycle.js';

const triggerSchema = z.strictObject({ key: z.string().min(1).max(4096), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly();
export function ownSubmissionTrigger(value: unknown): SessionSubmissionTrigger { return triggerSchema.parse(value); }
export function triggeredSubmissionId(key: string): string {
  z.string().min(1).max(4096).parse(key);
  return `host-wake-${hashJson(key)}`;
}
/** Stable across pre-admission preparation retries; never a second accepted run identity. */
export function triggeredRunId(sessionId: string, key: string): string {
  z.string().min(1).parse(sessionId); triggeredSubmissionId(key);
  return `host-wake-run-${hashJson({ sessionId, key })}`;
}
/** Hash the captured payload, including its exact typed causal origin. */
export function triggeredSubmissionDigest(input: SessionSubmissionInput): string { return hashJson(ownSessionSubmissionInput(input)); }
export function captureTriggeredSubmission(input: SessionTriggeredSubmissionAdmission) {
  const captured = ownSessionSubmissionInput(input.input);
  if (captured.origin?.kind !== 'host_wake') throw new Error('Triggered submission requires a host-wake origin.');
  if (captured.relationship !== undefined) throw new Error('Host wakes cannot claim a direct-user correction relationship.');
  return Object.freeze({ configuration: ownSessionSubmissionConfiguration(input.configuration),
    ...(input.maximumQueuedInputs === undefined ? {} : { maximumQueuedInputs: input.maximumQueuedInputs }),
    input: Object.freeze({ ...captured, origin: captured.origin }), submissionId: triggeredSubmissionId(input.key), trigger: ownSubmissionTrigger({ key: input.key, payloadDigest: hashJson(captured) }) });
}
export function triggeredSubmissionReceipt(session: SessionDescriptor, record: SessionAdmittedSubmission): SessionTriggeredSubmissionReceipt {
  if (!record.trigger) throw new Error('Submission has no host-trigger receipt.');
  return Object.freeze({ ...record.trigger, sessionId: session.id, submissionId: record.submissionId, runId: record.runId, admittedAt: record.timestamp });
}
export function findTriggeredSubmissionReceipt(session: SessionDescriptor, records: readonly SessionSubmissionRecord[], key: string): SessionTriggeredSubmissionReceipt | undefined {
  const id = triggeredSubmissionId(key);
  const record = records.find(record => record.type === 'submission.admitted' && record.submissionId === id);
  if (!record) return undefined;
  if (record.type !== 'submission.admitted' || record.trigger?.key !== key) throw new Error('Host-trigger identity conflicts with an existing submission.');
  return triggeredSubmissionReceipt(session, record);
}
export function assertTriggeredSubmissionRetry(receipt: SessionTriggeredSubmissionReceipt, input: SessionTriggeredSubmissionAdmission): void {
  const captured = captureTriggeredSubmission(input);
  if (receipt.key !== input.key || receipt.payloadDigest !== captured.trigger.payloadDigest)
    throw new Error('Host-trigger key was already admitted with a different payload.');
}
