import test from 'node:test';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Text } from '@agent-core/tools-local/testing/filesystem';
import { validateToolObservationPresentation } from '@agent-core/tools';
import {
  applyPatchTool,
  listDirectoryTreeTool,
  readTextFilesTool,
  shellCommandTool,
  searchFileTextTool,
  ShellRunner
} from '@agent-core/tools-local';

const readOnlyPolicy = { allowedRisks: ['read'] };
const writePolicy = { allowedRisks: ['read', 'write'] };
const executePolicy = { allowedRisks: ['read', 'execute'] };
const dryRunWritePolicy = { allowedRisks: ['read'], dryRunWrites: true };
const allTools = [listDirectoryTreeTool, searchFileTextTool, readTextFilesTool, applyPatchTool, shellCommandTool];

test('search_file_text returns compact file evidence with caller-controlled filtering', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-search-file-text-'));
  await mkdir(path.join(dir, '.agent-core'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, '.agent-core', 'hidden.txt'), 'Needle hidden ledger\n', 'utf8');
  await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n', 'utf8');
  await writeFile(path.join(dir, 'ignored.txt'), 'Needle ignored by convention only\n', 'utf8');
  await writeFile(path.join(dir, 'docs', 'guide.md'), 'Needle docs\n', 'utf8');
  await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.txt'), 'Needle dependency text\n', 'utf8');
  await writeFile(path.join(dir, 'src', 'index.ts'), 'Needle source\nneedle source again\n', 'utf8');

  assert.equal(searchFileTextTool.jsonSchema.properties.path.default, '.');
  assert.equal(searchFileTextTool.jsonSchema.properties.mode.default, 'literal');
  assert.equal(searchFileTextTool.jsonSchema.properties.caseSensitive.default, false);
  assert.equal(searchFileTextTool.jsonSchema.properties.hidden.default, 'exclude');
  assert.equal(searchFileTextTool.jsonSchema.properties.resultMode.default, 'files');
  assert.deepEqual(searchFileTextTool.jsonSchema.properties.include.default, []);
  assert.deepEqual(searchFileTextTool.jsonSchema.properties.exclude.default, []);
  assert.deepEqual(searchFileTextTool.jsonSchema.required, ['query']);
  assert.match(searchFileTextTool.description, /outside the searched subset/);
  assert.match(searchFileTextTool.description, /applies no ignore-file conventions/);
  assert.match(searchFileTextTool.description, /Absence claims apply only to the exact searched scope/i);
  assert.match(searchFileTextTool.description, /hidden:"include" or hidden:"only"/);
  assert.match(searchFileTextTool.jsonSchema.properties.hidden.description, /hidden files are not searched/);
  assert.match(searchFileTextTool.jsonSchema.properties.include.description, /absence claims apply only/);
  assert.match(searchFileTextTool.jsonSchema.properties.exclude.description, /absence claims do not apply/);
  assert.match(searchFileTextTool.jsonSchema.properties.maxResults.description, /partial coverage/);
  assert.match(searchFileTextTool.jsonSchema.properties.maxFileBytes.description, /outside the searched subset/);
  assert.doesNotMatch(JSON.stringify(searchFileTextTool.jsonSchema), /respectIgnoreFiles|gitignore|ripgrep|rg-compatible|warnings/);

  const defaultSearch = await invokeToolCall(jsonToolCall('search_file_text', { query: 'Needle' }), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(defaultSearch.ok, true);
  assert.equal(defaultSearch.output.path, '.');
  assert.equal(defaultSearch.output.mode, 'literal');
  assert.equal(defaultSearch.output.resultMode, 'files');
  assert.deepEqual(defaultSearch.output.filters, {
    hidden: 'exclude',
    include: [],
    exclude: [],
    caseSensitive: false,
    contextLines: 0,
    maxResults: 50,
    maxMatchesPerFile: 5,
    maxFileBytes: 1_000_000,
    maxResultBytes: 64_000
  });
  assert.equal('warnings' in defaultSearch.output, false);
  assert.equal(defaultSearch.output.matches, undefined);
  assert.equal(defaultSearch.output.files.some((entry) => entry.path === 'ignored.txt'), true);
  assert.equal(defaultSearch.output.files.some((entry) => entry.path === 'node_modules/pkg/index.txt'), true);
  assert.equal(defaultSearch.output.files.some((entry) => entry.path === '.agent-core/hidden.txt'), false);

  const excludedSearch = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'Needle', exclude: ['node_modules', 'ignored.txt'] }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(excludedSearch.ok, true);
  assert.equal(excludedSearch.output.files.some((entry) => entry.path === 'node_modules/pkg/index.txt'), false);
  assert.equal(excludedSearch.output.files.some((entry) => entry.path === 'ignored.txt'), false);

  const includedSearch = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'Needle', include: ['*.md'] }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(includedSearch.ok, true);
  assert.deepEqual(includedSearch.output.files.map((entry) => entry.path), ['docs/guide.md']);

  const hiddenIncluded = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'Needle', hidden: 'include' }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(hiddenIncluded.ok, true);
  assert.equal(hiddenIncluded.output.files.some((entry) => entry.path === '.agent-core/hidden.txt'), true);

  const hiddenOnly = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'Needle', hidden: 'only' }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(hiddenOnly.ok, true);
  assert.equal(hiddenOnly.output.filters.hidden, 'only');
  assert.deepEqual(hiddenOnly.output.files.map((entry) => entry.path), ['.agent-core/hidden.txt']);
});

