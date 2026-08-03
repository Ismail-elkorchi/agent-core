import { defineTool, requireWorkspaceRoot } from '@agent-core/tools';
import { toolFailurePresentation, toJsonValue, type ToolObservationPresentation } from '@agent-core/tools';
import { shellCommand } from './run.js';
import { shellCommandPromptGuide } from './prompt-guide.js';
import { shellCommandInputSchema } from './schema.js';
import type { ShellResult } from './shell-runner.js';
import { canonicalWorkspacePath } from '../../core/filesystem.js';

export const shellCommandTool = defineTool({
  name: 'shell_command',
  implementationId: '@agent-core/tools-local/shell-command@1',
  description: 'Run a shell command in the configured workspace. First call shape: {"command":"pwd && ls","workdir":"."}. Supports pipes, redirects, here-docs, and composed commands; output is bounded and truncated with metadata.',
  promptGuide: shellCommandPromptGuide,
  schema: shellCommandInputSchema,
  risk: 'execute',
  declaredEffects: { kind: 'mixed', resourceScopes: ['workspace', 'process'], idempotency: 'non_idempotent', reversible: false },
  async canonicalizeInput(input, context) { return { ...input, workdir: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.workdir) }; },
  deriveEffects(input) { return { kind: 'mixed', resourceScopes: [`workspace/${input.workdir}`, 'process'], idempotency: 'non_idempotent', reversible: false }; },
  invoke: shellCommand,
  presentObservation: ({ input, observation, limit }): ToolObservationPresentation => {
    if (observation.kind === 'failure') {
      return toolFailurePresentation('shell_command', observation);
    }
    const output: ShellResult = observation.output;
    const previewMode = input.previewMode;
    const requestedPreviewBytes = input.previewBytes;
    const maxPreviewBytes = Math.max(500, Math.floor(limit.maxBytes * 0.42));
    const previewBytes = Math.min(requestedPreviewBytes, maxPreviewBytes);
    const stdout = previewText('stdout', output.stdout, previewBytes, previewMode);
    const stderr = previewText('stderr', output.stderr, previewBytes, previewMode);
    const stdoutCaptureOmittedBytes = Math.max(0, output.stdoutObservedBytes - output.stdoutRetainedBytes);
    const stderrCaptureOmittedBytes = Math.max(0, output.stderrObservedBytes - output.stderrRetainedBytes);
    const exitCode = output.process.kind === 'exited' ? output.process.exitCode : null;
    const succeeded = output.outcome === 'exited' && exitCode === 0;
    const warnings = [
      succeeded && output.stderr.trim().length > 0 ? 'Command exited 0 but wrote to stderr; treat stdout as usable only after considering the stderr warning.' : '',
      output.outcome === 'cleanup_failed' ? 'Process-tree cleanup failed; never treat this command as successful even if the child exit code was zero.' : '',
      output.stdoutTruncated ? 'stdout exceeded maxOutputBytes and was truncated during command capture.' : '',
      output.stderrTruncated ? 'stderr exceeded maxOutputBytes and was truncated during command capture.' : '',
      stdout.omittedBytes > 0 ? 'stdout was retained but not fully included in the observation presentation.' : '',
      stderr.omittedBytes > 0 ? 'stderr was retained but not fully included in the observation presentation.' : ''
    ].filter((item) => item.length > 0);
    return {
      ok: observation.ok,
      title: 'Command execution result',
      summary: observation.summary,
      scope: {
        command: output.command,
        workdir: input.workdir
      },
      limits: {
        workdir: input.workdir,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        previewMode,
        requestedPreviewBytes,
        effectivePreviewBytes: previewBytes,
        presentationMaxBytes: limit.maxBytes
      },
      results: {
        status: {
          outcome: output.outcome,
          process: toJsonValue(output.process),
          cleanup: toJsonValue(output.cleanup),
          exitCode,
          durationMs: output.durationMs,
          stdoutTruncated: output.stdoutTruncated || stdout.omittedBytes > 0,
          stderrTruncated: output.stderrTruncated || stderr.omittedBytes > 0
        },
        stdout: {
          text: stdout.text,
          truncated: output.stdoutTruncated || stdout.omittedBytes > 0,
          rawObservedBytes: output.stdoutObservedBytes,
          rawRetainedBytes: output.stdoutRetainedBytes,
          visiblePreviewBytes: Buffer.byteLength(stdout.text, 'utf8'),
          previewOmittedBytes: stdout.omittedBytes,
          captureOmittedBytes: stdoutCaptureOmittedBytes
        },
        stderr: {
          text: stderr.text,
          truncated: output.stderrTruncated || stderr.omittedBytes > 0,
          rawObservedBytes: output.stderrObservedBytes,
          rawRetainedBytes: output.stderrRetainedBytes,
          visiblePreviewBytes: Buffer.byteLength(stderr.text, 'utf8'),
          previewOmittedBytes: stderr.omittedBytes,
          captureOmittedBytes: stderrCaptureOmittedBytes
        },
        artifacts: toJsonValue(observation.artifacts ?? output.artifacts ?? [])
      },
      omitted: {
        stdoutCaptureBytes: stdoutCaptureOmittedBytes,
        stderrCaptureBytes: stderrCaptureOmittedBytes,
        stdoutPreviewBytes: stdout.omittedBytes,
        stderrPreviewBytes: stderr.omittedBytes
      },
      truncated: output.stdoutTruncated || output.stderrTruncated || stdout.omittedBytes > 0 || stderr.omittedBytes > 0,
      ...(warnings.length > 0 ? { warnings } : {}),
      next: nextAction(output, stdout.omittedBytes, stderr.omittedBytes, stdoutCaptureOmittedBytes, stderrCaptureOmittedBytes)
    };
  }
});

