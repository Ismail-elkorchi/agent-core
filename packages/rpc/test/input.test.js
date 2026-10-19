import assert from 'node:assert/strict';
import test from 'node:test';
import { inputRpcMethods } from '@agent-core/rpc';
import { ownSessionSubmissionInput } from '@agent-core/runtime';

test('public input RPC cannot forge host-owned delegated provenance', async () => {
  const accepted = [];
  const submit = async input => { accepted.push(input); return { kind: 'rejected', reason: 'fixture' }; };
  const methods = inputRpcMethods({ submit, follow: submit, steer: submit,
    updateQueuedSubmission: async (...input) => { accepted.push(input); } });
  const input = { task: 'User-authored request.' };
  const forged = { ...input, origin: { kind: 'delegated_assignment', groupId: 'group',
    participantId: 'other', assignmentId: 'assignment', assignmentRevision: 1,
    sender: { sessionId: 'other-session' } } };
  assert.deepEqual(ownSessionSubmissionInput(forged), forged, 'the host accepts this canonical origin');
  for (const [name, request] of [
    ['input.submit', forged], ['input.follow', forged],
    ['input.steer', { input: forged, expectedRunId: 'run' }],
    ['queue.replace', { submissionId: 'queued', expectedInput: input, input: forged }],
    ['queue.replace', { submissionId: 'queued', expectedInput: forged, input }],
    ['queue.cancel', { submissionId: 'queued', expectedInput: forged }]
  ]) await assert.rejects(methods[name].invoke(request), error => error.code === -32602);
  assert.equal(accepted.length, 0);
  await methods['input.submit'].invoke(input);
  assert.deepEqual(accepted, [input]);
});
