import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProviderContextState, parseModelSelection, conservativeProtocolCapabilities } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentSession,
  AgentRunCoordinator,
  AgentRuntime,
  ContextService,
  HistoryReader,
  InMemorySessionRepository,
  assertHistoryModelCompatibility,
  sourceRef,
  agentEventCodec
} from '@agent-core/runtime';
import { JsonlSessionRepository, SessionHistorySourceError } from '@agent-core/runtime/node';

const binding = { schemaId: 'test/fresh-continuation', schemaVersion: 1, subject: {} };
const identity = { turnId: 'turn', turnIndex: 1, requestAttempt: 1 };
function profile(provider = 'portable') {
  return {
    provider,
    id: 'model',
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 64000, outputTokens: 1000 },
    supportedParameters: ['maxOutputTokens', 'tools'],
    capabilities: {
      streaming: false,
      protocol: conservativeProtocolCapabilities('https://portable.example', { contextReset: 'fresh_request', inputKinds: ['text', 'image', 'tool_call', 'tool_result'], toolChoice: ['auto', 'none', 'required', 'named'] }),
      toolCalling: true,
      supportedToolInputs: [{ kind: 'json' }],
      jsonMode: false,
      jsonSchema: false,
      logprobs: false,
      temperature: false,
      topP: false
    }
  };
}
async function fixture(sessions = new InMemorySessionRepository(), descriptor) {
  const session = descriptor ?? (await sessions.create({ binding }));
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session, artifacts });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    artifacts,
    policy: { maxSourceBytes: 1000000, historyRead: { history, isAvailable: () => true } }
  });
  const requests = [];
  const provider = {
    id: 'portable',
    implementationId: 'test/portable@1',
    describe: () => ({ id: 'portable', displayName: 'Portable' }),
    describeModel: async () => profile(),
    complete: async (request) => {
      requests.push(request);
      return {
        provider: 'portable',
        model: 'model',
        content: 'Continued.',
        terminationReason: 'stop'
      };
    }
  };
  const agent = new AgentSession({
    descriptor: session,
    expectedBinding: binding,
    repository: sessions,
    runs: new AgentRunCoordinator(events, artifacts),
    context,
    configuration: { provider: 'portable', model: 'model' },
    createRuntime: async (settings, onProgress) =>
      new AgentRuntime({
        provider,
        model: settings.model,
        context,
        tools: [],
        maxOutputTokens: 128,
        onProgress,
        repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
        toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }
      })
  });
  return { sessions, session, history, context, agent, artifacts, requests, provider, events };
}
async function nativeAnswer(f) {
  const input = await f.sessions.appendInput(f.session, {
    runId: 'past',
    task: 'Keep my exact constraint: café العربية.',
    instructions: []
  });
  const state = await createProviderContextState({
    protocolRevision: 'native-v1',
    provider: 'native',
    endpoint: 'https://native.example',
    request: { model: 'model', messages: [{ role: 'user', content: 'Original input' }] },
    requestId: 'native-request',
    kind: 'signed',
    requiresExactPrefix: true,
    data: { opaque: 'NOT ANSWER TEXT' }
  });
  const answer = await f.sessions.appendAssistant(f.session, {
    runId: 'past',
    identity,
    content: 'The original answer.',
    reasoning: 'PRIVATE REASONING',
    output: [
      { type: 'text', text: 'The original answer.' },
      { type: 'protocol', state }
    ]
  });
  return { input, answer };
}

