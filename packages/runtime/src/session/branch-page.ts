import { hashJson } from '@agent-core/persistence';
import type {
  SessionBranchBoundary,
  SessionBranchEntry,
  SessionBranchPage,
  SessionBranchPageRequest,
  SessionBranchSearchRequest,
  SessionBranchSearchResult
} from './contracts.js';

export interface BranchEntryPosition {
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

export function branchBoundary(source: BranchPageSource, leafId = source.leafId): SessionBranchBoundary {
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
  if (!branchPath(source, boundary).byId.has(entryId))
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
  const path = branchPath(source, boundary);
  const step = request.direction === 'newer' ? 1 : -1;
  let index = next === null ? -1 : (path.byId.get(next) ?? -1);
  let first = index;
  let last = index;
  let bytes = 0;
  let oversizedEntry: SessionBranchPage['oversizedEntry'];
  while (index >= 0 && index < path.ids.length && entries.length < limit) {
    const entryId = path.ids[index];
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
  const older = path.ids[first - 1];
  const newer = path.ids[last + 1];
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
    ...(page.older === undefined ? {} : { older: Object.freeze({ ...page.older, query: request.query }) })
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

interface BranchPath {
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, number>;
}
const paths = new WeakMap<BranchPageSource['positions'], Map<string | null, BranchPath>>();

function branchPath(source: BranchPageSource, boundary: SessionBranchBoundary): BranchPath {
  let retained = paths.get(source.positions);
  if (retained === undefined) {
    retained = new Map();
    paths.set(source.positions, retained);
  }
  const cached = retained.get(boundary.leafId);
  if (cached !== undefined) return cached;
  const ids: string[] = [];
  let id = boundary.leafId;
  while (id !== null) {
    ids.push(id);
    id = position(source, id).parentId;
  }
  ids.reverse();
  const path = { ids, byId: new Map(ids.map((id, index) => [id, index])) };
  if (retained.size === 2) retained.clear();
  retained.set(boundary.leafId, path);
  return path;
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
  }
}
