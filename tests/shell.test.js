import test from 'node:test';
import assert from 'node:assert/strict';
import { ShellRunner } from '@agent-core/tools-local';
import { assessShellCommand } from '@agent-core/tools-local/testing/shell-command/safety';

test('ShellRunner handles spawn errors and truncates output', async () => {
  const runner = new ShellRunner({ maxStdoutBytes: 10, maxStderrBytes: 10 });
  const missing = await runner.run({ command: 'definitely-not-a-real-command-agent-core' });
  assert.equal(missing.outcome, 'process_failed');
  assert.equal(missing.cleanup.status, 'settled');
  assert.ok(missing.process.diagnostic || missing.stderr.length > 0);

  const result = await runner.run({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(100))'] });
  assert.equal(result.outcome, 'exited');
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.cleanup.status, 'settled');
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdoutObservedBytes, 100);
  assert.equal(result.stdoutRetainedBytes, 10);
});

test('assessShellCommand blocks destructive command patterns', () => {
  assert.equal(assessShellCommand('rm -rf .').allowed, false);
  assert.equal(assessShellCommand('npm test').allowed, true);
});
