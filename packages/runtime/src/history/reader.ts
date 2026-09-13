import { parseJsonObject } from '@agent-core/json';
import { hashJson, type ArtifactRepository, type EventRepository } from '@agent-core/persistence';
import type { AgentEvent } from '../events.js';
import type { SessionBranchEntry, SessionDescriptor, SessionRepository } from '../session/contracts.js';
import type {
  HistoryFilter,
  HistoryItem,
  HistoryReadRequest,
  HistoryReadResult,
  HistorySearchRequest,
  HistorySearchResult,
  HistorySourceCut,
  HistorySourceRef,
  HistoryView
} from './contracts.js';
import { joinHistoryLedgers } from './ledger.js';
import { LiteralHistoryIndex } from './literal-index.js';
import { historyCutSchema } from './schema.js';

const MAX_BYTES = 256 * 1024;
const MAX_SCANNED = 1000;
const MAX_RESULTS = 100;

/** Host-bound branch reader. Model-supplied IDs never expand its authority. */
export class HistoryReader {
  private readonly lexicalIndex = new LiteralHistoryIndex();
  private indexedCutFingerprint: string | undefined;
  constructor(
    private readonly options: {
      readonly repository: SessionRepository;
      readonly session: SessionDescriptor;
      readonly events?: EventRepository<AgentEvent>;
      readonly artifacts?: ArtifactRepository;
    }
  ) {}

  async rebuildIndex(options: { readonly maxScanned?: number } = {}) {
    const maximum = bound(options.maxScanned, 1000, MAX_SCANNED, 'maxScanned');
    const view = await this.view();
    this.lexicalIndex.clear();
    this.indexedCutFingerprint = undefined;
    let indexed = 0;
    for (const entry of view.entries.slice(0, maximum)) {
      const source = sourceRef(view.cut.sessionId, entry);
      if (!this.lexicalIndex.add(`${source.entryId}:${source.sha256}`, publicText(entry))) break;
      indexed++;
    }
    if (indexed === view.entries.length) this.indexedCutFingerprint = hashJson(view.cut);
    return Object.freeze({
      ...this.lexicalIndex.inspect(),
      cut: view.cut,
      coverage: indexed === view.entries.length ? ('complete' as const) : ('partial' as const)
    });
  }

  async capture(): Promise<HistorySourceCut> {
    return (await this.view()).cut;
  }

  async view(cut?: HistorySourceCut): Promise<HistoryView> {
    const current = await this.options.repository.loadReplayState(this.options.session);
    const branchId =
      [...current.branch].reverse().find((entry) => entry.type === 'branch')?.id ?? current.session.id;
    let entries = current.branch;
    if (cut) {
      cut = historyCutSchema.parse(cut);
      if (
        cut.sessionId !== current.session.id ||
        cut.branchId !== branchId ||
        !Number.isSafeInteger(cut.sourceRevision) ||
        cut.sourceRevision < 0 ||
        cut.sourceRevision > current.sourceRevision
      )
        throw new Error('History cut is outside the authorized branch or incompatible.');
      const throughEntryId = cut.throughEntryId;
      const index =
        throughEntryId === null ? -1 : entries.findIndex((entry) => entry.id === throughEntryId);
      if (cut.throughEntryId !== null && index === -1)
        throw new Error('History cut is unavailable on the authorized branch.');
      entries = Object.freeze(entries.slice(0, index + 1));
    }
    const sessionLeaf = entries.at(-1)?.id ?? null;
    const fork = [...entries].reverse().find((entry) => entry.type === 'branch');
    const forkSource =
      fork?.type === 'branch' ? entries.find((entry) => entry.id === fork.fromEntryId) : undefined;
    const inheritedHeads =
      forkSource?.type === 'context_transition' ? forkSource.window.historyPosition.ledgerHeads : undefined;
    const joined = this.options.events
      ? await joinHistoryLedgers({
          entries,
          finalizations: current.runFinalizations,
          events: this.options.events,
          ...(this.options.artifacts ? { artifacts: this.options.artifacts } : {}),
          ...(cut?.ledgerHeads ? { heads: cut.ledgerHeads } : {}),
          ...(inheritedHeads ? { inheritedHeads } : {})
        })
      : undefined;
    if (joined) entries = joined.entries;
    const position: HistorySourceCut =
      cut ??
      Object.freeze({
        format: 'agent-core.history/1',
        sessionId: current.session.id,
        branchId,
        throughEntryId: sessionLeaf,
        sourceRevision: current.sourceRevision,
        ledgerCoverage: joined ? 'authoritative' : 'session',
        ledgerHeads: joined?.heads ?? mirroredOpenHeads(entries, current.runFinalizations)
      });
    const ids = new Set(entries.map((entry) => entry.id));
    const contextWindow = [...entries]
      .reverse()
      .find((entry) => entry.type === 'context_transition')?.window;
    return Object.freeze({
      cut: position,
      entries,
      runFinalizations: Object.freeze(
        current.runFinalizations.filter((entry) => ids.has(entry.throughEntryId))
      ),
      ...(contextWindow ? { contextWindow } : {})
    });
  }

