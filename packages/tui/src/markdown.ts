import type { InlineContent, InlineTextSegment } from '@ismail-elkorchi/terminal-ui/components';
import type { TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import {
  createMarkdownDocumentSession,
  extractMarkdownOutline,
  MarkdownBudgetExceededError,
  markdownCodeValueSourceSpan,
  type MarkdownBlockNode,
  type MarkdownCodeBlockNode,
  type MarkdownDocumentSession,
  type MarkdownInlineNode,
  type MarkdownParseBudgets,
  type MarkdownSessionUpdate,
  type SourceSpan
} from 'markspan';
import { highlightCode } from './highlight.js';

export interface MarkdownSegment extends InlineTextSegment {
  /** Exact enclosing source range; generated labels and separators have no source. */
  readonly source?: SourceSpan;
}

export interface MarkdownPresentation {
  readonly segments: readonly MarkdownSegment[];
  readonly text: string;
  readonly failure?: string;
}

/** One parser identity namespace and one retained layout per displayed document. */
export class MarkdownDocument {
  private session: MarkdownDocumentSession | undefined;
  private failure: string | undefined;
  private presentation: { readonly width: number; readonly value: MarkdownPresentation } | undefined;
  private sourceText = '';

  constructor(
    source: string,
    private readonly budgets?: MarkdownParseBudgets
  ) {
    this.replace(source);
  }

  get source(): string {
    return this.sourceText;
  }

  replace(source: string): MarkdownSessionUpdate | undefined {
    if (source === this.sourceText && this.session !== undefined) return;
    this.sourceText = source;
    this.presentation = undefined;
    try {
      if (this.session !== undefined) return this.session.replaceSource(source);
      this.session = createMarkdownDocumentSession(source, {
        dialect: 'gfm',
        sourceRetention: 'text',
        ...(this.budgets ? { budgets: this.budgets } : {})
      });
      this.failure = undefined;
    } catch (error) {
      if (!(error instanceof MarkdownBudgetExceededError)) throw error;
      this.session = undefined;
      this.failure = error.message;
    }
    return undefined;
  }

  outline() {
    return this.session ? extractMarkdownOutline(this.session.snapshot().document.tree) : [];
  }

  render(width: number): MarkdownPresentation {
    if (this.presentation?.width === width) return this.presentation.value;
    const segments = this.session
      ? renderBlocks(this.session.snapshot().document.tree.children, width)
      : [
          segment(`Markdown presentation unavailable: ${this.failure ?? 'unknown parser failure'}\n`, {
            bold: true
          }),
          segment('Open the original source to inspect or copy the complete document.')
        ];
    const value: MarkdownPresentation = {
      segments,
      text: segments.map((part) => part.text).join(''),
      ...(this.failure === undefined ? {} : { failure: this.failure })
    };
    this.presentation = { width, value };
    return value;
  }

  copyOriginal(span: SourceSpan = { start: 0, end: this.sourceText.length }): string {
    return this.sourceText.slice(span.start, span.end);
  }

  copyDisplayed(width: number): string {
    return this.render(width).text;
  }

  codeBlocks(): readonly MarkdownCodeBlockNode[] {
    const result: MarkdownCodeBlockNode[] = [];
    const visit = (nodes: readonly MarkdownBlockNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'codeBlock') result.push(node);
        else if (node.kind === 'list') for (const item of node.items) visit(item.children);
        else if ('children' in node && node.kind !== 'heading' && node.kind !== 'paragraph')
          visit(node.children);
      }
    };
    if (this.session) visit(this.session.snapshot().document.tree.children);
    return result;
  }
}

function segment(text: string, style: TerminalStyle = {}, source?: SourceSpan): MarkdownSegment {
  return { kind: 'text', text, style, ...(source === undefined ? {} : { source }) };
}

function renderBlocks(nodes: readonly MarkdownBlockNode[], width: number): MarkdownSegment[] {
  return nodes.flatMap((node) => [...renderBlock(node, width), segment('\n')]);
}

