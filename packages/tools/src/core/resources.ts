import type { ModelInputModality, ToolDefinition, ToolRequirements } from './definition.js';
import { parseJsonObject } from '@agent-core/json';

export const ARTIFACTS_SCOPE = 'artifacts';

export function artifactScope(artifactId = ''): string { return scoped(ARTIFACTS_SCOPE, artifactId); }
export function validateResourceScope(value: string): string {
  if (value.length === 0 || value.trim() !== value || value.includes('\\') || value.endsWith('/')
    || value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) throw new Error('Invalid resource scope: ' + value);
  return value;
}
export function validateToolRequirements(value: unknown): ToolRequirements | undefined {
  if (value === undefined) return undefined;
  const record = parseJsonObject(value, { maxDepth: 4, maxCollectionEntries: 1_000, maxStringBytes: 16_000, maxTotalBytes: 100_000 });
  const unknown = Object.keys(record).filter((key) => key !== 'services' && key !== 'modelInputModalities' && key !== 'hostCapabilities');
  if (unknown.length > 0) throw new Error('Tool requirements contain unsupported fields: ' + unknown.join(', ') + '.');
  const services = strings(record.services, 'services');
  const hostCapabilities = strings(record.hostCapabilities, 'hostCapabilities');
  const modelInputModalities = record.modelInputModalities === undefined ? undefined : (() => {
    if (!Array.isArray(record.modelInputModalities)) throw new Error('Tool model input modalities are invalid.');
    const modalities: ModelInputModality[] = [];
    for (const item of record.modelInputModalities as unknown[]) {
      if (item !== 'text' && item !== 'image') throw new Error('Tool model input modalities are invalid.');
      modalities.push(item);
    }
    return Object.freeze([...new Set(modalities)]);
  })();
  return Object.freeze({ ...(services ? { services } : {}), ...(modelInputModalities ? { modelInputModalities } : {}), ...(hostCapabilities ? { hostCapabilities } : {}) });
}
export interface ToolHostRequirements {
  readonly services?: Readonly<Record<string, unknown>>;
  readonly modelInputModalities?: readonly string[];
  readonly hostCapabilities?: readonly string[];
}
export interface MissingToolRequirement {
  readonly kind: 'service' | 'model_input_modality' | 'host_capability';
  readonly name: string;
}
/** The same requirement decision supplies both execution eligibility and inspection. */
export function missingToolRequirements(tool: ToolDefinition, host: ToolHostRequirements): readonly MissingToolRequirement[] {
  const requirements = tool.requirements;
  return Object.freeze([
    ...(requirements?.services ?? []).filter(name => host.services?.[name] === undefined)
      .map(name => Object.freeze({ kind: 'service' as const, name })),
    ...(requirements?.modelInputModalities ?? []).filter(name => host.modelInputModalities?.includes(name) !== true)
      .map(name => Object.freeze({ kind: 'model_input_modality' as const, name })),
    ...(requirements?.hostCapabilities ?? []).filter(name => host.hostCapabilities?.includes(name) !== true)
      .map(name => Object.freeze({ kind: 'host_capability' as const, name }))
  ]);
}
export function toolRequirementsSatisfied(tool: ToolDefinition, host: ToolHostRequirements): boolean {
  return missingToolRequirements(tool, host).length === 0;
}
function scoped(parent: string, child: string): string {
  const clean = child.replaceAll('\\', '/').replace(/^\.?\/+/u, '').replace(/\/+$/u, '');
  return clean.length === 0 || clean === '.' ? parent : validateResourceScope(parent + '/' + clean);
}
function strings(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Tool requirement ' + label + ' must contain non-empty strings.');
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) throw new Error('Tool requirement ' + label + ' must contain non-empty strings.');
    strings.push(item);
  }
  if (new Set(strings).size !== strings.length) throw new Error('Tool requirement ' + label + ' must be unique.');
  return Object.freeze(strings);
}
