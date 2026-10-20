import { peerContributionText } from './peer-contribution.js';
import { HistorySearchIndex } from '../history/search-index.js';
import type { HistorySearchPosition } from '../history/contracts.js';
import { hashJson } from '@agent-core/persistence';
import { historySourceFacts } from '../history/source-metadata.js';
import { historyInputAuthorship, historyToolName } from '../history/metadata.js';
import { entryIdentity } from '../history/ledger.js';
import type {
  SessionSourceMetadata,
  SessionSourceSnapshot,
  SessionRunFinalization,
  SessionRunFinalizationConfirmation,
  SessionBranchBoundary,
  SessionBranchEntry,
  SessionBranchPage,
  SessionBranchPageRequest,
  SessionBranchSearchRequest,
  SessionBranchSearchResult
} from './contracts.js';

export interface BranchEntryPosition {
  readonly inputAuthorship?: 'model' | 'host';
  readonly depth: number;
  readonly ancestors: readonly string[];
  readonly context: SessionSourceMetadata['context'];
  readonly timestamp: string;
  readonly toolName?: string;
  readonly identity: string;
  readonly type: SessionBranchEntry['type'];
  readonly runId?: string;
  readonly source?: SessionBranchEntry['source'];
  readonly fromEntryId?: string | null;
  readonly historyPosition?: import('../history/contracts.js').HistorySourceCut;
  readonly parentId: string | null;
  readonly hash: string;
  readonly bytes: number;
}

export interface BranchPageSource {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly positions: ReadonlyMap<string, BranchEntryPosition>;
  /** Validate this captured source once at each public operation boundary. */
  validate(): Promise<void>;
  readPosition(entryId: string): Promise<BranchEntryPosition | undefined>;
  read(entryId: string): Promise<SessionBranchEntry>;
}

class UnknownHistoryEntryError extends Error {}

async function asyncPosition(source: BranchPageSource, id: string): Promise<BranchEntryPosition> {
  const value = await source.readPosition(id);
  if (!value) throw new UnknownHistoryEntryError(`Unknown history entry: ${id}`);
  return value;
}
async function asyncBoundary(source: BranchPageSource, leafId = source.leafId,
  read = (id: string) => asyncPosition(source, id)): Promise<SessionBranchBoundary> {
  return Object.freeze({ sessionId: source.sessionId, leafId,
    leafHash: leafId === null ? null : (await read(leafId)).hash });
}
/** Navigate already-validated owned metadata without materializing preceding history. */
export async function branchNavigation(source: BranchPageSource, boundary: SessionBranchBoundary,
  read = (id: string) => asyncPosition(source, id)) {
  const leaf = boundary.leafId === null ? undefined : await read(boundary.leafId);
  if (boundary.sessionId !== source.sessionId || (leaf?.hash ?? null) !== boundary.leafHash)
    throw new Error('History boundary does not match its source.');
  const length = (leaf?.depth ?? -1) + 1;
  const at = async (depth: number) => {
    if (depth < 0 || depth >= length || boundary.leafId === null) return undefined;
    let id = boundary.leafId;
    let distance = length - depth - 1;
    for (let bit = 0; distance > 0; bit++, distance = Math.floor(distance / 2)) {
      if (distance % 2 === 0) continue;
      const ancestor = (await read(id)).ancestors[bit];
      if (ancestor === undefined) throw new Error('Invalid history ancestry projection.');
      id = ancestor;
    }
    return { metadata: { ...await read(id), entryId: id } };
  };
  const contains = async (id: string) => {
    try {
      const metadata = await read(id);
      return (await at(metadata.depth))?.metadata.entryId === id;
    } catch (error) {
      if (error instanceof UnknownHistoryEntryError) return false;
      throw error;
    }
  };
  return { length, at, contains,
    position: async (id: string) => await contains(id) ? (await read(id)).depth : undefined };
}
export async function assertBranchEntry(
  source: BranchPageSource,
  boundary: SessionBranchBoundary,
  entryId: string
): Promise<void> {
  await source.validate();
  if (!(await (await branchNavigation(source, boundary)).contains(entryId)))
    throw new Error(`History entry is outside the selected branch: ${entryId}`);
}

