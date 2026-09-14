import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModelRequest, createProviderContextState } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  InferenceService,
  InMemoryInferenceRepository,
  InferenceOutcomeUnknownError,
  InMemorySessionRepository,
  HistoryReader,
  ContextService,
  sourceRef,
  agentEventCodec
} from '@agent-core/runtime';

const profile = {
  id: 'native',
  provider: 'fixture',
  capabilities: {
    streaming: false,
    toolCalling: false,
    supportedToolInputs: [],
    jsonMode: false,
    jsonSchema: false,
    logprobs: false,
    temperature: false,
    topP: false,
    protocol: {
      version: 1,
      revision: 'transform1',
      endpoint: 'fixture',
      roles: ['system', 'developer', 'user', 'assistant'],
      inputKinds: ['text', 'protocol'],
      outputKinds: ['text', 'protocol'],
      state: 'exact',
      continuation: 'replay',
      asyncTools: false,
      steering: 'next_request',
      contextTransforms: ['fixture.compact'],
      toolChoice: ['auto'],
      counting: 'estimate'
    }
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 20000, outputTokens: 256 },
  supportedParameters: ['maxOutputTokens'],
  pricing: { currency: 'USD', rates: { input: 1, output: 2 } }
};
async function fixture({ tokenCount = 32, gate, budget } = {}) {
  const artifacts = new InMemoryArtifactRepository();
  const repository = new InMemoryInferenceRepository();
  const requests = [];
  let transforms = 0;
  const admitted = new WeakSet();
  const provider = {
    id: 'fixture',
    implementationId: 'fixture-transform@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'native' }),
    describeModel: async () => profile,
    async complete(request) {
      requests.push(request);
      return {
        provider: 'fixture',
        model: 'native',
        content: 'Original complete answer.',
        terminationReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 }
      };
    },
    async compileContextTransform({ request }) {
      const compiled = await compileModelRequest({
        request,
        profile,
        body: { model: request.model, input: request.messages },
        endpoint: 'fixture/compact'
      });
      admitted.add(compiled);
      return compiled;
    },
    async transformContextCompiled(transformId, compiled) {
      assert.ok(admitted.has(compiled));
      transforms++;
      if (gate) await gate;
      const state = await createProviderContextState({
        protocolRevision: 'transform1',
        provider: 'fixture',
        endpoint: 'fixture',
        request: compiled.logicalRequest,
        requestId: 'native-window',
        kind: 'fixture.compact',
        requiresExactPrefix: false,
        data: { items: compiled.body.input },
        tokenCount
      });
      return {
        transformId,
        input: [{ role: 'protocol', content: '', state }],
        state,
        usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }
      };
    }
  };
  const inference = new InferenceService({
    provider,
    repository,
    artifacts,
    ...(budget ? { budget } : {})
  });
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'test/native-context', schemaVersion: 1, subject: {} }
  });
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    policy: { maxSourceBytes: 1000000, selfContained: true }
  });
  const options = {
    provider,
    model: 'native',
    maxOutputTokens: 64,
    inferenceService: inference,
    context,
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
    toolBoundary: { authorizationPolicyId: 'none', executionTargetId: 'none' }
  };
  return {
    artifacts,
    repository,
    inference,
    sessions,
    session,
    events,
    history,
    context,
    options,
    requests,
    transforms: () => transforms
  };
}
async function transitionInput(state) {
  const cut = await state.history.capture();
  const page = await state.history.page({ cut, limit: 1000, maxBytes: 1000000 });
  assert.equal(page.coverage, 'complete');
  return {
    expectedWindowId: null,
    idempotencyKey: 'native-window',
    reason: 'Native transformation',
    selection: {
      strategy: 'provider',
      retained: page.entries.map((entry) => sourceRef(cut.sessionId, entry)),
      notes: []
    }
  };
}
async function applyTransition(state, transition) {
  let runtime;
  let scheduled = false;
  runtime = new AgentRuntime({
    ...state.options,
    onProgress: async (event) => {
      if (event.type === 'turn.started' && !scheduled) {
        scheduled = true;
        await runtime.scheduleContextTransition(transition);
      }
    }
  });
  return runtime.run({ runId: 'transform-run', task: 'Continue with exact native state.' }).result;
}
test('provider transform settlement is followed by actual next-generation admission', async () => {
  const state = await fixture();
  await new AgentRuntime(state.options).run({
    runId: 'source-run',
    task: 'Original source BLUE-82.'
  }).result;
  const result = await applyTransition(state, await transitionInput(state));
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(state.transforms(), 1);
  const context = await state.context.inspect();
  assert.equal(context.window.selection.strategy, 'provider');
  assert.equal(context.admission.status, 'admitted');
  const request = state.requests.at(-1);
  assert.ok(request.messages.some((item) => item.role === 'protocol'));
  assert.equal(
    request.messages.filter((item) => item.content === 'Continue with exact native state.').length,
    1
  );
  const owner = await state.repository.load('transform-run');
  assert.deepEqual(
    [...owner.invocations.values()].map((item) => item.start.operation),
    ['context_transform', 'generation']
  );
});
test('oversized transformed context is charged but never activated', async () => {
  const state = await fixture({ tokenCount: 30000 });
  await new AgentRuntime(state.options).run({ runId: 'source-run', task: 'Original source.' })
    .result;
  await applyTransition(state, await transitionInput(state));
  assert.equal(state.transforms(), 1);
  assert.equal((await state.context.inspect()).window, null);
  const owner = await state.repository.load('transform-run');
  assert.ok(
    [...owner.invocations.values()].some(
      (item) => item.start.operation === 'context_transform' && item.settlement
    )
  );
});

