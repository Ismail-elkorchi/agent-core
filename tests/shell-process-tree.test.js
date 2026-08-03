import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShellRunner } from '@agent-core/tools-local';

test('ShellRunner timeout terminates descendants of shell commands', async () => {
  const fixture = await createProcessTreeFixture();
  let descendantPid;
  try {
    const result = await new ShellRunner().run({
      command: fixture.command,
      args: fixture.args,
      shell: fixture.shell,
      timeoutMs: 500
    });
    descendantPid = await waitForRecordedPid(fixture.pidFile);

    assert.equal(result.outcome, 'timed_out');
    assert.equal(result.process.signal, 'SIGKILL');
    assert.equal(result.cleanup.status, 'settled');
    await assertProcessStopped(descendantPid);
  } finally {
    forceStop(descendantPid);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('ShellRunner abort terminates signal-resistant descendants', async () => {
  const fixture = await createProcessTreeFixture();
  const controller = new AbortController();
  let descendantPid;
  try {
    const running = new ShellRunner().run({
      command: fixture.command,
      args: fixture.args,
      shell: fixture.shell,
      timeoutMs: 10_000,
      signal: controller.signal
    });
    descendantPid = await waitForRecordedPid(fixture.pidFile);
    controller.abort('test abort');
    const result = await running;

    assert.equal(result.outcome, 'aborted');
    assert.equal(result.process.signal, 'SIGTERM');
    assert.equal(result.cleanup.status, 'settled');
    await assertProcessStopped(descendantPid);
  } finally {
    forceStop(descendantPid);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createProcessTreeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-core-shell-tree-'));
  const helper = path.join(directory, 'process-tree.mjs');
  const pidFile = path.join(directory, 'descendant.pid');
  await writeFile(helper, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "process.on('SIGTERM', () => {});",
    "const descendant = spawn(process.execPath, ['--input-type=module', '--eval', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    "writeFileSync(process.argv[2], String(descendant.pid));",
    "setInterval(() => {}, 1000);"
  ].join('\n'), 'utf8');
  return process.platform === 'win32'
    ? { directory, pidFile, command: process.execPath, args: [helper, pidFile], shell: false }
    : {
        directory,
        pidFile,
        command: `${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(pidFile)}`,
        args: [],
        shell: true
      };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readRecordedPid(pidFile) {
  return Number.parseInt(await readFile(pidFile, 'utf8'), 10);
}

async function waitForRecordedPid(pidFile) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readRecordedPid(pidFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await delay(10);
    }
  }
  throw new Error('Timed out waiting for the descendant process id.');
}

async function assertProcessStopped(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(pid))) return;
    await delay(10);
  }
  assert.fail(`Descendant process ${String(pid)} remained alive.`);
}

async function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => undefined);
    if (stat === undefined || stat.split(' ')[2] === 'Z') return false;
  }
  return true;
}

function forceStop(pid) {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
