import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {
  AgentRuntime,
  AgentRunRecords,
  AgentRunCoordinator,
  InferenceService,
  resolveToolObservation,
  agentEventCodec,
  applyAgentRunStateTransition
} from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { adoptCommandExecution, commandExecutionResources, defineTool, ResourceLeaseCoordinator } from '@agent-core/tools';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  LocalCommandExecution,
  applyPatchTool,
  execCommandTool,
  readFilesTool,
  stopProcessTool
} from '@agent-core/tools-local';
import { testPatchJournal, testRootedFileAuthority } from '../rooted-file-authority-helper.js';

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
const done = {
  content: 'done',
  model: 'scripted',
  provider: 'scripted',
  terminationReason: 'stop'
};
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
    if (typeof item === 'function') return item(request);
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
  return new AgentRuntime({ maxOutputTokens: 64,
    provider: input.provider,
    ...(input.inferenceService ? { inferenceService: input.inferenceService } : {}),
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

test('a running process blocks conflicting file operations and new commands but permits exact process controls', async (t) => {
  const state = await setup();
  t.after(async () => { await state.manager.close(); await rm(state.root, { recursive: true, force: true }); });
  await writeFile(path.join(state.root, 'source.txt'), 'Original source\n');
  let processId;
  const assertRunning = () => {
    assert.equal(state.manager.activeCount(), 1);
    assert.equal(state.manager.resourceLeases.wouldWait({
      accesses: [{ mode: 'write', scope: 'files/added.txt' }], lockScopes: ['files/added.txt']
    }), true);
  };
  const provider = new Provider([
    toolResponse('exec_command', { command: longCommand }),
    async () => {
      assertRunning();
      processId = (await state.manager.listProcesses())[0].processId;
      return toolResponse('read_files', { files: [{ path: 'source.txt' }] });
    },
    () => {
      assertRunning();
      return toolResponse('apply_patch', {
        patch: '*** Begin Patch\n*** Add File: added.txt\n+Independent edit\n*** End Patch'
      });
    },
    async () => {
      assertRunning();
      await assert.rejects(readFile(path.join(state.root, 'added.txt'), 'utf8'), /ENOENT/);
      return toolResponse('exec_command', { command: 'printf independent' });
    },
    () => {
      assertRunning();
      return toolResponse('stop_process', { processId });
    },
    done
  ]);
  const result = await createRuntime({ ...state, provider,
    services: { ...state.services, patchJournal: testPatchJournal(state.services.rootedFileAuthority) },
    tools: [execCommandTool, readFilesTool, applyPatchTool, stopProcessTool]
  }).run({ task: 'Keep the server running while reading, editing and checking.',
    signal: AbortSignal.timeout(10_000)
  }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(state.manager.activeCount(), 0);
  const journal = await records(state.events, result.terminal.runId);
  const observations = await Promise.all(journal.filter(event => event.type === 'tool.ended')
    .map(event => resolveToolObservation(event.observation, state.artifacts)));
  assert.equal(observations.length, 5);
  for (const observation of observations.slice(1, 4)) {
    assert.equal(observation.kind, 'failure');
    assert.equal(observation.execution.state, 'not_started');
    assert.equal(observation.output.reason, 'resource_blocked');
    assert.deepEqual(observation.output.blockingResourceIds, [processId]);
  }
  assert.equal(observations[4].output.status, 'stopped');
});

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

    summary: 'written',
    scope: { resources: ['files/approval'], coverage: 'complete' },
    output: {}
  })
});

