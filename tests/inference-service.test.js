import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  agentEventCodec,
  InferenceService,
  InMemoryInferenceRepository,
  InferenceOutcomeUnknownError,
  InferenceBudgetExceededError
} from '@agent-core/runtime';
import { JsonlInferenceRepository } from '@agent-core/runtime/node';

const profile = {
  id: 'classifier',
  provider: 'fixture',
  capabilities: {
    streaming: false,
    toolCalling: false,
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: true,
    jsonSchema: false,
    logprobs: false,
    temperature: false,
    topP: false
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 20000, outputTokens: 1000 },
  supportedParameters: ['maxOutputTokens', 'responseFormat']
};
function fixture(complete) {
  return {
    id: 'fixture',
    implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'classifier' }),
    describeModel: async () => profile,
    complete
  };
}
function response(request, content = '{"category":"inquiry"}') {
  return {
    provider: 'fixture',
    model: request.model,
    content,
    terminationReason: 'stop',
    usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 }
  };
}
function input(invocationId = 'one', ownerId = 'work') {
  return {
    invocationId,
    ownerId,
    purpose: 'classification',
    request: {
      model: 'classifier',
      messages: [
        { role: 'developer', content: 'Classify the text.' },
        { role: 'user', content: 'When does it open?' }
      ],
      responseFormat: 'json',
      maxOutputTokens: 100
    }
  };
}

test('classification uses durable invocation without a session, workflow, checks, or final-text contract', async () => {
  let calls = 0;
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  const provider = fixture(async (request) => {
    calls++;
    assert.equal(request.messages.length, 2);
    return response(request);
  });
  const service = new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 1 } });
  const first = await service.invoke(input());
  assert.deepEqual(JSON.parse(first.response.content), { category: 'inquiry' });
  const replay = await new InferenceService({
    provider,
    repository,
    artifacts,
    budget: { maxInvocations: 1 }
  }).invoke(input());
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  await assert.rejects(
    service.invoke({
      ...input(),
      request: { ...input().request, messages: [{ role: 'user', content: 'Changed input' }] }
    }),
    /different input/
  );
  await assert.rejects(service.invoke(input('two')), InferenceBudgetExceededError);
  const state = await repository.load('work');
  assert.equal(state.invocations.size, 1);
  assert.equal(state.invocations.get('one').settlement.usage.promptTokens, 40);
});

test('concurrent auxiliary invocations reserve one shared owner budget transactionally', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = fixture(async (request) => {
    calls++;
    await gate;
    return response(request);
  });
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  const services = [0, 1].map(
    () => new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 1 } })
  );
  const results = Promise.allSettled(
    services.map((service, index) => service.invoke(input(`call${index}`)))
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const settled = await results;
  assert.equal(calls, 1);
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(
    settled.some(
      (item) => item.status === 'rejected' && item.reason instanceof InferenceBudgetExceededError
    )
  );
});

test('aborted dispatch remains uncertain, does not replay spend, and a late result settles its original identity', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = fixture(async (request) => {
    calls++;
    await gate;
    return response(request, 'late');
  });
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  const service = new InferenceService({ provider, repository, artifacts });
  const controller = new AbortController();
  const active = service.invoke({ ...input(), signal: controller.signal });
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort(new Error('stop'));
  await assert.rejects(active, InferenceOutcomeUnknownError);
  await assert.rejects(service.invoke(input()), InferenceOutcomeUnknownError);
  assert.equal(calls, 1);
  release();
  while (!(await repository.load('work')).invocations.get('one').settlement)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const replay = await service.invoke(input());
  assert.equal(replay.response.content, 'late');
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
});

