import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { hashJson, InMemoryEventRepository } from '@agent-core/persistence';
import { issueEffectStartTicket, startExternalEffect, settleExternalEffect } from '@agent-core/effects';
import { createToolCall, parseToolObservation } from '@agent-core/tools';
import { AgentRunCoordinator, agentEventCodec, decodeAgentRunState } from '@agent-core/runtime';

function acceptance(runId) {
  return {
    runId,
    finalizationId: `${runId}:final`,
    input: { task: 'Exercise independently fenced work.', instructions: [], contextItems: [] },
    configuration: {
      providerId: 'scripted',
      providerImplementationId: 'scripted@1',
      model: 'scripted',
      runtimeImplementationId: 'runtime@1',
      toolImplementationIds: ['read@1'],
      policyHash: 'policy'
    }
  };
}

function effect(runId, id, stage = 'started', generation = 1) {
  const issued = issueEffectStartTicket({
    intent: {
      effectId: id,
      ownerId: runId,
      implementationId: 'read@1',
      parametersDigest: hashJson(id),
      recovery: { kind: 'unknown' },
      exposure: { quantities: [] }
    },
    ticketId: `${id}:start`,
    settlementPermitId: `${id}:settle`,
    driverGeneration: generation,
    currentDriverGeneration: generation
  });
  assert.equal(issued.status, 'issued');
  if (stage === 'ticket_issued') return issued.state;
  const started = startExternalEffect(issued.state, issued.state.ticket, generation);
  assert.equal(started.status, 'started');
  return started.state;
}

function batch(
  runId,
  id,
  { stage = 'effect_pending', scope = id, dependencies = [], count = 1, maxConcurrency = 3 } = {}
) {
  const calls = Array.from({ length: count }, (_, index) =>
    createToolCall({
      id: `${id}:call:${index}`,
      name: 'read',
      input: { kind: 'json', value: { index } }
    })
  );
  const entries = [{ name: 'read', implementationId: 'read@1', definitionHash: hashJson('read') }];
  return {
    kind: 'tools',
    identity: { turnIndex: id === 'r1' ? 1 : 2, turnId: `${id}:turn`, requestAttempt: 1 },
    toolBatchId: id,
    calls,
    maxConcurrency,
    instructions: [],
    modelInputModalities: ['text'],
    source: { responseId: id, catalog: { revision: hashJson(entries), entries } },
    modelCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
      type: 'function',
      async: true
    })),
    callStates: calls.map((_, index) => {
      const execution = effect(
        runId,
        `${id}:effect:${index}`,
        stage === 'effect_ready' ? 'ticket_issued' : 'started'
      );
      return {
        stage,
        toolAttempt: 1,
        effect: execution,
        plan: {
          toolImplementationId: 'read@1',
          fingerprint: execution.intent.parametersDigest,
          canonicalInput: { index },
          effects: {
            accesses: [{ mode: 'write', scope }],
            lockScopes: [],
            recovery: { kind: 'unknown' },
            ...(index && dependencies.length ? { dependsOnCallIndices: dependencies } : {})
          },
          binding: {
            toolImplementationId: 'read@1',
            authorizationPolicyId: 'policy',
            executionTargetId: 'memory'
          },
          authorization: 'allow'
        }
      };
    })
  };
}

function provider(runId) {
  return {
    kind: 'provider',
    stage: 'effect_pending',
    identity: { turnIndex: 2, turnId: 'r2:turn', requestAttempt: 1 },
    toolBatchId: 'r2',
    requestEventId: 'request-r2',
    responseId: 'r2',
    effect: effect(runId, 'provider:r2')
  };
}

function observation(id, ok = true) {
  return {
    observationId: `observation:${id}`,
    createdAt: new Date(0).toISOString(),
    observation: parseToolObservation(
      { outputSchema: z.strictObject({ value: z.string() }) },
      {
        kind: 'result',
        ok,
        output: { value: id },
        summary: `Completed ${id}`,
        scope: { resources: ['memory'], coverage: 'complete' }
      }
    )
  };
}

async function fixture(runId, toolBatches, providerRequests = []) {
  const events = new InMemoryEventRepository(agentEventCodec);
  const runs = new AgentRunCoordinator(events);
  await runs.accept(acceptance(runId));
  const initial = await runs.attach(runId, 'original');
  const state = decodeAgentRunState({
    ...initial.state(),
    revision: 2,
    phase: { kind: 'active' },
    toolBatches,
    providerRequests
  });
  await events.appendConditional(
    runId,
    { type: 'run.state.changed', state },
    {
      idempotencyKey: `${runId}:work`,
      expectedTail: await events.tail(runId),
      driverGeneration: 1
    }
  );
  await initial.synchronize();
  return { events, runs, initial };
}

