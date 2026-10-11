import type { AgentSession } from '@agent-core/runtime';
import * as z from 'zod';
import { rpcMethod } from './index.js';

export interface RecoveryRpcOperations {
  abort(runId: string, reason?: string): Promise<unknown>;
  resume(runId: string): Promise<unknown>;
  resolveApproval: AgentSession['resolveApproval'];
}

export function recoveryRpcMethods(operations: RecoveryRpcOperations) {
  const id = z.string().min(1);
  return {
    'run.abort': rpcMethod(
      z.strictObject({ runId: id, reason: z.string().optional() }),
      ({ runId, reason }) => operations.abort(runId, reason)
    ),
    'run.resume': rpcMethod(z.strictObject({ runId: id }), ({ runId }) => operations.resume(runId)),
    'approval.resolve': rpcMethod(
      z.strictObject({ runId: id, approvalId: id, fingerprint: id, decision: z.enum(['allow', 'deny']) }),
      (request) => operations.resolveApproval(request)
    )
  };
}
