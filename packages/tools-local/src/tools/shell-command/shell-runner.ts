import type { ArtifactRef, ArtifactRepository } from '@agent-core/evidence';
import { spawnOwnedProcess, type OwnedProcessSpawner } from './process-tree.js';
import { inspectLocalShellRuntime, type ShellRuntimeDescriber, type ShellRuntimeSnapshot } from './shell-runtime.js';
import { createShellLifecycle, reduceShellLifecycle, type ShellLifecycleCommand, type ShellLifecycleEvent, type ShellLifecycleState } from './lifecycle-machine.js';

export interface ShellCommand {
  id?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

interface ShellCaptureResult {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  stdoutObservedBytes: number;
  stderrObservedBytes: number;
  stdoutRetainedBytes: number;
  stderrRetainedBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  artifacts?: ArtifactRef[];
}

export type ShellProcessResult =
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'timed_out'; readonly signal: 'SIGKILL' }
  | { readonly kind: 'aborted'; readonly signal: 'SIGTERM' }
  | { readonly kind: 'process_failed'; readonly diagnostic: string }
  | { readonly kind: 'spawn_failed'; readonly diagnostic: string };
export type ShellCleanupResult =
  | { readonly status: 'not_required' }
  | { readonly status: 'settled' }
  | { readonly status: 'failed'; readonly diagnostic: string };
type SettledShellProcess = Exclude<ShellProcessResult, { kind: 'spawn_failed' }>;
export type ShellResult = ShellCaptureResult & (
  | { readonly outcome: 'spawn_failed'; readonly process: Extract<ShellProcessResult, { kind: 'spawn_failed' }>; readonly cleanup: { readonly status: 'not_required' } }
  | { readonly outcome: 'aborted'; readonly process: Extract<ShellProcessResult, { kind: 'aborted' }>; readonly cleanup: { readonly status: 'not_required' | 'settled' } }
  | { readonly outcome: 'exited'; readonly process: Extract<ShellProcessResult, { kind: 'exited' }>; readonly cleanup: { readonly status: 'settled' } }
  | { readonly outcome: 'timed_out'; readonly process: Extract<ShellProcessResult, { kind: 'timed_out' }>; readonly cleanup: { readonly status: 'settled' } }
  | { readonly outcome: 'process_failed'; readonly process: Extract<ShellProcessResult, { kind: 'process_failed' }>; readonly cleanup: { readonly status: 'settled' } }
  | { readonly outcome: 'cleanup_failed'; readonly process: SettledShellProcess; readonly cleanup: Extract<ShellCleanupResult, { status: 'failed' }> }
);

export interface ShellRunnerOptions {
  defaultTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  artifactStore?: ArtifactRepository;
  redactPatterns?: RegExp[];
  processSpawner?: OwnedProcessSpawner;
}

