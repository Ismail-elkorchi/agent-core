import { parseJsonObject } from '@agent-core/json';
import { type ToolExecutionContext } from '@agent-core/tools';

export interface LocalToolConfiguration {
  readonly fileSelection: { readonly maxDepth: number; readonly maxVisitedEntries: number; readonly maxReturnedEntries: number; readonly maxIgnoreFiles: number; readonly maxGlobExpansions: number };
  readonly readFiles: { readonly maxFiles: number; readonly maxLinesPerFile: number; readonly maxBytesPerFile: number; readonly maxTotalBytes: number };
  readonly searchText: { readonly maxResults: number; readonly maxOutputBytes: number; readonly maxFileBytes: number };
  readonly applyPatch: { readonly maxPatchBytes: number; readonly maxOperations: number; readonly maxFileBytes: number; readonly maxNewBytesPerFile: number };
  readonly process: {
    readonly maxYieldMs: number;
    readonly maxTimeoutMs: number;
    readonly maxOutputTokens: number;
    readonly maxCapturedBytes: number;
    readonly tailBytes: number;
    readonly maxActiveProcessesPerRun: number;
    readonly maxActiveProcesses: number;
    readonly maxTotalCapturedBytes: number;
    readonly maxProcessLifetimeMs: number;
    readonly completedRetentionMs: number;
    readonly maxPendingOutputBytes: number;
  };
  readonly artifact: {
    readonly maxReadBytes: number;
    readonly maxImageEncodedBytes: number;
    readonly maxImageWidth: number;
    readonly maxImageHeight: number;
    readonly maxImagePixels: number;
  };
}

const DEFAULTS: LocalToolConfiguration = {
  fileSelection: { maxDepth: 20, maxVisitedEntries: 20_000, maxReturnedEntries: 2_000, maxIgnoreFiles: 100, maxGlobExpansions: 256 },
  readFiles: { maxFiles: 50, maxLinesPerFile: 2_000, maxBytesPerFile: 2_000_000, maxTotalBytes: 4_000_000 },
  searchText: { maxResults: 2_000, maxOutputBytes: 4_000_000, maxFileBytes: 20_000_000 },
  applyPatch: { maxPatchBytes: 2_000_000, maxOperations: 500, maxFileBytes: 10_000_000, maxNewBytesPerFile: 10_000_000 },
  process: {
    maxYieldMs: 30_000, maxTimeoutMs: 3_600_000, maxOutputTokens: 32_000, maxCapturedBytes: 8_000_000, tailBytes: 256_000,
    maxActiveProcessesPerRun: 8, maxActiveProcesses: 32, maxTotalCapturedBytes: 64_000_000, maxProcessLifetimeMs: 3_600_000,
    completedRetentionMs: 60_000, maxPendingOutputBytes: 2_000_000
  },
  artifact: { maxReadBytes: 2_000_000, maxImageEncodedBytes: 20_000_000, maxImageWidth: 16_384, maxImageHeight: 16_384, maxImagePixels: 100_000_000 }
};
export const DEFAULT_LOCAL_TOOL_CONFIGURATION = parseLocalToolConfiguration(DEFAULTS);
const CONFIGURATION_SNAPSHOTS = new WeakMap<object, LocalToolConfiguration>();

export function parseLocalToolConfiguration(value: unknown): LocalToolConfiguration {
  const owned = parseJsonObject(value, { maxDepth: 8, maxCollectionEntries: 100, maxStringBytes: 1_000, maxTotalBytes: 32_000 });
  exactKeys(owned, ['fileSelection', 'readFiles', 'searchText', 'applyPatch', 'process', 'artifact'], 'Local tool configuration');
  return Object.freeze({
    fileSelection: group(owned.fileSelection, ['maxDepth', 'maxVisitedEntries', 'maxReturnedEntries', 'maxIgnoreFiles', 'maxGlobExpansions'], 'fileSelection'),
    readFiles: group(owned.readFiles, ['maxFiles', 'maxLinesPerFile', 'maxBytesPerFile', 'maxTotalBytes'], 'readFiles'),
    searchText: group(owned.searchText, ['maxResults', 'maxOutputBytes', 'maxFileBytes'], 'searchText'),
    applyPatch: group(owned.applyPatch, ['maxPatchBytes', 'maxOperations', 'maxFileBytes', 'maxNewBytesPerFile'], 'applyPatch'),
    process: group(owned.process, ['maxYieldMs', 'maxTimeoutMs', 'maxOutputTokens', 'maxCapturedBytes', 'tailBytes', 'maxActiveProcessesPerRun', 'maxActiveProcesses', 'maxTotalCapturedBytes', 'maxProcessLifetimeMs', 'completedRetentionMs', 'maxPendingOutputBytes'], 'process'),
    artifact: group(owned.artifact, ['maxReadBytes', 'maxImageEncodedBytes', 'maxImageWidth', 'maxImageHeight', 'maxImagePixels'], 'artifact')
  }) as LocalToolConfiguration;
}
export function requireLocalToolConfiguration(context: ToolExecutionContext): LocalToolConfiguration {
  const configured = context.services?.localToolConfiguration;
  if (configured === undefined) return DEFAULT_LOCAL_TOOL_CONFIGURATION;
  if (!record(configured)) throw new Error('Tool service localToolConfiguration is invalid; expected LocalToolConfiguration.');
  const cached = CONFIGURATION_SNAPSHOTS.get(configured);
  if (cached) return cached;
  const parsed = parseLocalToolConfiguration(configured);
  CONFIGURATION_SNAPSHOTS.set(configured, parsed);
  return parsed;
}
export function clampRequestedLimit(requested: number | undefined, configured: number): number { return Math.min(requested ?? configured, configured); }
function group(value: unknown, keys: readonly string[], label: string): Readonly<Record<string, number>> {
  if (!record(value)) throw new Error('Local tool configuration group ' + label + ' must be an object.');
  exactKeys(value, keys, label);
  const output: Record<string, number> = {};
  for (const key of keys) {
    const item = value[key];
    if (!Number.isSafeInteger(item) || Number(item) < 1) throw new Error('Local tool configuration ' + label + '.' + key + ' must be a positive integer.');
    output[key] = Number(item);
  }
  return Object.freeze(output);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) throw new Error(label + ' fields are invalid. Unknown: ' + unknown.join(', ') + '; missing: ' + missing.join(', ') + '.');
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
