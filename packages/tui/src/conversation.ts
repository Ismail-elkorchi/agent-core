import type { AgentProgressEvent, SessionBranchEntry } from '@agent-core/runtime';
import { decodeToolCall, type ToolCall } from '@agent-core/tools';
import {
  completedSessionToolActivity,
  completedToolActivity,
  pendingToolActivity,
  runningToolActivity,
  sessionObservationActivityId,
  toolActivityId,
  updatedToolActivity
} from './tools.js';

export type ConversationEntry =
  | ConversationUserEntry
  | ConversationAssistantEntry
  | ConversationReasoningEntry
  | ConversationActivityEntry
  | ConversationNoticeEntry
  | ConversationReferenceEntry;
interface ConversationIdentity {
  readonly runId?: string;
}
export interface ConversationUserEntry extends ConversationIdentity {
  readonly id: string;
  readonly kind: 'user';
  readonly text: string;
  readonly images?: readonly import('@agent-core/runtime').SessionImageInput[];
}
export interface ConversationAssistantEntry extends ConversationIdentity {
  readonly id: string;
  readonly kind: 'assistant';
  readonly turnId: string;
  readonly text: string;
  readonly status: 'streaming' | 'complete' | 'interrupted';
}
export interface ConversationReasoningEntry extends ConversationIdentity {
  readonly id: string;
  readonly kind: 'reasoning';
  readonly turnId: string;
  readonly text: string;
  readonly channel: 'reasoning' | 'summary';
}
export interface ActivityDetail {
  readonly id: string;
  readonly content: string;
}
export interface ConversationActivityEntry extends ConversationIdentity {
  readonly id: string;
  readonly kind: 'activity';
  readonly activity: string;
  readonly label: string;
  readonly status: 'running' | 'success' | 'warning' | 'failed';
  readonly summary?: string;
  readonly details?: readonly ActivityDetail[];
}
export interface ConversationNoticeEntry extends ConversationIdentity {
  readonly id: string;
  readonly kind: 'notice';
  readonly tone: 'info' | 'success' | 'warning' | 'error';
  readonly text: string;
}

export function sessionConversationId(entry: SessionBranchEntry): string {
  switch (entry.type) {
    case 'input':
      return `input:${entry.runId}`;
    case 'assistant':
      return `assistant:${entry.turnId}`;
    case 'tool_call':
      return toolActivityId(entry);
    case 'observation':
      return sessionObservationActivityId(entry);
    case 'steering':
      return entry.deliveryId === undefined ? `session:${entry.id}` : `steering:${entry.deliveryId}`;
    case 'context_transition':
      return `session:${entry.window.windowId}`;
    default:
      return `session:${entry.id}`;
  }
}

/** Pure presentation of authorized recorded entries; it owns no transcript or execution state. */
function sessionEntries(
  entry: SessionBranchEntry,
  current?: ConversationActivityEntry,
  label?: (call: ToolCall) => string
): readonly ConversationEntry[] {
  const id = sessionConversationId(entry);
  switch (entry.type) {
    case 'input':
      return [
        {
          id,
          kind: 'user',
          text: entry.task,
          ...(entry.images === undefined ? {} : { images: entry.images })
        }
      ];
    case 'steering':
      return [{ id, kind: 'user', text: entry.content }];
    case 'assistant':
      return [
        ...reasoningEntries(entry.turnId, entry),
        ...assistant(
          entry.turnId,
          entry.content,
          entry.completeness === undefined || entry.completeness === 'complete' ? 'complete' : 'interrupted'
        )
      ];
    case 'tool_call': {
      const call = decodeToolCall(entry.call);
      return [pendingToolActivity(id, call, label?.(call))];
    }
    case 'observation':
      return [completedSessionToolActivity(current, entry)];
    case 'context_transition':
      return [{ id, kind: 'notice', tone: 'info', text: `Context changed · ${entry.window.reason}` }];
    case 'branch':
      return [
        {
          id,
          kind: 'notice',
          tone: 'info',
          text: `Session branched${entry.label === undefined ? '' : ` · ${entry.label}`}`
        }
      ];
    case 'model_settings':
      return [];
  }
}

function progressEntries(
  input: { readonly runId: string; readonly event: AgentProgressEvent },
  entries: readonly ConversationEntry[],
  label?: (call: ToolCall) => string
): readonly ConversationEntry[] {
  const { event, runId } = input;
  switch (event.type) {
    case 'turn.started':
      return event.turnIndex !== 1 || entries.some((entry) => entry.id === `input:${runId}`)
        ? []
        : [{ id: `input:${runId}`, kind: 'user', text: event.task }];
    case 'assistant.delta':
      return assistant(event.turnId, event.accumulated, 'streaming');
    case 'assistant.reasoning':
      return reasoningEntries(
        event.turnId,
        event.channel === 'summary'
          ? { reasoningSummary: event.accumulated }
          : { reasoning: event.accumulated }
      );
    case 'assistant.ended':
      return [
        ...reasoningEntries(event.turnId, event),
        ...assistant(event.turnId, event.content, 'complete')
      ];
    case 'assistant.interrupted':
      return [
        ...reasoningEntries(event.turnId, event),
        ...assistant(event.turnId, event.content, 'interrupted')
      ];
    case 'tool.call.received':
      return [
        pendingToolActivity(toolActivityId({ ...event, runId }), event.toolCall, label?.(event.toolCall))
      ];
    case 'tool.started':
      return [
        runningToolActivity(
          toolActivityId({ ...event, runId }),
          event.input,
          event.effects,
          label?.(event.input)
        )
      ];
    case 'tool.updated':
    case 'tool.ended': {
      const id = toolActivityId({ ...event, runId });
      const current = entries.find(
        (entry): entry is ConversationActivityEntry => entry.kind === 'activity' && entry.id === id
      );
      return [
        event.type === 'tool.updated'
          ? updatedToolActivity(current, id, event.toolName, event.progress)
          : completedToolActivity(current, id, event.toolName, event.observation)
      ];
    }
    default:
      return [];
  }
}

