import type { HistorySourceRef } from './contracts.js';

export interface HistorySearchPosition {
  readonly at: number;
  readonly sequence: number;
  readonly entryId: string;
}
export interface IndexedHistorySource {
  readonly source: HistorySourceRef;
  readonly position: HistorySearchPosition;
}

/** Rebuildable substring candidates. Original bodies are never retained; every match is verified. */
export class HistorySearchIndex {
  private readonly sources: IndexedHistorySource[] = [];
  private readonly identities = new Set<string>();
  private readonly sourceKeys = new Map<IndexedHistorySource, ReadonlySet<number>>();
  private readonly postings = new Map<number, Set<IndexedHistorySource>>();

  add(source: IndexedHistorySource, text: string): void {
    const identity = `${source.source.entryId}:${source.source.sha256}`;
    if (this.identities.has(identity)) return;
    this.identities.add(identity);
    this.sources.push(source);
    const keys = grams(text);
    this.sourceKeys.set(source, keys);
    for (const key of keys) {
      let posting = this.postings.get(key);
      if (!posting) this.postings.set(key, (posting = new Set()));
      posting.add(source);
    }
  }

  /** New output in a formerly open run replaces only its indexed tail. */
  truncate(at: number): void {
    while ((this.sources.at(-1)?.position.at ?? -1) >= at) {
      const source = this.sources.pop();
      if (!source) break;
      this.identities.delete(`${source.source.entryId}:${source.source.sha256}`);
      for (const key of this.sourceKeys.get(source) ?? []) {
        const posting = this.postings.get(key);
        posting?.delete(source);
        if (!posting?.size) this.postings.delete(key);
      }
      this.sourceKeys.delete(source);
    }
  }

  candidates(query: string, after?: HistorySearchPosition): readonly IndexedHistorySource[] {
    const keys = [...grams(query)];
    const postings = keys.map((key) => this.postings.get(key));
    if (postings.some((posting) => !posting)) return [];
    const smallest = postings.reduce<Set<IndexedHistorySource> | undefined>(
      (a, b) => (a === undefined || (b !== undefined && b.size < a.size) ? b : a),
      undefined
    );
    const ids = smallest ?? this.sources;
    const result: IndexedHistorySource[] = [];
    for (const source of ids) {
      if (!postings.every((posting) => posting?.has(source))) continue;
      if (!after || compareHistoryPositions(source.position, after) > 0) result.push(source);
    }
    return result.sort((a, b) => compareHistoryPositions(a.position, b.position));
  }
}

export function compareHistoryPositions(
  a: HistorySearchPosition,
  b: HistorySearchPosition
): number {
  return a.at - b.at || a.sequence - b.sequence || a.entryId.localeCompare(b.entryId);
}
function grams(text: string): Set<number> {
  const keys = new Set<number>();
  for (let at = 0; at + 2 < text.length; at++) {
    // Hash collisions only produce candidates, never evidence or false exclusions.
    let hash = Math.imul(text.charCodeAt(at) ^ 2166136261, 16777619);
    hash = Math.imul(hash ^ text.charCodeAt(at + 1), 16777619);
    keys.add(Math.imul(hash ^ text.charCodeAt(at + 2), 16777619) >>> 0);
  }
  return keys;
}
