import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { modelOutputToInput, parseModelStreamEvent, parseModelContextTransformResult, modelInputIdentity, requestAccountingInputTokens } from '@agent-core/model';

class FixtureSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  constructor(dispatch) { super(); this.dispatch = dispatch; }
  send(data) { const body = JSON.parse(data); this.sent.push(body); this.dispatch(body, this); }
  close() { this.readyState = 3; }
  feed(...events) { for (const event of events) this.emit('message', JSON.stringify(event)); }
}
const textOutput = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
const response = (id, text, extras = {}) => ({ id, model: 'gpt-6-astra', status: 'completed', output: textOutput(text), usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }, ...extras });
const streamNative = async function* (provider, session, input, admit = async () => {}) {
  yield* session.streamCompiled(await provider.compileRequest(input), { native: { admit } });
};
const request = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'initial' }], maxOutputTokens: 100 };

test('native steering traces submitted, acknowledged and applied with original response IDs and aggregate usage', async () => {
  let socket;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((body, ws) => {
    if (body.type === 'response.create') ws.feed({ type: 'response.created', response: { id: 'r1' } }, { type: 'response.output_text.delta', delta: 'first' });
    if (body.type === 'response.steer') ws.feed(
      { type: 'response.steer.accepted', steer: { id: 'steer1', previous_response_id: 'r1' } },
      { type: 'response.incomplete', response: response('r1', 'first', { status: 'incomplete', incomplete_details: { reason: 'steered' } }) },
      { type: 'response.created', response: { id: 'r2' } },
      { type: 'response.output_text.delta', delta: 'second' },
      { type: 'response.completed', response: response('r2', 'second') }
    );
  }) });
  const session = provider.createSession();
  const events = [];
  for await (const raw of streamNative(provider, session, request)) {
    const event = parseModelStreamEvent(raw); events.push(event);
    if (event.type === 'response_started' && event.responseId === 'r1') {
      const submitted = await session.steer({ deliveryId: 'input-7', responseId: 'r1', input: [{ role: 'user', content: 'correction' }] });
      assert.equal(submitted.status, 'submitted');
      assert.equal((await session.steer({ deliveryId: 'input-7', responseId: 'r1', input: [{ role: 'user', content: 'correction' }] })).status, 'submitted');
      await assert.rejects(() => session.steer({ deliveryId: 'input-7', responseId: 'r1', input: [{ role: 'user', content: 'changed correction' }] }), /reused/u);
    }
  }
  assert.deepEqual(events.filter(event => event.type === 'steering').map(event => event.delivery.status), ['submitted', 'acknowledged', 'applied']);
  assert.deepEqual(events.filter(event => event.type === 'response_boundary').map(event => event.response.requestId), ['r1', 'r2']);
  assert.equal(events.at(-1).response.content, 'firstsecond');
  assert.deepEqual(events.at(-1).response.usage, { promptTokens: 8, completionTokens: 4, totalTokens: 12 });
  assert.equal((await session.steeringStatus('input-7')).status, 'applied');
  assert.equal(socket.sent.filter(item => item.type === 'response.create').length, 1, 'automatic continuation is not duplicated locally');
  assert.equal(socket.sent.filter(item => item.type === 'response.steer').length, 1, 'same delivery does not send twice');
  assert.deepEqual(socket.sent[1], { type: 'response.steer', previous_response_id: 'r1', input: [{ role: 'user', content: 'correction' }] });
  await session.close();
});

test('disconnect after steering acknowledgment leaves explicit uncertain delivery and never retries', async () => {
  let socket;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((body, ws) => {
    if (body.type === 'response.create') ws.feed({ type: 'response.created', response: { id: 'r1' } });
    if (body.type === 'response.steer') ws.feed({ type: 'response.steer.accepted', steer: { id: 'steer1', previous_response_id: 'r1' } });
  }) });
  const session = provider.createSession(); const states = [];
  await assert.rejects(async () => {
    for await (const event of streamNative(provider, session, request)) {
      if (event.type === 'response_started') await session.steer({ deliveryId: 'input-8', responseId: 'r1', input: [{ role: 'user', content: 'correction' }] });
      if (event.type === 'steering') { states.push(event.delivery.status); if (event.delivery.status === 'acknowledged') socket.emit('close'); }
    }
  }, /disconnected/u);
  assert.deepEqual(states, ['submitted', 'acknowledged', 'uncertain']);
  assert.equal((await session.steeringStatus('input-8')).status, 'uncertain');
  assert.equal(socket.sent.length, 2);
});

