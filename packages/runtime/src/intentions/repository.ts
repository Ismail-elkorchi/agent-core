import { fitBoundedJsonPage } from '../session/bounded-result.js';
import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import { InMemoryEventRepository, hashJson, type EventCodec, type EventRepository } from '@agent-core/persistence';
import { ownSessionSubmissionInput } from '../session/submission-lifecycle.js';
import type { AcceptIntentionInput, DurableIntention, IntentionPage, IntentionPageRequest, IntentionRepository } from './contracts.js';

type IntentionPublication = Parameters<Parameters<IntentionRepository['withIntention']>[2]>[0];

const id = z.string().min(1).max(1024);
const timestamp = z.iso.datetime({ offset: true });
const object = z.unknown().transform(value => parseJsonObject(value, { maxTotalBytes: 32768, maxStringBytes: 16384, maxCollectionEntries: 1024 }));
export const intentionConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('time'), notBefore: timestamp }),
  z.strictObject({ kind: z.literal('event'), topic: id, condition: object })
]);
const taskInput = z.unknown().transform(value => {
  const input = ownSessionSubmissionInput(value);
  if (input.origin !== undefined || input.relationship !== undefined) throw new Error('Intention input cannot supply origin or user-correction authority.');
  return input;
});
const acceptanceFields = { ownerId: id, intentionId: id, sessionId: id, authorizationRef: z.string().min(1).max(4096), condition: intentionConditionSchema, input: taskInput };
const acceptanceSchema = z.strictObject(acceptanceFields);
const identity = { ...acceptanceFields, revision: z.number().int().positive(), acceptedAt: timestamp, updatedAt: timestamp };
const trigger = z.strictObject({ key: id, evidence: object, intentionRevision: z.number().int().positive() });
const receipt = z.strictObject({ key: z.string().min(1).max(4096), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u), sessionId: id, submissionId: id, runId: id, admittedAt: timestamp });
const recordSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...identity, status: z.literal('pending') }),
  z.strictObject({ ...identity, status: z.literal('triggered'), trigger }),
  z.strictObject({ ...identity, status: z.literal('admitted'), trigger, receipt }),
  z.strictObject({ ...identity, status: z.literal('completed'), trigger, receipt, outcome: z.enum(['completed', 'failed', 'cancelled']) }),
  z.strictObject({ ...identity, status: z.literal('cancelled'), reason: id })
]);
export function ownAcceptedIntention(value: unknown): AcceptIntentionInput { return freeze(acceptanceSchema.parse(value)); }
export function ownDurableIntention(value: unknown): DurableIntention {
  const parsed = recordSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 65536) throw new RangeError('Intention exceeds the 64 KiB durable record bound.');
  if ('trigger' in parsed && parsed.trigger.intentionRevision >= parsed.revision) throw new Error('Recorded intention trigger has an invalid revision.');
  if ('receipt' in parsed && parsed.receipt.sessionId !== parsed.sessionId) throw new Error('Intention receipt belongs to another session.');
  return freeze(parsed);
}
export type IntentionEvent =
  | { readonly type: 'intention.accepted'; readonly format: 'agent-core.intentions/1'; readonly requestDigest: string; readonly record: DurableIntention }
  | { readonly type: 'intention.updated'; readonly format: 'agent-core.intentions/1'; readonly previousRevision: number; readonly record: DurableIntention };
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('intention.accepted'), format: z.literal('agent-core.intentions/1'), requestDigest: z.string().regex(/^[a-f0-9]{64}$/u), record: z.unknown().transform(ownDurableIntention) }),
  z.strictObject({ type: z.literal('intention.updated'), format: z.literal('agent-core.intentions/1'), previousRevision: z.number().int().positive(), record: z.unknown().transform(ownDurableIntention) })
]);
export const intentionEventCodec: EventCodec<IntentionEvent> = {
  encode: value => parseJsonObject(eventSchema.parse(value)),
  decode: value => {
    const event = eventSchema.parse(value);
    if (event.type === 'intention.accepted') {
      const { ownerId, intentionId, sessionId, authorizationRef, condition, input } = event.record;
      if (event.record.revision !== 1 || event.record.status !== 'pending' || event.requestDigest !== hashJson({ ownerId, intentionId, sessionId, authorizationRef, condition, input }))
        throw new Error('Invalid accepted intention state or request digest.');
    }
    if (event.type === 'intention.updated' && event.record.revision !== event.previousRevision + 1) throw new Error('Invalid intention revision transition.');
    return freeze(event);
  }
};
export type IntentionLock = <T>(ownerId: string, intentionId: string, operation: (assertOwned: () => Promise<void>) => Promise<T>) => Promise<T>;
type IntentionEvents = Pick<EventRepository<IntentionEvent>, 'tail' | 'latest' | 'readReference' | 'referenceByKey' | 'readMetadataRange' | 'appendConditional'>;
/** Uses the ordinary event journal. The catalog is an immutable acceptance directory, never a scheduler. */
export class EventIntentionRepository implements IntentionRepository {
  constructor(readonly events: IntentionEvents, private readonly withLock: IntentionLock) {}
  async accept(input: AcceptIntentionInput, acceptedAt: string): Promise<DurableIntention> {
    const captured = ownAcceptedIntention(input);
    const record = ownDurableIntention({ ...captured, revision: 1, status: 'pending', acceptedAt, updatedAt: acceptedAt });
    const requestDigest = hashJson(captured);
    return this.withLock(captured.ownerId, captured.intentionId, async assertOwned => {
      const key = catalogKey(captured.ownerId), operationId = acceptanceKey(captured.intentionId);
      for (let attempt = 0; attempt < 32; attempt++) {
        const existing = await this.acceptance(captured.ownerId, captured.intentionId);
        if (existing) {
          if (existing.requestDigest !== requestDigest) throw new Error('Intention identity was already accepted with different work.');
          return (await this.read(captured.ownerId, captured.intentionId)) ?? existing.record;
        }
        const tail = await this.events.tail(key);
        await assertOwned();
        const result = await this.events.appendConditional(key, { type: 'intention.accepted', format: 'agent-core.intentions/1', requestDigest, record },
          { expectedTail: tail, driverGeneration: tail.driverGeneration, idempotencyKey: operationId, actor: 'runtime' });
        if (result.kind === 'committed' || result.kind === 'already_committed' || result.kind === 'committed_index_unknown') return record;
        if (result.kind === 'rejected' && result.reason === 'stale_tail') continue;
        throw new Error(`Intention acceptance durability failed: ${result.kind}.`);
      }
      throw new Error('Intention acceptance contention exceeded its bounded retry allowance.');
    });
  }
  private async acceptance(ownerId: string, intentionId: string) {
    const reference = await this.events.referenceByKey(catalogKey(ownerId), acceptanceKey(intentionId));
    if (!reference) return undefined;
    const event = (await this.events.readReference(reference)).event;
    if (event.type !== 'intention.accepted' || event.record.ownerId !== ownerId || event.record.intentionId !== intentionId) throw new Error('Intention acceptance identity mismatch.');
    return event;
  }
  async read(ownerId: string, intentionId: string): Promise<DurableIntention | undefined> {
    const accepted = await this.acceptance(ownerId, intentionId);
    if (!accepted) return undefined;
    const latest = await this.events.latest(intentionStreamKey(ownerId, intentionId));
    if (!latest) return accepted.record;
    const event = latest.event;
    if (event.type !== 'intention.updated' || event.record.revision !== latest.sequence + 2 || event.record.ownerId !== ownerId || event.record.intentionId !== intentionId || event.record.acceptedAt !== accepted.record.acceptedAt)
      throw new Error('Intention update identity mismatch.');
    return event.record;
  }
  async list(ownerId: string, request: IntentionPageRequest = {}): Promise<IntentionPage> {
    id.parse(ownerId); request.signal?.throwIfAborted();
    const { limit, maxBytes } = intentionPageBounds(request);
    if (request.cursor && request.cursor.ownerId !== ownerId) throw new Error('Intention cursor belongs to another owner.');
    const through = request.cursor?.through ?? await this.events.tail(catalogKey(ownerId));
    const page = await this.events.readMetadataRange(catalogKey(ownerId), { through, afterSequence: request.cursor?.afterSequence ?? -1, limit, maxBytes });
    if (page.oversized) throw new Error('Intention catalog metadata exceeds the requested page bound.');
    const entries: { readonly record: DurableIntention; readonly sequence: number }[] = [];
    let bytes = 0;
    for (const metadata of page.records) {
      request.signal?.throwIfAborted();
      const event = (await this.events.readReference(metadata.reference)).event;
      if (event.type !== 'intention.accepted' || event.record.ownerId !== ownerId) throw new Error('Invalid intention catalog record.');
      const current = (await this.read(ownerId, event.record.intentionId)) ?? event.record;
      entries.push({ record: current, sequence: metadata.reference.sequence });
      bytes += Buffer.byteLength(JSON.stringify(current));
      if (bytes > maxBytes) break;
    }
    return fitBoundedJsonPage(entries, delivered => {
      const complete = page.complete && delivered.length === page.records.length;
      const afterSequence = delivered.at(-1)?.sequence ?? page.nextSequence;
      return Object.freeze({ intentions: Object.freeze(delivered.map(entry => entry.record)), coverage: complete ? 'complete' as const : 'partial' as const,
        ...(complete ? {} : { cursor: Object.freeze({ ownerId, afterSequence, through }) }) });
    }, maxBytes, requiredBytes => { throw new RangeError(`Intention page requires at least ${String(requiredBytes)} bytes including its cursor and envelope.`); });
  }

