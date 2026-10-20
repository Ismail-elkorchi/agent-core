import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { InMemorySkillSource, SkillCatalog, SKILL_LIMITS, parseSkillMarkdown, parseSkillPackage,
  decodeSkillResourceText } from '@agent-core/skills';
import { FileSystemSkillSource } from '@agent-core/skills/node';

const markdown = (name = 'check', instructions = 'Use this when checking text.', extra = '') =>
  `---\nname: ${name}\ndescription: Check text when requested\n${extra}---\n${instructions}`;
const input = (packageId = 'one', body = 'Original instructions', extras = []) => ({ packageId,
  files: [{ path: 'SKILL.md', content: markdown('check', body, 'metadata:\n  version: "1.0"\n  applicability: "text review"\n  outcome: "run:one"\nallowed-tools: Read Bash(rm:*)\n') }, ...extras] });
const source = (packages = [input()], options = {}) => new InMemorySkillSource({ scopeId: 'personal', bindingRevision: 'grant-1', packages, ...options });
async function first(catalog, scopeId = 'personal') { return (await catalog.discover({ scopeId })).items[0].reference; }

test('portable exports do not initialize filesystem, shell, or execution adapters', async () => {
  // A fresh process is covered in packed consumers; root import graph must not reach tools-local.
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@agent-core/tools-local') throw new Error('unexpected filesystem adapter');
    return next(specifier, context);
  } });
  try { assert.equal(typeof (await import('@agent-core/skills')).SkillCatalog, 'function'); }
  finally { hook.deregister(); }
});

test('qualified identities disambiguate names and preserve owned exact revisions and applicability', async () => {
  const mutable = input();
  const personal = source([mutable]);
  const shared = source([input('two')], { scopeId: 'shared' });
  mutable.files[0].content = markdown('check', 'Mutated caller bytes');
  const catalog = new SkillCatalog({ sources: [personal, shared] });
  const a = await first(catalog), b = await first(catalog, 'shared');
  assert.equal((await catalog.load(a)).instructions, 'Original instructions');
  assert.equal(a.scopeId, 'personal'); assert.equal(b.scopeId, 'shared');
  assert.equal((await catalog.loadSelection([a, b])).length, 2);
  const loaded = await catalog.load(a);
  assert.equal(loaded.manifest.metadata.metadata.version, '1.0');
  assert.equal(loaded.manifest.metadata.metadata.applicability, 'text review');
  assert.equal(loaded.manifest.metadata.metadata.outcome, 'run:one');
  assert.ok(Object.isFrozen(loaded.manifest.resources));
  assert.equal('instructions' in (await catalog.discover({ scopeId: 'personal' })).items[0], false);
  await assert.rejects(catalog.loadSelection([a, a]), /duplicate/);
  await assert.rejects(catalog.load({ ...a, bindingRevision: 'old' }), /grant or binding/);
});

test('discovery scan and output bounds are independent and no cross-scope enumeration occurs', async () => {
  const catalog = new SkillCatalog({ sources: [source(Array.from({ length: 100 }, (_, index) => input(`p-${String(index).padStart(3, '0')}`)))] });
  const page = await catalog.discover({ scopeId: 'personal', query: 'absent', maxScanned: 3, limit: 1 });
  assert.equal(page.scanned, 3); assert.equal(page.items.length, 0); assert.equal(page.nextOffset, 3); assert.equal(page.coverage, 'partial');
  assert.equal(page.scannedBytes, 0);
  await assert.rejects(catalog.discover({ scopeId: 'unknown' }), /not granted/);
  await assert.rejects(catalog.discover({ scopeId: 'personal', expectedRevision: '0'.repeat(64) }), /revision changed/);
  await assert.rejects(catalog.discover({ scopeId: 'personal', maxBytes: 1 }), /too small/);
  await assert.rejects(catalog.loadSelection([await first(catalog)], { maxBytes: 1 }), /byte bound/);
});

test('reading is bounded exact bytes, immutable across caller changes, and UTF-8 splits are explicit', async () => {
  const content = new TextEncoder().encode('A😀B');
  const catalog = new SkillCatalog({ sources: [source([input('one', 'Read', [{ path: 'references/example.txt', content }])])] });
  content.fill(0);
  const reference = await first(catalog);
  const full = await catalog.readResource(reference, 'references/example.txt', { offset: 1, length: 4 });
  assert.equal(decodeSkillResourceText(full), '😀');
  full.bytes.fill(0);
  assert.equal(decodeSkillResourceText(await catalog.readResource(reference, 'references/example.txt', { offset: 1, length: 4 })), '😀');
  assert.throws(() => decodeSkillResourceText({ bytes: new Uint8Array([0x80]) }), /UTF-8/);
  await assert.rejects(catalog.readResource(reference, '../outside', { offset: 0, length: 2 }), /relative path/);
  await assert.rejects(catalog.readResource(reference, 'references/example.txt', { offset: 0, length: SKILL_LIMITS.readBytes + 1 }), /byte bound/);
});

