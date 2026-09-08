import type { InferenceCost } from './usage-cost.js';
import {
  InMemoryEventRepository,
  hashJson,
  decodeOwnedArtifactRef,
  type EventRepository,
  type ArtifactRef,
  type EventLedgerTail,
  type RuntimeCodec
} from '@agent-core/persistence';
import { parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';
import { parseModelUsage, type ModelUsage } from '@agent-core/model';

export interface InferenceBudget {
  readonly maxInvocations?: number;
  readonly maxKnownCost?: {
    readonly amount: number;
    readonly currency: string;
  };
  readonly maxPromptTokens?: number;
  readonly maxCompletionTokens?: number;
}
export interface InferenceReservation {
  readonly cost: InferenceCost;
  readonly promptTokens: number;
  readonly completionTokens: number;
}
export interface InferenceIdentity {
  readonly invocationId: string;
  readonly ownerId: string;
  readonly parentInvocationId?: string;
  readonly purpose: string;
}
export type InferenceEvent =
  | (InferenceIdentity & {
      readonly type: 'inference.started';
      readonly format: 'agent-core.inference/1';
      readonly operation: 'generation' | 'context_transform' | 'native_generation';
      readonly fingerprint: string;
      readonly sourceFingerprint: string;
      readonly requestRef: ArtifactRef;
      readonly reservation: InferenceReservation;
      readonly limits: InferenceBudget;
      readonly permit: string;
    })
  | {
      readonly type: 'inference.extended';
      readonly invocationId: string;
      readonly permit: string;
      readonly revision: number;
      readonly fingerprint: string;
      readonly requestRef: ArtifactRef;
      readonly reservation: InferenceReservation;
    }
  | {
      readonly type: 'inference.settled';
      readonly invocationId: string;
      readonly permit: string;
      readonly resultRef: ArtifactRef;
      readonly usage: ModelUsage;
      readonly usageSource: 'provider' | 'estimate';
      readonly cost: InferenceCost;
    }
  | {
      readonly type: 'inference.not_sent';
      readonly invocationId: string;
      readonly permit: string;
      readonly message: string;
    }
  | {
      readonly type: 'inference.uncertain';
      readonly invocationId: string;
      readonly permit: string;
      readonly message: string;
    };

export const inferenceEventCodec: RuntimeCodec<InferenceEvent> = {
  encode: (event) => parseJsonObject(decodeInferenceEvent(event)),
  decode: decodeInferenceEvent
};
function decodeInferenceEvent(value: unknown): InferenceEvent {
  const event = parseJsonObject(value);
  const invocationId = text(event.invocationId, 'invocationId');
  const permit = text(event.permit, 'permit');
  if (event.type === 'inference.started') {
    exact(event, [
      'type',
      'format',
      'operation',
      'invocationId',
      'ownerId',
      'parentInvocationId',
      'purpose',
      'fingerprint',
      'sourceFingerprint',
      'requestRef',
      'reservation',
      'limits',
      'permit'
    ]);
    if (event.format !== 'agent-core.inference/1')
      throw new Error('Incompatible inference format; start a new owner without deleting prior state.');
    const reservation = parseJsonObject(event.reservation);
    exact(reservation, ['promptTokens', 'completionTokens', 'cost']);
    const limits = parseJsonObject(event.limits);
    exact(limits, ['maxInvocations', 'maxPromptTokens', 'maxCompletionTokens', 'maxKnownCost']);
    if (
      event.operation !== 'generation' &&
      event.operation !== 'context_transform' &&
      event.operation !== 'native_generation'
    )
      throw new Error('Invalid inference operation.');
    return Object.freeze({
      type: 'inference.started',
      format: 'agent-core.inference/1',
      operation: event.operation,
      invocationId,
      permit,
      ownerId: text(event.ownerId, 'ownerId'),
      purpose: text(event.purpose, 'purpose'),
      fingerprint: text(event.fingerprint, 'fingerprint'),
      sourceFingerprint: text(event.sourceFingerprint, 'sourceFingerprint'),
      ...(event.parentInvocationId === undefined
        ? {}
        : {
            parentInvocationId: text(event.parentInvocationId, 'parentInvocationId')
          }),
      requestRef: decodeOwnedArtifactRef(parseJsonObject(event.requestRef)),
      reservation: Object.freeze({
        cost: decodeCost(reservation.cost),
        promptTokens: count(reservation.promptTokens),
        completionTokens: count(reservation.completionTokens)
      }),
      limits: parseInferenceBudget(limits)
    });
  }
  if (event.type === 'inference.extended') {
    exact(event, ['type', 'invocationId', 'permit', 'revision', 'fingerprint', 'requestRef', 'reservation']);
    const reservation = parseJsonObject(event.reservation);
    exact(reservation, ['promptTokens', 'completionTokens', 'cost']);
    return Object.freeze({
      type: 'inference.extended',
      invocationId,
      permit,
      revision: count(event.revision),
      fingerprint: text(event.fingerprint, 'fingerprint'),
      requestRef: decodeOwnedArtifactRef(parseJsonObject(event.requestRef)),
      reservation: Object.freeze({
        promptTokens: count(reservation.promptTokens),
        completionTokens: count(reservation.completionTokens),
        cost: decodeCost(reservation.cost)
      })
    });
  }
  if (event.type === 'inference.settled') {
    exact(event, ['type', 'invocationId', 'permit', 'resultRef', 'usage', 'usageSource', 'cost']);
    if (event.usageSource !== 'provider' && event.usageSource !== 'estimate')
      throw new Error('Invalid inference usage source.');
    const usage = parseModelUsage(event.usage);
    return Object.freeze({
      type: 'inference.settled',
      invocationId,
      permit,
      resultRef: decodeOwnedArtifactRef(parseJsonObject(event.resultRef)),
      usage,
      usageSource: event.usageSource,
      cost: decodeCost(event.cost)
    });
  }
  if (event.type === 'inference.not_sent') {
    exact(event, ['type', 'invocationId', 'permit', 'message']);
    return Object.freeze({
      type: 'inference.not_sent',
      invocationId,
      permit,
      message: text(event.message, 'message')
    });
  }
  if (event.type === 'inference.uncertain') {
    exact(event, ['type', 'invocationId', 'permit', 'message']);
    return Object.freeze({
      type: 'inference.uncertain',
      invocationId,
      permit,
      message: text(event.message, 'message')
    });
  }
  throw new Error('Invalid inference event kind.');
}
export function parseInferenceBudget(value: unknown): InferenceBudget {
  const limits = parseJsonObject(value);
  exact(limits, ['maxInvocations', 'maxPromptTokens', 'maxCompletionTokens', 'maxKnownCost']);
  return Object.freeze({
    ...(limits.maxInvocations === undefined ? {} : { maxInvocations: count(limits.maxInvocations) }),
    ...(limits.maxPromptTokens === undefined ? {} : { maxPromptTokens: count(limits.maxPromptTokens) }),
    ...(limits.maxCompletionTokens === undefined
      ? {}
      : { maxCompletionTokens: count(limits.maxCompletionTokens) }),
    ...(limits.maxKnownCost === undefined ? {} : { maxKnownCost: decodeMoney(limits.maxKnownCost) })
  });
}
function decodeMoney(value: JsonValue | undefined): {
  readonly amount: number;
  readonly currency: string;
} {
  const object = parseJsonObject(value);
  exact(object, ['amount', 'currency']);
  return Object.freeze({
    amount: amount(object.amount),
    currency: text(object.currency, 'currency')
  });
}
function amount(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid inference monetary amount.');
  return value;
}
function decodeCost(value: JsonValue | undefined): InferenceCost {
  const object = parseJsonObject(value);
  exact(object, ['status', 'amount', 'currency', 'unknownTokens']);
  if (object.status !== 'known' && object.status !== 'partial' && object.status !== 'unknown')
    throw new Error('Invalid inference cost status.');
  if ((object.amount === undefined) !== (object.currency === undefined))
    throw new Error('Incomplete inference known cost.');
  const unknownTokens = count(object.unknownTokens);
  if (
    (object.status === 'known' && unknownTokens !== 0) ||
    (object.status === 'partial' && (unknownTokens === 0 || object.amount === undefined)) ||
    (object.status === 'unknown' && (unknownTokens === 0 || object.amount !== undefined))
  )
    throw new Error('Inconsistent inference cost.');
  return Object.freeze({
    status: object.status,
    unknownTokens,
    ...(object.amount === undefined
      ? {}
      : {
          amount: amount(object.amount),
          currency: text(object.currency, 'currency')
        })
  });
}
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unsupported inference event fields.');
}
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid inference ${label}.`);
  return value;
}
function count(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid inference token count.');
  return value;
}
export interface InferenceOwnerState {
  readonly tail: EventLedgerTail;
  readonly invocations: ReadonlyMap<
    string,
    {
      readonly start: Extract<InferenceEvent, { type: 'inference.started' }>;
      readonly extensions: readonly Extract<InferenceEvent, { type: 'inference.extended' }>[];
      readonly settlement?: Extract<InferenceEvent, { type: 'inference.settled' }>;
      readonly notSent?: Extract<InferenceEvent, { type: 'inference.not_sent' }>;
      readonly uncertain?: Extract<InferenceEvent, { type: 'inference.uncertain' }>;
    }
  >;
}
export interface InferenceRepository {
  load(ownerId: string): Promise<InferenceOwnerState>;
  append(ownerId: string, event: InferenceEvent, tail: EventLedgerTail): Promise<boolean>;
}
export class EventInferenceRepository implements InferenceRepository {
  constructor(readonly events: Pick<EventRepository<InferenceEvent>, 'read' | 'appendConditional'>) {}
  async load(ownerId: string): Promise<InferenceOwnerState> {
    const invocations = new Map<
      string,
      {
        start: Extract<InferenceEvent, { type: 'inference.started' }>;
        extensions: Extract<InferenceEvent, { type: 'inference.extended' }>[];
        settlement?: Extract<InferenceEvent, { type: 'inference.settled' }>;
        notSent?: Extract<InferenceEvent, { type: 'inference.not_sent' }>;
        uncertain?: Extract<InferenceEvent, { type: 'inference.uncertain' }>;
      }
    >();
    let tail: EventLedgerTail = { sequence: -1, driverGeneration: 0 };
    for await (const record of this.events.read(ownerKey(ownerId))) {
      tail = {
        sequence: record.sequence,
        hash: record.hash,
        driverGeneration: record.driverGeneration
      };
      const event = record.event;
      if (event.type === 'inference.started') {
        if (event.ownerId !== ownerId || invocations.has(event.invocationId))
          throw new Error('Contradictory inference admission.');
        invocations.set(event.invocationId, { start: event, extensions: [] });
      } else {
        const prior = invocations.get(event.invocationId);
        if (prior?.start.permit !== event.permit || prior.settlement || prior.notSent)
          throw new Error('Contradictory inference settlement permit.');
        if (event.type === 'inference.extended') {
          if (
            prior.start.operation !== 'native_generation' ||
            prior.uncertain ||
            event.revision !== prior.extensions.length + 1
          )
            throw new Error('Contradictory native inference input extension.');
          prior.extensions.push(event);
        } else if (event.type === 'inference.settled') prior.settlement = event;
        else if (event.type === 'inference.not_sent') {
          if (prior.uncertain) throw new Error('An uncertain dispatch cannot be released without evidence.');
          prior.notSent = event;
        } else prior.uncertain = event;
      }
    }
    return { tail, invocations };
  }
  async append(ownerId: string, event: InferenceEvent, tail: EventLedgerTail): Promise<boolean> {
    const result = await this.events.appendConditional(ownerKey(ownerId), event, {
      expectedTail: tail,
      driverGeneration: tail.driverGeneration,
      idempotencyKey: `${event.invocationId}:${event.type}${event.type === 'inference.extended' ? `:${String(event.revision)}` : ''}`,
      actor: 'runtime'
    });
    if (
      result.kind === 'committed' ||
      result.kind === 'already_committed' ||
      result.kind === 'committed_index_unknown'
    )
      return true;
    if (result.kind === 'rejected' && result.reason === 'stale_tail') return false;
    throw new Error(`Inference durability failed: ${result.kind}.`);
  }
}
export class InMemoryInferenceRepository extends EventInferenceRepository {
  constructor() {
    super(new InMemoryEventRepository(inferenceEventCodec));
  }
}
function ownerKey(ownerId: string): string {
  if (ownerId.trim().length === 0) throw new Error('Inference ownerId must be non-empty.');
  return `inference-${hashJson(ownerId)}`;
}
