import { contextControlRole } from '../context/recovery.js';
import { isToolCatalogControl } from './tool-discovery.js';
import { parseNativeToolExposure, type NativeToolExposure } from '../orchestration/native-tool-exposure.js';
import * as z from 'zod';
import type { ModelProfile } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import { isToolAvailable, missingToolRequirements, type CompiledToolDefinition, type ToolHostRequirements, type ToolPolicy, type ToolInvocationMode } from '@agent-core/tools';

export const CAPABILITY_INSPECTION_LIMITS = Object.freeze({ defaultLimit: 32, maxLimit: 128 });
const nativeExposureSchema = z.strictObject({ discovery: z.boolean(), programmatic: z.boolean() }).readonly();
export const effectiveCapabilitySnapshotSchema = z.strictObject({
  revision: z.string().min(1), bindingId: z.string().min(1), policyRevision: z.string().min(1),
  nativeToolExposure: nativeExposureSchema,
  programmaticRoute: z.enum(['unavailable', 'portable', 'provider']),
  tools: z.array(z.strictObject({ name: z.string().min(1), implementationId: z.string().min(1),
    available: z.boolean(),
    invocationModes: z.array(z.enum(['direct', 'programmatic'])).readonly(),
    programmaticRoute: z.enum(['portable', 'provider']).optional(),
    modelCallable: z.boolean(), deferred: z.boolean(),
    controlRole: z.enum(['read', 'state', 'activation', 'catalog']).optional(), reasons: z.array(z.strictObject({
      kind: z.enum(['policy', 'service', 'model_input_modality', 'host_capability', 'invocation_mode']), name: z.string().optional()
    }).readonly()).readonly()
  }).readonly()).readonly()
}).readonly();
export type EffectiveCapabilitySnapshot = z.output<typeof effectiveCapabilitySnapshotSchema>;
export interface ToolInvocationConfiguration {
  readonly programmaticRunner?: boolean;
  readonly nativeToolExposure?: NativeToolExposure;
  readonly modelProfile?: ModelProfile;
  /** Exact host-registered program orchestration definition, not a name heuristic. */
  readonly eagerTool?: CompiledToolDefinition;
}

/** One eligibility decision for request construction and prospective inspection. */
export function resolveEffectiveToolCatalog(input: {
  readonly bindingId: string;
  readonly tools: readonly CompiledToolDefinition[];
  readonly policy: ToolPolicy;
  readonly host: ToolHostRequirements;
} & ToolInvocationConfiguration): { readonly tools: readonly CompiledToolDefinition[]; readonly snapshot: EffectiveCapabilitySnapshot } {
  const native = input.nativeToolExposure === undefined ? undefined : parseNativeToolExposure(input.nativeToolExposure);
  if (native?.discovery && !input.modelProfile?.capabilities.protocol?.deferredTools)
    throw new Error('Native tool discovery is unsupported by the current model endpoint.');
  if (native?.programmatic && !input.modelProfile?.capabilities.protocol?.programmaticTools)
    throw new Error('Native programmatic tools are unsupported by the current model endpoint.');
  if (input.programmaticRunner && native?.programmatic)
    throw new Error('Choose one portable or provider-native programmatic execution route.');
  const nativeToolExposure = Object.freeze({ discovery: native?.discovery === true, programmatic: native?.programmatic === true });
  const programmaticRoute = input.programmaticRunner ? 'portable' as const : nativeToolExposure.programmatic ? 'provider' as const : 'unavailable' as const;
  const available: CompiledToolDefinition[] = [];
  const entries = input.tools.map(tool => {
    const controlRole = contextControlRole(tool) ?? (isToolCatalogControl(tool) ? 'catalog' as const : undefined);
    const permittedModes = tool.invocationModes.filter(mode => mode === 'direct' || programmaticRoute !== 'unavailable');
    const reasons = Object.freeze([
      ...toolHostEligibilityReasons(tool, input.policy, input.host),
      ...(permittedModes.length === 0 ? [Object.freeze({ kind: 'invocation_mode' as const })] : [])
    ]);
    const eligible = reasons.length === 0;
    if (eligible) available.push(tool);
    const invocationModes: readonly ToolInvocationMode[] = Object.freeze(eligible ? permittedModes : []);
    const programmatic = invocationModes.includes('programmatic') && programmaticRoute !== 'unavailable' ? programmaticRoute : undefined;
    const modelCallable = invocationModes.includes('direct') || programmatic === 'provider';
    const deferred = modelCallable && nativeToolExposure.discovery && controlRole === undefined && tool !== input.eagerTool;
    return Object.freeze({ name: tool.name, implementationId: tool.implementationId,
      available: eligible, reasons, invocationModes, modelCallable, deferred,
      ...(programmatic ? { programmaticRoute: programmatic } : {}),
      ...(controlRole ? { controlRole } : {}) });
  });
  const material = { bindingId: input.bindingId, policyRevision: hashJson(input.policy), nativeToolExposure, programmaticRoute, tools: Object.freeze(entries) };
  return Object.freeze({ tools: Object.freeze(available), snapshot: Object.freeze({ ...material, revision: hashJson(material) }) });
}

/** Current policy/service checks for execution of an already admitted exact catalog. */
export function resolveToolHostEligibility(input: {
  readonly tools: readonly CompiledToolDefinition[];
  readonly policy: ToolPolicy;
  readonly host: ToolHostRequirements;
}): readonly CompiledToolDefinition[] {
  return Object.freeze(input.tools.filter(tool => toolHostEligibilityReasons(tool, input.policy, input.host).length === 0));
}
function toolHostEligibilityReasons(tool: CompiledToolDefinition, policy: ToolPolicy, host: ToolHostRequirements) {
  return [
    ...(!isToolAvailable(tool, policy) ? [Object.freeze({ kind: 'policy' as const })] : []),
    ...missingToolRequirements(tool, host)
  ];
}

export function inspectCapabilitySnapshot(snapshot: EffectiveCapabilitySnapshot, input: {
  readonly offset?: number | undefined; readonly limit?: number | undefined; readonly expectedRevision?: string | undefined;
} = {}) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? CAPABILITY_INSPECTION_LIMITS.defaultLimit;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.tools.length ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > CAPABILITY_INSPECTION_LIMITS.maxLimit)
    throw new RangeError('Capability inspection requires a valid offset and a limit between 1 and 128.');
  if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision)
    throw new Error('Capability inspection revision changed; restart from the current snapshot.');
  const items = snapshot.tools.slice(offset, offset + limit);
  return Object.freeze({ revision: snapshot.revision, bindingId: snapshot.bindingId,
    nativeToolExposure: snapshot.nativeToolExposure, programmaticRoute: snapshot.programmaticRoute,
    totalCount: snapshot.tools.length, offset, items: Object.freeze(items),
    coverage: offset === 0 && items.length === snapshot.tools.length ? 'complete' as const : 'partial' as const,
    ...(offset + items.length < snapshot.tools.length ? { nextOffset: offset + items.length } : {}) });
}

/** Applications choose the ceiling; the finite model bounds determine this default reservation. */
export function generationAllowance(profile: ModelProfile, ceiling: number): number {
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new RangeError('Generation allowance ceiling must be positive.');
  return Math.min(ceiling, profile.limits.outputTokens ?? Infinity,
    profile.limits.contextTokens === undefined ? Infinity : Math.max(1, Math.floor(profile.limits.contextTokens / 2)));
}
