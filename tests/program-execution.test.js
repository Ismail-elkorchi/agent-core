import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { createProgrammaticTool } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner } from '@agent-core/tools-programmatic/node';
import { defineTool } from '@agent-core/tools';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, AgentRunCoordinator, AgentRunRecords, programResultSchema, InferenceService, InMemoryInferenceRepository, agentEventCodec } from '@agent-core/runtime';

const boundary = { authorizationPolicyId: 'program-tests', executionTargetId: 'program-tests' };
const scope = { resources: ['memory'], coverage: 'complete' };
function leaf(invoke, modes = ['direct', 'programmatic'], extra = {}) {
  return defineTool({ name: 'read_value', implementationId: 'program-test.read.v1', description: 'Read a value',
    schema: z.strictObject({ value: z.number() }), outputSchema: z.strictObject({ value: z.number(), hidden: z.string() }),
    invocationModes: modes, ...extra, effectEnvelope: { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] },
    canonicalizeInput: input => input,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    async invoke(input, context) {
      await invoke?.(input, context);
      return { kind: 'result', execution: { state: 'settled' }, summary: 'Value read', scope,
        output: { value: input.value, hidden: 'private-intermediate-value' } };
    }
  });
}
const programTool = defineTool({ name: 'run_program', implementationId: 'program-test.runner.v1', description: 'Run program',
  schema: z.strictObject({ source: z.string() }), outputSchema: z.json(), invocationModes: ['direct'],
  requirements: { services: ['programExecution'] }, isAvailable: () => true, effectEnvelope: { accesses: [], lockScopes: [] },
  canonicalizeInput: input => input,
  deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
  invoke: (input, context) => context.services.programExecution.execute(input, context)
});
function provider(script, native = false) {
  return {
    id: 'program-tests', implementationId: 'program-tests.provider.v1', calls: [],
    describe() { return { id: this.id, displayName: 'Program test', defaultModel: 'test' }; },
    async describeModel(model) { return { id: model, provider: this.id,
      capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false,
        jsonSchema: false, logprobs: false, temperature: false, topP: false,
        ...(native ? { protocol: conservativeProtocolCapabilities('test', { programmaticTools: true }) } : {}) },
      modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 32000, outputTokens: 2000 },
      supportedParameters: ['maxOutputTokens'] }; },
    async complete(request) {
      this.calls.push(request);
      const next = script.shift();
      const response = typeof next === 'function' ? await next(request) : next;
      return { ...response, model: request.model, provider: this.id };
    }
  };
}
const first = { content: '', terminationReason: 'tool_calls', toolCalls: [{ type: 'function', id: 'program-call',
  name: 'run_program', input: { kind: 'json', value: { source: 'test-program' } } }] };
const final = { content: 'done', terminationReason: 'stop' };
function fixture(run, options = {}) {
  const events = options.events ?? new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const model = provider(options.script ?? [first, final], options.native);
  const runtimeOptions = { provider: model, model: 'test', maxOutputTokens: 500,
    toolBoundary: boundary, tools: [options.programTool ?? programTool, options.leaf ?? leaf()],
    ...(!options.nativeToolExposure?.programmatic ? { programRunner: options.runner ?? { toolName: 'run_program', configurationRevision: 'program-tests.runner.v1', run } } : {}),
    ...(options.nativeToolExposure ? { nativeToolExposure: options.nativeToolExposure } : {}),
    repositories: { events, artifacts },
    inferenceService: new InferenceService({ provider: model, repository: new InMemoryInferenceRepository(), artifacts }),
    limits: { maxConcurrentToolCalls: 1, totalToolCalls: 8, elapsedMs: 5000, ...options.limits },
    ...(options.toolAuthorizer ? { toolAuthorizer: options.toolAuthorizer } : {}) };
  const runtime = new AgentRuntime(runtimeOptions);
  return { runtime, model, events, artifacts, runtimeOptions };
}

