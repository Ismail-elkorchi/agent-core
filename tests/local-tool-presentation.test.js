import assert from 'node:assert/strict';
import test from 'node:test';
import { localToolCallPresentation } from '@agent-core/tools-local';

test('file call titles reflect structured file ranges rather than guessing a workspace target', () => {
  const call = { id: 'read', type: 'function', name: 'read_files', input: { kind: 'json', value: {
    files: [{ path: 'src/main.ts', startLine: 12, lineCount: 8 }, { path: 'README.md' }]
  } } };
  const presentation = localToolCallPresentation(call);
  assert.equal(presentation.label, 'Read src/main.ts:12, README.md');
  assert.match(presentation.details[0].content, /src\/main.ts · from line 12 · 8 lines/);
  assert.match(presentation.details[0].content, /README.md · from line 1/);
});

test('custom and JSON patch calls share one exact display representation', () => {
  const patch = '*** Begin Patch\n*** Update File: file.ts\n@@\n-old\n+new\n*** End Patch';
  const custom = localToolCallPresentation({ id: 'patch', type: 'custom', name: 'apply_patch', input: { kind: 'text', value: patch } });
  const logical = localToolCallPresentation({ id: 'patch', type: 'function', name: 'apply_patch', input: { kind: 'json', value: { patch } } });
  assert.deepEqual(custom, logical);
  assert.equal(custom.details[0].content, patch);
  assert.equal(custom.details[0].format, 'diff');
});
