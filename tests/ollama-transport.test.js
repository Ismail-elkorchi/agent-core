import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaProvider } from '@agent-core/provider-ollama';

const request = { model: 'fixture', messages: [{ role: 'user', content: 'Hello' }] };
const final = {
  model: 'fixture',
  message: { role: 'assistant', content: 'Done' },
  done: true,
  done_reason: 'stop'
};
const encode = (value) => new TextEncoder().encode(value);
function fixture(chunks) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk);
    },
    cancel() {
      cancelled = true;
    }
  });
  const provider = new OllamaProvider({
    fetch: async (url) =>
      String(url).endsWith('/api/show')
        ? Response.json({
            capabilities: ['completion', 'thinking', 'vision'],
            model_info: { 'fixture.context_length': 32768 }
          })
        : new Response(body)
  });
  return { provider, body, cancelled: () => cancelled };
}
for (const [label, chunks] of [
  ['invalid JSON', ['PRIVATE_FRAME_MUST_NOT_BE_LOGGED\n', JSON.stringify(final) + '\n']],
  ['invalid UTF-8', [new Uint8Array([0xc3, 0x28, 10]), JSON.stringify(final) + '\n']],
  [
    'an oversized incomplete frame',
    ['x'.repeat(4 * 1024 * 1024 + 1), '\n' + JSON.stringify(final) + '\n']
  ]
])
  test(`Ollama rejects ${label} without logging original response content`, async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    const { provider, body, cancelled } = fixture(chunks);
    await assert.rejects(
      provider.complete(request),
      (error) => error.code === 'malformed_response'
    );
    assert.deepEqual(warnings, []);
    assert.equal(body.locked, false);
    assert.equal(cancelled(), true);
  });
for (const finished of [false, true])
  test(`Ollama releases its response reader after ${finished ? 'completion' : 'consumer departure'}`, async () => {
    const { provider, body, cancelled } = fixture([JSON.stringify(final) + '\n']);
    if (finished) await provider.complete(request);
    else
      for await (const event of provider.stream(request)) {
        assert.equal(event.type, 'content');
        break;
      }
    assert.equal(body.locked, false);
    assert.equal(cancelled(), true);
  });
test(
  'Ollama cancellation releases a reader waiting for the next frame',
  { timeout: 2000 },
  async () => {
    const { provider, body, cancelled } = fixture([
      JSON.stringify({ message: { content: 'Partial' }, done: false }) + '\n'
    ]);
    const controller = new AbortController();
    const iterator = provider
      .stream(request, { signal: controller.signal })
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, 'content');
    const pending = iterator.next();
    controller.abort(new Error('Stop waiting'));
    await assert.rejects(pending, (error) => error.code === 'aborted');
    assert.equal(body.locked, false);
    assert.equal(cancelled(), true);
  }
);
test('Ollama streamed failures after reasoning are not eligible for a fresh generation retry', async () => {
  const { provider } = fixture([
    JSON.stringify({ message: { thinking: 'Preserved reasoning' }, done: false }) + '\n',
    '{"error":"Upstream failed"}\n'
  ]);
  const seen = [];
  await assert.rejects(
    async () => {
      for await (const event of provider.stream(request)) seen.push(event);
    },
    (error) => error.code === 'provider_unavailable' && !error.retryable
  );
  assert.equal(seen[0].type, 'reasoning');
});
test('Ollama sends the admitted base64 image without treating it as a local filename', async () => {
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), 'ollama-image-'));
  let sent;
  try {
    await writeFile(join(directory, 'YWxwaGE='), 'unrelated local file');
    process.chdir(directory);
    const provider = new OllamaProvider({
      fetch: async (url, init) => {
        if (String(url).endsWith('/api/show'))
          return Response.json({
            capabilities: ['completion', 'vision'],
            model_info: { 'fixture.context_length': 32768 }
          });
        sent = JSON.parse(init.body);
        return new Response(JSON.stringify(final) + '\n');
      }
    });
    const compiled = await provider.compileRequest({
      ...request,
      messages: [
        {
          role: 'user',
          content: 'Describe',
          images: [{ type: 'base64', data: 'YWxwaGE=', mediaType: 'image/png' }]
        }
      ]
    });
    await provider.completeCompiled(compiled);
    assert.equal(sent.messages[0].images[0], 'YWxwaGE=');
    assert.deepEqual(sent, { ...compiled.body, stream: true });
  } finally {
    process.chdir(cwd);
    await rm(directory, { recursive: true, force: true });
  }
});
test('Ollama reads split Unicode frames and a terminal frame without a final newline', async () => {
  const bytes = encode(JSON.stringify({ ...final, message: { content: '完成 🎨' } }));
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    }
  });
  const provider = new OllamaProvider({
    fetch: async (url) =>
      String(url).endsWith('/api/show')
        ? Response.json({
            capabilities: ['completion'],
            model_info: { 'fixture.context_length': 32768 }
          })
        : new Response(stream)
  });
  assert.equal((await provider.complete(request)).content, '完成 🎨');
  assert.equal(stream.locked, false);
});

test('Ollama preserves distinct calls with equal arguments in streaming and final output', async () => {
  const toolCall = {
    function: { name: 'read_files', arguments: { files: [{ path: 'item.txt' }] } }
  };
  const { provider } = fixture([
    JSON.stringify({ message: { tool_calls: [toolCall] }, done: false }) + '\n',
    JSON.stringify({ message: { tool_calls: [toolCall] }, done: true, done_reason: 'stop' }) + '\n'
  ]);
  const events = [];
  for await (const event of provider.stream(request)) events.push(event);
  const calls = events.filter((event) => event.type === 'tool_call').map((event) => event.toolCall);
  assert.equal(calls.length, 2);
  assert.deepEqual(events.at(-1).response.toolCalls, calls);
  assert.equal(events.at(-1).response.output.filter((item) => item.type === 'tool_call').length, 2);
});
