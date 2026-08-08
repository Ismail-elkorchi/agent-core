import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
