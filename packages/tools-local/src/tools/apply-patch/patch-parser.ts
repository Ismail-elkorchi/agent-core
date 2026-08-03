import { byteLengthUtf8 } from '../../core/filesystem.js';
import { normalizeNewlines } from '@agent-core/tools';

export type PatchParseFailureReason =
  | 'empty_patch'
  | 'patch_too_large'
  | 'missing_wrapper'
  | 'unsupported_header'
  | 'invalid_operation'
  | 'invalid_hunk_line'
  | 'empty_hunk'
  | 'hunk_without_change'
  | 'missing_hunk_header'
  | 'empty_update'
  | 'empty_add_file';

export interface ParseApplyPatchLimits {
  maxPatchBytes: number;
}

export type ParsedPatchOperation = ParsedAddFile | ParsedUpdateFile | ParsedDeleteFile;

export interface ParsedApplyPatch {
  operations: ParsedPatchOperation[];
  additions: number;
  deletions: number;
  hunkCount: number;
}

export interface ParsedAddFile {
  kind: 'add';
  path: string;
  content: string;
  additions: number;
}

export interface ParsedUpdateFile {
  kind: 'update';
  path: string;
  moveTo?: string;
  hunks: ParsedHunk[];
  additions: number;
  deletions: number;
}

export interface ParsedDeleteFile {
  kind: 'delete';
  path: string;
}

export interface ParsedHunk {
  index: number;
  header?: string;
  lines: ParsedHunkLine[];
  oldLines: string[];
  newLines: string[];
  additions: number;
  deletions: number;
  oldPreview: string;
}

export interface ParsedHunkLine {
  kind: 'context' | 'remove' | 'add';
  text: string;
}

export class PatchParseError extends Error {
  readonly reason: PatchParseFailureReason;
  readonly path?: string;
  readonly hunkIndex?: number;
  readonly header?: string;
  readonly failingLine?: string;
  readonly oldPreview?: string;

  constructor(reason: PatchParseFailureReason, message: string, details: { path?: string; hunkIndex?: number; header?: string; failingLine?: string; oldPreview?: string } = {}) {
    super(message);
    this.name = 'PatchParseError';
    this.reason = reason;
    if (details.path !== undefined) this.path = details.path;
    if (details.hunkIndex !== undefined) this.hunkIndex = details.hunkIndex;
    if (details.header !== undefined) this.header = details.header;
    if (details.failingLine !== undefined) this.failingLine = details.failingLine;
    if (details.oldPreview !== undefined) this.oldPreview = details.oldPreview;
  }
}

export function parseApplyPatch(patch: string, limits: ParseApplyPatchLimits): ParsedApplyPatch {
  const patchBytes = byteLengthUtf8(patch);
  if (patchBytes > limits.maxPatchBytes) {
    throw new PatchParseError('patch_too_large', `Patch document is too large (${String(patchBytes)} bytes, max ${String(limits.maxPatchBytes)}).`);
  }
  const normalized = normalizeNewlines(patch);
  if (normalized.trim().length === 0) {
    throw new PatchParseError('empty_patch', 'Patch document is empty.');
  }
  const lines = splitPatchLines(normalized);
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    throw new PatchParseError('missing_wrapper', 'Patch document must start with "*** Begin Patch" and end with "*** End Patch".');
  }

  const operations: ParsedPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index] ?? '';
    if (line.length === 0) {
      index += 1;
      continue;
    }
    rejectUnsupportedHeader(line);
    if (line.startsWith('*** Add File: ')) {
      const parsed = parseAddFile(lines, index);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const parsed = parseUpdateFile(lines, index);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      operations.push({ kind: 'delete', path: requirePath(line.slice('*** Delete File: '.length), 'Delete File') });
      index += 1;
      continue;
    }
    throw new PatchParseError('invalid_operation', `Unsupported patch operation line: ${line}`, { failingLine: line });
  }

  if (operations.length === 0) {
    throw new PatchParseError('invalid_operation', 'Patch document must contain at least one file operation.');
  }
  return {
    operations,
    additions: operations.reduce((total, operation) => total + operationAdditions(operation), 0),
    deletions: operations.reduce((total, operation) => total + operationDeletions(operation), 0),
    hunkCount: operations.reduce((total, operation) => total + (operation.kind === 'update' ? operation.hunks.length : 0), 0)
  };
}

function splitPatchLines(patch: string): string[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function parseAddFile(lines: readonly string[], startIndex: number): { operation: ParsedAddFile; nextIndex: number } {
  const header = lines[startIndex] ?? '';
  const path = requirePath(header.slice('*** Add File: '.length), 'Add File');
  const contentLines: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] ?? '')) {
    const line = lines[index] ?? '';
    rejectUnsupportedHeader(line);
    if (!line.startsWith('+')) {
      throw new PatchParseError('invalid_operation', `Add File content lines must start with "+": ${line}`, { path, failingLine: line });
    }
    contentLines.push(line.slice(1));
    index += 1;
  }
  if (contentLines.length === 0) {
    throw new PatchParseError('empty_add_file', `Add File operation has no content: ${path}`, { path });
  }
  return {
    operation: {
      kind: 'add',
      path,
      content: `${contentLines.join('\n')}\n`,
      additions: contentLines.length
    },
    nextIndex: index
  };
}

