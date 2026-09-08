import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  InMemorySessionRepository,
  HistoryReader,
  InMemoryNoteRepository,
  ContextService,
  createHistoryTools,
  createRuntimeContextBootstrapValidator,
  sourceRef,
  agentEventCodec
} from '@agent-core/runtime';

function profile(contextTokens = 40000) {
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
      temperature: false,
      topP: false
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens, outputTokens: 256 },
    supportedParameters: ['maxOutputTokens', 'tools']
  };
}
async function fixture() {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'tests/runtime-context', schemaVersion: 1, subject: {} }
  });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const notes = new InMemoryNoteRepository({ artifacts });
  const tools = createHistoryTools({ history });
  const requests = [];
  let capacity = 40000;
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
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    notes,
    bootstrap: {
      maxBytes: 1000000,
      historyRead: { history, isAvailable: () => tools.some((tool) => tool.name === 'history_read') },
      validate: createRuntimeContextBootstrapValidator({
        provider,
        model: 'context',
        tools: () => tools,
        maxOutputTokens: 128
      })
    }
  });
  const options = {
    provider,
    model: 'context',
    maxOutputTokens: 128,
    tools,
    context,
    notes,
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }
  };
  return {
    sessions,
    session,
    events,
    artifacts,
    history,
    notes,
    context,
    requests,
    options,
    setCapacity(value) {
      capacity = value;
    }
  };
}
async function noteSelection(state) {
  const view = await state.history.view();
  const scope = { sessionId: view.cut.sessionId, branchId: view.cut.branchId };
  const note = await state.notes.write({
    scope,
    noteId: 'entry',
    title: 'Selected entry',
    mediaType: 'text/plain',
    content: 'Selected note: preserve identifier BLUE-82.',
    expectedRevision: null,
    idempotencyKey: 'write-entry',
    authorId: 'model',
    invocationId: 'note-invocation',
    sources: [sourceRef(view.cut.sessionId, view.entries[0])]
  });
  assert.equal(note.status, 'committed');
  return {
    view,
    selection: {
      retained: [],
      notes: [
        { scope: note.revision.scope, noteId: note.revision.noteId, revisionId: note.revision.revisionId }
      ],
      omitted: [
        {
          fromEntryId: view.entries[0].id,
          toEntryId: view.entries.at(-1).id,
          reason: 'Authorized retrieval retains original sources.'
        }
      ],
      strategy: 'notes'
    }
  };
}

test('committed context selections activate selected notes and retain every later original contribution', async () => {
  const state = await fixture();
  const runtime = new AgentRuntime(state.options);
  const original = 'Original source: identifier BLUE-82. ' + 'Long original detail. '.repeat(300);
  assert.equal((await runtime.run({ task: original }).result).terminal.executionStatus, 'completed');
  const { view, selection } = await noteSelection(state);
  await state.context.transition({
    expectedWindowId: null,
    idempotencyKey: 'transition',
    selection,
    reason: 'Use selected note and retrieval.'
  });
  assert.equal(
    (await runtime.run({ task: 'Next contribution.' }).result).terminal.executionStatus,
    'completed'
  );
  const next = state.requests.at(-1).messages;
  assert.equal(next.filter((item) => item.content === original).length, 0);
  assert.equal(next.filter((item) => item.content === 'Next contribution.').length, 1);
  assert.equal(
    next.filter((item) => item.content.includes('Selected note: preserve identifier BLUE-82.')).length,
    1
  );
  await runtime.run({ task: 'Later correction: identifier GREEN-93.' }).result;
  const later = state.requests.at(-1).messages;
  assert.equal(later.filter((item) => item.content === 'Next contribution.').length, 1);
  assert.equal(later.filter((item) => item.content === 'Later correction: identifier GREEN-93.').length, 1);
  const retrieved = await state.history.read({
    source: sourceRef(view.cut.sessionId, view.entries[0]),
    maxBytes: 64000
  });
  assert.equal(retrieved.status, 'available');
  assert.ok(retrieved.item.text.includes(original));
});

