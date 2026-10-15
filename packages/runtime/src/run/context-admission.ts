import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import { historyCutSchema, sourceSchema } from '../history/schema.js';
import { parseJsonObject } from '@agent-core/json';

export type ContextAdmissionAction =
  'select_sources' | 'transition_context' | 'change_model' | 'reduce_reservation' | 'retry' | 'cancel';

/** An inference-boundary admission conflict; unavailable preparation does not prove overflow. */
interface ContextAdmissionMeasurements {
  readonly recoveryBoundary?: string;
  readonly recovery?: 'unsupported_action' | 'unchanged_action' | 'attempt_limit' | 'request_unavailable';
  readonly message: string;
  readonly inputIdentity?: string;
  readonly estimatedInputTokens?: number;
  readonly outputReservation?: number;
  readonly reasoningReservation?: number;
  readonly contextTokens?: number;
  readonly maxInputTokens?: number;
  readonly actions: readonly ContextAdmissionAction[];
}

export type ContextAdmissionConflict = ContextAdmissionMeasurements &
  (
    | Readonly<{ kind: 'request_capacity' }>
    | Readonly<{
        kind: 'request_preparation';
        inputIdentity?: never;
        estimatedInputTokens?: never;
        outputReservation?: never;
        reasoningReservation?: never;
        contextTokens?: never;
        maxInputTokens?: never;
      }>
    | Readonly<{ kind: 'native_continuity'; reason: 'automatic_disabled' | 'unsupported' | 'transform_failed' }>
    | Readonly<{ kind: 'provider_capacity'; inputIdentity: string }>
    | Readonly<{
        kind: 'source_capacity';
        cut: HistorySourceCut;
        bound: Readonly<{
          unit: 'bytes' | 'entries' | 'records';
          limit: number;
          observedAtLeast: number;
        }>;
        source?: HistorySourceRef;
        inputIdentity?: never;
        estimatedInputTokens?: never;
        outputReservation?: never;
        reasoningReservation?: never;
        contextTokens?: never;
        maxInputTokens?: never;
      }>
  );

/** Native prefix changes are recoverable conflicts, never permission to discard reasoning. */
export class ContextContinuityError extends Error {
  readonly conflict: ContextAdmissionConflict & { kind: 'native_continuity' };
  constructor(reason: 'automatic_disabled' | 'unsupported' | 'transform_failed', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextContinuityError';
    this.conflict = Object.freeze({
      kind: 'native_continuity', reason, message,
      actions: Object.freeze(['transition_context', 'change_model', 'cancel'] as const)
    });
  }
}

export class ContextSourceCapacityError extends Error {
  readonly conflict: ContextAdmissionConflict & { kind: 'source_capacity' };
  constructor(
    cut: HistorySourceCut,
    bound: { unit: 'bytes' | 'entries' | 'records'; limit: number; observedAtLeast: number },
    source?: HistorySourceRef
  ) {
    super(
      `Selected original context exceeds its ${String(bound.limit)} ${bound.unit} source bound. Select fewer original sources.`
    );
    this.name = 'ContextSourceCapacityError';
    this.conflict = Object.freeze({
      kind: 'source_capacity',
      message: this.message,
      cut,
      bound: Object.freeze(bound),
      ...(source ? { source } : {}),
      actions: Object.freeze(['select_sources', 'cancel'] as const)
    });
  }
}

