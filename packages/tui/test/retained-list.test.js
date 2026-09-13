import assert from 'node:assert/strict';
import test from 'node:test';
import { RetainedListPresentation } from '@agent-core/tui';
import { richText } from '@ismail-elkorchi/terminal-ui/components';
import { measuredViewport } from '@ismail-elkorchi/terminal-ui/layout';
import { renderElementFrame } from '@ismail-elkorchi/terminal-ui/renderer';

test('retained entries reuse elements while layout supplies history navigation', () => {
  const presentation = new RetainedListPresentation();
  const first = { id: 'first', text: 'word '.repeat(20) };
  const last = { id: 'last', text: 'tail '.repeat(30) };
  const renderEntry = (entry) => richText({ id: entry.id, segments: [{ kind: 'text', text: entry.text }], wrap: true });
  const initial = presentation.render([first, last], [], 'plain', renderEntry);
  const repeated = presentation.render([first, last], [], 'plain', renderEntry);
  assert.equal(initial[0], repeated[0]);
  assert.equal(initial[1], repeated[1]);
  renderElementFrame(measuredViewport(repeated, {
    id: 'history', followTail: true, scrollbar: { visible: 'auto' }, onScroll: () => null,
    onLayout: (layout) => { presentation.layout = layout; }
  }), { columns: 12, rows: 4 });
  const anchor = presentation.anchor(presentation.layout.scroll.offsetRow);
  assert.equal(anchor.itemId, 'last');
  assert.deepEqual(presentation.adjacentMessage(anchor, 'previous'), { itemId: 'last', rowWithinItem: 0, viewportRow: 0 });
  const replaced = presentation.render([first, { ...last, text: 'updated' }], [], 'plain', renderEntry);
  assert.equal(replaced[0], initial[0]);
  assert.notEqual(replaced[1], initial[1]);
});