test('async tools and appended configuration are exact-model capabilities and preserve delayed call IDs', async () => {
  const sent = [];
  const tool = { type: 'function', async: true, function: { name: 'lookup', parameters: { type: 'object', properties: {} } } };
  const call = { type: 'function_call', call_id: 'async-exact', name: 'lookup', arguments: '{}', async: true };
  const provider = new OpenAIProvider({ apiKey: 'fixture', fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json(response('r1', '', { output: [call] })); } });
  const first = await provider.complete({ ...request, tools: [tool] });
  assert.equal(first.output[0].toolCall.async, true);
  await provider.complete({ ...request, tools: [tool], messages: [...request.messages, ...modelOutputToInput(first.output), { role: 'user', content: 'independent work' }, { role: 'control', content: '', update: { id: 'config-2', type: 'configuration', reasoning: { strategy: 'effort', effort: 'high' } } }, { role: 'tool', content: 'late result', toolName: 'lookup', toolCallId: 'async-exact', toolCallType: 'function' }] });
  assert.equal(sent[0].tools[0].async, true);
  assert.equal(sent[1].input.at(-1).call_id, 'async-exact');
  assert.deepEqual(sent[1].input.at(-2), { type: 'configuration_update', reasoning: { effort: 'high' } });
  await assert.rejects(() => provider.complete({ ...request, model: 'gpt-5.6-sol', tools: [tool] }), /Asynchronous/u);
  const custom = new OpenAIProvider({ apiKey: 'fixture', baseUrl: 'https://custom.test/v1' });
  assert.equal((await custom.describeModel('gpt-6-astra')).capabilities.protocol.asyncTools, false);
});

test('native compaction replays the entire returned window and records exact origin and usage', async () => {
  const canonical = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained original' }] }, { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque==' }];
  const sent = [];
  const provider = new OpenAIProvider({ apiKey: 'fixture', fetch: async (url, init) => { sent.push([url, JSON.parse(init.body)]); return Response.json(url.endsWith('/compact') ? { id: 'compacted', output: canonical, usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } } : response('r-next', 'done')); } });
  const transformed = await provider.transformContext({ transformId: 'transition-1', request });
  assert.equal(transformed.transformId, 'transition-1');
  assert.equal(transformed.state.origin.requestId, 'compacted');
  assert.equal(transformed.usage.totalTokens, 28);
  await provider.complete({ ...request, messages: [...transformed.input, { role: 'user', content: 'next' }] });
  assert.deepEqual(sent[1][1].input.slice(0, 2), canonical);
});

test('native compaction admits its exact payload once and binds transform dispatch to the original identity', async () => {
  const sent = [];
  const provider = new OpenAIProvider({ apiKey: 'fixture', fetch: async (url, init) => {
    sent.push([url, JSON.parse(init.body)]);
    return Response.json({ id: 'compaction-exact', output: [{ type: 'compaction', encrypted_content: 'opaque==' }], usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } });
  } });
  const source = { ...request, messages: request.messages.map(item => ({ ...item })), tools: [{ type: 'function', function: { name: 'unused_schema', parameters: { description: 'x'.repeat(30000) } } }], reasoning: { strategy: 'effort', effort: 'high' } };
  const compiled = await provider.compileContextTransform({ transformId: 'transform-exact', request: source });
  assert.equal(sent.length, 0);
  assert.deepEqual(Object.keys(compiled.body).sort(), ['input', 'model']);
  assert.equal(compiled.endpoint, 'https://api.openai.com/v1/responses/compact');
  assert.equal(compiled.accounting.outputReservation, 100);
  assert.equal(compiled.accounting.outputReservationSource, 'policy');
  assert.ok(compiled.accounting.estimatedInputTokens < 1000, 'unused generation tool schemas do not inflate compaction accounting');
  source.messages[0].content = 'changed after admission';
  await assert.rejects(() => provider.transformContextCompiled('wrong-id', compiled), /not admitted/u);
  assert.throws(() => provider.completeCompiled(compiled), /not admitted/u);
  const transformed = await provider.transformContextCompiled('transform-exact', compiled);
  assert.deepEqual(sent[0], [compiled.endpoint, compiled.body]);
  assert.deepEqual(parseModelContextTransformResult(JSON.parse(JSON.stringify(transformed))), transformed);
  assert.throws(() => parseModelContextTransformResult({ ...transformed, usage: { promptTokens: -1, completionTokens: 0, totalTokens: -1 } }), /usage/u);
  assert.equal(sent.length, 1);
});

