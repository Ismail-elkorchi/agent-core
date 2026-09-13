import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import * as z from 'zod';
import { rpcMethod } from '@agent-core/rpc';
import { JsonlRpcConnection } from '@agent-core/rpc/node';

function fixture(methods, output) {
  const input = new PassThrough();
  const frames = [],
    diagnostics = [];
  let closed = false;
  const connection = new JsonlRpcConnection({
    input,
    output:
      output ??
      new Writable({
        write(chunk, encoding, done) {
          frames.push(JSON.parse(chunk.toString()));
          done();
        }
      }),
    methods,
    diagnostic: (message) => diagnostics.push(message),
    onClose: async () => {
      closed = true;
    }
  });
  const completion = connection.run();
  void completion.catch(() => undefined);
  return { input, connection, frames, diagnostics, completion, closed: () => closed };
}
async function until(condition) {
  for (let i = 0; i < 2_000; i++) {
    if (condition()) return;
    await setImmediate();
  }
  throw new Error('RPC response did not arrive.');
}

test('JSONL preserves UTF-8 chunk boundaries and Unicode separators; request validation is independent', async () => {
  const f = fixture({ echo: rpcMethod(z.strictObject({ text: z.string() }), (params) => params.text) });
  const request = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'echo', params: { text: '文\u2028\u2029👩🏽‍💻' } }) + '\r\n'
  );
  for (const byte of request) f.input.write(Buffer.of(byte));
  f.input.write('{invalid}\n');
  f.input.write(JSON.stringify({ jsonrpc: '1.0', id: 3, method: 'echo' }) + '\n');
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 'bad', method: 'echo', params: { text: 42 } }) + '\n');
  await until(() => f.frames.length === 4);
  assert.equal(f.frames.find((frame) => frame.id === 0).result, '文\u2028\u2029👩🏽‍💻');
  assert.deepEqual(
    f.frames
      .filter((frame) => frame.error)
      .map((frame) => frame.error.code)
      .sort((a, b) => a - b),
    [-32700, -32602, -32600]
  );
  f.input.end();
  await f.completion;
  assert(f.closed());
});

test('batch results omit notifications and preserve request IDs including null', async () => {
  const called = [];
  const f = fixture({
    echo: rpcMethod(z.tuple([z.string()]), ([text]) => {
      called.push(text);
      return text;
    })
  });
  f.input.write(
    JSON.stringify([
      { jsonrpc: '2.0', method: 'echo', params: ['notification'] },
      { jsonrpc: '2.0', method: 'echo', id: null, params: ['response'] },
      12,
      { jsonrpc: '2.0', method: 'unknown', id: 'missing' }
    ]) + '\n'
  );
  await until(() => f.frames.length === 1);
  assert.equal(f.frames[0].length, 3);
  assert(f.frames[0].some((response) => response.id === null && response.result === 'response'));
  assert.deepEqual(called, ['notification', 'response']);
  f.input.write(
    JSON.stringify([
      { jsonrpc: '2.0', method: 'echo', params: ['one'] },
      { jsonrpc: '2.0', method: 'unknown' }
    ]) + '\n'
  );
  await until(() => f.diagnostics.length === 1);
  assert.equal(f.frames.length, 1);
  f.input.end();
  await f.completion;
});

test('notifications interleave with independent requests and EOF owns shutdown', async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    wait: rpcMethod(z.strictObject({}), async () => {
      await waiting;
      return 'done';
    }),
    state: rpcMethod(z.strictObject({}), () => 'running')
  });
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 'work', method: 'wait' }) + '\n');
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 'read', method: 'state' }) + '\n');
  await f.connection.notify('progress', { text: 'Current work' });
  await until(() => f.frames.some((frame) => frame.id === 'read'));
  assert.equal(
    f.frames.some((frame) => frame.id === 'work'),
    false
  );
  f.input.end();
  await until(f.closed);
  release();
  await f.completion;
  assert(f.frames.some((frame) => frame.id === 'work' && frame.result === 'done'));
});

test('a slow consumer is disconnected explicitly when its output cannot drain', async () => {
  const output = new Writable({ write() {} });
  const f = fixture({}, output);
  const delivery = f.connection.notify('progress', { text: 'Waiting on output' });
  void delivery.catch(() => undefined);
  f.input.end();
  await assert.rejects(f.completion, /drain/u);
  await assert.rejects(delivery, /drain/u);
  assert(f.closed());
  assert(f.diagnostics.some((message) => message.includes('drain')));
});