test('requested tools never grant execution or interpret tool-pattern permissions', async () => {
  const catalog = new SkillCatalog({ sources: [source()] });
  const skill = await catalog.load(await first(catalog));
  assert.deepEqual(skill.manifest.metadata.requestedTools, ['Read', 'Bash(rm:*)']);
  assert.equal('execute' in catalog, false);
});

test('strict YAML, immutable manifests, invalid paths and package size fail closed', async () => {
  for (const malformed of ['no frontmatter', '---\nname: check\ndescription: yes\nname: duplicate\n---\n',
    '---\nname: check\ndescription: !evil hi\n---\n', '---\nname: check\ndescription: &a test\nlicense: *a\n---\n',
    '---\nname: check\ndescription: test\nmetadata:\n  version: 1\n---\n'])
    assert.throws(() => parseSkillMarkdown(malformed));
  const parsed = parseSkillMarkdown('---\nname: check\ndescription: >-\n  Check text\n  carefully\n---\nBody');
  assert.equal(parsed.metadata.description, 'Check text carefully');
  for (const bad of ['../bad', '/bad', 'C:/bad', 'x\\bad', 'x//bad', './bad'])
    assert.throws(() => source([input('one', 'Body', [{ path: bad, content: 'x' }])]), /relative path/);
  assert.throws(() => source([input('one', 'Body', [{ path: 'asset', content: new Uint8Array(SKILL_LIMITS.fileBytes + 1) }])]), /byte bound/);
  const catalog = new SkillCatalog({ sources: [source()] });
  const value = await catalog.load(await first(catalog));
  assert.throws(() => parseSkillPackage({ ...value, instructions: 'injected instructions' }), /digest/);
  assert.throws(() => parseSkillPackage({ ...value, manifest: { ...value.manifest, totalBytes: 0 } }), /inventory/);
});

test('read revocation checks cached content and guarded dispatch rejects a check-only host', async () => {
  let revoked = false, checks = 0;
  const access = async () => { checks++; if (revoked) throw new Error('revoked'); };
  const catalog = new SkillCatalog({ sources: [source([input()], { access })] });
  const ref = await first(catalog); await catalog.load(ref);
  await assert.rejects(catalog.withAvailable([ref], async () => 'not dispatched'), /revocation fence/);
  revoked = true;
  await assert.rejects(catalog.discover({ scopeId: 'personal' }), /revoked/);
  await assert.rejects(catalog.load(ref), /revoked/);
  await assert.rejects(catalog.readResource(ref, 'SKILL.md', { offset: 0, length: 5 }), /revoked/);
  await assert.rejects(catalog.assertAvailable([ref]), /revoked/);
  assert.ok(checks > 5);
});

test('host dispatch fence holds for native old+new dependencies without publishing a new selection', async () => {
  let inside = false;
  const versions = source([input('one', 'old'), input('one', 'new')], { access: async () => {},
    withAccess: async (_request, operation) => { assert.equal(inside, false); inside = true; try { return await operation(); } finally { inside = false; } } });
  const oldCatalog = new SkillCatalog({ sources: [source([input('one', 'old')])] });
  const catalog = new SkillCatalog({ sources: [versions] });
  const old = await first(oldCatalog), current = await first(catalog);
  assert.notEqual(old.revision, current.revision);
  await catalog.assertAvailable([old, current, old]);
  await catalog.withAvailable([old, current], async () => { assert.equal(inside, true); });
  assert.equal((await catalog.load(old)).instructions, 'old');
  await assert.rejects(catalog.loadSelection([old, current]), /duplicate/);
});

test('cancellation escapes an uncooperative source without starting dispatch', async () => {
  const original = source();
  const blocked = { scopeId: original.scopeId, discover: async () => new Promise(() => {}) };
  const catalog = new SkillCatalog({ sources: [blocked] });
  const controller = new AbortController();
  const pending = catalog.discover({ scopeId: 'personal' }, controller.signal);
  controller.abort(new Error('stop skills'));
  await assert.rejects(pending, /stop skills/);
});

