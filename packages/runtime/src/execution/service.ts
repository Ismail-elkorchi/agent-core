import {
  closeExternalEffect,
  decodeEffectExecutionState,
  decodeExternalEffectIntent,
  encodeEffectExecutionState,
  executeEffectLifecycle,
  issueEffectStartTicket,
  settleExternalEffect,
  startExternalEffect,
  type EffectExecutionState,
  type EffectExposureSettlement,
  type ExternalEffectIntent,
  type ExternalEffectSettlement
} from '@agent-core/effects';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  hashJson,
  PersistenceConflictError,
  type EventEnvelope,
  type EventLedgerTail,
  type EventRepository,
  type RuntimeCodec
} from '@agent-core/persistence';
import { randomUUID } from 'node:crypto';

export type EffectExecutionEvent = {
  readonly type: 'execution.state.changed';
} & (
  | {
      readonly state: Exclude<EffectExecutionState, { readonly phase: 'settled' }>;
      readonly observation?: never;
    }
  | {
      readonly state: Extract<EffectExecutionState, { readonly phase: 'settled' }> & {
        readonly settlement: Exclude<ExternalEffectSettlement, { readonly outcome: 'unknown' }>;
      };
      readonly observation: JsonObject;
    }
);

export interface AdmittedEffect<T> {
  readonly intent: ExternalEffectIntent;
  readonly codec: RuntimeCodec<T>;
  readonly exposure: (observation: T) => EffectExposureSettlement;
  start(signal: AbortSignal): Promise<T>;
  reconcile(
    signal: AbortSignal
  ): Promise<
    | { readonly status: 'settled'; readonly observation: T }
    | { readonly status: 'running' | 'unknown' | 'expired' }
  >;
}

export type EffectExecutionResult<T> =
  | { readonly status: 'settled'; readonly observation: T; readonly replayed: boolean }
  | { readonly status: 'running' | 'unknown' | 'expired' | 'cancelled_before_start' };

export const effectExecutionEventCodec: RuntimeCodec<EffectExecutionEvent> = {
  encode: (event) =>
    parseJsonObject({
      type: event.type,
      state: encodeEffectExecutionState(event.state),
      ...(event.observation === undefined ? {} : { observation: event.observation })
    }),
  decode(value) {
    const event = parseJsonObject(value);
    if (
      event.type !== 'execution.state.changed' ||
      Object.keys(event).some((key) => !['type', 'state', 'observation'].includes(key))
    )
      throw new TypeError('Incompatible effect execution record.');
    const state = decodeEffectExecutionState(event.state);
    const observation = event.observation === undefined ? undefined : parseJsonObject(event.observation);
    if (state.phase === 'settled') {
      const settlement = state.settlement;
      if (
        settlement.outcome === 'unknown' ||
        observation === undefined ||
        hashJson(observation) !== settlement.resultDigest
      )
        throw new TypeError('Effect observation does not match its settlement.');
      return Object.freeze({
        type: 'execution.state.changed',
        state: Object.freeze({ ...state, settlement }),
        observation
      });
    }
    if (observation !== undefined) throw new TypeError('An unsettled effect cannot own an observation.');
    return Object.freeze({
      type: 'execution.state.changed',
      state
    });
  }
};

/** Runs admitted application effects using the same tickets, permits and dispatch lifecycle as tools and inference. */
export class EffectExecutor {
  constructor(private readonly events: EventRepository<EffectExecutionEvent>) {}

  async execute<T>(
    effect: AdmittedEffect<T>,
    signal = new AbortController().signal
  ): Promise<EffectExecutionResult<T>> {
    const intent = decodeExternalEffectIntent(effect.intent);
    const streamId = intent.effectId;
    const latest = await this.events.latest(streamId);
    if (latest) {
      this.assertIntent(latest.event.state.intent, intent);
      const recorded = this.recorded(effect, latest.event);
      if (recorded) return recorded;
      if (latest.event.state.phase === 'started') return this.reconcile(effect, latest.event.state, signal);
    }
    signal.throwIfAborted();
    const tail = latest ? envelopeTail(latest) : { sequence: -1, driverGeneration: 0 };
    const generation = tail.driverGeneration + 1;
    const issued = issueEffectStartTicket({
      intent,
      ticketId: randomUUID(),
      settlementPermitId: randomUUID(),
      driverGeneration: generation,
      currentDriverGeneration: generation
    });
    if (issued.status !== 'issued') throw new Error('Effect driver could not issue a start ticket.');
    // A competing attach changes the tail; it cannot authorize a second dispatch.
    let current = await this.commit(
      streamId,
      { type: 'execution.state.changed', state: issued.state },
      tail,
      generation
    );
    return executeEffectLifecycle<EffectExecutionResult<T>, T>(
      {
        start: async () => {
          if (signal.aborted) {
            await this.commit(
              streamId,
              {
                type: 'execution.state.changed',
                state: closeExternalEffect(issued.state, 'cancelled_before_start')
              },
              current,
              generation
            );
            signal.throwIfAborted();
          }
          const started = startExternalEffect(issued.state, issued.state.ticket, generation);
          if (started.status !== 'started') throw new Error(`Effect start rejected: ${started.reason}.`);
          current = await this.commit(
            streamId,
            { type: 'execution.state.changed', state: started.state },
            current,
            generation
          );
        },
        settle: (observation) => this.settle(effect, issued.state, observation, false),
        // A lost response stays reconcilable. It is never rewritten as a failed or unstarted effect.
        uncertain: () => Promise.resolve({ status: 'unknown' })
      },
      () => effect.start(signal)
    );
  }

