import type { InferenceLifecycle } from './lifecycle.js';
import type { ModelStreamEvent } from '@agent-core/model';
import type { NativeSteeringCoordinator } from './native-steering.js';
import { providerWork } from '../run/control/contracts.js';
import { randomUUID } from 'node:crypto';
import {
  createModelRequest,
  parseModelResponse,
  type ModelProvider,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
  type ModelProviderSession,
  type ModelUsage,
  type CompiledModelRequest
} from '@agent-core/model';
import { hashJson, type ArtifactRepository, type EventAppendReceipt } from '@agent-core/persistence';
import {
  UNKNOWN_EFFECT_RECOVERY,
  decodeEffectRecoveryCapability,
  issueEffectStartTicket,
  startExternalEffect,
  settleExternalEffect,
  closeExternalEffect,
  knownEffectExposure,
  unknownEffectExposure,
  type EffectExposureReservation,
  type EffectExposureQuantity
} from '@agent-core/effects';
import type { InferenceService } from './service.js';
import type { AgentAuditEvent, AgentEvent, AgentProgressEvent } from '../events.js';
import type {
  AgentTurnIdentity,
  AgentTurnSnapshotRecord,
  InferenceRequestFingerprintRecord,
  LogicalModelRequestRecord
} from '../run/contracts.js';
import type { AgentRunDriver, AgentRunAdvance } from '../run/control/driver.js';
import type { AgentRunProcedure } from '../run/control/contracts.js';
import { AgentRunController } from '../orchestration/run-controller.js';
import { normalizeModelToolCall } from '../orchestration/model-request.js';
import { storeProviderStateArtifact } from '../orchestration/provider-state-artifacts.js';
import type { RequestCostEstimate } from '../orchestration/budget-accountant.js';
import type { summarizeModelRequest } from '../orchestration/event-summaries.js';

export type RunInferenceResult =
  | {
      readonly kind: 'settled';
      readonly response: ModelResponse;
      readonly identity: AgentTurnIdentity;
    }
  | { readonly kind: 'outcome_unknown'; readonly effectId: string };
