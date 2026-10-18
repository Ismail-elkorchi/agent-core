import { isAbsolute } from 'node:path';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
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
  /** Absolute host-owned executable path; scripts belong in args to an explicit interpreter. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Required absolute working directory; never model-selected. */
  readonly cwd: string;
  /** Explicit environment allowlist, plus Windows installation paths needed to start a process. No ambient credentials are inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly limits?: Partial<McpLimits>;
}
export function createMcpStdioTransport(options: McpStdioTransportOptions): Transport {
  if (!isAbsolute(options.command) || !isAbsolute(options.cwd)) throw new Error('MCP stdio requires absolute executable and working directory paths.');
  if (process.platform === 'win32') assertWindowsExecutable(options.command);
  const limits = mcpLimits(options.limits);
  return new StdioClientTransport({ command: options.command, args: [...(options.args ?? [])], cwd: options.cwd,
    env: captureStdioEnvironment(options.env), stderr: 'ignore', maxBufferSize: limits.maxMessageBytes });
}

function assertWindowsExecutable(command: string): void {
  // cross-spawn otherwise inserts cmd.exe for wrappers or unresolved paths, even
  // though the SDK passes shell:false. Explicit cmd.exe itself remains allowed.
  if (!/\.(?:exe|com)$/iu.test(command)) throw new Error('MCP stdio on Windows requires an explicit .exe or .com executable; pass scripts as interpreter arguments.');
  let file: number | undefined;
  try {
    file = openSync(command, 'r');
    if (!fstatSync(file).isFile()) throw new Error('not a file');
    const header = Buffer.alloc(2);
    readSync(file, header, 0, header.length, 0);
    if (header[0] === 0x23 && header[1] === 0x21) throw new Error('shebang wrapper');
  } catch {
    throw new Error('MCP stdio on Windows requires a readable executable file without a shebang wrapper.');
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

function captureStdioEnvironment(explicit: Readonly<Record<string, string>>): Record<string, string> {
  const windows = process.platform === 'win32';
  // The SDK merges defaults even when env is explicit. libuv also supplies these
  // Windows identity variables when absent, so suppress them as well.
  const cleared = windows ? [...DEFAULT_INHERITED_ENV_VARS, 'LOGONSERVER', 'USERDOMAIN'] : DEFAULT_INHERITED_ENV_VARS;
  const environment = new Map(cleared.map(name => [name, '']));
  if (windows) {
    // Present-but-empty SYSTEMROOT prevents libuv's fallback and breaks Winsock
    // initialization in Node. Only machine installation paths may be inherited;
    // PATH, profiles, temporary directories and credentials remain host-owned.
    for (const name of ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR']) {
      const value = process.env[name];
      if (value !== undefined) environment.set(name, value);
    }
  }
  const names = new Set<string>();
  for (const [name, value] of Object.entries(explicit)) {
    const normalized = windows ? name.toUpperCase() : name;
    if (!name || /[=\0]/u.test(name) || typeof value !== 'string' || value.includes('\0'))
      throw new Error('MCP stdio environment entries must have valid names and string values.');
    if (names.has(normalized)) throw new Error('MCP stdio environment contains duplicate case-insensitive names.');
    names.add(normalized);
    environment.set(normalized, value);
  }
  if (windows && !isAbsolute(environment.get('SYSTEMROOT') ?? ''))
    throw new Error('MCP stdio on Windows requires an absolute SYSTEMROOT installation path.');
  return Object.fromEntries(environment);
}