test('automatic pressure invokes the same committed transition path and recompiles the next request', async () => {
  const state = await fixture();
  const original = 'Important original source BLUE-82. ' + 'large paragraph '.repeat(3000);
  const runtime = new AgentRuntime(state.options);
  assert.equal((await runtime.run({ task: original }).result).terminal.executionStatus, 'completed');
  const { selection } = await noteSelection(state);
  state.setCapacity(6000);
  let transitions = 0;
  const next = new AgentRuntime({
    ...state.options,
    contextPressurePolicy: ({ context }) => {
      transitions++;
      return {
        expectedWindowId: context.window?.windowId ?? null,
        idempotencyKey: 'pressure',
        selection,
        reason: 'Context pressure'
      };
    }
  });
  const result = await next.run({ task: 'Continue from the selected entry.' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed');
  assert.equal(transitions, 1);
  assert.equal((await state.context.inspect()).window.reason, 'Context pressure');
  assert.ok(
    state.requests
      .at(-1)
      .messages.some((item) => item.content.includes('Selected note: preserve identifier BLUE-82.'))
  );
});

test('model context tools durably schedule at a legal boundary and publish the committed window', async () => {
  const state = await fixture();
  await new AgentRuntime(state.options).run({ task: 'Original archival contribution.' }).result;
  let runtime;
  let called = false;
  const progress = [];
  const view = await state.history.view();
  const request = {
    expectedWindowId: null,
    idempotencyKey: 'model-transition',
    reason: 'Requested by model',
    selection: {
      retained: view.entries.map((entry) => sourceRef(view.cut.sessionId, entry)),
      notes: [],
      omitted: [],
      strategy: 'retain'
    }
  };
  const { createContextTools } = await import('@agent-core/runtime');
  const context = new ContextService({
    repository: state.sessions,
    session: state.session,
    history: state.history,
    bootstrap: {
      maxBytes: 1000000,
      historyRead: { history: state.history, isAvailable: () => true },
      schedule: (input) => runtime.scheduleContextTransition(input),
      validate: createRuntimeContextBootstrapValidator({
        provider: state.options.provider,
        model: 'context',
        tools: () => tools,
        maxOutputTokens: 128
      })
    }
  });
  const tools = [...state.options.tools, ...createContextTools({ context })];
  const provider = {
    ...state.options.provider,
    complete: async (input) => {
      if (!called) {
        called = true;
        return {
          provider: 'fixture',
          model: 'context',
          content: '',
          terminationReason: 'tool_calls',
          toolCalls: [
            {
              type: 'function',
              id: 'transition-call',
              name: 'context_transition',
              input: { kind: 'json', value: request }
            }
          ]
        };
      }
      assert.equal((await context.inspect()).window.reason, 'Requested by model');
      assert.equal(input.messages.filter((item) => item.content === 'Current contribution.').length, 1);
      return {
        provider: 'fixture',
        model: 'context',
        content: 'Transition applied.',
        terminationReason: 'stop'
      };
    }
  };
  runtime = new AgentRuntime({
    ...state.options,
    provider,
    context,
    tools,
    toolPolicy: { allowedRisks: ['read', 'write'] },
    onProgress: (event) => {
      progress.push(event);
    }
  });
  const result = await runtime.run({ runId: 'scheduled-run', task: 'Current contribution.' }).result;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(result.terminal.executionStatus, 'completed');
  const events = [];
  for await (const record of state.events.read('scheduled-run')) events.push(record.event);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith('context.transition.')).map((event) => event.type),
    ['context.transition.requested', 'context.transition.admitted', 'context.transition.completed']
  );
  assert.equal(progress.filter((event) => event.type === 'context.transitioned').length, 1);
});

test('scheduled context requests also drain after the final provider response and terminal replay does not duplicate them', async () => {
  const state = await fixture();
  await new AgentRuntime(state.options).run({ task: 'Earlier source.' }).result;
  let runtime;
  let queued;
  let second = false;
  const view = await state.history.view();
  const transition = {
    expectedWindowId: null,
    idempotencyKey: 'restart-transition',
    reason: 'Durable requested transition',
    selection: {
      retained: view.entries.map((entry) => sourceRef(view.cut.sessionId, entry)),
      notes: [],
      omitted: [],
      strategy: 'retain'
    }
  };
  // Admission can occur while the provider is active; the committed request lives in the run ledger.
  const provider = {
    ...state.options.provider,
    complete: async () => {
      queued = await runtime.scheduleContextTransition(transition);
      return { provider: 'fixture', model: 'context', content: 'Done.', terminationReason: 'stop' };
    }
  };
  runtime = new AgentRuntime({ ...state.options, provider });
  const result = await runtime.run({ runId: 'last-boundary', task: 'A final task.' }).result;
  assert.equal(result.terminal.executionStatus, 'completed');
  assert.ok(queued.requestId);
  const entries = [];
  for await (const record of state.events.read('last-boundary')) entries.push(record.event);
  assert.equal(entries.filter((event) => event.type === 'context.transition.requested').length, 1);
  assert.equal(entries.filter((event) => event.type === 'context.transition.completed').length, 1);
  const replay = new AgentRuntime({
    ...state.options,
    provider: {
      ...state.options.provider,
      complete: async (request) => {
        second = true;
        return state.options.provider.complete(request);
      }
    }
  });
  const ended = await replay.resume('last-boundary').result;
  assert.equal(ended.state, 'ended');
  assert.equal(second, false);
  assert.equal((await state.context.inspect()).window.reason, 'Durable requested transition');
});

