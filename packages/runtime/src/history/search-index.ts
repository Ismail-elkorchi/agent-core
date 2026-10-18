import type { HistorySourceRef, HistorySearchPosition } from './contracts.js';

export interface IndexedHistorySource {
  readonly source: HistorySourceRef;
  readonly position: HistorySearchPosition;
}
export interface SearchWork {
  postings: number;
  candidates: number;
  readonly maxPostings: number;
  readonly maxCandidates: number;
}

/** Ordered, disposable substring candidates. Bodies and verified matches are never retained. */
export class HistorySearchIndex<T extends { readonly position: HistorySearchPosition } = IndexedHistorySource> {
  private readonly sources = new OrderedSources<T>();
  private readonly identities = new Set<string>();
  private readonly sourceKeys = new Map<T, { keys: ReadonlySet<number>; bytes: number }>();
  private readonly postings = new Map<number, OrderedSources<T>>();

  add(source: T, text: string): void {
    if (this.identities.has(source.position.entryId)) return;
    this.identities.add(source.position.entryId);
    this.sources.add(source);
    const keys = grams(text);
    this.sourceKeys.set(source, { keys, bytes: Buffer.byteLength(text) });
    for (const key of keys) {
      let posting = this.postings.get(key);
      if (!posting) this.postings.set(key, (posting = new OrderedSources<T>()));
      posting.add(source);
    }
  }

  /** Derived negative filter only; every candidate must still be verified against original bytes. */
  mayMatch(source: T, query: string): boolean {
    const indexed = this.sourceKeys.get(source);
    if (!indexed) return true;
    for (const key of grams(query)) if (!indexed.keys.has(key)) return false;
    return true;
  }

  /** New output in a formerly open run replaces only its indexed tail. */
  truncate(at: number, maxEntries: number, maxBytes: number) {
    let entries = 0, bytes = 0;
    while ((this.sources.last()?.position.at ?? -1) >= at) {
      const source = this.sources.last();
      if (!source) break;
      const indexed = this.sourceKeys.get(source);
      if (entries >= maxEntries || (indexed?.bytes ?? 0) > maxBytes - bytes) break;
      entries++; bytes += indexed?.bytes ?? 0;
      this.sources.delete(source.position);
      this.identities.delete(source.position.entryId);
      for (const key of indexed?.keys ?? []) {
        const posting = this.postings.get(key);
        posting?.delete(source.position);
        if (!posting?.size) this.postings.delete(key);
      }
      this.sourceKeys.delete(source);
    }
    return { entries, bytes, complete: (this.sources.last()?.position.at ?? -1) < at };
  }

  /** One rarest posting is a safe superset. Exact original verification rejects collisions and
   * other grams without an unbounded intersection or candidate-array allocation. */
  traversal(query: string, after?: HistorySearchPosition, direction: 1 | -1 = 1) {
    let selected = this.sources;
    for (const key of grams(query)) {
      const posting = this.postings.get(key);
      if (!posting) { selected = new OrderedSources<T>(); break; }
      if (posting.size < selected.size) selected = posting;
    }
    let next = selected.seek(after, direction);
    return {
      get complete() { return next === undefined; },
      next(work: SearchWork): T | undefined {
        if (!next || work.postings >= work.maxPostings || work.candidates >= work.maxCandidates) return undefined;
        work.postings++;
        work.candidates++;
        const value = next;
        next = selected.seek(value.position, direction);
        return value;
      }
    };
  }
}
interface Node<T> { value: T; left?: Node<T> | undefined; right?: Node<T> | undefined; height: number }
/** AVL postings provide worst-case logarithmic insertion and cursor seeking even for reverse builds. */
class OrderedSources<T extends { readonly position: HistorySearchPosition }> {
  private root: Node<T> | undefined;
  size = 0;
  add(value: T) { this.root = this.insert(this.root, value); this.size++; }
  delete(position: HistorySearchPosition) { this.root = this.remove(this.root, position); this.size--; }
  last() { let node = this.root; while (node?.right) node = node.right; return node?.value; }
  seek(after: HistorySearchPosition | undefined, direction: 1 | -1): T | undefined {
    let node = this.root, found: T | undefined;
    while (node) {
      const comparison = after === undefined ? direction : compareHistoryPositions(node.value.position, after);
      if (comparison * direction > 0) { found = node.value; node = direction === 1 ? node.left : node.right; }
      else node = direction === 1 ? node.right : node.left;
    }
    return found;
  }
  private insert(node: Node<T> | undefined, value: T): Node<T> {
    if (!node) return { value, height: 1 };
    if (compareHistoryPositions(value.position, node.value.position) < 0) node.left = this.insert(node.left, value);
    else node.right = this.insert(node.right, value);
    return balance(node);
  }
  private remove(node: Node<T> | undefined, position: HistorySearchPosition): Node<T> | undefined {
    if (!node) return undefined;
    const order = compareHistoryPositions(position, node.value.position);
    if (order < 0) node.left = this.remove(node.left, position);
    else if (order > 0) node.right = this.remove(node.right, position);
    else {
      if (!node.left) return node.right;
      if (!node.right) return node.left;
      let successor = node.right;
      while (successor.left) successor = successor.left;
      node.value = successor.value;
      node.right = this.remove(node.right, successor.value.position);
    }
    return balance(node);
  }
}
function height<T>(node: Node<T> | undefined) { return node?.height ?? 0; }
function update<T>(node: Node<T>) { node.height = 1 + Math.max(height(node.left), height(node.right)); }
function rotateLeft<T>(node: Node<T>): Node<T> {
  const root = node.right; if (!root) throw new Error('Invalid search index rotation.'); node.right = root.left; root.left = node; update(node); update(root); return root;
}
function rotateRight<T>(node: Node<T>): Node<T> {
  const root = node.left; if (!root) throw new Error('Invalid search index rotation.'); node.left = root.right; root.right = node; update(node); update(root); return root;
}
function balance<T>(node: Node<T>): Node<T> {
  update(node);
  if (node.left && height(node.left) - height(node.right) > 1) {
    if (height(node.left.left) < height(node.left.right)) node.left = rotateLeft(node.left);
    return rotateRight(node);
  }
  if (node.right && height(node.right) - height(node.left) > 1) {
    if (height(node.right.right) < height(node.right.left)) node.right = rotateRight(node.right);
    return rotateLeft(node);
  }
  return node;
}
export function compareHistoryPositions(a: HistorySearchPosition, b: HistorySearchPosition): number {
  return a.at - b.at || a.sequence - b.sequence || a.entryId.localeCompare(b.entryId);
}
function grams(text: string): Set<number> {
  const keys = new Set<number>();
  for (let at = 0; at + 2 < text.length; at++) {
    let hash = Math.imul(text.charCodeAt(at) ^ 2166136261, 16777619);
    hash = Math.imul(hash ^ text.charCodeAt(at + 1), 16777619);
    keys.add(Math.imul(hash ^ text.charCodeAt(at + 2), 16777619) >>> 0);
  }
  return keys;
}
