import { spawn } from 'node:child_process';
import { requireWorkspaceRoot, workspaceFileScope, type ToolExecutionContext, type ToolObservationInput } from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { builtInReadEvidence } from '../../core/read-evidence.js';
import type { SearchTextInput, SearchTextOutput } from './schema.js';

interface RipgrepData {
  readonly path?: { readonly text?: string };
  readonly lines?: { readonly text?: string };
  readonly line_number?: number;
  readonly submatches?: readonly { readonly start?: number; readonly end?: number; readonly match?: { readonly text?: string } }[];
}
interface MatchRecord { path: string; lineNumber: number; text: string; occurrences: { startByte: number; endByte: number; text: string }[] }
type SearchStatus = SearchTextOutput['status'];
interface SearchAggregate {
  files: Set<string>;
  counts: Map<string, { matchingLineCount: number; occurrenceCount: number }>;
  matches: MatchRecord[];
  contexts: Map<string, Map<number, string>>;
  matchingLineCount: number;
  occurrenceCount: number;
  examinedFileCount: number;
  status: SearchStatus;
  diagnostic?: string;
  perFileOmissions: Map<string, number>;
  outputTruncated: boolean;
}

export async function searchText(input: SearchTextInput, context: ToolExecutionContext): Promise<ToolObservationInput<SearchTextOutput>> {
  const root = requireWorkspaceRoot(context);
  const limits = requireLocalToolConfiguration(context).searchText;
  const resultLimit = clampRequestedLimit(input.resultLimit, limits.maxResults);
  const perFileLimit = clampRequestedLimit(input.perFileLimit, limits.maxResults);
  const args = ['--json', '--stats', '--line-number', '--color', 'never', '--max-filesize', String(limits.maxFileBytes)];
  if (input.mode !== 'count') args.push('--max-count', String(perFileLimit + 1));
  if (input.contextLines > 0) args.push('--context', String(input.contextLines));
  if (input.fixedStrings) args.push('--fixed-strings');
  if (!input.caseSensitive) args.push('--ignore-case');
  if (!input.respectGitIgnore) args.push('--no-ignore');
  if (input.includeHidden) args.push('--hidden');
  for (const pattern of input.patterns) args.push('--glob', pattern);
  for (const pattern of input.exclude) args.push('--glob', '!' + pattern);
  args.push('--', input.query, input.path);
  const aggregate = await runRipgrep(root, args, limits.maxOutputBytes, input.mode, input.mode === 'count' ? undefined : perFileLimit, context.signal);
  const perFileOmitted = [...aggregate.perFileOmissions.values()].reduce((sum, count) => sum + count, 0);
  const globallyOmitted = input.mode === 'matches'
    ? Math.max(0, aggregate.matchingLineCount - Math.min(aggregate.matches.length, resultLimit))
    : Math.max(0, aggregate.files.size - Math.min(aggregate.files.size, resultLimit));
  const omittedResultCount = globallyOmitted + (input.mode === 'matches' ? perFileOmitted : 0);
  const failed = aggregate.status !== 'completed';
  const resultCoverage = failed || aggregate.outputTruncated || globallyOmitted > 0 || (input.mode === 'matches' && perFileOmitted > 0) ? 'partial' as const : 'complete' as const;
  const countCoverage = failed || aggregate.outputTruncated || perFileOmitted > 0 ? 'partial' as const : 'complete' as const;
  const limited = resultCoverage === 'partial' || countCoverage === 'partial';
  const status: SearchStatus = aggregate.status === 'completed' && limited ? 'partial' : aggregate.status;
  const common = {
    query: input.query, status, ...(aggregate.diagnostic ? { diagnostic: aggregate.diagnostic } : {}), resultCoverage, countCoverage,
    examinedFileCount: aggregate.examinedFileCount, matchingFileCount: aggregate.files.size,
    matchingLineCount: aggregate.matchingLineCount, occurrenceCount: aggregate.occurrenceCount, omittedResultCount,
    countsCapped: countCoverage === 'partial',
    omittedResultCountIsLowerBound: perFileOmitted > 0 || aggregate.outputTruncated,
    outputTruncated: aggregate.outputTruncated,
    perFileOmissions: [...aggregate.perFileOmissions.entries()].sort(([a], [b]) => compare(a, b)).map(([file, omittedAtLeast]) => ({
      path: file, cause: 'per_file_limit' as const, retainedMatches: perFileLimit, omittedAtLeast
    }))
  };
  let output: SearchTextOutput;
  if (input.mode === 'files') output = { ...common, mode: 'files', results: [...aggregate.files].sort(compare).slice(0, resultLimit) };
  else if (input.mode === 'count') output = { ...common, mode: 'count', results: [...aggregate.counts.entries()].sort(([a], [b]) => compare(a, b)).slice(0, resultLimit).map(([file, count]) => ({ path: file, ...count })) };
  else {
    const results = aggregate.matches.sort((a, b) => compare(a.path, b.path) || a.lineNumber - b.lineNumber).slice(0, resultLimit).map((match) => {
      if (input.contextLines === 0) return match;
      const lines = aggregate.contexts.get(match.path);
      return {
        ...match,
        context: {
          before: range(match.lineNumber - input.contextLines, match.lineNumber - 1).flatMap((line) => {
            const text = lines?.get(line); return text === undefined ? [] : [{ lineNumber: line, text }];
          }),
          after: range(match.lineNumber + 1, match.lineNumber + input.contextLines).flatMap((line) => {
            const text = lines?.get(line); return text === undefined ? [] : [{ lineNumber: line, text }];
          })
        }
      };
    });
    output = { ...common, mode: 'matches', results };
  }
  const coverage = resultCoverage === 'complete' && countCoverage === 'complete' ? 'complete' as const : 'partial' as const;
  const scope = {
    resources: [workspaceFileScope(input.path)], coverage,
    filters: { patterns: input.patterns, exclude: input.exclude, respectGitIgnore: input.respectGitIgnore, query: input.query, mode: input.mode },
    limits: { resultLimit, perFileLimit, contextLines: input.contextLines },
    ...(coverage === 'partial' ? { causes: [
      ...(status !== 'partial' ? [status] : []),
      ...(globallyOmitted > 0 ? ['result_limit'] : []),
      ...(perFileOmitted > 0 ? ['per_file_limit'] : [])
    ], omitted: { results: omittedResultCount, perFile: perFileOmitted }, truncated: aggregate.outputTruncated || limited } : {})
  } as const;
  return {
    kind: 'result', ok: status === 'completed' || status === 'partial',
    summary: status === 'completed' || status === 'partial'
      ? (output.countCoverage === 'complete' ? 'Found ' : 'Reported at least ') + String(output.occurrenceCount) + ' occurrences on '
        + (output.countCoverage === 'complete' ? '' : 'at least ') + String(output.matchingLineCount) + ' lines in ' + String(output.matchingFileCount) + ' files.'
      : 'Search failed: ' + status + '.',
    scope,
    evidence: builtInReadEvidence(
      'search',
      scope,
      `Searched ${String(output.examinedFileCount)} files and reported ${String(output.occurrenceCount)} occurrences.`,
      {
        outcome: status === 'completed' || status === 'partial' ? 'success' : 'failure',
        confidence: output.countsCapped || output.outputTruncated ? 'unverified' : 'verified'
      }
    ),
    output
  };
}