test('model commands reject obsolete manual continuation options', () => {
  assert.deepEqual(parseModelSelection({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.throws(() => parseModelSelection({ provider: 'p', model: 'm', continuation: 'fresh' }), /Unknown/u);
});

test('session model changes reject obsolete outer options', async () => {
  const f = await fixture();
  assert.throws(() => f.agent.changeModel({ selection: { provider: 'portable', model: 'model' }, profile: profile(), artifacts: f.artifacts, continuation: 'fresh' }), /Unknown model change option/u);
  await f.agent.close();
});

test('model choice admits fresh replay only on its actual successor and preserves originals', async () => {
  const f = await fixture();
  const original = await nativeAnswer(f);
  const state = await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: profile(),
    artifacts: f.artifacts
  });
  assert.equal(state.sessionId, f.session.id);
  assert.equal((await f.context.inspect()).window, null, 'Selection alone cannot publish an unadmitted reset.');
  const accepted = await f.agent.submit({ task: 'Continue this same work.' });
  const result = await accepted.completion;
  assert.equal(result.state, 'ended', JSON.stringify({ result, transitions: (await f.events.readRange(result.runId ?? result.terminal.runId, { types: ['context.transition.rejected'] })).records }));
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
  const window = (await f.context.inspect()).window;
  assert.equal(window.selection.continuity.model.provider, 'portable');
  assert(
    window.selection.retained.some(
      (source) => source.sha256 === sourceRef(f.session.id, original.input).sha256
    )
  );
  assert.equal(
    (await f.history.read({ source: sourceRef(f.session.id, original.answer) })).status,
    'available'
  );
  await assertHistoryModelCompatibility({
    history: f.history,
    artifacts: f.artifacts,
    profile: profile()
  });
  const messages = f.requests[0].messages;
  assert(messages.some((message) => message.content.includes('café العربية')));
  assert(messages.some((message) => message.content.includes('The original answer.')));
  assert.equal(
    messages.some((message) => message.role === 'protocol'),
    false
  );
  assert.equal(JSON.stringify(messages).includes('PRIVATE REASONING'), false);
  await f.agent.close();
});

test('fresh reset survives a JSONL restart with its exact target and original history', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fresh-continuation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(new JsonlSessionRepository({ rootDir: root }));
  await nativeAnswer(f);
  await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: profile(),
    artifacts: f.artifacts
  });
  await f.agent.close();
  const sessions = new JsonlSessionRepository({ rootDir: root });
  const restarted = await fixture(sessions, await sessions.open(f.session.id, binding));
  assert.equal((await restarted.context.inspect()).window, null);
  const accepted = await restarted.agent.submit({ task: 'Continue after restart.' });
  const result = await accepted.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const window = (await restarted.context.inspect()).window;
  assert.equal(window.selection.continuity.model.provider, 'portable');
  await assertHistoryModelCompatibility({
    history: restarted.history,
    artifacts: restarted.artifacts,
    profile: profile()
  });
  assert(
    (await sessions.loadReplayState(restarted.session)).branch.some(
      (entry) => entry.type === 'assistant' && entry.output.some((item) => item.type === 'protocol')
    )
  );
  await restarted.agent.close();
});

test('fresh continuation rejects an unfinished tool exchange without changing the selected window', async () => {
  const f = await fixture();
  await f.sessions.appendInput(f.session, { runId: 'past', task: 'Run original command.' });
  await f.sessions.appendAssistant(f.session, {
    runId: 'past',
    identity,
    content: '',
    output: [
      {
        type: 'tool_call',
        toolCall: {
          id: 'pending',
          name: 'work',
          type: 'function',
          input: { kind: 'json', value: {} }
        }
      }
    ]
  });
  await assert.rejects(
    f.agent.changeModel({
      selection: { provider: 'portable', model: 'model' },
      profile: profile(),
      artifacts: f.artifacts
    }),
    /unfinished tool exchange/u
  );
  assert.equal((await f.context.inspect()).window, null);
  await f.agent.close();
});

test('fresh continuation rejects accepted image loss separately from native incompatibility', async () => {
  const f = await fixture();
  const artifact = await f.artifacts.store({
    label: 'original-image',
    content: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png'
  });
  await f.sessions.appendInput(f.session, {
    runId: 'past',
    task: 'Inspect this image.',
    images: [{ artifact }]
  });
  await assert.rejects(
    f.agent.changeModel({
      selection: { provider: 'portable', model: 'model' },
      profile: profile(),
      artifacts: f.artifacts
    }),
    /selected images/u
  );
  assert.equal((await f.context.inspect()).window, null);
  await f.agent.close();
});

test('durable queued work blocks a fresh reset without dispatching or discarding it', async () => {
  const f = await fixture();
  await f.sessions.admitSubmission(f.session, {
    submissionId: 'pending',
    runId: 'pending-run',
    input: { task: 'Accepted work retains its configuration.' },
    configuration: { provider: 'portable', model: 'model' }
  });
  await assert.rejects(
    f.agent.changeModel({
      selection: { provider: 'portable', model: 'model' },
      profile: profile(),
      artifacts: f.artifacts
    }),
    /pending work/u
  );
  assert.equal((await f.sessions.loadPendingSubmissions(f.session)).length, 1);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.context.inspect()).window, null);
  await f.agent.close();
});

