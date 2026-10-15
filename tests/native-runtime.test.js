import { recordInferenceEvents } from './inference-audit-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as z from 'zod';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  AgentRunCoordinator,
  InferenceService,
  InMemoryInferenceRepository,
  InMemorySessionRepository,
  HistoryReader,
  ContextService,
  agentEventCodec
} from '@agent-core/runtime';
import { adoptToolDefinition } from '@agent-core/tools';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  errors = [];
  constructor(dispatch) {
    super();
    this.dispatch = dispatch;
  }
  send(data) {
    const body = JSON.parse(data);
    this.sent.push(body);
    try {
      this.dispatch(body, this);
    } catch (error) {
      this.errors.push(String(error));
      throw error;
    }
  }
  feed(...events) {
    for (const event of events) this.emit('message', JSON.stringify(event));
  }
  close() {
    this.readyState = 3;
  }
}
const message = (content) => [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }
];
const response = (id, output) => ({
  id,
  status: 'completed',
  model: 'gpt-6-astra',
  output,
  usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
});
const call = (id, name, async = false) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: '{}',
  async
});
function tool(name, invoke) {
  const envelope = { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] };
  return adoptToolDefinition({
    name,
    implementationId: `tests/native/${name}@1`,
    description: name,
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: z.strictObject({}),
    effectEnvelope: envelope,
    decodeInput: () => ({ ok: true, input: {} }),
    canonicalizeInput: (value) => value,
    snapshotInput: (value) => value,
    deriveEffects: () => ({ ...envelope, recovery: { kind: 'unknown' } }),
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          await invoke();
          return {
            kind: 'result',
            output: {},
            summary: `${name} finished`,
            scope: { resources: ['memory'], coverage: 'complete' }
          };
        }
      };
    }
  });
}

test(
  'native runtime starts a successor before a late async result and settles original work exactly once',
  { timeout: 10000 },
  async () => {
    let finishSlow;
    const slow = new Promise((resolve) => {
      finishSlow = resolve;
    });
    let slowFinished = false;
    let slowInvocations = 0;
    let catalogChanged = false;
    let socket;
    const provider = new OpenAIProvider({
      apiKey: 'fixture',
      transport: 'websocket',
      webSocketFactory: () =>
        (socket = new Socket((body, ws) => {
          if (!body.previous_response_id) {
            ws.feed(
              { type: 'response.created', response: { id: 'r1' } },
              {
                type: 'response.completed',
                response: response('r1', [call('a', 'slow', true), call('b', 'fast')])
              }
            );
          } else if (body.previous_response_id === 'r1') {
            assert.equal(slowFinished, false, 'async A cannot hold the R2 admission behind it');
            assert.deepEqual(
              body.input.map((item) => item.call_id),
              ['b']
            );
            assert.deepEqual(
              body.tools.map((tool) => tool.name),
              ['fast']
            );
            ws.feed(
              { type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } },
              {
                type: 'response.completed',
                response: response('r2', message('Independent work complete.'))
              }
            );
            finishSlow();
          } else {
            assert.equal(body.previous_response_id, 'r2');
            assert.deepEqual(
              body.input.map((item) => item.call_id),
              ['a']
            );
            ws.feed(
              { type: 'response.created', response: { id: 'r3', previous_response_id: 'r2' } },
              {
                type: 'response.completed',
                response: response('r3', message('All work complete.'))
              }
            );
          }
        }))
    });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const inference = new InMemoryInferenceRepository();
    const inferenceAudit = recordInferenceEvents(inference);
    const slowTool = tool('slow', async () => {
      slowInvocations++;
      await slow;
      slowFinished = true;
    });
    const fastTool = tool('fast', async () => {
      catalogChanged = true;
    });
    const runtime = new AgentRuntime({
      provider,
      model: 'gpt-6-astra',
      maxOutputTokens: 128,
      inferenceService: new InferenceService({
        provider,
        repository: inference,
        artifacts,
        budget: { maxInvocations: 3 }
      }),
      tools: [slowTool, fastTool],
      toolCatalogProvider: () => (catalogChanged ? [fastTool] : [slowTool, fastTool]),
      toolBoundary: { authorizationPolicyId: 'tests/native', executionTargetId: 'tests/native' },
      repositories: { events, artifacts }
    });
    const result = await runtime.run({
      runId: 'native-independent',
      task: 'Do independent work while the slow read runs.'
    }).result;
    const diagnosticEvents = (await Array.fromAsync(events.read('native-independent')))
      .map(({ event }) => ({
        type: event.type,
        message: event.message,
        error: event.error,
        diagnostic: event.diagnostic
      }))
      .filter((e) => e.message || e.error || e.diagnostic);
    assert.equal(
      result.state,
      'ended',
      JSON.stringify({ result, errors: socket.errors, diagnosticEvents })
    );
    assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
    assert.equal(result.terminal.modelOutput.message, 'All work complete.');
    assert.equal(result.terminal.budget.modelTurns, 3);
    assert.equal(result.terminal.budget.promptTokens, 12);
    assert.equal(result.terminal.budget.completionTokens, 6);
    assert.equal(slowInvocations, 1);
    assert.equal(socket.sent.length, 3);
    const state = (await new AgentRunCoordinator(events, artifacts).inspect('native-independent'))
      .state;
    assert.deepEqual(state.providerRequests, []);
    assert.deepEqual(state.toolBatches, []);
    const ledger = await inference.load('native-independent');
    assert.equal(ledger.committed.invocations, 3);
    assert.equal(ledger.settledUsage.invocations, 3);
  }
);

