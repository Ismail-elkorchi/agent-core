import { textDocumentText, wrapTextCells, type TextDocument } from '@ismail-elkorchi/terminal-ui/text';

export function composerRows(document: TextDocument, columns: number, viewportRows: number): number {
  const lines = wrapTextCells(textDocumentText(document), Math.max(1, columns - 2), {
    preserveWords: true
  }).length;
  return Math.min(Math.max(2, lines), Math.max(2, Math.floor(viewportRows / 3)));
}
