import { spawn } from 'node:child_process';
import path from 'node:path';
import { requireWorkspaceRoot, type ToolExecutionContext, type ToolObservation } from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { workspaceFileSelector } from '../../core/workspace-file-selection.js';
import type { SearchTextInput, SearchTextOutput } from './schema.js';

interface RipgrepMatchData {
  readonly path?: { readonly text?: string };
  readonly lines?: { readonly text?: string };
  readonly line_number?: number;
  readonly submatches?: readonly { readonly start?: number; readonly end?: number; readonly match?: { readonly text?: string } }[];
}

export async function searchText(input: SearchTextInput, context: ToolExecutionContext): Promise<ToolObservation<SearchTextOutput>> {
  const root = requireWorkspaceRoot(context);
  const limits = requireLocalToolConfiguration(context).searchText;
  const resultLimit = clampRequestedLimit(input.resultLimit, limits.maxResults);
  const selection = await workspaceFileSelector(context).select({
    startPath: input.path,
    patterns: input.patterns,
    type: 'file',
    respectGitIgnore: input.respectGitIgnore,
    includeHidden: input.includeHidden,
    exclude: input.exclude
  });
  const files = selection.entries.map((entry) => path.relative(root, path.resolve(root, entry.path)) || '.');
  const args = ['--json', '--stats', '--line-number', '--column', '--color', 'never', '--max-filesize', String(limits.maxFileBytes)];
  if (input.fixedStrings) args.push('--fixed-strings');
  if (!input.caseSensitive) args.push('--ignore-case');
  args.push('--', input.query, ...files);

  const aggregate = await runRipgrep(root, args, limits.maxOutputBytes, resultLimit);
  const omittedResultCount = input.mode === 'matches'
    ? Math.max(0, aggregate.matchingLineCount - aggregate.matches.length)
    : Math.max(0, aggregate.files.size - Math.min(aggregate.files.size, resultLimit));
  const partial = selection.coverage === 'partial' || aggregate.outputLimited || omittedResultCount > 0;
  const status = aggregate.invalidPattern ? 'invalid_pattern' : partial ? 'partial' : 'completed';
  const coverage = partial || aggregate.invalidPattern ? 'partial' : 'complete';
  const common = {
    query: input.query,
    status,
    ...(aggregate.diagnostic ? { diagnostic: aggregate.diagnostic } : {}),
    coverage,
    examinedFileCount: aggregate.examinedFileCount,
    matchingFileCount: aggregate.files.size,
    matchingLineCount: aggregate.matchingLineCount,
    occurrenceCount: aggregate.occurrenceCount,
    omittedResultCount
  } as const;
  let output: SearchTextOutput;
  if (input.mode === 'files') {
    output = { ...common, mode: 'files', results: [...aggregate.files].sort((a, b) => a.localeCompare(b, 'en')).slice(0, resultLimit) };
  } else if (input.mode === 'count') {
    output = {
      ...common,
      mode: 'count',
      results: [...aggregate.counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).slice(0, resultLimit)
        .map(([file, count]) => ({ path: file, ...count }))
    };
  } else {
    output = { ...common, mode: 'matches', results: aggregate.matches };
  }
  return {
    kind: 'result',
    ok: !aggregate.invalidPattern,
    summary: aggregate.invalidPattern
      ? 'ripgrep rejected the search pattern.'
      : `Found ${String(output.occurrenceCount)} occurrences on ${String(output.matchingLineCount)} lines in ${String(output.matchingFileCount)} files.`,
    scope: {
      resources: [`workspace/files/${input.path}`],
      coverage,
      ...(coverage === 'partial' ? { cause: aggregate.invalidPattern ? 'invalid regular expression' : 'selection or output limit reached' } : {})
    },
    output
  };
}

interface SearchAggregate {
  readonly files: Set<string>;
  readonly counts: Map<string, { matchingLineCount: number; occurrenceCount: number }>;
  readonly matches: Extract<SearchTextOutput, { mode: 'matches' }>['results'];
  matchingLineCount: number;
  occurrenceCount: number;
  examinedFileCount: number;
  outputLimited: boolean;
  invalidPattern: boolean;
  diagnostic?: string;
}

async function runRipgrep(cwd: string, args: readonly string[], maxOutputBytes: number, resultLimit: number): Promise<SearchAggregate> {
  const aggregate = emptyAggregate();
  const child = spawn('rg', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutBuffer = '';
  let stderr = '';
  let observedBytes = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const boundedChunk = (chunk: string): string => {
    const bytes = Buffer.from(chunk);
    const remaining = Math.max(0, maxOutputBytes - observedBytes);
    observedBytes += bytes.byteLength;
    if (bytes.byteLength <= remaining) return chunk;
    aggregate.outputLimited = true;
    child.kill('SIGTERM');
    return bytes.subarray(0, remaining).toString('utf8');
  };
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += boundedChunk(chunk);
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) consumeJsonLine(line, aggregate, resultLimit);
  });
  child.stderr.on('data', (chunk: string) => { stderr += boundedChunk(chunk); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (stdoutBuffer.length > 0) consumeJsonLine(stdoutBuffer, aggregate, resultLimit);
  if (exitCode === 2) {
    aggregate.invalidPattern = true;
    aggregate.diagnostic = stderr.trim() || 'ripgrep rejected the search request.';
  } else if (exitCode !== 0 && exitCode !== 1 && !aggregate.outputLimited) {
    aggregate.outputLimited = true;
    aggregate.diagnostic = stderr.trim() || `ripgrep exited with code ${String(exitCode)}.`;
  }
  return aggregate;
}

function emptyAggregate(): SearchAggregate {
  return {
    files: new Set(), counts: new Map(), matches: [], matchingLineCount: 0, occurrenceCount: 0,
    examinedFileCount: 0, outputLimited: false, invalidPattern: false
  };
}

function consumeJsonLine(line: string, aggregate: SearchAggregate, resultLimit: number): void {
  if (line.trim().length === 0) return;
  let event: unknown;
  try { event = JSON.parse(line); } catch { return; }
  if (!isRecord(event) || typeof event.type !== 'string' || !isRecord(event.data)) return;
  if (event.type === 'summary' && isRecord(event.data.stats)) {
    const searches = event.data.stats.searches;
    if (typeof searches === 'number' && Number.isSafeInteger(searches) && searches >= 0) aggregate.examinedFileCount = searches;
    return;
  }
  if (event.type !== 'match') return;
  const data = event.data as RipgrepMatchData;
  const file = data.path?.text;
  const lineNumber = data.line_number;
  if (typeof file !== 'string' || typeof lineNumber !== 'number') return;
  const occurrences = (data.submatches ?? []).map((match) => ({
    start: match.start ?? 0,
    end: match.end ?? match.start ?? 0,
    text: match.match?.text ?? ''
  }));
  aggregate.files.add(file);
  aggregate.matchingLineCount += 1;
  aggregate.occurrenceCount += occurrences.length;
  const count = aggregate.counts.get(file) ?? { matchingLineCount: 0, occurrenceCount: 0 };
  count.matchingLineCount += 1;
  count.occurrenceCount += occurrences.length;
  aggregate.counts.set(file, count);
  if (aggregate.matches.length < resultLimit) {
    aggregate.matches.push({ path: file, lineNumber, text: data.lines?.text?.replace(/\r?\n$/u, '') ?? '', occurrences });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
