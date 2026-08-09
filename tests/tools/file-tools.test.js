import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, rename, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareToolCall } from '@agent-core/tools';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  WorkspaceFileSelector,
  findFilesTool,
  listDirectoryTool,
  readFilesTool,
  requireLocalToolConfiguration,
  searchTextTool
} from '@agent-core/tools-local';

const tools = [listDirectoryTool, findFilesTool, readFilesTool, searchTextTool];
const policy = { allowedRisks: ['read'] };

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-file-tools-'));
  const configuration = DEFAULT_LOCAL_TOOL_CONFIGURATION;
  return {
    root,
    context: {
      policy,
      services: {
        workspaceRoot: root,
        localToolConfiguration: configuration,
        workspaceFileSelector: new WorkspaceFileSelector(root, configuration.fileSelection)
      }
    }
  };
}

test('directory and path selection are sorted, Git-aware, hidden-safe, and match root globs', async () => {
  const { root, context } = await workspace();
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, '.hidden'));
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\nignored-dir/\n');
  await writeFile(path.join(root, 'z.ts'), 'z\n');
  await writeFile(path.join(root, 'a.ts'), 'a\n');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored\n');
  await writeFile(path.join(root, 'skip.tmp'), 'skip\n');
  await writeFile(path.join(root, '.secret'), 'secret\n');
  await writeFile(path.join(root, '.hidden', 'deep.ts'), 'hidden\n');
  await writeFile(path.join(root, 'src', 'b.ts'), 'b\n');

  const listed = await invokeToolCall(jsonToolCall('list_directory', { depth: 2 }), tools, context);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.output.entries.map((entry) => entry.path), [...listed.output.entries.map((entry) => entry.path)].sort((a, b) => a.localeCompare(b, 'en')));
  assert.equal(listed.output.entries.some((entry) => entry.path === 'ignored.txt'), false);
  assert.equal(listed.output.entries.some((entry) => entry.path === '.secret'), false);
  assert.equal(listed.output.counts.omitted.count > 0, true);
  assert.equal(listed.output.counts.omitted.relation, 'exact');
  assert.equal(listed.output.omissionSamples.some((entry) => entry.reason === 'hidden'), true);
  assert.equal(listed.output.omissionSamples.some((entry) => entry.reason === 'gitignored'), true);
  assert.deepEqual(listed.output.counts, {
    visited: listed.output.counts.visited,
    returned: listed.output.entries.length,
    omitted: listed.output.counts.omitted
  });

  const rootGlob = await invokeToolCall(jsonToolCall('find_files', { patterns: ['*.ts'] }), tools, context);
  assert.equal(rootGlob.ok, true);
  assert.deepEqual(rootGlob.output.entries.map((entry) => entry.path), ['a.ts', 'z.ts']);

  const excluded = await invokeToolCall(jsonToolCall('list_directory', { exclude: ['*.tmp'] }), tools, context);
  assert.equal(excluded.output.entries.some((entry) => entry.path === 'skip.tmp'), false);
  assert.equal(excluded.output.omissionSamples.some((entry) => entry.path === 'skip.tmp' && entry.reason === 'excluded'), true);

  const shallowConfiguration = {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    fileSelection: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.fileSelection, maxDepth: 1 }
  };
  const shallowContext = {
    ...context,
    services: {
      ...context.services,
      localToolConfiguration: shallowConfiguration,
      workspaceFileSelector: new WorkspaceFileSelector(root, shallowConfiguration.fileSelection)
    }
  };
  const clampedDepth = await invokeToolCall(jsonToolCall('list_directory', { depth: 99 }), tools, shallowContext);
  assert.equal(clampedDepth.output.entries.some((entry) => entry.path === 'src/b.ts'), false);

  const hidden = await invokeToolCall(jsonToolCall('find_files', { patterns: ['**/*'], includeHidden: true, respectGitIgnore: false }), tools, context);
  assert.equal(hidden.output.entries.some((entry) => entry.path === '.secret'), true);
  assert.equal(hidden.output.entries.some((entry) => entry.path === '.hidden/deep.ts'), true);
  assert.equal(hidden.output.entries.some((entry) => entry.path === 'ignored.txt'), true);

  const hiddenTypescript = await invokeToolCall(jsonToolCall('find_files', { patterns: ['**/*.ts'], includeHidden: true, respectGitIgnore: false }), tools, context);
  assert.equal(hiddenTypescript.output.entries.some((entry) => entry.path === '.hidden/deep.ts'), true);
  assert.equal(hiddenTypescript.output.entries.every((entry) => entry.path.endsWith('.ts')), true);
});