test('compatible normal changes retain context and persist their selected target', async () => {
  const f = await fixture();
  await f.sessions.appendInput(f.session, { runId: 'past', task: 'Retain this original.' });
  await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: profile(),
    artifacts: f.artifacts
  });
  assert.equal((await f.context.inspect()).window, null);
  const { recordedModelSelection } = await import('@agent-core/runtime');
  assert.deepEqual(recordedModelSelection((await f.sessions.loadReplayState(f.session)).branch), {
    provider: 'portable',
    model: 'model'
  });
  await f.agent.close();
});

test('fresh continuation snapshots never replace an explicitly selected connection', async () => {
  const { recordedModelSelection } = await import('@agent-core/runtime');
  const selected = { provider: 'portable', model: 'model', endpoint: 'https://selected.invalid/base', temperature: 0.25 };
  const executionSnapshot = { type: 'context_transition', window: { selection: { continuity: {
    kind: 'fresh', resetId: 'first-seen-reset', model: { provider: 'other', model: 'historical-model' }, sources: []
  } } } };
  assert.deepEqual(recordedModelSelection([{ type: 'model_settings', ...selected }, executionSnapshot]), selected);
  assert.equal(recordedModelSelection([executionSnapshot]), undefined);
});

test('carried portable sources do not overwrite a later compatible model choice on restart', async () => {
  const f = await fixture();
  await nativeAnswer(f);
  await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: profile(),
    artifacts: f.artifacts
  });
  const accepted = await f.agent.submit({ task: 'Continue with the selected model.' });
  assert.equal((await accepted.completion).terminal?.executionStatus, 'completed');
  const window = (await f.context.inspect()).window;
  await f.agent.changeModel({
    selection: { provider: 'other', model: 'model' },
    profile: profile('other'),
    artifacts: f.artifacts
  });
  const branch = (await f.sessions.loadReplayState(f.session)).branch;
  const { recordedModelSelection } = await import('@agent-core/runtime');
  assert.equal(
    recordedModelSelection([...branch, { type: 'context_transition', window }]).provider,
    'other'
  );
  await f.agent.close();
});

test('an uncertain provider invocation remains suspended across a fresh-continuation attempt', async () => {
  const f = await fixture();
  let invocations = 0;
  f.provider.complete = async () => {
    invocations++;
    throw new Error('Transport disconnected after possible dispatch.');
  };
  const accepted = await f.agent.submit({ task: 'Accepted original input.' });
  const result = await accepted.completion;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  await assert.rejects(
    f.agent.changeModel({
      selection: { provider: 'portable', model: 'model' },
      profile: profile(),
      artifacts: f.artifacts
    }),
    /pending work/u
  );
  assert.equal(invocations, 1);
  assert.equal(f.agent.state().phase, 'suspended');
  assert.equal((await f.context.inspect()).window, null);
  await f.agent.close();
});

test('fresh continuation retains complete tool observations and their exact original images', async () => {
  const f = await fixture();
  await nativeAnswer(f);
  const call = { id: 'observed', name: 'read_image', input: { kind: 'json', value: {} } };
  const callIdentity = {
    ...identity,
    toolBatchId: 'batch',
    callIndex: 0,
    callId: call.id,
    toolAttempt: 1
  };
  await f.sessions.appendToolCall(f.session, { runId: 'past', identity: callIdentity, call });
  const artifact = await f.artifacts.store({
    label: 'original',
    content: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png'
  });
  await f.sessions.appendObservation(f.session, {
    runId: 'past',
    identity: callIdentity,
    toolName: call.name,
    observation: {
      kind: 'result',
      summary: 'Original image.',
      output: { source: 'original.png' },
      modelContent: [
        { type: 'text', text: 'Exact original observation.' },
        { type: 'image', artifact, detail: 'original' }
      ]
    }
  });
  await assert.rejects(
    f.agent.changeModel({
      selection: { provider: 'portable', model: 'model' },
      profile: profile(),
      artifacts: f.artifacts
    }),
    /images/u
  );
  const vision = { ...profile(), modalities: { input: ['text', 'image'], output: ['text'] } };
  f.provider.describeModel = async () => vision;
  await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: vision,
    artifacts: f.artifacts
  });
  const accepted = await f.agent.submit({ task: 'Use the original image.' });
  const result = await accepted.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const observation = f.requests[0].messages.find((message) => message.role === 'tool');
  assert.equal(observation.content, 'Exact original observation.');
  const image = observation.images[0];
  assert.deepEqual(
    [...(image.type === 'base64' ? Buffer.from(image.data, 'base64') : image.data)],
    [1, 2, 3]
  );
  assert.equal(image.detail, 'original');
  await f.agent.close();
});

