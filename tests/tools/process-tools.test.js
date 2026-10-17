import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  LocalCommandExecution,
  RootedFileAuthority,
  createLocalToolHost,
  execCommandTool,
  stopProcessTool,
  writeStdinTool
} from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';
import { testRootedFileAuthority } from '../rooted-file-authority-helper.js';
import { CommandProcessOperationRejectedError, isCommandExecution, planToolCall, releaseToolCallPlan, renderCommandOutput } from '@agent-core/tools';

const tools = [execCommandTool, writeStdinTool, stopProcessTool];
const policy = { allowedRisks: ['read', 'execute'] };
const invocation = {
  ownerId: 'process-test-run',
  runId: 'process-test-run',
  turnId: 'turn-1',
  requestAttempt: 1,
  toolBatchId: 'batch-1',
  callIndex: 0,
  toolAttempt: 1
};

async function startCommand(execution, request, options = {}) {
  const plan = await execution.plan(request);
  const started = await execution.start(plan, options);
  assert.equal(started.kind, 'started', started.diagnostic);
  return started.result;
}

async function settledCommandResult(execution, result, budget = 4_000) {
  while (result.status === 'running')
    result = await execution.query(result.processId, budget, 100, result.cursorEnd);
  return execution.query(result.processId, budget, 0, 0);
}

async function startSettledCommand(execution, request, options = {}) {
  return settledCommandResult(execution, await startCommand(execution, request, options), request.outputTokenBudget);
}

async function invokeSettledCommand(call, selectedTools, context) {
  let result = await invokeToolCall(call, selectedTools, context);
  if (result.kind !== 'result') return result;
  while (result.output.status === 'running')
    result = await invokeToolCall(jsonToolCall('write_stdin', {
      processId: result.output.processId, afterCursor: result.output.cursorEnd,
      yieldMs: 100, outputTokenBudget: call.input.value.outputTokenBudget ?? 4_000
    }), selectedTools, context);
  return invokeToolCall(jsonToolCall('write_stdin', {
    processId: result.output.processId, afterCursor: 0, yieldMs: 0,
    outputTokenBudget: call.input.value.outputTokenBudget ?? 4_000
  }), selectedTools, context);
}

async function processContext(options = {}, owner = invocation) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-tools-'));
  const artifacts = new InMemoryArtifactRepository();
  const configuration = {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    process: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process, ...options }
  };
  const rootedFileAuthority = testRootedFileAuthority(root);
  const manager = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority,
    ...configuration.process
  });
  return {
    root,
    artifacts,
    manager,
    context: {
      policy,
      invocation: owner,
      services: {
        rootedFileAuthority,
        artifactRepository: artifacts,
        localToolConfiguration: configuration,
        commandExecution: manager
      }
    }
  };
}

async function pollUntilSettled(processId, context, afterCursor = 0) {
  let result;
  do {
    result = await invokeToolCall(
      jsonToolCall('write_stdin', {
        processId,
        afterCursor,
        yieldMs: 100,
        outputTokenBudget: 4_000
      }),
      tools,
      context
    );
    afterCursor = result.output.cursorEnd;
  } while (result.output.status === 'running');
  return result;
}

test('command execution is admitted by behavior and has a stable recovery identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-command-contract-'));
  const ledgerDirectory = path.join(root, 'processes');
  const options = {
    artifactRepository: new InMemoryArtifactRepository(),
    rootedFileAuthority: testRootedFileAuthority(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  };
  const first = new LocalCommandExecution(options);
  const second = new LocalCommandExecution(options);
  assert.equal(isCommandExecution(first), true);
  assert.equal(
    isCommandExecution({ descriptor: first.descriptor, resourceLeases: first.resourceLeases }),
    false
  );
  assert.equal(first.descriptor.implementationId, 'agent-core.local-command-execution@1');
  assert.equal(first.descriptor.recoveryIdentity, second.descriptor.recoveryIdentity);
  assert.match(first.descriptor.recoveryIdentity, /^local-command:sha256:[a-f0-9]{64}$/u);
  await first.close();
  await second.close();
});

test('command plans bind the physical directory without fingerprinting live descriptors', async (t) => {
  const { root, manager, context } = await processContext();
  t.after(async () => {
    await manager.close();
    context.services.rootedFileAuthority.close();
    await rm(root, { recursive: true, force: true });
  });
  const work = path.join(root, 'work');
  await mkdir(work);
  const call = jsonToolCall('exec_command', { command: 'pwd', workdir: 'work' });
  const planningContext = {
    ...context,
    signal: new AbortController().signal,
    boundary: {
      authorizationPolicyId: 'tests/command-plan@1',
      executionTargetId: manager.descriptor.recoveryIdentity
    }
  };
  const plan = async () => {
    const result = await planToolCall(call, tools, planningContext);
    assert.equal(result.ok, true, result.ok ? '' : result.observation.summary);
    return result.plan;
  };

  const first = await plan();
  const second = await plan();
  assert.deepEqual(first.canonicalSnapshot, second.canonicalSnapshot);
  assert.equal(first.fingerprint, second.fingerprint);
  await releaseToolCallPlan(first);
  await releaseToolCallPlan(second);

  await writeFile(path.join(work, 'note.txt'), 'changed contents');
  const changedContents = await plan();
  assert.equal(changedContents.fingerprint, first.fingerprint);
  await releaseToolCallPlan(changedContents);

  await rename(work, path.join(root, 'moved'));
  await mkdir(work);
  const replaced = await plan();
  assert.notEqual(replaced.fingerprint, second.fingerprint);
  await releaseToolCallPlan(replaced);
});

test('local process inspection and durable terminal handoff report the owned command', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-inspection-'));
  const files = testRootedFileAuthority(root);
  const settled = [];
  const execution = new LocalCommandExecution({
    artifactRepository: new InMemoryArtifactRepository(),
    rootedFileAuthority: files,
    ledgerDirectory: path.join(root, 'processes'),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    commitTerminalReport: async ({ result }) => { settled.push(result); }
  });
  t.after(async () => {
    await execution.close();
    files.close();
    await rm(root, { recursive: true, force: true });
  });
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`;
  let result = await startCommand(execution, {
    command,
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 5_000,
    yieldMs: 0,
    outputTokenBudget: 100,
    owner: invocation
  });
  const listed = (await execution.listProcesses()).find((item) => item.processId === result.processId);
  assert.equal(listed?.command, command);
  assert.deepEqual(listed?.owner, {
    ownerId: invocation.ownerId, runId: invocation.runId, turnId: invocation.turnId,
    toolBatchId: invocation.toolBatchId, callIndex: invocation.callIndex
  });
  assert.match(listed?.revision ?? '', /^[a-f0-9]{64}$/u);
  while (result.status === 'running')
    result = await execution.query(result.processId, 100, 50, result.cursorEnd, invocation);
  await execution.unreportedTerminalProcesses(invocation.ownerId);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].processId, result.processId);
  assert.equal(settled[0].status, 'exited');
});

test('command execution keeps the admitted physical working directory across a path swap', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-command-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agent-core-command-outside-'));
  const original = path.join(root, 'work');
  const retained = path.join(root, 'retained-work');
  await mkdir(original);
  const owner = {
    ...invocation,
    ownerId: 'working-directory-swap-run',
    runId: 'working-directory-swap-run'
  };
  const execution = new LocalCommandExecution({
    artifactRepository: new InMemoryArtifactRepository(),
    rootedFileAuthority: testRootedFileAuthority(root),
    ledgerDirectory: path.join(root, 'processes'),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    async onSupervisorCheckpoint(checkpoint) {
      if (checkpoint !== 'supervisor_ready') return;
      await rename(original, retained);
      await symlink(outside, original, 'dir');
    }
  });
  let result = await startCommand(execution, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('marker.txt', 'inside')")}`,
    rootedDirectory: 'work',
    pty: false,
    timeoutMs: 5_000,
    yieldMs: 1_000,
    outputTokenBudget: 100,
    owner
  });
  while (result.status === 'running')
    result = await execution.query(result.processId, 100, 50, result.cursorEnd, owner);
  await access(path.join(retained, 'marker.txt'));
  await assert.rejects(access(path.join(outside, 'marker.txt')), /ENOENT/u);
  await execution.acknowledgeTerminalReport(result.processId);
  await execution.close();
});

