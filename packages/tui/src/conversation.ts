import type { AgentTuiState } from './state.js';
import type {
  AgentTuiActivityEntry,
  AgentTuiAssistantEntry,
  AgentTuiConversationEntry,
  AgentTuiNoticeEntry
} from './conversation-model.js';

export const MAX_CONVERSATION_ENTRIES = 512;
export const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;
const MAX_CONVERSATION_ENTRY_BYTES = 256 * 1024;

export function appendUser(state: AgentTuiState, text: string): AgentTuiState {
  return appendEntry(state, { id: localId(state, 'user'), kind: 'user', text });
}

export function appendNotice(
  state: AgentTuiState,
  text: string,
  tone: AgentTuiNoticeEntry['tone'] = 'info'
): AgentTuiState {
  return appendEntry(state, { id: localId(state, 'notice'), kind: 'notice', tone, text });
}

export function upsertAssistant(
  state: AgentTuiState,
  turnId: string,
  text: string,
  status: AgentTuiAssistantEntry['status']
): AgentTuiState {
  const id = `assistant:${turnId}`;
  const current = state.conversation.items.find((item): item is AgentTuiAssistantEntry => item.id === id && item.kind === 'assistant');
  const entry: AgentTuiAssistantEntry = { id, kind: 'assistant', turnId, text, status };
  if (current === undefined) return appendEntry(state, entry);
  return replaceEntry(state, entry);
}

export function upsertReasoning(state: AgentTuiState, turnId: string, text: string): AgentTuiState {
  const entry = { id: `reasoning:${turnId}`, kind: 'reasoning' as const, turnId, text };
  return state.conversation.items.some((item) => item.id === entry.id)
    ? replaceEntry(state, entry)
    : appendEntry(state, entry);
}

export function upsertActivity(state: AgentTuiState, entry: AgentTuiActivityEntry): AgentTuiState {
  const exists = state.conversation.items.some((item) => item.id === entry.id);
  const next = exists ? replaceEntry(state, entry) : appendEntry(state, entry);
  if (entry.status !== 'failed' || next.conversation.expandedIds.includes(entry.id)) return next;
  return {
    ...next,
    conversation: {
      ...next.conversation,
      expandedIds: [...next.conversation.expandedIds, entry.id]
    }
  };
}

export function toggleActivity(state: AgentTuiState, id: string): AgentTuiState {
  const expanded = state.conversation.expandedIds.includes(id);
  return {
    ...state,
    conversation: {
      ...state.conversation,
      expandedIds: expanded
        ? state.conversation.expandedIds.filter((candidate) => candidate !== id)
        : [...state.conversation.expandedIds, id]
    }
  };
}

export function conversationText(entry: AgentTuiConversationEntry): string {
  switch (entry.kind) {
    case 'user': return entry.text;
    case 'assistant': return entry.text;
    case 'reasoning': return entry.text;
    case 'notice': return entry.text;
    case 'activity': return [entry.label, entry.summary, entry.details].filter((part): part is string => part !== undefined).join('\n');
  }
}

function appendEntry(state: AgentTuiState, entry: AgentTuiConversationEntry): AgentTuiState {
  const retained = retainConversation([...state.conversation.items, limitEntry(entry)]);
  return {
    ...state,
    conversation: {
      ...state.conversation,
      items: retained.items,
      omittedEntries: state.conversation.omittedEntries + retained.omittedEntries,
      omittedBytes: state.conversation.omittedBytes + retained.omittedBytes,
      expandedIds: state.conversation.expandedIds.filter((id) => retained.items.some((item) => item.id === id))
    },
    nextLocalId: state.nextLocalId + 1
  };
}

function replaceEntry(state: AgentTuiState, entry: AgentTuiConversationEntry): AgentTuiState {
  const retained = retainConversation(state.conversation.items.map((item) => item.id === entry.id ? limitEntry(entry) : item));
  return {
    ...state,
    conversation: {
      ...state.conversation,
      items: retained.items,
      omittedEntries: state.conversation.omittedEntries + retained.omittedEntries,
      omittedBytes: state.conversation.omittedBytes + retained.omittedBytes,
      expandedIds: state.conversation.expandedIds.filter((id) => retained.items.some((item) => item.id === id))
    }
  };
}

function retainConversation(items: readonly AgentTuiConversationEntry[]): { items: readonly AgentTuiConversationEntry[]; omittedEntries: number; omittedBytes: number } {
  const retained = [...items];
  let bytes = retained.reduce((total, item) => total + entryBytes(item), 0);
  let omittedEntries = 0;
  let omittedBytes = 0;
  while (retained.length > MAX_CONVERSATION_ENTRIES || bytes > MAX_CONVERSATION_BYTES) {
    const removed = retained.shift();
    if (!removed) break;
    const removedBytes = entryBytes(removed);
    bytes -= removedBytes;
    omittedEntries += 1;
    omittedBytes += removedBytes;
  }
  return { items: retained, omittedEntries, omittedBytes };
}

function limitEntry(entry: AgentTuiConversationEntry): AgentTuiConversationEntry {
  const bytes = entryBytes(entry);
  if (bytes <= MAX_CONVERSATION_ENTRY_BYTES) return entry;
  switch (entry.kind) {
    case 'activity': return {
      ...entry,
      id: limitUtf8Text(entry.id, 2_000),
      label: limitUtf8Text(entry.label, 16_000),
      ...(entry.summary ? { summary: limitUtf8Text(entry.summary, 48_000) } : {}),
      ...(entry.details ? { details: limitUtf8Text(entry.details, 180_000) } : {})
    };
    case 'user': return { ...entry, id: limitUtf8Text(entry.id, 2_000), text: limitUtf8Text(entry.text, 250_000) };
    case 'assistant': return { ...entry, id: limitUtf8Text(entry.id, 2_000), turnId: limitUtf8Text(entry.turnId, 2_000), text: limitUtf8Text(entry.text, 246_000) };
    case 'reasoning': return { ...entry, id: limitUtf8Text(entry.id, 2_000), turnId: limitUtf8Text(entry.turnId, 2_000), text: limitUtf8Text(entry.text, 246_000) };
    case 'notice': return { ...entry, id: limitUtf8Text(entry.id, 2_000), text: limitUtf8Text(entry.text, 250_000) };
  }
}

function entryBytes(entry: AgentTuiConversationEntry): number { return Buffer.byteLength(JSON.stringify(entry), 'utf8'); }
function limitUtf8Text(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '\n[display truncated]';
  const contentLimit = maxBytes - Buffer.byteLength(marker, 'utf8');
  let end = Math.min(value.length, contentLimit);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > contentLimit) end -= 1;
  return `${value.slice(0, end)}${marker}`;
}

function localId(state: AgentTuiState, kind: string): string {
  return `${kind}:local:${String(state.nextLocalId)}`;
}
