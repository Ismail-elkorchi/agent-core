import {
  Client, ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode, type McpSubscription, type Tool,
  type Transport, type RequestOptions, type ListToolsResult
} from '@modelcontextprotocol/client';
import type * as z from 'zod';
import { canonicalJsonString, parseJsonObject, type JsonObject } from '@agent-core/json';
import { hashArtifactBytes, type ArtifactRepository } from '@agent-core/persistence';
import {
  captureToolSourceSnapshot, defineTool, describeCatalogTool, validateToolEffectEnvelope,
  normalizeToolInvocationModes,
  type CompiledToolDefinition, type ToolCatalogSource, type ToolReference, type ToolSourceSnapshot,
  type ToolEffectEnvelope, type ToolEffects, type ToolCanonicalizationContext, type ToolExecutionContext,
  type ToolObservationInput, type ToolInvocationMode
} from '@agent-core/tools';
import { jsonLimits, mcpLimits, type McpLimits } from './limits.js';
import { mcpOutputSchema, normalizeMcpResult } from './result.js';
import { mcpSchema } from './schema.js';
import { BoundedMcpTransport } from './transport.js';
import { hasCredential, McpCredentialContentError, type McpCredentialMatcher } from './credentials.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export interface McpBinding {
  /** Stable opaque endpoint identity, never a URL containing credentials. */
  readonly endpointId: string;
  /** Stable opaque principal identity. A changed account requires a new source. */
  readonly accountId: string;
  /** Change whenever effect mappings or host policy change. */
  readonly policyRevision: string;
}
export interface McpToolPolicy {
  readonly effectEnvelope: ToolEffectEnvelope;
  readonly invocationModes?: readonly ToolInvocationMode[];
  deriveEffects(input: JsonObject, context: ToolCanonicalizationContext):
    Omit<ToolEffects, 'recovery'> | Promise<Omit<ToolEffects, 'recovery'>>;
}
export interface McpToolSourceOptions {
  readonly id: string;
  readonly binding: McpBinding;
  /** New host-owned transport per connection; undefined explicitly exhausts a one-shot source. */
  readonly createTransport: () => Transport | undefined;
  /** Exact remote tool names. Unmapped tools are not exposed. Server hints grant no authority. */
  readonly tools: Readonly<Record<string, McpToolPolicy>>;
  readonly artifacts?: ArtifactRepository;
  readonly limits?: Partial<McpLimits>;
  readonly watchChanges?: boolean;
  /** Private host matcher for known transport credentials; never serialized. */
  readonly containsCredential?: McpCredentialMatcher;
}
interface CatalogEntry { readonly reference: ToolReference; readonly tool: CompiledToolDefinition; readonly remoteRevision: string }