const linux = { skip: process.platform !== 'linux' };
async function filesystemFixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'agent-skills-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'check'); await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'SKILL.md'), markdown());
  await writeFile(path.join(root, 'scripts', 'side-effect.sh'), `echo forbidden > '${base}/executed'`);
  const options = { scopeId: 'personal', bindingRevision: 'grant-1', roots: [{ packageId: 'one', path: root }] };
  const src = new FileSystemSkillSource(options); t.after(() => src.close());
  return { base, root, options, src, catalog: new SkillCatalog({ sources: [src] }) };
}

test('filesystem package mutation rejects first activation, then immutable old selection stays exact', linux, async t => {
  const f = await filesystemFixture(t);
  const before = await first(f.catalog);
  await writeFile(path.join(f.root, 'scripts', 'side-effect.sh'), 'changed');
  await assert.rejects(f.catalog.loadSelection([before]), /changed|unavailable/);
  const current = await first(f.catalog);
  assert.notEqual(before.revision, current.revision);
  await f.catalog.load(current);
  await writeFile(path.join(f.root, 'SKILL.md'), markdown('check', 'new instructions'));
  assert.equal((await f.catalog.load(current)).instructions, 'Use this when checking text.');
  assert.equal(decodeSkillResourceText(await f.catalog.readResource(current, 'scripts/side-effect.sh', { offset: 0, length: 99 })), 'changed');
  await assert.rejects(readFile(path.join(f.base, 'executed')), { code: 'ENOENT' });
  const restart = new FileSystemSkillSource(f.options); t.after(() => restart.close());
  await assert.rejects(restart.load(current), /changed|unavailable/);
});

test('filesystem confines all resource components and rejects symlink, hard-link and oversize packages', linux, async t => {
  const f = await filesystemFixture(t);
  await writeFile(path.join(f.base, 'outside'), 'private');
  await symlink(path.join(f.base, 'outside'), path.join(f.root, 'escape'));
  let page = await f.catalog.discover({ scopeId: 'personal' });
  assert.equal(page.items.length, 0); assert.equal(page.diagnostics[0].code, 'unsafe_path');
  await rm(path.join(f.root, 'escape'));
  await link(path.join(f.base, 'outside'), path.join(f.root, 'hard-link'));
  page = await f.catalog.discover({ scopeId: 'personal' });
  assert.equal(page.items.length, 0); assert.equal(page.diagnostics[0].code, 'unsafe_path');
  await rm(path.join(f.root, 'hard-link'));
  await writeFile(path.join(f.root, 'oversize'), new Uint8Array(SKILL_LIMITS.fileBytes + 1));
  page = await f.catalog.discover({ scopeId: 'personal' });
  assert.equal(page.items.length, 0); assert.equal(page.diagnostics[0].code, 'resource_limit');
  assert.equal(page.coverage, 'partial');
});


