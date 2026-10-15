import type { ContextWindowRecord, ContextSourceManifest } from './contracts.js';
import { incompleteHistoryExchange } from '../history/source-metadata.js';
import * as z from 'zod';
import { ContextSourceCapacityError } from '../run/context-admission.js';
import { ToolInputError } from '@agent-core/tools';
import { hashJson } from '@agent-core/persistence';
import type { HistorySourceCut, HistorySourceRef, HistorySourceMetadata, HistorySearchPosition } from '../history/contracts.js';
import { historyCutSchema } from '../history/schema.js';
import { sameHistorySource, type HistoryReader } from '../history/reader.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
export const contextInspectionSchema = z.strictObject({
  cursor: z.string().max(MAX_MANIFEST_BYTES).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  maxBytes: z.number().int().min(1).max(MAX_MANIFEST_BYTES).default(8192)
});
export type ContextInspectionPage = z.infer<typeof contextInspectionSchema>;
const cursorSchema = z.strictObject({
  cut: historyCutSchema,
  offset: z.number().int().min(0),
  retained: z.number().int().min(0),
  tail: z.string().optional(),
  phase: z.enum(['retained', 'tail'])
});

export function contextInspectionCursor(cursor: string) {
  try { return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); }
  catch (cause) { throw new ToolInputError('Invalid context inspection cursor.', { cause }); }
}

type ManifestItem = ContextSourceManifest['items'][number];
type ManifestGroup = ManifestItem['group'];

/** Bounded metadata traversal. Global counts and dependency expansion belong to selection validation. */
export async function contextSourceManifest(
  history: HistoryReader,
  cut: HistorySourceCut,
  protectedSources: readonly HistorySourceRef[],
  request: ContextInspectionPage
): Promise<ContextSourceManifest> {
  const cursor = request.cursor ? contextInspectionCursor(request.cursor) : undefined;
  if (cursor && hashJson(cursor.cut) !== hashJson(cut)) throw new ToolInputError('Context inspection cursor belongs to another capture.');
  const window = await history.selectedContext(cut);
  const retainedSources = window?.selection.retained ?? [];
  let retained = cursor?.retained ?? 0;
  let tail = cursor?.tail;
  let phase = cursor?.phase ?? 'retained';
  const offset = cursor?.offset ?? 0;
  if (retained > retainedSources.length) throw new ToolInputError('Context inspection cursor exceeds its selection.');
  let complete = false;
  let scanned = 0;
  const protectedIds = new Set(protectedSources.map(source => source.entryId));
  const groups = new Map<string, ManifestGroup>();
  const items: ManifestItem[] = [];
  const page = (): ContextSourceManifest => ({
    status: 'available' as const, cut, offset, items,
    coverage: complete ? 'complete' as const : 'partial' as const,
    ...(!complete ? { cursor: Buffer.from(JSON.stringify({ cut, offset: offset + items.length, retained, phase, ...(tail ? { tail } : {}) })).toString('base64url') } : {}),
    releaseMeaning: 'Release choices are validated against complete exchanges, protected sources and native prefix dependencies before changing the selection. Bytes describe stored sources, not compiled token savings.'
  });
  let lastFit: { retained: number; tail: string | undefined; phase: typeof phase; complete: boolean; count: number } | undefined;
  while (items.length < request.limit && scanned < 1000 && !complete) {
    let item: HistorySourceMetadata | undefined;
    if (phase === 'retained' && retained < retainedSources.length) {
      const source = retainedSources[retained++];
      if (!source) break;
      item = await history.metadata(source, cut);
      if (!item) throw new Error('Committed context source is unavailable at its history cut.');
      scanned++;
    } else {
      phase = 'tail';
      const next = await history.metadataPage({ cut, ...(window ? { after: window.historyPosition } : {}), cursor: tail, limit: 1 });
      scanned += next.scanned;
      item = next.items[0];
      tail = next.cursor;
      complete = next.coverage === 'complete';
    }
    if (item && ['input', 'steering', 'assistant', 'tool_call', 'observation'].includes(item.type)) {
      const key = item.exchangeId ?? item.source.entryId;
      let group = groups.get(key);
      if (!group) {
        const exchange = item.exchangeId ? await history.exchangeMetadata(item.source, cut) : { items: [item], coverage: 'complete' as const };
        const members = exchange.items;
        const incomplete = incompleteHistoryExchange(members);
        group = {
          id: key,
          prefixBound: members.some(member => member.prefixBound) ? true : exchange.coverage === 'complete' ? false : 'unknown',
          release: incomplete && exchange.coverage === 'complete' ? 'unfinished_exchange' : members.some(member => protectedIds.has(member.source.entryId)) ? 'protected' : 'requires_validation'
        };
        groups.set(key, group);
      }
      items.push({ source: item.source, type: item.type, description: item.description, sourceBytes: item.sourceBytes, group });
    }
    if (Buffer.byteLength(JSON.stringify(page())) > request.maxBytes) {
      if (!lastFit) throw new ToolInputError('Context inspection metadata cannot fit maxBytes; increase maxBytes.');
      ({ retained, tail, phase, complete } = lastFit);
      items.length = lastFit.count;
      break;
    }
    lastFit = { retained, tail, phase, complete, count: items.length };
  }
  const result = page();
  if (Buffer.byteLength(JSON.stringify(result)) > request.maxBytes) throw new ToolInputError('Context inspection metadata cannot fit maxBytes; increase maxBytes.');
  return result;
}

