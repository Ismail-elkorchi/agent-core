import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import { conversationEntryView, MarkdownDocument, patchSegments } from '@agent-core/tui';

test('shared transcript identifies raw reasoning, summaries, and interrupted answers accurately', async (t) => {
  const entries = [
    { id: 'raw', kind: 'reasoning', channel: 'reasoning', text: 'Original reasoning.' },
    { id: 'summary', kind: 'reasoning', channel: 'summary', text: 'Summary content.' },
    { id: 'answer', kind: 'assistant', status: 'interrupted', text: 'Partial answer.' }
  ];
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } }), app: defineTui({
    id: 'transcript-test',
    init: () => ({ state: {} }), update: (state) => ({ state }),
    view: () => column(entries.map((entry) => conversationEntryView(entry, {
      width: 80, expanded: true, markdown: (_id, source) => new MarkdownDocument(source),
      onToggle: () => ({ type: 'toggle' }), onInspect: () => ({ type: 'inspect' })
    })))
  }) });
  t.after(() => runtime.dispose());
  await runtime.start();
  const frame = renderFramePlain(runtime.frame());
  assert.match(frame, /Reasoning\s*\n.*Original reasoning/);
  assert.match(frame, /Reasoning summary/);
  assert.match(frame, /Assistant · interrupted/);
  const patch = '*** Update File: a.ts\n-old\n+new\n';
  assert.equal(patchSegments(patch).map((item) => item.text).join(''), patch);
});
