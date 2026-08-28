import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventRepository } from '@agent-core/evidence';
import {
  AgentOperationConflictError,
  AgentOperationCoordinator,
  agentEventCodec,
  decodeAgentOperationState,
  nextAgentOperationInstruction
} from '@agent-core/runtime';

const acceptance = (runId = 'run-operation') => ({
  runId,
  finalizationId: `${runId}-final`,
  input: { task: 'Perform a bounded task.', instructions: [], contextItems: [] },
  configuration: {
    providerId: 'scripted',
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
    phase: { kind: 'accepted' }
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
