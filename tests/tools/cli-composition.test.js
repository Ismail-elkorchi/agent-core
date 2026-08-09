import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { createCliLocalToolHost, describeWorkspace } from '@agent-core/cli';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';

const owner = { runId: 'cli-composition-run', turnId: 'turn-1', requestAttempt: 1, toolBatchId: 'batch-1', callIndex: 0, toolAttempt: 1 };

test('CLI local host composition executes artifact, image, and process tools with production services', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-cli-composition-'));
  const workspace = describeWorkspace(root);
  await mkdir(workspace.artifactsDir, { recursive: true });
  const artifacts = new LocalArtifactRepository({ rootDir: workspace.artifactsDir });
  const host = createCliLocalToolHost(workspace, artifacts);
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
});