export async function readBranchPage(
  source: BranchPageSource,
  request: SessionBranchPageRequest = {}
): Promise<SessionBranchPage> {
  await source.validate();
  const limit = boundedInteger(request.limit ?? 64, 256, 'History page entry limit');
  const maxBytes = boundedInteger(
    request.maxBytes ?? 256 * 1024,
    8 * 1024 * 1024,
    'History page byte limit'
  );
  const boundary = request.cursor?.boundary ?? await asyncBoundary(source, request.leafId);
  const next = request.cursor?.entryId ?? boundary.leafId;
  const path = await branchNavigation(source, boundary);
  if (next !== null) {
    if (!(await path.contains(next)))
      throw new Error(`History entry is outside the selected branch: ${next}`);
  } else if (boundary.sessionId !== source.sessionId || boundary.leafHash !== null)
    throw new Error('Invalid empty history boundary.');
  const entries: SessionBranchEntry[] = [];
  const step = request.direction === 'newer' ? 1 : -1;
  let index = next === null ? -1 : (await path.position(next) ?? -1);
  let first = index;
  let last = index;
  let bytes = 0;
  let oversizedEntry: SessionBranchPage['oversizedEntry'];
  while (index >= 0 && index < path.length && entries.length < limit) {
    const entryId = (await path.at(index))?.metadata.entryId;
    if (entryId === undefined) break;
    const metadata = await asyncPosition(source, entryId);
    if (metadata.bytes > maxBytes && entries.length === 0) {
      oversizedEntry = Object.freeze({ entryId, bytes: metadata.bytes });
      break;
    }
    if (bytes + metadata.bytes > maxBytes) break;
    entries.push(await source.read(entryId));
    bytes += metadata.bytes;
    first = Math.min(first, index);
    last = Math.max(last, index);
    index += step;
  }
  const older = (await path.at(first - 1))?.metadata.entryId;
  const newer = (await path.at(last + 1))?.metadata.entryId;
  return Object.freeze({
    boundary,
    entries: Object.freeze(step < 0 ? entries.reverse() : entries),
    ...(oversizedEntry === undefined ? {} : { oversizedEntry }),
    ...(older === undefined ? {} : { older: Object.freeze({ boundary, entryId: older }) }),
    ...(newer === undefined ? {} : { newer: Object.freeze({ boundary, entryId: newer }) })
  });
}

class BranchSearchMetadataLimit extends Error {}

interface BranchSearchSource {
  readonly position: HistorySearchPosition;
  readonly hash: string;
}
const branchSearchIndexes = new WeakMap<BranchPageSource['positions'], {
  readonly index: HistorySearchIndex<BranchSearchSource>;
  readonly indexed: Set<string>;
  readonly boundaries: Map<string | null, { next: string | null; partialStart: boolean }>;
}>();