export class McpToolSource implements ToolCatalogSource {
  readonly id: string;
  private readonly authorityRevision: string;
  private connectionEpoch: string | undefined;
  private connectionAttempts = 0;
  private readonly binding: McpBinding;
  private readonly limits: McpLimits;
  private readonly policies: ReadonlyMap<string, Required<McpToolPolicy>>;
  private readonly client: Client;
  private readonly createTransport: () => Transport | undefined;
  private readonly usedTransports = new WeakSet<Transport>();
  private transportUnavailable = false;
  private readonly artifacts: ArtifactRepository | undefined;
  private readonly watchChanges: boolean;
  private readonly containsCredential: McpCredentialMatcher | undefined;
  private connection: Promise<void> | undefined;
  private refresh: Promise<ToolSourceSnapshot> | undefined;
  private current: ToolSourceSnapshot | undefined;
  private entries = new Map<string, CatalogEntry>();
  private refreshedAt = 0;
  private retryAfter = 0;
  private generation = 0;
  private closed = false;
  private subscription: McpSubscription | undefined;
  private subscriptionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: McpToolSourceOptions) {
    this.id = identifier(options.id, 'source id');
    this.binding = Object.freeze({ endpointId: identifier(options.binding.endpointId, 'endpoint id'),
      accountId: identifier(options.binding.accountId, 'account id'),
      policyRevision: identifier(options.binding.policyRevision, 'policy revision') });
    this.limits = mcpLimits(options.limits);
    this.policies = new Map(Object.entries(options.tools).map(([name, policy]) => {
      if (!name || name.length > 256 || typeof policy.deriveEffects !== 'function') throw new Error('Invalid MCP tool mapping.');
      return [name, Object.freeze({ effectEnvelope: validateToolEffectEnvelope(policy.effectEnvelope),
        invocationModes: normalizeToolInvocationModes(policy.invocationModes), deriveEffects: policy.deriveEffects.bind(policy) })];
    }));
    this.authorityRevision = digest({ sourceId: this.id, ...this.binding,
      policies: [...this.policies].sort(([a], [b]) => a.localeCompare(b)).map(([name, policy]) => ({ name,
        envelope: policy.effectEnvelope, invocationModes: policy.invocationModes })) });
    this.artifacts = options.artifacts;
    this.watchChanges = options.watchChanges !== false;
    this.containsCredential = options.containsCredential;
    this.createTransport = options.createTransport;
    this.client = new Client({ name: 'agent-core-tools-mcp', version: '0.2.0' }, {
      capabilities: {}, enforceStrictCapabilities: true,
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION }, probe: { maxRetries: 0 } },
      inputRequired: { autoFulfill: false }, listMaxPages: this.limits.maxPages
    });
    this.client.setNotificationHandler('notifications/tools/list_changed', () => { this.invalidate(); });
    this.client.onclose = () => {
      this.connection = undefined;
      this.invalidate();
      if (!this.closed) this.retryAfter = Date.now() + this.limits.failureBackoffMs;
    };
    // Transport/auth errors can contain headers or URLs. They never enter model observations.
    this.client.onerror = () => { this.invalidate(); };
  }

  get bindingRevision(): string {
    return this.connectionEpoch === undefined ? this.authorityRevision : digest({ authorityRevision: this.authorityRevision, connectionEpoch: this.connectionEpoch });
  }

  async snapshot(signal?: AbortSignal): Promise<ToolSourceSnapshot> {
    this.assertOpen();
    signal?.throwIfAborted();
    if (this.transportUnavailable) throw new Error('MCP source transport cannot be recreated.');
    if (Date.now() < this.retryAfter) throw new Error('MCP source is temporarily unavailable after a connection or inventory failure.');
    await this.connect(signal);
    signal?.throwIfAborted();
    if (this.current && this.limits.catalogMaxAgeMs > 0 && Date.now() - this.refreshedAt < this.limits.catalogMaxAgeMs) return this.current;
    this.refresh ??= this.fetchSnapshot(signal).catch((error: unknown) => {
      if (!signal?.aborted) {
        this.retryAfter = Date.now() + this.limits.failureBackoffMs;
        this.invalidate();
      }
      throw error;
    }).finally(() => { this.refresh = undefined; });
    const snapshot = await this.refresh;
    signal?.throwIfAborted();
    return snapshot;
  }

  async load(reference: ToolReference, signal?: AbortSignal): Promise<CompiledToolDefinition> {
    await this.snapshot(signal);
    return this.requireEntry(reference).tool;
  }

  /** Host invalidation, also used for tools/list_changed and subscription loss. */
  invalidate(): void { this.current = undefined; this.refreshedAt = 0; this.generation += 1; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
    const subscription = this.subscription;
    this.subscription = undefined;
    try { await subscription?.close(); } finally { await this.client.close(); this.invalidate(); }
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    const connection = this.connection ??= (async () => {
        try {
          const transport = this.createTransport();
          if (!transport || this.usedTransports.has(transport)) {
            this.transportUnavailable = true;
            throw new Error('MCP transport factory must provide a fresh transport.');
          }
          this.usedTransports.add(transport);
          if (this.connectionAttempts++ > 0) {
            // A reconnect lease must never revive a persisted reference from another source lifetime.
            this.connectionEpoch = globalThis.crypto.randomUUID();
            this.entries.clear();
            this.invalidate();
          }
          await this.client.connect(new BoundedMcpTransport(transport, this.limits), this.requestOptions(signal));
          if (this.client.getProtocolEra() !== 'modern') throw new Error('MCP modern protocol is required.');
          if (!this.client.getServerCapabilities()?.tools) throw new Error('MCP server does not advertise tools.');
          if (this.watchChanges && this.client.getServerCapabilities()?.tools?.listChanged) {
            this.subscription = await this.client.listen({ toolsListChanged: true }, this.requestOptions(signal));
            const subscription = this.subscription;
            const timer = setTimeout(() => { void subscription.close().catch(() => { this.invalidate(); }); }, this.limits.subscriptionLifetimeMs);
            this.subscriptionTimer = timer;
            timer.unref();
            void subscription.closed.then(() => {
              if (this.subscription === subscription) {
                this.subscription = undefined;
                this.subscriptionTimer = undefined;
              }
              clearTimeout(timer);
              this.invalidate();
            });
          }
        } catch {
          await this.client.close().catch(() => undefined);
          this.retryAfter = signal?.aborted ? 0 : Date.now() + this.limits.failureBackoffMs;
          signal?.throwIfAborted();
          throw new Error('MCP connection failed; protocol 2026-07-28, tools capability, and host authentication are required.');
        }
      })();
    try { await connection; }
    catch (error) {
      if (this.connection === connection) this.connection = undefined;
      throw error;
    }
  }

  private async fetchSnapshot(signal?: AbortSignal): Promise<ToolSourceSnapshot> {
    const generation = this.generation;
    const entries = new Map<string, CatalogEntry>();
    const descriptors = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let count = 0;
    let complete = false;
    for (let page = 0; page < this.limits.maxPages; page += 1) {
      let result: ListToolsResult;
      try {
        result = await this.client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, this.requestOptions(signal));
      } catch {
        signal?.throwIfAborted();
        throw new Error('MCP tool inventory request failed.');
      }
      const captured = parseJsonObject(result, jsonLimits(this.limits.maxMessageBytes));
      if (this.containsCredential && hasCredential(captured, this.containsCredential)) throw new Error('MCP inventory contains host credentials and is unavailable.');
      for (const remote of result.tools) {
        count += 1;
        if (count > this.limits.maxTools) throw new Error('MCP tool inventory limit exceeded.');
        if (seenNames.has(remote.name)) throw new Error('MCP tool inventory contains duplicate names.');
        seenNames.add(remote.name);
        const policy = this.policies.get(remote.name);
        if (!policy) continue;
        if (remote.execution?.taskSupport === 'required') throw new Error('MCP task-required tools are unavailable.');
        const remoteRevision = digest(parseJsonObject(remote, jsonLimits(this.limits.maxSchemaBytes)));
        const prior = this.entries.get(remote.name);
        const tool = prior?.remoteRevision === remoteRevision ? prior.tool : this.compile(remote, policy, remoteRevision);
        const descriptor = describeCatalogTool({ sourceId: this.id, bindingRevision: this.bindingRevision, toolId: remote.name, tool });
        descriptors.push(descriptor);
        entries.set(remote.name, { reference: descriptor.reference, tool, remoteRevision });
      }
      if (result.nextCursor === undefined) { complete = true; break; }
      if (result.nextCursor.length === 0 || seenCursors.has(result.nextCursor)) throw new Error('MCP pagination cursor did not advance.');
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    if (!complete) throw new Error('MCP tool inventory page limit exceeded.');
    if (generation !== this.generation) throw new Error('MCP tool inventory changed while listing; request a new snapshot.');
    const snapshot = captureToolSourceSnapshot({ sourceId: this.id, bindingRevision: this.bindingRevision, tools: descriptors });
    this.entries = entries;
    this.current = snapshot;
    this.refreshedAt = Date.now();
    return snapshot;
  }

  private compile(remote: Tool, policy: Required<McpToolPolicy>, remoteRevision: string): CompiledToolDefinition {
    const bindingRevision = this.bindingRevision;
    const remoteDescription = remote.description?.trim();
    const description = remoteDescription === undefined || remoteDescription.length === 0 ? `Remote MCP tool ${remote.name}` : remoteDescription;
    const schema = mcpSchema(remote.inputSchema, this.limits.maxSchemaBytes);
    const structured = remote.outputSchema === undefined ? undefined : mcpSchema(remote.outputSchema, this.limits.maxSchemaBytes);
    const name = `mcp_${this.id.replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 16)}_${remote.name.replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 20)}_${digest({ sourceId: this.id, toolId: remote.name }).slice(0, 12)}`;
    const network = { mode: 'network' as const, scope: `mcp/${this.id}/${bindingRevision}` };
    const effectEnvelope = { accesses: [...policy.effectEnvelope.accesses, network], lockScopes: policy.effectEnvelope.lockScopes };
    const outputSchema = mcpOutputSchema(structured);
    const tool = defineTool({
      name, implementationId: `mcp/${this.id}/${bindingRevision}/${remoteRevision}`,
      description, schema, outputSchema, effectEnvelope, invocationModes: policy.invocationModes,
      canonicalizeInput: input => parseJsonObject(input, jsonLimits(this.limits.maxMessageBytes)),
      snapshotInput: input => parseJsonObject({ binding: this.binding, sourceId: this.id,
        bindingRevision, toolId: remote.name, remoteRevision, arguments: input }),
      deriveEffects: async (input, context) => {
        const effects = await policy.deriveEffects(input, context);
        return { ...effects, accesses: [...effects.accesses, network], recovery: { kind: 'unknown' as const } };
      },
      invoke: (input, context) => this.invoke(reference, remote, input, outputSchema, context)
    });
    const reference: ToolReference = describeCatalogTool({ sourceId: this.id, bindingRevision, toolId: remote.name, tool }).reference;
    return tool;
  }

  private async invoke(reference: ToolReference, remote: Tool, input: JsonObject, outputSchema: z.ZodType, context: ToolExecutionContext): Promise<ToolObservationInput> {
    const scope = { resources: [`mcp/${this.id}/${reference.bindingRevision}/${encodeURIComponent(remote.name)}`], coverage: 'complete' as const };
    try {
      await this.snapshot(context.signal);
      this.requireEntry(reference);
    } catch {
      return { kind: 'failure', execution: { state: 'not_started' }, summary: 'MCP tool binding is no longer available.', scope,
        output: { reason: 'policy', policyReason: 'MCP source, account, or tool revision is stale.' } };
    }
    let returned = false;
    try {
      const result = await this.client.request({ method: 'tools/call', params: { name: remote.name, arguments: input } }, this.requestOptions(context.signal));
      returned = true;
      const normalized = await normalizeMcpResult(result, { sourceId: this.id, toolId: remote.name,
        bindingRevision: reference.bindingRevision }, this.limits, this.artifacts, this.containsCredential);
      if (normalized.isError) return {
        kind: 'failure', execution: { state: 'settled' }, summary: 'MCP tool reported an error.', scope,
        content: normalized.content, output: { reason: 'runtime_error', error: 'mcp_tool_error', details: normalized.output }
      };
      if (!outputSchema.safeParse(normalized.output).success) throw new Error('MCP structured output violates its declared schema.');
      return { kind: 'result', execution: { state: 'settled' }, summary: 'MCP tool returned a result.', scope,
        output: normalized.output, content: normalized.content };
    } catch (error) {
      if (error instanceof McpCredentialContentError) return {
        kind: 'failure', execution: { state: 'settled' }, summary: 'MCP result withheld because it contained host credentials.',
        scope: { ...scope, coverage: 'partial', causes: ['credential_content'] },
        output: { reason: 'runtime_error', error: 'mcp_credential_content',
          details: { sha256: error.sha256, size: error.size, original: 'unavailable_credential_content' } }
      };
      const protocol = error instanceof ProtocolError;
      const unavailableResultType = error instanceof SdkError && error.code === SdkErrorCode.UnsupportedResultType;
      const rejected = protocol && [ProtocolErrorCode.ParseError, ProtocolErrorCode.InvalidRequest,
        ProtocolErrorCode.MethodNotFound, ProtocolErrorCode.InvalidParams,
        ProtocolErrorCode.MissingRequiredClientCapability, ProtocolErrorCode.UnsupportedProtocolVersion,
        -32020 // Modern HTTP header/body routing mismatch, rejected before dispatch.
      ].includes(error.code);
      const known = returned || rejected;
      return { kind: 'failure', execution: { state: rejected ? 'not_started' : known ? 'settled' : 'unknown' },
        summary: known ? 'MCP tool returned an unusable response.' : 'MCP tool outcome is unknown; do not retry without reconciliation.',
        scope: { ...scope, coverage: 'partial', causes: [known ? 'unusable_response' : 'outcome_unknown'] },
        output: { reason: 'runtime_error', error: protocol ? 'mcp_protocol_error' : unavailableResultType ? 'mcp_result_type_unavailable'
          : known ? 'mcp_invalid_result' : 'mcp_outcome_unknown',
          details: parseJsonObject({ ...(protocol ? { protocolCode: error.code } : {}), sourceId: this.id, toolId: remote.name }) } };
    }
  }

  private requireEntry(reference: ToolReference): CatalogEntry {
    const entry = this.entries.get(reference.toolId);
    if (!entry || reference.sourceId !== this.id || reference.bindingRevision !== this.bindingRevision
      || canonicalJsonString(parseJsonObject(reference)) !== canonicalJsonString(parseJsonObject(entry.reference))) {
      throw new Error('MCP exact tool reference is stale or belongs to another binding.');
    }
    return entry;
  }
  private requestOptions(signal?: AbortSignal): RequestOptions {
    return { ...(signal ? { signal } : {}), timeout: this.limits.requestTimeoutMs,
      maxTotalTimeout: this.limits.requestTimeoutMs, resetTimeoutOnProgress: false };
  }
  private assertOpen(): void { if (this.closed) throw new Error('MCP source is closed.'); }
}
function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`MCP ${label} must be an opaque identifier.`);
  return value;
}
function digest(value: unknown): string {
  return hashArtifactBytes(new TextEncoder().encode(canonicalJsonString(value)));
}
