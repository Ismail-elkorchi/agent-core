import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpToolSource, MCP_PROTOCOL_VERSION } from '@agent-core/tools-mcp';
import { createMcpHttpTransport, createMcpStdioTransport, parseMcpConfiguration, createConfiguredMcpSources } from '@agent-core/tools-mcp/node';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { isOwnedJsonValue } from '@agent-core/json';
import { planToolCall, createToolCall, releaseToolCallPlan } from '@agent-core/tools';
import { invokeToolCall } from './tool-call-helpers.js';

const inputSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
const serverMeta = { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1' } };
const remote = (extra = {}) => ({ name: 'echo', description: 'Echo a value', inputSchema, ...extra });
class WireTransport {
  messages = [];
  tools = [remote()];
  response = { content: [], structuredContent: 'ok' };
  listChanged = false;
  calls = 0;
  closed = false;
  async start() {}
  async close() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
  reply(id, result) { queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: serverMeta, ...result } })); }
  notification(method, params = {}) { this.onmessage?.({ jsonrpc: '2.0', method, params }); }
  async send(message) {
    this.messages.push(structuredClone(message));
    if (message.method === 'server/discover') {
      if (this.legacy) this.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } });
      else this.reply(message.id, { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: { listChanged: this.listChanged } } });
    } else if (message.method === 'subscriptions/listen') {
      this.listenId = message.id;
      queueMicrotask(() => this.notification('notifications/subscriptions/acknowledged', {
        _meta: { 'io.modelcontextprotocol/subscriptionId': message.id }, notifications: { toolsListChanged: true }
      }));
    } else if (message.method === 'tools/list') {
      const page = this.list?.(message.params) ?? { tools: this.tools };
      this.reply(message.id, { ttlMs: 0, cacheScope: 'private', ...page });
    } else if (message.method === 'tools/call') {
      this.calls += 1;
      if (this.call) return this.call(message);
      this.reply(message.id, this.response);
    }
  }
}
const policy = {
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'remote-data' }], lockScopes: [] },
  deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'remote-data' }], lockScopes: [] })
};
function sourceFor(transport, extra = {}) {
  return new McpToolSource({ id: 'fixture', binding: { endpointId: 'endpoint-v1', accountId: 'account-a', policyRevision: 'policy-v1' },
    createTransport: () => transport, tools: { echo: policy }, limits: { requestTimeoutMs: 500 }, ...extra });
}
async function loaded(source) { const snapshot = await source.snapshot(); return { snapshot, tool: await source.load(snapshot.tools[0].reference) }; }
async function call(source, input = { value: 'x' }, context = {}) {
  const { tool } = await loaded(source);
  return invokeToolCall({ name: tool.name, input: { kind: 'json', value: input } }, [tool], {
    policy: { allowedRisks: ['read', 'network', 'write'] }, ...context
  });
}

test('MCP modern wire uses per-request envelope and exact server-qualified loaded tools', async t => {
  const wire = new WireTransport();
  const source = sourceFor(wire); t.after(() => source.close());
  const { snapshot, tool } = await loaded(source);
  assert.equal(snapshot.tools[0].reference.sourceId, 'fixture');
  assert.equal(snapshot.tools[0].reference.toolId, 'echo');
  assert.equal(snapshot.tools[0].reference.bindingRevision, source.bindingRevision);
  assert.match(tool.name, /^mcp_fixture_echo_/);
  const result = await call(source);
  assert.equal(result.kind, 'result');
  assert.equal(result.output.structuredContent, 'ok');
  for (const message of wire.messages.filter(message => message.id !== undefined)) {
    assert.notEqual(message.method, 'initialize');
    assert.equal(message.params._meta['io.modelcontextprotocol/protocolVersion'], MCP_PROTOCOL_VERSION);
    assert.deepEqual(message.params._meta['io.modelcontextprotocol/clientCapabilities'], {});
  }
  assert.equal(wire.calls, 1);
});

test('MCP transport boundaries forward owned snapshots and isolate mutable host response messages', async t => {
  const wire = new WireTransport();
  const sentOwnership = [];
  const send = wire.send.bind(wire);
  wire.send = async message => {
    sentOwnership.push({ method: message.method, owned: isOwnedJsonValue(message),
      frozen: Object.isFrozen(message) && Object.isFrozen(message.params) });
    await send(message);
  };
  let original;
  wire.call = message => {
    original = { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', _meta: serverMeta,
      content: [], structuredContent: { value: 'captured before mutation' } } };
    wire.onmessage(original);
    original.result.structuredContent.value = 'mutated after delivery';
  };
  const source = sourceFor(wire); t.after(() => source.close());
  const result = await call(source);
  assert.equal(result.kind, 'result');
  assert.deepEqual(result.output.structuredContent, { value: 'captured before mutation' });
  assert.equal(original.result.structuredContent.value, 'mutated after delivery');
  assert.ok(sentOwnership.some(message => message.method === 'tools/call'));
  assert.ok(sentOwnership.every(message => message.owned && message.frozen));
});

