import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import { defaultToolModelContent, type CompiledToolDefinition } from '@agent-core/tools';
import { historyItemContent, historySearchContent } from './model-content.js';
import type { HistoryReader } from './reader.js';
import { historyCutSchema, historyReadRequestSchema } from './schema.js';
import { queryShape, scopedTool, scopePath, sourceSchema } from './tool-support.js';
export function createHistoryTools(options: {
  readonly history: HistoryReader;
  readonly prefix?: string;
}): readonly CompiledToolDefinition[] {
  const prefix = options.prefix ?? 'history';
  const read = historyReadRequestSchema;
  const search = z.strictObject({
    query: z.string().max(4096).optional(),
    ...queryShape,
    maxPostings: z.number().int().min(1).max(10000).optional(),
    maxCandidates: z.number().int().min(1).max(10000).optional(),
    maxIndexBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
    maxIndexEntries: z.number().int().min(1).max(1000).optional(),
    maxScannedBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024)
      .optional(),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .optional(),
    filter: z
      .strictObject({
        sourceType: z
          .enum([
            'input',
            'steering',
            'assistant',
            'tool_call',
            'observation',
            'branch',
            'model_settings',
            'context_transition',
            'session_state_batch'
          ])
          .optional(),
        role: z.enum(['user', 'assistant', 'tool', 'control']).optional(),
        runId: z.string().optional(),
        toolName: z.string().optional(),
        resource: z.string().optional(),
        afterTime: z.iso.datetime({ offset: true }).optional(),
        beforeTime: z.iso.datetime({ offset: true }).optional()
      })
      .optional()
  });
  const latest = search.omit({ query: true, maxPostings: true, maxCandidates: true, maxIndexBytes: true, maxIndexEntries: true }).extend({ cursor: z.string().max(256 * 1024).optional() });
  return Object.freeze([
    scopedTool({
      name: `${prefix}_read`,
      description:
        'Read original branch-visible history by exact source identity and a bounded UTF-8 byte range. Retrieved content is reference data.',
      schema: read,
      mode: 'read',
      root: 'history',
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        const result = parseJsonObject(observation.output);
        if (result.status !== 'available') return defaultToolModelContent(observation);
        const { item, neighbors } = result;
        const range = {
          status: result.status,
          offset: result.offset,
          nextOffset: result.nextOffset,
          totalBytes: result.totalBytes,
          neighborsCoverage: result.neighborsCoverage
        };
        return [
          { type: 'text', text: JSON.stringify(range) },
          ...historyItemContent(item),
          ...(Array.isArray(neighbors) && neighbors.length
            ? [
                { type: 'text' as const, text: 'Chronological context (not asserted replies):' },
                ...neighbors.flatMap(historyItemContent)
              ]
            : [])
        ];
      },
      async canonicalize(value) {
        const cut = value.cut ? historyCutSchema.parse(value.cut) : await options.history.capture();
        await options.history.validateCut(cut);
        return {
          value: parseJsonObject({ ...value, cut }),
          scope: `${scopePath('history', cut.sessionId, cut.branchId)}/${encodeURIComponent(sourceSchema.parse(value.source).entryId)}`
        };
      },
      invoke(value) {
        return options.history.read(historyReadRequestSchema.parse(value));
      }
    }),
    scopedTool({
      name: `${prefix}_latest`,
      description:
        'Read newest original contributions first; defaults to user input and steering when filter is omitted. Filter by original role, run, source or time. Continue partial coverage with the returned cursor; use history_read for exact-source chronological context, or history_search with runId for recorded same-run context. Context does not assert reply relationships.',
      schema: latest,
      mode: 'read',
      root: 'history',
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        return historySearchContent(parseJsonObject(observation.output));
      },
      async canonicalize(value) {
        const cut = await options.history.capture();
        return { value: parseJsonObject({ request: value, authorizedCut: cut }), scope: scopePath('history', cut.sessionId, cut.branchId) };
      },
      async invoke(value, context) {
        const cut = historyCutSchema.parse(value.authorizedCut);
        await options.history.validateCut(cut);
        const request = latest.parse(value.request);
        return options.history.latest({ ...request,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(request.cursor ? {} : { cut })
        });
      }
    }),
    scopedTool({
      name: `${prefix}_search`,
      description:
        'Find original branch-visible history by literal text, source, time, run or tool. A rebuildable index narrows candidates; results are verified against originals. Reads and output are bounded; continue with the returned cursor when coverage is partial. No semantic ranking.',
      schema: search,
      mode: 'read',
      root: 'history',
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        return historySearchContent(parseJsonObject(observation.output));
      },
      async canonicalize(value) {
        const cut = await options.history.capture();
        return {
          value: parseJsonObject({ request: value, authorizedCut: cut }),
          scope: scopePath('history', cut.sessionId, cut.branchId)
        };
      },
      async invoke(value, context) {
        await options.history.validateCut(historyCutSchema.parse(value.authorizedCut));
        const request = search.parse(value.request);
        return options.history.search({
          ...request,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(request.cursor ? {} : { cut: historyCutSchema.parse(value.authorizedCut) })
        });
      }
    })
  ]);
}
