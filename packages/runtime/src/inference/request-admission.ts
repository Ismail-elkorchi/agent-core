import {
  requestAccountingInputTokens,
  type CompiledModelRequest,
  type ModelProfile,
  type ModelRequest,
  type RequestAccounting
} from '@agent-core/model';
import type { InferenceService } from './service.js';
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
    const request: ModelRequest = { ...settings, messages: assembly.messages };
    const compiled = await this.inference.compile(request, input.modelProfile, {
      outputReservation
    });
    return Object.freeze({ assembly, request, compiled });
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
    readonly providerRejected = false
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ContextAdmissionError';
  }
}

/** Capacity is a view of compiled accounting; continuity headroom is a soft reserve. */
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
  // Continuity is a soft reserve, not another output reservation. Leave at least
  // half the admitted input capacity for ordinary work, even with large outputs.
  const continuityHeadroomTokens = Math.min(
    requestedHeadroom,
    inputCapacity === undefined ? requestedHeadroom : Math.floor(inputCapacity / 2)
  );
  return Object.freeze({
    inputTokens,
    ...(remainingTokens === undefined ? {} : { remainingTokens }),
    outputReservation: accounting.outputReservation,
    reasoningReservation,
    continuityHeadroomTokens,
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
