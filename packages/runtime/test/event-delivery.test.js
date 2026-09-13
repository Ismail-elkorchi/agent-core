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