test('a run stops and persists its active process before durable approval suspension', async () => {
  const state = await setup();
  const provider = new Provider([
    toolResponse('exec_command', { command: longCommand }),
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
      toolResponse('exec_command', { command: longCommand }),
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
        finalOperation = await applyAgentRunStateTransition(
          finalOperation,
          event.transition,
          new AgentRunRecords(state.artifacts)
        );
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
    provider: new Provider([toolResponse('exec_command', { command }), done]),
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
      provider: new Provider([
        { ...done, content: 'partial answer', terminationReason: 'output_limit' }
      ]),
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
    const agent = new AgentRuntime({ maxOutputTokens: 64,
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
  const result = await agent.run({
    runId: 'aborted-cleanup',
    task: 'abort',
    signal: controller.signal
  }).result;
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
  const started = await state.manager.start(plan);
  assert.equal(started.kind, 'started');
  const running = started.result;
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
  const resources = commandExecutionResources(state.manager, {
    kind: 'owner',
    ownerId: 'coding-work'
  });
  const options = {
    model: 'scripted',
    toolBoundary: boundary,
    repositories: { events: state.events, artifacts: state.artifacts },
    toolPolicy: { allowedRisks: ['read', 'execute'] },
    toolContext: { services: state.services },
    resources
  };
  const first = await new AgentRuntime({ maxOutputTokens: 64,
    ...options,
    provider: new Provider([
      toolResponse('exec_command', { command: longCommand }),
      done
    ]),
    tools: [execCommandTool]
  }).run({ runId: 'first-attempt', task: 'Start the work process.' }).result;
  assert.equal(first.terminal.executionStatus, 'completed');
  assert.equal(state.manager.activeCount('coding-work'), 1);
  assert.equal(
    (await records(state.events, 'first-attempt')).some(
      (event) => event.type === 'resource.released'
    ),
    false
  );
  const observed = (await records(state.events, 'first-attempt')).find(
    (event) => event.type === 'tool.ended'
  );
  const processId = (await resolveToolObservation(observed.observation, state.artifacts)).output
    .processId;
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
  const second = await new AgentRuntime({ maxOutputTokens: 64,
    ...options,
    provider: new Provider([done]),
    tools: []
  }).run({
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

test('failed resource admission records not_started and permits the run to continue', async (t) => {
  const state = await setup();
  t.after(() => state.manager.close());
  const leases = state.manager.resourceLeases;
  leases.restoreResource('uncertain-process', {
    accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['files'], recovery: { kind: 'unknown' }
  }, 'processes/uncertain-process');
  leases.failResource('uncertain-process', new Error('Authenticated process evidence is unavailable.'));
  const provider = new Provider([toolResponse('exec_command', { command: 'printf must-not-run' }), done]);
  const result = await createRuntime({ ...state, provider, tools: [execCommandTool] })
    .run({ runId: 'refused-run', task: 'run a command' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed');
  const ended = (await records(state.events, 'refused-run')).find((event) => event.type === 'tool.ended');
  const observation = await resolveToolObservation(ended.observation, state.artifacts);
  assert.equal(observation.execution.state, 'not_started');
  assert.equal(observation.kind, 'failure');
  assert.equal(state.manager.activeCount(), 0);
  assert.equal(leases.activeCount(), 1, 'uncertainty remains protected');
});


test('an executor settlement reference is reused rather than duplicated during release', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  let acknowledged;
  const resources = { lifetime: { kind: 'run' }, capabilities: [], resourceLeases: new ResourceLeaseCoordinator(),
    async release() {
      const committed = await events.append('already-settled-run', { type: 'resource.released',
        runId: 'already-settled-run', resourceId: 'process', outcome: 'released', details: { status: 'exited' } });
      return [{ resourceId: 'process', outcome: 'released', details: { status: 'exited' },
        settlementReference: { runId: committed.runId, eventId: committed.eventId, sequence: committed.sequence, hash: committed.hash } }];
    },
    async acknowledge(id) { acknowledged = id; } };
  const agent = new AgentRuntime({ provider: new Provider([done]), model: 'scripted', maxOutputTokens: 64, toolBoundary: boundary,
    repositories: { events, artifacts: new InMemoryArtifactRepository() }, resources });
  const result = await agent.run({ runId: 'already-settled-run', task: 'finish' }).result;
  assert.equal(result.terminal.executionStatus, 'completed');
  assert.equal(acknowledged, 'process');
  assert.equal((await records(events, 'already-settled-run')).filter((event) => event.type === 'resource.released').length, 1);
});

test('an uncertain stop reports its diagnostic immediately and recovers by querying terminal evidence', async () => {
  const state = await setup();
  const terminate = state.manager.terminate.bind(state.manager);
  let stopAttempts = 0;
  state.manager.terminate = async (...args) => {
    const result = await terminate(...args);
    if (++stopAttempts === 1) throw new Error('Stop response interrupted after termination');
    return result;
  };
  const provider = new Provider([
    toolResponse('exec_command', { command: 'printf done' }),
    async () => {
      const [result] = await state.manager.listProcesses();
      return toolResponse('stop_process', { processId: result.processId });
    },
    done
  ]);
  const progress = [];
  const input = { ...state, provider, inferenceService: InferenceService.inMemory({ provider }),
    tools: [execCommandTool, stopProcessTool],
    onProgress(event) { progress.push(event); } };
  const agent = createRuntime(input);
  const paused = await agent.run({ runId: 'stop-recovery-run', task: 'Run and stop the process.' }).result;
  assert.equal(paused.state, 'suspended');
  assert.equal(paused.reason, 'tool_outcome_unknown');
  const failure = progress.find(event => event.type === 'tool.ended' && event.toolName === 'stop_process');
  assert.equal(failure.observation.kind, 'failure');
  assert.equal(failure.observation.execution.state, 'unknown');
  assert.match(failure.observation.summary, /Stop response interrupted/);
  const coordinator = new AgentRunCoordinator(state.events, state.artifacts);
  const inspection = await coordinator.inspect(paused.runId);
  const diagnostics = await coordinator.readToolDiagnostics(inspection.state);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].observation.summary, failure.observation.summary);
  const result = await createRuntime(input).resume(paused.runId).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
  assert.equal(stopAttempts, 1, 'recovery must not repeat the stop effect');
  await state.manager.close();
});

for (const blocker of ['steering', 'timeout']) {
  test(`resource admission ${blocker} settles not_started without abandoning a queued lease`, async (t) => {
    const state = await setup();
    t.after(async () => { await state.manager.close(); await rm(state.root, { recursive: true, force: true }); });
    const leases = state.manager.resourceLeases;
    leases.restoreResource('busy-process', {
      accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['files'], recovery: { kind: 'unknown' }
    }, 'processes/busy-process');
    let handle;
    const provider = new Provider([toolResponse('exec_command', { command: 'printf must-not-run' }), done]);
    const agent = createRuntime({ ...state, provider, tools: [execCommandTool],
      onProgress(event) {
        if (blocker === 'steering' && event.type === 'tool.updated' && event.progress.stage === 'resource_lease_waiting')
          handle.injectSteering({ instruction: 'Stop waiting and reconsider.' });
      }
    });
    handle = agent.run({ runId: `blocked-${blocker}`, task: 'run a command' });
    const result = await handle.result;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'completed');
    const persisted = await records(state.events, `blocked-${blocker}`);
    assert.equal(persisted.filter(event => event.type === 'tool.started').length, 0);
    const ended = persisted.find(event => event.type === 'tool.ended');
    const observation = await resolveToolObservation(ended.observation, state.artifacts);
    assert.equal(observation.execution.state, 'not_started');
    assert.equal(observation.output.reason, 'resource_blocked');
    assert.equal(observation.output.blocker, blocker);
    assert.deepEqual(observation.output.blockingResourceIds, ['busy-process']);
    assert.equal(state.manager.activeCount(), 0);
    leases.releaseResource('busy-process');
    assert.equal(leases.activeCount(), 0, 'a rejected waiter cannot acquire after the blocker releases');
  });
}

test('steering yields observations, stays latched for batch dispatch, and resets at next model boundary', async (t) => {
  const state = await setup();
  t.after(async () => { await state.manager.close(); await rm(state.root, { recursive: true, force: true }); });
  let handle;
  let invoked = 0;
  const observer = defineTool({
    name: 'observe', implementationId: 'tests/observe-yield@1', description: 'observe',
    schema: z.strictObject({}), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'observations' }], lockScopes: [] },
    canonicalizeInput: input => input,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'observations' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    async invoke(_input, context) {
      invoked += 1;
      assert.equal(context.signal.aborted, false);
      if (invoked === 1) {
        assert.equal(context.observationSignal.aborted, false);
        const yielded = new Promise(resolve => context.observationSignal.addEventListener('abort', resolve, { once: true }));
        handle.injectSteering({ instruction: 'Reconsider after observing.' });
        await yielded;
      } else assert.equal(context.observationSignal.aborted, invoked === 2);
      return { kind: 'result', summary: 'observed', scope: { resources: ['observations'], coverage: 'complete' }, output: {} };
    }
  });
  const batch = toolResponse('observe', {});
  batch.toolCalls.push({ ...batch.toolCalls[0], id: 'observe-second' });
  const provider = new Provider([batch, async (request) => {
    assert.equal(invoked, 2, 'the ordinary batch must settle before the next model request');
    assert.match(JSON.stringify(request), /Reconsider after observing/);
    return toolResponse('observe', {});
  }, done]);
  handle = createRuntime({ ...state, provider, tools: [observer] }).run({ runId: 'observation-yield', task: 'observe twice' });
  const result = await handle.result;
  assert.equal(result.terminal.executionStatus, 'completed');
  assert.equal(invoked, 3);
});

test('steering accepted with a final response cannot yield observations in the next run', async (t) => {
  const state = await setup();
  t.after(async () => { await state.manager.close(); await rm(state.root, { recursive: true, force: true }); });
  let firstHandle;
  let observed = false;
  const observer = defineTool({
    name: 'observe_next_run', implementationId: 'tests/observe-next-run@1', description: 'observe',
    schema: z.strictObject({}), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'observations' }], lockScopes: [] },
    canonicalizeInput: input => input,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'observations' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    async invoke(_input, context) {
      assert.equal(context.observationSignal.aborted, false);
      assert.equal(context.signal.aborted, false);
      const outcome = await Promise.race([
        new Promise(resolve => setTimeout(() => resolve('wait_completed'), 25)),
        new Promise(resolve => context.observationSignal.addEventListener('abort', () => resolve('yielded'), { once: true }))
      ]);
      assert.equal(outcome, 'wait_completed');
      observed = true;
      return { kind: 'result', summary: 'observed', scope: { resources: ['observations'], coverage: 'complete' }, output: {} };
    }
  });
  const provider = new Provider([
    () => { firstHandle.injectSteering({ instruction: 'Instruction for the finishing run only.' }); return done; },
    request => {
      assert.doesNotMatch(JSON.stringify(request), /Instruction for the finishing run only/);
      return toolResponse('observe_next_run', {});
    }, done
  ]);
  const agent = createRuntime({ ...state, provider, tools: [observer] });
  firstHandle = agent.run({ runId: 'late-steering-first', task: 'finish now' });
  const first = await firstHandle.result;
  assert.equal(first.terminal.executionStatus, 'completed');
  const second = await agent.run({ runId: 'late-steering-second', task: 'observe normally' }).result;
  assert.equal(second.terminal.executionStatus, 'completed');
  assert.equal(observed, true);
});
