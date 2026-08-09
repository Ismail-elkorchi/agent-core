import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import { AgentRuntime, InMemorySessionRepository, agentEventCodec } from '@agent-core/runtime';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  WorkspaceFileSelector,
  findFilesTool,
  listDirectoryTool,
  readArtifactTool,
  readFilesTool,
  searchTextTool,
  viewImageTool
} from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function readHost() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-read-evidence-'));
  const artifacts = new InMemoryArtifactRepository();
  const configuration = DEFAULT_LOCAL_TOOL_CONFIGURATION;
  const services = {
    workspaceRoot: root,
    artifactRepository: artifacts,
    localToolConfiguration: configuration,
    workspaceFileSelector: new WorkspaceFileSelector(root, configuration.fileSelection)
  };
  return { root, artifacts, services, context: { policy: { allowedRisks: ['read'] }, services } };
}

test('every built-in read tool derives evidence from its persisted ToolScope', async () => {
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
    assert.equal(observation.evidence.items.length, 1, tool.name);
    const evidence = observation.evidence.items[0];
    assert.equal(evidence.action, action, tool.name);
    assert.equal(evidence.scope.coverage, observation.scope.coverage, tool.name);
    assert.deepEqual(evidence.scope.filters, observation.scope.filters, tool.name);
    assert.deepEqual(evidence.scope.limits, observation.scope.limits, tool.name);
    assert.deepEqual(evidence.scope.omitted, observation.scope.omitted, tool.name);
    assert.equal(evidence.resources.length, observation.scope.resources.length, tool.name);
  }
});

test('read-tool evidence reaches durable observations, session context, prompt selection, and check input', async () => {
  const { root, artifacts, services } = await readHost();
  await writeFile(path.join(root, 'visible.txt'), 'visible\n');
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ workspaceRoot: root, provider: 'evidence-provider', model: 'evidence-model' });
  const requests = [];
  const provider = {
    id: 'evidence-provider',
    describe() { return { id: this.id, displayName: 'Evidence provider', defaultModel: 'evidence-model' }; },
    async describeModel() {
      return {
        id: 'evidence-model', provider: this.id, modalities: { input: ['text'], output: ['text'] },
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
      return { content: 'evidence retained', model: request.model, provider: this.id, terminationReason: 'stop' };
    }
  };
  let checkedEvidence;
  const check = {
    id: 'evidence-visible', requirement: 'required',
    async run(context) {
      checkedEvidence = await context.execution.evidence.read({ limit: 100, maxBytes: 256 * 1024 });
      return { verdict: checkedEvidence.items.some((item) => item.toolName === 'list_directory') ? 'passed' : 'failed', summary: 'read evidence was supplied to verification' };
    }
  };
  const runtime = new AgentRuntime({
    provider, model: 'evidence-model', repositories: { events, session: { repository: sessions, sessionId: session.id }, artifacts },
    tools: [listDirectoryTool], checks: [check], toolBoundary: { authorizationPolicyId: 'tests/read-evidence@1', executionTargetId: root },
    toolPolicy: { allowedRisks: ['read'] }, toolContext: { services }
  });
  const result = await runtime.run({ task: 'inspect the workspace' });
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.verificationStatus, 'passed');

  const durable = [];
  for await (const envelope of events.read(result.terminal.runId)) durable.push(envelope.event);
  const observation = durable.find((event) => event.type === 'observation.record.created');
  assert.equal(observation.evidence[0].toolName, 'list_directory');
  assert.equal(observation.evidence[0].action, 'list');

  assert.equal(requests.length, 2);
  const secondRequest = JSON.stringify(requests[1].messages);
  assert.match(secondRequest, /list_directory/u);
  assert.match(secondRequest, /evidence_state/u);
  assert.match(secondRequest, /workspace:\/\/\./u);
  assert.equal(checkedEvidence.items.some((item) => item.toolName === 'list_directory' && item.action === 'list'), true);

  const replay = await sessions.loadReplayState(session.id);
  assert.equal(replay.branch.some((entry) => entry.type === 'observation' && entry.toolName === 'list_directory'), true);
});