test('persistent processes support polling and stdin without replaying prior output', async () => {
  const { context, manager } = await processContext();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('ready\\n'); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('echo:' + d)); process.stdin.on('end', () => process.exit(0));")}`;
  const started = await invokeToolCall(
    jsonToolCall('exec_command', { command }),
    tools,
    context
  );
  assert.equal(started.output.status, 'running');
  assert.match(started.output.stdout.segments.join(''), /ready/u);
  assert.equal(started.output.combined.startsAtOutputStart, true);
  assert.equal(started.output.combined.endsAtOutputEnd, true);
  const completed = await invokeToolCall(
    jsonToolCall('write_stdin', {
      processId: started.output.processId,
      afterCursor: started.output.cursorEnd,
      text: 'hello\n',
      closeStdin: true,
      yieldMs: 1_000
    }),
    tools,
    context
  );
  const settled =
    completed.output.status === 'running'
      ? await pollUntilSettled(started.output.processId, context, completed.output.cursorEnd)
      : completed;
  assert.match(`${completed.output.stdout.segments.join('')}${settled.output.stdout.segments.join('')}`, /echo:hello/u);
  assert.doesNotMatch(
    completed.output.stdout.segments.join(''),
    /^ready$/mu,
    'polling returns only output after the prior cursor'
  );
  assert.equal(completed.output.combined.startsAtOutputStart, false);
  assert.equal(settled.output.status, 'exited');
  await manager.disposeOwner(invocation.runId);
});

test('stop_process terminates an owned process tree without a shell stop command', async () => {
  const { context } = await processContext();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('started'); setInterval(() => {}, 1000)")}`;
  const started = await invokeToolCall(
    jsonToolCall('exec_command', { command, timeoutMs: 60_000 }),
    tools,
    context
  );
  const stopped = await invokeToolCall(
    jsonToolCall('stop_process', { processId: started.output.processId }),
    tools,
    context
  );
  assert.equal(stopped.output.status, 'stopped');
});

test('a nonzero command exit is a negative tool result, not a tool failure', async () => {
  const { context } = await processContext();
  const result = await invokeSettledCommand(
    jsonToolCall('exec_command', {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(7)')}`
    }),
    tools,
    context
  );
  assert.equal(result.output.status, 'exited');
  assert.equal(result.kind, 'result');
  assert.equal(result.execution.state, 'settled');
  assert.equal(result.output.exitCode, 7);
});