test('unavailable provider outcome survives repository reopen and preserves reserved budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inference-reopen-'));
  try {
    const repository = new JsonlInferenceRepository({ rootDir: path.join(root, 'events') });
    const artifacts = new InMemoryArtifactRepository();
    let calls = 0;
    const provider = fixture(async () => {
      calls++;
      throw new Error('disconnect');
    });
    await assert.rejects(
      new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 1 } }).invoke(
        input()
      ),
      InferenceOutcomeUnknownError
    );
    const reopened = new InferenceService({
      provider,
      repository: new JsonlInferenceRepository({ rootDir: path.join(root, 'events') }),
      artifacts,
      budget: { maxInvocations: 1 }
    });
    await assert.rejects(reopened.invoke(input()), InferenceOutcomeUnknownError);
    await assert.rejects(reopened.invoke(input('different')), InferenceBudgetExceededError);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aborting before admission consumes no invocation and auxiliary inference rejects missing durability', async () => {
  const repository = new InMemoryInferenceRepository();
  let calls = 0;
  const provider = fixture(async (request) => {
    calls++;
    return response(request);
  });
  const service = new InferenceService({
    provider,
    repository,
    artifacts: new InMemoryArtifactRepository()
  });
  await assert.rejects(
    service.invoke({ ...input(), signal: AbortSignal.abort(new Error('before')) }),
    /before/
  );
  assert.equal((await repository.load('work')).invocations.size, 0);
  assert.equal(calls, 0);
  assert.throws(() => new InferenceService({ provider }), /explicit invocation and artifact repositories/);
});

test('primary runtime requests and auxiliary verification consume the same durable owner allowance', async () => {
  let calls = 0;
  const provider = fixture(async (request) => {
    calls++;
    return response(request, 'Primary result.');
  });
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  const service = new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 1 } });
  const events = new InMemoryEventRepository(agentEventCodec);
  const runtime = new AgentRuntime({
    provider,
    model: 'classifier',
    inferenceService: service,
    maxOutputTokens: 100,
    repositories: { events, artifacts },
    toolBoundary: { authorizationPolicyId: 'none', executionTargetId: 'none' }
  });
  const result = await runtime.run({ runId: 'shared-owner', task: 'Produce the primary result.' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed');
  await assert.rejects(
    service.invoke({ ...input('verification', 'shared-owner'), purpose: 'semantic_verification' }),
    InferenceBudgetExceededError
  );
  assert.equal(calls, 1);
  assert.equal((await repository.load('shared-owner')).invocations.size, 1);
});

test('durable output replay preserves binary media and provider protocol ownership', async () => {
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  let calls = 0;
  const provider = fixture(async (request) => {
    calls++;
    return {
      ...response(request),
      output: [
        {
          type: 'media',
          part: {
            type: 'image',
            image: { type: 'bytes', data: new Uint8Array([0, 127, 255]), mediaType: 'image/png' }
          }
        }
      ]
    };
  });
  const service = new InferenceService({ provider, repository, artifacts });
  const first = await service.invoke(input());
  const replay = await new InferenceService({ provider, repository, artifacts }).invoke(input());
  assert.equal(calls, 1);
  assert.deepEqual(replay.response.output, first.response.output);
  assert.deepEqual([...Buffer.from(replay.response.output[0].part.image.data, 'base64')], [0, 127, 255]);
});

test('known monetary spend persists before later admission rejects and unknown prices remain explicit', async () => {
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  const priced = { ...profile, pricing: { currency: 'USD', rates: { input: 1, output: 1 } } };
  let calls = 0;
  const provider = {
    ...fixture(async (request) => {
      calls++;
      return {
        ...response(request),
        usage: { promptTokens: 300, completionTokens: 100, totalTokens: 400 }
      };
    }),
    describeModel: async () => priced
  };
  const service = new InferenceService({
    provider,
    repository,
    artifacts,
    budget: { maxKnownCost: { amount: 0.0003, currency: 'USD' } }
  });
  const settled = await service.invoke(input());
  assert.equal(settled.cost.status, 'known');
  assert.ok(Math.abs(settled.cost.amount - 0.0004) < 1e-12);
  assert.ok(
    Math.abs((await repository.load('work')).invocations.get('one').settlement.cost.amount - 0.0004) < 1e-12
  );
  await assert.rejects(
    service.invoke(input('after')),
    (error) => error instanceof InferenceBudgetExceededError && error.resource === 'known_cost'
  );
  assert.equal(calls, 1);
  const unknown = await new InferenceService({
    provider: fixture(async (request) => response(request)),
    repository: new InMemoryInferenceRepository(),
    artifacts
  }).invoke(input());
  assert.equal(unknown.cost.status, 'unknown');
  assert.equal(unknown.cost.unknownTokens, 50);
  assert.equal(unknown.cost.amount, undefined);
});

