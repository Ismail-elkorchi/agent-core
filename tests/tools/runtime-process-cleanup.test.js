import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { AgentRuntime, agentEventCodec, applyAgentRunStateTransition } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { adoptCommandExecution, commandExecutionResources, defineTool } from '@agent-core/tools';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  LocalCommandExecution,
  execCommandTool
} from '@agent-core/tools-local';
import { testRootedFileAuthority } from '../rooted-file-authority-helper.js';

const boundary = {
  authorizationPolicyId: 'tests/process-cleanup@1',
  executionTargetId: 'rooted-authority'
};
const profile = {
  id: 'scripted',
  provider: 'scripted',
  capabilities: {
    streaming: false,
    toolCalling: true,
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: false,
    jsonSchema: false,
    logprobs: false,
    temperature: true,
    topP: true
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 16_000, outputTokens: 2_000 },
  supportedParameters: ['tools', 'maxOutputTokens']
};
const done = { content: 'done', model: 'scripted', provider: 'scripted', terminationReason: 'stop' };
class Provider {
  id = 'scripted';
  implementationId = 'agent-core.tests.runtime-process-provider@1';
  constructor(script) {
    this.script = [...script];
  }
  describe() {
    return { id: this.id, displayName: 'Scripted', defaultModel: 'scripted' };
  }
  async describeModel() {
    return profile;
  }
  async complete(request) {
    const item = this.script.shift();
    if (item instanceof Error) throw item;
    return { ...item, model: request.model };
  }
}
function toolResponse(name, value) {
  return {
    content: '',
    model: 'scripted',
    provider: 'scripted',
    terminationReason: 'tool_calls',
    toolCalls: [{ id: `${name}-call`, type: 'function', name, input: { kind: 'json', value } }]
  };
}
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-runtime-process-'));
  const artifacts = new InMemoryArtifactRepository();
  const manager = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority: testRootedFileAuthority(root),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  });
  const events = new InMemoryEventRepository(agentEventCodec);
  const services = {
    rootedFileAuthority: testRootedFileAuthority(root),
    artifactRepository: artifacts,
    localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION,
    commandExecution: manager
  };
  return { root, artifacts, manager, events, services };
}
function createRuntime(input) {
  return new AgentRuntime({
    provider: input.provider,
    model: 'scripted',
    toolBoundary: boundary,
    repositories: { events: input.events, artifacts: input.artifacts },
    tools: input.tools ?? [],
    toolPolicy: { allowedRisks: ['read', 'write', 'execute'] },
    toolContext: { services: input.services },
    resources: commandExecutionResources(input.services.commandExecution),
    ...(input.authorizer ? { toolAuthorizer: input.authorizer } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {})
  });
}
async function records(events, runId) {
  const values = [];
  for await (const item of events.read(runId)) values.push(item.event);
  return values;
}
const longCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('started'); setInterval(()=>{},1000)")}`;

const approvalTool = defineTool({
  name: 'approval_write',
  implementationId: 'tests/approval-write@1',
  description: 'write',
  schema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  effectEnvelope: {
    accesses: [{ mode: 'write', scope: 'files/approval' }],
    lockScopes: ['files/approval']
  },
  canonicalizeInput: (input) => input,
  deriveEffects: () => ({
    accesses: [{ mode: 'write', scope: 'files/approval' }],
    lockScopes: ['files/approval'],
    recovery: { kind: 'unknown' }
  }),
  invoke: async () => ({
    kind: 'result',
    ok: true,
    summary: 'written',
    scope: { resources: ['files/approval'], coverage: 'complete' },
    output: {}
  })
});

test('a run stops and persists its active process before durable approval suspension', async () => {
  const state = await setup();
  const provider = new Provider([
    toolResponse('exec_command', { command: longCommand, yieldMs: 100 }),
    toolResponse('approval_write', {})
  ]);
  const agent = createRuntime({
    ...state,
    provider,
    tools: [execCommandTool, approvalTool],
    authorizer: (request) =>
      request.call.name === 'approval_write'
        ? { decision: 'require_approval', reason: 'confirm' }
        : { decision: 'allow' }
  });
  const result = await agent.run({ runId: 'suspension-run', task: 'suspend' }).result;
  assert.equal(result.state, 'suspended');
  assert.equal(state.manager.activeCount('suspension-run'), 0);
  const ended = (await records(state.events, 'suspension-run')).filter(
    (event) => event.type === 'resource.released'
  );
  assert.equal(ended.length, 1);
  assert.equal(ended[0].details.status, 'stopped');
});

