import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, InMemorySessionRepository, agentEventCodec } from '@agent-core/runtime';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  RootedFileSelector,
  findFilesTool,
  listDirectoryTool,
  readArtifactTool,
  readFilesTool,
  searchTextTool,
  viewImageTool
} from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';
import { testRootedFileAuthority } from '../rooted-file-authority-helper.js';

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sessionBinding = Object.freeze({ schemaId: 'agent-core.tests/read-observed-facts', schemaVersion: 1, subject: Object.freeze({ application: 'read-observed-facts' }) });

async function readHost() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-read-observed-facts-'));
  const artifacts = new InMemoryArtifactRepository();
  const configuration = DEFAULT_LOCAL_TOOL_CONFIGURATION;
  const rootedFileAuthority = testRootedFileAuthority(root);
  const services = {
    rootedFileAuthority,
    artifactRepository: artifacts,
    localToolConfiguration: configuration,
    rootedFileSelector: new RootedFileSelector(rootedFileAuthority, configuration.fileSelection)
  };
  return { root, artifacts, services, context: { policy: { allowedRisks: ['read'] }, services } };
}

test('every built-in read tool derives observedFacts from its persisted ToolScope', async () => {
  const { root, artifacts, context } = await readHost();
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.txt'), 'needle one\nneedle two\n');
  await writeFile(path.join(root, 'pixel.png'), onePixelPng);
  const artifact = await artifacts.store({ label: 'fixture', content: new TextEncoder().encode('artifact body'), mediaType: 'text/plain; charset=utf-8' });
  const calls = [
    [listDirectoryTool, { depth: 2 }, 'list'],
    [findFilesTool, { patterns: ['**/*.txt'] }, 'search'],
    [readFilesTool, { files: [{ path: 'src/a.txt', startLine: 1, lineCount: 1 }] }, 'read'],
    [searchTextTool, { query: 'needle', patterns: ['**/*.txt'], mode: 'matches' }, 'search'],
    [viewImageTool, { path: 'pixel.png' }, 'read'],
    [readArtifactTool, { artifactId: artifact.artifactId, offset: 0, byteCount: 8 }, 'read']
  ];

  for (const [tool, input, action] of calls) {
    const observation = await invokeToolCall(jsonToolCall(tool.name, input), [tool], context);
    assert.equal(observation.ok, true, tool.name);
    assert.equal(observation.observedFacts.items.length, 1, tool.name);
    const observedFacts = observation.observedFacts.items[0];
    assert.equal(observedFacts.action, action, tool.name);
    assert.equal(observedFacts.scope.coverage, observation.scope.coverage, tool.name);
    assert.deepEqual(observedFacts.scope.filters, observation.scope.filters, tool.name);
    if (tool.name !== 'read_files') {
      assert.deepEqual(observedFacts.scope.limits, observation.scope.limits, tool.name);
      assert.deepEqual(observedFacts.scope.omitted, observation.scope.omitted, tool.name);
      assert.equal(observedFacts.resources.length, observation.scope.resources.length, tool.name);
    } else {
      assert.equal(observedFacts.resources.length, 1);
      assert.equal(observedFacts.scope.limits.maxFiles, observation.scope.limits.maxFiles);
    }
  }
});

