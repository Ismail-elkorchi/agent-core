import { incompleteHistoryExchange } from '../history/source-metadata.js';
import { selectedHistoryMetadata } from './inspection.js';
import { ContextSourceCapacityError } from '../run/context-admission.js';
import type { HistoryReader } from '../history/reader.js';
import type { HistorySourceCut, HistorySourceRef, HistorySourceMetadata } from '../history/contracts.js';

/** Complete exchanges and native prefix dependencies form source-change units. */
export function contextMetadataGroups(items: readonly HistorySourceMetadata[], fresh = false): HistorySourceMetadata[][] {
  const groups: HistorySourceMetadata[][] = [];
  const responses = new Map<string, HistorySourceMetadata[]>();
  for (const item of items) {
    if (item.type === 'input' || item.type === 'steering' || item.type === 'peer_contribution') groups.push([item]);
    else if (item.exchangeId) {
      let group = responses.get(item.exchangeId);
      if (!group) { group = []; responses.set(item.exchangeId, group); groups.push(group); }
      group.push(item);
    }
  }
  const retained: HistorySourceMetadata[][] = [];
  for (const group of groups) {
    if (!fresh && group.some(item => item.prefixBound && !item.contextRecovery)) retained.splice(0, retained.length, [...retained.flat(), ...group]);
    else retained.push(group);
  }
  return retained;
}

/** Validate protocol obligations using routing metadata, including groups being discarded. */
export async function assertContextProtocolClosure(
  history: HistoryReader,
  cut: HistorySourceCut,
  retained: readonly HistorySourceRef[],
  portableSources: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
  freshReset = false
): Promise<void> {
  const ids = new Set(retained.map(source => source.entryId));
  const checked = new Map<string, boolean>();
  const historicalPrefixes = new Set<string>();
  const prefixSources: HistorySourceRef[] = [];
  const checkExchange = async (item: HistorySourceMetadata): Promise<boolean> => {
    if (!item.exchangeId) return false;
    const known = checked.get(item.exchangeId);
    if (known !== undefined) return known;
    signal?.throwIfAborted();
    if (checked.size >= 1000) {
      const first = checked.keys().next().value;
      if (first !== undefined) checked.delete(first);
    }
    const exchange = await history.exchangeMetadata(item.source, cut);
    if (exchange.coverage !== 'complete')
      throw new ContextSourceCapacityError(cut, { unit: 'records', limit: 1000, observedAtLeast: 1001 }, item.source);
    const recovery = exchange.items.some(member => member.contextRecovery);
    checked.set(item.exchangeId, recovery);
    if (recovery) return true;
    const present = exchange.items.filter(member => ids.has(member.source.entryId));
    const incomplete = incompleteHistoryExchange(exchange.items);
    if (present.length !== exchange.items.length && (present.length > 0 || incomplete))
      throw new Error(incomplete
        ? 'An unfinished tool exchange cannot be released from context.'
        : 'Context selection must retain or release the complete tool exchange.');
    return false;
  };
  // Explicit additions can name sources outside the current window. They obey the same closure.
  for (const source of retained) {
    signal?.throwIfAborted();
    const item = await history.metadata(source, cut);
    if (!item) throw new Error('Selected source is unavailable on this branch.');
    if (await checkExchange(item)) continue;
    if (item.prefixBound && !portableSources.has(source.entryId)) {
      historicalPrefixes.add(source.entryId);
      prefixSources.push(source);
    }
  }
  const latestPrefix = (await history.orderSources(prefixSources, cut)).at(-1);
  for await (const item of selectedHistoryMetadata(history, cut)) {
    signal?.throwIfAborted();
    if (await checkExchange(item)) continue;
    historicalPrefixes.delete(item.source.entryId);
    if (item.prefixBound && !ids.has(item.source.entryId) && !portableSources.has(item.source.entryId) && !freshReset)
      throw new Error('Releasing native protocol state requires an explicit fresh continuation.');
    if (latestPrefix && !ids.has(item.source.entryId) && ['input', 'steering', 'peer_contribution', 'assistant', 'tool_call', 'observation'].includes(item.type)) {
      const order = await history.orderSources([item.source, latestPrefix], cut);
      if (order[0]?.entryId === item.source.entryId)
        throw new Error('Selected native protocol state requires its complete preceding source prefix.');
    }
  }
  if (historicalPrefixes.size)
    throw new Error('Historical native protocol state requires a validated fresh continuation before reintroduction.');
}