test('abort and unknown provider outcome both clean active run processes before terminal or suspension publication', async () => {
  for (const mode of ['abort', 'failure']) {
    const state = await setup();
    const provider = new Provider([
      toolResponse('exec_command', { command: longCommand, yieldMs: 100 }),
      ...(mode === 'failure' ? [new Error('provider failed')] : [done])
    ]);
    let control;
    const agent = createRuntime({
      ...state,
      provider,
      tools: [execCommandTool],
      onProgress(event) {
        if (mode === 'abort' && event.type === 'tool.ended') control.abort('stop');
      }
    });
    const runId = `${mode}-run`;
    control = agent.run({ runId, task: mode });
    const result = await control.result;
    assert.equal(result.state, mode === 'abort' ? 'ended' : 'suspended');
    if (result.state === 'ended') assert.equal(result.terminal.executionStatus, 'aborted');
    else assert.equal(result.reason, 'provider_outcome_unknown');
    assert.equal(state.manager.activeCount(runId), 0);
    const persisted = await records(state.events, runId);
    assert.equal(
      persisted.some((event) => event.type === 'resource.released'),
      true
    );
    let finalOperation;
    for (const event of persisted)
      if (event.type === 'run.state.transitioned')
        finalOperation = applyAgentRunStateTransition(finalOperation, event.transition);
    assert.equal(finalOperation.phase.kind, mode === 'abort' ? 'terminal' : 'active');
    if (mode === 'failure')
      assert.equal(finalOperation.providerRequests.at(-1).stage, 'outcome_unknown');
    assert.equal(
      persisted.some((event) => event.type === 'run.ended'),
      mode === 'abort'
    );
  }
});

