import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { defineTool } from '@agent-core/tools';
import { compileModelRequest, ModelProviderError } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  InferenceService,
  InMemoryInferenceRepository,
  InMemorySessionRepository,
  HistoryReader,
  ContextService,
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
  const policy = { maxSourceBytes: 4 * 1024 * 1024, historyRead: { history, isAvailable: () => true } };
  const context = new ContextService({
    artifacts,
    repository: sessions,
    session,
    history,

    policy
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
    tools: [...createHistoryTools({ history }), ...context.toolDefinitions()],
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
    },
    setSourceCapacity(value) {
      policy.maxSourceBytes = value;
    }
  };
}

test('idle source selection records intent without invoking or claiming request admission', async () => {
  const state = await fixture();
  await state.context.transition({
      expectedWindowId: (await state.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await state.context.history.capture()).sourceRevision,
 selection: await state.context.selectSources(await state.history.capture(), {}),
 reason: 'User selection', idempotencyKey: 'idle'
    });
  assert.equal(state.requests.length, 0);
  const inspected = await state.context.inspect();
  assert.equal(inspected.window.selection.strategy, 'sources');
  assert.equal(inspected.admission, undefined);
});

test('explicit selection retains original evidence and complete parallel exchanges without rerunning tools', async () => {
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
  state.provider.complete = async (request) => {
    state.requests.push(request);
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
  const cut = await state.history.capture();
  const evidence = await state.history.search({ query: 'Original evidence.', filter: { sourceType: 'observation' }, cut });
  const selection = await state.context.selectSources(cut, { retain: [evidence.items[0].source] });
  await state.context.transition({
      expectedWindowId: (await state.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await state.context.history.capture()).sourceRevision,
 idempotencyKey: 'evidence-only', reason: 'Use original evidence', selection
    });
  const task = 'Answer from the original evidence. Do not read it again.';
  const result = await new AgentRuntime({ ...options, contextRenewal: { automatic: true } })
    .run({ task }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(reads, 2, 'Selection must not require the completed observations to be reconstructed.');
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
  assert.equal(after.workingState.revisionId, null);
});

test('model selection uses invocation identity and retains its own complete tool exchange', async () => {
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
              input: { kind: 'json', value: { reason: 'Keep the current purpose', workingState: 'Current accepted task remains active.' } }
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
    task: 'Current accepted task', runId: 'model-context-test'
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
  const inspection = await state.context.inspect();
  assert.ok(inspection.window);
  assert.equal((await state.context.workingState()).text, 'Current accepted task remains active.');
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
      const result = await runtime.run({ task: `Original ${index}: ${'x'.repeat(370000)}` }).result;
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
      contextRenewal: { automatic: false }
    }).resume('source-overflow').result;
    assert.equal(blocked.reason, 'context_admission', JSON.stringify(blocked));
    assert.equal(state.requests.length, before);
    const result = await new AgentRuntime({
      ...state.options,
      contextRenewal: { automatic: false }
    }).resume('source-overflow').result;
    assert.equal(result.reason, 'context_admission', JSON.stringify(result));
    assert.equal(state.requests.length, before);
    const inspection = await state.context.inspect();
    assert.equal(inspection.window, null);
    assert.equal(inspection.activeSelection.status, 'available');
    const inventory = (await inspectTool(state.context)).selection;
    assert.equal(inventory.status, 'available');
    assert.ok(inventory.items.length > 0, 'Metadata remains available without hydrating oversized originals.');
    const replacement = await state.context.selectSources(inspection.cut, { retain: [] });
    assert.deepEqual(replacement.retained, await state.context.protectedSources());
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

test('a model-selected fresh context keeps parallel observations and commits state once', async () => {
  const f = await fixture();
  let effects = 0;
  const read = defineTool({
    name: 'read_fact', implementationId: 'test/read-fact', description: 'Read a fact.',
    schema: z.strictObject({}), outputSchema: z.string(), canonicalizeInput: input => input,
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'fact' }], lockScopes: [] },
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'fact' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => {
      effects++;
      return { kind: 'result', output: 'Original exact evidence.', summary: 'Fact read',
        scope: { resources: ['fact'], coverage: 'complete' } };
    }
  });
  let turn = 0;
  f.provider.complete = async request => {
    f.requests.push(request);
    return ++turn === 1 ? {
      provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
      toolCalls: [
        { id: 'context-call', name: 'context_transition', type: 'function', input: { kind: 'json', value: {
          reason: 'Continue with selected originals', retain: [], continuation: 'fresh', workingState: 'Use original evidence.'
        } } },
        { id: 'fact-call', name: 'read_fact', type: 'function', input: { kind: 'json', value: {} } }
      ]
    } : { provider: 'fixture', model: 'context', content: 'Completed.', terminationReason: 'stop' };
  };
  const result = await new AgentRuntime({ ...f.options, tools: [...f.options.tools, read] })
    .run({ task: 'Current task' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(effects, 1);
  const window = (await f.context.inspect()).window;
  assert.equal(window.selection.continuity.kind, 'fresh');
  const messages = f.requests[1].messages;
  assert.deepEqual(messages.filter(item => item.role === 'tool').map(item => item.toolCallId).sort(), ['context-call', 'fact-call']);
  assert(messages.some(item => item.content?.includes('Original exact evidence.')));
  assert.equal((await f.context.workingState()).text, 'Use original evidence.');
});

async function inspectTool(context, input = {}) {
  const tool = context.toolDefinitions().find(tool => tool.name === 'context_inspect');
  const canonical = await tool.canonicalizeInput(input, {});
  const execution = await tool.bindExecution(canonical, {});
  const observation = await execution.invoke({});
  const content = await tool.buildModelContent({ observation });
  return JSON.parse(content[0].text);
}

test('model inspection pages the live selection before a window and includes its later tail', async () => {
  const f = await fixture();
  await new AgentRuntime(f.options).run({ task: 'First original' }).result;
  const initial = await inspectTool(f.context, { limit: 1, maxBytes: 4096 });
  assert.equal(initial.committedWindow, null);
  assert.equal(initial.selection.status, 'available');
  assert.equal(initial.selection.coverage, 'partial');
  assert.equal(initial.selection.items[0].type, 'input');
  const captured = initial.selection.cut;
  await new AgentRuntime(f.options).run({ task: 'Later original' }).result;
  const second = await inspectTool(f.context, { cursor: initial.selection.cursor, limit: 10, maxBytes: 4096 });
  assert.deepEqual(second.selection.cut, captured);
  assert.equal('total' in second.selection, false);
  const full = await inspectTool(f.context);
  assert(full.selection.items.some(item => item.description.includes('Later original')));
  const candidate = full.selection.items.find(item => item.type === 'assistant');
  assert.equal(candidate.group.release, 'requires_validation');
  const reduced = await f.context.selectSources(full.selection.cut, { release: [candidate.source] });
  assert(!reduced.retained.some(source => source.entryId === candidate.source.entryId));
  await f.context.transition({
      expectedWindowId: (await f.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await f.context.history.capture()).sourceRevision,
 idempotencyKey: 'selection', reason: 'Release completed answer', selection: reduced
    });
  await new AgentRuntime(f.options).run({ task: 'Tail after committed window' }).result;
  const current = await inspectTool(f.context, { maxBytes: 16384 });
  assert(current.committedWindow.windowId);
  assert(current.selection.items.some(item => item.description.includes('Tail after committed window')));
  assert(Buffer.byteLength(JSON.stringify(current.selection)) <= 16384);
  await assert.rejects(inspectTool(f.context, { maxBytes: 1 }), /cannot fit maxBytes/);
});

test('inspection advertises complete exchange groups and protects the active contribution', async () => {
  const f = await fixture();
  const resultTool = defineTool({ name: 'lookup', implementationId: 'lookup@1', description: 'Evidence', schema: z.strictObject({}),
    outputSchema: z.json(), canonicalizeInput: input => input,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'facts' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'facts' }], lockScopes: [] },
    invoke: async () => ({ kind: 'result', summary: 'Evidence', output: { fact: 1 }, scope: { resources: [], coverage: 'complete' } }) });
  let calls = 0;
  f.provider.complete = async () => ++calls === 1 ? {
    provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
    toolCalls: ['left', 'right'].map(id => ({ type: 'function', id, name: 'lookup', input: { kind: 'json', value: {} } }))
  } : { provider: 'fixture', model: 'context', content: 'done', terminationReason: 'stop' };
  await new AgentRuntime({ ...f.options, tools: [...f.options.tools, resultTool] }).run({ task: 'Original evidence' }).result;
  await f.sessions.appendInput(f.session, { runId: 'pending', task: 'Protected latest obligation' });
  const current = await inspectTool(f.context);
  const observation = current.selection.items.find(item => item.type === 'observation');
  const exchange = current.selection.items.filter(item => item.group.id === observation.group.id);
  assert.equal(exchange.filter(item => item.type === 'observation').length, 2);
  assert.equal(exchange.length, 5);
  assert.equal('sources' in observation.group, false);
  const selection = await f.context.selectSources(current.selection.cut, { release: [observation.source] });
  assert(exchange.every(item => !selection.retained.some(source => source.entryId === item.source.entryId)));
  const protectedInput = current.selection.items.find(item => item.description.includes('Protected latest obligation'));
  assert.equal(protectedInput.group.release, 'protected');
  assert(selection.retained.some(source => source.entryId === protectedInput.source.entryId));
});