  withIntention<T>(ownerId: string, intentionId: string, operation: (transaction: IntentionPublication) => Promise<T>): Promise<T> {
    return this.withLock(ownerId, intentionId, async assertLockOwned => {
      const found = await this.read(ownerId, intentionId);
      if (!found) throw new Error('Unknown accepted intention.');
      let current: DurableIntention = found;
      let released = false;
      const assertOwned = async () => { if (released) throw new Error('Intention transaction no longer owns its admission fence.'); await assertLockOwned(); };
      return operation({ get current() { return current; }, assertOwned, replace: async next => {
        await assertOwned();
        const captured = ownDurableIntention(next);
        assertTransition(current, captured);
        const key = intentionStreamKey(ownerId, intentionId), tail = await this.events.tail(key);
        const result = await this.events.appendConditional(key, { type: 'intention.updated', format: 'agent-core.intentions/1', previousRevision: current.revision, record: captured },
          { expectedTail: tail, driverGeneration: tail.driverGeneration, idempotencyKey: `revision:${String(captured.revision)}`, actor: 'runtime' });
        if (result.kind !== 'committed' && result.kind !== 'already_committed' && result.kind !== 'committed_index_unknown') throw new Error(`Intention update durability failed: ${result.kind}.`);
        current = captured; return current;
      } }).finally(() => { released = true; });
    });
  }
}
export class InMemoryIntentionRepository extends EventIntentionRepository {
  constructor() {
    const queues = new Map<string, Promise<unknown>>();
    super(new InMemoryEventRepository(intentionEventCodec), (ownerId, intentionId, operation) => {
      const key = intentionStreamKey(ownerId, intentionId);
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => operation(() => Promise.resolve()));
      queues.set(key, next);
      void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
      return next;
    });
  }
}
export function intentionStreamKey(ownerId: string, intentionId: string): string { id.parse(ownerId); id.parse(intentionId); return `intention-${hashJson([ownerId, intentionId])}`; }
function catalogKey(ownerId: string) { id.parse(ownerId); return `intentions-${hashJson(ownerId)}`; }
function acceptanceKey(intentionId: string) { id.parse(intentionId); return `accepted:${hashJson(intentionId)}`; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function assertTransition(previous: DurableIntention, next: DurableIntention) {
  if (previous.ownerId !== next.ownerId || previous.intentionId !== next.intentionId || previous.sessionId !== next.sessionId || previous.acceptedAt !== next.acceptedAt || next.revision !== previous.revision + 1)
    throw new Error('Intention identity or revision changed.');
  const allowed = previous.status === 'pending' ? ['pending', 'triggered', 'cancelled'] : previous.status === 'triggered' ? ['pending', 'admitted', 'cancelled'] : previous.status === 'admitted' ? ['completed'] : [];
  if (!allowed.includes(next.status)) throw new Error(`Invalid intention transition: ${previous.status} -> ${next.status}.`);
  if (next.status !== 'pending' && hashJson({ input: previous.input, condition: previous.condition, authorizationRef: previous.authorizationRef }) !== hashJson({ input: next.input, condition: next.condition, authorizationRef: next.authorizationRef }))
    throw new Error('Only rescheduling may change accepted intention work.');
  if (previous.status === 'pending' && next.status === 'triggered' && next.trigger.intentionRevision !== previous.revision) throw new Error('Recorded trigger does not bind the accepted revision.');
  if ('trigger' in previous && 'trigger' in next && hashJson(previous.trigger) !== hashJson(next.trigger)) throw new Error('Recorded trigger identity changed.');
  if ('receipt' in previous && 'receipt' in next && hashJson(previous.receipt) !== hashJson(next.receipt)) throw new Error('Durable intention receipt changed.');
}

export function intentionPageBounds(request: IntentionPageRequest) {
  const limit = request.limit ?? 32, maxBytes = request.maxBytes ?? 1048576;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8388608)
    throw new RangeError('Invalid intention page bounds.');
  return { limit, maxBytes };
}
