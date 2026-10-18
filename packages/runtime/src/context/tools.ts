import { ContextInspectionSizeError, MAX_MANIFEST_BYTES, contextInspectionStartCursor, contextInspectionCursor, contextInspectionSchema } from './inspection.js';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import {
  defaultToolModelContent,
  artifactRefSchema,
  artifactScope,
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
import { hashJson, decodeOwnedArtifactRef, PersistenceConflictError, type ArtifactRepository } from '@agent-core/persistence';
import { SESSION_STATE_GUIDANCE, sessionStateOperationSchema, sessionStateItemRefSchema, plannedSessionStateRefs } from '../session/session-state.js';
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
  const selectionShape = {
    reason: z.string().min(1), renewal: z.boolean().optional(), retain: sources.optional(),
    add: sources.optional(), release: sources.optional(), recentFrom: sourceSchema.optional(),
    excerpts: z.array(sourceExcerptSchema).max(10000).readonly().optional(),
    sessionState: z.array(sessionStateItemRefSchema).max(10000).readonly().optional(),
    artifacts: z.array(z.discriminatedUnion('representation', [
      z.strictObject({ artifact: artifactRefSchema, representation: z.literal('reference') }),
      z.strictObject({ artifact: artifactRefSchema, representation: z.literal('text'),
        range: z.strictObject({ offset: z.int().nonnegative(), bytes: z.int().positive() }).optional() })
    ])).max(10000).readonly().optional()
  };
  const transition = z.strictObject(selectionShape);
  const save = z.strictObject({ operations: z.array(sessionStateOperationSchema).min(1).max(256).readonly() });
  const combined = z.strictObject({ ...selectionShape, operations: save.shape.operations,
    activateSaved: z.boolean().default(true) });
  const canonicalize = async (value: z.output<typeof transition> & { operations?: z.output<typeof save>['operations']; activateSaved?: boolean }, planning: ToolCanonicalizationContext) => {
    if (!planning.invocation) throw new Error('Context operation requires an invocation.');
    const origin = await options.context.sessionStateOrigin(planning.invocation);
    const cut = await options.context.history.capture();
    if (cut.sessionId !== origin.sessionId || cut.branchId !== origin.branchId)
      throw new Error('Context branch changed after the originating inference.');
    const window = await options.context.history.selectedContext(cut);
    const identity = invocationIdentity(planning);
    const batch = value.operations ? { idempotencyKey: identity, branchId: origin.branchId,
      capturedHistoryCut: origin.capturedHistoryCut, inference: origin.inference, operations: value.operations } : undefined;
    const changed = batch ? plannedSessionStateRefs(batch) : undefined;
    const { artifacts, ...sourceChange } = value;
    const selection = await options.context.selectSources(cut, { ...sourceChange, ...(artifacts ? { artifacts: artifacts.map(value => {
      const ref = decodeOwnedArtifactRef(parseJsonObject(value.artifact));
      if (ref.visibility !== 'public') throw new Error('Only public artifacts may enter a selected view.');
      return value.representation === 'reference' ? { artifact: ref, representation: 'reference' as const }
        : { artifact: ref, representation: 'text' as const, ...(value.range ? { range: value.range } : {}) };
    }) } : {}) });
    return { ...value, cut, expectedWindowId: window?.windowId ?? null, identity,
      ...(batch ? { batch } : {}),
      selection: value.activateSaved && changed ? { ...selection,
        sessionState: [...(selection.sessionState ?? []).filter(ref => !changed.some(revision => revision.itemId === ref.itemId)), ...changed.filter(item => !item.deleted).map(({ itemId, revisionId }) => ({ itemId, revisionId }))] } : selection };
  };
  const observe = async (value: Awaited<ReturnType<typeof canonicalize>>, execution: ToolExecutionContext): Promise<ToolObservationInput<JsonValue>> => {
    const current = await options.context.history.capture();
    if (current.sessionId !== value.cut.sessionId || current.branchId !== value.cut.branchId)
      throw new Error('Context branch changed after authorization.');
    const committed = await options.context.findTransition(value.identity);
    if (committed && value.batch && committed.sessionState?.fingerprint !== hashJson(value.batch))
      throw new ToolInputError('Context idempotency key has conflicting state operations.');
    if (committed) return { kind: 'result', execution: { state: 'settled' },
      scope: { resources: [scopePath('context', value.cut.sessionId, value.cut.branchId)], coverage: 'complete' },
      summary: 'Context view committed after admission.', output: { status: 'committed', windowId: committed.window.windowId } };
    const staged = value.batch ? await options.context.stageSessionState(value.batch).catch(stateToolFailure) : undefined;
    const invocation = execution.invocation;
    if (!invocation) throw new Error('Context operation requires an invocation.');
    const { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt } = invocation;
    const result = await options.context.schedule(contextTransitionRequestSchema.parse({
      toolInvocation: { runId, turnId, requestAttempt, toolBatchId, callIndex, toolAttempt },
      expectedCut: value.cut, expectedWindowId: value.expectedWindowId, expectedSourceRevision: value.cut.sourceRevision,
      ...(staged ? { sessionState: staged } : {}), idempotencyKey: value.identity,
      reason: value.reason, ...(value.renewal === undefined ? {} : { renewal: value.renewal }), selection: value.selection
    }));
    return { kind: 'result', execution: { state: 'settled' },
      scope: { resources: [scopePath('context', value.cut.sessionId, value.cut.branchId)], coverage: 'complete' },
      summary: 'View activation scheduled; the exact successor must pass admission before publication.',
      output: { status: 'scheduled', ...result } };
  };
  const viewTool = (atomic: boolean) => defineTool({
    name: `${prefix}_${atomic ? 'save_and_activate' : 'transition'}`,
    implementationId: `agent-core.context-${atomic ? 'save-and-activate' : 'transition'}.v2`,
    description: `${SESSION_STATE_GUIDANCE} ${atomic
      ? 'Atomically save conditional narrative item changes and activate the selected view, or publish neither if admission fails. activateSaved replaces selected references for touched items with their new revisions and removes deleted items from the view. Set activateSaved=false to use the explicitly supplied view unchanged.'
      : 'Activate exact existing item revisions and historical sources without saving state.'} retain replaces optional original sources; add/release edits complete exchanges. Active accepted inputs remain protected. renewal deliberately starts a new provider continuation. A scheduled result is pending until the exact next request is admitted.`,
    schema: atomic ? combined : transition,
    outputSchema: z.json().transform(value => parseJsonValue(value)),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'session_state' }, { mode: 'read', scope: 'artifacts' }, { mode: 'write', scope: 'context' }, ...(atomic ? [{ mode: 'write' as const, scope: 'session_state' }] : [])],
      lockScopes: atomic ? ['context', 'session_state'] : ['context'] },
    canonicalizeInput: canonicalize,
    deriveEffects(value) {
      const contextScope = scopePath('context', value.cut.sessionId, value.cut.branchId);
      const scopes = [contextScope, ...(atomic ? [scopePath('session_state', value.cut.sessionId, value.cut.branchId)] : [])];
      return { accesses: [...scopes.map(scope => ({ mode: 'write' as const, scope })),
        ...(value.selection.sessionState?.length || value.batch?.operations.some(operation => operation.kind === 'edit')
          ? [{ mode: 'read' as const, scope: scopePath('session_state', value.cut.sessionId, value.cut.branchId) }] : []),
        ...(value.selection.artifacts ?? []).map(item => ({ mode: 'read' as const, scope: artifactScope(item.artifact.artifactId) }))], lockScopes: scopes,
        recovery: { kind: 'buffered_mutation' as const, transactionId: value.identity,
          reconcilerId: `agent-core.context-${atomic ? 'save-and-activate' : 'transition'}.v2`, authority: contextScope } };
    },
    invoke: observe,
    async recover(value, _effect, execution) { return { status: 'settled', observation: await observe(value, execution) }; }
  });
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
    scopedTool({
      name: `${prefix}_runtime_inspect`, description: 'Inspect effective capabilities, continuing-work allowance and active operations. Page capabilities with offset, limit and expectedRevision from the previous page. This is read-only; state storage and source-selection limits are separate from runtime budgets.',
      schema: z.strictObject({ target: z.enum(['configured', 'last_admitted']).optional(), offset: z.int().nonnegative().optional(), limit: z.int().min(1).max(256).optional(),
        expectedRevision: z.string().min(1).max(512).optional(), maxBytes: z.int().positive().max(262144).default(32768) }),
      mode: 'read', root: 'context',
      async canonicalize(value) { const cut = await options.context.history.capture(); return { value: parseJsonObject(value), scope: scopePath('context', cut.sessionId, cut.branchId) }; },
      async invoke(value) {
        const result = await options.context.inspectOperational({ ...(value.target === 'configured' || value.target === 'last_admitted' ? { target: value.target } : {}), ...(typeof value.offset === 'number' ? { offset: value.offset } : {}),
          ...(typeof value.limit === 'number' ? { limit: value.limit } : {}), ...(typeof value.expectedRevision === 'string' ? { expectedRevision: value.expectedRevision } : {}) });
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (typeof value.maxBytes !== 'number' || bytes > value.maxBytes) throw new ToolInputError('Runtime inspection exceeds maxBytes; reduce the capability page or raise the bound.',
          { code: 'runtime_inspection_max_bytes', requiredBytes: bytes, requestedMaxBytes: value.maxBytes ?? 0 });
        return result;
      }
    }),
    scopedTool({
      name: `${prefix}_state_list`, description: 'List stored narrative item metadata or exact currently selected revision references without loading bodies. Set view=selected for the active view; default stored lists current item heads. Continue with the returned cut-pinned cursor.',
      schema: z.strictObject({ view: z.enum(['stored', 'selected']).default('stored'), cursor: z.string().max(65536).optional(), limit: z.int().min(1).max(256).optional(), maxBytes: z.int().positive().max(65536).optional() }),
      mode: 'read', root: 'session_state',
      async canonicalize(value) { const cut = await options.context.history.capture(); return { value: parseJsonObject({ ...value, cut }), scope: scopePath('session_state', cut.sessionId, cut.branchId) }; },
      async invoke(value) { const cut = historyCutSchema.parse(value.cut); await options.context.history.validateCut(cut);
        return parseJsonValue(await (value.view === 'selected' ? (request: Parameters<ContextService['listSessionState']>[0]) => options.context.listSelectedSessionState(request, cut) : (request: Parameters<ContextService['listSessionState']>[0]) => options.context.listSessionState(request, cut))({
          ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
          ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
          ...(typeof value.maxBytes === 'number' ? { maxBytes: value.maxBytes } : {}) })); }
    }),
    scopedTool({
      name: `${prefix}_state_search`, description: 'Search current stored narrative text literally with bounded scanning and output. Partial results carry a query-pinned cursor. An unsearched oversized item needs a larger scan allowance; absence of a match is not complete coverage.',
      schema: z.strictObject({ query: z.string().min(1).max(1024), cursor: z.string().max(65536).optional(), limit: z.int().min(1).max(256).optional(),
        maxBytes: z.int().positive().max(1048576).optional(), maxScannedBytes: z.int().positive().max(16777216).optional() }),
      mode: 'read', root: 'session_state',
      async canonicalize(value) { const cut = await options.context.history.capture(); return { value: parseJsonObject({ ...value, authorizedCut: cut }), scope: scopePath('session_state', cut.sessionId, cut.branchId) }; },
      async invoke(value) {
        if (typeof value.query !== 'string') throw new ToolInputError('State search requires a string query.');
        return parseJsonValue(await options.context.searchSessionState({ query: value.query, cut: historyCutSchema.parse(value.authorizedCut),
        ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}), ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
        ...(typeof value.maxBytes === 'number' ? { maxBytes: value.maxBytes } : {}), ...(typeof value.maxScannedBytes === 'number' ? { maxScannedBytes: value.maxScannedBytes } : {}) })); }
    }),
    scopedTool({
      name: `${prefix}_state_read`, description: 'Read one exact narrative item revision, optionally an exact bounded UTF-8 byte range. Does not activate it.',
      schema: sessionStateItemRefSchema, mode: 'read', root: 'session_state',
      async canonicalize(value) { const cut = await options.context.history.capture(); return { value: parseJsonObject({ ref: value, cut }), scope: scopePath('session_state', cut.sessionId, cut.branchId) }; },
      async invoke(value) { return parseJsonValue(await options.context.readSessionState(sessionStateItemRefSchema.parse(value.ref), historyCutSchema.parse(value.cut))); }
    }),
    defineTool({
      name: `${prefix}_state_save`, implementationId: 'agent-core.session-state-save.v1',
      description: `${SESSION_STATE_GUIDANCE} Durably save a conditional atomic batch of create, replace, UTF-8 range edit, or remove operations. Does not compile or activate any model request. Runtime assigns item and revision identities and returns them in the durable receipt.`,
      schema: save,
      outputSchema: z.json().transform(value => parseJsonValue(value)),
      effectEnvelope: { accesses: [{ mode: 'write', scope: 'session_state' }, { mode: 'read', scope: 'session_state' }], lockScopes: ['session_state'] },
      async canonicalizeInput(value, planning) {
        if (!planning.invocation) throw new Error('State saving requires an originating inference.');
        const origin = await options.context.sessionStateOrigin(planning.invocation);
        return { idempotencyKey: invocationIdentity(planning), branchId: origin.branchId,
          capturedHistoryCut: origin.capturedHistoryCut, inference: origin.inference, operations: value.operations };
      },
      deriveEffects(value) { const scope = scopePath('session_state', value.capturedHistoryCut.sessionId, value.branchId);
        return { accesses: [{ mode: 'write' as const, scope }, ...(value.operations.some(operation => operation.kind === 'edit') ? [{ mode: 'read' as const, scope }] : [])], lockScopes: [scope],
          recovery: { kind: 'buffered_mutation' as const, transactionId: value.idempotencyKey,
            reconcilerId: 'agent-core.session-state-save.v1', authority: scope } }; },
      async invoke(value) { const receipt = await options.context.saveSessionState(value).catch(stateToolFailure); return { kind: 'result' as const,
        execution: { state: 'settled' as const }, scope: { resources: [scopePath('session_state', value.capturedHistoryCut.sessionId, value.branchId)], coverage: 'complete' as const }, summary: 'Narrative changes durably saved; the active view is unchanged.', output: parseJsonValue(receipt) }; },
      async recover(value) { const receipt = await options.context.saveSessionState(value).catch(stateToolFailure); return { status: 'settled' as const,
        observation: { kind: 'result' as const, execution: { state: 'settled' as const }, scope: { resources: [scopePath('session_state', value.capturedHistoryCut.sessionId, value.branchId)], coverage: 'complete' as const }, summary: 'Narrative changes durably saved.', output: parseJsonValue(receipt) } }; }
    }),
    viewTool(false),
    viewTool(true)
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
    operational: result.operational,
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

function stateToolFailure(error: unknown): never {
  if (error instanceof PersistenceConflictError && 'details' in error)
    throw new ToolInputError(error.message, parseJsonObject(error.details));
  throw error;
}
