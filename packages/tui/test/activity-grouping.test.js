import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedToolActivity,
  ConversationGroupingPresentation,
  conversationDisplayKey,
  RetainedListPresentation,
  conversationDisplayEntryView,
  MarkdownDocument,
  mergeConversationEntries,
  projectConversationDisplay,
  projectProgress,
  projectSessionEntry
} from '@agent-core/tui';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { text } from '@ismail-elkorchi/terminal-ui/components';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';

const classify = (entry) => ({ read_files: 'read', search_text: 'search' })[entry.toolName];
const project = (entries, preserveIds = []) => projectConversationDisplay(entries, { classify, preserveIds });
const activity = (id, toolName = 'read_files', status = 'complete', runId = 'run') => ({
  id, kind: 'activity', activity: 'tool', toolName, runId, status,
  label: `${toolName} ${id}`, summary: `Observed ${id}`,
  details: [{ id: 'output', content: `Exact output ${id}\n  original spacing` }]
});

test('display grouping retains exact source entries and counts calls, not guessed files or outcomes', () => {
  const entries = [activity('a'), activity('b', 'search_text'), activity('c')];
  const before = JSON.stringify(entries);
  const [group] = project(entries);
  assert.equal(group.kind, 'activity-group');
  assert.equal(group.id, 'activity-group:a');
  assert.equal(group.toggleId, 'activity-group:a');
  assert.equal(group.summary, '2 read calls · 1 search call');
  assert.deepEqual(group.members, entries);
  group.members.forEach((member, index) => assert.equal(member, entries[index]));
  assert.equal(JSON.stringify(entries), before);
  assert.deepEqual(project(JSON.parse(before)), project(entries));
});

test('active, failed, warning, unknown tools and intervening messages always remain independent', () => {
  for (const barrier of [
    activity('active', 'read_files', 'running'),
    activity('failure', 'read_files', 'failed'),
    activity('warning', 'read_files', 'warning'),
    activity('write', 'apply_patch'),
    { ...activity('unidentified'), toolName: undefined, label: 'read_files' },
    { id: 'approval', kind: 'notice', tone: 'warning', text: 'Approval required' },
    { id: 'message', kind: 'assistant', text: 'Next action', turnId: 'turn', status: 'complete' }
  ]) {
    const entries = [activity('before'), barrier, activity('after')];
    assert.deepEqual(project(entries), entries);
  }
  assert.equal(project([activity('first'), activity('second', 'read_files', 'complete', 'next-run')]).length, 2);
});

test('preserved focused or expanded members retain their own stable viewport identities', () => {
  const entries = [activity('a'), activity('b'), activity('c'), activity('d')];
  const display = project(entries, ['b']);
  assert.equal(display[0], entries[0]);
  assert.equal(display[1], entries[1]);
  assert.equal(display[2].id, 'activity-group:c');
  assert.deepEqual(display[2].members, entries.slice(2));
  const initial = project(entries.slice(0, 2))[0];
  const extended = project(entries)[0];
  assert.equal(initial.id, extended.id);
  assert.equal(initial.toggleId, extended.toggleId);
});

test('asynchronous completion preserves recorded call positions and exposes late failures', () => {
  const entries = [activity('a', 'read_files', 'running'), activity('b', 'read_files', 'running')];
  const secondComplete = mergeConversationEntries(entries, [activity('b')]);
  assert.deepEqual(project(secondComplete).map((entry) => entry.id), ['a', 'b']);
  const bothComplete = mergeConversationEntries(secondComplete, [activity('a')]);
  assert.deepEqual(project(bothComplete)[0].members.map((entry) => entry.id), ['a', 'b']);
  const lateFailure = mergeConversationEntries(bothComplete, [activity('b', 'read_files', 'failed')]);
  assert.deepEqual(project(lateFailure).map((entry) => [entry.id, entry.status]), [['a', 'complete'], ['b', 'failed']]);
});

test('live and recorded projection retain canonical tool identity independently of rendered labels', () => {
  const events = [0, 1].map((callIndex) => ({
    type: 'tool.ended', toolName: 'read_files', turnId: 'turn', toolBatchId: 'batch',
    callIndex, callId: `call-${callIndex}`,
    observation: { kind: 'result', summary: 'Read finished.', output: { text: `file-${callIndex}` } }
  }));
  const live = events.flatMap((event) => projectProgress({ runId: 'run', event }, []));
  const recorded = events.flatMap((event) => projectSessionEntry({
    type: 'observation', id: `observation-${event.callIndex}`, runId: 'run',
    turnId: event.turnId, toolBatchId: event.toolBatchId, callIndex: event.callIndex,
    toolName: event.toolName, ...event.observation
  }));
  assert.deepEqual(project(live), project(recorded));
  assert.equal(live[0].toolName, 'read_files');
  const uncertain = completedToolActivity(undefined, 'uncertain', 'read_files', {
    kind: 'result', output: {}, summary: 'Unknown result', execution: { state: 'unknown' }
  });
  assert.equal(uncertain.status, 'warning');
  assert.equal(project([live[0], uncertain]).length, 2);
});