test('local tool hosts retain an owned configuration snapshot after caller mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-config-snapshot-'));
  await writeFile(path.join(root, 'one.txt'), 'one\n');
  await writeFile(path.join(root, 'two.txt'), 'two\n');
  const callerOwned = JSON.parse(JSON.stringify(DEFAULT_LOCAL_TOOL_CONFIGURATION));
  const localToolConfiguration = requireLocalToolConfiguration({ services: { localToolConfiguration: callerOwned } });
  const context = { policy, services: { workspaceRoot: root, localToolConfiguration } };

  callerOwned.readFiles.maxFiles = 1;
  callerOwned.readFiles.unexpected = 10;
  const observation = await invokeToolCall(jsonToolCall('read_files', { files: [{ path: 'one.txt' }, { path: 'two.txt' }] }), [readFilesTool], context);
  assert.equal(observation.output.returnedFiles, 2);
  assert.equal(localToolConfiguration.readFiles.maxFiles, DEFAULT_LOCAL_TOOL_CONFIGURATION.readFiles.maxFiles);
  assert.equal(Object.isFrozen(localToolConfiguration.readFiles), true);

  const invalid = JSON.parse(JSON.stringify(DEFAULT_LOCAL_TOOL_CONFIGURATION));
  invalid.readFiles.unexpected = 10;
  assert.throws(() => requireLocalToolConfiguration({ services: { localToolConfiguration: invalid } }), /fields are invalid/iu);
});

test('directory traversal continues with partial coverage after an unreadable branch', async (t) => {
  const { root, context } = await workspace();
  await mkdir(path.join(root, 'readable'));
  await mkdir(path.join(root, 'unreadable'));
  await writeFile(path.join(root, 'readable', 'kept.txt'), 'kept\n');
  await writeFile(path.join(root, 'unreadable', 'hidden.txt'), 'hidden\n');
  await chmod(path.join(root, 'unreadable'), 0o000);
  t.after(async () => chmod(path.join(root, 'unreadable'), 0o700));
  const result = await invokeToolCall(jsonToolCall('list_directory', { depth: 2 }), tools, context);
  assert.equal(result.output.entries.some((entry) => entry.path === 'readable/kept.txt'), true);
  if (process.getuid?.() !== 0) {
    assert.equal(result.output.coverage, 'partial');
    assert.equal(result.output.omissionSamples.some((entry) => entry.reason === 'unreadable'), true);
  }
});

test('list_directory depth is structural and find_files still traverses to the host depth', async () => {
  const { root, context } = await workspace();
  await mkdir(path.join(root, 'a-deep'));
  await mkdir(path.join(root, 'a-deep', 'branch'));
  await mkdir(path.join(root, 'z-other'));
  await writeFile(path.join(root, 'a-deep', 'branch', 'deep.txt'), 'deep\n');
  await writeFile(path.join(root, 'a-deep', 'first.txt'), 'first\n');
  await writeFile(path.join(root, 'z-other', 'second.txt'), 'second\n');
  await writeFile(path.join(root, 'top.txt'), 'top\n');

  const shallowLimits = { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.fileSelection, maxVisitedEntries: 3 };
  const shallowConfiguration = { ...DEFAULT_LOCAL_TOOL_CONFIGURATION, fileSelection: shallowLimits };
  const shallowContext = { ...context, services: { ...context.services, localToolConfiguration: shallowConfiguration, workspaceFileSelector: new WorkspaceFileSelector(root, shallowLimits) } };
  const shallow = await invokeToolCall(jsonToolCall('list_directory', { depth: 1 }), tools, shallowContext);
  assert.deepEqual(shallow.output.entries.map(entry => entry.path), ['a-deep', 'top.txt', 'z-other']);
  assert.equal(shallow.output.counts.visited, 3);
  assert.equal(shallow.output.coverage, 'complete');
  assert.equal(shallow.output.causes.includes('visit_limit'), false);

  const hostLimited = { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.fileSelection, maxDepth: 1 };
  const hostConfiguration = { ...DEFAULT_LOCAL_TOOL_CONFIGURATION, fileSelection: hostLimited };
  const hostContext = { ...context, services: { ...context.services, localToolConfiguration: hostConfiguration, workspaceFileSelector: new WorkspaceFileSelector(root, hostLimited) } };
  const requestedDeeper = await invokeToolCall(jsonToolCall('list_directory', { depth: 3 }), tools, hostContext);
  assert.equal(requestedDeeper.output.coverage, 'partial');
  assert.equal(requestedDeeper.output.causes.includes('host_depth_limit'), true);
  assert.equal(requestedDeeper.output.counts.omitted.relation, 'at_least');
  assert.equal(requestedDeeper.output.entries.some(entry => entry.path === 'a-deep/first.txt'), false);

  const found = await invokeToolCall(jsonToolCall('find_files', { patterns: ['**/*.txt'] }), tools, context);
  assert.deepEqual(found.output.entries.map(entry => entry.path), ['a-deep/branch/deep.txt', 'a-deep/first.txt', 'top.txt', 'z-other/second.txt']);
  const hostFound = await invokeToolCall(jsonToolCall('find_files', { patterns: ['**/*.txt'] }), tools, hostContext);
  assert.equal(hostFound.output.coverage, 'partial');
  assert.equal(hostFound.output.causes.includes('host_depth_limit'), true);
  assert.equal(hostFound.output.counts.omitted.relation, 'at_least');
});