async function deliveryFixture({ maxInvocations = 3, disconnect = false, admitRequest } = {}) {
  let effects = 0;
  let socket;
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    transport: 'websocket',
    webSocketFactory: () =>
      (socket = new Socket((body, ws) => {
        if (!body.previous_response_id) {
          ws.feed(
            { type: 'response.created', response: { id: 'source' } },
            {
              type: 'response.completed',
              response: response('source', [call('saved-result', 'read')])
            }
          );
        } else if (disconnect) {
          ws.readyState = 3;
          ws.emit('close', 1006);
        } else {
          ws.feed(
            {
              type: 'response.created',
              response: { id: 'successor', previous_response_id: 'source' }
            },
            { type: 'response.completed', response: response('successor', message('Finished.')) }
          );
        }
      }))
  });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const inference = new InMemoryInferenceRepository();
  const inferenceAudit = recordInferenceEvents(inference);
  const options = {
    provider,
    model: 'gpt-6-astra',
    maxOutputTokens: 128,
    inferenceService: new InferenceService({
      provider,
      repository: inference,
      artifacts,
      budget: { maxInvocations },
      ...(admitRequest ? { admitRequest } : {})
    }),
    tools: [
      tool('read', async () => {
        effects++;
      })
    ],
    repositories: { events, artifacts },
    toolBoundary: { authorizationPolicyId: 'tests/native', executionTargetId: 'tests/native' }
  };
  const runtime = new AgentRuntime(options);
  const control = runtime.run({ runId: 'delivery-boundary', task: 'Read and report.' });
  const result = await control.result;
  return { result, runtime, options, events, inference, socket, effects };
}

test('application admission rejects a native successor before any result frame is sent', async () => {
  const fixture = await deliveryFixture({
    admitRequest(compiled) {
      if (compiled.body.previous_response_id) throw new Error('Successor denied');
    }
  });
  assert.equal(fixture.socket.sent.length, 1);
  assert.equal(fixture.effects, 1);
  assert.equal(fixture.result.state, 'ended', JSON.stringify(fixture.result));
  assert.equal(fixture.result.terminal.executionStatus, 'failed');
  const state = (await fixture.runtime.inspectRun('delivery-boundary')).state;
  assert.equal(state.toolBatches[0].callStates[0].stage, 'recorded');
  assert.equal(state.toolBatches[0].callStates[0].delivery, undefined);
});

test('native successor spends the shared owner allowance before any result frame is sent', async () => {
  const fixture = await deliveryFixture({ maxInvocations: 1 });
  assert.equal(fixture.socket.sent.length, 1);
  assert.equal(fixture.effects, 1);
  assert.equal(fixture.result.state, 'ended');
  assert.equal(fixture.result.terminal.executionStatus, 'failed');
  assert.match(fixture.result.terminal.errorMessage, /invocations.*1 settled.*0 outstanding reservations.*1 candidate.*limit 1/);
  const state = (await fixture.runtime.inspectRun('delivery-boundary')).state;
  assert.equal(state.providerRequests.length, 0, 'Ended runs discard settled provider payloads.');
  assert.equal(state.toolBatches[0].callStates[0].stage, 'recorded');
  assert.equal(state.toolBatches[0].callStates[0].delivery, undefined);
  const audit = await Array.fromAsync(fixture.events.read('delivery-boundary'));
  assert.equal(audit.filter(({ event }) => event.type === 'tool.ended').length, 1);
  assert.equal((await fixture.inference.load('delivery-boundary')).committed.invocations, 1);
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
  assert.equal((await fixture.inference.load('delivery-boundary')).committed.invocations, 2);
});