/** Stream current selected pointers; callers choose their own bounded planning allowance. */
export async function* selectedHistoryMetadata(history: HistoryReader, cut: HistorySourceCut) {
  const window = await history.selectedContext(cut);
  for (const source of window?.selection.retained ?? []) {
    const item = await history.metadata(source, cut);
    if (!item) throw new Error('Committed context source is unavailable at its history cut.');
    yield item;
  }
  let cursor: string | undefined;
  do {
    const page = await history.metadataPage({ cut, ...(window ? { after: window.historyPosition } : {}), cursor, limit: 1000 });
    for (const item of page.items) yield item;
    cursor = page.cursor;
  } while (cursor);
}

interface SelectedMetadataView {
  readonly cut: HistorySourceCut;
  readonly contextWindow: ContextWindowRecord | undefined;
  readonly items: readonly HistorySourceMetadata[];
}
interface PositionedMetadata {
  readonly item: HistorySourceMetadata;
  readonly position: HistorySearchPosition;
  readonly bytes: number;
}

/** One bounded immutable view, extended from source deltas rather than replayed per cut. */
export class SelectedHistoryMetadata {
  private state: { readonly identity: string; readonly view: SelectedMetadataView;
    readonly records: Map<string, PositionedMetadata>; readonly bytes: number } | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly history: HistoryReader) {}

  read(cut: HistorySourceCut): Promise<SelectedMetadataView> {
    const result = this.pending.then(() => this.readCut(cut));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readCut(cut: HistorySourceCut): Promise<SelectedMetadataView> {
    const history = this.history;
    // Even an exact-cut cache hit must still belong to the currently authorized branch.
    await history.validateCut(cut);
    const identity = hashJson(cut);
    const previous = this.state;
    if (previous?.identity === identity) return previous.view;
    const contextWindow = await history.selectedContext(cut);
    const ledgerStarted = previous?.view.cut.ledgerHeads?.some(head => head.sequence < 0 &&
      (cut.ledgerHeads?.find(current => current.runId === head.runId)?.sequence ?? 0) >= 0);
    const extend = !ledgerStarted && previous?.view.cut.branchId === cut.branchId &&
      previous.view.contextWindow?.windowId === contextWindow?.windowId &&
      await history.extendsCut(previous.view.cut, cut);
    const records = extend ? previous.records : new Map<string, PositionedMetadata>();
    const changes = new Map<string, PositionedMetadata>();
    let count = records.size;
    let bytes = extend ? previous.bytes : 0;
    const add = async (item: HistorySourceMetadata) => {
      const old = changes.get(item.source.entryId) ?? records.get(item.source.entryId);
      if (old && !sameHistorySource(old.item.source, item.source)) throw new Error('Selected source identities conflict.');
      const size = Buffer.byteLength(JSON.stringify(item));
      bytes += size - (old?.bytes ?? 0);
      if ((!old && count >= 10000) || bytes > 4 * 1024 * 1024)
        throw new ContextSourceCapacityError(cut, bytes > 4 * 1024 * 1024
          ? { unit: 'bytes', limit: 4 * 1024 * 1024, observedAtLeast: bytes }
          : { unit: 'records', limit: 10000, observedAtLeast: count + 1 });
      const position = old?.position ?? await history.sourcePosition(item.source, cut);
      changes.set(item.source.entryId, { item, position, bytes: size });
      if (!old) count++;
    };
    if (extend) {
      let cursor: string | undefined;
      do {
        const page = await history.metadataPage({ cut, after: previous.view.cut, cursor, limit: 1000 });
        for (const item of page.items) await add(item);
        cursor = page.cursor;
      } while (cursor);
      for await (const item of history.metadataUpdates(previous.view.cut, cut)) {
        // A newly committed mirror must not reintroduce a source released by the selection.
        if (records.has(item.source.entryId) || changes.has(item.source.entryId)) await add(item);
      }
    } else {
      for await (const item of selectedHistoryMetadata(history, cut)) await add(item);
    }
    const orderedChanges = [...changes.values()]
      .sort((a, b) => a.position.at - b.position.at || a.position.sequence - b.position.sequence);
    const items: HistorySourceMetadata[] = [];
    let next = 0;
    // Materialize the immutable return value once; only changed facts need sorting or indexing.
    for (const item of extend ? previous.view.items : []) {
      if (changes.has(item.source.entryId)) continue;
      const position = records.get(item.source.entryId)?.position;
      if (!position) throw new Error('Selected metadata lost its ordering position.');
      while (next < orderedChanges.length) {
        const changed = orderedChanges[next];
        if (!changed || changed.position.at > position.at ||
            (changed.position.at === position.at && changed.position.sequence > position.sequence)) break;
        items.push(changed.item);
        next++;
      }
      items.push(item);
    }
    for (; next < orderedChanges.length; next++) {
      const changed = orderedChanges[next];
      if (changed) items.push(changed.item);
    }
    // Commit only after every bounded read and validation succeeds. No predecessor views are retained.
    for (const [id, changed] of changes) records.set(id, changed);
    Object.freeze(items);
    const view = Object.freeze({ cut, contextWindow, items });
    this.state = { identity, view, records, bytes };
    return view;
  }
}
