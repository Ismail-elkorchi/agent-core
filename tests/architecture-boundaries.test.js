import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { hashJson, InMemoryEventRepository } from '@agent-core/persistence';

const root = path.resolve(import.meta.dirname, '..');
const production = readdirSync(path.join(root, 'packages'), { recursive: true, withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.parentPath.includes(`${path.sep}test${path.sep}`) &&
      !entry.parentPath.includes(`${path.sep}dist${path.sep}`)
  )
  .map((entry) => path.join(entry.parentPath, entry.name));

// Source strings evaluated in another realm do not carry host ownership proofs.
// Inspect executable TypeScript, including template substitutions, rather than
// treating embedded guest-language source or documentation as host operations.
function hasHostIdentifier(source, name) {
  const parsed = ts.createSourceFile('boundary.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node) {
    return (ts.isIdentifier(node) && node.text === name) || (ts.forEachChild(node, visit) ?? false);
  }
  return visit(parsed);
}

test('ownership rules inspect host operations rather than guest source strings', () => {
  const guest = 'const guest = String.raw`function deepFreeze(value) { return Object.freeze(value); }`;';
  assert.equal(hasHostIdentifier(guest, 'deepFreeze'), false);
  assert.equal(hasHostIdentifier(`${guest}\nfunction deepFreeze(value) { return Object.freeze(value); }`, 'deepFreeze'), true);
  assert.equal(hasHostIdentifier('const guest = `prefix ${deepFreeze(value)}`;', 'deepFreeze'), true);
});

test('production boundaries do not rebuild established ownership proofs', () => {
  const violations = [];
  for (const file of production) {
    const source = readFileSync(file, 'utf8');
    if (/\bdeepFreeze\b/u.test(source) && hasHostIdentifier(source, 'deepFreeze')) violations.push(`${file}: generic deepFreeze`);
    if (/\bas unknown as\b/u.test(source)) violations.push(`${file}: as unknown as`);
    if (/\b(?:hashRecord|stableStringify|validateToolDefinition)\b/u.test(source)) violations.push(`${file}: retired boundary abstraction`);
    for (const discarded of source.matchAll(/^\s*(?:parse|decode|normalize|sanitize|own|snapshot|clone)[A-Z][A-Za-z0-9_]*\([^;\n]*\);\s*$/gmu)) {
      if (!discarded[0].includes(').')) violations.push(`${file}: discarded owning decoder result: ${discarded[0].trim()}`);
    }
    if (/try\s*\{\s*parse[A-Z][A-Za-z0-9_]*\([^;]*\);\s*return true;\s*\}\s*catch\s*\{\s*return false;/su.test(source)) violations.push(`${file}: parse used as a predicate`);
  }
  assert.deepEqual(violations, []);
});

test('repositories capture and validate once before publication', async () => {
  let encodes = 0;
  let decodes = 0;
  const codec = {
    encode(value) {
      encodes += 1;
      const payload = Object.freeze({ ...value.payload });
      return Object.freeze({ type: value.type, payload });
    },
    decode(value) {
      decodes += 1;
      if (
        !value ||
        typeof value !== 'object' ||
        value.type !== 'measured' ||
        !value.payload ||
        typeof value.payload !== 'object' ||
        typeof value.payload.count !== 'number'
      )
        throw new Error('malformed measured event');
      return Object.freeze({ type: value.type, payload: Object.freeze({ count: value.payload.count }) });
    }
  };
  const repository = new InMemoryEventRepository(codec);
  const original = { type: 'measured', payload: { count: 1 } };
  const appended = await repository.append('run', original);
  original.payload.count = 2;
  assert.deepEqual({ encodes, decodes }, { encodes: 1, decodes: 1 });
  assert.equal('event' in appended, false);
  const { hash, ...receipt } = appended;
  assert.equal(hash, hashJson({ ...receipt, event: { type: 'measured', payload: { count: 1 } } }));
  const records = await Array.fromAsync(repository.read('run'));
  assert.deepEqual({ encodes, decodes }, { encodes: 1, decodes: 1 });
  assert.equal(records[0].event.payload.count, 1);
  await Array.fromAsync(repository.read('run'));
  await repository.verifyIntegrity('run');
  assert.deepEqual({ encodes, decodes }, { encodes: 1, decodes: 1 });

  const malformed = new InMemoryEventRepository({
    encode(value) {
      return { type: value.type, payload: { count: 'bad' } };
    },
    decode: codec.decode
  });
  await assert.rejects(malformed.append('run', { type: 'measured', payload: { count: 1 } }), /malformed measured event/u);
  assert.deepEqual(await Array.fromAsync(malformed.read('run')), []);

  const events = readFileSync(path.join(root, 'packages/runtime/src/events.ts'), 'utf8');
  assert.doesNotMatch(
    events,
    /AgentEvent\s*&\s*JsonObject|as\s+AgentEvent\s*&\s*JsonObject|Object\.freeze\(\{\s*\.\.\.value\s*\}\)/u
  );
  const repositorySource = readFileSync(
    path.join(root, 'packages/persistence/src/event-repository.ts'),
    'utf8'
  );
  assert.doesNotMatch(repositorySource, /readonly json:\s*JsonObject;\s*readonly value|encoding\.value/u);
  const plan = readFileSync(path.join(root, 'packages/tools/src/core/plan.ts'), 'utf8');
  assert.doesNotMatch(plan, /parseJsonObject|decodeToolCall/u);
  const execute = readFileSync(path.join(root, 'packages/tools/src/core/execute.ts'), 'utf8');
  assert.doesNotMatch(
    `${plan}\n${execute}`,
    /parseToolObservation\(undefined,\s*(?:invalid|missing|runtime|unknown)[A-Z][A-Za-z]+Observation/u
  );
  const modelWindow = readFileSync(
    path.join(root, 'packages/runtime/src/inference/model-window.ts'),
    'utf8'
  );
  assert.doesNotMatch(modelWindow, /\brawItems\s*\(/u);
  const observationFacts = readFileSync(
    path.join(root, 'packages/runtime/src/orchestration/observation-facts.ts'),
    'utf8'
  );
  assert.doesNotMatch(observationFacts, /parseJsonValue\(record\)/u);
  const observationStore = readFileSync(
    path.join(root, 'packages/runtime/src/orchestration/observation-store.ts'),
    'utf8'
  );
  assert.doesNotMatch(
    observationStore,
    /normalizeToolObservationForPersistence|parseJsonValue\(canonical|parseToolObservation/u
  );
  const toolContracts = readFileSync(path.join(root, 'packages/tools/src/core/definition.ts'), 'utf8');
  assert.doesNotMatch(
    toolContracts,
    /interface ToolObservationBase\s*\{[^}]*metadata\?:\s*Record<string, unknown>/u
  );
  assert.doesNotMatch(
    toolContracts,
    /interface \w+ToolFailureOutput[^\{]*\{[^}]*details\?:\s*Record<string, unknown>/u
  );
  const registry = readFileSync(path.join(root, 'packages/tools/src/core/registry.ts'), 'utf8');
  const registerBody = registry.slice(registry.indexOf('register('), registry.indexOf('\n  get('));
  assert.doesNotMatch(registerBody, /markCompiledTool|parseJsonObject/u);
});

test('public and persisted Core contracts use the domain glossary', () => {
  const violations = [];
  const prohibitedExport =
    /export\s+(?:interface|type|class|function|const)\s+[A-Za-z0-9_]*(?:Projection|Prepare|Prepared|Evidence|Candidate|Evaluation)[A-Za-z0-9_]*/gu;
  const prohibitedPersistedTag =
    /(?:kind|type):\s*(?:z\.literal\()?['"][^'"]*(?:projection|prepared|candidate|evaluation)[^'"]*['"]/gu;
  for (const file of production) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(prohibitedExport)) violations.push(`${file}: ${match[0]}`);
    for (const match of source.matchAll(prohibitedPersistedTag)) violations.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(violations, []);
});