for (const failNotice of [false, true]) {
  test(`capacity feedback is admitted before dispatch; optional preparation failure=${failNotice} preserves ordinary admission`, async () => {
    const f = await fixture();
    f.setCapacity(10000);
    let count = 0;
    const compiled = [];
    f.provider.compileRequest = async request => {
      const hasNotice = request.messages.some(item => item.content.includes('Context capacity notice'));
      if (failNotice && hasNotice) throw new Error('Optional count unavailable');
      const { signal, ...body } = request;
      const result = await compileModelRequest({ request, body, profile: await f.provider.describeModel(),
        endpoint: 'fixture://capacity', providerInputTokens: 9800 + (hasNotice ? 20 : 0) });
      compiled.push(result);
      return result;
    };
    f.provider.complete = async request => {
      f.requests.push(request);
      return ++count < 3 ? { provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
        toolCalls: [{ type: 'function', id: `inspect-${count}`, name: 'context_inspect', input: { kind: 'json', value: {} } }] }
        : { provider: 'fixture', model: 'context', content: 'done', terminationReason: 'stop' };
    };
    const result = await new AgentRuntime(f.options).run({ task: 'Continue useful work.' }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(f.requests.length, 3);
    const notices = f.requests.map(request => request.messages.filter(item => item.role === 'user' && item.content.includes('Context capacity notice')));
    assert(notices.every(items => items.length === (failNotice ? 0 : 1)));
    if (!failNotice) {
      assert.equal(notices[0][0].content, notices[1][0].content, 'unchanged pressure must not rewrite the notice');
      assert.match(notices[0][0].content, /not settled token usage/);
      const final = await f.context.inspect();
      assert(compiled.some(item => item.inputIdentity === final.admission.inputIdentity));
      assert.equal(final.capacity.inputTokens, 9820);
    }
  });
}

test('cancelling optional capacity preparation cannot dispatch an ordinary request afterward', async () => {
  const f = await fixture();
  const abort = new AbortController();
  f.setCapacity(10000);
  f.provider.compileRequest = async request => {
    if (request.messages.some(item => item.content.includes('Context capacity notice'))) {
      abort.abort(new Error('User cancelled.'));
      request.signal.throwIfAborted();
    }
    const { signal, ...body } = request;
    return compileModelRequest({ request, body, profile: await f.provider.describeModel(),
      endpoint: 'fixture://capacity', providerInputTokens: 9800 });
  };
  const result = await new AgentRuntime(f.options).run({ task: 'Continue.', signal: abort.signal }).result;
  assert.notEqual(result.terminal?.executionStatus, 'completed');
  assert.equal(f.requests.length, 0);
});

test('source-bound feedback is independent of compiled token pressure', async () => {
  const f = await fixture();
  for (let i = 0; i < 8; i++)
    await f.sessions.appendInput(f.session, { runId: `source-${i}`, task: 'x'.repeat(850000) });
  const compiled = await compileModelRequest({ request: { model: 'context', messages: [{ role: 'user', content: 'small' }] },
    body: { input: 'small' }, profile: await f.provider.describeModel(), endpoint: 'fixture://capacity', providerInputTokens: 100 });
  const feedback = await f.context.capacityFeedback(compiled);
  const notice = JSON.parse(feedback.notice.content);
  assert.equal(notice.capacity.pressure, 'normal');
  assert.equal(notice.sourceRead.pressure, 'near_bound');
  assert(notice.sourceRead.bytes >= 6800000);
  assert.deepEqual(notice.sourceRead.cut, await f.history.capture());
});

test('inspection discloses native prefix dependencies and calls announced before execution starts', async () => {
  const { createProviderContextState } = await import('@agent-core/model');
  const f = await fixture();
  await f.sessions.appendInput(f.session, { runId: 'bound', task: 'Protected obligation' });
  const native = await createProviderContextState({ protocolRevision: 'fixture-v1', provider: 'fixture',
    endpoint: 'fixture://native', request: { model: 'context', messages: [{ role: 'user', content: 'Protected obligation' }] },
    requestId: 'native-request', kind: 'signed', requiresExactPrefix: true, data: { opaque: 'provider-only' } });
  await f.sessions.appendAssistant(f.session, { runId: 'bound',
    identity: { turnId: 'turn', turnIndex: 1, requestAttempt: 1 }, content: '',
    output: [{ type: 'protocol', state: native }, { type: 'tool_call', toolCall: {
      id: 'pending', type: 'function', name: 'lookup', input: { kind: 'json', value: {} }
    } }] });
  const presented = await inspectTool(f.context);
  assert.equal(presented.selection.items.length, 2);
  const response = presented.selection.items.find(item => item.type === 'assistant');
  assert.equal(response.group.prefixBound, true);
  assert.equal(response.group.release, 'unfinished_exchange');
  assert.equal(presented.selection.items.find(item => item.type === 'input').group.release, 'protected');
  assert.doesNotMatch(JSON.stringify(presented.selection), /provider-only/);
});


test('every returned manifest cursor is accepted as tool input, including large captured boundaries', async () => {
  const f = await fixture();
  for (let i = 0; i < 200; i++)
    await f.sessions.appendInput(f.session, { runId: `pending-${i}-${'x'.repeat(180)}`, task: `Original ${i}` });
  const first = await inspectTool(f.context, { limit: 1, maxBytes: 256 * 1024 });
  assert(first.selection.cursor.length > 32768);
  const nextInput = { cursor: first.selection.cursor, limit: 1, maxBytes: 256 * 1024 };
  const tool = f.context.toolDefinitions().find(tool => tool.name === 'context_inspect');
  assert.equal(tool.decodeInput({ kind: 'json', value: nextInput }).ok, true);
  const next = await inspectTool(f.context, nextInput);
  assert.deepEqual(next.selection.cut, first.selection.cut);
  assert.equal(next.selection.offset, 1);
  assert.notEqual(next.selection.items[0].source.entryId, first.selection.items[0].source.entryId);
});

test('ordinary replay never hydrates a large independent recovery exchange', async () => {
  const f = await fixture();
  await f.sessions.appendInput(f.session, { runId: 'prior', task: 'Ordinary original requirement' });
  const control = await f.sessions.appendAssistant(f.session, {
    runId: 'prior', identity: { turnId: 'control', turnIndex: 1, requestAttempt: 1 },
    contextRecovery: true, content: 'Recovery control data '.repeat(30000)
  });
  const originalRead = f.sessions.readBranchEntry.bind(f.sessions);
  f.sessions.readBranchEntry = async (session, boundary, entryId) => {
    assert.notEqual(entryId, control.id, 'ordinary replay must skip control bodies before hydration');
    return originalRead(session, boundary, entryId);
  };
  const context = new ContextService({ repository: f.sessions, session: f.session,
    artifacts: new InMemoryArtifactRepository(), history: f.history,
    policy: { maxSourceBytes: 65536, historyRead: { history: f.history, isAvailable: () => true } } });
  const result = await new AgentRuntime({ ...f.options, context }).run({ task: 'Continue ordinary work' }).result;
  assert.equal(result.terminal.executionStatus, 'completed');
  assert(f.requests.length > 0);
  assert.doesNotMatch(JSON.stringify(f.requests), /Recovery control data/);
});

for (const capacity of [32000, 16000]) {
  for (const combined of [false, true]) {
    test(`${capacity} tokens: 44800-byte ${combined ? 'combined' : 'state-only'} state admits the completed exchange before publication`, async () => {
      const f = await fixture();
      f.setCapacity(capacity);
      const body = 'S'.repeat(44800);
      const candidates = [];
      let runtime;
      let rejectedRetry;
      f.provider.compileRequest = async request => {
        const { signal, ...wire } = request;
        const compiled = await compileModelRequest({ request, body: wire,
          profile: await f.provider.describeModel(), endpoint: 'fixture://state-admission',
          providerInputTokens: 1000 + Math.ceil(Buffer.byteLength(JSON.stringify(wire)) / 4) });
        candidates.push({ request, compiled });
        return compiled;
      };
      f.provider.complete = async request => {
        f.requests.push(request);
        if (f.requests.length === 1) return {
          provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
          toolCalls: [{ id: 'state', type: 'function', name: 'context_transition', input: { kind: 'json',
            value: { reason: 'Consolidate useful understanding', workingState: body, ...(combined ? { retain: [] } : {}) } } }]
        };
        const live = await f.context.workingState();
        assert.equal(live.text, capacity === 32000 ? body : '', 'Rejected admission cannot publish a revision');
        const receipt = request.messages.find(item => item.role === 'tool' && item.toolCallId === 'state');
        assert.ok(receipt, 'The admission candidate includes the originating result');
        assert.match(receipt.content, /scheduled/);
        if (capacity === 16000) {
          let command;
          for await (const record of f.events.read(`state-capacity-${capacity}-${combined}`))
            if (record.event.type === 'context.transition.requested') command = record.event.request;
          try { await runtime.scheduleContextTransition(command); }
          catch (error) { rejectedRetry = error; }
        }
        return { provider: 'fixture', model: 'context', content: 'Handled.', terminationReason: 'stop' };
      };
      runtime = new AgentRuntime(f.options);
      const result = await runtime.run({ runId: `state-capacity-${capacity}-${combined}`, task: 'Retain useful understanding.' }).result;
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
      if (capacity === 16000) assert.match(rejectedRetry?.message ?? '', /already rejected/);
      const proposed = candidates.filter(({ request }) => request.messages.some(item =>
        item.role === 'user' && item.content.includes(body)));
      assert.ok(proposed.length > 0, 'The full staged state must be compiled before commit');
      assert.ok(proposed.every(({ request }) => request.messages.some(item => item.role === 'tool' && item.toolCallId === 'state')));
      const transitions = (await f.sessions.loadReplayState(f.session)).branch.filter(item => item.type === 'context_transition');
      assert.equal(transitions.length, capacity === 32000 ? 1 : 0);
      if (transitions[0]) {
        assert.equal(transitions[0].transition.admission.status, 'admitted');
        assert.ok(proposed.some(({ compiled }) => compiled.inputIdentity === transitions[0].transition.admission.compiledInputIdentity));
      }
      const logs = [];
      for await (const record of f.events.read(`state-capacity-${capacity}-${combined}`)) logs.push(record.event);
      assert.equal(logs.some(event => event.type === 'context.transition.rejected'), capacity === 16000, logs.map(event => event.type).join(', '));
    });
  }
}

for (const lostReceipt of ['request', 'publication', 'completion_prewrite', 'completion_receipt']) {
  test(`lost ${lostReceipt} receipt reconciles one admitted state transition`, async () => {
    const f = await fixture();
    let lost = false;
    if (lostReceipt === 'publication') {
      const commit = f.sessions.commitContextTransition.bind(f.sessions);
      f.sessions.commitContextTransition = async (...args) => {
        const entry = await commit(...args);
        if (!lost && args[1].workingState) { lost = true; throw new Error('Lost publication receipt'); }
        return entry;
      };
    } else {
      const append = f.events.appendConditional.bind(f.events);
      f.events.appendConditional = async (...args) => {
        const type = lostReceipt === 'request' ? 'context.transition.requested' : 'context.transition.completed';
        const target = !lost && args.some(arg => arg?.type === type || arg?.event?.type === type);
        if (target && lostReceipt === 'completion_prewrite') {
          lost = true;
          throw new Error('Completion audit prewrite failed');
        }
        const receipt = await append(...args);
        if (target) {
          lost = true;
          throw new Error(`Lost ${lostReceipt} receipt`);
        }
        return receipt;
      };
    }
    f.provider.complete = async request => {
      f.requests.push(request);
      return f.requests.length === 1
        ? { provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
            toolCalls: [{ id: 'state', name: 'context_transition', type: 'function', input: { kind: 'json',
              value: { reason: 'Remember constraints', workingState: 'Keep exact original requirements.' } } }] }
        : { provider: 'fixture', model: 'context', content: 'Done.', terminationReason: 'stop' };
    };
    const runtime = new AgentRuntime(f.options);
    const runId = `receipt-${lostReceipt}`;
    const first = await runtime.run({ runId, task: 'Continue.' }).result;
    const result = first.terminal?.executionStatus === 'completed' ? first : await new AgentRuntime(f.options).resume(first.runId).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(lost, true);
    assert.equal((await f.context.workingState()).text, 'Keep exact original requirements.');
    const entries = (await f.sessions.loadReplayState(f.session)).branch.filter(item => item.type === 'context_transition' && item.workingState);
    assert.equal(entries.length, 1);
    const records = await Array.fromAsync(f.events.read(runId));
    assert.equal(records.filter(record => record.event.type === 'context.transition.completed').length, 1);
    assert.equal(records.filter(record => record.event.type === 'context.transition.rejected').length, 0);
    assert.equal(f.requests.length, 2);
  });
}

test('state-only replacement, unchanged text, and clear share one admitted publication operation', async () => {
  const f = await fixture();
  const bodies = ['Scoped understanding.', 'Scoped understanding.', ''];
  f.provider.complete = async request => {
    const index = f.requests.push(request) - 1;
    return index < bodies.length
      ? { provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
          toolCalls: [{ id: `state-${index}`, name: 'context_transition', type: 'function', input: { kind: 'json',
            value: { reason: 'Revise interpretation only when useful', workingState: bodies[index] } } }] }
      : { provider: 'fixture', model: 'context', content: 'Done.', terminationReason: 'stop' };
  };
  const result = await new AgentRuntime(f.options).run({ task: 'Keep requirements explicit.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const entries = (await f.sessions.loadReplayState(f.session)).branch.filter(item => item.type === 'context_transition');
  assert.equal(entries.length, 2, 'An unchanged state must not manufacture another window or revision');
  assert.equal((await f.context.workingState()).text, '');
  assert.equal(entries[1].workingState.previousRevisionId, entries[0].id);
  assert.equal(new TextDecoder().decode(await f.options.repositories.artifacts.readVerified(entries[0].workingState.contentRef)), bodies[0]);
  const receipt = f.requests[2].messages.find(item => item.role === 'tool' && item.toolCallId === 'state-1');
  assert.match(receipt.content, /unchanged/);
});

for (const fault of ['before_confirmation', 'lost_confirmation_receipt']) {
  test(`terminal confirmation ${fault} preserves outcome and repairs on resume`, async () => {
    const f = await fixture();
    const confirm = f.sessions.confirmRunFinalization.bind(f.sessions);
    let fail = true;
    f.sessions.confirmRunFinalization = async (...args) => {
      if (fail) {
        fail = false;
        if (fault === 'lost_confirmation_receipt') await confirm(...args);
        throw new Error(`Injected ${fault}`);
      }
      return confirm(...args);
    };
    const runId = `confirmation-${fault}`;
    const first = await new AgentRuntime(f.options).run({ runId, task: 'Complete once.' }).result;
    assert.equal(first.state, 'ended');
    assert.equal(first.terminal.executionStatus, 'completed');
    assert.equal(first.deliveryDiagnostics.length, 1);
    assert.equal(first.deliveryDiagnostics[0].eventType, 'session.run_finalization_confirmed');
    assert.match(first.deliveryDiagnostics[0].message, /Injected/);
    const committed = await f.events.latestOfType(runId, 'run.ended');
    assert.deepEqual(committed.event.terminal, first.terminal);
    const recorded = (await f.sessions.loadReplayState(f.session)).runFinalizations;
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].terminal, first.terminal);
    const resumed = await new AgentRuntime(f.options).resume(runId).result;
    assert.deepEqual(resumed.terminal, first.terminal);
    assert.deepEqual(resumed.deliveryDiagnostics, []);
    assert.equal(f.requests.length, 1);
    const snapshot = await f.sessions.sourceSnapshot(f.session);
    assert.ok(await snapshot.confirmedHead(runId));
    assert.deepEqual(await Array.fromAsync(snapshot.unconfirmedRuns()), []);
    const records = await Array.fromAsync(f.events.read(runId));
    assert.equal(records.filter((entry) => entry.event.type === 'run.ended').length, 1);
  });
}

test('a later rejected proposal cannot erase a committed source-capacity repair', async () => {
  const f = await fixture();
  const seed = await new AgentRuntime(f.options).run({ task: 'Old oversized source: ' + 'x'.repeat(100000) }).result;
  assert.equal(seed.terminal.executionStatus, 'completed');
  let turns = 0;
  f.provider.complete = async request => {
    f.requests.push(request);
    if (++turns === 1) {
      f.setSourceCapacity(12000);
      return { provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
        toolCalls: ['first-repair', 'second-stale'].map(id => ({ id, type: 'function', name: 'context_transition',
          input: { kind: 'json', value: { reason: id, retain: [] } } })) };
    }
    assert.ok(!JSON.stringify(request.messages).includes('Old oversized source:'));
    return { provider: 'fixture', model: 'context', content: 'Continued from the accepted repair.', terminationReason: 'stop' };
  };
  const runId = 'repair-then-reject';
  const result = await new AgentRuntime({ ...f.options, contextRenewal: { automatic: false } })
    .run({ runId, task: 'Keep the current task and release old sources.' }).result;
  const transitions = (await f.sessions.loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition');
  assert.equal(transitions.length, 1);
  const events = await Array.fromAsync(f.events.read(runId));
  assert.equal(events.filter(entry => entry.event.type === 'context.transition.rejected').length, 1);
  await f.context.assertSourceCapacity();
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(turns, 2);
});

function answerWithStateThenFinish(f) {
  f.provider.complete = async request => {
    f.requests.push(request);
    return f.requests.length === 1
      ? { provider: 'fixture', model: 'context', content: '', terminationReason: 'tool_calls',
          toolCalls: [{ id: 'state', name: 'context_transition', type: 'function', input: { kind: 'json',
            value: { reason: 'Preserve useful understanding', workingState: 'Accepted durable interpretation.' } } }] }
      : { provider: 'fixture', model: 'context', content: 'Done.', terminationReason: 'stop' };
  };
}

test('persistent completion audit failure preserves publication without rejection or transport and repairs on restart', async () => {
  const f = await fixture();
  answerWithStateThenFinish(f);
  const options = { ...f.options, inferenceService: new InferenceService({
    provider: f.provider, repository: new InMemoryInferenceRepository(), artifacts: f.options.repositories.artifacts
  }) };
  const append = f.events.appendConditional.bind(f.events);
  let unavailable = true;
  f.events.appendConditional = async (...args) => {
    if (unavailable && args.some(arg => arg?.type === 'context.transition.completed' || arg?.event?.type === 'context.transition.completed'))
      throw new Error('Completion audit unavailable');
    return append(...args);
  };
  const runId = 'completion-audit-restart';
  await assert.rejects(new AgentRuntime(options).run({ runId, task: 'Remember and finish.' }).result,
    /Completion audit unavailable/);
  assert.equal((await f.context.workingState()).text, 'Accepted durable interpretation.');
  assert.equal(f.requests.length, 1, 'Required completion audit failure must stop successor transport');
  let records = await Array.fromAsync(f.events.read(runId));
  assert.equal(records.filter(record => record.event.type === 'context.transition.rejected').length, 0);
  unavailable = false;
  const resumed = await new AgentRuntime(options).resume(runId).result;
  assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
  assert.equal(f.requests.length, 2);
  records = await Array.fromAsync(f.events.read(runId));
  assert.equal(records.filter(record => record.event.type === 'context.transition.completed').length, 1);
  assert.equal(records.filter(record => record.event.type === 'context.transition.rejected').length, 0);
  assert.equal((await f.sessions.loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition').length, 1);
});

test('abort after publication with a lost receipt preserves committed state and records truthful completion across restart', async () => {
  const f = await fixture();
  answerWithStateThenFinish(f);
  const abort = new AbortController();
  const commit = f.sessions.commitContextTransition.bind(f.sessions);
  f.sessions.commitContextTransition = async (...args) => {
    const entry = await commit(...args);
    abort.abort(new Error('Stop after publication'));
    throw new Error(`Lost committed receipt ${entry.id}`);
  };
  const runId = 'publication-abort';
  const result = await new AgentRuntime(f.options).run({ runId, task: 'Remember and finish.', signal: abort.signal }).result;
  assert.equal(result.terminal?.executionStatus, 'aborted', JSON.stringify(result));
  assert.equal((await f.context.workingState()).text, 'Accepted durable interpretation.');
  assert.equal(f.requests.length, 1);
  const records = await Array.fromAsync(f.events.read(runId));
  assert.equal(records.filter(record => record.event.type === 'context.transition.completed').length, 1);
  assert.equal(records.filter(record => record.event.type === 'context.transition.rejected').length, 0);
  const resumed = await new AgentRuntime(f.options).resume(runId).result;
  assert.deepEqual(resumed.terminal, result.terminal);
  assert.equal(f.requests.length, 1);
});
