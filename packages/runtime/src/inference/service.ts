import { ModelStreamInterruptedError } from '../orchestration/model-stream.js';
import { executeEffectLifecycle, type EffectLifecycle } from '@agent-core/effects';
import { parseJsonObject } from '@agent-core/json';
import {
  CompleteRequestEstimator,
  ModelProviderError,
  assertRequestAccountingFits,
  createModelRequest,
  modelInputIdentity,
  parseModelContextTransformResult,
  parseModelProfile,
  parseModelResponse,
  requestAccountingInputTokens,
  type CompiledModelRequest,
  type ModelCompilationOptions,
  type ModelContextTransformResult,
  type ModelProfile,
  type ModelProvider,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelUsage
} from '@agent-core/model';
import {
  InMemoryArtifactRepository,
  hashJson,
  type ArtifactRef,
  type ArtifactRepository
} from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';
import { requestWindowForModel } from '../orchestration/model-request.js';
import { InferenceGateway, type InferenceInvocation } from './gateway.js';
import {
  invokeNativeInference,
  type NativeGenerationContext,
  type NativeInferenceInput
} from './native-inference.js';
import type {
  InferenceBudget,
  InferenceEvent,
  InferenceIdentity,
  InferenceOwnerState,
  InferenceRepository,
  InferenceReservation
} from './repository.js';
import { InMemoryInferenceRepository, parseInferenceBudget } from './repository.js';
import { calculateInferenceCost, type InferenceCost } from './usage-cost.js';

export interface InferenceServiceOptions {
  readonly provider: ModelProvider;
  readonly repository: InferenceRepository;
  readonly artifacts: ArtifactRepository;
  readonly budget?: InferenceBudget;
}
export interface GovernedInferenceInput extends InferenceIdentity, ModelCompilationOptions {
  readonly request: ModelRequest;
  readonly profile?: ModelProfile;
  readonly signal?: AbortSignal;
  readonly onStreamEvent?: (
    event: Exclude<ModelStreamEvent, { readonly type: 'done' }>
  ) => void | Promise<void>;
}
export interface GovernedContextTransformInput extends Omit<
  GovernedInferenceInput,
  'onStreamEvent'
> {
  readonly transformId: string;
}
interface DurableInferenceInput extends GovernedInferenceInput {
  readonly session?: ModelProviderSession;
  readonly compiled?: CompiledModelRequest;
}
export interface InferenceCharges {
  readonly usage: ModelUsage;
  readonly usageSource: 'provider' | 'estimate';
  readonly cost: InferenceCost;
}
interface DurableResult<T> extends InferenceIdentity, InferenceCharges {
  readonly status: 'settled';
  readonly value: T;
  readonly artifact: ArtifactRef;
  readonly replayed: boolean;
}
export interface InferenceResult extends InferenceIdentity, InferenceCharges {
  readonly status: 'settled';
  readonly response: ModelResponse;
  readonly replayed: boolean;
}
export interface ContextTransformResult extends InferenceIdentity, InferenceCharges {
  readonly status: 'settled';
  readonly result: ModelContextTransformResult;
  readonly artifact: ArtifactRef;
  readonly replayed: boolean;
}
export class InferenceContextRejectedError extends Error {
  constructor(
    readonly invocationId: string,
    readonly inputIdentity: string,
    message: string
  ) {
    super(message);
    this.name = 'InferenceContextRejectedError';
  }
}

export class InferenceNotSentError extends Error {
  constructor(
    readonly invocationId: string,
    message: string
  ) {
    super(message);
    this.name = 'InferenceNotSentError';
  }
}
export class InferenceOutcomeUnknownError extends Error {
  constructor(
    readonly invocationId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'InferenceOutcomeUnknownError';
  }
}
export class InferenceBudgetExceededError extends Error {
  constructor(
    readonly resource: 'invocations' | 'prompt_tokens' | 'completion_tokens' | 'known_cost'
  ) {
    super(`Inference owner budget exhausted: ${resource}.`);
    this.name = 'InferenceBudgetExceededError';
  }
}
interface DurableOperation<T extends { readonly usage?: ModelUsage }> {
  readonly identity: InferenceIdentity;
  readonly operation: 'generation' | 'context_transform' | 'native_generation';
  readonly profile: ModelProfile;
  readonly compiled: CompiledModelRequest;
  readonly sourceRequest: ModelRequest;
  readonly outputReservation?: number;
  readonly signal?: AbortSignal;
  readonly discriminator?: string;
  readonly dispatch: () => Promise<T>;
  readonly decode: (value: unknown) => T;
  readonly startAuthority?: () => Promise<void>;
  readonly canRejectContext?: () => boolean;
}

