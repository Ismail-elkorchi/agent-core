import * as z from 'zod';
import { ToolInputError } from '@agent-core/tools';
import type { WebPolicy } from './contracts.js';

const limitsSchema = z.strictObject({
  maxTransferBytes: z.int().min(1).max(8 * 1024 * 1024).default(1024 * 1024),
  maxResponseBytes: z.int().min(1).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
  maxExpansionRatio: z.int().min(1).max(1000).default(100),
  maxHeaderBytes: z.int().min(256).max(64 * 1024).default(16 * 1024),
  requestTimeoutMs: z.int().min(1).max(120_000).default(30_000),
  idleTimeoutMs: z.int().min(1).max(30_000).default(10_000),
  maxExtractionBytes: z.int().min(1).max(2 * 1024 * 1024).default(1024 * 1024),
  maxParserNodes: z.int().min(1).max(100_000).default(50_000),
  maxExcerptBytes: z.int().min(4).max(64 * 1024).default(16 * 1024),
  maxSearchResults: z.int().min(1).max(20).default(10)
});
export const webPolicyInputSchema = z.strictObject({
  id: z.string().trim().min(1).max(256),
  allowedOrigins: z.array(z.string().max(4096)).max(1000).optional(),
  limits: limitsSchema.optional()
});
export function createWebPolicy(input: unknown): WebPolicy {
  const value = webPolicyInputSchema.parse(input);
  const origins = value.allowedOrigins?.map(origin => {
    const url = new URL(canonicalWebUrl(origin));
    if (url.href !== `${url.origin}/` || new URL(origin).hash) throw new TypeError('Web policy requires exact origins without paths, queries, or fragments.');
    return url.origin;
  });
  return Object.freeze({ id: value.id, ...(origins ? { allowedOrigins: Object.freeze([...new Set(origins)].sort()) } : {}),
    limits: Object.freeze(value.limits ?? limitsSchema.parse({})) });
}
export function canonicalWebUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ToolInputError('A valid absolute HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new ToolInputError('Public web retrieval requires HTTPS on port 443 without URL credentials.');
  if (url.hostname.endsWith('.') || url.hostname.includes('%'))
    throw new ToolInputError('Ambiguous or scoped hostnames are not supported.');
  url.hash = '';
  // The transport also serves percent-encoded provider queries. Model URL input remains capped at 4096 characters.
  if (url.href.length > 8192) throw new ToolInputError('Encoded URL exceeds the 8192-character transport limit.');
  return url.href;
}
export function assertWebOrigin(url: string, policy: WebPolicy): void {
  if (policy.allowedOrigins && !policy.allowedOrigins.includes(new URL(url).origin))
    throw new ToolInputError('The URL origin is outside the configured web policy.');
}
export function webOriginScope(url: string): string { return `web/origins/${encodeURIComponent(new URL(url).origin)}`; }
