import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = argumentsMap(process.argv.slice(2));
const identity = required('identity');
const endpoint = required('endpoint');
const stateFile = required('state-file');
const cwd = required('cwd');
const command = required('command');
const releaseTimeoutMs = positive(required('release-timeout-ms'));
const tokenValue = process.env.AGENT_CORE_SUPERVISOR_TOKEN;
delete process.env.AGENT_CORE_SUPERVISOR_TOKEN;
if (!tokenValue || !/^[a-f0-9]{64}$/u.test(tokenValue)) throw new Error('Process supervisor authentication token is unavailable.');
const authenticationToken: string = tokenValue;

let userProcess: ChildProcess | undefined;
let released = false;
let stopRequested = false;
let terminal = false;
let forceTimer: ReturnType<typeof setTimeout> | undefined;

if (process.platform !== 'win32') {
  await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  await rm(endpoint, { force: true });
}
const server = createServer((socket) => { handleConnection(socket); });
server.unref();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(endpoint, () => { resolve(); });
});
server.ref();

const releaseTimer = setTimeout(() => {
  if (released || terminal) return;
  void finish('failed', null, null, 70);
}, releaseTimeoutMs);
releaseTimer.unref();

process.stdout.on('error', () => { /* The manager may have crashed. */ });
process.stderr.on('error', () => { /* The manager may have crashed. */ });

function handleConnection(socket: Socket): void {
  socket.setEncoding('utf8');
  let request = '';
  socket.on('data', (chunk: string) => {
    request += chunk;
    if (Buffer.byteLength(request, 'utf8') > 16_384) { socket.destroy(); return; }
    if (!request.includes('\n')) return;
    socket.removeAllListeners('data');
    void respond(socket, request.slice(0, request.indexOf('\n')));
  });
}

async function respond(socket: Socket, text: string): Promise<void> {
  try {
    const request: unknown = JSON.parse(text);
    if (!isRecord(request) || request.identity !== identity || typeof request.nonce !== 'string'
      || (request.operation !== 'challenge' && request.operation !== 'release' && request.operation !== 'stop')
      || typeof request.clientProof !== 'string') throw new Error('Invalid supervisor request.');
    const expected = hmac(`client\n${identity}\n${request.nonce}\n${request.operation}`);
    if (!safeEqual(request.clientProof, expected)) throw new Error('Supervisor authentication failed.');
    if (request.operation === 'release') await release();
    if (request.operation === 'stop') stop();
    socket.end(JSON.stringify({
      ok: true,
      identity,
      nonce: request.nonce,
      serverProof: hmac(`server\n${identity}\n${request.nonce}\n${request.operation}`)
    }) + '\n');
  } catch (error) {
    socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
  }
}

async function release(): Promise<void> {
  if (released) return;
  released = true;
  clearTimeout(releaseTimer);
  const child = spawn(command, [], {
    cwd,
    env: process.env,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  userProcess = child;
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.once('error', (error) => { void finish('failed', null, null, 71, error.message); });
  child.once('close', (exitCode, signal) => { void finish(stopRequested ? 'stopped' : exitCode === null ? 'failed' : 'exited', exitCode, signal, exitCode ?? 1); });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function stop(): void {
  stopRequested = true;
  if (!userProcess) { setImmediate(() => { void finish('stopped', null, null, 0); }); return; }
  if (process.platform === 'win32') {
    const pid = userProcess.pid;
    if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else userProcess.kill('SIGKILL');
    return;
  }
  const child = userProcess;
  signalTree(child, 'SIGTERM');
  forceTimer = setTimeout(() => { signalTree(child, 'SIGKILL'); }, 500);
  forceTimer.unref();
}

async function finish(state: 'exited' | 'stopped' | 'failed', exitCode: number | null, signal: string | null, supervisorExitCode: number, diagnostic?: string): Promise<void> {
  if (terminal) return;
  terminal = true;
  clearTimeout(releaseTimer);
  if (forceTimer) clearTimeout(forceTimer);
  const value = {
    identity,
    state,
    exitCode,
    signal,
    ...(diagnostic ? { diagnostic } : {}),
    proof: hmac(`terminal\n${identity}\n${state}\n${String(exitCode)}\n${String(signal)}`)
  };
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${String(process.pid)}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, stateFile);
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (process.platform !== 'win32') await rm(endpoint, { force: true });
  process.exitCode = supervisorExitCode;
}

function signalTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch { try { child.kill(signal); } catch { /* Already exited. */ } }
}
function argumentsMap(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Invalid process supervisor arguments.');
    result.set(key.slice(2), value);
  }
  return result;
}
function required(name: string): string { const value = args.get(name); if (!value) throw new Error(`Missing process supervisor argument: ${name}`); return value; }
function positive(value: string): number { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid release timeout.'); return number; }
function hmac(value: string): string { return createHmac('sha256', authenticationToken).update(value).digest('hex'); }
function safeEqual(actual: string, expected: string): boolean { const left = Buffer.from(actual); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
