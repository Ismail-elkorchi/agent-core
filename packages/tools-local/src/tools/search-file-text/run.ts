import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { evidenceDelta, toEvidenceJsonObject, workspaceResource } from '@agent-core/evidence';
import { requireWorkspaceRoot, throwIfAborted, ToolInputError, type ToolExecutionContext } from '@agent-core/tools';
import type { ToolObservation } from '@agent-core/tools';
import {
  createPathMatcher,
  hiddenModeAllows,
  normalizePattern,
  relativePath,
  requireDirectoryInsideRoot,
  resolveInsideRoot,
  splitTextLines,
  validateRelativePatterns
} from '../../core/filesystem.js';
import { invalidToolInputObservation, missingServiceObservation, runtimeErrorObservation } from '@agent-core/tools';
import type {
  SearchFileTextFileResult,
  SearchFileTextInput,
  SearchFileTextMatchResult,
  SearchFileTextOutput
} from './schema.js';

interface FileAccumulator {
  path: string;
  matchCount: number;
  firstLine: number;
  firstPreview: string;
  matches: SearchFileTextMatchResult[];
}

interface RgMatchEvent {
  type: 'match';
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start?: number }[];
  };
}

export async function searchFileText(input: SearchFileTextInput, context: ToolExecutionContext): Promise<ToolObservation<SearchFileTextOutput>> {
  const rootDir = requireWorkspaceRoot(context);
  validateSearchInput(input);
  const result = await searchWithRipgrep(rootDir, input, context.signal);
  if (!result.ok) {
    return result;
  }
  return {
    kind: 'result',
    ok: true,
    summary: summarizeSearch(result.output),
    output: result.output,
    evidence: evidenceDelta([{
      action: 'search',
      resources: [workspaceResource(result.output.path)],
      scope: {
        filters: toEvidenceJsonObject({ ...result.output.filters }),
        limits: toEvidenceJsonObject({
          resultMode: result.output.resultMode,
          maxResults: result.output.filters.maxResults,
          maxMatchesPerFile: result.output.filters.maxMatchesPerFile,
          maxFileBytes: result.output.filters.maxFileBytes,
          maxResultBytes: result.output.filters.maxResultBytes
        }),
        omitted: toEvidenceJsonObject({ ...result.output.omitted }),
        coverage: result.output.coverage,
        truncated: result.output.truncated,
        confidence: 'verified'
      },
      summary: `Searched ${result.output.path} for ${result.output.mode} query "${result.output.query}" in ${result.output.resultMode} mode.`
    }])
  };
}

function validateSearchInput(input: SearchFileTextInput): void {
  validateRelativePatterns(input.include, 'include');
  validateRelativePatterns(input.exclude, 'exclude');
  if (input.mode === 'regex') {
    try {
      new RegExp(input.query);
    } catch {
      throw new ToolInputError('Invalid regex query.', { kind: 'invalid_regex', query: input.query });
    }
  }
}

