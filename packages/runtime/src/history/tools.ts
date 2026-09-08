import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import type { CompiledToolDefinition } from '@agent-core/tools';
import type { HistoryReader } from './reader.js';
import { historyCutSchema } from './schema.js';
import { queryShape, rangeShape, scopedTool, scopePath, sourceSchema } from './tool-support.js';
export function createHistoryTools(options: {
  readonly history: HistoryReader;
  readonly prefix?: string;
}): readonly CompiledToolDefinition[] {
  const prefix = options.prefix ?? 'history';
  const read = z.strictObject({
    source: sourceSchema,
    ...rangeShape,
    neighbors: z.number().int().min(0).max(10).optional()
  });
  const search = z.strictObject({
    query: z.string().max(4096).optional(),
    ...queryShape,
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
            'context_transition'
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
      async canonicalize(value) {
        const cut = await options.history.capture();
        return {
          value: parseJsonObject({ ...value, cut }),
          scope: `${scopePath('history', cut.sessionId, cut.branchId)}/${encodeURIComponent(sourceSchema.parse(value.source).entryId)}`
        };
      },
      invoke(value) {
        return options.history.read(read.extend({ cut: historyCutSchema.optional() }).parse(value));
      }
    }),
    scopedTool({
      name: `${prefix}_search`,
      description:
        'Literal search of original branch-visible history with source filters, bounded scan and stable cursor. No semantic ranking.',
      schema: search,
      mode: 'read',
      root: 'history',
      async canonicalize(value) {
        const cut = await options.history.capture();
        return {
          value: parseJsonObject({ request: value, authorizedCut: cut }),
          scope: scopePath('history', cut.sessionId, cut.branchId)
        };
      },
      async invoke(value) {
        await options.history.view(historyCutSchema.parse(value.authorizedCut));
        const request = search.parse(value.request);
        return options.history.search({
          ...request,
          ...(request.cursor ? {} : { cut: historyCutSchema.parse(value.authorizedCut) })
        });
      }
    })
  ]);
}