export function mergeConversationEntries(
  current: readonly ConversationEntry[],
  updates: readonly ConversationEntry[]
): readonly ConversationEntry[] {
  if (updates.length === 0) return current;
  const entries = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of updates) {
    const previous = entries.get(entry.id);
    if (
      entry.kind === 'assistant' &&
      entry.status === 'streaming' &&
      previous?.kind === 'assistant' &&
      previous.status !== 'streaming'
    )
      continue;
    entries.set(entry.id, entry);
  }
  return [...entries.values()];
}

function assistant(
  turnId: string,
  text: string,
  status: ConversationAssistantEntry['status']
): readonly ConversationAssistantEntry[] {
  return text.length === 0 ? [] : [{ id: `assistant:${turnId}`, kind: 'assistant', turnId, text, status }];
}
function reasoningEntries(
  turnId: string,
  input: { readonly reasoning?: string; readonly reasoningSummary?: string }
): readonly ConversationReasoningEntry[] {
  return (['reasoning', 'summary'] as const).flatMap((channel) => {
    const text = channel === 'reasoning' ? input.reasoning : input.reasoningSummary;
    return text === undefined || text.length === 0
      ? []
      : [{ id: `reasoning:${turnId}:${channel}`, kind: 'reasoning', turnId, channel, text }];
  });
}
/** Plain source for inspection/export; rendering does not alter the original message text. */
export function conversationText(entry: ConversationEntry, expanded = true): string {
  switch (entry.kind) {
    case 'reference':
      return `Recorded entry · ${String(entry.bytes)} bytes · open source to inspect`;
    case 'user':
      return `You\n${entry.text}`;
    case 'assistant':
      return entry.text;
    case 'reasoning':
      return `${entry.channel === 'summary' ? 'Reasoning summary' : 'Reasoning'}\n${entry.text}`;
    case 'notice':
      return entry.text;
    case 'activity':
      return `${entry.label} · ${entry.summary ?? entry.status}${expanded && entry.details !== undefined ? `\n${activityDetails(entry)}` : ''}`;
  }
}

export function activityDetails(entry: ConversationActivityEntry): string {
  return entry.details?.map((detail) => detail.content).join('\n\n') ?? '';
}

/** Recorded ordering is authoritative. Uncommitted output stays before its next recorded causal neighbor. */
export function reconcileConversationEntries(
  recorded: readonly ConversationEntry[],
  live: readonly ConversationEntry[]
): readonly ConversationEntry[] {
  const committed = new Map(recorded.map((entry) => [entry.id, entry]));
  const before = new Map<string | undefined, ConversationEntry[]>();
  const updates = new Map<string, ConversationEntry>();
  let next: string | undefined;
  for (let index = live.length - 1; index >= 0; index--) {
    const entry = live[index];
    if (entry === undefined) continue;
    const previous = committed.get(entry.id);
    if (previous !== undefined) {
      next = entry.id;
      if (
        (previous.kind === 'assistant' && previous.status === 'streaming') ||
        (previous.kind === 'activity' && previous.status === 'running')
      )
        updates.set(entry.id, entry);
    } else {
      const group = before.get(next) ?? [];
      group.push(entry);
      before.set(next, group);
    }
  }
  return [
    ...recorded.flatMap((entry) => [
      ...(before.get(entry.id) ?? []).reverse(),
      updates.get(entry.id) ?? entry
    ]),
    ...(before.get(undefined) ?? []).reverse()
  ];
}

export interface ConversationReferenceEntry extends ConversationIdentity {
  readonly kind: 'reference';
  readonly id: string;
  readonly boundary: import('@agent-core/runtime').SessionBranchBoundary;
  readonly entryId: string;
  readonly bytes: number;
}
export function oversizedHistoryEntry(
  page: import('@agent-core/runtime').SessionBranchPage
): readonly ConversationReferenceEntry[] {
  const entry = page.oversizedEntry;
  return entry === undefined
    ? []
    : [
        {
          kind: 'reference',
          id: `history:${page.boundary.sessionId}:${entry.entryId}`,
          boundary: page.boundary,
          entryId: entry.entryId,
          bytes: entry.bytes
        }
      ];
}

export function projectSessionEntry(
  entry: SessionBranchEntry,
  current?: ConversationActivityEntry,
  label?: (call: ToolCall) => string
): readonly ConversationEntry[] {
  const entries = sessionEntries(entry, current, label);
  return 'runId' in entry
    ? entries.map((item) => ({ ...item, runId: entry.runId }))
    : entries;
}
export function projectProgress(
  input: { readonly runId: string; readonly event: AgentProgressEvent },
  entries: readonly ConversationEntry[],
  label?: (call: ToolCall) => string
): readonly ConversationEntry[] {
  return progressEntries(input, entries, label).map((entry) => ({ ...entry, runId: input.runId }));
}
/** Acceptance can arrive after progress. Place the input before output from its own run. */
export function insertAcceptedInput(
  entries: readonly ConversationEntry[],
  input: ConversationUserEntry
): readonly ConversationEntry[] {
  if (entries.some((entry) => entry.id === input.id)) return mergeConversationEntries(entries, [input]);
  const index = input.runId === undefined ? -1 : entries.findIndex((entry) => entry.runId === input.runId);
  return index < 0 ? [...entries, input] : [...entries.slice(0, index), input, ...entries.slice(index)];
}
