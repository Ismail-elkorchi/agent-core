import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { defineTool } from '@agent-core/tools';
import { compileModelRequest, ModelContractError, ModelProviderError, requestAccountingInputTokens } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  InMemorySessionRepository,
  InferenceService,
  HistoryReader,
  ContextService,
  createContextTools,
  createHistoryTools,
  agentEventCodec
} from '@agent-core/runtime';

function profile(capacity) {
  return {
    id: 'context',
    provider: 'fixture',
    capabilities: {
      streaming: false,
      toolCalling: true,
      supportedToolInputs: [{ kind: 'json' }],
      jsonMode: false,
      jsonSchema: false,
      logprobs: false,
      temperature: true,
      topP: false
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: capacity, outputTokens: 256 },
    supportedParameters: ['maxOutputTokens', 'tools', 'temperature']
  };
}
async function fixture() {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'tests/context', schemaVersion: 1, subject: {} }
  });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({
    artifacts,
    repository: sessions,
    session,
    history,

    policy: { maxSourceBytes: 4 * 1024 * 1024, historyRead: { history, isAvailable: () => true } }
  });
  const requests = [];
  let capacity = 60000;
  const provider = {
    id: 'fixture',
    implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'context' }),
    describeModel: async () => profile(capacity),
    complete: async (request) => {
      requests.push(request);
      return {
        provider: 'fixture',
        model: 'context',
        content: request.tools
          ? 'Recorded answer.'
          : JSON.stringify({
              text: 'Recorded answer.'
            }),
        terminationReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }
      };
    }
  };
  const options = {
    provider,
    model: 'context',
    context,

    maxOutputTokens: 128,
    tools: [...createHistoryTools({ history }), ...createContextTools({ context })],
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
    toolPolicy: { allowedRisks: ['read', 'write'] }
  };
  return {
    sessions,
    session,
    events,
    history,
    context,
    requests,

    provider,
    options,
    setCapacity(value) {
      capacity = value;
    }
  };
}

test('idle source selection records intent without invoking or claiming request admission', async () => {
  const state = await fixture();
  await state.context.request({ reason: 'User selection', idempotencyKey: 'idle' });
  assert.equal(state.requests.length, 0);
  const inspected = await state.context.inspect();
  assert.equal(inspected.window.selection.strategy, 'sources');
  assert.equal(inspected.admission, undefined);
});

