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
  readonly runId?: string;
  readonly parentInvocationId?: string;
  readonly purpose: string;
}
export type InferenceEvent =
  | (Omit<InferenceIdentity, 'runId'> & {
      readonly runId: string | null;
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
      readonly type: 'inference.rejected';
      readonly invocationId: string;
      readonly permit: string;
      readonly code: 'context_overflow';
      readonly inputIdentity: string;
      readonly message: string;
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
      'runId',
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
      throw new Error(
        'Incompatible inference format; start a new owner without deleting prior state.'
      );
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
      runId:
        event.runId === null
          ? null
          : text(
              event.runId,
              'runId (required; obsolete inference records need their original application)'
            ),
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
    exact(event, [
      'type',
      'invocationId',
      'permit',
      'revision',
      'fingerprint',
      'requestRef',
      'reservation'
    ]);
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
  if (event.type === 'inference.rejected') {
    exact(event, ['type', 'invocationId', 'permit', 'code', 'inputIdentity', 'message']);
    if (event.code !== 'context_overflow') throw new Error('Invalid inference rejection.');
    return Object.freeze({
      type: 'inference.rejected',
      invocationId,
      permit,
      code: event.code,
      inputIdentity: text(event.inputIdentity, 'inputIdentity'),
      message: text(event.message, 'message')
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
    ...(limits.maxInvocations === undefined
      ? {}
      : { maxInvocations: count(limits.maxInvocations) }),
    ...(limits.maxPromptTokens === undefined
      ? {}
      : { maxPromptTokens: count(limits.maxPromptTokens) }),
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
export interface InferenceInvocation {
  readonly start: Extract<InferenceEvent, { type: 'inference.started' }>;
  readonly extension?: Extract<InferenceEvent, { type: 'inference.extended' }>;
  readonly settlement?: Extract<InferenceEvent, { type: 'inference.settled' }>;
  readonly rejected?: Extract<InferenceEvent, { type: 'inference.rejected' }>;
  readonly notSent?: Extract<InferenceEvent, { type: 'inference.not_sent' }>;
  readonly uncertain?: Extract<InferenceEvent, { type: 'inference.uncertain' }>;
}
export interface InferenceUsageTotals {
  readonly invocations: number;
  readonly usage: Required<ModelUsage>;
  readonly knownCosts: Readonly<Record<string, number>>;
  readonly unknownPricedTokens: number;
}
export interface InferenceOwnerState {
  readonly tail: EventLedgerTail;
  readonly policyFingerprint?: string;
  /** Settled consumption plus outstanding reservations. */
  readonly committed: InferenceUsageTotals;
  readonly invocation?: InferenceInvocation;
  readonly settledUsage: InferenceUsageTotals;
}
export interface InferenceRepository {
  load(
    ownerId: string,
    query?: { readonly invocationId?: string; readonly runId?: string }
  ): Promise<InferenceOwnerState>;
  append(ownerId: string, event: InferenceEvent, tail: EventLedgerTail): Promise<boolean>;
}
interface OwnerIndex {
  tail: EventLedgerTail;
  policyFingerprint?: string;
  committed: InferenceUsageTotals;
  settled: InferenceUsageTotals;
  readonly invocations: Map<string, InferenceInvocation>;
  readonly runs: Map<string, InferenceUsageTotals>;
}
export class EventInferenceRepository implements InferenceRepository {
  private readonly owners = new Map<string, OwnerIndex>();
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    readonly events: Pick<
      EventRepository<InferenceEvent>,
      'tail' | 'readRange' | 'appendConditional'
    >
  ) {}

  load(
    ownerId: string,
    query: { readonly invocationId?: string; readonly runId?: string } = {}
  ): Promise<InferenceOwnerState> {
    const previous = this.pending.get(ownerId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.read(ownerId, query));
    this.pending.set(ownerId, task);
    void task
      .finally(() => {
        if (this.pending.get(ownerId) === task) this.pending.delete(ownerId);
      })
      .catch(() => undefined);
    return task;
  }

  private async read(
    ownerId: string,
    query: { readonly invocationId?: string; readonly runId?: string }
  ): Promise<InferenceOwnerState> {
    const key = ownerKey(ownerId);
    const tail = await this.events.tail(key);
    const index: OwnerIndex = this.owners.get(ownerId) ?? {
      tail: { sequence: -1, driverGeneration: 0 },
      committed: emptyInferenceUsage(),
      settled: emptyInferenceUsage(),
      invocations: new Map(),
      runs: new Map()
    };
    if (
      tail.sequence < index.tail.sequence ||
      (tail.sequence === index.tail.sequence && tail.hash !== index.tail.hash)
    )
      throw new Error('Inference history changed behind its verified boundary.');
    try {
      while (index.tail.sequence < tail.sequence) {
        const page = await this.events.readRange(key, {
          afterSequence: index.tail.sequence,
          through: tail,
          limit: 256
        });
        if (page.oversized || page.nextSequence <= index.tail.sequence)
          throw new Error('Inference index could not advance through its ledger boundary.');
        for (const record of page.records) this.apply(index, ownerId, record.event);
        const last = page.records.at(-1);
        if (!last) throw new Error('Inference ledger advanced without accounting records.');
        index.tail = {
          sequence: page.nextSequence,
          driverGeneration: tail.driverGeneration,
          hash: last.hash
        };
      }
      index.tail = tail;
      this.owners.delete(ownerId);
      this.owners.set(ownerId, index);
      for (const id of this.owners.keys()) {
        if (this.owners.size <= 8) break;
        this.owners.delete(id);
      }
    } catch (error) {
      this.owners.delete(ownerId);
      throw error;
    }
    const invocation =
      query.invocationId === undefined ? undefined : index.invocations.get(query.invocationId);
    return Object.freeze({
      tail,
      ...(index.policyFingerprint ? { policyFingerprint: index.policyFingerprint } : {}),
      committed: index.committed,
      ...(invocation ? { invocation } : {}),
      settledUsage:
        query.runId === undefined
          ? index.settled
          : (index.runs.get(query.runId) ?? emptyInferenceUsage())
    });
  }

  private apply(index: OwnerIndex, ownerId: string, event: InferenceEvent): void {
    const prior = index.invocations.get(event.invocationId);
    let next: InferenceInvocation;
    if (event.type === 'inference.started') {
      const policy = hashJson(event.limits);
      if (
        event.ownerId !== ownerId ||
        prior ||
        (index.policyFingerprint !== undefined && index.policyFingerprint !== policy)
      )
        throw new Error('Contradictory inference admission or owner policy.');
      index.policyFingerprint = policy;
      next = Object.freeze({ start: event });
    } else {
      if (
        prior?.start.permit !== event.permit ||
        prior.settlement ||
        prior.notSent ||
        prior.rejected
      )
        throw new Error('Contradictory inference settlement permit.');
      if (event.type === 'inference.extended') {
        if (
          prior.start.operation !== 'native_generation' ||
          prior.uncertain ||
          event.revision !== (prior.extension?.revision ?? 0) + 1
        )
          throw new Error('Contradictory native inference input extension.');
        next = Object.freeze({ ...prior, extension: event });
      } else if (event.type === 'inference.rejected') {
        if (prior.uncertain)
          throw new Error('A context rejection cannot override an uncertain dispatch.');
        next = Object.freeze({ ...prior, rejected: event });
      } else if (event.type === 'inference.not_sent') {
        if (prior.uncertain)
          throw new Error('An uncertain dispatch cannot be released without evidence.');
        next = Object.freeze({ ...prior, notSent: event });
      } else if (event.type === 'inference.settled') {
        next = Object.freeze({ ...prior, settlement: event });
        index.settled = addInferenceUsage(index.settled, event.usage, event.cost, 1);
        if (prior.start.runId !== null)
          index.runs.set(
            prior.start.runId,
            addInferenceUsage(
              index.runs.get(prior.start.runId) ?? emptyInferenceUsage(),
              event.usage,
              event.cost,
              1
            )
          );
      } else next = Object.freeze({ ...prior, uncertain: event });
    }
    if (prior && !prior.notSent) index.committed = accountInvocation(index.committed, prior, -1);
    if (!next.notSent) index.committed = accountInvocation(index.committed, next, 1);
    index.invocations.set(event.invocationId, next);
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

export function emptyInferenceUsage(): InferenceUsageTotals {
  return Object.freeze({
    invocations: 0,
    usage: Object.freeze({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    }),
    knownCosts: Object.freeze({}),
    unknownPricedTokens: 0
  });
}
function accountInvocation(
  total: InferenceUsageTotals,
  invocation: InferenceInvocation,
  direction: 1 | -1
): InferenceUsageTotals {
  const reservation = invocation.extension?.reservation ?? invocation.start.reservation;
  return addInferenceUsage(
    total,
    invocation.settlement?.usage ?? {
      promptTokens: reservation.promptTokens,
      completionTokens: reservation.completionTokens,
      totalTokens: reservation.promptTokens + reservation.completionTokens
    },
    invocation.settlement?.cost ?? reservation.cost,
    direction
  );
}
function addInferenceUsage(
  total: InferenceUsageTotals,
  usage: ModelUsage,
  cost: InferenceCost,
  direction: 1 | -1
): InferenceUsageTotals {
  const knownCosts = { ...total.knownCosts };
  if (cost.currency !== undefined && cost.amount !== undefined)
    knownCosts[cost.currency] = (knownCosts[cost.currency] ?? 0) + direction * cost.amount;
  return Object.freeze({
    invocations: total.invocations + direction,
    usage: Object.freeze({
      promptTokens: total.usage.promptTokens + direction * usage.promptTokens,
      completionTokens: total.usage.completionTokens + direction * usage.completionTokens,
      totalTokens: total.usage.totalTokens + direction * usage.totalTokens,
      cacheReadTokens: total.usage.cacheReadTokens + direction * (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: total.usage.cacheWriteTokens + direction * (usage.cacheWriteTokens ?? 0),
      reasoningTokens: total.usage.reasoningTokens + direction * (usage.reasoningTokens ?? 0)
    }),
    knownCosts: Object.freeze(knownCosts),
    unknownPricedTokens: total.unknownPricedTokens + direction * cost.unknownTokens
  });
}
