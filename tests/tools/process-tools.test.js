import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/evidence';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  ProcessManager,
  execCommandTool,
  stopProcessTool,
  writeStdinTool
} from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';

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
  const manager = new ProcessManager({
    artifactRepository: artifacts,
    ...configuration.process
  });
  return { root, artifacts, manager, context: { policy, invocation: owner, services: { workspaceRoot: root, artifactRepository: artifacts, localToolConfiguration: configuration, processManager: manager } } };
}

async function pollUntilSettled(processId, context, afterCursor = 0) {
  let result;
  do {
    result = await invokeToolCall(jsonToolCall('write_stdin', { processId, afterCursor, yieldMs: 100, outputTokenBudget: 4_000 }), tools, context);
    afterCursor = result.output.cursorEnd;
  } while (result.output.status === 'running');
  return result;
}

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

test('stop_process force-kills descendants that ignore graceful termination', { skip: process.platform === 'win32' }, async () => {
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