test('MCP rejects initialize-only servers without fallback', async t => {
  const wire = new WireTransport(); wire.legacy = true;
  const source = sourceFor(wire); t.after(() => source.close());
  await assert.rejects(source.snapshot(), /2026-07-28/);
  assert.deepEqual(wire.messages.map(message => message.method), ['server/discover']);
});

test('MCP pagination is bounded, detects repetition and duplicate names, and excludes unmapped tools', async t => {
  for (const [kind, list, pattern] of [
    ['pages', () => ({ tools: [], nextCursor: String(Math.random()) }), /page limit/],
    ['cursor', () => ({ tools: [], nextCursor: 'same' }), /cursor/],
    ['duplicate', () => ({ tools: [remote(), remote()] }), /duplicate/]
  ]) {
    const wire = new WireTransport(); wire.list = list;
    const source = sourceFor(wire, { id: kind, limits: { maxPages: 2, requestTimeoutMs: 500 } }); t.after(() => source.close());
    await assert.rejects(source.snapshot(), pattern);
  }
  const wire = new WireTransport(); wire.tools = [remote(), remote({ name: 'unmapped', annotations: { readOnlyHint: true } })];
  const source = sourceFor(wire); t.after(() => source.close());
  assert.equal((await source.snapshot()).tools.length, 1);
});

test('MCP stale schemas and changed account binding cannot resolve an old reference', async t => {
  const wire = new WireTransport();
  const source = sourceFor(wire); t.after(() => source.close());
  const { snapshot } = await loaded(source);
  wire.tools = [remote({ description: 'Changed tool meaning' })];
  await assert.rejects(source.load(snapshot.tools[0].reference), /stale/);
  const second = sourceFor(new WireTransport(), { binding: { endpointId: 'endpoint-v1', accountId: 'account-b', policyRevision: 'policy-v1' } });
  t.after(() => second.close());
  await assert.rejects(second.load(snapshot.tools[0].reference), /stale/);
});

test('MCP host effects remain required despite read-only and idempotent server hints', async t => {
  const wire = new WireTransport(); wire.tools = [remote({ annotations: { readOnlyHint: true, idempotentHint: true } })];
  const source = sourceFor(wire, { tools: { echo: {
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'account-data' }], lockScopes: [] },
    deriveEffects: () => ({ accesses: [{ mode: 'write', scope: 'account-data' }], lockScopes: [] })
  } } }); t.after(() => source.close());
  const { tool } = await loaded(source);
  const plan = await planToolCall(createToolCall({ name: tool.name, input: { kind: 'json', value: { value: 'x' } } }), [tool], {
    policy: { allowedRisks: ['read', 'network'] }, signal: new AbortController().signal,
    boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.effects.accesses.some(access => access.mode === 'write'), true);
  assert.equal(plan.plan.effects.recovery.kind, 'unknown');
  await releaseToolCallPlan(plan.plan);
  const denied = await call(source, { value: 'x' }, { policy: { allowedRisks: ['read', 'network'] } });
  assert.equal(denied.output.reason, 'policy');
  assert.equal(wire.calls, 0);
});

test('MCP invalid input never dispatches; declared scalar and array output schemas are enforced', async t => {
  const wire = new WireTransport(); wire.tools = [remote({ outputSchema: { type: 'array', items: { type: 'number' } } })];
  wire.response = { content: [], structuredContent: [1, 2] };
  const source = sourceFor(wire); t.after(() => source.close());
  assert.deepEqual((await call(source)).output.structuredContent, [1, 2]);
  assert.equal((await call(source, { value: 3 })).output.reason, 'invalid_arguments');
  assert.equal(wire.calls, 1);
  wire.response = { content: [], structuredContent: ['wrong'] };
  const invalid = await call(source);
  assert.equal(invalid.kind, 'failure');
  assert.notEqual(invalid.output.error, 'mcp_tool_error');
});

test('MCP tool errors are settled; post-dispatch disconnect and timeout retain unknown outcome without retry', async t => {
  const wire = new WireTransport(); wire.response = { content: [{ type: 'text', text: 'Tool error' }], isError: true };
  const source = sourceFor(wire); t.after(() => source.close());
  const failure = await call(source);
  assert.equal(failure.execution.state, 'settled');
  assert.equal(failure.output.error, 'mcp_tool_error');
  for (const mode of ['disconnect', 'timeout']) {
    const transport = new WireTransport();
    transport.call = async () => { if (mode === 'disconnect') await transport.close(); };
    const failed = sourceFor(transport, { id: mode, limits: { requestTimeoutMs: 20 } }); t.after(() => failed.close());
    const observation = await call(failed);
    assert.equal(observation.execution.state, 'unknown');
    assert.equal(observation.output.error, 'mcp_outcome_unknown');
    assert.equal(transport.calls, 1);
  }
});

