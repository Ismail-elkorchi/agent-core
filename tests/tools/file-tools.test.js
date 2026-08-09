import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  assert.equal(listed.output.counts.omitted > 0, true);
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
  assert.equal(result.output.files[1].lineEnding, 'crlf');
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
  assert.equal(limitedFiles.output.coverage, 'partial');

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

test('search_text handles long repositories, context, per-file limits, abort, and missing ripgrep', async () => {
  const { root, context } = await workspace();
  const many = path.join(root, 'many'); await mkdir(many);
  await Promise.all(Array.from({ length: 1_200 }, (_unused, index) => {
    const name = `${String(index).padStart(4, '0')}-${'long-path-component-'.repeat(5)}.txt`;
    return writeFile(path.join(many, name), index === 1_199 ? 'before\nneedle\nafter\nneedle\n' : 'nothing\n');
  }));
  const long = await invokeToolCall(jsonToolCall('search_text', { path: 'many', query: 'needle', contextLines: 1, perFileLimit: 1 }), tools, context);
  assert.equal(long.output.status, 'completed');
  assert.equal(long.output.results.length, 1);
  assert.deepEqual(long.output.results[0].context, { before: ['before'], after: ['after'] });

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
