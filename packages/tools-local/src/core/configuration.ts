import { requireToolService, type ToolExecutionContext } from '@agent-core/tools';

export interface LocalToolConfiguration {
  readonly fileSelection: {
    readonly maxDepth: number;
    readonly maxVisitedEntries: number;
    readonly maxReturnedEntries: number;
    readonly maxIgnoreFiles: number;
    readonly maxGlobExpansions: number;
  };
  readonly readFiles: {
    readonly maxFiles: number;
    readonly maxLinesPerFile: number;
    readonly maxBytesPerFile: number;
    readonly maxTotalBytes: number;
  };
  readonly searchText: {
    readonly maxResults: number;
    readonly maxOutputBytes: number;
    readonly maxFileBytes: number;
  };
  readonly applyPatch: {
    readonly maxPatchBytes: number;
    readonly maxOperations: number;
    readonly maxFileBytes: number;
    readonly maxNewBytesPerFile: number;
  };
  readonly process: {
    readonly maxYieldMs: number;
    readonly maxTimeoutMs: number;
    readonly maxOutputTokens: number;
    readonly maxCapturedBytes: number;
    readonly tailBytes: number;
  };
  readonly artifact: {
    readonly maxReadBytes: number;
    readonly maxImageBytes: number;
  };
}

export const DEFAULT_LOCAL_TOOL_CONFIGURATION: LocalToolConfiguration = Object.freeze({
  fileSelection: { maxDepth: 20, maxVisitedEntries: 20_000, maxReturnedEntries: 2_000, maxIgnoreFiles: 100, maxGlobExpansions: 256 },
  readFiles: { maxFiles: 50, maxLinesPerFile: 2_000, maxBytesPerFile: 2_000_000, maxTotalBytes: 4_000_000 },
  searchText: { maxResults: 2_000, maxOutputBytes: 4_000_000, maxFileBytes: 20_000_000 },
  applyPatch: { maxPatchBytes: 2_000_000, maxOperations: 500, maxFileBytes: 10_000_000, maxNewBytesPerFile: 10_000_000 },
  process: { maxYieldMs: 30_000, maxTimeoutMs: 3_600_000, maxOutputTokens: 32_000, maxCapturedBytes: 8_000_000, tailBytes: 256_000 },
  artifact: { maxReadBytes: 2_000_000, maxImageBytes: 20_000_000 }
});

export function requireLocalToolConfiguration(context: ToolExecutionContext): LocalToolConfiguration {
  const configured = context.services?.localToolConfiguration;
  if (configured === undefined) return DEFAULT_LOCAL_TOOL_CONFIGURATION;
  return requireToolService(context, 'localToolConfiguration', isLocalToolConfiguration, 'LocalToolConfiguration');
}

export function clampRequestedLimit(requested: number | undefined, configured: number): number {
  return Math.min(requested ?? configured, configured);
}

function isLocalToolConfiguration(value: unknown): value is LocalToolConfiguration {
  if (!isRecord(value)) return false;
  return isPositiveLimitGroup(value.fileSelection, ['maxDepth', 'maxVisitedEntries', 'maxReturnedEntries', 'maxIgnoreFiles', 'maxGlobExpansions'])
    && isPositiveLimitGroup(value.readFiles, ['maxFiles', 'maxLinesPerFile', 'maxBytesPerFile', 'maxTotalBytes'])
    && isPositiveLimitGroup(value.searchText, ['maxResults', 'maxOutputBytes', 'maxFileBytes'])
    && isPositiveLimitGroup(value.applyPatch, ['maxPatchBytes', 'maxOperations', 'maxFileBytes', 'maxNewBytesPerFile'])
    && isPositiveLimitGroup(value.process, ['maxYieldMs', 'maxTimeoutMs', 'maxOutputTokens', 'maxCapturedBytes', 'tailBytes'])
    && isPositiveLimitGroup(value.artifact, ['maxReadBytes', 'maxImageBytes']);
}

function isPositiveLimitGroup(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
