import assert from 'node:assert/strict';
import test from 'node:test';
import { hashJson, InMemoryArtifactRepository } from '@agent-core/persistence';
import {
  AgentRunRecords,
  applyAgentRunStateTransition,
  createAgentRunStateTransition,
  decodeAgentRunState,
  decodeAgentRunStateTransition
} from '@agent-core/runtime';
import { createToolCall } from '@agent-core/tools';

test('completed original records exceed the former aggregate quota while live work stays bounded', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const records = new AgentRunRecords(artifacts);
  let state = initialState();
  let replay = await applyAgentRunStateTransition(
    undefined,
    await createAgentRunStateTransition(undefined, state, records),
    records
  );
  let bytes = 0;
  for (let index = 0; index < 500; index++) {
    const next = {
      ...state,
      revision: state.revision + 1,
      phase: { kind: 'active' },
      toolBatches: [{ ...readyBatch(index), callStates: [{ stage: 'cancelled', toolAttempt: 1 }] }]
    };
    const transition = await createAgentRunStateTransition(state, next, records);
    const persisted = decodeAgentRunStateTransition(JSON.parse(JSON.stringify(transition)));
    bytes += Buffer.byteLength(JSON.stringify(persisted));
    assert.equal(persisted.toolRecords.length, 1);
    assert.equal(persisted.toolRecords[0].value.source.kind, 'tool_source');
    replay = await applyAgentRunStateTransition(replay, persisted, records);
    assert.equal(replay.toolBatches.length, 1);
    state = next;
  }
  const empty = { ...state, revision: state.revision + 1, toolBatches: [] };
  replay = await applyAgentRunStateTransition(
    replay,
    await createAgentRunStateTransition(state, empty, records),
    records
  );
  assert.deepEqual(replay.toolBatches, []);
  assert(bytes > 20000);
});

test('obsolete inline transitions and unresolved work removal are rejected', async () => {
  const records = new AgentRunRecords(new InMemoryArtifactRepository());
  const previous = initialState();
  assert.throws(
    () =>
      decodeAgentRunStateTransition({
        kind: 'updated',
        runId: previous.runId,
        revision: 1,
        driverGeneration: 0,
        toolBatches: [{ index: 0, value: readyBatch(1) }]
      }),
    /unsupported field/
  );
  const active = { ...previous, revision: 1, toolBatches: [readyBatch(0)] };
  await assert.rejects(
    createAgentRunStateTransition(active, { ...active, revision: 2, toolBatches: [] }, records),
    /Unresolved tool/
  );
});

test('record lookup verifies run scope, missing artifacts and changed digests before work can load', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const records = new AgentRunRecords(artifacts);
  const batch = readyBatch(1);
  const stored = await records.storeTools('run-a', batch);
  assert.deepEqual(await records.loadTools('run-a', stored), batch);
  await assert.rejects(records.loadTools('run-b', stored), /scope/);
  await assert.rejects(
    new AgentRunRecords(new InMemoryArtifactRepository()).loadTools('run-a', stored),
    /Unknown artifact/
  );
  await assert.rejects(
    records.loadTools('run-a', {
      ...stored,
      source: { ...stored.source, artifact: { ...stored.source.artifact, sha256: '0'.repeat(64) } }
    }),
    /verification failed/
  );
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
    source: {
      responseId: `response-${String(index)}`,
      catalog: { revision: hashJson(entries), entries }
    },
    callStates: [{ stage: 'ready' }],
    maxConcurrency: 1,
    instructions: [],
    modelInputModalities: ['text']
  };
}

test('individually bounded original call inputs do not share an aggregate state parser quota', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const records = new AgentRunRecords(artifacts);
  const original = readyBatch(1);
  const calls = Array.from({ length: 40 }, (_, index) =>
    createToolCall({
      id: `large-${index}`,
      name: 'read',
      input: { kind: 'json', value: { values: Array.from({ length: 400 }, (_, n) => n + index) } }
    })
  );
  const batch = {
    ...original,
    calls,
    modelCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      type: 'function',
      input: call.input
    })),
    callStates: calls.map(() => ({ stage: 'ready' }))
  };
  const stored = await records.storeTools('large-run', batch);
  const restored = await records.loadTools('large-run', stored);
  assert.deepEqual(restored.calls, calls);
  assert.equal(restored.calls[39].input.value.values[399], 438);
  const source = await records.read('large-run', 'tool_source', stored.source);
  assert.equal(
    source.calls[0].inputRef.artifact.sha256,
    source.modelCalls[0].inputRef.artifact.sha256
  );
  assert.equal(source.calls[0].input, undefined);
});

test('failed record storage cannot publish a startable reference', async () => {
  const failure = new Error('artifact durability unavailable');
  const artifacts = new InMemoryArtifactRepository();
  artifacts.storeProtected = async () => {
    throw failure;
  };
  const records = new AgentRunRecords(artifacts);
  const previous = initialState();
  await assert.rejects(
    createAgentRunStateTransition(
      previous,
      { ...previous, revision: 1, toolBatches: [readyBatch(0)] },
      records
    ),
    (error) => error.cause === failure
  );
  assert.deepEqual(previous.toolBatches, []);
});
