import { effectiveCapabilitySnapshotSchema } from '../run/capabilities.js';
import { captureRequestCapabilities, capturedRequestCapabilities } from './capability-capture.js';
import { historyCutSchema } from '../history/schema.js';
import type { HistorySourceCut } from '../history/contracts.js';
import * as z from 'zod';
import {
  readAdmittedModelInput,
  type RequestPresentation
} from './input.js';
import type { SessionStateInference } from '../session/session-state.js';
import { ModelStreamInterruptedError } from '../orchestration/model-stream.js';
import { executeEffectLifecycle, type EffectLifecycle } from '@agent-core/effects';
import { parseJsonObject } from '@agent-core/json';
import {
  RequestTokenEstimator,
  ModelProviderError,
  assertRequestAccountingFits,
  createModelRequest,
  modelInputIdentity,
  observeModelRequest,
  parseModelProfile,
  parseModelResponse,
  requestAccountingInputTokens,
  requestAccountingInputBound,
  type CompiledModelRequest,
  type ModelCompilationOptions,
  type ModelProfile,
  type ModelNativeDispatch,
  type ModelProvider,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelUsage,
  type RequestAccountingKind,
  type RequestTokenObservation
} from '@agent-core/model';
import {
  InMemoryArtifactRepository,
  hashJson,
  type ArtifactRef,
  type ArtifactRepository,
  type EventLedgerTail
} from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';
import { InferenceGateway, type InferenceInvocation } from './gateway.js';
import { ContextAdmissionError } from './request-admission.js';
import {
  invokeNativeInference,
  type NativeGenerationContext,
  type NativeInferenceInput
} from './native-inference.js';
import type {
  InferenceBudget,
  InferenceBudgetScopeBinding,
  InferenceBudgetScopeState,
  InferenceEvent,
  InferenceIdentity,
  InferenceOwnerState,
  InferenceRepository,
  InferenceReservation
} from './repository.js';
import { InMemoryInferenceRepository, parseInferenceBudget } from './repository.js';
import { calculateInferenceCost, type InferenceCost } from './usage-cost.js';

/** Inference alone can prove a transport was not sent after owning execution preparation. */
export interface InferenceLifecycle<TResult> extends EffectLifecycle<TResult, ModelResponse> {
  notSent(cause: InferenceNotSentError): Promise<TResult>;
}

export interface InferenceServiceOptions {
  readonly provider: ModelProvider;
  readonly repository: InferenceRepository;
  readonly artifacts: ArtifactRepository;
  readonly budget?: InferenceBudget;
  /** Side-effect-free application policy, checked before any provider dispatch authority. */
  readonly admitRequest?: (request: CompiledModelRequest) => void | Promise<void>;
}
export interface GovernedInferenceInput extends InferenceIdentity, ModelCompilationOptions {
  readonly withDispatchAuthority?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly stateSelectionId?: string | null;
  readonly capturedHistoryCut?: HistorySourceCut | undefined;
  readonly request: ModelRequest;
  readonly compiled?: CompiledModelRequest;
  readonly profile?: ModelProfile;
  readonly signal?: AbortSignal;
  readonly onStreamEvent?: (
    event: Exclude<ModelStreamEvent, { readonly type: 'done' }>
  ) => void | Promise<void>;
}
interface DurableInferenceInput extends GovernedInferenceInput {
  readonly session?: ModelProviderSession;
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
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
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
export interface InferenceBudgetDiagnostic {
  readonly resource: 'invocations' | 'prompt_tokens' | 'completion_tokens' | 'known_cost';
  readonly budgetScopeId?: string;
  readonly participantId?: string;
  readonly ownerId: string;
  readonly invocationId: string;
  readonly inputIdentity: string;
  readonly ledgerTail: EventLedgerTail;
  readonly limit: number;
  readonly settled: number;
  readonly outstanding: number;
  readonly candidate: number;
  readonly replacing: number;
  readonly projected: number;
  readonly currency?: string;
  readonly inputAccounting: {
    readonly tokens: number;
    readonly reservation: number;
    readonly basis: 'compiled_accounting' | 'model_input_bound';
    readonly unknownKinds: readonly RequestAccountingKind[];
  };
}
export class InferenceBudgetExceededError extends Error {
  readonly diagnostic: InferenceBudgetDiagnostic;