  async read(request: HistoryReadRequest): Promise<HistoryReadResult> {
    const maxBytes = bound(request.maxBytes, 16 * 1024, MAX_BYTES, 'maxBytes');
    const offset = nonnegative(request.offset ?? 0, 'offset');
    const count = bound(request.neighbors, 0, 10, 'neighbors', true);
    if (request.source.sessionId !== this.options.session.id)
      return unavailable(request.source, 'outside_scope');
    const view = await this.view(request.cut);
    const index = view.entries.findIndex(
      (entry) => sourceRef(view.cut.sessionId, entry).entryId === request.source.entryId
    );
    const entry = view.entries[index];
    if (!entry) return unavailable(request.source, 'missing');
    if (!sameHistorySource(sourceRef(view.cut.sessionId, entry), request.source))
      return unavailable(request.source, 'identity_mismatch');
    const full = publicText(entry);
    const range = textRange(full, offset, maxBytes);
    let remaining = maxBytes - Buffer.byteLength(range.text);
    const neighbors: HistoryItem[] = [];
    for (
      let at = Math.max(0, index - count);
      at <= Math.min(view.entries.length - 1, index + count) && remaining > 0;
      at++
    ) {
      if (at === index) continue;
      const neighbor = view.entries[at];
      if (!neighbor) continue;
      const item = historyItem(view.cut.sessionId, neighbor, remaining);
      remaining -= Buffer.byteLength(item.text);
      neighbors.push(item);
    }
    return Object.freeze({
      status: 'available',
      item: Object.freeze({
        ...historyItem(view.cut.sessionId, entry, maxBytes),
        text: range.text,
        truncated: range.nextOffset < range.totalBytes || range.offset > 0
      }),
      ...range,
      neighbors: Object.freeze(neighbors),
      cut: view.cut
    });
  }

