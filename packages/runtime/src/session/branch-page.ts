import { workingStateAtEntry, type SessionWorkingStateEntry } from './working-state.js';
import { hashJson } from '@agent-core/persistence';
import { historySourceFacts } from '../history/source-metadata.js';
import { historyToolName } from '../history/metadata.js';
import { entryIdentity } from '../history/ledger.js';
import type {
  SessionSourceMetadata,
  SessionSourceSnapshot,
  SessionRunFinalization,
  SessionBranchBoundary,
  SessionBranchEntry,
  SessionBranchPage,
  SessionBranchPageRequest,
  SessionBranchSearchRequest,
  SessionBranchSearchResult
} from './contracts.js';

export interface BranchEntryPosition {
  readonly context: SessionSourceMetadata['context'];
  readonly timestamp: string;
  readonly toolName?: string;
  readonly workingState?: SessionWorkingStateEntry | null;
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
  read(entryId: string): Promise<SessionBranchEntry>;
}

export function branchBoundary(
  source: BranchPageSource,
  leafId = source.leafId
): SessionBranchBoundary {
  return Object.freeze({
    sessionId: source.sessionId,
    leafId,
    leafHash: leafId === null ? null : position(source, leafId).hash
  });
}

export function assertBranchEntry(
  source: BranchPageSource,
  boundary: SessionBranchBoundary,
  entryId: string
): void {
  if (
    boundary.sessionId !== source.sessionId ||
    (boundary.leafId === null
      ? boundary.leafHash !== null
      : position(source, boundary.leafId).hash !== boundary.leafHash)
  )
    throw new Error('History boundary does not match its source.');
  if (!branchView(source, boundary).contains(entryId))
    throw new Error(`History entry is outside the selected branch: ${entryId}`);
}

export async function readBranchPage(
  source: BranchPageSource,
  request: SessionBranchPageRequest = {}
): Promise<SessionBranchPage> {
  const limit = boundedInteger(request.limit ?? 64, 256, 'History page entry limit');
  const maxBytes = boundedInteger(
    request.maxBytes ?? 256 * 1024,
    8 * 1024 * 1024,
    'History page byte limit'
  );
  const boundary = request.cursor?.boundary ?? branchBoundary(source, request.leafId);
  const next = request.cursor?.entryId ?? boundary.leafId;
  if (next !== null) assertBranchEntry(source, boundary, next);
  else if (boundary.sessionId !== source.sessionId || boundary.leafHash !== null)
    throw new Error('Invalid empty history boundary.');
  const entries: SessionBranchEntry[] = [];
  const path = branchView(source, boundary);
  const step = request.direction === 'newer' ? 1 : -1;
  let index = next === null ? -1 : (path.position(next) ?? -1);
  let first = index;
  let last = index;
  let bytes = 0;
  let oversizedEntry: SessionBranchPage['oversizedEntry'];
  while (index >= 0 && index < path.length && entries.length < limit) {
    const entryId = path.at(index)?.metadata.entryId;
    if (entryId === undefined) break;
    const metadata = position(source, entryId);
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
  const older = path.at(first - 1)?.metadata.entryId;
  const newer = path.at(last + 1)?.metadata.entryId;
  return Object.freeze({
    boundary,
    entries: Object.freeze(step < 0 ? entries.reverse() : entries),
    ...(oversizedEntry === undefined ? {} : { oversizedEntry }),
    ...(older === undefined ? {} : { older: Object.freeze({ boundary, entryId: older }) }),
    ...(newer === undefined ? {} : { newer: Object.freeze({ boundary, entryId: newer }) })
  });
}

export async function searchBranch(
  source: BranchPageSource,
  request: SessionBranchSearchRequest
): Promise<SessionBranchSearchResult> {
  if (request.query.length === 0) throw new Error('History search requires non-empty text.');
  if (request.cursor !== undefined && request.cursor.query !== request.query)
    throw new Error('History search cursor belongs to a different query.');
  const page = await readBranchPage(source, request);
  const matches = page.entries.flatMap((entry) => {
    const text = branchEntryText(entry);
    const match = text.indexOf(request.query);
    return match < 0
      ? []
      : [
          {
            entryId: entry.id,
            excerpt: text.slice(Math.max(0, match - 80), match + request.query.length + 160)
          }
        ];
  });
  return Object.freeze({
    boundary: page.boundary,
    matches: Object.freeze(matches),
    ...(page.oversizedEntry === undefined ? {} : { oversizedEntry: page.oversizedEntry }),
    ...(page.older === undefined
      ? {}
      : { older: Object.freeze({ ...page.older, query: request.query }) })
  });
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
    index.positions.set(entry.id, {
      workingState: workingStateAtEntry(
        entry,
        entry.parentId === null ? null : (index.positions.get(entry.parentId)?.workingState ?? null)
      ),
      ...branchEntryMetadata(entry),
      parentId: entry.parentId,
      hash: hashJson(entry),
      bytes: Buffer.byteLength(JSON.stringify(entry))
    });
  }
  index.count = entries.length;
  const { byId, positions } = index;
  return {
    sessionId,
    leafId: entries.at(-1)?.id ?? null,
    positions,
    read(entryId) {
      const entry = byId.get(entryId);
      if (entry === undefined) throw new Error(`Unknown history entry: ${entryId}`);
      return Promise.resolve(entry);
    }
  };
}

