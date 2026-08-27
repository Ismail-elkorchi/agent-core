import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceFileRoot } from '@agent-core/tools-local';

test('workspace file roots fail closed when handle-relative confinement is unavailable', () => {
  if (process.platform === 'linux') return;
  assert.throws(() => WorkspaceFileRoot.adopt(process.cwd()), /unavailable/iu);
});

test('workspace file roots reject lexical escapes, reserved authority, aliases, links, mounts, and special files', { skip: process.platform !== 'linux' }, async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'agent-core-root-capability-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agent-core-root-outside-'));
  await writeFile(path.join(rootPath, 'safe.txt'), 'safe\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  await mkdir(path.join(rootPath, '.git'));
  await writeFile(path.join(rootPath, '.git', 'config'), 'authority\n');
  await mkdir(path.join(rootPath, 'nested'));
  await mkdir(path.join(rootPath, 'nested', '.git'));
  await writeFile(path.join(rootPath, 'nested', '.git', 'config'), 'nested authority\n');
  await symlink(path.join(outside, 'secret.txt'), path.join(rootPath, 'alias.txt'));
  await symlink(outside, path.join(rootPath, 'alias-dir'), 'dir');
  const rootAlias = path.join(path.dirname(rootPath), `${path.basename(rootPath)}-alias`);
  await symlink(rootPath, rootAlias, 'dir');
  await link(path.join(outside, 'secret.txt'), path.join(rootPath, 'hard.txt'));
  const fifo = spawnSync('mkfifo', [path.join(rootPath, 'pipe')]);
  assert.equal(fifo.status, 0, fifo.stderr?.toString());
  const root = WorkspaceFileRoot.adopt(rootPath);
  try {
    assert.throws(() => WorkspaceFileRoot.adopt(rootAlias), /aliased|directory/iu);
    for (const candidate of ['../secret', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\secret', '\\\\?\\C:\\secret', 'nested/../../secret']) {
      assert.throws(() => root.canonicalPath(candidate), /not allowed|escapes|Backslash/iu, candidate);
    }
    for (const candidate of ['.git/config', 'nested/.git/config', '.agent-core/state', '.agent-core-patch-forged-stage']) {
      assert.throws(() => root.canonicalPath(candidate), /reserved/iu, candidate);
    }
    await assert.rejects(root.openFile('alias.txt'), /symbolic|alias/iu);
    await assert.rejects(root.openFile('alias-dir/secret.txt'), /aliased|directory/iu);
    await assert.rejects(root.openFile('hard.txt'), /multiply linked/iu);
    await assert.rejects(root.openFile('pipe'), /regular file/iu);

    const system = WorkspaceFileRoot.adopt('/');
    try { await assert.rejects(system.openFile('proc/cpuinfo'), /mount/iu); }
    finally { system.close(); }
  } finally { root.close(); }
});

test('an adopted root keeps its original physical authority after its path is replaced', { skip: process.platform !== 'linux' }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-core-root-replacement-'));
  const rootPath = path.join(parent, 'workspace');
  const movedPath = path.join(parent, 'workspace-original');
  await mkdir(rootPath);
  await writeFile(path.join(rootPath, 'value.txt'), 'original\n');
  const root = WorkspaceFileRoot.adopt(rootPath);
  await rename(rootPath, movedPath);
  await mkdir(rootPath);
  await writeFile(path.join(rootPath, 'value.txt'), 'replacement-secret\n');
  try {
    const file = await root.openFile('value.txt');
    try { assert.equal((await file.readAll(100)).toString('utf8'), 'original\n'); }
    finally { await file.close(); }
  } finally { root.close(); }
});

test('a hostile process cannot redirect an admitted read through a swapped parent', { skip: process.platform !== 'linux' }, async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'agent-core-root-race-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agent-core-root-race-outside-'));
  await mkdir(path.join(rootPath, 'branch'));
  await writeFile(path.join(rootPath, 'branch', 'value.txt'), 'inside\n');
  await writeFile(path.join(outside, 'value.txt'), 'outside-secret\n');
  const fixture = path.resolve('tests/fixtures/hostile-path-swap.mjs');
  const child = spawn(process.execPath, [fixture, rootPath, outside], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`Hostile fixture exited early: ${String(code)}`)));
  });
  const root = WorkspaceFileRoot.adopt(rootPath);
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        const file = await root.openFile('branch/value.txt');
        try { assert.equal((await file.readAll(100)).toString('utf8'), 'inside\n'); }
        finally { await file.close(); }
      } catch (error) {
        assert.doesNotMatch(error instanceof Error ? error.message : String(error), /outside-secret/iu);
      }
    }
  } finally { root.close(); child.kill('SIGKILL'); await new Promise((resolve) => child.once('close', resolve)); }
});

test('released workspace file roots reject later authority use', { skip: process.platform !== 'linux' }, async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'agent-core-root-release-'));
  await writeFile(path.join(rootPath, 'value.txt'), 'value\n');
  const root = WorkspaceFileRoot.adopt(rootPath);
  const file = await root.openFile('value.txt');
  const directory = await root.openDirectory('.');
  root.close();
  assert.throws(() => root.canonicalPath('.'), /released/iu);
  await assert.rejects(root.openDirectory('.'), /released/iu);
  await assert.rejects(file.readAll(100), /released/iu);
  await assert.rejects(directory.entries(), /released/iu);
  await file.close(); await directory.close();
});
