import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationPanel } from '@agent-core/tui';
import { createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';

const participant = { participant: { participantId: 'worker', sessionId: 'worker-session' },
  assignment: { assignmentId: 'assignment', revision: 1, runId: 'worker-run', epoch: 2, task: 'Review', budgetOwnerId: 'owner', budgetScopeId: 'scope' },
  phase: 'running', cancelled: false, results: [] };
const snapshot = { supervisorSessionId: 'root-session', epoch: 2, maxParticipants: 4, maxConcurrentRuns: 2, maxWaitMs: 100, participants: [participant] };
const context = { signal: new AbortController().signal };
function fixture() {
  const calls = [];
  const operations = {
    readCollaboration: async () => snapshot,
    sendParticipantInput: async input => { calls.push(['send', input]); return { kind: 'steered', completion: Promise.resolve({}) }; },
    continueParticipant: async input => { calls.push(['continue', input]); return participant; },
    interruptParticipant: async input => { calls.push(['interrupt', input]); },
    cancelParticipant: async input => { calls.push(['cancel', input]); },
    waitForParticipants: async input => { calls.push(['wait', input]); return { reason: 'settled', participants: [participant] }; }
  };
  const panel = collaborationPanel(operations, 'root-session');
  let state = panel.update(panel.init().state, { type: 'loaded', snapshot }).state;
  state = panel.update(state, { type: 'select', participantId: 'worker' }).state;
  state = { ...state, input: createTextAreaState({ value: '  User steering\n' }) };
  return { panel, state, calls };
}

test('participant panel passes exact selected session/run/epoch and user text to canonical controls', async () => {
  const { panel, state, calls } = fixture();
  const result = panel.update(state, { type: 'control', action: 'send' });
  assert.equal(result.state.pending, true);
  const refreshed = await result.effects[0].run(context);
  assert.deepEqual(calls[0], ['send', { participantId: 'worker', sessionId: 'worker-session', expectedRunId: 'worker-run', expectedEpoch: 2, task: '  User steering\n' }]);
  assert.equal(refreshed.message.type, 'loaded');
  assert.equal(panel.update(result.state, { type: 'control', action: 'send' }).effects, undefined);
});

test('participant panel wait is host-bounded and refresh replaces recorded snapshots after a gap', async () => {
  const { panel, state, calls } = fixture();
  await panel.update(state, { type: 'control', action: 'wait' }).effects[0].run(context);
  assert.equal(calls[0][1].timeoutMs, snapshot.maxWaitMs);
  assert.equal(calls[0][1].signal, context.signal);
  const refreshed = panel.update(state, { type: 'refresh' });
  const loaded = await refreshed.effects[0].run(context);
  assert.equal(panel.update(refreshed.state, loaded.message).state.snapshot, snapshot);
  assert.equal(panel.update(state, { type: 'loaded', snapshot: { ...snapshot, supervisorSessionId: 'other' } }).state, state);
});

test('participant panel rejects stale selected-session hydration', async () => {
  const panel = collaborationPanel({ readCollaboration: async () => snapshot }, 'another-session');
  await assert.rejects(panel.init().effects[0].run(context), /selected session changed/);
});

test('changes delivered during hydration trigger a fresh read instead of being lost', async () => {
  const { panel, state } = fixture();
  const loading = panel.update(state, { type: 'refresh' }).state;
  const changed = panel.update(loading, { type: 'refresh' }).state;
  assert.equal(changed.refreshRequested, true);
  const stale = panel.update(changed, { type: 'loaded', snapshot });
  assert.equal(stale.state.pending, true);
  assert.equal(stale.effects.length, 1);
  const latest = await stale.effects[0].run(context);
  assert.equal(panel.update(stale.state, latest.message).state.pending, false);
});
