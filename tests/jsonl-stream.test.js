import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJsonlLines } from '@agent-core/persistence/node';

test('JSONL streaming enforces the line bound even when the terminator arrives in the same chunk', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'jsonl-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'records.jsonl');
  await writeFile(file, '12345\n');
  await assert.rejects(Array.fromAsync(readJsonlLines(file, { maxLineBytes: 4 })), /exceeds 4 bytes/u);
  const lines = await Array.fromAsync(readJsonlLines(file, { maxLineBytes: 5 }));
  assert.equal(lines[0].text, '12345');
});