test('read_files streams large ranges, preserves batch failures, and hashes raw selected bytes', async () => {
  const { root, context } = await workspace();
  const prefix = 'ignored-before-range\n'.repeat(150_000);
  await writeFile(path.join(root, 'large.txt'), `${prefix}target-one\r\ntarget-two\r\ntail\r\n`);
  await writeFile(path.join(root, 'raw.txt'), Buffer.from('one\r\ntwo\r\n'));

  const startLine = 150_001;
  const result = await invokeToolCall(jsonToolCall('read_files', {
    files: [{ path: 'large.txt', startLine, lineCount: 2 }, { path: 'raw.txt', lineCount: 1 }, { path: 'missing.txt' }]
  }), tools, context);
  assert.equal(result.kind, 'result');
  assert.equal(result.ok, false, 'a completed partial batch is a negative tool result, not a tool failure');
  assert.equal(result.output.coverage, 'partial');
  assert.equal(result.output.files[0].content, 'target-one\r\ntarget-two\r\n');
  assert.equal(result.output.files[0].nextStartLine, startLine + 2);
  assert.equal(result.output.files[0].eof, false);
  assert.equal(result.output.files[1].rangeSha256, createHash('sha256').update(Buffer.from('one\r\n')).digest('hex'));
  assert.equal(result.output.files[1].rangeLineEnding, 'crlf');
  assert.equal(result.output.files[1].fullFileSha256, undefined);
  assert.deepEqual(result.output.failures.map((failure) => failure.reason), ['not_found']);

  const full = await invokeToolCall(jsonToolCall('read_files', { files: [{ path: 'raw.txt', lineCount: 10 }] }), tools, context);
  assert.equal(full.output.files[0].eof, true);
  assert.equal(full.output.files[0].fullFileSha256, createHash('sha256').update(Buffer.from('one\r\ntwo\r\n')).digest('hex'));
});

test('search_text delegates regex validation to ripgrep and separates line and occurrence counts', async () => {
  const { root, context } = await workspace();
  await writeFile(path.join(root, 'matches.txt'), 'foo foo\nfoo\nnone\n');
  const result = await invokeToolCall(jsonToolCall('search_text', { query: 'foo', mode: 'matches' }), tools, context);
  assert.equal(result.ok, true);
  assert.equal(result.output.matchingLineCount, 2);
  assert.equal(result.output.occurrenceCount, 3);
  assert.equal(result.output.examinedFileCount >= 1, true);

  await writeFile(path.join(root, 'other.txt'), 'foo foo foo\n');
  const counts = await invokeToolCall(jsonToolCall('search_text', { query: 'foo', mode: 'count' }), tools, context);
  assert.deepEqual(counts.output.results.map((entry) => [entry.path, entry.matchingLineCount, entry.occurrenceCount]), [
    ['matches.txt', 2, 3],
    ['other.txt', 1, 3]
  ]);
  const limitedFiles = await invokeToolCall(jsonToolCall('search_text', { query: 'foo', mode: 'files', resultLimit: 1 }), tools, context);
  assert.equal(limitedFiles.output.results.length, 1);
  assert.equal(limitedFiles.output.omittedResultCount, 1);
  assert.equal(limitedFiles.output.resultCoverage, 'partial');
  assert.equal(limitedFiles.output.countCoverage, 'complete');

  const invalid = await invokeToolCall(jsonToolCall('search_text', { query: '[', mode: 'files' }), tools, context);
  assert.equal(invalid.kind, 'result');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.output.status, 'invalid_pattern');
  assert.match(invalid.output.diagnostic, /regex|unclosed|invalid/iu);

  await mkdir(path.join(root, 'empty'));
  const invalidWithoutFiles = await invokeToolCall(jsonToolCall('search_text', { query: '[', path: 'empty', mode: 'files' }), tools, context);
  assert.equal(invalidWithoutFiles.output.status, 'invalid_pattern');
});

