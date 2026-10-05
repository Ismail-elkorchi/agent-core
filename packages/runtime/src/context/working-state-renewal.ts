import { unicodeTextSchema } from '@agent-core/tools';
import type { CompiledModelRequest, ModelProfile, ModelRequest } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import * as z from 'zod';
import type { HistorySourceCut } from '../history/contracts.js';
import { InferenceContextRejectedError, type InferenceService } from '../inference/service.js';
import { ContextAdmissionError } from '../inference/request-admission.js';
import type { ContextService } from './service.js';
import { WORKING_STATE_GUIDANCE } from '../session/working-state.js';

const proposalSchema = z.strictObject({ text: unicodeTextSchema });

export function workingStateRenewalRequest(request: ModelRequest): ModelRequest {
  const renewal = {
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'user' as const,
        content: `Runtime context-maintenance task. ${WORKING_STATE_GUIDANCE} Return only a JSON object {"text":"..."} containing the complete current working state. Consolidate current understanding and remove superseded claims; original history already preserves earlier interpretations. Schema: ${JSON.stringify(z.toJSONSchema(proposalSchema))}. Return the current text unchanged when no revision is useful. Preserve understanding useful for the next inference; do not execute the original task or answer the user. This auxiliary request is not a new user contribution.`
      }
    ]
  };
  delete renewal.tools;
  delete renewal.responseFormat;
  return renewal;
}

/** Renewal proposes current understanding; admitted publication activates state and window together. */
export async function stageWorkingStateRenewal(input: {
  readonly inference: InferenceService;
  readonly context: ContextService;
  readonly request: ModelRequest;
  readonly compiled: CompiledModelRequest;
  readonly profile: ModelProfile;
  readonly cut: HistorySourceCut;
  readonly revisionId: string | null;
  readonly ownerId: string;
  readonly runId: string;
  readonly outputReservation: number;
}) {
  const { request, compiled } = input;
  await input.inference.admit(compiled, input.profile);
  const invocationId = `working-state-renewal-${hashJson({ cut: input.cut, inputIdentity: compiled.inputIdentity })}`;
  const result = await input.inference
    .invoke({
      invocationId,
      ownerId: input.ownerId,
      runId: input.runId,
      purpose: 'working_state_renewal',
      workingStateRevisionId: input.revisionId,
      request,
      compiled,
      profile: input.profile,
      outputReservation: input.outputReservation
    })
    .catch((cause: unknown) => {
      if (cause instanceof InferenceContextRejectedError)
        throw new ContextAdmissionError(compiled, cause);
      throw cause;
    });
  if (result.response.terminationReason !== 'stop' || result.response.toolCalls?.length)
    throw new ContextAdmissionError(
      compiled,
      new Error('Working-state renewal was incomplete; no state or window was published.')
    );
  let text: string;
  try {
    text = proposalSchema.parse(
      JSON.parse(unicodeTextSchema.parse(result.response.content)) as unknown
    ).text;
  } catch (cause) {
    throw new ContextAdmissionError(compiled, cause);
  }
  const origin = await input.inference.workingStateOrigin(input.ownerId, invocationId);
  const change = await input.context.stageWorkingState({
    id: invocationId,
    revisionId: origin.revisionId,
    inference: origin.inference,
    text
  });
  if ('status' in change && change.status !== 'unchanged')
    throw new ContextAdmissionError(
      compiled,
      new Error(`Working-state renewal ${change.status}; no state or window was published.`)
    );
  return { invocationId, ...('status' in change ? {} : { change }) };
}
