import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { modelOutputToInput, parseModelRequest, parseModelToolCall } from '@agent-core/model';
import { decodeResponsesPayload, responsesCaller, responsesTool } from '@agent-core/provider-openai-responses';

const request = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Look up records.' }], maxOutputTokens: 100 };
const parameters = { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false };
const outputSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
const tool = overrides => ({ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters }, outputSchema, ...overrides });
const program = { type: 'program', id: 'program-item', call_id: 'program-1', code: 'text(await tools.lookup({key:"a"}))', fingerprint: 'opaque-program-fingerprint' };
const child = { type: 'function_call', call_id: 'child-1', name: 'lookup', arguments: '{"key":"a"}', caller: { type: 'program', caller_id: program.call_id } };
const programOutput = { type: 'program_output', call_id: program.call_id, result: '{"value":"a"}', status: 'completed' };
const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer.' }] };
const response = (id, output) => ({ id, model: request.model, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } });

function scripted(outputs, bodies = []) {
  return new OpenAIProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const output = outputs.shift();
    if (!output) throw new Error('Unexpected request');
    return Response.json(response(`response-${bodies.length}`, output));
  } });
}

test('native program replay preserves origin, result caller and final-message continuation', async () => {
  const bodies = [];
  const provider = scripted([[program, child], [programOutput], [message]], bodies);
  const input = { ...request, tools: [tool({ allowedCallers: ['programmatic'] })] };
  const first = await provider.complete(input);
  assert.deepEqual(bodies[0].tools, [responsesTool(input.tools[0]), { type: 'programmatic_tool_calling' }]);
  assert.deepEqual(first.toolCalls[0].caller, { type: 'programmatic', callerId: program.call_id });
  assert.equal(first.output[0].state.kind, 'responses.tools');
  assert.deepEqual(first.output[0].state.data.items, [program]);
  const result = { role: 'tool', content: '{"value":"a"}', toolName: 'lookup', toolCallId: 'child-1', toolCallType: 'function', caller: first.toolCalls[0].caller };
  const continuation = { ...input, messages: [...input.messages, ...modelOutputToInput(first.output), result] };
  await assert.rejects(provider.compileRequest({ ...continuation, messages: [...continuation.messages.slice(0, -1), { ...result, caller: undefined }] }), /original program caller/u);
  const second = await provider.complete(continuation);
  assert.equal(second.terminationReason, 'continuation');
  assert.deepEqual(bodies[1].input.find(item => item.type === 'program'), program);
  assert.deepEqual(bodies[1].input.at(-1).caller, child.caller);
  const third = await provider.complete({ ...continuation, messages: [...continuation.messages, ...modelOutputToInput(second.output)] });
  assert.equal(third.terminationReason, 'stop');
  assert.equal(third.content, 'Answer.');
  assert.deepEqual(bodies[2].input.find(item => item.type === 'program_output'), programOutput);
});

test('deferred tools require exact admitted definitions loaded by completed hosted discovery', async () => {
  const deferred = tool({ deferLoading: true });
  const search = { type: 'tool_search_call', execution: 'server', call_id: null, status: 'completed', arguments: { query: 'lookup' } };
  const loaded = { type: 'tool_search_output', execution: 'server', call_id: null, status: 'completed', tools: [responsesTool(deferred)] };
  const directCall = { ...child, caller: { type: 'direct' } };
  const bodies = [];
  const provider = scripted([[search, loaded, directCall]], bodies);
  const result = await provider.complete({ ...request, tools: [deferred] });
  assert.equal(result.toolCalls[0].name, 'lookup');
  assert.equal(result.toolCalls[0].caller, undefined);
  assert.deepEqual(result.output.slice(0, 2).map(item => item.state.data.items[0]), [search, loaded]);
  assert.deepEqual(bodies[0].tools.at(-1), { type: 'tool_search' });
  for (const output of [[directCall], [search, { ...loaded, tools: [{ ...responsesTool(deferred), description: 'changed' }] }, directCall], [{ ...search, execution: 'client', call_id: 'client' }]]) {
    await assert.rejects(scripted([output]).complete({ ...request, tools: [deferred] }), /loaded|changed|hosted/u);
  }
  assert.equal(decodeResponsesPayload({ output: [search] }).output[0].call_id, null);
  assert.deepEqual(decodeResponsesPayload({ output: [search] }).output[0].arguments, { query: 'lookup' });
});