test('failed native steering after original completion settles without waiting for an impossible successor', async () => {
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', streamIdleTimeoutMs: 100, webSocketFactory: () => new FixtureSocket((body, ws) => {
    if (body.type === 'response.create') ws.feed({ type: 'response.created', response: { id: 'r1' } });
    if (body.type === 'response.steer') ws.feed(
      { type: 'response.steer.accepted', steer: { id: 'steer1', previous_response_id: 'r1' } },
      { type: 'response.completed', response: response('r1', 'finished') },
      { type: 'response.steer.failed', steer: { id: 'steer1', previous_response_id: 'r1', input: body.input }, error: { code: 'failed' } }
    );
  }) });
  const session = provider.createSession(); let final;
  for await (const event of streamNative(provider, session, request)) {
    if (event.type === 'response_started') await session.steer({ deliveryId: 'input-failed', responseId: event.responseId, input: [{ role: 'user', content: 'update' }] });
    if (event.type === 'done') final = event.response;
  }
  assert.equal(final.content, 'finished');
  assert.equal((await session.steeringStatus('input-failed')).status, 'failed');
  await session.close();
});

test('native pending steering accepts only its original tool result and never duplicates delivery', async () => {
  let socket;
  const toolCall = { type: 'function_call', call_id: 'pending-1', name: 'lookup', arguments: '{}' };
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((body, ws) => {
    if (body.type === 'response.create' && !body.previous_response_id) ws.feed({ type: 'response.created', response: { id: 'r1' } });
    if (body.type === 'response.steer') ws.feed(
      { type: 'response.steer.accepted', steer: { id: 'steer1', previous_response_id: 'r1' } },
      { type: 'response.completed', response: response('r1', '', { output: [toolCall] }) },
      { type: 'response.steer.pending', steer: { id: 'steer1', previous_response_id: 'r1' }, required_input: [{ type: 'function_call_output', call_id: 'pending-1', name: 'lookup' }] }
    );
    if (body.type === 'response.create' && body.previous_response_id) ws.feed({ type: 'response.created', response: { id: 'r2' } }, { type: 'response.completed', response: response('r2', 'after tool') });
  }) });
  const session = provider.createSession();
  let source;
  for await (const event of streamNative(provider, session, request)) {
    if (event.type === 'response_boundary') source = event.native.pendingToolCalls[0];
    if (event.type === 'response_started' && event.responseId === 'r1') await session.steer({ deliveryId: 'input-pending', responseId: 'r1', input: [{ role: 'user', content: 'update' }] });
    if (event.type === 'steering' && event.delivery.status === 'acknowledged' && event.delivery.detail) {
      const tool = { role: 'tool', content: 'result', toolName: 'lookup', toolCallId: 'pending-1', toolCallType: 'function' };
      await assert.rejects(() => session.deliverToolResults({ deliveryId: 'bad', responseId: 'r1', sourceCalls: [source], results: [{ ...tool, toolCallId: 'forged' }] }), /unmatched/u);
      await assert.rejects(() => session.deliverToolResults({ deliveryId: 'duplicate', responseId: 'r1', sourceCalls: [source, source], results: [tool, tool] }), /already delivered/u);
      await assert.rejects(() => session.deliverToolResults({ deliveryId: 'empty', responseId: 'r1', sourceCalls: [], results: [] }), /empty/u);
      await session.deliverToolResults({ deliveryId: 'result-1', responseId: 'r1', sourceCalls: [source], results: [tool] });
      tool.content = 'mutated after dispatch';
      await assert.rejects(() => session.deliverToolResults({ deliveryId: 'result-1', responseId: 'r1', sourceCalls: [source], results: [tool] }), /reused/u);
    }
  }
  assert.equal(socket.sent[2].previous_response_id, 'r1');
  assert.equal(socket.sent[2].input[0].call_id, 'pending-1');
  assert.equal(socket.sent[2].input[0].output, 'result');
  assert.equal((await session.steeringStatus('input-pending')).status, 'applied');
  await session.close();
});

