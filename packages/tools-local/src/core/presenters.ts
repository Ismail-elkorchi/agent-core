import { parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import type { ToolDefinition, ToolObservationPresentation } from '@agent-core/tools';

type Presenter = NonNullable<ToolDefinition['presentObservation']>;

export const presentListDirectoryObservation: Presenter = ({ observation, maxTokens }) => {
  const failure = failurePresentation('Directory listing', observation);
  if (failure) return failure;
  const output = object(observation.output);
  const entries = array(output.entries).filter(isObject);
  const base = resultBase('Directory listing', observation, {
    path: value(output.path), counts: value(output.counts), coverage: value(output.coverage),
    causes: value(output.causes), omitted: value(output.omitted)
  });
  const selected: JsonValue[] = [];
  const groups = new Map<string, JsonObject[]>();
  for (const entry of entries) {
    const entryPath = typeof entry.path === 'string' ? entry.path : '';
    const top = entryPath.split('/')[0] ?? '';
    const group = groups.get(top) ?? [];
    group.push(entry);
    groups.set(top, group);
  }
  let index = 0;
  while (groups.size > 0) {
    let added = false;
    for (const key of [...groups.keys()].sort(compare)) {
      const entry = groups.get(key)?.[index];
      if (!entry) { groups.delete(key); continue; }
      if (fits({ ...base, results: { ...object(base.results), entries: [...selected, entry] } }, maxTokens)) {
        selected.push(entry);
        added = true;
      }
    }
    if (!added) break;
    index += 1;
  }
  const omissionSamples = boundedArray(array(output.omissionSamples), { ...base, results: { ...object(base.results), entries: selected } }, 'omissionSamples', maxTokens);
  return withResults(base, { ...object(base.results), entries: selected, omissionSamples }, observation.scope.coverage === 'partial'
    ? 'Use a narrower path or larger host limits to inspect omitted directory entries.' : undefined);
};

export const presentFindFilesObservation: Presenter = ({ observation, maxTokens }) => {
  const failure = failurePresentation('File search', observation);
  if (failure) return failure;
  const output = object(observation.output);
  const base = resultBase('File search', observation, {
    path: value(output.path), patterns: value(output.patterns), counts: value(output.counts), coverage: value(output.coverage),
    causes: value(output.causes), omitted: value(output.omitted)
  });
  const paths = array(output.entries).filter(isObject).sort((a, b) => compare(stringField(a.path), stringField(b.path)));
  const entries: JsonValue[] = [];
  for (const entry of paths) {
    if (!fits({ ...base, results: { ...object(base.results), entries: [...entries, entry] } }, maxTokens)) break;
    entries.push(entry);
  }
  const omissionSamples = boundedArray(array(output.omissionSamples), { ...base, results: { ...object(base.results), entries } }, 'omissionSamples', maxTokens);
  return withResults(base, { ...object(base.results), entries, omissionSamples }, observation.scope.coverage === 'partial'
    ? 'Narrow the patterns or continue with a more specific path.' : undefined);
};

export const presentReadFilesObservation: Presenter = ({ observation, maxTokens }) => {
  const failure = failurePresentation('File contents', observation);
  if (failure) return failure;
  const output = object(observation.output);
  const sourceFiles = array(output.files).filter(isObject);
  let files: JsonObject[] = sourceFiles.map((file) => ({
    path: value(file.path), startLine: value(file.startLine), lineCount: value(file.lineCount), eof: value(file.eof),
    fileBytes: value(file.fileBytes), rangeSha256: value(file.rangeSha256), fullFileSha256: value(file.fullFileSha256),
    rangeLineEnding: value(file.rangeLineEnding), ...(file.nextStartLine === undefined ? {} : { continuationLine: value(file.nextStartLine) }), content: ''
  }));
  const base = resultBase('File contents', observation, {
    requestedFiles: value(output.requestedFiles), returnedFiles: value(output.returnedFiles), failedFiles: value(output.failedFiles),
    returnedBytes: value(output.returnedBytes), coverage: value(output.coverage), failures: compactReadFailures(array(output.failures), 512), files
  });
  if (!fits(base, maxTokens)) {
    files = files.map((file) => ({ ...file, content: '' }));
    const compactBase = resultBase('File contents', observation, {
      requestedFiles: value(output.requestedFiles), returnedFiles: value(output.returnedFiles), failedFiles: value(output.failedFiles),
      returnedBytes: value(output.returnedBytes), coverage: value(output.coverage), failures: compactReadFailures(array(output.failures), 96), files
    });
    Object.assign(base, compactBase);
  }
  let remaining = Math.max(0, maxTokens * 4 - jsonBytes(base) - 64);
  const sources = sourceFiles.map((file) => typeof file.content === 'string' ? file.content : '');
  for (let index = 0; index < files.length; index += 1) {
    const share = Math.max(0, Math.floor(remaining / Math.max(1, files.length - index)));
    const excerpt = takeChars(sources[index] ?? '', share);
    files[index] = { ...files[index], content: excerpt, ...(excerpt.length < (sources[index]?.length ?? 0) ? { contentOmittedCharacters: (sources[index]?.length ?? 0) - excerpt.length } : {}) };
    remaining -= excerpt.length;
  }
  const next = observation.scope.coverage === 'partial'
    ? 'Continue each file from its continuationLine, or correct the reported failures.' : undefined;
  let presentation = withResults(base, { ...object(base.results), files }, next);
  while (!fits(presentation, maxTokens) && files.some((file) => typeof file.content === 'string' && file.content.length > 1)) {
    files = files.map((file, index) => {
      const content = typeof file.content === 'string' ? file.content : '';
      const shortened = takeChars(content, Math.max(1, Math.floor(content.length * 0.75)));
      return { ...file, content: shortened, contentOmittedCharacters: Math.max(0, (sources[index]?.length ?? 0) - shortened.length) };
    });
    presentation = withResults(base, { ...object(base.results), files }, next);
  }
  return presentation;
};

export const presentSearchTextObservation: Presenter = ({ observation, maxTokens }) => {
  const failure = failurePresentation('Text search', observation);
  if (failure) return failure;
  const output = object(observation.output);
  const fixed = {
    query: value(output.query), mode: value(output.mode), status: value(output.status),
    resultCoverage: value(output.resultCoverage), countCoverage: value(output.countCoverage),
    examinedFileCount: value(output.examinedFileCount), matchingFileCount: value(output.matchingFileCount),
    matchingLineCount: value(output.matchingLineCount), occurrenceCount: value(output.occurrenceCount),
    omittedResultCount: value(output.omittedResultCount), countsCapped: value(output.countsCapped),
    omittedResultCountIsLowerBound: value(output.omittedResultCountIsLowerBound), outputTruncated: value(output.outputTruncated),
    perFileOmissions: value(output.perFileOmissions), diagnostic: value(output.diagnostic)
  };
  const base = resultBase('Text search', observation, fixed);
  const source = array(output.results);
  const selected: JsonValue[] = [];
  if (output.mode === 'matches') {
    const matches = source.filter(isObject).map((match) => compactMatch(match, Math.max(96, Math.floor(maxTokens * 3 / Math.max(1, source.length)))));
    const firstByFile = new Map<string, JsonObject>();
    for (const match of matches) if (!firstByFile.has(stringField(match.path))) firstByFile.set(stringField(match.path), match);
    for (const match of firstByFile.values()) {
      if (!fits({ ...base, results: { ...fixed, results: [...selected, match] } }, maxTokens)) break;
      selected.push(match);
    }
    for (const match of matches) {
      if (selected.includes(match)) continue;
      if (!fits({ ...base, results: { ...fixed, results: [...selected, match] } }, maxTokens)) break;
      selected.push(match);
    }
  } else {
    for (const item of source) {
      if (!fits({ ...base, results: { ...fixed, results: [...selected, item] } }, maxTokens)) break;
      selected.push(item);
    }
  }
  return withResults(base, { ...fixed, results: selected }, observation.scope.coverage === 'partial'
    ? 'Narrow the query or increase the relevant result and per-file limits.' : undefined);
};

export const presentApplyPatchObservation: Presenter = ({ observation, maxTokens }) => {
  const failure = failurePresentation('Patch transaction', observation);
  if (failure) return failure;
  const output = object(observation.output);
  const files = array(output.files).filter(isObject).map((file) => ({
    path: value(file.path), operation: value(file.operation), destinationPath: value(file.destinationPath),
    additions: value(file.additions), deletions: value(file.deletions), plannedChange: value(file.plannedChange), finalState: value(file.finalState)
  }));
  const affectedPaths = uniqueStrings([
    ...array(output.changedPaths), ...array(output.wouldChangePaths), ...array(output.potentiallyAffectedPaths),
    ...files.flatMap((file) => [file.path, file.destinationPath]).filter((item): item is string => typeof item === 'string')
  ]);
  const base = resultBase('Patch transaction', observation, {});
  let results: JsonObject = {
    operationStatus: value(output.operationStatus), transactionOutcome: value(output.transactionOutcome), workspaceState: value(output.workspaceState), dryRun: value(output.dryRun),
    files, affectedPaths, changedPaths: value(output.changedPaths), wouldChangePaths: value(output.wouldChangePaths),
    createdPaths: value(output.createdPaths), deletedPaths: value(output.deletedPaths), movedPaths: value(output.movedPaths),
    potentiallyAffectedPaths: value(output.potentiallyAffectedPaths), totalOperationCount: value(output.totalOperationCount),
    totalHunkCount: value(output.totalHunkCount), totalAdditions: value(output.totalAdditions), totalDeletions: value(output.totalDeletions),
    transaction: compactTransaction(output.transaction, 512)
  };
  if (!fits({ ...base, results }, maxTokens)) {
    results = {
      operationStatus: value(output.operationStatus), transactionOutcome: value(output.transactionOutcome), workspaceState: value(output.workspaceState), files, affectedPaths,
      totalOperationCount: value(output.totalOperationCount), totalAdditions: value(output.totalAdditions), totalDeletions: value(output.totalDeletions),
      transaction: compactTransaction(output.transaction, 96)
    };
  }
  return withResults(base, results);
};

export const presentProcessObservation: Presenter = ({ observation, maxTokens }) => {
  const failure = failurePresentation('Process', observation);
  if (failure) return failure;
  const output = object(observation.output);
  const combined = object(output.combined);
  const fixed = {
    status: value(output.status), processId: value(output.processId), exitCode: value(output.exitCode), signal: value(output.signal),
    cursorStart: value(output.cursorStart), cursorEnd: value(output.cursorEnd), cursorExpired: value(output.cursorExpired),
    omittedBytes: value(combined.omittedBytes), artifact: value(output.artifact), diagnostic: value(output.diagnostic),
    progressDroppedEvents: value(output.progressDroppedEvents), progressDeliveryErrors: value(output.progressDeliveryErrors)
  };
  const base = resultBase('Process', observation, fixed);
  const text = typeof combined.text === 'string' ? combined.text : '';
  const available = Math.max(0, maxTokens * 4 - jsonBytes(base) - 96);
  const tail = takeTailChars(text, available);
  return withResults(base, { ...fixed, outputTail: tail, outputTailOmittedCharacters: Math.max(0, text.length - tail.length) });
};

export const presentReadArtifactObservation: Presenter = ({ observation, maxTokens }) => {
  const failure = failurePresentation('Artifact range', observation);
  if (failure) return failure;
  const output = object(observation.output);
  const artifact = object(output.artifact);
  const fixed = {
    artifactId: value(artifact.artifactId), mediaType: value(artifact.mediaType), fullSize: value(output.fullSize),
    returnedRange: value(output.returnedRange), returnedBytes: value(output.returnedBytes), contentType: value(output.contentType),
    ...(output.nextOffset === undefined ? {} : { nextOffset: value(output.nextOffset) })
  };
  const base = resultBase('Artifact range', observation, fixed);
  const text = typeof output.text === 'string' ? output.text : undefined;
  const available = Math.max(0, maxTokens * 4 - jsonBytes(base) - 64);
  const results = text === undefined ? fixed : { ...fixed, textExcerpt: takeChars(text, available), textOmittedCharacters: Math.max(0, text.length - available) };
  return withResults(base, results, typeof output.nextOffset === 'number' ? `Continue at byte offset ${String(output.nextOffset)}.` : undefined);
};

function failurePresentation(title: string, observation: Parameters<Presenter>[0]['observation']): ToolObservationPresentation | undefined {
  if (observation.kind !== 'failure') return undefined;
  return {
    ok: false, title, summary: observation.summary, scope: parseJsonValue(observation.scope) as JsonObject,
    failures: parseJsonValue(observation.output), coverage: observation.scope.coverage, next: observation.output.recovery
  };
}
function resultBase(title: string, observation: Parameters<Presenter>[0]['observation'], results: JsonObject): ToolObservationPresentation {
  return {
    ok: observation.ok, title, summary: observation.summary, scope: parseJsonValue(observation.scope) as JsonObject,
    results: parseJsonValue(results), coverage: observation.scope.coverage,
    ...(observation.scope.omitted ? { omitted: observation.scope.omitted } : {}),
    ...(observation.scope.causes?.length ? { warnings: [...observation.scope.causes] } : {})
  };
}
function withResults(base: ToolObservationPresentation, results: JsonObject, next?: string): ToolObservationPresentation {
  return { ...base, results: parseJsonValue(results), ...(next ? { next } : {}) };
}
function compactMatch(match: JsonObject, maxTextChars: number): JsonObject {
  return {
    path: value(match.path), lineNumber: value(match.lineNumber), occurrences: value(match.occurrences),
    text: typeof match.text === 'string' ? takeChars(match.text, maxTextChars) : '',
    ...(match.context === undefined ? {} : { context: match.context })
  };
}
function value(value: JsonValue | undefined): JsonValue { return value === undefined ? null : value; }
function stringField(value: JsonValue | undefined): string { return typeof value === 'string' ? value : ''; }
function object(value: unknown): JsonObject { const parsed = parseJsonValue(value); return isObject(parsed) ? parsed : {}; }
function array(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : []; }
function isObject(value: JsonValue | undefined): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function fits(value: unknown, maxTokens: number): boolean { return jsonBytes(value) <= Math.max(1, maxTokens) * 4; }
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
function takeChars(value: string, count: number): string {
  const characters = Array.from(GRAPHEME_SEGMENTER.segment(value), (item) => item.segment);
  return characters.length <= count ? value : characters.slice(0, Math.max(0, count)).join('');
}
function takeTailChars(value: string, count: number): string {
  const characters = Array.from(GRAPHEME_SEGMENTER.segment(value), (item) => item.segment);
  return characters.length <= count ? value : characters.slice(Math.max(0, characters.length - count)).join('');
}
function compare(left: string, right: string): number { return left.localeCompare(right, 'en'); }
function boundedArray(source: JsonValue[], base: unknown, key: string, maxTokens: number): JsonValue[] {
  const selected: JsonValue[] = [];
  const parsedBase = parseJsonValue(base);
  const baseObject = isObject(parsedBase) ? parsedBase : {};
  for (const item of source) {
    if (!fits({ ...baseObject, [key]: [...selected, item] }, maxTokens)) break;
    selected.push(item);
  }
  return selected;
}
function compactReadFailures(source: JsonValue[], messageChars: number): JsonValue[] {
  return source.filter(isObject).map((failure) => ({
    path: value(failure.path), reason: value(failure.reason),
    message: typeof failure.message === 'string' ? takeChars(failure.message, messageChars) : ''
  }));
}
function compactTransaction(value: JsonValue | undefined, messageChars: number): JsonValue {
  if (!isObject(value)) return null;
  const output: JsonObject = { outcome: value.outcome ?? null };
  if (isObject(value.failure)) output.failure = compactTransactionDiagnostic(value.failure, messageChars);
  for (const key of ['cleanup', 'rollback']) {
    const recovery = value[key];
    if (!isObject(recovery)) continue;
    output[key] = {
      status: recovery.status ?? null,
      strandedPaths: recovery.strandedPaths ?? [],
      diagnostics: array(recovery.diagnostics).filter(isObject).map((item) => compactTransactionDiagnostic(item, messageChars))
    };
  }
  return output;
}
function compactTransactionDiagnostic(value: JsonObject, messageChars: number): JsonObject {
  return {
    operation: value.operation ?? null, path: value.path ?? null, code: value.code ?? null,
    message: typeof value.message === 'string' ? takeChars(value.message, messageChars) : ''
  };
}
function uniqueStrings(values: JsonValue[]): JsonValue[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort(compare);
}
