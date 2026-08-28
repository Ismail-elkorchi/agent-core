import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/evidence';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  LocalCommandExecution,
  WorkspaceFileRoot,
  createLocalToolHost,
  execCommandTool,
  stopProcessTool,
  writeStdinTool
} from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';
import { testWorkspaceFileRoot } from '../workspace-file-root-helper.js';
import { isCommandExecution } from '@agent-core/tools';

const tools = [execCommandTool, writeStdinTool, stopProcessTool];
const policy = { allowedRisks: ['read', 'execute'] };
const invocation = { runId: 'process-test-run', turnId: 'turn-1', requestAttempt: 1, toolBatchId: 'batch-1', callIndex: 0, toolAttempt: 1 };

async function processContext(options = {}, owner = invocation) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-tools-'));
  const artifacts = new InMemoryArtifactRepository();
  const configuration = {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    process: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process, ...options }
  };
  const workspaceFileRoot = testWorkspaceFileRoot(root);
  const manager = new LocalCommandExecution({
    artifactRepository: artifacts,
    workspaceFileRoot,
    ...configuration.process
  });
  return { root, artifacts, manager, context: { policy, invocation: owner, services: { workspaceFileRoot, artifactRepository: artifacts, localToolConfiguration: configuration, commandExecution: manager } } };
}

async function pollUntilSettled(processId, context, afterCursor = 0) {
  let result;
  do {
    result = await invokeToolCall(jsonToolCall('write_stdin', { processId, afterCursor, yieldMs: 100, outputTokenBudget: 4_000 }), tools, context);
    afterCursor = result.output.cursorEnd;
  } while (result.output.status === 'running');
  return result;
}

test('command execution is admitted by behavior and has a stable recovery identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-command-contract-'));
  const ledgerDirectory = path.join(root, 'processes');
  const options = {
    artifactRepository: new InMemoryArtifactRepository(),
    workspaceFileRoot: testWorkspaceFileRoot(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  };
  const first = new LocalCommandExecution(options);
  const second = new LocalCommandExecution(options);
  assert.equal(isCommandExecution(first), true);
  assert.equal(isCommandExecution({ descriptor: first.descriptor, resourceLeases: first.resourceLeases }), false);
  assert.equal(first.descriptor.implementationId, 'agent-core.local-command-execution@1');
  assert.equal(first.descriptor.recoveryIdentity, second.descriptor.recoveryIdentity);
  assert.match(first.descriptor.recoveryIdentity, /^local-command:sha256:[a-f0-9]{64}$/u);
  await first.close();
  await second.close();
});

test('command execution keeps the admitted physical working directory across a path swap', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-command-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agent-core-command-outside-'));
  const original = path.join(root, 'work');
  const retained = path.join(root, 'retained-work');
  await mkdir(original);
  const owner = { ...invocation, runId: 'working-directory-swap-run' };
  const execution = new LocalCommandExecution({
    artifactRepository: new InMemoryArtifactRepository(),
    workspaceFileRoot: testWorkspaceFileRoot(root),
    ledgerDirectory: path.join(root, 'processes'),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    async onSupervisorCheckpoint(checkpoint) {
      if (checkpoint !== 'supervisor_ready') return;
      await rename(original, retained);
      await symlink(outside, original, 'dir');
    }
  });
  let result = await execution.start({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('marker.txt', 'inside')")}`,
    workspacePath: 'work', pty: false, timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner
  });
  while (result.status === 'running') result = await execution.query(result.processId, 100, 50, result.cursorEnd, owner);
  await access(path.join(retained, 'marker.txt'));
  await assert.rejects(access(path.join(outside, 'marker.txt')), /ENOENT/u);
  await execution.acknowledgeTerminalReport(result.processId);
  await execution.close();
});