test('nested gitignore negation, ignore limits, and visit limits are deterministic', async () => {
  const { root, context } = await workspace();
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, '.gitignore'), 'root-ignore.txt\n');
  await writeFile(path.join(root, 'root-ignore.txt'), 'ignored\n');
  await writeFile(path.join(root, 'nested', '.gitignore'), '*.log\n!important.log\n');
  await writeFile(path.join(root, 'nested', 'a.log'), 'ignored\n');
  await writeFile(path.join(root, 'nested', 'important.log'), 'kept\n');
  await Promise.all(Array.from({ length: 10 }, (_unused, index) => writeFile(path.join(root, `file-${String(index).padStart(2, '0')}.txt`), 'x')));
  const nested = await invokeToolCall(jsonToolCall('find_files', { patterns: ['**/*'], includeHidden: true }), tools, context);
  assert.equal(nested.output.entries.some((entry) => entry.path === 'nested/a.log'), false);
  assert.equal(nested.output.entries.some((entry) => entry.path === 'nested/important.log'), true);

  const limitedConfiguration = {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    fileSelection: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.fileSelection, maxVisitedEntries: 3, maxIgnoreFiles: 1 }
  };
  const limitedContext = { ...context, services: { ...context.services, localToolConfiguration: limitedConfiguration, workspaceFileSelector: new WorkspaceFileSelector(root, limitedConfiguration.fileSelection) } };
  const limited = await invokeToolCall(jsonToolCall('find_files', { patterns: ['**/*'], includeHidden: true }), tools, limitedContext);
  assert.equal(limited.scope.coverage, 'partial');
  assert.equal(limited.scope.causes.includes('visit_limit'), true);
  assert.equal(limited.output.counts.visited, 3);
});

test('read_files reports precise EOF, UTF-8, and batch limit outcomes', async () => {
  const { root, context } = await workspace();
  await writeFile(path.join(root, 'short.txt'), 'one\ntwo');
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0x66, 0x6f, 0x80, 0x6f]));
  await writeFile(path.join(root, 'second.txt'), 'second');
  const edge = await invokeToolCall(jsonToolCall('read_files', { files: [{ path: 'short.txt', startLine: 9 }, { path: 'invalid.txt' }, { path: 'short.txt' }] }), tools, context);
  assert.deepEqual(edge.output.failures.map((failure) => failure.reason), ['start_after_eof', 'invalid_utf8']);
  assert.equal(edge.output.files[0].content, 'one\ntwo');
  assert.equal(edge.output.files[0].fileBytes, 7);
  assert.equal(edge.output.files[0].eof, true);

  const limitedConfiguration = { ...DEFAULT_LOCAL_TOOL_CONFIGURATION, readFiles: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.readFiles, maxFiles: 1, maxTotalBytes: 4 } };
  const limitedContext = { ...context, services: { ...context.services, localToolConfiguration: limitedConfiguration } };
  const limited = await invokeToolCall(jsonToolCall('read_files', { files: [{ path: 'short.txt' }, { path: 'second.txt' }] }), tools, limitedContext);
  assert.equal(limited.output.failures.some((failure) => failure.reason === 'batch_byte_limit'), true);
  assert.equal(limited.output.failures.some((failure) => failure.reason === 'batch_file_limit'), true);
});