test('caller decoding handles direct/null and rejects malformed or unadmitted program origins', async () => {
  for (const wire of [undefined, null, { type: 'direct' }]) assert.equal(responsesCaller(wire, 'openai'), undefined);
  for (const wire of [{ type: 'program', caller_id: ' ' }, { type: 'direct', caller_id: 'bad' }, { type: 'program', caller_id: 'p', extra: true }, 2])
    assert.throws(() => responsesCaller(wire, 'openai'), /caller/u);
  for (const output of [[child], [program, { ...child, caller: { type: 'program', caller_id: 'forged' } }], [programOutput]])
    await assert.rejects(scripted([output]).complete({ ...request, tools: [tool({ allowedCallers: ['programmatic'] })] }), /origin/u);
  await assert.rejects(scripted([[program, child]]).complete({ ...request, tools: [tool({})] }), /Unadvertised program/u);
  const directUnknown = await scripted([[{ ...child, name: 'unknown', caller: null }]]).complete(request);
  assert.equal(directUnknown.toolCalls[0].name, 'unknown', 'ordinary unknown direct calls remain executor-owned failures');
});

test('unsupported models and endpoints reject advanced modes before transmission', async () => {
  let sends = 0;
  for (const options of [{}, { baseUrl: 'https://compatible.example/v1' }]) {
    const provider = new OpenAIProvider({ apiKey: 'fixture', ...options, fetch: async () => { sends++; return Response.json(response('unexpected', [message])); } });
    for (const exposure of [{ deferLoading: true }, { allowedCallers: ['programmatic'] }])
      await assert.rejects(provider.complete({ ...request, model: options.baseUrl ? 'gpt-6-astra' : 'gpt-5.6-sol', tools: [tool(exposure)] }), /not declared/u);
  }
  assert.equal(sends, 0);
});

test('canonical model contracts own exposure and caller metadata and reject field smuggling', () => {
  const authored = { ...request, tools: [tool({ deferLoading: true, allowedCallers: ['direct', 'programmatic'] })] };
  const owned = parseModelRequest(authored);
  authored.tools[0].allowedCallers.pop();
  assert.deepEqual(owned.tools[0].allowedCallers, ['direct', 'programmatic']);
  assert(Object.isFrozen(owned.tools[0].outputSchema.properties));
  const call = { id: 'call', type: 'function', name: 'lookup', input: { kind: 'json', value: { key: 'a' } }, caller: { type: 'programmatic', callerId: 'program' } };
  assert(Object.isFrozen(parseModelToolCall(call).caller));
  assert.throws(() => parseModelToolCall({ ...call, parent: 'forged' }), /unsupported fields/u);
  assert.throws(() => parseModelToolCall({ ...call, caller: { ...call.caller, parent: 'forged' } }), /caller/u);
  for (const exposure of [{ allowedCallers: [] }, { allowedCallers: ['direct', 'direct'] }, { allowedCallers: ['other'] }, { deferLoading: 'true' }, { outputSchema: [] }])
    assert.throws(() => parseModelRequest({ ...request, tools: [tool(exposure)] }));
});

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  constructor(dispatch) { super(); this.dispatch = dispatch; }
  send(value) { const body = JSON.parse(value); this.sent.push(body); this.dispatch(body, this); }
  close() { this.readyState = 3; }
  feed(...values) { for (const value of values) this.emit('message', JSON.stringify(value)); }
}

