import {
  ownSessionSubmissionInput,
  type AgentSession,
  type AgentSessionSubmissionResult,
  type SessionPendingSubmission,
  type SessionSubmissionInput
} from '@agent-core/runtime';
import * as z from 'zod';
import { rpcMethod } from './index.js';

type SubmissionResult =
  | AgentSessionSubmissionResult
  | { readonly kind: 'rejected'; readonly reason: string };
export interface InputRpcOperations {
  submit(input: SessionSubmissionInput): Promise<SubmissionResult>;
  follow?(input: SessionSubmissionInput): Promise<SubmissionResult>;
  steer?(input: SessionSubmissionInput, expectedRunId: string): Promise<SubmissionResult>;
  readPendingSubmissions?(): Promise<readonly SessionPendingSubmission[]>;
  updateQueuedSubmission?: AgentSession['updateQueuedSubmission'];
}

export function inputRpcMethods(operations: InputRpcOperations) {
  const input = z.unknown().transform(ownSessionSubmissionInput);
  const id = z.string().min(1);
  const follow = operations.follow?.bind(operations);
  const steer = operations.steer?.bind(operations);
  const read = operations.readPendingSubmissions?.bind(operations);
  const update = operations.updateQueuedSubmission?.bind(operations);
  return {
    'input.submit': rpcMethod(input, async (value) => submissionReceipt(await operations.submit(value))),
    ...(follow === undefined
      ? {}
      : { 'input.follow': rpcMethod(input, async (value) => submissionReceipt(await follow(value))) }),
    ...(steer === undefined
      ? {}
      : {
          'input.steer': rpcMethod(z.strictObject({ input, expectedRunId: id }), async (value) =>
            submissionReceipt(await steer(value.input, value.expectedRunId))
          )
        }),
    ...(read === undefined ? {} : { 'queue.read': rpcMethod(z.strictObject({}), () => read()) }),
    ...(update === undefined
      ? {}
      : {
          'queue.replace': rpcMethod(
            z.strictObject({ submissionId: id, expectedInput: input, input }),
            ({ submissionId, ...change }) => update(submissionId, { kind: 'replace', ...change })
          ),
          'queue.cancel': rpcMethod(
            z.strictObject({ submissionId: id, expectedInput: input }),
            ({ submissionId, expectedInput }) => update(submissionId, { kind: 'cancel', expectedInput })
          )
        })
  };
}

function submissionReceipt(result: SubmissionResult) {
  if (result.kind === 'rejected') return result;
  const { completion, ...receipt } = result;
  // Completion is delivered through session events, independently of request transport lifetime.
  void completion.catch(() => undefined);
  return receipt;
}
