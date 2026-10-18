import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { createReadArtifactTool, toolRequirementsSatisfied } from '@agent-core/tools';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';

const encode = (text) => new TextEncoder().encode(text);
const tool = createReadArtifactTool({ maxReadBytes: 4 });
const store = (repository, text, mediaType = 'text/plain') => repository.store({
  label: 'conversation-source', content: encode(text), mediaType
});
const read = (repository, input, policy = { allowedRisks: ['read'] }) => invokeToolCall(
  jsonToolCall('read_artifact', input), [tool], { policy, services: { artifactRepository: repository } }
);

test('artifact reading requires an explicit owned limit and only repository capability', () => {
  for (const maxReadBytes of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => createReadArtifactTool({ maxReadBytes }), /positive safe integer/u);
  assert.deepEqual(tool.requirements.services, ['artifactRepository']);
  assert.equal(toolRequirementsSatisfied(tool, { services: { artifactRepository: new InMemoryArtifactRepository() } }), true);
  assert.equal(toolRequirementsSatisfied(tool, {}), false);
});

test('artifact reads clamp ranges, preserve UTF-8 alignment and report original coverage', async () => {
  const repository = new InMemoryArtifactRepository();
  const artifact = await store(repository, 'abcdefgh');
  for (const byteCount of [undefined, 100]) {
    const result = await read(repository, { artifactId: artifact.artifactId, ...(byteCount ? { byteCount } : {}) });
    assert.equal(result.kind, 'result');
    assert.equal(result.output.text, 'abcd');
    assert.equal(result.output.returnedBytes, 4);
    assert.equal(result.output.nextOffset, 4);
    assert.equal(result.scope.coverage, 'partial');
    assert.deepEqual(result.scope.limits, { offset: 0, byteCount: 4 });
    assert.deepEqual(result.observedFacts.items[0].scope.limits, result.scope.limits);
  }
  const unicode = await store(repository, 'a🙂b');
  const result = await read(repository, { artifactId: unicode.artifactId, offset: 2, byteCount: 1 });
  assert.equal(result.output.text, '🙂');
  assert.deepEqual(result.output.returnedRange, { start: 1, end: 5 });
  assert.match(result.summary, /Read bytes 1-5/u);
  assert.deepEqual(result.observedFacts.items[0].resources[0].range, { kind: 'byte', start: 1, end: 5 });
  assert.equal(result.observedFacts.items[0].resources[0].fullSha256, unicode.sha256);
  assert.match(result.observedFacts.items[0].summary, /4 bytes at 1-5/u);
  assert.equal(result.output.nextOffset, 5);
  assert.equal(result.output.coverage, 'partial');
  const eof = await read(repository, { artifactId: unicode.artifactId, offset: unicode.size });
  assert.equal(eof.output.returnedBytes, 0);
  assert.equal(eof.output.nextOffset, undefined);
  assert.equal((await read(repository, { artifactId: artifact.artifactId, offset: 100 })).kind, 'failure');
});

test('artifact factory captures its limit and verified-read failures do not become content', async () => {
  const repository = new InMemoryArtifactRepository();
  const artifact = await store(repository, 'abcdefgh');
  const options = { maxReadBytes: 2 };
  const bounded = createReadArtifactTool(options);
  options.maxReadBytes = 100;
  const result = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: artifact.artifactId }),
    [bounded], { policy: { allowedRisks: ['read'] }, services: { artifactRepository: repository } });
  assert.equal(result.output.text, 'ab');
  repository.readVerifiedRange = () => Promise.reject(new Error('Artifact verification failed.'));
  const failed = await read(repository, { artifactId: artifact.artifactId });
  assert.equal(failed.kind, 'failure');
  assert.match(failed.summary, /verification failed/u);
  assert.equal(failed.content, undefined);
});

test('denied and protected artifact reads cannot disclose bytes', async () => {
  const repository = new InMemoryArtifactRepository();
  const publicRef = await store(repository, 'public');
  const secret = await repository.storeProtected({ label: 'private', content: encode('secret'), mediaType: 'text/plain' });
  let reads = 0;
  const original = repository.readVerifiedRange.bind(repository);
  repository.readVerifiedRange = (...args) => { reads++; return original(...args); };
  const denied = await read(repository, { artifactId: publicRef.artifactId }, { allowedRisks: [] });
  assert.equal(denied.kind, 'failure');
  const protectedResult = await read(repository, { artifactId: secret.artifactId });
  assert.equal(protectedResult.kind, 'failure');
  assert.match(protectedResult.summary, /unknown artifact/iu);
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(protectedResult).includes('secret'), false);
});

test('complete images remain images and partial images and binary ranges remain artifact references', async () => {
  const repository = new InMemoryArtifactRepository();
  for (const [mediaType, text, expected, coverage] of [
    ['image/png', '1234', 'image', 'complete'],
    ['image/png', '12345', 'artifact', 'partial'],
    ['application/octet-stream', '1234', 'artifact', 'complete']
  ]) {
    const artifact = await store(repository, text, mediaType);
    const result = await read(repository, { artifactId: artifact.artifactId });
    assert.equal(result.content[0].type, expected);
    assert.equal(result.output.coverage, coverage);
    assert.deepEqual(result.content[0].artifact, artifact);
    assert.equal(result.output.text, undefined);
  }
});

test('conversational runtime retrieves artifacts without local files or local configuration', async () => {
  const { AgentRuntime, agentEventCodec } = await import('@agent-core/runtime');
  const artifacts = new InMemoryArtifactRepository();
  const artifact = await store(artifacts, 'conversation-only');
  const requests = [];
  const provider = {
    id: 'artifact-conversation', implementationId: 'tests/artifact-conversation@1',
    describe() { return { id: this.id, displayName: 'Conversation', defaultModel: 'conversation' }; },
    async describeModel() {
      return {
        id: 'conversation', provider: this.id,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
        limits: { contextTokens: 16_000, outputTokens: 1000 }, supportedParameters: ['maxOutputTokens']
      };
    },
    async complete(request) {
      requests.push(request);
      return requests.length === 1 ? {
        content: '', model: request.model, provider: this.id, terminationReason: 'tool_calls',
        toolCalls: [{ id: 'read-1', type: 'function', name: 'read_artifact', input: { kind: 'json', value: { artifactId: artifact.artifactId } } }]
      } : { content: 'retrieved', model: request.model, provider: this.id, terminationReason: 'stop' };
    }
  };
  const runtime = new AgentRuntime({
    provider, model: 'conversation', maxOutputTokens: 64,
    repositories: { events: new InMemoryEventRepository(agentEventCodec), artifacts },
    tools: [createReadArtifactTool({ maxReadBytes: 100 })],
    toolBoundary: { authorizationPolicyId: 'tests/conversation@1', executionTargetId: 'conversation' },
    toolPolicy: { allowedRisks: ['read'] }, toolContext: { services: { artifactRepository: artifacts } }
  });
  const result = await runtime.run({ task: 'Read the conversation source' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /conversation-only/u);
});