function settle(runs, runId, work, callIndex = 0, ok = true) {
  const state = work.callStates[callIndex];
  return runs.settleToolEffect(runId, {
    effectId: state.effect.intent.effectId,
    permit: state.effect.settlementPermit,
    settlement: observation(`${work.toolBatchId}:${callIndex}`, ok)
  });
}

async function record(driver, work, callIndex = 0) {
  const target = { toolBatchId: work.toolBatchId, callIndex };
  await driver.transitionTool('begin_observation_recording', target, (call) => ({
    ...call,
    stage: 'recording'
  }));
  await driver.transitionTool('record_tool_observation', target, (call) => ({
    ...call,
    stage: 'recorded'
  }));
}

test('an older driver settles A while R2 independently settles, without replacing either source', async () => {
  const runId = 'cross-response-settlement';
  const original = batch(runId, 'r1');
  const later = provider(runId);
  const { runs, initial } = await fixture(runId, [original], [later]);
  const replacement = await runs.attach(runId, 'replacement');
  const responseSettlement = settleExternalEffect(later.effect, later.effect.settlementPermit, {
    outcome: 'succeeded',
    resultDigest: hashJson('r2 response'),
    exposure: { status: 'known', quantities: [] }
  });
  assert.equal(responseSettlement.status, 'settled');
  await Promise.all([
    initial.settleToolEffect({
      effectId: original.callStates[0].effect.intent.effectId,
      permit: original.callStates[0].effect.settlementPermit,
      settlement: observation('r1:0')
    }),
    replacement.transitionProvider(
      'reconcile_provider_request',
      { turnId: 'r2:turn', requestAttempt: 1 },
      (request) => ({
        ...request,
        stage: 'settled',
        effect: responseSettlement.state,
        settlementEventId: 'r2:settled'
      })
    )
  ]);
  const current = await runs.inspect(runId);
  assert.equal(current.state.providerRequests[0].stage, 'settled');
  assert.equal(current.state.toolBatches[0].callStates[0].stage, 'settled');
  assert.deepEqual(current.state.toolBatches[0].source, original.source);
  assert.deepEqual(current.state.toolBatches[0].modelCalls, original.modelCalls);
  assert.equal(current.state.control.driverId, 'replacement');
  await assert.rejects(
    initial.transitionProvider('consume_provider_settlement', later.identity, (request) => ({
      ...request,
      stage: 'consumed'
    })),
    /does not own/u
  );
  await record(replacement, original);
  assert.equal(replacement.state().providerRequests[0].stage, 'settled');
});

test('suspension and cancellation preserve an already-started call and its late permit', async () => {
  for (const phase of [
    { kind: 'suspended', reason: 'tool_outcome_unknown', effectId: 'r1:effect:0' },
    { kind: 'cancelling', stage: 'requested' }
  ]) {
    const runId = `late-${phase.kind}`;
    const original = batch(runId, 'r1');
    const later = provider(runId);
    const { runs, initial } = await fixture(runId, [original], [later]);
    const replacement = await runs.attach(runId, 'replacement');
    await replacement.transition(phase.kind === 'cancelling' ? 'finalize_abort' : 'reconcile_tool_call', {
      phase
    });
    await initial.settleToolEffect({
      effectId: original.callStates[0].effect.intent.effectId,
      permit: original.callStates[0].effect.settlementPermit,
      settlement: observation('r1:0')
    });
    const current = await runs.inspect(runId);
    assert.deepEqual(current.state.phase, phase);
    assert.deepEqual(current.state.providerRequests[0], later);
    assert.equal(current.state.toolBatches[0].callStates[0].stage, 'settled');
    await assert.rejects(
      runs.settleToolEffect(runId, {
        effectId: original.callStates[0].effect.intent.effectId,
        permit: original.callStates[0].effect.settlementPermit,
        settlement: observation('different')
      }),
      /different settlement/u
    );
  }
});

