import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import { hashJson, PersistenceConflictError, type EventCodec, type EventRepository } from '@agent-core/persistence';
import { sourceSchema } from '../history/schema.js';
import { sourceRef } from '../history/reader.js';
import type { SessionDescriptor, SessionRepository, SessionPeerContributionEntry } from '../session/contracts.js';
import { ownPeerContributionInput, peerContributionInputSchema, type PeerContributionInput } from '../session/peer-contribution.js';
import { peerEndpointSchema, type PeerEndpoint } from './share-contracts.js';
import type { ScopedShareService } from './sharing.js';

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptSchema = z.strictObject({ deliveryId: id, fingerprint: digest, entryId: id, source: sourceSchema }).readonly();
export type PeerDeliveryReceipt = z.infer<typeof receiptSchema>;
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('peer.delivery_staged'), format: z.literal('agent-core.peer-delivery/1'), contribution: peerContributionInputSchema }).readonly(),
  z.strictObject({ type: z.literal('peer.delivery_received'), format: z.literal('agent-core.peer-delivery/1'), receipt: receiptSchema }).readonly()
]);
export type PeerDeliveryEvent = z.infer<typeof eventSchema>;
export const peerDeliveryEventCodec: EventCodec<PeerDeliveryEvent> = {
  encode(value) { return parseJsonObject(eventSchema.parse(value), { maxStringBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }); },
  decode(value) {
    const event = eventSchema.parse(value);
    return event.type === 'peer.delivery_staged' ? Object.freeze({ ...event, contribution: ownPeerContributionInput(event.contribution) }) : event;
  },
  metadata(value) { return value.type === 'peer.delivery_staged'
    ? { deliveryId: value.contribution.deliveryId, fingerprint: value.contribution.fingerprint }
    : { deliveryId: value.receipt.deliveryId, fingerprint: value.receipt.fingerprint }; },
  metadataIndexes: [{ field: 'deliveryId' }]
};
export interface PeerDeliveryServiceOptions {
  readonly events: EventRepository<PeerDeliveryEvent>;
  readonly sessions: SessionRepository;
  readonly resolveSession: (endpoint: PeerEndpoint) => Promise<SessionDescriptor>;
  readonly shares?: ScopedShareService;
  /** Reject unrelated recipient addresses before reading any journal bodies or routing facts. */
  readonly authorizeAddress: (address: { readonly groupId: string; readonly recipient: PeerEndpoint }) => Promise<void>;
  /** Historical access is distinct from authority to publish a new contribution. */
  readonly authorize: (input: PeerContributionInput, stage: 'read' | 'admit' | 'publish') => Promise<void>;
  /** Host fences the short admission/publication boundary against scope/epoch changes. */
  readonly withAuthorization: <T>(input: PeerContributionInput, operation: () => Promise<T>) => Promise<T>;
  /** Bounds retained preparation and delivery operations, without a waiter queue. */
  readonly maxPendingDeliveries?: number;
  /** Best-effort observer only. Durable recipient history is the acceptance authority. */
  readonly notify?: (receipt: PeerDeliveryReceipt) => void | Promise<void>;
}
export interface PeerDeliveryAddress { readonly groupId: string; readonly recipient: PeerEndpoint; readonly deliveryId: string }
export interface PeerDeliveryRead {
  readonly contribution: PeerContributionInput;
  readonly receipt?: PeerDeliveryReceipt;
}
export interface PeerDeliveryListRequest {
  readonly groupId: string; readonly recipient: PeerEndpoint;
  readonly afterSequence?: number; readonly limit?: number; readonly maxBytes?: number; readonly maxSourceBytes?: number;
}
export interface PeerDeliveryList {
  readonly items: readonly { readonly deliveryId: string; readonly fingerprint: string; readonly state: 'pending' | 'received' }[];
  readonly coverage: 'complete' | 'partial'; readonly nextSequence: number;
}

export class PeerDeliveryAdmissionError extends Error {
  readonly code = 'peer_delivery_capacity';
  constructor(readonly maxPendingDeliveries: number) {
    super(`Peer delivery admission is full (${String(maxPendingDeliveries)} pending deliveries).`);
    this.name = 'PeerDeliveryAdmissionError';
  }
}

