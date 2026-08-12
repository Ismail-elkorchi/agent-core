import { spawn, type ChildProcessByStdio } from 'node:child_process';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

export type OwnedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface OwnedProcessTree {
  readonly child: OwnedChildProcess;
  readonly started: Promise<void>;
  stop(signal?: 'SIGTERM' | 'SIGKILL'): void;
  settle(): Promise<void>;
}

export async function stopExistingProcessTree(processGroup: number): Promise<void> {
  if (!Number.isSafeInteger(processGroup) || processGroup <= 0 || !processTreeExists(processGroup)) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(processGroup), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', reject);
      killer.once('close', (code) => { if (code === 0 || !processTreeExists(processGroup)) resolve(); else reject(new Error(`taskkill exited with code ${String(code)}.`)); });
    });
    for (let settled = 0; settled < 10;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = processTreeExists(processGroup) ? 0 : settled + 1;
    }
    return;
  }
  try { process.kill(-processGroup, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 20 && processTreeExists(processGroup); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!processTreeExists(processGroup)) return;
  try { process.kill(-processGroup, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

function processTreeExists(processGroup: number): boolean {
  if (process.platform === 'win32') {
    try { process.kill(processGroup, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  try { process.kill(-processGroup, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
