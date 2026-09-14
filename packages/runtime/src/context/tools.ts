import { parseJsonObject } from '@agent-core/json';
import type { CompiledToolDefinition } from '@agent-core/tools';
import * as z from 'zod';
import { historyCutSchema } from '../history/schema.js';
import { scopedTool, scopePath, invocationIdentity } from '../history/tool-support.js';
import { contextSelectionSchema, contextTransitionRequestSchema } from './schema.js';
import type { ContextService } from './service.js';
export function createContextTools(options: {
  readonly context: ContextService;
  readonly prefix?: string;
}): readonly CompiledToolDefinition[] {
  const prefix = options.prefix ?? 'context';
  const transition = z.strictObject({
    reason: z.string().min(1),
    selection: contextSelectionSchema
      .unwrap()
      .omit({ providerState: true, continuity: true, protected: true })
      .extend({
        strategy: z.enum(['sources', 'provider']).default('sources'),
        retained: contextSelectionSchema.unwrap().shape.retained.default([]),
        notes: contextSelectionSchema.unwrap().shape.notes.default([])
      })
      .optional()
  });
  return Object.freeze([
    scopedTool({
      name: `${prefix}_inspect`,
      description:
        'Inspect selected history and notes, compiled request capacity, admission conflicts, and available context operations.',
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
        'Request a fresh working window, optionally selecting original sources and note revisions. Active input and required tool exchanges are retained automatically. Original history remains retrievable.',
      schema: transition,
      mode: 'write',
      root: 'context',
      async canonicalize(value) {
        const cut = await options.context.history.capture();
        return {
          value: parseJsonObject({
            ...value,
            authorizedCut: cut,
            expectedWindowId: (await options.context.inspect(cut)).window?.windowId ?? null
          }),
          scope: scopePath('context', cut.sessionId, cut.branchId)
        };
      },
      invoke(value, execution) {
        const cut = historyCutSchema.parse(value.authorizedCut);
        const invocation = execution.invocation;
        if (!invocation) throw new Error('Context renewal requires its owning tool invocation.');
        const { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt } = invocation;
        return options.context.schedule(
          contextTransitionRequestSchema.parse({
            toolInvocation: { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt },
            expectedWindowId: value.expectedWindowId,
            expectedSourceRevision: cut.sourceRevision,
            idempotencyKey: invocationIdentity(execution),
            reason: value.reason,
            selection: value.selection ?? { strategy: 'sources', retained: [], notes: [] }
          })
        );
      }
    })
  ]);
}