test('incompatible persisted reset state is rejected in place without migration or rewriting history', async (t) => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'fresh-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(new JsonlSessionRepository({ rootDir: root }));
  await nativeAnswer(f);
  await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: profile(),
    artifacts: f.artifacts
  });
  const accepted = await f.agent.submit({ task: 'Admit the chosen model.' });
  assert.equal((await accepted.completion).terminal?.executionStatus, 'completed');
  await f.agent.close();
  const location = f.sessions.location(f.session.id);
  const lines = (await readFile(location, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const transition = lines.find((line) => line.type === 'context_transition');
  assert(transition);
  delete transition.window.selection.continuity.resetId;
  const incompatible = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  await writeFile(location, incompatible);
  const reopened = new JsonlSessionRepository({ rootDir: root });
  await assert.rejects(
    async () => reopened.loadReplayState(await reopened.open(f.session.id, binding)),
    error => {
      assert(error instanceof SessionHistorySourceError);
      const details = [];
      for (let cause = error.cause; cause instanceof Error; cause = cause.cause) details.push(cause.message);
      assert.match(details.join('\n'), /resetId|context|incompatible/u);
      return true;
    }
  );
  assert.equal(await readFile(location, 'utf8'), incompatible);
});


test('fresh continuation keeps the current session state separate from selected originals', async () => {
  const f = await fixture();
  await nativeAnswer(f);
  const requestRef = await f.artifacts.storeProtected({ label: 'original-inference', mediaType: 'application/json', content: new TextEncoder().encode(JSON.stringify({ sessionStateRevisionId: null, logical: { model: 'model', messages: [] } })) });
  const cut = await f.history.capture();
  const sessionState = {
    id: 'current-understanding', previousRevisionId: null, capturedHistoryCut: cut,
    content: { understanding: [{ id: 'constraint', text: 'Keep the original Unicode constraint; understanding does not authorize edits.' }] },
    inference: { ownerId: 'owner', invocationId: 'original', requestRef }
  };
  const stateEntry = await f.context.transition({
    expectedWindowId: (await f.history.selectedContext(cut))?.windowId ?? null,
    expectedSourceRevision: cut.sourceRevision, expectedSessionStateRevisionId: null,
    sessionState, idempotencyKey: 'current-understanding', reason: 'Seed admitted fixture understanding.',
    selection: await f.context.freshSelection({ selection: await f.context.selectSources(cut, {}), model: { provider: 'portable', model: 'model' }, profile: profile(), cut, resetId: 'seed-state' })
  }, { admit: async () => ({ compiledInputIdentity: 'fixture-input', capabilityRevision: 'fixture' }) });
  await f.agent.changeModel({ selection: { provider: 'portable', model: 'model' }, profile: profile(), artifacts: f.artifacts });
  const accepted = await f.agent.submit({ task: 'Explain the preserved constraint without editing.' });
  const result = await accepted.completion;
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
  const context = await f.context.inspect();
  assert.equal(context.sessionState.revisionId, stateEntry.id);
  assert.equal(context.window.selection.retained.some(source => source.entryId === stateEntry.id), false);
  assert.equal(context.window.selection.continuity.sources.some(source => source.entryId === stateEntry.id), false);
  const rendered = JSON.stringify(f.requests[0].messages);
  assert.equal(rendered.match(/Keep the original Unicode constraint/gu).length, 1);
  assert.ok(rendered.includes('café العربية'));
  assert.equal(f.requests[0].messages.some(item => item.role === 'protocol'), false);
  await f.agent.close();
});

