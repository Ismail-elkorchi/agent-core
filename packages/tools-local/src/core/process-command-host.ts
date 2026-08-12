import { spawn } from 'node:child_process';
import process from 'node:process';

const cwd = process.argv[2];
const command = process.argv[3];
if (!cwd || !command) throw new Error('Process command host requires a working directory and command.');

process.stdout.on('error', () => { /* The supervisor may have exited. */ });
process.stderr.on('error', () => { /* The supervisor may have exited. */ });

const child = spawn(command, [], {
  cwd,
  env: process.env,
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });

process.exitCode = await new Promise<number>((resolve) => {
  let settled = false;
  const finish = (exitCode: number) => {
    if (settled) return;
    settled = true;
    resolve(exitCode);
  };
  child.once('spawn', () => { process.send?.('ready'); process.disconnect(); });
  child.once('error', () => { finish(71); });
  child.once('close', (exitCode) => { finish(exitCode ?? 1); });
});
