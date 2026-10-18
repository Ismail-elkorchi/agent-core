import type { ModelProfile } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import { isToolAvailable, missingToolRequirements, type CompiledToolDefinition, type ToolHostRequirements, type ToolPolicy } from '@agent-core/tools';

export interface EffectiveCapabilitySnapshot {
  readonly revision: string;
  readonly bindingId: string;
  readonly policyRevision: string;
  readonly tools: readonly {
    readonly name: string;
    readonly implementationId: string;
    readonly available: boolean;
    readonly reasons: readonly { readonly kind: 'policy' | 'service' | 'model_input_modality' | 'host_capability'; readonly name?: string }[];
  }[];
}

/** One eligibility decision for request construction and prospective inspection. */
export function resolveEffectiveToolCatalog(input: {
  readonly bindingId: string;
  readonly tools: readonly CompiledToolDefinition[];
  readonly policy: ToolPolicy;
  readonly host: ToolHostRequirements;
}): { readonly tools: readonly CompiledToolDefinition[]; readonly snapshot: EffectiveCapabilitySnapshot } {
  const available: CompiledToolDefinition[] = [];
  const entries = input.tools.map(tool => {
    const reasons = Object.freeze([
      ...(!isToolAvailable(tool, input.policy) ? [Object.freeze({ kind: 'policy' as const })] : []),
      ...missingToolRequirements(tool, input.host)
    ]);
    if (reasons.length === 0) available.push(tool);
    return Object.freeze({ name: tool.name, implementationId: tool.implementationId,
      available: reasons.length === 0, reasons });
  });
  const material = { bindingId: input.bindingId, policyRevision: hashJson(input.policy), tools: Object.freeze(entries) };
  return Object.freeze({ tools: Object.freeze(available), snapshot: Object.freeze({ ...material, revision: hashJson(material) }) });
}

export function inspectCapabilitySnapshot(snapshot: EffectiveCapabilitySnapshot, input: {
  readonly offset?: number; readonly limit?: number; readonly expectedRevision?: string;
} = {}) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 32;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.tools.length ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new RangeError('Capability inspection requires a valid offset and a limit between 1 and 128.');
  if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision)
    throw new Error('Capability inspection revision changed; restart from the current snapshot.');
  const items = snapshot.tools.slice(offset, offset + limit);
  return Object.freeze({ revision: snapshot.revision, bindingId: snapshot.bindingId,
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