test('unsupported filesystem platforms fail explicitly while in-memory sources remain usable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'unsupported-os' });
    assert.throws(() => new FileSystemSkillSource({ scopeId: 'test', bindingRevision: 'grant', roots: [] }), error => error.code === 'unsupported_source' && /Linux handle-relative/.test(error.message));
    assert.doesNotThrow(() => source());
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('advertised schemas and complete-result byte limits match implementation bounds', async () => {
  const { skillDiscoveryRequestSchema, skillResourceReadRequestSchema, skillSelectionReferencesSchema,
    skillLoadRequestSchema } = await import('@agent-core/skills');
  const z = await import('zod');
  for (const schema of [skillDiscoveryRequestSchema, skillResourceReadRequestSchema, skillSelectionReferencesSchema, skillLoadRequestSchema])
    assert.equal(typeof z.toJSONSchema(schema), 'object');
  assert.equal(skillDiscoveryRequestSchema.safeParse({ scopeId: 'personal', limit: SKILL_LIMITS.discoveryItems + 1 }).success, false);
  const catalog = new SkillCatalog({ sources: [source(Array.from({ length: 20 }, (_, i) => input(`p${i}`)))] });
  const page = await catalog.discover({ scopeId: 'personal', maxBytes: 1500 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1500);
  const ref = page.items[0].reference;
  const full = await catalog.loadSelection([ref]);
  const completeBytes = Buffer.byteLength(JSON.stringify(full));
  await assert.rejects(catalog.loadSelection([ref], { maxBytes: completeBytes - 1 }), /byte bound/);
  assert.equal((await catalog.loadSelection([ref], { maxBytes: completeBytes })).length, 1);
});

test('filesystem close is fenced against already-entered dispatch and denies later reads', linux, async t => {
  const f = await filesystemFixture(t);
  const ref = await first(f.catalog);
  let entered, release;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const dispatch = f.catalog.withAvailable([ref], async () => { entered(); await gate; return 'dispatched'; });
  await inside;
  let closed = false;
  const firstClose = f.src.close();
  assert.equal(f.src.close(), firstClose);
  const closing = firstClose.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  await assert.rejects(f.catalog.load(ref), /closed/);
  release();
  assert.equal(await dispatch, 'dispatched');
  await closing;
  assert.equal(closed, true);
  await assert.rejects(f.catalog.withAvailable([ref], async () => assert.fail('must not dispatch')), /closed/);
});

test('cold skill discovery exposes bounded granted scopes without reading package bodies', async () => {
  const personal = source([input('private-method')], { scopeId: 'personal' });
  const shared = source([input('team-method')], { scopeId: 'shared' });
  let bodyReads = 0;
  const discover = personal.discover.bind(personal);
  personal.discover = (...args) => { bodyReads++; return discover(...args); };
  const catalog = new SkillCatalog({ sources: [shared, personal] });
  const scopes = await catalog.discoverScopes({ limit: 1, maxBytes: 512 });
  assert.deepEqual(scopes.items, [{ scopeId: 'personal', bindingRevision: 'grant-1' }]);
  assert.equal(scopes.nextOffset, 1); assert.equal(scopes.coverage, 'partial');
  assert.ok(Buffer.byteLength(JSON.stringify(scopes)) <= 512);
  assert.equal(bodyReads, 0);
  const packages = await catalog.discover({ scopeId: scopes.items[0].scopeId });
  assert.equal(bodyReads, 1);
  assert.equal((await catalog.load(packages.items[0].reference)).instructions, 'Original instructions');
  const next = await catalog.discoverScopes({ offset: scopes.nextOffset, expectedRevision: scopes.revision });
  assert.deepEqual(next.items.map(item => item.scopeId), ['shared']);
});

test('denied scope IDs, counts, positions, revisions and diagnostics never enter cold discovery', async () => {
  const { SkillPackageError } = await import('@agent-core/skills');
  const allowed = source([], { scopeId: 'allowed' });
  const forbidden = source([], { scopeId: 'private-medical-secret', access: async () => {
    throw new SkillPackageError('access_denied', 'Denied private-medical-secret inventory of 2500 packages');
  } });
  const catalog = new SkillCatalog({ sources: [forbidden, allowed] });
  assert.deepEqual(await catalog.discoverScopes(), await new SkillCatalog({ sources: [allowed] }).discoverScopes());
  assert.deepEqual(await new SkillCatalog({ sources: [forbidden] }).discoverScopes(), await new SkillCatalog({ sources: [] }).discoverScopes());
  let revoked = false;
  const revocable = source([], { scopeId: 'revocable', access: async () => {
    if (revoked) throw new SkillPackageError('access_denied', 'private revocation reason');
  } });
  const changing = new SkillCatalog({ sources: [revocable, forbidden] });
  const old = await changing.discoverScopes();
  revoked = true;
  await assert.rejects(changing.discoverScopes({ expectedRevision: old.revision }), /inventory changed/);
  const current = await changing.discoverScopes();
  assert.deepEqual(current, await new SkillCatalog({ sources: [] }).discoverScopes());
});

test('scope inspection failures report partial coverage without exposing failed identifiers or errors', async () => {
  const failed = source([], { scopeId: 'secret-offline-tenant', access: async () => {
    throw new Error('Secret account secret-offline-tenant timeout with token=not-for-output');
  } });
  const allowed = source([], { scopeId: 'allowed' });
  const page = await new SkillCatalog({ sources: [failed, allowed] }).discoverScopes();
  assert.deepEqual(page.items.map(item => item.scopeId), ['allowed']);
  assert.equal(page.coverage, 'partial');
  assert.equal('nextOffset' in page, false);
  assert.equal(/secret|timeout|token|scanned|totalCount/.test(JSON.stringify(page)), false);
  const unavailable = await new SkillCatalog({ sources: [failed] }).discoverScopes();
  assert.deepEqual(unavailable.items, []); assert.equal(unavailable.coverage, 'partial');
});

test('scope discovery cancellation and source-work ceilings do not depend on visible output size', async () => {
  const { skillScopeDiscoveryRequestSchema } = await import('@agent-core/skills');
  const z = await import('zod');
  assert.equal(typeof z.toJSONSchema(skillScopeDiscoveryRequestSchema), 'object');
  const sources = Array.from({ length: SKILL_LIMITS.sources }, (_, index) => source([], { scopeId: `scope-${index}` }));
  let reads = 0;
  for (const item of sources) { const original = item.describeScope.bind(item); item.describeScope = async (...args) => { reads++; return original(...args); }; }
  const catalog = new SkillCatalog({ sources });
  const page = await catalog.discoverScopes({ limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(reads, SKILL_LIMITS.sources * 2);
  sources[0].describeScope = async () => new Promise(() => {});
  const controller = new AbortController();
  const pending = catalog.discoverScopes({}, controller.signal);
  controller.abort(new Error('cancel scope discovery'));
  await assert.rejects(pending, /cancel scope discovery/);
  assert.equal(skillScopeDiscoveryRequestSchema.safeParse({ limit: SKILL_LIMITS.sources + 1 }).success, false);
});

test('filesystem scope discovery does not touch missing package roots', linux, async () => {
  const missing = new FileSystemSkillSource({ scopeId: 'configured-files', bindingRevision: 'grant-1', roots: [
    { packageId: 'unread', path: '/path-that-does-not-exist-for-agent-skill-test/check' }
  ] });
  try {
    assert.deepEqual((await new SkillCatalog({ sources: [missing] }).discoverScopes()).items,
      [{ scopeId: 'configured-files', bindingRevision: 'grant-1' }]);
  } finally { await missing.close(); }
});

test('scope revoked during enumeration is removed before the metadata page is returned', async () => {
  const { SkillPackageError } = await import('@agent-core/skills');
  let revoked = false;
  const firstSource = source([], { scopeId: 'now-private', access: async () => {
    if (revoked) throw new SkillPackageError('access_denied', 'no longer granted');
  } });
  const laterSource = source([], { scopeId: 'still-readable', access: async () => { revoked = true; } });
  const page = await new SkillCatalog({ sources: [firstSource, laterSource] }).discoverScopes();
  assert.deepEqual(page.items.map(item => item.scopeId), ['still-readable']);
  assert.equal(JSON.stringify(page).includes('now-private'), false);
});

async function externalResourceFixture() {
  const stored = source([input('one', 'Instructions', [{ path: 'references/data.txt', content: 'abcdef' }])]);
  const state = { transform: value => value, loads: 0, reads: 0, recheck: undefined };
  const external = { scopeId: stored.scopeId,
    describeScope: stored.describeScope.bind(stored), discover: stored.discover.bind(stored),
    load: async (...args) => { state.loads++; return stored.load(...args); },
    readResource: async (...args) => { state.reads++; return state.transform(structuredClone(await stored.readResource(...args))); },
    assertAvailable: async (...args) => { await state.recheck?.(); return stored.assertAvailable(...args); },
    withAvailable: stored.withAvailable.bind(stored)
  };
  const catalog = new SkillCatalog({ sources: [external] });
  return { catalog, state, ref: await first(catalog), path: 'references/data.txt' };
}

test('external resource responses must match exact reference, manifest and bounded range', async () => {
  const f = await externalResourceFixture();
  const corruptions = [
    value => ({ ...value, reference: { ...value.reference, scopeId: 'other' } }),
    value => ({ ...value, reference: { ...value.reference, packageId: 'other' } }),
    value => ({ ...value, reference: { ...value.reference, revision: '0'.repeat(64) } }),
    value => ({ ...value, reference: { ...value.reference, bindingRevision: 'other' } }),
    value => ({ ...value, resource: { ...value.resource, path: 'other.txt' } }),
    value => ({ ...value, resource: { ...value.resource, sha256: '0'.repeat(64) } }),
    value => ({ ...value, resource: { ...value.resource, size: 999 } }),
    value => ({ ...value, resource: { ...value.resource, injected: 'not manifest data' } }),
    value => ({ ...value, offset: 0 }),
    value => ({ ...value, end: 5 }),
    value => ({ ...value, bytes: new Uint8Array(SKILL_LIMITS.readBytes + 1) }),
    value => ({ ...value, bytes: new Uint8Array(2) }),
    value => ({ ...value, bytes: [1, 2, 3] }),
    value => ({ ...value, instruction: 'extra source output must not enter context' })
  ];
  for (const corrupt of corruptions) {
    f.state.transform = corrupt;
    await assert.rejects(f.catalog.readResource(f.ref, f.path, { offset: 1, length: 3 }));
  }
  f.state.transform = value => value;
  assert.equal(decodeSkillResourceText(await f.catalog.readResource(f.ref, f.path, { offset: 1, length: 3 })), 'bcd');
});

test('direct catalog resource inputs validate before any source load or read', async () => {
  const f = await externalResourceFixture();
  for (const request of [
    { path: '../outside', range: { offset: 0, length: 1 } },
    { path: f.path, range: { offset: -1, length: 1 } },
    { path: f.path, range: { offset: 0, length: 0 } },
    { path: f.path, range: { offset: 0, length: SKILL_LIMITS.readBytes + 1 } },
    { path: f.path, range: { offset: 0, length: 1, ref: { ...f.ref, scopeId: 'other' } } }
  ]) await assert.rejects(f.catalog.readResource(f.ref, request.path, request.range));
  await assert.rejects(f.catalog.readResource({ ...f.ref, revision: 'invalid' }, f.path, { offset: 0, length: 1 }));
  assert.equal(f.state.loads, 0); assert.equal(f.state.reads, 0);
  await assert.rejects(f.catalog.readResource(f.ref, 'references/absent.txt', { offset: 0, length: 1 }), /absent/);
  await assert.rejects(f.catalog.readResource(f.ref, f.path, { offset: 7, length: 1 }), /exceeds/);
  assert.equal(f.state.reads, 0);
});

test('external resource bytes and metadata are captured before asynchronous availability recheck', async () => {
  const f = await externalResourceFixture();
  let raw, entered, release;
  const checking = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.state.transform = value => { raw = value; return value; };
  f.state.recheck = async () => { entered(); await gate; };
  const pending = f.catalog.readResource(f.ref, f.path, { offset: 1, length: 3 });
  await checking;
  raw.bytes.fill(120); raw.reference.revision = '0'.repeat(64); raw.resource.path = 'changed'; raw.offset = 9;
  release();
  const result = await pending;
  assert.equal(decodeSkillResourceText(result), 'bcd');
  assert.deepEqual(result.reference, f.ref); assert.equal(result.resource.path, f.path); assert.equal(result.offset, 1);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.reference) && Object.isFrozen(result.resource));
  f.state.recheck = async () => { throw new Error('revoked during read'); };
  await assert.rejects(f.catalog.readResource(f.ref, f.path, { offset: 1, length: 3 }), /revoked during read/);
});

test('resource result capture rejects accessors and shadowed typed-array bounds without invoking them', async () => {
  const f = await externalResourceFixture();
  let getters = 0;
  f.state.transform = value => Object.defineProperty(value, 'bytes', { get() { getters++; return new Uint8Array(3); } });
  await assert.rejects(f.catalog.readResource(f.ref, f.path, { offset: 1, length: 3 }), /accessors/);
  assert.equal(getters, 0);
  f.state.transform = value => {
    Object.defineProperty(value.resource, 'path', { get() { getters++; return f.path; } });
    return value;
  };
  await assert.rejects(f.catalog.readResource(f.ref, f.path, { offset: 1, length: 3 }));
  assert.equal(getters, 0);
  f.state.transform = value => {
    const bytes = new Uint8Array(SKILL_LIMITS.readBytes + 1);
    Object.defineProperty(bytes, 'byteLength', { value: 3 });
    Object.defineProperty(bytes, 'length', { value: 3 });
    return { ...value, bytes };
  };
  await assert.rejects(f.catalog.readResource(f.ref, f.path, { offset: 1, length: 3 }), /byte length/);
});

test('complete external resource reads verify manifest digest and exact EOF reads remain bounded', async () => {
  const f = await externalResourceFixture();
  f.state.transform = value => { value.bytes.fill(120); return value; };
  await assert.rejects(f.catalog.readResource(f.ref, f.path, { offset: 0, length: 128 }), /content digest/);
  f.state.transform = value => value;
  assert.equal(decodeSkillResourceText(await f.catalog.readResource(f.ref, f.path, { offset: 0, length: 128 })), 'abcdef');
  const eof = await f.catalog.readResource(f.ref, f.path, { offset: 6, length: 1 });
  assert.equal(eof.offset, 6); assert.equal(eof.end, 6); assert.equal(eof.bytes.length, 0);
});
