import { parseJsonValue } from '@agent-core/json';
import { grantContextControlTool } from '../context/recovery.js';
import { defineTool, ToolInputError, ToolRegistry, TOOL_CATALOG_LIMITS, type ToolCatalog, type ToolReference, type ToolExecutionContext, type CompiledToolDefinition, type ToolDefinition, type ToolAuthorizationRequest, type ToolAuthorizationDecision } from '@agent-core/tools';
import * as z from 'zod';

const catalogControls = new WeakMap<ToolCatalog, readonly CompiledToolDefinition[]>();
const controls = new WeakMap<ToolDefinition, { readonly catalog: ToolCatalog; readonly mode: 'read' | 'write' }>();

const reference = z.strictObject({ sourceId: z.string().min(1).max(1024), toolId: z.string().min(1).max(1024),
  revision: z.string().min(1).max(1024), bindingRevision: z.string().min(1).max(1024) });
const discovery = z.strictObject({ target: z.enum(['inventory', 'selection']).optional(), query: z.string().max(4096).optional(), offset: z.int().nonnegative().optional(),
  limit: z.int().min(1).max(TOOL_CATALOG_LIMITS.discoveryItems).optional(), maxBytes: z.int().min(1024).max(TOOL_CATALOG_LIMITS.discoveryBytes).optional(),
  expectedRevision: z.string().min(1).max(1024).optional() });

/** Catalog controls alter selection only. Tool invocation always uses the admitted request catalog. */
export function createToolCatalogTools(options: { readonly catalog: ToolCatalog }) {
  const catalog = options.catalog;
  const existing = catalogControls.get(catalog);
  if (existing) return existing;
  catalog.reserveNames(['tool_catalog_discover', 'tool_catalog_select']);
  const scope = (ownerId: string) => `tool_catalog/${encodeURIComponent(ownerId)}`;
  const tools = [
    defineTool({ name: 'tool_catalog_discover', implementationId: 'agent-core.tool-catalog-discover/1',
      description: 'Discover deferred inventory or page target=selection for every currently selected exact reference, including unavailable ones. Returns bounded metadata, not invocation permission. Continue with nextOffset and expectedRevision. Use tool_catalog_select to replace the complete selection for a later admitted request.',
      schema: discovery, outputSchema: z.json(),
      effectEnvelope: { accesses: [{ mode: 'read', scope: 'tool_catalog' }], lockScopes: [] },
      canonicalizeInput: value => ({ request: value, ownerId: catalog.selection().ownerId }),
      deriveEffects: value => ({ accesses: [{ mode: 'read' as const, scope: scope(value.ownerId) }],
        lockScopes: [], recovery: { kind: 'unknown' as const } }),
      async invoke(value, context) {
        if (catalog.selection().ownerId !== value.ownerId) throw new ToolInputError('Tool catalog branch changed after authorization.');
        const output = await catalog.discover(value.request, context.signal);
        if (catalog.selection().ownerId !== value.ownerId) throw new ToolInputError('Tool catalog branch changed during discovery.');
        return { kind: 'result' as const, output: parseJsonValue(output), summary: `${String(output.items.length)} tool descriptors returned.`,
          execution: { state: 'settled' as const }, scope: { resources: [scope(value.ownerId)], coverage: output.coverage } };
      }
    }),
    defineTool({ name: 'tool_catalog_select', implementationId: 'agent-core.tool-catalog-select/1',
      description: 'Replace the complete branch-owned selection with up to 256 exact discovered references; an empty array unloads all deferred definitions. Unlisted tools are removed. Newly selected definitions are loaded atomically, then require successor request admission before calls. Selection grants no invocation authority. To shrink schema cost, retain only the needed exact references.',
      schema: z.strictObject({ references: z.array(reference).max(TOOL_CATALOG_LIMITS.selectionReferences), expectedSelectionRevision: z.string().min(1).max(1024) }),
      outputSchema: z.json(),
      effectEnvelope: { accesses: [{ mode: 'write', scope: 'tool_catalog' }], lockScopes: ['tool_catalog'] },
      canonicalizeInput(value, context) {
        return { ...value, ownerId: catalog.selection().ownerId, operationId: operationIdentity(context) };
      },
      deriveEffects(value) {
        const resource = scope(value.ownerId);
        return { accesses: [{ mode: 'write' as const, scope: resource }], lockScopes: [resource],
          recovery: { kind: 'buffered_mutation' as const, transactionId: value.operationId,
            reconcilerId: 'agent-core.tool-catalog-select/1', authority: resource } };
      },
      async invoke(value, context) { return observeSelection(catalog, value, context); },
      async recover(value, _effect, context) { return { status: 'settled' as const, observation: await observeSelection(catalog, value, context) }; }
    })
  ];
  tools.forEach((tool, index) => {
    controls.set(tool, { catalog, mode: index === 0 ? 'read' : 'write' });
    grantContextControlTool(tool, index === 0 ? 'read' : 'catalog');
  });
  const owned = Object.freeze(tools);
  catalogControls.set(catalog, owned);
  return owned;
}