/** One admission ledger, reservation policy, cancellation path, and settlement lifecycle for all inference. */
export class InferenceService {
  private readonly gateway: InferenceGateway;
  readonly options: InferenceServiceOptions;
  constructor(options: InferenceServiceOptions);
  constructor(
    options: Omit<InferenceServiceOptions, 'repository' | 'artifacts'> &
      Partial<Pick<InferenceServiceOptions, 'repository' | 'artifacts'>>
  ) {
    if (!options.repository || !options.artifacts)
      throw new TypeError(
        'Inference composition requires explicit invocation and artifact repositories.'
      );
    this.gateway = new InferenceGateway(options.provider);
    this.options = Object.freeze({
      ...options,
      repository: options.repository,
      artifacts: options.artifacts,
      budget: parseInferenceBudget(options.budget ?? {})
    });
  }
  static inMemory(
    options: Omit<InferenceServiceOptions, 'repository' | 'artifacts'>
  ): InferenceService {
    return new InferenceService({
      ...options,
      repository: new InMemoryInferenceRepository(),
      artifacts: new InMemoryArtifactRepository()
    });
  }
  /** Settled invocation identities are counted once, including transforms and native generations. */
  async settledRunUsage(ownerId: string, runId: string) {
    return (await this.options.repository.load(ownerId, { runId })).settledUsage;
  }

  async contextRejection(ownerId: string, invocationId: string) {
    return (await this.options.repository.load(ownerId, { invocationId })).invocation?.rejected;
  }

  createSession(): ModelProviderSession {
    return this.gateway.createSession();
  }
  async compile(request: ModelRequest, profile: ModelProfile, options?: ModelCompilationOptions) {
    return this.gateway.compile(request, profile, options);
  }
  async invokeWithLifecycle<TResult>(
    input: InferenceInvocation,
    lifecycle: EffectLifecycle<TResult, ModelResponse>,
    identity: InferenceIdentity
  ): Promise<TResult> {
    const dispatch = { started: false };
    let result: InferenceResult;
    try {
      result = await this.invokeDurably(
        {
          ...identity,
          request: input.request,
          profile: input.profile,
          session: input.session,
          ...(input.compiled
            ? {
                compiled: input.compiled,
                outputReservation: input.compiled.accounting.outputReservation
              }
            : {}),
          ...(input.onStreamEvent ? { onStreamEvent: input.onStreamEvent } : {})
        },
        async () => {
          await lifecycle.start();
          dispatch.started = true;
        }
      );
    } catch (cause) {
      if (!dispatch.started) throw cause;
      return lifecycle.uncertain(cause);
    }
    if (!dispatch.started) await lifecycle.start();
    return lifecycle.settle(result.response);
  }
  async invoke(input: GovernedInferenceInput): Promise<InferenceResult> {
    return this.invokeDurably(input);
  }

  /** Native transforms are inference operations, with exactly the same owning budget and uncertainty rules. */
  async transformContext(input: GovernedContextTransformInput): Promise<ContextTransformResult> {
    const replayed = await this.replayExisting(
      input,
      'context_transform',
      parseModelContextTransformResult,
      input.transformId
    );
    if (replayed)
      return Object.freeze({
        ...chargesAndIdentity(replayed),
        status: 'settled',
        result: replayed.value,
        artifact: replayed.artifact,
        replayed: true
      });
    const signal = input.signal ?? input.request.signal;
    signal?.throwIfAborted();
    const profile = parseModelProfile(
      input.profile ?? (await this.options.provider.describeModel(input.request.model))
    );
    const provider = this.options.provider;
    if (
      !profile.capabilities.protocol?.contextTransforms.length ||
      !provider.compileContextTransform ||
      !provider.transformContextCompiled
    )
      throw new Error('Provider has no governed compiled context transform capability.');
    const request = createModelRequest({
      ...input.request,
      ...(signal ? { signal } : {})
    });
    const transform = provider.transformContextCompiled.bind(provider);
    const compiled = await provider.compileContextTransform(
      { transformId: input.transformId, request, ...(signal ? { signal } : {}) },
      {
        outputReservation: requestWindowForModel(
          profile,
          request.maxOutputTokens ?? input.outputReservation
        ).maxOutputTokens
      }
    );
    const result = await this.executeDurably({
      identity: ownIdentity(input),
      operation: 'context_transform',
      sourceRequest: request,
      ...(input.outputReservation === undefined
        ? {}
        : { outputReservation: input.outputReservation }),
      profile,
      compiled,
      discriminator: input.transformId,
      ...(signal ? { signal } : {}),
      dispatch: () => transform(input.transformId, compiled),
      decode: (value) => {
        const owned = parseModelContextTransformResult(value);
        if (
          owned.transformId !== input.transformId ||
          owned.state.provider !== profile.provider ||
          owned.state.model !== profile.id
        )
          throw new Error('Context transform result changed the admitted identity.');
        return owned;
      }
    });
    return Object.freeze({
      ...chargesAndIdentity(result),
      status: 'settled',
      result: result.value,
      artifact: result.artifact,
      replayed: result.replayed
    });
  }

