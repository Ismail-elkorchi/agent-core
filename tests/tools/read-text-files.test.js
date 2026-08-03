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

test('read_text_files reads windows within explicit limits and reports per-file failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-read-text-files-'));
  await mkdir(path.join(dir, 'nested'), { recursive: true });
  await writeFile(path.join(dir, 'note.txt'), 'one\ntwo\n', 'utf8');
  await writeFile(path.join(dir, 'long.txt'), Array.from({ length: 150 }, (_, index) => `line-${index + 1}`).join('\n'), 'utf8');
  await writeFile(path.join(dir, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(dir, 'large.txt'), 'x'.repeat(600_000), 'utf8');

  assert.match(readTextFilesTool.description, /explicit byte limits/);
  assert.match(readTextFilesTool.description, /search_file_text first/);
  assert.match(readTextFilesTool.description, /coverage is partial/);
  assert.match(readTextFilesTool.jsonSchema.properties.files.description, /First call shape/);
  assert.match(readTextFilesTool.jsonSchema.properties.files.items.properties.path.description, /Required non-empty/);
  assert.equal(readTextFilesTool.jsonSchema.properties.files.items.properties.startLine.default, 1);
  assert.equal(readTextFilesTool.jsonSchema.properties.maxBytesPerFile.default, 512000);
  assert.equal(readTextFilesTool.jsonSchema.properties.maxTotalBytes.default, 2_000_000);
  assert.deepEqual(readTextFilesTool.jsonSchema.required, ['files']);

  const result = await invokeToolCall(
    jsonToolCall('read_text_files', {
        files: [
          { path: 'note.txt' },
          { path: 'long.txt', startLine: 2 },
          { path: 'missing.txt' },
          { path: 'nested' },
          { path: 'binary.bin' },
          { path: 'large.txt' }
        ]
      }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output.files.map((file) => file.path), ['note.txt', 'long.txt']);
  assert.equal(result.output.files[0].totalLines, 2);
  assert.equal(result.output.files[0].sha256, sha256Text('one\ntwo\n'));
  assert.equal(result.output.files[0].lineEndings, 'lf');
  assert.equal(result.output.files[0].hasFinalNewline, true);
  assert.equal(result.output.files[0].totalBytes, Buffer.byteLength('one\ntwo\n', 'utf8'));
  assert.equal(result.output.files[0].content, 'one\ntwo');
  assert.equal(result.output.files[0].endLine, 2);
  assert.equal(result.output.files[0].coverage, 'complete');
  assert.equal(result.output.files[1].startLine, 2);
  assert.equal(result.output.files[1].endLine, 101);
  assert.equal(result.output.files[1].content.split('\n').length, 100);
  assert.equal(result.output.files[1].coverage, 'partial');
  assert.deepEqual(result.output.failures.map((failure) => failure.reason).sort(), ['binary', 'not_file', 'not_found', 'too_large']);
  assert.equal(result.output.omitted.files, 4);
  assert.equal(result.output.omitted.bytes > 0, true);
  assert.equal(result.output.coverage, 'partial');
});

test('read_text_files separates invalid arguments and missing services', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-read-text-files-invalid-'));
  const outsideDir = await mkdtemp(path.join(tmpdir(), 'agent-core-read-text-files-outside-'));
  await writeFile(path.join(outsideDir, 'secret.txt'), 'outside\n', 'utf8');
  await symlink(path.join(outsideDir, 'secret.txt'), path.join(dir, 'linked-secret.txt'));

  const blankPath = await invokeToolCall(jsonToolCall('read_text_files', { files: [{ path: '   ' }] }), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(blankPath.ok, false);
  assert.equal(blankPath.output.reason, 'invalid_arguments');

  const invalidRange = await invokeToolCall(
    jsonToolCall('read_text_files', { files: [{ path: 'note.txt', startLine: 3, endLine: 1 }] }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(invalidRange.ok, false);
  assert.equal(invalidRange.output.reason, 'invalid_arguments');

  await writeFile(path.join(dir, 'short.txt'), 'one\n', 'utf8');
  const rangeBeyondEof = await invokeToolCall(
    jsonToolCall('read_text_files', { files: [{ path: 'short.txt', startLine: 2 }] }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(rangeBeyondEof.ok, true);
  assert.deepEqual(rangeBeyondEof.output.failures.map((failure) => failure.reason), ['invalid_range']);

  const pathEscape = await invokeToolCall(
    jsonToolCall('read_text_files', { files: [{ path: '../outside.txt' }] }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(pathEscape.ok, false);
  assert.equal(pathEscape.output.reason, 'invalid_arguments');

  const symlinkEscape = await invokeToolCall(
    jsonToolCall('read_text_files', { files: [{ path: 'linked-secret.txt' }] }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(symlinkEscape.ok, false);
  assert.equal(symlinkEscape.output.reason, 'invalid_arguments');

  const missingService = await invokeToolCall(jsonToolCall('read_text_files', { files: [{ path: 'note.txt' }] }), allTools, {
    policy: readOnlyPolicy
  });
  assert.equal(missingService.ok, false);
  assert.equal(missingService.output.reason, 'missing_service');
  assert.equal(missingService.output.service, 'workspaceRoot');
  assert.equal(missingService.output.details.expected, 'non-empty string workspace root');
  assert.equal(missingService.output.details.actualType, 'missing');
});