/** Shared configured/current view for runtime admission and application inspection. */
export async function resolveRuntimeToolCatalog(catalog: ToolCatalog, signal?: AbortSignal): Promise<readonly CompiledToolDefinition[]> {
  const tools = await catalog.refresh(signal);
  return Object.freeze(new ToolRegistry([...tools, ...(catalog.hasSelectionControls() ? createToolCatalogTools({ catalog }) : [])]).list());
}

/** Host controls remain eagerly exposed even when domain tool schemas use native discovery. */
export function isToolCatalogControl(tool: ToolDefinition | undefined): boolean {
  return tool !== undefined && controls.has(tool);
}

/** Only definitions actually constructed above can grant branch bookkeeping authority. */
export function authorizeToolCatalogEffects(request: ToolAuthorizationRequest, tool: CompiledToolDefinition | undefined): ToolAuthorizationDecision | undefined {
  if (!tool) return undefined;
  const control = controls.get(tool);
  if (!control || tool.implementationId !== request.toolImplementationId || tool.name !== request.call.name) return undefined;
  const scope = `tool_catalog/${encodeURIComponent(control.catalog.selection().ownerId)}`;
  const expectedLocks = control.mode === 'write' ? [scope] : [];
  if (request.effects.accesses.length !== 1 || request.effects.accesses[0]?.mode !== control.mode ||
      request.effects.accesses[0].scope !== scope || request.effects.lockScopes.length !== expectedLocks.length ||
      request.effects.lockScopes.some((lock, index) => lock !== expectedLocks[index]))
    return { decision: 'deny', reason: 'Tool catalog control exceeds its current branch authority.' };
  return { decision: 'allow', reason: 'Host-created catalog control is bound to its exact branch.' };
}

async function observeSelection(catalog: ToolCatalog, value: { readonly references: readonly ToolReference[];
  readonly expectedSelectionRevision: string; readonly ownerId: string; readonly operationId: string }, context: ToolExecutionContext) {
  if (catalog.selection().ownerId !== value.ownerId) throw new ToolInputError('Tool catalog branch changed after authorization.');
  const state = await catalog.select(value.references, { expectedOwnerId: value.ownerId, expectedSelectionRevision: value.expectedSelectionRevision,
    operationId: value.operationId, ...(context.signal ? { signal: context.signal } : {}) });
  if (state.ownerId !== value.ownerId) throw new ToolInputError('Tool catalog branch changed during loading.');
  return { kind: 'result' as const, output: parseJsonValue({ status: 'selected', ...state,
    invocation: 'requires_successor_admission' }), summary: 'Exact tool selection saved for a later admitted request.',
    execution: { state: 'settled' as const }, scope: { resources: [`tool_catalog/${encodeURIComponent(value.ownerId)}`], coverage: 'complete' as const } };
}
function operationIdentity(context: ToolExecutionContext): string {
  const invocation = context.invocation;
  if (!invocation) throw new ToolInputError('Tool selection requires a governed invocation.');
  return `${invocation.runId}:${invocation.turnId}:${invocation.toolBatchId}:${String(invocation.callIndex)}`;
}