test('MCP returned binary is a bounded local artifact with origin; resource links never fetch or grant local authority', async t => {
  const wire = new WireTransport();
  const artifacts = new InMemoryArtifactRepository();
  wire.response = { content: [
    { type: 'image', mimeType: 'image/png', data: btoa('pixels') },
    { type: 'audio', mimeType: 'audio/wav', data: btoa('sound') },
    { type: 'resource', resource: { uri: 'file:///etc/passwd', mimeType: 'application/octet-stream', blob: btoa('remote bytes') } },
    { type: 'resource_link', uri: 'file:///etc/passwd', name: 'untrusted remote reference' }
  ], structuredContent: null };
  const source = sourceFor(wire, { artifacts }); t.after(() => source.close());
  const result = await call(source);
  assert.equal(result.kind, 'result');
  assert.equal(result.output.structuredContent, null);
  assert.equal(result.output.content[0].origin.sourceId, 'fixture');
  assert.equal(result.output.content[0].artifact.visibility, 'public');
  assert.equal(new TextDecoder().decode(await artifacts.readVerified(result.output.content[2].artifact)), 'remote bytes');
  assert.equal(result.output.content[2].origin.uri, 'file:///etc/passwd');
  assert.equal(result.output.content[3].type, 'resource_link');
  assert.equal(result.output.content[3].artifact, undefined);
  assert.equal(wire.messages.some(message => message.method === 'resources/read'), false);
});

test('MCP unadvertised input-required and tasks cannot start callback flows', async t => {
  const wire = new WireTransport(); wire.response = { resultType: 'input_required', inputRequests: {
    secret: { method: 'elicitation/create', params: { message: 'secret', requestedSchema: { type: 'object', properties: {} } } }
  } };
  const source = sourceFor(wire); t.after(() => source.close());
  const result = await call(source);
  assert.equal(result.kind, 'failure');
  assert.equal(result.output.error, 'mcp_result_type_unavailable');
  assert.equal(wire.calls, 1);
  assert.equal(wire.messages.some(message => message.method?.startsWith('elicitation/') || message.method?.startsWith('tasks/')), false);
});

test('MCP notification subscription invalidates a cached catalog and closes cleanly', async t => {
  const wire = new WireTransport(); wire.listChanged = true;
  const source = sourceFor(wire, { limits: { requestTimeoutMs: 500, catalogMaxAgeMs: 60_000 } }); t.after(() => source.close());
  const first = await source.snapshot();
  wire.tools = [remote({ description: 'new definition' })];
  wire.notification('notifications/tools/list_changed', { _meta: { 'io.modelcontextprotocol/subscriptionId': wire.listenId } });
  await new Promise(resolve => setImmediate(resolve));
  const second = await source.snapshot();
  assert.notEqual(first.revision, second.revision);
  assert.equal(wire.messages.filter(message => message.method === 'subscriptions/listen').length, 1);
  await source.close();
  assert.equal(wire.closed, true);
});

test('MCP schemas reject unsupported constraints; oversized responses and binary fail closed', async t => {
  const wire = new WireTransport(); wire.tools = [remote({ inputSchema: { ...inputSchema, patternProperties: { '^x': { type: 'string' } } } })];
  const source = sourceFor(wire); t.after(() => source.close());
  await assert.rejects(source.snapshot(), /schema capability is unavailable/);
  const binary = new WireTransport(); binary.response = { content: [{ type: 'image', mimeType: 'image/png', data: btoa('too many bytes') }] };
  const binarySource = sourceFor(binary, { artifacts: new InMemoryArtifactRepository(), limits: { maxBinaryBytes: 3 } });
  t.after(() => binarySource.close());
  const result = await call(binarySource);
  assert.equal(result.kind, 'failure');
  assert.equal(result.execution.state, 'settled');
});

test('MCP node HTTP binds credentials to one endpoint and refuses redirect or oversized raw bodies', async t => {
  const requests = [];
  const transport = createMcpHttpTransport({ endpoint: 'https://mcp.example/tools', headers: () => ({ Authorization: 'Bearer private-token' }),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        _meta: serverMeta, supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} }
      } }), { headers: { 'content-type': 'application/json' } });
    }
  });
  const source = sourceFor(transport); t.after(() => source.close());
  await assert.rejects(source.snapshot()); // Fixture only implements discover, not list.
  assert.equal(requests[0].init.headers.get('authorization'), 'Bearer private-token');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.get('mcp-protocol-version'), MCP_PROTOCOL_VERSION);
  assert.throws(() => createMcpHttpTransport({ endpoint: 'http://public.example/mcp' }), /HTTPS/);
  assert.throws(() => createMcpHttpTransport({ endpoint: 'https://secret@example.com/mcp' }), /userinfo/);
  assert.throws(() => createMcpStdioTransport({ command: 'node', cwd: 'relative', env: {} }), /absolute/);
});


