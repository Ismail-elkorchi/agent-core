import type { ConversationActivityEntry, ConversationEntry } from './conversation.js';

/** Ephemeral display projection. Members remain the original recorded/live entries. */
export interface ConversationActivityGroup {
  readonly kind: 'activity-group';
  /** Synthetic identity distinguishes group-relative rows from member-relative rows. */
  readonly id: string;
  /** Group disclosure does not change any member's disclosure preference. */
  readonly toggleId: string;
  readonly members: readonly ConversationActivityEntry[];
  readonly summary: string;
}

export type ConversationDisplayEntry = ConversationEntry | ConversationActivityGroup;

/** Nested disclosure invalidates only its own group's retained view. */
export function conversationDisplayKey(
  entry: ConversationDisplayEntry,
  columns: number,
  expandedIds: readonly string[]
): string {
  return `${String(columns)}:${entry.kind === 'activity-group'
    ? entry.members.map((member) => expandedIds.includes(`activity-member:${member.id}`) ? '1' : '0').join('')
    : ''}`;
}

export interface ActivityGroupingOptions {
  /** Applications classify known tools; labels and output text never determine membership. */
  readonly classify: (entry: ConversationActivityEntry) => string | undefined;
  /** An inspected, focused or individually expanded entry stays independently addressable. */
  readonly preserveIds?: readonly string[];
}

/** A lifecycle-owned view cache, bounded to the groups in the latest rendered page. */
export class ConversationGroupingPresentation {
  private groups = new Map<string, ConversationActivityGroup>();

  project(
    entries: readonly ConversationEntry[],
    options: ActivityGroupingOptions
  ): readonly ConversationDisplayEntry[] {
    const retained = new Map<string, ConversationActivityGroup>();
    const display = projectConversationDisplay(entries, options).map((entry) => {
      if (entry.kind !== 'activity-group') return entry;
      const previous = this.groups.get(entry.id);
      const group =
        previous?.summary === entry.summary &&
        previous.members.length === entry.members.length &&
        previous.members.every((member, index) => member === entry.members[index])
          ? previous
          : entry;
      retained.set(group.id, group);
      return group;
    });
    this.groups = retained;
    return display;
  }
}

/**
 * Compress adjacent, settled, successful activity in the same run. This projection never
 * reorders events, crosses an intervening message, or conceals an active/error/uncertain row.
 * Counts describe calls, not files, patterns, effects or inferred outcomes.
 */
export function projectConversationDisplay(
  entries: readonly ConversationEntry[],
  options: ActivityGroupingOptions
): readonly ConversationDisplayEntry[] {
  const result: ConversationDisplayEntry[] = [];
  const preserved = new Set(options.preserveIds);
  let members: ConversationActivityEntry[] = [];
  let categories: string[] = [];
  const flush = () => {
    const first = members[0];
    if (first === undefined) return;
    if (members.length === 1) result.push(first);
    else {
      const counts = new Map<string, number>();
      for (const category of categories) counts.set(category, (counts.get(category) ?? 0) + 1);
      result.push({
        kind: 'activity-group',
        id: `activity-group:${first.id}`,
        toggleId: `activity-group:${first.id}`,
        members,
        summary: [...counts].map(([category, count]) => `${String(count)} ${category} call${count === 1 ? '' : 's'}`).join(' · ')
      });
    }
    members = [];
    categories = [];
  };
  for (const entry of entries) {
    const category =
      entry.kind === 'activity' &&
      entry.activity === 'tool' &&
      entry.toolName !== undefined &&
      (entry.status === 'complete' || entry.status === 'success') &&
      !preserved.has(entry.id)
        ? options.classify(entry)
        : undefined;
    if (category === undefined || entry.kind !== 'activity') {
      flush();
      result.push(entry);
      continue;
    }
    // Restored group anchors establish a boundary even when older calls are prepended.
    if (preserved.has(`activity-group:${entry.id}`)) flush();
    if (members[0] !== undefined && members[0].runId !== entry.runId) flush();
    members.push(entry);
    categories.push(category);
  }
  flush();
  return result;
}
