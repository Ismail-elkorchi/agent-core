import { hashJson } from '@agent-core/persistence';
import { SessionIndexStore, SessionIndexCorruptionError } from './projection-store-node.js';
import { canonicalJsonString, parseJsonObject, type JsonObject } from '@agent-core/json';
import * as z from 'zod';

const BUCKET_ENTRIES = 16;
const BUCKET_BYTES = 8 * 1024;
const CACHE_ENTRIES = 256;
const CACHE_BYTES = 2 * 1024 * 1024;
const bucketSchema = z.strictObject({kind: z.literal('bucket'), entries: z.array(z.strictObject({key: z.string(), value: z.unknown()})).min(1).max(BUCKET_ENTRIES)});
const nodeSchema = z.discriminatedUnion('kind', [bucketSchema,
  z.strictObject({kind: z.literal('branch'), children: z.record(z.string().regex(/^[a-f0-9]$/u), z.string().regex(/^[a-f0-9]{64}$/u))})
]);
type Node = z.infer<typeof nodeSchema>;
type Bucket = z.infer<typeof bucketSchema>;

export class SessionIndexNodeError extends Error {}

/** Persistent radix map with bounded buckets; historical roots share immutable nodes. */
export class SessionIndexTree {
  private staged: Map<string, Node> | undefined;
  private verified: Map<string, {node: Node; bytes: number}> | undefined;
  private verifiedBytes = 0;
  private writes: Set<string> | undefined;
  constructor(private readonly store: SessionIndexStore, private readonly namespace: string, private readonly onRead: (bytes: number) => void, private readonly readScope: <T>(operation: () => Promise<T>) => Promise<T>, private readonly retainVerified = false) {
    this.clearReadCache();
  }
  clearReadCache(): void {this.verified = this.retainVerified ? new Map() : undefined; this.verifiedBytes = 0;}
  cached(root: string | null, key: string): {readonly found: true; readonly value: unknown} | {readonly found: false} {
    const route = hashJson(key); let hash = root, depth = 0;
    while (hash !== null) {
      const node = this.verified?.get(hash)?.node;
      if (!node) return {found: false};
      if (node.kind === 'bucket') return {found: true, value: node.entries.find(entry => entry.key === key)?.value};
      const part = route[depth++];
      if (part === undefined) return {found: false};
      hash = node.children[part] ?? null;
    }
    return {found: true, value: undefined};
  }

  async get(root: string | null, key: string): Promise<unknown> {
    const route = hashJson(key);
    let hash = root;
    let depth = 0;
    while (hash !== null) {
      const node = await this.read(hash);
      if (node.kind === 'bucket') return node.entries.find(entry => entry.key === key)?.value;
      const part = route[depth++];
      if (part === undefined) throw new SessionIndexNodeError('Invalid projection tree depth.');
      hash = node.children[part] ?? null;
    }
    return undefined;
  }

