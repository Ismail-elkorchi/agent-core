import { hashJson } from '@agent-core/persistence';
import {
  parseModelResponse,
  type ModelNativeDispatch,
  type ModelNativeResponseBoundary,
  type ModelProviderSession,
  type CompiledModelRequest,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent
} from '@agent-core/model';
import type { InferenceIdentity } from './repository.js';
import type { InferenceResult } from './service.js';
import type { InferenceGateway } from './gateway.js';

export interface NativeGenerationContext extends InferenceIdentity {
  readonly generationDeliveryId: string;
  readonly compiled: CompiledModelRequest;
  readonly profile: ModelProfile;
  readonly dispatch?: ModelNativeDispatch;
}
export interface NativeGenerationSettlement {
  readonly context: NativeGenerationContext;
  readonly boundary: ModelNativeResponseBoundary;
  readonly result: InferenceResult;
}
export interface NativeInferenceInput extends InferenceIdentity {
  readonly request: ModelRequest;
  readonly compiled: CompiledModelRequest;
  readonly profile: ModelProfile;
  readonly session: ModelProviderSession;
  readonly signal?: AbortSignal;
  /** Fenced run authority is committed after the shared reservation and before transport submission. */
  readonly start: (context: NativeGenerationContext) => Promise<void>;
  readonly settled: (settlement: NativeGenerationSettlement) => Promise<void>;
  readonly uncertain: (context: NativeGenerationContext, cause: unknown) => Promise<void>;
  readonly extended?: (context: NativeGenerationContext, dispatch: ModelNativeDispatch) => Promise<void>;
  readonly onStreamEvent?: (event: Exclude<ModelStreamEvent, { type: 'done' }>) => void | Promise<void>;
}
export interface NativeInferenceAuthority {
  readonly gateway: InferenceGateway;
  readonly start: (input: {
    readonly context: NativeGenerationContext;
    readonly signal?: AbortSignal;
    readonly authorize: () => Promise<void>;
    readonly dispatch: () => Promise<ModelResponse>;
  }) => Promise<InferenceResult>;
  readonly extend: (context: NativeGenerationContext, compiled: CompiledModelRequest) => Promise<void>;
}
interface Generation {
  context: NativeGenerationContext;
  readonly result: Promise<InferenceResult>;
  readonly complete: (response: ModelResponse) => void;
  readonly fail: (cause: unknown) => void;
  responseId?: string;
  settlement?: NativeGenerationSettlement;
}
/** A connection is transport lifetime; each causal response keeps its own admitted inference identity. */
export async function invokeNativeInference(
  authority: NativeInferenceAuthority,
  input: NativeInferenceInput
): Promise<readonly NativeGenerationSettlement[]> {
  const generations = new Map<string, Generation>();
  const deliveries = new Map<string, string>();
  const responses = new Map<string, Generation>();
  const signal = input.signal ?? input.request.signal;
  signal?.throwIfAborted();
  const begin = async (context: NativeGenerationContext): Promise<Generation> => {
    let resolveResponse: (response: ModelResponse) => void = () => undefined;
    let rejectResponse: (cause: unknown) => void = () => undefined;
    const response = new Promise<ModelResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    let started: () => void = () => undefined;
    let rejected: (cause: unknown) => void = () => undefined;
    const admitted = new Promise<void>((resolve, reject) => {
      started = resolve;
      rejected = reject;
    });
    const result = authority.start({
      context,
      ...(signal ? { signal } : {}),
      authorize: () => input.start(context),
      dispatch: () => {
        started();
        return response;
      }
    });
    void result.catch(rejected);
    const generation: Generation = { context, result, complete: resolveResponse, fail: rejectResponse };
    generations.set(context.generationDeliveryId, generation);
    try {
      await admitted;
    } catch (cause) {
      generations.delete(context.generationDeliveryId);
      throw cause;
    }
    return generation;
  };
  const initialContext: NativeGenerationContext = {
    invocationId: input.invocationId,
    ownerId: input.ownerId,
    purpose: input.purpose,
    ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
    generationDeliveryId: 'initial',
    compiled: input.compiled,
    profile: input.profile
  };
  const initial = await begin(initialContext);
  let latest: Generation = initial;
  const admit = async (dispatch: ModelNativeDispatch): Promise<void> => {
    signal?.throwIfAborted();
    const generationId = dispatch.generationDeliveryId;
    if (!generationId || generationId === 'initial')
      throw new Error('Native successor requires a distinct generation identity.');
    const prior = generations.get(generationId);
    if (prior) {
      if (prior.responseId || prior.settlement)
        throw new Error('An executing native generation cannot change its admitted input.');
      await authority.extend(prior.context, dispatch.compiled);
      await input.extended?.(prior.context, dispatch);
      prior.context = { ...prior.context, compiled: dispatch.compiled, dispatch };
    } else {
      const context: NativeGenerationContext = {
        invocationId: `native-${hashJson({ parentInvocationId: input.invocationId, generationId })}`,
        ownerId: input.ownerId,
        parentInvocationId: input.invocationId,
        purpose: 'native_continuation',
        generationDeliveryId: generationId,
        compiled: dispatch.compiled,
        profile: input.profile,
        dispatch
      };
      await begin(context);
    }
    const previous = deliveries.get(dispatch.deliveryId);
    if (previous && previous !== generationId)
      throw new Error('Native delivery changed its admitted generation.');
    deliveries.set(dispatch.deliveryId, generationId);
  };
  const match = (boundary: ModelNativeResponseBoundary): Generation => {
    const known = responses.get(boundary.responseId);
    const ids = new Set(boundary.deliveryIds.map((id) => deliveries.get(id)));
    const generation =
      ids.size === 0 && !boundary.previousResponseId
        ? initial
        : ids.size === 1
          ? generations.get([...ids][0] ?? '')
          : undefined;
    if (!generation) throw new Error('Native response has no unique pre-admitted generation.');
    if (known && known !== generation) throw new Error('Native response changed its admitted generation.');
    if (boundary.inputIdentity !== generation.context.compiled.inputIdentity)
      throw new Error('Native response input differs from its exact admitted dispatch.');
    if (
      generation !== initial &&
      (!boundary.previousResponseId || !responses.has(boundary.previousResponseId))
    )
      throw new Error('Native response has no admitted causal parent.');
    if (generation.responseId && generation.responseId !== boundary.responseId)
      throw new Error('One admitted generation produced multiple native responses.');
    generation.responseId = boundary.responseId;
    responses.set(boundary.responseId, generation);
    return generation;
  };
  try {
    await authority.gateway.invoke({
      request: input.request,
      compiled: input.compiled,
      profile: input.profile,
      session: input.session,
      turnIndex: 0,
      transport: { ...(signal ? { signal } : {}), native: { admit } },
      onStreamEvent: async (event) => {
        if (event.type === 'response_started') {
          if (!event.native) throw new Error('Native response started without its causal input manifest.');
          latest = match(event.native);
        }
        if (event.type === 'response_boundary') {
          if (!event.native) throw new Error('Native response boundary has no causal input manifest.');
          const generation = match(event.native);
          const response = parseModelResponse(event.response);
          if (generation.settlement) {
            if (JSON.stringify(generation.settlement.result.response) !== JSON.stringify(response))
              throw new Error('Contradictory native response evidence.');
            return;
          }
          generation.complete(response);
          const result = await generation.result;
          const settlement: NativeGenerationSettlement = Object.freeze({
            context: generation.context,
            boundary: event.native,
            result
          });
          generation.settlement = settlement;
          await input.settled(settlement);
        }
        await input.onStreamEvent?.(event);
      }
    });
    if (!latest.settlement || [...generations.values()].some((generation) => !generation.settlement))
      throw new Error('Native transport closed with an unsettled admitted generation.');
    return Object.freeze(
      [...generations.values()].flatMap((generation) =>
        generation.settlement ? [generation.settlement] : []
      )
    );
  } catch (cause) {
    const pending = [...generations.values()].filter((generation) => !generation.settlement);
    for (const generation of pending) generation.fail(cause);
    await Promise.allSettled(
      pending.map(async (generation) => {
        await generation.result.catch(() => undefined);
        await input.uncertain(generation.context, cause);
      })
    );
    throw cause;
  }
}
