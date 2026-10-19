import * as z from 'zod';
import type { SessionSubmissionOrigin } from './contracts.js';

const originSchema = z.strictObject({
  kind: z.literal('delegated_assignment'),
  groupId: z.string().min(1), participantId: z.string().min(1), assignmentId: z.string().min(1),
  assignmentRevision: z.number().int().positive(),
  sender: z.strictObject({ sessionId: z.string().min(1), participantId: z.string().min(1).optional(), runId: z.string().min(1).optional() })
});

export function parseSessionSubmissionOrigin(value: unknown): SessionSubmissionOrigin {
  const origin = originSchema.parse(value);
  return Object.freeze({ ...origin, sender: Object.freeze({ sessionId: origin.sender.sessionId,
    ...(origin.sender.participantId === undefined ? {} : { participantId: origin.sender.participantId }),
    ...(origin.sender.runId === undefined ? {} : { runId: origin.sender.runId })
  }) });
}

/** Framing is presentation only; the original task and causal identities remain intact. */
export function presentSubmittedTask(task: string, origin?: SessionSubmissionOrigin): string {
  return origin === undefined ? task :
    `Delegated model-authored assignment. The runtime routes this bounded task from another agent; it is not a direct user message or a grant of additional authority.\nAssignment provenance: ${JSON.stringify(origin)}\n\n${task}`;
}
