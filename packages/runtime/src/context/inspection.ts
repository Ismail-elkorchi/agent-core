import type { ContextSourceManifest } from './contracts.js';
import { incompleteHistoryExchange } from '../history/source-metadata.js';
import * as z from 'zod';
import { ContextSourceCapacityError } from '../run/context-admission.js';
import { ToolInputError } from '@agent-core/tools';
import { hashJson } from '@agent-core/persistence';
import type { HistorySourceCut, HistorySourceRef, HistorySourceMetadata } from '../history/contracts.js';
import { historyCutSchema } from '../history/schema.js';
import { type HistoryReader } from '../history/reader.js';

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

/** A bounded source-change plan. Explicit replacement does not need to build this plan. */
export async function readSelectedHistoryMetadata(history: HistoryReader, cut: HistorySourceCut) {
  const contextWindow = await history.selectedContext(cut);
  const items = new Map<string, HistorySourceMetadata>();
  let bytes = 0;
  for await (const item of selectedHistoryMetadata(history, cut)) {
    if (items.has(item.source.entryId)) continue;
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (items.size >= 10000 || bytes > 4 * 1024 * 1024)
      throw new ContextSourceCapacityError(cut, bytes > 4 * 1024 * 1024
        ? { unit: 'bytes', limit: 4 * 1024 * 1024, observedAtLeast: bytes }
        : { unit: 'records', limit: 10000, observedAtLeast: items.size + 1 });
    items.set(item.source.entryId, item);
  }
  const ordered = await history.orderSources([...items.values()].map(item => item.source), cut);
  return { cut, contextWindow, items: ordered.map(source => {
    const item = items.get(source.entryId);
    if (!item) throw new Error('Selected metadata identity changed.');
    return item;
  }) };
}
