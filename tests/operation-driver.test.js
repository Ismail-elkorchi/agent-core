import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { hashJson, InMemoryEventRepository } from '@agent-core/evidence';
import {
  AgentOperationConflictError,
  AgentOperationCoordinator,
  agentEventCodec,
  decodeAgentOperationState,
  nextAgentOperationInstruction
} from '@agent-core/runtime';
import { createToolCall, parseToolObservation } from '@agent-core/tools';

const acceptance = (runId = 'run-operation') => ({
  runId,
  finalizationId: `${runId}-final`,
  input: { task: 'Perform a bounded task.', instructions: [], contextItems: [] },
  configuration: {
    providerId: 'scripted',
    providerImplementationId: 'agent-core.tests.operation-provider@1',
    model: 'scripted-model',
    runtimeImplementationId: 'runtime-test-v1',
    toolImplementationIds: ['read-v1'],
    checks: [{ id: 'required-check', implementationId: 'agent-core.test.check.v1' }],
    disposition: { implementationId: 'agent-core.tests.accept-disposition@1', policyIdentity: { strategy: 'accept' }, policyHash: hashJson({ strategy: 'accept' }) },
    policyHash: 'policy-hash'
  }
});

test('operation acceptance is durable and inspection is read-only', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  const accepted = await operations.accept(acceptance());
  assert.equal(accepted.state.phase.kind, 'accepted');
  assert.deepEqual(accepted.instruction, { kind: 'wait', reason: 'driver' });
  const before = await events.tail('run-operation');
  const inspected = await operations.inspect('run-operation');
  assert.deepEqual(await events.tail('run-operation'), before);
  assert.deepEqual(inspected, accepted);
  assert.equal((await operations.listUnfinished()).length, 1);
});

test('driver attachment fences a live stale owner and all writes retain one tail authority', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  await operations.accept(acceptance('fenced'));
  const first = await operations.attach('fenced', 'driver-one');
  await first.append({ type: 'input.received', task: 'Perform a bounded task.' }, 'fenced:input');

  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const staleDrive = first.drive(async ({ instruction }) => {
    assert.equal(instruction.procedure, 'prepare');
    await blocked;
    return { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 } };
  });

  const second = await operations.attach('fenced', 'driver-two');
  release();
  await assert.rejects(staleDrive, error => {
    assert.ok(error instanceof AgentOperationConflictError);
    assert.ok(error.reason === 'stale_tail' || error.reason === 'stale_driver');
    return true;
  });

  const advanced = await second.drive(({ instruction }) => {
    assert.equal(instruction.procedure, 'prepare');
    return { phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 } };
  });
  assert.equal(advanced.kind, 'advanced');
  assert.equal(advanced.inspection.state.driverGeneration, 2);
  assert.equal(advanced.inspection.state.phase.kind, 'preparing');
});

