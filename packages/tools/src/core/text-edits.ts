import * as z from 'zod';

export const unicodeTextSchema = z
  .string()
  .refine(
    (value) => !/\p{Surrogate}/u.test(value),
    'Text must contain well-formed Unicode scalar values.'
  );
export const textPositionSchema = z.strictObject({
  line: z.int().min(1).meta({ description: 'One-based line number.' }),
  column: z.int().min(1).meta({ description: 'One-based Unicode-scalar column.' })
});
export const textRangeSchema = z
  .strictObject({
    start: textPositionSchema,
    end: textPositionSchema
  })
  .meta({ description: 'Half-open range [start, end).' });
export const textEditSchema = z.strictObject({
  range: textRangeSchema,
  expectedText: unicodeTextSchema,
  replacementText: unicodeTextSchema
});
export type TextEdit = z.output<typeof textEditSchema>;
export type TextRange = TextEdit['range'];

export interface TextEditFailure {
  readonly editIndex: number;
  readonly reason:
    | 'range_out_of_bounds'
    | 'reversed_range'
    | 'overlapping_range'
    | 'expected_text_mismatch';
  readonly message: string;
}
export type TextEditResult =
  | { readonly status: 'invalid'; readonly failures: readonly TextEditFailure[] }
  | {
      readonly status: 'applied';
      readonly content: string;
      readonly changedEdits: readonly TextEdit[];
    };

/** All ranges address the original text. No newline normalization or approximate matching. */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): TextEditResult {
  const lines: { start: number; end: number }[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 10) continue;
    lines.push({
      start: lineStart,
      end: index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    });
    lineStart = index + 1;
  }
  lines.push({ start: lineStart, end: content.length });
  const offset = (position: TextRange['start']): number => {
    const line = lines[position.line - 1];
    if (!line) throw new Error(`Line ${String(position.line)} is outside the text.`);
    const scalars = Array.from(content.slice(line.start, line.end));
    if (position.column > scalars.length + 1)
      throw new Error(
        `Column ${String(position.column)} is outside line ${String(position.line)}.`
      );
    return line.start + scalars.slice(0, position.column - 1).join('').length;
  };
  const failures: TextEditFailure[] = [];
  const replacements: { start: number; end: number; edit: TextEdit }[] = [];
  let previousStart = -1;
  let previousEnd = -1;
  for (const { edit, editIndex } of edits
    .map((edit, editIndex) => ({ edit, editIndex }))
    .sort(
      (a, b) =>
        a.edit.range.start.line - b.edit.range.start.line ||
        a.edit.range.start.column - b.edit.range.start.column
    )) {
    let start: number;
    let end: number;
    try {
      start = offset(edit.range.start);
      end = offset(edit.range.end);
    } catch (error) {
      failures.push({
        editIndex,
        reason: 'range_out_of_bounds',
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    const reason =
      end < start
        ? 'reversed_range'
        : start <= previousStart || start < previousEnd
          ? 'overlapping_range'
          : content.slice(start, end) !== edit.expectedText
            ? 'expected_text_mismatch'
            : undefined;
    if (reason) {
      failures.push({
        editIndex,
        reason,
        message:
          reason === 'reversed_range'
            ? 'The range end precedes its start.'
            : reason === 'overlapping_range'
              ? 'Edit ranges must not overlap or share an insertion point.'
              : `Expected text does not match range ${formatTextRange(edit.range)}.`
      });
      continue;
    }
    replacements.push({ start, end, edit });
    previousStart = start;
    previousEnd = end;
  }
  if (failures.length) return { status: 'invalid', failures };
  let result = '';
  let cursor = 0;
  for (const replacement of replacements) {
    result += content.slice(cursor, replacement.start) + replacement.edit.replacementText;
    cursor = replacement.end;
  }
  return {
    status: 'applied',
    content: result + content.slice(cursor),
    changedEdits: replacements
      .filter(({ edit }) => edit.expectedText !== edit.replacementText)
      .map(({ edit }) => edit)
  };
}

export function formatTextRange(range: TextRange): string {
  return `${String(range.start.line)}:${String(range.start.column)}-${String(range.end.line)}:${String(range.end.column)}`;
}