async function searchWithRipgrep(
  rootDir: string,
  input: SearchFileTextInput,
  signal: AbortSignal | undefined
): Promise<ToolObservation<SearchFileTextOutput>> {
  const root = path.resolve(rootDir);
  const start = resolveInsideRoot(root, input.path);
  await requireDirectoryInsideRoot(root, start, input.path);
  const pathLabel = relativePath(root, start) || '.';
  const includeMatchers = input.include.map(createPathMatcher);
  const excludeMatchers = input.exclude.map(createPathMatcher);
  const fileMap = new Map<string, FileAccumulator>();
  const omitted = { files: 0, matches: 0, bytes: 0 };
  let retainedMatches = 0;
  let countFiles = 0;
  let countMatches = 0;
  let currentCountPath: string | undefined;

  const args = buildRipgrepArgs(input, start);
  const runResult = await runRipgrep(args, signal, (event) => {
    const data = event.data;
    if (!data?.path?.text || typeof data.line_number !== 'number') {
      return true;
    }
    const absolutePath = data.path.text;
    const lineNumber = data.line_number;

    const workspaceRelativePath = relativePath(root, absolutePath);
    const scopedRelativePath = relativePath(start, absolutePath);
    const name = path.basename(absolutePath);
    if (!pathAllowed(workspaceRelativePath, scopedRelativePath, name, input, includeMatchers, excludeMatchers)) {
      return true;
    }

    if (input.resultMode === 'count') {
      if (currentCountPath !== workspaceRelativePath) {
        currentCountPath = workspaceRelativePath;
        countFiles += 1;
      }
      countMatches += Math.max(1, data.submatches?.length ?? 0);
      return true;
    }

    const lineText = sanitizeLine(data.lines?.text ?? '');
    const firstColumn = firstMatchColumn(data);
    const existing = fileMap.get(workspaceRelativePath);
    if (existing) {
      existing.matchCount += 1;
      if (input.resultMode === 'matches') {
        if (retainedMatches >= input.maxResults) {
          omitted.matches += 1;
          return false;
        }
        retainedMatches += addMatch(existing, input.maxMatchesPerFile, {
          path: workspaceRelativePath,
          line: lineNumber,
          column: firstColumn,
          text: lineText
        }, omitted);
      }
      return true;
    }

    if (fileMap.size >= input.maxResults) {
      omitted.files += 1;
      return false;
    }

    const accumulator: FileAccumulator = {
      path: workspaceRelativePath,
      matchCount: 1,
      firstLine: lineNumber,
      firstPreview: lineText,
      matches: []
    };
    if (input.resultMode === 'matches') {
      retainedMatches += addMatch(accumulator, input.maxMatchesPerFile, {
        path: workspaceRelativePath,
        line: lineNumber,
        column: firstColumn,
        text: lineText
      }, omitted);
    }
    fileMap.set(workspaceRelativePath, accumulator);
    return true;
  });

  if (runResult.kind === 'missing_service') {
    return missingServiceObservation('search_file_text', 'ripgrep (rg)', 'Install ripgrep or put an rg executable on PATH, then call this tool again.');
  }
  if (runResult.kind === 'invalid_regex') {
    return invalidToolInputObservation('search_file_text', 'Regex query is not supported by the search backend.', {
      kind: 'invalid_regex',
      query: input.query
    });
  }
  if (runResult.kind === 'runtime_error') {
    return runtimeErrorObservation('search_file_text', new Error('Search backend failed.'));
  }

  let output = await buildOutput({
    pathLabel,
    input,
    files: [...fileMap.values()],
    omitted,
    root,
    stoppedEarly: runResult.stoppedEarly,
    countFiles,
    countMatches
  });
  output = enforceResultByteLimit(output, input.maxResultBytes);
  return {
    kind: 'result',
    ok: true,
    summary: summarizeSearch(output),
    output
  };
}

function buildRipgrepArgs(input: SearchFileTextInput, start: string): string[] {
  const args = [
    '--json',
    '--line-number',
    '--column',
    '--color=never',
    '--no-ignore',
    '--sort',
    'path',
    '--max-filesize',
    String(input.maxFileBytes)
  ];
  if (input.hidden === 'include' || input.hidden === 'only') {
    args.push('--hidden');
  }
  if (!input.caseSensitive) {
    args.push('--ignore-case');
  }
  if (input.mode === 'literal') {
    args.push('--fixed-strings');
  }
  for (const pattern of input.include.flatMap(toRipgrepIncludeGlobs)) {
    args.push('--glob', pattern);
  }
  for (const pattern of input.exclude.flatMap(toRipgrepExcludeGlobs)) {
    args.push('--glob', `!${pattern}`);
  }
  args.push('--', input.query, start);
  return args;
}

function toRipgrepIncludeGlobs(pattern: string): string[] {
  const normalized = normalizePattern(pattern);
  if (/[*?]/.test(normalized)) {
    return normalized.includes('/') ? [normalized] : [normalized, `**/${normalized}`];
  }
  if (normalized.includes('/')) {
    return [normalized, `${normalized}/**`];
  }
  return [`**/${normalized}`, `**/${normalized}/**`];
}

function toRipgrepExcludeGlobs(pattern: string): string[] {
  return toRipgrepIncludeGlobs(pattern);
}

type RipgrepRunResult =
  | { kind: 'ok'; stoppedEarly: boolean }
  | { kind: 'missing_service' }
  | { kind: 'invalid_regex' }
  | { kind: 'runtime_error' };