function parseUpdateFile(lines: readonly string[], startIndex: number): { operation: ParsedUpdateFile; nextIndex: number } {
  const header = lines[startIndex] ?? '';
  const path = requirePath(header.slice('*** Update File: '.length), 'Update File');
  let index = startIndex + 1;
  let moveTo: string | undefined;
  if ((lines[index] ?? '').startsWith('*** Move to: ')) {
    moveTo = requirePath((lines[index] ?? '').slice('*** Move to: '.length), 'Move to');
    index += 1;
  }

  const hunks: ParsedHunk[] = [];
  while (index < lines.length - 1 && !isOperationHeader(lines[index] ?? '')) {
    const line = lines[index] ?? '';
    rejectUnsupportedHeader(line);
    if (line.length === 0) {
      index += 1;
      continue;
    }
    if (!line.startsWith('@@')) {
      throw new PatchParseError('missing_hunk_header', `Update content must use @@ hunk headers before line: ${line}`, { path, failingLine: line });
    }
    const parsed = parseHunk(lines, index, hunks.length, path);
    hunks.push(parsed.hunk);
    index = parsed.nextIndex;
  }

  if (!moveTo && hunks.length === 0) {
    throw new PatchParseError('empty_update', `Update File operation has no hunks: ${path}`, { path });
  }
  return {
    operation: {
      kind: 'update',
      path,
      ...(moveTo ? { moveTo } : {}),
      hunks,
      additions: hunks.reduce((total, hunk) => total + hunk.additions, 0),
      deletions: hunks.reduce((total, hunk) => total + hunk.deletions, 0)
    },
    nextIndex: index
  };
}

function parseHunk(lines: readonly string[], startIndex: number, hunkIndex: number, path: string): { hunk: ParsedHunk; nextIndex: number } {
  const headerLine = lines[startIndex] ?? '';
  if (/^@@\s*-\d/.test(headerLine)) {
    throw new PatchParseError('unsupported_header', `Unified diff hunk headers are not supported: ${headerLine}`, { path, hunkIndex, failingLine: headerLine });
  }
  const header = headerLine.slice(2).trim() || undefined;
  const hunkLines: ParsedHunkLine[] = [];
  let index = startIndex + 1;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] ?? '') && !(lines[index] ?? '').startsWith('@@')) {
    if ((lines[index] ?? '') === '*** End of File') {
      index += 1;
      break;
    }
    hunkLines.push(parseHunkLine(lines[index] ?? '', hunkIndex, header, path));
    index += 1;
  }
  return { hunk: buildHunk(hunkIndex, header, hunkLines, path), nextIndex: index };
}

function parseHunkLine(line: string, hunkIndex: number, header: string | undefined, path: string): ParsedHunkLine {
  if (line.length === 0) {
    throw new PatchParseError('invalid_hunk_line', 'Hunk lines must start with space, -, or +.', { path, hunkIndex, ...(header ? { header } : {}), failingLine: line });
  }
  const prefix = line.charAt(0);
  const text = line.slice(1);
  if (prefix === ' ') return { kind: 'context', text };
  if (prefix === '-') return { kind: 'remove', text };
  if (prefix === '+') return { kind: 'add', text };
  throw new PatchParseError('invalid_hunk_line', `Invalid hunk line prefix: ${prefix}`, { path, hunkIndex, ...(header ? { header } : {}), failingLine: line });
}

function buildHunk(index: number, header: string | undefined, lines: ParsedHunkLine[], path: string): ParsedHunk {
  if (lines.length === 0) {
    throw new PatchParseError('empty_hunk', `Hunk ${String(index + 1)} has no lines.`, { path, hunkIndex: index, ...(header ? { header } : {}) });
  }
  const additions = lines.filter((line) => line.kind === 'add').length;
  const deletions = lines.filter((line) => line.kind === 'remove').length;
  const oldLines = lines.filter((line) => line.kind !== 'add').map((line) => line.text);
  if (additions + deletions === 0) {
    throw new PatchParseError('hunk_without_change', `Hunk ${String(index + 1)} has no additions or deletions.`, { path, hunkIndex: index, ...(header ? { header } : {}), oldPreview: previewLines(oldLines) });
  }
  const newLines = lines.filter((line) => line.kind !== 'remove').map((line) => line.text);
  return {
    index,
    ...(header ? { header } : {}),
    lines,
    oldLines,
    newLines,
    additions,
    deletions,
    oldPreview: previewLines(oldLines)
  };
}

function rejectUnsupportedHeader(line: string): void {
  if (line.startsWith('--- ')
    || line.startsWith('+++ ')
    || line.startsWith('diff --git ')
    || (line.startsWith('*** ') && !isOperationHeader(line) && line !== '*** End Patch' && line !== '*** End of File')) {
    throw new PatchParseError('unsupported_header', `Unsupported patch header: ${line}`, { failingLine: line });
  }
}

function isOperationHeader(line: string): boolean {
  return line.startsWith('*** Add File: ')
    || line.startsWith('*** Update File: ')
    || line.startsWith('*** Delete File: ');
}

function requirePath(value: string, operation: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new PatchParseError('invalid_operation', `${operation} path cannot be empty.`);
  }
  return trimmed;
}

function operationAdditions(operation: ParsedPatchOperation): number {
  if (operation.kind === 'add') return operation.additions;
  if (operation.kind === 'delete') return 0;
  return operation.additions;
}

function operationDeletions(operation: ParsedPatchOperation): number {
  if (operation.kind === 'add') return 0;
  if (operation.kind === 'delete') return 0;
  return operation.deletions;
}

function previewLines(lines: readonly string[]): string {
  const joined = lines.join('\n');
  return joined.length > 120 ? `${joined.slice(0, 120)}...` : joined;
}
