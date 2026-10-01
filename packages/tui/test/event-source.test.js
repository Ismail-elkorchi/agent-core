import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationEventSource } from '@agent-core/tui';

function fixture(extra = {}) {
  const observations = [];
  let deliver;
  let fail;
  const source = applicationEventSource('application', {
    replacementKey: (message) => (message.type === 'progress' ? 'progress' : undefined),
    failureMessage: (message) => ({ type: 'failure', message }),
    subscribe(emit, failed) {
      observations.push('subscribe');
      deliver = emit;
      fail = failed;
      return () => observations.push('unsubscribe');
    },
    ...extra
  });
  return {
    source,
    observations,
    emit: (message) => deliver(message),
    fail: (cause) => fail(cause)
  };
}

test('application subscription precedes startup, inherits sink backpressure and detaches exactly once', async () => {
  const delivered = [];
  let admit;
  const f = fixture({ start: async (emit) => emit({ type: 'ready' }) });
  assert.deepEqual(f.observations, []);
  const controller = new AbortController();
  const running = f.source.run(
    { signal: controller.signal },
    {
      emit: (message) => {
        delivered.push(message);
        return new Promise((resolve) => {
          admit = resolve;
        });
      }
    }
  );
  assert.deepEqual(f.observations, ['subscribe']);
  assert.equal(delivered[0].message.type, 'ready');
  admit();
  let accepted = false;
  const pending = f.emit({ type: 'progress' }).then(() => {
    accepted = true;
  });
  await Promise.resolve();
  assert.equal(accepted, false);
  admit();
  await pending;
  controller.abort();
  await running;
  await f.source.dispose?.();
  assert.deepEqual(f.observations, ['subscribe', 'unsubscribe']);
});

test('producer failure rejects the source and preserves its lifecycle message', async () => {
  const f = fixture();
  const running = f.source.run({ signal: new AbortController().signal }, { emit: async () => {} });
  const expected = new Error('application delivery failed');
  f.fail(expected);
  await assert.rejects(running, (error) => error === expected);
  await f.source.dispose?.();
  assert.deepEqual(f.observations, ['subscribe', 'unsubscribe']);
  assert.deepEqual(
    f.source.onLifecycle({ kind: 'failed', diagnostic: { message: expected.message } }),
    { type: 'failure', message: expected.message }
  );
});

test('an already removed source never attaches or starts its application', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture({
    start: async () => {
      throw new Error('Must not start');
    }
  });
  await f.source.run({ signal: controller.signal }, { emit: async () => {} });
  await f.source.dispose?.();
  assert.deepEqual(f.observations, []);
});
