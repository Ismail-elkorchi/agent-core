import { Resolver } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { WebRequest, WebResponse, WebTransport } from './contracts.js';
import { WebRequestError } from './contracts.js';
import { canonicalWebUrl } from './policy.js';

export interface WebAddress { readonly address: string; readonly family: 4 | 6 }
export interface NodeWebTransportOptions {
  /** Host-controlled injectable DNS authority, primarily useful for deterministic qualification. */
  readonly resolveAddresses?: (hostname: string, signal: AbortSignal) => Promise<readonly WebAddress[]>;
  /** Host-controlled HTTPS implementation; the default uses Node TLS certificate validation. */
  readonly request?: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  readonly id?: string;
}
/** Dedicated TLS connections, pinned public DNS addresses, no proxy/cookies/redirect following. */
export function createNodeWebTransport(options: NodeWebTransportOptions = {}): WebTransport {
  const resolveAddresses = options.resolveAddresses ?? resolvePublicAddresses;
  const request = options.request ?? httpsRequest;
  return Object.freeze({ id: options.id ?? 'agent-core.node-public-https.v1', async get(input: WebRequest): Promise<WebResponse> {
    const url = new URL(canonicalWebUrl(input.url));
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    if (Object.keys(input.headers ?? {}).some(name => ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'cookie', 'upgrade'].includes(name.toLowerCase())))
      throw new WebRequestError('blocked', 'Transport routing, cookies, proxy credentials and upgrade headers cannot be overridden.');
    if (/(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/iu.test(hostname))
      throw new WebRequestError('blocked', 'The hostname is not a public web destination.');
    const timeout = new AbortController();
    const timer = setTimeout(() => { timeout.abort(new WebRequestError('timeout', 'Web request deadline exceeded.')); }, input.limits.requestTimeoutMs);
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    try {
      signal.throwIfAborted();
      const literal = isIP(hostname);
      const addresses = literal ? [{ address: hostname, family: literal as 4 | 6 }] : await abortableResolution(resolveAddresses(hostname, signal), signal);
      signal.throwIfAborted();
      if (!addresses.length || addresses.length > 64 || addresses.some(item => !isPublicWebAddress(item.address) || isIP(item.address) !== item.family))
        throw new WebRequestError('blocked', 'DNS returned a non-public or invalid destination address.');
      const address = addresses[0];
      if (!address) throw new WebRequestError('blocked', 'DNS returned no public destination address.');
      const lookup: LookupFunction = (_hostname, _lookupOptions, callback) => { callback(null, address.address, address.family); };
      return await new Promise<WebResponse>((resolve, reject) => {
        let received = false;
        const headers = { accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.1', 'accept-encoding': 'gzip, deflate, br',
          'user-agent': 'AgentCore-SourceRetriever/0.2', ...input.headers, host: url.host, connection: 'close' };
        if (Object.entries(headers).some(([key, value]) => !/^[a-zA-Z0-9-]+$/u.test(key) || /[\r\n\0]/u.test(value))
          || Object.entries(headers).reduce((n, [key, value]) => n + Buffer.byteLength(key) + Buffer.byteLength(value) + 4, 0) > input.limits.maxHeaderBytes)
          { reject(new WebRequestError('header_limit', 'Request headers exceed the configured limit or are invalid.')); return; }
        const req = request(url, { method: 'GET', agent: false, family: address.family, lookup,
          rejectUnauthorized: true, maxHeaderSize: input.limits.maxHeaderBytes, signal, headers }, response => {
          received = true;
          response.setTimeout(input.limits.idleTimeoutMs, () => response.destroy(new WebRequestError('timeout', 'Web response stalled.')));
          void collectResponse(response, input, signal).then(resolve, reject);
        });
        req.once('socket', socket => {
          (socket as TLSSocket).once('secureConnect', () => {
            if (socket.remoteAddress === undefined || normalizedAddress(socket.remoteAddress) !== normalizedAddress(address.address))
              req.destroy(new WebRequestError('blocked', 'The connected address differs from the validated DNS address.'));
          });
        });
        req.setTimeout(input.limits.idleTimeoutMs, () => req.destroy(new WebRequestError('timeout', 'Web connection stalled.')));
        req.once('error', error => {
          if (!received) reject(error);
        });
        req.end();
      });
    } catch (error) {
      if (input.signal.aborted) throw new WebRequestError('aborted', 'The web request was cancelled.');
      if (timeout.signal.aborted) throw new WebRequestError('timeout', 'Web request deadline exceeded.');
      if (error instanceof WebRequestError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'HPE_HEADER_OVERFLOW')
        throw new WebRequestError('header_limit', 'Response headers exceeded the configured limit.');
      throw new WebRequestError('network_error', 'The public HTTPS request failed.');
    } finally { clearTimeout(timer); }
  } });
}