test('read_files emits per-file success and failure observedFacts and failed searches report failure', async () => {
  const { root, context } = await readHost();
  await writeFile(path.join(root, 'good.txt'), 'one\ntwo\n');
  const read = await invokeToolCall(jsonToolCall('read_files', {
    files: [{ path: 'good.txt', startLine: 1, lineCount: 2 }, { path: 'missing.txt' }]
  }), [readFilesTool], context);
  assert.equal(read.observedFacts.items.length, 2);
  const success = read.observedFacts.items.find(item => item.outcome === 'success');
  const failure = read.observedFacts.items.find(item => item.outcome === 'failure');
  assert.equal(success.resources[0].range.kind, 'line');
  assert.equal(success.resources[0].sha256, read.output.files[0].rangeSha256);
  assert.equal(success.resources[0].fullSha256, read.output.files[0].fullFileSha256);
  assert.equal(success.scope.coverage, 'complete');
  assert.equal(failure.resources[0].uri, 'rooted-file:///missing.txt');
  assert.equal(failure.scope.coverage, 'absent');

  const search = await invokeToolCall(jsonToolCall('search_text', { query: '[', mode: 'matches' }), [searchTextTool], context);
  assert.equal(search.output.status, 'invalid_pattern');
  assert.equal(search.observedFacts.items[0].outcome, 'failure');
  assert.equal(search.observedFacts.items[0].scope.coverage, 'partial');
});

test('read-tool observedFacts reaches durable observations, session context, prompt selection, and check input', async () => {
  const { root, artifacts, services } = await readHost();
  await writeFile(path.join(root, 'visible.txt'), 'visible\n');
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ provider: 'observedFacts-provider', model: 'observedFacts-model', binding: sessionBinding });
  const requests = [];
  const provider = {
    id: 'observedFacts-provider',
    implementationId: 'agent-core.tests.observedFacts-provider@1',
    describe() { return { id: this.id, displayName: 'Observed facts provider', defaultModel: 'observedFacts-model' }; },
    async describeModel() {
      return {
        id: 'observedFacts-model', provider: this.id, modalities: { input: ['text'], output: ['text'] },
        capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
        limits: { contextTokens: 16_000, outputTokens: 1_000 }, supportedParameters: ['maxOutputTokens']
      };
    },
    async complete(request) {
      requests.push(request);
      if (requests.length === 1) return {
        content: '', model: request.model, provider: this.id, terminationReason: 'tool_calls',
        toolCalls: [{ id: 'list-1', type: 'function', name: 'list_directory', input: { kind: 'json', value: { depth: 1 } } }]
      };
      return { content: 'observedFacts retained', model: request.model, provider: this.id, terminationReason: 'stop' };
    }
  };
  let checkedFacts;
  const check = {
    id: 'observedFacts-visible', implementationId: 'agent-core.test.check.v1', kind: 'deterministic', requirement: 'required',
    async run(context) {
      checkedFacts = await context.execution.observedFacts.read({ limit: 100, maxBytes: 256 * 1024 });
      return { verdict: checkedFacts.items.some((item) => item.toolName === 'list_directory') ? 'passed' : 'failed', summary: 'read observedFacts was supplied to verification' };
    }
  };
  const runtime = new AgentRuntime({
    provider, model: 'observedFacts-model', repositories: { events, session: { repository: sessions, descriptor: session }, artifacts },
    tools: [listDirectoryTool], checks: [check], toolBoundary: { authorizationPolicyId: 'tests/read-observed-facts@1', executionTargetId: root },
    toolPolicy: { allowedRisks: ['read'] }, toolContext: { services }
  });
  const result = await runtime.run({ task: 'inspect the workspace' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.verificationStatus, 'passed');

  const durable = [];
  for await (const envelope of events.read(result.terminal.runId)) durable.push(envelope.event);
  const observation = durable.find((event) => event.type === 'observation.record.created');
  assert.equal(observation.observedFacts[0].toolName, 'list_directory');
  assert.equal(observation.observedFacts[0].action, 'list');

  assert.equal(requests.length, 2);
  const secondRequest = JSON.stringify(requests[1].messages);
  assert.match(secondRequest, /list_directory/u);
  assert.match(secondRequest, /observed_facts/u);
  assert.match(secondRequest, /rooted-file:\/\/\//u);
  assert.equal(checkedFacts.items.some((item) => item.toolName === 'list_directory' && item.action === 'list'), true);

  const replay = await sessions.loadReplayState(session);
  assert.equal(replay.branch.some((entry) => entry.type === 'observation' && entry.toolName === 'list_directory'), true);
});