/** UI text has its own projection; candidates are always verified with captured originals. */
export async function searchBranch(
  source: BranchPageSource,
  request: SessionBranchSearchRequest
): Promise<SessionBranchSearchResult> {
  request.signal?.throwIfAborted();
  await source.validate();
  request.signal?.throwIfAborted();
  if (request.query.length === 0 || request.query.length > 4096)
    throw new Error('History search requires between 1 and 4096 characters.');
  if (request.cursor !== undefined && request.cursor.query !== request.query)
    throw new Error('History search cursor belongs to a different query.');
  const limit = boundedInteger(request.limit ?? 64, 256, 'History search result limit');
  const maxBytes = boundedInteger(request.maxScannedBytes ?? 256 * 1024, 8 * 1024 * 1024, 'History search source byte limit');
  const maxResultBytes = boundedInteger(request.maxBytes ?? 256 * 1024, 8 * 1024 * 1024, 'History search result byte limit');
  const maxIndexBytes = boundedInteger(request.maxIndexBytes ?? 256 * 1024, 8 * 1024 * 1024, 'History search index byte limit');
  const maxIndexEntries = boundedInteger(request.maxIndexEntries ?? 64, 1000, 'History search index build limit');
  const work = { postings: 0, candidates: 0,
    maxPostings: boundedInteger(request.maxPostings ?? 1000, 10000, 'History search posting limit'),
    maxCandidates: boundedInteger(request.maxCandidates ?? 1000, 10000, 'History search candidate limit') };
  const maxMetadataVisits = boundedInteger(request.maxMetadataVisits ?? 1000, 10000, 'History metadata visit limit');
  if (maxMetadataVisits < 128) throw new RangeError('History metadata visit limit must be at least 128.');
  let metadataVisited = 0;
  const metadataCache = new Map<string, BranchEntryPosition>();
  const metadataFor = async (id: string) => {
    request.signal?.throwIfAborted();
    let value = metadataCache.get(id);
    if (!value) {
      if (metadataVisited >= maxMetadataVisits) throw new BranchSearchMetadataLimit();
      metadataVisited++;
      value = await asyncPosition(source, id);
      metadataCache.set(id, value);
    }
    return value;
  };
  const boundary = request.cursor?.boundary ?? await asyncBoundary(source, request.leafId, metadataFor);
  const path = await branchNavigation(source, boundary, metadataFor);
  if (request.cursor && !(await path.contains(request.cursor.entryId)))
    throw new Error('Search cursor is outside the selected branch.');
  let projection = branchSearchIndexes.get(source.positions);
  if (!projection) {
    projection = { index: new HistorySearchIndex<BranchSearchSource>(), indexed: new Set(), boundaries: new Map() };
    branchSearchIndexes.set(source.positions, projection);
  }
  let build = projection.boundaries.get(boundary.leafId);
  if (!build || (!request.cursor && build.partialStart)) {
    build = { next: request.cursor?.entryId ?? boundary.leafId, partialStart: request.cursor !== undefined };
    projection.boundaries.set(boundary.leafId, build);
  }
  let next = request.cursor?.entryId ?? boundary.leafId;
  let after = request.cursor?.after;
  let scannedBytes = 0, indexed = 0, indexBytes = 0, bytes = 0;
  let oversizedEntry: SessionBranchSearchResult['oversizedEntry'];
  const matches: { entryId: string; excerpt: string }[] = [];
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ boundary,
    older: { boundary, entryId: next, query: request.query,
      after: { at: path.length, sequence: -1, entryId: next } } })) + 256;
  const loaded = new Map<string, SessionBranchEntry>();
  const read = async (id: string) => {
    const cached = loaded.get(id);
    if (cached) return cached;
    const metadata = await metadataFor(id);
    if (metadata.bytes > maxBytes - scannedBytes) {
      if (metadata.bytes > maxBytes) oversizedEntry = { entryId: id, bytes: metadata.bytes };
      return undefined;
    }
    request.signal?.throwIfAborted();
    const entry = await source.read(id);
    request.signal?.throwIfAborted();
    if (hashJson(entry) !== metadata.hash) throw new Error('Session history source identity changed.');
    scannedBytes += metadata.bytes;
    loaded.set(id, entry);
    return entry;
  };
  try {
  while (next !== null && matches.length < limit) {
    request.signal?.throwIfAborted();
    const depth = await path.position(next);
    if (depth === undefined) throw new Error('Search cursor is outside the selected branch.');
    // A prior captured leaf certifies its already-built contiguous ancestry, so an append
    // does not revisit the old branch metadata merely to discover there is nothing new.
    if (build.next !== null) {
      const ancestor = projection.boundaries.get(build.next);
      if (ancestor && ancestor !== build && !ancestor.partialStart) build.next = ancestor.next;
    }
    const buildDepth = build.next === null ? -1 : await path.position(build.next);
    if (buildDepth === undefined) throw new Error('Search projection boundary changed.');
    // Populate the next contiguous section, charging even already-indexed metadata visits.
    if (depth <= buildDepth) {
      if (indexed >= maxIndexEntries) break;
      const id = build.next;
      if (id === null) break;
      const metadata = await metadataFor(id);
      if (!projection.indexed.has(id) && metadata.bytes > maxIndexBytes - indexBytes) {
        if (metadata.bytes > maxBytes)
          oversizedEntry = { entryId: id, bytes: metadata.bytes };
        break;
      }
      indexed++;
      if (!projection.indexed.has(id)) {
        const entry = await read(id);
        if (!entry) break;
        indexBytes += metadata.bytes;
        projection.index.add({ position: { at: buildDepth, sequence: -1, entryId: id }, hash: metadata.hash }, branchEntryText(entry));
        projection.indexed.add(id);
      }
      build.next = metadata.parentId;
      continue;
    }
    const traversal = projection.index.traversal(request.query, after ?? { at: depth + 1, sequence: -1, entryId: '' }, -1);
    const candidate = traversal.next(work);
    if (!candidate) {
      if (!traversal.complete) break;
      next = build.next;
      after = undefined;
      continue;
    }
    // Rejected fork postings still advance the resumable CPU cursor.
    if (!(await path.contains(candidate.position.entryId))) { after = candidate.position; continue; }
    // Do not skip an unbuilt ancestor even if another captured boundary indexed older bodies.
    if (candidate.position.at <= buildDepth) { next = build.next; after = undefined; continue; }
    const entry = await read(candidate.position.entryId);
    if (!entry) break;
    const text = branchEntryText(entry), match = text.indexOf(request.query);
    if (match >= 0) {
      const hit = { entryId: entry.id, excerpt: branchExcerpt(text, match, request.query.length) };
      const size = Buffer.byteLength(JSON.stringify(hit));
      if (size > maxResultBytes - envelopeBytes - bytes) {
        if (!matches.length) throw new RangeError('History result byte limit cannot fit one match.');
        break;
      }
      bytes += size; matches.push(hit);
    }
    next = entry.parentId;
    after = candidate.position;
  }
  } catch (error) {
    if (!(error instanceof BranchSearchMetadataLimit)) throw error;
  }
  request.signal?.throwIfAborted();
  const result = {
    boundary, matches: Object.freeze(matches), scannedBytes, indexed, indexBytes, bytes: 0,
    postings: work.postings, candidates: work.candidates, metadataVisited,
    coverage: next === null ? 'complete' as const : 'partial' as const,
    ...(oversizedEntry ? { oversizedEntry } : {}),
    ...(next === null ? {} : { older: Object.freeze({ boundary, entryId: next, query: request.query, ...(after ? { after } : {}) }) })
  };
  // Include the boundary and continuation, not only excerpts, in the returned byte allowance.
  for (;;) {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size === result.bytes) break;
    result.bytes = size;
  }
  if (result.bytes > maxResultBytes)
    throw new RangeError('History result byte limit cannot fit its matches and continuation.');
  return Object.freeze(result);
}

