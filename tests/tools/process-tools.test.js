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

async function processContext(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-tools-'));
  const artifacts = new InMemoryArtifactRepository();
  const configuration = {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    process: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process, ...options }
  };
  const manager = new ProcessManager({
    artifactRepository: artifacts,
    maxCapturedBytes: configuration.process.maxCapturedBytes,
    tailBytes: configuration.process.tailBytes
  });
  return { root, artifacts, manager, context: { policy, services: { workspaceRoot: root, artifactRepository: artifacts, localToolConfiguration: configuration, processManager: manager } } };
}

async function pollUntilSettled(processId, context) {
  let result;
  do {
    result = await invokeToolCall(jsonToolCall('write_stdin', { processId, yieldMs: 100, outputTokenBudget: 4_000 }), tools, context);
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
  const completed = await invokeToolCall(jsonToolCall('write_stdin', { processId: started.output.processId, text: 'hello\n', closeStdin: true, yieldMs: 1_000 }), tools, context);
  const settled = completed.output.status === 'running' ? await pollUntilSettled(started.output.processId, context) : completed;
  assert.match(`${completed.output.stdout.text}${settled.output.stdout.text}`, /echo:hello/u);
  assert.doesNotMatch(completed.output.stdout.text, /^ready$/mu, 'polling returns only output after the prior cursor');
  assert.equal(completed.output.combined.startsAtOutputStart, false);
  assert.equal(settled.output.status, 'exited');
  await manager.disposeAll();
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
  if (result.output.status === 'running') result = await pollUntilSettled(result.output.processId, context);
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
  if (result.output.status === 'running') result = await pollUntilSettled(result.output.processId, context);
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
