import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  parseJsonObject,
  redactJson,
  type ArtifactRepository,
  type ProtectedArtifactRef,
  type PublicArtifactRef
} from '@agent-core/evidence';
import { ResourceLeaseCoordinator } from '@agent-core/tools';
import type { ToolProgress, ToolResourceLease } from '@agent-core/tools';
import {
  processTreeExists,
  spawnOwnedProcess,
  stopExistingProcessTree,
  type OwnedProcessTree
} from './process-tree.js';

export type ProcessStream = 'stdout' | 'stderr';
export type ManagedProcessStatus = 'running' | 'exited' | 'stopped' | 'timed_out' | 'failed';
export interface ProcessOwner { readonly runId: string; readonly turnId: string; readonly toolBatchId: string; readonly callIndex: number }
export interface ProcessManagerOptions {
  readonly artifactRepository: ArtifactRepository;
  readonly maxCapturedBytes: number;
  readonly tailBytes: number;
  readonly ledgerDirectory?: string;
  readonly maxActiveProcessesPerRun?: number;
  readonly maxActiveProcesses?: number;
  readonly maxTotalCapturedBytes?: number;
  readonly maxProcessLifetimeMs?: number;
  readonly completedRetentionMs?: number;
  readonly maxPendingOutputBytes?: number;
  readonly ptyFactory?: PtyProcessFactory;
}
export interface PtyProcessFactory { start(command: string, cwd: string, env: NodeJS.ProcessEnv): OwnedProcessTree }
export interface StartProcessRequest {
  readonly command: string;
  readonly cwd: string;
  readonly pty: boolean;
  readonly timeoutMs: number;
  readonly yieldMs: number;
  readonly outputTokenBudget: number;
  readonly owner: ProcessOwner;
  readonly signal?: AbortSignal;
  readonly lease?: ToolResourceLease;
  readonly onProgress?: (progress: ToolProgress) => void | Promise<void>;
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
  readonly owner: ProcessOwner;
  readonly status: ManagedProcessStatus;
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly cursorExpired?: boolean;
  readonly stdout: ProcessOutputView;
  readonly stderr: ProcessOutputView;
  readonly combined: ProcessOutputView;
  readonly artifact?: PublicArtifactRef;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly diagnostic?: string;
  readonly progressDroppedEvents?: number;
  readonly progressDeliveryErrors?: number;
}
export interface ProcessTerminalReport {
  readonly result: ProcessPollResult;
  readonly protectedArtifact?: ProtectedArtifactRef;
}
export interface ProcessReconciliationResult {
  readonly resolved: readonly string[];
  readonly unresolved: readonly { readonly processId: string; readonly diagnostic: string }[];
}

interface CapturedChunk { readonly sequence: number; readonly stream: ProcessStream; readonly text: string; readonly start: number; readonly end: number; readonly bytes: number }
interface QueuedProgress { readonly progress: ToolProgress; readonly bytes: number }
interface ManagedProcess {
  readonly id: string;
  readonly owner: ProcessOwner;
  readonly workspace: string;
  readonly tree: OwnedProcessTree;
  readonly startedAt: number;
  readonly capture: BoundedCapture;
  readonly history: CapturedChunk[];
  readonly decoder: { readonly stdout: StringDecoder; readonly stderr: StringDecoder };
  readonly activityWaiters: Set<() => void>;
  readonly onProgress?: StartProcessRequest['onProgress'];
  readonly lease?: ToolResourceLease;
  readonly progressQueue: QueuedProgress[];
  status: ManagedProcessStatus;
  cursor: number;
  oldestCursor: number;
  sequence: number;
  historyBytes: number;
  progressBytes: number;
  progressDelivering: boolean;
  progressStarted: boolean;
  progressDroppedEvents: number;
  progressDeliveryErrors: number;
  terminalReported: boolean;
  readonly observed: { stdout: number; stderr: number };
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  diagnostic?: string;
  timeout?: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  artifactPromise?: Promise<ProcessArtifacts>;
  finishPromise?: Promise<void>;
  startupComplete: boolean;
  startupFailed: boolean;
  pendingClose?: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };
}
interface ProcessArtifacts { readonly publicArtifact?: PublicArtifactRef; readonly protectedArtifact?: ProtectedArtifactRef }
interface ProcessLedgerEntry {
  readonly schemaVersion: 1;
  readonly processId: string;
  readonly osPid: number;
  readonly processGroup: number;
  readonly owner: ProcessOwner;
  readonly startedAt: string;
  readonly workspace: string;
  readonly state: 'running' | 'terminal';
  readonly terminalReported: boolean;
  readonly terminal?: ProcessPollResult;
  readonly protectedArtifact?: ProtectedArtifactRef;
}