test('MCP HTTP configuration is bounded, secret-free, and binds exact endpoint/account/policy', async () => {
  const raw = { servers: [{ id: 'configured', endpoint: 'https://inventory.example/mcp', accountId: 'operator-17',
    policyRevision: 'read-1', bearerTokenEnv: 'MCP_TOKEN', tools: { echo: policy.effectEnvelope } }] };
  const config = parseMcpConfiguration(raw);
  assert.equal(Object.isFrozen(config.servers[0].tools), true);
  const a = createConfiguredMcpSources(config, { environment: { MCP_TOKEN: 'private-secret' } });
  const b = createConfiguredMcpSources({ servers: [{ ...config.servers[0], endpoint: 'https://inventory.example/other' }] },
    { environment: { MCP_TOKEN: 'private-secret' } });
  assert.notEqual(a.sources[0].bindingRevision, b.sources[0].bindingRevision);
  assert.equal(JSON.stringify(config).includes('private-secret'), false);
  assert.throws(() => createConfiguredMcpSources(config, { environment: {} }), /credential/);
  assert.throws(() => parseMcpConfiguration({ servers: [{ ...raw.servers[0], token: 'literal-secret' }] }));
  assert.throws(() => parseMcpConfiguration({ servers: [{ ...raw.servers[0], endpoint: 'https://inventory.example/mcp?token=secret' }] }), /query parameters/);
  assert.throws(() => parseMcpConfiguration({ servers: [raw.servers[0], raw.servers[0]] }), /duplicate/);
  await a.close(); await b.close();
});

test('MCP malformed result and protocol rejection stay separate from internal-server uncertain execution', async t => {
  for (const [code, expectedState] of [[-32602, 'not_started'], [-32020, 'not_started'],
    [-32021, 'not_started'], [-32022, 'not_started'], [-32603, 'unknown'], [-32023, 'unknown']]) {
    const wire = new WireTransport();
    wire.call = async message => wire.onmessage({ jsonrpc: '2.0', id: message.id, error: { code, message: 'private-token must not leak' } });
    const source = sourceFor(wire); t.after(() => source.close());
    const result = await call(source);
    assert.equal(result.output.error, 'mcp_protocol_error');
    assert.equal(result.execution.state, expectedState);
    assert.equal(JSON.stringify(result).includes('private-token'), false);
    assert.equal(wire.calls, 1);
  }
});

