import { hashJson, type EventReference, type EventRepository } from '@agent-core/persistence';
import type { ResourceReleaseReport } from '@agent-core/tools';
import type { AgentAuditEvent, AgentEvent } from '../events.js';

/** Record and verify the exact durable release before acknowledging its authority. */
export async function commitResourceRelease(input: {
  readonly runId: string;
  readonly report: ResourceReleaseReport;
  readonly events: EventRepository<AgentEvent>;
  readonly append?: (event: AgentAuditEvent, idempotencyKey: string) => Promise<unknown>;
  readonly acknowledge?: (resourceId: string) => Promise<void>;
}): Promise<EventReference> {
  const { runId, report, events } = input;
  if (report.outcome !== 'released')
    throw new Error(`Resource ${report.resourceId} release outcome is unknown.`);
  const owner = report.details.owner;
  if (owner && typeof owner === 'object' && 'runId' in owner && owner.runId !== runId)
    throw new Error('Resource release report belongs to another run.');
  const key = `${runId}:resource:${report.resourceId}:released`;
  let reference = report.settlementReference ?? await events.referenceByKey(runId, key);
  if (reference === undefined) {
    const event: AgentAuditEvent = {
      type: 'resource.released', runId, resourceId: report.resourceId,
      outcome: report.outcome, details: report.details
    };
    if (input.append) await input.append(event, key);
    else await events.append(runId, event, { actor: 'runtime', idempotencyKey: key });
    reference = await events.referenceByKey(runId, key);
    if (reference === undefined) throw new Error('Resource release has no durable receipt.');
  }
  if (reference.runId !== runId)
    throw new Error('Committed resource settlement belongs to another run.');
  const { event } = await events.readReference(reference);
  if (event.type !== 'resource.released' || event.runId !== runId ||
      event.resourceId !== report.resourceId || event.outcome !== report.outcome ||
      hashJson(event.details) !== hashJson(report.details))
    throw new Error('Committed resource settlement does not match its release report.');
  await input.acknowledge?.(report.resourceId);
  return reference;
}
