import test from 'node:test';
import { invokeToolCall, jsonToolCall, presentToolObservation } from '../tool-call-helpers.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sha256Text } from '@agent-core/tools-local/testing/filesystem';
import { validateToolObservationPresentation } from '@agent-core/tools';
import {
  applyPatchTool,
  formatShellRuntimeForPrompt,
  inspectLocalShellRuntime,
  listDirectoryTreeTool,
  readTextFilesTool,
  shellCommandTool,
  searchFileTextTool,
  ShellRunner
} from '@agent-core/tools-local';

const readOnlyPolicy = { allowedRisks: ['read'] };
const writePolicy = { allowedRisks: ['read', 'write'] };
const executePolicy = { allowedRisks: ['read', 'execute'] };
const dryRunWritePolicy = { allowedRisks: ['read'], dryRunWrites: true };
const allTools = [listDirectoryTreeTool, searchFileTextTool, readTextFilesTool, applyPatchTool, shellCommandTool];

test('shell_command runs shell syntax and requires execution services', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-shell-command-'));

  assert.equal(shellCommandTool.jsonSchema.properties.timeoutMs.default, 120_000);
  assert.equal(shellCommandTool.jsonSchema.properties.maxOutputBytes.default, 64_000);
  assert.equal(shellCommandTool.jsonSchema.properties.previewMode.default, 'head_tail');
  assert.equal(shellCommandTool.jsonSchema.properties.previewBytes.default, 4_000);
  assert.equal(shellCommandTool.jsonSchema.properties.workdir.default, '.');
  assert.deepEqual(shellCommandTool.jsonSchema.required, ['command']);
  const localRuntime = inspectLocalShellRuntime();
  assert.equal(localRuntime.runtime, 'local');
  assert.equal(localRuntime.commands.length > 0, true);
  assert.equal(localRuntime.commands.length > 0, true);
  const completeDiscovery = { ...localRuntime, commands: Array.from({ length: 100 }, (_, index) => ({ name: `command-${String(index)}`, category: 'test' })) };
  const cappedPrompt = formatShellRuntimeForPrompt(completeDiscovery, { maxCommands: 100 });
  assert.equal((cappedPrompt.match(/command-/g) ?? []).length, 60, 'raw discovery remains complete while prompt formatting is capped');
  const shellRunner = new ShellRunner();
  assert.equal(shellRunner.describeEnvironment(), shellRunner.describeEnvironment());
  const runtimePrompt = formatShellRuntimeForPrompt(shellRunner.describeEnvironment(), { maxCommands: 8 });
  assert.match(runtimePrompt, /Shell runtime snapshot/);
  assert.match(runtimePrompt, /Useful commands found/);
  assert.match(runtimePrompt, /bounded snapshot/);
  assert.match(runtimePrompt, /binary was found on the shell runtime PATH/);
  assert.equal((runtimePrompt.match(/, /g) ?? []).length < 12, true);
  const shellGuide = typeof shellCommandTool.promptGuide === 'function'
    ? shellCommandTool.promptGuide({ inputFormat: 'json function', services: { shellRunner } })
    : shellCommandTool.promptGuide ?? '';
  assert.match(shellGuide, /command is one shell string/);
  assert.match(shellGuide, /workdir is workspace-relative/);
  assert.match(shellGuide, /maxOutputBytes controls how much process stdout\/stderr is captured/);
  assert.match(shellGuide, /previewMode and previewBytes choose the slice included in the observation presentation/);
  assert.match(shellGuide, /Before apply_patch updates, inspect the exact target region/);
  assert.match(shellGuide, /sed -n '120,170p' path/);
  assert.match(shellGuide, /avoid copying line numbers from `nl -ba` into patch hunks/);
  assert.match(shellGuide, /Shell runtime snapshot/);

  const unavailableGuide = typeof shellCommandTool.promptGuide === 'function'
    ? shellCommandTool.promptGuide({ inputFormat: 'json function' })
    : shellCommandTool.promptGuide ?? '';
  assert.match(unavailableGuide, /Runtime: unavailable from the configured shell runner/);

  const policyBlocked = await invokeToolCall(jsonToolCall('shell_command', { command: 'node --version' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: readOnlyPolicy
  });
  assert.equal(policyBlocked.ok, false);
  assert.equal(policyBlocked.output.reason, 'policy');

  const blankCommand = await invokeToolCall(jsonToolCall('shell_command', { command: '   ' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(blankCommand.ok, false);
  assert.equal(blankCommand.output.reason, 'invalid_arguments');

  const missingService = await invokeToolCall(jsonToolCall('shell_command', { command: 'node --version' }), allTools, {
    services: { workspaceRoot: dir },
    policy: executePolicy
  });
  assert.equal(missingService.ok, false);
  assert.equal(missingService.output.reason, 'missing_service');
  assert.equal(missingService.output.service, 'shellRunner');
  assert.equal(missingService.output.details.expected, 'ShellRunner service with run(command)');
  assert.equal(missingService.output.details.actualType, 'missing');

  const invalidShellRunner = await invokeToolCall(jsonToolCall('shell_command', { command: 'node --version' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: {} },
    policy: executePolicy
  });
  assert.equal(invalidShellRunner.ok, false);
  assert.equal(invalidShellRunner.output.reason, 'missing_service');
  assert.equal(invalidShellRunner.output.service, 'shellRunner');
  assert.equal(invalidShellRunner.output.details.expected, 'ShellRunner service with run(command)');
  assert.equal(invalidShellRunner.output.details.actualType, 'object');

  const pipeline = await invokeToolCall(jsonToolCall('shell_command', { command: 'printf "alpha\\nbeta\\n" | grep beta' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(pipeline.ok, true);
  assert.match(pipeline.output.stdout, /beta/);

  const stderrWithZeroExit = await invokeToolCall(jsonToolCall('shell_command', { command: 'printf "warn\\n" >&2; printf "ok\\n"' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(stderrWithZeroExit.ok, true);
  assert.match(stderrWithZeroExit.summary, /exited 0 with stderr/u);
  const stderrWithZeroExitView = await presentToolObservation(
    shellCommandTool,
    jsonToolCall('shell_command', { command: 'printf "warn\\n" >&2; printf "ok\\n"' }),
    stderrWithZeroExit,
    { services: { workspaceRoot: dir }, policy: executePolicy },
    3_000
  );
  assert.equal(stderrWithZeroExitView.ok, true);
  assert.equal(stderrWithZeroExitView.results.status.exitCode, 0);
  assert.match(stderrWithZeroExitView.warnings.join('\n'), /wrote to stderr/u);

  await mkdir(path.join(dir, 'subdir'));
  await writeFile(path.join(dir, 'subdir', 'inside.txt'), 'inside\n', 'utf8');
  const workdir = await invokeToolCall(jsonToolCall('shell_command', { command: 'pwd && ls', workdir: 'subdir' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(workdir.ok, true);
  assert.match(workdir.output.cwd, /subdir$/);
  assert.match(workdir.output.stdout, /inside.txt/);

  const escapingWorkdir = await invokeToolCall(jsonToolCall('shell_command', { command: 'pwd', workdir: '..' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(escapingWorkdir.ok, false);
  assert.equal(escapingWorkdir.output.reason, 'invalid_arguments');
  assert.equal(escapingWorkdir.output.details.path, '..');

  const hereDoc = await invokeToolCall(jsonToolCall('shell_command', { command: 'cat <<EOF\nhello\nEOF' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(hereDoc.ok, true);
  assert.match(hereDoc.output.stdout, /hello/);

  const truncated = await invokeToolCall(jsonToolCall('shell_command', { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(5000))"`, maxOutputBytes: 1_000 }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.output.stdoutTruncated, true);
  assert.equal(truncated.output.stdoutObservedBytes, 5_000);
  assert.equal(truncated.output.stdoutRetainedBytes, 1_000);
  const truncatedView = await presentToolObservation(
    shellCommandTool,
    jsonToolCall('shell_command', { command: 'long output', maxOutputBytes: 1_000, previewBytes: 800 }),
    truncated,
    { services: { workspaceRoot: dir }, policy: executePolicy },
    2_000
  );
  assert.equal(truncatedView.results.stdout.truncated, true);
  assert.equal(truncatedView.results.status.exitCode, 0);
  assert.equal(truncatedView.results.status.stdoutTruncated, true);
  assert.equal(truncatedView.results.status.stderrTruncated, false);
  assert.equal(truncatedView.results.status.outcome, 'exited');
  assert.equal(truncatedView.results.status.cleanup.status, 'settled');
  assert.equal(truncatedView.results.stdout.rawObservedBytes, 5_000);
  assert.equal(truncatedView.results.stdout.rawRetainedBytes, 1_000);
  assert.equal(truncatedView.results.stdout.visiblePreviewBytes > 0, true);
  assert.equal(truncatedView.results.stdout.captureOmittedBytes, 4_000);
  assert.equal(truncatedView.omitted.stdoutCaptureBytes, 4_000);
  assert.equal(truncatedView.omitted.stdoutPreviewBytes > 300, true);
  assert.equal(truncatedView.limits.requestedPreviewBytes, 800);
  assert.equal(truncatedView.limits.previewMode, 'head_tail');
  assert.match(truncatedView.results.stdout.text, /stdout middle omitted for observation presentation/);
  assert.match(truncatedView.next, /not captured/);

  const tailPreview = await presentToolObservation(
    shellCommandTool,
    jsonToolCall('shell_command', { command: 'long output', previewMode: 'tail', previewBytes: 500 }),
    {
      ...truncated,
      output: {
        ...truncated.output,
        stdout: `start\n${'m'.repeat(900)}\nfinish`,
        stdoutObservedBytes: 913,
        stdoutRetainedBytes: 913,
        stdoutTruncated: false
      }
    },
    { services: { workspaceRoot: dir }, policy: executePolicy },
    3_000
  );
  assert.doesNotMatch(tailPreview.results.stdout.text, /^start/);
  assert.match(tailPreview.results.stdout.text, /finish/);
  assert.equal(tailPreview.omitted.stdoutPreviewBytes > 0, true);
  assert.match(tailPreview.next, /previewMode\/previewBytes/);

  const failedAndTruncated = await presentToolObservation(
    shellCommandTool,
    jsonToolCall('shell_command', { command: 'failing output', previewMode: 'tail', previewBytes: 500 }),
    {
      ok: false,
      kind: 'result',
      summary: 'Command exited 2. noisy failure.',
      output: {
        ...truncated.output,
        outcome: 'exited',
        process: { kind: 'exited', exitCode: 2, signal: null },
        cleanup: { status: 'settled' },
        stderr: `error-start\n${'e'.repeat(1_500)}\nerror-end`,
        stderrObservedBytes: 1_516,
        stderrRetainedBytes: 1_516,
        stderrTruncated: false
      }
    },
    { services: { workspaceRoot: dir }, policy: executePolicy },
    3_000
  );
  assert.match(failedAndTruncated.next, /command failed/i);
  assert.match(failedAndTruncated.next, /previewMode\/previewBytes|narrower/);
  assert.equal(failedAndTruncated.results.status.exitCode, 2);
  assert.equal(failedAndTruncated.results.status.stderrTruncated, true);

  const cleanupRunner = new ShellRunner({ processSpawner(command, args, options) {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: options.shell, stdio: ['ignore', 'pipe', 'pipe'] });
    return { child, stop(signal) { child.kill(signal); }, async settle() { throw new Error('injected process-tree cleanup failure'); } };
  } });
  const cleanupFailed = await invokeToolCall(jsonToolCall('shell_command', { command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` }), allTools, {
    services: { workspaceRoot: dir, shellRunner: cleanupRunner },
    policy: executePolicy
  });
  assert.equal(cleanupFailed.ok, false);
  assert.equal(cleanupFailed.output.outcome, 'cleanup_failed');
  assert.equal(cleanupFailed.output.process.kind, 'exited');
  assert.equal(cleanupFailed.output.process.exitCode, 0);
  assert.equal(cleanupFailed.output.cleanup.status, 'failed');
  assert.match(cleanupFailed.summary, /cleanup failed/i);
  assert.equal(cleanupFailed.evidence.items[0].outcome, 'failure');
  const cleanupView = await presentToolObservation(shellCommandTool, jsonToolCall('shell_command', { command: 'cleanup failure' }), cleanupFailed, { services: { workspaceRoot: dir }, policy: executePolicy }, 3_000);
  assert.equal(cleanupView.ok, false);
  assert.equal(cleanupView.results.status.outcome, 'cleanup_failed');
  assert.match(cleanupView.warnings.join('\n'), /never treat this command as successful/i);

  const writeLikeCommand = await invokeToolCall(jsonToolCall('shell_command', { command: 'mkdir out' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(writeLikeCommand.ok, false);
  assert.equal(writeLikeCommand.output.reason, 'policy');
  assert.equal(writeLikeCommand.output.policyReason, 'risk_not_allowed');
  assert.equal(writeLikeCommand.output.risk, 'write');
  assert.equal('exitCode' in writeLikeCommand.output, false);

  const unsafeCommand = await invokeToolCall(jsonToolCall('shell_command', { command: 'rm note.txt' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(unsafeCommand.ok, false);
  assert.equal(unsafeCommand.output.reason, 'policy');
  assert.equal(unsafeCommand.output.policyReason, 'unsafe_shell_blocked');
  assert.equal(unsafeCommand.output.risk, 'destructive');

  const unsafeOverrideWithoutRisk = await invokeToolCall(jsonToolCall('shell_command', { command: 'rm note.txt' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: { allowedRisks: ['read', 'execute'], allowUnsafeShell: true }
  });
  assert.equal(unsafeOverrideWithoutRisk.ok, false);
  assert.equal(unsafeOverrideWithoutRisk.output.reason, 'policy');
  assert.equal(unsafeOverrideWithoutRisk.output.policyReason, 'risk_not_allowed');
  assert.equal(unsafeOverrideWithoutRisk.output.risk, 'destructive');

  const networkCommand = await invokeToolCall(jsonToolCall('shell_command', { command: 'curl https://example.com' }), allTools, {
    services: { workspaceRoot: dir, shellRunner: new ShellRunner() },
    policy: executePolicy
  });
  assert.equal(networkCommand.ok, false);
  assert.equal(networkCommand.output.reason, 'policy');
  assert.equal(networkCommand.output.policyReason, 'risk_not_allowed');
  assert.equal(networkCommand.output.risk, 'network');
});
