import { parseJsonObject, parseJsonValue } from '@agent-core/json';
import {
  defaultToolModelContent,
  defineTool,
  unicodeTextSchema,
  type CompiledToolDefinition
} from '@agent-core/tools';
import * as z from 'zod';
import { historyCutSchema, sourceSchema } from '../history/schema.js';
import { scopedTool, scopePath, invocationIdentity } from '../history/tool-support.js';
import { contextTransitionRequestSchema } from './schema.js';
import { hashJson } from '@agent-core/persistence';
import type { ContextService } from './service.js';
export function createContextTools(options: {
  readonly context: ContextService;
  readonly prefix?: string;
}): readonly CompiledToolDefinition[] {
  const prefix = options.prefix ?? 'context';
  const sources = z.array(sourceSchema).max(10000).readonly();
  const transition = z
    .strictObject({
      reason: z.string().min(1),
      retain: sources.optional(),
      add: sources.optional(),
      release: sources.optional(),
      workingState: unicodeTextSchema.optional(),
      continuation: z.enum(['preserve', 'fresh']).default('preserve'),
      strategy: z.enum(['sources', 'provider']).default('sources')
    })
    .refine(
      (input) => input.retain === undefined || input.release === undefined,
      'Use retain for a replacement or add/release to edit the current selection.'
    )
    .refine(
      (input) => input.continuation !== 'fresh' || input.strategy === 'sources',
      'A fresh continuation uses original sources, not native compaction.'
    );
  return Object.freeze([
    scopedTool({
      name: `${prefix}_inspect`,
      description:
        'Inspect selected history and current working state, compiled request capacity, admission conflicts, and available context operations.',
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
        const capacitySummary = capacity
          ? Object.fromEntries(
              Object.entries(capacity).filter(
                ([key]) => !['method', 'unknownComponents', 'outputReservation'].includes(key)
              )
            )
          : undefined;
        return [
          {
            type: 'text',
            text: JSON.stringify({
              admission: admission
                ? { status: admission.status, message: admission.message }
                : 'not_yet_recorded',
              capacity: capacitySummary,
              ...(accounting
                ? {
                    accounting: {
                      method: accounting.method,
                      estimatedInputTokens: accounting.estimatedInputTokens,
                      uncertainty: accounting.uncertainty,
                      unknownComponents: accounting.unknownComponents,
                      outputReservation: accounting.outputReservation,
                      outputReservationSource: accounting.outputReservationSource,
                      reasoningReservation: accounting.reasoningReservation,
                      reasoningIncludedInOutput: parseJsonObject(accounting.pricingSemantics)
                        .reasoningIncludedInOutput,
                      limits: accounting.limits,
                      inputTokensMeaning:
                        'Capacity inputTokens = ceil(estimatedInputTokens × (1 + uncertainty.headroomRatio)). Provider counting is exact; compatible provider usage calibrates an unchanged prefix plus estimated additions. Unknown components remain unquantified and do not establish overflow. Unquantified components under an explicit token or cost budget require a finite model input bound. Reservations otherwise use the count or estimate; actual usage settles the invocation.'
                    }
                  }
                : {}),
              selection: window?.selection ?? null,
              workingState: result.workingState,
              protectedSources: result.protectedSources,
              pendingWork: result.pendingWork,
              legalTransitions: result.legalTransitions,
              sourceBudget: result.budget
            })
          }
        ];
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
    defineTool({
      name: `${prefix}_transition`,
      implementationId: 'agent-core.context-transition.v1',
      description:
        'Change the active context without summarizing history. Add or release source references; release applies to the complete exchange. Supply retain to replace optional history (an empty array releases it all). Active input and required exchanges remain protected. Optionally replace workingState in the same atomic transition. Fresh continuation explicitly ends native reasoning while keeping the session and selected originals. Use provider strategy only to request native compaction. No change requires no call.',
      schema: transition,
      outputSchema: z.json().transform((value) => parseJsonValue(value)),
      effectEnvelope: {
        accesses: [
          { mode: 'write', scope: 'context' },
          { mode: 'write', scope: 'working_state' }
        ],
        lockScopes: ['context', 'working_state']
      },
      async canonicalizeInput(value, planning) {
        if (!planning.invocation) throw new Error('Context operation requires an invocation.');
        const origin = await options.context.workingStateOrigin(planning.invocation);
        const cut = await options.context.history.capture();
        if (cut.sessionId !== origin.sessionId || cut.branchId !== origin.branchId)
          throw new Error('Context branch changed after the originating inference.');
        const window = await options.context.history.selectedContext(cut);
        const selection = await options.context.selectSources(cut, value);
        const identity = invocationIdentity(planning);
        return {
          ...value,
          origin,
          cut,
          expectedWindowId: window?.windowId ?? null,
          selection: {
            ...selection,
            strategy: value.strategy,
            ...(value.continuation === 'fresh'
              ? {
                  continuity: {
                    kind: 'fresh' as const,
                    resetId: identity,
                    model: options.context.currentModel(),
                    sources: selection.retained
                  }
                }
              : {})
          },
          identity,
          stateId: `working-state-${hashJson({ invocation: identity, text: value.workingState ?? null })}`
        };
      },
      deriveEffects(value) {
        const contextScope = scopePath('context', value.cut.sessionId, value.cut.branchId);
        const stateScope = scopePath('working_state', value.cut.sessionId, value.cut.branchId);
        const scopes =
          value.workingState === undefined ? [contextScope] : [contextScope, stateScope];
        return {
          accesses: scopes.map((scope) => ({ mode: 'write' as const, scope })),
          lockScopes: scopes,
          recovery: { kind: 'unknown' as const }
        };
      },
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        return [{ type: 'text', text: JSON.stringify(observation.output) }];
      },
      async invoke(value, execution) {
        const current = await options.context.history.capture();
        if (current.sessionId !== value.cut.sessionId || current.branchId !== value.cut.branchId)
          throw new Error('Context branch changed after authorization.');
        let workingState;
        if (value.workingState !== undefined) {
          const staged = await options.context.stageWorkingState({
            id: value.stateId,
            revisionId: value.origin.revisionId,
            inference: value.origin.inference,
            text: value.workingState
          });
          if ('status' in staged && staged.status !== 'unchanged')
            return {
              kind: 'result',
              execution: { state: 'settled' },
              summary: `Context update: ${staged.status}.`,
              output: parseJsonValue(staged),
              scope: {
                resources: [scopePath('context', value.cut.sessionId, value.cut.branchId)],
                coverage: 'complete'
              }
            };
          if (!('status' in staged)) workingState = staged;
        }
        const invocation = execution.invocation;
        if (!invocation) throw new Error('Context operation requires an invocation.');
        const { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt } = invocation;
        const result = await options.context.schedule(
          contextTransitionRequestSchema.parse({
            toolInvocation: { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt },
            expectedWindowId: value.expectedWindowId,
            expectedSourceRevision: value.cut.sourceRevision,
            expectedWorkingStateRevisionId: value.origin.revisionId,
            ...(workingState ? { workingState } : {}),
            idempotencyKey: value.identity,
            reason: value.reason,
            selection: value.selection
          })
        );
        return {
          kind: 'result',
          execution: { state: 'settled' },
          summary: 'Context selection scheduled; activation requires admission.',
          output: { status: 'scheduled', ...result },
          scope: {
            resources: [scopePath('context', value.cut.sessionId, value.cut.branchId)],
            coverage: 'complete'
          }
        };
      }
    })
  ]);
}
