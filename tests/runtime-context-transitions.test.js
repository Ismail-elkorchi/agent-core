import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  InMemorySessionRepository,
  InMemoryNoteRepository,
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
  const notes = new InMemoryNoteRepository({ artifacts });
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    notes,
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
        content: 'Recorded answer.',
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
    notes,
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

test('bounded automatic renewal continues without notes and preserves current input and settings', async () => {
  const state = await fixture();
  const original = 'Old detail. '.repeat(9000);
  const first = await new AgentRuntime(state.options).run({ task: original }).result;
  assert.equal(first.terminal?.executionStatus, 'completed', JSON.stringify(first));
  state.setCapacity(6000);
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
  assert.equal(inspected.window.selection.notes.length, 0);
  assert.match(inspected.window.reason, /policy-triggered/);
  assert.equal(inspected.admission.status, 'admitted');
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
  const result = await new AgentRuntime({ ...state.options, provider }).run({
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
          content: 'Continued after reduction.',
          terminationReason: 'stop'
        };
      }
    };
    const result = await new AgentRuntime({
      ...state.options,
      provider,
      contextRenewal: { automatic: true }
    }).run({ task: 'Current work' }).result;
    assert.equal(seen.length, 2, JSON.stringify(result));
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

for (const [length, retainedNotes] of [
  [80, 1],
  [18000, 0]
]) {
  test(`automatic renewal retains ${retainedNotes} admissible optional notes without deleting their originals`, async () => {
    const state = await fixture();
    const old = await new AgentRuntime(state.options).run({
      task: 'Optional earlier detail. '.repeat(3000)
    }).result;
    assert.equal(old.terminal?.executionStatus, 'completed', JSON.stringify(old));
    const scope = { sessionId: state.session.id, branchId: state.session.id };
    const written = await state.notes.write({
      scope,
      noteId: 'working-note',
      title: 'Model hypothesis',
      mediaType: 'text/plain',
      content: 'x'.repeat(length),
      expectedRevision: null,
      idempotencyKey: 'write',
      authorId: 'model',
      invocationId: 'note-write'
    });
    assert.equal(written.status, 'committed');
    const originals = await state.history.search({ filter: { sourceType: 'input' }, limit: 30 });
    await state.context.request({
      idempotencyKey: 'select-note',
      reason: 'Keep a fallible working note',
      selection: {
        strategy: 'sources',
        retained: originals.items.map((item) => item.source),
        notes: [{ scope, noteId: written.revision.noteId, revisionId: written.revision.revisionId }]
      }
    });
    state.setCapacity(6000);
    const result = await new AgentRuntime({
      ...state.options,
      contextRenewal: { automatic: true }
    }).run({ task: 'Continue the same task.' }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal((await state.context.inspect()).window.selection.notes.length, retainedNotes);
    assert.equal(
      (
        await state.notes.read({
          scope,
          noteId: 'working-note',
          revisionId: written.revision.revisionId,
          maxBytes: 32768
        })
      ).text,
      'x'.repeat(length)
    );
  });
}

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
  const runtime = new AgentRuntime({ ...state.options, provider });
  const result = await runtime.run({ task: 'Keep this original instruction.' }).result;
  assert.equal(result.reason, 'context_admission', JSON.stringify(result));
  const resumed = await runtime.resume(result.runId).result;
  assert.equal(resumed.reason, 'context_admission', JSON.stringify(resumed));
  assert.equal(requests, 1);
  assert.equal((await state.context.inspect()).admission.status, 'blocked');
});