test('rejected automatic fresh admission cannot publish a reset or dispatch an empty staging request', async () => {
  const f = await fixture();
  await nativeAnswer(f);
  const small = { ...profile(), limits: { contextTokens: 8, outputTokens: 1 } };
  f.provider.describeModel = async () => small;
  await f.agent.changeModel({ selection: { provider: 'portable', model: 'model' }, profile: small, artifacts: f.artifacts });
  assert.equal((await f.context.inspect()).window, null);
  const accepted = await f.agent.submit({ task: 'Continue using every original constraint.' });
  const result = await accepted.completion;
  assert.notEqual(result.terminal?.executionStatus, 'completed');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.context.inspect()).window, null);
  await f.agent.close();
});

test('retained exact excerpts survive restart as attributed evidence without native or whole-answer replay', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'excerpt-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(new JsonlSessionRepository({ rootDir: root }));
  const original = await nativeAnswer(f);
  const source = sourceRef(f.session.id, original.answer);
  const excerpt = { source, offset: 4, bytes: 8 };
  const cut = await f.history.capture();
  const selection = await f.context.freshSelection({
    selection: { retained: [sourceRef(f.session.id, original.input)], excerpts: [excerpt] },
    model: { provider: 'portable', model: 'model' }, profile: profile(), cut, resetId: 'fixture-excerpt-reset'
  });
  await f.context.transition({
    expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'fixture-excerpt-selection', reason: 'Seed admitted exact evidence selection.', selection
  }, { admit: async () => ({ compiledInputIdentity: 'fixture-compiled-evidence', capabilityRevision: 'fixture' }) });
  await f.agent.close();

  const sessions = new JsonlSessionRepository({ rootDir: root });
  const restarted = await fixture(sessions, await sessions.open(f.session.id, binding));
  const inspected = await restarted.context.inspect();
  assert.deepEqual(inspected.window.selection.excerpts, [excerpt]);
  const accepted = await restarted.agent.submit({ task: 'Explain the preserved evidence.' });
  const result = await accepted.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const messages = restarted.requests[0].messages;
  const evidence = messages.find(message => message.content?.includes(source.entryId));
  assert(evidence, JSON.stringify(messages));
  assert.equal(evidence.role, 'user');
  assert(evidence.content.includes('original'));
  assert(evidence.content.includes('assistant'));
  assert(!JSON.stringify(messages).includes('The original answer.'));
  assert(!JSON.stringify(messages).includes('PRIVATE REASONING'));
  assert(!JSON.stringify(messages).includes('NOT ANSWER TEXT'));
  assert(!messages.some(message => message.role === 'protocol'));
  const exact = await restarted.history.read({ source });
  assert.equal(exact.item.text, 'The original answer.');
  await restarted.agent.close();
});

async function appendIdlessExchange(f, { durableId, unfinished = false, mismatch } = {}) {
  await nativeAnswer(f);
  const turn = { turnId: 'idless-turn', turnIndex: 2, requestAttempt: 1 };
  const input = { kind: 'json', value: { path: 'original.txt' } };
  await f.sessions.appendAssistant(f.session, { runId: 'past', identity: turn, content: '',
    output: [{ type: 'tool_call', toolCall: { type: 'function', name: 'read', input } }] });
  const call = { ...(durableId ? { id: durableId } : {}), name: 'read',
    input: mismatch === 'input' ? { kind: 'json', value: { path: 'different.txt' } } : input };
  const invocation = { ...turn, toolBatchId: 'idless-batch', callIndex: 0, toolAttempt: 1,
    ...(durableId ? { callId: durableId } : {}) };
  await f.sessions.appendToolCall(f.session, { runId: 'past', identity: invocation, call });
  if (!unfinished) await f.sessions.appendObservation(f.session, { runId: 'past',
    identity: { ...invocation, ...(mismatch === 'result' ? { toolBatchId: 'unrelated-batch' } : {}) },
    toolName: 'read', observation: { kind: 'result', summary: 'Exact original result', output: {},
      modelContent: [{ type: 'text', text: 'Original bytes remain available' }] } });
}

