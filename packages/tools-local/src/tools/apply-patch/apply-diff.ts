import { joinLogicalLines, splitLogicalLines } from '@agent-core/tools';
import type { ParsedHunk, ParsedUpdateFile } from './patch-parser.js';
import type { PatchMatchMode } from './schema.js';

export type PatchApplyFailureReason = 'context_not_found' | 'ambiguous_context';

export interface AppliedPatchUpdate {
  content: string;
  hunkCount: number;
  additions: number;
  deletions: number;
  changed: boolean;
  matchModes: PatchMatchMode[];
  exact: boolean;
}

export class PatchApplyError extends Error {
  readonly reason: PatchApplyFailureReason;
  readonly hunkIndex: number;
  readonly header?: string;
  readonly failingLine: string;
  readonly oldPreview: string;
  readonly matchCount?: number;
  readonly candidateLines?: number[];
  readonly possiblyAlreadyApplied?: boolean;

  constructor(reason: PatchApplyFailureReason, hunk: ParsedHunk, message: string, details: { matchCount?: number; candidateLines?: number[]; possiblyAlreadyApplied?: boolean } = {}) {
    super(message);
    this.name = 'PatchApplyError';
    this.reason = reason;
    this.hunkIndex = hunk.index;
    if (hunk.header !== undefined) this.header = hunk.header;
    this.failingLine = hunkFocusLine(hunk);
    this.oldPreview = hunk.oldPreview;
    if (details.matchCount !== undefined) this.matchCount = details.matchCount;
    if (details.candidateLines !== undefined) this.candidateLines = details.candidateLines;
    if (details.possiblyAlreadyApplied !== undefined) this.possiblyAlreadyApplied = details.possiblyAlreadyApplied;
  }
}

export function applyPatchUpdate(content: string, operation: ParsedUpdateFile): AppliedPatchUpdate {
  const shape = splitLogicalLines(content);
  const lines = [...shape.lines];
  const matchModes: PatchMatchMode[] = [];

  for (const hunk of operation.hunks) {
    matchModes.push(applyHunk(lines, hunk));
  }

  const nextContent = joinLogicalLines(lines, shape);
  return {
    content: nextContent,
    hunkCount: operation.hunks.length,
    additions: operation.additions,
    deletions: operation.deletions,
    changed: content !== nextContent,
    matchModes: uniqueMatchModes(matchModes),
    exact: matchModes.every((mode) => mode === 'exact')
  };
}

function applyHunk(lines: string[], hunk: ParsedHunk): PatchMatchMode {
  const match = findHunkMatch(lines, hunk);
  if (!match) {
    const alreadyApplied = hunk.newLines.length > 0 && findOldLines(lines, hunk.newLines).length === 1;
    throw new PatchApplyError('context_not_found', hunk, `Hunk ${String(hunk.index + 1)} context was not found.`, {
      matchCount: 0,
      ...(alreadyApplied ? { possiblyAlreadyApplied: true } : {})
    });
  }

  lines.splice(match.start, hunk.oldLines.length, ...hunk.newLines);
  return match.mode;
}

function findHunkMatch(lines: readonly string[], hunk: ParsedHunk): { start: number; mode: PatchMatchMode } | undefined {
  for (const mode of matchModeOrder) {
    const candidates = findOldLines(lines, hunk.oldLines, mode);
    if (candidates.length === 0) {
      continue;
    }
    const narrowed = candidates.length > 1 && hunk.header
      ? narrowCandidatesWithHeader(lines, candidates, hunk)
      : candidates;
    if (narrowed.length === 1) {
      return { start: narrowed[0] ?? 0, mode };
    }
    const candidateLines = narrowed.length > 0 ? narrowed.map((index) => index + 1) : candidates.map((index) => index + 1);
    throw new PatchApplyError('ambiguous_context', hunk, `Hunk ${String(hunk.index + 1)} context matched ${String(candidateLines.length)} locations.`, {
      matchCount: candidateLines.length,
      candidateLines
    });
  }
  return undefined;
}

const matchModeOrder: readonly PatchMatchMode[] = [
  'exact',
  'trim_trailing_whitespace',
  'trim_surrounding_whitespace',
  'normalize_common_unicode_punctuation'
];

export function findOldLines(
  lines: readonly string[],
  oldLines: readonly string[],
  mode: PatchMatchMode = 'exact'
): number[] {
  if (oldLines.length === 0) {
    return lines.length === 0 ? [0] : [];
  }
  const matches: number[] = [];
  const maxStart = lines.length - oldLines.length;
  for (let start = 0; start <= maxStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (!matchesLine(lines[start + offset] ?? '', oldLines[offset] ?? '', mode)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(start);
    }
  }
  return matches;
}

function matchesLine(actual: string, expected: string, mode: PatchMatchMode): boolean {
  if (mode === 'exact') {
    return actual === expected;
  }
  if (mode === 'trim_trailing_whitespace') {
    return trimTrailingWhitespace(actual) === trimTrailingWhitespace(expected);
  }
  if (mode === 'trim_surrounding_whitespace') {
    return actual.trim() === expected.trim();
  }
  return normalizeCommonUnicodePunctuation(actual) === normalizeCommonUnicodePunctuation(expected);
}

function trimTrailingWhitespace(value: string): string {
  return value.replace(/[ \t]+$/u, '');
}

function normalizeCommonUnicodePunctuation(value: string): string {
  return value.trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ');
}

function uniqueMatchModes(modes: readonly PatchMatchMode[]): PatchMatchMode[] {
  return matchModeOrder.filter((mode) => modes.includes(mode));
}

function narrowCandidatesWithHeader(lines: readonly string[], candidates: readonly number[], hunk: ParsedHunk): number[] {
  const header = hunk.header;
  if (!header) {
    return [...candidates];
  }
  return candidates.filter((candidate) => {
    const start = Math.max(0, candidate - 200);
    const end = Math.min(lines.length, candidate + Math.max(1, hunk.oldLines.length));
    return lines.slice(start, end).some((line) => line.includes(header));
  });
}

function hunkFocusLine(hunk: ParsedHunk): string {
  const removed = hunk.lines.find((line) => line.kind === 'remove');
  if (removed) {
    return `-${removed.text}`;
  }
  const context = hunk.lines.find((line) => line.kind === 'context');
  if (context) {
    return ` ${context.text}`;
  }
  const added = hunk.lines.find((line) => line.kind === 'add');
  return added ? `+${added.text}` : '';
}
