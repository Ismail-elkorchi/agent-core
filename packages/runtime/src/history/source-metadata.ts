import type { SessionBranchEntry } from '../session/contracts.js';
import type { HistorySourceMetadata } from './contracts.js';
import { assistantResponseKey } from '../run/contracts.js';

export function historySourceFacts(entry: SessionBranchEntry): Omit<HistorySourceMetadata, 'source' | 'sourceBytes'> {
  const description = entry.type === 'input' ? entry.task
    : entry.type === 'assistant' || entry.type === 'steering' ? entry.content
    : entry.type === 'observation' ? `${entry.toolName}: ${entry.summary}`
    : entry.type === 'tool_call' ? JSON.stringify(entry.call) : entry.type;
  return Object.freeze({
    type: entry.type,
    description: description.slice(0, 200),
    ...('runId' in entry ? { runId: entry.runId } : {}),
    ...(entry.type === 'assistant' || entry.type === 'tool_call' || entry.type === 'observation'
      ? { exchangeId: assistantResponseKey(entry.runId, entry) } : {}),
    ...((entry.type === 'tool_call' || entry.type === 'observation') && entry.callIndex !== undefined
      ? { callIndex: entry.callIndex } : {}),
    ...((entry.type === 'tool_call' || entry.type === 'observation') && entry.toolBatchId !== undefined
      ? { toolBatchId: entry.toolBatchId } : {}),
    ...(entry.type === 'assistant' ? {
      ...(entry.contextRecovery ? { contextRecovery: true as const } : {}),
      expectedCalls: entry.output?.filter(item => item.type === 'tool_call').length ?? 0,
      prefixBound: !entry.contextRecovery && (entry.output?.some(item => item.type === 'protocol' && item.state.compatibility.requiresExactPrefix) ?? false)
    } : {})
  });
}

/** Announced calls and started calls remain obligations until their observations exist. */
export function incompleteHistoryExchange(items: readonly HistorySourceMetadata[]): boolean {
  if (items.some(item => item.contextRecovery)) return false;
  return items.some(item =>
    item.type === 'tool_call' && !items.some(other => other.type === 'observation' && other.toolBatchId === item.toolBatchId && other.callIndex === item.callIndex) ||
    item.type === 'assistant' && Array.from({ length: item.expectedCalls ?? 0 }, (_, i) => i).some(callIndex =>
      !items.some(other => other.type === 'observation' && other.callIndex === callIndex))
  );
}