export class ProcessManager {
  readonly resourceLeases = new ResourceLeaseCoordinator();
  private readonly active = new Map<string, ManagedProcess>();
  private readonly completed = new Map<string, ManagedProcess>();
  private readonly recovered = new Map<string, ProcessTerminalReport>();
  private readonly limits: Required<Pick<ProcessManagerOptions, 'maxActiveProcessesPerRun' | 'maxActiveProcesses' | 'maxTotalCapturedBytes' | 'maxProcessLifetimeMs' | 'completedRetentionMs' | 'maxPendingOutputBytes'>>;
  private readonly ready: Promise<ProcessReconciliationResult>;
  private reservedCapturedBytes = 0;

  constructor(private readonly options: ProcessManagerOptions) {
    this.limits = {
      maxActiveProcessesPerRun: positive(options.maxActiveProcessesPerRun ?? 8, 'maxActiveProcessesPerRun'),
      maxActiveProcesses: positive(options.maxActiveProcesses ?? 32, 'maxActiveProcesses'),
      maxTotalCapturedBytes: positive(options.maxTotalCapturedBytes ?? Math.max(options.maxCapturedBytes, options.maxCapturedBytes * 8), 'maxTotalCapturedBytes'),
      maxProcessLifetimeMs: positive(options.maxProcessLifetimeMs ?? 3_600_000, 'maxProcessLifetimeMs'),
      completedRetentionMs: positive(options.completedRetentionMs ?? 60_000, 'completedRetentionMs'),
      maxPendingOutputBytes: positive(options.maxPendingOutputBytes ?? Math.min(options.maxCapturedBytes, 2_000_000), 'maxPendingOutputBytes')
    };
    this.ready = this.reconcileLedger();
  }

  capabilities(): readonly string[] { return Object.freeze(this.options.ptyFactory ? ['process', 'process.pty'] : ['process']); }
  supportsPty(): boolean { return this.options.ptyFactory !== undefined; }

