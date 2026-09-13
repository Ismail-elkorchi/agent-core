import type { AgentSession } from '@agent-core/runtime';
import * as z from 'zod';
import { rpcMethod } from './index.js';

export interface RecoveryRpcOperations {
  abort(runId: string, reason?: string): Promise<unknown>;
  resume(runId: string): Promise<unknown>;
  resolveApproval: AgentSession['resolveApproval'];
  resolveDecision?: AgentSession['resolveDecision'];
}

export function recoveryRpcMethods(operations: RecoveryRpcOperations) {
  const id = z.string().min(1);
  const decide = operations.resolveDecision?.bind(operations);
  return {
    'run.abort': rpcMethod(
      z.strictObject({ runId: id, reason: z.string().optional() }),
      ({ runId, reason }) => operations.abort(runId, reason)
    ),
    'run.resume': rpcMethod(z.strictObject({ runId: id }), ({ runId }) => operations.resume(runId)),
    'approval.resolve': rpcMethod(
      z.strictObject({ runId: id, approvalId: id, fingerprint: id, decision: z.enum(['allow', 'deny']) }),
      (request) => operations.resolveApproval(request)
    ),
    ...(decide === undefined
      ? {}
      : {
          'decision.resolve': rpcMethod(
            z.strictObject({
              runId: id,
              decisionRequestId: id,
              choice: id,
              fingerprint: id,
              expectedRunRevision: z.number().int().min(0)
            }),
            (request) => decide(request)
          )
        })
  };
}