  constructor(diagnostic: InferenceBudgetDiagnostic) {
    const replaced = diagnostic.replacing === 0 ? '' : ` - ${String(diagnostic.replacing)} replaced`;
    const currency = diagnostic.currency === undefined ? '' : ` ${diagnostic.currency}`;
    const bound = diagnostic.inputAccounting.basis === 'model_input_bound' &&
      (diagnostic.resource === 'prompt_tokens' || diagnostic.resource === 'known_cost')
        ? ` Candidate input reserves ${String(diagnostic.inputAccounting.reservation)} tokens from the finite model input bound because ${diagnostic.inputAccounting.unknownKinds.join(', ')} is uncounted; compiled accounting is ${String(diagnostic.inputAccounting.tokens)} tokens.`
        : '';
    super(
      `Inference ${diagnostic.budgetScopeId === undefined ? 'owner' : 'participant scope'} allowance exceeded (${diagnostic.resource}): ` +
      `${String(diagnostic.settled)} settled + ${String(diagnostic.outstanding)} outstanding reservations + ` +
      `${String(diagnostic.candidate)} candidate${replaced} = ${String(diagnostic.projected)}; ` +
      `limit ${String(diagnostic.limit)}${currency}.${bound}`
    );
    this.diagnostic = Object.freeze({
      ...diagnostic,
      ledgerTail: Object.freeze({ ...diagnostic.ledgerTail }),
      inputAccounting: Object.freeze({
        ...diagnostic.inputAccounting,
        unknownKinds: Object.freeze([...diagnostic.inputAccounting.unknownKinds])
      })
    });
    this.name = 'InferenceBudgetExceededError';
  }
  get resource(): InferenceBudgetDiagnostic['resource'] {
    return this.diagnostic.resource;
  }
}
interface DurableOperation<T extends { readonly usage?: ModelUsage }> {
  readonly nativeDispatch?: ModelNativeDispatch | undefined;
  readonly identity: InferenceIdentity;
  readonly stateSelectionId?: string | null;
  readonly capturedHistoryCut?: HistorySourceCut | undefined;
  readonly operation: 'generation' | 'native_generation';
  readonly profile: ModelProfile;
  readonly compiled: CompiledModelRequest;
  readonly sourceRequest: ModelRequest;
  readonly outputReservation?: number;
  readonly signal?: AbortSignal;
  readonly dispatch: () => Promise<T>;
  readonly decode: (value: unknown) => T;
  readonly startAuthority?: () => Promise<void>;
  readonly withDispatchAuthority?: <TValue>(operation: () => Promise<TValue>) => Promise<TValue>;
  readonly canRejectContext?: () => boolean;
}

/** One admission ledger, reservation policy, cancellation path, and settlement lifecycle for all inference. */
export class InferenceService {
  private readonly presentations = new WeakMap<CompiledModelRequest, RequestPresentation>();
  private readonly gateway: InferenceGateway;
  private tokenObservation: RequestTokenObservation | undefined;
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
      ...(options.budget === undefined ? {} : { budget: parseInferenceBudget(options.budget) })
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
  /** Settled invocation identities are counted once, including native generations. */
  presentationFor(compiled: CompiledModelRequest): RequestPresentation | undefined {
    return this.presentations.get(compiled);
  }

  async settledRunUsage(ownerId: string, runId: string) {
    return (await this.options.repository.load(ownerId, { runId })).settledUsage;
  }

