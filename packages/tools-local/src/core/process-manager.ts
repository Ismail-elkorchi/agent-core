import { randomUUID } from 'node:crypto';
import type { ArtifactRef, ArtifactRepository } from '@agent-core/evidence';
import { spawnOwnedProcess, type OwnedProcessTree } from './process-tree.js';

export type ProcessStream = 'stdout' | 'stderr';
export type ManagedProcessStatus = 'running' | 'exited' | 'stopped' | 'timed_out' | 'failed';

export interface ProcessManagerOptions {
  readonly artifactRepository: ArtifactRepository;
  readonly maxCapturedBytes: number;
  readonly tailBytes: number;
  readonly ptyFactory?: PtyProcessFactory;
}

export interface PtyProcessFactory {
  start(command: string, cwd: string, env: NodeJS.ProcessEnv): OwnedProcessTree;
}

export interface StartProcessRequest {
  readonly command: string;
  readonly cwd: string;
  readonly pty: boolean;
  readonly timeoutMs: number;
  readonly yieldMs: number;
  readonly outputTokenBudget: number;
  readonly signal?: AbortSignal;
}

export interface ProcessOutputView {
  readonly text: string;
  readonly observedBytes: number;
  readonly capturedBytes: number;
  readonly omittedBytes: number;
  readonly startsAtOutputStart: boolean;
  readonly endsAtOutputEnd: boolean;
}

export interface ProcessPollResult {
  readonly processId: string;
  readonly status: ManagedProcessStatus;
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly stdout: ProcessOutputView;
  readonly stderr: ProcessOutputView;
  readonly combined: ProcessOutputView;
  readonly artifact: ArtifactRef;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly diagnostic?: string;
}

interface CapturedChunk { readonly sequence: number; readonly stream: ProcessStream; readonly bytes: Buffer }

interface ManagedProcess {
  readonly id: string;
  readonly tree: OwnedProcessTree;
  readonly startedAt: number;
  readonly full: StreamWindows;
  pending: StreamWindows;
  status: ManagedProcessStatus;
  cursor: number;
  sequence: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  diagnostic?: string;
  timeout?: ReturnType<typeof setTimeout>;
  readonly activityWaiters: Set<() => void>;
}

interface StreamWindows { readonly stdout: BoundedWindow; readonly stderr: BoundedWindow; readonly combined: BoundedWindow }

export class ProcessManager {
  private readonly options: ProcessManagerOptions;
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(options: ProcessManagerOptions) { this.options = options; }

  async start(request: StartProcessRequest): Promise<ProcessPollResult> {
    const id = `proc_${randomUUID()}`;
    const tree = request.pty
      ? this.requirePtyFactory().start(request.command, request.cwd, process.env)
      : spawnOwnedProcess(request.command, request.cwd);
    const record: ManagedProcess = {
      id,
      tree,
      startedAt: Date.now(),
      full: windows(this.options.maxCapturedBytes, this.options.tailBytes),
      pending: windows(this.options.maxCapturedBytes, this.options.tailBytes),
      status: 'running',
      cursor: 0,
      sequence: 0,
      activityWaiters: new Set()
    };
    this.processes.set(id, record);
    tree.child.stdout.on('data', (value: Buffer | string) => { this.append(record, 'stdout', value); });
    tree.child.stderr.on('data', (value: Buffer | string) => { this.append(record, 'stderr', value); });
    tree.child.once('error', (error) => {
      record.status = 'failed';
      record.diagnostic = error.message;
      this.signalActivity(record);
    });
    tree.child.once('close', (exitCode, signal) => {
      if (record.status === 'running') record.status = 'exited';
      record.exitCode = exitCode;
      record.signal = signal ?? null;
      if (record.timeout !== undefined) clearTimeout(record.timeout);
      void tree.settle();
      this.signalActivity(record);
    });
    record.timeout = setTimeout(() => {
      if (record.status !== 'running') return;
      record.status = 'timed_out';
      tree.stop();
      this.signalActivity(record);
    }, request.timeoutMs);
    record.timeout.unref();
    if (request.signal) {
      const stop = () => { if (record.status === 'running') void this.stop(id); };
      request.signal.addEventListener('abort', stop, { once: true });
      if (request.signal.aborted) stop();
    }
    await this.waitForActivity(record, request.yieldMs);
    return this.poll(id, request.outputTokenBudget);
  }

