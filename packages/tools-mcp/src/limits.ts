export interface McpLimits {
  readonly maxPages: number;
  readonly maxTools: number;
  readonly maxSchemaBytes: number;
  readonly maxMessageBytes: number;
  readonly maxResultBytes: number;
  readonly maxContentBlocks: number;
  readonly maxBinaryBytes: number;
  readonly maxNotifications: number;
  readonly requestTimeoutMs: number;
  readonly subscriptionLifetimeMs: number;
  readonly catalogMaxAgeMs: number;
  readonly failureBackoffMs: number;
}
export const DEFAULT_MCP_LIMITS: McpLimits = Object.freeze({
  maxPages: 16, maxTools: 256, maxSchemaBytes: 256_000,
  maxMessageBytes: 4_000_000, maxResultBytes: 2_000_000,
  maxContentBlocks: 128, maxBinaryBytes: 1_000_000, maxNotifications: 256,
  requestTimeoutMs: 30_000, subscriptionLifetimeMs: 60_000, catalogMaxAgeMs: 0, failureBackoffMs: 30_000
});
export function mcpLimits(input: Partial<McpLimits> = {}): McpLimits {
  const limits = { ...DEFAULT_MCP_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'catalogMaxAgeMs' ? 0 : 1)
      || value > 2_147_483_647) throw new Error(`Invalid MCP limit: ${key}.`);
  }
  return Object.freeze(limits);
}
export function jsonLimits(bytes: number) {
  return { maxDepth: 32, maxCollectionEntries: 20_000, maxStringBytes: bytes, maxTotalBytes: bytes };
}
