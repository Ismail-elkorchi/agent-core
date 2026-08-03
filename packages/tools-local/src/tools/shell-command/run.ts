import { evidenceDelta, toEvidenceJsonObject } from '@agent-core/evidence';
import { requireToolService, requireWorkspaceRoot, ToolInputError, type ToolExecutionContext } from '@agent-core/tools';
import type { ToolObservation } from '@agent-core/tools';
import { relativePath, requireDirectoryInsideRoot, resolveInsideRoot } from '../../core/filesystem.js';
import { invalidToolInputObservation, policyBlockedObservation } from '@agent-core/tools';
import { isRiskAllowed } from '@agent-core/tools';
import { assessShellCommand } from './safety.js';
import type { ShellResult, ShellRunner } from './shell-runner.js';
import type { ShellCommandInput } from './schema.js';

export async function shellCommand(input: ShellCommandInput, context: ToolExecutionContext): Promise<ToolObservation<ShellResult>> {
  if (!isRiskAllowed(context.policy, 'execute')) {
    return policyBlockedObservation('Command blocked because command execution is disabled.', {
      tool: 'shell_command',
      risk: 'execute',
      policyReason: 'execute_disabled'
    });
  }
  const rootDir = requireWorkspaceRoot(context);
  let cwd;
  try {
    cwd = resolveInsideRoot(rootDir, input.workdir, {
      emptyPathMessage: 'workdir cannot be empty.'
    });
    await requireDirectoryInsideRoot(rootDir, cwd, input.workdir);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return invalidToolInputObservation('shell_command', 'Command workdir is invalid.', {
        kind: 'invalid_workdir',
        path: input.workdir,
        message: error.message
      });
    }
    throw error;
  }
  const shellRunner = requireToolService(context, 'shellRunner', isShellRunner, 'ShellRunner service with run(command)');
  const command = input.command.trim();
  const safety = assessShellCommand(command);
  if (!safety.allowed && !context.policy.allowUnsafeShell) {
    return policyBlockedObservation(safety.reason ?? 'Command blocked by safety policy.', {
      tool: 'shell_command',
      risk: safety.risk,
      policyReason: 'unsafe_shell_blocked',
      details: { command, cwd: relativePath(rootDir, cwd) || '.', reason: safety.reason ?? 'Command blocked by safety policy.' }
    });
  }
  if (safety.risk !== 'execute' && !isRiskAllowed(context.policy, safety.risk)) {
    return policyBlockedObservation(`Command blocked because it requires ${safety.risk} access.`, {
      tool: 'shell_command',
      risk: safety.risk,
      policyReason: 'risk_not_allowed',
      details: { command, cwd: relativePath(rootDir, cwd) || '.' }
    });
  }
  const result = await shellRunner.run({
    id: `shell:${command.slice(0, 80)}`,
    command,
    shell: true,
    cwd,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    ...(context.signal ? { signal: context.signal } : {})
  });
  const succeeded = result.outcome === 'exited' && result.process.exitCode === 0;
  const exitCode = result.process.kind === 'exited' ? result.process.exitCode : null;
  const observation: ToolObservation<ShellResult> = {
    kind: 'result',
    ok: succeeded,
    summary: summarizeShellResult(result),
    output: result,
    evidence: evidenceDelta([{
      action: 'execute',
      resources: [],
      scope: {
        filters: toEvidenceJsonObject({ workdir: relativePath(rootDir, cwd) || '.' }),
        limits: toEvidenceJsonObject({
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes
        }),
        omitted: toEvidenceJsonObject({
          stdoutCaptureBytes: Math.max(0, result.stdoutObservedBytes - result.stdoutRetainedBytes),
          stderrCaptureBytes: Math.max(0, result.stderrObservedBytes - result.stderrRetainedBytes)
        }),
        truncated: result.stdoutTruncated || result.stderrTruncated,
        confidence: succeeded ? 'verified' : 'unverified'
      },
      outcome: succeeded ? 'success' : 'failure',
      summary: `Executed command in ${relativePath(rootDir, cwd) || '.'}; outcome ${result.outcome}, exit ${String(exitCode)}.`
    }])
  };
  if (result.artifacts && result.artifacts.length > 0) {
    observation.artifacts = result.artifacts;
  }
  return observation;
}

function isShellRunner(value: unknown): value is ShellRunner {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { run?: unknown }).run === 'function';
}

function summarizeShellResult(result: ShellResult): string {
  if (result.outcome === 'spawn_failed') return `Command failed to start: ${result.process.diagnostic}`;
  if (result.outcome === 'cleanup_failed') return `Command process reached ${result.process.kind}, but process-tree cleanup failed: ${result.cleanup.diagnostic}`;
  if (result.outcome === 'timed_out') {
    return `Command timed out after ${String(result.durationMs)}ms.`;
  }
  if (result.outcome === 'aborted') return `Command was aborted after ${String(result.durationMs)}ms.`;
  if (result.outcome === 'process_failed') return `Command process failed: ${result.process.diagnostic}`;
  if (result.process.exitCode === 0 && result.stderr.trim().length > 0) {
    return `Command exited 0 with stderr. ${result.stderr.trim().slice(0, 300)}`;
  }
  const output = result.stderr.trim() || result.stdout.trim();
  return `Command exited ${String(result.process.exitCode)}. ${output ? output.slice(0, 300) : 'No output.'}`;
}
