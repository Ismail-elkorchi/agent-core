import { parseJsonObject, type JsonValue } from '@agent-core/json';
import type { ArtifactRepository, EventRepository } from '@agent-core/persistence';
import { serializeToolModelContent } from '@agent-core/tools';
import type { AgentEvent } from '../events.js';
import type { PromptContextItemInput } from '../inference/prompt-material.js';
import { toolEventKey } from '../run/contracts.js';
import { resolveToolObservation } from './observation-source.js';

type ReceiptEvents = Pick<EventRepository<AgentEvent>, 'readMetadataRange' | 'readReference' | 'referenceByKey' | 'latestOfType'>;

/** Last settled invocation that received the exact receipt contributions. No preparation writes. */
export async function settledProgramReceiptsThrough(runId: string, events: ReceiptEvents): Promise<number | undefined> {
  const previous = await events.latestOfType(runId, 'provider.attempt.settled');
  return previous?.event.type === 'provider.attempt.settled' ? previous.event.programReceiptsThrough : undefined;
}

/** Read only pending receipt records using the existing observation index and invocation cursor. */
export async function programCompletionContext(runId: string, events: ReceiptEvents, artifacts?: ArtifactRepository): Promise<{
  readonly items: readonly PromptContextItemInput[]; readonly through?: number; readonly complete: boolean;
}> {
  const items: PromptContextItemInput[] = [];
  let through = await settledProgramReceiptsThrough(runId, events);
  let afterSequence = through ?? -1;
  let bytes = 0;
  let scanned = 0;
  const parentReceipts = new Map<string, ReadonlySet<string>>();
  const result = (complete: boolean) => Object.freeze({
    items: Object.freeze(complete ? items : [...items, Object.freeze({
      id: 'program-receipts-pending', sourceUri: `agent-run:${runId}:program-receipts`, sourceKind: 'generated' as const,
      integrity: 'verified' as const, representation: 'summary' as const, mediaType: 'application/json',
      title: 'Program receipt delivery is incomplete', purpose: 'Make pending receipt coverage explicit without dropping older records.',
      content: JSON.stringify({ coverage: 'partial', through: through ?? null, delivered: items.length,
        remaining: 'Additional child receipts remain pending; they will be selected on the next inference.' }) })]),
    ...(through === undefined ? {} : { through }), complete
  });
  for (;;) {
    const page = await events.readMetadataRange(runId, { afterSequence,
      types: ['observation.record.created'], metadata: { programReceipt: 'true' }, limit: 64, maxBytes: 256 * 1024 });
    if (page.oversized) throw new Error('Program completion receipt metadata exceeds its bounded access allowance.');
    for (const record of page.records) {
      const source = record.reference;
      const event = (await events.readReference(source)).event;
      if (event.type !== 'observation.record.created' || !event.programId)
        throw new Error('Program completion receipt has an incompatible durable source.');
      const completion = parseJsonObject(JSON.parse(serializeToolModelContent(event.modelContent ?? [])));
      const parent = parseJsonObject(completion.parent);
      if (parent.runId !== runId || typeof parent.turnId !== 'string' || typeof parent.toolBatchId !== 'string' ||
          typeof parent.callIndex !== 'number' || typeof parent.toolAttempt !== 'number')
        throw new Error('Program completion receipt has an invalid parent identity.');
      const parentReference = await events.referenceByKey(runId, toolEventKey(runId,
        { turnId: parent.turnId, toolBatchId: parent.toolBatchId, callIndex: parent.callIndex, toolAttempt: parent.toolAttempt }, 'ended'));
      // The parent has not sealed its result yet. Do not advance past this child: its
      // final receipt can race the parent's interrupted-result commit.
      if (!parentReference) return result(false);
      const parentEvent = (await events.readReference(parentReference)).event;
      if (parentEvent.type !== 'tool.ended') throw new Error('Program parent outcome has an incompatible source.');
      let delivered = parentReceipts.get(parentReference.eventId);
      if (!delivered) {
        const ids = new Set<string>();
        try {
          const output = parseJsonObject((await resolveToolObservation(parentEvent.observation, artifacts)).output);
          if (Array.isArray(output.receipts)) for (const receipt of output.receipts as readonly JsonValue[])
            if (receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt) && 'observationId' in receipt && typeof receipt.observationId === 'string')
              ids.add(receipt.observationId);
        } catch { /* Unavailable parent output cannot prove delivery; retain the child fact. */ }
        delivered = ids;
        parentReceipts.set(parentReference.eventId, delivered);
      }
      if (!delivered.has(event.id)) {
        const content = JSON.stringify({ source, completion });
        const contentBytes = new TextEncoder().encode(content).byteLength;
        if (items.length >= 256 || bytes + contentBytes > 1024 * 1024 - 2048)
          return result(false);
        bytes += contentBytes;
        items.push(Object.freeze({ id: `program-receipt:${event.id}`, sourceUri: `agent-event:${runId}:${source.eventId}`,
          sourceKind: 'tool-observation', integrity: 'verified', representation: 'summary', mediaType: 'application/json',
          title: 'Program child settled after its program stopped',
          purpose: 'Report this independently settled child without replaying or changing the interrupted program result.', content }));
      }
      through = source.sequence;
      if (++scanned >= 512) return result(false);
    }
    if (page.complete) return result(true);
    if (page.nextSequence <= afterSequence) throw new Error('Program receipt metadata made no progress.');
    afterSequence = page.nextSequence;
  }
}
