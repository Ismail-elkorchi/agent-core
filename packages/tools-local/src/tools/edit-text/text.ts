import type { EditTextOutput } from './schema.js';

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