test('commands retain the file lease until exit or timeout', async (t) => {
  const { context, manager, root } = await processContext();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const read = { accesses: [{ mode: 'read', scope: 'files/a.txt' }], lockScopes: [] };
  const acquire = () => manager.resourceLeases.acquire({
    accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['files']
  }, invocation.ownerId);
  const startupBlocks = [];
  const emitProgress = (progress) => {
    if (progress.type === 'status' && progress.stage === 'process_started') {
      startupBlocks.push(manager.resourceLeases.wouldWait(read));
    }
  };
  const completed = await invokeSettledCommand(
    jsonToolCall('exec_command', {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('first\\n'); setTimeout(() => { process.stdout.write('last\\n'); process.exit(0); }, 150)")}`,
      timeoutMs: 5_000
    }),
    tools,
    { ...context, emitProgress, resourceLease: await acquire() }
  );
  assert.equal(completed.output.status, 'exited');
  assert.match(completed.output.combined.segments.join(''), /first\nlast\n/u);
  assert.equal(completed.execution.state, 'settled');
  assert.equal(manager.resourceLeases.wouldWait(read), false);

  const timedOut = await invokeSettledCommand(
    jsonToolCall('exec_command', {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`,
      timeoutMs: 500
    }),
    tools,
    { ...context, emitProgress, resourceLease: await acquire() }
  );
  assert.equal(timedOut.output.status, 'timed_out');
  assert.equal(timedOut.execution.state, 'settled');
  assert.deepEqual(startupBlocks, [true, true]);
  assert.equal(manager.resourceLeases.wouldWait(read), false);
});

test('stop_process force-kills descendants that ignore graceful termination', async () => {
  const { context } = await processContext();
  const script =
    "console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const started = await invokeToolCall(
    jsonToolCall('exec_command', { command, timeoutMs: 60_000 }),
    tools,
    context
  );
  const operatingSystemPid = Number(started.output.stdout.segments.join('').trim().split(/\s+/u)[0]);
  assert.equal(Number.isSafeInteger(operatingSystemPid), true);
  const stopped = await invokeToolCall(
    jsonToolCall('stop_process', { processId: started.output.processId }),
    tools,
    context
  );
  assert.equal(stopped.output.status, 'stopped');
  await waitForMissingProcess(operatingSystemPid);
});

test('bounded output retains the true start and true tail and stores an artifact', async () => {
  const { context, artifacts } = await processContext({ maxCapturedBytes: 160, tailBytes: 64, maxPendingOutputBytes: 160 });
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('START-' + 'x'.repeat(5000) + '-END')")}`;
  const result = await invokeSettledCommand(
    jsonToolCall('exec_command', { command, outputTokenBudget: 64 }),
    tools,
    context
  );
  assert.equal(result.output.status, 'exited');
  const output = result.output.combined.segments.join('');
  assert.match(output, /START-/u);
  assert.match(output, /-END/u);
  assert.equal(result.output.combined.omittedBytes > 0, true);
  assert.equal(result.output.combined.startsAtOutputStart, true);
  assert.equal(result.output.combined.endsAtOutputEnd, true);
  assert.match(renderCommandOutput(result.output.combined), /START-[\s\S]*output omitted[\s\S]*-END/);
  const stored = Buffer.from(await artifacts.readVerified(result.output.artifact)).toString();
  assert.match(stored, /START-[\s\S]*output omitted[\s\S]*-END/);
  assert.equal(result.output.artifact.mediaType, 'text/plain; charset=utf-8');
});

async function waitForMissingProcess(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Process ${String(pid)} remained alive after stop_process.`);
}

test('process polls use stable cursors, preserve split UTF-8, and retain terminal evidence', async () => {
  const { context, manager } = await processContext({ completedRetentionMs: 1_000 });
  const script =
    "const b=Buffer.from('🙂 café'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),10)";
  let started = await invokeToolCall(
    jsonToolCall('exec_command', {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    }),
    tools,
    context
  );
  if (started.output.status === 'running')
    started = await pollUntilSettled(started.output.processId, context, started.output.cursorEnd);
  const first = await invokeToolCall(
    jsonToolCall('write_stdin', { processId: started.output.processId, afterCursor: 0 }),
    tools,
    context
  );
  const repeated = await invokeToolCall(
    jsonToolCall('write_stdin', { processId: started.output.processId, afterCursor: 0 }),
    tools,
    context
  );
  assert.equal(first.output.stdout.segments.join(''), '🙂 café');
  assert.deepEqual(repeated.output, first.output);
  const stoppedAgain = await invokeToolCall(
    jsonToolCall('stop_process', { processId: started.output.processId, afterCursor: 0 }),
    tools,
    context
  );
  assert.equal(stoppedAgain.output.status, 'exited');
  assert.equal((await manager.query(started.output.processId, 100)).processId, started.output.processId);
});

test(
  'expired cursors are explicit and process limits are enforced',
  { timeout: 10000 },
  async () => {
    const { context } = await processContext({
      maxCapturedBytes: 128,
      tailBytes: 48,
      maxPendingOutputBytes: 64,
      maxActiveProcessesPerOwner: 1
    });
    const noisy = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)")}`;
    let first = await invokeToolCall(
      jsonToolCall('exec_command', { command: noisy }),
      tools,
      context
    );
    while (first.output.status === 'running' && first.output.stdout.observedBytes < 5000) {
      first = await invokeToolCall(
        jsonToolCall('write_stdin', {
          processId: first.output.processId,
          afterCursor: 0,
          yieldMs: 50
        }),
        tools,
        context
      );
    }
    assert.equal(first.output.cursorExpired, true);
    const expired = await invokeToolCall(
      jsonToolCall('write_stdin', { processId: first.output.processId, afterCursor: 1 }),
      tools,
      context
    );
    assert.equal(expired.output.cursorExpired, true);
    const limited = await invokeToolCall(
      jsonToolCall('exec_command', { command: noisy }),
      tools,
      context
    );
    assert.equal(limited.kind, 'failure');
    assert.match(limited.summary, /active process count/u);
    await invokeToolCall(
      jsonToolCall('stop_process', {
        processId: first.output.processId,
        afterCursor: first.output.cursorEnd
      }),
      tools,
      context
    );
  }
);

test('process ownership and run cleanup cannot affect another run', async () => {
  const ownerA = { ...invocation, ownerId: 'run-a', runId: 'run-a' };
  const ownerB = { ...invocation, ownerId: 'run-b', runId: 'run-b' };
  const { context, manager } = await processContext({}, ownerA);
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(()=>{},1000)')}`;
  const started = await invokeToolCall(
    jsonToolCall('exec_command', { command, yieldMs: 0 }),
    tools,
    context
  );
  const foreignContext = { ...context, invocation: ownerB };
  const foreignStop = await invokeToolCall(
    jsonToolCall('stop_process', { processId: started.output.processId }),
    tools,
    foreignContext
  );
  assert.equal(foreignStop.kind, 'failure');
  assert.match(foreignStop.summary, /another resource owner/u);
  await manager.disposeOwner(ownerB.runId);
  assert.equal((await manager.query(started.output.processId, 100)).processId, started.output.processId);
  const stopped = await invokeToolCall(
    jsonToolCall('stop_process', { processId: started.output.processId }),
    tools,
    context
  );
  assert.equal(stopped.output.status, 'stopped');
});

test('natural termination is reported once whether or not the process was polled or stopped', async () => {
  for (const mode of ['unpolled', 'polled', 'stopped']) {
    const { root, manager } = await processContext({ completedRetentionMs: 100 });
    const owner = { ...invocation, ownerId: `terminal-${mode}`, runId: `terminal-${mode}` };
    const command =
      mode === 'stopped'
        ? `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(()=>{},1000)')}`
        : `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`;
    let result = await startCommand(manager, {
      command,
      rootedDirectory: '.',
      pty: false,
      timeoutMs: 60_000,
      yieldMs: mode === 'stopped' ? 20 : 1_000,
      outputTokenBudget: 1_000,
      owner
    });
    if (mode === 'polled') {
      while (result.status === 'running')
        result = await manager.query(result.processId, 1_000, 100, result.cursorEnd, owner);
    } else if (mode === 'stopped') {
      result = await manager.terminate(result.processId, owner);
    } else {
      while (manager.activeCount(owner.runId) > 0)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const reports = await manager.disposeOwner(owner.runId);
    assert.equal(reports.length, 1, mode);
    assert.equal(reports[0].result.processId, result.processId);
    await manager.acknowledgeTerminalReport(result.processId);
    assert.deepEqual(await manager.disposeOwner(owner.runId), []);
    assert.deepEqual(await manager.disposeOwner(owner.runId), []);
  }
});

test('terminal records release capture budgets before late acknowledgment', async () => {
  const { root, manager } = await processContext({
    maxCapturedBytes: 1_024,
    maxTotalCapturedBytes: 1_024,
    completedRetentionMs: 20
  });
  const processIds = [];
  for (let index = 0; index < 4; index += 1) {
    const owner = {
      ...invocation,
      ownerId: `late-ack-${String(index)}`,
      runId: `late-ack-${String(index)}`
    };
    let result = await startCommand(manager, {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(800))")}`,
      rootedDirectory: '.',
      pty: false,
      timeoutMs: 5_000,
      yieldMs: 1_000,
      outputTokenBudget: 100,
      owner
    });
    while (result.status === 'running')
      result = await manager.query(result.processId, 100, 50, result.cursorEnd, owner);
    processIds.push(result.processId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await manager.unreportedTerminalProcesses(owner.runId)).length, 1);
  }
  for (const processId of processIds) {
    const before = await manager.query(processId, 100);
    await manager.acknowledgeTerminalReport(processId);
    await manager.acknowledgeTerminalReport(processId);
    assert.equal(before.status, 'exited');
    assert.equal((await manager.query(processId, 100)).status, 'exited');
  }
});

test('ledger cleanup residue does not change a terminal result and is retried on startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-ledger-residue-'));
  const ledgerDirectory = path.join(root, 'processes');
  const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
  const owner = { ...invocation, ownerId: 'cleanup-residue-run', runId: 'cleanup-residue-run' };
  const manager = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority: testRootedFileAuthority(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    async removeLedgerRecord() {
      throw new Error('simulated ledger deletion failure');
    }
  });
  let result = await startCommand(manager, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`,
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 5_000,
    yieldMs: 1_000,
    outputTokenBudget: 100,
    owner
  });
  while (result.status === 'running')
    result = await manager.query(result.processId, 100, 50, result.cursorEnd, owner);
  while ((await manager.unreportedTerminalProcesses(owner.runId)).length === 0)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await manager.acknowledgeTerminalReport(result.processId);
  assert.equal(result.status, 'exited');
  assert.match(manager.cleanupDiagnostics().join(' '), /simulated ledger deletion failure/u);

  const retry = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority: testRootedFileAuthority(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  });
  const reconciliation = await retry.reconcile();
  assert.equal(reconciliation.unresolved.length, 0);
  assert.equal(reconciliation.resolved.includes(result.processId), true);
  assert((await readdir(ledgerDirectory)).every(name => name.endsWith('.terminal.json')));
});

test('public process redaction detects a secret split across output chunks', async () => {
  const { root, artifacts, manager } = await processContext();
  const owner = { ...invocation, ownerId: 'split-redaction-run', runId: 'split-redaction-run' };
  const secret = 'split-secret-value';
  const script = `process.stdout.write('API_TO'); setTimeout(()=>process.stdout.write('KEN=${secret}'), 20)`;
  let result = await startCommand(manager, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 5_000,
    yieldMs: 1_000,
    outputTokenBudget: 100,
    owner
  });
  while (result.status === 'running')
    result = await manager.query(result.processId, 100, 50, result.cursorEnd, owner);
  const publicOutput = new TextDecoder().decode(await artifacts.readVerified(result.artifact));
  assert.doesNotMatch(publicOutput, new RegExp(secret, 'u'));
  assert.match(publicOutput, /REDACTED/u);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('public process logs preserve large original output without serialization metadata', async () => {
  const { root, artifacts, manager } = await processContext({
    maxCapturedBytes: 5_000_000,
    maxTotalCapturedBytes: 5_000_000
  });
  const owner = {
    ...invocation,
    ownerId: 'large-public-output-run',
    runId: 'large-public-output-run'
  };
  const outputBytes = 4_300_000;
  let result = await startCommand(manager, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write('x'.repeat(${String(outputBytes)}))`)}`,
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 10_000,
    yieldMs: 1_000,
    outputTokenBudget: 100,
    owner
  });
  while (result.status === 'running')
    result = await manager.query(result.processId, 100, 100, result.cursorEnd, owner);
  assert.equal(result.artifact.visibility, 'public');
  assert.ok(result.artifact.size > 4_000_000);
  assert.equal((await artifacts.readVerified(result.artifact)).byteLength, outputBytes);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('process output keeps raw protected bytes internal and exposes only a redacted public artifact', async () => {
  const { root, artifacts, manager } = await processContext();
  const owner = {
    ...invocation,
    ownerId: 'artifact-visibility-run',
    runId: 'artifact-visibility-run'
  };
  const secret = 'super-secret-value';
  let result = await startCommand(manager, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write('API_TOKEN=${secret}')`)}`,
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 60_000,
    yieldMs: 1_000,
    outputTokenBudget: 1_000,
    owner
  });
  while (result.status === 'running')
    result = await manager.query(result.processId, 1_000, 100, result.cursorEnd, owner);
  assert.equal(result.artifact.visibility, 'public');
  const publicText = new TextDecoder().decode(await artifacts.readVerified(result.artifact));
  assert.doesNotMatch(publicText, new RegExp(secret, 'u'));
  assert.match(publicText, /REDACTED/u);
  assert.equal(JSON.stringify(result).includes('protected-'), false);
  const reports = await manager.disposeOwner(owner.runId);
  assert.equal(reports[0].protectedArtifact.visibility, 'protected');
  const rawText = new TextDecoder().decode(
    await artifacts.readVerified(reports[0].protectedArtifact)
  );
  assert.match(rawText, new RegExp(secret, 'u'));
  assert.equal(await artifacts.resolve(reports[0].protectedArtifact.artifactId), undefined);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('asynchronous process progress is ordered, bounded, and catches callback failures', async () => {
  const { root, artifacts } = await processContext();
  const manager = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority: testRootedFileAuthority(root),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    maxPendingOutputBytes: 512
  });
  const delivered = [];
  const unhandled = [];
  const listener = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    const script =
      "let i=0; const t=setInterval(()=>{process.stdout.write('o'+i+'\\n'); process.stderr.write('e'+i+'\\n'); if(++i===50){clearInterval(t);}},1)";
    let result = await startCommand(
      manager,
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        rootedDirectory: '.',
        pty: false,
        timeoutMs: 60_000,
        yieldMs: 20,
        outputTokenBudget: 1_000,
        owner: { ...invocation, ownerId: 'progress-run', runId: 'progress-run' }
      },
      {
        async onProgress(progress) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          delivered.push(progress);
          if (progress.type === 'output' || progress.stage === 'process_started')
            throw new Error('delivery broke');
        }
      }
    );
    while (result.status === 'running')
      result = await manager.query(result.processId, 1_000, 100, result.cursorEnd);
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await manager.query(result.processId, 1_000);
    const sequences = delivered
      .filter((item) => item.type === 'output')
      .map((item) => item.sequence);
    assert.deepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b)
    );
    assert.equal(result.progressDeliveryErrors > 0, true);
    assert.equal(result.progressDroppedEvents > 0, true);
    assert.equal(unhandled.length, 0);
    assert.equal(
      delivered.find((item) => item.type === 'status' && item.stage === 'process_started') !==
        undefined,
      true
    );
    assert.equal(
      delivered.some((item) => item.type === 'status' && item.stage === 'process_exited'),
      true
    );
    const startedIndex = delivered.findIndex(
      (item) => item.type === 'status' && item.stage === 'process_started'
    );
    const exitedIndex = delivered.findIndex(
      (item) => item.type === 'status' && item.stage === 'process_exited'
    );
    assert.ok(startedIndex >= 0 && exitedIndex > startedIndex);
    assert.equal(
      delivered.slice(0, startedIndex).some((item) => item.type === 'output'),
      false
    );
    const deliveredAtTerminal = delivered.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      delivered.length,
      deliveredAtTerminal,
      'no progress is delivered after a terminal result'
    );
    await manager.disposeOwner('progress-run');
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('a terminal poll waits for accepted asynchronous progress delivery', async () => {
  const { root, artifacts } = await processContext();
  const manager = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority: testRootedFileAuthority(root),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  });
  const delivered = [];
  const owner = {
    ...invocation,
    ownerId: 'terminal-progress-drain-run',
    runId: 'terminal-progress-drain-run'
  };
  let result = await startCommand(
    manager,
    {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`,
      rootedDirectory: '.',
      pty: false,
      timeoutMs: 5_000,
      yieldMs: 1_000,
      outputTokenBudget: 100,
      owner
    },
    {
      async onProgress(progress) {
        if (progress.type === 'status' && progress.stage === 'process_exited')
          await new Promise((resolve) => setTimeout(resolve, 40));
        delivered.push(progress);
      }
    }
  );
  while (result.status === 'running')
    result = await manager.query(result.processId, 100, 100, result.cursorEnd, owner);
  assert.equal(delivered.at(-1).type, 'status');
  assert.equal(delivered.at(-1).stage, 'process_exited');
  const deliveredAtTerminal = delivered.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(delivered.length, deliveredAtTerminal);
  await manager.acknowledgeTerminalReport(result.processId);
});