const asyncTool = { type: 'function', async: true, function: { name: 'lookup', parameters: { type: 'object', properties: {} } } };
const asyncCall = id => ({ type: 'function_call', call_id: id, name: 'lookup', arguments: '{}', async: true });
const resultInput = (id, content = 'saved result') => ({ role: 'tool', content, toolName: 'lookup', toolCallId: id, toolCallType: 'function' });

test('independent asynchronous results cross successor and catalog boundaries without steering or duplicate sends', async () => {
  let socket;
  const admitted = [];
  let currentAdmission;
  const events = [];
  let originalSource;
  let lateFinished = false;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((body, ws) => {
    if (!body.previous_response_id) {
      ws.feed({ type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.done', response_id: 'r1', item: asyncCall('slow-original') },
        { type: 'response.output_text.delta', response_id: 'r1', delta: 'Independent answer while lookup runs.' },
        { type: 'response.completed', response: response('r1', '', { output: [asyncCall('slow-original'), ...textOutput('first independent answer')] }) });
    } else {
      assert.deepEqual(body, currentAdmission.compiled.body, 'send uses exactly the admitted frame');
      if (body.previous_response_id === 'r1') {
        assert.equal(lateFinished, false, 'R2 starts while original result is still pending');
        ws.feed({ type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } });
      } else {
        assert.equal(body.previous_response_id, 'r2');
        ws.feed({ type: 'response.created', response: { id: 'r3', previous_response_id: 'r2' } },
          { type: 'response.completed', response: response('r3', 'final with late result') });
      }
    }
  }) });
  const session = provider.createSession();
  for await (const raw of streamNative(provider, session, { ...request, tools: [asyncTool] }, async dispatch => {
    assert(Object.isFrozen(dispatch.compiled));
    assert(Object.isFrozen(dispatch.compiled.body));
    assert.equal(dispatch.compiled.inputIdentity, await modelInputIdentity({ body: dispatch.compiled.body, retainedBody: dispatch.compiled.retainedBody }));
    assert(requestAccountingInputTokens(dispatch.compiled.accounting) > 0);
    currentAdmission = dispatch;
    admitted.push(dispatch);
  })) {
    const event = parseModelStreamEvent(raw);
    events.push(event);
    if (event.type === 'tool_call') originalSource = event.source;
    if (event.type === 'response_boundary' && event.response.requestId === 'r1') {
      assert.deepEqual(event.native.pendingToolCalls, [originalSource]);
      await session.continueNative({ deliveryId: 'independent-2', responseId: 'r1', input: [{ role: 'user', content: 'Handle this independent request too.' }, { role: 'control', content: '', update: { id: 'reasoning-2', type: 'configuration', reasoning: { strategy: 'effort', effort: 'high' } } }], tools: [] });
    }
    if (event.type === 'response_started' && event.responseId === 'r2') {
      assert.notEqual(event.native.catalogIdentity, originalSource.catalogIdentity);
      await new Promise(resolve => setTimeout(resolve, 10));
      lateFinished = true;
      await assert.rejects(() => session.deliverToolResults({ deliveryId: 'too-early', responseId: 'r2', results: [resultInput('slow-original')], sourceCalls: [originalSource] }), /completed response boundary/u);
      socket.feed({ type: 'response.completed', response: response('r2', 'second independent answer') });
    }
    if (event.type === 'response_boundary' && event.response.requestId === 'r2') {
      const submission = { deliveryId: 'late-result', responseId: 'r2', results: [resultInput('slow-original')], sourceCalls: [originalSource] };
      await assert.rejects(() => session.deliverToolResults({ ...submission, deliveryId: 'forged-catalog', sourceCalls: [{ ...originalSource, catalogIdentity: event.native.catalogIdentity }] }), /unmatched/u);
      const [sent, repeated] = await Promise.all([session.deliverToolResults(submission), session.deliverToolResults(submission)]);
      assert.equal(sent.status, 'submitted');
      assert.equal(repeated.status, 'submitted');
      assert.equal((await session.deliverToolResults(submission)).status, 'submitted');
      submission.results[0].content = 'caller changed its result';
    }
  }
  const boundaries = events.filter(event => event.type === 'response_boundary');
  assert.deepEqual(boundaries.map(event => event.response.requestId), ['r1', 'r2', 'r3']);
  assert.deepEqual(boundaries.map(event => event.response.toolCalls?.length ?? 0), [1, 0, 0]);
  assert.deepEqual(boundaries[2].native.request.messages.map(item => item.role), ['user', 'assistant', 'assistant', 'user', 'control', 'assistant', 'tool']);
  assert.equal(boundaries[2].native.request.messages.at(-1).content, 'saved result');
  assert.equal(boundaries[2].native.generationDeliveryId, 'late-result');
  assert.deepEqual(events.filter(event => event.type === 'tool_result_delivery').map(event => event.delivery.status), ['submitted', 'acknowledged', 'applied']);
  assert.equal((await session.toolResultStatus('late-result')).successorResponseId, 'r3');
  assert.equal(socket.sent.length, 3);
  assert(socket.sent.every(body => body.type === 'response.create'));
  assert.equal(socket.sent[2].input[0].call_id, 'slow-original');
  assert.equal(admitted.length, 2);
  assert.equal(socket.sent[1].input.at(-1).type, 'configuration_update');
  assert.throws(() => parseModelStreamEvent({ ...boundaries[0], native: { ...boundaries[0].native, responseId: 'forged' } }), /identity conflicts/u);
  await session.close();
});