test('persistent processes support polling and stdin without replaying prior output', async () => {
  const { context, manager } = await processContext();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('ready\\n'); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('echo:' + d)); process.stdin.on('end', () => process.exit(0));")}`;
  const started = await invokeToolCall(jsonToolCall('exec_command', { command, yieldMs: 500 }), tools, context);
  assert.equal(started.output.status, 'running');
  assert.match(started.output.stdout.text, /ready/u);
  assert.equal(started.output.combined.startsAtOutputStart, true);
  assert.equal(started.output.combined.endsAtOutputEnd, true);
  const completed = await invokeToolCall(jsonToolCall('write_stdin', { processId: started.output.processId, afterCursor: started.output.cursorEnd, text: 'hello\n', closeStdin: true, yieldMs: 1_000 }), tools, context);
  const settled = completed.output.status === 'running' ? await pollUntilSettled(started.output.processId, context, completed.output.cursorEnd) : completed;
  assert.match(`${completed.output.stdout.text}${settled.output.stdout.text}`, /echo:hello/u);
  assert.doesNotMatch(completed.output.stdout.text, /^ready$/mu, 'polling returns only output after the prior cursor');
  assert.equal(completed.output.combined.startsAtOutputStart, false);
  assert.equal(settled.output.status, 'exited');
  await manager.disposeRun(invocation.runId);
});

test('stop_process terminates an owned process tree without a shell stop command', async () => {
  const { context } = await processContext();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('started'); setInterval(() => {}, 1000)")}`;
  const started = await invokeToolCall(jsonToolCall('exec_command', { command, yieldMs: 500, timeoutMs: 60_000 }), tools, context);
  const stopped = await invokeToolCall(jsonToolCall('stop_process', { processId: started.output.processId }), tools, context);
  assert.equal(stopped.output.status, 'stopped');
});