test('a stale live owner may settle only its exact started tool effect permit', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  await operations.accept(acceptance('effect-settlement'));
  const staleOwner = await operations.attach('effect-settlement', 'driver-one');
  const call = createToolCall({ id: 'call-1', name: 'read', input: { kind: 'json', value: {} } });
  const digest = 'a'.repeat(64);
  const effectId = 'effect-settlement:tool:1';
  const permit = { permitId: 'settle-effect-1', effectId, parametersDigest: digest };
  const effect = {
    phase: 'started',
    intent: { effectId, operationId: 'effect-settlement', implementationId: 'read-v1', parametersDigest: digest, recovery: { kind: 'unknown' }, exposure: { quantities: [] } },
    ticket: { ticketId: 'start-effect-1', effectId, parametersDigest: digest, driverGeneration: 1 },
    settlementPermit: permit
  };
  const pending = decodeAgentOperationState({
    ...staleOwner.state(),
    revision: staleOwner.state().revision + 1,
    phase: {
      kind: 'tools', identity: { turnIndex: 1, turnId: 'turn-1', requestAttempt: 1 },
      toolBatchId: 'batch-1', calls: [call], maxConcurrency: 1, nextProjectionIndex: 0,
      instructions: [], modelInputModalities: ['text'],
      callStates: [{
        stage: 'effect_pending',
        preparation: {
          toolImplementationId: 'read-v1', canonicalInput: {}, fingerprint: digest,
          effects: { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [], recovery: { kind: 'unknown' } },
          binding: { toolImplementationId: 'read-v1', authorizationPolicyId: 'policy-1', executionTargetId: 'target-1' },
          authorization: 'allow'
        },
        toolAttempt: 1,
        effect
      }]
    },
    budget: {
      modelTurns: 1, totalToolCalls: 1, repeatedIdenticalToolCalls: 0, candidateRevisions: 0, elapsedMs: 1,
      promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      knownCosts: {}, pricingStatus: 'known', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0
    },
    toolCalls: [call]
  });
  const tail = await events.tail('effect-settlement');
  const installed = await events.appendConditional('effect-settlement', { type: 'operation.transition', state: pending }, {
    idempotencyKey: 'effect-settlement:pending', expectedTail: tail, driverGeneration: 1
  });
  assert.equal(installed.kind, 'committed');
  const replacement = await operations.attach('effect-settlement', 'driver-two');
  assert.equal(replacement.state().driverGeneration, 2);
  const observation = parseToolObservation({ outputSchema: z.strictObject({ value: z.string() }) }, {
    kind: 'result', ok: true, output: { value: 'settled' }, summary: 'read completed', scope: { resources: ['memory'], coverage: 'complete' }
  });
  const settlement = { observationId: 'observation-1', observation, createdAt: new Date(0).toISOString() };

  await assert.rejects(
    operations.settleToolEffect('effect-settlement', { effectId, permit: { ...permit, permitId: 'wrong-permit' }, settlement }),
    /settlement authority was rejected/u
  );
  const settled = await operations.settleToolEffect('effect-settlement', { effectId, permit, settlement });
  assert.equal(settled.state.phase.kind, 'tools');
  assert.equal(settled.state.phase.callStates[0].stage, 'settled');
  const synchronized = await staleOwner.synchronize();
  assert.equal(synchronized.state.control.status, 'owned');
  assert.equal(synchronized.state.control.driverId, 'driver-two');
});

test('every parallel completion permutation survives driver replacement and projects only the settled source-order prefix', async () => {
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]
  ];
  for (const [permutationIndex, permutation] of permutations.entries()) {
    const runId = `parallel-permutation-${String(permutationIndex)}`;
    const events = new InMemoryEventRepository(agentEventCodec);
    const operations = new AgentOperationCoordinator(events);
    await operations.accept(acceptance(runId));
    const initial = await operations.attach(runId, 'driver-initial');
    const calls = [0, 1, 2].map((index) => createToolCall({ id: `call-${String(index)}`, name: 'read', input: { kind: 'json', value: { index } } }));
    const effects = calls.map((_call, index) => {
      const parametersDigest = String(index + 1).repeat(64);
      const effectId = `${runId}:effect:${String(index)}`;
      return {
        phase: 'started',
        intent: { effectId, operationId: runId, implementationId: 'read-v1', parametersDigest, recovery: { kind: 'unknown' }, exposure: { quantities: [] } },
        ticket: { ticketId: `${effectId}:start`, effectId, parametersDigest, driverGeneration: initial.state().driverGeneration },
        settlementPermit: { permitId: `${effectId}:settle`, effectId, parametersDigest }
      };
    });
    const callStates = effects.map((effect, index) => ({
      stage: 'effect_pending',
      preparation: {
        toolImplementationId: 'read-v1', canonicalInput: { index }, fingerprint: effect.intent.parametersDigest,
        effects: { accesses: [{ mode: 'read', scope: `memory/${String(index)}` }], lockScopes: [], recovery: { kind: 'unknown' } },
        binding: { toolImplementationId: 'read-v1', authorizationPolicyId: 'policy-1', executionTargetId: 'target-1' }, authorization: 'allow'
      },
      toolAttempt: 1,
      effect
    }));
    const pending = decodeAgentOperationState({
      ...initial.state(), revision: initial.state().revision + 1,
      phase: {
        kind: 'tools', identity: { turnIndex: 1, turnId: 'turn-1', requestAttempt: 1 }, toolBatchId: 'batch-1', calls,
        callStates, maxConcurrency: 3, nextProjectionIndex: 0, instructions: [], modelInputModalities: ['text']
      },
      budget: {
        modelTurns: 1, totalToolCalls: 3, repeatedIdenticalToolCalls: 1, candidateRevisions: 0, elapsedMs: 1,
        promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        knownCosts: {}, pricingStatus: 'known', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0
      },
      toolCalls: calls
    });
    const installed = await events.appendConditional(runId, { type: 'operation.transition', state: pending }, {
      idempotencyKey: `${runId}:pending`, expectedTail: await events.tail(runId), driverGeneration: initial.state().driverGeneration
    });
    assert.equal(installed.kind, 'committed');

    let driver = initial;
    const settlements = calls.map((_call, index) => ({
      observationId: `observation-${String(index)}`,
      observation: parseToolObservation({ outputSchema: z.strictObject({ index: z.int() }) }, {
        kind: 'result', ok: true, output: { index }, summary: `settled ${String(index)}`, scope: { resources: [`memory/${String(index)}`], coverage: 'complete' }
      }),
      createdAt: new Date(index).toISOString()
    }));
    for (const [completionIndex, callIndex] of permutation.entries()) {
      const effect = effects[callIndex];
      const settlement = settlements[callIndex];
      await operations.settleToolEffect(runId, { effectId: effect.intent.effectId, permit: effect.settlementPermit, settlement });
      await operations.settleToolEffect(runId, { effectId: effect.intent.effectId, permit: effect.settlementPermit, settlement });
      driver = await operations.attach(runId, `driver-after-${String(completionIndex)}`);
      const phase = driver.state().phase;
      assert.equal(phase.kind, 'tools');
      assert.equal(phase.callStates[callIndex].stage, 'settled');
      assert.equal(phase.nextProjectionIndex, 0);
    }
    assert.deepEqual(nextAgentOperationInstruction(driver.state()), { kind: 'execute', procedure: 'prepare_tool_projection' });

    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      let result = await driver.drive(({ state, instruction }) => {
        assert.equal(instruction.procedure, 'prepare_tool_projection');
        const phase = state.phase;
        assert.equal(phase.kind, 'tools');
        const states = [...phase.callStates];
        states[callIndex] = { ...states[callIndex], stage: 'projecting' };
        return { phase: { ...phase, callStates: states } };
      });
      assert.equal(result.kind, 'advanced');
      result = await driver.drive(({ state, instruction }) => {
        assert.equal(instruction.procedure, 'project_tool_settlement');
        const phase = state.phase;
        assert.equal(phase.kind, 'tools');
        const states = [...phase.callStates];
        states[callIndex] = { ...states[callIndex], stage: 'projected' };
        return { phase: { ...phase, callStates: states, nextProjectionIndex: callIndex + 1 } };
      });
      assert.equal(result.kind, 'advanced');
    }
    assert.deepEqual(nextAgentOperationInstruction(driver.state()), { kind: 'execute', procedure: 'advance_after_tools' });
  }
});

