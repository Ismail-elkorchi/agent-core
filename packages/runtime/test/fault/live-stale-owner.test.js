import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { agentEventCodec } from '@agent-core/runtime';
import { createLiveDriverRuntime } from './fixtures/live-driver-support.mjs';

const modes = ['before_start', 'inside_effect', 'after_completion'];

for (const mode of modes) {
  test(`a live stale owner cannot duplicate work when paused ${mode.replaceAll('_', ' ')}`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `agent-live-driver-${mode}-`));
    const fixture = path.resolve('packages/runtime/test/fault/fixtures/live-driver-old.mjs');
    const child = spawn(process.execPath, [fixture, root, mode], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    try {
      const initialMessages = [await nextMessage(lines), await nextMessage(lines)];
      const runMessage = initialMessages.find((message) => message.type === 'run');
      const checkpoint = initialMessages.find((message) => message.type === 'checkpoint');
      assert.ok(runMessage);
      assert.deepEqual(checkpoint, { type: 'checkpoint', checkpoint: mode });

      const replacement = createLiveDriverRuntime({ root, mode, role: 'replacement' });
      const firstRecovery = await replacement.resume(runMessage.runId).result;
      if (mode === 'inside_effect') {
        assert.equal(firstRecovery.state, 'suspended');
        assert.equal(firstRecovery.reason, 'tool_outcome_unknown');
      } else {
        assert.equal(firstRecovery.state, 'ended');
        assert.equal(firstRecovery.terminal.executionStatus, 'completed');
      }

      await writeFile(path.join(root, 'release-old'), 'release\n');
      const oldOutcome = await nextMessage(lines);
      assert.equal(oldOutcome.type, 'error');
      assert.match(oldOutcome.message, /driver|stale|tail|replacement|already terminal/iu);
      assert.equal(await exitCode(child), 0, stderr);

      const finalResult = mode === 'inside_effect'
        ? await replacement.resume(runMessage.runId).result
        : firstRecovery;
      assert.equal(finalResult.state, 'ended');
      assert.equal(finalResult.terminal.executionStatus, 'completed');
      assert.equal(finalResult.terminal.modelOutput.message, 'replacement completed');

      const invocations = await readFile(path.join(root, 'external-invocations'), 'utf8');
      assert.deepEqual(invocations.trim().split('\n'), ['invoke']);
      const events = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
      const records = [];
      for await (const record of events.read(runMessage.runId)) records.push(record.event);
      assert.equal(records.filter((event) => event.type === 'tool.started').length, 1);
      assert.equal(records.filter((event) => event.type === 'tool.ended').length, 1);
      assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 1);
      assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
      assert.equal((await events.verifyIntegrity(runMessage.runId)).ok, true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function nextMessage(iterator) {
  const next = await iterator.next();
  if (next.done) throw new Error('Live-driver fixture exited before the expected message.');
  return JSON.parse(next.value);
}

function exitCode(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => signal === null ? resolve(code) : reject(new Error(`Fixture exited with ${signal}.`)));
  });
}