test('host admission blocks native writes and cancellation during admission is definitely unsent', async () => {
  let socket;
  const cancellation = new AbortController();
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((_body, ws) => ws.feed({ type: 'response.created', response: { id: 'r1' } })) });
  const session = provider.createSession();
  const compiled = await provider.compileRequest(request);
  const stream = session.streamCompiled(compiled, { native: { admit: async dispatch => {
    assert.equal(socket.sent.length, 1, 'admission precedes steer write');
    assert(dispatch.compiled.accounting.components.some(part => part.path === 'retainedBody.pendingOutput' && part.tokens === 100));
    cancellation.abort();
  } } });
  for await (const event of stream) {
    if (event.type === 'response_started') {
      await assert.rejects(() => session.steer({ deliveryId: 'cancelled', responseId: 'r1', input: [{ role: 'user', content: 'do more' }], signal: cancellation.signal }), /abort/u);
      assert.equal((await session.steeringStatus('cancelled')).status, 'failed');
      socket.feed({ type: 'response.completed', response: response('r1', 'original only') });
    }
  }
  assert.equal(socket.sent.length, 1);
  await session.close();
});

test('result send disconnect keeps uncertainty and original saved result without retransmission', async () => {
  let socket;
  let saved;
  let submission;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((body, ws) => {
    if (!body.previous_response_id) ws.feed({ type: 'response.created', response: { id: 'r1' } }, { type: 'response.completed', response: response('r1', '', { output: [asyncCall('late')] }) });
    else { saved = body.input[0].output; ws.emit('close'); }
  }) });
  const session = provider.createSession();
  await assert.rejects(async () => {
    for await (const event of streamNative(provider, session, { ...request, tools: [asyncTool] })) {
      if (event.type === 'response_boundary') {
        submission = { deliveryId: 'saved-delivery', responseId: 'r1', results: [resultInput('late')], sourceCalls: event.native.pendingToolCalls };
        assert.equal((await session.deliverToolResults(submission)).status, 'uncertain');
      }
    }
  }, /disconnected/u);
  assert.equal((await session.toolResultStatus('saved-delivery')).status, 'uncertain');
  assert.equal((await session.deliverToolResults(submission)).status, 'uncertain');
  assert.equal(saved, 'saved result');
  assert.equal(socket.sent.length, 2);
  await assert.rejects(() => session.deliverToolResults({ ...submission, deliveryId: 'new-id' }), /original connection/u);
  const next = await provider.compileRequest(request);
  await assert.rejects(() => session.completeCompiled(next), /Uncertain native delivery/u);
});