/** Durable intent, recipient append, then receipt. A crash between these steps is retryable. */
export class PeerDeliveryService {
  private pending = 0;
  private readonly maximum: number;
  constructor(private readonly options: PeerDeliveryServiceOptions) {
    this.maximum = bounded(options.maxPendingDeliveries ?? 32, 1024);
  }
  get pendingDeliveries(): number { return this.pending; }

  /** Reserve before capturing or awaiting work; excess calls never enter an unbounded waiter queue. */
  deliver(value: PeerContributionInput): Promise<PeerDeliveryReceipt> {
    return this.admitted(() => this.deliverOwned(ownPeerContributionInput(value)));
  }
  prepareAndDeliver(prepare: () => Promise<PeerContributionInput>): Promise<PeerDeliveryReceipt> {
    return this.admitted(async () => this.deliverOwned(ownPeerContributionInput(await prepare())));
  }
  private async admitted<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maximum) throw new PeerDeliveryAdmissionError(this.maximum);
    this.pending++;
    try { return await operation(); } finally { this.pending--; }
  }

  private async deliverOwned(input: PeerContributionInput): Promise<PeerDeliveryReceipt> {
    await this.options.authorizeAddress({ groupId: input.groupId, recipient: input.recipient });
    await this.options.authorize(input, 'read');
    const stream = deliveryStream(input.groupId, input.recipient);
    const committed = await this.readRecord(stream, input.deliveryId);
    if (committed && hashJson(committed.contribution) !== hashJson(input))
      throw new PersistenceConflictError(`Conflicting peer delivery ${input.deliveryId}.`);
    if (committed?.receipt) {
      await this.validate(input, 'read');
      const session = await this.options.resolveSession(input.recipient);
      if (session.id !== input.recipient.sessionId) throw new Error('Peer receipt recipient identity changed.');
      await this.assertReceipt(session, input, committed.receipt);
      await this.validate(input, 'read');
      return committed.receipt;
    }
    // The recipient append is acceptance truth even if a crash prevented the receipt event.
    // Recover that fact without treating old assignment authority as new publication authority.
    if (committed) {
      await this.validate(input, 'read');
      const session = await this.options.resolveSession(input.recipient);
      if (session.id !== input.recipient.sessionId) throw new Error('Peer receipt recipient identity changed.');
      const entry = await this.options.sessions.findPeerContribution(session, input.deliveryId);
      if (entry) {
        if (hashJson(entry.contribution) !== hashJson(input)) throw new PersistenceConflictError(`Conflicting peer delivery ${input.deliveryId}.`);
        const receipt = this.receipt(session, input, entry);
        await this.validate(input, 'read');
        await this.options.events.append(stream, { type: 'peer.delivery_received', format: 'agent-core.peer-delivery/1', receipt }, { idempotencyKey: `receipt:${input.deliveryId}` });
        await this.notify(receipt);
        return receipt;
      }
    }
    await this.validate(input, 'publish');
    const session = await this.options.resolveSession(input.recipient);
    if (session.id !== input.recipient.sessionId) throw new Error('Peer delivery resolved a different recipient session.');
    const receipt = await this.options.withAuthorization(input, async () => {
      await this.validate(input, 'publish');
      const prior = await this.readRecord(stream, input.deliveryId);
      if (prior && prior.contribution.fingerprint !== input.fingerprint)
        throw new PersistenceConflictError(`Conflicting peer delivery ${input.deliveryId}.`);
      if (prior?.receipt) {
        await this.assertReceipt(session, input, prior.receipt);
        return prior.receipt;
      }
      if (!prior) await this.options.events.append(stream, { type: 'peer.delivery_staged', format: 'agent-core.peer-delivery/1', contribution: input }, { idempotencyKey: `intent:${input.deliveryId}` });
      // Only this recipient-side host adapter writes the recipient's typed import.
      const entry = await this.options.sessions.appendPeerContribution(session, input, {
        withOwnership: async operation => {
          // Recheck after durable intent I/O and the recipient journal queue, at publication.
          await this.options.authorize(input, 'publish');
          for (const share of input.shares) await this.options.shares?.authorizeGrant(share.grant, 'publish');
          return operation();
        }
      });
      const received = this.receipt(session, input, entry);
      await this.options.events.append(stream, { type: 'peer.delivery_received', format: 'agent-core.peer-delivery/1', receipt: received }, { idempotencyKey: `receipt:${input.deliveryId}` });
      return received;
    });
    await this.notify(receipt);
    return receipt;
  }

  /** Reconcile an intent after restart without accepting changed text or duplicated imports. */
  reconcile(address: PeerDeliveryAddress): Promise<PeerDeliveryReceipt> {
    return this.admitted(async () => {
      const record = await this.read(address, { maxBytes: 2 * 1024 * 1024 });
      if (!record) throw new Error('No durable peer delivery intent exists.');
      return record.receipt ?? this.deliverOwned(record.contribution);
    });
  }

  async read(address: PeerDeliveryAddress, request: { readonly maxBytes: number }): Promise<PeerDeliveryRead | undefined> {
    id.parse(address.deliveryId);
    const maxBytes = bounded(request.maxBytes, 2 * 1024 * 1024);
    await this.options.authorizeAddress({ groupId: id.parse(address.groupId), recipient: peerEndpointSchema.parse(address.recipient) });
    const result = await this.readRecord(deliveryStream(address.groupId, address.recipient), address.deliveryId);
    if (!result) return undefined;
    await this.validate(result.contribution, 'read');
    if (result.receipt) {
      const session = await this.options.resolveSession(result.contribution.recipient);
      if (session.id !== result.contribution.recipient.sessionId) throw new Error('Peer receipt recipient identity changed.');
      await this.assertReceipt(session, result.contribution, result.receipt);
    }
    await this.validate(result.contribution, 'read');
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new RangeError('Peer delivery read exceeds its full envelope byte allowance.');
    return result;
  }

  /** Lists bounded routing facts only; each returned delivery is reauthorized. */
  async list(request: PeerDeliveryListRequest): Promise<PeerDeliveryList> {
    const maxBytes = bounded(request.maxBytes ?? 32 * 1024, 1024 * 1024);
    const limit = bounded(request.limit ?? 32, 256);
    const maxSourceBytes = bounded(request.maxSourceBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024);
    await this.options.authorizeAddress({ groupId: id.parse(request.groupId), recipient: peerEndpointSchema.parse(request.recipient) });
    const stream = deliveryStream(request.groupId, request.recipient);
    const page = await this.options.events.readMetadataRange(stream, { afterSequence: request.afterSequence ?? -1, limit, maxBytes, types: ['peer.delivery_staged'] });
    if (page.oversized) throw new RangeError('Peer delivery list cannot fit one source.');
    const items: { deliveryId: string; fingerprint: string; state: 'pending' | 'received' }[] = [];
    let sourceBytes = 0, nextSequence = request.afterSequence ?? -1, complete = page.complete;
    for (const metadata of page.records) {
      if (sourceBytes + metadata.bytes > maxSourceBytes) {
        if (!items.length) throw new RangeError('Peer delivery source exceeds its list source byte allowance.');
        complete = false; break;
      }
      sourceBytes += metadata.bytes;
      const deliveryId = metadata.metadata.deliveryId;
      if (!deliveryId) throw new Error('Peer delivery index is missing its identity.');
      const record = await this.readRecord(stream, deliveryId);
      if (!record) throw new Error('Peer delivery intent disappeared.');
      await this.validate(record.contribution, 'read');
      sourceBytes += record.receipt ? Buffer.byteLength(JSON.stringify(record.receipt)) : 0;
      if (sourceBytes > maxSourceBytes) {
        if (!items.length) throw new RangeError('Peer delivery receipt exceeds its list source byte allowance.');
        complete = false; break;
      }
      items.push({ deliveryId, fingerprint: record.contribution.fingerprint, state: record.receipt ? 'received' : 'pending' });
      nextSequence = metadata.reference.sequence;
    }
    const result = Object.freeze({ items: Object.freeze(items), coverage: complete ? 'complete' as const : 'partial' as const, nextSequence: complete || items.length === page.records.length ? page.nextSequence : nextSequence });
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new RangeError('Peer delivery list exceeds its full envelope byte allowance.');
    return result;
  }

  async authorizeContribution(entry: SessionPeerContributionEntry, stage: 'read' | 'admit'): Promise<void> {
    const input = ownPeerContributionInput(entry.contribution);
    await this.options.authorizeAddress({ groupId: input.groupId, recipient: input.recipient });
    await this.options.authorize(input, stage);
    const committed = await this.readRecord(deliveryStream(input.groupId, input.recipient), input.deliveryId);
    if (!committed?.receipt || hashJson(committed.contribution) !== hashJson(input) ||
      hashJson(committed.receipt.source) !== hashJson(sourceRef(input.recipient.sessionId, entry)))
      throw new Error('Peer context requires its exact durable recipient receipt.');
    await this.validate(input, stage);
  }

  private async validate(input: PeerContributionInput, stage: 'read' | 'admit' | 'publish') {
    await this.options.authorize(input, stage);
    if (input.shares.length && !this.options.shares) throw new Error('Peer shares require a current scoped share service.');
    for (const share of input.shares) {
      if (stage === 'publish') await this.options.shares?.authorizeMaterial(share, stage, { maxSourceBytes: Math.floor(8 * 1024 * 1024 / input.shares.length) });
      else await this.options.shares?.authorizeGrant(share.grant, stage);
    }
    await this.options.authorize(input, stage);
  }

  private async assertReceipt(session: SessionDescriptor, input: PeerContributionInput, receipt: PeerDeliveryReceipt): Promise<void> {
    const entry = await this.options.sessions.readBranchEntry(session,
      { sessionId: session.id, leafId: receipt.entryId, leafHash: receipt.source.sha256 }, receipt.entryId);
    if (entry.type !== 'peer_contribution' || entry.contribution.fingerprint !== input.fingerprint ||
      hashJson(entry.contribution) !== hashJson(input) || hashJson(sourceRef(session.id, entry)) !== hashJson(receipt.source))
      throw new Error('Peer delivery receipt does not name the exact committed recipient import.');
  }

  private receipt(session: SessionDescriptor, input: PeerContributionInput, entry: SessionPeerContributionEntry): PeerDeliveryReceipt {
    return receiptSchema.parse({ deliveryId: input.deliveryId, fingerprint: input.fingerprint, entryId: entry.id, source: sourceRef(session.id, entry) });
  }

  private async notify(receipt: PeerDeliveryReceipt): Promise<void> {
    try { await this.options.notify?.(receipt); } catch { /* Observers do not change committed delivery truth. */ }
  }

  private async readRecord(stream: string, deliveryId: string): Promise<PeerDeliveryRead | undefined> {
    const reference = await this.options.events.referenceByKey(stream, `intent:${deliveryId}`);
    if (!reference) return undefined;
    const event = (await this.options.events.readReference(reference)).event;
    if (event.type !== 'peer.delivery_staged' || event.contribution.deliveryId !== deliveryId) throw new Error('Peer delivery intent identity is invalid.');
    const contribution = ownPeerContributionInput(event.contribution);
    const received = await this.options.events.referenceByKey(stream, `receipt:${deliveryId}`);
    const receiptEvent = received ? (await this.options.events.readReference(received)).event : undefined;
    if (receiptEvent && (receiptEvent.type !== 'peer.delivery_received' || receiptEvent.receipt.deliveryId !== deliveryId || receiptEvent.receipt.fingerprint !== contribution.fingerprint ||
      receiptEvent.receipt.source.sessionId !== contribution.recipient.sessionId || receiptEvent.receipt.source.entryId !== receiptEvent.receipt.entryId || receiptEvent.receipt.source.event !== undefined))
      throw new Error('Peer delivery receipt conflicts with its intent.');
    return Object.freeze({ contribution, ...(receiptEvent?.type === 'peer.delivery_received' ? { receipt: receiptEvent.receipt } : {}) });
  }
}
function deliveryStream(groupId: string, endpoint: PeerEndpoint): string {
  return `peer-${hashJson([id.parse(groupId), peerEndpointSchema.parse(endpoint)])}`;
}
function bounded(value: number, max: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError('Invalid peer delivery read allowance.');
  return value;
}
