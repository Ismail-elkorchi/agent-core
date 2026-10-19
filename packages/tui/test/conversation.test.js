import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCall } from '@agent-core/tools';
import { projectProgress, projectToolDiagnostics, projectSessionEntry, mergeConversationEntries } from '@agent-core/tui';

const turn = { turnId: 'turn', turnIndex: 1, requestAttempt: 1 };
test('reasoning channels, assistant text and concurrent tools retain causal identities', () => {
  let entries = [];
  const append = (event) => {
    entries = mergeConversationEntries(entries, projectProgress({ runId: 'run', event }, entries));
  };
  append({
    ...turn,
    type: 'assistant.reasoning',
    channel: 'reasoning',
    accumulated: 'Consider alternatives.'
  });
  append({ ...turn, type: 'assistant.delta', accumulated: 'I will inspect both inputs.' });
  for (const [callIndex, callId] of ['a', 'b'].entries())
    append({
      ...turn,
      callId,
      callIndex,
      toolBatchId: 'batch',
      type: 'tool.call.received',
      toolCall: createToolCall({
        id: callId,
        name: 'inspect',
        input: { kind: 'json', value: { path: callId } }
      })
    });
  append({
    ...turn,
    type: 'assistant.reasoning',
    channel: 'summary',
    accumulated: 'Comparing observations.'
  });
  append({ ...turn, type: 'assistant.ended', content: 'The observations agree.' });
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['reasoning', 'assistant', 'activity', 'activity', 'reasoning']
  );
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 5);
  assert.equal(entries[1].status, 'complete');
  append({ ...turn, type: 'assistant.delta', accumulated: 'stale partial' });
  assert.equal(entries[1].text, 'The observations agree.');
});

test('recorded reasoning and interrupted prose remain inspectable without placeholder messages', () => {
  const entries = projectSessionEntry({
    ...turn,
    id: 'entry',
    type: 'assistant',
    runId: 'run',
    content: 'Partial answer',
    reasoning: 'Full reasoning',
    reasoningSummary: 'Summary',
    completeness: 'partial'
  });
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['Full reasoning', 'Summary', 'Partial answer']
  );
  assert.equal(entries.at(-1).status, 'interrupted');
  assert.deepEqual(
    projectSessionEntry({ ...turn, type: 'assistant', id: 'empty', runId: 'run', content: '' }),
    []
  );
});

test('reused provider call IDs remain separate calls and streamed output settles without duplicated details', () => {
  let entries = [];
  const emit = (event) => {
    entries = mergeConversationEntries(entries, projectProgress({ runId: 'run', event }, entries));
  };
  const call = createToolCall({
    id: 'same',
    name: 'observe',
    input: { kind: 'json', value: { target: 'input' } }
  });
  const identity = { ...turn, toolBatchId: 'batch', callIndex: 0, callId: 'same' };
  emit({ ...identity, type: 'tool.call.received', toolCall: call });
  emit({
    ...identity,
    type: 'tool.updated',
    toolName: 'observe',
    progress: { type: 'output', stream: 'stdout', text: 'first\n' }
  });
  emit({
    ...identity,
    type: 'tool.updated',
    toolName: 'observe',
    progress: { type: 'output', stream: 'stdout', text: 'second\n' }
  });
  assert.match(
    entries[0].details.find((detail) => detail.id === 'live:stdout').content,
    /first\nsecond\n/
  );
  const ended = {
    ...identity,
    type: 'tool.ended',
    toolName: 'observe',
    observation: { kind: 'result', ok: true, summary: 'Observed', output: 'first\nsecond\n' }
  };
  emit(ended);
  emit(ended);
  assert.deepEqual(
    entries[0].details.map((detail) => detail.id),
    ['input', 'output']
  );
  emit({ ...identity, turnId: 'later', type: 'tool.call.received', toolCall: call });
  assert.equal(entries.length, 2);
});

test('live output previews are bounded and presentation cannot hide execution uncertainty', async () => {
  const { updatedToolActivity, completedToolActivity, completedSessionToolActivity } =
    await import('@agent-core/tui');
  let activity;
  for (let i = 0; i < 100; i++)
    activity = updatedToolActivity(activity, 'tool', 'stream', {
      type: 'output',
      stream: 'stdout',
      text: '文😀'.repeat(1000)
    });
  assert.ok(activity.details[0].content.length <= 32768);
  assert.match(activity.details[0].content, /Earlier live preview omitted/);
  const observation = {
    kind: 'result',
    execution: { state: 'unknown' },
    output: {},
    summary: 'No confirmed outcome',
    scope: { resources: [], coverage: 'partial' }
  };
  const rendered = completedToolActivity(undefined, 'tool', 'stream', observation, () => ({
    status: 'complete'
  }));
  assert.equal(rendered.status, 'warning');
  const stored = completedSessionToolActivity(
    undefined,
    {
      id: 'source',
      runId: 'run',
      turnId: 'turn',
      toolName: 'stream',
      kind: 'result',
      summary: 'Result',
      originalUnavailable: { message: 'Storage unavailable', bytes: 100, digest: 'a'.repeat(64) }
    },
    () => ({ status: 'complete', summary: 'Looks complete' })
  );
  assert.equal(stored.status, 'warning');
  assert.match(stored.summary, /Original observation unavailable/);
});


