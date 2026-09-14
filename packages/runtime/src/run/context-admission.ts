import { parseJsonObject } from '@agent-core/json';

export type ContextAdmissionAction =
  'select_sources' | 'change_model' | 'reduce_reservation' | 'cancel';

/** A fit conflict at an inference boundary; it grants no effect or retry authority. */
export interface ContextAdmissionConflict {
  readonly message: string;
  readonly inputIdentity?: string;
  readonly estimatedInputTokens?: number;
  readonly outputReservation?: number;
  readonly reasoningReservation?: number;
  readonly contextTokens?: number;
  readonly maxInputTokens?: number;
  readonly actions: readonly ContextAdmissionAction[];
}

export function decodeContextAdmissionConflict(value: unknown): ContextAdmissionConflict {
  const object = parseJsonObject(value, {
    maxDepth: 3,
    maxCollectionEntries: 32,
    maxStringBytes: 8192,
    maxTotalBytes: 16384
  });
  const fields = [
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
  return Object.freeze({
    message: object.message,
    ...(object.inputIdentity === undefined ? {} : { inputIdentity: object.inputIdentity }),
    ...counts,
    actions: Object.freeze(actions)
  });
}