test('MCP explicit stdio construction uses the modern SDK with bounded framing and an owned environment', async t => {
  const previous = process.env.MCP_AMBIENT_SECRET;
  process.env.MCP_AMBIENT_SECRET = 'test-only-ambient-secret';
  t.after(() => { if (previous === undefined) delete process.env.MCP_AMBIENT_SECRET; else process.env.MCP_AMBIENT_SECRET = previous; });
  const transport = createMcpStdioTransport({ command: process.execPath, args: ['tests/mcp-stdio-fixture.mjs'],
    cwd: process.cwd(), env: { MCP_FIXTURE_ENV: 'explicit-value' }, limits: { maxMessageBytes: 32_000 } });
  const source = sourceFor(transport, { limits: { requestTimeoutMs: 2000 } }); t.after(() => source.close());
  const result = await call(source);
  assert.equal(result.kind, 'result');
  assert.equal(result.output.structuredContent.value, 'x');
  assert.equal(result.output.structuredContent.explicit, 'explicit-value');
  assert.equal(result.output.structuredContent.ambientHome, '');
  assert.equal(result.output.structuredContent.ambientSecretPresent, false);
  const environment = result.output.structuredContent.environment;
  for (const name of ['PATH', 'USERPROFILE', 'USERDOMAIN', 'LOGONSERVER']) assert.equal(environment[name], '', name);
  if (process.platform === 'win32') {
    assert.ok(environment.SYSTEMROOT, 'Windows bootstrap keeps its installation root');
    for (const name of ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR']) assert.equal(environment[name], process.env[name] ?? '', name);
  }
});

test('MCP stdio captures explicit environment overrides with platform-correct name identity', async t => {
  const env = { MCP_FIXTURE_ENV: 'before-mutation', [process.platform === 'win32' ? 'Path' : 'PATH']: 'explicit-host-search-path',
    ['__proto__']: 'explicit-special-value' };
  if (process.platform === 'win32') env.SystemRoot = process.env.SYSTEMROOT;
  const transport = createMcpStdioTransport({ command: process.execPath, args: ['tests/mcp-stdio-fixture.mjs'],
    cwd: process.cwd(), env });
  env.MCP_FIXTURE_ENV = 'after-mutation';
  const source = sourceFor(transport, { limits: { requestTimeoutMs: 2000 } }); t.after(() => source.close());
  const result = await call(source);
  assert.equal(result.kind, 'result');
  assert.equal(result.output.structuredContent.explicit, 'before-mutation');
  assert.equal(result.output.structuredContent.specialEnvironmentName, 'explicit-special-value');
  assert.equal(result.output.structuredContent.environment.PATH, 'explicit-host-search-path');
  if (process.platform === 'win32') {
    assert.equal(result.output.structuredContent.environment.SYSTEMROOT, process.env.SYSTEMROOT);
    assert.throws(() => createMcpStdioTransport({ command: process.execPath, cwd: process.cwd(), env: { Path: 'one', PATH: 'two' } }), /duplicate case-insensitive/);
    assert.throws(() => createMcpStdioTransport({ command: process.execPath, cwd: process.cwd(), env: { SystemRoot: '' } }), /SYSTEMROOT/);
  }
});

test('MCP stdio requires an absolute executable and rejects implicit Windows shell wrappers', async t => {
  for (const command of ['node', 'node.exe', './node', 'relative/server'])
    assert.throws(() => createMcpStdioTransport({ command, cwd: process.cwd(), env: {} }), /absolute executable/);
  assert.throws(() => createMcpStdioTransport({ command: process.execPath, cwd: 'relative', env: {} }), /absolute executable/);
  if (process.platform === 'win32') {
    for (const name of ['server.cmd', 'server.bat', 'server.ps1', 'server.js'])
      assert.throws(() => createMcpStdioTransport({ command: path.join(process.cwd(), name), cwd: process.cwd(), env: {} }), /explicit .exe or .com/);
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-stdio-executable-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const wrapper = path.join(directory, 'wrapper.exe');
    await writeFile(wrapper, '#!/usr/bin/env node\n');
    assert.throws(() => createMcpStdioTransport({ command: wrapper, cwd: process.cwd(), env: {} }), /without a shebang wrapper/);
    assert.throws(() => createMcpStdioTransport({ command: path.join(directory, 'missing.exe'), cwd: process.cwd(), env: {} }), /readable executable/);
    assert.doesNotThrow(() => createMcpStdioTransport({ command: path.join(process.env.SYSTEMROOT, 'System32', 'cmd.exe'), cwd: process.cwd(), env: {} }));
  }
});


test('MCP model names remain valid and distinct across normalized or truncated source IDs', async t => {
  const names = [];
  for (const id of ['server.a', 'server-a', 'samefirstsixteen1long', 'samefirstsixteen1other']) {
    const source = sourceFor(new WireTransport(), { id }); t.after(() => source.close());
    const { tool } = await loaded(source);
    assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
    names.push(tool.name);
  }
  assert.equal(new Set(names).size, names.length);
});


test('MCP cancellation after dispatch and malformed terminal wire responses remain uncertain', async t => {
  const controller = new AbortController();
  const cancelledWire = new WireTransport();
  cancelledWire.call = async () => { controller.abort(new Error('cancelled by host')); };
  const cancelledSource = sourceFor(cancelledWire); t.after(() => cancelledSource.close());
  const cancelled = await call(cancelledSource, { value: 'x' }, { signal: controller.signal });
  assert.equal(cancelled.execution.state, 'unknown');
  assert.equal(cancelledWire.calls, 1);
  const malformedWire = new WireTransport();
  malformedWire.call = async message => malformedWire.onmessage({ jsonrpc: '2.0', id: message.id,
    result: { resultType: 'complete', content: 'invalid content array' } });
  const malformedSource = sourceFor(malformedWire); t.after(() => malformedSource.close());
  const malformed = await call(malformedSource);
  assert.equal(malformed.execution.state, 'unknown');
  assert.equal(malformedWire.calls, 1);
});

test('MCP HTTP raw response limits and redirect refusal apply before accepting any tools', async t => {
  for (const mode of ['redirect', 'oversized']) {
    let requests = 0;
    const transport = createMcpHttpTransport({ endpoint: 'https://mcp.example/tools', limits: { maxMessageBytes: 1000 },
      fetch: async () => {
        requests += 1;
        return mode === 'redirect' ? new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/tools' } })
          : new Response('x'.repeat(1001), { headers: { 'content-type': 'application/json' } });
      }
    });
    const source = sourceFor(transport); t.after(() => source.close());
    await assert.rejects(source.snapshot(), /connection failed/);
    assert.equal(requests, 1);
  }
});


test('MCP schema admission rejects unsafe or malformed schema capabilities', async t => {
  for (const inputSchema of [
    { type: 'object', properties: { value: { type: 'number', minimum: 'not a number' } } },
    { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } },
    { type: 'object', properties: { value: { $ref: 'https://remote.example/schema' } } },
    { type: 'object', properties: { value: { $async: true } } },
    { type: 'object', properties: { value: { unsupportedAssertion: true } } }
  ]) {
    const wire = new WireTransport(); wire.tools = [remote({ inputSchema })];
    const source = sourceFor(wire); t.after(() => source.close());
    await assert.rejects(source.snapshot());
    assert.equal(wire.calls, 0);
  }
});