for (const [requiresResult, reportsUsage] of [
  [false, true],
  [true, true],
  [true, false]
]) {
  test(`native steering ${requiresResult ? 'and its required result share' : 'reserves'} one successor before transmission (${reportsUsage ? 'reported' : 'estimated'} usage)`, async () => {
    const nativeResponse = (id, output) => {
      const value = response(id, output);
      if (!reportsUsage) delete value.usage;
      return value;
    };
    let socket;
    let handle;
    let steered = false;
    const provider = new OpenAIProvider({
      apiKey: 'fixture',
      transport: 'websocket',
      webSocketFactory: () =>
        (socket = new Socket((body, ws) => {
          if (body.type === 'response.steer') {
            ws.feed({
              type: 'response.steer.accepted',
              steer: { id: 'steer-event', previous_response_id: 'r1' }
            });
            if (requiresResult) {
              ws.feed({
                type: 'response.completed',
                response: nativeResponse('r1', [call('dependency', 'read')])
              });
            } else {
              ws.feed(
                {
                  type: 'response.incomplete',
                  response: {
                    ...nativeResponse('r1', message('Working.')),
                    status: 'incomplete',
                    incomplete_details: { reason: 'steered' }
                  }
                },
                { type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } },
                {
                  type: 'response.completed',
                  response: nativeResponse('r2', message('Correction applied.'))
                }
              );
            }
          } else if (!body.previous_response_id) {
            ws.feed(
              { type: 'response.created', response: { id: 'r1' } },
              { type: 'response.output_text.delta', response_id: 'r1', delta: 'Working.' }
            );
          } else {
            assert.equal(requiresResult, true);
            assert.deepEqual(
              body.input.map((item) => item.call_id),
              ['dependency']
            );
            ws.feed(
              { type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } },
              {
                type: 'response.completed',
                response: nativeResponse('r2', message('Correction applied.'))
              }
            );
          }
        }))
    });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const inference = new InMemoryInferenceRepository();
    const inferenceAudit = recordInferenceEvents(inference);
    const runtime = new AgentRuntime({
      provider,
      model: 'gpt-6-astra',
      maxOutputTokens: 128,
      inferenceService: new InferenceService({
        provider,
        repository: inference,
        artifacts,
        budget: { maxInvocations: 2 }
      }),
      tools: requiresResult ? [tool('read', async () => {})] : [],
      repositories: { events, artifacts },
      toolBoundary: { authorizationPolicyId: 'tests/native', executionTargetId: 'tests/native' },
      onProgress(event) {
        if (!steered && event.type === 'assistant.delta') {
          steered = true;
          const input = {
            instruction: 'Preserve this exact correction.',
            deliveryId: 'original-correction'
          };
          const receipt = handle.injectSteering(input);
          assert.equal(handle.injectSteering(input).id, receipt.id);
          assert.throws(
            () => handle.injectSteering({ ...input, instruction: 'conflict' }),
            /conflicting/
          );
        }
      }
    });
    handle = runtime.run({ runId: 'steered-runtime', task: 'Start work.' });
    const result = await handle.result;
    assert.equal(
      result.state,
      'ended',
      JSON.stringify({
        result,
        inference: await inference.load('steered-runtime')
      })
    );
    assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
    assert.equal(result.terminal.budget.modelTurns, 2);
    if (reportsUsage) {
      assert.equal(result.terminal.budget.promptTokens, 8);
      assert.equal(result.terminal.budget.completionTokens, 4);
    }
    assert.equal(socket.sent.length, requiresResult ? 3 : 2);
    const owner = await inference.load('steered-runtime');
    assert.equal(owner.committed.invocations, 2);
    assert.equal(
      inferenceAudit.filter(({ event }) => event.type === 'inference.extended').length,
      requiresResult ? 1 : 0
    );
    const audit = [];
    for await (const record of events.read('steered-runtime')) audit.push(record.event);
    if (!reportsUsage) {
      const estimates = audit.filter((event) => event.type === 'budget.estimate.created');
      const latest = new Map(
        estimates.map((event) => [event.turnId, event.estimate.totalPromptTokens])
      );
      assert.equal(latest.size, 2);
      assert.equal(
        result.terminal.budget.promptTokens,
        [...latest.values()].reduce((sum, tokens) => sum + tokens, 0)
      );
      const successor = estimates.filter((event) => event.turnId === estimates.at(-1).turnId);
      assert.equal(successor.length, 2);
      assert.notEqual(
        successor[0].estimate.totalPromptTokens,
        successor[1].estimate.totalPromptTokens
      );
    }
    assert.equal(audit.filter((event) => event.type === 'input.steering.accepted').length, 1);
    assert.equal(audit.filter((event) => event.type === 'input.steering.local_applied').length, 0);
    assert.ok(
      audit.some(
        (event) => event.type === 'input.steering.delivery' && event.delivery.status === 'applied'
      )
    );
    assert.ok(
      (await runtime.inspectRun('steered-runtime')).state.providerRequests.every(
        (request) => request.stage === 'consumed'
      )
    );
  });
}