test('a nonzero command exit is a negative tool result, not a tool failure', async () => {
  const { context } = await processContext();
  let result = await invokeToolCall(jsonToolCall('exec_command', { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(7)')}`, yieldMs: 1_000 }), tools, context);
  if (result.output.status === 'running') result = await pollUntilSettled(result.output.processId, context, result.output.cursorEnd);
  assert.equal(result.kind, 'result');
  assert.equal(result.ok, false);
  assert.equal(result.output.exitCode, 7);
});

test('stop_process force-kills descendants that ignore graceful termination', async () => {
  const { context } = await processContext();
  const script = "console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const started = await invokeToolCall(jsonToolCall('exec_command', { command, yieldMs: 500, timeoutMs: 60_000 }), tools, context);
  const operatingSystemPid = Number(started.output.stdout.text.trim().split(/\s+/u)[0]);
  assert.equal(Number.isSafeInteger(operatingSystemPid), true);
  const stopped = await invokeToolCall(jsonToolCall('stop_process', { processId: started.output.processId }), tools, context);
  assert.equal(stopped.output.status, 'stopped');
  await waitForMissingProcess(operatingSystemPid);
});

test('bounded output retains the true start and true tail and stores an artifact', async () => {
  const { context, artifacts } = await processContext({ maxCapturedBytes: 160, tailBytes: 64 });
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('START-' + 'x'.repeat(5000) + '-END')")}`;
  let result = await invokeToolCall(jsonToolCall('exec_command', { command, yieldMs: 1_000, outputTokenBudget: 64 }), tools, context);
  const first = result;
  if (result.output.status === 'running') result = await pollUntilSettled(result.output.processId, context, result.output.cursorEnd);
  const output = `${first.output.combined.text}${result === first ? '' : result.output.combined.text}`;
  assert.match(output, /START-/u);
  assert.match(output, /-END/u);
  assert.equal(first.output.combined.omittedBytes > 0, true);
  assert.equal(first.output.combined.startsAtOutputStart, true);
  assert.equal(first.output.combined.endsAtOutputEnd, true);
  assert.equal((await artifacts.readVerified(result.output.artifact)).byteLength > 0, true);
});

async function waitForMissingProcess(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error && typeof error === 'object' && error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Process ${String(pid)} remained alive after stop_process.`);
}

test('process polls use stable cursors, preserve split UTF-8, and retain a completed tombstone', async () => {
  const { context, manager } = await processContext({ completedRetentionMs: 1_000 });
  const script = "const b=Buffer.from('🙂 café'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),10)";
  let started = await invokeToolCall(jsonToolCall('exec_command', { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, yieldMs: 500 }), tools, context);
  if (started.output.status === 'running') started = await pollUntilSettled(started.output.processId, context, started.output.cursorEnd);
  const first = await invokeToolCall(jsonToolCall('write_stdin', { processId: started.output.processId, afterCursor: 0 }), tools, context);
  const repeated = await invokeToolCall(jsonToolCall('write_stdin', { processId: started.output.processId, afterCursor: 0 }), tools, context);
  assert.equal(first.output.stdout.text, '🙂 café');
  assert.deepEqual(repeated.output, first.output);
  const stoppedAgain = await invokeToolCall(jsonToolCall('stop_process', { processId: started.output.processId, afterCursor: 0 }), tools, context);
  assert.equal(stoppedAgain.output.status, 'exited');
  assert.equal(manager.has(started.output.processId), true);
});

test('expired cursors are explicit and process limits are enforced', async () => {
  const { context } = await processContext({ maxCapturedBytes: 128, tailBytes: 48, maxPendingOutputBytes: 64, maxActiveProcessesPerRun: 1 });
  const noisy = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)")}`;
  const first = await invokeToolCall(jsonToolCall('exec_command', { command: noisy, yieldMs: 200 }), tools, context);
  assert.equal(first.output.cursorExpired, true);
  const expired = await invokeToolCall(jsonToolCall('write_stdin', { processId: first.output.processId, afterCursor: 1 }), tools, context);
  assert.equal(expired.output.cursorExpired, true);
  const limited = await invokeToolCall(jsonToolCall('exec_command', { command: noisy, yieldMs: 10 }), tools, context);
  assert.equal(limited.kind, 'failure');
  assert.match(limited.summary, /active process count/u);
  await invokeToolCall(jsonToolCall('stop_process', { processId: first.output.processId, afterCursor: first.output.cursorEnd }), tools, context);
});

test('process ownership and run cleanup cannot affect another run', async () => {
  const ownerA = { ...invocation, runId: 'run-a' };
  const ownerB = { ...invocation, runId: 'run-b' };
  const { context, manager } = await processContext({}, ownerA);
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(()=>{},1000)')}`;
  const started = await invokeToolCall(jsonToolCall('exec_command', { command, yieldMs: 50 }), tools, context);
  const foreignContext = { ...context, invocation: ownerB };
  const foreignStop = await invokeToolCall(jsonToolCall('stop_process', { processId: started.output.processId }), tools, foreignContext);
  assert.equal(foreignStop.kind, 'failure');
  assert.match(foreignStop.summary, /another run/u);
  await manager.disposeRun(ownerB.runId);
  assert.equal(manager.has(started.output.processId), true);
  const stopped = await invokeToolCall(jsonToolCall('stop_process', { processId: started.output.processId }), tools, context);
  assert.equal(stopped.output.status, 'stopped');
});

test('natural termination is reported once whether or not the process was polled or stopped', async () => {
  for (const mode of ['unpolled', 'polled', 'stopped']) {
    const { root, manager } = await processContext({ completedRetentionMs: 100 });
    const owner = { ...invocation, runId: `terminal-${mode}` };
    const command = mode === 'stopped'
      ? `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(()=>{},1000)')}`
      : `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`;
    let result = await manager.start({ command, workspacePath: '.', pty: false, timeoutMs: 60_000, yieldMs: mode === 'stopped' ? 20 : 1_000, outputTokenBudget: 1_000, owner });
    if (mode === 'polled') {
      while (result.status === 'running') result = await manager.query(result.processId, 1_000, 100, result.cursorEnd, owner);
    } else if (mode === 'stopped') {
      result = await manager.terminate(result.processId, owner);
    } else {
      while (manager.activeCount(owner.runId) > 0) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const reports = await manager.disposeRun(owner.runId);
    assert.equal(reports.length, 1, mode);
    assert.equal(reports[0].result.processId, result.processId);
    await manager.acknowledgeTerminalReport(result.processId);
    assert.deepEqual(await manager.disposeRun(owner.runId), []);
    assert.deepEqual(await manager.disposeRun(owner.runId), []);
  }
});

test('terminal tombstones release capture budgets before late acknowledgment', async () => {
  const { root, manager } = await processContext({
    maxCapturedBytes: 1_024,
    maxTotalCapturedBytes: 1_024,
    completedRetentionMs: 20
  });
  const processIds = [];
  for (let index = 0; index < 4; index += 1) {
    const owner = { ...invocation, runId: `late-ack-${String(index)}` };
    let result = await manager.start({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(800))")}`,
      workspacePath: '.', pty: false, timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner
    });
    while (result.status === 'running') result = await manager.query(result.processId, 100, 50, result.cursorEnd, owner);
    processIds.push(result.processId);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await manager.unreportedTerminalProcesses(owner.runId)).length, 1);
  }
  for (const processId of processIds) {
    const before = await manager.query(processId, 100);
    await manager.acknowledgeTerminalReport(processId);
    await manager.acknowledgeTerminalReport(processId);
    assert.equal(before.status, 'exited');
    assert.equal(manager.has(processId), false);
  }
});