test('native websocket validates ordered program output before exposing children and preserves caller on delivery', async () => {
  let socket;
  let source;
  let completed = false;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new Socket((body, ws) => {
    if (!body.previous_response_id) {
      ws.feed({ type: 'response.created', response: { id: 'native-1' } },
        { type: 'response.output_item.done', item: program },
        { type: 'response.output_item.done', item: child });
      completed = true;
      ws.feed({ type: 'response.completed', response: response('native-1', [program, child]) });
    } else {
      assert.deepEqual(body.input[0].caller, child.caller);
      ws.feed({ type: 'response.created', response: { id: 'native-2', previous_response_id: 'native-1' } },
        { type: 'response.completed', response: response('native-2', [programOutput, message]) });
    }
  }) });
  const session = provider.createSession();
  const events = [];
  try {
    for await (const event of session.stream({ ...request, tools: [tool({ allowedCallers: ['programmatic'] })] }, { native: { admit: async () => {} } })) {
      events.push(event);
      if (event.type === 'tool_call') { assert(completed); source = event.source; }
      if (event.type === 'response_boundary' && event.response.requestId === 'native-1') {
        const result = { role: 'tool', toolName: 'lookup', toolCallId: 'child-1', toolCallType: 'function', content: '{"value":"a"}', caller: event.response.toolCalls[0].caller };
        await assert.rejects(session.deliverToolResults({ deliveryId: 'forged', responseId: 'native-1', sourceCalls: [source], results: [{ ...result, caller: undefined }] }), /unmatched/u);
        await session.deliverToolResults({ deliveryId: 'real', responseId: 'native-1', sourceCalls: [source], results: [result] });
      }
    }
    assert.equal(events.filter(event => event.type === 'tool_call').length, 1);
    assert.equal(events.at(-1).response.content, 'Answer.');
    assert.equal(socket.sent.length, 2);
  } finally { await session.close(); }
});

test('advanced SSE custom calls cannot escape before their program origin is validated', async () => {
  const custom = { type: 'custom', name: 'lookup', format: { type: 'text' }, allowedCallers: ['programmatic'] };
  const raw = { type: 'custom_tool_call', call_id: 'custom-1', name: 'lookup', input: 'source', caller: { type: 'program', caller_id: 'missing' } };
  const payloads = [
    { type: 'response.output_item.added', output_index: 0, item: raw },
    { type: 'response.custom_tool_call_input.done', output_index: 0, input: 'source' },
    { type: 'response.output_item.done', output_index: 0, item: raw },
    { type: 'response.completed', response: response('sse', [raw]) }
  ];
  const body = payloads.map(value => `data: ${JSON.stringify(value)}\n\n`).join('');
  const provider = new OpenAIProvider({ apiKey: 'fixture', fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  let calls = 0;
  await assert.rejects(async () => {
    for await (const event of provider.stream({ ...request, tools: [custom] })) if (event.type === 'tool_call') calls++;
  }, /origin/u);
  assert.equal(calls, 0);
});

test('program tools are pinned at program start and completed programs cannot acquire new children', async () => {
  const deferred = tool({ deferLoading: true, allowedCallers: ['programmatic'] });
  const loaded = { type: 'tool_search_output', execution: 'server', call_id: null, status: 'completed', tools: [responsesTool(deferred)] };
  await assert.rejects(scripted([[program, loaded, child]]).complete({ ...request, tools: [deferred] }), /origin/u);
  await assert.rejects(scripted([[program, programOutput, child]]).complete({ ...request, tools: [tool({ allowedCallers: ['programmatic'] })] }), /origin/u);
  await assert.rejects(scripted([[program, { ...program, code: 'different' }, child]]).complete({ ...request, tools: [tool({ allowedCallers: ['programmatic'] })] }), /reused/u);
  assert.throws(() => responsesTool({ type: 'custom', name: 'custom', format: { type: 'text' }, outputSchema }), /do not support output_schema/u);
});
