import { stageSessionState } from './session-state.js';
import { contextInspectionCursor, contextInspectionSchema } from './inspection.js';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import {
  defaultToolModelContent,
  ToolInputError,
  defineTool,
  type ToolCanonicalizationContext,
  type ToolExecutionContext,
  type ToolObservationInput,
  type CompiledToolDefinition
} from '@agent-core/tools';
import * as z from 'zod';
import { historyCutSchema, sourceSchema, sourceExcerptSchema } from '../history/schema.js';
import { scopedTool, scopePath, invocationIdentity } from '../history/tool-support.js';
import { contextTransitionRequestSchema } from './schema.js';
import { hashJson, type ArtifactRepository } from '@agent-core/persistence';
import { SESSION_STATE_GUIDANCE, sessionStateContentSchema } from '../session/session-state.js';
import type { HistorySourceExcerpt } from '../history/contracts.js';
import type { ContextService } from './service.js';
/** Internal construction receives explicit owned storage, never a public staging capability. */
export function contextToolDefinitions(options: {
  readonly context: ContextService;
  readonly artifacts: ArtifactRepository;
  readonly maxSourceBytes: number;
  readonly prefix?: string;
}): readonly CompiledToolDefinition[] {
  const prefix = options.prefix ?? 'context';
  const sources = z.array(sourceSchema).max(10000).readonly();
  const transition = z
    .strictObject({
      reason: z.string().min(1),
      renewal: z.boolean().optional(),
      retain: sources.optional(),
      add: sources.optional(),
      release: sources.optional(),
      recentFrom: sourceSchema.optional(),
      excerpts: z.array(sourceExcerptSchema).max(10000).readonly().optional(),
      sessionState: sessionStateContentSchema.optional(),
      declaredHistoryCut: historyCutSchema.optional()
    })
    .refine(
      (input) => input.retain === undefined || (input.release === undefined && input.recentFrom === undefined),
      'Use retain for a replacement or add/release to edit the current selection.'
    );
  const canonicalize = async (value: z.output<typeof transition>, planning: ToolCanonicalizationContext) => {
    if (!planning.invocation) throw new Error('Context operation requires an invocation.');
    const origin = await options.context.sessionStateOrigin(planning.invocation);
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
      selection,
      identity,
      stateId: `session-state-${hashJson({ invocation: identity, content: value.sessionState ?? null })}`
    };
  };
  const observe = async (value: Awaited<ReturnType<typeof canonicalize>>, execution: ToolExecutionContext): Promise<ToolObservationInput<JsonValue>> => {
    const current = await options.context.history.capture();
    if (current.sessionId !== value.cut.sessionId || current.branchId !== value.cut.branchId)
      throw new Error('Context branch changed after authorization.');
    const committed = await options.context.findTransition(value.identity);
    if (committed) return {
      kind: 'result', execution: { state: 'settled' },
      summary: 'Context transition committed after admission.',
      output: { status: 'committed', windowId: committed.window.windowId },
      scope: { resources: [scopePath('context', value.cut.sessionId, value.cut.branchId)], coverage: 'complete' }
    };
    let sessionState;
    if (value.sessionState !== undefined) {
      const staged = await stageSessionState(options.context, options, {
        id: value.stateId,
        revisionId: value.origin.revisionId,
        inference: value.origin.inference,
        content: value.sessionState,
        capturedHistoryCut: value.origin.capturedHistoryCut,
        ...(value.declaredHistoryCut ? { declaredHistoryCut: value.declaredHistoryCut } : {})
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
      if (!('status' in staged)) sessionState = staged;
    }
    const invocation = execution.invocation;
    if (!invocation) throw new Error('Context operation requires an invocation.');
    const { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt } = invocation;
    const result = await options.context.schedule(
      contextTransitionRequestSchema.parse({
        toolInvocation: { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt },
        expectedCut: value.cut,
        expectedWindowId: value.expectedWindowId,
        expectedSourceRevision: value.cut.sourceRevision,
        expectedSessionStateRevisionId: value.origin.revisionId,
        ...(sessionState ? { sessionState } : {}),
        idempotencyKey: value.identity,
        reason: value.reason,
        ...(value.renewal === undefined ? {} : { renewal: value.renewal }),
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
  };
  return Object.freeze([
    scopedTool({
      name: `${prefix}_inspect`,
      description:
        'Inspect the live selected sources at a captured boundary, including recent exchanges, protected input and native prefix dependencies. Source references can be passed unchanged to context_transition add/release. maxBytes bounds the complete delivered JSON, including bookkeeping and cursor. Continue with cursor for more sources. Capacity describes the last admitted request, not later tool results. No periodic inspection is required.',
      schema: contextInspectionSchema,
      mode: 'read',
      root: 'context',
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        const result = parseJsonObject(observation.output);
        return [{ type: 'text', text: inspectionPresentation(result) }];
      },
      async canonicalize(value) {
        const cut = await options.context.history.capture();
        return {
          value: parseJsonObject({ ...value, authorizedCut: cut }),
          scope: scopePath('context', cut.sessionId, cut.branchId)
        };
      },
      async invoke(value) {
        const authorized = historyCutSchema.parse(value.authorizedCut);
        await options.context.history.validateCut(authorized);
        const page = contextInspectionSchema.parse({
          cursor: value.cursor,
          limit: value.limit,
          maxBytes: value.maxBytes
        });
        const cut = page.cursor ? contextInspectionCursor(page.cursor).cut : authorized;
        if (cut.sessionId !== authorized.sessionId || cut.branchId !== authorized.branchId)
          throw new Error('Context inspection cursor belongs to another branch.');
        await options.context.history.validateCut(cut);
        // maxBytes bounds the complete model-facing JSON, not just its source list.
        // Re-page at the same cut so shrinking preserves exact cursor/coverage semantics.
        let manifestBytes = page.maxBytes;
        while (manifestBytes > 0) {
          const inspection = await options.context.inspect(cut, { ...page, maxBytes: manifestBytes });
          const active = inspection.activeSelection;
          const result = parseJsonObject({
            ...inspection,
            excerpts: excerptInspection(inspection.window?.selection.excerpts ?? [], page.limit, Math.floor(page.maxBytes / 4)),
            activeSelection: active.status === 'available' ? active.manifest : active,
            window: inspection.window
              ? { windowId: inspection.window.windowId, historyPosition: inspection.window.historyPosition }
              : null
          });
          const bytes = Buffer.byteLength(inspectionPresentation(result));
          if (bytes <= page.maxBytes) return result;
          const manifestSize = Buffer.byteLength(JSON.stringify(result.activeSelection));
          // Account for actual page size, not unused requested space: oversized fixed
          // bookkeeping must fail immediately instead of shrinking one byte per pass.
          manifestBytes = Math.min(manifestBytes - 1, page.maxBytes - (bytes - manifestSize));
        }
        throw new ToolInputError('Context inspection cannot fit maxBytes including required metadata and pagination. Increase maxBytes.');
      }
    }),
    defineTool({
      name: `${prefix}_transition`,
      implementationId: 'agent-core.context-transition.v1',
      description:
        `${SESSION_STATE_GUIDANCE} Change the active context without summarizing history. Add or release source references; release applies to the complete exchange. Supply retain to replace optional history (an empty array releases it all). Active input and required exchanges remain protected. Optionally replace structured sessionState in the same atomic transition. recentFrom retains the active source suffix beginning at that exact reference, with complete exchanges. excerpts replaces retained exact text spans ({source,offset,bytes}, UTF-8 byte boundaries); excerpts are attributed historical evidence, not conversation replay, and cannot replace mandatory originals. Source-preserving state updates preserve lawful provider continuation; selection edits, capacity recovery, and incompatible prefixes start fresh. Set renewal:true to deliberately start fresh even without a content change. Identical updates are unchanged. Clearing state does not delete history or earlier provider-visible state. A successful scheduled receipt is pending: the runtime first completes this exchange and admits the actual next request before atomically publishing state and selection.`,
      schema: transition,
      outputSchema: z.json().transform((value) => parseJsonValue(value)),
      effectEnvelope: {
        accesses: [
          { mode: 'write', scope: 'context' },
          { mode: 'write', scope: 'session_state' }
        ],
        lockScopes: ['context', 'session_state']
      },
      canonicalizeInput: canonicalize,

      deriveEffects(value) {
        const contextScope = scopePath('context', value.cut.sessionId, value.cut.branchId);
        const stateScope = scopePath('session_state', value.cut.sessionId, value.cut.branchId);
        const scopes =
          value.sessionState === undefined ? [contextScope] : [contextScope, stateScope];
        return {
          accesses: scopes.map((scope) => ({ mode: 'write' as const, scope })),
          lockScopes: scopes,
          recovery: {
            kind: 'buffered_mutation' as const,
            transactionId: value.identity,
            reconcilerId: 'agent-core.context-transition.v1',
            authority: contextScope
          }
        };
      },
      buildModelContent({ observation }) {
        if (observation.kind !== 'result') return defaultToolModelContent(observation);
        return [{ type: 'text', text: JSON.stringify(observation.output) }];
      },
      invoke: observe,
      async recover(value, _effect, execution) {
        return { status: 'settled', observation: await observe(value, execution) };
      }
    })
  ]);
}

/** A bounded, explicitly partial inventory; original spans remain in the committed selection. */
function excerptInspection(excerpts: readonly HistorySourceExcerpt[], limit: number, maxBytes: number) {
  const items: HistorySourceExcerpt[] = [];
  let bytes = 0;
  for (const excerpt of excerpts) {
    const size = Buffer.byteLength(JSON.stringify(excerpt));
    if (items.length >= limit || bytes + size > maxBytes) break;
    items.push(excerpt);
    bytes += size;
  }
  return { items, totalCount: excerpts.length, textBytes: excerpts.reduce((sum, excerpt) => sum + excerpt.bytes, 0),
    coverage: items.length === excerpts.length ? 'complete' : 'partial' };
}

function inspectionPresentation(result: JsonObject): string {
  const admission = result.admission ? parseJsonObject(result.admission) : undefined;
  const accounting = admission ? parseJsonObject(admission.accounting) : undefined;
  const capacity = result.capacity ? parseJsonObject(result.capacity) : undefined;
  const capacitySummary = capacity
    ? Object.fromEntries(Object.entries(capacity).filter(
        ([key]) => !['method', 'unknownComponents', 'outputReservation'].includes(key)))
    : undefined;
  return JSON.stringify({
    admission: admission
      ? { status: admission.status, inputIdentity: admission.inputIdentity, message: admission.message }
      : 'not_yet_recorded',
    capacity: capacitySummary,
    ...(accounting ? {
      accounting: {
        method: accounting.method,
        estimatedInputTokens: accounting.estimatedInputTokens,
        uncertainty: accounting.uncertainty,
        unknownComponents: accounting.unknownComponents,
        outputReservation: accounting.outputReservation,
        outputReservationSource: accounting.outputReservationSource,
        reasoningReservation: accounting.reasoningReservation,
        reasoningIncludedInOutput: parseJsonObject(accounting.pricingSemantics).reasoningIncludedInOutput,
        limits: accounting.limits,
        inputTokensMeaning:
          'Capacity inputTokens = ceil(estimatedInputTokens × (1 + uncertainty.headroomRatio)). Provider counting is exact; compatible provider usage calibrates an unchanged prefix plus estimated additions. Unknown components remain unquantified and do not establish overflow. Unquantified components under an explicit token or cost budget require a finite model input bound. Reservations otherwise use the count or estimate; actual usage settles the invocation.'
      }
    } : {}),
    selection: result.activeSelection,
    excerpts: result.excerpts,
    committedWindow: result.window,
    sessionState: result.sessionState,
    protectedSources: result.protectedSources,
    pendingWork: result.pendingWork,
    legalTransitions: result.legalTransitions,
    sourceBudget: result.budget
  });
}
