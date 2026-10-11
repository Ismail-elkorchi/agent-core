import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

for (const continuation of ['read', 'stop'])
  test(`SSE disconnect during consumer work stays owned when the consumer chooses to ${continuation}`, async () => {
    // Isolate unhandled rejection detection: a transport error must reach the
    // consumer, never terminate its process while that consumer handles output.
    await exec(process.execPath, [
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
    ], { cwd: new URL('..', import.meta.url), timeout: 10000 });
  });