test('restored uncertain tool diagnostics replace running presentation without claiming settlement', () => {
  const diagnostic = { ...turn, runId: 'run', toolBatchId: 'batch', callIndex: 0,
    toolAttempt: 1, toolName: 'stop_process',
    observation: { kind: 'failure', execution: { state: 'unknown' }, summary: 'Stop response interrupted.' } };
  const running = { id: 'tool:run:turn:batch:0', kind: 'activity', activity: 'tool',
    label: 'Stop owned process', status: 'running' };
  const [activity] = projectToolDiagnostics([diagnostic], [running]);
  assert.equal(activity.status, 'failed');
  assert.equal(activity.summary, diagnostic.observation.summary);
  assert.match(activity.details[0].content, /external execution unknown/);
});

test('human output rendering retains the call and authoritative execution details', async () => {
  const { completedToolActivity } = await import('@agent-core/tui');
  const activity = completedToolActivity({ label: 'Apply change', details: [
    { id: 'input', content: '+new\n-old', format: 'diff' }, { id: 'effects', content: 'Write authorized file' }
  ] }, 'call', 'edit', {
    kind: 'result', summary: 'Applied', output: {},
    execution: { state: 'settled' }, scope: { resources: ['file'], coverage: 'complete' }
  }, () => ({ details: [{ id: 'output', content: 'Edited file · +1 −1' }] }));
  assert.equal(activity.details.find((item) => item.id === 'input').format, 'diff');
  assert.match(activity.details.find((item) => item.id === 'effects').content, /authorized/);
  assert.equal(activity.details.find((item) => item.id === 'output').content, 'Edited file · +1 −1');
});

test('tool presentation bounds previews without modifying original input or losing diagnostic evidence', async () => {
  const { pendingToolActivity, completedToolActivity } = await import('@agent-core/tui');
  const patch = '+😀'.repeat(20000);
  const call = createToolCall({ id: 'patch', name: 'apply_patch', input: { kind: 'text', value: patch }, type: 'custom' });
  const pending = pendingToolActivity('call', call, { label: 'Apply patch', details: [{ id: 'input', format: 'diff', content: patch }] });
  assert.ok(pending.details[0].content.length <= 32768);
  assert.match(pending.details[0].content, /Preview shortened/);
  assert.equal(pending.details[0].content.isWellFormed(), true);
  assert.equal(call.input.value, patch);
  const completed = completedToolActivity(pending, 'call', 'apply_patch', {
    kind: 'result', summary: 'Recorded', output: { status: 'applied' }
  }, () => { throw new Error('display failed'); });
  assert.equal(completed.details.find(item => item.id === 'input').content, pending.details[0].content);
  assert.match(completed.details.find(item => item.id === 'output').content, /applied/);
  assert.match(completed.details.find(item => item.id === 'presentation-diagnostic').content, /display failed/);
});

test('peer contributions retain model authorship and exact sender attribution apart from user steering', () => {
  const contribution = projectSessionEntry({
    type: 'peer_contribution', id: 'peer-entry', authorship: 'model',
    contribution: { sender: { participantId: 'reviewer', sessionId: 'review-session' }, senderRunId: 'review-run', content: 'Check the error handling.' }
  });
  assert.deepEqual(contribution, [{
    id: 'session:peer-entry', kind: 'peer', participantId: 'reviewer', sessionId: 'review-session', senderRunId: 'review-run', text: 'Check the error handling.'
  }]);
  const steering = projectSessionEntry({ type: 'steering', id: 'user-entry', runId: 'run', content: 'Change the requirement.' });
  assert.equal(steering[0].kind, 'user');
  assert.notEqual(contribution[0].kind, steering[0].kind);
});

test('delegated assignments remain model-authored when a participant session is inspected', () => {
  const origin = { kind: 'delegated_assignment', groupId: 'group', participantId: 'worker',
    assignmentId: 'assignment', assignmentRevision: 2, sender: { sessionId: 'supervisor' } };
  const [entry] = projectSessionEntry({ type: 'input', id: 'input', runId: 'child-run', task: 'Review this change.',
    originalInput: { task: 'Review this change.', origin } });
  assert.equal(entry.kind, 'assignment');
  assert.deepEqual(entry.origin, origin);
  assert.equal(entry.text, 'Review this change.');
  const [live] = projectProgress({ runId: 'child-run', event: { ...turn, type: 'turn.started',
    origin, task: 'Review this change.' } }, []);
  assert.equal(live.kind, 'assignment');
  assert.deepEqual(live.origin, origin);
});
