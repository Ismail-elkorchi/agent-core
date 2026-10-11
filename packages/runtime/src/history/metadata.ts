import type { SessionBranchEntry, SessionSourceMetadata } from '../session/contracts.js';
import type { HistoryFilter } from './contracts.js';

export function historyToolName(entry: SessionBranchEntry): string | undefined {
  if (entry.type === 'observation') return entry.toolName;
  if (entry.type !== 'tool_call') return undefined;
  const call = entry.call;
  return typeof call === 'object' && call !== null && !Array.isArray(call) &&
    'name' in call && typeof call.name === 'string'
    ? call.name
    : undefined;
}

export function matchesHistoryMetadata(
  metadata: Pick<SessionSourceMetadata, 'type' | 'runId' | 'timestamp' | 'toolName'>,
  filter?: HistoryFilter
): boolean {
  if (!filter) return true;
  if (filter.sourceType && filter.sourceType !== metadata.type) return false;
  if (filter.runId && metadata.runId !== filter.runId) return false;
  if (filter.toolName && metadata.toolName !== filter.toolName) return false;
  if (filter.afterTime && Date.parse(metadata.timestamp) < Date.parse(filter.afterTime)) return false;
  if (filter.beforeTime && Date.parse(metadata.timestamp) >= Date.parse(filter.beforeTime)) return false;
  const role = metadata.type === 'input' || metadata.type === 'steering' ? 'user'
    : metadata.type === 'assistant' || metadata.type === 'tool_call' ? 'assistant'
    : metadata.type === 'observation' ? 'tool' : 'control';
  return !filter.role || filter.role === role;
}
