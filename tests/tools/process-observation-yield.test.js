import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { LocalCommandExecution } from '@agent-core/tools-local';
import { testRootedFileAuthority } from '../rooted-file-authority-helper.js';

const owner = { ownerId: 'yield-owner', runId: 'yield-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 };
const effects = { accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['files'], recovery: { kind: 'unknown' } };
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'process-yield-'));
  const manager = new LocalCommandExecution({ artifactRepository: new InMemoryArtifactRepository(),
    rootedFileAuthority: testRootedFileAuthority(root), maxCapturedBytes: 100_000, tailBytes: 10_000 });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return manager;
}
async function start(manager, signal, yieldMs = 30_000) {
  const lease = await manager.resourceLeases.acquire(effects, 'launch');
  const plan = await manager.plan({ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setTimeout(() => {}, 30_000)')}`, rootedDirectory: '.', pty: false,
    timeoutMs: 60_000, yieldMs, outputTokenBudget: 100, owner });
  const result = await manager.start(plan, { lease, observationSignal: signal });
  assert.equal(result.kind, 'started');
  return { result: result.result, lease };
}

for (const timing of ['before', 'during']) {
  test(`observation yield ${timing} launch preserves one live process and its lease`, async t => {
    const manager = await setup(t);
    const controller = new AbortController();
    if (timing === 'before') controller.abort();
    else setTimeout(() => controller.abort(), 250);
    const began = Date.now();
    const { result, lease } = await start(manager, controller.signal);
    assert.equal(result.status, 'running');
    assert.ok(Date.now() - began < 5000);
    assert.equal(lease.transferred, true);
    assert.equal(manager.resourceLeases.activeCount(), 1);
    assert.equal((await manager.listProcesses()).length, 1);
    const control = await manager.resourceLeases.acquire({ accesses: [{ mode: 'execute', scope: `processes/${result.processId}` }], lockScopes: [`processes/${result.processId}`] }, 'control');
    control.release();
    assert.equal(manager.resourceLeases.wouldWait({ accesses: [{ mode: 'write', scope: 'files/test.txt' }], lockScopes: ['files/test.txt'] }), true);
    await manager.terminate(result.processId, owner);
    assert.equal(manager.resourceLeases.activeCount(), 0);
  });
}

test('query and termination observation yield independently of process cancellation', async t => {
  const manager = await setup(t);
  const { result } = await start(manager, undefined, 0);
  const controller = new AbortController();
  const waiting = manager.query(result.processId, 100, 30_000, 0, owner, controller.signal);
  controller.abort();
  assert.equal((await waiting).status, 'running');
  const stopped = await manager.terminate(result.processId, owner, controller.signal);
  assert.equal(stopped.processId, result.processId);
  // Yielding the observation leaves the accepted stop in progress and the lease retained.
  if (stopped.status === 'running') assert.equal(manager.resourceLeases.activeCount(), 1);
  const terminal = await manager.terminate(result.processId, owner);
  assert.equal(terminal.status, 'stopped');
  assert.equal(manager.resourceLeases.activeCount(), 0);
});
