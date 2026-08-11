import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeWorkspace } from '@agent-core/cli';
import { createLocalToolHost } from '@agent-core/tools-local';
import { createToolCall, prepareToolCall } from '@agent-core/tools';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';

const owner = { runId: 'cli-composition-run', turnId: 'turn-1', requestAttempt: 1, toolBatchId: 'batch-1', callIndex: 0, toolAttempt: 1 };

test('CLI local host composition executes artifact, image, and process tools with production services', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-cli-composition-'));
  const workspace = describeWorkspace(root);
  await mkdir(workspace.artifactsDir, { recursive: true });
  const host = createLocalToolHost({
    workspaceRoot: workspace.workspaceRoot,
    artifactDirectory: workspace.artifactsDir,
    processLedgerDirectory: path.join(workspace.runtimeDir, 'processes'),
    patchTransactionDirectory: path.join(workspace.runtimeDir, 'transactions', 'patch')
  });
  await host.ready();
  assert.deepEqual(await host.reconciliation(), { resolved: [], unresolved: [] });
  const artifacts = host.artifactRepository;
  assert.deepEqual(host.tools.map((tool) => tool.name), ['list_directory', 'find_files', 'read_files', 'search_text', 'apply_patch', 'exec_command', 'write_stdin', 'stop_process', 'view_image', 'read_artifact']);
  assert.equal(host.services.artifactRepository, artifacts);

  const imagePath = path.join(root, 'pixel.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const stored = await artifacts.store({ label: 'text', content: new TextEncoder().encode('artifact text'), mediaType: 'text/plain; charset=utf-8' });
  const context = { policy: { allowedRisks: ['read', 'execute'] }, services: host.services, invocation: owner };

  const viewed = await invokeToolCall(jsonToolCall('view_image', { path: 'pixel.png' }), host.tools, context);
  assert.equal(viewed.ok, true);
  const read = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: stored.artifactId, offset: 0, byteCount: 64 }), host.tools, context);
  assert.equal(read.output.text, 'artifact text');

  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdin.on('data', d => process.stdout.write(d)); setInterval(() => {}, 1000)")}`;
  const started = await invokeToolCall(jsonToolCall('exec_command', { command, yieldMs: 50 }), host.tools, context);
  assert.equal(started.output.status, 'running');
  const written = await invokeToolCall(jsonToolCall('write_stdin', { processId: started.output.processId, afterCursor: started.output.cursorEnd, text: 'ping', yieldMs: 250 }), host.tools, context);
  assert.match(written.output.stdout.text, /ping/u);
  const stopped = await invokeToolCall(jsonToolCall('stop_process', { processId: started.output.processId, afterCursor: written.output.cursorEnd }), host.tools, context);
  assert.equal(stopped.output.status, 'stopped');
  await host.close();
});

test('local host exposes dry-run patching without a transaction directory and gates mutation dynamically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-local-host-patch-services-'));
  await writeFile(path.join(root, 'note.txt'), 'old\n');
  const patch = '*** Begin Patch\n*** Update File: note.txt\n@@\n-old\n+new\n*** End Patch';
  const contextFor = (services) => ({
    policy: { allowedRisks: ['read', 'write', 'destructive'] }, services,
    signal: new AbortController().signal,
    boundary: { authorizationPolicyId: 'tests/local-host-patch@1', executionTargetId: root }
  });
  const withoutDirectory = createLocalToolHost({
    workspaceRoot: root,
    artifactDirectory: path.join(root, 'artifacts-without-patch'),
    processLedgerDirectory: path.join(root, 'processes-without-patch')
  });
  await withoutDirectory.ready();
  assert.equal(withoutDirectory.tools.some(tool => tool.name === 'apply_patch'), true);
  assert.equal('patchTransactionDirectory' in withoutDirectory.services, false);
  const dryContext = contextFor(withoutDirectory.services);
  const dryPrepared = await prepareToolCall(createToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch, dryRun: true } } }), withoutDirectory.tools, dryContext);
  assert.equal(dryPrepared.ok, true);
  const dry = await dryPrepared.prepared.invoke(dryContext);
  assert.equal(dry.output.operationStatus, 'dry_run');
  const writePrepared = await prepareToolCall(createToolCall({ name: 'apply_patch', input: { kind: 'text', value: patch } }), withoutDirectory.tools, dryContext);
  assert.equal(writePrepared.ok, true);
  await assert.rejects(writePrepared.prepared.invoke(dryContext), /patchTransactionDirectory/u);
  await withoutDirectory.close();

  const withDirectory = createLocalToolHost({
    workspaceRoot: root,
    artifactDirectory: path.join(root, 'artifacts-with-patch'),
    processLedgerDirectory: path.join(root, 'processes-with-patch'),
    patchTransactionDirectory: path.join(root, 'patch-transactions')
  });
  await withDirectory.ready();
  assert.equal(withDirectory.tools.some(tool => tool.name === 'apply_patch'), true);
  const writeContext = contextFor(withDirectory.services);
  const prepared = await prepareToolCall(createToolCall({ name: 'apply_patch', input: { kind: 'text', value: patch } }), withDirectory.tools, writeContext);
  assert.equal(prepared.ok, true);
  const applied = await prepared.prepared.invoke(writeContext);
  assert.equal(applied.output.operationStatus, 'applied');
  await withDirectory.close();
});
