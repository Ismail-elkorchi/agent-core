import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ApplicationEvents } from '@agent-core/runtime';

test('slow subscribers have bounded delivery with an explicit gap and do not delay other subscribers', async () => {
  const events = new ApplicationEvents();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const slow = [],
    fast = [];
  events.subscribe(async (event) => {
    slow.push(event);
    if (slow.length === 1) await blocked;
  }, assert.fail);
  events.subscribe((event) => {
    fast.push(event);
  }, assert.fail);
  for (let i = 0; i < 1_000; i++) {
    events.publish({ type: 'committed', id: i });
    await setImmediate();
  }
  assert.equal(fast.length, 1_000);
  assert.equal(slow.length, 1);
  release();
  await setImmediate();
  assert.deepEqual(
    slow.map((event) => event.type),
    ['committed', 'delivery.gap']
  );
  events.close();
});

test('replacement values coalesce within reliable boundaries and detachment discards delivery only', async () => {
  const events = new ApplicationEvents((event) => (event.type === 'text' ? event.id : undefined));
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const received = [];
  const detach = events.subscribe(async (event) => {
    received.push(event);
    if (received.length === 1) await blocked;
  }, assert.fail);
  events.publish({ type: 'started' });
  await setImmediate();
  for (let i = 0; i < 500; i++) events.publish({ type: 'text', id: 'turn', accumulated: String(i) });
  events.publish({ type: 'ended' });
  events.publish({ type: 'text', id: 'next', accumulated: 'Next' });
  release();
  await setImmediate();
  assert.deepEqual(
    received.map((event) => event.type),
    ['started', 'text', 'ended', 'text']
  );
  assert.equal(received[1].accumulated, '499');
  detach();
  events.publish({ type: 'after-detach' });
  assert.equal(received.length, 4);
  events.close();
});

test('a failing sole subscriber is detached and its owner receives the failure', async () => {
  const events = new ApplicationEvents();
  const failures = [];
  events.subscribe(
    () => {
      throw new Error('consumer stopped');
    },
    (error) => failures.push(error)
  );
  events.publish({ type: 'committed', id: 1 });
  await setImmediate();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'consumer stopped');
  events.publish({ type: 'committed', id: 2 });
  await setImmediate();
  assert.equal(failures.length, 1);
  events.close();
});

for (const handler of ['throws', 'rejects']) {
  for (const trigger of ['listener', 'fail']) {
    test(`failure handler that ${handler} is isolated after ${trigger} failure`, async () => {
      const events = new ApplicationEvents();
      const errors = [];
      const received = [];
      events.subscribe(() => {
        throw new Error('listener failed');
      }, (error) => {
        errors.push(error.message);
        if (handler === 'throws') throw new Error('owner failed');
        return Promise.reject(new Error('owner failed'));
      });
      events.subscribe((event) => received.push(event.type), (error) => errors.push(error.message));
      if (trigger === 'listener') events.publish({ type: 'first' });
      else assert.doesNotThrow(() => events.fail(new Error('source failed')));
      await setImmediate();
      events.publish({ type: 'second' });
      await setImmediate();
      assert.deepEqual(errors, trigger === 'listener' ? ['listener failed'] : ['source failed', 'source failed']);
      assert.deepEqual(received, trigger === 'listener' ? ['first', 'second'] : []);
      events.close();
    });
  }
}

test('reentrant publication preserves order for every independent observer', async () => {
  const events = new ApplicationEvents();
  const first = [], second = [];
  events.subscribe((event) => {
    first.push(event.id);
    if (event.id === 1) events.publish({ type: 'committed', id: 2 });
  }, assert.fail);
  events.subscribe((event) => second.push(event.id), assert.fail);
  events.publish({ type: 'committed', id: 1 });
  assert.deepEqual(first, [], 'publication does not invoke application code');
  await setImmediate();
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [1, 2]);
  events.close();
});

for (const shutdown of ['unsubscribe', 'close']) {
  test(`${shutdown} discards queued deliveries without waiting for an active listener`, async () => {
    const events = new ApplicationEvents();
    const blocked = Promise.withResolvers();
    const received = [];
    const unsubscribe = events.subscribe(async (event) => {
      received.push(event.id);
      await blocked.promise;
    }, assert.fail);
    events.publish({ type: 'committed', id: 1 });
    await setImmediate();
    events.publish({ type: 'committed', id: 2 });
    if (shutdown === 'unsubscribe') unsubscribe();
    else events.close();
    blocked.resolve();
    await setImmediate();
    events.publish({ type: 'committed', id: 3 });
    await setImmediate();
    assert.deepEqual(received, [1]);
    events.close();
  });
}

test('a gap is followed by new committed events after recovery starts', async () => {
  const events = new ApplicationEvents();
  const blocked = Promise.withResolvers();
  const received = [];
  events.subscribe(async (event) => {
    received.push(event.type);
    if (event.type === 'first') await blocked.promise;
    if (event.type === 'delivery.gap') events.publish({ type: 'after-refresh' });
  }, assert.fail);
  events.publish({ type: 'first' });
  await setImmediate();
  for (let index = 0; index < 100; index++) events.publish({ type: 'overflow' });
  blocked.resolve();
  await setImmediate();
  assert.deepEqual(received, ['first', 'delivery.gap', 'after-refresh']);
  events.close();
});

test('failing the source reports once even if its detached in-flight listener later rejects', async () => {
  const events = new ApplicationEvents();
  const blocked = Promise.withResolvers();
  const failures = [];
  events.subscribe(() => blocked.promise, (error) => {
    failures.push(error.message);
    return new Promise(() => {});
  });
  events.publish({ type: 'committed' });
  await setImmediate();
  events.fail(new Error('source failed'));
  blocked.reject(new Error('late listener failure'));
  await setImmediate();
  assert.deepEqual(failures, ['source failed']);
  events.close();
});