function runRipgrep(
  args: string[],
  signal: AbortSignal | undefined,
  onMatch: (event: RgMatchEvent) => boolean
): Promise<RipgrepRunResult> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let settled = false;
    let aborted = false;
    let stoppedEarly = false;
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const rl = createInterface({ input: child.stdout });

    const settle = (result: RipgrepRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const cleanup = (): void => {
      rl.close();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      aborted = true;
      if (!child.killed) {
        child.kill();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    rl.on('line', (line) => {
      if (!line.trim()) {
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (isRgMatchEvent(event) && !stoppedEarly && !onMatch(event)) {
        stoppedEarly = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        settle({ kind: 'missing_service' });
        return;
      }
      settle({ kind: 'runtime_error' });
    });
    child.on('close', (code) => {
      cleanup();
      if (aborted || signal?.aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Tool execution aborted.'));
        return;
      }
      if (settled) {
        return;
      }
      if (code === 0 || code === 1 || stoppedEarly) {
        settle({ kind: 'ok', stoppedEarly });
        return;
      }
      if (code === 2) {
        settle({ kind: 'invalid_regex' });
        return;
      }
      settle({ kind: 'runtime_error' });
    });
  });
}

function isRgMatchEvent(value: unknown): value is RgMatchEvent {
  return typeof value === 'object'
    && value !== null
    && (value as { type?: unknown }).type === 'match';
}

function pathAllowed(
  workspaceRelativePath: string,
  scopedRelativePath: string,
  name: string,
  input: SearchFileTextInput,
  includeMatchers: ReturnType<typeof createPathMatcher>[],
  excludeMatchers: ReturnType<typeof createPathMatcher>[]
): boolean {
  if (!hiddenModeAllows(workspaceRelativePath, input.hidden)) {
    return false;
  }
  if (excludeMatchers.some((matcher) => matcher.matches(workspaceRelativePath, scopedRelativePath, name))) {
    return false;
  }
  return includeMatchers.length === 0
    || includeMatchers.some((matcher) => matcher.matches(workspaceRelativePath, scopedRelativePath, name));
}

function addMatch(
  file: FileAccumulator,
  maxMatchesPerFile: number,
  match: SearchFileTextMatchResult,
  omitted: { matches: number }
): number {
  if (file.matches.length >= maxMatchesPerFile) {
    omitted.matches += 1;
    return 0;
  }
  file.matches.push(match);
  return 1;
}

async function buildOutput(options: {
  pathLabel: string;
  input: SearchFileTextInput;
  files: FileAccumulator[];
  omitted: SearchFileTextOutput['omitted'];
  root: string;
  stoppedEarly: boolean;
  countFiles: number;
  countMatches: number;
}): Promise<SearchFileTextOutput> {
  const rankedFiles = rankFiles(options.files, options.input.query, options.input.mode);
  const base = {
    path: options.pathLabel,
    query: options.input.query,
    mode: options.input.mode,
    resultMode: options.input.resultMode,
    filters: {
      hidden: options.input.hidden,
      include: [...options.input.include],
      exclude: [...options.input.exclude],
      caseSensitive: options.input.caseSensitive,
      contextLines: options.input.contextLines,
      maxResults: options.input.maxResults,
      maxMatchesPerFile: options.input.maxMatchesPerFile,
      maxFileBytes: options.input.maxFileBytes,
      maxResultBytes: options.input.maxResultBytes
    },
    omitted: { ...options.omitted },
    coverage: options.stoppedEarly || options.omitted.files > 0 || options.omitted.matches > 0 ? 'partial' as const : 'complete' as const,
    truncated: false
  };

  if (options.input.resultMode === 'count') {
    const counts = {
      filesWithMatches: options.countFiles,
      totalMatches: options.countMatches
    };
    return { ...base, counts };
  }

  if (options.input.resultMode === 'files') {
    const files = rankedFiles.map(toFileResult);
    const limitedFiles = files.slice(0, options.input.maxResults);
    const omittedFiles = base.omitted.files + (files.length - limitedFiles.length);
    return {
      ...base,
      files: limitedFiles,
      omitted: {
        ...base.omitted,
        files: omittedFiles
      },
      coverage: omittedFiles > 0 ? 'partial' : base.coverage
    };
  }

  await addContextLines(rankedFiles, options.root, options.input.contextLines);
  const matches = rankedFiles.flatMap((file) => file.matches.sort((left, right) => left.line - right.line));
  const limitedMatches = matches.slice(0, options.input.maxResults);
  const omittedMatches = base.omitted.matches + (matches.length - limitedMatches.length);
  return {
    ...base,
    matches: limitedMatches,
    omitted: {
      ...base.omitted,
      matches: omittedMatches
    },
    coverage: omittedMatches > 0 ? 'partial' : base.coverage
  };
}

function rankFiles(files: FileAccumulator[], query: string, mode: SearchFileTextInput['mode']): FileAccumulator[] {
  const literalQuery = mode === 'literal' ? query.toLowerCase() : '';
  return [...files].sort((left, right) => {
    const leftNameHit = literalQuery.length > 0 && path.basename(left.path).toLowerCase().includes(literalQuery) ? 1 : 0;
    const rightNameHit = literalQuery.length > 0 && path.basename(right.path).toLowerCase().includes(literalQuery) ? 1 : 0;
    if (leftNameHit !== rightNameHit) {
      return rightNameHit - leftNameHit;
    }
    if (left.matchCount !== right.matchCount) {
      return right.matchCount - left.matchCount;
    }
    if (left.firstLine !== right.firstLine) {
      return left.firstLine - right.firstLine;
    }
    return left.path.localeCompare(right.path);
  });
}

function toFileResult(file: FileAccumulator): SearchFileTextFileResult {
  return {
    path: file.path,
    matchCount: file.matchCount,
    firstLine: file.firstLine,
    firstPreview: file.firstPreview
  };
}

async function addContextLines(files: FileAccumulator[], root: string, contextLines: number): Promise<void> {
  if (contextLines <= 0) {
    return;
  }
  for (const file of files) {
    const lines = await readFileLines(root, file.path);
    for (const match of file.matches) {
      const start = Math.max(1, match.line - contextLines);
      const end = Math.min(lines.length, match.line + contextLines);
      const before = lines.slice(start - 1, match.line - 1).map(sanitizeLine);
      const after = lines.slice(match.line, end).map(sanitizeLine);
      if (before.length > 0) {
        match.before = before;
      }
      if (after.length > 0) {
        match.after = after;
      }
    }
  }
}

async function readFileLines(root: string, relativeFilePath: string): Promise<string[]> {
  const absolute = resolveInsideRoot(root, relativeFilePath);
  try {
    const content = await fs.readFile(absolute, 'utf8');
    return splitTextLines(content);
  } catch {
    return [];
  }
}

function firstMatchColumn(event: RgMatchEvent['data']): number {
  const start = event?.submatches?.[0]?.start;
  return typeof start === 'number' ? start + 1 : 1;
}

function sanitizeLine(value: string): string {
  const singleLine = value.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, '');
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
}