async function originalObservation(fixture, runId, predicate) {
  const entry = (await fixture.events.readRange(runId, { types: ['tool.ended'], limit: 100 })).records
    .map(record => record.event).find(predicate);
  assert.ok(entry, 'original tool outcome exists');
  return entry.observation.storage === 'inline' ? entry.observation.observation
    : JSON.parse(new TextDecoder().decode(await fixture.artifacts.readVerified(entry.observation.artifact)));
}

test('program children use canonical execution at concurrency one and keep intermediate results private', { timeout: 8000 }, async () => {
  let caller;
  const f = fixture(async ({ call, tools }) => {
    assert.deepEqual(tools.map(tool => tool.name), ['read_value']);
    assert.equal(tools[0].outputSchema.type, 'object');
    const first = await call('read_value', { value: 7 });
    const second = await call('read_value', { value: first.observation.output.value + 1 });
    return { status: 'completed', value: second.observation.output.value };
  }, { leaf: leaf((_input, context) => { caller = context.invocation.caller; }) });
  const result = await f.runtime.run({ task: 'compose', runId: 'compose' }).result;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
  const results = f.model.calls[1].messages.filter(item => item.role === 'tool');
  assert.equal(results.length, 1);
  assert.equal(results[0].toolName, 'run_program');
  assert.equal(JSON.stringify(f.model.calls[1]).includes('private-intermediate-value'), false);
  const body = JSON.parse(results[0].content);
  assert.equal(body.value, 8);
  assert.equal(body.receipts.length, 2);
  assert.equal(caller.kind, 'programmatic');
  assert.equal(caller.parent.runId, 'compose');
  const original = JSON.parse(new TextDecoder().decode(await f.artifacts.readVerified(body.receipts[0].original)));
  assert.equal(original.output.value, 7);
  const state = (await new AgentRunCoordinator(f.events, f.artifacts).inspect('compose')).state;
  assert.equal(state.budget.totalToolCalls, 3);
});