type PreviewMode = 'head_tail' | 'head' | 'tail' | 'none';

function leadingText(label: 'stdout' | 'stderr', text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) {
    return { text, omittedBytes: 0 };
  }
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end = Math.floor(end * 0.8);
  }
  const prefix = text.slice(0, end);
  return {
    text: `${prefix}\n[${label} preview truncated for observation presentation]`,
    omittedBytes: Math.max(0, bytes - Buffer.byteLength(prefix, 'utf8'))
  };
}

function trailingText(label: 'stdout' | 'stderr', text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) {
    return { text, omittedBytes: 0 };
  }
  let start = 0;
  while (start < text.length && Buffer.byteLength(text.slice(start), 'utf8') > maxBytes) {
    start += Math.max(1, Math.floor((text.length - start) * 0.2));
  }
  const suffix = text.slice(start);
  return {
    text: `[${label} tail truncated for observation presentation]\n${suffix}`,
    omittedBytes: Math.max(0, bytes - Buffer.byteLength(suffix, 'utf8'))
  };
}

function previewText(label: 'stdout' | 'stderr', text: string, maxBytes: number, mode: PreviewMode): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (mode === 'none') {
    return { text: '', omittedBytes: bytes };
  }
  if (bytes <= maxBytes) {
    return { text, omittedBytes: 0 };
  }
  if (mode === 'head') {
    return leadingText(label, text, maxBytes);
  }
  if (mode === 'tail') {
    return trailingText(label, text, maxBytes);
  }
  const halfBudget = Math.max(1, Math.floor(maxBytes / 2));
  const head = leadingText(label, text, halfBudget);
  const tail = trailingText(label, text, halfBudget);
  const headVisibleBytes = bytes - head.omittedBytes;
  const tailVisibleBytes = bytes - tail.omittedBytes;
  return {
    text: `${head.text}\n[${label} middle omitted for observation presentation]\n${tail.text}`,
    omittedBytes: Math.max(0, bytes - headVisibleBytes - tailVisibleBytes)
  };
}

function nextAction(
  output: ShellResult,
  stdoutPreviewBytes: number,
  stderrPreviewBytes: number,
  stdoutCaptureBytes: number,
  stderrCaptureBytes: number
): string {
  if (stdoutCaptureBytes > 0 || stderrCaptureBytes > 0) {
    return shellSucceeded(output)
      ? 'The process produced output that was not captured. Rerun with narrower shell filters, redirection to a workspace file, or a larger maxOutputBytes value.'
      : 'The command failed and also produced output that was not captured. Use exit status plus a narrower or larger-capture follow-up command before relying on stderr/stdout details.';
  }
  if (stdoutPreviewBytes > 0 || stderrPreviewBytes > 0) {
    return shellSucceeded(output)
      ? 'The retained output was not fully shown. Use previewMode/previewBytes to choose the visible slice, or rerun with narrower shell filters before making completeness claims.'
      : 'The command failed and retained output was not fully shown. Use exit status plus previewMode/previewBytes or a narrower follow-up command to inspect the relevant stderr/stdout slice.';
  }
  if (!shellSucceeded(output)) {
    return 'Use exit status and stderr/stdout evidence to adjust the next command or answer.';
  }
  return 'Use stdout/stderr only within their shown scope.';
}
function shellSucceeded(output: ShellResult): boolean { return output.outcome === 'exited' && output.process.exitCode === 0; }
