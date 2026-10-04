import { parseJsonObject } from '@agent-core/json';
import { defaultToolModelContent, type CompiledToolDefinition } from '@agent-core/tools';
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
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        const result = parseJsonObject(observation.output);
        const admission = result.admission ? parseJsonObject(result.admission) : undefined;
        const accounting = admission ? parseJsonObject(admission.accounting) : undefined;
        const window = result.window ? parseJsonObject(result.window) : undefined;
        const capacity = result.capacity ? parseJsonObject(result.capacity) : undefined;
        const capacitySummary = capacity ? Object.fromEntries(Object.entries(capacity).filter(([key]) =>
          !['method', 'unknownComponents', 'outputReservation'].includes(key)
        )) : undefined;
        return [{ type: 'text', text: JSON.stringify({
          admission: admission ? { status: admission.status, message: admission.message } : 'not_yet_recorded',
          capacity: capacitySummary,
          ...(accounting ? { accounting: {
            method: accounting.method,
            estimatedInputTokens: accounting.estimatedInputTokens,
            uncertainty: accounting.uncertainty,
            unknownComponents: accounting.unknownComponents,
            outputReservation: accounting.outputReservation,
            outputReservationSource: accounting.outputReservationSource,
            reasoningReservation: accounting.reasoningReservation,
            reasoningIncludedInOutput: parseJsonObject(accounting.pricingSemantics).reasoningIncludedInOutput,
            limits: accounting.limits,
            inputTokensMeaning: 'Capacity inputTokens = ceil(estimatedInputTokens × (1 + uncertainty.headroomRatio)). Provider counting is exact; compatible provider usage calibrates an unchanged prefix plus estimated additions. Unknown components remain unquantified and do not establish overflow. Unquantified components under an explicit token or cost budget require a finite model input bound. Reservations otherwise use the count or estimate; actual usage settles the invocation.'
          } } : {}),
          selection: window?.selection ?? null,
          protectedSources: result.protectedSources,
          pendingWork: result.pendingWork,
          legalTransitions: result.legalTransitions,
          sourceBudget: result.budget
        }) }];
      },
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
        'Schedule a replacement context window from selected original sources and note revisions. Omitted selection removes all optional history and notes; this tool does not summarize them. Active input and required tool exchanges are retained automatically. Original history remains retrievable.',
      schema: transition,
      mode: 'write',
      root: 'context',
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        return [{ type: 'text', text: `Context replacement scheduled; activation still requires admission. ${JSON.stringify(observation.output)}` }];
      },
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