test('process ledger restores unreported terminal records across manager restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-ledger-'));
  const ledgerDirectory = path.join(root, 'processes');
  const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
  const owner = { ...invocation, ownerId: 'restart-run', runId: 'restart-run' };
  const first = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority: testRootedFileAuthority(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  });
  const started = await startCommand(first, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`,
    rootedDirectory: '.',
    pty: false,
    timeoutMs: 60_000,
    yieldMs: 1_000,
    outputTokenBudget: 1_000,
    owner
  });
  while ((await first.unreportedTerminalProcesses(owner.runId)).length === 0)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const second = new LocalCommandExecution({
    artifactRepository: artifacts,
    rootedFileAuthority: testRootedFileAuthority(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  });
  const reconciliation = await second.reconcile();
  assert.equal(reconciliation.unresolved.length, 0);
  const reports = await second.disposeOwner(owner.runId);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].result.processId, started.processId);
  await second.acknowledgeTerminalReport(started.processId);
  assert((await readdir(ledgerDirectory)).every(name => name.endsWith('.terminal.json')));
});

test('startup reconciliation stops an orphaned child process tree and resolves its atomic ledger', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-orphan-'));
  const fixture = path.resolve('tests/fixtures/process-orphan.mjs');
  const crashed = spawnSync(process.execPath, [fixture, root], {
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.equal(crashed.status, 44, crashed.stderr);
  const { processId } = JSON.parse(crashed.stdout);
  const ledgerDirectory = path.join(root, 'processes');
  const ledgerName = (await readdir(ledgerDirectory)).find((name) =>
    /^proc_[a-f0-9-]+\.json$/u.test(name)
  );
  const ledger = JSON.parse(await readFile(path.join(ledgerDirectory, ledgerName), 'utf8'));
  const manager = new LocalCommandExecution({
    artifactRepository: new LocalArtifactRepository({
      rootDir: path.join(root, 'artifacts-recovered')
    }),
    rootedFileAuthority: testRootedFileAuthority(root),
    ledgerDirectory,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
  });
  const reconciliation = await manager.reconcile();
  assert.equal(reconciliation.resolved.includes(processId), true, JSON.stringify(reconciliation));
  assert.equal(reconciliation.unresolved.length, 0, JSON.stringify(reconciliation));
  assert.equal(typeof ledger.supervisorIdentity, 'string');
  assert.equal(typeof ledger.supervisorEndpoint, 'string');
  const reports = await manager.disposeOwner('orphan-run');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].result.status, 'stopped');
  await manager.acknowledgeTerminalReport(processId);
  assert((await readdir(ledgerDirectory)).every(name => name.endsWith('.terminal.json')));
});

for (const recordKind of ['current', 'incompatible']) {
  test(`${recordKind}: unauthenticated reconciliation preserves process uncertainty and the admitted lease scope`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-core-process-pid-reuse-'));
    const ledgerDirectory = path.join(root, 'processes');
    await mkdir(ledgerDirectory, { recursive: true });
    const processId = 'proc_11111111-1111-4111-8111-111111111111';
    await writeFile(
      path.join(ledgerDirectory, `${processId}.json`),
      JSON.stringify({
        schemaVersion: recordKind === 'incompatible' ? 1 : 2,
        processId,
        supervisorPid: process.pid,
        supervisorIdentity: 'supervisor_22222222-2222-4222-8222-222222222222',
        supervisorEndpoint:
          process.platform === 'win32'
            ? '\\\\.\\pipe\\missing-agent-core-supervisor'
            : path.join(ledgerDirectory, 'missing.sock'),
        owner: {
          ownerId: 'old-run',
          runId: 'old-run',
          turnId: 'turn',
          toolBatchId: 'batch',
          callIndex: 0
        },
        startedAt: new Date().toISOString(),
        rootPath: root,
        terminalReported: false
      }) + '\n'
    );

    const host = createLocalToolHost({
      rootedFileAuthority: RootedFileAuthority.adopt(root),
      artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') }),
      processLedgerDirectory: ledgerDirectory,
      enabledTools: ['exec_command', 'write_stdin', 'stop_process']
    });
    await host.ready();
    const reconciliation = await host.reconciliation();
    assert.equal(reconciliation.unresolved.length, 1);
    assert.equal(reconciliation.unresolved[0].rootPath, recordKind === 'incompatible' ? '*' : root);
    assert.equal(host.commandExecution.resourceLeases.activeCount(), 1);
    assert.equal(
      host.commandExecution.resourceLeases.wouldWait({
        accesses: [{ mode: 'write', scope: 'files/a.txt' }],
        lockScopes: ['files/a.txt'],
        recovery: { kind: 'unknown' }
      }),
      true
    );
    assert.doesNotThrow(() => process.kill(process.pid, 0), 'the reused PID remains untouched');
    const refused = await host.commandExecution.start(await host.commandExecution.plan({
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`,
        rootedDirectory: '.',
        pty: false,
        timeoutMs: 1_000,
        yieldMs: 1,
        outputTokenBudget: 100,
        owner: {
          ownerId: 'new-run',
          runId: 'new-run',
          turnId: 'turn',
          toolBatchId: 'batch',
          callIndex: 0
        }
      }));
    assert.equal(refused.kind, 'not_started');
    assert.match(refused.diagnostic, /lifetime is unresolved/u);

    if (recordKind === 'incompatible') assert.match(reconciliation.unresolved[0].diagnostic, /schemaVersion|version/);
    await rm(path.join(ledgerDirectory, `${processId}.json`));
    const changed = await host.commandExecution.retryReconciliation();
    assert.equal(changed.unresolved.length, 1, 'missing evidence cannot prove release');
    assert.equal((await host.commandExecution.listProcesses())[0].status, 'unknown');
    await assert.rejects(host.commandExecution.acknowledgeUnresolved(reconciliation.unresolved), /evidence changed/);
    const resolved = await host.resolveReconciliation({ acknowledge: changed.unresolved });
    assert.equal(resolved.unresolved.length, 0);
    assert.equal(host.commandExecution.resourceLeases.activeCount(), 0);
    assert.deepEqual((await host.commandExecution.reconcile()).unresolved, []);
    const next = await startSettledCommand(host.commandExecution, {
      command: 'printf recovered', rootedDirectory: '.', pty: false,
      timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner: invocation
    });
    assert.equal(next.status, 'exited');
    await host.commandExecution.acknowledgeTerminalReport(next.processId);
    await host.close();
  });
}

