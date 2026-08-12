import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { stopExistingProcessTree, type OwnedProcessTree } from './process-tree.js';

export interface ProcessSupervisorOwner {
  readonly runId: string;
  readonly turnId: string;
  readonly toolBatchId: string;
  readonly callIndex: number;
}

export interface ProcessSupervisorIdentity {
  readonly identity: string;
  readonly authenticationToken: string;
  readonly processId: string;
  readonly owner: ProcessSupervisorOwner;
  readonly endpoint: string;
  readonly stateFile: string;
}

export interface SupervisorTerminalState {
  readonly identity: string;
  readonly processId: string;
  readonly owner: ProcessSupervisorOwner;
  readonly state: 'exited' | 'stopped' | 'failed';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly proof: string;
}

export interface SupervisedProcessTree extends OwnedProcessTree {
  readonly supervision: ProcessSupervisorIdentity;
  release(): Promise<void>;
}

interface SupervisorResponse { readonly processPid?: number; readonly processProof?: string }

export function createProcessSupervisorIdentity(processId: string, directory: string, owner: ProcessSupervisorOwner): ProcessSupervisorIdentity {
  const identity = `supervisor_${randomUUID()}`;
  const authenticationToken = randomBytes(32).toString('hex');
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-core-${processId}-${randomUUID()}`
    : path.join(tmpdir(), `agent-core-${randomUUID()}.sock`);
  return Object.freeze({ identity, authenticationToken, processId, owner: Object.freeze({ ...owner }), endpoint, stateFile: path.join(directory, `${processId}.state.json`) });
}

export function spawnSupervisedProcess(input: {
  readonly command: string;
  readonly cwd: string;
  readonly supervision: ProcessSupervisorIdentity;
  readonly releaseTimeoutMs?: number;
}): SupervisedProcessTree {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./process-supervisor.js', import.meta.url)),
    '--identity', input.supervision.identity,
    '--process-id', input.supervision.processId,
    '--owner', JSON.stringify(input.supervision.owner),
    '--endpoint', input.supervision.endpoint,
    '--state-file', input.supervision.stateFile,
    '--cwd', input.cwd,
    '--command', input.command,
    '--release-timeout-ms', String(input.releaseTimeoutMs ?? 10_000)
  ], {
    cwd: input.cwd,
    env: { ...process.env, AGENT_CORE_SUPERVISOR_TOKEN: input.supervision.authenticationToken },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  return new SupervisorController(child, input.supervision);
}

export async function sendSupervisorCommand(
  supervision: ProcessSupervisorIdentity,
  operation: 'challenge' | 'release' | 'stop',
  timeoutMs = 2_000
): Promise<SupervisorResponse> {
  const nonce = randomBytes(24).toString('hex');
  const clientProof = hmac(supervision.authenticationToken, `client\n${supervision.identity}\n${nonce}\n${operation}`);
  const response = await exchange(supervision.endpoint, JSON.stringify({
    identity: supervision.identity,
    nonce,
    operation,
    clientProof
  }) + '\n', timeoutMs);
  const parsed: unknown = JSON.parse(response);
  if (!isRecord(parsed) || parsed.ok !== true || parsed.identity !== supervision.identity || parsed.nonce !== nonce || typeof parsed.serverProof !== 'string') {
    throw new Error('Process supervisor returned an invalid authentication response.');
  }
  const processPid = parsed.processPid === undefined ? undefined : typeof parsed.processPid === 'number' && Number.isSafeInteger(parsed.processPid) && parsed.processPid > 0 ? parsed.processPid : invalidResponse();
  const processProof = parsed.processProof === undefined ? undefined : typeof parsed.processProof === 'string' ? parsed.processProof : invalidResponse();
  if ((processPid === undefined) !== (processProof === undefined)) throw new Error('Process supervisor returned incomplete process ownership.');
  const expected = hmac(supervision.authenticationToken, `server\n${supervision.identity}\n${nonce}\n${operation}\n${String(processPid ?? '')}\n${processProof ?? ''}`);
  if (!safeEqual(parsed.serverProof, expected)) throw new Error('Process supervisor failed authenticated challenge.');
  if (processPid !== undefined && processProof !== processOwnershipProof(supervision, processPid)) throw new Error('Process supervisor returned invalid process ownership.');
  if (processPid === undefined || processProof === undefined) return Object.freeze({});
  return Object.freeze({ processPid, processProof });
}

export function verifySupervisorTerminalState(value: unknown, supervision: ProcessSupervisorIdentity): SupervisorTerminalState {
  if (!isRecord(value) || value.identity !== supervision.identity || value.processId !== supervision.processId || !sameOwner(value.owner, supervision.owner)
    || (value.state !== 'exited' && value.state !== 'stopped' && value.state !== 'failed')
    || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || typeof value.exitCode !== 'number'))
    || (value.signal !== null && typeof value.signal !== 'string') || typeof value.proof !== 'string') {
    throw new Error('Invalid process supervisor terminal state.');
  }
  const expected = terminalStateProof(supervision, value.state, value.exitCode, value.signal);
  if (!safeEqual(value.proof, expected)) throw new Error('Process supervisor terminal state failed authentication.');
  return Object.freeze({ identity: value.identity, processId: value.processId, owner: supervision.owner, state: value.state, exitCode: value.exitCode, signal: value.signal, proof: value.proof });
}

export function terminalStateProof(supervision: ProcessSupervisorIdentity, state: string, exitCode: number | null, signal: string | null): string {
  return hmac(supervision.authenticationToken, `terminal\n${supervision.identity}\n${supervision.processId}\n${ownerText(supervision.owner)}\n${state}\n${String(exitCode)}\n${String(signal)}`);
}

class SupervisorController implements SupervisedProcessTree {
  readonly started: Promise<void>;
  readonly supervision: ProcessSupervisorIdentity;
  readonly #settled: Promise<void>;
  #operation: Promise<void> = Promise.resolve();
  #processGroup: number | undefined;
  #releaseAttempted = false;
  #stopRequested = false;

  constructor(readonly child: ChildProcessByStdio<Writable, Readable, Readable>, supervision: ProcessSupervisorIdentity) {
    this.supervision = supervision;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    this.started = spawned.then(() => waitForSupervisor(supervision, child));
    this.#settled = new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        void this.settleProcessTree().then(resolve, reject);
      };
      child.once('close', finish);
      child.once('error', finish);
    });
  }

  async release(): Promise<void> {
    this.#releaseAttempted = true;
    const response = await sendSupervisorCommand(this.supervision, 'release', 5_000);
    if (response.processPid === undefined) throw new Error('Process supervisor did not return authenticated process ownership.');
    this.#processGroup = response.processPid;
  }

  stop(): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    this.#operation = sendSupervisorCommand(this.supervision, 'stop', 5_000).then(() => undefined).catch(async (error: unknown) => {
      // This is the exact child handle created by this controller, not a recovered PID.
      try { this.child.kill('SIGKILL'); } catch { /* The supervisor already exited. */ }
      try { await this.#settled; } catch { throw error; }
    });
  }

  async settle(): Promise<void> {
    await this.#operation;
    await this.#settled;
  }

  private async settleProcessTree(): Promise<void> {
    try {
      verifySupervisorTerminalState(JSON.parse(await readFile(this.supervision.stateFile, 'utf8')), this.supervision);
      return;
    } catch (error) {
      if (!this.#releaseAttempted) return;
      if (this.#processGroup === undefined) throw error;
      await stopExistingProcessTree(this.#processGroup);
    }
  }
}

async function waitForSupervisor(supervision: ProcessSupervisorIdentity, child: ChildProcessByStdio<Writable, Readable, Readable>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Process supervisor exited before authentication with code ${String(child.exitCode)}.`);
    try { await sendSupervisorCommand(supervision, 'challenge', 250); return; }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error(`Process supervisor did not become ready: ${errorMessage(lastError)}`);
}

