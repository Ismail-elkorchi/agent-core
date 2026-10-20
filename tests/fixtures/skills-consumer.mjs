import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@agent-core/tools-local' || specifier === 'node:child_process' || specifier === 'node:worker_threads')
    throw new Error(`Portable skill import initialized a filesystem/execution adapter: ${specifier}`);
  return next(specifier, context);
} });
const { SkillCatalog, InMemorySkillSource, decodeSkillResourceText, skillDiscoveryRequestSchema, skillResourceReadRequestSchema, SKILL_LIMITS } = await import('@agent-core/skills');
hook.deregister();
const { FileSystemSkillSource } = await import('@agent-core/skills/node');
const source = new InMemorySkillSource({ scopeId: 'packed', bindingRevision: 'grant-1', packages: [{
  packageId: 'review', files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review text on request\nallowed-tools: forbidden\n---\nCheck claims against sources.' },
    { path: 'scripts/check.py', content: 'raise Exception("must not execute")' }] }] });
const catalog = new SkillCatalog({ sources: [source] });
const scopes = await catalog.discoverScopes({ limit: 1 });
assert.deepEqual(scopes.items, [{ scopeId: 'packed', bindingRevision: 'grant-1' }]);
const page = await catalog.discover({ scopeId: scopes.items[0].scopeId, limit: 1 });
assert.equal(page.items.length, 1);
assert.equal('instructions' in page.items[0], false);
const ref = page.items[0].reference;
const [loaded] = await catalog.loadSelection([ref], { maxBytes: 8192 });
assert.equal(loaded.instructions, 'Check claims against sources.');
assert.deepEqual(loaded.manifest.metadata.requestedTools, ['forbidden']);
assert.equal('execute' in catalog, false);
assert.match(decodeSkillResourceText(await catalog.readResource(ref, 'scripts/check.py', { offset: 0, length: 128 })), /must not execute/);
await catalog.withAvailable([ref], async () => true);
assert.equal(skillDiscoveryRequestSchema.safeParse({ scopeId: 'packed', limit: SKILL_LIMITS.discoveryItems + 1 }).success, false);
assert.equal(skillResourceReadRequestSchema.safeParse({ ref, path: '../outside', offset: 0, length: 1 }).success, false);
assert.equal(typeof FileSystemSkillSource, 'function');
