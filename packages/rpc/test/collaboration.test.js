import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationRpcMethods } from '@agent-core/rpc';

function fixture() {
  const calls = [];
  const methods = collaborationRpcMethods({
    readCollaboration: async () => ({ groupId: 'group', participants: [] }),
    readParticipant: async participantId => ({ participantId }),
    sendParticipantInput: async input => { calls.push(['send', input]); return { kind: 'steered', runId: input.expectedRunId, submissionId: 'input', completion: Promise.resolve({}) }; },
    continueParticipant: async input => { calls.push(['continue', input]); return { phase: 'running' }; },
    interruptParticipant: async input => { calls.push(['interrupt', input]); return true; },
    cancelParticipant: async input => { calls.push(['cancel', input]); return true; },
    waitForParticipants: async input => { calls.push(['wait', input]); return { reason: 'timeout', participants: [] }; }
  });
  return { methods, calls };
}

const target = { participantId: 'participant', sessionId: 'session', expectedRunId: 'run', expectedEpoch: 2 };
test('collaboration RPC preserves user text and explicit participant/session/run/epoch targeting', async () => {
  const { methods, calls } = fixture();
  const input = { ...target, task: '  User correction\n' };
  const receipt = await methods['collaboration.send'].invoke(input);
  assert.deepEqual(receipt, { kind: 'steered', runId: 'run', submissionId: 'input' });
  assert.deepEqual(calls, [['send', input]]);
  assert.equal('completion' in receipt, false);
  for (const field of Object.keys(target)) {
    const missing = { ...input };
    delete missing[field];
    await assert.rejects(methods['collaboration.send'].invoke(missing), error => error.code === -32602);
  }
  await assert.rejects(methods['collaboration.send'].invoke({ ...input, capabilities: { toolNames: ['shell'] } }), error => error.code === -32602);
  await assert.rejects(methods['collaboration.send'].invoke({ ...input, task: '  ' }), error => error.code === -32602);
  assert.equal(calls.length, 1);
});

test('collaboration controls require explicit targets and bounded waits without exposing grant assignment', async () => {
  const { methods, calls } = fixture();
  const control = { operationId: 'control', participantId: 'participant', expectedSessionId: 'session', expectedRunId: 'run', expectedEpoch: 2, reason: 'Stop this run' };
  await methods['collaboration.interrupt'].invoke(control);
  await methods['collaboration.cancel'].invoke({ ...control, cascade: false });
  await methods['collaboration.continue'].invoke({ ...target, operationId: 'continuation', task: 'Next work' });
  await methods['collaboration.wait'].invoke({ participantIds: ['participant'], timeoutMs: 0 });
  assert.deepEqual(calls.map(call => call[0]), ['interrupt', 'cancel', 'continue', 'wait']);
  for (const invalid of [{ participantIds: [], timeoutMs: 0 }, { participantIds: ['participant'], timeoutMs: 300_001 }])
    await assert.rejects(methods['collaboration.wait'].invoke(invalid), error => error.code === -32602);
  await assert.rejects(methods['collaboration.cancel'].invoke(control), error => error.code === -32602);
  await assert.rejects(methods['collaboration.interrupt'].invoke({ ...control, expectedRunId: undefined }), error => error.code === -32602);
  assert.equal(methods['collaboration.start'], undefined);
});
