import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashJson, InMemoryEventRepository, PersistenceCorruptionError } from '@agent-core/evidence';
import { issueEffectStartTicket, settleExternalEffect, startExternalEffect } from '@agent-core/effects';
import { AgentOperationCoordinator, AgentSession, InMemorySessionRepository, agentEventCodec, decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { createToolCall } from '@agent-core/tools';

test('session repository initializes a missing nested root before acquiring its stream lock', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-session-missing-root-'));
  const rootDir = path.join(parent, 'missing', 'nested');
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'created' });
  assert.equal((await repository.open(session.id)).id, 'created');
});

test('concurrent session appends preserve one parent chain and leaf', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-concurrent-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'concurrent' });
  await Promise.all(Array.from({ length: 30 }, (_, index) => repository.appendInput(session.id, { runId: `run-${index}`, task: `task ${index}` })));
  const replay = await repository.loadReplayState(session.id);
  assert.equal(replay.branch.length, 30);
  assert.equal(replay.branch[0].parentId, null);
  for (let index = 1; index < replay.branch.length; index += 1) assert.equal(replay.branch[index].parentId, replay.branch[index - 1].id);
  assert.equal((await repository.open(session.id)).leafId, replay.branch.at(-1).id);
});

test('session repositories scan once and incrementally preserve a cross-instance branch', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-index-'));
  const first = new JsonlSessionRepository({ rootDir });
  const second = new JsonlSessionRepository({ rootDir });
  const session = await first.create({ id: 'indexed' });
  await second.open(session.id);
  // Force each warm index to ingest one record from the other writer before the
  // concurrent burst. Lock scheduling may otherwise let one repository finish
  // its whole local queue first, which is correct but exercises only one
  // incremental refresh path.
  await first.appendInput(session.id, { runId: 'run-0', task: 'task-0' });
  await second.appendInput(session.id, { runId: 'run-1', task: 'task-1' });
  await first.appendInput(session.id, { runId: 'run-2', task: 'task-2' });
  await Promise.all(Array.from({ length: 21 }, (_, offset) => {
    const index = offset + 3;
    return (index % 2 === 0 ? first : second).appendInput(session.id, { runId: `run-${index}`, task: `task-${index}` });
  }));
  const replay = await first.loadReplayState(session.id);
  assert.equal(replay.branch.length, 24);
  for (let index = 1; index < replay.branch.length; index += 1) assert.equal(replay.branch[index].parentId, replay.branch[index - 1].id);
  assert.ok(first.indexMetrics().incrementalRefreshes > 0);
  assert.equal(second.indexMetrics().fullScans, 1);
  assert.ok(second.indexMetrics().incrementalRefreshes > 0);
});

test('session observations normalize hostile output and metadata before durable replay', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-hostile-json-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'hostile-json' });
  await repository.appendInput(session.id, { runId: 'run-hostile', task: 'persist hostile observation' });
  let getterCalls = 0;
  const output = Object.create(null);
  Object.defineProperty(output, 'getter', { enumerable: true, get() { getterCalls += 1; throw new Error('must not run'); } });
  Object.defineProperty(output, '__proto__', { enumerable: true, value: { retained: true } });
  output.cycle = output;
  const metadata = new Proxy({}, { ownKeys() { throw new Error('ownKeys denied'); } });
  await repository.appendObservation(session.id, {
    runId: 'run-hostile',
    identity: { turnIndex: 1, turnId: 'turn-hostile', requestAttempt: 1 },
    toolName: 'hostile_tool',
    observation: { ok: true, summary: 'bounded', output, metadata }
  });

  const replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session.id);
  const observation = replay.branch.find((entry) => entry.type === 'observation');
  assert.equal(getterCalls, 0);
  assert.equal(observation.output.getter, '[accessor omitted]');
  assert.equal(observation.output.__proto__.retained, true);
  assert.match(observation.output.cycle, /circular/u);
  assert.deepEqual(observation.metadata, { value: '[value inspection failed]' });
});

