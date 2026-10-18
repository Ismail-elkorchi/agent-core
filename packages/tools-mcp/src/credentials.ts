import { canonicalJsonString, type JsonValue } from '@agent-core/json';
import { hashArtifactBytes } from '@agent-core/persistence';

export type McpCredentialMatcher = (value: string | Uint8Array) => boolean;

/** Inspect strings and keys without retaining or publishing known host credentials. */
export function hasCredential(value: JsonValue, matches: McpCredentialMatcher): boolean {
  if (typeof value === 'string') return matches(value);
  if (Array.isArray(value)) {
    const items: readonly JsonValue[] = value;
    return items.some(item => hasCredential(item, matches));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => matches(key) || hasCredential(item, matches));
  }
  return false;
}
export class McpCredentialContentError extends Error {
  readonly sha256: string;
  readonly size: number;
  constructor(value: JsonValue) {
    super('MCP result contains host credentials; original unavailable.');
    const bytes = new TextEncoder().encode(canonicalJsonString(value));
    this.sha256 = hashArtifactBytes(bytes);
    this.size = bytes.byteLength;
  }
}