async function runRipgrep(cwd: string, args: readonly string[], maxOutputBytes: number, mode: SearchTextInput['mode'], perFileLimit?: number, signal?: AbortSignal): Promise<SearchAggregate> {
  const aggregate: SearchAggregate = { files: new Set(), counts: new Map(), matches: [], contexts: new Map(), matchingLineCount: 0, occurrenceCount: 0, examinedFileCount: 0, status: 'completed', perFileOmissions: new Map(), outputTruncated: false };
  let child;
  try { child = spawn('rg', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) }); }
  catch (error) { aggregate.status = code(error) === 'ENOENT' ? 'missing_ripgrep' : signal?.aborted ? 'aborted' : 'failed'; aggregate.diagnostic = message(error); return aggregate; }
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = ''; let stderr = ''; let observedBytes = 0; let spawnError: unknown;
  const bounded = (chunk: string): string => {
    const remaining = Math.max(0, maxOutputBytes - observedBytes);
    observedBytes += Buffer.byteLength(chunk, 'utf8');
    if (Buffer.byteLength(chunk, 'utf8') <= remaining) return chunk;
    aggregate.status = 'output_limit'; aggregate.outputTruncated = true; child.kill('SIGTERM');
    return takeUtf8(chunk, remaining);
  };
  child.stdout.on('data', (chunk: string) => {
    stdout += bounded(chunk);
    const lines = stdout.split('\n'); stdout = lines.pop() ?? '';
    for (const line of lines) consume(line, aggregate, mode, perFileLimit);
  });
  child.stderr.on('data', (chunk: string) => { stderr += bounded(chunk); });
  child.once('error', (error) => { spawnError = error; });
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
  if (stdout.length > 0) {
    const complete = consume(stdout, aggregate, mode, perFileLimit);
    if (!complete) {
      aggregate.outputTruncated = true;
      if (aggregate.status === 'completed') aggregate.status = 'output_limit';
      aggregate.diagnostic = 'ripgrep output ended in the middle of a JSON event.';
    }
  }
  const diagnostic = stderr.trim();
  if (spawnError) {
    aggregate.status = code(spawnError) === 'ENOENT' ? 'missing_ripgrep' : signal?.aborted ? 'aborted' : 'failed';
    aggregate.diagnostic = message(spawnError);
  } else if (signal?.aborted) {
    aggregate.status = 'aborted'; aggregate.diagnostic = message(signal.reason);
  } else if (aggregate.status === 'output_limit') {
    aggregate.diagnostic = [aggregate.diagnostic, 'ripgrep output exceeded the host byte limit; a terminal JSON event may be incomplete.'].filter(Boolean).join(' ');
  } else if (exitCode === 2) {
    aggregate.status = /regex parse error|error parsing regex|invalid regular expression/iu.test(diagnostic) ? 'invalid_pattern' : /permission denied|I\/O error|no such file/iu.test(diagnostic) ? 'io_error' : 'failed';
    aggregate.diagnostic = diagnostic || 'ripgrep rejected the search request.';
  } else if (exitCode !== 0 && exitCode !== 1) {
    aggregate.status = 'failed'; aggregate.diagnostic = diagnostic || 'ripgrep exited with code ' + String(exitCode) + '.';
  }
  return aggregate;
}
function consume(line: string, aggregate: SearchAggregate, mode: SearchTextInput['mode'], perFileLimit?: number): boolean {
  if (line.trim().length === 0) return true;
  let event: unknown;
  try { event = JSON.parse(line); } catch { return false; }
  if (!record(event) || typeof event.type !== 'string' || !record(event.data)) return true;
  if (event.type === 'summary' && record(event.data.stats)) {
    const searches = event.data.stats.searches;
    if (typeof searches === 'number' && Number.isSafeInteger(searches) && searches >= 0) aggregate.examinedFileCount = searches;
    return true;
  }
  if (event.type !== 'match' && event.type !== 'context') return true;
  const data = event.data as RipgrepData;
  const rawFile = data.path?.text; const lineNumber = data.line_number;
  if (typeof rawFile !== 'string' || typeof lineNumber !== 'number') return true;
  const file = rawFile.replaceAll('\\', '/').replace(/^\.\//u, '');
  const text = data.lines?.text?.replace(/\r?\n$/u, '') ?? '';
  let contexts = aggregate.contexts.get(file);
  if (!contexts) { contexts = new Map(); aggregate.contexts.set(file, contexts); }
  contexts.set(lineNumber, text);
  if (event.type === 'context') return true;
  const occurrences = (data.submatches ?? []).map((match) => ({ startByte: match.start ?? 0, endByte: match.end ?? match.start ?? 0, text: match.match?.text ?? '' }));
  const count = aggregate.counts.get(file) ?? { matchingLineCount: 0, occurrenceCount: 0 };
  aggregate.files.add(file);
  if (perFileLimit !== undefined && count.matchingLineCount >= perFileLimit) {
    aggregate.perFileOmissions.set(file, (aggregate.perFileOmissions.get(file) ?? 0) + 1);
    return true;
  }
  aggregate.matchingLineCount += 1; aggregate.occurrenceCount += occurrences.length;
  count.matchingLineCount += 1; count.occurrenceCount += occurrences.length; aggregate.counts.set(file, count);
  if (mode === 'matches') aggregate.matches.push({ path: file, lineNumber, text, occurrences });
  return true;
}
function range(start: number, end: number): number[] { const output: number[] = []; for (let value = Math.max(1, start); value <= end; value += 1) output.push(value); return output; }
function takeUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] ?? 0) >>> 6 === 0b10) end -= 1;
  const lead = bytes[end];
  if (lead !== undefined) {
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (end + width > maxBytes) { /* Exclude the incomplete final code point. */ }
    else end = maxBytes;
  }
  return bytes.subarray(0, end).toString('utf8');
}
function compare(a: string, b: string): number { return a.localeCompare(b, 'en'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function code(error: unknown): string | undefined { return record(error) && typeof error.code === 'string' ? error.code : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
