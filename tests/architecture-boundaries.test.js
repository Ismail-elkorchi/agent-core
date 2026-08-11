import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const production = readdirSync(path.join(root, 'packages'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.parentPath.includes(`${path.sep}test${path.sep}`))
  .map((entry) => path.join(entry.parentPath, entry.name));

test('production boundaries do not rebuild established ownership proofs', () => {
  const violations = [];
  for (const file of production) {
    const source = readFileSync(file, 'utf8');
    if (/\bdeepFreeze\b/u.test(source)) violations.push(`${file}: generic deepFreeze`);
    if (/\bas unknown as\b/u.test(source)) violations.push(`${file}: as unknown as`);
    if (/\b(?:hashRecord|stableStringify|validateToolDefinition)\b/u.test(source)) violations.push(`${file}: retired boundary abstraction`);
    for (const discarded of source.matchAll(/^\s*(?:parse|decode|normalize|sanitize|own|snapshot|clone)[A-Z][A-Za-z0-9_]*\([^;\n]*\);\s*$/gmu)) {
      if (!discarded[0].includes(').')) violations.push(`${file}: discarded owning decoder result: ${discarded[0].trim()}`);
    }
    if (/try\s*\{\s*parse[A-Z][A-Za-z0-9_]*\([^;]*\);\s*return true;\s*\}\s*catch\s*\{\s*return false;/su.test(source)) violations.push(`${file}: parse used as a predicate`);
  }
  assert.deepEqual(violations, []);
});

test('event persistence and tool registration have one ownership transition', () => {
  const events = readFileSync(path.join(root, 'packages/runtime/src/events.ts'), 'utf8');
  const decodeBody = events.slice(events.indexOf('export function decodeAgentEvent'), events.indexOf('type AgentEventOf'));
  assert.equal((decodeBody.match(/parseJsonObject\(/gu) ?? []).length, 1);
  assert.doesNotMatch(decodeBody, /isAgentEvent\(/u);
  const dispatch = events.slice(events.indexOf('const AGENT_EVENT_DECODERS'), events.indexOf('const AGENT_EVENT_TYPES'));
  assert.match(dispatch, /satisfies AgentEventDecoderMap/u);
  assert.doesNotMatch(dispatch, /parseJsonObject\(|parseAgentCandidate|as unknown as/u);
  assert.equal((dispatch.match(/^  '[^']+': \(value\) => \{/gmu) ?? []).length, (dispatch.match(/\n    exact\(value,/gu) ?? []).length);

  const registry = readFileSync(path.join(root, 'packages/tools/src/core/registry.ts'), 'utf8');
  const registerBody = registry.slice(registry.indexOf('register<'), registry.indexOf('\n  get('));
  assert.doesNotMatch(registerBody, /adoptToolDefinition|parseJsonObject/u);
});