test('read_files handles empty files, unterminated final lines, and UTF-8 split across scan chunks', async () => {
  const { root, context } = await workspace();
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'no-final-newline.txt'), 'one\ntwo');
  await writeFile(path.join(root, 'utf8-boundary.txt'), `${'a'.repeat(65_535)}😀\n`);
  const result = await invokeToolCall(jsonToolCall('read_files', { files: [
    { path: 'empty.txt', startLine: 1 }, { path: 'no-final-newline.txt' }, { path: 'utf8-boundary.txt' }
  ] }), tools, context);
  assert.equal(result.output.files[0].content, '');
  assert.equal(result.output.files[0].lineCount, 0);
  assert.equal(result.output.files[0].fileBytes, 0);
  assert.equal(result.output.files[0].eof, true);
  assert.equal(result.output.files[0].fullFileSha256, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.equal(result.output.files[1].content, 'one\ntwo');
  assert.equal(result.output.files[1].lineCount, 2);
  assert.equal(result.output.files[1].eof, true);
  assert.match(result.output.files[2].content, /😀\n$/u);
});

test('read_files detects replacement, growth, and truncation of an opened file', async () => {
  for (const mutation of ['replace', 'grow', 'truncate']) {
    const { root, context } = await workspace();
    const target = path.join(root, 'changing.txt');
    await writeFile(target, 'line\n'.repeat(1_600_000));
    const configuration = { ...DEFAULT_LOCAL_TOOL_CONFIGURATION, readFiles: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.readFiles, maxBytesPerFile: 16 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 } };
    const changingContext = { ...context, services: { ...context.services, localToolConfiguration: configuration } };
    let mutated = false;
    const emitProgress = async (progress) => {
      if (mutated || progress.stage !== 'file_reading') return;
      mutated = true;
      if (mutation === 'replace') {
        const replacement = path.join(root, 'replacement.txt');
        await writeFile(replacement, 'replacement\n');
        await rename(replacement, target);
      } else if (mutation === 'grow') await appendFile(target, 'growth\n');
      else await truncate(target, 1024);
    };
    const result = await invokeToolCall(jsonToolCall('read_files', { files: [{ path: 'changing.txt' }] }), tools, { ...changingContext, emitProgress });
    assert.equal(mutated, true, mutation);
    assert.equal(result.kind, 'result');
    assert.equal(result.output.failures.some(failure => failure.reason === 'file_changed'), true, mutation);
  }
});

test('read_files observes abort during a long streamed scan', async () => {
  const { root, context } = await workspace();
  await writeFile(path.join(root, 'long.txt'), 'line\n'.repeat(1_600_000));
  const controller = new AbortController();
  const configuration = { ...DEFAULT_LOCAL_TOOL_CONFIGURATION, readFiles: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.readFiles, maxBytesPerFile: 16 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 } };
  const promise = invokeToolCall(jsonToolCall('read_files', { files: [{ path: 'long.txt' }] }), tools, {
    ...context, signal: controller.signal, services: { ...context.services, localToolConfiguration: configuration }
  });
  setTimeout(() => controller.abort('cancel long read'), 1);
  await assert.rejects(promise, /cancel long read|aborted|abort/iu);
});

test('search_text handles long repositories, context, per-file limits, abort, and missing ripgrep', async () => {
  const { root, context } = await workspace();
  const many = path.join(root, 'many'); await mkdir(many);
  await Promise.all(Array.from({ length: 1_200 }, (_unused, index) => {
    const name = `${String(index).padStart(4, '0')}-${'long-path-component-'.repeat(5)}.txt`;
    return writeFile(path.join(many, name), index === 1_199 ? 'before\nneedle\nafter\nneedle\n' : 'nothing\n');
  }));
  const long = await invokeToolCall(jsonToolCall('search_text', { path: 'many', query: 'needle', contextLines: 1, perFileLimit: 1 }), tools, context);
  assert.equal(long.output.status, 'partial');
  assert.deepEqual(long.output.perFileOmissions, [{ path: long.output.results[0].path, cause: 'per_file_limit', retainedMatches: 1, omittedAtLeast: 1 }]);
  assert.equal(long.output.results.length, 1);
  assert.deepEqual(long.output.results[0].context, {
    before: [{ lineNumber: 1, text: 'before' }],
    after: [{ lineNumber: 3, text: 'after' }]
  });

  const controller = new AbortController();
  const call = jsonToolCall('search_text', { path: 'many', query: 'nothing' });
  const preparationContext = { ...context, signal: controller.signal, boundary: { authorizationPolicyId: 'tests/search@1', executionTargetId: root } };
  const prepared = await prepareToolCall(call, [searchTextTool], preparationContext);
  assert.equal(prepared.ok, true);
  const abortedPromise = prepared.prepared.tool.invoke(prepared.prepared.canonicalInput, preparationContext);
  setTimeout(() => controller.abort('search cancelled'), 1);
  const aborted = await abortedPromise;
  assert.equal(aborted.output.status, 'aborted');

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = '';
    const missing = await invokeToolCall(jsonToolCall('search_text', { path: 'many', query: 'needle' }), tools, context);
    assert.equal(missing.output.status, 'missing_ripgrep');
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
});

