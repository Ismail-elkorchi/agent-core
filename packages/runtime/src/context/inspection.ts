import * as z from 'zod';
import { ToolInputError } from '@agent-core/tools';
import { hashJson } from '@agent-core/persistence';
import type { SessionBranchEntry } from '../session/contracts.js';
import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import { historyCutSchema } from '../history/schema.js';
import { sourceRef, textRange } from '../history/reader.js';
import { contextSourceGroups } from './selection.js';

const MAX_MANIFEST_BYTES = 256 * 1024;

export const contextInspectionSchema = z.strictObject({
  // Any cursor that fits a returned page must also fit the next tool input.
  cursor: z.string().max(MAX_MANIFEST_BYTES).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  maxBytes: z.number().int().min(1).max(MAX_MANIFEST_BYTES).default(16384)
});
export type ContextInspectionPage = z.infer<typeof contextInspectionSchema>;
const cursorSchema = z.strictObject({ cut: historyCutSchema, offset: z.number().int().min(0) });

export function contextInspectionCursor(cursor: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch (cause) {
    throw new ToolInputError('Invalid context inspection cursor.', { cause });
  }
}

/** A page describes source choices, not copies of the source contents or token savings. */
export function contextSourceManifest(
  cut: HistorySourceCut,
  entries: readonly SessionBranchEntry[],
  protectedSources: readonly HistorySourceRef[],
  request: ContextInspectionPage
) {
  const groups = contextSourceGroups(entries);
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const cursor = request.cursor ? contextInspectionCursor(request.cursor) : undefined;
  if (cursor && hashJson(cursor.cut) !== hashJson(cut))
    throw new ToolInputError('Context inspection cursor belongs to another capture.');
  const offset = cursor?.offset ?? 0;
  if (offset > total) throw new ToolInputError('Context inspection cursor exceeds its selection.');
  const protectedIds = new Set(protectedSources.map((source) => source.entryId));
  const items: ReturnType<typeof sourceDescription>[] = [];
  let next = offset;
  const page = () => ({
    status: 'available' as const,
    cut,
    total,
    offset,
    items,
    coverage: next < total ? ('partial' as const) : ('complete' as const),
    ...(next < total
      ? { cursor: Buffer.from(JSON.stringify({ cut, offset: next })).toString('base64url') }
      : {}),
    releaseMeaning:
      'Release any member to remove its complete group. Protected or unfinished groups cannot be released. Bytes describe stored sources, not compiled token savings.'
  });
  let at = 0;
  outer: for (const group of groups) {
    const first = group[0];
    if (!first) continue;
    const protectedGroup = group.some((entry) =>
      protectedIds.has(sourceRef(cut.sessionId, entry).entryId)
    );
    const calls = group.filter((entry) => entry.type === 'tool_call');
    const incomplete = calls.some((call) => !group.some((entry) =>
      entry.type === 'observation' && entry.runId === call.runId &&
      entry.toolBatchId === call.toolBatchId && entry.callIndex === call.callIndex
    )) || group.some((response) => response.type === 'assistant' &&
      response.output?.filter((item) => item.type === 'tool_call').some((_, callIndex) =>
        !group.some((entry) => entry.type === 'observation' &&
          entry.runId === response.runId && entry.turnId === response.turnId &&
          entry.requestAttempt === response.requestAttempt && entry.callIndex === callIndex
        )
      )
    );
    const prefixBound = group.some((entry) =>
      entry.type === 'assistant' && entry.output?.some((item) =>
        item.type === 'protocol' && item.state.compatibility.requiresExactPrefix
      )
    );
    for (const entry of group) {
      if (at++ < offset) continue;
      items.push(sourceDescription(entry, cut.sessionId, {
        id: sourceRef(cut.sessionId, first).entryId,
        sources: group.length,
        prefixBound,
        release: incomplete ? 'unfinished_exchange' : protectedGroup ? 'protected' : 'available'
      }));
      next++;
      if (Buffer.byteLength(JSON.stringify(page())) > request.maxBytes) {
        items.pop();
        next--;
        break outer;
      }
      if (items.length >= request.limit) break outer;
    }
  }
  const result = page();
  if (
    (next === offset && next < total) ||
    Buffer.byteLength(JSON.stringify(result)) > request.maxBytes
  )
    throw new ToolInputError('Context inspection metadata cannot fit maxBytes; increase maxBytes.');
  return result;
}

function sourceDescription(
  entry: SessionBranchEntry,
  sessionId: string,
  group: {
    readonly id: string;
    readonly sources: number;
    readonly prefixBound: boolean;
    readonly release: 'available' | 'protected' | 'unfinished_exchange';
  }
) {
  const description =
    entry.type === 'input' ? entry.task
      : entry.type === 'steering' || entry.type === 'assistant' ? entry.content
        : entry.type === 'observation' ? `${entry.toolName}: ${entry.summary}`
          : entry.type === 'tool_call' ? JSON.stringify(entry.call) : entry.type;
  return {
    source: sourceRef(sessionId, entry),
    type: entry.type,
    description: textRange(description, 0, 200).text,
    sourceBytes: Buffer.byteLength(JSON.stringify(entry)),
    group
  };
}