test('ledger cleanup residue does not change a terminal result and is retried on startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-ledger-residue-'));
  const ledgerDirectory = path.join(root, 'processes');
  const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
  const owner = { ...invocation, runId: 'cleanup-residue-run' };
  const manager = new LocalCommandExecution({
    artifactRepository: artifacts,
    workspaceFileRoot: testWorkspaceFileRoot(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    async removeLedgerRecord() { throw new Error('simulated ledger deletion failure'); }
  });
  let result = await manager.start({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`,
    workspacePath: '.', pty: false, timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner
  });
  while (result.status === 'running') result = await manager.query(result.processId, 100, 50, result.cursorEnd, owner);
  while ((await manager.unreportedTerminalProcesses(owner.runId)).length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.acknowledgeTerminalReport(result.processId);
  assert.equal(result.status, 'exited');
  assert.match(manager.cleanupDiagnostics().join(' '), /simulated ledger deletion failure/u);

  const retry = new LocalCommandExecution({ artifactRepository: artifacts, workspaceFileRoot: testWorkspaceFileRoot(root), ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  const reconciliation = await retry.reconcile();
  assert.equal(reconciliation.unresolved.length, 0);
  assert.equal(reconciliation.resolved.includes(result.processId), true);
  assert.deepEqual(await readdir(ledgerDirectory), []);
});

test('public process redaction detects a secret split across output chunks', async () => {
  const { root, artifacts, manager } = await processContext();
  const owner = { ...invocation, runId: 'split-redaction-run' };
  const secret = 'split-secret-value';
  const script = `process.stdout.write('API_TO'); setTimeout(()=>process.stdout.write('KEN=${secret}'), 20)`;
  let result = await manager.start({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    workspacePath: '.', pty: false, timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner
  });
  while (result.status === 'running') result = await manager.query(result.processId, 100, 50, result.cursorEnd, owner);
  const publicPayload = JSON.parse(new TextDecoder().decode(await artifacts.readVerified(result.artifact)));
  const publicOutput = publicPayload.chunks.map((chunk) => chunk.text).join('');
  assert.doesNotMatch(publicOutput, new RegExp(secret, 'u'));
  assert.match(publicOutput, /REDACTED/u);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('public process artifacts preserve output larger than the strict JSON string boundary', async () => {
  const { root, artifacts, manager } = await processContext({ maxCapturedBytes: 5_000_000, maxTotalCapturedBytes: 5_000_000 });
  const owner = { ...invocation, runId: 'large-public-output-run' };
  const outputBytes = 4_300_000;
  let result = await manager.start({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write('x'.repeat(${String(outputBytes)}))`)}`,
    workspacePath: '.', pty: false, timeoutMs: 10_000, yieldMs: 1_000, outputTokenBudget: 100, owner
  });
  while (result.status === 'running') result = await manager.query(result.processId, 100, 100, result.cursorEnd, owner);
  assert.equal(result.artifact.visibility, 'public');
  assert.ok(result.artifact.size > 4_000_000);
  const publicPayload = JSON.parse(new TextDecoder().decode(await artifacts.readVerified(result.artifact)));
  assert.equal(publicPayload.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text, 'utf8'), 0), outputBytes);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('process output keeps raw protected bytes internal and exposes only a redacted public artifact', async () => {
  const { root, artifacts, manager } = await processContext();
  const owner = { ...invocation, runId: 'artifact-visibility-run' };
  const secret = 'super-secret-value';
  let result = await manager.start({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write('API_TOKEN=${secret}')`)}`,
    workspacePath: '.', pty: false, timeoutMs: 60_000, yieldMs: 1_000, outputTokenBudget: 1_000, owner
  });
  while (result.status === 'running') result = await manager.query(result.processId, 1_000, 100, result.cursorEnd, owner);
  assert.equal(result.artifact.visibility, 'public');
  const publicText = new TextDecoder().decode(await artifacts.readVerified(result.artifact));
  assert.doesNotMatch(publicText, new RegExp(secret, 'u'));
  assert.match(publicText, /REDACTED/u);
  assert.equal(JSON.stringify(result).includes('protected-'), false);
  const reports = await manager.disposeRun(owner.runId);
  assert.equal(reports[0].protectedArtifact.visibility, 'protected');
  const rawText = new TextDecoder().decode(await artifacts.readVerified(reports[0].protectedArtifact));
  assert.match(rawText, new RegExp(secret, 'u'));
  assert.equal(await artifacts.resolve(reports[0].protectedArtifact.artifactId), undefined);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('asynchronous process progress is ordered, bounded, and catches callback failures', async () => {
  const { root, artifacts } = await processContext();
  const manager = new LocalCommandExecution({ artifactRepository: artifacts, workspaceFileRoot: testWorkspaceFileRoot(root), ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process, maxPendingOutputBytes: 512 });
  const delivered = [];
  const unhandled = [];
  const listener = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const script = "let i=0; const t=setInterval(()=>{process.stdout.write('o'+i+'\\n'); process.stderr.write('e'+i+'\\n'); if(++i===50){clearInterval(t);}},1)";
    let result = await manager.start({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, workspacePath: '.', pty: false, timeoutMs: 60_000, yieldMs: 20, outputTokenBudget: 1_000,
      owner: { ...invocation, runId: 'progress-run' },
      async onProgress(progress) {
        await new Promise(resolve => setTimeout(resolve, 2));
        delivered.push(progress);
        if (progress.type === 'output' || progress.stage === 'process_started') throw new Error('delivery broke');
      }
    });
    while (result.status === 'running') result = await manager.query(result.processId, 1_000, 100, result.cursorEnd);
    await new Promise(resolve => setTimeout(resolve, 100));
    result = await manager.query(result.processId, 1_000);
    const sequences = delivered.filter(item => item.type === 'output').map(item => item.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(result.progressDeliveryErrors > 0, true);
    assert.equal(result.progressDroppedEvents > 0, true);
    assert.equal(unhandled.length, 0);
    assert.equal(delivered.find(item => item.type === 'status' && item.stage === 'process_started') !== undefined, true);
    assert.equal(delivered.some(item => item.type === 'status' && item.stage === 'process_exited'), true);
    const startedIndex = delivered.findIndex(item => item.type === 'status' && item.stage === 'process_started');
    const exitedIndex = delivered.findIndex(item => item.type === 'status' && item.stage === 'process_exited');
    assert.ok(startedIndex >= 0 && exitedIndex > startedIndex);
    assert.equal(delivered.slice(0, startedIndex).some(item => item.type === 'output'), false);
    const deliveredAtTerminal = delivered.length;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(delivered.length, deliveredAtTerminal, 'no progress is delivered after a terminal result');
    await manager.disposeRun('progress-run');
  } finally { process.off('unhandledRejection', listener); }
});

test('a terminal poll waits for accepted asynchronous progress delivery', async () => {
  const { root, artifacts } = await processContext();
  const manager = new LocalCommandExecution({ artifactRepository: artifacts, workspaceFileRoot: testWorkspaceFileRoot(root), ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  const delivered = [];
  const owner = { ...invocation, runId: 'terminal-progress-drain-run' };
  let result = await manager.start({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`,
    workspacePath: '.', pty: false, timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner,
    async onProgress(progress) {
      if (progress.type === 'status' && progress.stage === 'process_exited') await new Promise(resolve => setTimeout(resolve, 40));
      delivered.push(progress);
    }
  });
  while (result.status === 'running') result = await manager.query(result.processId, 100, 100, result.cursorEnd, owner);
  assert.equal(delivered.at(-1).type, 'status');
  assert.equal(delivered.at(-1).stage, 'process_exited');
  const deliveredAtTerminal = delivered.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(delivered.length, deliveredAtTerminal);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('process ledger restores unreported terminal records across manager restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-ledger-'));
  const ledgerDirectory = path.join(root, 'processes');
  const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
  const owner = { ...invocation, runId: 'restart-run' };
  const first = new LocalCommandExecution({ artifactRepository: artifacts, workspaceFileRoot: testWorkspaceFileRoot(root), ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  const started = await first.start({ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`, workspacePath: '.', pty: false, timeoutMs: 60_000, yieldMs: 1_000, outputTokenBudget: 1_000, owner });
  while ((await first.unreportedTerminalProcesses(owner.runId)).length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  const second = new LocalCommandExecution({ artifactRepository: artifacts, workspaceFileRoot: testWorkspaceFileRoot(root), ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  const reconciliation = await second.reconcile();
  assert.equal(reconciliation.unresolved.length, 0);
  const reports = await second.disposeRun(owner.runId);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].result.processId, started.processId);
  await second.acknowledgeTerminalReport(started.processId);
  assert.deepEqual(await readdir(ledgerDirectory), []);
});

test('startup reconciliation stops an orphaned child process tree and resolves its atomic ledger', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-orphan-'));
  const fixture = path.resolve('tests/fixtures/process-orphan.mjs');
  const crashed = spawnSync(process.execPath, [fixture, root], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(crashed.status, 44, crashed.stderr);
  const { processId } = JSON.parse(crashed.stdout);
  const ledgerDirectory = path.join(root, 'processes');
  const ledgerName = (await readdir(ledgerDirectory)).find(name => /^proc_[a-f0-9-]+\.json$/u.test(name));
  const ledger = JSON.parse(await readFile(path.join(ledgerDirectory, ledgerName), 'utf8'));
  const manager = new LocalCommandExecution({ artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts-recovered') }), workspaceFileRoot: testWorkspaceFileRoot(root), ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  const reconciliation = await manager.reconcile();
  assert.equal(reconciliation.resolved.includes(processId), true, JSON.stringify(reconciliation));
  assert.equal(reconciliation.unresolved.length, 0, JSON.stringify(reconciliation));
  assert.equal(typeof ledger.supervisorIdentity, 'string');
  assert.equal(typeof ledger.supervisorEndpoint, 'string');
  const reports = await manager.disposeRun('orphan-run');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].result.status, 'stopped');
  await manager.acknowledgeTerminalReport(processId);
  assert.deepEqual(await readdir(ledgerDirectory), []);
});

test('reconciliation never signals a PID without authenticated supervisor identity and blocks the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-pid-reuse-'));
  const ledgerDirectory = path.join(root, 'processes');
  await mkdir(ledgerDirectory, { recursive: true });
  const processId = 'proc_11111111-1111-4111-8111-111111111111';
  await writeFile(path.join(ledgerDirectory, `${processId}.json`), JSON.stringify({
    schemaVersion: 1,
    processId,
    supervisorPid: process.pid,
    supervisorIdentity: 'supervisor_22222222-2222-4222-8222-222222222222',
    supervisorEndpoint: process.platform === 'win32' ? '\\\\.\\pipe\\missing-agent-core-supervisor' : path.join(ledgerDirectory, 'missing.sock'),
    owner: { runId: 'old-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 },
    startedAt: new Date().toISOString(),
    workspace: root,
    state: 'running',
    terminalReported: false
  }) + '\n');

  const host = createLocalToolHost({
    workspaceFileRoot: WorkspaceFileRoot.adopt(root),
    artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') }),
    processLedgerDirectory: ledgerDirectory,
    enabledTools: ['exec_command', 'write_stdin', 'stop_process']
  });
  await host.ready();
  const reconciliation = await host.reconciliation();
  assert.equal(reconciliation.unresolved.length, 1);
  assert.equal(reconciliation.unresolved[0].workspace, root);
  assert.equal(host.commandExecution.resourceLeases.activeCount(), 1);
  assert.equal(host.commandExecution.resourceLeases.wouldWait({ accesses: [{ mode: 'write', scope: 'workspace/files/a.txt' }], lockScopes: ['workspace/files/a.txt'], recovery: { kind: 'unknown' } }), true);
  assert.doesNotThrow(() => process.kill(process.pid, 0), 'the reused PID remains untouched');
  await assert.rejects(host.commandExecution.start({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`,
    workspacePath: '.', pty: false, timeoutMs: 1_000, yieldMs: 1, outputTokenBudget: 100,
    owner: { runId: 'new-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 }
  }), /unresolved supervised process/u);

  const resolved = await host.resolveReconciliation({ acknowledgeProcessIds: [processId] });
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(host.commandExecution.resourceLeases.activeCount(), 0);
  await host.close();
});