function position(source: BranchPageSource, entryId: string): BranchEntryPosition {
  const entry = source.positions.get(entryId);
  if (entry === undefined) throw new Error(`Unknown history entry: ${entryId}`);
  return entry;
}

interface SourceNode {
  readonly metadata: SessionSourceMetadata;
  readonly depth: number;
  readonly ancestors: readonly SourceNode[];
  readonly branchId: string;
  readonly latestContext: SessionSourceMetadata | undefined;
  readonly inheritedHeads: SessionSourceSnapshot['inheritedHeads'];
}

/** Jump pointers share ancestry across captured windows and forks without copying their prefixes. */
class BranchSourceIndex {
  readonly nodes = new Map<string, SourceNode>();
  readonly identities = new Map<string, SourceNode[]>();
  readonly exchanges = new Map<string, SourceNode[]>();
  readonly sources = new Map<string, SourceNode[]>();
  readonly runs = new Map<string, SourceNode[]>();
  readonly inputs = new Map<string, SourceNode[]>();
  readonly pending = new Map<string, SourceNode[]>();
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
      const ancestors: SourceNode[] = parent ? [parent] : [];
      for (let level = 0; ; level++) {
        const ancestor = ancestors[level]?.ancestors[level];
        if (!ancestor) break;
        ancestors.push(ancestor);
      }
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
      const node: SourceNode = {
        metadata,
        depth: (parent?.depth ?? -1) + 1,
        ancestors,
        branchId: record.type === 'branch' ? entryId : (parent?.branchId ?? source.sessionId),
        latestContext: record.type === 'context_transition' ? metadata : parent?.latestContext,
        inheritedHeads
      };
      this.nodes.set(entryId, node);
      this.add(this.identities, record.identity, node);
      if (record.context.exchangeId) this.add(this.exchanges, record.context.exchangeId, node);
      this.add(this.sources, record.source ? `event:${record.source.eventId}` : entryId, node);
      if (record.runId) {
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
  private add(index: Map<string, SourceNode[]>, key: string, node: SourceNode): void {
    const entries = index.get(key);
    if (entries) entries.push(node);
    else index.set(key, [node]);
  }
}

function branchMetadata(record: BranchEntryPosition) {
  return {
    context: record.context,
    timestamp: record.timestamp,
    ...(record.toolName ? { toolName: record.toolName } : {}),
    identity: record.identity,
    type: record.type,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.source ? { source: record.source } : {}),
    ...(record.fromEntryId === undefined ? {} : { fromEntryId: record.fromEntryId }),
    ...(record.historyPosition ? { historyPosition: record.historyPosition } : {})
  };
}
const sourceIndexes = new WeakMap<BranchPageSource['positions'], BranchSourceIndex>();
function branchView(source: BranchPageSource, boundary: SessionBranchBoundary) {
  let index = sourceIndexes.get(source.positions);
  if (!index) {
    index = new BranchSourceIndex(source.positions);
    sourceIndexes.set(source.positions, index);
  }
  index.refresh({ ...source, leafId: boundary.leafId });
  const leaf = boundary.leafId === null ? undefined : index.nodes.get(boundary.leafId);
  const length = (leaf?.depth ?? -1) + 1;
  const at = (depth: number): SourceNode | undefined => {
    if (depth < 0 || depth >= length) return undefined;
    let node = leaf;
    let distance = length - depth - 1;
    for (let bit = 0; distance > 0 && node; bit++, distance = Math.floor(distance / 2))
      if (distance % 2 === 1) node = node.ancestors[bit];
    return node;
  };
  const contains = (id: string): boolean => {
    const node = index.nodes.get(id);
    return node !== undefined && at(node.depth) === node;
  };
  const lookup = (values: readonly SourceNode[] | undefined) => {
    for (let at = (values?.length ?? 0) - 1; at >= 0; at--) {
      const node = values?.[at];
      if (node && contains(node.metadata.entryId)) return node;
    }
    return undefined;
  };
  return {
    index,
    leaf,
    length,
    at,
    contains,
    lookup,
    position: (id: string) => (contains(id) ? index.nodes.get(id)?.depth : undefined)
  };
}

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${label} must be between 1 and ${String(maximum)}.`);
  return value;
}

function branchEntryText(entry: SessionBranchEntry): string {
  switch (entry.type) {
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
    case 'model_settings':
      return `${entry.provider}/${entry.model}`;
    case 'context_transition':
      return entry.window.reason;
    case 'working_state':
      return 'Generated working-state interpretation';
  }
}

export function branchEntryMetadata(entry: SessionBranchEntry) {
  const toolName = historyToolName(entry);
  return {
    context: historySourceFacts(entry),
    timestamp: entry.timestamp,
    ...(toolName ? { toolName } : {}),
    identity: entryIdentity(entry),
    type: entry.type,
    ...('runId' in entry ? { runId: entry.runId } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.type === 'branch' ? { fromEntryId: entry.fromEntryId } : {}),
    ...(entry.type === 'context_transition'
      ? { historyPosition: entry.window.historyPosition }
      : {})
  };
}
export function sourceSnapshot(
  source: BranchPageSource,
  sourceRevision: number,
  finalizations: readonly Pick<SessionRunFinalization, 'runId' | 'throughEntryId'>[],
  leafId = source.leafId
): SessionSourceSnapshot {
  let index = sourceIndexes.get(source.positions);
  if (!index) {
    index = new BranchSourceIndex(source.positions);
    sourceIndexes.set(source.positions, index);
  }
  index.settle(finalizations);
  const boundary = branchBoundary(source, leafId);
  const view = branchView(source, boundary);
  view.index.settle(finalizations);
  const finalizedCount = view.index.finalizations.length;
  const byId = (id: string) => (view.contains(id) ? view.index.nodes.get(id)?.metadata : undefined);
  const isFinalized = (runId: string) => {
    const item = view.index.finalized.get(runId);
    return item !== undefined && item.at < finalizedCount && view.contains(item.throughEntryId);
  };
  return Object.freeze({
    boundary,
    sourceRevision,
    branchId: view.leaf?.branchId ?? source.sessionId,
    entries: Object.freeze({
      length: view.length,
      at: (at: number) => view.at(at < 0 ? view.length + at : at)?.metadata,
      *[Symbol.iterator]() {
        for (let at = 0; at < view.length; at++) {
          const node = view.at(at);
          if (node) yield node.metadata;
        }
      }
    }),
    index: Object.freeze({
      *exchange(exchangeId: string) {
        for (const node of view.index.exchanges.get(exchangeId) ?? [])
          if (view.contains(node.metadata.entryId)) yield node.metadata;
      },
      byId: { get: byId, has: view.contains },
      bySource: { get: (id: string) => view.lookup(view.index.sources.get(id))?.metadata },
      byIdentity: { get: (id: string) => view.lookup(view.index.identities.get(id))?.metadata },
      runs: {
        has: (id: string) => view.lookup(view.index.runs.get(id)) !== undefined,
        lastPosition: (id: string) => view.lookup(view.index.runs.get(id))?.depth
      },
      positions: { get: view.position },
      inputs: { get: (id: string) => view.lookup(view.index.inputs.get(id))?.depth }
    }),
    inheritedHeads: view.leaf?.inheritedHeads ?? new Map(),
    finalizedRuns: { has: isFinalized },
    latestContext: view.leaf?.latestContext,
    *activeInputs() {
      const candidates = new Map(view.index.pending);
      for (const run of view.leaf?.inheritedHeads.keys() ?? [])
        if (!isFinalized(run)) candidates.set(run, view.index.runs.get(run) ?? []);
      for (const { runId: run } of view.index.finalizations.slice(finalizedCount)) {
        candidates.set(run, view.index.runs.get(run) ?? []);
      }
      for (const [run, nodes] of candidates) {
        if (isFinalized(run)) continue;
        for (const node of nodes)
          if (
            (node.metadata.type === 'input' || node.metadata.type === 'steering') &&
            view.contains(node.metadata.entryId)
          )
            yield node.metadata;
      }
    }
  });
}

export function currentWorkingState(
  source: BranchPageSource,
  leafId = source.leafId
): SessionWorkingStateEntry | null {
  return leafId === null ? null : (position(source, leafId).workingState ?? null);
}