test('canceled native transforms remain uncertain and late results settle the original shared permit', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const state = await fixture({ gate });
  const abort = new AbortController();
  const request = {
    invocationId: 'transform-one',
    ownerId: 'owner',
    purpose: 'context_transformation',
    transformId: 'transform-one',
    request: {
      model: 'native',
      messages: [{ role: 'user', content: 'Original.' }],
      maxOutputTokens: 64
    }
  };
  const active = state.inference.transformContext({ ...request, signal: abort.signal });
  while (state.transforms() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  abort.abort(new Error('stop'));
  await assert.rejects(active, InferenceOutcomeUnknownError);
  await assert.rejects(state.inference.transformContext(request), InferenceOutcomeUnknownError);
  assert.equal(state.transforms(), 1);
  release();
  while (!(await state.repository.load('owner')).invocations.get('transform-one').settlement)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const replay = await state.inference.transformContext(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.transformId, 'transform-one');
  assert.equal(state.transforms(), 1);
});

test('ordinary runtime output replays typed provider protocol unchanged into the next run', async () => {
  const state = await fixture();
  const originalComplete = state.options.provider.complete;
  let protocol;
  state.options.provider.complete = async (request) => {
    const response = await originalComplete(request);
    if (!protocol) {
      protocol = await createProviderContextState({
        protocolRevision: 'transform1',
        provider: 'fixture',
        endpoint: 'fixture',
        request,
        requestId: 'response-origin',
        kind: 'fixture.reasoning',
        requiresExactPrefix: false,
        data: { opaque: 'original-provider-payload' },
        tokenCount: 16
      });
      return {
        ...response,
        output: [
          { type: 'protocol', state: protocol },
          { type: 'text', text: response.content }
        ]
      };
    }
    return response;
  };
  assert.equal(
    (await new AgentRuntime(state.options).run({ task: 'First full source.' }).result).terminal
      .executionStatus,
    'completed'
  );
  assert.equal(
    (
      await new AgentRuntime(state.options).run({ task: 'Continue the same original source.' })
        .result
    ).terminal.executionStatus,
    'completed'
  );
  assert.deepEqual(
    state.requests
      .at(-1)
      .messages.filter((item) => item.role === 'protocol')
      .map((item) => item.state),
    [protocol]
  );
});