  async start(request: StartProcessRequest): Promise<ProcessPollResult> {
    await this.ready;
    this.pruneExpired();
    if (this.active.size >= this.limits.maxActiveProcesses) throw new Error('Maximum active process count reached.');
    if ([...this.active.values()].filter((item) => item.owner.runId === request.owner.runId).length >= this.limits.maxActiveProcessesPerRun) throw new Error('Maximum active process count for this run reached.');
    if (this.reservedCapturedBytes + this.options.maxCapturedBytes > this.limits.maxTotalCapturedBytes) throw new Error('Maximum total captured process bytes reached.');
    const id = 'proc_' + randomUUID();
    const tree = request.pty ? this.requirePtyFactory().start(request.command, request.cwd, process.env) : spawnOwnedProcess(request.command, request.cwd);
    const osPid = tree.child.pid;
    if (osPid === undefined || osPid <= 0) {
      tree.stop('SIGKILL');
      throw new Error('The process host did not provide an operating-system process ID.');
    }
    const record: ManagedProcess = {
      id, owner: Object.freeze({ ...request.owner }), workspace: request.cwd, tree, startedAt: Date.now(),
      capture: new BoundedCapture(this.options.maxCapturedBytes, this.options.tailBytes),
      history: [], decoder: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      activityWaiters: new Set(), progressQueue: [], status: 'running', cursor: 0, oldestCursor: 0, sequence: 0,
      historyBytes: 0, progressBytes: 0, progressDelivering: false, progressStarted: false, progressDroppedEvents: 0,
      progressDeliveryErrors: 0, terminalReported: false, observed: { stdout: 0, stderr: 0 },
      startupComplete: false, startupFailed: false,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}), ...(request.lease ? { lease: request.lease } : {})
    };
    this.active.set(id, record);
    this.reservedCapturedBytes += this.options.maxCapturedBytes;
    tree.child.stdout.on('data', (value: Buffer | string) => { this.decodeAndAppend(record, 'stdout', value); });
    tree.child.stderr.on('data', (value: Buffer | string) => { this.decodeAndAppend(record, 'stderr', value); });
    tree.child.once('error', (error) => {
      record.status = 'failed';
      record.diagnostic = error.message;
      this.signalActivity(record);
    });
    tree.child.once('close', (exitCode, signal) => {
      if (!record.startupComplete) { record.pendingClose = { exitCode, signal: signal ?? null }; return; }
      if (!record.startupFailed) this.handleClose(record, exitCode, signal ?? null);
    });
    try {
      await tree.started;
      await this.persistLedger(this.runningLedgerEntry(record, osPid));
      record.startupComplete = true;
    } catch (error) {
      record.startupComplete = true;
      record.startupFailed = true;
      this.active.delete(id);
      this.reservedCapturedBytes -= this.options.maxCapturedBytes;
      tree.stop('SIGKILL');
      await tree.settle();
      throw error;
    }
    this.enqueueProgress(record, { type: 'status', stage: 'process_started', message: `Process ${id} started.` });
    record.progressStarted = true;
    for (const chunk of record.history) this.enqueueProgress(record, { type: 'output', stream: chunk.stream, sequence: chunk.sequence, text: chunk.text, observedBytes: chunk.end });
    if (record.pendingClose) this.handleClose(record, record.pendingClose.exitCode, record.pendingClose.signal);
    if (record.status === 'running') {
      record.timeout = setTimeout(() => {
        if (record.status !== 'running') return;
        record.status = 'timed_out';
        record.tree.stop();
        this.signalActivity(record);
      }, Math.min(request.timeoutMs, this.limits.maxProcessLifetimeMs));
      record.timeout.unref();
    }
    if (request.signal) {
      record.abortSignal = request.signal;
      record.abortListener = () => { if (record.status === 'running') void this.disposeProcess(id).catch((error: unknown) => { record.diagnostic = errorMessage(error); }); };
      request.signal.addEventListener('abort', record.abortListener, { once: true });
      if (request.signal.aborted) record.abortListener();
    }
    await this.waitForActivity(record, request.yieldMs, 0);
    if (record.status === 'running' && request.lease) request.lease.transferToProcess(id);
    return this.poll(id, request.outputTokenBudget, 0, 0, request.owner);
  }

  async poll(processId: string, outputTokenBudget: number, yieldMs = 0, afterCursor = 0, requester?: ProcessOwner): Promise<ProcessPollResult> {
    await this.ready;
    this.pruneExpired();
    const record = this.requireProcess(processId);
    this.assertOwner(record, requester);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > record.cursor) throw new Error('Invalid process output cursor.');
    if (record.status === 'running' && record.cursor === afterCursor && yieldMs > 0) await this.waitForActivity(record, yieldMs, afterCursor);
    const cursorExpired = afterCursor < record.oldestCursor;
    const useCapture = cursorExpired && afterCursor === 0;
    const effectiveCursor = useCapture ? 0 : cursorExpired ? record.oldestCursor : afterCursor;
    const budgetBytes = Math.max(256, outputTokenBudget * 4);
    const available = useCapture ? record.capture.chunks() : record.history.filter((chunk) => chunk.end > effectiveCursor);
    const stdout = view(available.filter((chunk) => chunk.stream === 'stdout'), Math.max(64, Math.floor(budgetBytes / 4)), effectiveCursor, record.cursor, useCapture ? 0 : record.oldestCursor, useCapture ? record.observed.stdout : undefined);
    const stderr = view(available.filter((chunk) => chunk.stream === 'stderr'), Math.max(64, Math.floor(budgetBytes / 4)), effectiveCursor, record.cursor, useCapture ? 0 : record.oldestCursor, useCapture ? record.observed.stderr : undefined);
    const combined = view(available, Math.max(128, Math.floor(budgetBytes / 2)), effectiveCursor, record.cursor, useCapture ? 0 : record.oldestCursor, useCapture ? record.cursor : undefined);
    const artifacts = record.status === 'running' ? undefined : await this.finalArtifacts(record);
    return Object.freeze({
      processId, owner: record.owner, status: record.status, cursorStart: effectiveCursor, cursorEnd: record.cursor,
      ...(cursorExpired ? { cursorExpired: true } : {}), stdout, stderr, combined,
      ...(artifacts?.publicArtifact ? { artifact: artifacts.publicArtifact } : {}),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }),
      ...(record.progressDroppedEvents > 0 ? { progressDroppedEvents: record.progressDroppedEvents } : {}),
      ...(record.progressDeliveryErrors > 0 ? { progressDeliveryErrors: record.progressDeliveryErrors } : {})
    });
  }

  async write(processId: string, text: string, requester?: ProcessOwner): Promise<void> {
    await this.ready;
    const record = this.requireRunningProcess(processId);
    this.assertOwner(record, requester);
    await new Promise<void>((resolve, reject) => record.tree.child.stdin.write(text, (error) => { if (error) reject(error); else resolve(); }));
  }

  async closeStdin(processId: string, requester?: ProcessOwner): Promise<void> {
    await this.ready;
    const record = this.requireProcess(processId);
    this.assertOwner(record, requester);
    if (record.status !== 'running' || record.tree.child.stdin.writableEnded) return;
    await new Promise<void>((resolve, reject) => record.tree.child.stdin.end((error?: Error | null) => { if (error) reject(error); else resolve(); }));
  }

  async disposeProcess(processId: string, requester?: ProcessOwner): Promise<ProcessPollResult> {
    await this.ready;
    const record = this.requireProcess(processId);
    this.assertOwner(record, requester);
    if (record.status === 'running') {
      this.enqueueProgress(record, { type: 'status', stage: 'process_stopping', message: `Stopping process ${processId}.` });
      record.status = 'stopped';
      record.tree.stop();
    }
    await record.tree.settle();
    await this.finish(record);
    return this.poll(processId, 4_000, 0, 0, requester);
  }

  async stop(processId: string, requester?: ProcessOwner): Promise<void> { await this.disposeProcess(processId, requester); }

  /** Stop active owned processes and return every terminal process not yet durably reported. */
  async disposeRun(runId: string): Promise<readonly ProcessTerminalReport[]> {
    await this.ready;
    const active = [...this.active.values()].filter((record) => record.owner.runId === runId);
    for (const record of active) await this.disposeProcess(record.id);
    return this.unreportedTerminalProcesses(runId);
  }

  async unreportedTerminalProcesses(runId: string): Promise<readonly ProcessTerminalReport[]> {
    await this.ready;
    const reports: ProcessTerminalReport[] = [];
    for (const record of this.completed.values()) {
      if (record.owner.runId !== runId || record.terminalReported) continue;
      const artifacts = await this.finalArtifacts(record);
      reports.push(Object.freeze({ result: await this.poll(record.id, 4_000), ...(artifacts.protectedArtifact ? { protectedArtifact: artifacts.protectedArtifact } : {}) }));
    }
    for (const report of this.recovered.values()) if (report.result.owner.runId === runId) reports.push(report);
    return Object.freeze(reports.sort((left, right) => left.result.processId.localeCompare(right.result.processId)));
  }

  /** Call only after process.ended persistence succeeds or another durable handoff exists. */
  async markTerminalReported(processId: string): Promise<void> {
    await this.ready;
    const record = this.completed.get(processId);
    if (record) record.terminalReported = true;
    this.recovered.delete(processId);
    await this.removeLedger(processId);
  }

  async reconcileOrphanProcesses(): Promise<ProcessReconciliationResult> { return this.ready; }
  has(processId: string): boolean { this.pruneExpired(); return this.active.has(processId) || this.completed.has(processId); }
  activeCount(runId?: string): number { return runId === undefined ? this.active.size : [...this.active.values()].filter((record) => record.owner.runId === runId).length; }

  private decodeAndAppend(record: ManagedProcess, stream: ProcessStream, value: Buffer | string): void {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const text = record.decoder[stream].write(bytes);
    if (text.length > 0) this.append(record, stream, text);
  }

  private handleClose(record: ManagedProcess, exitCode: number | null, signal: NodeJS.Signals | null): void {
    delete record.pendingClose;
    this.flushDecoders(record);
    if (record.status === 'running') record.status = exitCode === null ? 'failed' : 'exited';
    record.exitCode = exitCode;
    record.signal = signal;
    this.enqueueProgress(record, terminalProgress(record));
    void this.settleAndFinish(record);
  }

  private flushDecoders(record: ManagedProcess): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = record.decoder[stream].end();
      if (text.length > 0) this.append(record, stream, text);
    }
  }

  private append(record: ManagedProcess, stream: ProcessStream, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    record.observed[stream] += bytes;
    const chunk: CapturedChunk = { sequence: record.sequence++, stream, text, start: record.cursor, end: record.cursor + bytes, bytes };
    record.cursor += bytes;
    record.capture.append(chunk);
    record.history.push(chunk);
    record.historyBytes += bytes;
    while (record.historyBytes > this.limits.maxPendingOutputBytes && record.history.length > 0) {
      const removed = record.history.shift();
      if (!removed) break;
      record.historyBytes -= removed.bytes;
      record.oldestCursor = removed.end;
      if (!record.progressStarted) record.progressDroppedEvents += 1;
    }
    if (record.progressStarted) this.enqueueProgress(record, { type: 'output', stream, sequence: chunk.sequence, text, observedBytes: record.cursor });
    this.signalActivity(record);
  }

  private enqueueProgress(record: ManagedProcess, progress: ToolProgress): void {
    if (!record.onProgress) return;
    const bytes = Buffer.byteLength(JSON.stringify(progress), 'utf8');
    if (progress.type === 'output' && record.progressBytes + bytes > this.limits.maxPendingOutputBytes) {
      record.progressDroppedEvents += 1;
      return;
    }
    while (record.progressBytes + bytes > this.limits.maxPendingOutputBytes) {
      const index = record.progressQueue.findIndex((item) => item.progress.type === 'output');
      if (index < 0) break;
      const [removed] = record.progressQueue.splice(index, 1);
      if (removed) { record.progressBytes -= removed.bytes; record.progressDroppedEvents += 1; }
    }
    record.progressQueue.push({ progress, bytes });
    record.progressBytes += bytes;
    if (!record.progressDelivering) void this.drainProgress(record);
  }

  private async drainProgress(record: ManagedProcess): Promise<void> {
    record.progressDelivering = true;
    try {
      while (record.progressQueue.length > 0) {
        const item = record.progressQueue.shift();
        if (!item) continue;
        record.progressBytes -= item.bytes;
        try { await record.onProgress?.(item.progress); }
        catch (error) {
          record.progressDeliveryErrors += 1;
          record.diagnostic = appendDiagnostic(record.diagnostic, `Progress delivery failed: ${errorMessage(error)}`);
        }
      }
    } finally {
      record.progressDelivering = false;
      if (record.progressQueue.length > 0) void this.drainProgress(record);
    }
  }

  private async settleAndFinish(record: ManagedProcess): Promise<void> {
    try { await record.tree.settle(); }
    catch (error) { record.diagnostic = appendDiagnostic(record.diagnostic, `Process settlement failed: ${errorMessage(error)}`); }
    try { await this.finish(record); }
    catch (error) { record.diagnostic = appendDiagnostic(record.diagnostic, `Process finalization failed: ${errorMessage(error)}`); }
  }

  private finish(record: ManagedProcess): Promise<void> {
    record.finishPromise ??= this.finishOnce(record);
    return record.finishPromise;
  }

  private async finishOnce(record: ManagedProcess): Promise<void> {
    if (record.timeout) { clearTimeout(record.timeout); delete record.timeout; }
    if (record.abortSignal && record.abortListener) record.abortSignal.removeEventListener('abort', record.abortListener);
    delete record.abortSignal;
    delete record.abortListener;
    this.active.delete(record.id);
    this.completed.set(record.id, record);
    record.lease?.release();
    this.signalActivity(record);
    const artifacts = await this.finalArtifacts(record);
    const result = await this.poll(record.id, 4_000);
    await this.persistLedger({
      ...this.runningLedgerEntry(record, requirePid(record.tree)), state: 'terminal', terminalReported: false,
      terminal: result, ...(artifacts.protectedArtifact ? { protectedArtifact: artifacts.protectedArtifact } : {})
    });
    record.retention ??= setTimeout(() => { this.expire(record.id); }, this.limits.completedRetentionMs);
    record.retention.unref();
  }

  private finalArtifacts(record: ManagedProcess): Promise<ProcessArtifacts> {
    record.artifactPromise ??= (async () => {
      const payload = {
        processId: record.id, owner: record.owner, status: record.status, startedAt: new Date(record.startedAt).toISOString(),
        observedBytes: record.cursor, retainedBytes: record.capture.retainedBytes,
        omittedBytes: Math.max(0, record.cursor - record.capture.retainedBytes),
        chunks: record.capture.chunks().map((chunk) => ({ sequence: chunk.sequence, stream: chunk.stream, text: chunk.text }))
      };
      const raw = new TextEncoder().encode(JSON.stringify(payload, null, 2) + '\n');
      let protectedArtifact: ProtectedArtifactRef | undefined;
      let publicArtifact: PublicArtifactRef | undefined;
      try {
        protectedArtifact = await this.options.artifactRepository.storeProtected({
          label: record.id + '-raw-output', content: raw, mediaType: 'application/json; charset=utf-8',
          description: 'Protected bounded raw process output preserving stdout/stderr order.'
        });
      } catch (error) { record.diagnostic = appendDiagnostic(record.diagnostic, `Protected output storage failed: ${errorMessage(error)}`); }
      try {
        const redacted = redactJson(payload);
        publicArtifact = await this.options.artifactRepository.store({
          label: record.id + '-output', content: new TextEncoder().encode(JSON.stringify(redacted.value, null, 2) + '\n'),
          mediaType: 'application/json; charset=utf-8', description: 'Public redacted bounded process output.'
        });
      } catch (error) { record.diagnostic = appendDiagnostic(record.diagnostic, `Public output storage failed: ${errorMessage(error)}`); }
      return Object.freeze({ ...(publicArtifact ? { publicArtifact } : {}), ...(protectedArtifact ? { protectedArtifact } : {}) });
    })();
    return record.artifactPromise;
  }

  private expire(processId: string): void {
    const record = this.completed.get(processId);
    if (!record?.terminalReported) return;
    this.completed.delete(processId);
    this.reservedCapturedBytes = Math.max(0, this.reservedCapturedBytes - this.options.maxCapturedBytes);
    if (record.retention) clearTimeout(record.retention);
  }

  private pruneExpired(): void { /* retention timers own expiry */ }
  private requirePtyFactory(): PtyProcessFactory { if (!this.options.ptyFactory) throw new Error('PTY mode is not available on this host.'); return this.options.ptyFactory; }
  private requireProcess(id: string): ManagedProcess { const record = this.active.get(id) ?? this.completed.get(id); if (!record) throw new Error('Unknown process: ' + id); return record; }
  private requireRunningProcess(id: string): ManagedProcess { const record = this.requireProcess(id); if (record.status !== 'running') throw new Error('Process is not running: ' + id); return record; }
  private assertOwner(record: ManagedProcess, requester?: ProcessOwner): void { if (requester && requester.runId !== record.owner.runId) throw new Error('Process belongs to another run: ' + record.id); }

  private waitForActivity(record: ManagedProcess, yieldMs: number, afterCursor: number): Promise<void> {
    if (yieldMs <= 0 || record.status !== 'running' || record.cursor > afterCursor) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); record.activityWaiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, yieldMs);
      record.activityWaiters.add(finish);
    });
  }

  private signalActivity(record: ManagedProcess): void { for (const waiter of [...record.activityWaiters]) waiter(); }

  private runningLedgerEntry(record: ManagedProcess, osPid: number): ProcessLedgerEntry {
    return {
      schemaVersion: 1, processId: record.id, osPid, processGroup: osPid, owner: record.owner,
      startedAt: new Date(record.startedAt).toISOString(), workspace: record.workspace,
      state: 'running', terminalReported: false
    };
  }

  private async reconcileLedger(): Promise<ProcessReconciliationResult> {
    if (!this.options.ledgerDirectory) return Object.freeze({ resolved: [], unresolved: [] });
    await mkdir(this.options.ledgerDirectory, { recursive: true, mode: 0o700 });
    const resolved: string[] = [];
    const unresolved: { processId: string; diagnostic: string }[] = [];
    for (const name of await readdir(this.options.ledgerDirectory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = parseLedgerEntry(JSON.parse(await readFile(path.join(this.options.ledgerDirectory, name), 'utf8')));
        if (entry.state === 'terminal' && entry.terminal && !entry.terminalReported) {
          this.recovered.set(entry.processId, Object.freeze({ result: entry.terminal, ...(entry.protectedArtifact ? { protectedArtifact: entry.protectedArtifact } : {}) }));
          resolved.push(entry.processId);
          continue;
        }
        const exists = processTreeExists(entry.processGroup);
        if (exists) await stopExistingProcessTree(entry.processGroup);
        if (processTreeExists(entry.processGroup)) {
          unresolved.push({ processId: entry.processId, diagnostic: `Process tree ${String(entry.processGroup)} remains active after reconciliation.` });
          continue;
        }
        const result = orphanTerminalResult(entry, exists);
        await this.persistLedger({ ...entry, state: 'terminal', terminalReported: false, terminal: result });
        this.recovered.set(entry.processId, Object.freeze({ result }));
        resolved.push(entry.processId);
      } catch (error) {
        unresolved.push({ processId: name.slice(0, -5), diagnostic: errorMessage(error) });
      }
    }
    return Object.freeze({ resolved: Object.freeze(resolved), unresolved: Object.freeze(unresolved) });
  }

  private async persistLedger(entry: ProcessLedgerEntry): Promise<void> {
    if (!this.options.ledgerDirectory) return;
    await mkdir(this.options.ledgerDirectory, { recursive: true, mode: 0o700 });
    const target = this.ledgerPath(entry.processId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, target);
  }

  private async removeLedger(processId: string): Promise<void> {
    if (!this.options.ledgerDirectory) return;
    await rm(this.ledgerPath(processId), { force: true });
  }

  private ledgerPath(processId: string): string {
    if (!this.options.ledgerDirectory || !/^proc_[a-f0-9-]+$/u.test(processId)) throw new Error('Invalid process ledger identity.');
    return path.join(this.options.ledgerDirectory, `${processId}.json`);
  }
}