export interface RunInferenceInput {
  readonly service: InferenceService;
  readonly steering?: NativeSteeringCoordinator;
  readonly options: {
    readonly provider: ModelProvider;
    readonly repositories: { readonly artifacts?: ArtifactRepository };
    readonly recordLogicalRequest?: (record: LogicalModelRequestRecord) => void | Promise<void>;
  };
  readonly request: ModelRequest;
  readonly compiled: CompiledModelRequest;
  readonly requestEstimate: RequestCostEstimate;
  readonly requestFingerprint: InferenceRequestFingerprintRecord;
  readonly requestSummary: ReturnType<typeof summarizeModelRequest>;
  readonly turnRequest: {
    readonly runId: string;
    readonly turnIndex: number;
    readonly toolBatchId: string;
    readonly modelSession: ModelProviderSession;
    readonly snapshot: {
      readonly record: AgentTurnSnapshotRecord;
      readonly profile: ModelProfile;
    };
    readonly controller: AgentRunController;
    readonly run: AgentRunDriver;
  };
  readonly append: (event: AgentAuditEvent) => Promise<EventAppendReceipt>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
  readonly advanceRun: (
    run: AgentRunDriver,
    procedure: AgentRunProcedure,
    advance: AgentRunAdvance
  ) => Promise<void>;
}
export function createRunInferenceLifecycle(input: RunInferenceInput): {
  readonly lifecycle: InferenceLifecycle<RunInferenceResult>;
  readonly onStreamEvent: (event: Exclude<ModelStreamEvent, { readonly type: 'done' }>) => Promise<void>;
} {
  const { request, requestEstimate, requestFingerprint, requestSummary, turnRequest, append, emit } = input;
  const identity = {
    turnIndex: turnRequest.snapshot.record.turnIndex,
    turnId: turnRequest.snapshot.record.turnId,
    requestAttempt: turnRequest.snapshot.record.requestAttempt
  };
  let effectId = '';
  let responseId = '';
  let streamedToolCallIndex = 0;
  let sawUpdate = false;
  const onStreamEvent = async (
    event: Exclude<ModelStreamEvent, { readonly type: 'done' }>
  ): Promise<void> => {
    await input.steering?.observe(event);
    if (event.type === 'content') {
      sawUpdate = true;
      await emit({
        type: 'assistant.delta',
        ...identity,
        delta: event.content,
        accumulated: event.accumulated
      });
    } else if (event.type === 'reasoning') {
      sawUpdate = true;
      if (turnRequest.snapshot.profile.capabilities.reasoning?.separateOutput)
        await emit({
          type: 'assistant.reasoning',
          ...identity,
          delta: event.reasoning,
          accumulated: event.accumulatedReasoning,
          ...(event.channel ? { channel: event.channel } : {})
        });
    } else if (event.type === 'tool_call') {
      sawUpdate = true;
      const toolCall = normalizeModelToolCall(event.toolCall);
      await emit({
        type: 'tool.call.received',
        ...identity,
        toolBatchId: turnRequest.toolBatchId,
        toolCall,
        callIndex: streamedToolCallIndex++,
        ...(toolCall.id ? { callId: toolCall.id } : {})
      });
    } else if (event.type === 'status')
      await emit({
        type: 'assistant.status',
        ...identity,
        message: event.message
      });
  };
  const lifecycle: InferenceLifecycle<RunInferenceResult> = {
    start: async () => {
      await append({
        type: 'turn.snapshot.created',
        snapshot: {
          ...turnRequest.snapshot.record,
          requestAttempt: identity.requestAttempt
        }
      });
      if (input.options.recordLogicalRequest) {
        const ownedRequest = recordableModelRequest(request);
        await input.options.recordLogicalRequest(
          Object.freeze({
            ...identity,
            requestId: requestFingerprint.requestId,
            request: ownedRequest
          })
        );
      }
      await append({
        type: 'inference.request.fingerprinted',
        fingerprint: {
          ...requestFingerprint,
          requestAttempt: identity.requestAttempt
        }
      });
      const requestReceipt = await append({
        type: 'model.requested',
        ...identity,
        request: requestSummary
      });
      const exactRequest = recordableModelRequest(request);
      const parametersDigest = input.compiled.inputIdentity.replace(/^sha256:/u, '');
      const recovery = input.options.provider.requestRecovery
        ? decodeEffectRecoveryCapability(input.options.provider.requestRecovery(exactRequest))
        : UNKNOWN_EFFECT_RECOVERY;
      const exposure = providerExposureReservation(requestEstimate);
      effectId = `${requestFingerprint.requestId}:${String(identity.requestAttempt)}`;
      responseId = randomUUID();
      const issued = issueEffectStartTicket({
        intent: Object.freeze({
          effectId,
          ownerId: turnRequest.runId,
          implementationId: input.options.provider.implementationId,
          parametersDigest,
          recovery,
          exposure
        }),
        ticketId: randomUUID(),
        settlementPermitId: randomUUID(),
        driverGeneration: turnRequest.run.state().driverGeneration,
        currentDriverGeneration: turnRequest.run.state().driverGeneration
      });
      if (issued.status !== 'issued')
        throw new Error(`Provider effect ${effectId} was rejected before intent commit.`);
      await turnRequest.run.transitionProvider('authorize_provider_request', identity, () => ({
        kind: 'provider',
        stage: 'effect_ready',
        identity,
        toolBatchId: turnRequest.toolBatchId,
        requestEventId: requestReceipt.eventId,
        responseId,
        effect: issued.state
      }));
      const current = providerWork(turnRequest.run.state(), identity);
      if (current.stage !== 'effect_ready')
        throw new Error(`Provider effect ${effectId} lost its issued ticket.`);
      const started = startExternalEffect(
        current.effect,
        current.effect.ticket,
        turnRequest.run.state().driverGeneration
      );
      if (started.status !== 'started')
        throw new Error(
          `Provider effect ${effectId} could not consume its start authority: ${started.reason}.`
        );
      await turnRequest.run.transitionProvider('start_provider_request', identity, () => ({
        ...current,
        stage: 'effect_pending',
        effect: started.state
      }));
    },
    settle: async (responseWithPrivateState) => {
      await input.steering?.finishResponse();
      if (!sawUpdate && responseWithPrivateState.content)
        await emit({
          type: 'assistant.delta',
          ...identity,
          delta: responseWithPrivateState.content,
          accumulated: responseWithPrivateState.content
        });
      const providerState =
        responseWithPrivateState.providerState && input.options.repositories.artifacts
          ? await storeProviderStateArtifact({
              artifacts: input.options.repositories.artifacts,
              turnIndex: turnRequest.turnIndex,
              state: responseWithPrivateState.providerState
            })
          : undefined;
      const response = durableProviderResponse(responseWithPrivateState);
      const settlementEvent: Extract<AgentEvent, { type: 'provider.attempt.settled' }> = {
        type: 'provider.attempt.settled',
        ...identity,
        effectId,
        responseId,
        response,
        ...(providerState ? { providerState } : {})
      };
      const settlementReceipt = await append(settlementEvent);
      const pending = providerWork(turnRequest.run.state(), identity);
      if (pending.stage !== 'effect_pending' || pending.effect.intent.effectId !== effectId)
        throw new Error(`Provider effect ${effectId} completed outside its durable start state.`);
      const effectSettlement = settleExternalEffect(pending.effect, pending.effect.settlementPermit, {
        outcome: 'succeeded',
        resultDigest: hashJson(settlementEvent),
        exposure: response.usage
          ? knownEffectExposure(providerUsageQuantities(response.usage))
          : unknownEffectExposure(pending.effect.intent.exposure)
      });
      if (effectSettlement.status !== 'settled' && effectSettlement.status !== 'already_settled') {
        throw new Error(
          `Provider effect ${effectId} could not settle: ${effectSettlement.status === 'rejected' ? effectSettlement.reason : 'effect was already closed'}.`
        );
      }
      await turnRequest.run.transitionProvider('reconcile_provider_request', identity, () => ({
        ...pending,
        stage: 'settled',
        effect: effectSettlement.state,
        settlementEventId: settlementReceipt.eventId
      }));
      turnRequest.controller.recordProviderSuccess();
      return Object.freeze({
        kind: 'settled',
        response,
        identity: Object.freeze(identity)
      });
    },
    uncertain: async (error) => {
      turnRequest.controller.recordProviderFailure();
      const pending = providerWork(turnRequest.run.state(), identity);
      if (pending.stage !== 'effect_pending' || pending.effect.intent.effectId !== effectId) throw error;
      const closed = closeExternalEffect(pending.effect, 'unknown_outcome');
      await turnRequest.run.transitionProvider('reconcile_provider_request', identity, () => ({
        ...pending,
        stage: 'outcome_unknown',
        effect: closed
      }));
      return Object.freeze({ kind: 'outcome_unknown', effectId });
    }
  };
  return { lifecycle, onStreamEvent };
}
export async function invokeRunInference(input: RunInferenceInput): Promise<RunInferenceResult> {
  const governed = createRunInferenceLifecycle(input);
  return input.service.invokeWithLifecycle(
    {
      request: input.request,
      admitted: input.compiled,
      profile: input.turnRequest.snapshot.profile,
      session: input.turnRequest.modelSession,
      turnIndex: input.turnRequest.turnIndex,
      onStreamEvent: governed.onStreamEvent
    },
    governed.lifecycle,
    {
      invocationId: input.requestFingerprint.requestId,
      ownerId: input.turnRequest.runId,
      purpose: 'agent_step'
    }
  );
}