function renderBlock(node: MarkdownBlockNode, width: number): MarkdownSegment[] {
  switch (node.kind) {
    case 'paragraph':
      return inline(node.children);
    case 'heading':
      return inline(node.children, { bold: true, fg: { kind: 'theme', token: 'text.strong' } });
    case 'blockQuote':
      return prefixLines(renderBlocks(node.children, Math.max(1, width - 2)), '│ ');
    case 'list':
      return node.items.flatMap((item, index) => {
        const marker = item.task
          ? item.task.checked
            ? '[x] '
            : '[ ] '
          : node.ordered
            ? `${String((node.start ?? 1) + index)}. `
            : '• ';
        return prefixLines(
          renderBlocks(item.children, Math.max(1, width - marker.length)),
          marker,
          ' '.repeat(marker.length)
        );
      });
    case 'codeBlock':
      return [
        segment(`${node.language ?? 'code'}\n`, { dim: true }),
        ...highlightCode(node.value, node.language).map((token) =>
          segment(token.text, token.style, markdownCodeValueSourceSpan(node, token.start, token.end))
        )
      ];
    case 'thematicBreak':
      return [segment('─'.repeat(Math.max(1, Math.min(width, 40))), { dim: true })];
    case 'htmlBlock':
      return [segment('HTML (literal)\n', { dim: true }), segment(node.value, {}, node.span)];
    case 'linkDefinition':
      return [];
    case 'footnoteDefinition':
      return [segment(`[${node.label}] `, { dim: true }), ...renderBlocks(node.children, width)];
    case 'table': {
      const rows = [node.header, ...node.rows];
      // At small widths, labeled fields keep each cell readable without horizontal clipping.
      if (width < node.align.length * 16)
        return node.rows.flatMap((row) =>
          row.cells.flatMap((cell, index) => [
            ...inline(node.header.cells[index]?.children ?? [], { bold: true }),
            segment(': '),
            ...inline(cell.children),
            segment('\n')
          ])
        );
      return rows.flatMap((row, index) => [
        ...row.cells.flatMap((cell, column) => [
          ...(column === 0 ? [] : [segment(' │ ', { dim: true })]),
          ...inline(cell.children, index === 0 ? { bold: true } : {})
        ]),
        segment('\n')
      ]);
    }
    case 'callout':
      return [segment(`${node.calloutKind}\n`, { bold: true }), ...renderBlocks(node.children, width)];
    case 'frontMatter':
      return [segment(node.raw, { dim: true }, node.span)];
    case 'mathBlock':
      return [segment(node.value, {}, node.contentSpan)];
  }
}

function inline(nodes: readonly MarkdownInlineNode[], style: TerminalStyle = {}): MarkdownSegment[] {
  return nodes.flatMap((node): MarkdownSegment[] => {
    switch (node.kind) {
      case 'text':
      case 'escape':
      case 'characterReference':
        return [segment(node.value, style, node.span)];
      case 'softBreak':
        return [segment(' ', style, node.span)];
      case 'hardBreak':
        return [segment('\n', style, node.span)];
      case 'emphasis':
        return inline(node.children, { ...style, italic: true });
      case 'strong':
        return inline(node.children, { ...style, bold: true });
      case 'strikethrough':
        return inline(node.children, { ...style, strikethrough: true });
      case 'codeSpan':
        return [
          segment(
            node.value,
            { ...style, fg: { kind: 'theme', token: 'accent.primary' } },
            node.contentSpan
          )
        ];
      case 'mathInline':
        return [segment(node.value, style, node.contentSpan)];
      case 'htmlInline':
        return [segment(node.value, { ...style, dim: true }, node.span)];
      case 'footnoteReference':
        return [segment(`[${node.label}]`, style, node.span)];
      case 'image':
        return [
          segment('Image: ', { dim: true }),
          ...inline(node.children, style),
          segment(` (${node.destination})`, { dim: true })
        ];
      case 'link': {
        const children = inline(node.children, { ...style, underline: true });
        const url = URL.parse(node.destination);
        const allowed = url !== null && ['https:', 'http:', 'mailto:'].includes(url.protocol);
        return children.map((child) => (allowed ? { ...child, link: { href: node.destination } } : child));
      }
    }
  });
}

function prefixLines(
  parts: readonly MarkdownSegment[],
  first: string,
  subsequent = first
): MarkdownSegment[] {
  const output: MarkdownSegment[] = [];
  let prefix: string | undefined = first;
  for (const part of parts) {
    const lines = part.text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (index > 0) {
        output.push(segment('\n'));
        prefix = subsequent;
      }
      if (line.length === 0) continue;
      if (prefix !== undefined) {
        output.push(segment(prefix, { dim: true }));
        prefix = undefined;
      }
      output.push({ ...part, text: line });
    }
  }
  return output;
}

export function markdownInlineContent(document: MarkdownDocument, width: number): InlineContent {
  return document.render(width).segments;
}
