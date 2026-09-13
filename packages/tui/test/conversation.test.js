import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCall } from '@agent-core/tools';
import { projectProgress, projectSessionEntry, mergeConversationEntries } from '@agent-core/tui';

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
  assert.match(entries[0].details.find((detail) => detail.id === 'live:stdout').content, /first\nsecond\n/);
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