  async inspectLatestAdmission(ownerId: string) {
    const { latestInvocation: invocation } = await this.options.repository.load(ownerId);
    if (!invocation) return null;
    const ref = invocation.extension?.requestRef ?? invocation.start.requestRef;
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.options.artifacts.readVerified(ref))) as Record<string, unknown>;
    if (typeof record.inputIdentity !== 'string' || typeof record.capabilityRevision !== 'string')
      throw new Error('Recorded inference request lacks operational admission identity.');
    const snapshot = record.capabilities === undefined ? null : effectiveCapabilitySnapshotSchema.parse(record.capabilities);
    return Object.freeze({ inputIdentity: record.inputIdentity, protocolCapabilityRevision: record.capabilityRevision,
      snapshot, invocationId: invocation.start.invocationId, runId: invocation.start.runId, purpose: invocation.start.purpose,
      contextAdmission: 'admitted' as const,
      invocationStatus: invocation.settlement ? 'settled' as const : invocation.notSent ? 'not_sent' as const :
        invocation.rejected ? 'rejected' as const : invocation.uncertain ? 'uncertain' as const : 'started' as const,
      dispatch: invocation.notSent ? 'not_sent' as const : invocation.settlement || invocation.rejected ? 'observed' as const : 'unconfirmed' as const });
  }

  private ownerBudget(state: InferenceOwnerState): InferenceBudget {
    const recorded = state.limits;
    if (recorded && this.options.budget !== undefined && hashJson(recorded) !== hashJson(this.options.budget))
      throw new Error('Inference owner budget policy changed after admission.');
    return recorded ?? this.options.budget ?? {};
  }

  /** Register one immutable participant allowance in the same journal as owner reservations. */
  async registerBudgetScope(
    input: InferenceBudgetScopeBinding & { readonly ownerId: string }
  ): Promise<InferenceBudgetScopeState> {
    const binding = Object.freeze({
      ownerId: input.ownerId,
      participantId: input.participantId,
      scopeId: input.scopeId,
      budget: parseInferenceBudget(input.budget)
    });
    if (![binding.ownerId, binding.participantId, binding.scopeId].every(value => typeof value === 'string' && value.trim()))
      throw new Error('Inference owner, participant, and budget scope must be non-empty identifiers.');
    for (;;) {
      const state = await this.options.repository.load(binding.ownerId);
      const limits = this.ownerBudget(state);
      const existing = Object.values(state.budgetScopes).find(scope =>
        scope.scopeId === binding.scopeId || scope.participantId === binding.participantId);
      if (existing) {
        if (existing.scopeId !== binding.scopeId || existing.participantId !== binding.participantId ||
            hashJson(existing.budget) !== hashJson(binding.budget))
          throw new Error('Inference participant budget scope or policy changed after registration.');
        return existing;
      }
      if (await this.options.repository.append(binding.ownerId, {
        ...binding, type: 'inference.scope_registered', format: 'agent-core.inference/2', limits
      }, state.tail)) {
        const registered = (await this.options.repository.load(binding.ownerId)).budgetScopes[binding.scopeId];
        if (!registered) throw new Error('Inference scope registration did not persist.');
        return registered;
      }
    }
  }

  private budgetScope(
    state: InferenceOwnerState,
    identity: Pick<InferenceIdentity, 'participantId' | 'budgetScopeId'>,
    admitted = false
  ): InferenceBudgetScopeState | undefined {
    if (admitted && (!state.invocation || state.invocation.start.participantId !== identity.participantId ||
        state.invocation.start.budgetScopeId !== identity.budgetScopeId))
      throw new Error('Inference participant budget scope differs from its admitted invocation.');
    const scope = identity.budgetScopeId === undefined || !Object.hasOwn(state.budgetScopes, identity.budgetScopeId)
      ? undefined : state.budgetScopes[identity.budgetScopeId];
    if (identity.budgetScopeId !== undefined && (!scope || scope.participantId !== identity.participantId))
      throw new Error('Inference requires its registered participant budget scope.');
    if (!scope && !admitted && Object.keys(state.budgetScopes).length > 0)
      throw new Error('Inference participant budget scope cannot be omitted for this owner.');
    return scope;
  }

  /** Read a participant's durable allowance without reserving or authorizing work. */
  async inspectBudgetScopeAllowance(ownerId: string, scopeId: string) {
    const state = await this.options.repository.load(ownerId);
    this.ownerBudget(state);
    const scope = Object.hasOwn(state.budgetScopes, scopeId) ? state.budgetScopes[scopeId] : undefined;
    if (!scope) throw new Error('Inference participant budget scope is not registered.');
    return Object.freeze({ ownerId, participantId: scope.participantId, budgetScopeId: scope.scopeId,
      ...allowanceSnapshot(state.tail, scope.budget, scope.committed, scope.settledUsage) });
  }

  /** Read the existing owner ledger; this snapshot neither reserves nor authorizes work. */
  async inspectOwnerAllowance(ownerId: string) {
    const state = await this.options.repository.load(ownerId);
    const limits = this.ownerBudget(state);
    return Object.freeze({ ownerId, budgetScopes: state.budgetScopes,
      ...allowanceSnapshot(state.tail, limits, state.committed, state.settledUsage) });
  }

  /** The caller must durably fence dispatch and prove this invocation has never started. */
  async cancelBeforeDispatch(
    identity: Pick<InferenceIdentity, 'ownerId' | 'invocationId' | 'runId' | 'participantId' | 'budgetScopeId'>,
    message: string
  ): Promise<void> {
    const { repository } = this.options;
    for (;;) {
      const state = await repository.load(identity.ownerId, { invocationId: identity.invocationId });
      const prior = state.invocation;
      if (prior?.start.runId !== (identity.runId ?? null))
        throw new Error('Inference cancellation does not match its admitted invocation.');
      this.budgetScope(state, identity, true);
      if (prior.notSent) return;
      if (prior.settlement || prior.uncertain || prior.rejected || prior.extension)
        throw new Error('Inference admission cannot be released after dispatch evidence.');
      if (await repository.append(identity.ownerId, {
        type: 'inference.not_sent',
        invocationId: identity.invocationId,
        permit: prior.start.permit,
        message
      }, state.tail)) return;
    }
  }

  async contextRejection(ownerId: string, invocationId: string) {
    return (await this.options.repository.load(ownerId, { invocationId })).invocation?.rejected;
  }

  createSession(): ModelProviderSession {
    return this.gateway.createSession();
  }
  async compile(
    request: ModelRequest,
    profile: ModelProfile,
    options?: ModelCompilationOptions,
    presentation?: RequestPresentation
  ) {
    const compiled = await this.gateway.compile(request, profile, {
      ...(this.tokenObservation ? { tokenObservation: this.tokenObservation } : {}),
      ...options
    });
    if (presentation) this.presentations.set(compiled, presentation);
    return compiled;
  }

  async inputReference(ownerId: string, invocationId: string) {
    const { invocation } = await this.options.repository.load(ownerId, { invocationId });
    if (!invocation) throw new Error('No recorded originating inference.');
    const ref = invocation.extension?.requestRef ?? invocation.start.requestRef;
    if (ref.visibility !== 'protected') throw new Error('Recorded inference input is not protected.');
    return ref;
  }

  async admittedInput(ownerId: string, invocationId: string) {
    return readAdmittedModelInput(
      this.options.artifacts,
      await this.inputReference(ownerId, invocationId)
    );
  }

  async admit(compiled: CompiledModelRequest, profile: ModelProfile): Promise<void> {
    assertCompiledProfile(compiled, profile);
    const identity = await modelInputIdentity(
      compiled.retainedBody === undefined
        ? compiled.body
        : { body: compiled.body, retainedBody: compiled.retainedBody }
    );
    if (identity !== compiled.inputIdentity)
      throw new Error('Compiled provider input identity changed.');
    try {
      assertRequestAccountingFits(compiled.accounting);
    } catch (cause) {
      throw new ContextAdmissionError(compiled, cause);
    }
    await this.options.admitRequest?.(compiled);
  }
  async inputInvocationId(ownerId: string, ref: ArtifactRef): Promise<string> {
    if (ref.visibility !== 'protected') throw new Error('Inference input must be protected.');
    const record = z.object({ invocationId: z.string().min(1) }).parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        await this.options.artifacts.readVerified(ref)
      )) as unknown
    );
    const current = await this.inputReference(ownerId, record.invocationId);
    if (current.sha256 !== ref.sha256) throw new Error('Inference input does not match its durable invocation.');
    return record.invocationId;
  }

  /** Prove a settled native result-only successor of this exact original tool call. */
  async isNativeAcknowledgement(
    ownerId: string,
    invocationId: string,
    sourceInvocationId: string,
    toolCallId: string
  ): Promise<boolean> {
    const [successor, source] = await Promise.all([
      this.options.repository.load(ownerId, { invocationId }),
      this.options.repository.load(ownerId, { invocationId: sourceInvocationId })
    ]);
    const next = successor.invocation;
    const prior = source.invocation;
    if (!next?.settlement || !prior?.settlement ||
        next.start.operation !== 'native_generation' ||
        prior.start.operation !== 'native_generation' || next.start.runId !== prior.start.runId)
      return false;
    const record = z.object({ nativeDispatch: nativeDispatchProvenanceSchema.optional() }).parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        await this.options.artifacts.readVerified(next.extension?.requestRef ?? next.start.requestRef)
      )) as unknown
    );
    const dispatch = record.nativeDispatch;
    if (dispatch?.kind !== 'tool_results' || dispatch.sourceCalls.length !== 1) return false;
    const response = parseModelResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await this.options.artifacts.readVerified(prior.settlement.resultRef)
    )) as unknown);
    return dispatch.sourceCalls[0]?.toolCallId === toolCallId &&
      dispatch.sourceCalls[0].responseId === response.requestId &&
      response.toolCalls?.some(call => call.id === toolCallId) === true;
  }

  async sessionStateOrigin(
    ownerId: string,
    invocationId: string
  ): Promise<{
    readonly stateSelectionId: string | null;
    readonly capturedHistoryCut: HistorySourceCut;
    readonly inference: SessionStateInference;
  }> {
    const ref = await this.inputReference(ownerId, invocationId);
    // Only the captured binding is needed here. The protected, already-accounted
    // request body is not a model-tool JSON payload with collection quotas.
    const record = z
      .object({ stateSelectionId: z.string().min(1).nullable(), capturedHistoryCut: historyCutSchema })
      .parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await this.options.artifacts.readVerified(ref)
          )
        ) as unknown
      );
    return {
      stateSelectionId: record.stateSelectionId,
      capturedHistoryCut: record.capturedHistoryCut,
      inference: { ownerId, invocationId, requestRef: ref }
    };
  }

  async invokeWithLifecycle<TResult>(
    input: InferenceInvocation,
    lifecycle: InferenceLifecycle<TResult>,
    identity: InferenceIdentity
  ): Promise<TResult> {
    const dispatch = { started: false, startAttempted: false };
    let result: InferenceResult;
    try {
      result = await this.invokeDurably(
        {
          ...identity,
          ...(input.withDispatchAuthority ? { withDispatchAuthority: input.withDispatchAuthority } : {}),
          stateSelectionId: input.stateSelectionId ?? null,
          capturedHistoryCut: input.capturedHistoryCut,
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
          dispatch.startAttempted = true;
          await lifecycle.start();
          dispatch.started = true;
        }
      );
    } catch (cause) {
      if (cause instanceof InferenceNotSentError && dispatch.startAttempted) return lifecycle.notSent(cause);
      if (!dispatch.started) throw cause;
      return lifecycle.uncertain(cause);
    }
    if (!dispatch.started) await lifecycle.start();
    return lifecycle.settle(result.response);
  }
  async invoke(input: GovernedInferenceInput): Promise<InferenceResult> {
    return this.invokeDurably(input);
  }

  async invokeNative(input: NativeInferenceInput) {
    const presentation = this.presentationFor(input.compiled);
    if (presentation?.materialDependencies?.length || presentation?.skillReferences?.length)
      throw new Error('Revocable material requires a governed request launch; native continuous transport does not expose a held dispatch fence.');
    return invokeNativeInference(
      {
        gateway: this.gateway,
        start: async ({ context, signal, authorize, dispatch }) => {
          const capabilities = input.capabilities?.(context);
          if (capabilities) captureRequestCapabilities(context.compiled, capabilities);
          const result = await this.executeDurably({
            identity: ownIdentity(context),
            stateSelectionId: input.stateSelectionId?.() ?? null,
            capturedHistoryCut: await input.capturedHistoryCut?.(),
            operation: 'native_generation',
            nativeDispatch: context.dispatch,
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
        extend: async (context, compiled, dispatch) => {
          const capabilities = input.capabilities?.({ ...context, compiled, dispatch });
          if (capabilities) captureRequestCapabilities(compiled, capabilities);
          return this.extendNativeInvocation(context, compiled, input.stateSelectionId?.() ?? null, await input.capturedHistoryCut?.(), dispatch);
        }
      },
      {
        ...input,
        settled: async (settlement) => {
          this.tokenObservation = observeModelRequest(
            settlement.context.compiled,
            settlement.result.response
          );
          await input.settled(settlement);
        }
      }
    );
  }

  private async extendNativeInvocation(
    context: NativeGenerationContext,
    compiled: CompiledModelRequest,
    stateSelectionId: string | null,
    capturedHistoryCut: HistorySourceCut | undefined,
    dispatch: ModelNativeDispatch
  ): Promise<void> {
    const { repository, artifacts } = this.options;
    capturedHistoryCut = capturedHistoryCut === undefined ? undefined : historyCutSchema.parse(capturedHistoryCut);
    await this.admit(compiled, context.profile);
    const fingerprint = (
      await modelInputIdentity({
        identity: ownIdentity(context),
        stateSelectionId,
        capturedHistoryCut: capturedHistoryCut ?? null,
        nativeDispatch: nativeDispatchProvenance(dispatch),
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
      const scope = this.budgetScope(state, context, true);
      const limits = this.ownerBudget(state);
      const reservation = inferenceReservation(compiled, context.profile, [limits, ...(scope ? [scope.budget] : [])]);
      if (current.extension?.fingerprint === fingerprint) return;
      assertAdmissionBudgets({
        state,
        reservation,
        identity: context,
        compiled,
        profile: context.profile,
        limits,
        ...(scope ? { scope } : {}),
        replacing: current.extension?.reservation ?? current.start.reservation
      });
      const requestRef = await artifacts.storeProtected({
        label: 'native-inference-input-extension',
        mediaType: 'application/json',
        content: new TextEncoder().encode(
          JSON.stringify({
            invocationId: context.invocationId,
            ...(context.participantId === undefined ? {} : { participantId: context.participantId, budgetScopeId: context.budgetScopeId }),
            stateSelectionId,
            capturedHistoryCut,
            nativeDispatch: nativeDispatchProvenance(dispatch),
            logical: recordableSourceRequest(compiled.logicalRequest),
            profile: context.profile,
            body: compiled.body,
            retainedBody: compiled.retainedBody,
            inputIdentity: compiled.inputIdentity,
            accounting: compiled.accounting,
            endpoint: compiled.endpoint,
            capabilityRevision: compiled.capabilityRevision,
            capabilities: capturedRequestCapabilities(compiled)
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
    if (replayed) {
      if (input.compiled)
        this.tokenObservation = observeModelRequest(input.compiled, replayed.value);
      return Object.freeze({
        ...chargesAndIdentity(replayed),
        status: 'settled',
        response: replayed.value,
        replayed: true
      });
    }
    const signal = input.signal ?? input.request.signal;
    signal?.throwIfAborted();
    const profile = parseModelProfile(
      input.profile ?? (await this.options.provider.describeModel(input.request.model))
    );
    const request = createModelRequest({
      ...input.request,
      ...(signal ? { signal } : {})
    });
    const compiled = input.compiled ?? (await this.compile(request, profile, input));
    const session = input.session ?? this.gateway.createSession();
    let dispatchPromise: Promise<ModelResponse> | undefined;
    let sawOutput = false;
    try {
      const result = await this.executeDurably({
        identity: ownIdentity(input),
        stateSelectionId: input.stateSelectionId ?? null,
        capturedHistoryCut: input.capturedHistoryCut,
        operation: 'generation',
        sourceRequest: request,
        ...(input.outputReservation === undefined
          ? {}
          : { outputReservation: input.outputReservation }),
        profile,
        compiled,
        ...(signal ? { signal } : {}),
        ...(startAuthority ? { startAuthority } : {}),
        ...(input.withDispatchAuthority ? { withDispatchAuthority: input.withDispatchAuthority } : {}),
        canRejectContext: () => !sawOutput,
        dispatch: () => {
          dispatchPromise = this.gateway.invoke({
            request,
            profile,
            session,
            transport: { affinityKey: input.ownerId },
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
      this.tokenObservation = observeModelRequest(compiled, result.value);
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
    operation: 'generation' | 'native_generation',
    request: ModelRequest,
    stateSelectionId: string | null,
    capturedHistoryCut: HistorySourceCut | undefined,
    outputReservation?: number
  ): Promise<string> {
    return (
      await modelInputIdentity({
        identity,
        operation,
        stateSelectionId,
        capturedHistoryCut: capturedHistoryCut === undefined ? null : historyCutSchema.parse(capturedHistoryCut),
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
    operation: 'generation' | 'native_generation',
    decode: (value: unknown) => T
  ): Promise<DurableResult<T> | undefined> {
    const { repository, artifacts } = this.options;
    (input.signal ?? input.request.signal)?.throwIfAborted();
    const identity = ownIdentity(input);
    const state = await repository.load(identity.ownerId, { invocationId: identity.invocationId });
    const existing = state.invocation;
    this.ownerBudget(state);
    this.budgetScope(state, identity, existing !== undefined);
    if (!existing) return undefined;
    if (
      existing.start.sourceFingerprint !==
      (await this.sourceFingerprint(
        identity,
        operation,
        input.request,
        input.stateSelectionId ?? null,
        input.capturedHistoryCut,
        input.outputReservation
      ))
    )
      throw new Error(
        `Inference ${identity.invocationId} was already admitted with different input or configuration.`
      );
    if (input.profile || input.compiled) {
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
      if (input.compiled && record.inputIdentity !== input.compiled.inputIdentity)
        throw new Error('Inference input differs from its captured admission.');
      if (
        input.profile &&
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
    const capturedHistoryCut = input.capturedHistoryCut === undefined
      ? undefined : historyCutSchema.parse(input.capturedHistoryCut);
    signal?.throwIfAborted();
    assertCompiledProfile(compiled, profile);
    try {
      assertRequestAccountingFits(compiled.accounting);
    } catch (cause) {
      throw new ContextAdmissionError(compiled, cause);
    }
    const logical = { ...compiled.logicalRequest };
    delete logical.signal;
    const sourceFingerprint = await this.sourceFingerprint(
      identity,
      input.operation,
      input.sourceRequest,
      input.stateSelectionId ?? null,
      capturedHistoryCut,
      input.outputReservation
    );
    const fingerprint = (
      await modelInputIdentity({
        identity,
        operation: input.operation,
        stateSelectionId: input.stateSelectionId ?? null,
        provider: this.options.provider.id,
        implementation: this.options.provider.implementationId,
        profile,
        inputIdentity: compiled.inputIdentity,
        accounting: compiled.accounting,
        sourceFingerprint,
        nativeDispatch: input.nativeDispatch ? nativeDispatchProvenance(input.nativeDispatch) : null
      })
    ).slice(7);
    let start: Extract<InferenceEvent, { type: 'inference.started' }>;
    for (;;) {
      signal?.throwIfAborted();
      const state = await repository.load(identity.ownerId, {
        invocationId: identity.invocationId
      });
      const existing = state.invocation;
      const limits = this.ownerBudget(state);
      const scope = this.budgetScope(state, identity, existing !== undefined);
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
      const reservation = inferenceReservation(compiled, profile, [limits, ...(scope ? [scope.budget] : [])]);
      assertAdmissionBudgets({ state, reservation, limits, identity, compiled, profile, ...(scope ? { scope } : {}) });
      const requestRef = await artifacts.storeProtected({
        label: `inference-${input.operation}-request`,
        mediaType: 'application/json',
        content: new TextEncoder().encode(
          JSON.stringify({
            invocationId: identity.invocationId,
            runId: identity.runId ?? null,
            ...(identity.participantId === undefined ? {} : { participantId: identity.participantId, budgetScopeId: identity.budgetScopeId }),
            ...(this.presentations.has(compiled)
              ? { presentation: this.presentations.get(compiled) }
              : {}),
            stateSelectionId: input.stateSelectionId ?? null,
            capturedHistoryCut,
            ...(input.nativeDispatch ? { nativeDispatch: nativeDispatchProvenance(input.nativeDispatch) } : {}),
            logical,
            sourceRequest: recordableSourceRequest(input.sourceRequest),
            profile,
            inputIdentity: compiled.inputIdentity,
            accounting: compiled.accounting,
            capabilityRevision: compiled.capabilityRevision,
            capabilities: capturedRequestCapabilities(compiled),
            operation: input.operation
          })
        )
      });
      signal?.throwIfAborted();
      const proposed: Extract<InferenceEvent, { type: 'inference.started' }> = {
        ...identity,
        runId: identity.runId ?? null,
        type: 'inference.started',
        format: 'agent-core.inference/2',
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
        : new RequestTokenEstimator().estimateText(JSON.stringify(value));
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
        await this.admit(compiled, profile);
        signal?.throwIfAborted();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        await this.cancelBeforeDispatch(identity, message);
        throw new InferenceNotSentError(identity.invocationId, message, { cause });
      }
    };
    let pending: Promise<T> | undefined;
    let authorityFailure: Error | undefined;
    const heldAuthority = async (operation: () => Promise<void>): Promise<void> => {
      if (!input.withDispatchAuthority) return operation();
      const lease: { active: boolean; called: boolean; violation?: Error } = { active: true, called: false };
      try {
        await input.withDispatchAuthority(() => {
          if (!lease.active || lease.called) {
            lease.violation = new Error(!lease.active ? 'Dispatch authority callback outlived its held lease.' : 'Dispatch authority callback must be invoked exactly once.');
            return Promise.reject(lease.violation);
          }
          lease.called = true;
          return operation();
        });
      } finally { lease.active = false; }
      if (lease.violation) throw lease.violation;
      if (!lease.called) throw new Error('Dispatch authority did not invoke its callback.');
    };
    const launch = () => {
      signal?.throwIfAborted();
      if (dispatchStarted) throw new Error('Inference transport was already launched.');
      dispatchStarted = true;
      try { pending = input.dispatch(); } catch (cause) { pending = Promise.reject(cause instanceof Error ? cause : new Error(String(cause))); }
      // Transport may reject before the held authority callback releases its locks.
      void pending.catch(() => undefined);
      return Promise.resolve(undefined);
    };
    const startDispatch = async () => {
      const presentation = this.presentationFor(compiled);
      const requiresGuard = (presentation?.materialDependencies?.length ?? 0) > 0 || (presentation?.skillReferences?.length ?? 0) > 0;
      try {
        // Host admission may read session state; complete it before acquiring source locks.
        // The held authority then validates exact dependencies again immediately before send.
        await authorize();
        if (requiresGuard && !input.withDispatchAuthority)
          throw new Error('Revocable request material requires a held dispatch authority.');
        // Check before issuing owning execution authority, then recheck after its asynchronous preparation.
        await heldAuthority(() => Promise.resolve());
        await input.startAuthority?.();
        await heldAuthority(launch);
      } catch (cause) {
        if (dispatchStarted) { authorityFailure = cause instanceof Error ? cause : new Error(String(cause)); return; }
        const message = cause instanceof Error ? cause.message : String(cause);
        await this.cancelBeforeDispatch(identity, message);
        throw new InferenceNotSentError(identity.invocationId, message, { cause });
      }
    };
    const operation = executeEffectLifecycle({ start: startDispatch, settle, uncertain }, () => {
      if (authorityFailure) return Promise.reject(authorityFailure);
      if (!pending) throw new Error('Inference dispatch did not launch.');
      return pending;
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
    !input.purpose.trim() ||
    ((input.participantId === undefined) !== (input.budgetScopeId === undefined)) ||
    (input.participantId !== undefined && !input.participantId.trim()) ||
    (input.budgetScopeId !== undefined && !input.budgetScopeId.trim())
  )
    throw new Error('Inference identity and purpose must be non-empty identifiers.');
  return Object.freeze({
    invocationId: input.invocationId,
    ownerId: input.ownerId,
    ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
    ...(input.budgetScopeId === undefined ? {} : { budgetScopeId: input.budgetScopeId }),
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
    compiled.logicalRequest.model !== profile.id ||
    compiled.provider !== profile.provider ||
    compiled.model !== profile.id ||
    compiled.capabilityRevision !== (profile.capabilities.protocol?.revision ?? 'conservative-v1')
  )
    throw new Error('Compiled inference changed the admitted model or capability revision.');
}
function inferenceReservation(
  compiled: CompiledModelRequest,
  profile: ModelProfile,
  budgets: readonly InferenceBudget[]
): InferenceReservation {
  const accounting = compiled.accounting;
  const needsInputBound = budgets.some(budget => requiresInputBound(compiled, profile, budget));
  const promptTokens = needsInputBound
    ? requestAccountingInputBound(accounting)
    : requestAccountingInputTokens(accounting);
  if (promptTokens === undefined)
    throw new Error(
      'Unquantified input under an explicit token or cost budget requires provider counting or a finite model input bound.'
    );
  const completionTokens =
    accounting.outputReservation +
    (accounting.pricingSemantics.reasoningIncludedInOutput === false
      ? accounting.reasoningReservation
      : 0);
  return {
    promptTokens,
    completionTokens,
    cost: calculateInferenceCost(
      { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      profile.pricing
    )
  };
}

function requiresInputBound(
  compiled: CompiledModelRequest,
  profile: ModelProfile,
  budget: InferenceBudget
): boolean {
  return (
    compiled.accounting.unknownComponents.length > 0 &&
    (budget.maxPromptTokens !== undefined ||
      (budget.maxKnownCost !== undefined && profile.pricing?.currency === budget.maxKnownCost.currency))
  );
}

interface AdmissionBudgetInput {
  readonly state: InferenceOwnerState;
  readonly reservation: InferenceReservation;
  readonly limits: InferenceBudget;
  readonly identity: InferenceIdentity;
  readonly compiled: CompiledModelRequest;
  readonly profile: ModelProfile;
  readonly replacing?: InferenceReservation;
  readonly scope?: InferenceBudgetScopeState;
}
/** Both checks use exactly the owner tail committed by the next start/extension CAS. */
function assertAdmissionBudgets(input: AdmissionBudgetInput): void {
  assertBudget(input);
  if (input.scope) assertBudget({ ...input,
    state: { ...input.state, committed: input.scope.committed, settledUsage: input.scope.settledUsage },
    limits: input.scope.budget, budgetScopeId: input.scope.scopeId
  });
}
function assertBudget(input: AdmissionBudgetInput & { readonly budgetScopeId?: string }): void {
  const { state, reservation: next, limits, identity, compiled, profile, replacing } = input;
  const currency = limits.maxKnownCost?.currency;
  const checks: readonly {
    resource: InferenceBudgetDiagnostic['resource'];
    limit: number | undefined;
    settled: number;
    committed: number;
    candidate: number;
    replacing: number;
    currency?: string;
  }[] = [
    {
      resource: 'invocations', limit: limits.maxInvocations,
      settled: state.settledUsage.invocations, committed: state.committed.invocations,
      candidate: 1, replacing: replacing === undefined ? 0 : 1
    },
    {
      resource: 'prompt_tokens', limit: limits.maxPromptTokens,
      settled: state.settledUsage.usage.promptTokens, committed: state.committed.usage.promptTokens,
      candidate: next.promptTokens, replacing: replacing?.promptTokens ?? 0
    },
    {
      resource: 'completion_tokens', limit: limits.maxCompletionTokens,
      settled: state.settledUsage.usage.completionTokens, committed: state.committed.usage.completionTokens,
      candidate: next.completionTokens, replacing: replacing?.completionTokens ?? 0
    },
    {
      resource: 'known_cost', limit: limits.maxKnownCost?.amount,
      settled: currency === undefined ? 0 : state.settledUsage.knownCosts[currency] ?? 0,
      committed: currency === undefined ? 0 : state.committed.knownCosts[currency] ?? 0,
      candidate: next.cost.currency === currency ? next.cost.amount ?? 0 : 0,
      replacing: replacing?.cost.currency === currency ? replacing?.cost.amount ?? 0 : 0,
      ...(currency === undefined ? {} : { currency })
    }
  ];
  for (const check of checks) {
    const projected = check.committed + check.candidate - check.replacing;
    if (check.limit === undefined || projected <= check.limit) continue;
    throw new InferenceBudgetExceededError({
      resource: check.resource,
      ...(input.budgetScopeId === undefined ? {} : { budgetScopeId: input.budgetScopeId }),
      ...(input.budgetScopeId === undefined || identity.participantId === undefined ? {} : { participantId: identity.participantId }),
      ownerId: identity.ownerId,
      invocationId: identity.invocationId,
      inputIdentity: compiled.inputIdentity,
      ledgerTail: state.tail,
      limit: check.limit,
      settled: check.settled,
      outstanding: check.committed - check.settled,
      candidate: check.candidate,
      replacing: check.replacing,
      projected,
      ...(check.currency === undefined ? {} : { currency: check.currency }),
      inputAccounting: {
        tokens: requestAccountingInputTokens(compiled.accounting),
        reservation: next.promptTokens,
        basis: requiresInputBound(compiled, profile, limits)
          ? 'model_input_bound'
          : 'compiled_accounting',
        unknownKinds: [...new Set(compiled.accounting.unknownComponents.map(part => part.kind))]
      }
    });
  }
}

function allowanceSnapshot(
  tail: EventLedgerTail,
  limits: InferenceBudget,
  committed: InferenceOwnerState['committed'],
  settled: InferenceOwnerState['settledUsage']
) {
  const outstanding = Object.freeze({
    invocations: committed.invocations - settled.invocations,
    promptTokens: committed.usage.promptTokens - settled.usage.promptTokens,
    completionTokens: committed.usage.completionTokens - settled.usage.completionTokens,
    unknownPricedTokens: committed.unknownPricedTokens - settled.unknownPricedTokens,
    knownCosts: Object.freeze(Object.fromEntries(Object.entries(committed.knownCosts)
      .map(([currency, amount]) => [currency, amount - (settled.knownCosts[currency] ?? 0)])))
  });
  return {
    ledgerTail: tail, limits, settled, outstanding,
    remaining: Object.freeze({
      ...(limits.maxInvocations === undefined ? {} : { invocations: Math.max(0, limits.maxInvocations - committed.invocations) }),
      ...(limits.maxPromptTokens === undefined ? {} : { promptTokens: Math.max(0, limits.maxPromptTokens - committed.usage.promptTokens) }),
      ...(limits.maxCompletionTokens === undefined ? {} : { completionTokens: Math.max(0, limits.maxCompletionTokens - committed.usage.completionTokens) }),
      ...(limits.maxKnownCost === undefined ? {} : { knownCost: Object.freeze({
        currency: limits.maxKnownCost.currency,
        amount: Math.max(0, limits.maxKnownCost.amount - (committed.knownCosts[limits.maxKnownCost.currency] ?? 0))
      }) })
    }),
    meaning: 'Remaining allowance subtracts settled usage and outstanding exposure. Missing limits are unbounded by this policy. Known cost excludes unpriced usage; it is not a hard monetary ceiling. Actual admission is transactional and may differ after this ledger cut.'
  };
}

function recordableSourceRequest(request: ModelRequest): Omit<ModelRequest, 'signal'> {
  const value = { ...createModelRequest(request) };
  delete value.signal;
  return value;
}

const nativeDispatchProvenanceSchema = z.strictObject({
  kind: z.enum(['steering', 'tool_results', 'continuation']),
  sourceCalls: z.array(z.strictObject({
    responseId: z.string().min(1), catalogIdentity: z.string().min(1), toolCallId: z.string().min(1)
  }))
});
function nativeDispatchProvenance(dispatch: ModelNativeDispatch) {
  return nativeDispatchProvenanceSchema.parse({ kind: dispatch.kind, sourceCalls: dispatch.sourceCalls });
}
