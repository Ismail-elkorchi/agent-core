import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import {
  readJsonSseEvents,
  waitForResponseOrStatus,
  retryAfterDeadline
} from '@agent-core/provider-openai-responses';

const exec = promisify(execFile);

test('HTTP retry guidance preserves absolute dates and rejects unusable delay values', () => {
  const receivedAt = Date.UTC(2026, 9, 11);
  assert.equal(retryAfterDeadline('2', receivedAt), receivedAt + 2000);
  assert.equal(retryAfterDeadline('0.25', receivedAt), receivedAt + 250);
  const absolute = receivedAt + 60000;
  assert.equal(retryAfterDeadline(new Date(absolute).toUTCString(), receivedAt), absolute);
  assert.equal(
    retryAfterDeadline(new Date(receivedAt - 60000).toUTCString(), receivedAt),
    receivedAt - 60000
  );
  for (const value of [null, '', ' ', '-1', 'invalid', 'Infinity', '9'.repeat(310)])
    assert.equal(retryAfterDeadline(value, receivedAt), undefined);
});

for (const when of ['before reading', 'while reading'])
  test(`SSE cancellation ${when} works without status or idle timers`, async (t) => {
    const controller = new AbortController();
    const reason = new Error('Stop requested');
    let source;
    let cancelled = false;
    const body = new ReadableStream({
      start(value) {
        source = value;
      },
      cancel() {
        cancelled = true;
      }
    });
    t.after(() => {
      if (!cancelled) source.close();
    });
    if (when === 'before reading') controller.abort(reason);
    const events = readJsonSseEvents(body, {
      signal: controller.signal,
      decodeData: (value) => value,
      createMalformedError: (message) => new Error(message)
    })[Symbol.asyncIterator]();
    const pending = events.next();
    if (when === 'while reading') controller.abort(reason);
    let timer;
    try {
      await assert.rejects(
        Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Cancellation was ignored')), 500);
          })
        ]),
        (error) => error === reason
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });

test('waiting for response headers preserves a caller-owned frozen abort reason', async () => {
  const reason = Object.freeze(new Error('Stop requested'));
  await assert.rejects(
    waitForResponseOrStatus(new Promise(() => {}), 1000, AbortSignal.abort(reason)),
    (error) => error === reason
  );
  assert.equal(reason.name, 'Error');
});

for (const continuation of ['read', 'stop'])
  test(`SSE disconnect during consumer work stays owned when the consumer chooses to ${continuation}`, async () => {
    // Isolate unhandled rejection detection: a transport error must reach the
    // consumer, never terminate its process while that consumer handles output.
    await exec(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--input-type=module',
        '--eval',
        `
        import assert from 'node:assert/strict';
        import { setImmediate } from 'node:timers/promises';
        import { readJsonSseEvents } from '@agent-core/provider-openai-responses';
        let source;
        const body = new ReadableStream({
          start(controller) {
            source = controller;
            controller.enqueue(new TextEncoder().encode('data: {"text":"received"}\\n\\n'));
          }
        });
        const events = readJsonSseEvents(body, {
          statusIntervalMs: 1000,
          idleTimeoutMs: 5000,
          decodeData: value => value,
          createMalformedError: message => new Error(message)
        })[Symbol.asyncIterator]();
        assert.deepEqual(await events.next(), {
          value: { type: 'data', data: { text: 'received' } }, done: false
        });
        const failure = new Error('Connection lost while recording received output');
        source.error(failure);
        await setImmediate();
        if (${JSON.stringify(continuation)} === 'read')
          await assert.rejects(events.next(), error => error === failure);
        else
          assert.equal((await events.return()).done, true);
        assert.equal(body.locked, false);
      `
      ],
      { cwd: new URL('..', import.meta.url), timeout: 10000 }
    );
  });
