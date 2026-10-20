import { fitBoundedJsonPage } from '../session/bounded-result.js';
import { hashJson } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import type { SessionSubmissionInput, SessionHostWakeOrigin } from '../session/contracts.js';
import { triggeredSubmissionDigest } from '../session/triggered-submission.js';
import type { AcceptIntentionInput, DurableIntention, HostWakeRecoveryPage, HostWakeServiceOptions, IntentionRepository, IntentionCondition, IntentionPageRequest, IntentionCursor, RecordedIntentionTrigger } from './contracts.js';
import { intentionPageBounds, ownAcceptedIntention } from './repository.js';

type IntentionPublication = Parameters<Parameters<IntentionRepository['withIntention']>[2]>[0];

/** Durable future-work admission, with host-provided clock/event eligibility. No timers, cron,
 * autonomous inference, or effect retries are installed. The host redelivers/recover()s until acknowledged.
 */
export class HostWakeService {
  constructor(private readonly options: HostWakeServiceOptions) {}
  accept(input: AcceptIntentionInput): Promise<DurableIntention> {
    return this.options.repository.accept(input, this.options.adapter.now());
  }
  read(ownerId: string, intentionId: string) { return this.options.repository.read(ownerId, intentionId); }
  list(ownerId: string, request?: IntentionPageRequest) { return this.options.repository.list(ownerId, request); }

  async dispatch(ownerId: string, intentionId: string, options: { readonly expectedRevision?: number; readonly signal?: AbortSignal } = {}): Promise<DurableIntention> {
    options.signal?.throwIfAborted();
    const observed = await this.options.repository.read(ownerId, intentionId);
    if (!observed) throw new Error('Unknown accepted intention.');
    this.assertRevision(observed, options.expectedRevision);
    // Slow host observation does not hold the cancellation fence. Recheck its captured
    // revision under that fence before publishing the trigger.
    const evaluated = observed.status === 'pending' && this.timeEligible(observed)
      ? await withSignal(this.options.adapter.evaluate(observed, options.signal === undefined ? {} : { signal: options.signal }), options.signal)
      : undefined;
    return this.options.repository.withIntention(ownerId, intentionId, async transaction => {
      options.signal?.throwIfAborted();
      this.assertRevision(transaction.current, options.expectedRevision);
      let current = await this.recoverAdmission(transaction);
      if (current.status === 'admitted') return this.settle(transaction);
      if (current.status === 'completed' || current.status === 'cancelled') return current;
      if (current.status === 'pending') {
        if (current.revision !== observed.revision) throw new Error('Intention changed during host eligibility observation.');
        if (!this.timeEligible(current)) return current;
        const trigger = evaluated;
        options.signal?.throwIfAborted();
        if (!trigger) return current;
        current = await transaction.replace({ ...current, status: 'triggered', revision: current.revision + 1,
          updatedAt: this.options.adapter.now(), trigger: { key: trigger.key, evidence: parseJsonObject(trigger.evidence), intentionRevision: current.revision } });
      }
      if (current.status !== 'triggered') throw new Error('Intention is not eligible for host admission.');
      if (!this.timeEligible(current)) throw new Error('Intention time condition is no longer eligible.');
      const recorded = current;
      const session = await this.options.resolveSession(current.sessionId);
      options.signal?.throwIfAborted();
      const receipt = await session.submitTriggered({ ...(options.signal === undefined ? {} : { signal: options.signal }), key: hostWakeSubmissionKey(recorded.ownerId, recorded.intentionId, recorded.trigger),
        input: hostWakeInput(recorded, recorded.trigger), withAdmission: operation => this.options.adapter.withAdmission(recorded, recorded.trigger, async () => {
          options.signal?.throwIfAborted();
          await transaction.assertOwned();
          if (!this.timeEligible(recorded)) throw new Error('Intention time condition is no longer eligible.');
          return operation();
        }) });
      // Acknowledgement is recorded only after durable session admission. A crash in this gap
      // recovers the immutable receipt, never repeats the accepted work.
      return transaction.replace({ ...recorded, status: 'admitted', revision: recorded.revision + 1, updatedAt: this.options.adapter.now(), receipt });
    });
  }

  async recover(ownerId: string, request: IntentionPageRequest = {}): Promise<HostWakeRecoveryPage> {
    const { limit, maxBytes } = intentionPageBounds(request);
    interface RecoveryEntry { readonly cursor?: IntentionCursor; readonly intention?: DurableIntention; readonly failure?: { readonly intentionId: string; readonly message: string } }
    const entries: RecoveryEntry[] = [];
    let cursor = request.cursor;
    let result: HostWakeRecoveryPage = { intentions: [], failures: [], coverage: 'complete' };
    for (let index = 0; index < limit; index++) {
      request.signal?.throwIfAborted();
      const page = await this.options.repository.list(ownerId, { ...request, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      const intention = page.intentions[0];
      if (!intention) return result;
      const next = page.cursor === undefined ? {} : { cursor: page.cursor };
      try { entries.push({ ...next, intention: await this.dispatch(ownerId, intention.intentionId, request.signal === undefined ? {} : { signal: request.signal }) }); }
      catch (error) {
        request.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        entries.push({ ...next, failure: Object.freeze({ intentionId: intention.intentionId,
          message: message.length > 256 ? `${Array.from(message).slice(0, 256).join('')}… [truncated]` : message }) });
      }
      result = fitBoundedJsonPage(entries, delivered => {
        const nextCursor = delivered.at(-1)?.cursor;
        return Object.freeze({ intentions: Object.freeze(delivered.flatMap(entry => entry.intention ? [entry.intention] : [])),
          failures: Object.freeze(delivered.flatMap(entry => entry.failure ? [entry.failure] : [])),
          coverage: nextCursor === undefined ? 'complete' as const : 'partial' as const,
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }) });
      }, maxBytes, requiredBytes => { throw new RangeError(`Host recovery page requires at least ${String(requiredBytes)} bytes including diagnostics and cursor.`); });
      if (result.intentions.length + result.failures.length < entries.length || page.cursor === undefined) return result;
      cursor = page.cursor;
    }
    return result;
  }