for (const publication of ['normal', 'lost_receipt', 'rejected']) test(
  `native session-state ${publication} binds each successor to its exact admitted input`,
  { timeout: 10000 },
  async () => {
    const sessions = new InMemorySessionRepository();
    const descriptor = await sessions.create({
      binding: { schemaId: 'native-state', schemaVersion: 1, subject: {} }
    });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const history = new HistoryReader({
      repository: sessions,
      session: descriptor,
      events,
      artifacts
    });
    const context = new ContextService({
      repository: sessions,
      session: descriptor,
      history,
      artifacts,
      policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } }
    });
    const frames = [];
    const sockets = [];
    let freshRequests = 0;
    const body1 = 'Retain the rationale.';
    const body2 = 'Retain the corrected rationale.';
    const provider = new OpenAIProvider({
      apiKey: 'fixture', transport: 'websocket',
      webSocketFactory: () => {
        const socket = new Socket((body, ws) => {
          frames.push(body);
          const fresh = !body.previous_response_id;
          if (fresh) freshRequests++;
          const id = fresh ? `r${freshRequests}` : `ack${freshRequests}`;
          const output = !fresh || freshRequests === 3 || (publication === 'rejected' && freshRequests > 1)
            ? message(fresh ? 'Finished.' : 'Selection requested.')
            : [{ ...call(id + '-state', 'context_transition'), arguments: JSON.stringify({
              reason: 'Revise useful understanding.',
              sessionState: { understanding: [{ id: 'rationale', text: freshRequests === 1 ? body1 : body2 }] }
            }) }];
          ws.feed({ type: 'response.created', response: { id,
            ...(body.previous_response_id ? { previous_response_id: body.previous_response_id } : {}) } },
            { type: 'response.completed', response: response(id, output) });
        });
        sockets.push(socket);
        return socket;
      }
    });
    let receiptLost = false;
    const commit = sessions.commitContextTransition.bind(sessions);
    sessions.commitContextTransition = async (...args) => {
      const before = frames.length;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(frames.length, before, 'A native successor cannot be sent while state publication is pending');
      const entry = await commit(...args);
      if (publication === 'lost_receipt' && !receiptLost) {
        receiptLost = true;
        throw new Error('Lost admitted state receipt');
      }
      return entry;
    };
    const inference = new InferenceService({
      provider,
      ...(publication === 'rejected' ? { admitRequest: compiled => {
        if (compiled.logicalRequest.messages.some(item => item.role === 'user' && item.content.includes(body1)))
          throw new Error('Reject the exact native state successor');
      } } : {}),
      repository: new InMemoryInferenceRepository(),
      artifacts
    });
    const result = await new AgentRuntime({
      provider,
      model: 'gpt-6-astra',
      maxOutputTokens: 512,
      context,
      inferenceService: inference,
      tools: context.toolDefinitions(),
      toolPolicy: { allowedRisks: ['write'] },
      toolBoundary: { authorizationPolicyId: 'native-state', executionTargetId: 'native-state' },
      repositories: { events, artifacts, session: { repository: sessions, descriptor } }
    }).run({ task: 'Correct the understanding and finish.' }).result;
    if (publication === 'rejected') {
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
      assert.equal((await context.sessionState()).revision, null);
      assert.equal(frames.length, 3);
      assert.ok(!frames[2].input.some(item => item.role === 'user' && JSON.stringify(item).includes(body1)),
        'Rejected state is never dispatched; unchanged original context may continue');
      assert.equal((await sessions.loadReplayState(descriptor)).branch.filter(entry => entry.type === 'context_transition').length, 0);
      return;
    }
    assert.equal(receiptLost, publication === 'lost_receipt');
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    const { branch } = await sessions.loadReplayState(descriptor);
    const revisions = branch.filter((entry) => entry.type === 'context_transition' && entry.sessionState);
    assert.equal(revisions.length, 2, JSON.stringify((await Array.fromAsync(events.read(result.terminal.runId))).filter(({event}) => event.type === 'context.transition.rejected')));
    assert.equal((await context.sessionState()).content.understanding[0].text, body2);
    assert.equal(frames.length, 5);
    assert.equal(sockets.length, 3, 'Each committed state opens a fresh provider session');
    for (const [index, text] of [body1, body2].entries()) {
      const wire = frames[(index + 1) * 2];
      assert.equal(wire.previous_response_id, undefined);
      assert.equal(wire.input.filter(item => item.role === 'user' && JSON.stringify(item).includes(text)).length, 1);
      assert.ok(wire.input.findIndex(item => item.role === 'user' && JSON.stringify(item).includes(text)) <
        wire.input.findIndex(item => item.type === 'function_call'));
    }
    const originatingInput = JSON.parse(
      new TextDecoder().decode(await artifacts.readVerified(revisions[1].sessionState.inference.requestRef))
    );
    assert.equal(originatingInput.sessionStateRevisionId, revisions[0].id);
    assert.ok(JSON.stringify(originatingInput.logical).includes(body1));
    assert.notEqual(
      revisions[0].sessionState.inference.requestRef.sha256,
      revisions[1].sessionState.inference.requestRef.sha256
    );
  }
);


