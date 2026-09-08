import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as z from 'zod';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, AgentRunCoordinator, InferenceService, InMemoryInferenceRepository, agentEventCodec } from '@agent-core/runtime';
import { adoptToolDefinition } from '@agent-core/tools';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  constructor(dispatch) { super(); this.dispatch = dispatch; }
  send(data) { const body = JSON.parse(data); this.sent.push(body); this.dispatch(body, this); }
  feed(...events) { for (const event of events) this.emit('message', JSON.stringify(event)); }
  close() { this.readyState = 3; }
}
const message = content => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }];
const response = (id, output) => ({ id, status: 'completed', model: 'gpt-6-astra', output, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
const call = (id, name, async = false) => ({ type: 'function_call', call_id: id, name, arguments: '{}', async });
function tool(name, invoke) {
  const envelope = { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] };
  return adoptToolDefinition({
    name, implementationId: `tests/native/${name}@1`, description: name,
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: z.strictObject({}),
    effectEnvelope: envelope,
    decodeInput: () => ({ ok: true, input: {} }), canonicalizeInput: value => value, snapshotInput: value => value,
    deriveEffects: () => ({ ...envelope, recovery: { kind: 'unknown' } }),
    async invoke() {
      await invoke();
      return { kind: 'result', ok: true, output: {}, summary: `${name} finished`, scope: { resources: ['memory'], coverage: 'complete' } };
    }
  });
}

test('native runtime starts a successor before a late async result and settles original work exactly once', { timeout: 10000 }, async () => {
  let finishSlow;
  const slow = new Promise(resolve => { finishSlow = resolve; });
  let slowFinished = false;
  let slowInvocations = 0;
  let catalogChanged = false;
  let socket;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new Socket((body, ws) => {
    if (!body.previous_response_id) {
      ws.feed({ type: 'response.created', response: { id: 'r1' } },
        { type: 'response.completed', response: response('r1', [call('a', 'slow', true), call('b', 'fast')]) });
    } else if (body.previous_response_id === 'r1') {
      assert.equal(slowFinished, false, 'async A cannot hold the R2 admission behind it');
      assert.deepEqual(body.input.map(item => item.call_id), ['b']);
      assert.deepEqual(body.tools.map(tool => tool.name), ['fast']);
      ws.feed({ type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } },
        { type: 'response.completed', response: response('r2', message('Independent work complete.')) });
      finishSlow();
    } else {
      assert.equal(body.previous_response_id, 'r2');
      assert.deepEqual(body.input.map(item => item.call_id), ['a']);
      ws.feed({ type: 'response.created', response: { id: 'r3', previous_response_id: 'r2' } },
        { type: 'response.completed', response: response('r3', message('All work complete.')) });
    }
  }) });
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const inference = new InMemoryInferenceRepository();
  const slowTool = tool('slow', async () => { slowInvocations++; await slow; slowFinished = true; });
  const fastTool = tool('fast', async () => { catalogChanged = true; });
  const runtime = new AgentRuntime({
    provider, model: 'gpt-6-astra', maxOutputTokens: 128,
    inferenceService: new InferenceService({ provider, repository: inference, artifacts, budget: { maxInvocations: 3 } }),
    tools: [slowTool, fastTool],
    toolCatalogProvider: () => catalogChanged ? [fastTool] : [slowTool, fastTool],
    toolBoundary: { authorizationPolicyId: 'tests/native', executionTargetId: 'tests/native' },
    repositories: { events, artifacts }
  });
  const result = await runtime.run({ runId: 'native-independent', task: 'Do independent work while the slow read runs.' }).result;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
  assert.equal(result.terminal.modelOutput.message, 'All work complete.');
  assert.equal(result.terminal.budget.modelTurns, 3);
  assert.equal(result.terminal.budget.promptTokens, 12);
  assert.equal(result.terminal.budget.completionTokens, 6);
  assert.equal(slowInvocations, 1);
  assert.equal(socket.sent.length, 3);
  const state = (await new AgentRunCoordinator(events).inspect('native-independent')).state;
  assert.equal(state.providerRequests.length, 3);
  assert.ok(state.providerRequests.every(request => request.stage === 'consumed'));
  assert.deepEqual(state.toolBatches[0].modelCalls.map(call => call.async ?? false), [true, false]);
  for (const call of state.toolBatches[0].callStates) {
    assert.equal(call.stage, 'recorded');
    assert.equal(call.delivery.status, 'applied');
    assert.equal(call.effect.phase, 'settled');
  }
  const ledger = await inference.load('native-independent');
  assert.equal(ledger.invocations.size, 3);
  assert.ok([...ledger.invocations.values()].every(invocation => invocation.settlement));
});

