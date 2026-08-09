import type { ModelInputModality, ToolDefinition, ToolRequirements } from './definition.js';
import { parseJsonObject } from '@agent-core/evidence';

export const WORKSPACE_FILES_SCOPE = 'workspace/files';
export const WORKSPACE_PROCESSES_SCOPE = 'workspace/processes';
export const PATCH_JOURNAL_SCOPE = 'workspace/internal/patch-journal';
export const ARTIFACTS_SCOPE = 'artifacts';

export function workspaceFileScope(relativePath = ''): string { return scoped(WORKSPACE_FILES_SCOPE, relativePath); }
export function workspaceProcessScope(processId = ''): string { return scoped(WORKSPACE_PROCESSES_SCOPE, processId); }
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
export function toolRequirementsSatisfied(tool: ToolDefinition, host: {
  readonly services?: Readonly<Record<string, unknown>>;
  readonly modelInputModalities?: readonly string[];
  readonly hostCapabilities?: readonly string[];
}): boolean {
  const requirements = tool.requirements;
  return (requirements?.services ?? []).every((service) => host.services?.[service] !== undefined)
    && (requirements?.modelInputModalities ?? []).every((modality) => host.modelInputModalities?.includes(modality) === true)
    && (requirements?.hostCapabilities ?? []).every((capability) => host.hostCapabilities?.includes(capability) === true);
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
