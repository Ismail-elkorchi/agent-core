import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/evidence';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
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

test('artifact repositories verify small ranges without breaking UTF-8 boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-artifact-range-'));
  for (const repository of [new InMemoryArtifactRepository(), new LocalArtifactRepository({ rootDir: root })]) {
    const text = `prefix-${'x'.repeat(2_000_000)}-a🙂b-suffix`;
    const artifact = await repository.store({ label: 'large-text', content: new TextEncoder().encode(text), mediaType: 'text/plain; charset=utf-8' });
    const marker = new TextEncoder().encode(`prefix-${'x'.repeat(2_000_000)}-a`).byteLength;
    const range = await repository.readVerifiedRange(artifact, { offset: marker + 1, length: 2 });
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(range.bytes), '🙂');
    assert.equal(range.offset, marker);
    assert.equal(range.end, marker + 4);
    assert.equal(range.fullSize, artifact.size);
  }
});

test('public and protected artifacts have distinct lookup and filesystem visibility', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-artifact-visibility-'));
  const repository = new LocalArtifactRepository({ rootDir: root });
  const publicRef = await repository.store({ label: 'public', content: new TextEncoder().encode('public'), mediaType: 'text/plain' });
  const protectedRef = await repository.storeProtected({ label: 'raw', content: new TextEncoder().encode('secret raw'), mediaType: 'text/plain' });
  assert.equal(publicRef.visibility, 'public');
  assert.equal(protectedRef.visibility, 'protected');
  assert.equal((await repository.resolve(publicRef.artifactId)).artifactId, publicRef.artifactId);
  assert.equal(await repository.resolve(protectedRef.artifactId), undefined);
  assert.equal(new TextDecoder().decode(await repository.readVerified(protectedRef)), 'secret raw');
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(root, 'protected'))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, 'protected', protectedRef.artifactId))).mode & 0o777, 0o600);
  }
  const denied = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: protectedRef.artifactId }), tools, {
    policy: { allowedRisks: ['read'] }, services: { artifactRepository: repository }
  });
  assert.equal(denied.kind, 'failure');
  assert.match(denied.summary, /unknown artifact/iu);
});

test('verified range cache reuses hashes only for unchanged file identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-artifact-cache-'));
  const scans = [];
  const repository = new LocalArtifactRepository({ rootDir: root, onVerificationScan: artifactId => scans.push(artifactId) });
  const original = new TextEncoder().encode('a🙂b-' + 'x'.repeat(10_000));
  const artifact = await repository.store({ label: 'cached', content: original, mediaType: 'text/plain; charset=utf-8' });
  const target = path.join(root, artifact.artifactId);
  const first = await repository.readVerifiedRange(artifact, { offset: 2, length: 2 });
  assert.equal(new TextDecoder('utf8', { fatal: true }).decode(first.bytes), '🙂');
  await repository.readVerifiedRange(artifact, { offset: 100, length: 10 });
  assert.equal(scans.length, 1, 'the second unchanged small range reuses the verified hash');

  await writeFile(target, Buffer.alloc(artifact.size, 0x79));
  await assert.rejects(repository.readVerifiedRange(artifact, { offset: 0, length: 4 }), /SHA-256/u);
  assert.equal(scans.length, 2);
  await writeFile(target, original);
  await repository.readVerifiedRange(artifact, { offset: 0, length: 4 });
  assert.equal(scans.length, 3, 'restoring contents still invalidates the changed identity');

  const replacement = path.join(root, 'same-size-replacement.tmp');
  await writeFile(replacement, original);
  await rename(replacement, target);
  await repository.readVerifiedRange(artifact, { offset: 0, length: 4 });
  assert.equal(scans.length, 4, 'same-size replacement invalidates inode-based identity');
  assert.deepEqual(Buffer.from(await readFile(target)), Buffer.from(original));
});