test('fencing rejection before dispatch durably releases the owning reservation', async () => {
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  let calls = 0;
  const provider = fixture(async (request) => {
    calls++;
    return response(request);
  });
  const service = new InferenceService({ provider, repository, artifacts, budget: { maxInvocations: 1 } });
  await assert.rejects(
    service.invokeWithLifecycle(
      { request: input().request, profile, session: { complete: provider.complete }, turnIndex: 0 },
      {
        start: async () => {
          throw new Error('fencing denied');
        },
        settle: async () => {
          throw new Error('must not settle');
        },
        uncertain: async () => {
          throw new Error('must not invent uncertainty');
        }
      },
      input()
    ),
    /fencing denied/
  );
  const rejected = (await repository.load('work')).invocations.get('one');
  assert.equal(rejected.notSent.type, 'inference.not_sent');
  assert.equal(rejected.uncertain, undefined);
  assert.equal(calls, 0);
  await service.invoke(input('allowed'));
  assert.equal(calls, 1);
});

test('cancellation during durable reservation releases only a request that never dispatched', async () => {
  const repository = new InMemoryInferenceRepository();
  const append = repository.append.bind(repository);
  const abort = new AbortController();
  repository.append = async (owner, event, tail) => {
    const result = await append(owner, event, tail);
    if (event.type === 'inference.started') abort.abort(new Error('before dispatch'));
    return result;
  };
  let calls = 0;
  const service = new InferenceService({
    provider: fixture(async (request) => {
      calls++;
      return response(request);
    }),
    repository,
    artifacts: new InMemoryArtifactRepository()
  });
  await assert.rejects(service.invoke({ ...input(), signal: abort.signal }), /before dispatch/);
  assert.equal(calls, 0);
  const record = (await repository.load('work')).invocations.get('one');
  assert.ok(record.notSent);
  assert.equal(record.uncertain, undefined);
});

test('inference budget configuration is owned at construction and rejects unknown limits', async () => {
  const budget = { maxInvocations: 1 };
  let calls = 0;
  const provider = fixture(async (request) => {
    calls++;
    return response(request);
  });
  const service = new InferenceService({
    provider,
    repository: new InMemoryInferenceRepository(),
    artifacts: new InMemoryArtifactRepository(),
    budget
  });
  budget.maxInvocations = 0;
  await service.invoke(input());
  await assert.rejects(service.invoke(input('second')), InferenceBudgetExceededError);
  assert.equal(calls, 1);
  assert.throws(
    () => InferenceService.inMemory({ provider, budget: { maxInvocations: 1, invented: 2 } }),
    /Unsupported/
  );
});

test('runtime binds cancellation before compilation and dispatches the exact immutable admitted request', async () => {
  const { compileModelRequest } = await import('@agent-core/model');
  let compiled;
  let sends = 0;
  const provider = {
    ...fixture(async () => {
      throw new Error('compiled dispatch required');
    }),
    compileRequest: async (request) => {
      compiled = await compileModelRequest({
        request,
        profile,
        body: {
          model: request.model,
          messages: request.messages,
          max_output_tokens: request.maxOutputTokens
        },
        endpoint: 'fixture'
      });
      return compiled;
    },
    completeCompiled: async (value) => {
      assert.equal(value, compiled);
      assert.ok(Object.isFrozen(value));
      assert.ok(value.logicalRequest.signal);
      sends++;
      return response(value.logicalRequest, 'Done.');
    }
  };
  const runtime = new AgentRuntime({
    provider,
    model: 'classifier',
    maxOutputTokens: 100,
    repositories: { events: new InMemoryEventRepository(agentEventCodec) },
    toolBoundary: { authorizationPolicyId: 'none', executionTargetId: 'none' }
  });
  const ended = await runtime.run({ task: 'Use the admitted body.' }).result;
  assert.equal(ended.terminal.executionStatus, 'completed');
  assert.equal(sends, 1);
});