  async search(request: HistorySearchRequest = {}): Promise<HistorySearchResult> {
    const limit = bound(request.limit, 20, MAX_RESULTS, 'limit');
    const maxBytes = bound(request.maxBytes, 32 * 1024, MAX_BYTES, 'maxBytes');
    const maxScanned = bound(request.maxScanned, MAX_SCANNED, MAX_SCANNED, 'maxScanned');
    if ((request.query?.length ?? 0) > 4096) throw new Error('History query exceeds 4096 characters.');
    const queryFingerprint = hashJson({ query: request.query ?? '', filter: request.filter ?? {} });
    const cursor = request.cursor ? decodeCursor(request.cursor) : undefined;
    if (cursor && cursor.queryFingerprint !== queryFingerprint)
      throw new Error('History cursor query mismatch.');
    if (cursor && request.cut && hashJson(cursor.cut) !== hashJson(request.cut))
      throw new Error('History cursor source cut mismatch.');
    const view = await this.view(cursor?.cut ?? request.cut);
    let position = cursor?.position ?? 0;
    if (position > view.entries.length) throw new Error('Invalid history cursor position.');
    let scanned = 0;
    let bytes = 0;
    const items: HistoryItem[] = [];
    while (
      position < view.entries.length &&
      scanned < maxScanned &&
      items.length < limit &&
      bytes < maxBytes
    ) {
      const entry = view.entries[position++];
      scanned++;
      if (!entry || !matches(entry, request.filter)) continue;
      const source = sourceRef(view.cut.sessionId, entry);
      const key = `${source.entryId}:${source.sha256}`;
      const fullText = this.lexicalIndex.text(key) ?? publicText(entry);
      this.lexicalIndex.add(key, fullText);
      if (request.query && this.lexicalIndex.matches(key, request.query) === false) continue;
      const match = request.query ? fullText.indexOf(request.query) : 0;
      if (match < 0) continue;
      const room = maxBytes - bytes;
      const excerpt = textRange(
        fullText,
        Buffer.byteLength(fullText.slice(0, Math.max(0, match - 128))),
        Math.min(
          Math.max(
            0,
            room - Buffer.byteLength(JSON.stringify(historyItem(view.cut.sessionId, entry, 0))) - 32
          ),
          4096
        )
      );
      const item = Object.freeze({
        ...historyItem(view.cut.sessionId, entry, 0),
        text: excerpt.text,
        truncated: excerpt.offset > 0 || excerpt.nextOffset < excerpt.totalBytes
      });
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > room) {
        // Never silently skip a matching source when metadata does not fit this page.
        position--;
        scanned--;
        if (items.length === 0)
          throw new Error('History result byte budget cannot fit one source reference.');
        break;
      }
      items.push(item);
      bytes += size;
    }
    const complete = position === view.entries.length;
    return Object.freeze({
      items: Object.freeze(items),
      cut: view.cut,
      indexWatermark: view.cut,
      coverage: complete ? 'complete' : 'partial',
      scanned,
      bytes,
      index: Object.freeze({
        ...this.lexicalIndex.inspect(),
        coverage:
          this.indexedCutFingerprint === hashJson(view.cut) ? ('complete' as const) : ('partial' as const)
      }),
      ...(!complete ? { cursor: encodeCursor({ cut: view.cut, position, queryFingerprint }) } : {})
    });
  }
}

