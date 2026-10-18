import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { createWebPolicy } from '@agent-core/tools-web';
import { createNodeWebTransport, isPublicWebAddress } from '@agent-core/tools-web/node';

const limits = createWebPolicy({ id: 'transport-test' }).limits;
function fixture({ body = Buffer.from('body'), status = 200, headers = { 'content-type': 'text/plain' }, addresses = [{ address: '93.184.216.34', family: 4 }], remoteAddress, hang = false } = {}) {
  const calls = [];
  let destroyed = false;
  const transport = createNodeWebTransport({ id: 'test-node-https',
    async resolveAddresses(hostname, signal) { calls.push({ phase: 'dns', hostname, signal }); return addresses; },
    request(url, options, receive) {
      calls.push({ phase: 'connection', url: url.href, options });
      const req = new EventEmitter();
      const response = new PassThrough();
      response.rawHeaders = Object.entries(headers).flat();
      response.statusCode = status;
      response.setTimeout = () => response;
      req.setTimeout = () => req;
      req.destroy = error => { destroyed = true; response.destroy(error); req.emit('error', error ?? new Error('closed')); };
      req.end = () => queueMicrotask(() => {
        if (options.signal.aborted) return req.destroy(options.signal.reason);
        options.signal.addEventListener('abort', () => req.destroy(options.signal.reason), { once: true });
        const socket = new EventEmitter();
        socket.remoteAddress = remoteAddress ?? addresses[0]?.address;
        req.emit('socket', socket);
        socket.emit('secureConnect');
        if (destroyed) return;
        if (hang) return;
        receive(response);
        response.end(body);
      });
      response.on('error', () => {});
      return req;
    }
  });
  return { transport, calls, destroyed: () => destroyed };
}
const get = (f, options = {}) => f.transport.get({ url: 'https://public.example.org/article', limits, signal: new AbortController().signal, ...options });

test('non-public IPv4, IPv6, mapped addresses, transition addresses and reserved ranges are rejected', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1', '64:ff9b::7f00:1'])
    assert.equal(isPublicWebAddress(address), false, address);
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicWebAddress(address), true, address);
});

test('mixed DNS answers cannot cause a connection and hostname lookup is pinned once', async () => {
  const mixed = fixture({ addresses: [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(get(mixed), error => error.code === 'blocked');
  assert.equal(mixed.calls.filter(call => call.phase === 'connection').length, 0);
  const f = fixture();
  await get(f);
  const options = f.calls.find(call => call.phase === 'connection').options;
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.family, 4);
  const address = await new Promise((resolve, reject) => options.lookup('public.example.org', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(address, { address: '93.184.216.34', family: 4 });
  assert.equal(f.calls.filter(call => call.phase === 'dns').length, 1);
});

test('actual connection mismatch, private literals and normalized alternate IP encodings cannot bypass the guard', async () => {
  const mismatch = fixture({ remoteAddress: '127.0.0.1' });
  await assert.rejects(get(mismatch), error => error.code === 'blocked');
  assert.equal(mismatch.destroyed(), true);
  for (const url of ['https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://[::ffff:127.0.0.1]', 'https://localhost', 'https://metadata.internal']) {
    const f = fixture();
    await assert.rejects(get(f, { url }), error => error.code === 'blocked');
    assert.equal(f.calls.filter(call => call.phase === 'connection').length, 0, url);
  }
});

test('gzip, deflate and brotli streams preserve entity bytes and count transferred bytes', async () => {
  const content = Buffer.from('Café 😀\n'.repeat(20));
  for (const [encoding, compressed] of [['gzip', gzipSync(content)], ['deflate', deflateSync(content)], ['br', brotliCompressSync(content)]]) {
    const f = fixture({ body: compressed, headers: { 'content-type': 'text/plain', 'content-encoding': encoding } });
    const result = await get(f);
    assert.deepEqual(result.body, content);
    assert.equal(result.transferredBytes, compressed.length);
  }
});

test('transfer, decoded, expansion, header and unknown encoding limits fail without a complete body', async () => {
  for (const [config, override, code] of [
    [{ body: Buffer.alloc(100) }, { maxTransferBytes: 10 }, 'byte_limit'],
    [{ body: gzipSync(Buffer.alloc(10_000, 65)), headers: { 'content-encoding': 'gzip' } }, { maxResponseBytes: 100 }, 'byte_limit'],
    [{ body: gzipSync(Buffer.alloc(10_000, 65)), headers: { 'content-encoding': 'gzip' } }, { maxExpansionRatio: 2 }, 'byte_limit'],
    [{ headers: { 'x-large': 'a'.repeat(300) } }, { maxHeaderBytes: 256 }, 'header_limit'],
    [{ headers: { 'content-encoding': 'unknown' } }, {}, 'unsupported_encoding']
  ]) {
    await assert.rejects(get(fixture(config), { limits: { ...limits, ...override } }), error => error.code === code);
  }
});

test('redirect response closes promptly and does not resolve or connect to its Location', async () => {
  const f = fixture({ status: 302, headers: { location: 'https://127.0.0.1/private' } });
  const result = await get(f);
  assert.equal(result.status, 302);
  assert.equal(result.body.length, 0);
  assert.equal(f.calls.filter(call => call.phase === 'connection').length, 1);
  assert.equal(f.calls.filter(call => call.phase === 'dns').length, 1);
});

test('cancellation and overall deadlines close an outstanding request', async () => {
  const controller = new AbortController();
  const f = fixture({ hang: true });
  const pending = get(f, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, error => error.code === 'aborted');
  assert.equal(f.destroyed(), true);
  const timeout = fixture({ hang: true });
  await assert.rejects(get(timeout, { limits: { ...limits, requestTimeoutMs: 5 } }), error => error.code === 'timeout');
  assert.equal(timeout.destroyed(), true);
});

test('host routing, proxy, cookie and protocol headers cannot change the authorized destination', async () => {
  for (const name of ['Host', 'connection', 'transfer-encoding', 'content-length', 'proxy-authorization', 'cookie', 'upgrade']) {
    const f = fixture();
    await assert.rejects(get(f, { headers: { [name]: 'different-destination' } }), error => error.code === 'blocked');
    assert.equal(f.calls.length, 0, name);
  }
});
