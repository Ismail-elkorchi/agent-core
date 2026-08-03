export type TextLineEndings = 'lf' | 'crlf' | 'mixed' | 'none';

export interface LogicalText {
  lines: string[];
  lineEndings: TextLineEndings;
  eol: '\n' | '\r\n';
  hasFinalNewline: boolean;
}

export function splitLogicalLines(content: string): LogicalText {
  const normalized = normalizeNewlines(content);
  const hasFinalNewline = content.endsWith('\n') || content.endsWith('\r');
  const lines = normalized.length === 0 ? [] : normalized.split('\n');
  if (hasFinalNewline && lines.at(-1) === '') {
    lines.pop();
  }
  const lineEndings = detectLineEndings(content);
  return {
    lines,
    lineEndings,
    eol: preferredEol(lineEndings, content),
    hasFinalNewline
  };
}

export function joinLogicalLines(lines: readonly string[], shape: Pick<LogicalText, 'eol' | 'hasFinalNewline'>): string {
  const joined = lines.join('\n');
  const withFinalNewline = shape.hasFinalNewline && lines.length > 0 ? `${joined}\n` : joined;
  return shape.eol === '\r\n' ? withFinalNewline.replaceAll('\n', '\r\n') : withFinalNewline;
}

export function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function detectLineEndings(content: string): TextLineEndings {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const bareLf = content.match(/(?<!\r)\n/g)?.length ?? 0;
  const bareCr = content.match(/\r(?!\n)/g)?.length ?? 0;
  const kinds = [crlf > 0, bareLf > 0, bareCr > 0].filter(Boolean).length;
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  if (crlf > 0) return 'crlf';
  return 'lf';
}

function preferredEol(lineEndings: TextLineEndings, content: string): '\n' | '\r\n' {
  if (lineEndings === 'crlf') return '\r\n';
  if (lineEndings !== 'mixed') return '\n';
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const bareLf = content.match(/(?<!\r)\n/g)?.length ?? 0;
  return crlf > bareLf ? '\r\n' : '\n';
}
