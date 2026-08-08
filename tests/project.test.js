import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeWorkspace, loadAgentCoreConfiguration, loadWorkspace, parseAgentCoreConfiguration } from '@agent-core/cli';

test('loadWorkspace canonicalizes symlink roots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-workspace-'));
  const realRoot = path.join(dir, 'workspace');
  const linkRoot = path.join(dir, 'workspace-link');
  await mkdir(realRoot);
  await symlink(realRoot, linkRoot, 'dir');

  const workspace = await loadWorkspace(linkRoot);
  assert.equal(workspace.workspaceRoot, await realpath(realRoot));
  assert.equal(workspace.runtimeDir, path.join(workspace.workspaceRoot, '.agent-core'));
});

test('describeWorkspace remains a pure path description', () => {
  const workspace = describeWorkspace('relative-workspace');
  assert.equal(workspace.workspaceRoot, path.resolve('relative-workspace'));
  assert.equal(workspace.runsDir, path.join(workspace.workspaceRoot, '.agent-core', 'runs'));
});

test('workspace configuration validates first-party policy, checks, and exact limit names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-config-'));
  const configuration = {
    version: 1,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoning: { strategy: 'effort', effort: 'max', mode: 'standard' },
    instructions: [{ path: 'AGENTS.md' }],
    tools: { enabled: ['read_files'] },
    authorization: { allowedRisks: ['read', 'write'], requireApprovalFor: ['write'] },
    verification: { required: [{ id: 'test', command: 'npm test', timeoutMs: 1_000 }], advisory: [] },
    limits: { modelTurns: 3, knownCost: { amount: 10, currency: 'USD' } },
    session: { mode: 'latest' }
  };
  await writeFile(path.join(dir, 'agent-core.config.json'), JSON.stringify(configuration));
  assert.deepEqual(await loadAgentCoreConfiguration(dir), configuration);
  assert.throws(() => parseAgentCoreConfiguration({ ...configuration, limits: { mysteryLimit: 1 } }), /run limits/iu);
  assert.throws(() => parseAgentCoreConfiguration({ ...configuration, authorization: { allowedRisks: ['read'], requireApprovalFor: ['write'] } }), /Approval risks/u);
  assert.throws(() => parseAgentCoreConfiguration({ ...configuration, verification: { required: [{ id: 'same', command: 'true' }], advisory: [{ id: 'same', command: 'true' }] } }), /unique/u);
});

test('workspace configuration cannot escape through a symlink', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'agent-core-config-link-'));
  const root = path.join(container, 'workspace');
  await mkdir(root);
  const outside = path.join(container, 'outside.json');
  await writeFile(outside, '{}');
  await symlink(outside, path.join(root, 'linked.json'));
  await assert.rejects(() => loadAgentCoreConfiguration(root, 'linked.json'), /symlink escapes/u);
});
