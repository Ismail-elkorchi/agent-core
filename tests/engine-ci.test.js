import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const minimumNode = '>=24.8.0';

test('package engines and release CI enforce the stable path.matchesGlob Node floor', async () => {
  const manifests = [
    'package.json',
    'packages/auth/package.json',
    'packages/evidence/package.json',
    'packages/json/package.json',
    'packages/model/package.json',
    'packages/runtime/package.json',
    'packages/tools/package.json',
    'packages/tools-local/package.json',
    'packages/providers/ollama/package.json',
    'packages/providers/openai/package.json',
    'packages/providers/openai-codex/package.json',
    'packages/providers/openai-responses/package.json',
    'packages/providers/openrouter/package.json'
  ];
  for (const manifest of manifests) {
    const parsed = JSON.parse(await readFile(path.resolve(manifest), 'utf8'));
    assert.equal(parsed.engines.node, minimumNode, manifest);
  }

  const workflow = await readFile(path.resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /Ubuntu \/ minimum Node 24\.8\.0[\s\S]*?node: 24\.8\.0/u);
  assert.match(workflow, /Ubuntu \/ current Node 24[\s\S]*?os: ubuntu-latest[\s\S]*?node: 24/u);
  assert.match(workflow, /macOS \/ current Node 24[\s\S]*?os: macos-latest[\s\S]*?node: 24/u);
  assert.match(workflow, /Windows \/ current Node 24[\s\S]*?os: windows-latest[\s\S]*?node: 24/u);
  assert.match(workflow, /run: npm run verify:release/u);
  assert.doesNotMatch(workflow, /if:\s*runner\.os\s*!==?\s*['"]Windows/u);
});

test('the JSON foundation restores model dependency direction without domain behavior', async () => {
  const model = JSON.parse(await readFile(path.resolve('packages/model/package.json'), 'utf8'));
  assert.equal(model.dependencies['@agent-core/json'], '0.2.0');
  assert.equal(model.dependencies['@agent-core/evidence'], undefined);
  const foundation = JSON.parse(await readFile(path.resolve('packages/json/package.json'), 'utf8'));
  assert.deepEqual(foundation.dependencies ?? {}, {});
  const source = await readFile(path.resolve('packages/json/src/index.ts'), 'utf8');
  assert.doesNotMatch(source, /evidence|artifact|provider|runtime|tool/iu);
});
