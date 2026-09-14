import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import { historyCutSchema, sourceSchema } from '../history/schema.js';
import { parseJsonObject } from '@agent-core/json';

export type ContextAdmissionAction =
  'select_sources' | 'change_model' | 'reduce_reservation' | 'cancel';

/** A fit conflict at an inference boundary; it grants no effect or retry authority. */
interface ContextAdmissionMeasurements {
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
      action !== 'change_model' &&
      action !== 'reduce_reservation' &&
      action !== 'cancel'
    )
      throw new TypeError('Context admission action is invalid.');
    return action;
  });
  if (new Set(actions).size !== actions.length)
    throw new TypeError('Context admission actions must be unique.');
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
    object.kind !== 'request_capacity' ||
    object.cut !== undefined ||
    object.bound !== undefined ||
    object.source !== undefined
  )
    throw new TypeError('Incompatible context capacity conflict.');
  return Object.freeze({
    kind: 'request_capacity',
    message: object.message,
    ...(object.inputIdentity === undefined ? {} : { inputIdentity: object.inputIdentity }),
    ...counts,
    actions: Object.freeze(actions)
  });
}