export function isProcessManager(value: unknown): value is ProcessManager { return value instanceof ProcessManager; }

class BoundedCapture {
  private readonly head: CapturedChunk[] = [];
  private readonly tail: CapturedChunk[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  constructor(maxBytes: number, tailBytes: number) { this.tailLimit = Math.min(tailBytes, Math.floor(maxBytes / 2)); this.headLimit = maxBytes - this.tailLimit; }
  append(chunk: CapturedChunk): void {
    let text = chunk.text;
    if (this.headBytes < this.headLimit) {
      const selected = takeUtf8Start(text, this.headLimit - this.headBytes);
      if (selected.length > 0) {
        const bytes = Buffer.byteLength(selected, 'utf8');
        this.head.push({ ...chunk, text: selected, bytes, end: chunk.start + bytes });
        this.headBytes += bytes;
        text = text.slice(selected.length);
      }
    }
    if (text.length > 0 && this.tailLimit > 0) {
      const bytes = Buffer.byteLength(text, 'utf8');
      this.tail.push({ ...chunk, text, bytes, start: chunk.end - bytes });
      this.tailBytes += bytes;
      while (this.tailBytes > this.tailLimit && this.tail.length > 0) {
        const first = this.tail[0];
        if (!first) break;
        const keep = takeUtf8End(first.text, Math.max(0, first.bytes - (this.tailBytes - this.tailLimit)));
        if (keep.length === 0) { this.tail.shift(); this.tailBytes -= first.bytes; }
        else {
          const keptBytes = Buffer.byteLength(keep, 'utf8');
          this.tail[0] = { ...first, text: keep, bytes: keptBytes, start: first.end - keptBytes };
          this.tailBytes -= first.bytes - keptBytes;
        }
      }
    }
  }
  get retainedBytes(): number { return this.headBytes + this.tailBytes; }
  chunks(): readonly CapturedChunk[] { return [...this.head, ...this.tail]; }
}

function view(chunks: readonly CapturedChunk[], maxBytes: number, afterCursor: number, cursorEnd: number, oldestCursor: number, observedOverride?: number): ProcessOutputView {
  const sliced = chunks.flatMap((chunk) => {
    if (chunk.start >= afterCursor) return [chunk];
    const skip = Math.max(0, afterCursor - chunk.start);
    const text = dropUtf8Bytes(chunk.text, skip);
    const bytes = Buffer.byteLength(text, 'utf8');
    return text.length > 0 ? [{ ...chunk, text, bytes, start: chunk.end - bytes }] : [];
  });
  const observedBytes = observedOverride ?? sliced.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const joined = sliced.map((chunk) => chunk.text).join('');
  const headBytes = Math.max(0, maxBytes - Math.floor(maxBytes / 3));
  const head = takeUtf8Start(joined, headBytes);
  const headSize = Buffer.byteLength(head, 'utf8');
  const text = observedBytes <= maxBytes ? joined : head + takeUtf8End(joined.slice(head.length), Math.max(0, maxBytes - headSize));
  const capturedBytes = Buffer.byteLength(text, 'utf8');
  return Object.freeze({
    text, observedBytes, capturedBytes, omittedBytes: Math.max(0, observedBytes - capturedBytes),
    startsAtOutputStart: afterCursor === 0 && oldestCursor === 0,
    endsAtOutputEnd: (sliced.at(-1)?.end ?? afterCursor) === cursorEnd
  });
}

function takeUtf8Start(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0; let high = value.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle; else high = middle - 1; }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? '')) low -= 1;
  return value.slice(0, low);
}
function takeUtf8End(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0; let high = value.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (Buffer.byteLength(value.slice(middle), 'utf8') <= maxBytes) high = middle; else low = middle + 1; }
  if (/[\uDC00-\uDFFF]/u.test(value[low] ?? '')) low += 1;
  return value.slice(low);
}
function dropUtf8Bytes(value: string, bytes: number): string {
  if (bytes <= 0) return value;
  let consumed = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    if (code === undefined) return '';
    const character = String.fromCodePoint(code);
    const size = Buffer.byteLength(character, 'utf8');
    if (consumed + size > bytes) return value.slice(index);
    consumed += size;
    index += character.length;
    if (consumed === bytes) return value.slice(index);
  }
  return '';
}

