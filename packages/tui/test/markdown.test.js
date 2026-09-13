import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownDocument, composerRows } from '@agent-core/tui';
import { createTextDocument } from '@ismail-elkorchi/terminal-ui/text';
import { markdownCodeValueSourceSpan } from 'markspan';

const source =
  '# Heading 🧑🏽‍💻\r\n\r\nA **strong** and _soft_ [reference][target].\r\n\r\n- [x] outer\r\n  - nested\r\n\r\n| Name | Value |\r\n| --- | --- |\r\n| 日本語 | ~~old~~ new |\r\n\r\n> quote\r\n\r\n```typescript\r\nconst message = "👩🏽‍💻";\r\n```\r\n\r\n[target]: https://example.com\r\n';

test('streamed GFM rendering converges with a complete parse at every width', () => {
  for (const step of [1, 7, 31]) {
    const streamed = new MarkdownDocument('');
    for (let length = step; length < source.length; length += step) {
      streamed.replace(source.slice(0, length));
      streamed.render(32);
    }
    streamed.replace(source);
    for (const width of [18, 48, 120])
      assert.deepEqual(streamed.render(width), new MarkdownDocument(source).render(width));
    assert.equal(streamed.copyOriginal(), source);
  }
});

test('unchanged presentation is retained; earlier definitions invalidate linked output', () => {
  const document = new MarkdownDocument('[target]: https://example.com/one\n\n[target]\n');
  const before = document.render(80);
  assert.equal(document.render(80), before);
  assert.equal(document.replace(document.source), undefined);
  assert.equal(document.render(80), before);
  document.replace(document.source.replace('/one', '/two'));
  assert(document.render(80).segments.some((segment) => segment.link?.href === 'https://example.com/two'));
  const other = new MarkdownDocument('Unrelated document');
  assert.equal(other.render(80).text.trim(), 'Unrelated document');
});

test('unfinished code, normalized code copying, and original CRLF have distinct faithful coordinates', () => {
  const document = new MarkdownDocument('  ```ts\r\n  const x = 1;\r\n');
  assert.match(document.render(24).text, /const x = 1;/);
  const [code] = document.codeBlocks();
  assert.equal(code.value, 'const x = 1;\n');
  const range = markdownCodeValueSourceSpan(code, 0, 5);
  assert.equal(document.copyOriginal(range), 'const');
  assert.equal(document.copyOriginal(), '  ```ts\r\n  const x = 1;\r\n');
  assert(document.render(24).segments.some((segment) => segment.style.bold && segment.text === 'const'));
});

test('literal HTML, image references, and unsafe links never become active content', () => {
  const document = new MarkdownDocument(
    '<script>alert(1)</script>\n\n![alt](https://example.com/image.png) [unsafe](javascript:alert)'
  );
  const presentation = document.render(50);
  assert.match(presentation.text, /HTML \(literal\)/);
  assert.match(presentation.text, /Image: alt/);
  assert.equal(
    presentation.segments.some((segment) => segment.link),
    false
  );
});

test('resource failure is visible and preserves the complete original source', () => {
  const document = new MarkdownDocument(source, { maxInputCodeUnits: 20 });
  assert.match(document.render(40).failure, /maxInputCodeUnits/);
  assert.equal(document.copyOriginal(), source);
  document.replace('Recovered');
  assert.equal(document.render(40).failure, undefined);
  assert.equal(document.copyDisplayed(40).trim(), 'Recovered');
});

test('composer grows with wrapped content and stays bounded by its viewport', () => {
  assert.equal(composerRows(createTextDocument('short'), 80, 24), 2);
  assert.equal(composerRows(createTextDocument('one\ntwo\nthree\nfour'), 80, 24), 4);
  assert.equal(composerRows(createTextDocument('x'.repeat(2000)), 48, 24), 8);
});