export function decodeContextAdmissionConflict(value: unknown): ContextAdmissionConflict {
  const object = parseJsonObject(value, {
    maxDepth: 12,
    maxCollectionEntries: 10000,
    maxStringBytes: 8192,
    maxTotalBytes: 1024 * 1024
  });
  const fields = [
    'kind',
    'reason',
    'recovery',
    'recoveryBoundary',
    'cut',
    'bound',
    'source',
    'message',
    'inputIdentity',
    'estimatedInputTokens',
    'outputReservation',
    'reasoningReservation',
    'contextTokens',
    'maxInputTokens',
    'actions'
  ];
  if (Object.keys(object).some((key) => !fields.includes(key)))
    throw new TypeError('Incompatible context admission conflict fields.');
  if (object.recovery !== undefined && (typeof object.recovery !== 'string' || !['unsupported_action', 'unchanged_action', 'attempt_limit', 'request_unavailable'].includes(object.recovery)))
    throw new TypeError('Invalid context recovery status.');
  if (object.recoveryBoundary !== undefined && (typeof object.recoveryBoundary !== 'string' || !/^[a-f0-9]{64}$/u.test(object.recoveryBoundary)))
    throw new TypeError('Invalid context recovery boundary.');
  const recoveryBoundary = object.recoveryBoundary;
  const recovery = object.recovery as ContextAdmissionConflict['recovery'];
  if (typeof object.message !== 'string' || object.message.trim().length === 0)
    throw new TypeError('Context admission conflict requires a message.');
  if (
    object.inputIdentity !== undefined &&
    (typeof object.inputIdentity !== 'string' || object.inputIdentity.length === 0)
  )
    throw new TypeError('Context admission input identity is invalid.');
  const counts: {
    estimatedInputTokens?: number;
    outputReservation?: number;
    reasoningReservation?: number;
    contextTokens?: number;
    maxInputTokens?: number;
  } = {};
  for (const key of [
    'estimatedInputTokens',
    'outputReservation',
    'reasoningReservation',
    'contextTokens',
    'maxInputTokens'
  ] as const) {
    const count = object[key];
    if (count === undefined) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new TypeError(`Context admission ${key} is invalid.`);
    counts[key] = count;
  }
  if (!Array.isArray(object.actions) || object.actions.length === 0)
    throw new TypeError('Context admission requires available actions.');
  const actions = object.actions.map((action: unknown): ContextAdmissionAction => {
    if (
      action !== 'select_sources' &&
      action !== 'transition_context' &&
      action !== 'change_model' &&
      action !== 'reduce_reservation' &&
      action !== 'retry' &&
      action !== 'cancel'
    )
      throw new TypeError('Context admission action is invalid.');
    return action;
  });
  if (new Set(actions).size !== actions.length)
    throw new TypeError('Context admission actions must be unique.');
  if (object.kind === 'request_preparation') {
    if (recovery !== 'request_unavailable' || object.recoveryBoundary !== undefined ||
        object.reason !== undefined || object.cut !== undefined || object.bound !== undefined ||
        object.source !== undefined || object.inputIdentity !== undefined || Object.keys(counts).length ||
        !actions.includes('retry') ||
        actions.some(action => action !== 'retry' && action !== 'change_model' && action !== 'cancel'))
      throw new TypeError('Context admission preparation must describe unavailable preparation, not capacity or recovery authority.');
    return Object.freeze({
      kind: 'request_preparation', recovery, message: object.message, actions: Object.freeze(actions)
    });
  }
  if (actions.includes('retry'))
    throw new TypeError('Context admission retry requires unavailable request preparation.');
  if (object.kind === 'native_continuity') {
    if (typeof object.reason !== 'string' || !['automatic_disabled', 'unsupported', 'transform_failed'].includes(object.reason) ||
        object.cut !== undefined || object.bound !== undefined || object.source !== undefined)
      throw new TypeError('Invalid native continuity conflict.');
    return Object.freeze({
      kind: 'native_continuity',
      reason: object.reason as 'automatic_disabled' | 'unsupported' | 'transform_failed',
      message: object.message,
      ...(recovery ? { recovery } : {}),
      ...(recoveryBoundary ? { recoveryBoundary } : {}),
      ...(object.inputIdentity === undefined ? {} : { inputIdentity: object.inputIdentity }),
      ...counts,
      actions: Object.freeze(actions)
    });
  }
  if (object.reason !== undefined) throw new TypeError('Unexpected context conflict reason.');
  if (object.kind === 'source_capacity') {
    if (Object.keys(counts).length || object.inputIdentity !== undefined)
      throw new TypeError('Source capacity must not claim compiled request accounting.');
    const bound = parseJsonObject(object.bound);
    if (
      (bound.unit !== 'bytes' && bound.unit !== 'entries' && bound.unit !== 'records') ||
      typeof bound.limit !== 'number' ||
      !Number.isSafeInteger(bound.limit) ||
      bound.limit < 1 ||
      typeof bound.observedAtLeast !== 'number' ||
      !Number.isSafeInteger(bound.observedAtLeast) ||
      bound.observedAtLeast <= bound.limit ||
      Object.keys(bound).some((key) => !['unit', 'limit', 'observedAtLeast'].includes(key))
    )
      throw new TypeError('Invalid context source capacity bound.');
    return Object.freeze({
      kind: 'source_capacity',
      message: object.message,
      ...(recovery ? { recovery } : {}),
      ...(recoveryBoundary ? { recoveryBoundary } : {}),
      cut: historyCutSchema.parse(object.cut),
      bound: Object.freeze({
        unit: bound.unit,
        limit: bound.limit,
        observedAtLeast: bound.observedAtLeast
      }),
      ...(object.source === undefined ? {} : { source: sourceSchema.parse(object.source) }),
      actions: Object.freeze(actions)
    });
  }
  if (
    (object.kind !== 'request_capacity' && object.kind !== 'provider_capacity') ||
    object.cut !== undefined ||
    object.bound !== undefined ||
    object.source !== undefined
  )
    throw new TypeError('Incompatible context capacity conflict.');
  const requestConflict = {
    message: object.message,
    ...(recovery ? { recovery } : {}),
      ...(recoveryBoundary ? { recoveryBoundary } : {}),
    ...(object.inputIdentity === undefined ? {} : { inputIdentity: object.inputIdentity }),
    ...counts,
    actions: Object.freeze(actions)
  };
  if (object.kind === 'provider_capacity') {
    if (object.inputIdentity === undefined)
      throw new TypeError('Provider capacity rejection requires its compiled input identity.');
    return Object.freeze({ ...requestConflict, kind: 'provider_capacity', inputIdentity: object.inputIdentity });
  }
  return Object.freeze({ ...requestConflict, kind: 'request_capacity' });
}