test('MCP authoritative schemas preserve Unicode, object constants, required defaults, and composition', async t => {
  const cases = [
    [{ type: 'string', maxLength: 1 }, '😀'],
    [{ type: 'object', const: { key: 'value', $ref: 'literal data' } }, { key: 'value', $ref: 'literal data' }],
    [{ enum: [['value']] }, ['value']],
    [{ type: 'array', minItems: 2, maxItems: 2 }, [1, 2]],
    [{ type: 'object', required: ['missing'] }, { missing: 'present' }],
    [{ type: 'object', properties: { key: { type: 'number', default: 1 } }, required: ['key'] }, { key: 2 }],
    [{ type: 'number', anyOf: [{ minimum: 2 }, { maximum: -2 }] }, 3]
  ];
  for (const [schema, value] of cases) {
    const inputSchema = { type: 'object', properties: { value: schema }, required: ['value'] };
    const wire = new WireTransport(); wire.tools = [remote({ inputSchema, outputSchema: schema })];
    wire.response = { content: [], structuredContent: value };
    const source = sourceFor(wire); t.after(() => source.close());
    const { tool } = await loaded(source);
    assert.deepEqual(tool.jsonSchema, inputSchema);
    assert.ok(Object.values(tool.outputJsonSchema.$defs).some(definition => { try { assert.deepEqual(definition, schema); return true; } catch { return false; } }));
    const result = await call(source, { value });
    assert.equal(result.kind, 'result');
    assert.deepEqual(result.output.structuredContent, value);
  }
  const wire = new WireTransport(); wire.tools = [remote({ inputSchema: { type: 'object',
    properties: { value: { type: 'string', minLength: 2 } }, required: ['value'] } })];
  const source = sourceFor(wire); t.after(() => source.close());
  assert.equal((await call(source, { value: '😀' })).output.reason, 'invalid_arguments');
  assert.equal(wire.calls, 0);
  const inherited = new WireTransport(); inherited.tools = [remote({ inputSchema: { type: 'object', required: ['toString'] } })];
  const inheritedSource = sourceFor(inherited); t.after(() => inheritedSource.close());
  assert.equal((await call(inheritedSource)).output.reason, 'invalid_arguments');
  assert.equal(inherited.calls, 0);
});

