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
  const read = historyReadRequestSchema.omit({ cut: true });
  const search = z.strictObject({
    query: z.string().max(4096).optional(),
    ...queryShape,
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
            'working_state'
          ])
          .optional(),
        role: z.enum(['user', 'assistant', 'tool', 'control']).optional(),
        runId: z.string().optional(),
        toolName: z.string().optional(),
        resource: z.string().optional()
      })
      .optional()
  });
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
          totalBytes: result.totalBytes
        };
        return [
          { type: 'text', text: JSON.stringify(range) },
          ...historyItemContent(item),
          ...(Array.isArray(neighbors) && neighbors.length
            ? [
                { type: 'text' as const, text: 'Neighboring history:' },
                ...neighbors.flatMap(historyItemContent)
              ]
            : [])
        ];
      },
      async canonicalize(value) {
        const cut = await options.history.capture();
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
      name: `${prefix}_search`,
      description:
        'Literal search of original branch-visible history with source filters, bounded scan and stable cursor. No semantic ranking.',
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
      async invoke(value) {
        await options.history.validateCut(historyCutSchema.parse(value.authorizedCut));
        const request = search.parse(value.request);
        return options.history.search({
          ...request,
          ...(request.cursor ? {} : { cut: historyCutSchema.parse(value.authorizedCut) })
        });
      }
    })
  ]);
}