test('search_text reports independent per-file omissions in matches and files modes while count mode stays exact', async () => {
  const { root, context } = await workspace();
  await writeFile(path.join(root, 'below.txt'), 'needle\n');
  await writeFile(path.join(root, 'at.txt'), 'needle\nneedle\n');
  await writeFile(path.join(root, 'above.txt'), 'needle\nneedle\nneedle\n');
  await writeFile(path.join(root, 'second-above.txt'), 'needle\nneedle\nneedle\nneedle\n');

  const matches = await invokeToolCall(jsonToolCall('search_text', { query: 'needle', mode: 'matches', perFileLimit: 2 }), tools, context);
  assert.equal(matches.output.status, 'partial');
  assert.equal(matches.output.resultCoverage, 'partial');
  assert.equal(matches.output.countCoverage, 'partial');
  assert.deepEqual(matches.output.perFileOmissions.map(item => [item.path, item.cause, item.retainedMatches, item.omittedAtLeast]), [
    ['above.txt', 'per_file_limit', 2, 1], ['second-above.txt', 'per_file_limit', 2, 1]
  ]);
  assert.deepEqual(Object.fromEntries(matches.output.results.reduce((map, item) => map.set(item.path, (map.get(item.path) ?? 0) + 1), new Map())), {
    'above.txt': 2, 'at.txt': 2, 'below.txt': 1, 'second-above.txt': 2
  });

  const counts = await invokeToolCall(jsonToolCall('search_text', { query: 'needle', mode: 'count', perFileLimit: 2 }), tools, context);
  assert.equal(counts.output.status, 'completed');
  assert.equal(counts.output.countsCapped, false);
  assert.equal(counts.output.resultCoverage, 'complete');
  assert.equal(counts.output.countCoverage, 'complete');
  assert.deepEqual(counts.output.results.map(item => [item.path, item.matchingLineCount, item.occurrenceCount]), [
    ['above.txt', 3, 3], ['at.txt', 2, 2], ['below.txt', 1, 1], ['second-above.txt', 4, 4]
  ]);

  const files = await invokeToolCall(jsonToolCall('search_text', { query: 'needle', mode: 'files', perFileLimit: 1 }), tools, context);
  assert.deepEqual(files.output.results, ['above.txt', 'at.txt', 'below.txt', 'second-above.txt']);
  assert.equal(files.output.status, 'partial');
  assert.equal(files.output.resultCoverage, 'complete');
  assert.equal(files.output.countCoverage, 'partial');
  assert.deepEqual(files.output.perFileOmissions.map(item => item.path), ['above.txt', 'at.txt', 'second-above.txt']);
});

test('search_text bounds and parses multi-megabyte ripgrep output without quadratic truncation', async () => {
  const { root, context } = await workspace();
  const line = `needle ${'x'.repeat(1_500)}\n`;
  await writeFile(path.join(root, 'large-search.txt'), line.repeat(2_500));
  const largeConfiguration = {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    searchText: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.searchText, maxResults: 3_000, maxOutputBytes: 6 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024 }
  };
  const large = await invokeToolCall(jsonToolCall('search_text', { query: 'needle', mode: 'matches', resultLimit: 3_000, perFileLimit: 3_000 }), tools, {
    ...context, services: { ...context.services, localToolConfiguration: largeConfiguration }
  });
  assert.equal(large.output.status, 'completed');
  assert.equal(large.output.results.length, 2_500);

  const boundedConfiguration = {
    ...largeConfiguration,
    searchText: { ...largeConfiguration.searchText, maxOutputBytes: 20_000 }
  };
  const bounded = await invokeToolCall(jsonToolCall('search_text', { query: 'needle', mode: 'matches', resultLimit: 3_000, perFileLimit: 3_000 }), tools, {
    ...context, services: { ...context.services, localToolConfiguration: boundedConfiguration }
  });
  assert.equal(bounded.output.status, 'output_limit');
  assert.equal(bounded.output.outputTruncated, true);
  assert.equal(bounded.output.resultCoverage, 'partial');
  assert.equal(bounded.output.countCoverage, 'partial');
  assert.match(bounded.output.diagnostic, /output.*limit|middle.*JSON/iu);
});