test('supervisor handshake prevents user code before durable release and reconciles a post-release crash', async () => {
  const fixture = path.resolve('tests/fixtures/process-supervisor-crash.mjs');
  for (const phase of ['ledger_persisted', 'released']) {
    const root = await mkdtemp(path.join(tmpdir(), `agent-core-supervisor-${phase}-`));
    const crashed = spawnSync(process.execPath, [fixture, root, phase], {
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.equal(crashed.status, 45, crashed.stderr);
    const { processId, checkpoint } = JSON.parse(crashed.stdout);
    assert.equal(checkpoint, phase);
    const marker = path.join(root, 'user-command-started');
    if (phase === 'ledger_persisted') {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await assert.rejects(
        access(marker),
        /ENOENT/u,
        'the supervisor timed out without starting user code'
      );
    } else {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await access(marker);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await access(marker);
    }
    const ledgerDirectory = path.join(root, 'processes');
    const manager = new LocalCommandExecution({
      artifactRepository: new LocalArtifactRepository({
        rootDir: path.join(root, 'recovered-artifacts')
      }),
      rootedFileAuthority: testRootedFileAuthority(root),
      ledgerDirectory,
      ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
    });
    const reconciliation = await manager.reconcile();
    assert.equal(reconciliation.unresolved.length, 0, JSON.stringify(reconciliation));
    assert.equal(reconciliation.resolved.includes(processId), true, JSON.stringify(reconciliation));
    const reports = await manager.disposeOwner(`crash-${phase}`);
    assert.equal(reports.length, 1);
    assert.equal(
      phase === 'ledger_persisted'
        ? reports[0].result.status === 'failed'
        : reports[0].result.status === 'stopped',
      true
    );
    await manager.acknowledgeTerminalReport(processId);
  }
});

test('local host durably hands recovered terminal reports to old runs during startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-terminal-handoff-'));
  const fixture = path.resolve('tests/fixtures/process-orphan.mjs');
  const crashed = spawnSync(process.execPath, [fixture, root], {
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.equal(crashed.status, 44, crashed.stderr);
  const { processId } = JSON.parse(crashed.stdout);
  const delivered = [];
  const host = createLocalToolHost({
    rootedFileAuthority: RootedFileAuthority.adopt(root),
    artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'host-artifacts') }),
    processLedgerDirectory: path.join(root, 'processes'),
    enabledTools: ['exec_command', 'write_stdin', 'stop_process'],
    async commitTerminalReport(report) {
      delivered.push(report);
    }
  });
  await host.ready();
  assert.equal(delivered.length, 1, JSON.stringify(await host.reconciliation()));
  assert.equal(delivered[0].result.processId, processId);
  assert.equal(delivered[0].result.owner.runId, 'orphan-run');
  assert((await readdir(path.join(root, 'processes'))).every(name => name.endsWith('.terminal.json')));
  await host.close();
});

test('output budgets preserve gaps, UTF-8 and empty-view coverage independently of retained capture', async (t) => {
  const { context, manager, root } = await processContext({ maxCapturedBytes: 160, tailBytes: 64, maxPendingOutputBytes: 160 });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const result = await invokeSettledCommand(jsonToolCall('exec_command', {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('START-' + '🙂'.repeat(4000) + '-END')")}`,
    outputTokenBudget: 64
  }), tools, context);
  assert.equal(result.kind, 'result', result.summary);
  for (const budget of [64, 4000]) {
    const view = (await manager.query(result.output.processId, budget)).combined;
    assert.ok(view.segments.length >= 2);
    assert.equal(view.segments.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0), view.capturedBytes);
    assert.doesNotMatch(renderCommandOutput(view), /\uFFFD/);
    assert.match(renderCommandOutput(view), /START-[\s\S]*output omitted[\s\S]*-END/);
  }
  const empty = await manager.query(result.output.processId, 0);
  assert.deepEqual(empty.combined.segments, []);
  assert.equal(empty.combined.capturedBytes, 0);
  assert.equal(empty.combined.omittedBytes, 16010);
});

test('planning owns an immutable execution request before callers can mutate it', async (t) => {
  const { manager, root } = await processContext();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const owner = { ...invocation };
  const request = { command: 'printf original', rootedDirectory: '.', pty: false,
    timeoutMs: 5000, yieldMs: 1_000, outputTokenBudget: 1000, owner };
  const planning = manager.plan(request);
  request.command = 'printf changed';
  request.yieldMs = 0;
  owner.ownerId = 'changed-owner';
  const started = await manager.start(await planning);
  assert.equal(started.kind, 'started');
  const result = await settledCommandResult(manager, started.result);
  assert.equal(result.combined.segments.join(''), 'original');
  assert.equal(result.owner.ownerId, invocation.ownerId);
  assert.equal(Object.hasOwn(result.owner, 'requestAttempt'), false);
});

test('stream completeness is measured against its own offsets when capture keeps another stream at the end', async (t) => {
  const { context, manager, root } = await processContext({ maxCapturedBytes: 160, tailBytes: 64, maxPendingOutputBytes: 160 });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const script = "process.stdout.write('A'.repeat(4000)); setTimeout(() => process.stderr.write('B'.repeat(4000)), 100)";
  const result = await invokeSettledCommand(jsonToolCall('exec_command', {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    outputTokenBudget: 4000
  }), tools, context);
  assert.equal(result.kind, 'result', result.summary);
  assert.equal(result.output.stdout.startsAtOutputStart, true);
  assert.equal(result.output.stdout.endsAtOutputEnd, false);
  assert.match(renderCommandOutput(result.output.stdout), /Later output not included/);
  assert.equal(result.output.stderr.startsAtOutputStart, false);
  assert.equal(result.output.stderr.endsAtOutputEnd, true);
  assert.match(renderCommandOutput(result.output.stderr), /Earlier output not included/);
});

test('redaction precedes output selection and cannot expose a detached credential suffix', async (t) => {
  const { context, manager, artifacts, root } = await processContext({ maxCapturedBytes: 160, tailBytes: 64, maxPendingOutputBytes: 160 });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const script = "process.stdout.write('API_TOKEN=' + 'a'.repeat(4000) + 'sensitive-suffix')";
  const result = await invokeSettledCommand(jsonToolCall('exec_command', {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, outputTokenBudget: 64
  }), tools, context);
  assert.equal(result.kind, 'result', result.summary);
  assert.doesNotMatch(renderCommandOutput(result.output.combined), /sensitive-suffix|a{16}/);
  assert.match(renderCommandOutput(result.output.combined), /output omitted/);
  const artifact = Buffer.from(await artifacts.readVerified(result.output.artifact)).toString();
  assert.doesNotMatch(artifact, /sensitive-suffix|a{16}/);
});

test('authenticated process settlement is independent of incompatible output metadata', async (t) => {
  for (const output of ['missing', 'malformed', 'invalid-counts']) await t.test(output, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'process-evidence-'));
    const ledgerDirectory = path.join(root, 'processes');
    const files = testRootedFileAuthority(root);
    const options = { artifactRepository: new InMemoryArtifactRepository(), rootedFileAuthority: files,
      ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process };
    const first = new LocalCommandExecution(options);
    let second;
    t.after(async () => { await first.close(); await second?.close(); files.close(); await rm(root, { recursive: true, force: true }); });
    const request = { command: 'printf original', rootedDirectory: '.', pty: false,
      timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner: invocation };
    const result = await startSettledCommand(first, request);
    await first.unreportedTerminalProcesses(invocation.ownerId);
    const outputPath = path.join(ledgerDirectory, `${result.processId}.terminal.json`);
    if (output === 'missing') await rm(outputPath);
    else if (output === 'malformed') await writeFile(outputPath, '{');
    else {
      const receipt = JSON.parse(await readFile(outputPath, 'utf8'));
      receipt.combined.capturedBytes = receipt.combined.observedBytes + 1;
      await writeFile(outputPath, JSON.stringify(receipt));
    }
    second = new LocalCommandExecution(options);
    assert.deepEqual((await second.reconcile()).unresolved, []);
    const [report] = second.recoveredTerminalReports();
    assert.equal(report.result.status, 'exited');
    assert.equal(report.result.originalOutput.kind, 'unavailable');
    assert.match(report.result.originalOutput.diagnostic, /output/);
    assert.equal(second.resourceLeases.activeCount(), 0);
    const next = await startSettledCommand(second, { ...request, command: 'printf next' });
    assert.equal(next.combined.segments.join(''), 'next');
    await second.acknowledgeTerminalReport(report.result.processId);
    await second.acknowledgeTerminalReport(next.processId);
  });
});

test('retrying recovery leaves a currently managed process running', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'process-retry-'));
  const files = testRootedFileAuthority(root);
  const manager = new LocalCommandExecution({ artifactRepository: new InMemoryArtifactRepository(),
    rootedFileAuthority: files, ledgerDirectory: path.join(root, 'processes'),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  t.after(async () => { await manager.close(); files.close(); await rm(root, { recursive: true, force: true }); });
  const running = await startCommand(manager, { command: 'sleep 30', rootedDirectory: '.', pty: false,
    timeoutMs: 60_000, yieldMs: 0, outputTokenBudget: 100, owner: invocation });
  assert.equal(running.status, 'running');
  assert.deepEqual((await manager.retryReconciliation()).unresolved, []);
  assert.equal((await manager.query(running.processId, 100)).status, 'running');
  await manager.disposeOwner(invocation.ownerId);
});

