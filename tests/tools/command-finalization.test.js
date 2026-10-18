import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalCommandExecution, DEFAULT_LOCAL_TOOL_CONFIGURATION } from '@agent-core/tools-local';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { testRootedFileAuthority } from '../rooted-file-authority-helper.js';

// Exercise observation finalization without launching a process or opening a socket.
function terminalObservation(report) {
  const process = { id: 'terminal-process', owner: { ownerId: 'owner' },
    status: 'exited', exitCode: 0, signal: null,
    cursor: 0, oldestCursor: 0, history: [], observed: { stdout: 0, stderr: 0 },
    progressDroppedEvents: 0, progressDeliveryErrors: 0 };
  const command = Object.assign(Object.create(LocalCommandExecution.prototype), {
    ready: Promise.resolve(), active: new Map(), completed: new Map([[process.id, process]]),
    finish: async () => report
  });
  return { command, process };
}

test('a resolved but undurable terminal report remains finalizationPending through query', async () => {
  const { command, process } = terminalObservation({ result: { finalizationPending: true } });
  const pending = await command.query(process.id, 100, 0, 0, process.owner);
  assert.equal(pending.status, 'exited');
  assert.equal(pending.exitCode, 0);
  assert.equal(pending.finalizationPending, true);
  command.finish = async () => ({ result: {} });
  const durable = await command.query(process.id, 100, 0, 0, process.owner);
  assert.equal(durable.status, 'exited');
  assert.equal(durable.exitCode, 0);
  assert.equal(durable.finalizationPending, undefined);
});

test('failed receipt persistence keeps terminal truth, defers handoff, and retries after repair without sockets', async (t) => {
  const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'terminal-finalization-fault-'));
  const processId = 'proc_11111111-1111-4111-8111-111111111111';
  const terminalPath = path.join(root, `${processId}.terminal.json`);
  await mkdir(terminalPath);
  const record = { id: processId,
    owner: { ownerId: 'owner', runId: 'run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 },
    rootPath: root, command: 'already-exited', startedAt: Date.now(),
    status: 'exited', terminalStatus: 'exited', exitCode: 0, signal: null,
    cursor: 0, oldestCursor: 0, history: [], observed: { stdout: 0, stderr: 0 },
    progressDroppedEvents: 0, progressDeliveryErrors: 0, progressClosed: true,
    terminalReported: false, activityWaiters: new Set(),
    capture: { chunks: () => [], retainedBytes: 0 },
    tree: { child: { pid: process.pid }, supervision: {
      identity: 'supervisor_22222222-2222-4222-8222-222222222222', endpoint: '/unused'
    } }
  };
  const delivered = [];
  const files = testRootedFileAuthority(root);
  const command = new LocalCommandExecution({
    ledgerDirectory: root, rootedFileAuthority: files,
    artifactRepository: new InMemoryArtifactRepository(),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    commitTerminalReport: async report => { delivered.push(report); }
  });
  await command.reconcile();
  // Inject the already-exited process only; authority lifecycle/index state comes from construction.
  command.completed.set(processId, record);
  command.finalArtifacts = async () => ({});
  t.after(async () => { clearTimeout(record.retention); files.close(); await rm(root, { recursive: true, force: true }); });
  const pending = await command.query(processId, 100, 0, 0, record.owner);
  assert.equal(pending.status, 'exited');
  assert.equal(pending.exitCode, 0);
  assert.equal(pending.finalizationPending, true);
  assert.match(pending.diagnostic, /terminal record storage failed/);
  assert.equal(delivered.length, 0);
  const pendingPage = await command.readPendingTerminalReports({ ownerId: record.owner.ownerId });
  assert.equal(pendingPage.reports[0].finalizationPending, true);
  assert.equal(pendingPage.reports[0].handoffPending, true);
  assert.equal(record.finishPromise, undefined, 'failed durability must allow another finalization attempt');
  await rm(terminalPath, { recursive: true });
  const repaired = await command.query(processId, 100, 0, 0, record.owner);
  assert.equal(repaired.status, 'exited');
  assert.equal(repaired.finalizationPending, undefined);
  assert.equal(delivered.length, 1);
  const acknowledged = await command.readPendingTerminalReports({ ownerId: record.owner.ownerId, after: pendingPage.next });
  assert.deepEqual(acknowledged.reports, []);
  assert.equal(acknowledged.complete, true);
  const receipt = JSON.parse(await readFile(terminalPath, 'utf8'));
  assert.deepEqual(delivered[0].terminalOutput.combined, receipt.combined);
  assert.equal(delivered[0].terminalDiagnostic, receipt.diagnostic);
  const originalBytes = await readFile(terminalPath, 'utf8');
  await command.query(processId, 100, 0, 0, record.owner);
  assert.equal(delivered.length, 1);
  assert.equal(await readFile(terminalPath, 'utf8'), originalBytes);
});