test('native continuation requires admission and compiled transport cancellation preserves per-instance ownership', async () => {
  let socket;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((_body, ws) => ws.feed({ type: 'response.created', response: { id: 'r1' } }, { type: 'response.completed', response: response('r1', 'done') })) });
  const session = provider.createSession();
  const compiled = await provider.compileRequest(request);
  assert.equal(compiled.body.type, 'response.create');
  for await (const event of session.streamCompiled(compiled)) {
    if (event.type === 'response_started') await assert.rejects(() => session.steer({ deliveryId: 'no-admission', responseId: 'r1', input: [{ role: 'user', content: 'more' }] }), /host admission/u);
  }
  assert.equal(socket.sent.length, 1);
  const cancelled = new AbortController(); cancelled.abort();
  const other = provider.createSession();
  await assert.rejects(() => other.completeCompiled(compiled, { signal: cancelled.signal }), /abort/u);
  assert.equal(socket.sent.length, 1);
  await assert.rejects(() => other.completeCompiled({ ...compiled }, { signal: new AbortController().signal }), /not admitted/u);
  assert(Object.isFrozen(compiled));
  await session.close();
});

test('mixed synchronous and asynchronous obligations deliver fast results without waiting for slow work', async () => {
  const fast = { type: 'function_call', call_id: 'fast-sync', name: 'lookup', arguments: '{}' };
  let socket;
  let sourceCalls;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((body, ws) => {
    if (!body.previous_response_id) ws.feed({ type: 'response.created', response: { id: 'r1' } }, { type: 'response.completed', response: response('r1', '', { output: [asyncCall('slow-async'), fast] }) });
    else {
      const id = body.previous_response_id === 'r1' ? 'r2' : 'r3';
      ws.feed({ type: 'response.created', response: { id, previous_response_id: body.previous_response_id } }, { type: 'response.completed', response: response(id, 'independent work') });
    }
  }) });
  const session = provider.createSession();
  for await (const event of streamNative(provider, session, { ...request, tools: [asyncTool] })) {
    if (event.type !== 'response_boundary') continue;
    if (event.response.requestId === 'r1') {
      sourceCalls = event.native.pendingToolCalls;
      assert.deepEqual(event.native.requiredToolCallIds, ['fast-sync']);
      await assert.rejects(() => session.continueNative({ deliveryId: 'blocked', responseId: 'r1', input: [] }), /Synchronous/u);
      await session.deliverToolResults({ deliveryId: 'fast-result', responseId: 'r1', results: [resultInput('fast-sync')], sourceCalls: [sourceCalls[1]] });
    } else if (event.response.requestId === 'r2') {
      assert.deepEqual(event.native.pendingToolCalls, [sourceCalls[0]]);
      await session.deliverToolResults({ deliveryId: 'slow-result', responseId: 'r2', results: [resultInput('slow-async')], sourceCalls: [sourceCalls[0]] });
    }
  }
  assert.deepEqual(socket.sent.slice(1).map(body => body.input[0].call_id), ['fast-sync', 'slow-async']);
  assert.equal((await session.toolResultStatus('slow-result')).status, 'applied');
  await session.close();
});