const memoryPositions = new WeakMap<
  readonly SessionBranchEntry[],
  {
    readonly byId: Map<string, SessionBranchEntry>;
    readonly positions: Map<string, BranchEntryPosition>;
    count: number;
  }
>();

export function memoryBranchSource(
  sessionId: string,
  entries: readonly SessionBranchEntry[]
): BranchPageSource {
  let index = memoryPositions.get(entries);
  if (index === undefined) {
    index = { byId: new Map(), positions: new Map(), count: 0 };
    memoryPositions.set(entries, index);
  }
  for (const entry of entries.slice(index.count)) {
    index.byId.set(entry.id, entry);
    const parent = entry.parentId === null ? undefined : index.positions.get(entry.parentId);
    const ancestors = entry.parentId === null ? [] : [entry.parentId];
    for (let level = 0; ; level++) {
      const id = ancestors[level];
      const ancestor = id === undefined ? undefined : index.positions.get(id)?.ancestors[level];
      if (ancestor === undefined) break;
      ancestors.push(ancestor);
    }
    index.positions.set(entry.id, {
      depth: (parent?.depth ?? -1) + 1, ancestors: Object.freeze(ancestors),
      ...branchEntryMetadata(entry),
      parentId: entry.parentId,
      hash: hashJson(entry),
      bytes: Buffer.byteLength(JSON.stringify(entry))
    });
  }
  index.count = entries.length;
  const { byId, positions } = index;
  const source: BranchPageSource = {
    sessionId,
    leafId: entries.at(-1)?.id ?? null,
    positions,
    validate: () => Promise.resolve(),
    readPosition: (entryId) => Promise.resolve(positions.get(entryId)),
    read(entryId) {
      const entry = byId.get(entryId);
      if (entry === undefined) throw new Error(`Unknown history entry: ${entryId}`);
      return Promise.resolve(entry);
    }
  };
  memorySourceIndex(source);
  return source;
}

