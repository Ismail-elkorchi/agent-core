import { historyCutSchema } from '../history/schema.js';
import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import type { CompiledToolDefinition } from '@agent-core/tools';
import { scopedTool, scopePath } from '../history/tool-support.js';
import type { ContextService } from './service.js';
import { contextSelectionSchema, contextTransitionRequestSchema } from './schema.js';
export function createContextTools(options: {
  readonly context: ContextService;
  readonly prefix?: string;
}): readonly CompiledToolDefinition[] {
  const prefix = options.prefix ?? 'context';
  const transition = contextTransitionRequestSchema
    .unwrap()
    .extend({ selection: contextSelectionSchema.unwrap().omit({ providerState: true }) });
  return Object.freeze([
    scopedTool({
      name: `${prefix}_inspect`,
      description:
        'Inspect the current context window, byte budget, pending work, and legal transition options.',
      schema: z.strictObject({}),
      mode: 'read',
      root: 'context',
      async canonicalize(value) {
        const cut = await options.context.history.capture();
        return {
          value: parseJsonObject({ ...value, authorizedCut: cut }),
          scope: scopePath('context', cut.sessionId, cut.branchId)
        };
      },
      invoke(value) {
        return options.context.inspect(historyCutSchema.parse(value.authorizedCut));
      }
    }),
    scopedTool({
      name: `${prefix}_transition`,
      description:
        'Request a retained history/note selection at a host-validated provider boundary. This schedules a transition; it does not clear history or commit a window inside this tool.',
      schema: transition,
      mode: 'write',
      root: 'context',
      async canonicalize(value) {
        const cut = await options.context.history.capture();
        return {
          value: parseJsonObject({
            ...value,
            expectedSourceRevision: value.expectedSourceRevision ?? cut.sourceRevision
          }),
          scope: scopePath('context', cut.sessionId, cut.branchId)
        };
      },
      invoke(value) {
        return options.context.schedule(contextTransitionRequestSchema.parse(value));
      }
    })
  ]);
}