test('program call allowlist and canonical authorization both constrain children', { timeout: 8000 }, async () => {
  let invocations = 0;
  const f = fixture(async ({ call }) => {
    const result = await call('read_value', { value: 3 });
    assert.equal(result.observation.kind, 'failure');
    assert.equal(result.observation.output.reason, 'policy');
    return { status: 'completed', value: 'denied' };
  }, { leaf: leaf(() => { invocations++; }), toolAuthorizer: async request =>
    request.call.name === 'read_value' ? { decision: 'deny', reason: 'read denied' } : { decision: 'allow' } });
  const result = await f.runtime.run({ task: 'deny child' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(invocations, 0);
  assert.match(f.model.calls[1].messages.find(item => item.role === 'tool').content, /policy|denied/);

  const excluded = fixture(async ({ call, tools }) => {
    assert.equal(tools.length, 0);
    await assert.rejects(call('read_value', { value: 1 }), /admitted manifest/);
    return { status: 'completed' };
  }, { leaf: leaf(() => { invocations++; }, ['direct']) });
  assert.equal((await excluded.runtime.run({ task: 'excluded child' }).result).state, 'ended');
  assert.equal(invocations, 0);
});

test('program child reservations share parent tool budget and do not execute beyond it', { timeout: 8000 }, async () => {
  let invocations = 0;
  const f = fixture(async ({ call }) => {
    await call('read_value', { value: 1 });
    await assert.rejects(call('read_value', { value: 2 }), /limit exhausted/);
    return { status: 'completed' };
  }, { leaf: leaf(() => { invocations++; }), limits: { totalToolCalls: 2 } });
  const result = await f.runtime.run({ task: 'budget', runId: 'budget-program' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(invocations, 1);
  assert.equal((await new AgentRunCoordinator(f.events, f.artifacts).inspect('budget-program')).state.budget.totalToolCalls, 2);
});

test('program child approval suspends with receipts and never reruns the program', { timeout: 8000 }, async () => {
  let programs = 0;
  let leaves = 0;
  const f = fixture(async ({ call }) => {
    programs++;
    await call('read_value', { value: 4 });
    return { status: 'completed' };
  }, { leaf: leaf(() => { leaves++; }), toolAuthorizer: async request =>
    request.call.name === 'read_value' ? { decision: 'require_approval', reason: 'explicit approval' } : { decision: 'allow' } });
  const result = await f.runtime.run({ task: 'approval', runId: 'approve-program' }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'approval_required');
  assert.equal(programs, 1);
  assert.equal(leaves, 0);
  const state = (await new AgentRunCoordinator(f.events, f.artifacts).inspect('approve-program')).state;
  const parent = state.toolBatches.find(batch => !batch.source.program).callStates[0];
  assert.ok(['settled', 'recording', 'recorded', 'resolved'].includes(parent.stage), parent.stage);
  const child = state.toolBatches.find(batch => batch.source.program);
  assert.equal(child.modelCalls.length, 0);
  assert.equal(child.source.program.parent.callId, 'program-call');
});

test('provider program continuation advances inference without fabricating a tool call', { timeout: 8000 }, async () => {
  const f = fixture(async () => ({ status: 'completed' }), { script: [
    { content: '', terminationReason: 'continuation' }, final
  ] });
  const result = await f.runtime.run({ task: 'continue', runId: 'continue-program' }).result;
  assert.equal(result.state, 'ended', JSON.stringify(result));
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(f.model.calls.length, 2);
  assert.equal((await new AgentRunCoordinator(f.events, f.artifacts).inspect('continue-program')).state.budget.totalToolCalls, 0);
});

test('isolated runner composes canonical tool children with bounded parallelism', { timeout: 10000 }, async () => {
  const source = `const values = await Promise.all([call('read_value', {value: 2}), call('read_value', {value: 5})]);
    return values.map(value => value.observation.output.value).reduce((a,b) => a+b, 0);`;
  const f = fixture(undefined, { programTool: createProgrammaticTool(), runner: createQuickJSProgramRunner(),
    script: [{ ...first, toolCalls: [{ ...first.toolCalls[0], input: { kind: 'json', value: { source } } }] }, final] });
  const result = await f.runtime.run({ task: 'isolated composition' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const body = JSON.parse(f.model.calls[1].messages.find(item => item.role === 'tool').content);
  assert.equal(body.status, 'completed', JSON.stringify(body));
  assert.equal(body.value, 7);
  assert.equal(body.receipts.length, 2);
});

test('native program children receive exact structured redacted results and original caller identity', { timeout: 8000 }, async () => {
  let caller;
  const f = fixture(async () => ({ status: 'completed' }), {
    native: true, nativeToolExposure: { programmatic: true },
    leaf: leaf((_input, context) => { caller = context.invocation.caller; }, ['direct', 'programmatic'],
      { buildModelContent: () => [{ type: 'text', text: 'display-only-value' }] }),
    script: [{ content: '', terminationReason: 'tool_calls', toolCalls: [{ type: 'function', id: 'native-child',
      name: 'read_value', input: { kind: 'json', value: { value: 11 } }, caller: { type: 'programmatic', callerId: 'native-program' } }] }, final]
  });
  const result = await f.runtime.run({ task: 'native composition' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const declaration = f.model.calls[0].tools.find(tool => tool.function?.name === 'read_value');
  assert.deepEqual(declaration.allowedCallers, ['direct', 'programmatic']);
  assert.deepEqual(declaration.outputSchema.required, ['receipt', 'observation']);
  const message = f.model.calls[1].messages.find(item => item.role === 'tool');
  assert.deepEqual(message.caller, { type: 'programmatic', callerId: 'native-program' });
  const content = JSON.parse(message.content);
  assert.equal(content.observation.output.value, 11);
  assert.equal(content.receipt.status, 'recorded');
  assert.equal(message.content.includes('display-only-value'), false);
  assert.equal(caller.kind, 'provider_programmatic');
  assert.equal(caller.programId, 'native-program');
});

test('unadvertised native program callers cannot start client effects', { timeout: 8000 }, async () => {
  let leaves = 0;
  const f = fixture(async () => ({ status: 'completed' }), { leaf: leaf(() => { leaves++; }),
    script: [{ content: '', terminationReason: 'tool_calls', toolCalls: [{ type: 'function', id: 'forged-child',
      name: 'read_value', input: { kind: 'json', value: { value: 1 } }, caller: { type: 'programmatic', callerId: 'unadvertised' } }] }]
  });
  const result = await f.runtime.run({ task: 'reject unadvertised caller' }).result;
  assert.equal(leaves, 0);
  assert.equal(result.terminal?.executionStatus, 'failed', JSON.stringify(result));
  assert.match(result.terminal.errorMessage, /not authorized/);
});

test('approval resumes in a replacement runtime and publishes distinct child receipt without replay', { timeout: 10000 }, async () => {
  for (const decision of ['allow', 'deny']) {
    let programs = 0;
    let leaves = 0;
    const f = fixture(async ({ call }) => { programs++; await call('read_value', { value: 19 }); return { status: 'completed' }; },
      { leaf: leaf(() => { leaves++; }), toolAuthorizer: async request => request.call.name === 'read_value'
        ? { decision: 'require_approval', reason: 'approval requested' } : { decision: 'allow' } });
    const paused = await f.runtime.run({ task: 'resume child', runId: `program-resume-${decision}` }).result;
    assert.equal(paused.state, 'suspended');
    const approval = paused.pendingApprovals[0];
    const restarted = new AgentRuntime(f.runtimeOptions);
    const handle = await restarted.resolveApproval({ runId: paused.runId, approvalId: approval.approvalId,
      fingerprint: approval.fingerprint, decision });
    const completed = await handle.result;
    assert.equal(completed.terminal?.executionStatus, 'completed', JSON.stringify(completed));
    assert.equal(programs, 1);
    assert.equal(leaves, decision === 'allow' ? 1 : 0);
    const nextRequest = JSON.stringify(f.model.calls[1]);
    assert.match(nextRequest, /Program child settled after its program stopped/);
    assert.match(nextRequest, /program-receipt:/);
    assert.match(nextRequest, decision === 'allow' ? /Value read/ : /authorization denied/);
    assert.equal(nextRequest.includes('private-intermediate-value'), false);
    const parent = await originalObservation(f, paused.runId, event => event.toolName === 'run_program');
    assert.equal(parent.output.status, 'interrupted');
    const childEvents = (await f.events.readRange(paused.runId, { types: ['tool.ended'], limit: 100 })).records;
    const child = childEvents.find(record => record.event.toolName === 'read_value')?.event;
    assert.ok(child?.programId, JSON.stringify(childEvents));
    assert.equal(child.observation.kind, decision === 'allow' ? 'result' : 'failure');
  }
});

test('program source accessors cannot change approved source at execution', { timeout: 8000 }, async () => {
  let executed = false;
  const unsafeWrapper = defineTool({ name: 'run_program', implementationId: 'program-test.unsafe-wrapper.v1', description: 'test wrapper',
    schema: z.strictObject({ source: z.string() }), outputSchema: z.json(), isAvailable: () => true,
    requirements: { services: ['programExecution'] }, effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: input => input,
    deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: (input, context) => context.services.programExecution.execute({ get source() { return input.source; } }, context)
  });
  const f = fixture(async () => { executed = true; return { status: 'completed' }; }, { programTool: unsafeWrapper });
  const result = await f.runtime.run({ task: 'reject source accessor' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(executed, false);
  assert.match(f.model.calls[1].messages.find(item => item.role === 'tool').content, /accessor|data properties/);
});

test('steering yields an uncooperative child with durable uncertainty and accepts its later receipt once', { timeout: 10000 }, async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let programs = 0;
  let leaves = 0;
  const f = fixture(async ({ call }) => { programs++; await call('read_value', { value: 31 }); return { status: 'completed' }; }, {
    leaf: leaf(async () => { leaves++; entered(); await delayed; })
  });
  const handle = f.runtime.run({ task: 'steer slow child', runId: 'program-steer-child' });
  await started;
  handle.injectSteering({ instruction: 'Do not start more child work.', deliveryId: 'stop-child-work' });
  const paused = await Promise.race([handle.result, new Promise((_, reject) => setTimeout(() => reject(new Error('Steering stayed blocked on child effect')), 1500))]);
  assert.equal(paused.state, 'suspended', JSON.stringify(paused));
  assert.equal(paused.reason, 'tool_outcome_unknown');
  const before = new AgentRuntime(f.runtimeOptions);
  assert.equal((await before.resume(paused.runId).result).reason, 'tool_outcome_unknown');
  assert.equal(programs, 1);
  assert.equal(leaves, 1);
  release();
  const coordinator = new AgentRunCoordinator(f.events, f.artifacts);
  for (;;) {
    const state = (await coordinator.inspect(paused.runId)).state;
    if (state.toolBatches.some(batch => batch.source.program && batch.callStates[0].stage === 'settled')) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const after = new AgentRuntime(f.runtimeOptions);
  const result = await after.resume(paused.runId).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(programs, 1);
  assert.equal(leaves, 1);
  assert.match(JSON.stringify(f.model.calls[1]), /Program child settled after its program stopped/);
  assert.match(JSON.stringify(f.model.calls[1]), /Do not start more child work/);
});

test('direct native dual-mode results match the advertised structured output schema', { timeout: 8000 }, async () => {
  const f = fixture(async () => ({ status: 'completed' }), { native: true, nativeToolExposure: { programmatic: true },
    leaf: leaf(undefined, ['direct', 'programmatic'], { buildModelContent: () => [{ type: 'text', text: 'display-only' }] }),
    script: [{ content: '', terminationReason: 'tool_calls', toolCalls: [{ type: 'function', id: 'native-direct', name: 'read_value',
      input: { kind: 'json', value: { value: 42 } } }] }, final]
  });
  const result = await f.runtime.run({ task: 'direct native contract' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const message = f.model.calls[1].messages.find(item => item.role === 'tool');
  assert.equal(message.caller, undefined);
  assert.equal(JSON.parse(message.content).observation.output.value, 42);
});

test('a crash after a child effect cannot replay its program or child', { timeout: 8000 }, async () => {
  class FailingJournal extends InMemoryEventRepository {
    stopped = false;
    appendConditional(...args) {
      if (this.stopped) throw new Error('simulated program process loss');
      return super.appendConditional(...args);
    }
  }
  const events = new FailingJournal(agentEventCodec);
  let programs = 0;
  let leaves = 0;
  const f = fixture(async ({ call }) => { programs++; await call('read_value', { value: 1 }); return { status: 'completed' }; },
    { events, leaf: leaf(() => { leaves++; events.stopped = true; }) });
  const handle = f.runtime.run({ task: 'crash child', runId: 'program-crash' });
  await assert.rejects(handle.result, /process loss|outcome|stale/);
  events.stopped = false;
  const recovered = new AgentRuntime(f.runtimeOptions);
  const outcome = await recovered.resume(handle.runId).result;
  assert.equal(outcome.state, 'suspended', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'tool_outcome_unknown');
  assert.equal(programs, 1);
  assert.equal(leaves, 1);
  assert.equal(f.model.calls.length, 1);
});

test('program computations have an independent concurrency cap while their leaves can proceed', { timeout: 8000 }, async () => {
  let active = 0;
  let maximum = 0;
  const f = fixture(async ({ call }) => {
    active++; maximum = Math.max(maximum, active);
    try { await call('read_value', { value: 1 }); await new Promise(resolve => setTimeout(resolve, 25)); return { status: 'completed' }; }
    finally { active--; }
  }, { script: [{ ...first, toolCalls: [first.toolCalls[0], { ...first.toolCalls[0], id: 'second-program' }] }, final] });
  const result = await f.runtime.run({ task: 'bounded programs' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(maximum, 1);
  assert.equal(f.model.calls[1].messages.filter(item => item.role === 'tool').length, 2);
});


test('plain program computation failure retains failed disposition', { timeout: 8000 }, async () => {
  const f = fixture(async () => ({ status: 'failed', diagnostic: 'computation failed' }));
  const result = await f.runtime.run({ task: 'compute failure' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const { output } = await originalObservation(f, result.terminal.runId, event => event.toolName === 'run_program');
  assert.equal(output.status, 'failed');
  assert.equal(output.diagnostic, 'computation failed');
});

test('program runner interruption yields a pending child without waiting for its effect', { timeout: 8000 }, async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const f = fixture(async ({ call }) => {
    void call('read_value', { value: 1 }).catch(() => undefined);
    await started;
    return { status: 'interrupted', diagnostic: 'wall limit' };
  }, { leaf: leaf(async () => { entered(); await delayed; }) });
  try {
    const result = await f.runtime.run({ task: 'runner wall limit', runId: 'program-wall-stop' }).result;
    assert.equal(result.state, 'suspended', JSON.stringify(result));
    assert.equal(result.reason, 'tool_outcome_unknown');
    const state = (await new AgentRunCoordinator(f.events, f.artifacts).inspect(result.runId)).state;
    assert.equal(state.toolBatches.find(batch => batch.source.program).callStates[0].stage, 'outcome_unknown');
  } finally { release(); }
});

test('parallel approval quiesces pending children from the same or another program', { timeout: 12000 }, async () => {
  for (const separatePrograms of [false, true]) {
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const delayed = new Promise(resolve => { release = resolve; });
    let programs = 0;
    const run = async ({ call }) => {
      programs++;
      if (separatePrograms) {
        const value = programs;
        if (value === 2) await started;
        await call('read_value', { value });
      } else {
        const first = call('read_value', { value: 1 });
        void first.catch(() => undefined);
        await started;
        await call('read_value', { value: 2 });
        await first;
      }
      return { status: 'completed' };
    };
    const f = fixture(run, { runner: { toolName: 'run_program', configurationRevision: 'program-tests.runner.v1', maxConcurrentPrograms: 2, run },
      limits: { maxConcurrentToolCalls: 2 },
      ...(separatePrograms ? { script: [{ ...first, toolCalls: [first.toolCalls[0], { ...first.toolCalls[0], id: 'second-program' }] }, final] } : {}),
      leaf: leaf(async input => { if (input.value === 1) { entered(); await delayed; } }),
      toolAuthorizer: async request => request.call.name === 'read_value' && request.call.input.value.value === 2
        ? { decision: 'require_approval', reason: 'parallel approval' } : { decision: 'allow' } });
    try {
      const result = await f.runtime.run({ task: 'parallel approval', runId: `parallel-approval-${separatePrograms}` }).result;
      assert.equal(result.state, 'suspended', JSON.stringify(result));
      assert.equal(result.reason, 'approval_required');
      const state = (await new AgentRunCoordinator(f.events, f.artifacts).inspect(result.runId)).state;
      assert.ok(state.toolBatches.some(batch => batch.source.program && batch.callStates[0].stage === 'outcome_unknown'));
      assert.equal(programs, separatePrograms ? 2 : 1);
    } finally { release(); }
  }
});

test('runtime captures native exposure and runner authority fields before caller mutation', { timeout: 8000 }, async () => {
  const runner = { toolName: 'run_program', configurationRevision: 'program-tests.runner.v1', maxConcurrentPrograms: 1, run: async () => ({ status: 'completed', value: 73 }) };
  const f = fixture(runner.run, { runner });
  runner.toolName = 'read_value';
  runner.configurationRevision = 'mutated-runner-revision';
  runner.maxConcurrentPrograms = 0;
  runner.run = async () => ({ status: 'failed' });
  const result = await f.runtime.run({ task: 'captured runner configuration' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(JSON.parse(f.model.calls[1].messages.find(item => item.role === 'tool').content).value, 73);
  const exposure = { programmatic: true };
  const native = fixture(undefined, { native: true, nativeToolExposure: exposure,
    script: [{ content: '', terminationReason: 'tool_calls', toolCalls: [{ type: 'function', id: 'native-direct', name: 'read_value',
      input: { kind: 'json', value: { value: 42 } } }] }, final] });
  exposure.programmatic = false;
  const nativeResult = await native.runtime.run({ task: 'captured native configuration' }).result;
  assert.equal(nativeResult.terminal?.executionStatus, 'completed', JSON.stringify(nativeResult));
  assert.deepEqual(native.model.calls[0].tools.find(tool => tool.function?.name === 'read_value').allowedCallers, ['direct', 'programmatic']);
});


test('program result schema rebases schema references without rewriting literal data and rejects separate resources', () => {
  const schema = programResultSchema({ type: 'object', properties: {
    next: { $ref: '#' }, literal: { const: { $ref: '#/literal-data' }, default: { $ref: '#' } }
  }, $defs: { child: { type: 'array', items: { $ref: '#/$defs/child' } } },
  examples: [{ $ref: '#/data' }] });
  assert.equal(schema.$defs.toolOutput.properties.next.$ref, '#/$defs/toolOutput');
  assert.equal(schema.$defs.toolOutput.$defs.child.items.$ref, '#/$defs/toolOutput/$defs/child');
  assert.deepEqual(schema.$defs.toolOutput.properties.literal.const, { $ref: '#/literal-data' });
  assert.deepEqual(schema.$defs.toolOutput.properties.literal.default, { $ref: '#' });
  assert.throws(() => programResultSchema({ $id: 'https://example.test/child-schema', $ref: '#' }), /separate resources/);
  assert.deepEqual(schema.$defs.toolOutput.examples, [{ $ref: '#/data' }]);
});

test('protected run originals reject old source and approval envelopes', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const records = new AgentRunRecords(artifacts);
  for (const kind of ['tool_source', 'tool_approval']) {
    const old = await artifacts.storeProtected({ label: 'old-run-record', mediaType: 'application/json',
      content: new TextEncoder().encode(JSON.stringify({ runId: 'old-program-run', kind, value: {} })) });
    await assert.rejects(records.read('old-program-run', kind, { runId: 'old-program-run', kind, artifact: old }), /scope or kind/);
    const current = await records.store('new-program-run', kind, { value: 'owned' });
    assert.deepEqual(await records.read('new-program-run', kind, current), { value: 'owned' });
  }
});

test('native program caller provenance survives approval and runtime replacement', { timeout: 8000 }, async () => {
  const caller = { type: 'programmatic', callerId: 'native-program-restart' };
  let invokedCaller;
  const f = fixture(undefined, { native: true, nativeToolExposure: { programmatic: true },
    leaf: leaf((_input, context) => { invokedCaller = context.invocation.caller; }),
    toolAuthorizer: async () => ({ decision: 'require_approval', reason: 'native child approval' }),
    script: [{ content: '', terminationReason: 'tool_calls', toolCalls: [{ type: 'function', id: 'native-restart-child',
      name: 'read_value', input: { kind: 'json', value: { value: 44 } }, caller }] }, final] });
  const paused = await f.runtime.run({ task: 'native child restart', runId: 'native-program-restart' }).result;
  assert.equal(paused.state, 'suspended', JSON.stringify(paused));
  const approval = paused.pendingApprovals[0];
  const resumed = new AgentRuntime(f.runtimeOptions);
  const handle = await resumed.resolveApproval({ runId: paused.runId, approvalId: approval.approvalId,
    fingerprint: approval.fingerprint, decision: 'allow' });
  const result = await handle.result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(invokedCaller.kind, 'provider_programmatic');
  assert.equal(invokedCaller.programId, caller.callerId);
  const assistantCall = f.model.calls[1].messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === 'native-restart-child');
  assert.deepEqual(assistantCall.caller, caller);
  assert.deepEqual(f.model.calls[1].messages.find(message => message.role === 'tool').caller, caller);
});

test('old accepted and terminal runs are rejected before resume or approval can mutate their ledger', { timeout: 8000 }, async () => {
  const source = fixture(async () => { assert.fail('old-format fixture must not execute a program'); }, { script: [final] });
  const completed = await source.runtime.run({ task: 'old format fixture', runId: 'old-runtime-format' }).result;
  assert.equal(completed.state, 'ended');
  const records = [];
  for await (const record of source.events.read('old-runtime-format')) records.push(record);
  for (const terminal of [false, true]) {
    const events = new InMemoryEventRepository(agentEventCodec);
    for (const record of records) {
      const event = record.event.type === 'run.state.transitioned' && record.event.transition.kind === 'accepted'
        ? { ...record.event, transition: { ...record.event.transition, state: { ...record.event.transition.state,
            configuration: { ...record.event.transition.state.configuration, runtimeImplementationId: 'agent-core.runtime.run-v1' } } } }
        : record.event;
      const appended = await events.appendConditional(record.runId, event, {
        idempotencyKey: `old-format-fixture:${record.sequence}`,
        expectedTail: await events.tail(record.runId),
        driverGeneration: record.driverGeneration
      });
      assert.equal(appended.kind, 'committed');
      if (!terminal) break;
    }
    const options = { ...source.runtimeOptions, repositories: { ...source.runtimeOptions.repositories, events } };
    const before = [];
    for await (const record of events.read('old-runtime-format')) before.push(record);
    const tail = await events.tail('old-runtime-format');
    const resumed = new AgentRuntime(options);
    await assert.rejects(resumed.resume('old-runtime-format').result, /incompatible runtime implementation/);
    const approving = new AgentRuntime(options);
    await assert.rejects(approving.resolveApproval({ runId: 'old-runtime-format', approvalId: 'old-approval',
      fingerprint: 'old-fingerprint', decision: 'allow' }), /incompatible runtime implementation/);
    const after = [];
    for await (const record of events.read('old-runtime-format')) after.push(record);
    assert.deepEqual(after, before, 'no event bytes or authority records changed');
    assert.deepEqual(await events.tail('old-runtime-format'), tail);
  }
});

test('runner configuration revisions are required and changed limits cannot resume accepted work', { timeout: 8000 }, async () => {
  assert.throws(() => fixture(async () => ({ status: 'completed' }), {
    runner: { toolName: 'run_program', run: async () => ({ status: 'completed' }) }
  }), /configurationRevision/);
  assert.throws(() => fixture(undefined, {
    runner: { toolName: 'run_program', configurationRevision: 'program-tests.runner.v1' }
  }), /requires a run function/);
  let programs = 0;
  let leaves = 0;
  const f = fixture(async ({ call }) => { programs++; await call('read_value', { value: 18 }); return { status: 'completed' }; }, {
    leaf: leaf(() => { leaves++; }), toolAuthorizer: async request => request.call.name === 'read_value'
      ? { decision: 'require_approval', reason: 'revision-bound approval' } : { decision: 'allow' }
  });
  const paused = await f.runtime.run({ task: 'revision bound program', runId: 'program-runner-revision' }).result;
  assert.equal(paused.state, 'suspended');
  const before = await f.events.tail(paused.runId);
  const options = { ...f.runtimeOptions, programRunner: { ...f.runtimeOptions.programRunner, configurationRevision: 'runner-with-different-limits' } };
  await assert.rejects(new AgentRuntime(options).resume(paused.runId).result, /different runtime configuration/);
  const approval = paused.pendingApprovals[0];
  await assert.rejects(new AgentRuntime(options).resolveApproval({ runId: paused.runId, approvalId: approval.approvalId,
    fingerprint: approval.fingerprint, decision: 'allow' }), /different runtime configuration/);
  assert.deepEqual(await f.events.tail(paused.runId), before);
  assert.equal(programs, 1);
  assert.equal(leaves, 0);
  const resumed = await new AgentRuntime(f.runtimeOptions).resolveApproval({ runId: paused.runId, approvalId: approval.approvalId,
    fingerprint: approval.fingerprint, decision: 'allow' });
  assert.equal((await resumed.result).terminal?.executionStatus, 'completed');
  assert.equal(programs, 1);
  assert.equal(leaves, 1);
});