function recordableModelRequest(request: ModelRequest): Omit<ModelRequest, 'signal'> {
  return createModelRequest({
    model: request.model,
    messages: request.messages,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.keepAlive === undefined ? {} : { keepAlive: request.keepAlive }),
    ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
    ...(request.logprobs === undefined ? {} : { logprobs: request.logprobs }),
    ...(request.topLogprobs === undefined ? {} : { topLogprobs: request.topLogprobs }),
    ...(request.providerOptions === undefined ? {} : { providerOptions: request.providerOptions }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata })
  });
}

function providerExposureReservation(estimate: RequestCostEstimate): EffectExposureReservation {
  return Object.freeze({
    quantities: Object.freeze([
      Object.freeze({
        unit: 'prompt_tokens',
        amount: Math.ceil(estimate.totalPromptTokens)
      }),
      Object.freeze({
        unit: 'completion_tokens',
        amount: Math.ceil(estimate.outputReserveTokens)
      })
    ])
  });
}

export function providerUsageQuantities(usage: ModelUsage): readonly EffectExposureQuantity[] {
  return Object.freeze([
    Object.freeze({
      unit: 'prompt_tokens',
      amount: Math.ceil(usage.promptTokens)
    }),
    Object.freeze({
      unit: 'completion_tokens',
      amount: Math.ceil(usage.completionTokens)
    })
  ]);
}

function durableProviderResponse(response: ModelResponse): ModelResponse {
  return parseModelResponse({
    content: response.content,
    ...(response.output === undefined ? {} : { output: response.output }),
    model: response.model,
    provider: response.provider,
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    ...(response.transport === undefined ? {} : { transport: response.transport }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    ...(response.reasoningSummary === undefined ? {} : { reasoningSummary: response.reasoningSummary }),
    ...(response.toolCalls === undefined ? {} : { toolCalls: response.toolCalls }),
    terminationReason: response.terminationReason,
    ...(response.providerTerminationReason === undefined
      ? {}
      : { providerTerminationReason: response.providerTerminationReason })
  });
}