const sourceReferences = new WeakMap<SessionBranchEntry, Map<string, HistorySourceRef>>();
export function sourceRef(sessionId: string, entry: SessionBranchEntry): HistorySourceRef {
  const cached = sourceReferences.get(entry)?.get(sessionId);
  if (cached) return cached;
  const source = Object.freeze({
    sessionId,
    entryId: entry.source ? `event:${entry.source.eventId}` : entry.id,
    ...(entry.source ? { event: entry.source } : {}),
    sha256:
      entry.source?.hash ??
      hashJson(parseJsonObject(entry, { maxStringBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 }))
  });
  const cache = sourceReferences.get(entry) ?? new Map<string, HistorySourceRef>();
  cache.set(sessionId, source);
  sourceReferences.set(entry, cache);
  return source;
}
export function historyRole(entry: SessionBranchEntry): HistoryItem['role'] {
  return entry.type === 'input' || entry.type === 'steering'
    ? 'user'
    : entry.type === 'assistant' || entry.type === 'tool_call'
      ? 'assistant'
      : entry.type === 'observation'
        ? 'tool'
        : 'control';
}
function historyItem(sessionId: string, entry: SessionBranchEntry, maxBytes: number): HistoryItem {
  const text = publicText(entry);
  const range = textRange(text, 0, maxBytes);
  return Object.freeze({
    source: sourceRef(sessionId, entry),
    type: entry.type,
    role: historyRole(entry),
    ...('runId' in entry ? { runId: entry.runId } : {}),
    text: range.text,
    truncated: range.nextOffset < range.totalBytes,
    ...(entry.type === 'assistant' && entry.completeness ? { completeness: entry.completeness } : {})
  });
}
function publicText(entry: SessionBranchEntry): string {
  switch (entry.type) {
    case 'input':
      return entry.originalInput ? JSON.stringify(entry.originalInput) : entry.task;
    case 'steering':
      return entry.originalInput ? JSON.stringify(entry.originalInput) : entry.content;
    case 'assistant': {
      const media = entry.output?.filter((item) => item.type === 'media');
      return media && media.length > 0 ? JSON.stringify({ content: entry.content, media }) : entry.content;
    }
    case 'tool_call':
      return JSON.stringify(entry.call);
    case 'observation':
      return JSON.stringify({
        summary: entry.summary,
        output: entry.output,
        artifacts: entry.artifacts?.filter((ref) => ref.visibility === 'public')
      });
    case 'model_settings':
      return JSON.stringify({
        provider: entry.provider,
        model: entry.model,
        temperature: entry.temperature,
        reasoning: entry.reasoning,
        endpoint: entry.endpoint
      });
    case 'branch':
      return JSON.stringify({ fromEntryId: entry.fromEntryId, label: entry.label });
    case 'context_transition':
      return JSON.stringify({
        windowId: entry.window.windowId,
        reason: entry.window.reason,
        historyPosition: entry.window.historyPosition
      });
  }
}
function matches(entry: SessionBranchEntry, filter?: HistoryFilter): boolean {
  if (!filter) return true;
  if (filter.sourceType && entry.type !== filter.sourceType) return false;
  if (filter.role && historyRole(entry) !== filter.role) return false;
  if (filter.runId && (!('runId' in entry) || entry.runId !== filter.runId)) return false;
  if (
    filter.toolName &&
    (entry.type !== 'observation' || entry.toolName !== filter.toolName) &&
    (entry.type !== 'tool_call' ||
      typeof entry.call !== 'object' ||
      entry.call === null ||
      Array.isArray(entry.call) ||
      !('name' in entry.call) ||
      entry.call.name !== filter.toolName)
  )
    return false;
  if (
    filter.resource &&
    (entry.type !== 'observation' ||
      !entry.artifacts?.some((ref) => ref.visibility === 'public' && ref.artifactId === filter.resource))
  )
    return false;
  return true;
}
function unavailable(
  source: HistorySourceRef,
  reason: Extract<HistoryReadResult, { status: 'unavailable' }>['reason']
): HistoryReadResult {
  return Object.freeze({ status: 'unavailable', reason, source });
}
export function bound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
  zero = false
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (zero ? 0 : 1) || result > maximum)
    throw new Error(`${name} must be ${zero ? 'nonnegative' : 'positive'} and at most ${String(maximum)}.`);
  return result;
}
function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer.`);
  return value;
}
/** UTF-8 byte ranges, aligned to code-point boundaries. */
export function textRange(
  text: string,
  offset: number,
  maxBytes: number
): { text: string; offset: number; nextOffset: number; totalBytes: number } {
  nonnegative(offset, 'offset');
  const bytes = Buffer.from(text);
  let start = Math.min(offset, bytes.length);
  let end = Math.min(start + maxBytes, bytes.length);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  if (maxBytes > 0 && start < bytes.length && end <= start)
    throw new Error('Byte budget cannot fit the next UTF-8 character; request at least four bytes.');
  return {
    text: bytes.subarray(start, Math.max(start, end)).toString('utf8'),
    offset: start,
    nextOffset: Math.max(start, end),
    totalBytes: bytes.length
  };
}
interface SearchCursor {
  readonly cut: HistorySourceCut;
  readonly position: number;
  readonly queryFingerprint: string;
}
function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify({ format: 'agent-core.history-cursor/1', ...cursor })).toString(
    'base64url'
  );
}
function decodeCursor(value: string): SearchCursor {
  if (value.length > 4096) throw new Error('History cursor too large.');
  const parsed = parseJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  if (
    parsed.format !== 'agent-core.history-cursor/1' ||
    typeof parsed.queryFingerprint !== 'string' ||
    typeof parsed.position !== 'number' ||
    !Number.isSafeInteger(parsed.position) ||
    parsed.position < 0
  )
    throw new Error('Invalid history cursor.');
  return {
    position: parsed.position,
    queryFingerprint: parsed.queryFingerprint,
    cut: historyCutSchema.parse(parsed.cut)
  };
}

export function sameHistorySource(left: HistorySourceRef, right: HistorySourceRef): boolean {
  return hashJson(left) === hashJson(right);
}

interface ViewPositions {
  readonly entries: ReadonlyMap<SessionBranchEntry, number>;
  readonly ids: ReadonlyMap<string, number>;
  readonly inputs: ReadonlyMap<string, number>;
}
const viewPositions = new WeakMap<HistoryView, ViewPositions>();
const cutHeads = new WeakMap<HistorySourceCut, ReadonlyMap<string, number>>();

/** Routing cuts and event cuts are independent; source-array placement alone is not a ledger boundary. */
export function historySourceAfterCut(
  view: HistoryView,
  entry: SessionBranchEntry,
  cut: HistorySourceCut
): boolean {
  let positions = viewPositions.get(view);
  if (!positions) {
    const inputs = new Map<string, number>();
    for (const [index, item] of view.entries.entries())
      if (item.type === 'input') inputs.set(item.runId, index);
    positions = {
      entries: new Map(view.entries.map((item, index) => [item, index])),
      ids: new Map(view.entries.map((item, index) => [item.id, index])),
      inputs
    };
    viewPositions.set(view, positions);
  }
  const boundary = cut.throughEntryId === null ? -1 : positions.ids.get(cut.throughEntryId);
  if (boundary === undefined) throw new Error('Context history source cut is unavailable.');
  const index = positions.entries.get(entry);
  if (index === undefined) throw new Error('History source is outside the captured view.');
  if (entry.source) {
    let heads = cutHeads.get(cut);
    if (!heads) {
      heads = new Map(cut.ledgerHeads?.map((head) => [head.runId, head.sequence]));
      cutHeads.set(cut, heads);
    }
    const sequence = heads.get(entry.source.runId);
    if (sequence !== undefined) return entry.source.sequence > sequence;
    // No declared ledger coverage means newly visible routing records are new tail.
    if (cut.ledgerCoverage === 'session' || cut.ledgerHeads === undefined) return index > boundary;
    const input = positions.inputs.get(entry.source.runId);
    if (input !== undefined) return input > boundary;
  }
  return index > boundary;
}

function mirroredOpenHeads(
  entries: readonly SessionBranchEntry[],
  finalizations: readonly import('../session/contracts.js').SessionRunFinalization[]
): readonly import('./contracts.js').HistoryLedgerHead[] {
  const ended = new Set(finalizations.map((record) => record.runId));
  const heads = new Map<string, import('./contracts.js').HistoryLedgerHead>();
  for (const entry of entries) {
    if (!('runId' in entry) || ended.has(entry.runId)) continue;
    const previous = heads.get(entry.runId);
    if (!previous) heads.set(entry.runId, Object.freeze({ runId: entry.runId, sequence: -1 }));
    if (entry.source && entry.source.sequence > (previous?.sequence ?? -1))
      heads.set(
        entry.runId,
        Object.freeze({ runId: entry.runId, sequence: entry.source.sequence, hash: entry.source.hash })
      );
  }
  return Object.freeze([...heads.values()]);
}