function exchange(endpoint: string, payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = '';
    let completed = false;
    const timer = setTimeout(() => { finish(new Error('Process supervisor IPC timed out.')); }, timeoutMs);
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(response.trim());
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => { socket.write(payload); });
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > 16_384) finish(new Error('Process supervisor response exceeded its limit.'));
      else if (response.includes('\n')) finish();
    });
    socket.once('error', (error) => { finish(error); });
    socket.once('end', () => { if (response.trim().length > 0) finish(); else finish(new Error('Process supervisor closed without a response.')); });
  });
}

function hmac(token: string, value: string): string { return createHmac('sha256', token).update(value).digest('hex'); }
function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8'); const right = Buffer.from(expected, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function processOwnershipProof(supervision: ProcessSupervisorIdentity, processPid: number): string {
  return hmac(supervision.authenticationToken, `process\n${supervision.identity}\n${supervision.processId}\n${ownerText(supervision.owner)}\n${String(processPid)}`);
}
function ownerText(owner: ProcessSupervisorOwner): string { return `${owner.runId}\n${owner.turnId}\n${owner.toolBatchId}\n${String(owner.callIndex)}`; }
function sameOwner(value: unknown, expected: ProcessSupervisorOwner): boolean {
  return isRecord(value) && value.runId === expected.runId && value.turnId === expected.turnId && value.toolBatchId === expected.toolBatchId && value.callIndex === expected.callIndex;
}
function invalidResponse(): never { throw new Error('Process supervisor returned invalid process ownership.'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
