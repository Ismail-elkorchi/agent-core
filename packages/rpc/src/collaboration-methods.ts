import type { CollaborationCoordinator } from '@agent-core/runtime';
import * as z from 'zod';
import { rpcMethod } from './index.js';

/** Application adapters select the current session's canonical coordinator. */
export interface CollaborationRpcOperations {
  readCollaboration(input?: Parameters<CollaborationCoordinator['inspectParticipants']>[0]): ReturnType<CollaborationCoordinator['inspectParticipants']>;
  readParticipant(participantId: string): ReturnType<CollaborationCoordinator['inspectParticipantSummary']>;
  sendParticipantInput(input: Parameters<CollaborationCoordinator['sendUserInput']>[0]): ReturnType<CollaborationCoordinator['sendUserInput']>;
  continueParticipant(input: Parameters<CollaborationCoordinator['continueUserInput']>[0]): ReturnType<CollaborationCoordinator['continueUserInput']>;
  interruptParticipant(input: Parameters<CollaborationCoordinator['interrupt']>[0]): ReturnType<CollaborationCoordinator['interrupt']>;
  cancelParticipant(input: Parameters<CollaborationCoordinator['cancel']>[0]): ReturnType<CollaborationCoordinator['cancel']>;
  waitForParticipants(input: Parameters<CollaborationCoordinator['wait']>[0]): ReturnType<CollaborationCoordinator['wait']>;
}

export function collaborationRpcMethods(operations: CollaborationRpcOperations) {
  const id = z.string().min(1).max(512);
  const epoch = z.int().nonnegative();
  const target = {
    participantId: id,
    sessionId: id,
    expectedRunId: id,
    expectedEpoch: epoch
  };
  const userInput = z.strictObject({ ...target, task: z.string().min(1).max(1_000_000).refine(value => value.trim().length > 0, 'An instruction is required.') });
  const control = {
    operationId: id,
    participantId: id,
    expectedSessionId: id,
    expectedRunId: id,
    expectedEpoch: epoch,
    reason: z.string().min(1).max(16_384)
  };
  return {
    'collaboration.read': rpcMethod(z.strictObject({ offset: z.int().nonnegative().optional(), limit: z.int().positive().max(64).optional() }), ({ offset, limit }) => operations.readCollaboration({ ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) })),
    'collaboration.participant': rpcMethod(z.strictObject({ participantId: id }), ({ participantId }) =>
      operations.readParticipant(participantId)),
    'collaboration.send': rpcMethod(userInput, async (input) => {
      const result = await operations.sendParticipantInput(input);
      if (result.kind === 'rejected') return result;
      const { completion, ...receipt } = result;
      void completion.catch(() => undefined);
      return receipt;
    }),
    'collaboration.continue': rpcMethod(userInput.extend({ operationId: id }), input =>
      operations.continueParticipant(input)),
    'collaboration.interrupt': rpcMethod(z.strictObject(control), input =>
      operations.interruptParticipant(input)),
    'collaboration.cancel': rpcMethod(z.strictObject({ ...control, cascade: z.boolean() }), input =>
      operations.cancelParticipant(input)),
    'collaboration.wait': rpcMethod(z.strictObject({
      participantIds: z.array(id).min(1).max(256),
      timeoutMs: z.int().nonnegative().max(300_000)
    }), input => operations.waitForParticipants(input))
  };
}
