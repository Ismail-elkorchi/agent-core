import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/evidence';
import { readArtifactTool, viewImageTool } from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';

const tools = [readArtifactTool, viewImageTool];

test('read_artifact returns ranges, continuation offsets, and typed text content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-artifacts-'));
  const repository = new InMemoryArtifactRepository();
  const artifact = await repository.store({ label: 'sample', content: new TextEncoder().encode('0123456789'), mediaType: 'text/plain; charset=utf-8' });
  const observation = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: artifact.artifactId, offset: 2, byteCount: 4 }), tools, {
    policy: { allowedRisks: ['read'] }, services: { workspaceRoot: root, artifactRepository: repository }
  });
  assert.equal(observation.output.text, '2345');
  assert.deepEqual(observation.output.returnedRange, { start: 2, end: 6 });
  assert.equal(observation.output.fullSize, 10);
  assert.equal(observation.output.nextOffset, 6);
  assert.equal(observation.output.coverage, 'partial');
  assert.deepEqual(observation.content, [{ type: 'text', text: '2345', mediaType: 'text/plain; charset=utf-8' }]);
});

test('view_image stores image bytes and returns an image content reference without a data URL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-image-'));
  const repository = new InMemoryArtifactRepository();
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(3, 20);
  await writeFile(path.join(root, 'image.png'), png);
  const observation = await invokeToolCall(jsonToolCall('view_image', { path: 'image.png', detail: 'original' }), tools, {
    policy: { allowedRisks: ['read'] }, services: { workspaceRoot: root, artifactRepository: repository }
  });
  assert.equal(observation.ok, true);
  assert.equal(observation.output.width, 2);
  assert.equal(observation.output.height, 3);
  assert.equal(observation.content[0].type, 'image');
  assert.equal(observation.content[0].detail, 'original');
  assert.equal(JSON.stringify(observation).includes('data:image'), false);
  assert.deepEqual(Buffer.from(await repository.readVerified(observation.output.artifact)), png);
});
