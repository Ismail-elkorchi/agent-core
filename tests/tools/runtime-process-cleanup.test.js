import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import { defineTool } from '@agent-core/tools';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, ProcessManager, execCommandTool } from '@agent-core/tools-local';
import { testWorkspaceFileRoot } from '../workspace-file-root-helper.js';

const boundary = { authorizationPolicyId: 'tests/process-cleanup@1', executionTargetId: 'workspace' };
const profile = {
  id: 'scripted', provider: 'scripted',
  capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: true, topP: true },
  modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 16_000, outputTokens: 2_000 }, supportedParameters: ['tools', 'maxOutputTokens']
};
const done = { content: 'done', model: 'scripted', provider: 'scripted', terminationReason: 'stop' };
class Provider {
  id = 'scripted';
  implementationId = 'agent-core.tests.runtime-process-provider@1';
  constructor(script) { this.script = [...script]; }
  describe() { return { id: this.id, displayName: 'Scripted', defaultModel: 'scripted' }; }
  async describeModel() { return profile; }
  async complete(request) { const item = this.script.shift(); if (item instanceof Error) throw item; return { ...item, model: request.model }; }
}
function toolResponse(name, value) { return { content: '', model: 'scripted', provider: 'scripted', terminationReason: 'tool_calls', toolCalls: [{ id: `${name}-call`, type: 'function', name, input: { kind: 'json', value } }] }; }
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-runtime-process-'));
  const artifacts = new InMemoryArtifactRepository();
  const manager = new ProcessManager({ artifactRepository: artifacts, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  const events = new InMemoryEventRepository(agentEventCodec);
  const services = { workspaceFileRoot: testWorkspaceFileRoot(root), artifactRepository: artifacts, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION, processManager: manager };
  return { root, artifacts, manager, events, services };
}
function createRuntime(input) {
  return new AgentRuntime({
    provider: input.provider, model: 'scripted', toolBoundary: boundary, repositories: { events: input.events, artifacts: input.artifacts },
    tools: input.tools ?? [], toolPolicy: { allowedRisks: ['read', 'write', 'execute'] }, toolContext: { services: input.services },
    ...(input.authorizer ? { toolAuthorizer: input.authorizer } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {})
  });
}
async function records(events, runId) { const values = []; for await (const item of events.read(runId)) values.push(item.event); return values; }
const longCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('started'); setInterval(()=>{},1000)")}`;

const approvalTool = defineTool({
  name: 'approval_write', implementationId: 'tests/approval-write@1', description: 'write', schema: z.strictObject({}), outputSchema: z.strictObject({}),
  effectEnvelope: { accesses: [{ mode: 'write', scope: 'workspace/files/approval' }], lockScopes: ['workspace/files/approval'] }, canonicalizeInput: (input) => input,
  deriveEffects: () => ({ accesses: [{ mode: 'write', scope: 'workspace/files/approval' }], lockScopes: ['workspace/files/approval'], recovery: { kind: 'unknown' } }),
  invoke: async () => ({ kind: 'result', ok: true, summary: 'written', scope: { resources: ['workspace/files/approval'], coverage: 'complete' }, output: {} })
});

test('a run stops and persists its active process before durable approval suspension', async () => {
  const state = await setup();
  const provider = new Provider([toolResponse('exec_command', { command: longCommand, yieldMs: 100 }), toolResponse('approval_write', {})]);
  const agent = createRuntime({ ...state, provider, tools: [execCommandTool, approvalTool], authorizer: (request) => request.call.name === 'approval_write' ? { decision: 'require_approval', reason: 'confirm' } : { decision: 'allow' } });
  const result = await agent.run({ runId: 'suspension-run', task: 'suspend' }).result;
  assert.equal(result.state, 'suspended');
  assert.equal(state.manager.activeCount('suspension-run'), 0);
  const ended = (await records(state.events, 'suspension-run')).filter((event) => event.type === 'process.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, 'stopped');
});

test('abort and runtime failure both clean active run processes before run.ended', async () => {
  for (const mode of ['abort', 'failure']) {
    const state = await setup();
    const provider = new Provider([toolResponse('exec_command', { command: longCommand, yieldMs: 100 }), ...(mode === 'failure' ? [new Error('provider failed')] : [done])]);
    let control;
    const agent = createRuntime({ ...state, provider, tools: [execCommandTool], onProgress(event) { if (mode === 'abort' && event.type === 'tool.ended') control.abort('stop'); } });
    const runId = `${mode}-run`;
    control = agent.run({ runId, task: mode });
    const result = await control.result;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, mode === 'abort' ? 'aborted' : 'failed');
    assert.equal(state.manager.activeCount(runId), 0);
    const persisted = await records(state.events, runId);
    assert.equal(persisted.some((event) => event.type === 'process.ended'), true);
    assert.equal(persisted.at(-2).type, 'run.ended');
    assert.equal(persisted.at(-1).type, 'operation.transition');
    assert.equal(persisted.at(-1).state.phase.kind, 'terminal');
  }
});

test('cleanup failure becomes terminal runtime_error and still commits run.ended', async () => {
  const state = await setup();
  const failingManager = { resourceLeases: state.manager.resourceLeases, capabilities: () => ['process'], async disposeRun() { throw new Error('cleanup broke'); } };
  const agent = createRuntime({ ...state, provider: new Provider([done]), services: { ...state.services, processManager: failingManager } });
  const result = await agent.run({ runId: 'cleanup-failure-run', task: 'finish' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'failed');
  assert.match(result.terminal.errorMessage, /cleanup broke/u);
  assert.equal(result.terminal.candidate.status, 'complete');
  assert.equal(result.terminal.candidate.message, 'done');
  assert.equal(result.terminal.turnCount, 1);
  assert.equal(result.terminal.modelTerminationReason, 'stop');
  assert.deepEqual(result.terminal.cleanupDiagnostic, { kind: 'process_cleanup', message: 'cleanup broke' });
  const persisted = await records(state.events, 'cleanup-failure-run');
  assert.equal(persisted.at(-2).type, 'run.ended');
  assert.equal(persisted.at(-1).state.phase.kind, 'terminal');
});

test('natural process exit is persisted exactly once even when the model never polls it', async () => {
  const state = await setup();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`;
  const agent = createRuntime({ ...state, provider: new Provider([toolResponse('exec_command', { command, yieldMs: 1_000 }), done]), tools: [execCommandTool] });
  const result = await agent.run({ runId: 'natural-exit-run', task: 'let process exit' }).result;
  assert.equal(result.state, 'ended');
  const persisted = await records(state.events, 'natural-exit-run');
  const ended = persisted.filter(event => event.type === 'process.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, 'exited');
  assert.equal(ended[0].result.artifact.visibility, 'public');
  assert.equal(ended[0].result.protectedArtifact.visibility, 'protected');
  assert.deepEqual(await state.manager.disposeRun('natural-exit-run'), []);
});

test('cleanup failure transforms prior partial, checked, and aborted decisions without erasing their truth', async () => {
  const cases = [
    {
      runId: 'partial-cleanup', provider: new Provider([{ ...done, content: 'partial answer', terminationReason: 'output_limit' }]),
      assertTerminal(terminal) { assert.equal(terminal.candidate.status, 'partial'); assert.equal(terminal.modelTerminationReason, 'output_limit'); }
    },
    {
      runId: 'checked-cleanup', provider: new Provider([done]),
      checks: [
        { id: 'required-pass', requirement: 'required', async run() { return { verdict: 'passed', summary: 'passed' }; } },
        { id: 'advisory-fail', requirement: 'advisory', async run() { return { verdict: 'failed', summary: 'failed advisory' }; } }
      ],
      assertTerminal(terminal) { assert.deepEqual(terminal.checkResults.map(item => [item.id, item.verdict]), [['required-pass', 'passed'], ['advisory-fail', 'failed']]); }
    }
  ];
  for (const item of cases) {
    const state = await setup();
    const failingManager = { resourceLeases: state.manager.resourceLeases, capabilities: () => ['process'], async disposeRun() { throw new Error('cleanup failed'); } };
    const agent = new AgentRuntime({
      provider: item.provider, model: 'scripted', toolBoundary: boundary, repositories: { events: state.events, artifacts: state.artifacts },
      toolContext: { services: { ...state.services, processManager: failingManager } }, ...(item.checks ? { checks: item.checks } : {})
    });
    const result = await agent.run({ runId: item.runId, task: 'preserve prior decision' }).result;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'failed');
    assert.equal(result.terminal.terminationReason, 'runtime_error');
    assert.equal(result.terminal.turnCount, 1);
    assert.match(result.terminal.errorMessage, /cleanup failed/u);
    item.assertTerminal(result.terminal);
  }

  const state = await setup();
  const failingManager = { resourceLeases: state.manager.resourceLeases, capabilities: () => ['process'], async disposeRun() { throw new Error('cleanup failed'); } };
  const agent = createRuntime({ ...state, provider: new Provider([done]), services: { ...state.services, processManager: failingManager } });
  const controller = new AbortController(); controller.abort('already aborted');
  const result = await agent.run({ runId: 'aborted-cleanup', task: 'abort', signal: controller.signal }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'failed');
  assert.equal(result.terminal.candidate.status, 'absent');
  assert.match(result.terminal.errorMessage, /already aborted.*cleanup failed/iu);
});

test('two runtimes sharing one manager clean only their own processes', async () => {
  const state = await setup();
  const ownerB = { runId: 'run-b', turnId: 'turn-b', toolBatchId: 'batch-b', callIndex: 0 };
  const running = await state.manager.start({ command: longCommand, cwd: state.root, pty: false, timeoutMs: 60_000, yieldMs: 100, outputTokenBudget: 1_000, owner: ownerB });
  assert.equal(running.status, 'running');
  const agentA = createRuntime({ ...state, provider: new Provider([done]) });
  const result = await agentA.run({ runId: 'run-a', task: 'finish a' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(state.manager.activeCount('run-b'), 1);
  await state.manager.disposeRun('run-b');
});
