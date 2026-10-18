import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import { ArtifactIntegrityError, InMemoryArtifactRepository, hashArtifactBytes } from '@agent-core/persistence';
import { createReadArtifactTool, planToolCall, releaseToolCallPlan } from '@agent-core/tools';
import { createWebPolicy, createWebTools } from '@agent-core/tools-web';
import { createBraveSearchAdapter } from '@agent-core/tools-web/node';
import { invokeToolCall, jsonToolCall } from '../../../tests/tool-call-helpers.js';

const context = { policy: { allowedRisks: ['network', 'read'] } };
function fixture(body = '<h1>Title</h1><p>Original &amp; café 😀.</p>', options = {}) {
  const artifacts = options.artifacts ?? new InMemoryArtifactRepository();
  const calls = [];
  const transport = { id: 'fixture-public-https.v1', async get(request) {
    calls.push(request);
    return { status: options.status ?? 200, headers: options.headers ?? { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(body), transferredBytes: Buffer.byteLength(body) };
  } };
  return { artifacts, transport, calls, tools: createWebTools({ policy: { id: 'fixture.v1', ...options.policy }, artifacts, transport, ...(options.search ? { search: options.search } : {}) }) };
}
async function fetch(f, url = 'https://www.example.org/source') { return invokeToolCall(jsonToolCall('fetch_source', { url }), f.tools, context); }

test('optional acquisition tools do not appear without their adapter and require network authority', async () => {
  const f = fixture();
  assert.deepEqual(f.tools.map(tool => tool.name), ['fetch_source']);
  assert.deepEqual(f.tools[0].invocationModes, ['direct', 'programmatic']);
  const denied = await invokeToolCall(jsonToolCall('fetch_source', { url: 'https://www.example.org/source' }), f.tools, { policy: { allowedRisks: ['read'] } });
  assert.equal(denied.kind, 'failure');
  assert.equal(f.calls.length, 0);
  for (const url of ['http://www.example.org', 'file:///etc/passwd', 'https://user:pass@www.example.org', 'https://www.example.org:8443']) {
    assert.equal((await fetch(f, url)).kind, 'failure');
  }
  assert.equal(f.calls.length, 0);
});

test('capture retains exact original bytes and a distinctly identified derived representation', async () => {
  const f = fixture();
  const result = await fetch(f);
  assert.equal(result.kind, 'result');
  assert.equal(result.output.status, 'available');
  const { source, capture, excerpt } = result.output;
  assert.notEqual(source.original.artifactId, source.extraction.artifact.artifactId);
  assert.equal(Buffer.from(await f.artifacts.readVerified(source.original)).toString(), '<h1>Title</h1><p>Original &amp; café 😀.</p>');
  assert.match(excerpt.text, /Original & café 😀/);
  assert.doesNotMatch(excerpt.text, /<h1>|&amp;/);
  assert.equal(source.bodyEncoding, 'http-content-decoded');
  assert.deepEqual(JSON.parse(Buffer.from(await f.artifacts.readVerified(capture)).toString()), source);
  assert.equal(result.observedFacts.items[1].resources[0].sha256, hashArtifactBytes(Buffer.from(excerpt.text)));
  assert.deepEqual(result.observedFacts.items[1].resources[0].range, { kind: 'byte', start: 0, end: Buffer.byteLength(excerpt.text) });
  const reread = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: excerpt.artifact.artifactId }), [createReadArtifactTool({ maxReadBytes: 10000 })],
    { policy: { allowedRisks: ['read'] }, services: { artifactRepository: f.artifacts } });
  assert.equal(reread.output.text, excerpt.text);
});

test('capture identity preserves source URL even when identical response artifacts deduplicate', async () => {
  const f = fixture();
  const a = (await fetch(f, 'https://www.example.org/a')).output;
  const b = (await fetch(f, 'https://www.example.org/b')).output;
  assert.equal(a.source.original.artifactId, b.source.original.artifactId);
  assert.notEqual(a.capture.artifactId, b.capture.artifactId);
});

test('exact excerpt bytes and extraction limits never imply complete source presentation', async () => {
  const f = fixture('<p>😀😀😀😀😀😀😀</p>', { policy: { limits: { maxExtractionBytes: 15, maxExcerptBytes: 5 } } });
  const result = await fetch(f);
  assert.equal(result.output.status, 'available');
  assert.equal(result.output.source.extraction.coverage, 'partial');
  assert.deepEqual(result.output.source.extraction.causes, ['output_limit']);
  assert.equal(result.scope.coverage, 'partial');
  assert.equal(Buffer.byteLength(result.output.excerpt.text), result.output.excerpt.range.end);
  assert.doesNotMatch(result.output.excerpt.text, /�/);
  assert.ok(result.output.excerpt.nextOffset <= 5);
  assert.equal(result.observedFacts.items[0].scope.coverage, 'complete', 'complete capture is distinct from partial derived presentation');
});

