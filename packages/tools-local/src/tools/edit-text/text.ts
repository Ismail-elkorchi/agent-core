import type { EditTextOutput } from './schema.js';

interface IndexedLine {
  readonly start: number;
  readonly contentEnd: number;
}
export function indexLines(content: string): IndexedLine[] {
  const lines: IndexedLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 0x0a) continue;
    const contentEnd = index > start && content.charCodeAt(index - 1) === 0x0d ? index - 1 : index;
    lines.push({ start, contentEnd });
    start = index + 1;
  }
  lines.push({ start, contentEnd: content.length });
  return lines;
}

export function positionOffset(
  content: string,
  lines: readonly IndexedLine[],
  lineNumber: number,
  column: number
): number {
  const line = lines[lineNumber - 1];
  if (!line) throw new Error(`Line ${String(lineNumber)} is outside the file.`);
  const text = content.slice(line.start, line.contentEnd);
  const scalars = Array.from(text);
  if (column > scalars.length + 1)
    throw new Error(
      `Column ${String(column)} is outside line ${String(lineNumber)}; maximum is ${String(scalars.length + 1)}.`
    );
  let width = 0;
  for (let index = 0; index < column - 1; index += 1) width += scalars[index]?.length ?? 0;
  return line.start + width;
}

export function boundedDiffSummary(
  lines: readonly string[],
  maxBytes: number
): EditTextOutput['diffSummary'] {
  const source = lines.join('\n');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes)
    return {
      text: source,
      bytes: Buffer.byteLength(source, 'utf8'),
      truncated: false,
      totalChangedRanges: lines.length
    };
  let text = '';
  for (const scalar of source) {
    if (Buffer.byteLength(text + scalar, 'utf8') > maxBytes) break;
    text += scalar;
  }
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated: true,
    totalChangedRanges: lines.length
  };
}