function terminalProgress(record: ManagedProcess): ToolProgress {
  const stage = record.status === 'timed_out' ? 'process_timed_out' : record.status === 'failed' ? 'process_failed' : record.status === 'stopped' ? 'process_stopped' : 'process_exited';
  return { type: 'status', stage, message: `Process ${record.id} ${record.status}.` };
}
function orphanTerminalResult(entry: ProcessLedgerEntry, stopped: boolean): ProcessPollResult {
  const stream = Object.freeze({ text: '', observedBytes: 0, capturedBytes: 0, omittedBytes: 0, startsAtOutputStart: true, endsAtOutputEnd: true });
  return Object.freeze({
    processId: entry.processId, owner: entry.owner, status: stopped ? 'stopped' : 'failed', cursorStart: 0, cursorEnd: 0,
    stdout: stream, stderr: stream, combined: stream,
    diagnostic: stopped ? 'An orphaned process tree was stopped during startup reconciliation.' : 'The recorded process tree was no longer running; its terminal status could not be recovered.'
  });
}
function parseLedgerEntry(value: unknown): ProcessLedgerEntry {
  const owned = parseJsonObject(value);
  if (owned.schemaVersion !== 1 || typeof owned.processId !== 'string' || !/^proc_[a-f0-9-]+$/u.test(owned.processId)
    || typeof owned.osPid !== 'number' || !Number.isSafeInteger(owned.osPid) || owned.osPid <= 0
    || typeof owned.processGroup !== 'number' || !Number.isSafeInteger(owned.processGroup) || owned.processGroup <= 0
    || typeof owned.startedAt !== 'string' || typeof owned.workspace !== 'string'
    || (owned.state !== 'running' && owned.state !== 'terminal') || typeof owned.terminalReported !== 'boolean') throw new Error('Invalid process ledger record.');
  const owner = owned.owner;
  if (typeof owner !== 'object' || owner === null || Array.isArray(owner)
    || typeof owner.runId !== 'string' || typeof owner.turnId !== 'string' || typeof owner.toolBatchId !== 'string'
    || typeof owner.callIndex !== 'number' || !Number.isSafeInteger(owner.callIndex) || owner.callIndex < 0) throw new Error('Invalid process ledger owner.');
  return owned as unknown as ProcessLedgerEntry;
}
function requirePid(tree: OwnedProcessTree): number { const pid = tree.child.pid; if (pid === undefined || pid <= 0) throw new Error('Process PID is unavailable.'); return pid; }
function appendDiagnostic(existing: string | undefined, next: string): string { return existing ? `${existing} ${next}` : next; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error(label + ' must be positive.'); return value; }