test('HTML parser node bounds, hidden elements, and chunked Unicode remain explicit', async () => {
  const bounded = await fetch(fixture('<p>one</p><p>two</p>', { policy: { limits: { maxParserNodes: 2 } } }));
  assert.equal(bounded.output.source.extraction.coverage, 'partial');
  assert.deepEqual(bounded.output.source.extraction.causes, ['parser_limit']);
  const hidden = await fetch(fixture('<script>secret()</script><style>.x{}</style><p>visible</p>'));
  assert.doesNotMatch(hidden.output.excerpt.text, /secret|\.x/);
  assert.match(hidden.output.excerpt.text, /visible/);
  const body = '<p>' + 'a'.repeat(16380) + '😀' + '</p>';
  const unicode = await fetch(fixture(body, { policy: { limits: { maxExcerptBytes: 32768 } } }));
  assert.match(unicode.output.excerpt.text, /😀/);
  assert.doesNotMatch(unicode.output.excerpt.text, /�/);
});

test('unsupported media or charset retains original capture without invented text', async () => {
  for (const type of ['application/pdf', 'text/plain; charset=iso-8859-1']) {
    const result = await fetch(fixture('bytes', { headers: { 'content-type': type } }));
    assert.equal(result.output.status, 'available');
    assert.equal(result.output.source.extraction.status, 'unavailable');
    assert.equal(result.output.excerpt, undefined);
    assert.equal(result.scope.coverage, 'partial');
  }
});

test('declared ASCII rejects non-ASCII entity bytes and preserves the exact original', async () => {
  for (const [type, body] of [
    ['text/plain; charset=us-ascii', Buffer.from('café')],
    ['text/html; charset="US-ASCII"', Buffer.from('<p>😀</p>')],
    ['text/plain; charset=us-ascii', Buffer.from([0xff])],
    ['text/plain; charset=us-ascii', Buffer.from([0xef, 0xbb, 0xbf, 0x61])],
    ['text/plain; charset=utf-8', Buffer.from([0xff])]
  ]) {
    const f = fixture(body, { headers: { 'content-type': type } });
    const result = await fetch(f);
    assert.equal(result.output.status, 'available');
    assert.deepEqual(result.output.source.extraction, { status: 'unavailable', reason: 'invalid_text' });
    assert.equal(result.output.excerpt, undefined);
    assert.deepEqual(Buffer.from(await f.artifacts.readVerified(result.output.source.original)), body);
  }
  const ascii = await fetch(fixture('plain ASCII', { headers: { 'content-type': 'text/plain; charset=us-ascii' } }));
  assert.equal(ascii.output.excerpt.text, 'plain ASCII');
  const entity = await fetch(fixture('<p>caf&#233;</p>', { headers: { 'content-type': 'text/html; charset=us-ascii' } }));
  assert.match(entity.output.excerpt.text, /café/);
});

test('Content-Type charset parsing rejects malformed or repeated declarations without guessing', async () => {
  for (const type of [
    'text/plain; charset=', 'text/plain; charset="utf-8',
    'text/plain; charset=utf-8; charset=utf-8', 'text/plain; charset=utf-8; charset=us-ascii',
    'text/plain; charset=""', 'text/plain; broken'
  ]) {
    const f = fixture('original', { headers: { 'content-type': type } });
    const result = await fetch(f);
    assert.deepEqual(result.output.source.extraction, { status: 'unavailable', reason: 'unsupported_charset' }, type);
    assert.equal(result.output.excerpt, undefined);
    assert.equal(Buffer.from(await f.artifacts.readVerified(result.output.source.original)).toString(), 'original');
  }
  for (const type of ['text/plain', 'text/plain; charset="UTF8"; title="quoted; value"', 'text/plain; title="charset=us-ascii"']) {
    const result = await fetch(fixture('café 😀', { headers: { 'content-type': type } }));
    assert.equal(result.output.excerpt.text, 'café 😀', type);
  }
});