  reschedule(ownerId: string, intentionId: string, input: {
    readonly expectedRevision: number;
    readonly condition: IntentionCondition;
    readonly authorizationRef: string;
    readonly input?: AcceptIntentionInput['input'];
  }): Promise<DurableIntention> {
    return this.options.repository.withIntention(ownerId, intentionId, async transaction => {
      this.assertRevision(transaction.current, input.expectedRevision);
      const current = await this.recoverAdmission(transaction);
      if (current.status !== 'pending' && current.status !== 'triggered') throw new Error('Already admitted or settled work cannot be rescheduled; use ordinary session controls.');
      const accepted = ownAcceptedIntention({ ownerId, intentionId, sessionId: current.sessionId,
        condition: input.condition, authorizationRef: input.authorizationRef, input: input.input ?? current.input });
      return transaction.replace({ ...accepted, revision: current.revision + 1, status: 'pending', acceptedAt: current.acceptedAt, updatedAt: this.options.adapter.now() });
    });
  }

  cancel(ownerId: string, intentionId: string, input: { readonly expectedRevision: number; readonly reason: string }): Promise<DurableIntention> {
    return this.options.repository.withIntention(ownerId, intentionId, async transaction => {
      this.assertRevision(transaction.current, input.expectedRevision);
      let current = await this.recoverAdmission(transaction);
      if (current.status === 'cancelled' || current.status === 'completed') return current;
      if (current.status === 'admitted') {
        const session = await this.options.resolveSession(current.sessionId);
        const submission = await session.readSubmission(current.receipt.submissionId);
        if (submission?.state === 'queued') await session.updateQueuedSubmission(submission.submissionId, { kind: 'cancel', expectedInput: submission.input });
        current = await this.settle(transaction);
        if (current.status !== 'completed') throw new Error('Intention work is already running or suspended; abort or reconcile it through ordinary session controls.');
        return current;
      }
      const { trigger: ignored, ...identity } = current.status === 'triggered' ? current : { ...current, trigger: undefined };
      void ignored;
      return transaction.replace({ ...identity, status: 'cancelled', reason: input.reason, revision: current.revision + 1, updatedAt: this.options.adapter.now() });
    });
  }

  private async recoverAdmission(transaction: IntentionPublication): Promise<DurableIntention> {
    const current = transaction.current;
    if (current.status !== 'triggered') return current;
    const session = await this.options.resolveSession(current.sessionId);
    const key = hostWakeSubmissionKey(current.ownerId, current.intentionId, current.trigger);
    const receipt = await session.readTriggeredSubmissionReceipt(key);
    if (!receipt) return current;
    if (receipt.payloadDigest !== triggeredSubmissionDigest(hostWakeInput(current, current.trigger))) throw new Error('Intention trigger receipt has a conflicting payload.');
    return transaction.replace({ ...current, status: 'admitted', receipt, revision: current.revision + 1, updatedAt: this.options.adapter.now() });
  }
  private async settle(transaction: IntentionPublication): Promise<DurableIntention> {
    const current = transaction.current;
    if (current.status !== 'admitted') return current;
    const session = await this.options.resolveSession(current.sessionId);
    const submission = await session.readSubmission(current.receipt.submissionId);
    if (submission?.runId !== current.receipt.runId) throw new Error('Admitted intention submission is unavailable or changed identity.');
    if (submission.state !== 'completed' && submission.state !== 'failed' && submission.state !== 'cancelled') return current;
    return transaction.replace({ ...current, status: 'completed', outcome: submission.state, revision: current.revision + 1, updatedAt: this.options.adapter.now() });
  }
  private timeEligible(intention: DurableIntention): boolean {
    const now = Date.parse(this.options.adapter.now());
    if (!Number.isFinite(now)) throw new Error('Host clock returned an invalid time.');
    return intention.condition.kind !== 'time' || now >= Date.parse(intention.condition.notBefore);
  }
  private assertRevision(current: DurableIntention, expected?: number) {
    if (expected !== undefined && current.revision !== expected) throw new Error('Intention revision changed; inspect the current accepted work.');
  }
}
export function hostWakeSubmissionKey(ownerId: string, intentionId: string, trigger: RecordedIntentionTrigger): string {
  return `intention:${hashJson({ ownerId, intentionId, intentionRevision: trigger.intentionRevision, triggerKey: trigger.key })}`;
}
function hostWakeInput(intention: DurableIntention, trigger: RecordedIntentionTrigger): SessionSubmissionInput & { readonly origin: SessionHostWakeOrigin } {
  return { ...intention.input, origin: { kind: 'host_wake', ownerId: intention.ownerId, intentionId: intention.intentionId,
    intentionRevision: trigger.intentionRevision, triggerKey: trigger.key, authorizationRef: intention.authorizationRef, evidence: trigger.evidence } };
}

function withSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  const reason = () => signal.reason instanceof Error ? signal.reason : new Error('Host recovery was aborted.', { cause: signal.reason });
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(reason()); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(reason()); };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); });
  });
}
