import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeProvider } from '@agent-core/provider-claude';
import { modelOutputToInput, parseModelStreamEvent, assertRequestAccountingFits } from '@agent-core/model';

const initial = { model: 'claude-sonnet-4-6', messages: [{ role: 'system', content: 'system authority' }, { role: 'user', content: 'do work' }], maxOutputTokens: 3000, reasoning: { strategy: 'budget', maxTokens: 1024 } };
const blocks = [{ type: 'thinking', thinking: 'display summary', signature: 'SIGNED=exact+bytes' }, { type: 'redacted_thinking', data: 'OPAQUE+/=' }, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'tool-exact-1', name: 'lookup', input: { key: 'value' } }];
const payload = { type: 'message', id: 'msg-1', model: 'claude-sonnet-4-6', role: 'assistant', content: blocks, stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } };

test('Claude preserves exact signed/redacted thinking order and tool identity across replay', async () => {
  const sent = [];
  const provider = new ClaudeProvider({ apiKey: 'fixture', fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json(payload); } });
  const response = await provider.complete(initial);
  assert.deepEqual(response.output.map(item => item.type), ['protocol', 'protocol', 'text', 'tool_call']);
  assert.deepEqual(response.usage, { promptTokens: 9, completionTokens: 5, totalTokens: 14, cacheReadTokens: 2, cacheWriteTokens: 3 });
  const replay = { ...initial, messages: [...initial.messages, ...modelOutputToInput(response.output), { role: 'tool', content: 'result', toolName: 'lookup', toolCallId: 'tool-exact-1', toolCallType: 'function' }] };
  await provider.complete(replay);
  assert.deepEqual(sent[1].messages[1].content, blocks);
  assert.equal(sent[1].messages[2].content[0].tool_use_id, 'tool-exact-1');
  assert.equal(sent[1].system[0].text, 'system authority');
  await assert.rejects(() => provider.complete({ ...replay, messages: [{ role: 'system', content: 'edited earlier instruction' }, ...replay.messages.slice(1)] }), /Earlier input/u);
  const other = new ClaudeProvider({ apiKey: 'fixture', baseUrl: 'https://another.test/v1', fetch: async () => { throw new Error('must not dispatch'); } });
  await assert.rejects(() => other.complete(replay), /endpoint/u);
});

test('Claude rejects role promotion, unsupported media, malformed reasoning and unavailable models before dispatch', async () => {
  let calls = 0;
  const provider = new ClaudeProvider({ apiKey: 'fixture', fetch: async () => { calls++; return Response.json({ ...payload, content: [{ type: 'thinking', thinking: 'unsigned' }] }); } });
  await assert.rejects(() => provider.complete({ ...initial, messages: [{ role: 'developer', content: 'guidance' }] }), /Role developer/u);
  await assert.rejects(() => provider.complete({ ...initial, messages: [{ role: 'user', content: '', parts: [{ type: 'video', mediaType: 'video/mp4', source: { type: 'url', value: 'https://media.test/movie' } }] }] }), /video/u);
  await assert.rejects(() => provider.describeModel('claude-unverified-future'), /verified/u);
  assert.equal(calls, 0);
  await assert.rejects(() => provider.complete(initial), /signature/u);
});

test('Claude streaming assembles signature deltas exactly and rejects disconnects', async () => {
  const chunks = [
    { type: 'message_start', message: { ...payload, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'summary' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig+' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '/=' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' }
  ];
  const stream = list => new Response(list.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''));
  const provider = new ClaudeProvider({ apiKey: 'fixture', fetch: async () => stream(chunks) });
  const events = [];
  for await (const event of provider.stream(initial)) events.push(parseModelStreamEvent(event));
  assert.equal(events.at(-1).response.output[0].state.data.block.signature, 'sig+/=');
  assert.equal(events.at(-1).response.reasoningSummary, 'summary');
  const disconnected = new ClaudeProvider({ apiKey: 'fixture', fetch: async () => stream(chunks.slice(0, -1)) });
  await assert.rejects(async () => { for await (const event of disconnected.stream(initial)) void event; }, /message_stop/u);
});

test('Claude bounded provider counting resolves opaque/media admission and sends the same output cap', async () => {
  const calls = [];
  const provider = new ClaudeProvider({ apiKey: 'fixture', countTokens: true, fetch: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return Response.json(url.endsWith('count_tokens') ? { input_tokens: 25 } : payload); } });
  const compiled = await provider.compileRequest(initial);
  assert.equal(compiled.accounting.method.name, 'provider-count');
  assert.equal(compiled.accounting.estimatedInputTokens, 25);
  assert.equal(compiled.accounting.outputReservation, compiled.body.max_tokens);
  assert.doesNotThrow(() => assertRequestAccountingFits(compiled.accounting));
  await provider.completeCompiled(compiled);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1].messages, calls[1][1].messages);
  assert.equal('max_tokens' in calls[0][1], false);
});