async function deliveryFixture({ maxInvocations = 3, disconnect = false } = {}) {
  let effects = 0;
  let socket;
  const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new Socket((body, ws) => {
    if (!body.previous_response_id) {
      ws.feed({ type: 'response.created', response: { id: 'source' } },
        { type: 'response.completed', response: response('source', [call('saved-result', 'read')]) });
    } else if (disconnect) {
      ws.readyState = 3;
      ws.emit('close', 1006);
    } else {
      ws.feed({ type: 'response.created', response: { id: 'successor', previous_response_id: 'source' } },
        { type: 'response.completed', response: response('successor', message('Finished.')) });
    }
  }) });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const inference = new InMemoryInferenceRepository();
  const options = {
    provider, model: 'gpt-6-astra', maxOutputTokens: 128,
    inferenceService: new InferenceService({ provider, repository: inference, artifacts, budget: { maxInvocations } }),
    tools: [tool('read', async () => { effects++; })],
    repositories: { events, artifacts },
    toolBoundary: { authorizationPolicyId: 'tests/native', executionTargetId: 'tests/native' }
  };
  const runtime = new AgentRuntime(options);
  const control = runtime.run({ runId: 'delivery-boundary', task: 'Read and report.' });
  const result = await control.result;
  return { result, runtime, options, events, inference, socket, effects };
}

test('native successor spends the shared owner allowance before any result frame is sent', async () => {
  const fixture = await deliveryFixture({ maxInvocations: 1 });
  assert.equal(fixture.socket.sent.length, 1);
  assert.equal(fixture.effects, 1);
  assert.equal(fixture.result.state, 'ended');
  assert.equal(fixture.result.terminal.executionStatus, 'failed');
  const state = (await fixture.runtime.inspectRun('delivery-boundary')).state;
  assert.equal(state.providerRequests.length, 1, 'No second driver request can start without shared admission.');
  assert.equal(state.toolBatches[0].callStates[0].stage, 'recorded');
  assert.equal(state.toolBatches[0].callStates[0].delivery, undefined);
  assert.equal((await fixture.inference.load('delivery-boundary')).invocations.size, 1);
});

test('disconnect after result transmission preserves uncertain delivery and never repeats the known effect', async () => {
  const fixture = await deliveryFixture({ disconnect: true });
  assert.equal(fixture.socket.sent.length, 2);
  assert.equal(fixture.effects, 1);
  assert.equal(fixture.result.state, 'suspended', JSON.stringify(fixture.result));
  assert.equal(fixture.result.reason, 'provider_outcome_unknown');
  const state = (await fixture.runtime.inspectRun('delivery-boundary')).state;
  const saved = state.toolBatches[0].callStates[0];
  assert.equal(saved.stage, 'recorded');
  assert.equal(saved.effect.phase, 'settled');
  assert.equal(saved.delivery.status, 'uncertain');
  assert.equal(saved.delivery.targetResponseId, 'source');
  assert.equal(state.providerRequests.at(-1).stage, 'outcome_unknown');
  const resumed = await new AgentRuntime(fixture.options).resume('delivery-boundary').result;
  assert.equal(resumed.state, 'suspended');
  assert.equal(resumed.reason, 'provider_outcome_unknown');
  assert.equal(fixture.socket.sent.length, 2);
  assert.equal((await fixture.inference.load('delivery-boundary')).invocations.size, 2);
});

