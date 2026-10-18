import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionReadLifetime } from '@agent-core/runtime';

test('closing fences new reads and waits for admitted read publication and decoration', async () => {
  const reads = new SessionReadLifetime();
  const release = Promise.withResolvers();
  const order = [];
  const reading = reads.read(async () => {
    order.push('captured');
    await release.promise;
    order.push('published');
    await Promise.resolve();
    order.push('decorated');
    return 42;
  });
  const closing = reads.close().then(() => order.push('closed'));
  assert.throws(() => reads.read(async () => 0), /closed/);
  assert.deepEqual(order, ['captured']);
  release.resolve();
  assert.equal(await reading, 42);
  await closing;
  assert.deepEqual(order, ['captured', 'published', 'decorated', 'closed']);
});

test('failed reads settle ownership without masking their failure', async () => {
  const reads = new SessionReadLifetime();
  const release = Promise.withResolvers();
  const failure = new Error('index publication failed');
  const reading = reads.read(async () => { await release.promise; throw failure; });
  const rejected = assert.rejects(reading, error => error === failure);
  const closing = reads.close();
  release.resolve();
  await rejected;
  await closing;
  await reads.close();
});

test('read ownership is admitted before a synchronous reentrant close', async () => {
  const reads = new SessionReadLifetime();
  const release = Promise.withResolvers();
  let closing;
  let closed = false;
  const reading = reads.read(() => {
    closing = reads.close().then(() => { closed = true; });
    return release.promise;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve('original session');
  assert.equal(await reading, 'original session');
  await closing;
  assert.equal(closed, true);
});