  private async reconcile<T>(
    effect: AdmittedEffect<T>,
    state: EffectExecutionState,
    signal: AbortSignal
  ): Promise<EffectExecutionResult<T>> {
    signal.throwIfAborted();
    const recovery = state.intent.recovery;
    if (recovery.kind === 'unknown') return { status: 'unknown' };
    if (
      (recovery.kind === 'queryable' || recovery.kind === 'idempotency_key') &&
      recovery.expiresAt !== null &&
      Date.parse(recovery.expiresAt) <= Date.now()
    )
      return { status: 'expired' };
    const result = await effect.reconcile(signal);
    return result.status === 'settled' ? this.settle(effect, state, result.observation, true) : result;
  }

  private async settle<T>(
    effect: AdmittedEffect<T>,
    admitted: EffectExecutionState,
    observation: T,
    replayed: boolean
  ): Promise<EffectExecutionResult<T>> {
    const encoded = effect.codec.encode(observation);
    const owned = effect.codec.decode(encoded);
    for (;;) {
      const latest = await this.events.latest(admitted.intent.effectId);
      if (!latest) throw new Error('Started effect lost its execution record.');
      this.assertIntent(latest.event.state.intent, admitted.intent);
      const settled = settleExternalEffect(latest.event.state, admitted.settlementPermit, {
        outcome: 'succeeded',
        resultDigest: hashJson(encoded),
        exposure: effect.exposure(owned)
      });
      if (settled.status === 'rejected')
        throw new PersistenceConflictError(`Effect settlement rejected: ${settled.reason}.`);
      if (settled.status === 'late') return { status: 'unknown' };
      if (settled.status === 'already_settled')
        return { status: 'settled', observation: owned, replayed: true };
      try {
        await this.commit(
          admitted.intent.effectId,
          {
            type: 'execution.state.changed',
            state: settled.state,
            observation: encoded
          },
          envelopeTail(latest),
          latest.driverGeneration
        );
        return { status: 'settled', observation: owned, replayed };
      } catch (error) {
        if (!(error instanceof PersistenceConflictError)) throw error;
      }
    }
  }

  private recorded<T>(
    effect: AdmittedEffect<T>,
    event: EffectExecutionEvent
  ): EffectExecutionResult<T> | undefined {
    if (event.observation !== undefined)
      return { status: 'settled', observation: effect.codec.decode(event.observation), replayed: true };
    if (event.state.phase === 'closed')
      return {
        status:
          event.state.closure.reason === 'cancelled_before_start' ? 'cancelled_before_start' : 'unknown'
      };
    return undefined;
  }

  private assertIntent(recorded: ExternalEffectIntent, requested: ExternalEffectIntent): void {
    if (hashJson(recorded) !== hashJson(requested))
      throw new PersistenceConflictError('Effect identity was reused with a different admitted contract.');
  }

  private async commit(
    streamId: string,
    event: EffectExecutionEvent,
    tail: EventLedgerTail,
    generation: number
  ): Promise<EventLedgerTail> {
    const result = await this.events.appendConditional(streamId, event, {
      expectedTail: tail,
      driverGeneration: generation,
      idempotencyKey: `${String(generation)}:${hashJson(event)}`
    });
    if (result.kind === 'committed' || result.kind === 'already_committed') return result.tail;
    if (result.kind === 'rejected')
      throw new PersistenceConflictError(`Effect transition rejected: ${result.reason}.`);
    throw new Error(`Effect transition persistence is ${result.kind}.`);
  }
}

function envelopeTail(event: EventEnvelope<EffectExecutionEvent>): EventLedgerTail {
  return { sequence: event.sequence, hash: event.hash, driverGeneration: event.driverGeneration };
}
