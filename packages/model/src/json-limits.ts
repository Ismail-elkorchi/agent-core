import type { SafeJsonParseLimits } from '@agent-core/json';

/** Shared bound for exact model request material, including normalized media. */
export const MODEL_REQUEST_JSON_LIMITS: SafeJsonParseLimits = Object.freeze({
  maxDepth: 64,
  maxCollectionEntries: 100_000,
  maxStringBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024
});