test('supervisor handshake prevents user code before durable release and reconciles a post-release crash', async () => {
  const fixture = path.resolve('tests/fixtures/process-supervisor-crash.mjs');
  for (const phase of ['ledger_persisted', 'released']) {
    const root = await mkdtemp(path.join(tmpdir(), `agent-core-supervisor-${phase}-`));
    const crashed = spawnSync(process.execPath, [fixture, root, phase], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(crashed.status, 45, crashed.stderr);
    const { processId, checkpoint } = JSON.parse(crashed.stdout);
    assert.equal(checkpoint, phase);
    const marker = path.join(root, 'user-command-started');
    if (phase === 'ledger_persisted') {
      await new Promise(resolve => setTimeout(resolve, 600));
      await assert.rejects(access(marker), /ENOENT/u, 'the supervisor timed out without starting user code');
    } else {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { await access(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      await access(marker);
    }
    const ledgerDirectory = path.join(root, 'processes');
    const manager = new LocalCommandExecution({
      artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'recovered-artifacts') }),
      workspaceFileRoot: testWorkspaceFileRoot(root),
      ledgerDirectory,
      ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
    });
    const reconciliation = await manager.reconcile();
    assert.equal(reconciliation.unresolved.length, 0, JSON.stringify(reconciliation));
    assert.equal(reconciliation.resolved.includes(processId), true, JSON.stringify(reconciliation));
    const reports = await manager.disposeRun(`crash-${phase}`);
    assert.equal(reports.length, 1);
    assert.equal(phase === 'ledger_persisted' ? reports[0].result.status === 'failed' : reports[0].result.status === 'stopped', true);
    await manager.acknowledgeTerminalReport(processId);
  }
});

test('local host durably hands recovered terminal reports to old runs during startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-terminal-handoff-'));
  const fixture = path.resolve('tests/fixtures/process-orphan.mjs');
  const crashed = spawnSync(process.execPath, [fixture, root], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(crashed.status, 44, crashed.stderr);
  const { processId } = JSON.parse(crashed.stdout);
  const delivered = [];
  const host = createLocalToolHost({
    workspaceFileRoot: WorkspaceFileRoot.adopt(root),
    artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'host-artifacts') }),
    processLedgerDirectory: path.join(root, 'processes'),
    enabledTools: ['exec_command', 'write_stdin', 'stop_process'],
    async deliverRecoveredTerminalReport(report) { delivered.push(report); return true; }
  });
  await host.ready();
  assert.equal(delivered.length, 1, JSON.stringify(await host.reconciliation()));
  assert.equal(delivered[0].result.processId, processId);
  assert.equal(delivered[0].result.owner.runId, 'orphan-run');
  assert.deepEqual(await readdir(path.join(root, 'processes')), []);
  await host.close();
});
