import {
  invokeNativeInference,
  type NativeInferenceInput,
  type NativeGenerationContext
} from './native-inference.js';
import { parseInferenceBudget } from './repository.js';
import { randomUUID } from 'node:crypto';
import { hashJson, type ArtifactRepository, type ArtifactRef } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import {
  createModelRequest,
  parseModelProfile,
  parseModelResponse,
  parseModelContextTransformResult,
  requestAccountingInputTokens,
  assertRequestAccountingFits,
  modelInputIdentity,
  CompleteRequestEstimator,
  type ModelProvider,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
  type ModelProviderSession,
  type ModelStreamEvent,
  type CompiledModelRequest,
  type ModelContextTransformResult,
  type ModelUsage
} from '@agent-core/model';
import { InferenceGateway, type InferenceInvocation } from './gateway.js';
import { executeInferenceLifecycle, type InferenceLifecycle } from './lifecycle.js';
import type {
  InferenceBudget,
  InferenceIdentity,
  InferenceRepository,
  InferenceEvent,
  InferenceOwnerState,
  InferenceReservation
} from './repository.js';
import { calculateInferenceCost, type InferenceCost } from './usage-cost.js';

export interface InferenceServiceOptions {
  readonly provider: ModelProvider;
  readonly repository?: InferenceRepository;
  readonly artifacts?: ArtifactRepository;
  readonly budget?: InferenceBudget;
}
export interface GovernedInferenceInput extends InferenceIdentity {
  readonly request: ModelRequest;
  readonly profile?: ModelProfile;
  readonly signal?: AbortSignal;
  readonly onStreamEvent?: (
    event: Exclude<ModelStreamEvent, { readonly type: 'done' }>
  ) => void | Promise<void>;
}
export interface GovernedContextTransformInput extends Omit<GovernedInferenceInput, 'onStreamEvent'> {
  readonly transformId: string;
}
interface DurableInferenceInput extends GovernedInferenceInput {
  readonly session?: ModelProviderSession;
  readonly admitted?: CompiledModelRequest;
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
    message: string
  ) {
    super(message);
    this.name = 'InferenceOutcomeUnknownError';
  }
}
export class InferenceBudgetExceededError extends Error {
  constructor(readonly resource: 'invocations' | 'prompt_tokens' | 'completion_tokens' | 'known_cost') {
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
  readonly signal?: AbortSignal;
  readonly discriminator?: string;
  readonly dispatch: () => Promise<T>;
  readonly decode: (value: unknown) => T;
  readonly startAuthority?: () => Promise<void>;
}

/** One admission ledger, reservation policy, cancellation path, and settlement lifecycle for all inference. */
export class InferenceService {
  private readonly gateway: InferenceGateway;
  constructor(readonly options: InferenceServiceOptions) {
    this.gateway = new InferenceGateway(options.provider);
    this.options = Object.freeze({
      ...options,
      budget: parseInferenceBudget(options.budget ?? {})
    });
  }
  createSession(): ModelProviderSession {
    return this.gateway.createSession();
  }
  async compile(request: ModelRequest, profile: ModelProfile) {
    return this.gateway.compile(request, profile);
  }
  async invokeWithLifecycle<TResult>(
    input: InferenceInvocation,
    lifecycle: InferenceLifecycle<TResult>,
    identity?: InferenceIdentity
  ): Promise<TResult> {
    if (this.options.repository && this.options.artifacts) {
      if (!identity) throw new Error('A durable inference service requires the owning invocation identity.');
      const dispatch = { started: false };
      let result: InferenceResult;
      try {
        result = await this.invokeDurably(
          {
            ...identity,
            request: input.request,
            profile: input.profile,
            session: input.session,
            ...(input.admitted ? { admitted: input.admitted } : {}),
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
    const admitted = input.admitted ?? (await this.gateway.admit(input.request, input.profile));
    return executeInferenceLifecycle(lifecycle, () => this.gateway.invoke({ ...input, admitted }));
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
    this.requireDurability();
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
    const compiled = await provider.compileContextTransform({
      transformId: input.transformId,
      request,
      ...(signal ? { signal } : {})
    });
    assertCompiledProfile(compiled, profile);
    assertRequestAccountingFits(compiled.accounting);
    const result = await this.executeDurably({
      identity: ownIdentity(input),
      operation: 'context_transform',
      sourceRequest: request,
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
    this.requireDurability();
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
            throw new Error('A settled native invocation cannot be redispatched as a new connection.');
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
    const { repository, artifacts } = this.requireDurability();
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
        profile: context.profile
      })
    ).slice(7);
    for (;;) {
      const state = await repository.load(context.ownerId);
      const current = state.invocations.get(context.invocationId);
      if (
        current?.start.operation !== 'native_generation' ||
        current.settlement ||
        current.uncertain ||
        current.notSent
      )
        throw new Error('Native input extension requires an unresolved admitted generation.');
      if (current.extensions.at(-1)?.fingerprint === fingerprint) return;
      const other = new Map(state.invocations);
      other.delete(context.invocationId);
      assertBudget({ ...state, invocations: other }, reservation, this.options.budget ?? {});
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
            revision: current.extensions.length + 1,
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
    this.requireDurability();
    const signal = input.signal ?? input.request.signal;
    signal?.throwIfAborted();
    const profile = parseModelProfile(
      input.profile ?? (await this.options.provider.describeModel(input.request.model))
    );
    const request = createModelRequest({
      ...input.request,
      ...(signal ? { signal } : {})
    });
    const compiled = input.admitted ?? (await this.gateway.admit(request, profile));
    const session = input.session ?? this.gateway.createSession();
    let dispatchPromise: Promise<ModelResponse> | undefined;
    try {
      const result = await this.executeDurably({
        identity: ownIdentity(input),
        operation: 'generation',
        sourceRequest: request,
        profile,
        compiled,
        ...(signal ? { signal } : {}),
        ...(startAuthority ? { startAuthority } : {}),
        dispatch: () => {
          dispatchPromise = this.gateway.invoke({
            request,
            profile,
            session,
            turnIndex: 0,
            admitted: compiled,
            ...(input.onStreamEvent ? { onStreamEvent: input.onStreamEvent } : {})
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
        if (dispatchPromise) void dispatchPromise.finally(() => session.close?.()).catch(() => undefined);
        else await session.close?.();
      }
    }
  }

  private async sourceFingerprint(
    identity: InferenceIdentity,
    operation: 'generation' | 'context_transform' | 'native_generation',
    request: ModelRequest,
    discriminator?: string
  ): Promise<string> {
    return (
      await modelInputIdentity({
        identity,
        operation,
        discriminator: discriminator ?? null,
        provider: this.options.provider.id,
        implementation: this.options.provider.implementationId,
        request: recordableSourceRequest(request)
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
    const { repository, artifacts } = this.requireDurability();
    (input.signal ?? input.request.signal)?.throwIfAborted();
    const identity = ownIdentity(input);
    const existing = (await repository.load(identity.ownerId)).invocations.get(identity.invocationId);
    if (!existing) return undefined;
    if (
      existing.start.sourceFingerprint !==
      (await this.sourceFingerprint(identity, operation, input.request, discriminator))
    )
      throw new Error(
        `Inference ${identity.invocationId} was already admitted with different input or configuration.`
      );
    if (
      hashJson(existing.start.limits) !==
      hashJson(this.options.budget ?? {})
    )
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
    if (existing.notSent) throw new InferenceNotSentError(identity.invocationId, existing.notSent.message);
    if (!existing.settlement)
      throw new InferenceOutcomeUnknownError(
        identity.invocationId,
        existing.uncertain?.message ??
          'A prior invocation crossed its durable start boundary; replay requires provider outcome evidence.'
      );
    const settled = existing.settlement;
    const value = decode(
      JSON.parse(new TextDecoder().decode(await artifacts.readVerified(settled.resultRef))) as unknown
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

  private requireDurability(): {
    repository: InferenceRepository;
    artifacts: ArtifactRepository;
  } {
    const { repository, artifacts } = this.options;
    if (!repository || !artifacts)
      throw new Error('Auxiliary inference requires explicit invocation and artifact repositories.');
    return { repository, artifacts };
  }
  private async executeDurably<T extends { readonly usage?: ModelUsage }>(
    input: DurableOperation<T>
  ): Promise<DurableResult<T>> {
    const { repository, artifacts } = this.requireDurability();
    const { identity, profile, compiled, signal } = input;
    signal?.throwIfAborted();
    assertCompiledProfile(compiled, profile);
    const logical = { ...compiled.logicalRequest };
    delete logical.signal;
    const sourceFingerprint = await this.sourceFingerprint(
      identity,
      input.operation,
      input.sourceRequest,
      input.discriminator
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
        request: JSON.parse(JSON.stringify(logical)) as unknown
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
      const state = await repository.load(identity.ownerId);
      const existing = state.invocations.get(identity.invocationId);
      if (existing) {
        if (existing.start.fingerprint !== fingerprint)
          throw new Error(
            `Inference ${identity.invocationId} was already admitted with different input or configuration.`
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
      const usage = value.usage ?? {
        promptTokens: reservation.promptTokens,
        completionTokens: estimatedOutput,
        totalTokens: reservation.promptTokens + estimatedOutput
      };
      const cost = calculateInferenceCost(usage, profile.pricing);
      const usageSource = value.usage ? 'provider' : 'estimate';
      for (;;) {
        const state = await repository.load(identity.ownerId);
        const prior = state.invocations.get(identity.invocationId);
        if (prior?.start.permit !== permit) throw new Error('Inference settlement permit changed.');
        if (prior.settlement) {
          if (prior.settlement.resultRef.sha256 !== resultRef.sha256)
            throw new Error('Contradictory inference result.');
          break;
        }
        if (
          await repository.append(
            identity.ownerId,
            {
              type: 'inference.settled',
              invocationId: identity.invocationId,
              permit,
              resultRef,
              usage,
              usageSource,
              cost
            },
            state.tail
          )
        )
          break;
      }
      return Object.freeze({
        ...identity,
        status: 'settled',
        value,
        artifact: resultRef,
        replayed: false,
        usage,
        usageSource,
        cost
      });
    };
    const uncertain = async (cause: unknown): Promise<DurableResult<T>> => {
      for (;;) {
        const state = await repository.load(identity.ownerId);
        const prior = state.invocations.get(identity.invocationId);
        if (prior?.settlement || prior?.uncertain) break;
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
        'Provider dispatch ended without a durable known result; the invocation will not be retried.'
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
          const state = await repository.load(identity.ownerId);
          const prior = state.invocations.get(identity.invocationId);
          if (prior?.start.permit !== permit || prior.settlement || prior.uncertain)
            throw new Error('Inference admission cannot be released after dispatch evidence.', { cause });
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
    const operation = executeInferenceLifecycle({ start: authorize, settle, uncertain }, () => {
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
function assertBudget(state: InferenceOwnerState, next: InferenceReservation, limits: InferenceBudget): void {
  let prompt = next.promptTokens;
  let completion = next.completionTokens;
  let knownCost = next.cost.currency === limits.maxKnownCost?.currency ? (next.cost.amount ?? 0) : 0;
  const policy = hashJson(limits);
  let invocations = 1;
  for (const item of state.invocations.values()) {
    if (hashJson(item.start.limits) !== policy)
      throw new Error('Inference owner budget policy changed after admission.');
    if (item.notSent) continue;
    invocations++;
    const reserved = item.extensions.at(-1)?.reservation ?? item.start.reservation;
    prompt += item.settlement?.usage.promptTokens ?? reserved.promptTokens;
    completion += item.settlement?.usage.completionTokens ?? reserved.completionTokens;
    const cost = item.settlement?.cost ?? reserved.cost;
    if (cost.currency === limits.maxKnownCost?.currency) knownCost += cost.amount ?? 0;
  }
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