test('terminal handoff retries use stable evidence and retain it until durable acceptance', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'process-handoff-'));
  const files = testRootedFileAuthority(root);
  const ledgerDirectory = path.join(root, 'processes');
  let accepted = false;
  const deliveries = [];
  const options = { artifactRepository: new InMemoryArtifactRepository(), rootedFileAuthority: files,
    ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    async commitTerminalReport(report) {
      deliveries.push(report);
      if (!accepted) throw new Error('Ledger unavailable');
    } };
  const first = new LocalCommandExecution(options);
  let second;
  t.after(async () => { await first.close(); await second?.close(); files.close(); await rm(root, { recursive: true, force: true }); });
  const result = await startSettledCommand(first, { command: 'printf evidence', rootedDirectory: '.', pty: false,
    timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner: invocation });
  const [original] = await first.unreportedTerminalProcesses(invocation.ownerId);
  assert.deepEqual(await first.unreportedTerminalProcesses(invocation.ownerId), [original]);
  assert.equal(deliveries.length, 1);
  await access(path.join(ledgerDirectory, `${result.processId}.json`));
  second = new LocalCommandExecution(options);
  assert.deepEqual((await second.reconcile()).unresolved, []);
  const recovered = deliveries.at(-1);
  await second.retryReconciliation();
  assert.deepEqual(deliveries.at(-1), recovered);
  accepted = true;
  await second.retryReconciliation();
  assert((await readdir(ledgerDirectory)).every(name => name.endsWith('.terminal.json')));
  assert.deepEqual(second.recoveredTerminalReports(), []);
});

test('an output receipt write failure cannot erase a known terminal outcome', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'process-receipt-failure-'));
  const files = testRootedFileAuthority(root);
  const ledgerDirectory = path.join(root, 'processes');
  let blockedPath;
  const manager = new LocalCommandExecution({ artifactRepository: new InMemoryArtifactRepository(),
    rootedFileAuthority: files, ledgerDirectory, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    async onSupervisorCheckpoint(checkpoint, processId) {
      if (checkpoint !== 'ledger_persisted' || blockedPath) return;
      blockedPath = path.join(ledgerDirectory, `${processId}.terminal.json`);
      await mkdir(blockedPath);
    } });
  t.after(async () => { await manager.close(); files.close(); await rm(root, { recursive: true, force: true }); });
  const request = { command: 'printf result', rootedDirectory: '.', pty: false,
    timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner: invocation };
  const result = await startSettledCommand(manager, request);
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.match(result.diagnostic, /terminal record storage failed/);
  const [report] = await manager.disposeOwner(invocation.ownerId);
  assert.equal(report.result.status, 'exited');
  const next = await startSettledCommand(manager, request);
  assert.equal(next.status, 'exited');
  await rm(blockedPath, { recursive: true });
  await manager.acknowledgeTerminalReport(result.processId);
  await manager.acknowledgeTerminalReport(next.processId);
});

test('acknowledged terminal processes survive buffer expiration and restart with their original owner and artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'process-terminal-retention-'));
  const files = testRootedFileAuthority(root);
  const artifacts = new InMemoryArtifactRepository();
  const reports = [];
  const options = { artifactRepository: artifacts, rootedFileAuthority: files,
    ledgerDirectory: path.join(root, 'processes'), ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    maxCapturedBytes: 256, maxTotalCapturedBytes: 256, completedRetentionMs: 20,
    async commitTerminalReport(report) { reports.push(report); } };
  const manager = new LocalCommandExecution(options);
  let reopened;
  t.after(async () => { await manager.close(); await reopened?.close(); files.close(); await rm(root, { recursive: true, force: true }); });
  const request = { command: 'printf original', rootedDirectory: '.', pty: false,
    timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner: invocation };
  const original = await startSettledCommand(manager, request);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(await manager.unreportedTerminalProcesses(invocation.ownerId), []);
  const terminal = await manager.query(original.processId, 100, 0, original.cursorEnd, invocation);
  assert.equal(terminal.status, 'exited');
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.cursorEnd, original.cursorEnd);
  assert.deepEqual(terminal.owner, original.owner);
  assert.deepEqual(terminal.artifact, original.artifact);
  assert.deepEqual(terminal.combined.segments, []);
  const retained = await manager.query(original.processId, 100, 0, 0, invocation);
  assert.equal(retained.status, 'exited');
  assert.equal(retained.exitCode, 0);
  assert.equal(retained.combined.segments.join(''), 'original');
  assert.equal(retained.cursorExpired, false);
  await assert.rejects(manager.query(original.processId, 100, 0, 0, { ...invocation, ownerId: 'foreign' }), /another resource owner/);
  await assert.rejects(manager.query(original.processId, 100, 0, 999, invocation), /Invalid process output cursor/);
  assert.equal((await manager.terminate(original.processId, invocation)).status, 'exited');
  await assert.rejects(manager.terminate(original.processId, { ...invocation, ownerId: 'foreign' }), /another resource owner/);
  const next = await startSettledCommand(manager, request);
  assert.equal(next.status, 'exited', 'expired buffers release capture reservations');
  assert.equal(reports.length, 2);
  reopened = new LocalCommandExecution(options);
  assert.deepEqual((await reopened.reconcile()).unresolved, []);
  const recovered = await reopened.terminate(original.processId, invocation);
  assert.equal(recovered.status, 'exited');
  assert.deepEqual(recovered.artifact, original.artifact);
  const readAfterRestart = await reopened.query(original.processId, 100, 0, 3, invocation);
  assert.equal(readAfterRestart.combined.segments.join(''), 'ginal');
  const bounded = await reopened.query(original.processId, 1, 0, 0, invocation);
  assert(bounded.combined.capturedBytes <= 2);
  assert(bounded.stdout.capturedBytes + bounded.stderr.capturedBytes + bounded.combined.capturedBytes <= 4);
  assert.equal(reports.length, 2, 'querying terminal truth does not republish completion');
  assert((await readdir(options.ledgerDirectory)).every(name => name.endsWith('.terminal.json')));
});

test('late output recovery preserves redaction, UTF-8 ranges and terminal truth when storage fails', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'process-late-output-'));
  const files = testRootedFileAuthority(root);
  const artifacts = new InMemoryArtifactRepository();
  const manager = new LocalCommandExecution({ artifactRepository: artifacts, rootedFileAuthority: files,
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process, completedRetentionMs: 10,
    maxCapturedBytes: 512, tailBytes: 128 });
  t.after(async () => { await manager.close(); files.close(); await rm(root, { recursive: true, force: true }); });
  const source = 'API_TOKEN=private-secret\n' + '改😀'.repeat(400) + '-TAIL';
  const result = await startSettledCommand(manager, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(source)})`)}`,
    rootedDirectory: '.', pty: false, timeoutMs: 5_000, yieldMs: 1_000, outputTokenBudget: 100, owner: invocation
  });
  const suffixCursor = Buffer.byteLength('API_TOKEN=');
  const liveSuffix = await manager.query(result.processId, 1000, 0, suffixCursor, invocation);
  assert.doesNotMatch(renderCommandOutput(liveSuffix.stdout), /private-secret/);
  assert.doesNotMatch(renderCommandOutput(liveSuffix.combined), /private-secret/);
  await manager.acknowledgeTerminalReport(result.processId);
  await new Promise(resolve => setTimeout(resolve, 50));
  const retainedSuffix = await manager.query(result.processId, 1000, 0, suffixCursor, invocation);
  assert.doesNotMatch(renderCommandOutput(retainedSuffix.stdout), /private-secret/);
  assert.doesNotMatch(renderCommandOutput(retainedSuffix.combined), /private-secret/);
  const retained = await manager.query(result.processId, 1000, 0, 0, invocation);
  assert.equal(retained.status, 'exited');
  assert.equal(retained.exitCode, 0);
  const output = renderCommandOutput(retained.combined);
  assert.doesNotMatch(output, /private-secret|\uFFFD/);
  assert.match(output, /REDACTED[\s\S]*output omitted[\s\S]*-TAIL/);
  assert(retained.combined.omittedBytes > 0);
  const verifiedRead = artifacts.readVerified.bind(artifacts);
  artifacts.readVerified = async ref => {
    if (ref.visibility === 'protected') throw new Error('storage unavailable');
    return verifiedRead(ref);
  };
  const unavailable = await manager.query(result.processId, 100, 0, 0, invocation);
  assert.equal(unavailable.status, 'exited');
  assert.equal(unavailable.exitCode, 0);
  assert.deepEqual(unavailable.artifact, retained.artifact);
  assert.match(unavailable.diagnostic, /Retained process output.*storage unavailable/);
});