async function collectResponse(response: IncomingMessage, input: WebRequest, signal: AbortSignal): Promise<WebResponse> {
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i]?.toLowerCase();
    const value = response.rawHeaders[i + 1];
    if (!name || value === undefined) throw new WebRequestError('invalid_response', 'Malformed response headers.');
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (headerBytes > input.limits.maxHeaderBytes) { response.destroy(); throw new WebRequestError('header_limit', 'Response headers exceeded the configured limit.'); }
    if (['content-encoding', 'content-length', 'content-type', 'location'].includes(name) && headers[name] !== undefined) {
      response.destroy(); throw new WebRequestError('invalid_response', 'Ambiguous response metadata.');
    }
    headers[name] = value;
  }
  const status = response.statusCode ?? 0;
  // Redirect/error bodies cannot become successful source captures. Close promptly without draining arbitrary bytes.
  if (status < 200 || status >= 300) { response.destroy(); return { status, headers, body: new Uint8Array(), transferredBytes: 0 }; }
  const length = headers['content-length'];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > input.limits.maxTransferBytes)) {
    response.destroy(); throw new WebRequestError('byte_limit', 'Content-Length exceeds the configured transfer limit or is invalid.');
  }
  let transferredBytes = 0;
  let decodedBytes = 0;
  const chunks: Buffer[] = [];
  const counter = new Transform({ transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    transferredBytes += chunk.length;
    if (transferredBytes > input.limits.maxTransferBytes) callback(new WebRequestError('byte_limit', 'Transferred response bytes exceeded the configured limit.'));
    else callback(null, chunk);
  } });
  const collector = new Transform({ transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    decodedBytes += chunk.length;
    if (decodedBytes > input.limits.maxResponseBytes || decodedBytes > Math.max(1024, transferredBytes * input.limits.maxExpansionRatio))
      callback(new WebRequestError('byte_limit', 'Decoded response bytes exceeded the configured byte or expansion limit.'));
    else { chunks.push(Buffer.from(chunk)); callback(); }
  } });
  const encoding = headers['content-encoding']?.trim().toLowerCase() ?? 'identity';
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  if (!decoder && encoding !== 'identity') { response.destroy(); throw new WebRequestError('unsupported_encoding', 'The HTTP content encoding is unsupported.'); }
  if (decoder) await pipeline(response, counter, decoder, collector, { signal });
  else await pipeline(response, counter, collector, { signal });
  if (length !== undefined && Number(length) !== transferredBytes) throw new WebRequestError('invalid_response', 'The response ended before its declared length.');
  return { status, headers, body: Buffer.concat(chunks, decodedBytes), transferredBytes };
}
async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<readonly WebAddress[]> {
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  const cancel = () => { resolver.cancel(); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    return answers.flatMap((answer, index): WebAddress[] => answer.status === 'fulfilled'
      ? answer.value.map(address => ({ address, family: index === 0 ? 4 : 6 })) : []);
  } finally { signal.removeEventListener('abort', cancel); resolver.cancel(); }
}
async function abortableResolution<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel = () => { /* assigned before awaiting */ };
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => { reject(signal.reason instanceof Error ? signal.reason : new WebRequestError('aborted', 'DNS resolution was cancelled.')); }; signal.addEventListener('abort', cancel, { once: true }); });
  try { signal.throwIfAborted(); return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
/** Conservative public-global-unicast policy, including rejection of IPv4-mapped and transition IPv6. */
export function isPublicWebAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const a = octets[0] ?? 0, b = octets[1] ?? 0, c = octets[2] ?? 0;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const groups = ipv6Groups(address);
  const a = groups[0] ?? 0, b = groups[1] ?? 0;
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3ffe && a !== 0x3fff
    && !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8));
}
function normalizedAddress(address: string): string { return isIP(address) === 6 ? ipv6Groups(address).map(n => n.toString(16)).join(':') : address; }
function ipv6Groups(address: string): number[] {
  const [left = '', right] = address.toLowerCase().split('::');
  const before = left ? left.split(':').map(n => Number.parseInt(n, 16)) : [];
  if (right === undefined) return before;
  const after = right ? right.split(':').map(n => Number.parseInt(n, 16)) : [];
  return [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after];
}