test('automatic renewal revises working state and preserves current input and settings', async () => {
  const state = await fixture();
  const original = 'Old detail. '.repeat(9000);
  const first = await new AgentRuntime(state.options).run({ task: original }).result;
  assert.equal(first.terminal?.executionStatus, 'completed', JSON.stringify(first));
  state.setCapacity(45000);
  let captures = 0;
  const runtime = new AgentRuntime({
    ...state.options,
    contextRenewal: { automatic: true },
    temperature: 0.3,
    contextProvider: () => {
      captures++;
      return [
        {
          id: 'guidance-revision',
          sourceUri: 'app://guidance',
          sourceKind: 'external',
          representation: 'full',
          mediaType: 'text/plain',
          title: 'Guidance',
          content: 'Exact captured guidance',
          purpose: 'Applicable guidance'
        }
      ];
    }
  });
  const result = await runtime.run({ task: 'Continue the same work.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(captures, 1);
  const request = state.requests.at(-1);
  assert.equal(request.temperature, 0.3);
  assert.equal(
    request.messages.filter((item) => item.content === 'Continue the same work.').length,
    1
  );
  assert.ok(request.messages.some((item) => item.content.includes('Exact captured guidance')));
  assert.ok(!request.messages.some((item) => item.content === original));
  const inspected = await state.context.inspect();
  assert.ok(inspected.workingState.revisionId);
  assert.match(inspected.window.reason, /working-state/);
  assert.equal(state.requests.length, 3);
  assert.equal(state.requests[1].tools, undefined);
  assert.ok(JSON.stringify(state.requests[1].messages).includes(original));
  assert.equal(inspected.admission.status, 'admitted');
});

test('automatic renewal retains original evidence and complete parallel exchanges without rerunning tools', async () => {
  const state = await fixture();
  let reads = 0;
  const lookup = defineTool({
    name: 'lookup', implementationId: 'lookup@1', description: 'Read original evidence.',
    schema: z.strictObject({ source: z.string() }),
    outputSchema: z.strictObject({ source: z.string(), revision: z.number() }),
    canonicalizeInput: input => input,
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'facts' }], lockScopes: [] },
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'facts' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async ({ source }) => {
      reads++;
      return { kind: 'result', output: { source, revision: 2 }, summary: 'Original evidence.',
        scope: { resources: ['facts'], coverage: 'complete' } };
    }
  });
  let generations = 0;
  let renewals = 0;
  state.provider.complete = async (request) => {
    state.requests.push(request);
    if (!request.tools) {
      renewals++;
      return { provider: 'fixture', model: 'context', content: JSON.stringify({ text: 'Use original evidence for the next answer.' }),
        terminationReason: 'stop' };
    }
    generations++;
    return { provider: 'fixture', model: 'context',
      content: generations === 1 ? '' : 'Revision two is supported by both original sources.',
      terminationReason: generations === 1 ? 'tool_calls' : 'stop',
      ...(generations === 1 ? { toolCalls: ['left', 'right'].map(source => ({
        id: source, name: 'lookup', type: 'function', input: { kind: 'json', value: { source } }
      })) } : {}) };
  };
  const options = { ...state.options, tools: [...state.options.tools, lookup] };
  const original = 'Old detail. '.repeat(9000);
  const first = await new AgentRuntime(options).run({ task: original }).result;
  assert.equal(first.terminal?.executionStatus, 'completed', JSON.stringify(first));
  assert.equal(reads, 2);
  const before = await state.context.inspect();
  state.setCapacity(requestAccountingInputTokens(before.admission.accounting) + 64);
  const task = 'Answer from the original evidence. Do not read it again.';
  const result = await new AgentRuntime({ ...options, contextRenewal: { automatic: true } })
    .run({ task }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(renewals, 1);
  assert.equal(reads, 2, 'Renewal must not require the completed observations to be reconstructed.');
  const admitted = state.requests.at(-1);
  assert.equal(admitted.messages.filter(item => item.content === task).length, 1);
  assert.ok(!admitted.messages.some(item => item.content === original));
  const calls = admitted.messages.flatMap(item => item.role === 'assistant' ? item.toolCalls ?? [] : []);
  assert.deepEqual(calls.map(call => call.id), ['left', 'right']);
  const observations = admitted.messages.filter(item => item.role === 'tool');
  assert.deepEqual(observations.map(item => item.toolCallId), ['left', 'right']);
  assert.ok(observations.every(item => /"revision"\s*:\s*2/u.test(item.content)), JSON.stringify(observations));
  const after = await state.context.inspect();
  assert.ok(after.window.selection.retained.length > 1);
  assert.ok(after.workingState.revisionId);
});