async function nativeControlRoomFixture(resultTokens = 850) {
  const sessions = new InMemorySessionRepository();
  const descriptor = await sessions.create({ binding: { schemaId: 'native-control-room', schemaVersion: 1, subject: {} } });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const inference = new InMemoryInferenceRepository();
  const inferenceAudit = recordInferenceEvents(inference);
  const history = new HistoryReader({ repository: sessions, session: descriptor, events, artifacts });
  const context = new ContextService({ repository: sessions, session: descriptor, history, artifacts,
    policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
  const capacity = 1200;
  let effects = 0;
  let releaseHistory = false;
  const frames = [];
  const counted = [];
  const provider = new OpenAIProvider({
    apiKey: 'fixture', transport: 'websocket', countTokens: true,
    fetch: async (url, init) => {
      assert.ok(url.endsWith('/input_tokens'), `Unexpected network operation: ${url}`);
      const body = JSON.parse(init.body);
      const control = JSON.stringify(body).includes('Application execution is suspended');
      const result = body.input?.some(item => item.type === 'function_call_output');
      // Exact fixture counts isolate the reserve from hard overflow: the 850-token
      // successor fits 1200 tokens, but cannot leave the extra full-context checkpoint input and output.
      const inputTokens = control ? (result ? resultTokens + 150 : 600) : result ? resultTokens : 100;
      counted.push({ control, result, inputTokens });
      return Response.json({ input_tokens: inputTokens });
    },
    webSocketFactory: () => new Socket((body, ws) => {
      frames.push(body);
      const first = frames.length === 1;
      const control = JSON.stringify(body).includes('Application execution is suspended');
      const id = first ? 'source-control-room' : `control-room-${frames.length}`;
      ws.feed({ type: 'response.created', response: { id,
        ...(body.previous_response_id ? { previous_response_id: body.previous_response_id } : {}) } },
      { type: 'response.completed', response: response(id,
        first ? [call('preserved-result', 'read')]
          : control && releaseHistory
            ? [{ ...call('release-context', 'context_transition'), arguments: JSON.stringify({ retain: [], reason: 'Release completed history for the next task.' }) }]
            : message(control ? 'Source selection needs user input.' : 'Finished from the recorded result.')) });
    })
  });
  const describe = provider.describeModel.bind(provider);
  provider.describeModel = async model => {
    const profile = await describe(model);
    return { ...profile,
      capabilities: { ...profile.capabilities, protocol: { ...profile.capabilities.protocol, contextReset: 'fresh_request' } },
      limits: { ...profile.limits, contextTokens: capacity, maxInputTokens: capacity - 128, outputTokens: 128 } };
  };
  const options = {
    provider, model: 'gpt-6-astra', maxOutputTokens: 128, context,
    contextRenewal: { automatic: true },
    inferenceService: new InferenceService({ provider, repository: inference, artifacts }),
    tools: [tool('read', async () => { effects++; }), ...context.toolDefinitions()],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolBoundary: { authorizationPolicyId: 'native-control-room', executionTargetId: 'native-control-room' },
    repositories: { events, artifacts, session: { repository: sessions, descriptor } }
  };
  return { options, events, artifacts, inferenceAudit, inference, history, context, frames, counted, capacity, effects: () => effects, releaseHistory: () => { releaseHistory = true; } };
}

test('required native delivery preserves effects before control-room recovery at the next legal boundary',
  { timeout: 10000 }, async () => {
    const { options, events, artifacts, inferenceAudit, inference, history, context, frames, counted, capacity, effects, releaseHistory } = await nativeControlRoomFixture();
    const first = await new AgentRuntime(options).run({ runId: 'native-control-room', task: 'Read once and report.' }).result;
    assert.equal(first.terminal?.executionStatus, 'completed', JSON.stringify({ first, counted }));
    assert.equal(effects(), 1);
    assert.equal(frames.length, 2, 'mandatory result delivery must not deadlock on a soft reserve');
    assert.equal(frames[1].previous_response_id, 'source-control-room');
    assert.equal(frames[1].input.filter(item => item.type === 'function_call_output').length, 1);
    assert.equal(frames[1].input.find(item => item.type === 'function_call_output').call_id, 'preserved-result');
    assert.ok(counted.some(item => item.control && item.inputTokens === 600));
    assert.ok(counted.some(item => item.result && item.inputTokens === 850));
    assert.ok(850 + 128 < capacity && capacity - 850 - 128 < 150 + 128,
      'the required successor fits actual capacity while leaving less than the compiled control reserve');
    const firstAudit = await Array.fromAsync(events.read('native-control-room'));
    assert.equal(firstAudit.filter(({ event }) => event.type === 'tool.ended').length, 1);
    const completed = (await new AgentRunCoordinator(events, artifacts).inspect('native-control-room')).state;
    assert.deepEqual(completed.toolBatches, [], 'successful completion resolves the native delivery obligation');
    assert.equal((await inference.load('native-control-room')).committed.invocations, 2);

    const blocked = await new AgentRuntime(options).run({ runId: 'next-legal-boundary', task: 'Start the next task.' }).result;
    assert.equal(blocked.state, 'suspended', JSON.stringify(blocked));
    assert.equal(blocked.reason, 'context_admission');
    assert.equal(blocked.contextAdmission.kind, 'request_capacity');
    assert.equal(blocked.contextAdmission.estimatedInputTokens, 850);
    assert.equal(blocked.contextAdmission.contextTokens, capacity);
    assert.equal(frames.length, 3, 'only the admitted control request may be sent at this boundary');
    assert.match(JSON.stringify(frames[2]), /Application execution is suspended/);
    assert.equal(effects(), 1);
    assert.ok(!(await Array.fromAsync(events.read('next-legal-boundary'))).some(({ event }) => event.type === 'run.ended'));

    // A new admitted checkpoint selects sources without replaying the completed domain effect.
    releaseHistory();
    const resumed = await new AgentRuntime(options).resume('next-legal-boundary').result;
    assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
    assert.equal(effects(), 1, 'resuming capacity admission must never repeat the settled effect');
    assert.equal(frames.length, 5);
    assert.doesNotMatch(JSON.stringify(frames[4]), /Application execution is suspended/);
    const audit = await Array.fromAsync(events.read('next-legal-boundary'));
    assert.equal(audit.filter(({ event }) => event.type === 'tool.ended').length, 1);
    assert.ok(audit.filter(({ event }) => event.type === 'tool.ended').every(({event}) => event.toolName === 'context_transition'));
    assert.equal(audit.filter(({ event }) => event.type === 'run.ended').length, 1);
    const budget = await inference.load('next-legal-boundary');
    assert.equal(budget.settledUsage.invocations, 3);
    assert.equal(budget.committed.invocations, budget.settledUsage.invocations);
    assert.deepEqual(budget.committed.usage, budget.settledUsage.usage,
      'no rejected unsent generation leaves outstanding token reservations');
    assert.equal(budget.committed.unknownPricedTokens, budget.settledUsage.unknownPricedTokens);
    assert.ok(Math.abs(budget.committed.knownCosts.USD - budget.settledUsage.knownCosts.USD) < 1e-12);
    assert.ok(!inferenceAudit.some(({ event }) => event.type === 'inference.uncertain'));
  });


test('hard native capacity conflict preserves an unsent settled result without repeating it',
  { timeout: 10000 }, async () => {
    const { options, events, artifacts, inference, frames, effects, capacity } = await nativeControlRoomFixture(1100);
    const result = await new AgentRuntime(options).run({ runId: 'native-hard-capacity', task: 'Read once and report.' }).result;
    assert.equal(result.state, 'suspended', JSON.stringify(result));
    assert.equal(result.reason, 'context_admission');
    assert.equal(result.contextAdmission.kind, 'request_capacity');
    assert.equal(result.contextAdmission.estimatedInputTokens, 1100);
    assert.ok(result.contextAdmission.estimatedInputTokens + result.contextAdmission.outputReservation > capacity);
    assert.equal(frames.length, 1, 'an over-capacity result frame must never be transmitted');
    assert.equal(effects(), 1);
    const state = (await new AgentRunCoordinator(events, artifacts).inspect('native-hard-capacity')).state;
    const saved = state.toolBatches[0].callStates[0];
    assert.equal(saved.stage, 'recorded');
    assert.equal(saved.effect.phase, 'settled');
    assert.equal(saved.delivery, undefined);
    const audit = await Array.fromAsync(events.read('native-hard-capacity'));
    assert.equal(audit.filter(({event}) => event.type === 'tool.ended').length, 1);
    assert.ok(!audit.some(({event}) => event.type === 'run.ended'));
    assert.equal((await inference.load('native-hard-capacity')).committed.invocations, 1);
    const stillBlocked = await new AgentRuntime(options).resume('native-hard-capacity').result;
    assert.equal(stillBlocked.state, 'suspended', JSON.stringify(stillBlocked));
    assert.equal(stillBlocked.reason, 'context_admission');
    assert.equal(frames.length, 1);
    assert.equal(effects(), 1);
    const cancelled = await new AgentRuntime(options).resume('native-hard-capacity',
      AbortSignal.abort('Cancel while native delivery has no lawful capacity.')).result;
    assert.equal(cancelled.terminal?.executionStatus, 'aborted', JSON.stringify(cancelled));
    assert.equal(frames.length, 1);
    assert.equal(effects(), 1);
    assert.equal((await inference.load('native-hard-capacity')).committed.invocations, 1);
    const finalAudit = await Array.fromAsync(events.read('native-hard-capacity'));
    assert.equal(finalAudit.filter(({event}) => event.type === 'tool.ended').length, 1);
    assert.equal(finalAudit.filter(({event}) => event.type === 'run.ended').length, 1);
  });

for (const publication of ['normal', 'lost_receipt', 'rejected']) {
  test(`native steering ${publication} commits state only at a fresh request boundary`, { timeout: 10000 }, async () => {
    const sessions = new InMemorySessionRepository();
    const descriptor = await sessions.create({ binding: { schemaId: 'native-extension-state', schemaVersion: 1, subject: {} } });
    const events = new InMemoryEventRepository(agentEventCodec);
    const artifacts = new InMemoryArtifactRepository();
    const history = new HistoryReader({ repository: sessions, session: descriptor, events, artifacts });
    const context = new ContextService({ repository: sessions, session: descriptor, history, artifacts,
      policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
    const text = 'The steering successor must contain the committed understanding.';
    const frames = [];
    let socket;
    let connections = 0;
    let handle;
    let steered = false;
    let commits = 0;
    let lost = false;
    const commit = sessions.commitContextTransition.bind(sessions);
    sessions.commitContextTransition = async (...args) => {
      const sent = frames.length;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(frames.length, sent, 'Publication must complete before fresh transport');
      if (publication === 'rejected') throw new Error('Reject staged native extension');
      const value = await commit(...args);
      commits++;
      if (publication === 'lost_receipt' && !lost) {
        lost = true;
        throw new Error('Lost native extension publication receipt');
      }
      return value;
    };
    const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket',
      webSocketFactory: () => { connections++; return (socket = new Socket((body, ws) => {
        frames.push(body);
        if (body.type === 'response.steer') {
          ws.feed({ type: 'response.steer.accepted', steer: { id: 'state-steer', previous_response_id: 'r1' } },
            { type: 'response.completed', response: response('r1', [{ ...call('state-call', 'context_transition'),
              arguments: JSON.stringify({ reason: 'Remember the corrected understanding.', sessionState: { understanding: [{ id: 'correction', text }] } }) }]) });
        } else if (!body.previous_response_id && connections === 1) {
          ws.feed({ type: 'response.created', response: { id: 'r1' } },
            { type: 'response.output_text.delta', response_id: 'r1', delta: 'Working.' });
        } else if (body.previous_response_id) {
          assert.equal(commits, 0, 'Old native input receives only its mandatory tool result');
          assert.equal(body.input[0].call_id, 'state-call');
          ws.feed({ type: 'response.created', response: { id: 'r2', previous_response_id: 'r1' } },
            { type: 'response.completed', response: response('r2', message('Selection requested.')) });
        } else {
          assert.equal(commits, publication === 'rejected' ? 0 : 1, 'Fresh state is sent only after publication');
          assert.equal(body.input.some(item => item.role === 'user' && JSON.stringify(item).includes(text)), publication !== 'rejected');
          ws.feed({ type: 'response.created', response: { id: 'fresh' } },
            { type: 'response.completed', response: response('fresh', message('Correction remembered.')) });
        }
      })); } });
    const repository = new InMemoryInferenceRepository();
    const audit = recordInferenceEvents(repository);
    const inference = new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 4 } });
    const runId = `native-state-extension-${publication}`;
    const runtime = new AgentRuntime({ provider, model: 'gpt-6-astra', maxOutputTokens: 512,
      context, inferenceService: inference, tools: context.toolDefinitions(),
      toolPolicy: { allowedRisks: ['write'] },
      toolBoundary: { authorizationPolicyId: 'native-extension-state', executionTargetId: 'native-extension-state' },
      repositories: { events, artifacts, session: { repository: sessions, descriptor } },
      onProgress(event) {
        if (!steered && event.type === 'assistant.delta') {
          steered = true;
          handle.injectSteering({ instruction: 'Use the corrected understanding.', deliveryId: 'state-steering' });
        }
      } });
    handle = runtime.run({ runId, task: 'Remember the understanding and finish.' });
    const result = await handle.result;
    const transitions = (await sessions.loadReplayState(descriptor)).branch.filter(entry => entry.type === 'context_transition');
    if (publication === 'rejected') {
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
      assert.equal(commits, 0);
      assert.equal(transitions.length, 0);
      assert.equal((await context.sessionState()).revision, null);
      assert.equal(frames.length, 4, 'Rejected state is omitted from the unchanged fresh fallback');
      return;
    }
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify({ result, errors: socket.errors, transitions: (await Array.fromAsync(events.read(runId))).filter(({event}) => event.type === 'context.transition.rejected' || event.type === 'model.failed' || event.type === 'model.stream.failed') }));
    assert.equal(transitions.length, 1);
    assert.equal(commits, 1);
    assert.equal(lost, publication === 'lost_receipt');
    assert.equal(frames.length, 4);
    assert.equal(connections, 2);
    assert.equal((await context.sessionState()).content.understanding[0].text, text);
    const extension = audit.find(({ event }) => event.type === 'inference.extended').event;
    const origin = await inference.sessionStateOrigin(runId, extension.invocationId);
    assert.equal(origin.revisionId, null, 'Steering stays bound to the old state until fresh admission');
    assert.ok(origin.capturedHistoryCut.sourceRevision > 0);
    const starts = audit.filter(({ event }) => event.type === 'inference.started');
    const fresh = starts.at(-1).event;
    const freshOrigin = await inference.sessionStateOrigin(runId, fresh.invocationId);
    assert.equal(freshOrigin.revisionId, transitions[0].id);
    const input = JSON.parse(new TextDecoder().decode(await artifacts.readVerified(freshOrigin.inference.requestRef)));
    assert.ok(JSON.stringify(input.logical).includes(text));
    assert.equal(audit.filter(({ event }) => event.type === 'inference.uncertain').length, 0);

  });
}
