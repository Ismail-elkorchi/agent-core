import {
  textDocumentText,
  wrapTextCells,
  type TextDocument
} from '@ismail-elkorchi/terminal-ui/text';

export function composerRows(
  document: TextDocument,
  columns: number,
  viewportRows: number
): number {
  const lines = wrapTextCells(textDocumentText(document), Math.max(1, columns - 2), {
    preserveWords: true
  }).length;
  return Math.min(Math.max(2, lines), Math.max(2, Math.floor(viewportRows / 3)));
}

/** Keep suggestions available in compact terminals without covering the input. */
export function suggestionLimit(terminalRows: number): number {
  return Math.max(1, Math.min(5, Math.floor(terminalRows / 3) - 1));
}