test('global effect conflicts span response groups while independent work may start', async () => {
  const runId = 'global-locks';
  const older = batch(runId, 'r1', { scope: 'shared' });
  const conflicting = batch(runId, 'r2', { stage: 'effect_ready', scope: 'shared' });
  const independent = batch(runId, 'r3', { stage: 'effect_ready', scope: 'independent' });
  const { runs, initial } = await fixture(runId, [older, conflicting, independent]);
  const start = (id) =>
    initial.transitionTool('start_tool_call', { toolBatchId: id, callIndex: 0 }, (call) => {
      const result = startExternalEffect(call.effect, call.effect.ticket, 1);
      assert.equal(result.status, 'started');
      return { ...call, stage: 'effect_pending', effect: result.state };
    });
  await assert.rejects(start('r2'), /blocked/u);
  await start('r3');
  assert.equal(initial.state().toolBatches[2].callStates[0].stage, 'effect_pending');
  await settle(runs, runId, older);
  await start('r2');
  assert.equal(initial.state().toolBatches[1].callStates[0].stage, 'effect_pending');
  await assert.rejects(
    initial.transition('assemble_turn', (state) => ({
      phase: state.phase,
      toolBatches: state.toolBatches.slice(1)
    })),
    /cannot be removed/u
  );
});

test('source dependencies and the concurrency cap remain enforced at the durable start boundary', async () => {
  const runId = 'cross-response-cap';
  const older = batch(runId, 'r1', { scope: 'old', maxConcurrency: 1 });
  const newer = batch(runId, 'r2', {
    stage: 'effect_ready',
    scope: 'new',
    count: 2,
    dependencies: [0],
    maxConcurrency: 1
  });
  const { runs, initial } = await fixture(runId, [older, newer]);
  const start = (callIndex) =>
    initial.transitionTool('start_tool_call', { toolBatchId: 'r2', callIndex }, (call) => ({
      ...call,
      stage: 'effect_pending',
      effect: startExternalEffect(call.effect, call.effect.ticket, 1).state
    }));
  await assert.rejects(start(0), /blocked/u);
  await settle(runs, runId, older);
  await assert.rejects(start(1), /blocked/u);
  await start(0);
  await assert.rejects(start(1), /blocked/u);
  await settle(runs, runId, newer);
  await start(1);
  assert.equal(initial.state().toolBatches[1].callStates[1].stage, 'effect_pending');
});

test('result delivery uncertainty retains the original observation and forbids another send identity', async () => {
  const runId = 'delivery-uncertainty';
  const work = batch(runId, 'r1');
  const { runs, initial } = await fixture(runId, [work]);
  await settle(runs, runId, work);
  await record(initial, work);
  const target = { toolBatchId: 'r1', callIndex: 0 };
  const identity = { deliveryId: 'result:A', inputIdentity: hashJson('result:A'), targetResponseId: 'r2' };
  for (const status of ['admitted', 'submitted', 'uncertain'])
    await initial.recordToolDelivery(target, { ...identity, status });
  const replacement = await runs.attach(runId, 'replacement');
  await assert.rejects(
    replacement.recordToolDelivery(target, {
      ...identity,
      deliveryId: 'result:A:retry',
      status: 'admitted'
    }),
    /redelivered/u
  );
  await assert.rejects(
    replacement.recordToolDelivery(target, { ...identity, status: 'admitted' }),
    /regress/u
  );
  await replacement.recordToolDelivery(target, {
    ...identity,
    status: 'applied',
    successorResponseId: 'r3'
  });
  await assert.rejects(
    replacement.recordToolDelivery(target, {
      ...identity,
      status: 'applied',
      successorResponseId: 'unrelated'
    }),
    /identity cannot change/u
  );
  assert.deepEqual(replacement.state().toolBatches[0].callStates[0].settlement, observation('r1:0'));
  await settle(runs, runId, work);
  assert.equal(
    (await runs.inspect(runId)).state.toolBatches[0].callStates[0].delivery.successorResponseId,
    'r3'
  );
});

test('owning codecs reject rewritten original model calls, duplicate effect authorities and the removed observation barrier', async () => {
  const runId = 'strict-original-binding';
  const work = batch(runId, 'r1');
  const { initial } = await fixture(runId, [work]);
  const state = initial.state();
  assert.throws(
    () => decodeAgentRunState({ ...state, toolBatches: [{ ...work, nextObservationIndex: 0 }] }),
    /Unsupported/u
  );
  assert.throws(
    () =>
      decodeAgentRunState({
        ...state,
        toolBatches: [{ ...work, modelCalls: [{ ...work.modelCalls[0], id: 'rewritten' }] }]
      }),
    /original model call/u
  );
  assert.throws(
    () => decodeAgentRunState({ ...state, toolBatches: [work, { ...work, toolBatchId: 'copy' }] }),
    /Effect identity/u
  );
  await assert.rejects(
    initial.transition('assemble_turn', {
      phase: state.phase,
      toolBatches: [{ ...work, source: { ...work.source, responseId: 'rewritten' } }]
    }),
    /Original tool source/u
  );
});