test('cleanup failure becomes terminal runtime_error and still commits run.ended', async () => {
  const state = await setup();
  const failingManager = commandExecutionWithCleanupFailure(state.manager, 'cleanup broke');
  const agent = createRuntime({
    ...state,
    provider: new Provider([done]),
    services: { ...state.services, commandExecution: failingManager }
  });
  const result = await agent.run({ runId: 'cleanup-failure-run', task: 'finish' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'failed');
  assert.match(result.terminal.errorMessage, /cleanup broke/u);
  assert.equal(result.terminal.modelOutput.status, 'complete');
  assert.equal(result.terminal.modelOutput.message, 'done');
  assert.equal(result.terminal.turnCount, 1);
  assert.equal(result.terminal.modelTerminationReason, 'stop');
  assert.deepEqual(result.terminal.cleanupDiagnostic, {
    kind: 'resource_cleanup',
    message: 'cleanup broke'
  });
  const persisted = await records(state.events, 'cleanup-failure-run');
  assert.equal(persisted.at(-2).type, 'run.ended');
  assert.equal(persisted.at(-1).type, 'run.state.transitioned');
  assert.equal((await agent.inspectRun('cleanup-failure-run')).state.phase.kind, 'terminal');
});

test('natural process exit is persisted exactly once even when the model never polls it', async () => {
  const state = await setup();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`;
  const agent = createRuntime({
    ...state,
    provider: new Provider([toolResponse('exec_command', { command, yieldMs: 1_000 }), done]),
    tools: [execCommandTool]
  });
  const result = await agent.run({ runId: 'natural-exit-run', task: 'let process exit' }).result;
  assert.equal(result.state, 'ended');
  const persisted = await records(state.events, 'natural-exit-run');
  const ended = persisted.filter((event) => event.type === 'resource.released');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].details.status, 'exited');
  assert.equal(ended[0].details.artifact.visibility, 'public');
  assert.equal(ended[0].details.protectedArtifact.visibility, 'protected');
  assert.deepEqual(await state.manager.disposeOwner('natural-exit-run'), []);
});

test('cleanup failure transforms prior partial, completed, and aborted decisions without erasing their truth', async () => {
  const cases = [
    {
      runId: 'partial-cleanup',
      provider: new Provider([{ ...done, content: 'partial answer', terminationReason: 'output_limit' }]),
      assertTerminal(terminal) {
        assert.equal(terminal.modelOutput.status, 'partial');
        assert.equal(terminal.modelTerminationReason, 'output_limit');
      }
    },
    {
      runId: 'completed-cleanup',
      provider: new Provider([done]),
      assertTerminal(terminal) {
        assert.equal(terminal.modelOutput.status, 'complete');
      }
    }
  ];
  for (const item of cases) {
    const state = await setup();
    const failingManager = commandExecutionWithCleanupFailure(state.manager, 'cleanup failed');
    const agent = new AgentRuntime({
      provider: item.provider,
      model: 'scripted',
      toolBoundary: boundary,
      repositories: { events: state.events, artifacts: state.artifacts },
      toolContext: { services: { ...state.services, commandExecution: failingManager } },
      resources: commandExecutionResources(failingManager)
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
  const failingManager = commandExecutionWithCleanupFailure(state.manager, 'cleanup failed');
  const agent = createRuntime({
    ...state,
    provider: new Provider([done]),
    services: { ...state.services, commandExecution: failingManager }
  });
  const controller = new AbortController();
  controller.abort('already aborted');
  const result = await agent.run({ runId: 'aborted-cleanup', task: 'abort', signal: controller.signal })
    .result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'failed');
  assert.equal(result.terminal.modelOutput.status, 'absent');
  assert.match(result.terminal.errorMessage, /already aborted.*cleanup failed/iu);
});

function commandExecutionWithCleanupFailure(commandExecution, message) {
  return adoptCommandExecution(
    new Proxy(commandExecution, {
      get(target, property) {
        if (property === 'disposeOwner')
          return async () => {
            throw new Error(message);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    })
  );
}

test('two runtimes sharing one manager clean only their own processes', async () => {
  const state = await setup();
  const ownerB = {
    ownerId: 'run-b',
    runId: 'run-b',
    turnId: 'turn-b',
    toolBatchId: 'batch-b',
    callIndex: 0
  };
  const plan = await state.manager.plan({
    command: longCommand,
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 60_000,
    yieldMs: 100,
    outputTokenBudget: 1_000,
    owner: ownerB
  });
  const running = await state.manager.start(plan);
  assert.equal(running.status, 'running');
  const agentA = createRuntime({ ...state, provider: new Provider([done]) });
  const result = await agentA.run({ runId: 'run-a', task: 'finish a' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(state.manager.activeCount('run-b'), 1);
  await state.manager.disposeOwner('run-b');
});

test('an explicitly admitted work owner keeps a process across runs with its original causal identity', async (t) => {
  const state = await setup();
  t.after(() => state.manager.close());
  const resources = commandExecutionResources(state.manager, { kind: 'owner', ownerId: 'coding-work' });
  const options = {
    model: 'scripted',
    toolBoundary: boundary,
    repositories: { events: state.events, artifacts: state.artifacts },
    toolPolicy: { allowedRisks: ['read', 'execute'] },
    toolContext: { services: state.services },
    resources
  };
  const first = await new AgentRuntime({
    ...options,
    provider: new Provider([toolResponse('exec_command', { command: longCommand, yieldMs: 100 }), done]),
    tools: [execCommandTool]
  }).run({ runId: 'first-attempt', task: 'Start the work process.' }).result;
  assert.equal(first.terminal.executionStatus, 'completed');
  assert.equal(state.manager.activeCount('coding-work'), 1);
  assert.equal(
    (await records(state.events, 'first-attempt')).some((event) => event.type === 'resource.released'),
    false
  );
  const observed = (await records(state.events, 'first-attempt')).find(
    (event) => event.type === 'tool.ended'
  );
  const processId = observed.observation.output.processId;
  const laterOwner = {
    ownerId: 'coding-work',
    runId: 'later-attempt',
    turnId: 'later-turn',
    toolBatchId: 'later-batch',
    callIndex: 0
  };
  const poll = await state.manager.query(processId, 100, 20, 0, laterOwner);
  assert.equal(poll.owner.runId, 'first-attempt');
  assert.equal(poll.owner.ownerId, 'coding-work');
  await assert.rejects(
    state.manager.query(processId, 100, 20, 0, { ...laterOwner, ownerId: 'different-work' }),
    /another resource owner/
  );
  const second = await new AgentRuntime({ ...options, provider: new Provider([done]), tools: [] }).run({
    runId: 'later-attempt',
    task: 'Continue the same work.'
  }).result;
  assert.equal(second.terminal.executionStatus, 'completed');
  assert.equal(state.manager.activeCount('coding-work'), 1);
  const released = await resources.release('coding-work');
  assert.equal(released.length, 1);
  assert.equal(released[0].outcome, 'released');
  assert.equal(state.manager.activeCount('coding-work'), 0);
});