test('precompiled input is admitted before any invocation or external effect is started', async () => {
  const { compileModelRequest } = await import('@agent-core/model');
  let calls = 0;
  let starts = 0;
  const provider = fixture(async (request) => { calls++; return response(request); });
  const repository = new InMemoryInferenceRepository();
  const service = new InferenceService({ provider, repository, artifacts: new InMemoryArtifactRepository() });
  const request = { model: profile.id, messages: [{ role: 'user', content: 'Hello' }] };
  for (const policy of [{}, { outputReservation: 100_000 }]) {
    const compiled = await compileModelRequest({ request, profile, body: request, endpoint: 'fixture', ...policy });
    await assert.rejects(service.invokeWithLifecycle(
      { request, compiled, profile, session: service.createSession(), turnIndex: 1 },
      {
        async start() { starts++; },
        async settle() { assert.fail('Rejected input cannot settle'); },
        async uncertain() { assert.fail('Admission failure is not an unknown provider outcome'); }
      },
      input()
    ), /admission limits/);
  }
  assert.equal(starts, 0);
  assert.equal(calls, 0);
  assert.equal((await repository.load('work')).invocations.size, 0);
  await service.invoke(input());
  assert.equal(calls, 1);
});

test('runtime reserves Codex output without sending an unsupported generation control', async () => {
  const { OpenAICodexProvider } = await import('@agent-core/provider-openai-codex');
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-test' } })).toString('base64url')}.test`;
  const requests = [];
  const provider = new OpenAICodexProvider({
    auth: { type: 'bearer', tokenProvider: {
      describe: () => ({ type: 'oauth', label: 'offline test', provider: 'openai-codex' }),
      async getBearerToken() { return { token }; }
    } },
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.equal('max_output_tokens' in body, false);
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'first-response', model: body.model, status: 'completed', output_text: 'Hello.', output: [] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  const repository = new InMemoryInferenceRepository();
  const service = new InferenceService({ provider, repository, artifacts: new InMemoryArtifactRepository() });
  for (const maxOutputTokens of [undefined, 777]) {
    const runtime = new AgentRuntime({
      provider, model: 'gpt-5.6-luna', inferenceService: service,
      repositories: { events: new InMemoryEventRepository(agentEventCodec) },
      toolBoundary: { authorizationPolicyId: 'none', executionTargetId: 'none' },
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
    });
    const run = runtime.run({ task: 'Say hello.' });
    const result = await run.result;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
    const invocations = [...(await repository.load(result.terminal.runId)).invocations.values()];
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].start.reservation.completionTokens, maxOutputTokens ?? 4096);
    assert.ok(invocations[0].settlement);
    assert.equal(invocations[0].uncertain, undefined);
  }
  assert.equal(requests.length, 2);
});

test('interrupted provider output preserves the cause and partial text without redispatch', async () => {
  const events = [];
  const repository = new InMemoryEventRepository(agentEventCodec);
  let calls = 0;
  const provider = {
    ...fixture(async () => assert.fail('stream required')),
    describeModel: async () => ({ ...profile, capabilities: { ...profile.capabilities, streaming: true } }),
    async *stream() {
      calls++;
      yield { type: 'content', content: 'Partial answer', accumulated: 'Partial answer' };
      throw new Error('Connection closed while reading the response');
    }
  };
  const runtime = new AgentRuntime({ provider, model: profile.id, onProgress: event => { events.push(event); },
    repositories: { events: repository },
    toolBoundary: { authorizationPolicyId: 'none', executionTargetId: 'none' }
  });
  const run = runtime.run({ task: 'Explain.' });
  const result = await run.result;
  assert.equal(result.state, 'suspended');
  assert.equal(result.reason, 'provider_outcome_unknown');
  assert.equal(calls, 1);
  const interrupted = events.find(event => event.type === 'assistant.interrupted');
  assert.equal(interrupted.content, 'Partial answer');
  assert.equal(interrupted.modelOutput.status, 'partial');
  assert.equal(interrupted.diagnostic.causeSummary.message, 'Connection closed while reading the response');
});


test('durable replay binds the output reservation policy independently of the wire request', async () => {
  let calls = 0;
  const provider = fixture(async request => { calls++; return response(request); });
  const service = InferenceService.inMemory({ provider });
  const request = { model: profile.id, messages: [{ role: 'user', content: 'Hello' }] };
  const invocation = { ...input(), request, outputReservation: 100 };
  await service.invoke(invocation);
  assert.equal((await service.invoke(invocation)).replayed, true);
  await assert.rejects(service.invoke({ ...invocation, outputReservation: 200 }), /different input or configuration/);
  assert.equal(calls, 1);
});
