import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';
import { modelOutputToInput } from '@agent-core/model';

// Exact deterministic wire fixtures through the OpenRouter endpoint. These IDs are fixture labels, not live model availability claims.
for (const fixture of [
  { model: 'fixture/qwen', fields: { reasoning_content: 'Original preserved thinking\nunchanged' } },
  { model: 'fixture/glm', fields: { reasoning_content: 'Preserved sequence A → B' } },
  { model: 'fixture/kimi', fields: { reasoning: 'Original reasoning field', reasoning_details: [{ type: 'reasoning.encrypted', data: 'OPAQUE+/=', id: 'reasoning1', format: 'unknown', index: 0 }] } }
]) {
  test(`${fixture.model} keeps required Chat reasoning fields separate from display text`, async () => {
    const calls = [];
    const provider = new OpenRouterProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
      if (!init?.body) return Response.json({ data: [{ id: fixture.model, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'max_tokens'] }] });
      calls.push(JSON.parse(init.body));
      return Response.json({ id: 'r1', model: fixture.model, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', ...fixture.fields, tool_calls: [{ id: 'call-original', type: 'function', function: { name: 'lookup', arguments: '{"path":"a"}' } }] } }] });
    } });
    const request = { model: fixture.model, messages: [{ role: 'developer', content: 'developer policy' }, { role: 'user', content: 'question' }], maxOutputTokens: 100 };
    const first = await provider.complete(request);
    assert.equal(first.output[0].type, 'protocol');
    assert.equal(first.output[0].state.kind, 'chat.reasoning');
    const replay = { ...request, messages: [...request.messages, ...modelOutputToInput(first.output), { role: 'tool', content: 'result', toolName: 'lookup', toolCallId: 'call-original', toolCallType: 'function' }] };
    await provider.complete(replay);
    for (const [key, value] of Object.entries(fixture.fields)) assert.deepEqual(calls[1].messages[2][key], value);
    assert.equal(calls[1].messages[0].role, 'developer');
    assert.equal(calls[1].messages[2].tool_calls[0].id, 'call-original');
    await assert.rejects(() => provider.complete({ ...replay, messages: [{ role: 'developer', content: 'edited policy' }, ...replay.messages.slice(1)] }), /Earlier input/u);
  });
}

test('streamed Chat signatures concatenate only payload deltas and retain stable indices', async () => {
  let sent;
  const model = 'fixture/reasoning';
  const provider = new OpenRouterProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
    if (!init?.body) return Response.json({ data: [{ id: model, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['max_tokens'] }] });
    sent = JSON.parse(init.body);
    if (!sent.stream) return Response.json({ id: 'r2', model, choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
    const chunks = [
      { id: 'r1', model, choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', id: 'reasoning1', index: 0, text: 'A', signature: 'sig' }] } }] },
      { id: 'r1', model, choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', id: 'reasoning1', index: 0, text: 'B', signature: '+/=' }] } }] },
      { id: 'r1', model, choices: [{ finish_reason: 'stop', delta: { content: 'answer' } }] }
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  } });
  const request = { model, messages: [{ role: 'user', content: 'question' }], maxOutputTokens: 100 };
  let response;
  for await (const event of provider.stream(request)) if (event.type === 'done') response = event.response;
  await provider.complete({ ...request, messages: [...request.messages, ...modelOutputToInput(response.output), { role: 'user', content: 'next' }] });
  assert.deepEqual(sent.messages[1].reasoning_details, [{ type: 'reasoning.text', id: 'reasoning1', index: 0, text: 'AB', signature: 'sig+/=' }]);
});