test('MCP configured credentials never persist through thrown errors, inventory, text, or binary echoes', async t => {
  const token = 'fixture-private-bearer-credential';
  for (const mode of ['throw', 'inventory', 'text', 'binary']) {
    const artifacts = new InMemoryArtifactRepository();
    let stores = 0;
    artifacts.store = async () => { stores += 1; throw new Error('unexpected public store'); };
    artifacts.storeProtected = async () => { stores += 1; throw new Error('unexpected protected store'); };
    const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const message = JSON.parse(init.body);
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
      let result;
      if (message.method === 'server/discover') result = { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} } };
      else if (message.method === 'tools/list') result = { tools: [remote(mode === 'inventory' ? { description: token } : {})], ttlMs: 0, cacheScope: 'private' };
      else if (message.method === 'tools/call') {
        if (mode === 'throw') throw new Error(`Request headers: Authorization: Bearer ${token}`);
        result = mode === 'binary' ? { content: [
          { type: 'image', mimeType: 'image/png', data: btoa('harmless earlier block') },
          { type: 'resource', resource: { uri: 'remote:secret', blob: btoa(token) } }
        ] } : { content: [], structuredContent: token };
      } else throw new Error(`unexpected method ${message.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { resultType: 'complete', _meta: serverMeta, ...result } }), { headers: { 'content-type': 'application/json' } });
    });
    const configured = createConfiguredMcpSources({ servers: [{ id: `credential-${mode}`, endpoint: 'https://fixture.example/mcp',
      accountId: 'account', policyRevision: 'policy', bearerTokenEnv: 'TOKEN', tools: { echo: policy.effectEnvelope } }] },
    { environment: { TOKEN: token }, artifacts });
    t.after(() => configured.close());
    const source = configured.sources[0];
    if (mode === 'inventory') {
      await assert.rejects(source.snapshot(), error => !error.message.includes(token) && /credentials/.test(error.message));
    } else {
      const snapshot = await source.snapshot();
      assert.equal(JSON.stringify(snapshot).includes(token), false);
      const result = await call(source);
      assert.equal(JSON.stringify(result).includes(token), false);
      assert.equal(result.output.error, mode === 'throw' ? 'mcp_outcome_unknown' : 'mcp_credential_content');
      if (mode !== 'throw') {
        assert.equal(result.execution.state, 'settled');
        assert.equal(result.output.details.original, 'unavailable_credential_content');
        assert.match(result.output.details.sha256, /^[a-f0-9]{64}$/);
      }
    }
    assert.equal(stores, 0);
    await configured.close();
    fetch.mock.restore();
  }
});

test('MCP source backoff bounds repeated inventory failures without retrying cancelled discovery', async t => {
  const wire = new WireTransport();
  wire.list = () => { throw new Error('server inventory failed'); };
  const source = sourceFor(wire, { limits: { failureBackoffMs: 25 } }); t.after(() => source.close());
  await assert.rejects(source.snapshot(), /inventory request failed/);
  const count = wire.messages.filter(message => message.method === 'tools/list').length;
  await assert.rejects(source.snapshot(), /temporarily unavailable/);
  assert.equal(wire.messages.filter(message => message.method === 'tools/list').length, count);
  await new Promise(resolve => setTimeout(resolve, 30));
  wire.list = undefined;
  assert.equal((await source.snapshot()).tools.length, 1);

  const cancelled = new WireTransport();
  const controller = new AbortController();
  const send = cancelled.send.bind(cancelled);
  cancelled.send = async message => {
    if (message.method === 'tools/list') { controller.abort(new Error('host cancelled discovery')); return; }
    return send(message);
  };
  const cancelSource = sourceFor(cancelled); t.after(() => cancelSource.close());
  await assert.rejects(cancelSource.snapshot(controller.signal), /host cancelled discovery/);
  cancelled.send = send;
  assert.equal((await cancelSource.snapshot()).tools.length, 1);
});

test('MCP programmatic calls require host opt-in and retain canonical authorization and structured results', async t => {
  const invocation = { runId: 'program-run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch',
    callIndex: 0, toolAttempt: 1, caller: { kind: 'provider_programmatic', programId: 'program', providerResponseId: 'response' } };
  const directWire = new WireTransport();
  const direct = sourceFor(directWire); t.after(() => direct.close());
  const excluded = await call(direct, { value: 'x' }, { invocation });
  assert.equal(excluded.output.policyReason, 'invocation_mode');
  assert.equal(directWire.calls, 0);

  const wire = new WireTransport();
  wire.tools = [remote({ outputSchema: { type: 'array', items: { type: 'number' } } })];
  wire.response = { content: [], structuredContent: [1, 2, 3] };
  const source = sourceFor(wire, { tools: { echo: { ...policy, invocationModes: ['direct', 'programmatic'] } } });
  t.after(() => source.close());
  assert.notEqual(source.bindingRevision, direct.bindingRevision);
  const { tool } = await loaded(source);
  assert.deepEqual(tool.invocationModes, ['direct', 'programmatic']);
  const denied = await call(source, { value: 'x' }, { invocation, policy: { allowedRisks: ['read'] } });
  assert.equal(denied.output.reason, 'policy');
  assert.equal(wire.calls, 0);
  const result = await call(source, { value: 'x' }, { invocation });
  assert.equal(result.kind, 'result');
  assert.deepEqual(result.output.structuredContent, [1, 2, 3]);
  assert.equal(wire.calls, 1);

  const config = parseMcpConfiguration({ servers: [{ id: 'program-config', endpoint: 'https://example.test/mcp',
    accountId: 'account', policyRevision: 'policy', tools: { echo: { ...policy.effectEnvelope, invocationModes: ['programmatic', 'direct'] } } }] });
  assert.deepEqual(config.servers[0].tools.echo.invocationModes, ['direct', 'programmatic']);
  assert.throws(() => parseMcpConfiguration({ servers: [{ ...config.servers[0],
    tools: { echo: { ...policy.effectEnvelope, invocationModes: ['programmatic', 'programmatic'] } } }] }), /unique/);
});

test('MCP configured application risk ceilings hide mutations and bind exact source authority', async t => {
  const effects = mode => ({ accesses: [{ mode, scope: 'account/data' }], lockScopes: [] });
  const config = { servers: [{ id: 'risk-filter', endpoint: 'https://risk.example/mcp', accountId: 'account', policyRevision: 'policy',
    tools: { reader: effects('read'), writer: effects('write'), remover: effects('delete') } }] };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const message = JSON.parse(init.body);
    const result = message.method === 'server/discover'
      ? { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} } }
      : message.method === 'tools/list' ? { ttlMs: 0, cacheScope: 'private', tools: ['reader', 'writer', 'remover']
        .map(name => remote({ name, annotations: { readOnlyHint: true } })) }
      : (calls++, { content: [], structuredContent: true });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { resultType: 'complete', _meta: serverMeta, ...result } }), { headers: { 'content-type': 'application/json' } });
  });
  const read = createConfiguredMcpSources(config, { allowedRisks: ['read', 'network'] });
  const edit = createConfiguredMcpSources(config, { allowedRisks: ['write', 'network', 'read'] });
  const all = createConfiguredMcpSources(config);
  const offline = createConfiguredMcpSources(config, { allowedRisks: ['read'] });
  for (const configured of [read, edit, all, offline]) t.after(() => configured.close());
  const readSnapshot = await read.sources[0].snapshot();
  assert.deepEqual(readSnapshot.tools.map(tool => tool.reference.toolId), ['reader']);
  assert.deepEqual((await edit.sources[0].snapshot()).tools.map(tool => tool.reference.toolId), ['reader', 'writer']);
  assert.equal(offline.sources.length, 0);
  assert.equal(createConfiguredMcpSources({ servers: [{ ...config.servers[0], bearerTokenEnv: 'MISSING_TOKEN',
    tools: { writer: effects('write') } }] }, { allowedRisks: ['read', 'network'], environment: {} }).sources.length, 0);
  assert.notEqual(read.sources[0].bindingRevision, edit.sources[0].bindingRevision);
  await assert.rejects(edit.sources[0].load(readSnapshot.tools[0].reference), /stale/);
  const allSnapshot = await all.sources[0].snapshot();
  assert.equal(allSnapshot.tools.length, 3);
  const writer = await all.sources[0].load(allSnapshot.tools.find(tool => tool.reference.toolId === 'writer').reference);
  const denied = await invokeToolCall({ name: writer.name, input: { kind: 'json', value: { value: 'x' } } }, [writer],
    { policy: { allowedRisks: ['read', 'network'] } });
  assert.equal(denied.output.reason, 'policy');
  assert.equal(calls, 0);
});

test('MCP declared-schema validation has an independent work bound before expensive assertions', async t => {
  const schema = { type: 'array', uniqueItems: true, items: { type: 'object' } };
  const wire = new WireTransport(); wire.tools = [remote({ inputSchema: { type: 'object', properties: { value: schema } }, outputSchema: schema })];
  const source = sourceFor(wire); t.after(() => source.close());
  const large = Array.from({ length: 1025 }, (_, value) => ({ value }));
  assert.equal((await call(source, { value: large })).output.reason, 'invalid_arguments');
  assert.equal(wire.calls, 0);
  wire.response = { content: [], structuredContent: large };
  const result = await call(source, { value: [] });
  assert.equal(result.kind, 'failure');
  assert.equal(result.output.error, 'mcp_invalid_result');
  assert.equal(result.execution.state, 'settled');
});

test('MCP transport factories recover metadata after backoff and revoke old connection references', async t => {
  const failed = new WireTransport(); failed.legacy = true;
  const connected = new WireTransport();
  const reconnected = new WireTransport();
  const transports = [failed, connected, reconnected];
  let constructions = 0;
  const source = sourceFor(undefined, { createTransport: () => { constructions += 1; return transports.shift(); },
    limits: { failureBackoffMs: 10, requestTimeoutMs: 500 } });
  t.after(() => source.close());
  await assert.rejects(source.snapshot(), /connection failed/);
  await assert.rejects(source.snapshot(), /temporarily unavailable/);
  assert.equal(constructions, 1);
  await new Promise(resolve => setTimeout(resolve, 15));
  const { snapshot, tool } = await loaded(source);
  assert.equal(constructions, 2);
  await connected.close();
  await assert.rejects(source.snapshot(), /temporarily unavailable/);
  await new Promise(resolve => setTimeout(resolve, 15));
  const fresh = await source.snapshot();
  assert.equal(constructions, 3);
  assert.notEqual(fresh.bindingRevision, snapshot.bindingRevision);
  await assert.rejects(source.load(snapshot.tools[0].reference), /stale/);
  const stale = await invokeToolCall({ name: tool.name, input: { kind: 'json', value: { value: 'x' } } }, [tool],
    { policy: { allowedRisks: ['read', 'network'] } });
  assert.equal(stale.execution.state, 'not_started');
  assert.equal(stale.output.reason, 'policy');
  assert.equal(connected.calls + reconnected.calls, 0);
  assert.equal((await call(source)).kind, 'result');
  assert.equal(reconnected.calls, 1);
});

test('MCP reconnect bindings cannot collide across recreated source lifetimes', async t => {
  const sources = [];
  const initial = [];
  const reconnected = [];
  for (let lifetime = 0; lifetime < 2; lifetime++) {
    const first = new WireTransport();
    const transports = [first, new WireTransport()];
    const source = sourceFor(undefined, { createTransport: () => transports.shift(),
      limits: { failureBackoffMs: 1, requestTimeoutMs: 500 } });
    sources.push(source);
    t.after(() => source.close());
    initial.push(await source.snapshot());
    await first.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    reconnected.push(await source.snapshot());
  }
  assert.equal(initial[0].bindingRevision, initial[1].bindingRevision, 'unchanged initial host authority restores exactly');
  assert.notEqual(reconnected[0].bindingRevision, reconnected[1].bindingRevision, 'each reconnect has a globally fresh lease identity');
  await assert.rejects(sources[1].load(reconnected[0].tools[0].reference), /stale/);
});
