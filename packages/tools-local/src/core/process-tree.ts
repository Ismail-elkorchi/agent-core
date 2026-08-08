import { spawn, type ChildProcessByStdio } from 'node:child_process';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

const FORCE_DELAY_MS = 500;

export type OwnedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface OwnedProcessTree {
  readonly child: OwnedChildProcess;
  stop(signal?: 'SIGTERM' | 'SIGKILL'): void;
  settle(): Promise<void>;
}

export function spawnOwnedProcess(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): OwnedProcessTree {
  const platform = process.platform;
  const child = spawn(command, [], {
    cwd,
    env,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true
  });
  return new ProcessTreeController(child, platform);
}

class ProcessTreeController implements OwnedProcessTree {
  readonly child: OwnedChildProcess;
  readonly #platform: NodeJS.Platform;
  readonly #settled: Promise<void>;
  #forceTimer: ReturnType<typeof setTimeout> | undefined;
  #stopRequested = false;
  #termination: Promise<void> = Promise.resolve();
  #windowsTermination: Promise<void> = Promise.resolve();

  constructor(child: OwnedChildProcess, platform: NodeJS.Platform) {
    this.child = child;
    this.#platform = platform;
    this.#settled = new Promise((resolve) => {
      child.once('close', () => { resolve(); });
      child.once('error', () => { resolve(); });
    });
  }

  stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    if (this.#platform === 'win32') {
      this.#windowsTermination = terminateWindowsTree(this.child);
      return;
    }
    signalPosixTree(this.child, signal);
    if (signal === 'SIGTERM') {
      this.#termination = new Promise((resolve) => {
        this.#forceTimer = setTimeout(() => {
          signalPosixTree(this.child, 'SIGKILL');
          resolve();
        }, FORCE_DELAY_MS);
      });
    }
  }

  async settle(): Promise<void> {
    await this.#windowsTermination;
    await this.#termination;
    await this.#settled;
    if (this.#forceTimer !== undefined) clearTimeout(this.#forceTimer);
  }
}

function signalPosixTree(child: OwnedChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) return;
  try { process.kill(-pid, signal); }
  catch {
    try { child.kill(signal); } catch { /* It already exited. */ }
  }
}

function terminateWindowsTree(child: OwnedChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    try { child.kill('SIGKILL'); } catch { /* It already exited. */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => { resolve(); });
    killer.once('close', () => { resolve(); });
  });
}
