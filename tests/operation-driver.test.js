import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { InMemoryEventRepository } from '@agent-core/evidence';
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
    checkIds: ['required-check'],
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
      kind: 'tools', stage: 'effect_pending', identity: { turnIndex: 1, turnId: 'turn-1', requestAttempt: 1 },
      toolBatchId: 'batch-1', calls: [call], nextCallIndex: 0, instructions: [], modelInputModalities: ['text'],
      preparation: {
        toolImplementationId: 'read-v1', canonicalInput: {}, fingerprint: digest,
        effects: { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [], recovery: { kind: 'unknown' } },
        binding: { toolImplementationId: 'read-v1', authorizationPolicyId: 'policy-1', executionTargetId: 'target-1' },
        authorization: 'allow'
      },
      toolAttempt: 1,
      effect
    },
    budget: {
      modelTurns: 1, totalToolCalls: 1, repeatedIdenticalToolCalls: 0, elapsedMs: 1,
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
  assert.equal(settled.state.phase.stage, 'settled');
  const synchronized = await staleOwner.synchronize();
  assert.equal(synchronized.state.control.status, 'owned');
  assert.equal(synchronized.state.control.driverId, 'driver-two');
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
    toolCalls: []
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