test('session repositories retain and expose only owned session state', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-owned-'));
  const repositories = [new InMemorySessionRepository(), new JsonlSessionRepository({ rootDir })];
  for (const [index, repository] of repositories.entries()) {
    const session = await repository.create({ id: `owned-${String(index)}`, model: 'original' });
    const instruction = { id: 'instruction', content: 'original', provenance: 'run' };
    const input = await repository.appendInput(session.id, { runId: 'run', task: 'original', instructions: [instruction] });
    instruction.content = 'mutated';

    assert.equal(input.instructions[0].content, 'original');
    assert.equal(Object.isFrozen(session), true);
    assert.equal(Object.isFrozen(session.header), true);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.instructions), true);
    assert.equal(Object.isFrozen(input.instructions[0]), true);
    assert.throws(() => { input.instructions[0].content = 'changed'; }, TypeError);

    const replay = await repository.loadReplayState(session.id);
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.branch), true);
    assert.equal(Object.isFrozen(replay.terminalProjections), true);
    assert.equal(Object.isFrozen(replay.ledgerRunIds), true);
    assert.throws(() => { replay.branch.pop(); }, TypeError);
    assert.equal((await repository.loadReplayState(session.id)).branch[0].instructions[0].content, 'original');
  }
});

test('session final projections are idempotent and validate the complete terminal union', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-final-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'final' });
  await repository.appendInput(session.id, { runId: 'run', task: 'finish the run' });
  const terminal = decodeAgentTerminalSnapshot({
    runId: 'run', finalizationId: 'fin', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop',
    candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [],
    budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, candidateRevisions: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0 }
  });
  const first = await repository.projectFinal(session.id, terminal);
  const second = await repository.projectFinal(session.id, terminal);
  assert.equal(first.id, second.id);
  const replay = await repository.loadReplayState(session.id);
  assert.equal(replay.terminalProjections.length, 1);
  assert.equal(first.throughEntryId, replay.branch[0].id);

  const file = repository.location(session.id);
  await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify({ type: 'final', id: 'bad', timestamp: new Date().toISOString(), runId: 'bad', finalizationId: 'bad', terminal: { ...terminal, runId: 'bad', finalizationId: 'bad', candidate: { status: 'absent' } } })}\n`, 'utf8');
  await assert.rejects(repository.open(session.id), error => error instanceof PersistenceCorruptionError && error.code === 'invalid_record');
});

test('session replay derives bounded continuity without persisted context records', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'long-session' });
  for (let index = 0; index < 300; index += 1) {
    const runId = `run-${String(index)}`;
    await repository.appendInput(session.id, { runId, task: `${'任務'.repeat(600)} ${String(index)}` });
    await repository.projectFinal(session.id, completedTerminal(runId, `final-${String(index)}`, `${'結果'.repeat(900)} ${String(index)}`));
  }

  const replay = await repository.loadReplayState(session.id);
  assert.equal(replay.branch.length, 300, 'the durable branch retains every input');
  assert.equal(replay.terminalProjections.length, 300, 'final projections remain authoritative inputs to derived continuity');
  assert.deepEqual(replay.ledgerRunIds, ['run-299']);
});

test('session JSONL tolerates a torn tail and identifies middle corruption', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-torn-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'torn' });
  await repository.appendInput(session.id, { runId: 'run', task: 'task' });
  const file = repository.location(session.id);
  await writeFile(file, `${await readFile(file, 'utf8')}{"type":`, 'utf8');
  assert.equal((await repository.loadReplayState(session.id)).branch.length, 1);
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.splice(1, 0, '{bad');
  await writeFile(file, lines.join('\n'), 'utf8');
  await assert.rejects(repository.open(session.id), error => error instanceof PersistenceCorruptionError && error.line === 2 && error.byteOffset > 0);
});

test('session JSONL indexes only newline-committed records and repairs arbitrarily large torn tails', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-committed-prefix-'));
  let repository = new JsonlSessionRepository({ rootDir });
  let session = await repository.create({ id: 'valid-tail' });
  await repository.appendInput(session.id, { runId: 'one', task: 'one' });
  await repository.appendInput(session.id, { runId: 'uncommitted', task: 'uncommitted' });
  const validFile = repository.location(session.id);
  const validBytes = await readFile(validFile);
  await writeFile(validFile, validBytes.subarray(0, validBytes.length - 1));

  repository = new JsonlSessionRepository({ rootDir });
  await repository.appendInput(session.id, { runId: 'replacement', task: 'replacement' });
  let replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session.id);
  assert.deepEqual(replay.branch.map(entry => entry.runId), ['one', 'replacement']);
  assert.equal(replay.branch[1].parentId, replay.branch[0].id);

  repository = new JsonlSessionRepository({ rootDir });
  session = await repository.create({ id: 'large-tail' });
  await repository.appendInput(session.id, { runId: 'one', task: 'one' });
  await appendFile(repository.location(session.id), 'x'.repeat(70 * 1024));
  await new JsonlSessionRepository({ rootDir }).appendInput(session.id, { runId: 'two', task: 'two' });
  replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session.id);
  assert.deepEqual(replay.branch.map(entry => entry.runId), ['one', 'two']);
  assert.equal(replay.branch[1].parentId, replay.branch[0].id);
});

test('session JSONL owns queued configuration and validates submission lifecycle recovery', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-submissions-'));
  let repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'submissions' });
  await repository.enqueueSubmission(session.id, {
    submissionId: 'submission', runId: 'run', input: { task: 'persisted task' },
    configuration: { provider: 'test', model: 'captured-model', reasoning: { strategy: 'effort', effort: 'high' }, responseFormat: { type: 'json_schema', schema: { type: 'object' } } }
  });
  repository = new JsonlSessionRepository({ rootDir });
  let pending = await repository.loadPendingSubmissions(session.id);
  assert.equal(pending[0].configuration.model, 'captured-model');
  assert.equal(Object.isFrozen(pending[0].configuration.responseFormat.schema), true);
  await repository.transitionSubmission(session.id, 'submission', { state: 'claimed' });
  await repository.transitionSubmission(session.id, 'submission', { state: 'suspended' });
  pending = await new JsonlSessionRepository({ rootDir }).loadPendingSubmissions(session.id);
  assert.equal(pending[0].state, 'suspended');

  await appendFile(repository.location(session.id), `${JSON.stringify({ type: 'submission.completed', submissionId: 'submission', runId: 'run', timestamp: new Date().toISOString() })}\n`);
  await assert.rejects(new JsonlSessionRepository({ rootDir }).open(session.id), error => error instanceof PersistenceCorruptionError && error.code === 'invalid_record');
});

function completedTerminal(runId, finalizationId, message) {
  return {
    runId,
    finalizationId,
    phase: 'ended',
    executionStatus: 'completed',
    verificationStatus: 'not_required',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    candidate: { status: 'complete', message, source: 'content', turnIndex: 1 },
    turnCount: 1,
    checkResults: [],
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      repeatedIdenticalToolCalls: 0,
      candidateRevisions: 0,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0,
      consecutiveProviderFailures: 0,
      consecutiveToolFailures: 0
    }
  };
}

function testBudget() { return completedTerminal('run', 'final', 'result').budget; }

function operationCoordinator() {
  return new AgentOperationCoordinator(new InMemoryEventRepository(agentEventCodec));
}

async function acceptTestOperation(operations, runId) {
  return operations.accept({
    runId,
    finalizationId: `${runId}:final`,
    input: { task: 'claimed', instructions: [], contextItems: [] },
    configuration: { providerId: 'test', providerImplementationId: 'agent-core.tests.session-provider@1', model: 'model', runtimeImplementationId: 'test/runtime@1', toolImplementationIds: [], checks: [], disposition: { implementationId: 'agent-core.tests.accept-disposition@1', policyIdentity: { strategy: 'accept' }, policyHash: hashJson({ strategy: 'accept' }) }, policyHash: 'policy' }
  });
}

async function acceptApprovalOperation(operations, runId) {
  await acceptTestOperation(operations, runId);
  const driver = await operations.attach(runId, 'session-test-driver');
  const identity = { turnIndex: 1, turnId: 'turn', requestAttempt: 1 };
  const advance = async (procedure, phase) => {
    const result = await driver.drive(({ instruction }) => {
      assert.equal(instruction.procedure, procedure);
      return { phase, budget: testBudget() };
    });
    assert.equal(result.kind, 'advanced');
  };
  await advance('prepare', { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 });
  await advance('assemble_turn', { kind: 'provider', stage: 'ready', identity, toolBatchId: 'batch' });
  const issued = issueEffectStartTicket({ intent: { effectId: 'provider-effect', operationId: runId, implementationId: 'agent-core.tests.session-provider@1', parametersDigest: '0'.repeat(64), recovery: { kind: 'unknown' }, exposure: { quantities: [] } }, ticketId: 'provider-ticket', settlementPermitId: 'provider-permit', driverGeneration: driver.state().driverGeneration, currentDriverGeneration: driver.state().driverGeneration });
  assert.equal(issued.status, 'issued');
  await advance('prepare_provider_request', { kind: 'provider', stage: 'effect_ready', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response', effect: issued.state });
  const started = startExternalEffect(issued.state, issued.state.ticket, driver.state().driverGeneration);
  assert.equal(started.status, 'started');
  await advance('start_provider_request', { kind: 'provider', stage: 'effect_pending', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response', effect: started.state });
  const settled = settleExternalEffect(started.state, started.state.settlementPermit, { outcome: 'succeeded', resultDigest: '1'.repeat(64), exposure: { status: 'known', quantities: [] } });
  assert.equal(settled.status, 'settled');
  await advance('reconcile_provider_request', { kind: 'provider', stage: 'settled', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response', settlementEventId: 'response-event', effect: settled.state });
  const call = createToolCall({ id: 'call', name: 'write', input: { kind: 'json', value: {} } });
  const effects = { accesses: [{ mode: 'write', scope: 'workspace/file' }], lockScopes: ['workspace/file'], recovery: { kind: 'unknown' } };
  const binding = { toolImplementationId: 'test/write@1', authorizationPolicyId: 'test-policy', executionTargetId: 'test-target' };
  const preparation = { toolImplementationId: binding.toolImplementationId, canonicalInput: {}, fingerprint: '2'.repeat(64), effects, binding, authorization: 'require_approval', authorizationReason: 'confirm' };
  const approval = { runId, ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call', approvalId: 'approval', status: 'pending', toolName: 'write', fingerprint: preparation.fingerprint, input: {}, effects, binding, policyHash: '3'.repeat(64), reason: 'confirm' };
  const batch = { identity, toolBatchId: 'batch', calls: [call], callStates: [{ stage: 'ready' }], maxConcurrency: 1, nextProjectionIndex: 0, instructions: [], modelInputModalities: ['text'] };
  await advance('consume_provider_settlement', { kind: 'tools', ...batch });
  await advance('prepare_tool_call', { kind: 'approval', ...batch, approvalCallIndex: 0, preparation, approval });
}

test('AgentSession serializes admission, preserves steering identity, and snapshots configuration at submission', async () => {
  const configurations = [];
  const runtimeContexts = [];
  const controls = [];
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'session-authority' });
  const session = new AgentSession({
    descriptor,
    repository,
    operations: operationCoordinator(),
    configuration: { provider: 'test', model: 'first' },
    createRuntime(configuration, _onProgress, context) {
      configurations.push(configuration);
      runtimeContexts.push(context);
      if (configuration.model === 'broken') throw new Error('unsupported model');
      return {
        run(input) {
          let resolve;
          const steering = [];
          const result = new Promise((done) => { resolve = done; });
          const control = { runId: input.runId, steering, resolve, result, injectSteering(value) { steering.push(value.instruction); return { id: 'steer', runId: input.runId, timestamp: new Date().toISOString() }; }, abort() {} };
          controls.push(control);
          return control;
        }
      };
    }
  });
  const first = await session.submit({ task: 'first' });
  assert.equal(first.kind, 'started');
  const stale = await session.submit({ task: 'stale' }, { delivery: 'steer', expectedRunId: 'wrong' });
  assert.deepEqual(stale, { kind: 'rejected', reason: 'run_mismatch' });
  const steered = await session.submit({ task: 'focus' }, { delivery: 'steer', expectedRunId: first.runId });
  assert.equal(steered.kind, 'steered');
  assert.deepEqual(controls[0].steering, ['focus']);
  await session.configure({ model: 'second' });
  const second = await session.submit({ task: 'second' });
  assert.equal(second.kind, 'queued');
  controls[0].resolve({ state: 'ended', terminal: { runId: first.runId }, deliveryDiagnostics: [] });
  await first.completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(configurations[0].model, 'first');
  assert.equal(configurations[1].model, 'second');
  assert.equal(runtimeContexts[0].runId, first.runId);
  assert.equal(runtimeContexts[0].submissionId, first.submissionId);
  assert.equal(runtimeContexts[0].input.task, 'first');
  assert.equal(runtimeContexts[0].resuming, false);
  controls[1].resolve({ state: 'ended', terminal: { runId: controls[1].runId }, deliveryDiagnostics: [] });
  await second.completion;
  assert.equal(session.state().phase, 'idle');

  const third = await session.submit({ task: 'third' });
  await session.configure({ model: 'broken' });
  const fourth = await session.submit({ task: 'fourth' });
  controls[2].resolve({ state: 'ended', terminal: { runId: controls[2].runId }, deliveryDiagnostics: [] });
  await third.completion;
  await assert.rejects(fourth.completion, /unsupported model/u);
  assert.equal(session.state().phase, 'idle');
});

test('session branches require stable boundaries and conversation projects assistant turns once', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'stable-branch' });
  const input = await repository.appendInput(session.id, { runId: 'run', task: 'work' });
  await assert.rejects(repository.branchFrom(session.id, input.id), /completed final or compaction/u);
  await repository.appendAssistant(session.id, {
    runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'answer'
  });
  await repository.appendSteering(session.id, { runId: 'run', content: 'preserve this accepted correction' });
  await assert.rejects(repository.appendAssistant(session.id, {
    runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'conflicting answer'
  }), /Conflicting assistant projection/u);
  await repository.appendAssistant(session.id, {
    runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'answer'
  });
  await repository.projectFinal(session.id, completedTerminal('run', 'final', 'answer'));
  const points = await repository.listBranchPoints(session.id);
  assert.equal(points.length, 1);
  await repository.branchFrom(session.id, points[0].entryId);
  const conversation = await repository.readConversation(session.id);
  assert.equal(conversation.filter((entry) => entry.type === 'assistant').length, 1);
  assert.equal(conversation.filter((entry) => entry.type === 'steering').length, 1);
});

test('AgentSession restores claimed and queued work without starting execution during restore', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'durable-admission' });
  const blocked = new AgentSession({
    descriptor, repository, operations: operationCoordinator(), configuration: { provider: 'test', model: 'model' },
    createRuntime() {
      return { run(input) { return { runId: input.runId, result: new Promise(() => {}), injectSteering() { throw new Error('unused'); }, abort() {} }; } };
    }
  });
  const claimed = await blocked.submit({ task: 'claimed' });
  const queued = await blocked.submit({ task: 'recover me' });
  assert.equal(queued.kind, 'queued');

  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  await acceptTestOperation(operations, claimed.runId);

  const executed = [];
  const failures = [];
  const recovered = new AgentSession({
    descriptor, repository, operations, configuration: { provider: 'test', model: 'different-model' },
    createRuntime(configuration, _onProgress, context) {
      const execute = (input) => {
        executed.push({ task: input.task, model: configuration.model, resuming: context.resuming });
        return { runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), injectSteering() { throw new Error('unused'); }, abort() {} };
      };
      return { run: execute, resume(runId) { return execute({ runId, task: 'claimed' }); } };
    }
  });
  recovered.subscribe((event) => { if (event.type === 'run.failed') failures.push(event.error.message); });
  await recovered.restore();
  assert.deepEqual(executed, []);
  await recovered.waitForIdle();
  assert.deepEqual(executed, [{ task: 'claimed', model: 'model', resuming: true }, { task: 'recover me', model: 'model', resuming: false }]);
  assert.equal(failures.length, 0);
  assert.deepEqual(await repository.loadPendingSubmissions(descriptor.id), []);
});

test('semantic compaction is persisted once and becomes the replay base', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'semantic-compaction' });
  await repository.appendInput(descriptor.id, { runId: 'run', task: 'retain this decision' });
  await repository.appendAssistant(descriptor.id, { runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'decision retained' });
  await repository.projectFinal(descriptor.id, completedTerminal('run', 'final', 'decision retained'));
  let calls = 0;
  const agent = new AgentSession({
    descriptor, repository, operations: operationCoordinator(), configuration: { provider: 'test', model: 'summary-model' },
    createRuntime() { throw new Error('runtime is not needed for compaction'); },
    async summarizeConversation(request) {
      calls += 1;
      assert.equal(request.conversation.some((entry) => entry.type === 'assistant'), true);
      return 'Persisted semantic decision.';
    }
  });
  const compacted = await agent.compact();
  assert.equal(Object.isFrozen(compacted), true);
  const replay = await repository.loadReplayState(descriptor.id);
  assert.equal(replay.compaction?.summary, 'Persisted semantic decision.');
  assert.deepEqual(replay.ledgerRunIds, []);
  assert.equal(calls, 1);
  await assert.rejects(agent.compact(), /requires new completed conversation history/u);
  assert.equal(calls, 1);
});

test('approval suspension remains durable and blocks queued follow-ups until resolution', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'durable-suspension' });
  let resolveFirst;
  const firstProcess = new AgentSession({
    descriptor, repository, operations: operationCoordinator(), configuration: { provider: 'test', model: 'model' },
    createRuntime() { return { run(input) {
      return { runId: input.runId, result: new Promise((resolve) => { resolveFirst = resolve; }), injectSteering() { throw new Error('unused'); }, abort() {} };
    } }; }
  });
  const first = await firstProcess.submit({ task: 'needs approval' });
  const followUp = await firstProcess.submit({ task: 'after approval' });
  assert.equal(followUp.kind, 'queued');
  resolveFirst({ state: 'suspended', reason: 'approval_required', runId: first.runId, finalizationId: 'final', pendingApprovals: [], budget: testBudget() });
  await first.completion;
  assert.equal(firstProcess.state().phase, 'waiting_for_user');

  const approvalEvents = new InMemoryEventRepository(agentEventCodec);
  const approvalOperations = new AgentOperationCoordinator(approvalEvents);
  await acceptApprovalOperation(approvalOperations, first.runId);

  const executed = [];
  const restarted = new AgentSession({
    descriptor, repository, operations: approvalOperations, configuration: { provider: 'test', model: 'model' },
    createRuntime() { return {
      run(input) {
        executed.push(input.task);
        return { runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), injectSteering() { throw new Error('unused'); }, abort() {} };
      },
      resolveApproval(input) {
        return Promise.resolve({ runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), injectSteering() { throw new Error('unused'); }, abort() {} });
      }
    }; }
  });
  await restarted.restore();
  assert.equal(restarted.state().phase, 'waiting_for_user');
  assert.deepEqual(executed, []);
  await restarted.resolveApproval({ runId: first.runId, approvalId: 'approval', fingerprint: 'fingerprint', decision: 'allow' });
  await restarted.waitForIdle();
  assert.deepEqual(executed, ['after approval']);
});

test('aborting a suspended submission commits cancellation before starting finalization', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'abort-suspension' });
  const runId = 'suspended-run';
  await repository.enqueueSubmission(descriptor.id, {
    submissionId: 'submission',
    runId,
    input: { task: 'suspended task' },
    configuration: { provider: 'test', model: 'model' }
  });
  await repository.transitionSubmission(descriptor.id, 'submission', { state: 'claimed' });
  await repository.transitionSubmission(descriptor.id, 'submission', { state: 'suspended' });
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  await acceptApprovalOperation(operations, runId);
  let resumed = false;
  const session = new AgentSession({
    descriptor,
    repository,
    operations,
    configuration: { provider: 'test', model: 'model' },
    createRuntime() {
      return {
        resume(resumedRunId) {
          resumed = true;
          const result = operations.inspect(resumedRunId).then((inspection) => {
            assert.equal(inspection.state.control.status, 'abort_requested');
            return { state: 'ended', terminal: { runId: resumedRunId }, deliveryDiagnostics: [] };
          });
          return { runId: resumedRunId, result, injectSteering() { throw new Error('unused'); }, abort() { return Promise.resolve(); } };
        }
      };
    }
  });
  await session.restore();
  assert.equal(session.state().phase, 'waiting_for_user');
  assert.equal(await session.abort('cancel suspended work', runId), true);
  await session.waitForIdle();
  assert.equal(resumed, true);
  assert.equal(session.state().phase, 'idle');
});
test('session listing orders sessions by latest committed activity', async () => {
  const repository = new InMemorySessionRepository();
  const first = await repository.create({ id: 'first' });
  await new Promise(resolve => setTimeout(resolve, 2));
  await repository.create({ id: 'second' });
  await new Promise(resolve => setTimeout(resolve, 2));
  await repository.appendInput(first.id, { runId: 'run', task: 'recent activity' });
  const sessions = await repository.list();
  assert.equal(sessions[0].id, first.id);
  assert.ok(sessions[0].updatedAt >= sessions[0].timestamp);
});