test('search_file_text returns bounded match evidence and typed failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-search-file-text-failures-'));
  await writeFile(path.join(dir, 'many.txt'), 'target one\nbefore\nTarget two\ntarget three\ntarget four\n', 'utf8');

  const matches = await invokeToolCall(
    jsonToolCall('search_file_text', {
        query: 'target',
        resultMode: 'matches',
        contextLines: 1,
        maxMatchesPerFile: 2,
        maxResults: 10
      }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(matches.ok, true);
  assert.equal(matches.output.matches.length, 2);
  assert.equal(matches.output.omitted.matches > 0, true);
  assert.equal(matches.output.coverage, 'partial');
  assert.equal(matches.output.matches[0].path, 'many.txt');
  assert.equal(Array.isArray(matches.output.matches[1].before), true);

  const counts = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'target', resultMode: 'count' }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(counts.ok, true);
  assert.deepEqual(counts.output.counts, { filesWithMatches: 1, totalMatches: 4 });
  assert.equal(counts.output.files, undefined);
  assert.equal(counts.output.matches, undefined);

  const invalidRegex = await invokeToolCall(
    jsonToolCall('search_file_text', { query: '(', mode: 'regex' }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(invalidRegex.ok, false);
  assert.equal(invalidRegex.output.reason, 'invalid_arguments');
  assert.equal(invalidRegex.output.details.kind, 'invalid_regex');

  const backendRegex = await invokeToolCall(
    jsonToolCall('search_file_text', { query: '(?=target)', mode: 'regex' }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(backendRegex.ok, false);
  assert.equal(backendRegex.output.reason, 'invalid_arguments');
  assert.doesNotMatch(JSON.stringify(backendRegex), /regex parse error|look-around|stderr/i);

  const pathEscape = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'target', path: '..' }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(pathEscape.ok, false);
  assert.equal(pathEscape.output.reason, 'invalid_arguments');

  const invalidExclude = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'target', exclude: ['../outside'] }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(invalidExclude.ok, false);
  assert.equal(invalidExclude.output.reason, 'invalid_arguments');
  assert.equal(invalidExclude.output.details.field, 'exclude');
});

test('search_file_text reports missing ripgrep and truncates oversized observations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-search-file-text-limits-'));
  const emptyBin = await mkdtemp(path.join(tmpdir(), 'agent-core-empty-bin-'));
  for (let index = 0; index < 30; index += 1) {
    await writeFile(path.join(dir, `file-${index}.txt`), `needle ${'x'.repeat(400)} ${index}\n`, 'utf8');
  }
  await writeFile(path.join(dir, 'oversized.txt'), `needle ${'x'.repeat(2_000)}\n`, 'utf8');

  const limited = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'needle', maxResults: 30, maxResultBytes: 1000 }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(limited.ok, true);
  assert.equal(limited.output.truncated, true);
  assert.equal(limited.output.omitted.bytes > 0, true);
  assert.equal(Buffer.byteLength(JSON.stringify(limited.output), 'utf8') <= 1000, true);

  const oversized = await invokeToolCall(
    jsonToolCall('search_file_text', { query: 'needle', maxFileBytes: 1_000, maxResults: 50 }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(oversized.ok, true);
  assert.equal(oversized.output.files.some((entry) => entry.path === 'oversized.txt'), false);
  assert.equal(oversized.output.omitted.files, 0);
  assert.equal(oversized.output.omitted.bytes, 0);
  assert.equal(oversized.output.coverage, 'complete');
  assert.equal(oversized.output.filters.maxFileBytes, 1_000);

  const originalPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    const missingRg = await invokeToolCall(
      jsonToolCall('search_file_text', { query: 'needle' }),
      allTools,
      { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
    );
    assert.equal(missingRg.ok, false);
    assert.equal(missingRg.output.reason, 'missing_service');
    assert.equal(missingRg.output.service, 'ripgrep (rg)');
  } finally {
    process.env.PATH = originalPath;
  }
});
