import type { SessionBranchEntry, SessionSourceMetadata } from '../session/contracts.js';
import type { HistoryFilter, HistoryItem } from './contracts.js';

export function historyToolName(entry: SessionBranchEntry): string | undefined {
  if (entry.type === 'observation') return entry.toolName;
  if (entry.type !== 'tool_call') return undefined;
  const call = entry.call;
  return typeof call === 'object' && call !== null && !Array.isArray(call) &&
    'name' in call && typeof call.name === 'string'
    ? call.name
    : undefined;
}

/** Authorship is separate from user-role framing in provider protocols. */
export function historyInputAuthorship(entry: SessionBranchEntry): 'model' | undefined {
  return (entry.type === 'input' || entry.type === 'steering') && entry.originalInput?.origin ? 'model' : undefined;
}

export function historyMetadataRole(metadata: Pick<SessionSourceMetadata, 'type' | 'inputAuthorship'>): HistoryItem['role'] {
  return metadata.type === 'input' || metadata.type === 'steering'
    ? metadata.inputAuthorship === 'model' ? 'assistant' : 'user'
    : metadata.type === 'assistant' || metadata.type === 'tool_call' || metadata.type === 'peer_contribution' ? 'assistant'
    : metadata.type === 'observation' ? 'tool' : 'control';
}

export function matchesHistoryMetadata(
  metadata: Pick<SessionSourceMetadata, 'type' | 'runId' | 'timestamp' | 'toolName' | 'inputAuthorship'>,
  filter?: HistoryFilter
): boolean {
  if (!filter) return true;
  if (filter.sourceType && filter.sourceType !== metadata.type) return false;
  if (filter.runId && metadata.runId !== filter.runId) return false;
  if (filter.toolName && metadata.toolName !== filter.toolName) return false;
  if (filter.afterTime && Date.parse(metadata.timestamp) < Date.parse(filter.afterTime)) return false;
  if (filter.beforeTime && Date.parse(metadata.timestamp) >= Date.parse(filter.beforeTime)) return false;
  return !filter.role || filter.role === historyMetadataRole(metadata);
}