test('result admission rejection and cancellation retain saved results without crossing transport', async () => {
  let socket;
  let source;
  let failedInput;
  const controller = new AbortController();
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new FixtureSocket((_body, ws) => ws.feed({ type: 'response.created', response: { id: 'r1' } }, { type: 'response.completed', response: response('r1', '', { output: [asyncCall('cancel-late')] }) })) });
  const session = provider.createSession();
  await assert.rejects(async () => {
    for await (const event of session.streamCompiled(await provider.compileRequest({ ...request, tools: [asyncTool] }), { signal: controller.signal, native: { admit: async () => { throw new Error('owner budget exhausted'); } } })) {
      if (event.type === 'response_boundary') {
        source = event.native.pendingToolCalls[0];
        failedInput = { deliveryId: 'denied-result', responseId: 'r1', results: [resultInput('cancel-late')], sourceCalls: [source] };
        await assert.rejects(() => session.deliverToolResults(failedInput), /owner budget/u);
        assert.equal((await session.toolResultStatus('denied-result')).status, 'failed');
        controller.abort();
      }
    }
  }, /aborted/u);
  await assert.rejects(() => session.deliverToolResults({ ...failedInput, deliveryId: 'after-cancel' }), /abort/u);
  assert.equal((await session.deliverToolResults(failedInput)).status, 'failed');
  assert.equal(socket.sent.length, 1);
});

test('unrelated response.created cannot confirm a result transmission', async () => {
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => new FixtureSocket((body, ws) => {
    if (!body.previous_response_id) ws.feed({ type: 'response.created', response: { id: 'r1' } }, { type: 'response.completed', response: response('r1', '', { output: [asyncCall('original')] }) });
    else ws.feed({ type: 'response.created', response: { id: 'unrelated', previous_response_id: 'different-parent' } });
  }) });
  const session = provider.createSession();
  await assert.rejects(async () => {
    for await (const event of streamNative(provider, session, { ...request, tools: [asyncTool] })) {
      if (event.type === 'response_boundary') await session.deliverToolResults({ deliveryId: 'delivery', responseId: 'r1', results: [resultInput('original')], sourceCalls: event.native.pendingToolCalls });
    }
  }, /exact completed parent/u);
  assert.equal((await session.toolResultStatus('delivery')).status, 'uncertain');
});

test('buffered causal response evidence can reconcile result application after socket close', async () => {
  const boundaries = [];
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => new FixtureSocket((body, ws) => {
    if (!body.previous_response_id) ws.feed({ type: 'response.created', response: { id: 'r1' } }, { type: 'response.completed', response: response('r1', '', { output: [asyncCall('buffered')] }) });
    else { ws.feed({ type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } }); ws.emit('close'); }
  }) });
  const session = provider.createSession();
  await assert.rejects(async () => {
    for await (const event of streamNative(provider, session, { ...request, tools: [asyncTool] })) {
      if (event.type === 'response_boundary') {
        boundaries.push(event.response.requestId);
        await session.deliverToolResults({ deliveryId: 'buffered-delivery', responseId: 'r1', results: [resultInput('buffered')], sourceCalls: event.native.pendingToolCalls });
      }
    }
  }, /disconnected/u);
  assert.deepEqual(boundaries, ['r1'], 'known response survives while successor inference remains unsettled');
  assert.equal((await session.toolResultStatus('buffered-delivery')).status, 'applied', 'delivery application is separate from successor inference completion');
});

test('native compaction keeps its full canonical prefix and appends current authority at exact roles', async () => {
  const canonical = [...textOutput('retained assistant'), { type: 'compaction', encrypted_content: 'opaque==' }];
  const provider = new OpenAIProvider({ apiKey: 'fixture', countTokens: true, fetch: async url => Response.json(url.endsWith('/input_tokens') ? { input_tokens: 40 } : { id: 'compacted', output: canonical }) });
  const transformed = await provider.transformContext({ transformId: 'host-prefix', request });
  const authority = [{ role: 'system', content: 'Current host policy.' }, { role: 'developer', content: 'Current application instructions.' }];
  const compiled = await provider.compileRequest({ ...request, messages: [...authority, ...transformed.input, { role: 'user', content: 'next' }] });
  assert.deepEqual(compiled.body.input, [...canonical, ...authority, { role: 'user', content: 'next' }]);
  assert.deepEqual(compiled.logicalRequest.messages.slice(0, 2), authority);
  await assert.rejects(() => provider.compileRequest({ ...request, messages: [...request.messages, ...transformed.input] }), /must precede ordinary/u);
});
