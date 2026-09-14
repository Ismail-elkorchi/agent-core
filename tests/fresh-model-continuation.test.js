import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProviderContextState } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentSession,
  AgentRunCoordinator,
  AgentRuntime,
  ContextService,
  HistoryReader,
  InMemorySessionRepository,
  ModelContinuationRequiredError,
  assertHistoryModelCompatibility,
  parseModelChangeRequest,
  sourceRef,
  agentEventCodec
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

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
  return { sessions, session, history, context, agent, artifacts, requests, provider };
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

test('model command rejects unknown continuation and keeps explicit choice out of defaults', () => {
  assert.deepEqual(parseModelChangeRequest({ provider: 'p', model: 'm', continuation: 'fresh' }), {
    selection: { provider: 'p', model: 'm' },
    options: { continuation: 'fresh' }
  });
  assert.throws(
    () => parseModelChangeRequest({ provider: 'p', model: 'm', continuation: true }),
    /continuation/u
  );
  assert.throws(
    () => parseModelChangeRequest({ provider: 'p', model: 'm', unknown: true }),
    /Unknown/u
  );
});

test('native incompatibility needs explicit choice; fresh replay preserves originals and omits provider state', async () => {
  const f = await fixture();
  const original = await nativeAnswer(f);
  await assert.rejects(
    f.agent.changeModel({
      selection: { provider: 'portable', model: 'model' },
      profile: profile(),
      artifacts: f.artifacts
    }),
    ModelContinuationRequiredError
  );
  assert.equal((await f.context.inspect()).window, null);
  const state = await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: profile(),
    artifacts: f.artifacts,
    continuation: 'fresh'
  });
  assert.equal(state.sessionId, f.session.id);
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
  const accepted = await f.agent.submit({ task: 'Continue this same work.' });
  const result = await accepted.completion;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
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
    artifacts: f.artifacts,
    continuation: 'fresh'
  });
  await f.agent.close();
  const sessions = new JsonlSessionRepository({ rootDir: root });
  const restarted = await fixture(sessions, await sessions.open(f.session.id, binding));
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
      artifacts: f.artifacts,
      continuation: 'fresh'
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
      artifacts: f.artifacts,
      continuation: 'fresh'
    }),
    /selected images/u
  );
  assert.equal((await f.context.inspect()).window, null);
  await f.agent.close();
});

test('durable queued work blocks a fresh reset without dispatching or discarding it', async () => {
  const f = await fixture();
  await f.sessions.enqueueSubmission(f.session, {
    submissionId: 'pending',
    runId: 'pending-run',
    input: { task: 'Accepted work retains its configuration.' },
    configuration: { provider: 'portable', model: 'model' }
  });
  await assert.rejects(
    f.agent.changeModel({
      selection: { provider: 'portable', model: 'model' },
      profile: profile(),
      artifacts: f.artifacts,
      continuation: 'fresh'
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

test('carried portable sources do not overwrite a later compatible model choice on restart', async () => {
  const f = await fixture();
  await nativeAnswer(f);
  await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: profile(),
    artifacts: f.artifacts,
    continuation: 'fresh'
  });
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
      artifacts: f.artifacts,
      continuation: 'fresh'
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
      artifacts: f.artifacts,
      continuation: 'fresh'
    }),
    /images/u
  );
  const vision = { ...profile(), modalities: { input: ['text', 'image'], output: ['text'] } };
  f.provider.describeModel = async () => vision;
  await f.agent.changeModel({
    selection: { provider: 'portable', model: 'model' },
    profile: vision,
    artifacts: f.artifacts,
    continuation: 'fresh'
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
    artifacts: f.artifacts,
    continuation: 'fresh'
  });
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
    /resetId|context|incompatible/u
  );
  assert.equal(await readFile(location, 'utf8'), incompatible);
});