const DEFAULT_REDACT_PATTERNS = [
  /([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*=)[^\s]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(sk-[A-Za-z0-9_-]{16,})/g
];

export class ShellRunner implements ShellRuntimeDescriber {
  private readonly defaultTimeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly artifactStore: ArtifactRepository | undefined;
  private readonly redactPatterns: RegExp[];
  private readonly processSpawner: OwnedProcessSpawner;
  private environmentSnapshot: ShellRuntimeSnapshot | undefined;

  constructor(options: ShellRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.maxStdoutBytes = options.maxStdoutBytes ?? 64_000;
    this.maxStderrBytes = options.maxStderrBytes ?? 64_000;
    this.artifactStore = options.artifactStore;
    this.redactPatterns = options.redactPatterns ?? DEFAULT_REDACT_PATTERNS;
    this.processSpawner = options.processSpawner ?? spawnOwnedProcess;
  }

  describeEnvironment(): ShellRuntimeSnapshot {
    this.environmentSnapshot ??= inspectLocalShellRuntime();
    return this.environmentSnapshot;
  }

  async run(command: ShellCommand): Promise<ShellResult> {
    let lifecycle: ShellLifecycleState = createShellLifecycle();
    const args = command.args ?? [];
    const cwd = command.cwd ?? process.cwd();
    const maxStdoutBytes = command.maxStdoutBytes ?? this.maxStdoutBytes;
    const maxStderrBytes = command.maxStderrBytes ?? this.maxStderrBytes;
    const maxOutputBytes = command.maxOutputBytes;
    const startedAt = Date.now();

    if (command.signal?.aborted) {
      lifecycle = shellTransition(lifecycle, { type: 'stop.requested', reason: 'abort' }, 'output.collect').state;
      lifecycle = shellTransition(lifecycle, { type: 'output.collected' }, 'result.complete').state;
      assertShellCompleted(lifecycle);
      return this.aborted(command, args, cwd, startedAt);
    }

    let processTree;
    lifecycle = shellTransition(lifecycle, { type: 'spawn.requested' }, 'process.spawn').state;
    try {
      processTree = this.processSpawner(command.command, args, {
        cwd,
        env: { ...process.env, ...command.env },
        shell: command.shell ?? false
      });
    } catch (error) {
      lifecycle = shellTransition(lifecycle, { type: 'spawn.failed', message: errorMessage(error) }, 'output.collect').state;
      lifecycle = shellTransition(lifecycle, { type: 'output.collected' }, 'result.complete').state;
      assertShellCompleted(lifecycle);
      return this.spawnFailure(command, args, cwd, startedAt, error);
    }
    lifecycle = shellTransition(lifecycle, { type: 'spawn.succeeded' }, undefined).state;
    const { child } = processTree;

    let stdoutRaw = Buffer.alloc(0);
    let stderrRaw = Buffer.alloc(0);
    let stdoutObservedBytes = 0;
    let stderrObservedBytes = 0;
    const state = {
      stdoutTruncated: false,
      stderrTruncated: false
    };
    let processClosed = false;
    let stopReason: 'abort' | 'timeout' | undefined;

    child.stdout.on('data', (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutObservedBytes += next.length;
      const allowed = remainingStreamBytes({
        currentStreamBytes: stdoutRaw.length,
        otherStreamBytes: stderrRaw.length,
        streamLimit: maxStdoutBytes,
        combinedLimit: maxOutputBytes
      });
      const retained = next.subarray(0, allowed);
      const combined = Buffer.concat([stdoutRaw, retained]);
      if (combined.length > maxStdoutBytes) {
        state.stdoutTruncated = true;
        stdoutRaw = combined.subarray(0, maxStdoutBytes);
      } else {
        stdoutRaw = combined;
      }
      if (retained.length < next.length) {
        state.stdoutTruncated = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrObservedBytes += next.length;
      const allowed = remainingStreamBytes({
        currentStreamBytes: stderrRaw.length,
        otherStreamBytes: stdoutRaw.length,
        streamLimit: maxStderrBytes,
        combinedLimit: maxOutputBytes
      });
      const retained = next.subarray(0, allowed);
      const combined = Buffer.concat([stderrRaw, retained]);
      if (combined.length > maxStderrBytes) {
        state.stderrTruncated = true;
        stderrRaw = combined.subarray(0, maxStderrBytes);
      } else {
        stderrRaw = combined;
      }
      if (retained.length < next.length) {
        state.stderrTruncated = true;
      }
    });

    const requestStop = (reason: 'abort' | 'timeout'): void => {
      if (processClosed || stopReason !== undefined) return;
      stopReason = reason;
      const transition = shellTransition(lifecycle, { type: 'stop.requested', reason }, 'process.stop');
      lifecycle = transition.state;
      clearTimeout(timeout);
      const command = transition.command;
      if (command?.type !== 'process.stop') throw new Error('Shell stop transition did not return a process.stop command.');
      processTree.stop(command.signal);
    };
    const timeoutMs = command.timeoutMs ?? this.defaultTimeoutMs;
    const timeout = setTimeout(() => {
      requestStop('timeout');
    }, timeoutMs);
    const abortHandler = () => {
      requestStop('abort');
    };
    command.signal?.addEventListener('abort', abortHandler, { once: true });
    if (command.signal?.aborted === true) abortHandler();

    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; processError?: string }>((resolve) => {
      child.once('error', (error) => {
        processClosed = true;
        resolve({ exitCode: null, signal: null, processError: error.message });
      });
      child.once('close', (code, signal) => {
        processClosed = true;
        resolve({ exitCode: code, signal: signal ?? null });
      });
    });

    const closeResult = await closed;
    lifecycle = shellTransition(lifecycle,
      closeResult.processError ? { type: 'process.failed', message: closeResult.processError } : { type: 'process.closed', exitCode: closeResult.exitCode, signal: closeResult.signal },
      'process.cleanup').state;
    clearTimeout(timeout);
    command.signal?.removeEventListener('abort', abortHandler);
    let cleanupError: string | undefined;
    try { await processTree.settle(); lifecycle = shellTransition(lifecycle, { type: 'cleanup.settled' }, 'output.collect').state; }
    catch (error) { cleanupError = errorMessage(error); lifecycle = shellTransition(lifecycle, { type: 'cleanup.failed', message: cleanupError }, 'output.collect').state; }

    const stdoutFull = this.redact(stdoutRaw.toString('utf8'));
    const stderrFull = this.redact(stopReason === 'abort' && stderrRaw.length === 0 ? 'Command aborted.' : stderrRaw.toString('utf8'));
    const artifacts = await this.captureArtifacts(command.id ?? command.command, stdoutFull, stderrFull, state.stdoutTruncated, state.stderrTruncated);
    const completedTransition = shellTransition(lifecycle, { type: 'output.collected' }, 'result.complete');
    lifecycle = completedTransition.state;
    assertShellCompleted(lifecycle);

    const capture: ShellCaptureResult = {
      id: command.id ?? command.command,
      command: command.command,
      args,
      cwd,
      stdout: state.stdoutTruncated ? `${stdoutFull}\n[stdout truncated at ${String(maxStdoutBytes)} bytes]` : stdoutFull,
      stderr: state.stderrTruncated ? `${stderrFull}\n[stderr truncated at ${String(maxStderrBytes)} bytes]` : stderrFull,
      stdoutObservedBytes,
      stderrObservedBytes,
      stdoutRetainedBytes: stdoutRaw.length,
      stderrRetainedBytes: stderrRaw.length,
      stdoutTruncated: state.stdoutTruncated,
      stderrTruncated: state.stderrTruncated,
      durationMs: Date.now() - startedAt
    };
    if (artifacts.length > 0) {
      capture.artifacts = artifacts;
    }
    const processResult: SettledShellProcess = stopReason === 'timeout'
      ? { kind: 'timed_out', signal: 'SIGKILL' }
      : stopReason === 'abort'
        ? { kind: 'aborted', signal: 'SIGTERM' }
        : closeResult.processError
          ? { kind: 'process_failed', diagnostic: closeResult.processError }
          : { kind: 'exited', exitCode: closeResult.exitCode, signal: closeResult.signal };
    const result = shellResult(capture, processResult, cleanupError);
    if (lifecycle.outcome !== result.outcome) throw new Error(`Shell lifecycle/result mismatch: ${lifecycle.outcome} !== ${result.outcome}.`);
    return result;
  }

  private spawnFailure(command: ShellCommand, args: string[], cwd: string, startedAt: number, error: unknown): ShellResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: command.id ?? command.command,
      command: command.command,
      args,
      cwd,
      stdout: '',
      stderr: this.redact(message),
      stdoutObservedBytes: 0,
      stderrObservedBytes: Buffer.byteLength(message, 'utf8'),
      stdoutRetainedBytes: 0,
      stderrRetainedBytes: Buffer.byteLength(message, 'utf8'),
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
      outcome: 'spawn_failed',
      process: { kind: 'spawn_failed', diagnostic: message },
      cleanup: { status: 'not_required' }
    };
  }

  private aborted(command: ShellCommand, args: string[], cwd: string, startedAt: number): ShellResult {
    return {
      id: command.id ?? command.command,
      command: command.command,
      args,
      cwd,
      stdout: '',
      stderr: 'Command aborted.',
      stdoutObservedBytes: 0,
      stderrObservedBytes: Buffer.byteLength('Command aborted.', 'utf8'),
      stdoutRetainedBytes: 0,
      stderrRetainedBytes: Buffer.byteLength('Command aborted.', 'utf8'),
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
      outcome: 'aborted',
      process: { kind: 'aborted', signal: 'SIGTERM' },
      cleanup: { status: 'not_required' }
    };
  }

  private redact(value: string): string {
    return this.redactPatterns.reduce((text, pattern) => text.replace(pattern, (_match: string, prefix?: string) => prefix ? `${prefix}[REDACTED]` : '[REDACTED]'), value);
  }

  private async captureArtifacts(id: string, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean): Promise<ArtifactRef[]> {
    if (!this.artifactStore) {
      return [];
    }
    const artifacts: ArtifactRef[] = [];
    if (stdoutTruncated || stdout.length > 16_000) {
      artifacts.push(await this.artifactStore.store({ label: `${id}-stdout`, content: new TextEncoder().encode(stdout), mediaType: 'text/plain; charset=utf-8', description: `retained stdout for ${id}` }));
    }
    if (stderrTruncated || stderr.length > 16_000) {
      artifacts.push(await this.artifactStore.store({ label: `${id}-stderr`, content: new TextEncoder().encode(stderr), mediaType: 'text/plain; charset=utf-8', description: `retained stderr for ${id}` }));
    }
    return artifacts;
  }
}

