import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import { hashArtifactBytes, hashJson, type ArtifactRepository } from '@agent-core/persistence';
import { validateToolEffectEnvelope, normalizeToolInvocationModes, parseToolPolicy, accessRisk,
  type ToolEffectEnvelope, type ToolInvocationMode, type ToolRisk } from '@agent-core/tools';
import { McpToolSource, type McpToolPolicy } from './source.js';
import { createMcpHttpTransport } from './transports-node.js';
import { jsonLimits, mcpLimits, type McpLimits } from './limits.js';

export interface NodeMcpToolConfiguration extends ToolEffectEnvelope {
  readonly invocationModes?: readonly ToolInvocationMode[];
}
export interface NodeMcpServerConfiguration {
  readonly id: string;
  readonly endpoint: string;
  readonly accountId: string;
  readonly policyRevision: string;
  readonly bearerTokenEnv?: string;
  readonly allowInsecureLoopback?: boolean;
  readonly tools: Readonly<Record<string, NodeMcpToolConfiguration>>;
  readonly limits?: Partial<McpLimits>;
}
export interface NodeMcpConfiguration { readonly servers: readonly NodeMcpServerConfiguration[] }
export interface ConfiguredMcpSources {
  readonly sources: readonly McpToolSource[];
  close(): Promise<void>;
}
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const positiveLimit = z.number().int().min(1).max(2_147_483_647).optional();
const limitsSchema = z.strictObject({
  maxPages: positiveLimit, maxTools: positiveLimit, maxSchemaBytes: positiveLimit,
  maxMessageBytes: positiveLimit, maxResultBytes: positiveLimit, maxContentBlocks: positiveLimit,
  maxBinaryBytes: positiveLimit, maxNotifications: positiveLimit, requestTimeoutMs: positiveLimit,
  subscriptionLifetimeMs: positiveLimit, failureBackoffMs: positiveLimit,
  catalogMaxAgeMs: z.number().int().min(0).max(2_147_483_647).optional()
});
const effectSchema = z.strictObject({
  accesses: z.array(z.strictObject({ mode: z.enum(['read', 'write', 'execute', 'network', 'delete']), scope: z.string().min(1).max(2048) })).max(128),
  lockScopes: z.array(z.string().min(1).max(2048)).max(128),
  invocationModes: z.array(z.enum(['direct', 'programmatic'])).min(1).max(2).optional()
});
const configurationSchema = z.strictObject({ servers: z.array(z.strictObject({
  id: identifier, endpoint: z.string().max(8192), accountId: identifier, policyRevision: identifier,
  bearerTokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u).optional(),
  allowInsecureLoopback: z.boolean().optional(),
  tools: z.record(z.string().min(1).max(256), effectSchema), limits: limitsSchema.optional()
})).max(16) });

/** Validate a parsed JSON configuration. Literal secrets and executable commands are not supported. */
export function parseMcpConfiguration(input: unknown): NodeMcpConfiguration {
  const captured = parseJsonObject(input, jsonLimits(1_000_000));
  const parsed = configurationSchema.parse(captured);
  const ids = new Set<string>();
  const servers: NodeMcpServerConfiguration[] = parsed.servers.map(server => {
    if (ids.has(server.id)) throw new Error('MCP configuration contains duplicate server IDs.');
    ids.add(server.id);
    const endpoint = new URL(server.endpoint);
    if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
      throw new Error('Configured MCP endpoints cannot contain userinfo, fragments, or query parameters; use bearerTokenEnv for credentials.');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(server.allowInsecureLoopback === true && loopback && endpoint.protocol === 'http:')) {
      throw new Error('Configured MCP endpoints require HTTPS or explicit loopback permission.');
    }
    if (Object.keys(server.tools).length > 256) throw new Error('MCP configuration tool mapping limit exceeded.');
    const tools = Object.freeze(Object.fromEntries(Object.entries(server.tools).map(([name, effects]) => [name,
      Object.freeze({ ...validateToolEffectEnvelope({ accesses: effects.accesses, lockScopes: effects.lockScopes }),
        invocationModes: normalizeToolInvocationModes(effects.invocationModes) })])));
    // Object capture removed undefined before schema parsing; the limits remain owned finite values.
    const limits = server.limits === undefined ? undefined : mcpLimits(parseJsonObject(server.limits));
    return Object.freeze({ id: server.id, endpoint: endpoint.href, accountId: server.accountId,
      policyRevision: server.policyRevision, tools,
      ...(server.bearerTokenEnv === undefined ? {} : { bearerTokenEnv: server.bearerTokenEnv }),
      ...(server.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: server.allowInsecureLoopback }),
      ...(limits === undefined ? {} : { limits }) });
  });
  return Object.freeze({ servers: Object.freeze(servers) });
}

/** Construction does not connect. Discovery and execution use the same source/executor path. */
export function createConfiguredMcpSources(configuration: NodeMcpConfiguration, options: {
  readonly artifacts?: ArtifactRepository;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Host application authority ceiling, applied before discovery, never remote hints. */
  readonly allowedRisks?: readonly ToolRisk[];
} = {}): ConfiguredMcpSources {
  const config = parseMcpConfiguration(configuration);
  const environment = options.environment ?? process.env;
  const allowedRisks = options.allowedRisks === undefined ? undefined : [...parseToolPolicy({ allowedRisks: options.allowedRisks }).allowedRisks].sort();
  const sources = config.servers.flatMap(server => {
    const tools: Record<string, McpToolPolicy> = Object.fromEntries(Object.entries(server.tools)
      .filter(([, tool]) => allowedRisks === undefined || (allowedRisks.includes('network')
        && tool.accesses.every(access => allowedRisks.includes(accessRisk(access.mode)))))
      .map(([name, tool]) => [name, {
      effectEnvelope: { accesses: tool.accesses, lockScopes: tool.lockScopes },
      invocationModes: normalizeToolInvocationModes(tool.invocationModes),
      deriveEffects: () => ({ accesses: tool.accesses, lockScopes: tool.lockScopes })
    }]));
    if (Object.keys(tools).length === 0) return [];
    const token = server.bearerTokenEnv === undefined ? undefined : environment[server.bearerTokenEnv];
    if (server.bearerTokenEnv !== undefined && (!token || /[\r\n]/u.test(token))) throw new Error('Configured MCP bearer credential is unavailable or invalid.');
    const createTransport = () => createMcpHttpTransport({ endpoint: server.endpoint,
      ...(token === undefined ? {} : { headers: () => ({ authorization: `Bearer ${token}` }) }),
      ...(server.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: server.allowInsecureLoopback }),
      ...(server.limits === undefined ? {} : { limits: server.limits }) });
    return [new McpToolSource({ id: server.id,
      binding: { endpointId: hashArtifactBytes(new TextEncoder().encode(server.endpoint)), accountId: server.accountId,
        policyRevision: allowedRisks === undefined ? server.policyRevision : hashJson({ policyRevision: server.policyRevision, allowedRisks }) },
      ...(token === undefined ? {} : { containsCredential: (value: string | Uint8Array) =>
        (typeof value === 'string' ? value : new TextDecoder().decode(value)).includes(token) }),
      createTransport, tools, ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      ...(server.limits === undefined ? {} : { limits: server.limits }) })];
  });
  return Object.freeze({ sources: Object.freeze(sources), async close() {
    const results = await Promise.allSettled(sources.map(source => source.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('One or more MCP sources could not close cleanly.');
  } });
}
