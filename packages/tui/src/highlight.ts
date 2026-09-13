import type { TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-typescript.js';

export interface CodeToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly style: TerminalStyle;
}

export function highlightCode(value: string, language: string | null): readonly CodeToken[] {
  const grammar = language === null ? undefined : Prism.languages[language];
  const tokens = grammar === undefined ? [value] : Prism.tokenize(value, grammar);
  const result: CodeToken[] = [];
  let offset = 0;
  const visit = (token: string | Prism.Token, style: TerminalStyle): void => {
    if (typeof token === 'string') {
      result.push({ text: token, start: offset, end: offset + token.length, style });
      offset += token.length;
      return;
    }
    const content = Array.isArray(token.content) ? token.content : [token.content];
    for (const child of content) visit(child, { ...style, ...tokenStyle(token.type) });
  };
  for (const token of tokens) visit(token, {});
  return result;
}

function tokenStyle(type: string): TerminalStyle {
  switch (type) {
    case 'comment':
      return { dim: true, italic: true };
    case 'keyword':
    case 'boolean':
      return { bold: true, fg: { kind: 'theme', token: 'accent.primary' } };
    case 'string':
    case 'char':
      return { fg: { kind: 'theme', token: 'status.success' } };
    case 'number':
      return { fg: { kind: 'theme', token: 'status.info' } };
    case 'function':
    case 'class-name':
      return { fg: { kind: 'theme', token: 'text.strong' } };
    default:
      return {};
  }
}