test('HTML charset declarations honor HTTP precedence and only actual metadata when absent', async () => {
  const conflicting = '<meta charset="iso-8859-1"><p>café 😀</p>';
  const explicit = await fetch(fixture(conflicting));
  assert.match(explicit.output.excerpt.text, /café 😀/);
  for (const body of [
    '<meta charset="iso-8859-1"><p>original</p>',
    '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>original</p>',
    '<meta charset="utf-8"><meta charset="us-ascii"><p>original</p>',
    '<meta charset="utf-8" charset="iso-8859-1"><p>original</p>',
    '<meta charset=""><p>original</p>'
  ]) {
    const f = fixture(body, { headers: { 'content-type': 'text/html' } });
    const result = await fetch(f);
    assert.deepEqual(result.output.source.extraction, { status: 'unavailable', reason: 'unsupported_charset' }, body);
    assert.equal(result.output.excerpt, undefined);
    assert.equal(Buffer.from(await f.artifacts.readVerified(result.output.source.original)).toString(), body);
  }
  for (const metadata of [
    '<!-- <meta charset="iso-8859-1"> -->',
    '<script>const text = \'<meta charset="iso-8859-1">\';</script>',
    '<meta data-charset="iso-8859-1">',
    '<meta name="description" content="charset=iso-8859-1">',
    '<template><meta charset="iso-8859-1"></template>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">'
  ]) {
    const result = await fetch(fixture(metadata + '<p>café 😀</p>', { headers: { 'content-type': 'text/html' } }));
    assert.match(result.output.excerpt.text, /café 😀/, metadata);
  }
  const metaAscii = await fetch(fixture('<meta charset="us-ascii"><p>café</p>', { headers: { 'content-type': 'text/html' } }));
  assert.deepEqual(metaAscii.output.source.extraction, { status: 'unavailable', reason: 'invalid_text' });
  const metaAsciiEntity = await fetch(fixture('<meta charset="us-ascii"><p>caf&#233;</p>', { headers: { 'content-type': 'text/html' } }));
  assert.match(metaAsciiEntity.output.excerpt.text, /café/);
});

test('redirects and HTTP errors are typed unavailable page reads and never automatically followed', async () => {
  const f = fixture('', { status: 302, headers: { location: 'https://other.example.org/next' } });
  const redirect = await fetch(f);
  assert.equal(redirect.output.status, 'redirect');
  assert.equal(redirect.output.location, 'https://other.example.org/next');
  assert.equal(f.calls.length, 1);
  assert.equal(redirect.observedFacts.items[0].outcome, 'failure');
  assert.equal(redirect.observedFacts.items[0].scope.coverage, 'absent');
  const error = await fetch(fixture('', { status: 404 }));
  assert.equal(error.output.reason, 'http_error');
  assert.equal(error.output.httpStatus, 404);
});

test('transport response and origin policy violations cannot become successful captures', async () => {
  const limited = fixture('a'.repeat(100), { policy: { limits: { maxResponseBytes: 10 } } });
  assert.equal((await fetch(limited)).output.reason, 'byte_limit');
  const scoped = fixture('', { policy: { allowedOrigins: ['https://allowed.example.org'] } });
  assert.equal((await fetch(scoped)).kind, 'failure');
  assert.equal(scoped.calls.length, 0);
  assert.throws(() => createWebPolicy({ id: 'bad', allowedOrigins: ['https://www.example.org/path'] }), /origins/);
});

test('provider query is bounded, credential-free in authorization, and snippets never claim page inspection', async () => {
  const f = fixture(JSON.stringify({ query: { more_results_available: true }, web: { results: [{ title: 'Title', url: 'https://www.example.org/a', description: 'A provider snippet' }] } }),
    { headers: { 'content-type': 'application/json' } });
  const search = createBraveSearchAdapter({ apiKey: 'very-secret-token', transport: f.transport });
  const tools = createWebTools({ policy: { id: 'brave-only', allowedOrigins: ['https://api.search.brave.com'] }, artifacts: f.artifacts, transport: f.transport, search });
  const call = jsonToolCall('search_web', { query: 'bounded search', count: 4, page: 1 });
  const plan = await planToolCall(call, tools, { ...context, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } });
  assert.equal(plan.ok, true);
  assert.doesNotMatch(JSON.stringify(plan.plan.canonicalSnapshot), /very-secret-token|apiKey/);
  assert.match(JSON.stringify(plan.plan.canonicalSnapshot), /brave\.web-search/);
  await releaseToolCallPlan(plan.plan);
  const result = await invokeToolCall(call, tools, context);
  assert.equal(result.output.status, 'completed');
  assert.equal(result.output.resultsAre, 'provider_snippets_not_page_reads');
  assert.equal(result.output.nextPage, 2);
  assert.equal(result.observedFacts.items[0].action, 'search');
  assert.equal(f.calls[0].headers['x-subscription-token'], 'very-secret-token');
  assert.equal(new URL(f.calls[0].url).searchParams.get('offset'), '1');
  assert.equal(new URL(f.calls[0].url).searchParams.get('count'), '4');
});

