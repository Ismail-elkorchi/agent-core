import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendJsonlRecord, readJsonlBytes } from '@agent-core/persistence/node';

test('JSONL commits complete UTF-8 records across short writes and reads', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jsonl-short-io-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'records.jsonl');
  const open = fs.open.bind(fs);
  let writes = 0;
  let reads = 0;
  let failWrite = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] !== file) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'write')
          return async (bytes, offset, length, position) => {
            writes++;
            if (failWrite)
              throw Object.assign(new Error('storage unavailable'), { code: 'ENOSPC' });
            return target.write(bytes, offset, Math.min(length, 7), position);
          };
        if (key === 'read')
          return async (bytes, offset, length, position) => {
            reads++;
            return target.read(bytes, offset, Math.min(length, 11), position);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  });
  const record = { text: 'Original UTF-8: λ🙂改正'.repeat(20) };
  const length = await appendJsonlRecord(file, record);
  assert(writes > 1);
  assert.equal((await fs.stat(file)).size, length);
  const bytes = await readJsonlBytes(file, 0, length + 10);
  assert(reads > 1);
  assert.equal(bytes.length, length);
  assert.equal(bytes.at(-1), 10);
  assert.deepEqual(JSON.parse(Buffer.from(bytes).toString('utf8')), record);
  failWrite = true;
  await assert.rejects(appendJsonlRecord(file, { text: 'must not be committed' }), {
    code: 'ENOSPC'
  });
  assert.equal((await fs.stat(file)).size, length);
});