test('unavailable process controls return known failures rather than uncertain effects', async (t) => {
  const { manager, context, root } = await processContext();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  for (const name of ['stop_process', 'write_stdin']) {
    const observation = await invokeToolCall(jsonToolCall(name, { processId: 'missing-process' }), tools, context);
    assert.equal(observation.kind, 'failure');
    assert.equal(observation.execution.state, 'not_started');
    assert.equal(observation.output.details.cause, 'not_found');
  }
});

test('active commands expose their effective deadline and rejected writes return bounded terminal evidence', async t => {
  const { context, manager, root } = await processContext({ maxProcessLifetimeMs: 500 });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const script = "process.stdout.write('ready'); setInterval(()=>{},1000)";
  const before = Date.now();
  const started = await invokeToolCall(jsonToolCall('exec_command', {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    timeoutMs: 5_000
  }), tools, context);
  assert.equal(started.kind, 'result');
  assert.equal(started.output.status, 'running');
  const deadline = Date.parse(started.output.deadline);
  assert.ok(deadline >= before && deadline <= Date.now() + 500);
  const terminal = await pollUntilSettled(started.output.processId, context);
  assert.equal(terminal.output.status, 'timed_out');
  const rejected = await invokeToolCall(jsonToolCall('write_stdin', {
    processId: started.output.processId, text: 'Too late', outputTokenBudget: 64
  }), tools, context);
  assert.equal(rejected.kind, 'failure');
  assert.equal(rejected.execution.state, 'not_started');
  assert.equal(rejected.output.details.cause, 'not_running');
  const outcome = rejected.output.details.process;
  assert.equal(outcome.status, 'timed_out');
  assert.match(outcome.combined.segments.join(''), /ready/);
  assert.equal(outcome.cursorEnd, terminal.output.cursorEnd);
  assert.ok(outcome.combined.capturedBytes <= 64 * 4);
  const presentation = writeStdinTool.buildModelContent({ observation: rejected });
  assert.match(JSON.stringify(presentation), /timed_out/);
  assert.match(JSON.stringify(presentation), /ready/);
  assert.doesNotMatch(JSON.stringify(presentation), /ownerId/);
  const foreign = await invokeToolCall(jsonToolCall('write_stdin', {
    processId: started.output.processId, text: 'Unauthorized'
  }), tools, { ...context, invocation: { ...invocation, runId: 'foreign', ownerId: 'foreign' } });
  assert.equal(foreign.output.details.cause, 'wrong_owner');
  assert.equal(foreign.output.details.process, undefined);
});

test('process wait guidance defaults to a long interruptible observation', () => {
  const parsed = writeStdinTool.decodeInput({ kind: 'json', value: { processId: 'process' } });
  assert.equal(parsed.ok, true);
  const input = parsed.input;
  assert.equal(input.yieldMs, 30_000);
  assert.equal(input.afterCursor, 0);
  assert.match(writeStdinTool.description, /wait for output or termination/);
  assert.match(writeStdinTool.jsonSchema.properties.afterCursor.description, /prior result cursorEnd/);
  assert.match(writeStdinTool.jsonSchema.properties.yieldMs.description, /Keep the default/);
  for (const yieldMs of [-1, 0.5])
    assert.equal(writeStdinTool.decodeInput({ kind: 'json', value: { processId: 'process', yieldMs } }).ok, false);
});