for (const [requiresResult, reportsUsage] of [[false, true], [true, true], [true, false]]) {
  test(`native steering ${requiresResult ? 'and its required result share' : 'reserves'} one successor before transmission (${reportsUsage ? 'reported' : 'estimated'} usage)`, async () => {
    const nativeResponse = (id, output) => {
      const value = response(id, output);
      if (!reportsUsage) delete value.usage;
      return value;
    };
    let socket;
    let handle;
    let steered = false;
    const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', webSocketFactory: () => socket = new Socket((body, ws) => {
      if (body.type === 'response.steer') {
        ws.feed({ type: 'response.steer.accepted', steer: { id: 'steer-event', previous_response_id: 'r1' } });
        if (requiresResult) {
          ws.feed({ type: 'response.completed', response: nativeResponse('r1', [call('dependency', 'read')]) });
        } else {
          ws.feed({ type: 'response.incomplete', response: { ...nativeResponse('r1', message('Working.')), status: 'incomplete', incomplete_details: { reason: 'steered' } } },
            { type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } },
            { type: 'response.completed', response: nativeResponse('r2', message('Correction applied.')) });
        }
      } else if (!body.previous_response_id) {
        ws.feed({ type: 'response.created', response: { id: 'r1' } },
          { type: 'response.output_text.delta', response_id: 'r1', delta: 'Working.' });
      } else {
        assert.equal(requiresResult, true);
        assert.deepEqual(body.input.map(item => item.call_id), ['dependency']);
        ws.feed({ type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } },
          { type: 'response.completed', response: nativeResponse('r2', message('Correction applied.')) });
      }
    }) });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const inference = new InMemoryInferenceRepository();
    const runtime = new AgentRuntime({
      provider, model: 'gpt-6-astra', maxOutputTokens: 128,
      inferenceService: new InferenceService({ provider, repository: inference, artifacts, budget: { maxInvocations: 2 } }),
      tools: requiresResult ? [tool('read', async () => {})] : [],
      repositories: { events, artifacts },
      toolBoundary: { authorizationPolicyId: 'tests/native', executionTargetId: 'tests/native' },
      onProgress(event) {
        if (!steered && event.type === 'assistant.delta') {
          steered = true;
          const input = { instruction: 'Preserve this exact correction.', deliveryId: 'original-correction' };
          const receipt = handle.injectSteering(input);
          assert.equal(handle.injectSteering(input).id, receipt.id);
          assert.throws(() => handle.injectSteering({ ...input, instruction: 'conflict' }), /conflicting/);
        }
      }
    });
    handle = runtime.run({ runId: 'steered-runtime', task: 'Start work.' });
    const result = await handle.result;
    assert.equal(result.state, 'ended', JSON.stringify({ result, uncertain: [...(await inference.load('steered-runtime')).invocations.values()].map(item => item.uncertain) }));
    assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
    assert.equal(result.terminal.budget.modelTurns, 2);
    if (reportsUsage) {
      assert.equal(result.terminal.budget.promptTokens, 8);
      assert.equal(result.terminal.budget.completionTokens, 4);
    }
    assert.equal(socket.sent.length, requiresResult ? 3 : 2);
    const owner = await inference.load('steered-runtime');
    assert.equal(owner.invocations.size, 2);
    assert.equal([...owner.invocations.values()].reduce((sum, item) => sum + item.extensions.length, 0), requiresResult ? 1 : 0);
    const audit = [];
    for await (const record of events.read('steered-runtime')) audit.push(record.event);
    if (!reportsUsage) {
      const estimates = audit.filter(event => event.type === 'budget.estimate.created');
      const latest = new Map(estimates.map(event => [event.turnId, event.estimate.totalPromptTokens]));
      assert.equal(latest.size, 2);
      assert.equal(result.terminal.budget.promptTokens, [...latest.values()].reduce((sum, tokens) => sum + tokens, 0));
      const successor = estimates.filter(event => event.turnId === estimates.at(-1).turnId);
      assert.equal(successor.length, 2);
      assert.notEqual(successor[0].estimate.totalPromptTokens, successor[1].estimate.totalPromptTokens);
    }
    assert.equal(audit.filter(event => event.type === 'input.steering.accepted').length, 1);
    assert.equal(audit.filter(event => event.type === 'input.steering.local_applied').length, 0);
    assert.ok(audit.some(event => event.type === 'input.steering.delivery' && event.delivery.status === 'applied'));
    assert.ok((await runtime.inspectRun('steered-runtime')).state.providerRequests.every(request => request.stage === 'consumed'));
  });
}
