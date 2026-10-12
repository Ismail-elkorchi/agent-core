import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';

const request = { model: 'gpt-5.6', messages: [{ role: 'user', content: 'hello' }] };
const auth = {
  type: 'bearer',
  tokenProvider: {
    describe: () => ({ type: 'oauth', label: 'fixture', provider: 'openai-codex' }),
    getBearerToken: async () => ({ token: `e30.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' }
    })).toString('base64url')}.signature` })
  }
};
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const terminal = (status) => ({ type: `response.${status}`, response: {
  id: 'terminal', model: request.model, status, output_text: 'Known answer',
  usage: { input_tokens: 17, output_tokens: 5, total_tokens: 22 },
  ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {})
} });
const factories = {
  OpenAI: (fetch) => new OpenAIProvider({ apiKey: 'fixture', fetch, statusIntervalMs: 5, streamIdleTimeoutMs: 20 }),
  Codex: (fetch) => new OpenAICodexProvider({ auth, transport: 'http', fetch, statusIntervalMs: 5, streamIdleTimeoutMs: 20 })
};

for (const [name, create] of Object.entries(factories)) {
  for (const status of ['completed', 'incomplete']) {
    for (const tail of ['idle', 'error', 'transport-error', 'malformed', 'oversized-tail', 'abort-on-cancel', 'cancel-error']) {
      test(`${name} HTTP settles ${status} before ${tail} and cancels the body`, { timeout: 2000 }, async () => {
        let cancelled = false;
        const controller = new AbortController();
        const body = new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(frame(terminal(status)) +
              (tail === 'error' ? frame({ type: 'error', message: 'too late' }) :
                tail === 'malformed' ? 'data: {invalid\n\n' :
                  tail === 'oversized-tail' ? 'data: ' + 'x'.repeat(2 * 1024 * 1024) + '\n\n' : '')));
          },
          pull(stream) {
            if (tail === 'transport-error') stream.error(new Error('late transport error'));
          },
          cancel() {
            cancelled = true;
            if (tail === 'abort-on-cancel') controller.abort();
            if (tail === 'cancel-error') throw new Error('late cancellation failure');
          }
        }, { highWaterMark: 0 });
        const provider = create(async () => new Response(body));
        const events = [];
        for await (const event of provider.stream({ ...request, signal: controller.signal })) events.push(event);
        const done = events.at(-1);
        assert.equal(done.type, 'done');
        assert.equal(done.response.content, 'Known answer');
        assert.equal(done.response.usage.totalTokens, 22);
        assert.equal(done.response.providerTerminationReason, status === 'incomplete' ? 'max_output_tokens' : 'completed');
        assert.equal(cancelled, true);
        assert.equal(body.locked, false);
      });
    }
  }
  for (const response of [undefined, {}, { status: 'in_progress' }, { status: 'completed', usage: { total_tokens: 'invalid' } }]) {
    test(`${name} HTTP rejects malformed terminal ${JSON.stringify(response)}`, async () => {
      let cancelled = false;
      const body = new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode(frame({ type: 'response.completed', response }))); },
        cancel() { cancelled = true; }
      });
      const provider = create(async () => new Response(body));
      await assert.rejects(async () => {
        for await (const event of provider.stream(request)) assert.notEqual(event.type, 'done');
      }, (error) => error.code === 'malformed_response');
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    });
  }
  test(`${name} HTTP preserves errors before a terminal and active cancellation`, async () => {
    const provider = create(async () => new Response(frame({ type: 'error', error: { message: 'original error' } }) + frame(terminal('completed'))));
    await assert.rejects(async () => {
      for await (const event of provider.stream(request)) assert.notEqual(event.type, 'done');
    }, /original error/);
    const controller = new AbortController();
    let cancelled = false;
    const aborting = create(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: 'partial' }))); },
      cancel() { cancelled = true; }
    })));
    await assert.rejects(async () => {
      for await (const event of aborting.stream({ ...request, signal: controller.signal })) {
        if (event.type === 'content') controller.abort();
      }
    }, (error) => error.code === 'aborted');
    assert.equal(cancelled, true);
  });
}

test('Codex default WebSocket factory detaches old request cancellation but respects the active request', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  let connections = 0;
  let received = 0;
  const secondSent = Promise.withResolvers();
  const thirdSent = Promise.withResolvers();
  let peer;
  server.on('connection', (socket) => {
    connections++;
    peer = socket;
    socket.on('message', () => {
      received++;
      if (received === 1) socket.send(JSON.stringify(terminal('completed')));
      if (received === 2) secondSent.resolve();
      if (received === 3) thirdSent.resolve();
    });
  });
  const provider = new OpenAICodexProvider({ auth, transport: 'websocket', baseUrl: `http://127.0.0.1:${server.address().port}` });
  const session = provider.createSession();
  const first = new AbortController();
  const active = new AbortController();
  try {
    assert.equal((await session.complete({ ...request, signal: first.signal })).content, 'Known answer');
    const second = session.complete(request);
    await secondSent.promise;
    first.abort();
    // Let any stale abort-induced socket termination propagate before replying.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(peer.readyState, 1);
    peer.send(JSON.stringify(terminal('completed')));
    assert.equal((await second).content, 'Known answer');
    assert.equal(connections, 1);
    const third = session.complete({ ...request, signal: active.signal });
    const rejected = assert.rejects(third, (error) => error.code === 'aborted');
    await thirdSent.promise;
    const closed = once(peer, 'close');
    active.abort();
    await rejected;
    await closed;
  } finally {
    await session.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Codex default WebSocket factory cancels an unfinished connection', { timeout: 5000 }, async () => {
  const server = createServer();
  const upgraded = Promise.withResolvers();
  let peer;
  server.on('upgrade', (_request, socket) => { peer = socket; upgraded.resolve(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const provider = new OpenAICodexProvider({ auth, transport: 'websocket', baseUrl: `http://127.0.0.1:${server.address().port}` });
  const session = provider.createSession();
  const controller = new AbortController();
  try {
    const completion = session.complete({ ...request, signal: controller.signal });
    const rejected = assert.rejects(completion, (error) => error.code === 'aborted');
    await upgraded.promise;
    const closed = once(peer, 'end');
    peer.resume();
    controller.abort();
    await rejected;
    await closed;
  } finally {
    await session.close();
    peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