function assertShellCompleted(state: ShellLifecycleState): asserts state is Extract<ShellLifecycleState, { state: 'completed' }> { if (state.state !== 'completed') throw new Error(`Shell lifecycle did not complete: ${state.state}.`); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function shellTransition(state: ShellLifecycleState, event: ShellLifecycleEvent, expected: ShellLifecycleCommand['type'] | undefined): { readonly state: ShellLifecycleState; readonly command?: ShellLifecycleCommand } {
  const transition = reduceShellLifecycle(state, event);
  if (expected === undefined) {
    if (transition.commands.length !== 0) throw new Error(`Shell transition produced unhandled commands: ${transition.commands.map((command) => command.type).join(', ')}.`);
    return { state: transition.state };
  }
  if (transition.commands.length !== 1 || transition.commands[0]?.type !== expected) throw new Error(`Shell transition expected ${expected}, received ${transition.commands.map((command) => command.type).join(', ') || 'none'}.`);
  return { state: transition.state, command: transition.commands[0] };
}

function shellResult(capture: ShellCaptureResult, processResult: SettledShellProcess, cleanupError: string | undefined): ShellResult {
  if (cleanupError) return { ...capture, outcome: 'cleanup_failed', process: processResult, cleanup: { status: 'failed', diagnostic: cleanupError } };
  switch (processResult.kind) {
    case 'exited': return { ...capture, outcome: 'exited', process: processResult, cleanup: { status: 'settled' } };
    case 'timed_out': return { ...capture, outcome: 'timed_out', process: processResult, cleanup: { status: 'settled' } };
    case 'aborted': return { ...capture, outcome: 'aborted', process: processResult, cleanup: { status: 'settled' } };
    case 'process_failed': return { ...capture, outcome: 'process_failed', process: processResult, cleanup: { status: 'settled' } };
    default: return assertNeverProcess(processResult);
  }
}
function assertNeverProcess(value: never): never { throw new Error(`Unhandled shell process result: ${JSON.stringify(value)}`); }

function remainingStreamBytes(input: {
  currentStreamBytes: number;
  otherStreamBytes: number;
  streamLimit: number;
  combinedLimit: number | undefined;
}): number {
  const streamRemaining = Math.max(0, input.streamLimit - input.currentStreamBytes);
  if (input.combinedLimit === undefined) {
    return streamRemaining;
  }
  const combinedRemaining = Math.max(0, input.combinedLimit - input.currentStreamBytes - input.otherStreamBytes);
  return Math.min(streamRemaining, combinedRemaining);
}
