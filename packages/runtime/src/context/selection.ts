import type { SessionBranchEntry } from '../session/contracts.js';
import { assistantResponseKey } from '../run/contracts.js';

/** Recent originals are removable in whole contributions or complete response/tool exchanges. */
export function contextSourceGroups(
  entries: readonly SessionBranchEntry[]
): SessionBranchEntry[][] {
  const groups: SessionBranchEntry[][] = [];
  const responses = new Map<string, SessionBranchEntry[]>();
  for (const entry of entries) {
    if (entry.type === 'input' || entry.type === 'steering') groups.push([entry]);
    else if (
      entry.type === 'assistant' ||
      entry.type === 'tool_call' ||
      entry.type === 'observation'
    ) {
      const key = assistantResponseKey(entry.runId, entry);
      let group = responses.get(key);
      if (!group) {
        group = [];
        responses.set(key, group);
        groups.push(group);
      }
      group.push(entry);
    }
  }
  const retained: SessionBranchEntry[][] = [];
  for (const group of groups) {
    const requiresPrefix = group.some(
      (entry) =>
        entry.type === 'assistant' &&
        entry.output?.some(
          (item) => item.type === 'protocol' && item.state.compatibility.requiresExactPrefix
        )
    );
    // Required native replay binds a response to its preceding originals. Remove
    // that prefix and its dependent exchanges together, never orphan the state.
    if (requiresPrefix) retained.splice(0, retained.length, [...retained.flat(), ...group]);
    else retained.push(group);
  }
  return retained;
}