  async set(root: string | null, key: string, value: JsonObject): Promise<string> {
    return this.setMany(root, [[key, value]]);
  }
  /** One changed path per batch, with no intermediate published roots. */
  async setMany(root: string | null, changes: readonly (readonly [string, JsonObject])[]): Promise<string> {
    const updates = [...new Map(changes)].map(([key, value]) => ({key, value, route: hashJson(key)}));
    const put = async (hash: string | null, items: typeof updates, depth: number): Promise<string> => {
      if (items.length === 0) {
        if (hash === null) throw new Error('Projection update has no value.');
        return hash;
      }
      const node = hash === null ? undefined : await this.read(hash);
      if (node?.kind !== 'branch') {
        const values = new Map(node?.entries.map(entry => [entry.key, {key: entry.key, value: parseJsonObject(entry.value), route: hashJson(entry.key)}]));
        for (const item of items) values.set(item.key, item);
        items = [...values.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        const bucket: Bucket = {kind: 'bucket', entries: items.map(({key, value}) => ({key, value}))};
        if (this.fits(bucket)) {
          if (hash !== null && hashJson(bucket) === hash) return hash;
          return this.write(bucket);
        }
      }
      const groups = new Map<string, typeof updates>();
      for (const item of items) {
        const part = item.route[depth];
        if (part === undefined) throw new SessionIndexNodeError('Projection key collision.');
        const group = groups.get(part);
        if (group) group.push(item); else groups.set(part, [item]);
      }
      const children = node?.kind === 'branch' ? {...node.children} : {};
      for (const [part, group] of groups) children[part] = await put(children[part] ?? null, group, depth + 1);
      if (node?.kind === 'branch' && hash !== null && hashJson(node.children) === hashJson(children)) return hash;
      return this.write({kind: 'branch', children});
    };
    return put(root, updates, 0);
  }

  async delete(root: string | null, key: string): Promise<string | null> {
    const route = hashJson(key);
    const remove = async (hash: string | null, depth: number): Promise<string | null> => {
      if (hash === null) return null;
      const node = await this.read(hash);
      if (node.kind === 'bucket') {
        const entries = node.entries.filter(entry => entry.key !== key);
        if (entries.length === node.entries.length) return hash;
        return entries.length === 0 ? null : this.write({kind: 'bucket', entries});
      }
      const part = route[depth];
      if (part === undefined) throw new SessionIndexNodeError('Invalid projection tree depth.');
      const previous = node.children[part];
      if (!previous) return hash;
      const child = await remove(previous, depth + 1);
      if (child === previous) return hash;
      const children = Object.fromEntries(Object.entries(node.children).filter(([key]) => key !== part));
      if (child !== null) children[part] = child;
      const remaining = Object.values(children);
      if (remaining.length === 0) return null;
      const only = remaining.length === 1 ? remaining[0] : undefined;
      if (only !== undefined && (await this.read(only)).kind === 'bucket') return only;
      return this.write({kind: 'branch', children});
    };
    return remove(root, 0);
  }

  async *entries(root: string | null): AsyncGenerator<readonly [string, unknown]> {
    if (root === null) return;
    const node = await this.read(root);
    if (node.kind === 'bucket') {for (const entry of node.entries) yield [entry.key, entry.value]; return;}
    for (const hash of Object.values(node.children)) yield* this.entries(hash);
  }

  /** Seek a stable hash-order cursor without visiting preceding subtrees. */
  async *entriesAfter(root: string | null, after?: string, prefix = ''): AsyncGenerator<readonly [string, unknown]> {
    if (root === null) return;
    const route = after === undefined ? undefined : hashJson(after);
    if (route !== undefined && prefix < route.slice(0, prefix.length)) return;
    const node = await this.read(root);
    if (node.kind === 'bucket') {
      const entries = [...node.entries].sort((a,b) => hashJson(a.key).localeCompare(hashJson(b.key)) || a.key.localeCompare(b.key));
      for (const entry of entries) {
        const hash = hashJson(entry.key);
        if (route !== undefined && (hash < route || (hash === route && entry.key <= (after ?? '')))) continue;
        yield [entry.key,entry.value];
      }
      return;
    }
    for (const part of Object.keys(node.children).sort()) yield* this.entriesAfter(node.children[part] ?? null, after, prefix + part);
  }

  /** Retire changed main-tree paths only, including buckets split into smaller descendants. */
  async retired(previous: string | null, next: string | null): Promise<readonly string[]> {
    const retired: string[] = [];
    const contains = async (root: string | null, wanted: string, key: string, depth: number): Promise<boolean> => {
      if (root === null) return false;
      if (root === wanted) return true;
      const node = await this.read(root);
      if (node.kind === 'bucket') return false;
      const part = hashJson(key)[depth];
      if (part === undefined) throw new SessionIndexNodeError('Invalid projection tree depth.');
      return contains(node.children[part] ?? null, wanted, key, depth + 1);
    };
    const compare = async (before: string | null, after: string | null, depth: number): Promise<void> => {
      if (before === null || before === after) return;
      const node = await this.read(before);
      if (node.kind === 'bucket') {
        const first = node.entries[0];
        if (!first) throw new SessionIndexNodeError('Empty projection bucket.');
        if (!await contains(after, before, first.key, depth)) retired.push(before);
        return;
      }
      retired.push(before);
      const replacement = after === null ? undefined : await this.read(after);
      for (const [part, child] of Object.entries(node.children))
        await compare(child, replacement?.kind === 'branch' ? replacement.children[part] ?? null : after, depth + 1);
    };
    await compare(previous, next, 0);
    return retired;
  }
  removeNodes(hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) if (!/^[a-f0-9]{64}$/u.test(hash)) throw new SessionIndexNodeError('Invalid retired node identity.');
    this.store.remove(this.namespace, hashes); return Promise.resolve();
  }