function position(source: BranchPageSource, entryId: string): BranchEntryPosition {
  const entry = source.positions.get(entryId);
  if (entry === undefined) throw new Error(`Unknown history entry: ${entryId}`);
  return entry;
}

interface IndexedBranchMetadata {
  readonly metadata: SessionSourceMetadata;
  readonly depth: number;
  readonly branchId: string;
  readonly latestContext: SessionSourceMetadata | undefined;
  readonly inheritedHeads: Awaited<SessionSourceSnapshot['inheritedHeads']>;
}

/** Incremental in-memory routing facts; ancestry belongs to the canonical source projection. */
class BranchSourceIndex {
  readonly nodes = new Map<string, IndexedBranchMetadata>();
  readonly identities = new Map<string, IndexedBranchMetadata[]>();
  readonly exchanges = new Map<string, IndexedBranchMetadata[]>();
  readonly sources = new Map<string, IndexedBranchMetadata[]>();
  readonly runs = new Map<string, IndexedBranchMetadata[]>();
  readonly inputs = new Map<string, IndexedBranchMetadata[]>();
  readonly pending = new Map<string, IndexedBranchMetadata[]>();
  readonly capturePending = new Set<string>();
  readonly confirmations: SessionRunFinalizationConfirmation[] = [];
  readonly confirmed = new Map<string, { at: number; proof: SessionRunFinalizationConfirmation }>();
  readonly finalizations: Pick<SessionRunFinalization, 'runId' | 'throughEntryId'>[] = [];
  readonly finalized = new Map<string, { at: number; throughEntryId: string }>();
  private consumed = 0;
  constructor(private readonly positions: BranchPageSource['positions']) {}

  refresh(source: BranchPageSource): void {
    if (this.consumed === this.positions.size) return;
    // Walk only the new tail. Other fork tails are indexed on demand.
    const additions: string[] = [];
    let id = source.leafId;
    while (id !== null && !this.nodes.has(id)) {
      additions.push(id);
      id = position(source, id).parentId;
    }
    for (const entryId of additions.reverse()) {
      const record = position(source, entryId);
      const parent = record.parentId === null ? undefined : this.nodes.get(record.parentId);
      const metadata: SessionSourceMetadata = Object.freeze({
        ...branchMetadata(record),
        entryId,
        sha256: record.hash,
        bytes: record.bytes,
        parentId: record.parentId
      });
      let inheritedHeads = parent?.inheritedHeads ?? new Map();
      if (record.type === 'branch') {
        const heads = new Map(inheritedHeads);
        const origin = record.fromEntryId ? this.nodes.get(record.fromEntryId) : undefined;
        for (const head of origin?.metadata.historyPosition?.ledgerHeads ?? [])
          heads.set(head.runId, head);
        inheritedHeads = heads;
      }
      const node: IndexedBranchMetadata = {
        metadata,
        depth: record.depth,
        branchId: record.type === 'branch' ? entryId : (parent?.branchId ?? source.sessionId),
        latestContext: record.type === 'context_transition' ? metadata : parent?.latestContext,
        inheritedHeads
      };
      this.nodes.set(entryId, node);
      this.add(this.identities, record.identity, node);
      if (record.context.exchangeId) this.add(this.exchanges, record.context.exchangeId, node);
      this.add(this.sources, record.source ? `event:${record.source.eventId}` : entryId, node);
      if (record.runId) {
        if (!this.confirmed.has(record.runId)) this.capturePending.add(record.runId);
        this.add(this.runs, record.runId, node);
        if (record.type === 'input') this.add(this.inputs, record.runId, node);
        if (
          (record.type === 'input' || record.type === 'steering') &&
          !this.finalized.has(record.runId)
        )
          this.add(this.pending, record.runId, node);
      }
    }
    this.consumed = this.nodes.size;
  }