test('group disclosure shows exact evidence and uses a separate toggle identity', async (t) => {
  const [group] = project([activity('a'), activity('b')]);
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 30 } });
  const runtime = createTuiRuntime({ host, app: defineTui({
    id: 'activity-group-test',
    init: () => ({ state: { expanded: false, expandedIds: [] } }),
    update: (state, message) => {
      return message.id === group.toggleId
        ? { state: { ...state, expanded: !state.expanded } }
        : { state: { ...state, expandedIds: [...state.expandedIds, message.id] } };
    },
    view: (state) => conversationDisplayEntryView(group, {
      width: 100, expanded: state.expanded, expandedIds: state.expandedIds,
      markdown: (_id, source) => new MarkdownDocument(source),
      onToggle: (id) => ({ type: 'toggle', id }),
      onInspect: () => ({ type: 'inspect' })
    })
  }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  assert.match(renderFramePlain(runtime.frame()), /2 read calls/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Exact output/);
  await runtime.dispatch({ type: 'toggle', id: group.toggleId });
  assert.match(renderFramePlain(runtime.frame()), /read_files a/);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /Exact output/);
  await runtime.dispatch({ type: 'toggle', id: 'activity-member:a' });
  const frame = renderFramePlain(runtime.frame());
  assert.match(frame, /Exact output a/);
  assert.doesNotMatch(frame, /Exact output b/);
  assert.match(frame, /original spacing/);
});


test('retained group cache reuses unchanged members and releases groups outside the current projection', () => {
  const presentation = new ConversationGroupingPresentation();
  const entries = [activity('a'), activity('b')];
  const initial = presentation.project(entries, { classify });
  assert.equal(presentation.project([...entries], { classify })[0], initial[0]);
  const changed = presentation.project([entries[0], { ...entries[1], summary: 'Updated evidence' }], { classify });
  assert.notEqual(changed[0], initial[0]);
  const last = presentation.project(entries, { classify });
  presentation.project([], { classify });
  assert.notEqual(presentation.project(entries, { classify })[0], last[0]);
  presentation.project(entries, { classify, preserveIds: ['a'] });
  assert.notEqual(presentation.project(entries, { classify })[0], last[0]);
});


test('nested member toggles invalidate their retained group only', () => {
  const grouping = new ConversationGroupingPresentation();
  const retained = new RetainedListPresentation();
  const entries = [activity('a'), activity('b'), { id: 'notice', kind: 'notice', tone: 'info', text: 'Boundary' }, activity('c'), activity('d')];
  const renderCounts = new Map();
  const render = (expandedIds) => retained.render(grouping.project(entries, { classify }), ['a', 'c'],
    (entry) => conversationDisplayKey(entry, 100, expandedIds),
    (entry) => {
      renderCounts.set(entry.id, (renderCounts.get(entry.id) ?? 0) + 1);
      return text({ id: entry.id, content: entry.id });
    });
  render([]);
  render([]);
  assert.deepEqual([...renderCounts.values()], [1, 1, 1]);
  render(['activity-member:b']);
  assert.equal(renderCounts.get('activity-group:a'), 2);
  assert.equal(renderCounts.get('activity-group:c'), 1);
  assert.equal(renderCounts.get('notice'), 1);
  render([]);
  assert.equal(renderCounts.get('activity-group:a'), 3);
  assert.equal(renderCounts.get('activity-group:c'), 1);
});


test('expanding a large-output group renders call summaries without exposing every retained output', async (t) => {
  const entries = Array.from({ length: 40 }, (_, index) => ({ ...activity(`large-${index}`), details: [{ id: 'output', content: 'PRIVATE_EXPANDED_DETAIL'.repeat(1400) }] }));
  const [group] = project(entries);
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 60 } }), app: defineTui({
    id: 'large-group-test', init: () => ({ state: {} }), update: (state) => ({ state }),
    view: () => conversationDisplayEntryView(group, {
      width: 100, expanded: true, expandedIds: [],
      markdown: (_id, source) => new MarkdownDocument(source),
      onToggle: (id) => ({ type: 'toggle', id }), onInspect: () => ({ type: 'inspect' })
    })
  }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  const frame = renderFramePlain(runtime.frame());
  assert.match(frame, /40 read calls/);
  assert.doesNotMatch(frame, /PRIVATE_EXPANDED_DETAIL/);
  assert(frame.length < 4000);
  assert.equal(group.members[0].details[0].content.length, 'PRIVATE_EXPANDED_DETAIL'.length * 1400);
});


test('group anchors remain synthetic and keep their start boundary when earlier history arrives', () => {
  const entries = ['a', 'b', 'c', 'd'].map((id) => activity(id));
  const [group] = project(entries.slice(2));
  assert.equal(group.id, 'activity-group:c');
  const display = project(entries, [group.id]);
  assert.deepEqual(display.map((entry) => entry.id), ['activity-group:a', group.id]);
  assert.deepEqual(display[1].members, group.members);
  assert.equal(project(entries, ['c'])[1], entries[2]);
});
