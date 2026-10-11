import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaProvider } from '@agent-core/provider-ollama';

const request = { model: 'fixture', messages: [{ role: 'user', content: 'Inspect two sources.' }] };
function fixture(records) {
  const sent = [];
  return {
    sent,
    provider: new OllamaProvider({
      fetch: async (url, init) => {
        if (String(url).endsWith('/api/show'))
          return Response.json({
            capabilities: ['completion', 'tools'],
            model_info: { 'fixture.context_length': 32768 }
          });
        sent.push(JSON.parse(init.body));
        return new Response(records.map((value) => JSON.stringify(value)).join('\n') + '\n');
      }
    })
  };
}

test('Ollama admission disables implicit input truncation and context shifting', async () => {
  const { provider, sent } = fixture([
    { done: true, done_reason: 'stop', message: { content: 'Answer' } }
  ]);
  const compiled = await provider.compileRequest(request);
  await provider.completeCompiled(compiled);
  assert.equal(compiled.body.truncate, false);
  assert.equal(compiled.body.shift, false);
  const { stream, ...body } = sent[0];
  assert.equal(stream, true);
  assert.deepEqual(body, compiled.body);
});

test('Ollama preserves distinct native call identities through streaming and result replay', async () => {
  const ids = ['original-call-a', 'original-call-b'];
  const { provider } = fixture([
    ...ids.map((id) => ({
      message: {
        tool_calls: [
          { id, function: { name: 'read_source', arguments: { query: 'same request' } } }
        ]
      },
      done: false
    })),
    { done: true, done_reason: 'stop', message: { content: '' } }
  ]);
  const events = [];
  for await (const event of provider.stream(request)) events.push(event);
  const response = events.at(-1).response;
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_call').map((event) => event.toolCall.id),
    ids
  );
  assert.deepEqual(
    response.toolCalls.map((call) => call.id),
    ids
  );
  const messages = [
    ...request.messages,
    { role: 'assistant', content: '', toolCalls: response.toolCalls },
    ...[...ids]
      .reverse()
      .map((id) => ({
        role: 'tool',
        content: `Result for ${id}`,
        toolName: 'read_source',
        toolCallId: id,
        toolCallType: 'function'
      }))
  ];
  const compiled = await provider.compileRequest({ ...request, messages });
  assert.deepEqual(
    compiled.body.messages[1].tool_calls.map((call) => call.id),
    ids
  );
  assert.deepEqual(
    compiled.body.messages.slice(2).map((message) => message.tool_call_id),
    [...ids].reverse()
  );
});

for (const [status, code, retryable] of [
  [400, 'invalid_request', false],
  [429, 'rate_limited', true],
  [503, 'provider_unavailable', true]
])
  for (const partial of [false, true])
    test(`Ollama streamed HTTP ${status} preserves its disposition after partial output=${partial}`, async () => {
      const { provider } = fixture([
        ...(partial ? [{ message: { thinking: 'Already received reasoning' }, done: false }] : []),
        { error: 'Provider explanation', status }
      ]);
      await assert.rejects(provider.complete(request), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable && !partial);
        assert.match(error.message, /Provider explanation/);
        return true;
      });
    });