function enforceResultByteLimit(output: SearchFileTextOutput, maxResultBytes: number): SearchFileTextOutput {
  const limited = structuredClone(output);
  const beforeBytes = byteSize(limited);
  if (beforeBytes <= maxResultBytes) {
    return limited;
  }

  const removeOne = (): boolean => {
    if (limited.matches && limited.matches.length > 0) {
      limited.matches.pop();
      limited.omitted.matches += 1;
      return true;
    }
    if (limited.files && limited.files.length > 0) {
      limited.files.pop();
      limited.omitted.files += 1;
      return true;
    }
    return false;
  };

  while (byteSize(limited) > maxResultBytes && removeOne()) {
    limited.truncated = true;
  }
  const afterBytes = byteSize(limited);
  limited.omitted.bytes += Math.max(0, beforeBytes - afterBytes);
  return limited;
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function summarizeSearch(output: SearchFileTextOutput): string {
  const suffix = `${output.coverage === 'partial' ? ' Search stopped after reaching the result limit.' : ''}${output.truncated ? ' Returned details were truncated to the byte limit.' : ''}`;
  if (output.resultMode === 'count') {
    return `Found ${String(output.counts?.totalMatches ?? 0)} matches in ${String(output.counts?.filesWithMatches ?? 0)} files under "${output.path}".${suffix}`;
  }
  if (output.resultMode === 'matches') {
    return `Returned ${String(output.matches?.length ?? 0)} text matches under "${output.path}".${suffix}`;
  }
  return `Returned ${String(output.files?.length ?? 0)} matching files under "${output.path}".${suffix}`;
}