  private fits(bucket: Bucket): boolean {
    return bucket.entries.length === 1 || (bucket.entries.length <= BUCKET_ENTRIES && Buffer.byteLength(canonicalJsonString(bucket)) <= BUCKET_BYTES);
  }
  private remember(hash: string, node: Node, bytes: number): void {
    if (!this.verified || bytes > CACHE_BYTES) return;
    while (this.verified.size >= CACHE_ENTRIES || this.verifiedBytes + bytes > CACHE_BYTES) {
      const oldest = this.verified.keys().next().value;
      if (oldest === undefined) break;
      this.verifiedBytes -= this.verified.get(oldest)?.bytes ?? 0; this.verified.delete(oldest);
    }
    const prior = this.verified.get(hash); if (prior) this.verifiedBytes -= prior.bytes;
    const owned = parseJsonObject(node, {maxDepth: 64, maxCollectionEntries: 50_000, maxStringBytes: 16 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024}) as Node;
    this.verified.set(hash, {node: owned, bytes}); this.verifiedBytes += bytes;
  }
  private async read(hash: string): Promise<Node> {
    const owned = this.staged?.get(hash) ?? this.verified?.get(hash)?.node;
    if (owned) return owned;
    try {
      const stored = await this.readScope(() => Promise.resolve(this.store.read(this.namespace, hash)));
      if (!stored) throw Object.assign(new Error('Missing projection node.'), {code: 'ENOENT'});
      const {value, bytes} = stored;
      this.onRead(bytes);
      const node = nodeSchema.parse(value);
      if (node.kind === 'bucket' && (!this.fits(node) || new Set(node.entries.map(entry => entry.key)).size !== node.entries.length)) throw new SessionIndexNodeError('Invalid projection bucket bounds or identity.');
      this.remember(hash, node, bytes); return node;
    } catch (cause) {
      const sqliteCode = (cause as {errcode?: number}).errcode;
      const code = sqliteCode === undefined ? undefined : sqliteCode & 255;
      if (!(code === 11 || code === 26 || (cause as NodeJS.ErrnoException).code === 'ENOENT' || cause instanceof TypeError || cause instanceof SyntaxError || cause instanceof z.ZodError || cause instanceof SessionIndexNodeError || cause instanceof SessionIndexCorruptionError)) throw cause;
      throw new SessionIndexNodeError('Projection node is missing, corrupt, or incompatible.', {cause});}
  }
  begin(): void {
    if (this.staged) throw new Error('Projection transaction already active.');
    this.staged = new Map();
    if (!this.retainVerified) {this.verified = new Map(); this.verifiedBytes = 0;}
    this.writes = undefined;
  }
  discard(): void {
    this.staged = undefined;
    if (!this.retainVerified) {this.verified = undefined; this.verifiedBytes = 0;}
    this.writes = undefined;
  }
  private prepareWrites(): void {
    this.writes = new Set();
    for (const hash of this.staged?.keys() ?? []) {
      if (this.verified?.has(hash)) continue;
      try {
        const stored = this.store.read(this.namespace, hash);
      if (!stored) throw Object.assign(new Error('Missing projection node.'), {code: 'ENOENT'});
      const {value, bytes} = stored;
        this.onRead(bytes); this.remember(hash, nodeSchema.parse(value), bytes);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && !(error instanceof TypeError || error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
        this.writes.add(hash);
      }
    }
  }
  flush(): Promise<void> {
    this.prepareWrites();
    const values = [...this.staged ?? []].filter(([hash]) => this.writes?.has(hash)).map(([, node]) => parseJsonObject(node));
    this.store.write(this.namespace, values);
    this.discard(); return Promise.resolve();
  }
  private write(node: Node): Promise<string> {
    const value = parseJsonObject(node), hash = hashJson(value);
    if (this.staged) {this.staged.set(hash, node); return Promise.resolve(hash);}
    this.store.write(this.namespace, [value]); return Promise.resolve(hash);
  }
}