test('policy and exact URL change authorization fingerprints without executing network work', async () => {
  const f = fixture();
  const other = createWebTools({ policy: { id: 'fixture.v1', limits: { maxResponseBytes: 100 } }, transport: f.transport, artifacts: f.artifacts });
  const planning = { ...context, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } };
  const results = await Promise.all([[f.tools, '/a'], [f.tools, '/b'], [other, '/a']].map(([tools, path]) => planToolCall(jsonToolCall('fetch_source', { url: `https://www.example.org${path}` }), tools, planning)));
  assert.equal(new Set(results.map(result => result.plan.fingerprint)).size, 3);
  for (const result of results) await releaseToolCallPlan(result.plan);
  assert.equal(f.calls.length, 0);
});

test('plain configuration names credentials without persisting them and missing requested credentials fail honestly', async () => {
  const { parseWebConfiguration, createConfiguredWebTools } = await import('@agent-core/tools-web/node');
  const value = parseWebConfiguration({ policy: { id: 'cli-web' }, search: { provider: 'brave', credentialEnvironmentVariable: 'BRAVE_SEARCH_API_KEY' } });
  assert.doesNotMatch(JSON.stringify(value), /secret-token/);
  assert.throws(() => parseWebConfiguration({ policy: { id: 'cli-web' }, search: { provider: 'brave', apiKey: 'secret-token' } }), /Unrecognized/);
  assert.throws(() => createConfiguredWebTools(value, { artifacts: new InMemoryArtifactRepository(), environment: {} }), /BRAVE_SEARCH_API_KEY.*missing/);
  const tools = createConfiguredWebTools(value, { artifacts: new InMemoryArtifactRepository(), environment: { BRAVE_SEARCH_API_KEY: 'secret-token' } });
  assert.deepEqual(tools.map(tool => tool.name), ['fetch_source', 'search_web']);
  const fetchOnly = createConfiguredWebTools(parseWebConfiguration({ policy: { id: 'cli-web' } }), { artifacts: new InMemoryArtifactRepository(), environment: {} });
  assert.deepEqual(fetchOnly.map(tool => tool.name), ['fetch_source']);
});

test('search distinguishes provider HTTP failure from invalid output, and query bounds precede requests', async () => {
  for (const [body, status, expected] of [['', 429, 'http_error'], ['{"error":"unexpected"}', 200, 'invalid_response']]) {
    const f = fixture(body, { status, headers: { 'content-type': 'application/json' } });
    const tools = createWebTools({ policy: { id: 'search' }, artifacts: f.artifacts, transport: f.transport,
      search: createBraveSearchAdapter({ apiKey: 'token', transport: f.transport }) });
    const result = await invokeToolCall(jsonToolCall('search_web', { query: 'test' }), tools, context);
    assert.equal(result.output.status, 'unavailable');
    assert.equal(result.output.reason, expected);
    if (status === 429) assert.equal(result.output.httpStatus, 429);
    assert.equal(result.observedFacts.items[0].scope.coverage, 'absent');
    const before = f.calls.length;
    for (const query of ['a'.repeat(601), Array(76).fill('a').join(' ')]) {
      const rejected = await invokeToolCall(jsonToolCall('search_web', { query }), tools, context);
      assert.equal(rejected.kind, 'failure');
    }
    assert.equal(f.calls.length, before);
  }
});

test('owned normalized policy composes directly with tool construction and plain configuration parsing', async () => {
  const { parseWebConfiguration } = await import('@agent-core/tools-web/node');
  const f = fixture();
  const policy = createWebPolicy({ id: 'normalized', allowedOrigins: ['https://www.example.org'] });
  assert.deepEqual(createWebPolicy(policy), policy);
  assert.deepEqual(parseWebConfiguration({ policy }).policy, policy);
  assert.equal(createWebTools({ policy, artifacts: f.artifacts, transport: f.transport }).length, 1);
});

test('capture manifests and exact representations remain retrievable after reopening persistent artifacts without refetching', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture('<p>Retained café 😀 source.</p>', { artifacts: new LocalArtifactRepository(directory) });
  const result = (await fetch(f)).output;
  const reopened = new LocalArtifactRepository(directory);
  const capture = await reopened.resolve(result.capture.artifactId);
  assert.deepEqual(capture, result.capture);
  const source = JSON.parse(Buffer.from(await reopened.readVerified(capture)).toString());
  const original = await reopened.resolve(source.original.artifactId);
  const extracted = await reopened.resolve(source.extraction.artifact.artifactId);
  assert.equal(Buffer.from(await reopened.readVerified(original)).toString(), '<p>Retained café 😀 source.</p>');
  assert.match(Buffer.from(await reopened.readVerified(extracted)).toString(), /Retained café 😀 source/);
  await assert.rejects(reopened.readVerified({ ...original, sha256: '0'.repeat(64) }), ArtifactIntegrityError);
  assert.equal(f.calls.length, 1);
});
