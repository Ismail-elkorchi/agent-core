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

test('list_directory_tree exposes a caller-filtered tree within an explicit traversal limit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-list-directory-tree-'));
  await mkdir(path.join(dir, '.agent-core'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'nested'), { recursive: true });
  await writeFile(path.join(dir, '.agent-core', 'session.json'), '{}\n', 'utf8');
  await writeFile(path.join(dir, '.env.example'), 'TOKEN=\n', 'utf8');
  await writeFile(path.join(dir, 'note.txt'), 'hello\n', 'utf8');
  await writeFile(path.join(dir, 'package-lock.json'), '{}\n', 'utf8');
  await writeFile(path.join(dir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  await writeFile(path.join(dir, 'src', 'nested', 'deep.txt'), 'deep\n', 'utf8');

  assert.equal(listDirectoryTreeTool.jsonSchema.properties.path.default, '.');
  assert.equal(listDirectoryTreeTool.jsonSchema.properties.depth.default, 1);
  assert.equal(listDirectoryTreeTool.jsonSchema.properties.maxVisitedEntries.default, 300);
  assert.equal(listDirectoryTreeTool.jsonSchema.properties.hidden.default, 'include');
  assert.deepEqual(listDirectoryTreeTool.jsonSchema.properties.exclude.default, []);
  assert.deepEqual(listDirectoryTreeTool.jsonSchema.required ?? [], []);
  assert.match(listDirectoryTreeTool.description, /First call shape: \{\}/);

  const rootListing = await invokeToolCall(jsonToolCall('list_directory_tree', {}), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(rootListing.ok, true);
  assert.equal(rootListing.output.path, '.');
  assert.deepEqual(rootListing.output.scope, { path: '.' });
  assert.deepEqual(rootListing.output.filters, { hidden: 'include', exclude: [] });
  assert.deepEqual(rootListing.output.limits, { depth: 1, maxVisitedEntries: 300 });
  assert.equal(rootListing.output.coverage, 'complete');
  assert.equal(rootListing.output.entries.some((entry) => entry.path === '.agent-core' && entry.type === 'directory'), true);
  assert.equal(rootListing.output.entries.some((entry) => entry.path === '.env.example' && entry.type === 'file'), true);
  assert.equal(rootListing.output.entries.some((entry) => entry.path === 'src' && entry.type === 'directory'), true);
  assert.equal(rootListing.output.entries.some((entry) => entry.path === 'src/index.ts'), false);

  const deeperListing = await invokeToolCall(
    jsonToolCall('list_directory_tree', {
        depth: 2,
        exclude: ['.agent-core', 'node_modules', 'package-lock.json']
      }),
    allTools,
    {
      services: { workspaceRoot: dir },
      policy: readOnlyPolicy
    }
  );
  assert.equal(deeperListing.ok, true);
  assert.equal(deeperListing.output.entries.some((entry) => entry.path === 'src/index.ts' && entry.type === 'file'), true);
  assert.equal(deeperListing.output.entries.some((entry) => entry.path === 'src/nested' && entry.type === 'directory'), true);
  assert.equal(deeperListing.output.entries.some((entry) => entry.path === 'src/nested/deep.txt'), false);
  assert.deepEqual(deeperListing.output.omitted.map((entry) => entry.pattern).sort(), ['.agent-core', 'node_modules', 'package-lock.json']);

  const hiddenExcluded = await invokeToolCall(jsonToolCall('list_directory_tree', { hidden: 'exclude' }), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(hiddenExcluded.ok, true);
  assert.equal(hiddenExcluded.output.entries.some((entry) => entry.path.startsWith('.')), false);

  const hiddenOnly = await invokeToolCall(jsonToolCall('list_directory_tree', { hidden: 'only', depth: 2 }), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(hiddenOnly.ok, true);
  assert.equal(hiddenOnly.output.entries.some((entry) => entry.path === '.agent-core/session.json'), true);
  assert.equal(hiddenOnly.output.entries.every((entry) => entry.path.split('/').some((segment) => segment.startsWith('.'))), true);

  const limited = await invokeToolCall(jsonToolCall('list_directory_tree', { maxVisitedEntries: 1 }), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(limited.ok, true);
  assert.equal(limited.output.entries.length, 1);
  assert.equal(limited.output.coverage, 'partial');

  const blankPath = await invokeToolCall(jsonToolCall('list_directory_tree', { path: '   ' }), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(blankPath.ok, false);
  assert.equal(blankPath.output.reason, 'invalid_arguments');
  assert.deepEqual(Object.keys(blankPath.output.issues), ['issues']);
  assert.equal(Array.isArray(blankPath.output.issues.issues), true);
  assert.deepEqual(Object.keys(blankPath.output.issues.issues[0]).sort(), ['code', 'message', 'path']);
  assert.match(blankPath.output.recovery, /tool schema/);

  const invalidWorkspaceRoot = await invokeToolCall(jsonToolCall('list_directory_tree', {}), allTools, {
    services: { workspaceRoot: 42 },
    policy: readOnlyPolicy
  });
  assert.equal(invalidWorkspaceRoot.ok, false);
  assert.equal(invalidWorkspaceRoot.output.reason, 'missing_service');
  assert.equal(invalidWorkspaceRoot.output.service, 'workspaceRoot');
  assert.equal(invalidWorkspaceRoot.output.details.expected, 'non-empty string workspace root');
  assert.equal(invalidWorkspaceRoot.output.details.actualType, 'number');

  const outsideDir = await mkdtemp(path.join(tmpdir(), 'agent-core-list-directory-tree-outside-'));
  await writeFile(path.join(outsideDir, 'secret.txt'), 'outside\n', 'utf8');
  await symlink(outsideDir, path.join(dir, 'outside-link'));
  const symlinkStart = await invokeToolCall(jsonToolCall('list_directory_tree', { path: 'outside-link' }), allTools, {
    services: { workspaceRoot: dir },
    policy: readOnlyPolicy
  });
  assert.equal(symlinkStart.ok, false);
  assert.equal(symlinkStart.output.reason, 'invalid_arguments');
});
