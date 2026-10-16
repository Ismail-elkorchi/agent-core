import { stageSessionState } from './session-state.js';
import { ContextInspectionSizeError, MAX_MANIFEST_BYTES, contextInspectionStartCursor, contextInspectionCursor, contextInspectionSchema } from './inspection.js';
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
        'Inspect the live selected sources at a captured boundary, including recent exchanges, protected input and native prefix dependencies. Source references can be passed unchanged to context_transition add/release. maxBytes bounds successful delivered JSON, including bookkeeping and cursor. Size errors provide measured bounds and cut-pinned retry arguments when supported. Continue with cursor for more sources. Capacity describes the last admitted request, not later tool results. No periodic inspection is required.',
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
        const present = (inspection: Awaited<ReturnType<ContextService['inspect']>>, excerptBudget: number) => {
          const active = inspection.activeSelection;
          return parseJsonObject({
            ...inspection,
            excerpts: excerptInspection(inspection.window?.selection.excerpts ?? [], page.limit, excerptBudget),
            activeSelection: active.status === 'available' ? active.manifest : active,
            window: inspection.window
              ? { windowId: inspection.window.windowId, historyPosition: inspection.window.historyPosition }
              : null
          });
        };
        let manifestBytes = page.maxBytes;
        try {
          while (manifestBytes > 0) {
            const inspection = await options.context.inspect(cut, { ...page, maxBytes: manifestBytes });
            const result = present(inspection, Math.floor(page.maxBytes / 4));
            const bytes = Buffer.byteLength(inspectionPresentation(result));
            if (bytes <= page.maxBytes) return result;
            const manifestSize = Buffer.byteLength(JSON.stringify(result.activeSelection));
            manifestBytes = Math.min(manifestBytes - 1, page.maxBytes - (bytes - manifestSize));
          }
        } catch (error) {
          if (!(error instanceof ContextInspectionSizeError)) throw error;
        }
        // Probe only one source at the same cut and within the schema ceiling. This
        // measures a sufficient retry budget, not a global minimum: a complete page
        // can be smaller than a partial page carrying a continuation cursor.
        const retryCursor = page.cursor ?? contextInspectionStartCursor(cut);
        let probe;
        try {
          probe = await options.context.inspect(cut, { cursor: retryCursor, limit: 1, maxBytes: MAX_MANIFEST_BYTES });
        } catch (error) {
          if (!(error instanceof ContextInspectionSizeError)) throw error;
          throw new ToolInputError('Context inspection cannot fit maxBytes: the candidate manifest exceeds the supported maximum.', {
            code: 'context_inspection_max_bytes', requestedMaxBytes: page.maxBytes,
            maxAllowedBytes: MAX_MANIFEST_BYTES, requiredManifestBytes: error.requiredManifestBytes,
            retry: null
          });
        }
        // Use the largest allowed excerpt allowance, so the suggested retry never
        // underestimates extra excerpt inventory revealed by increasing maxBytes.
        const candidate = present(probe, Math.floor(MAX_MANIFEST_BYTES / 4));
        const suggestedMaxBytes = Buffer.byteLength(inspectionPresentation(candidate));
        const retry = suggestedMaxBytes <= MAX_MANIFEST_BYTES
          ? { cursor: retryCursor, limit: 1, maxBytes: suggestedMaxBytes } : null;
        throw new ToolInputError(retry
          ? `Context inspection cannot fit maxBytes=${String(page.maxBytes)}. Retry with limit=1 and maxBytes=${String(suggestedMaxBytes)} using the supplied cursor.`
          : 'Context inspection cannot fit maxBytes: the measured one-source result exceeds the supported maximum.', {
          code: 'context_inspection_max_bytes', requestedMaxBytes: page.maxBytes,
          maxAllowedBytes: MAX_MANIFEST_BYTES, measuredPageBytes: suggestedMaxBytes,
          measurement: 'one_source_page_with_maximum_excerpt_allowance', retry
        });
      }
    }),
    defineTool({
      name: `${prefix}_transition`,
      implementationId: 'agent-core.context-transition.v1',
      description:
        `${SESSION_STATE_GUIDANCE} Change the active context without summarizing history. Add or release source references; release applies to the complete exchange. Supply retain to replace optional history (an empty array releases it all). Active input and required exchanges remain protected. Optionally replace narrative sessionState blocks in the same atomic transition. recentFrom retains the active source suffix beginning at that exact reference, with complete exchanges. excerpts replaces retained exact text spans ({source,offset,bytes}, UTF-8 byte boundaries); excerpts are attributed historical evidence, not conversation replay, and cannot replace mandatory originals. Source-preserving state updates preserve lawful provider continuation; selection edits, capacity recovery, and incompatible prefixes start fresh. Set renewal:true to deliberately start fresh even without a content change. Identical updates are unchanged. Clearing state does not delete history or earlier provider-visible state. A successful scheduled receipt is pending: the runtime first completes this exchange and admits the actual next request before atomically publishing state and selection.`,
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
          'inputTokens = ceil(estimatedInputTokens × (1 + uncertainty.headroomRatio)). Provider counts are exact; compatible usage calibrates unchanged prefixes plus estimated additions. Unknowns do not prove overflow; budgeted unknowns require a finite input bound. Reservations use counts/estimates; actual usage settles.'
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
