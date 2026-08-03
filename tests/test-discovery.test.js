import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ordinaryTestFiles } from '../scripts/run-test-suite.mjs';

test('ordinary test discovery is confined to source tests and excludes packed-consumer installation', async () => {
  const files = await ordinaryTestFiles();
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.endsWith('.test.js')));
  assert.ok(files.every((file) => file.split(path.sep).includes('tests')));
  assert.ok(files.every((file) => !file.includes('test-packed-consumer')));
});