  async poll(processId: string, outputTokenBudget: number, yieldMs = 0): Promise<ProcessPollResult> {
    const record = this.requireProcess(processId);
    if (record.status === 'running' && record.pending.combined.observedBytes === 0 && yieldMs > 0) {
      await this.waitForActivity(record, yieldMs);
    }
    const cursorStart = record.cursor;
    const cursorEnd = record.full.combined.observedBytes;
    const budgetBytes = Math.max(256, outputTokenBudget * 4);
    const stdout = contextualizeView(
      record.pending.stdout.view(Math.max(64, Math.floor(budgetBytes / 4))),
      record.full.stdout.observedBytes === record.pending.stdout.observedBytes
    );
    const stderr = contextualizeView(
      record.pending.stderr.view(Math.max(64, Math.floor(budgetBytes / 4))),
      record.full.stderr.observedBytes === record.pending.stderr.observedBytes
    );
    const combined = contextualizeView(
      record.pending.combined.view(Math.max(128, Math.floor(budgetBytes / 2))),
      cursorStart === 0
    );
    record.pending = windows(this.options.maxCapturedBytes, this.options.tailBytes);
    record.cursor = cursorEnd;
    const artifact = await this.storeArtifact(record);
    return {
      processId,
      status: record.status,
      cursorStart,
      cursorEnd,
      stdout,
      stderr,
      combined,
      artifact,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic })
    };
  }

  async write(processId: string, text: string): Promise<void> {
    const record = this.requireRunningProcess(processId);
    await new Promise<void>((resolve, reject) => {
      record.tree.child.stdin.write(text, (error) => { if (error) reject(error); else resolve(); });
    });
  }

  async closeStdin(processId: string): Promise<void> {
    const record = this.requireRunningProcess(processId);
    await new Promise<void>((resolve, reject) => {
      record.tree.child.stdin.end((error?: Error | null) => { if (error) reject(error); else resolve(); });
    });
  }

  async stop(processId: string): Promise<void> {
    const record = this.requireProcess(processId);
    if (record.status === 'running') {
      record.status = 'stopped';
      if (record.timeout !== undefined) clearTimeout(record.timeout);
      record.tree.stop();
    }
    await record.tree.settle();
    this.signalActivity(record);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.processes.values()].map((record) => this.stop(record.id)));
  }

  has(processId: string): boolean { return this.processes.has(processId); }

  private append(record: ManagedProcess, stream: ProcessStream, value: Buffer | string): void {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes.length === 0) return;
    const chunk = { sequence: record.sequence, stream, bytes: Buffer.from(bytes) };
    record.sequence += 1;
    record.full[stream].append(chunk);
    record.full.combined.append(chunk);
    record.pending[stream].append(chunk);
    record.pending.combined.append(chunk);
    this.signalActivity(record);
  }

  private requirePtyFactory(): PtyProcessFactory {
    if (!this.options.ptyFactory) throw new Error('PTY mode is not available on this host; call exec_command with pty=false.');
    return this.options.ptyFactory;
  }

  private requireProcess(processId: string): ManagedProcess {
    const record = this.processes.get(processId);
    if (!record) throw new Error(`Unknown process: ${processId}`);
    return record;
  }

  private requireRunningProcess(processId: string): ManagedProcess {
    const record = this.requireProcess(processId);
    if (record.status !== 'running') throw new Error(`Process is not running: ${processId}`);
    return record;
  }

  private waitForActivity(record: ManagedProcess, yieldMs: number): Promise<void> {
    if (yieldMs <= 0 || record.status !== 'running' || record.pending.combined.observedBytes > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        record.activityWaiters.delete(waiter);
        resolve();
      };
      const waiter = () => { finish(); };
      const timer = setTimeout(finish, yieldMs);
      record.activityWaiters.add(waiter);
    });
  }

  private signalActivity(record: ManagedProcess): void {
    for (const waiter of [...record.activityWaiters]) waiter();
  }

  private async storeArtifact(record: ManagedProcess): Promise<ArtifactRef> {
    const data = {
      processId: record.id,
      status: record.status,
      startedAt: new Date(record.startedAt).toISOString(),
      observedBytes: record.full.combined.observedBytes,
      capturedBytes: record.full.combined.capturedBytes,
      omittedBytes: record.full.combined.omittedBytes,
      chunks: record.full.combined.chunks().map((chunk) => ({ sequence: chunk.sequence, stream: chunk.stream, text: chunk.bytes.toString('utf8') }))
    };
    return this.options.artifactRepository.store({
      label: `${record.id}-output`,
      content: new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`),
      mediaType: 'application/json; charset=utf-8',
      description: 'Bounded process output preserving stdout/stderr order.'
    });
  }
}

export function isProcessManager(value: unknown): value is ProcessManager { return value instanceof ProcessManager; }

class BoundedWindow {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  readonly #head: CapturedChunk[] = [];
  readonly #tail: CapturedChunk[] = [];
  observedBytes = 0;
  #headBytes = 0;
  #tailBytes = 0;

  constructor(maxBytes: number, tailBytes: number) {
    this.#tailLimit = Math.min(tailBytes, Math.floor(maxBytes / 2));
    this.#headLimit = maxBytes - this.#tailLimit;
  }

  append(chunk: CapturedChunk): void {
    this.observedBytes += chunk.bytes.length;
    let remaining = chunk.bytes;
    if (this.#headBytes < this.#headLimit) {
      const count = Math.min(remaining.length, this.#headLimit - this.#headBytes);
      if (count > 0) {
        this.#head.push({ ...chunk, bytes: Buffer.from(remaining.subarray(0, count)) });
        this.#headBytes += count;
        remaining = remaining.subarray(count);
      }
    }
    if (remaining.length > 0 && this.#tailLimit > 0) {
      this.#tail.push({ ...chunk, bytes: Buffer.from(remaining) });
      this.#tailBytes += remaining.length;
      this.trimTail();
    }
  }

  get capturedBytes(): number { return this.#headBytes + this.#tailBytes; }
  get omittedBytes(): number { return Math.max(0, this.observedBytes - this.capturedBytes); }

  chunks(): readonly CapturedChunk[] { return [...this.#head, ...this.#tail]; }

  view(maxBytes: number): ProcessOutputView {
    const retained = excerpt(this.chunks(), maxBytes);
    const capturedBytes = retained.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
    return {
      text: retained.map((chunk) => chunk.bytes.toString('utf8')).join(''),
      observedBytes: this.observedBytes,
      capturedBytes,
      omittedBytes: Math.max(0, this.observedBytes - capturedBytes),
      startsAtOutputStart: retained[0]?.sequence === this.#head[0]?.sequence,
      endsAtOutputEnd: retained.at(-1)?.sequence === this.chunks().at(-1)?.sequence
    };
  }

  private trimTail(): void {
    while (this.#tailBytes > this.#tailLimit && this.#tail.length > 0) {
      const first = this.#tail[0];
      if (!first) break;
      const excess = this.#tailBytes - this.#tailLimit;
      if (first.bytes.length <= excess) {
        this.#tail.shift();
        this.#tailBytes -= first.bytes.length;
      } else {
        this.#tail[0] = { ...first, bytes: Buffer.from(first.bytes.subarray(excess)) };
        this.#tailBytes -= excess;
      }
    }
  }
}

function windows(maxBytes: number, tailBytes: number): StreamWindows {
  return {
    stdout: new BoundedWindow(maxBytes, tailBytes),
    stderr: new BoundedWindow(maxBytes, tailBytes),
    combined: new BoundedWindow(maxBytes, tailBytes)
  };
}

function contextualizeView(view: ProcessOutputView, includesOutputStart: boolean): ProcessOutputView {
  return {
    ...view,
    startsAtOutputStart: includesOutputStart && view.startsAtOutputStart
  };
}

function excerpt(chunks: readonly CapturedChunk[], maxBytes: number): CapturedChunk[] {
  const total = chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
  if (total <= maxBytes) return [...chunks];
  const headLimit = Math.floor(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  return [...takeStart(chunks, headLimit), ...takeEnd(chunks, tailLimit)];
}

function takeStart(chunks: readonly CapturedChunk[], limit: number): CapturedChunk[] {
  const output: CapturedChunk[] = [];
  let remaining = limit;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const bytes = chunk.bytes.subarray(0, remaining);
    output.push({ ...chunk, bytes: Buffer.from(bytes) });
    remaining -= bytes.length;
  }
  return output;
}

function takeEnd(chunks: readonly CapturedChunk[], limit: number): CapturedChunk[] {
  const output: CapturedChunk[] = [];
  let remaining = limit;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    const bytes = chunk.bytes.subarray(Math.max(0, chunk.bytes.length - remaining));
    output.unshift({ ...chunk, bytes: Buffer.from(bytes) });
    remaining -= bytes.length;
  }
  return output;
}