  settle(finalizations: readonly Pick<SessionRunFinalization, 'runId' | 'throughEntryId'>[]): void {
    for (const value of finalizations.slice(this.finalizations.length)) {
      const at = this.finalizations.length;
      this.finalizations.push(value);
      this.finalized.set(value.runId, { at, throughEntryId: value.throughEntryId });
      this.pending.delete(value.runId);
    }
  }
  confirm(values: readonly SessionRunFinalizationConfirmation[]): void {
    for (const proof of values.slice(this.confirmations.length)) {
      this.confirmed.set(proof.runId, { at: this.confirmations.length, proof });
      this.confirmations.push(proof);
      this.capturePending.delete(proof.runId);
    }
  }
  private add(index: Map<string, IndexedBranchMetadata[]>, key: string, node: IndexedBranchMetadata): void {
    const entries = index.get(key);
    if (entries) entries.push(node);
    else index.set(key, [node]);
  }
}

export function branchSourceMetadata(entryId: string, record: BranchEntryPosition): SessionSourceMetadata {
  return Object.freeze({ ...branchMetadata(record), entryId, sha256: record.hash,
    bytes: record.bytes, parentId: record.parentId });
}
function branchMetadata(record: BranchEntryPosition) {
  return {
    context: record.context,
    timestamp: record.timestamp,
    ...(record.toolName ? { toolName: record.toolName } : {}),
    identity: record.identity,
    type: record.type,
    ...(record.inputAuthorship ? { inputAuthorship: record.inputAuthorship } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.source ? { source: record.source } : {}),
    ...(record.fromEntryId === undefined ? {} : { fromEntryId: record.fromEntryId }),
    ...(record.historyPosition ? { historyPosition: record.historyPosition } : {})
  };
}
const sourceIndexes = new WeakMap<BranchPageSource['positions'], BranchSourceIndex>();

