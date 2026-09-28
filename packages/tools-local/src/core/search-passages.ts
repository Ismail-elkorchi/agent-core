import type { SearchTextOutput } from '../tools/search-text/schema.js';

type Match = Extract<SearchTextOutput, { mode: 'matches' }>['results'][number];

/** Merge overlapping context without changing source text or match coordinates. */
export function searchPassages(matches: readonly Match[]): readonly { header: string; text: string }[] {
  const files = new Map<string, Map<number, { text: string; occurrences: Match['occurrences'] }>>();
  for (const match of matches) {
    let lines = files.get(match.path);
    if (!lines) files.set(match.path, lines = new Map<number, { text: string; occurrences: Match['occurrences'] }>());
    for (const line of [...(match.context?.before ?? []), ...(match.context?.after ?? [])])
      if (!lines.has(line.lineNumber)) lines.set(line.lineNumber, { text: line.text, occurrences: [] });
    lines.set(match.lineNumber, { text: match.text, occurrences: match.occurrences });
  }
  const passages: { header: string; text: string }[] = [];
  for (const [path, lines] of files) {
    const ordered = [...lines].sort(([a], [b]) => a - b);
    let passage: typeof ordered = [];
    const flush = () => {
      if (passage.length === 0) return;
      const ranges = passage.flatMap(([line, { occurrences }]) => occurrences.length
        ? [`${String(line)}: ${occurrences.map(({ startByte, endByte }) => `${String(startByte)}-${String(endByte)}`).join(', ')}`]
        : []);
      passages.push({
        header: `${JSON.stringify(path)} lines ${String(passage[0]?.[0])}-${String(passage.at(-1)?.[0])}; match byte ranges by line: ${ranges.join('; ')}`,
        text: passage.map(([, { text }]) => text).join('\n')
      });
      passage = [];
    };
    for (const line of ordered) {
      const previous = passage.at(-1)?.[0];
      if (previous !== undefined && line[0] !== previous + 1) flush();
      passage.push(line);
    }
    flush();
  }
  return passages;
}