  async invokeNative(input: NativeInferenceInput) {
    return invokeNativeInference(
      {
        gateway: this.gateway,
        start: async ({ context, signal, authorize, dispatch }) => {
          const result = await this.executeDurably({
            identity: ownIdentity(context),
            operation: 'native_generation',
            profile: context.profile,
            compiled: context.compiled,
            sourceRequest: context.compiled.logicalRequest,
            ...(signal ? { signal } : {}),
            startAuthority: authorize,
            dispatch,
            decode: parseModelResponse
          });
          if (result.replayed)
            throw new Error(
              'A settled native invocation cannot be redispatched as a new connection.'
            );
          return Object.freeze({
            ...chargesAndIdentity(result),
            status: 'settled',
            response: result.value,
            replayed: false
          });
        },
        extend: (context, compiled) => this.extendNativeInvocation(context, compiled)
      },
      input
    );
  }

  private async extendNativeInvocation(
    context: NativeGenerationContext,
    compiled: CompiledModelRequest
  ): Promise<void> {
    const { repository, artifacts } = this.options;
    assertCompiledProfile(compiled, context.profile);
    assertRequestAccountingFits(compiled.accounting);
    const promptTokens = requestAccountingInputTokens(compiled.accounting);
    const completionTokens =
      compiled.accounting.outputReservation +
      (compiled.accounting.pricingSemantics.reasoningIncludedInOutput === false
        ? compiled.accounting.reasoningReservation
        : 0);
    const reservation: InferenceReservation = {
      promptTokens,
      completionTokens,
      cost: calculateInferenceCost(
        { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        context.profile.pricing
      )
    };
    const fingerprint = (
      await modelInputIdentity({
        identity: ownIdentity(context),
        inputIdentity: compiled.inputIdentity,
        accounting: compiled.accounting,
        profile: context.profile
      })
    ).slice(7);
    for (;;) {
      const state = await repository.load(context.ownerId, { invocationId: context.invocationId });
      const current = state.invocation;
      if (
        current?.start.operation !== 'native_generation' ||
        current.settlement ||
        current.uncertain ||
        current.notSent ||
        current.rejected
      )
        throw new Error('Native input extension requires an unresolved admitted generation.');
      if (current.extension?.fingerprint === fingerprint) return;
      assertBudget(
        state,
        reservation,
        this.options.budget ?? {},
        current.extension?.reservation ?? current.start.reservation
      );
      const requestRef = await artifacts.storeProtected({
        label: 'native-inference-input-extension',
        mediaType: 'application/json',
        content: new TextEncoder().encode(
          JSON.stringify({
            logical: recordableSourceRequest(compiled.logicalRequest),
            profile: context.profile,
            body: compiled.body,
            retainedBody: compiled.retainedBody,
            inputIdentity: compiled.inputIdentity,
            accounting: compiled.accounting,
            endpoint: compiled.endpoint,
            capabilityRevision: compiled.capabilityRevision
          })
        )
      });
      if (
        await repository.append(
          context.ownerId,
          {
            type: 'inference.extended',
            invocationId: context.invocationId,
            permit: current.start.permit,
            revision: (current.extension?.revision ?? 0) + 1,
            fingerprint,
            requestRef,
            reservation
          },
          state.tail
        )
      )
        return;
    }
  }

  private async invokeDurably(
    input: DurableInferenceInput,
    startAuthority?: () => Promise<void>
  ): Promise<InferenceResult> {
    const replayed = await this.replayExisting(input, 'generation', parseModelResponse);
    if (replayed)
      return Object.freeze({
        ...chargesAndIdentity(replayed),
        status: 'settled',
        response: replayed.value,
        replayed: true
      });
    const signal = input.signal ?? input.request.signal;
    signal?.throwIfAborted();
    const profile = parseModelProfile(
      input.profile ?? (await this.options.provider.describeModel(input.request.model))
    );
    const request = createModelRequest({
      ...input.request,
      ...(signal ? { signal } : {})
    });
    const compiled = input.compiled ?? (await this.gateway.compile(request, profile, input));
    const session = input.session ?? this.gateway.createSession();
    let dispatchPromise: Promise<ModelResponse> | undefined;
    let sawOutput = false;
    try {
      const result = await this.executeDurably({
        identity: ownIdentity(input),
        operation: 'generation',
        sourceRequest: request,
        ...(input.outputReservation === undefined
          ? {}
          : { outputReservation: input.outputReservation }),
        profile,
        compiled,
        ...(signal ? { signal } : {}),
        ...(startAuthority ? { startAuthority } : {}),
        canRejectContext: () => !sawOutput,
        dispatch: () => {
          dispatchPromise = this.gateway.invoke({
            request,
            profile,
            session,
            turnIndex: 0,
            compiled,
            onStreamEvent: async (event) => {
              if (event.type !== 'status') sawOutput = true;
              await input.onStreamEvent?.(event);
            }
          });
          return dispatchPromise;
        },
        decode: parseModelResponse
      });
      return Object.freeze({
        ...chargesAndIdentity(result),
        status: 'settled',
        response: result.value,
        replayed: result.replayed
      });
    } finally {
      if (!input.session) {
        // The detached request retains its session until its original late outcome arrives.
        if (dispatchPromise)
          void dispatchPromise.finally(() => session.close?.()).catch(() => undefined);
        else await session.close?.();
      }
    }
  }

  private async sourceFingerprint(
    identity: InferenceIdentity,
    operation: 'generation' | 'context_transform' | 'native_generation',
    request: ModelRequest,
    discriminator?: string,
    outputReservation?: number
  ): Promise<string> {
    return (
      await modelInputIdentity({
        identity,
        operation,
        discriminator: discriminator ?? null,
        provider: this.options.provider.id,
        implementation: this.options.provider.implementationId,
        request: recordableSourceRequest(request),
        outputReservation: outputReservation ?? null
      })
    ).slice(7);
  }

  /** Replay owns no fresh provider I/O: the persisted admission already fixed profile and input. */
  private async replayExisting<T>(
    input: GovernedInferenceInput,
    operation: 'generation' | 'context_transform' | 'native_generation',
    decode: (value: unknown) => T,
    discriminator?: string
  ): Promise<DurableResult<T> | undefined> {
    const { repository, artifacts } = this.options;
    (input.signal ?? input.request.signal)?.throwIfAborted();
    const identity = ownIdentity(input);
    const existing = (
      await repository.load(identity.ownerId, { invocationId: identity.invocationId })
    ).invocation;
    if (!existing) return undefined;
    if (
      existing.start.sourceFingerprint !==
      (await this.sourceFingerprint(
        identity,
        operation,
        input.request,
        discriminator,
        input.outputReservation
      ))
    )
      throw new Error(
        `Inference ${identity.invocationId} was already admitted with different input or configuration.`
      );
    if (hashJson(existing.start.limits) !== hashJson(this.options.budget ?? {}))
      throw new Error('Inference owner budget policy changed after admission.');
    if (input.profile) {
      const record = parseJsonObject(
        JSON.parse(
          new TextDecoder().decode(await artifacts.readVerified(existing.start.requestRef))
        ) as unknown,
        {
          maxDepth: 64,
          maxCollectionEntries: 100000,
          maxStringBytes: 32 * 1024 * 1024,
          maxTotalBytes: 64 * 1024 * 1024
        }
      );
      if (
        (await modelInputIdentity(parseModelProfile(record.profile))) !==
        (await modelInputIdentity(parseModelProfile(input.profile)))
      )
        throw new Error('Inference profile differs from its captured admission.');
    }
    if (existing.rejected)
      throw new InferenceContextRejectedError(
        identity.invocationId,
        existing.rejected.inputIdentity,
        existing.rejected.message
      );
    if (existing.notSent)
      throw new InferenceNotSentError(identity.invocationId, existing.notSent.message);
    if (!existing.settlement)
      throw new InferenceOutcomeUnknownError(
        identity.invocationId,
        existing.uncertain?.message ??
          'A prior invocation crossed its durable start boundary; replay requires provider outcome evidence.'
      );
    const settled = existing.settlement;
    const value = decode(
      JSON.parse(
        new TextDecoder().decode(await artifacts.readVerified(settled.resultRef))
      ) as unknown
    );
    return Object.freeze({
      ...identity,
      status: 'settled',
      value,
      artifact: settled.resultRef,
      replayed: true,
      usage: settled.usage,
      usageSource: settled.usageSource,
      cost: settled.cost
    });
  }

  private async executeDurably<T extends { readonly usage?: ModelUsage }>(
    input: DurableOperation<T>
  ): Promise<DurableResult<T>> {
    const { repository, artifacts } = this.options;
    const { identity, profile, compiled, signal } = input;
    signal?.throwIfAborted();
    assertCompiledProfile(compiled, profile);
    assertRequestAccountingFits(compiled.accounting);
    const logical = { ...compiled.logicalRequest };
    delete logical.signal;
    const sourceFingerprint = await this.sourceFingerprint(
      identity,
      input.operation,
      input.sourceRequest,
      input.discriminator,
      input.outputReservation
    );
    const fingerprint = (
      await modelInputIdentity({
        identity,
        operation: input.operation,
        discriminator: input.discriminator ?? null,
        provider: this.options.provider.id,
        implementation: this.options.provider.implementationId,
        profile,
        inputIdentity: compiled.inputIdentity,
        accounting: compiled.accounting,
        sourceFingerprint
      })
    ).slice(7);
    const promptTokens = requestAccountingInputTokens(compiled.accounting);
    const completionTokens =
      compiled.accounting.outputReservation +
      (compiled.accounting.pricingSemantics.reasoningIncludedInOutput === false
        ? compiled.accounting.reasoningReservation
        : 0);
    const reservation: InferenceReservation = {
      promptTokens,
      completionTokens,
      cost: calculateInferenceCost(
        {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        profile.pricing
      )
    };
    let start: Extract<InferenceEvent, { type: 'inference.started' }>;
    for (;;) {
      signal?.throwIfAborted();
      const state = await repository.load(identity.ownerId, {
        invocationId: identity.invocationId
      });
      const existing = state.invocation;
      if (existing) {
        if (existing.start.fingerprint !== fingerprint)
          throw new Error(
            `Inference ${identity.invocationId} was already admitted with different input or configuration.`
          );
        if (existing.rejected)
          throw new InferenceContextRejectedError(
            identity.invocationId,
            existing.rejected.inputIdentity,
            existing.rejected.message
          );
        if (existing.notSent)
          throw new InferenceNotSentError(identity.invocationId, existing.notSent.message);
        if (existing.settlement) {
          const value = input.decode(
            JSON.parse(
              new TextDecoder().decode(await artifacts.readVerified(existing.settlement.resultRef))
            ) as unknown
          );
          return Object.freeze({
            ...identity,
            status: 'settled',
            value,
            artifact: existing.settlement.resultRef,
            replayed: true,
            usage: existing.settlement.usage,
            usageSource: existing.settlement.usageSource,
            cost: existing.settlement.cost
          });
        }
        throw new InferenceOutcomeUnknownError(
          identity.invocationId,
          existing.uncertain?.message ??
            'A prior invocation crossed its durable start boundary; replay requires provider outcome evidence.'
        );
      }
      const limits = this.options.budget ?? {};
      assertBudget(state, reservation, limits);
      const requestRef = await artifacts.storeProtected({
        label: `inference-${input.operation}-request`,
        mediaType: 'application/json',
        content: new TextEncoder().encode(
          JSON.stringify({
            logical,
            sourceRequest: recordableSourceRequest(input.sourceRequest),
            profile,
            inputIdentity: compiled.inputIdentity,
            accounting: compiled.accounting,
            operation: input.operation
          })
        )
      });
      signal?.throwIfAborted();
      const proposed: Extract<InferenceEvent, { type: 'inference.started' }> = {
        ...identity,
        runId: identity.runId ?? null,
        type: 'inference.started',
        format: 'agent-core.inference/1',
        operation: input.operation,
        fingerprint,
        sourceFingerprint,
        requestRef,
        reservation,
        limits,
        permit: randomUUID()
      };
      if (await repository.append(identity.ownerId, proposed, state.tail)) {
        start = proposed;
        break;
      }
    }
    const permit = start.permit;
    const settle = async (raw: T): Promise<DurableResult<T>> => {
      const value = input.decode(raw);
      const resultRef = await artifacts.storeProtected({
        label: `inference-${input.operation}-response`,
        mediaType: 'application/json',
        content: new TextEncoder().encode(JSON.stringify(value))
      });
      const estimatedOutput = value.usage
        ? 0
        : new CompleteRequestEstimator().estimateText(JSON.stringify(value));
      let settlement: Extract<InferenceEvent, { type: 'inference.settled' }>;
      for (;;) {
        const state = await repository.load(identity.ownerId, {
          invocationId: identity.invocationId
        });
        const prior = state.invocation;
        if (prior?.start.permit !== permit) throw new Error('Inference settlement permit changed.');
        if (prior.settlement) {
          if (prior.settlement.resultRef.sha256 !== resultRef.sha256)
            throw new Error('Contradictory inference result.');
          settlement = prior.settlement;
          break;
        }
        const promptTokens = (prior.extension?.reservation ?? prior.start.reservation).promptTokens;
        const usage = value.usage ?? {
          promptTokens,
          completionTokens: estimatedOutput,
          totalTokens: promptTokens + estimatedOutput
        };
        settlement = {
          type: 'inference.settled',
          invocationId: identity.invocationId,
          permit,
          resultRef,
          usage,
          usageSource: value.usage ? 'provider' : 'estimate',
          cost: calculateInferenceCost(usage, profile.pricing)
        };
        if (await repository.append(identity.ownerId, settlement, state.tail)) break;
      }
      return Object.freeze({
        ...identity,
        status: 'settled',
        value,
        artifact: resultRef,
        replayed: false,
        usage: settlement.usage,
        usageSource: settlement.usageSource,
        cost: settlement.cost
      });
    };
    const uncertain = async (cause: unknown): Promise<DurableResult<T>> => {
      const failure = cause instanceof ModelStreamInterruptedError ? cause.cause : cause;
      const emptyStream =
        !(cause instanceof ModelStreamInterruptedError) ||
        (!cause.content &&
          !cause.reasoning &&
          !cause.reasoningSummary &&
          !cause.finalResponseReceived);
      if (
        input.canRejectContext?.() &&
        emptyStream &&
        failure instanceof ModelProviderError &&
        failure.provider === this.options.provider.id &&
        failure.code === 'context_overflow' &&
        !signal?.aborted
      ) {
        for (;;) {
          const state = await repository.load(identity.ownerId, {
            invocationId: identity.invocationId
          });
          const prior = state.invocation;
          if (prior?.start.permit !== permit)
            throw new Error('Inference rejection permit changed.');
          if (prior.settlement || prior.uncertain || prior.notSent) break;
          if (
            prior.rejected ||
            (await repository.append(
              identity.ownerId,
              {
                type: 'inference.rejected',
                invocationId: identity.invocationId,
                permit,
                code: 'context_overflow',
                inputIdentity: compiled.inputIdentity,
                message: failure.message
              },
              state.tail
            ))
          )
            throw new InferenceContextRejectedError(
              identity.invocationId,
              compiled.inputIdentity,
              failure.message
            );
        }
      }
      for (;;) {
        const state = await repository.load(identity.ownerId, {
          invocationId: identity.invocationId
        });
        const prior = state.invocation;
        if (prior?.settlement || prior?.uncertain || prior?.rejected) break;
        if (
          await repository.append(
            identity.ownerId,
            {
              type: 'inference.uncertain',
              invocationId: identity.invocationId,
              permit,
              message: cause instanceof Error ? cause.message : String(cause)
            },
            state.tail
          )
        )
          break;
      }
      throw new InferenceOutcomeUnknownError(
        identity.invocationId,
        cause instanceof Error ? cause.message : String(cause),
        { cause }
      );
    };
    let dispatchStarted = false;
    const authorize = async (): Promise<void> => {
      try {
        signal?.throwIfAborted();
        await input.startAuthority?.();
        signal?.throwIfAborted();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        for (;;) {
          const state = await repository.load(identity.ownerId, {
            invocationId: identity.invocationId
          });
          const prior = state.invocation;
          if (
            prior?.start.permit !== permit ||
            prior.settlement ||
            prior.uncertain ||
            prior.rejected
          )
            throw new Error('Inference admission cannot be released after dispatch evidence.', {
              cause
            });
          if (
            prior.notSent ||
            (await repository.append(
              identity.ownerId,
              {
                type: 'inference.not_sent',
                invocationId: identity.invocationId,
                permit,
                message
              },
              state.tail
            ))
          )
            break;
        }
        throw new InferenceNotSentError(identity.invocationId, message);
      }
    };
    const operation = executeEffectLifecycle({ start: authorize, settle, uncertain }, () => {
      dispatchStarted = true;
      return input.dispatch();
    });
    if (!signal) return operation;
    return new Promise<DurableResult<T>>((resolve, reject) => {
      const abort = (): void => {
        if (dispatchStarted) void uncertain(signal.reason).catch(reject);
      };
      signal.addEventListener('abort', abort, { once: true });
      operation
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener('abort', abort);
        })
        .catch(() => undefined);
      if (signal.aborted) abort();
    });
  }
}
function ownIdentity(input: InferenceIdentity): InferenceIdentity {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(input.invocationId) ||
    !input.ownerId.trim() ||
    !input.purpose.trim()
  )
    throw new Error('Inference identity and purpose must be non-empty identifiers.');
  return Object.freeze({
    invocationId: input.invocationId,
    ownerId: input.ownerId,
    ...(input.runId ? { runId: input.runId } : {}),
    purpose: input.purpose,
    ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {})
  });
}
function chargesAndIdentity(result: DurableResult<unknown>): InferenceIdentity & InferenceCharges {
  return {
    ...ownIdentity(result),
    usage: result.usage,
    usageSource: result.usageSource,
    cost: result.cost
  };
}
function assertCompiledProfile(compiled: CompiledModelRequest, profile: ModelProfile): void {
  if (
    compiled.provider !== profile.provider ||
    compiled.model !== profile.id ||
    compiled.capabilityRevision !== (profile.capabilities.protocol?.revision ?? 'conservative-v1')
  )
    throw new Error('Compiled inference changed the admitted model or capability revision.');
}
function assertBudget(
  state: InferenceOwnerState,
  next: InferenceReservation,
  limits: InferenceBudget,
  replacing?: InferenceReservation
): void {
  if (state.policyFingerprint !== undefined && state.policyFingerprint !== hashJson(limits))
    throw new Error('Inference owner budget policy changed after admission.');
  const prompt =
    state.committed.usage.promptTokens + next.promptTokens - (replacing?.promptTokens ?? 0);
  const completion =
    state.committed.usage.completionTokens +
    next.completionTokens -
    (replacing?.completionTokens ?? 0);
  const currency = limits.maxKnownCost?.currency;
  const knownCost =
    (currency === undefined ? 0 : (state.committed.knownCosts[currency] ?? 0)) +
    (next.cost.currency === currency ? (next.cost.amount ?? 0) : 0) -
    (replacing?.cost.currency === currency ? (replacing?.cost.amount ?? 0) : 0);
  const invocations = state.committed.invocations + (replacing === undefined ? 1 : 0);
  if (limits.maxInvocations !== undefined && invocations > limits.maxInvocations)
    throw new InferenceBudgetExceededError('invocations');
  if (limits.maxPromptTokens !== undefined && prompt > limits.maxPromptTokens)
    throw new InferenceBudgetExceededError('prompt_tokens');
  if (limits.maxCompletionTokens !== undefined && completion > limits.maxCompletionTokens)
    throw new InferenceBudgetExceededError('completion_tokens');
  if (limits.maxKnownCost && knownCost > limits.maxKnownCost.amount)
    throw new InferenceBudgetExceededError('known_cost');
}

function recordableSourceRequest(request: ModelRequest): Omit<ModelRequest, 'signal'> {
  const value = { ...createModelRequest(request) };
  delete value.signal;
  return value;
}
