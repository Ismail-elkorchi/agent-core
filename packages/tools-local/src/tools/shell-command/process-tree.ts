import { spawn, type ChildProcessByStdio } from 'node:child_process';
import process from 'node:process';
import type { Readable } from 'node:stream';

const ABORT_FORCE_DELAY_MS = 500;

export type OwnedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface OwnedProcessSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: boolean;
}

export interface OwnedProcessTree {
  readonly child: OwnedChildProcess;
  stop(signal: 'SIGTERM' | 'SIGKILL'): void;
  settle(): Promise<void>;
}

export type OwnedProcessSpawner = (command: string, args: readonly string[], options: OwnedProcessSpawnOptions) => OwnedProcessTree;

export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: OwnedProcessSpawnOptions
): OwnedProcessTree {
  const platform = process.platform;
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true
  });
  return new ProcessTreeController(child, platform);
}

class ProcessTreeController implements OwnedProcessTree {
  readonly child: OwnedChildProcess;
  readonly #platform: NodeJS.Platform;
  #forceTimer: ReturnType<typeof setTimeout> | undefined;
  #stopRequested = false;
  #windowsTermination: Promise<void> = Promise.resolve();

  constructor(child: OwnedChildProcess, platform: NodeJS.Platform) {
    this.child = child;
    this.#platform = platform;
  }

  stop(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    if (this.#platform === 'win32') {
      this.#windowsTermination = terminateWindowsTree(this.child);
      return;
    }
    signalPosixTree(this.child, signal);
    if (signal === 'SIGTERM') {
      this.#forceTimer = setTimeout(() => {
        signalPosixTree(this.child, 'SIGKILL');
      }, ABORT_FORCE_DELAY_MS);
      this.#forceTimer.unref();
    }
  }

  async settle(): Promise<void> {
    if (!this.#stopRequested) return;
    if (this.#forceTimer !== undefined) {
      clearTimeout(this.#forceTimer);
      this.#forceTimer = undefined;
    }
    await this.#windowsTermination;
    if (this.#platform !== 'win32') signalPosixTree(this.child, 'SIGKILL');
  }
}

function signalPosixTree(child: OwnedChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between observation and signaling.
    }
  }
}

function terminateWindowsTree(child: OwnedChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    forceDirectChild(child);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    let settled = false;
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      if (!success) forceDirectChild(child);
      resolve();
    };
    killer.once('error', () => {
      finish(false);
    });
    killer.once('close', (code) => {
      finish(code === 0);
    });
  });
}

function forceDirectChild(child: OwnedChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // The process may already have exited.
  }
}
