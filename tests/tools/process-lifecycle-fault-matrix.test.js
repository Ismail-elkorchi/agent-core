import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, LocalCommandExecution } from '@agent-core/tools-local';
import { testWorkspaceFileRoot } from '../workspace-file-root-helper.js';

const owner = Object.freeze({ runId: 'fault-matrix-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 });

test('process lifecycle fault matrix preserves one settled terminal truth', async (t) => {
  await t.test('exit before supervisor reachability leaves no owned process', async () => {
    const { manager, root } = await context();
    const missing = 'missing-working-directory';
    await assert.rejects(manager.start(request(missing, 'process.exit(0)')));
    assert.equal(manager.activeCount(owner.runId), 0);
    assert.deepEqual(await manager.disposeRun(owner.runId), []);
  });

  await t.test('supervisor death stops its authenticated process tree before terminal publication', async () => {
    const delivered = [];
    const { manager, root, ledgerDirectory } = await context();
    const heartbeat = path.join(root, 'heartbeat');
    const script = `const fs=require('node:fs');let n=0;fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),10)`;
    let result = await manager.start(request('.', script, { onProgress(progress) { delivered.push(progress); } }));
    assert.equal(result.status, 'running');
    await waitFor(() => access(heartbeat));
    const ledger = await readLedger(ledgerDirectory, result.processId);
    process.kill(ledger.supervisorPid, 'SIGKILL');
    while (result.status === 'running') result = await manager.query(result.processId, 1_000, 50, result.cursorEnd, owner);
    const heartbeatAtTerminal = await readFile(heartbeat, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await readFile(heartbeat, 'utf8'), heartbeatAtTerminal, 'descendant work stopped before terminal publication');
    assert.equal(result.status, 'failed');
    assert.equal(delivered.at(-1).type, 'status');
    assert.equal(delivered.at(-1).stage, 'process_failed');
    assert.deepEqual((await manager.terminate(result.processId, owner)).status, result.status);
    const firstCleanup = await manager.disposeRun(owner.runId);
    const secondCleanup = await manager.disposeRun(owner.runId);
    assert.equal(firstCleanup.length, 1);
    assert.deepEqual(secondCleanup, firstCleanup);
    await manager.acknowledgeTerminalReport(result.processId);
    await manager.acknowledgeTerminalReport(result.processId);
    assert.deepEqual(await manager.disposeRun(owner.runId), []);
  });

  for (const race of [
    { name: 'timeout and natural exit', timeoutMs: 35, stop: false },
    { name: 'explicit stop and natural exit', timeoutMs: 5_000, stop: true }
  ]) {
    await t.test(race.name + ' produce one stable outcome', async () => {
      const { manager, root } = await context();
      let result = await manager.start(request('.', 'setTimeout(() => process.exit(0), 35)', { timeoutMs: race.timeoutMs }));
      if (race.stop) {
        const outcomes = await Promise.all([manager.terminate(result.processId, owner), manager.terminate(result.processId, owner)]);
        assert.deepEqual(outcomes[1], outcomes[0]);
        result = outcomes[0];
      } else {
        while (result.status === 'running') result = await manager.query(result.processId, 100, 20, result.cursorEnd, owner);
      }
      const repeated = await manager.query(result.processId, 100, 0, result.cursorEnd, owner);
      assert.equal(repeated.status, result.status);
      assert.equal(repeated.cursorEnd, result.cursorEnd);
      assert.equal(['exited', race.stop ? 'stopped' : 'timed_out'].includes(result.status), true, result.status);
      await manager.acknowledgeTerminalReport(result.processId);
    });
  }

  await t.test('shutdown drains output and observer failures cannot change truth', async () => {
    const delivered = [];
    const { manager, root } = await context();
    const script = "let n=0;const timer=setInterval(()=>{process.stdout.write(String(n++)+'\\n');if(n===8){clearInterval(timer);process.exit(0)}},5)";
    let result = await manager.start(request('.', script, { async onProgress(progress) { delivered.push(progress); await new Promise((resolve) => setTimeout(resolve, 2)); throw new Error('observer failed'); } }));
    while (result.status === 'running') result = await manager.query(result.processId, 1_000, 20, result.cursorEnd, owner);
    const terminalCursor = result.cursorEnd;
    const deliveredAtTerminal = delivered.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const repeated = await manager.query(result.processId, 1_000, 0, terminalCursor, owner);
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.progressDeliveryErrors > 0, true);
    assert.equal(repeated.cursorEnd, terminalCursor);
    assert.equal(delivered.length, deliveredAtTerminal);
    assert.equal(delivered.at(-1).type, 'status');
    assert.equal(delivered.at(-1).stage, 'process_exited');
    await manager.acknowledgeTerminalReport(result.processId);
  });
});

test('terminal-state recovery rejects missing, malformed, stale, unauthenticated, misowned, and invalid states', async (t) => {
  const valid = await terminalFixture();
  const validManager = recoveredManager(valid);
  const validReconciliation = await validManager.reconcile();
  assert.deepEqual(validReconciliation.unresolved, []);
  const [validReport] = await validManager.disposeRun('recovered-run');
  assert.equal(validReport.result.processId, valid.processId);
  assert.deepEqual(validReport.result.owner, { runId: 'recovered-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 });
  await validManager.acknowledgeTerminalReport(valid.processId);

  const staleSource = await terminalFixture();
  const staleState = await readFile(staleSource.stateFile, 'utf8');
  await recoveredManager(staleSource).acknowledgeTerminalReport(staleSource.processId);
  const cases = [
    ['missing', async (fixture) => { await rm(fixture.stateFile); }],
    ['malformed', async (fixture) => { await writeFile(fixture.stateFile, '{'); }],
    ['stale identity and process', async (fixture) => { await writeFile(fixture.stateFile, staleState); }],
    ['incorrect authentication', mutateState((state) => { state.proof = '0'.repeat(64); })],
    ['incorrect execution ownership', mutateState((state) => { state.owner.runId = 'other-run'; })],
    ['invalid terminal state', mutateState((state) => { state.state = 'running'; })]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = await terminalFixture();
      await mutate(fixture);
      const manager = recoveredManager(fixture);
      const reconciliation = await manager.reconcile();
      assert.equal(reconciliation.resolved.includes(fixture.processId), false);
      assert.equal(reconciliation.unresolved.some((item) => item.processId === fixture.processId), true);
      assert.deepEqual(await manager.disposeRun('recovered-run'), []);
      await manager.acknowledgeUnresolved([fixture.processId]);
    });
  }
});

function request(workspacePath, source, overrides = {}) {
  return { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`, workspacePath, pty: false, timeoutMs: 5_000, yieldMs: 1, outputTokenBudget: 1_000, owner, ...overrides };
}
async function context() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-faults-'));
  const ledgerDirectory = path.join(root, 'processes');
  const manager = new LocalCommandExecution({ artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') }), workspaceFileRoot: testWorkspaceFileRoot(root), ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  return { manager, root, ledgerDirectory };
}
async function readLedger(directory, processId) { return JSON.parse(await readFile(path.join(directory, `${processId}.json`), 'utf8')); }
async function waitFor(operation) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await operation(); } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw lastError;
}
async function terminalFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-terminal-state-'));
  const fixture = path.resolve('tests/fixtures/process-terminal-state.mjs');
  const child = spawnSync(process.execPath, [fixture, root], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 46, child.stderr);
  const { processId } = JSON.parse(child.stdout);
  const ledgerDirectory = path.join(root, 'processes');
  const stateFile = path.join(ledgerDirectory, `${processId}.state.json`);
  await waitFor(() => access(stateFile));
  return { root, ledgerDirectory, stateFile, processId };
}
function recoveredManager(fixture) {
  return new LocalCommandExecution({ artifactRepository: new LocalArtifactRepository({ rootDir: path.join(fixture.root, 'recovered-artifacts') }), workspaceFileRoot: testWorkspaceFileRoot(fixture.root), ledgerDirectory: fixture.ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
}
function mutateState(change) {
  return async (fixture) => {
    const state = JSON.parse(await readFile(fixture.stateFile, 'utf8'));
    change(state);
    await writeFile(fixture.stateFile, JSON.stringify(state) + '\n');
  };
}
