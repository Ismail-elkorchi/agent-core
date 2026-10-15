import {
  requestAccountingInputTokens,
  type CompiledModelRequest,
  type ModelProfile,
  type ModelRequest,
  type RequestAccounting
} from '@agent-core/model';
import type { InferenceService } from './service.js';
import { hashJson } from '@agent-core/persistence';
import { NativeContextTransitionRequired, type RequestPresentation } from './input.js';
import {
  ModelRequestAssembler,
  type ModelRequestAssemblyInput
} from './model-request-assembler.js';

/** One captured logical request and provider compilation for generation and context changes. */
export class RequestAdmission {
  constructor(
    private readonly assembler: ModelRequestAssembler,
    private readonly inference: InferenceService
  ) {}

  async assemble(
    input: ModelRequestAssemblyInput,
    settings: Omit<ModelRequest, 'messages'>,
    outputReservation: number
  ) {
    const assembly = await this.assembler.assemble(input);
    if (
      assembly.continuationSource &&
      hashJson(settings.tools ?? []) !== hashJson(assembly.continuationSource.tools ?? [])
    )
      throw new NativeContextTransitionRequired(
        assembly.continuationSource,
        'The current tool catalog differs from the catalog bound to earlier reasoning.'
      );
    const request: ModelRequest = { ...settings, messages: assembly.messages };
    const compiled = await this.compile(request, input.modelProfile, outputReservation, assembly.presentation);
    return Object.freeze({ assembly, request, compiled });
  }

  compile(
    request: ModelRequest,
    profile: ModelProfile,
    outputReservation: number,
    presentation?: RequestPresentation
  ): Promise<CompiledModelRequest> {
    return this.inference.compile(request, profile, { outputReservation }, presentation);
  }

  /** Also admits adapter-compiled native successors without inventing an initial-request identity. */
  async admit(compiled: CompiledModelRequest, profile: ModelProfile): Promise<void> {
    await this.inference.admit(compiled, profile);
  }
}

export class ContextAdmissionError extends Error {
  readonly actions = Object.freeze([
    'select_sources',
    'reduce_reservation',
    'change_model',
    'cancel'
  ] as const);
  constructor(
    readonly compiled: CompiledModelRequest,
    cause: unknown,
    readonly providerRejected = false,
    readonly continuityHeadroomTokens?: number
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ContextAdmissionError';
  }
}

/** Capacity and headroom describe the same compiled admission boundary. */
export function requestCapacity(accounting: RequestAccounting, headroom?: number) {
  const inputTokens = requestAccountingInputTokens(accounting);
  const reasoningReservation =
    accounting.pricingSemantics.reasoningIncludedInOutput === false
      ? accounting.reasoningReservation
      : 0;
  const inputLimits = [
    accounting.limits.maxInputTokens,
    accounting.limits.contextTokens === undefined
      ? undefined
      : accounting.limits.contextTokens - accounting.outputReservation - reasoningReservation
  ].filter((value): value is number => value !== undefined);
  const inputCapacity = inputLimits.length ? Math.max(0, Math.min(...inputLimits)) : undefined;
  const remainingTokens =
    inputCapacity === undefined
      ? undefined
      : Math.max(0, inputCapacity - inputTokens);
  const requestedHeadroom = headroom ?? accounting.outputReservation + reasoningReservation;
  if (!Number.isSafeInteger(requestedHeadroom) || requestedHeadroom < 0)
    throw new Error('Continuity headroom must be a nonnegative token count.');
  // Without automatic control recovery, output-sized headroom is advisory. An
  // explicit reserve is the actual compiled control allowance enforced by Core.
  const continuityHeadroomTokens = headroom ?? Math.min(
    requestedHeadroom,
    inputCapacity === undefined ? requestedHeadroom : Math.floor(inputCapacity / 2)
  );
  return Object.freeze({
    inputTokens,
    ...(inputCapacity === undefined ? {} : { inputCapacity }),
    ...(remainingTokens === undefined ? {} : { remainingTokens }),
    outputReservation: accounting.outputReservation,
    reasoningReservation,
    continuityHeadroomTokens,
    continuityHeadroomPolicy: headroom === undefined ? 'advisory' as const : 'required' as const,
    ...(remainingTokens === undefined
      ? {}
      : { ordinaryRemainingTokens: Math.max(0, remainingTokens - continuityHeadroomTokens) }),
    pressure:
      remainingTokens === undefined
        ? ('unknown' as const)
        : remainingTokens <= continuityHeadroomTokens
          ? ('continuity' as const)
          : ('normal' as const),
    method: accounting.method,
    unknownComponents: accounting.unknownComponents
  });
}