function memorySourceIndex(source: BranchPageSource) {
  let index = sourceIndexes.get(source.positions);
  if (!index) {
    index = new BranchSourceIndex(source.positions);
    sourceIndexes.set(source.positions, index);
  }
  index.refresh(source);
  return index;
}

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${label} must be between 1 and ${String(maximum)}.`);
  return value;
}

function branchExcerpt(text: string, match: number, queryLength: number): string {
  let start = Math.max(0, match - 80);
  let end = Math.min(text.length, match + queryLength + 160);
  const lowSurrogate = (at: number) => text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;
  if (start > 0 && lowSurrogate(start)) start--;
  if (end < text.length && lowSurrogate(end)) end++;
  return text.slice(start, end);
}

function branchEntryText(entry: SessionBranchEntry): string {
  switch (entry.type) {
    case 'peer_contribution': return peerContributionText(entry);
    case 'input':
      return entry.task;
    case 'assistant':
    case 'steering':
      return entry.content;
    case 'observation':
      return `${entry.summary}\n${JSON.stringify(entry.output ?? null)}`;
    case 'tool_call':
      return JSON.stringify(entry.call);
    case 'branch':
      return entry.label ?? '';
    case 'tool_catalog_selection':
      return JSON.stringify(entry.selection);
    case 'model_settings':
      return `${entry.provider}/${entry.model}`;
    case 'context_transition':
      return entry.window.reason;
    case 'session_material_revocation': return 'Material future-use revocation';
    case 'session_state_batch':
      return entry.batch.idempotencyKey;
  }
}

export function branchEntryMetadata(entry: SessionBranchEntry) {
  const inputAuthorship = historyInputAuthorship(entry);
  const toolName = historyToolName(entry);
  return {
    context: historySourceFacts(entry),
    timestamp: entry.timestamp,
    ...(toolName ? { toolName } : {}),
    identity: entryIdentity(entry),
    type: entry.type,
    ...(inputAuthorship ? { inputAuthorship } : {}),
    ...('runId' in entry ? { runId: entry.runId } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.type === 'branch' ? { fromEntryId: entry.fromEntryId } : {}),
    ...(entry.type === 'context_transition'
      ? { historyPosition: entry.window.historyPosition }
      : entry.type === 'session_state_batch' ? {historyPosition:entry.batch.capturedHistoryCut} : {})
  };
}
/** Advance the in-memory repository's derived lifecycle facts at admission, not first search. */
export function settleMemorySource(
  source: BranchPageSource,
  finalizations: readonly Pick<SessionRunFinalization, 'runId' | 'throughEntryId'>[],
  confirmations: readonly SessionRunFinalizationConfirmation[]
): void {
  const index = memorySourceIndex(source);
  index.settle(finalizations);
  index.confirm(confirmations);
}

export async function sourceSnapshot(
  source: BranchPageSource,
  sourceRevision: number,
  finalizations: readonly Pick<SessionRunFinalization, 'runId' | 'throughEntryId'>[],
  leafId = source.leafId,
  confirmations: readonly SessionRunFinalizationConfirmation[]
): Promise<SessionSourceSnapshot> {
  const index = memorySourceIndex(source);
  index.settle(finalizations);
  index.confirm(confirmations);
  const boundary = await asyncBoundary(source, leafId);
  const view = await branchNavigation(source, boundary);
  const leaf = leafId === null ? undefined : index.nodes.get(leafId);
  const confirmedCount = index.confirmations.length;
  const capturePending = new Set(index.capturePending);
  const finalizedCount = index.finalizations.length;
  const lookup = async (values: readonly IndexedBranchMetadata[] | undefined) => {
    for (let at = (values?.length ?? 0) - 1; at >= 0; at--) {
      const value = values?.[at];
      if (value && await view.contains(value.metadata.entryId)) return value;
    }
    return undefined;
  };
  const byId = async (id: string) => await view.contains(id) ? index.nodes.get(id)?.metadata : undefined;
  const at = async (at: number) => {
    const item = await view.at(at < 0 ? view.length + at : at);
    return item ? branchSourceMetadata(item.metadata.entryId, item.metadata) : undefined;
  };
  const isFinalized = async (runId: string) => {
    const item = index.finalized.get(runId);
    return item !== undefined && item.at < finalizedCount && await view.contains(item.throughEntryId);
  };
  return Object.freeze({
    boundary, sourceRevision, branchId: leaf?.branchId ?? source.sessionId,
    entries: Object.freeze({ length: view.length, at,
      async *[Symbol.asyncIterator]() {
        for (let position = 0; position < view.length; position++) {
          const item = await at(position);
          if (item) yield item;
        }
      }
    }),
    index: Object.freeze({
      async *exchange(exchangeId: string) {
        for (const node of index.exchanges.get(exchangeId) ?? [])
          if (await view.contains(node.metadata.entryId)) yield node.metadata;
      },
      byId: { get: byId, has: view.contains },
      bySource: { get: async (id: string) => (await lookup(index.sources.get(id)))?.metadata },
      byIdentity: { get: async (id: string) => (await lookup(index.identities.get(id)))?.metadata },
      runs: {
        has: async (id: string) => (await lookup(index.runs.get(id))) !== undefined,
        lastPosition: async (id: string) => (await lookup(index.runs.get(id)))?.depth
      },
      positions: { get: view.position },
      inputs: { get: async (id: string) => (await lookup(index.inputs.get(id)))?.depth }
    }),
    inheritedHeads: Promise.resolve(leaf?.inheritedHeads ?? new Map()),
    finalizedRuns: { has: isFinalized },
    latestContext: Promise.resolve(leaf?.latestContext),
    async confirmedHead(runId: string) {
      const item = index.confirmed.get(runId);
      const record = index.finalized.get(runId);
      const proof = item && item.at < confirmedCount && record && await view.contains(record.throughEntryId) ? item.proof : undefined;
      return proof ? { runId, sequence: proof.source.sequence, hash: proof.source.hash } : undefined;
    },
    async *unconfirmedRuns() {
      for (const runId of capturePending)
        if (await lookup(index.runs.get(runId))) yield { runId, finalized: await isFinalized(runId) };
    },
    async *activeInputs() {
      const candidates = new Map(index.pending);
      for (const run of leaf?.inheritedHeads.keys() ?? [])
        if (!await isFinalized(run)) candidates.set(run, index.runs.get(run) ?? []);
      for (const { runId: run } of index.finalizations.slice(finalizedCount))
        candidates.set(run, index.runs.get(run) ?? []);
      for (const [run, nodes] of candidates) {
        if (await isFinalized(run)) continue;
        for (const node of nodes)
          if ((node.metadata.type === 'input' || node.metadata.type === 'steering') && await view.contains(node.metadata.entryId))
            yield node.metadata;
      }
    }
  });
}
