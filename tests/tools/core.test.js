import test from 'node:test';
import { invokeToolCall, jsonToolCall, presentToolObservation } from '../tool-call-helpers.js';
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

test('built-in tools expose stable observation presentation result shapes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-tool-observation-presentation-'));
  await writeFile(path.join(dir, 'note.txt'), 'Needle one\nNeedle two\n', 'utf8');

  for (const tool of allTools) {
    assert.equal(typeof tool.presentObservation, 'function', `${tool.name} must provide an observation presenter`);
    assert.equal('capabilities' in tool, false, `${tool.name} must not expose operation-capability metadata`);
  }

  const searchCall = jsonToolCall('search_file_text', { query: 'Needle' });
  const searchObservation = await invokeToolCall(searchCall, allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(searchObservation.evidence.items[0].action, 'search');
  assert.equal(searchObservation.evidence.items[0].resources[0].uri, 'workspace://.');
  const searchView = await presentToolObservation(searchFileTextTool, searchCall, searchObservation, { services: { workspaceRoot: dir }, policy: readOnlyPolicy }, 12_000);
  assert.equal(validateToolObservationPresentation(searchView).ok, true);
  assert.equal(searchView.results.files[0].path, 'note.txt');
  assert.equal(searchView.results.files[0].matchCount, 2);
  assert.equal(searchView.filters.hidden, 'exclude');
  assert.equal(searchView.limits.maxResults, 50);

  const readCall = jsonToolCall('read_text_files', { files: [{ path: 'note.txt', startLine: 1, endLine: 1 }] });
  const readObservation = await invokeToolCall(readCall, allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(readObservation.evidence.items[0].action, 'read');
  assert.equal(readObservation.evidence.items[0].resources[0].uri, 'workspace://note.txt');
  assert.deepEqual(readObservation.evidence.items[0].resources[0].range, { kind: 'line', start: 1, end: 1 });
  const readView = await presentToolObservation(readTextFilesTool, readCall, readObservation, { services: { workspaceRoot: dir }, policy: readOnlyPolicy }, 12_000);
  assert.equal(validateToolObservationPresentation(readView).ok, true);
  assert.equal(readView.results.files[0].path, 'note.txt');
  assert.equal(readView.results.files[0].sha256, sha256Text('Needle one\nNeedle two\n'));
  assert.equal(readView.results.files[0].lineEndings, 'lf');
  assert.equal(readView.results.files[0].hasFinalNewline, true);
  assert.equal(readView.results.files[0].totalBytes, Buffer.byteLength('Needle one\nNeedle two\n', 'utf8'));
  assert.deepEqual(readView.results.files[0].returned, { startLine: 1, endLine: 1, totalLines: 2 });
  assert.equal(readView.results.files[0].content, 'Needle one');
  assert.equal(readView.results.files[0].coverage, 'partial');

  const patchText = [
    '*** Begin Patch',
    '*** Update File: note.txt',
    '@@',
    '-Needle one',
    '+Replacement',
    '*** End Patch'
  ].join('\n');
  const patchCall = jsonToolCall('apply_patch', { dryRun: true, patch: patchText });
  const patchObservation = await invokeToolCall(patchCall, allTools, {
    services: { workspaceRoot: dir },
    policy: writePolicy
  });
  assert.equal(patchObservation.evidence.items[0].action, 'update');
  assert.equal(patchObservation.evidence.items[0].scope.confidence, 'unverified');
  const patchView = await presentToolObservation(applyPatchTool, patchCall, patchObservation, { services: { workspaceRoot: dir }, policy: writePolicy }, 12_000);
  assert.equal(validateToolObservationPresentation(patchView).ok, true);
  assert.equal(patchView.results.files[0].path, 'note.txt');
  assert.equal(patchView.results.files[0].oldSha256, sha256Text('Needle one\nNeedle two\n'));
  assert.equal(patchView.results.files[0].newSha256, sha256Text('Replacement\nNeedle two\n'));
  assert.equal(patchView.scope.patchBytes, Buffer.byteLength(patchText, 'utf8'));

  const runCall = jsonToolCall('shell_command', { command: `${JSON.stringify(process.execPath)} -e "console.log('hello')"` });
  const runObservation = await invokeToolCall(runCall, allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(runObservation.evidence.items[0].action, 'execute');
  assert.deepEqual(runObservation.evidence.items[0].resources, []);
  const runView = await presentToolObservation(shellCommandTool, runCall, runObservation, { services: { workspaceRoot: dir }, policy: executePolicy }, 12_000);
  assert.equal(validateToolObservationPresentation(runView).ok, true);
  assert.deepEqual(runView.scope, { command: `${JSON.stringify(process.execPath)} -e "console.log('hello')"`, workdir: '.' });
  assert.deepEqual(runView.results.status, {
    outcome: 'exited',
    process: { kind: 'exited', exitCode: 0, signal: null },
    cleanup: { status: 'settled' },
    exitCode: 0,
    durationMs: runView.results.status.durationMs,
    stdoutTruncated: false,
    stderrTruncated: false
  });
  assert.equal('timedOut' in runView.results.status, false);
  assert.equal('spawnError' in runView.results.status, false);
  assert.equal(runView.results.status.process.exitCode, 0);
  assert.equal('execution' in runView.results, false);
  assert.match(runView.results.stdout.text, /hello/);
  assert.equal(runView.results.stderr.truncated, false);
});

test('invokeToolCall reports unknown tools distinctly', async () => {
  const observation = await invokeToolCall(jsonToolCall('missing_tool', {}), allTools, {
    policy: readOnlyPolicy
  });

  assert.equal(observation.ok, false);
  assert.equal(observation.output.reason, 'unknown_tool');
  assert.match(observation.output.recovery, /native tools/);
});
