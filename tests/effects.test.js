import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeExternalEffect,
  decodeEffectExecutionState,
  decodeEffectRecoveryCapability,
  decodeExternalEffectIntent,
  decodeExternalEffectSettlement,
  issueEffectStartTicket,
  encodeEffectExecutionState,
  settleExternalEffect,
  startExternalEffect,
  unknownEffectExposure
} from '@agent-core/effects';

const digest = (character) => character.repeat(64);

function intent(recovery = { kind: 'unknown' }) {
  return decodeExternalEffectIntent({
    effectId: 'effect-1',
    operationId: 'operation-1',
    implementationId: 'tests/effect@1',
    parametersDigest: digest('a'),
    recovery,
    exposure: { quantities: [{ unit: 'tokens', amount: 100 }, { unit: 'usd_micros', amount: 50 }] }
  });
}

function issue(currentDriverGeneration = 3, driverGeneration = 3) {
  return issueEffectStartTicket({
    intent: intent(),
    ticketId: 'ticket-1',
    settlementPermitId: 'permit-1',
    driverGeneration,
    currentDriverGeneration
  });
}

test('effect recovery admission owns exact capability facts and rejects incomplete proof', () => {
  const queryable = decodeEffectRecoveryCapability({
    kind: 'queryable',
    service: 'sandbox',
    reconcilerId: 'sandbox.execution-query.v1',
    externalExecutionId: 'execution-1',
    expiresAt: '2027-01-01T00:00:00.000Z'
  });
  assert.equal(Object.isFrozen(queryable), true);
  assert.equal(queryable.kind, 'queryable');
  assert.throws(() => decodeEffectRecoveryCapability({ kind: 'preconditioned_reexecution', preconditions: [] }), /at least one/iu);
  assert.throws(() => decodeEffectRecoveryCapability({
    kind: 'preconditioned_reexecution',
    preconditions: [
      { resource: 'files/a', validatorId: 'sha256', expectedVersion: digest('b') },
      { resource: 'files/a', validatorId: 'sha256', expectedVersion: digest('c') }
    ]
  }), /unique/iu);
  assert.throws(() => decodeEffectRecoveryCapability({ kind: 'idempotency_key', service: 'provider', key: 'key' }), /timestamp/iu);
});

test('effect tickets are generation-fenced and consumed exactly once', () => {
  assert.deepEqual(issue(4, 3), { status: 'rejected', reason: 'stale_driver' });
  const issued = issue();
  assert.equal(issued.status, 'issued');
  const staleStart = startExternalEffect(issued.state, issued.state.ticket, 4);
  assert.deepEqual(staleStart, { status: 'rejected', reason: 'stale_driver' });
  const mismatched = startExternalEffect(issued.state, { ...issued.state.ticket, ticketId: 'other' }, 3);
  assert.deepEqual(mismatched, { status: 'rejected', reason: 'ticket_mismatch' });
  const started = startExternalEffect(issued.state, issued.state.ticket, 3);
  assert.equal(started.status, 'started');
  assert.deepEqual(decodeEffectExecutionState(encodeEffectExecutionState(started.state)), started.state);
  assert.deepEqual(startExternalEffect(started.state, issued.state.ticket, 3), { status: 'rejected', reason: 'ticket_consumed' });
  assert.throws(() => decodeEffectExecutionState({ ...encodeEffectExecutionState(started.state), settlementPermit: { ...started.state.settlementPermit, parametersDigest: digest('b') } }), /does not match/iu);
});

test('a settlement permit can settle only its exact outstanding effect', () => {
  const issued = issue();
  const started = startExternalEffect(issued.state, issued.state.ticket, 3);
  assert.equal(started.status, 'started');
  const settlement = decodeExternalEffectSettlement({
    outcome: 'succeeded',
    resultDigest: digest('d'),
    exposure: { status: 'known', quantities: [{ unit: 'tokens', amount: 40 }] }
  });
  assert.deepEqual(settleExternalEffect(started.state, { ...started.state.settlementPermit, effectId: 'other' }, settlement), { status: 'rejected', reason: 'permit_mismatch' });
  const settled = settleExternalEffect(started.state, started.state.settlementPermit, settlement);
  assert.equal(settled.status, 'settled');
  assert.equal(settleExternalEffect(settled.state, started.state.settlementPermit, settlement).status, 'already_settled');
  const conflict = decodeExternalEffectSettlement({ outcome: 'failed', resultDigest: digest('e'), exposure: { status: 'known', quantities: [] } });
  assert.deepEqual(settleExternalEffect(settled.state, started.state.settlementPermit, conflict), { status: 'rejected', reason: 'settlement_conflict' });
});

test('closed effects retain unknown reserved exposure and classify late settlement', () => {
  const issued = issue();
  const started = startExternalEffect(issued.state, issued.state.ticket, 3);
  assert.equal(started.status, 'started');
  const closed = closeExternalEffect(started.state, 'reconciliation_unavailable');
  assert.deepEqual(closed.closure, {
    reason: 'reconciliation_unavailable',
    exposure: { status: 'unknown', reserved: [{ unit: 'tokens', amount: 100 }, { unit: 'usd_micros', amount: 50 }] }
  });
  const settlement = decodeExternalEffectSettlement({ outcome: 'failed', resultDigest: digest('f'), exposure: { status: 'known', quantities: [] } });
  assert.equal(settleExternalEffect(closed, started.state.settlementPermit, settlement).status, 'late');
  assert.deepEqual(unknownEffectExposure(started.state.intent.exposure), closed.closure.exposure);
});

test('unstarted effects can only close before start', () => {
  const issued = issue();
  assert.equal(closeExternalEffect(issued.state, 'cancelled_before_start').closure.reason, 'cancelled_before_start');
  assert.throws(() => closeExternalEffect(issued.state, 'unknown_outcome'), /unstarted/iu);
});
