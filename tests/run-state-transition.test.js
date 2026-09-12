import assert from 'node:assert/strict';
import test from 'node:test';
import { hashJson } from '@agent-core/persistence';
import {
  applyAgentRunStateTransition,
  createAgentRunStateTransition,
  decodeAgentRunState,
  decodeAgentRunStateTransition
} from '@agent-core/runtime';
import { createToolCall } from '@agent-core/tools';

test('run transitions persist only changed collection entries and reconstruct the exact state', () => {
  let state = initialState();
  let reconstructed;
  reconstructed = applyAgentRunStateTransition(
    reconstructed,
    createAgentRunStateTransition(undefined, state)
  );
  const transitionBytes = [];
  for (let index = 0; index < 100; index += 1) {
    const next = decodeAgentRunState({
      ...state,
      revision: state.revision + 1,
      phase: { kind: 'active' },
      toolBatches: [...state.toolBatches, readyBatch(index)]
    });
    const transition = createAgentRunStateTransition(state, next);
    assert.equal(transition.kind, 'updated');
    assert.deepEqual(transition.toolBatches?.map((entry) => entry.index), [index]);
    transitionBytes.push(Buffer.byteLength(JSON.stringify(transition)));
    reconstructed = applyAgentRunStateTransition(reconstructed, transition);
    state = next;
  }
  assert.deepEqual(reconstructed, state);
  const firstTen = transitionBytes.slice(0, 10).reduce((sum, value) => sum + value, 0);
  const all = transitionBytes.reduce((sum, value) => sum + value, 0);
  assert.ok(all < firstTen * 11, `transition storage grew faster than linearly: ${String(all)}`);
});

test('replay reuses validated immutable values and checks relationships across transition boundaries', () => {
  const previous = decodeAgentRunState({ ...initialState(), toolBatches: [readyBatch(0)] });
  const raw = { kind: 'updated', runId: previous.runId, revision: 1, driverGeneration: 0,
    toolBatches: [{ index: 1, value: readyBatch(1) }] };
  const transition = decodeAgentRunStateTransition(raw);
  const next = applyAgentRunStateTransition(previous, transition);
  raw.toolBatches[0].value.calls[0] = { name: 'tampered' };
  assert.equal(next.input, previous.input);
  assert.equal(next.toolBatches[0], previous.toolBatches[0]);
  assert.equal(next.toolBatches[1].calls[0].name, 'read');
  assert(Object.isFrozen(next.toolBatches[1].calls[0]));
  const duplicate = decodeAgentRunStateTransition({ ...raw, toolBatches: [{ index: 1, value: readyBatch(0) }] });
  assert.throws(() => applyAgentRunStateTransition(previous, duplicate), /identities must be unique/);
  const gap = decodeAgentRunStateTransition({ ...raw, toolBatches: [{ index: 2, value: readyBatch(1) }] });
  assert.throws(() => applyAgentRunStateTransition(previous, gap), /positional gap/);
});

function initialState() {
  return decodeAgentRunState({
    runId: 'linear-run',
    finalizationId: 'linear-finalization',
    revision: 0,
    driverGeneration: 0,
    input: { task: 'exercise storage', instructions: [], contextItems: [] },
    configuration: {
      providerId: 'test',
      providerImplementationId: 'test-provider@1',
      model: 'test-model',
      runtimeImplementationId: 'test-runtime@1',
      toolImplementationIds: ['read@1'],
      policyHash: 'policy'
    },
    control: { status: 'detached' },
    phase: { kind: 'accepted' },
    providerRequests: [],
    toolBatches: []
  });
}

function readyBatch(index) {
  const turnIndex = index + 1;
  const call = createToolCall({
    id: `call-${String(index)}`,
    name: 'read',
    input: { kind: 'json', value: { index } }
  });
  const entries = [{ name: 'read', implementationId: 'read@1', definitionHash: 'a'.repeat(64) }];
  return {
    kind: 'tools',
    identity: { turnIndex, turnId: `turn-${String(turnIndex)}`, requestAttempt: 1 },
    toolBatchId: `batch-${String(index)}`,
    calls: [call],
    modelCalls: [{ id: call.id, name: call.name, type: 'function', input: call.input }],
    source: { responseId: `response-${String(index)}`, catalog: { revision: hashJson(entries), entries } },
    callStates: [{ stage: 'ready' }],
    maxConcurrency: 1,
    instructions: [],
    modelInputModalities: ['text']
  };
}
