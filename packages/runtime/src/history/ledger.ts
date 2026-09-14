import { parseJsonValue } from '@agent-core/json';
import type { ModelOutputItem } from '@agent-core/model';
import type { EventEnvelope } from '@agent-core/persistence';
import type { AgentEvent } from '../events.js';
import type { SessionAssistantEntry, SessionBranchEntry } from '../session/contracts.js';

export function publicEventEntry(
  record: EventEnvelope<AgentEvent>,
  parentId: string | null,
  outputs: ReadonlyMap<string, readonly ModelOutputItem[]>
): SessionBranchEntry | undefined {
  const event = record.event;
  const source = Object.freeze({
    runId: record.runId,
    eventId: record.eventId,
    sequence: record.sequence,
    hash: record.hash
  });
  const base = {
    id: `event:${record.eventId}`,
    parentId,
    timestamp: record.timestamp,
    source,
    runId: record.runId
  };
  if (event.type === 'input.steering.accepted')
    return Object.freeze({
      ...base,
      type: 'steering',
      deliveryId: event.deliveryId,
      content: event.content
    });
  if (event.type === 'assistant.ended' || event.type === 'assistant.interrupted') {
    const output = outputs.get(`${event.turnId}:${String(event.requestAttempt)}`);
    const entry: SessionAssistantEntry = Object.freeze({
      ...base,
      type: 'assistant',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      content: event.content,
      ...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }),
      ...(event.reasoningSummary === undefined ? {} : { reasoningSummary: event.reasoningSummary }),
      completeness: event.modelOutput.status,
      ...(output ? { output } : {})
    });
    return entry;
  }
  if (event.type === 'tool.started')
    return Object.freeze({
      ...base,
      type: 'tool_call',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      toolBatchId: event.toolBatchId,
      callIndex: event.callIndex,
      ...(event.callId ? { callId: event.callId } : {}),
      call: parseJsonValue(event.input)
    });
  if (event.type === 'tool.ended')
    return Object.freeze({
      ...base,
      type: 'observation',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      toolBatchId: event.toolBatchId,
      callIndex: event.callIndex,
      ...(event.callId ? { callId: event.callId } : {}),
      toolAttempt: event.toolAttempt,
      toolName: event.toolName,
      kind: event.observation.kind,
      summary: event.observation.summary,
      ...(event.observation.storage === 'inline'
        ? { output: parseJsonValue(event.observation.observation.output) }
        : event.observation.storage === 'artifact'
          ? { originalArtifact: event.observation.artifact }
          : {
              originalUnavailable: {
                message: event.observation.message,
                bytes: event.observation.bytes,
                digest: event.observation.digest
              }
            })
    });
  if (event.type === 'observation.record.created')
    return Object.freeze({
      ...base,
      type: 'observation',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      toolBatchId: event.toolBatchId,
      callIndex: event.callIndex,
      ...(event.callId ? { callId: event.callId } : {}),
      toolAttempt: event.toolAttempt,
      toolName: event.toolName,
      kind: event.kind,
      summary: event.summary,
      ...(event.modelContentRef
        ? { modelContentRef: event.modelContentRef }
        : event.modelContent
          ? { modelContent: event.modelContent }
          : {})
    });
  return undefined;
}
export function mergeMirror(
  entry: SessionBranchEntry,
  mirror: SessionBranchEntry
): SessionBranchEntry {
  const routing = { id: mirror.id, parentId: mirror.parentId };
  switch (entry.type) {
    case 'steering':
      if (mirror.type === 'steering') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
    case 'assistant':
      if (mirror.type === 'assistant') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
    case 'tool_call':
      if (mirror.type === 'tool_call') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
    case 'observation':
      if (mirror.type === 'observation') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
  }
  throw new Error('Session mirror kind conflicts with its authoritative ledger event.');
}

export function entryIdentity(entry: SessionBranchEntry): string {
  if (entry.type === 'steering' && entry.deliveryId)
    return `steering:${entry.runId}:${entry.deliveryId}`;
  if (entry.type === 'assistant')
    return `assistant:${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}:${entry.completeness ?? 'complete'}`;
  if (entry.type === 'tool_call')
    return `tool_call:${entry.runId}:${entry.toolBatchId}:${String(entry.callIndex)}`;
  if (entry.type === 'observation')
    return `observation:${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}:${String(entry.toolBatchId)}:${String(entry.callIndex)}:${String(entry.toolAttempt)}`;
  if (entry.type === 'context_transition')
    return `context_transition:${entry.transition.idempotencyKey}`;
  return `entry:${entry.id}`;
}