test('model renewal uses invocation identity and retains its own complete tool exchange', async () => {
  const state = await fixture();
  let calls = 0;
  let renewedRequest;
  const provider = {
    ...state.provider,
    complete: async (request) => {
      calls++;
      if (calls === 1)
        return {
          provider: 'fixture',
          model: 'context',
          content: '',
          terminationReason: 'tool_calls',
          toolCalls: [
            {
              type: 'function',
              id: 'renew-call',
              name: 'context_transition',
              input: { kind: 'json', value: { reason: 'Model-requested fresh window' } }
            }
          ]
        };
      renewedRequest = request;
      return {
        provider: 'fixture',
        model: 'context',
        content: 'Continued.',
        terminationReason: 'stop'
      };
    }
  };
  const result = await new AgentRuntime({
    ...state.options,
    provider
  }).run({
    task: 'Current accepted task'
  }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(calls, 2);
  assert.equal(
    renewedRequest.messages.filter((item) => item.content === 'Current accepted task').length,
    1
  );
  assert.ok(
    renewedRequest.messages.some((item) => item.role === 'tool' && item.toolCallId === 'renew-call')
  );
  assert.ok((await state.context.inspect()).window);
});

test('automatic renewal credits the capacity released by its smaller compiled request', async () => {
  const state = await fixture();
  state.provider.complete = async (request) => {
    state.requests.push(request);
    return {
      provider: 'fixture', model: 'context', terminationReason: 'stop',
      content: request.tools ? 'Recorded answer.' : '{"text":"Useful state"}'
    };
  };
  await new AgentRuntime(state.options).run({ task: 'Original detail. '.repeat(1000) }).result;
  await new AgentRuntime(state.options).run({ task: 'Continue.' }).result;
  const before = await state.context.inspect();
  state.setCapacity(requestAccountingInputTokens(before.admission.accounting) + 228);
  const result = await new AgentRuntime({ ...state.options, contextRenewal: { automatic: true } })
    .run({ task: 'Continue.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(state.requests.length, 3, 'A smaller maintenance request needs no redundant reserve.');
  assert.ok(state.requests.every((request) => request.tools));
  assert.deepEqual((await state.context.inspect()).window, before.window);
});

test('a later contribution cannot rebase an automatic renewal onto an unseen source boundary', async () => {
  const state = await fixture();
  const complete = state.provider.complete;
  state.provider.complete = async (request) => {
    const { usage, ...response } = await complete(request);
    return response;
  };
  await new AgentRuntime(state.options).run({ task: 'Old detail. '.repeat(9000) }).result;
  const before = await state.context.inspect();
  state.setCapacity(requestAccountingInputTokens(before.admission.accounting) + 64);
  const generation = state.provider.complete;
  state.provider.complete = async (request) => {
    if (!request.tools)
      await state.sessions.appendInput(state.session, {
        runId: 'later', task: 'Later correction outside the captured inference.'
      });
    return generation(request);
  };
  const result = await new AgentRuntime({ ...state.options, contextRenewal: { automatic: true } })
    .run({ task: 'Continue.' }).result;
  assert.match(result.terminal?.errorMessage, /expected boundary is stale/u);
  const after = await state.context.inspect();
  assert.deepEqual(after.window, before.window);
  assert.deepEqual(after.workingState, before.workingState);
  const retrieved = await state.history.search({ query: 'Later correction', filter: { sourceType: 'input' } });
  assert.equal(retrieved.items.length, 1);
});

test('irreducible protected input suspends without provider invocation or a fake tool identity', async () => {
  const state = await fixture();
  state.setCapacity(1500);
  const result = await new AgentRuntime({
    ...state.options,
    contextRenewal: { automatic: true }
  }).run({ task: 'Protected user input '.repeat(4000) }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  assert.equal(state.requests.length, 0);
  assert.equal(result.effectId, undefined);
});

test('definitive provider overflow retries only a reduced admitted selection and bounds a second rejection', async () => {
  const { ModelProviderError } = await import('@agent-core/model');
  for (const rejectTwice of [false, true]) {
    const state = await fixture();
    await new AgentRuntime(state.options).run({ task: 'Optional old detail. '.repeat(1500) })
      .result;
    const seen = [];
    const provider = {
      ...state.provider,
      complete: async (request) => {
        seen.push(request);
        if (seen.length === 1 || rejectTwice)
          throw new ModelProviderError({
            provider: 'fixture',
            code: 'context_overflow',
            message: 'Provider reports context capacity.',
            retryable: false
          });
        return {
          provider: 'fixture',
          model: 'context',
          content: request.tools?.length
            ? 'Continued after reduction.'
            : JSON.stringify({ text: '' }),
          terminationReason: 'stop'
        };
      }
    };
    const result = await new AgentRuntime({
      ...state.options,
      provider,
      contextRenewal: { automatic: true }
    }).run({ task: 'Current work' }).result;
    assert.equal(seen.length, rejectTwice ? 2 : 3, JSON.stringify(result));
    assert.ok(JSON.stringify(seen[1]).length < JSON.stringify(seen[0]).length);
    if (rejectTwice) assert.equal(result.reason, 'context_admission', JSON.stringify(result));
    else assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  }
});

test('unchanged admission stays suspended; an admissible changed capacity resumes the same run', async () => {
  const state = await fixture();
  state.setCapacity(1500);
  const result = await new AgentRuntime(state.options).run({
    runId: 'suspended-capacity',
    task: 'Protected content '.repeat(800)
  }).result;
  assert.equal(result.reason, 'context_admission', JSON.stringify(result));
  const unchanged = await new AgentRuntime(state.options).resume('suspended-capacity').result;
  assert.equal(unchanged.reason, 'context_admission');
  assert.equal(state.requests.length, 0);
  state.setCapacity(30000);
  const resumed = await new AgentRuntime(state.options).resume('suspended-capacity').result;
  assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.terminal.runId, 'suspended-capacity');
});

test('application instructions refresh for each new admitted inference during one run', async () => {
  const state = await fixture();
  const requests = [];
  let revision = 0;
  const provider = {
    ...state.provider,
    complete: async (request) => {
      requests.push(request);
      return requests.length === 1
        ? {
            provider: 'fixture',
            model: 'context',
            content: '',
            terminationReason: 'tool_calls',
            toolCalls: [
              {
                type: 'function',
                id: 'inspect',
                name: 'context_inspect',
                input: { kind: 'json', value: {} }
              }
            ]
          }
        : {
            provider: 'fixture',
            model: 'context',
            content: 'Finished.',
            terminationReason: 'stop'
          };
    }
  };
  const result = await new AgentRuntime({
    ...state.options,
    provider,
    instructions: () => [
      {
        id: `guidance-${++revision}`,
        role: 'developer',
        content: `Current guidance revision ${revision}`
      }
    ]
  }).run({ task: 'Inspect the available context.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(requests.length, 2);
  assert.ok(
    requests[1].messages.some((item) =>
      item.content.includes(`Current guidance revision ${revision}`)
    )
  );
  assert.ok(
    !requests[1].messages.some((item) => item.content.includes('Current guidance revision 1'))
  );
});

test('definitive provider rejection cannot be retried by resuming the same input and constraints', async () => {
  const { ModelProviderError } = await import('@agent-core/model');
  const state = await fixture();
  let requests = 0;
  const provider = {
    ...state.provider,
    complete: async () => {
      requests++;
      throw new ModelProviderError({
        provider: 'fixture',
        code: 'context_overflow',
        message: 'Provider capacity exceeded.',
        retryable: false
      });
    }
  };
  const runtime = new AgentRuntime({
    ...state.options,
    provider
  });
  const result = await runtime.run({ task: 'Keep this original instruction.' }).result;
  assert.equal(result.reason, 'context_admission', JSON.stringify(result));
  const resumed = await runtime.resume(result.runId).result;
  assert.equal(resumed.reason, 'context_admission', JSON.stringify(resumed));
  assert.equal(requests, 1);
  assert.equal((await state.context.inspect()).admission.status, 'blocked');
});

test('retained source membership cannot reorder original user and assistant turns', async () => {
  const state = await fixture();
  const runtime = new AgentRuntime(state.options);
  await runtime.run({ task: 'First original request.' }).result;
  await runtime.run({ task: 'Second original correction.' }).result;
  const originals = await state.history.search({ query: '', limit: 100 });
  const retained = originals.items.map((item) => item.source).reverse();
  const cut = await state.history.capture();
  await state.context.transition({
    expectedWindowId: null,
    expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'reversed-membership',
    reason: 'Retain all originals.',
    selection: { strategy: 'sources', retained }
  });
  const result = await new AgentRuntime(state.options).run({ task: 'Follow up.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const messages = state.requests
    .at(-1)
    .messages.filter((item) => item.role === 'user' || item.role === 'assistant');
  assert.deepEqual(
    messages.map((item) => item.content),
    [
      'First original request.',
      'Recorded answer.',
      'Second original correction.',
      'Recorded answer.',
      'Follow up.'
    ]
  );
});

test(
  'source byte exhaustion preserves the window until an explicit bounded selection is supplied',
  { timeout: 120000 },
  async () => {
    const state = await fixture();
    state.setCapacity(10000000);
    const runtime = new AgentRuntime(state.options);
    for (let index = 0; index < 11; index++) {
      const result = await runtime.run({ task: `Original ${index}: ${'x'.repeat(750000)}` }).result;
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    }
    const before = state.requests.length;
    const task = `Current accepted input: ${'y'.repeat(200000)}`;
    const suspended = await new AgentRuntime(state.options).run({ runId: 'source-overflow', task })
      .result;
    assert.equal(suspended.reason, 'context_admission', JSON.stringify(suspended));
    assert.equal(suspended.contextAdmission.kind, 'source_capacity');
    assert.equal(suspended.contextAdmission.inputIdentity, undefined);
    assert.equal(state.requests.length, before);
    const tiny = new ContextService({
      repository: state.sessions,
      session: state.session,
      history: state.history,
      artifacts: state.options.repositories.artifacts,
      policy: {
        maxSourceBytes: 1,
        historyRead: { history: state.history, isAvailable: () => true }
      }
    });
    const blocked = await new AgentRuntime({
      ...state.options,
      context: tiny,
      contextRenewal: { automatic: true }
    }).resume('source-overflow').result;
    assert.equal(blocked.reason, 'context_admission', JSON.stringify(blocked));
    assert.equal(state.requests.length, before);
    const result = await new AgentRuntime({
      ...state.options,
      contextRenewal: { automatic: true }
    }).resume('source-overflow').result;
    assert.equal(result.reason, 'context_admission', JSON.stringify(result));
    assert.equal(state.requests.length, before);
    assert.equal((await state.context.inspect()).window, null);
    await state.context.transition({
      expectedWindowId: null,
      idempotencyKey: 'explicit-selection',
      reason: 'Explicit user selection',
      selection: { strategy: 'sources', retained: await state.context.protectedSources() }
    });
    const resumed = await new AgentRuntime(state.options).resume('source-overflow').result;
    assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
    assert.equal(state.requests.length, before + 1);
    assert.equal(state.requests.at(-1).messages.filter((item) => item.content === task).length, 1);
    assert.ok(JSON.stringify(state.requests.at(-1)).length < 500000);
    assert.equal((await state.context.inspect()).window.selection.strategy, 'sources');
  }
);

test('an incomplete continuation never replaces the working context', async () => {
  const state = await fixture();
  await new AgentRuntime(state.options).run({ task: 'Earlier requirements' }).result;
  const provider = {
    ...state.provider,
    complete: async (request) => {
      if (request.tools)
        throw new ModelProviderError({
          provider: 'fixture',
          code: 'context_overflow',
          message: 'Context full',
          retryable: false
        });
      return {
        provider: 'fixture',
        model: 'context',
        content: 'Unfinished notes',
        terminationReason: 'output_limit',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 }
      };
    }
  };
  const result = await new AgentRuntime({
    ...state.options,
    provider,
    contextRenewal: { automatic: true }
  }).run({ task: 'Continue the work' }).result;
  assert.equal(result.reason, 'context_admission', JSON.stringify(result));
  assert.equal((await state.context.inspect()).window, null);
  assert.equal(result.budget.promptTokens, 30);
});

test('large output reservations do not trigger renewal of a short conversation', async () => {
  const state = await fixture();
  await new AgentRuntime(state.options).run({ task: 'Original requirements.' }).result;
  const provider = {
    ...state.provider,
    describeModel: async () => ({
      ...profile(32768),
      limits: { contextTokens: 32768, outputTokens: 16384 }
    })
  };
  const result = await new AgentRuntime({
    ...state.options,
    provider,
    maxOutputTokens: 16384,
    contextRenewal: { automatic: true }
  }).run({ task: 'Continue.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(state.requests.length, 2);
  assert.ok(
    state.requests[1].messages.some((message) => message.content === 'Original requirements.')
  );
  assert.equal((await state.context.inspect()).window, null);
});

for (const failure of ['transient', 'unsupported', 'invalid_request', 'integrity', 'cancellation', 'ordinary']) {
  test(`renewal preparation (${failure}) preserves only a lawful ordinary request`, async () => {
    const state = await fixture();
    await new AgentRuntime(state.options).run({ task: 'Preserve these original requirements.' }).result;
    const before = await state.context.inspect();
    const abort = new AbortController();
    let preparations = 0;
    const provider = {
      ...state.provider,
      compileRequest: async (request, options) => {
        const renewal = request.messages.some(message =>
          message.content?.startsWith('Runtime context-maintenance task.')
        );
        if (renewal) {
          preparations++;
          if (failure === 'cancellation') {
            abort.abort(new Error('User cancelled preparation'));
            request.signal?.throwIfAborted();
          }
          if (failure === 'integrity') throw new Error('Compiled input integrity failed');
          if (failure === 'unsupported') throw new ModelContractError(
            'Renewal cannot change the preserved tool catalog.', ['Native prefix is bound.']
          );
          throw new ModelProviderError({ provider: 'fixture',
            code: failure === 'invalid_request' ? 'invalid_request' : 'provider_unavailable',
            message: 'Renewal preparation unavailable', retryable: failure === 'transient'
          });
        }
        if (failure === 'ordinary') throw new ModelContractError('Ordinary native input is incompatible.', []);
        const { signal, ...body } = request;
        return compileModelRequest({ ...options, request, profile: profile(60000), body, endpoint: 'fixture' });
      }
    };
    const result = await new AgentRuntime({ ...state.options, provider,
      contextRenewal: { automatic: true }
    }).run({ task: 'Continue.', signal: abort.signal }).result;
    assert.equal(preparations, failure === 'ordinary' ? 0 : 1);
    const canContinue = ['transient', 'unsupported', 'invalid_request'].includes(failure);
    assert.equal(state.requests.length, canContinue ? 2 : 1, JSON.stringify(result));
    const after = await state.context.inspect();
    assert.deepEqual(after.window, before.window);
    assert.deepEqual(after.workingState, before.workingState);
    if (canContinue) {
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
      assert.equal(after.admission.status, 'admitted');
      assert.match(after.admission.message, /renewal unavailable.*ordinary request still fits/i);
      assert.ok(state.requests[1].messages.some(message => message.content === 'Preserve these original requirements.'));
    } else if (failure === 'cancellation') {
      assert.equal(result.terminal?.executionStatus, 'aborted', JSON.stringify(result));
    } else {
      assert.equal(result.terminal?.executionStatus, 'failed', JSON.stringify(result));
      assert.match(result.terminal.errorMessage, failure === 'ordinary' ? /Ordinary native input/ : /integrity failed/);
    }
  });
}

test('unavailable renewal preparation cannot authorize an oversized ordinary request', async () => {
  const state = await fixture();
  await new AgentRuntime(state.options).run({ task: 'Original evidence. '.repeat(1000) }).result;
  state.setCapacity(1024);
  const before = await state.context.inspect();
  let preparations = 0;
  const provider = {
    ...state.provider,
    compileRequest: async (request, options) => {
      if (request.messages.some(message => message.content?.startsWith('Runtime context-maintenance task.'))) {
        preparations++;
        throw new ModelProviderError({ provider: 'fixture', code: 'provider_unavailable',
          message: 'Renewal token counting unavailable', retryable: true });
      }
      const { signal, ...body } = request;
      return compileModelRequest({ ...options, request, profile: profile(1024), body, endpoint: 'fixture' });
    }
  };
  const result = await new AgentRuntime({ ...state.options, provider,
    contextRenewal: { automatic: true }
  }).run({ task: 'Continue.' }).result;
  assert.equal(preparations, 1);
  assert.equal(state.requests.length, 1);
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  const after = await state.context.inspect();
  assert.equal(after.admission.status, 'blocked');
  assert.match(after.admission.message, /Renewal token counting unavailable/);
  assert.deepEqual(after.window, before.window);
  assert.deepEqual(after.workingState, before.workingState);
});

for (const failure of ['incomplete', 'transport', 'stream']) {
  test(`a failed proactive renewal (${failure}) preserves an admitted working context`, async () => {
    const state = await fixture();
    const original = 'Preserve the original requirements. '.repeat(700);
    await new AgentRuntime(state.options).run({ task: original }).result;
    const before = await state.context.inspect();
    let renewals = 0;
    let generations = 0;
    const provider = {
      ...state.provider,
      describeModel: async () => ({
        ...profile(32768),
        capabilities: { ...profile(32768).capabilities, streaming: failure === 'stream' },
        limits: { contextTokens: 32768, outputTokens: 16384 }
      }),
      complete: async (request) => {
        if (!request.tools) {
          renewals++;
          if (failure !== 'incomplete') throw new ModelProviderError({
            provider: 'fixture', code: 'provider_unavailable',
            message: 'Renewal transport failed', retryable: true
          });
          return {
            provider: 'fixture', model: 'context', content: 'Incomplete renewal',
            terminationReason: 'output_limit',
            usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 }
          };
        }
        generations++;
        assert.ok(request.messages.some((message) => message.content === original));
        assert.ok(request.messages.some((message) => message.content === 'Recorded answer.'));
        return {
          provider: 'fixture', model: 'context',
          content: 'Continued using the original context.', terminationReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }
        };
      },
      async *stream(request) {
        if (!request.tools) yield {
          type: 'content', content: '{"text":"Partial', accumulated: '{"text":"Partial'
        };
        yield { type: 'done', response: await this.complete(request) };
      }
    };
    const inference = InferenceService.inMemory({ provider });
    const result = await new AgentRuntime({
      ...state.options, provider, inferenceService: inference,
      maxOutputTokens: 16384, contextRenewal: { automatic: true }
    }).run({ task: 'Continue.' }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(renewals, 1);
    assert.equal(generations, 1);
    const after = await state.context.inspect();
    assert.deepEqual(after.window, before.window);
    assert.deepEqual(after.workingState, before.workingState);
    assert.equal(after.admission.status, 'admitted');
    assert.equal(result.terminal.budget.promptTokens, failure === 'incomplete' ? 50 : 20);
    if (failure !== 'incomplete') {
      const owner = await inference.options.repository.load(result.terminal.runId);
      assert.equal(owner.committed.invocations, 2);
      assert.equal(owner.settledUsage.invocations, 1);
    }
  });
}

for (const failure of ['required-transport', 'persistence', 'cancellation']) {
  test(`renewal (${failure}) cannot bypass admission, storage integrity or cancellation`, async () => {
    const state = await fixture();
    await new AgentRuntime(state.options).run({
      task: 'Preserve the original requirements. '.repeat(700)
    }).result;
    const before = await state.context.inspect();
    const abort = new AbortController();
    let renewals = 0;
    let generations = 0;
    const provider = {
      ...state.provider,
      describeModel: async () => ({
        ...profile(32768),
        limits: {
          contextTokens: 32768,
          outputTokens: 16384
        }
      }),
      complete: async (request) => {
        if (request.tools) {
          generations++;
          if (failure === 'required-transport') throw new ModelProviderError({
            provider: 'fixture', code: 'context_overflow',
            message: 'Ordinary context rejected', retryable: false
          });
          return state.provider.complete(request);
        }
        renewals++;
        if (failure === 'required-transport') throw new ModelProviderError({
          provider: 'fixture', code: 'provider_unavailable',
          message: 'Renewal transport failed', retryable: true
        });
        if (failure === 'cancellation') {
          abort.abort(new Error('User cancelled renewal'));
          request.signal?.throwIfAborted();
        }
        return { provider: 'fixture', model: 'context', content: '{"text":"Useful state"}',
          terminationReason: 'stop' };
      }
    };
    if (failure === 'persistence') state.context.stageWorkingState = async () => {
      throw new Error('Working-state storage failed');
    };
    const result = await new AgentRuntime({
      ...state.options, provider,
      maxOutputTokens: failure === 'required-transport' ? 4096 : 16384,
      contextRenewal: { automatic: true }
    }).run({ task: 'Continue.', signal: abort.signal }).result;
    assert.equal(renewals, 1, JSON.stringify(result));
    assert.equal(generations, failure === 'required-transport' ? 1 : 0);
    if (failure === 'required-transport') {
      assert.equal(result.state, 'suspended');
      assert.equal(result.reason, 'context_admission');
    } else if (failure === 'persistence') {
      assert.equal(result.terminal?.terminationReason, 'runtime_error');
      assert.match(result.terminal.errorMessage, /Working-state storage failed/);
    } else assert.equal(result.terminal?.executionStatus, 'aborted');
    const after = await state.context.inspect();
    assert.deepEqual(after.window, before.window);
    assert.deepEqual(after.workingState, before.workingState);
  });
}

test('a changed admitted request resumes a definitively rejected provider request without unresolved-outcome recovery', async () => {
  const state = await fixture();
  let extra = 'Optional captured context before the rejection.';
  let calls = 0;
  const provider = {
    ...state.provider,
    complete: async (request) => {
      calls++;
      if (calls === 1)
        throw new ModelProviderError({
          provider: 'fixture',
          code: 'context_overflow',
          message: 'Provider rejected the initial input.',
          retryable: false
        });
      return state.provider.complete(request);
    }
  };
  const runtime = new AgentRuntime({
    ...state.options,
    provider,
    contextProvider: () =>
      extra
        ? [
            {
              id: 'capture',
              sourceKind: 'external',
              sourceUri: 'test://optional-context',
              representation: 'full',
              mediaType: 'text/plain',
              title: 'Captured context',
              purpose: 'Optional evidence',
              content: extra
            }
          ]
        : []
  });
  const suspended = await runtime.run({ task: 'Keep the original work.' }).result;
  assert.equal(suspended.reason, 'context_admission');
  assert.equal(suspended.contextAdmission.kind, 'provider_capacity');
  extra = '';
  const result = await runtime.resume(suspended.runId).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(calls, 2);
  assert.equal(
    state.requests[0].messages.filter((item) => item.content === 'Keep the original work.').length,
    1
  );
});