test('abort retries a lost tail race and becomes the durable control state', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  await operations.accept(acceptance('abort-race'));
  const driver = await operations.attach('abort-race', 'driver');
  const results = await Promise.allSettled([
    driver.drive(() => ({ phase: { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 } })),
    operations.requestAbort('abort-race', 'User requested cancellation.')
  ]);
  assert.equal(results[1].status, 'fulfilled');
  assert.ok(results[0].status === 'fulfilled' || results[0].status === 'rejected');
  const current = await operations.inspect('abort-race');
  assert.equal(current.state.control.status, 'abort_requested');
});

test('total operation states select one explicit procedure, wait, or completion', () => {
  const accepted = decodeAgentOperationState({
    ...acceptance('selection'),
    revision: 0,
    driverGeneration: 0,
    control: { status: 'detached' },
    phase: { kind: 'accepted' },
    toolCalls: [],
    revisionInstructions: []
  });
  assert.deepEqual(nextAgentOperationInstruction(accepted), { kind: 'wait', reason: 'driver' });
  const owned = decodeAgentOperationState({ ...accepted, revision: 1, driverGeneration: 1, control: { status: 'owned', driverId: 'driver' } });
  assert.deepEqual(nextAgentOperationInstruction(owned), { kind: 'execute', procedure: 'prepare' });
  const suspended = decodeAgentOperationState({ ...owned, revision: 2, phase: { kind: 'suspended', reason: 'tool_outcome_unknown', effectId: 'effect-1' } });
  assert.deepEqual(nextAgentOperationInstruction(suspended), { kind: 'wait', reason: 'external_outcome' });
  const terminal = decodeAgentOperationState({ ...owned, revision: 3, phase: { kind: 'terminal', resultEventId: 'event-terminal' } });
  assert.deepEqual(nextAgentOperationInstruction(terminal), { kind: 'complete' });
  assert.throws(() => decodeAgentOperationState({ ...owned, phase: { kind: 'not-real' } }), /phase.kind/u);
});