test('a context request accepted before interruption is reconstructed and committed on resume', async () => {
  const state = await fixture();
  await new AgentRuntime(state.options).run({ task: 'Archived original source.' }).result;
  const view = await state.history.view();
  const transition = {
    expectedWindowId: null,
    idempotencyKey: 'interrupted-context',
    reason: 'Recover accepted context work',
    selection: {
      retained: view.entries.map((entry) => sourceRef(view.cut.sessionId, entry)),
      notes: [],
      omitted: [],
      strategy: 'retain'
    }
  };
  const originalAppend = state.events.appendConditional.bind(state.events);
  let interrupt = true;
  state.events.appendConditional = async (runId, event, options) => {
    if (interrupt && event.type === 'context.transition.admitted')
      throw new Error('Simulated process loss before context admission');
    return originalAppend(runId, event, options);
  };
  let runtime;
  let requests = 0;
  const provider = {
    ...state.options.provider,
    complete: async () => {
      requests++;
      await runtime.scheduleContextTransition(transition);
      return {
        provider: 'fixture',
        model: 'context',
        content: 'Known provider result.',
        terminationReason: 'stop'
      };
    }
  };
  runtime = new AgentRuntime({ ...state.options, provider });
  await assert.rejects(
    runtime.run({ runId: 'context-recovery', task: 'Current recovery source.' }).result,
    /Simulated process loss/
  );
  assert.equal((await state.context.inspect()).window, null);
  interrupt = false;
  // The provider settlement remains known; resume must recover queued control work without redispatch.
  runtime = new AgentRuntime({ ...state.options, provider });
  const recovered = await runtime.resume('context-recovery').result;
  assert.equal(recovered.state, 'ended');
  assert.equal(requests, 1);
  assert.equal((await state.context.inspect()).window.reason, 'Recover accepted context work');
  const receipts = [];
  for await (const record of state.events.read('context-recovery'))
    if (record.event.type.startsWith('context.transition.')) receipts.push(record.event);
  assert.equal(receipts.filter((event) => event.type === 'context.transition.requested').length, 1);
  assert.equal(receipts.filter((event) => event.type === 'context.transition.completed').length, 1);
});

test('explicit observation representations shorten requests without altering retrievable history', async () => {
  const state = await fixture();
  const runId = 'original';
  const identity = {
    turnId: 'turn-original',
    turnIndex: 1,
    requestAttempt: 1,
    toolBatchId: 'batch-original',
    callIndex: 0,
    callId: 'original-call'
  };
  await state.sessions.appendInput(state.session, { runId, task: 'Inspect the original record.' });
  await state.sessions.appendAssistant(state.session, { runId, identity, content: 'Reading.' });
  await state.sessions.appendToolCall(state.session, {
    runId,
    identity,
    call: { id: identity.callId, name: 'read', input: { kind: 'json', value: {} } }
  });
  await state.sessions.appendObservation(state.session, {
    runId,
    identity: { ...identity, toolAttempt: 1 },
    toolName: 'read',
    observation: {
      ok: true,
      summary: 'Original recorded summary.',
      output: { detail: 'EXACT-ORIGINAL-'.repeat(500) }
    }
  });
  const view = await state.history.view();
  const observation = view.entries.find((entry) => entry.type === 'observation');
  const source = sourceRef(view.cut.sessionId, observation);
  await state.context.transition({
    expectedWindowId: null,
    expectedSourceRevision: view.cut.sourceRevision,
    idempotencyKey: 'choose-summary',
    reason: 'Use the recorded summary and retrieve original detail as needed.',
    selection: {
      strategy: 'retain',
      retained: view.entries.map((entry) => sourceRef(view.cut.sessionId, entry)),
      representations: [{ source, presentation: 'summary' }],
      notes: [],
      omitted: []
    }
  });
  const result = await new AgentRuntime(state.options).run({ task: 'Continue.' }).result;
  assert.equal(result.terminal.executionStatus, 'completed');
  const delivered = state.requests.at(-1).messages.find((item) => item.role === 'tool');
  assert.equal(delivered.toolCallId, identity.callId);
  assert.equal(JSON.parse(delivered.content).representation, 'summary');
  assert.equal(delivered.content.includes('EXACT-ORIGINAL'), false);
  const original = await state.history.read({ source, maxBytes: 32000 });
  assert.equal(original.status, 'available');
  assert.equal(original.item.text.includes('EXACT-ORIGINAL'), true);
  assert.equal(
    (await state.context.inspect()).window.selection.representations[0].source.sha256,
    source.sha256
  );
});