for (const durableId of [undefined, 'recorded-runtime-call']) {
  test(`fresh renewal correlates an ID-less provider call through recorded exchange position (${durableId ?? 'no wire ID'})`, async () => {
    const f = await fixture();
    await appendIdlessExchange(f, { durableId });
    await f.agent.changeModel({ selection: { provider: 'portable', model: 'model' },
      profile: profile(), artifacts: f.artifacts });
    const accepted = await f.agent.submit({ task: 'Continue from the original result.' });
    const result = await accepted.completion;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    const calls = f.requests[0].messages.flatMap(message => message.toolCalls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, durableId);
    assert.deepEqual(calls[0].input, { kind: 'json', value: { path: 'original.txt' } });
    const observation = f.requests[0].messages.find(message => message.role === 'tool');
    assert.equal(observation.toolCallId, durableId);
    assert.equal(observation.content, 'Original bytes remain available');
    const original = (await f.sessions.loadReplayState(f.session)).branch.find(entry =>
      entry.type === 'assistant' && entry.turnId === 'idless-turn');
    assert.equal(original.output[0].toolCall.id, undefined, 'The original provider record is never rewritten');
    await f.agent.close();
  });
}

for (const scenario of ['unfinished', 'input', 'result']) {
  test(`fresh renewal rejects an ID-less ${scenario} exchange without publishing`, async () => {
    const f = await fixture();
    await appendIdlessExchange(f, scenario === 'unfinished' ? { unfinished: true } : { mismatch: scenario });
    await assert.rejects(f.agent.changeModel({ selection: { provider: 'portable', model: 'model' },
      profile: profile(), artifacts: f.artifacts }), /unfinished tool exchange|does not match|exact original call/);
    assert.equal((await f.context.inspect()).window, null);
    assert.equal(f.requests.length, 0);
    await f.agent.close();
  });
}

test('fresh replay orders fallback calls by recorded callIndex despite concurrent start order', async () => {
  const f = await fixture();
  await nativeAnswer(f);
  const turn = { turnId: 'parallel', turnIndex: 2, requestAttempt: 1 };
  await f.sessions.appendAssistant(f.session, { runId: 'past', identity: turn, content: 'Read both originals.' });
  for (const index of [1, 0]) {
    const call = { id: `parallel-${index}`, name: 'read', input: { kind: 'json', value: { index } } };
    const identity = { ...turn, toolBatchId: 'parallel-batch', callIndex: index, callId: call.id, toolAttempt: 1 };
    await f.sessions.appendToolCall(f.session, { runId: 'past', identity, call });
    await f.sessions.appendObservation(f.session, { runId: 'past', identity, toolName: 'read',
      observation: { kind: 'result', summary: `Read ${index}`, output: {},
        modelContent: [{ type: 'text', text: `Result ${index}` }] } });
  }
  await f.agent.changeModel({ selection: { provider: 'portable', model: 'model' }, profile: profile(), artifacts: f.artifacts });
  const accepted = await f.agent.submit({ task: 'Use both results.' });
  const result = await accepted.completion;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const calls = f.requests[0].messages.flatMap(message => message.toolCalls ?? []);
  assert.deepEqual(calls.map(call => call.id), ['parallel-0', 'parallel-1']);
  const results = f.requests[0].messages.filter(message => message.role === 'tool');
  assert.deepEqual(new Map(results.map(item => [item.toolCallId, item.content])),
    new Map([['parallel-0', 'Result 0'], ['parallel-1', 'Result 1']]));
  await f.agent.close();
});

test('fresh renewal rejects ambiguous duplicate positions in an ID-less provider exchange', async () => {
  const f = await fixture();
  await appendIdlessExchange(f);
  await f.sessions.appendToolCall(f.session, { runId: 'past',
    identity: { turnId: 'idless-turn', turnIndex: 2, requestAttempt: 1,
      toolBatchId: 'conflicting-batch', callIndex: 0, toolAttempt: 1 },
    call: { name: 'read', input: { kind: 'json', value: { path: 'original.txt' } } } });
  await assert.rejects(f.agent.changeModel({ selection: { provider: 'portable', model: 'model' },
    profile: profile(), artifacts: f.artifacts }), /conflicting call positions/);
  assert.equal((await f.context.inspect()).window, null);
  assert.equal(f.requests.length, 0);
  await f.agent.close();
});
