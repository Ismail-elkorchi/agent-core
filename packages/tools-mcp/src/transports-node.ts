import { isAbsolute } from 'node:path';
import { StreamableHTTPClientTransport, type FetchLike, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { mcpLimits, type McpLimits } from './limits.js';
import { MCP_PROTOCOL_VERSION } from './source.js';

export interface McpHttpTransportOptions {
  readonly endpoint: string | URL;
  /** Host-owned credential retrieval. No OAuth grants, refresh, or redirects are initiated. */
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
  readonly fetch?: FetchLike;
  readonly allowInsecureLoopback?: boolean;
  readonly limits?: Partial<McpLimits>;
}
export function createMcpHttpTransport(options: McpHttpTransportOptions): Transport {
  const endpoint = new URL(options.endpoint);
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error('MCP endpoint must not contain userinfo or a fragment.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(options.allowInsecureLoopback === true && loopback && endpoint.protocol === 'http:')) {
    throw new Error('MCP HTTP endpoints require HTTPS; loopback HTTP requires explicit host permission.');
  }
  const limits = mcpLimits(options.limits);
  const hostFetch = options.fetch ?? globalThis.fetch;
  const boundedFetch: FetchLike = async (url, init) => {
    if (new URL(url).href !== endpoint.href) throw new Error('MCP request attempted to leave its bound endpoint.');
    const headers = new Headers(await options.headers?.());
    // SDK protocol headers win; host credentials cannot alter method/version routing.
    new Headers(init?.headers).forEach((value, key) => { headers.set(key, value); });
    const deadline = AbortSignal.timeout(limits.subscriptionLifetimeMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    let response: Response;
    try { response = await hostFetch(endpoint, { ...init, headers, redirect: 'error', signal }); }
    catch { throw new Error('MCP HTTP request failed.'); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('MCP redirects are not permitted.');
    }
    if (!response.body) return response;
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > limits.maxMessageBytes) {
      await response.body.cancel();
      throw new Error('MCP HTTP response limit exceeded.');
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > limits.maxMessageBytes) {
            await reader.cancel();
            controller.error(new Error('MCP HTTP response limit exceeded.'));
            return;
          }
          controller.enqueue(chunk.value);
        } catch {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error('MCP HTTP response stream failed.'));
        }
      },
      async cancel() { await reader.cancel(); }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return new StreamableHTTPClientTransport(endpoint, {
    fetch: boundedFetch, protocolVersion: MCP_PROTOCOL_VERSION,
    requestInit: { redirect: 'error' }, redirectPolicy: 'same-origin',
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
  });
}

export interface McpStdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Required absolute working directory; never model-selected. */
  readonly cwd: string;
  /** Explicit environment allowlist. No ambient credentials are inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly limits?: Partial<McpLimits>;
}
export function createMcpStdioTransport(options: McpStdioTransportOptions): Transport {
  if (!options.command.trim() || !isAbsolute(options.cwd)) throw new Error('MCP stdio requires an executable and an absolute working directory.');
  const limits = mcpLimits(options.limits);
  return new StdioClientTransport({ command: options.command, args: [...(options.args ?? [])], cwd: options.cwd,
    env: { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(name => [name, ''])), ...options.env }, stderr: 'ignore', maxBufferSize: limits.maxMessageBytes });
}
