import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRunCoordinator,
  agentEventCodec,
  decodeAgentRunState,
  nextAgentRunInstruction
} from '@agent-core/runtime';

const acceptance = {
  runId: 'context-conflict',
  finalizationId: 'context-conflict-final',
  input: { task: 'Keep the accepted input.', instructions: [], contextItems: [] },
  configuration: {
    providerId: 'scripted',
    providerImplementationId: 'scripted@1',
    model: 'small',
    runtimeImplementationId: 'runtime@1',
    toolImplementationIds: [],
    policyHash: 'policy'
  }
};
const conflict = {
  kind: 'request_capacity',
  message: 'Protected input and output reservation exceed the context window.',
  inputIdentity: 'sha256:compiled-input',
  estimatedInputTokens: 12000,
  contextTokens: 10000,
  outputReservation: 2000,
  reasoningReservation: 0,
  actions: ['select_sources', 'change_model', 'reduce_reservation', 'cancel']
};

test('context admission suspension is durable, actionable, and has no fabricated effect', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const coordinator = new AgentRunCoordinator(events, artifacts);
  await coordinator.accept(acceptance);
  const run = await coordinator.attach(acceptance.runId);
  await run.transition('initialize_run', {
    phase: { kind: 'initializing', step: 'assemble_turn', turnIndex: 1 }
  });
  await run.transition('assemble_turn', {
    phase: { kind: 'suspended', reason: 'context_admission', turnIndex: 1, conflict }
  });
  const restored = await new AgentRunCoordinator(events, artifacts).inspect(acceptance.runId);
  assert.deepEqual(restored.state.phase.conflict, conflict);
  assert.deepEqual(restored.state.toolBatches, []);
  assert.deepEqual(restored.state.providerRequests, []);
  assert.deepEqual(nextAgentRunInstruction(restored.state), {
    kind: 'wait',
    reason: 'context_admission'
  });
  assert.equal(restored.state.input.task, acceptance.input.task);
  await coordinator.requestAbort(acceptance.runId, 'Stop waiting.');
  assert.equal(
    (await coordinator.inspect(acceptance.runId)).instruction.procedure,
    'finalize_abort'
  );
});

test('persisted context conflicts reject false recovery authority and invalid accounting', () => {
  const state = {
    ...acceptance,
    revision: 0,
    driverGeneration: 0,
    control: { status: 'detached' },
    phase: { kind: 'suspended', reason: 'context_admission', turnIndex: 1, conflict },
    providerRequests: [],
    toolBatches: []
  };
  assert.throws(
    () => decodeAgentRunState({ ...state, phase: { ...state.phase, effectId: 'invented' } }),
    /Unsupported/
  );
  for (const value of [
    { ...conflict, outputReservation: -1 },
    { ...conflict, actions: ['retry'] },
    { ...conflict, actions: [] }
  ])
    assert.throws(
      () => decodeAgentRunState({ ...state, phase: { ...state.phase, conflict: value } }),
      /Context admission/
    );
});

test('preparation retry is scoped to unavailable preparation without claiming measured capacity', () => {
  const preparation = {
    kind: 'request_preparation', recovery: 'request_unavailable',
    message: 'Provider request compilation is temporarily unavailable.',
    actions: ['retry', 'change_model', 'cancel']
  };
  const state = {
    ...acceptance, revision: 0, driverGeneration: 0, control: { status: 'detached' },
    phase: { kind: 'suspended', reason: 'context_admission', turnIndex: 1, conflict: preparation },
    providerRequests: [], toolBatches: []
  };
  assert.deepEqual(decodeAgentRunState(state).phase.conflict, preparation);
  const { recovery: _recovery, ...unclassified } = preparation;
  for (const value of [
    unclassified,
    { ...preparation, recovery: 'attempt_limit' },
    { ...preparation, recoveryBoundary: 'a'.repeat(64) },
    { ...preparation, inputIdentity: 'sha256:unmeasured' },
    { ...preparation, estimatedInputTokens: 100 },
    { ...preparation, outputReservation: 100 },
    { ...preparation, actions: ['select_sources', 'retry', 'cancel'] },
    { ...preparation, actions: ['change_model', 'cancel'] },
    { ...conflict, actions: ['retry', 'change_model', 'cancel'] },
    { ...conflict, kind: 'provider_capacity', actions: ['retry', 'cancel'] },
    { kind: 'native_continuity', reason: 'unsupported', message: 'No reset.', actions: ['retry'] },
    { kind: 'source_capacity', message: 'Too many source bytes.', actions: ['retry'],
      cut: { format: 'agent-core.history/1', sessionId: 'session', branchId: 'root', throughEntryId: null,
        sourceRevision: 0, ledgerCoverage: 'session', ledgerHeads: [] },
      bound: { unit: 'bytes', limit: 100, observedAtLeast: 101 } }
  ])
    assert.throws(() => decodeAgentRunState({ ...state, phase: { ...state.phase, conflict: value } }), /Context admission/);
});