test('quiet process waits stay bounded and report no fresh output without claiming completion', async (t) => {
  const { context, manager, root } = await processContext({ maxYieldMs: 100 });
  t.after(async () => {
    await manager.close();
    context.services.rootedFileAuthority.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await invokeToolCall(jsonToolCall('exec_command', {
    command: 'sleep 30', timeoutMs: 60_000
  }), tools, context);
  assert.equal(started.kind, 'result', JSON.stringify(started));
  const before = performance.now();
  const quiet = await invokeToolCall(jsonToolCall('write_stdin', {
    processId: started.output.processId, afterCursor: started.output.cursorEnd, yieldMs: 30_000
  }), tools, context);
  const elapsed = performance.now() - before;
  assert(elapsed >= 75, `Wait returned too early: ${elapsed}ms`);
  assert(elapsed < 5_000, `Configured wait cap was not honored: ${elapsed}ms`);
  assert.equal(quiet.output.status, 'running');
  assert.equal(quiet.output.cursorStart, quiet.output.cursorEnd);
  assert.equal(quiet.output.deadline, started.output.deadline);
  assert.equal(quiet.output.combined.segments.join(''), '');
  const content = writeStdinTool.buildModelContent({ observation: quiet });
  assert.match(content.map(part => part.text).join('\n'), /No fresh output.*still running/);
  assert.match(content.map(part => part.text).join('\n'), /afterCursor=cursorEnd, and a longer yieldMs/);
});

test('long activity waits wake for fresh input output, exit, and owner cancellation', async (t) => {
  for (const action of ['output', 'exit', 'cancel']) {
    await t.test(action, async (t) => {
      const { context, manager, root } = await processContext();
      t.after(async () => {
        await manager.close();
        context.services.rootedFileAuthority.close();
        await rm(root, { recursive: true, force: true });
      });
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "process.stdout.write('ready\\n'); process.stdin.on('data', d => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0));"
      )}`;
      const started = await invokeToolCall(jsonToolCall('exec_command', {
        command, timeoutMs: 60_000
      }), tools, context);
      assert.equal(started.kind, 'result', JSON.stringify(started));
      assert.match(started.output.combined.segments.join(''), /ready/);
      let settled = false;
      const waiting = invokeToolCall(jsonToolCall('write_stdin', {
        processId: started.output.processId, afterCursor: started.output.cursorEnd, yieldMs: 30_000
      }), tools, context).then(result => { settled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(settled, false, 'A quiet active process must remain waiting');
      const before = performance.now();
      if (action === 'output') await manager.writeInput(started.output.processId, 'fresh\n', invocation);
      else if (action === 'exit') await manager.closeInput(started.output.processId, invocation);
      else await manager.disposeOwner(invocation.ownerId);
      const result = await waiting;
      assert(performance.now() - before < 5_000, 'Activity must wake the wait before its 30s limit');
      assert.equal(result.output.cursorStart, started.output.cursorEnd);
      assert.doesNotMatch(result.output.combined.segments.join(''), /ready/);
      if (action === 'output') {
        assert.equal(result.output.status, 'running');
        assert.match(result.output.combined.segments.join(''), /fresh/);
      } else if (action === 'exit') {
        assert.equal(result.output.status, 'exited');
        const content = writeStdinTool.buildModelContent({ observation: result });
        assert.doesNotMatch(content.map(part => part.text).join('\n'), /Await progress/);
      } else {
        // A termination request can wake the existing activity waiter before settlement.
        // Preserve that prompt interruption without inventing a terminal outcome.
        assert(['running', 'stopped'].includes(result.output.status));
        const terminal = await manager.query(started.output.processId, 100, 0, result.output.cursorEnd, invocation);
        assert.equal(terminal.status, 'stopped');
      }
    });
  }
});

test('wait guidance preserves process facts and only appears for quiet running ranges', () => {
  const empty = { segments: [], observedBytes: 0, capturedBytes: 0, omittedBytes: 0,
    startsAtOutputStart: true, endsAtOutputEnd: true };
  for (const status of ['running', 'exited', 'stopped', 'timed_out', 'failed']) {
    const output = { processId: 'quiet-process', owner: invocation, status,
      cursorStart: 0, cursorEnd: 0, stdout: empty, stderr: empty, combined: empty,
      ...(status === 'running' ? { deadline: '2026-10-16T23:30:00.000Z' } : { exitCode: 0 }) };
    const original = structuredClone(output);
    const content = writeStdinTool.buildModelContent({ observation: { kind: 'result', output } });
    assert.deepEqual(output, original, 'Presentation must not mutate authoritative output');
    assert.equal(JSON.parse(content[0].text).status, status);
    assert.equal(content.some(part => part.text.includes('No fresh output')), status === 'running');
  }
  const fresh = { ...empty, segments: ['fresh'], observedBytes: 5, capturedBytes: 5 };
  const content = writeStdinTool.buildModelContent({ observation: { kind: 'result', output: {
    processId: 'active-process', owner: invocation, status: 'running', cursorStart: 0, cursorEnd: 5,
    stdout: fresh, stderr: empty, combined: fresh
  } } });
  assert.equal(content.some(part => part.text.includes('No fresh output')), false);
  assert.equal(content.at(-1).text, 'fresh');
});

test('requested long process waits retain the configured yield bound', async () => {
  const context = { services: { localToolConfiguration: {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    process: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process, maxYieldMs: 75 }
  } } };
  for (const [requested, expected] of [[undefined, 75], [0, 0], [50, 50], [30_000, 75]]) {
    const parsed = writeStdinTool.decodeInput({ kind: 'json', value: { processId: 'p', ...(requested === undefined ? {} : { yieldMs: requested }) } });
    assert.equal(parsed.ok, true);
    const canonical = await writeStdinTool.canonicalizeInput(parsed.input, context);
    assert.equal(canonical.yieldMs, expected);
    assert.equal(canonical.afterCursor, 0);
  }
});

test('exec_command exposes a bounded observation window without execution modes', async () => {
  const decoded = execCommandTool.decodeInput({ kind: 'json', value: { command: 'printf ready' } });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.input.yieldMs, 30_000);
  assert.equal(Object.hasOwn(execCommandTool.jsonSchema.properties, 'background'), false);
  assert.equal(execCommandTool.decodeInput({ kind: 'json', value: { command: 'true', background: true } }).ok, false);
  for (const yieldMs of [-1, 0.5])
    assert.equal(execCommandTool.decodeInput({ kind: 'json', value: { command: 'true', yieldMs } }).ok, false);
});

test('steering interrupts launch and query observation without terminating the owned process or releasing its lease', async t => {
  const { manager, root } = await processContext();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const lease = await manager.resourceLeases.acquire({
    accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['files']
  }, invocation.ownerId);
  const result = await startCommand(manager, {
    command: 'sleep 30', rootedDirectory: '.', pty: false,
    timeoutMs: 60_000, yieldMs: 30_000, outputTokenBudget: 100, owner: invocation
  }, { lease, observationSignal: AbortSignal.abort('steer launch') });
  assert.equal(result.status, 'running');
  assert.equal(manager.activeCount(), 1);
  assert.equal(manager.resourceLeases.wouldWait({
    accesses: [{ mode: 'write', scope: 'files/note.txt' }], lockScopes: ['files/note.txt']
  }), true);
  const controller = new AbortController();
  const before = performance.now();
  const pending = manager.query(result.processId, 100, 30_000, result.cursorEnd, invocation, controller.signal);
  setTimeout(() => controller.abort('steer query'), 25);
  const queried = await pending;
  assert(performance.now() - before < 5_000);
  assert.equal(queried.status, 'running');
  assert.equal(manager.activeCount(), 1);
  assert.equal(manager.resourceLeases.activeCount(), 1);
  await manager.terminate(result.processId, invocation);
  assert.equal(manager.resourceLeases.activeCount(), 0);
});


test('a yielded stop preserves active execution when its output cursor is rejected', async t => {
  const { context, manager, root } = await processContext();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  let stopped = 0;
  manager.terminate = async () => { stopped += 1; return { status: 'running' }; };
  manager.query = async processId => { throw new CommandProcessOperationRejectedError(processId, 'invalid_cursor'); };
  const result = await invokeToolCall(jsonToolCall('stop_process', {
    processId: 'proc_11111111-1111-4111-8111-111111111111', afterCursor: 999
  }), tools, { ...context, observationSignal: AbortSignal.abort('steer') });
  assert.equal(stopped, 1);
  assert.equal(result.kind, 'failure');
  assert.equal(result.execution.state, 'active');
  assert.equal(result.output.details.cause, 'invalid_cursor');
});


test('exec observation defaults and explicit snapshots retain the configured yield bound', async t => {
  const { context, manager, root } = await processContext({ maxYieldMs: 75 });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  for (const [requested, expected] of [[undefined, 75], [0, 0], [50, 50], [30_000, 75]]) {
    const parsed = execCommandTool.decodeInput({ kind: 'json', value: {
      command: 'true', ...(requested === undefined ? {} : { yieldMs: requested })
    } });
    assert.equal(parsed.ok, true);
    const canonical = await execCommandTool.canonicalizeInput(parsed.input, context);
    assert.equal(canonical.yieldMs, expected);
  }
});

test('terminal observations wait for the single durable report handoff', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'process-terminal-observation-'));
  const files = testRootedFileAuthority(root);
  let enterHandoff;
  const entered = new Promise(resolve => { enterHandoff = resolve; });
  let releaseHandoff;
  const released = new Promise(resolve => { releaseHandoff = resolve; });
  let handoffs = 0;
  const manager = new LocalCommandExecution({ artifactRepository: new InMemoryArtifactRepository(),
    rootedFileAuthority: files, ledgerDirectory: path.join(root, 'processes'),
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
    async commitTerminalReport(report) {
      handoffs += 1;
      assert.equal(report.result.status, 'exited');
      enterHandoff(report.result.processId);
      await released;
    }
  });
  t.after(async () => { releaseHandoff(); await manager.close(); files.close(); await rm(root, { recursive: true, force: true }); });
  const running = await startCommand(manager, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => process.stdout.write('done'), 100)")}`,
    rootedDirectory: '.', pty: false, timeoutMs: 5_000, yieldMs: 0, outputTokenBudget: 100, owner: invocation
  });
  const processId = await entered;
  assert.equal(processId, running.processId);
  let observed = false;
  const observation = manager.query(processId, 100, 0, 0, invocation).then(result => { observed = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(observed, false, 'terminal results must not outrun their durable report handoff');
  const controller = new AbortController();
  const interrupted = manager.query(processId, 100, 0, 0, invocation, controller.signal);
  controller.abort('steering during finalization');
  const pending = await interrupted;
  assert.equal(pending.status, 'exited', 'steering does not falsify the known process outcome');
  assert.equal(pending.finalizationPending, true);
  assert.equal(pending.artifact, undefined, 'yielded snapshots do not await artifact IO');
  assert.equal((await manager.terminate(processId, invocation, controller.signal)).finalizationPending, true);
  releaseHandoff();
  const terminal = await observation;
  assert.equal(terminal.status, 'exited');
  assert.equal(terminal.combined.segments.join(''), 'done');
  assert.equal(terminal.finalizationPending, undefined);
  assert.equal(handoffs, 1);
  assert.deepEqual(await manager.unreportedTerminalProcesses(invocation.ownerId), []);
});


test('steering yields a truthful terminal snapshot while artifact persistence is blocked', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'process-artifact-observation-'));
  const files = testRootedFileAuthority(root);
  const artifacts = new InMemoryArtifactRepository();
  const store = artifacts.store.bind(artifacts);
  let enterStore;
  const entered = new Promise(resolve => { enterStore = resolve; });
  let releaseStore;
  const released = new Promise(resolve => { releaseStore = resolve; });
  artifacts.store = async input => { enterStore(); await released; return store(input); };
  const manager = new LocalCommandExecution({ artifactRepository: artifacts, rootedFileAuthority: files,
    ledgerDirectory: path.join(root, 'processes'), ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  t.after(async () => { releaseStore(); await manager.close(); files.close(); await rm(root, { recursive: true, force: true }); });
  const running = await startCommand(manager, {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => process.stdout.write('done'), 100)")}`,
    rootedDirectory: '.', pty: false, timeoutMs: 5_000, yieldMs: 0, outputTokenBudget: 100, owner: invocation
  });
  await entered;
  const pending = await manager.query(running.processId, 100, 0, 0, invocation, AbortSignal.abort('steer'));
  assert.equal(pending.status, 'exited');
  assert.equal(pending.finalizationPending, true);
  assert.equal(pending.artifact, undefined);
  releaseStore();
  const terminal = await manager.query(running.processId, 100, 0, 0, invocation);
  assert.equal(terminal.finalizationPending, undefined);
  assert.ok(terminal.artifact);
});


test('pending process finalization remains an active observation with truthful terminal presentation', async t => {
  const { context, manager, root } = await processContext();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const empty = { segments: [], observedBytes: 0, capturedBytes: 0, omittedBytes: 0,
    startsAtOutputStart: true, endsAtOutputEnd: true };
  const output = { processId: 'pending-process', owner: {
    ownerId: invocation.ownerId, runId: invocation.runId, turnId: invocation.turnId,
    toolBatchId: invocation.toolBatchId, callIndex: invocation.callIndex
  }, status: 'exited', finalizationPending: true,
    cursorStart: 0, cursorEnd: 0, stdout: empty, stderr: empty, combined: empty, exitCode: 0 };
  const signal = AbortSignal.abort('steer pending finalization');
  manager.query = async (_id, _budget, _yield, _cursor, _owner, receivedSignal) => {
    assert.equal(receivedSignal, signal, 'control follow-up must preserve the observation yield');
    return output;
  };
  manager.terminate = async () => output;
  for (const toolName of ['write_stdin', 'stop_process']) {
    const result = await invokeToolCall(jsonToolCall(toolName, { processId: output.processId }), tools, { ...context, observationSignal: signal });
    assert.equal(result.kind, 'result');
    assert.equal(result.execution.state, 'active');
    assert.equal(result.output.status, 'exited');
    assert.equal(result.output.finalizationPending, true);
    const content = (toolName === 'write_stdin' ? writeStdinTool : stopProcessTool).buildModelContent({ observation: result });
    const metadata = JSON.parse(content[0].text);
    assert.equal(metadata.status, 'exited');
    assert.equal(metadata.finalizationPending, true);
    assert.equal(metadata.processId, output.processId);
  }
});
