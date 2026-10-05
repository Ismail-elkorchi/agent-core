import { parseJsonObject } from '@agent-core/json';
import {
  redactTextPreservingLength,
  type ArtifactRepository,
  type ProtectedArtifactRef,
  type PublicArtifactRef
} from '@agent-core/persistence';
import {
  ResourceLeaseCoordinator,
  CommandProcessOperationRejectedError,
  adoptCommandExecution,
  createCommandExecutionReservation,
  createCommandOutputView,
  ownCommandExecutionRequest,
  type CommandExecution,
  type CommandExecutionDescriptor,
  type CommandExecutionOwner,
  type CommandExecutionPlanRequest,
  type CommandExecutionReport,
  type CommandExecutionReservation,
  type CommandExecutionResult,
  type CommandExecutionStatus,
  type CommandProcess,
  type CommandStartResult,
  type CommandOutputStream,
  type CommandOutputView,
  type CommandReconciliationResult,
  type CommandUncertaintyAcceptance,
  type StartCommandExecutionOptions,
  type ToolProgress,
  type ToolResourceLease
} from '@agent-core/tools';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  createProcessSupervisorIdentity,
  sendSupervisorCommand,
  spawnSupervisedProcess,
  verifySupervisorTerminalState,
  type ProcessSupervisorIdentity,
  type SupervisedProcessTree,
  type SupervisorTerminalState
} from './process-supervision.js';
import type { OwnedProcessTree } from './process-tree.js';
import {
  parseLedgerEntry,
  parseTerminalRecord,
  terminalRecordReport,
  type ProcessLedgerEntry,
  type ProcessTerminalRecord
} from './process-records.js';
import { processScope } from './resources.js';
import { isRootedFileAuthority, type RootedFileAuthority } from './rooted-file-authority.js';

export interface LocalCommandExecutionOptions {
  readonly artifactRepository: ArtifactRepository;
  readonly rootedFileAuthority: RootedFileAuthority;
  readonly maxCapturedBytes: number;
  readonly tailBytes: number;
  readonly ledgerDirectory?: string;
  readonly maxActiveProcessesPerOwner?: number;
  readonly maxActiveProcesses?: number;
  readonly maxTotalCapturedBytes?: number;
  readonly maxProcessLifetimeMs?: number;
  readonly completedRetentionMs?: number;
  readonly maxPendingOutputBytes?: number;
  /** Resolve only after the original owner's terminal report is durably committed. */
  readonly commitTerminalReport?: (report: CommandExecutionReport) => Promise<void>;
  readonly supervisorReleaseTimeoutMs?: number;
  readonly onSupervisorCheckpoint?: (
    checkpoint: 'supervisor_ready' | 'ledger_persisted' | 'released',
    processId: string
  ) => void | Promise<void>;
  readonly removeLedgerRecord?: (filePath: string) => Promise<void>;
}
type LocalOutputStream = Exclude<CommandOutputStream, 'terminal'>;
interface CapturedChunk {
  readonly sequence: number;
  readonly stream: LocalOutputStream;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly bytes: number;
  readonly streamStart: number;
}
interface QueuedProgress {
  readonly progress: ToolProgress;
  readonly bytes: number;
  readonly delivered: () => void;
}
interface ManagedProcess {
  readonly id: string;
  readonly command: string;
  readonly owner: CommandExecutionOwner;
  readonly rootPath: string;
  readonly tree: SupervisedProcessTree;
  readonly startedAt: number;
  readonly deadline: number;
  readonly capture: BoundedCapture;
  readonly history: CapturedChunk[];
  readonly decoder: { readonly stdout: StringDecoder; readonly stderr: StringDecoder };
  readonly activityWaiters: Set<() => void>;
  readonly onProgress?: StartCommandExecutionOptions['onProgress'];
  readonly lease?: ToolResourceLease;
  readonly progressQueue: QueuedProgress[];
  status: CommandExecutionStatus;
  cursor: number;
  oldestCursor: number;
  sequence: number;
  historyBytes: number;
  progressBytes: number;
  progressDelivering: boolean;
  progressClosed: boolean;
  progressDrainPromise?: Promise<void>;
  progressStarted: boolean;
  progressDroppedEvents: number;
  progressDeliveryErrors: number;
  terminalReported: boolean;
  terminalStatus?: Exclude<CommandExecutionStatus, 'running'>;
  readonly observed: { stdout: number; stderr: number };
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  diagnostic?: string;
  timeout?: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  artifactPromise?: Promise<ProcessArtifacts>;
  finishPromise?: Promise<CommandExecutionReport>;
  startupComplete: boolean;
  startupFailed: boolean;
  pendingClose?: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };
}
interface ProcessArtifacts {
  readonly publicArtifact?: PublicArtifactRef;
  readonly protectedArtifact?: ProtectedArtifactRef;
}
class LocalCommandReservationState {
  readonly authorization;
  #state: 'plan' | 'started' | 'released' = 'plan';

  constructor(
    readonly authority: LocalCommandExecution,
    readonly request: CommandExecutionPlanRequest,
    private readonly directory: Awaited<ReturnType<RootedFileAuthority['commandDirectory']>>
  ) {
    this.authorization = Object.freeze({
      authority: authority.descriptor.implementationId,
      recoveryIdentity: authority.descriptor.recoveryIdentity,
      executionTarget: 'host',
      isolation: 'none',
      directoryIdentity: directory.identity
    });
  }

  start(): { readonly request: CommandExecutionPlanRequest; readonly path: string } {
    if (this.#state !== 'plan') throw new Error('Local command reservation is single-use.');
    this.#state = 'started';
    return { request: this.request, path: this.directory.path };
  }

  async release(): Promise<void> {
    if (this.#state === 'released') return;
    this.#state = 'released';
    await this.directory.close();
  }
}

export class LocalCommandExecution implements CommandExecution {
  readonly descriptor: CommandExecutionDescriptor;
  readonly resourceLeases = new ResourceLeaseCoordinator();
  private readonly active = new Map<string, ManagedProcess>();
  private readonly completed = new Map<string, ManagedProcess>();
  private readonly terminalRecords = new Map<string, ProcessTerminalRecord>();
  private readonly recovered = new Map<string, CommandExecutionReport>();
  private readonly recoveredEntries = new Map<string, ProcessLedgerEntry>();
  private readonly cleanupResidues = new Map<string, string>();
  private readonly limits: Required<
    Pick<
      LocalCommandExecutionOptions,
      | 'maxActiveProcessesPerOwner'
      | 'maxActiveProcesses'
      | 'maxTotalCapturedBytes'
      | 'maxProcessLifetimeMs'
      | 'completedRetentionMs'
      | 'maxPendingOutputBytes'
    >
  >;
  private readonly ready: Promise<void>;
  private reconciliation: CommandReconciliationResult = Object.freeze({ resolved: [], unresolved: [] });
  private reconciliationWork: Promise<void> = Promise.resolve();
  private reservedCapturedBytes = 0;
  private readonly reservations = new WeakMap<
    CommandExecutionReservation,
    LocalCommandReservationState
  >();

  constructor(private readonly options: LocalCommandExecutionOptions) {
    if (!isRootedFileAuthority(options.rootedFileAuthority))
      throw new TypeError('Local command execution requires an adopted RootedFileAuthority.');
    this.descriptor = Object.freeze({
      implementationId: 'agent-core.local-command-execution@1',
      recoveryIdentity: recoveryIdentity(options.ledgerDirectory, options.rootedFileAuthority),
      capabilities: Object.freeze(['process']),
      supportsPty: false
    });
    this.limits = {
      maxActiveProcessesPerOwner: positive(
        options.maxActiveProcessesPerOwner ?? 8,
        'maxActiveProcessesPerOwner'
      ),
      maxActiveProcesses: positive(options.maxActiveProcesses ?? 32, 'maxActiveProcesses'),
      maxTotalCapturedBytes: positive(
        options.maxTotalCapturedBytes ??
          Math.max(options.maxCapturedBytes, options.maxCapturedBytes * 8),
        'maxTotalCapturedBytes'
      ),
      maxProcessLifetimeMs: positive(
        options.maxProcessLifetimeMs ?? 3_600_000,
        'maxProcessLifetimeMs'
      ),
      completedRetentionMs: positive(
        options.completedRetentionMs ?? 60_000,
        'completedRetentionMs'
      ),
      maxPendingOutputBytes: positive(
        options.maxPendingOutputBytes ?? Math.min(options.maxCapturedBytes, 2_000_000),
        'maxPendingOutputBytes'
      )
    };
    this.ready = this.refreshReconciliation().then(() => undefined);
    adoptCommandExecution(this);
  }

  async plan(request: CommandExecutionPlanRequest): Promise<CommandExecutionReservation> {
    request = ownCommandExecutionRequest(request);
    const commandDirectory = await this.options.rootedFileAuthority.commandDirectory(
      request.rootedDirectory
    );
    const owned = new LocalCommandReservationState(this, request, commandDirectory);
    const reservation = createCommandExecutionReservation(owned.authorization, () =>
      owned.release()
    );
    this.reservations.set(reservation, owned);
    return reservation;
  }

  async start(
    reservation: CommandExecutionReservation,
    options: StartCommandExecutionOptions = {}
  ): Promise<CommandStartResult> {
    const owned = this.reservations.get(reservation);
    if (owned?.authority !== this)
      throw new TypeError('Command reservation does not belong to the local command authority.');
    const adopted = owned.start();
    try {
      return await this.startInDirectory(adopted.request, options, adopted.path);
    } finally {
      await owned.release();
    }
  }

  private async startInDirectory(
    request: CommandExecutionPlanRequest,
    options: StartCommandExecutionOptions,
    workingDirectory: string
  ): Promise<CommandStartResult> {
    await this.ready;
    if (this.reconciliation.unresolved.length > 0)
      return { kind: 'not_started', diagnostic: 'Process lifetime is unresolved for this command authority. Inspect Processes and reconcile the blocking records before starting a command.' };
    if (this.active.size >= this.limits.maxActiveProcesses)
      return { kind: 'not_started', diagnostic: 'Maximum active process count reached.' };
    if (
      [...this.active.values()].filter((item) => item.owner.ownerId === request.owner.ownerId)
        .length >= this.limits.maxActiveProcessesPerOwner
    )
      return { kind: 'not_started', diagnostic: 'Maximum active process count for this resource owner reached.' };
    if (
      this.reservedCapturedBytes + this.options.maxCapturedBytes >
      this.limits.maxTotalCapturedBytes
    )
      return { kind: 'not_started', diagnostic: 'Maximum total captured process bytes reached.' };
    if (request.pty)
      return { kind: 'not_started', diagnostic: 'PTY mode is unavailable for local supervised commands.' };
    const id = 'proc_' + randomUUID();
    const supervisorDirectory =
      this.options.ledgerDirectory ?? path.join(tmpdir(), 'agent-core-process-supervisors');
    const supervision = createProcessSupervisorIdentity(id, supervisorDirectory, request.owner);
    await this.persistSupervisorAuthentication(id, supervision);
    const tree = spawnSupervisedProcess({
      command: request.command,
      cwd: workingDirectory,
      supervision,
      ...(this.options.supervisorReleaseTimeoutMs
        ? {
            releaseTimeoutMs: positive(
              this.options.supervisorReleaseTimeoutMs,
              'supervisorReleaseTimeoutMs'
            )
          }
        : {})
    });
    const startedAt = Date.now();
    const record: ManagedProcess = {
      id,
      command: request.command,
      owner: request.owner,
      rootPath: this.options.rootedFileAuthority.identity.canonicalPath,
      tree,
      startedAt,
      deadline: startedAt + Math.min(request.timeoutMs, this.limits.maxProcessLifetimeMs),
      capture: new BoundedCapture(this.options.maxCapturedBytes, this.options.tailBytes),
      history: [],
      decoder: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      activityWaiters: new Set(),
      progressQueue: [],
      status: 'running',
      cursor: 0,
      oldestCursor: 0,
      sequence: 0,
      historyBytes: 0,
      progressBytes: 0,
      progressDelivering: false,
      progressClosed: false,
      progressStarted: false,
      progressDroppedEvents: 0,
      progressDeliveryErrors: 0,
      terminalReported: false,
      observed: { stdout: 0, stderr: 0 },
      startupComplete: false,
      startupFailed: false,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.lease ? { lease: options.lease } : {})
    };
    this.active.set(id, record);
    this.reservedCapturedBytes += this.options.maxCapturedBytes;
    tree.child.stdout.on('data', (value: Buffer | string) => {
      this.decodeAndAppend(record, 'stdout', value);
    });
    tree.child.stderr.on('data', (value: Buffer | string) => {
      this.decodeAndAppend(record, 'stderr', value);
    });
    tree.child.once('error', (error) => {
      record.terminalStatus ??= 'failed';
      record.diagnostic = error.message;
      this.signalActivity(record);
    });
    tree.child.once('close', (exitCode, signal) => {
      if (!record.startupComplete) {
        record.pendingClose = { exitCode, signal: signal ?? null };
        return;
      }
      if (!record.startupFailed) this.handleClose(record, exitCode, signal ?? null);
    });
    try {
      await tree.started;
      const osPid = tree.child.pid;
      if (osPid === undefined || osPid <= 0)
        throw new Error('The process host did not provide an operating-system process ID.');
      await this.options.onSupervisorCheckpoint?.('supervisor_ready', id);
      await this.persistLedger(this.runningLedgerEntry(record, osPid));
      await this.options.onSupervisorCheckpoint?.('ledger_persisted', id);
      await tree.release();
      await this.options.onSupervisorCheckpoint?.('released', id);
      record.startupComplete = true;
    } catch (error) {
      record.startupComplete = true;
      record.startupFailed = true;
      this.active.delete(id);
      this.reservedCapturedBytes -= this.options.maxCapturedBytes;
      tree.stop('SIGKILL');
      await tree.settle();
      await this.removeSupervisorFiles(id);
      throw error;
    }
    void this.enqueueProgress(record, {
      type: 'status',
      stage: 'process_started',
      message: `Process ${id} started.`
    });
    record.progressStarted = true;
    for (const chunk of record.history)
      void this.enqueueProgress(record, {
        type: 'output',
        stream: chunk.stream,
        sequence: chunk.sequence,
        text: chunk.text,
        observedBytes: chunk.end
      });
    if (record.pendingClose)
      this.handleClose(record, record.pendingClose.exitCode, record.pendingClose.signal);
    if (record.status === 'running') {
      record.timeout = setTimeout(
        () => {
          if (record.status !== 'running') return;
          this.requestTermination(record, 'timed_out');
        },
        Math.max(0, record.deadline - Date.now())
      );
      record.timeout.unref();
    }
    if (options.signal) {
      record.abortSignal = options.signal;
      record.abortListener = () => {
        if (record.status === 'running')
          void this.terminate(id).catch((error: unknown) => {
            record.diagnostic = errorMessage(error);
          });
      };
      options.signal.addEventListener('abort', record.abortListener, { once: true });
      if (options.signal.aborted) record.abortListener();
    }
    if (options.awaitTerminal) {
      await tree.settle();
      await this.finish(record);
      return { kind: 'started', result: await this.query(id, request.outputTokenBudget, 0, 0, request.owner) };
    }
    await this.waitForActivity(record, request.yieldMs, 0);
    if (record.status === 'running' && options.lease)
      options.lease.transferToResource(id, processScope(id));
    return { kind: 'started', result: await this.query(id, request.outputTokenBudget, 0, 0, request.owner) };
  }

  async query(
    processId: string,
    outputTokenBudget: number,
    yieldMs = 0,
    afterCursor = 0,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    if (!Number.isSafeInteger(outputTokenBudget) || outputTokenBudget < 0)
      throw new RangeError('Output budget must be a nonnegative safe integer.');
    await this.ready;
    const managed = this.active.get(processId) ?? this.completed.get(processId);
    if (!managed) {
      const terminal = await this.readTerminalRecord(processId);
      if (terminal) {
        this.assertOwner(terminal, requester);
        return terminalRecordReport(terminal, afterCursor).result;
      }
      const recovered = this.recovered.get(processId);
      if (recovered) {
        this.assertOwner(recovered.result, requester);
        return recovered.result;
      }
    }
    const record = this.requireProcess(processId);
    this.assertOwner(record, requester);
    if (record.status !== 'running' && record.progressClosed) await record.progressDrainPromise;
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > record.cursor)
      throw new CommandProcessOperationRejectedError(processId, 'invalid_cursor');
    if (record.status === 'running' && record.cursor === afterCursor && yieldMs > 0)
      await this.waitForActivity(record, yieldMs, afterCursor);
    const cursorExpired = afterCursor < record.oldestCursor;
    const useCapture = cursorExpired && afterCursor === 0;
    const effectiveCursor = useCapture ? 0 : cursorExpired ? record.oldestCursor : afterCursor;
    const budgetBytes = outputTokenBudget * 4;
    const available = useCapture
      ? record.capture.chunks()
      : record.history.filter((chunk) => chunk.end > effectiveCursor);
    const stdout = view(available, Math.floor(budgetBytes / 4), effectiveCursor,
      record.observed.stdout, 'stdout');
    const stderr = view(available, Math.floor(budgetBytes / 4), effectiveCursor,
      record.observed.stderr, 'stderr');
    const combined = view(available, Math.floor(budgetBytes / 2), effectiveCursor,
      record.cursor);
    const artifacts = record.status === 'running' ? undefined : await this.finalArtifacts(record);
    return Object.freeze({
      processId,
      owner: record.owner,
      status: record.status,
      ...(record.status === 'running' ? { deadline: new Date(record.deadline).toISOString() } : {}),
      cursorStart: effectiveCursor,
      cursorEnd: record.cursor,
      ...(cursorExpired ? { cursorExpired: true } : {}),
      stdout,
      stderr,
      combined,
      ...(artifacts?.publicArtifact ? { artifact: artifacts.publicArtifact } : {}),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }),
      ...(record.progressDroppedEvents > 0
        ? { progressDroppedEvents: record.progressDroppedEvents }
        : {}),
      ...(record.progressDeliveryErrors > 0
        ? { progressDeliveryErrors: record.progressDeliveryErrors }
        : {})
    });
  }

  async writeInput(
    processId: string,
    text: string,
    requester?: CommandExecutionOwner
  ): Promise<void> {
    await this.ready;
    const record = await this.requireRunningProcess(processId, requester);
    await new Promise<void>((resolve, reject) =>
      record.tree.child.stdin.write(text, (error) => {
        if (error) reject(error);
        else resolve();
      })
    );
  }

  async closeInput(processId: string, requester?: CommandExecutionOwner): Promise<void> {
    await this.ready;
    if (!this.active.has(processId) && !this.completed.has(processId)) {
      await this.query(processId, 0, 0, 0, requester);
      return;
    }
    const record = this.requireProcess(processId);
    this.assertOwner(record, requester);
    if (record.status !== 'running' || record.tree.child.stdin.writableEnded) return;
    await new Promise<void>((resolve, reject) =>
      record.tree.child.stdin.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      })
    );
  }

  async terminate(
    processId: string,
    requester?: CommandExecutionOwner
  ): Promise<CommandExecutionResult> {
    await this.ready;
    if (!this.active.has(processId) && !this.completed.has(processId))
      return this.query(processId, 4_000, 0, 0, requester);
    const record = this.requireProcess(processId);
    this.assertOwner(record, requester);
    if (record.status === 'running') {
      if (record.terminalStatus === undefined)
        void this.enqueueProgress(record, {
          type: 'status',
          stage: 'process_stopping',
          message: `Stopping process ${processId}.`
        });
      this.requestTermination(record, 'stopped');
    }
    await record.tree.settle();
    await this.finish(record);
    return this.query(processId, 4_000, 0, 0, requester);
  }

  /** Stop active owned processes and return every terminal process not yet durably reported. */
  async disposeOwner(ownerId: string): Promise<readonly CommandExecutionReport[]> {
    await this.ready;
    const active = [...this.active.values()].filter((record) => record.owner.ownerId === ownerId);
    for (const record of active) await this.terminate(record.id);
    return this.unreportedTerminalProcesses(ownerId);
  }

  async unreportedTerminalProcesses(ownerId: string): Promise<readonly CommandExecutionReport[]> {
    await this.ready;
    const reports: CommandExecutionReport[] = [];
    for (const record of this.completed.values()) {
      if (record.owner.ownerId !== ownerId || record.terminalReported) continue;
      reports.push(await this.finish(record));
    }
    for (const report of this.recovered.values())
      if (report.result.owner.ownerId === ownerId) reports.push(report);
    return Object.freeze(
      reports.sort((left, right) => left.result.processId.localeCompare(right.result.processId))
    );
  }

  recoveredTerminalReports(): readonly CommandExecutionReport[] {
    return Object.freeze(
      [...this.recovered.values()].sort((left, right) =>
        left.result.processId.localeCompare(right.result.processId)
      )
    );
  }

  /** Call only after resource.released persistence succeeds or another durable handoff exists. */
  async acknowledgeTerminalReport(processId: string): Promise<void> {
    await this.ready;
    const record = this.completed.get(processId);
    if (record && !(await this.readTerminalRecord(processId)))
      await this.persistTerminalRecord(record, await this.finalArtifacts(record));
    if (record) record.terminalReported = true;
    try {
      await this.markLedgerTerminalReported(processId);
      await this.removeLedger(processId);
      this.recovered.delete(processId);
      this.recoveredEntries.delete(processId);
      this.cleanupResidues.delete(processId);
    } catch (error) {
      this.cleanupResidues.set(
        processId,
        `Process terminal ledger cleanup residue: ${errorMessage(error)}`
      );
    }
  }

  async reconcile(): Promise<CommandReconciliationResult> {
    await this.ready;
    await this.deliverRecoveredReports();
    return this.reconciliation;
  }
  async retryReconciliation(): Promise<CommandReconciliationResult> {
    await this.ready;
    const result = await this.reconciliationOperation(() => this.refreshReconciliation());
    await this.deliverRecoveredReports();
    return result;
  }
  async acknowledgeUnresolved(acceptances: readonly CommandUncertaintyAcceptance[]): Promise<void> {
    await this.ready;
    await this.reconciliationOperation(async () => {
      const current = await this.refreshReconciliation();
      for (const { processId, revision } of acceptances) {
        const unresolved = current.unresolved.find((item) => item.processId === processId);
        if (unresolved?.revision !== revision)
          throw new Error(`Command evidence changed; refresh before accepting uncertainty: ${processId}`);
      }
      for (const { processId } of acceptances) {
        await this.removeLedger(processId);
        this.resourceLeases.releaseResource(processId);
      }
      const accepted = new Set(acceptances.map(({ processId }) => processId));
      this.reconciliation = Object.freeze({
        resolved: current.resolved,
        unresolved: Object.freeze(current.unresolved.filter(({ processId }) => !accepted.has(processId)))
      });
      await this.refreshReconciliation();
    });
  }
  async close(): Promise<void> {
    await this.ready;
    for (const record of [...this.active.values()]) await this.terminate(record.id);
    for (const processId of [...this.completed.keys()]) await this.expire(processId);
  }
  async listProcesses(): Promise<readonly CommandProcess[]> {
    await this.ready;
    const known: CommandProcess[] = [...this.active.values(), ...this.completed.values()].map((record) =>
      Object.freeze({
        processId: record.id,
        command: record.command,
        revision: createHash('sha256').update(JSON.stringify([
          record.id,
          record.status,
          record.cursor,
          record.exitCode,
          record.signal,
          record.diagnostic
        ])).digest('hex'),
        owner: record.owner,
        status: record.status,
        ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic })
      })
    );
    for (const [id, report] of this.recovered) {
      const entry = this.recoveredEntries.get(id);
      known.push({
        processId: id,
        revision: createHash('sha256').update(JSON.stringify(report.result)).digest('hex'),
        owner: report.result.owner,
        status: report.result.status,
        ...(entry?.command === undefined ? {} : { command: entry.command }),
        ...(entry === undefined ? {} : { rootPath: entry.rootPath }),
        ...(report.result.diagnostic === undefined ? {} : { diagnostic: report.result.diagnostic })
      });
    }
    return Object.freeze([...known, ...this.reconciliation.unresolved.map((item) => ({ ...item, status: 'unknown' as const }))]);
  }
  activeCount(ownerId?: string): number {
    return ownerId === undefined
      ? this.active.size
      : [...this.active.values()].filter((record) => record.owner.ownerId === ownerId).length;
  }
  cleanupDiagnostics(): readonly string[] {
    return Object.freeze([...this.cleanupResidues.values()]);
  }

  private decodeAndAppend(
    record: ManagedProcess,
    stream: LocalOutputStream,
    value: Buffer | string
  ): void {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const text = record.decoder[stream].write(bytes);
    if (text.length > 0) this.append(record, stream, text);
  }

  private requestTermination(
    record: ManagedProcess,
    status: Exclude<CommandExecutionStatus, 'running' | 'exited'>
  ): void {
    if (record.status !== 'running' || record.terminalStatus !== undefined) return;
    record.terminalStatus = status;
    record.tree.stop();
    this.signalActivity(record);
  }

  private handleClose(
    record: ManagedProcess,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    delete record.pendingClose;
    this.flushDecoders(record);
    record.terminalStatus ??= exitCode === null ? 'failed' : 'exited';
    record.exitCode = exitCode;
    record.signal = signal;
    void this.settleAndFinish(record);
  }

  private flushDecoders(record: ManagedProcess): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = record.decoder[stream].end();
      if (text.length > 0) this.append(record, stream, text);
    }
  }

  private append(record: ManagedProcess, stream: LocalOutputStream, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    const streamStart = record.observed[stream];
    record.observed[stream] += bytes;
    const chunk: CapturedChunk = {
      sequence: record.sequence++,
      stream,
      streamStart,
      text,
      start: record.cursor,
      end: record.cursor + bytes,
      bytes
    };
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
    if (record.progressStarted)
      void this.enqueueProgress(record, {
        type: 'output',
        stream,
        sequence: chunk.sequence,
        text,
        observedBytes: record.cursor
      });
    this.signalActivity(record);
  }

  private enqueueProgress(record: ManagedProcess, progress: ToolProgress): Promise<void> {
    if (!record.onProgress) return Promise.resolve();
    if (record.progressClosed) {
      record.progressDroppedEvents += 1;
      return Promise.resolve();
    }
    const bytes = Buffer.byteLength(JSON.stringify(progress), 'utf8');
    if (
      progress.type === 'output' &&
      record.progressBytes + bytes > this.limits.maxPendingOutputBytes
    ) {
      record.progressDroppedEvents += 1;
      return Promise.resolve();
    }
    while (record.progressBytes + bytes > this.limits.maxPendingOutputBytes) {
      const index = record.progressQueue.findIndex((item) => item.progress.type === 'output');
      if (index < 0) break;
      const [removed] = record.progressQueue.splice(index, 1);
      if (removed) {
        record.progressBytes -= removed.bytes;
        record.progressDroppedEvents += 1;
        removed.delivered();
      }
    }
    let delivered: () => void = () => undefined;
    const delivery = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    record.progressQueue.push({ progress, bytes, delivered });
    record.progressBytes += bytes;
    if (!record.progressDelivering) record.progressDrainPromise = this.drainProgress(record);
    return delivery;
  }

  private async drainProgress(record: ManagedProcess): Promise<void> {
    record.progressDelivering = true;
    try {
      while (record.progressQueue.length > 0) {
        const item = record.progressQueue.shift();
        if (!item) continue;
        record.progressBytes -= item.bytes;
        try {
          await record.onProgress?.(item.progress);
        } catch (error) {
          record.progressDeliveryErrors += 1;
          record.diagnostic = appendDiagnostic(
            record.diagnostic,
            `Progress delivery failed: ${errorMessage(error)}`
          );
        } finally {
          item.delivered();
        }
      }
    } finally {
      record.progressDelivering = false;
      if (record.progressQueue.length > 0) record.progressDrainPromise = this.drainProgress(record);
    }
  }

  private async settleAndFinish(record: ManagedProcess): Promise<void> {
    try {
      await record.tree.settle();
      const terminalState = await record.tree.terminalState;
      if (record.terminalStatus !== 'timed_out' && record.terminalStatus !== 'stopped') {
        record.terminalStatus = terminalState?.state ?? 'failed';
      }
    } catch (error) {
      record.diagnostic = appendDiagnostic(
        record.diagnostic,
        `Process settlement failed: ${errorMessage(error)}`
      );
      this.signalActivity(record);
      return;
    }
    try {
      await this.finish(record);
    } catch (error) {
      record.diagnostic = appendDiagnostic(
        record.diagnostic,
        `Process finalization failed: ${errorMessage(error)}`
      );
    }
  }

  private finish(record: ManagedProcess): Promise<CommandExecutionReport> {
    record.finishPromise ??= this.finishOnce(record);
    return record.finishPromise;
  }

  private async finishOnce(record: ManagedProcess): Promise<CommandExecutionReport> {
    const terminalStatus = record.terminalStatus ?? 'failed';
    let terminalDelivery = Promise.resolve();
    if (!record.progressClosed) {
      terminalDelivery = this.enqueueProgress(record, terminalProgress(record, terminalStatus));
      record.progressClosed = true;
    }
    await terminalDelivery;
    if (record.status === 'running') record.status = terminalStatus;
    if (record.timeout) {
      clearTimeout(record.timeout);
      delete record.timeout;
    }
    if (record.abortSignal && record.abortListener)
      record.abortSignal.removeEventListener('abort', record.abortListener);
    delete record.abortSignal;
    delete record.abortListener;
    this.active.delete(record.id);
    this.completed.set(record.id, record);
    record.lease?.release();
    this.signalActivity(record);
    const artifacts = await this.finalArtifacts(record);
    try {
      await this.persistTerminalRecord(record, artifacts);
    } catch (error) {
      record.diagnostic = appendDiagnostic(record.diagnostic, `Process terminal record storage failed: ${errorMessage(error)}`);
    }
    try {
      await this.persistLedger(this.runningLedgerEntry(record, requirePid(record.tree)));
    } catch (error) {
      record.diagnostic = appendDiagnostic(record.diagnostic, `Process terminal metadata storage failed: ${errorMessage(error)}`);
    }
    const result = await this.query(record.id, 4_000);
    const report = Object.freeze({ result,
      ...(artifacts.protectedArtifact === undefined ? {} : { protectedArtifact: artifacts.protectedArtifact })
    });
    await this.handoffTerminalReport(report);
    record.retention ??= setTimeout(() => {
      void this.expire(record.id).catch((error: unknown) => {
        record.diagnostic = appendDiagnostic(
          record.diagnostic,
          `Process retention cleanup failed: ${errorMessage(error)}`
        );
      });
    }, this.limits.completedRetentionMs);
    record.retention.unref();
    return report;
  }

  private async handoffTerminalReport(report: CommandExecutionReport): Promise<void> {
    if (!this.options.commitTerminalReport) return;
    try {
      await this.options.commitTerminalReport(report);
      await this.acknowledgeTerminalReport(report.result.processId);
    } catch (error) {
      this.cleanupResidues.set(report.result.processId, `Process terminal handoff failed: ${errorMessage(error)}`);
    }
  }

  private async deliverRecoveredReports(): Promise<void> {
    for (const report of this.recovered.values()) await this.handoffTerminalReport(report);
  }

  private finalArtifacts(record: ManagedProcess): Promise<ProcessArtifacts> {
    record.artifactPromise ??= (async () => {
      const raw = encodeProcessOutput(record, false);
      let protectedArtifact: ProtectedArtifactRef | undefined;
      let publicArtifact: PublicArtifactRef | undefined;
      try {
        protectedArtifact = await this.options.artifactRepository.storeProtected({
          label: record.id + '-raw-output',
          content: raw,
          mediaType: 'application/json; charset=utf-8',
          description: 'Protected bounded raw process output preserving stdout/stderr order.'
        });
      } catch (error) {
        record.diagnostic = appendDiagnostic(
          record.diagnostic,
          `Protected output storage failed: ${errorMessage(error)}`
        );
      }
      try {
        publicArtifact = await this.options.artifactRepository.store({
          label: record.id + '-output',
          content: encodeProcessOutput(record, true),
          mediaType: 'application/json; charset=utf-8',
          description: 'Public redacted bounded process output.'
        });
      } catch (error) {
        record.diagnostic = appendDiagnostic(
          record.diagnostic,
          `Public output storage failed: ${errorMessage(error)}`
        );
      }
      return Object.freeze({
        ...(publicArtifact ? { publicArtifact } : {}),
        ...(protectedArtifact ? { protectedArtifact } : {})
      });
    })();
    return record.artifactPromise;
  }

  private async expire(processId: string): Promise<void> {
    const record = this.completed.get(processId);
    if (!record) return;
    if (!(await this.readTerminalRecord(processId)))
      await this.persistTerminalRecord(record, await this.finalArtifacts(record));
    const report = record.terminalReported ? undefined : await this.finish(record);
    if (!this.completed.delete(processId)) return;
    if (!record.terminalReported && report)
      this.recovered.set(processId, compactTerminalReport(report));
    this.reservedCapturedBytes -= this.options.maxCapturedBytes;
    if (record.retention) clearTimeout(record.retention);
  }

  private requireProcess(id: string): ManagedProcess {
    const record = this.active.get(id) ?? this.completed.get(id);
    if (!record) throw new CommandProcessOperationRejectedError(id, 'not_found');
    return record;
  }
  private async requireRunningProcess(id: string, requester?: CommandExecutionOwner): Promise<ManagedProcess> {
    if (!this.active.has(id) && !this.completed.has(id)) {
      await this.query(id, 0, 0, 0, requester);
      throw new CommandProcessOperationRejectedError(id, 'not_running');
    }
    const record = this.requireProcess(id);
    this.assertOwner(record, requester);
    if (record.status !== 'running') throw new CommandProcessOperationRejectedError(id, 'not_running');
    return record;
  }
  private assertOwner(record: { readonly owner: CommandExecutionOwner } & ({ readonly id: string } | { readonly processId: string }), requester?: CommandExecutionOwner): void {
    if (requester && requester.ownerId !== record.owner.ownerId)
      throw new CommandProcessOperationRejectedError('processId' in record ? record.processId : record.id, 'wrong_owner');
  }

  private waitForActivity(
    record: ManagedProcess,
    yieldMs: number,
    afterCursor: number
  ): Promise<void> {
    if (yieldMs <= 0 || record.status !== 'running' || record.cursor > afterCursor)
      return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        record.activityWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, yieldMs);
      record.activityWaiters.add(finish);
    });
  }

  private signalActivity(record: ManagedProcess): void {
    for (const waiter of [...record.activityWaiters]) waiter();
  }

  private runningLedgerEntry(record: ManagedProcess, osPid: number): ProcessLedgerEntry {
    return {
      schemaVersion: 1,
      processId: record.id,
      supervisorPid: osPid,
      supervisorIdentity: record.tree.supervision.identity,
      supervisorEndpoint: record.tree.supervision.endpoint,
      owner: record.owner,
      startedAt: new Date(record.startedAt).toISOString(),
      rootPath: record.rootPath,
      command: record.command,
      ...(record.terminalStatus === 'timed_out' || record.terminalStatus === 'stopped' ? { terminationReason: record.terminalStatus } : {}),
      terminalReported: false
    };
  }

  private reconciliationOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.reconciliationWork.then(operation);
    this.reconciliationWork = result.then(() => undefined, () => undefined);
    return result;
  }

  private async refreshReconciliation(): Promise<CommandReconciliationResult> {
    this.reconciliation = await this.reconcileLedger();
    return this.reconciliation;
  }

  private async reconcileLedger(): Promise<CommandReconciliationResult> {
    if (!this.options.ledgerDirectory) return Object.freeze({ resolved: [], unresolved: [] });
    await mkdir(this.options.ledgerDirectory, { recursive: true, mode: 0o700 });
    const resolved: string[] = [];
    const unresolved: CommandReconciliationResult['unresolved'][number][] = [];
    const names = new Set((await readdir(this.options.ledgerDirectory)).filter((name) => /^proc_[a-f0-9-]+\.json$/u.test(name)));
    for (const { processId } of this.reconciliation.unresolved) names.add(`${processId}.json`);
    for (const name of names) {
      const processId = name.slice(0, -5);
      // A retry must never take over an effect already managed by this executor.
      if (this.active.has(processId) || this.completed.has(processId) || this.recovered.has(processId)) continue;
      let source: string | undefined;
      let entry: ProcessLedgerEntry | undefined;
      try {
        source = await readFile(path.join(this.options.ledgerDirectory, name), 'utf8');
        entry = parseLedgerEntry(JSON.parse(source));
        if (entry.processId !== processId) throw new Error('Process record identity does not match its filename.');
        if (entry.rootPath !== this.options.rootedFileAuthority.identity.canonicalPath)
          throw new Error('Process record belongs to another rooted authority.');
        const supervision = await this.readSupervisorAuthentication(entry);
        let terminal = await this.readSupervisorTerminalState(supervision);
        let stopped = false;
        if (!terminal) {
          await sendSupervisorCommand(supervision, 'stop', 3_000);
          stopped = true;
          terminal = await this.waitForSupervisorTerminalState(supervision);
        }
        if (entry.terminalReported) {
          try {
            await this.removeLedger(processId);
            this.cleanupResidues.delete(processId);
          } catch (error) {
            this.cleanupResidues.set(processId, `Process terminal ledger cleanup residue: ${errorMessage(error)}`);
          }
          this.recovered.delete(processId);
          this.recoveredEntries.delete(processId);
        } else {
          const report = this.recovered.get(processId) ?? await this.recoverTerminalReport(entry, terminal, stopped);
          this.recovered.set(processId, report);
          this.recoveredEntries.set(processId, entry);
        }
        this.resourceLeases.releaseResource(processId);
        resolved.push(processId);
      } catch (error) {
        const diagnostic = errorMessage(error);
        unresolved.push(Object.freeze({
          processId,
          revision: createHash('sha256').update(JSON.stringify([source, diagnostic])).digest('hex'),
          rootPath: entry?.rootPath ?? '*',
          diagnostic,
          ...(entry === undefined ? {} : { owner: entry.owner }),
          ...(entry?.command === undefined ? {} : { command: entry.command })
        }));
        this.recovered.delete(processId);
        this.recoveredEntries.delete(processId);
        this.resourceLeases.restoreResource(processId, {
          accesses: [{ mode: 'execute', scope: processScope() }],
          lockScopes: ['files'],
          recovery: { kind: 'unknown' }
        }, processScope(processId));
        this.resourceLeases.failResource(processId, new Error(`Process lifetime needs reconciliation: ${diagnostic}`));
      }
    }
    return Object.freeze({ resolved: Object.freeze(resolved), unresolved: Object.freeze(unresolved) });
  }

  private async recoverTerminalReport(
    entry: ProcessLedgerEntry,
    terminal: SupervisorTerminalState,
    stopped: boolean
  ): Promise<CommandExecutionReport> {
    let receipt: ProcessTerminalRecord | undefined;
    let outputDiagnostic: string | undefined;
    try {
      receipt = await this.readTerminalRecord(entry.processId);
      if (!receipt) outputDiagnostic = 'Original process output has no retained terminal record.';
    } catch (error) {
      outputDiagnostic = nodeCode(error) === 'ENOENT'
        ? 'Original process output has no retained receipt.'
        : `Original process output receipt is incompatible or unreadable: ${errorMessage(error)}`;
    }
    if (receipt && (
      receipt.processId !== entry.processId || receipt.rootPath !== entry.rootPath ||
      JSON.stringify(receipt.owner) !== JSON.stringify(entry.owner) ||
      receipt.exitCode !== terminal.exitCode || receipt.signal !== terminal.signal
    )) throw new Error('Process terminal record does not match its authenticated supervisor.');
    const report = Object.freeze({
      result: recoveredTerminalResult(entry, terminal, stopped, receipt, outputDiagnostic),
      ...(receipt?.protectedArtifact === undefined ? {} : { protectedArtifact: receipt.protectedArtifact })
    });
    if (!receipt) await this.storeTerminalRecord(
      terminalRecordFromReport(report, entry.rootPath, this.descriptor.recoveryIdentity)
    );
    return report;
  }

  private terminalRecordPath(processId: string): string {
    return this.ledgerPath(processId).replace(/\.json$/u, '.terminal.json');
  }

  private async readTerminalRecord(processId: string): Promise<ProcessTerminalRecord | undefined> {
    if (!/^proc_[a-f0-9-]+$/u.test(processId))
      throw new CommandProcessOperationRejectedError(processId, 'not_found');
    if (!this.options.ledgerDirectory) return this.terminalRecords.get(processId);
    let source: string;
    try {
      source = await readFile(this.terminalRecordPath(processId), 'utf8');
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return undefined;
      throw new CommandProcessOperationRejectedError(processId, 'evidence_unavailable', { cause: error });
    }
    try {
      const terminal = parseTerminalRecord(JSON.parse(source));
      if (terminal.processId !== processId ||
          terminal.rootPath !== this.options.rootedFileAuthority.identity.canonicalPath ||
          terminal.executionTargetId !== this.descriptor.recoveryIdentity)
        throw new Error('Process terminal record belongs to another execution authority.');
      return terminal;
    } catch (cause) {
      throw new CommandProcessOperationRejectedError(processId, 'evidence_unavailable', { cause });
    }
  }

  private async storeTerminalRecord(record: ProcessTerminalRecord): Promise<void> {
    if (this.options.ledgerDirectory)
      await this.persistJsonRecord(this.terminalRecordPath(record.processId), record);
    else this.terminalRecords.set(record.processId, record);
  }

  private async persistTerminalRecord(record: ManagedProcess, artifacts: ProcessArtifacts): Promise<void> {
    const chunks = record.capture.chunks();
    const captured = (stream: LocalOutputStream) => chunks.filter((chunk) => chunk.stream === stream).reduce((sum, chunk) => sum + chunk.bytes, 0);
    const receipt: ProcessTerminalRecord = {
      schemaVersion: 1,
      processId: record.id,
      rootPath: record.rootPath,
      executionTargetId: this.descriptor.recoveryIdentity,
      owner: record.owner,
      status: record.terminalStatus ?? 'failed',
      exitCode: record.exitCode ?? null,
      signal: record.signal ?? null,
      cursorEnd: record.cursor,
      stdout: { observedBytes: record.observed.stdout, capturedBytes: captured('stdout') },
      stderr: { observedBytes: record.observed.stderr, capturedBytes: captured('stderr') },
      combined: { observedBytes: record.cursor, capturedBytes: record.capture.retainedBytes },
      ...(artifacts.publicArtifact === undefined ? {} : { artifact: artifacts.publicArtifact }),
      ...(artifacts.protectedArtifact === undefined ? {} : { protectedArtifact: artifacts.protectedArtifact }),
      ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic })
    };
    await this.storeTerminalRecord(receipt);
  }

  private async persistJsonRecord(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }

  private async persistLedger(entry: ProcessLedgerEntry): Promise<void> {
    if (this.options.ledgerDirectory) await this.persistJsonRecord(this.ledgerPath(entry.processId), entry);
  }

  private async removeLedger(processId: string): Promise<void> {
    if (!this.options.ledgerDirectory) return;
    const ledgerPath = this.ledgerPath(processId);
    if (this.options.removeLedgerRecord) await this.options.removeLedgerRecord(ledgerPath);
    else await rm(ledgerPath, { force: true });
    await this.removeSupervisorFiles(processId);
  }

  private ledgerPath(processId: string): string {
    if (!this.options.ledgerDirectory || !/^proc_[a-f0-9-]+$/u.test(processId))
      throw new Error('Invalid process ledger identity.');
    return path.join(this.options.ledgerDirectory, `${processId}.json`);
  }

  private async persistSupervisorAuthentication(
    processId: string,
    supervision: ProcessSupervisorIdentity
  ): Promise<void> {
    if (this.options.ledgerDirectory)
      await this.persistJsonRecord(this.supervisorAuthenticationPath(processId), {
        identity: supervision.identity,
        token: supervision.authenticationToken
      });
  }

  private async markLedgerTerminalReported(processId: string): Promise<void> {
    if (!this.options.ledgerDirectory) return;
    let entry: ProcessLedgerEntry;
    try {
      entry = parseLedgerEntry(JSON.parse(await readFile(this.ledgerPath(processId), 'utf8')));
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }
    if (!entry.terminalReported) await this.persistLedger({ ...entry, terminalReported: true });
  }

  private async readSupervisorAuthentication(
    entry: ProcessLedgerEntry
  ): Promise<ProcessSupervisorIdentity> {
    if (!this.options.ledgerDirectory)
      throw new Error('Process supervisor authentication storage is unavailable.');
    const owned = parseJsonObject(
      JSON.parse(await readFile(this.supervisorAuthenticationPath(entry.processId), 'utf8'))
    );
    if (
      owned.identity !== entry.supervisorIdentity ||
      typeof owned.token !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(owned.token)
    ) {
      throw new Error('Process supervisor authentication record is invalid.');
    }
    return Object.freeze({
      identity: entry.supervisorIdentity,
      authenticationToken: owned.token,
      processId: entry.processId,
      owner: entry.owner,
      endpoint: entry.supervisorEndpoint,
      stateFile: this.supervisorStatePath(entry.processId)
    });
  }

  private async readSupervisorTerminalState(
    supervision: ProcessSupervisorIdentity
  ): Promise<SupervisorTerminalState | undefined> {
    try {
      return verifySupervisorTerminalState(
        JSON.parse(await readFile(supervision.stateFile, 'utf8')),
        supervision
      );
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async waitForSupervisorTerminalState(
    supervision: ProcessSupervisorIdentity
  ): Promise<SupervisorTerminalState> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const state = await this.readSupervisorTerminalState(supervision);
        if (state) return state;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Authenticated supervisor did not produce terminal state: ${errorMessage(lastError)}`
    );
  }

  private supervisorAuthenticationPath(processId: string): string {
    if (!this.options.ledgerDirectory || !/^proc_[a-f0-9-]+$/u.test(processId))
      throw new Error('Invalid process supervisor authentication identity.');
    return path.join(this.options.ledgerDirectory, `${processId}.auth.json`);
  }

  private supervisorStatePath(processId: string): string {
    if (!this.options.ledgerDirectory || !/^proc_[a-f0-9-]+$/u.test(processId))
      throw new Error('Invalid process supervisor state identity.');
    return path.join(this.options.ledgerDirectory, `${processId}.state.json`);
  }

  private async removeSupervisorFiles(processId: string): Promise<void> {
    if (!this.options.ledgerDirectory) return;
    await rm(this.supervisorAuthenticationPath(processId), { force: true });
    await rm(this.supervisorStatePath(processId), { force: true });
    if (process.platform !== 'win32') {
      try {
        await rmdir(path.join(this.options.ledgerDirectory, 'sockets'));
      } catch (error) {
        if (nodeCode(error) !== 'ENOENT' && nodeCode(error) !== 'ENOTEMPTY') throw error;
      }
    }
  }
}

function encodeProcessOutput(record: ManagedProcess, redact: boolean): Uint8Array {
  const chunks = record.capture.chunks();
  const text = chunks.map((chunk) => chunk.text);
  const selected = redact ? redactPassages(text) : text;
  return Buffer.from(JSON.stringify({
    processId: record.id,
    owner: record.owner,
    status: record.status,
    startedAt: new Date(record.startedAt).toISOString(),
    observedBytes: record.cursor,
    retainedBytes: record.capture.retainedBytes,
    omittedBytes: Math.max(0, record.cursor - record.capture.retainedBytes),
    chunks: chunks.map(({ sequence, stream, streamStart, start, end }, index) => ({
      sequence, stream, streamStart, start, end, text: selected[index]
    }))
  }) + '\n', 'utf8');
}

/** Redact before selection so slicing cannot detach a credential from its identifying prefix. */
function redactPassages(passages: readonly string[]): string[] {
  const source = Buffer.from(passages.join(''), 'utf8');
  const redacted = Buffer.from(redactTextPreservingLength(source.toString('latin1')).text, 'latin1');
  let offset = 0;
  return passages.map((text) => {
    const end = offset + Buffer.byteLength(text, 'utf8');
    const selected = redacted.subarray(offset, end).toString('utf8');
    offset = end;
    return selected;
  });
}

class BoundedCapture {
  private readonly head: CapturedChunk[] = [];
  private readonly tail: CapturedChunk[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  constructor(maxBytes: number, tailBytes: number) {
    this.tailLimit = Math.min(tailBytes, Math.floor(maxBytes / 2));
    this.headLimit = maxBytes - this.tailLimit;
  }
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
      this.tail.push({ ...chunk, text, bytes, start: chunk.end - bytes, streamStart: chunk.streamStart + chunk.bytes - bytes });
      this.tailBytes += bytes;
      while (this.tailBytes > this.tailLimit && this.tail.length > 0) {
        const first = this.tail[0];
        if (!first) break;
        const keep = takeUtf8End(
          first.text,
          Math.max(0, first.bytes - (this.tailBytes - this.tailLimit))
        );
        if (keep.length === 0) {
          this.tail.shift();
          this.tailBytes -= first.bytes;
        } else {
          const keptBytes = Buffer.byteLength(keep, 'utf8');
          this.tail[0] = { ...first, text: keep, bytes: keptBytes, start: first.end - keptBytes, streamStart: first.streamStart + first.bytes - keptBytes };
          this.tailBytes -= first.bytes - keptBytes;
        }
      }
    }
  }
  get retainedBytes(): number {
    return this.headBytes + this.tailBytes;
  }
  chunks(): readonly CapturedChunk[] {
    return [...this.head, ...this.tail];
  }
}

function view(
  chunks: readonly CapturedChunk[],
  maxBytes: number,
  afterCursor: number,
  observedBytes: number,
  stream?: LocalOutputStream
): CommandOutputView {
  const passages: string[] = [];
  let end: number | undefined;
  let start: number | undefined;
  for (const chunk of chunks) {
    if (chunk.end <= afterCursor || (stream !== undefined && chunk.stream !== stream)) continue;
    const text = dropUtf8Bytes(chunk.text, Math.max(0, afterCursor - chunk.start));
    const bytes = Buffer.byteLength(text, 'utf8');
    const chunkStart = (stream === undefined ? chunk.start : chunk.streamStart) + chunk.bytes - bytes;
    start ??= chunkStart;
    if (end !== chunkStart || passages.length === 0) passages.push('');
    end = chunkStart + bytes;
    passages[passages.length - 1] = (passages[passages.length - 1] ?? '') + text;
  }
  let segments = redactPassages(passages.filter((text) => text.length > 0));
  const retained = segments.reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0);
  let startsAtOutputStart = observedBytes === 0 || start === 0;
  let endsAtOutputEnd = observedBytes === 0 || end === observedBytes;
  if (retained > maxBytes) {
    const head: string[] = [];
    const tail: string[] = [];
    let remaining = maxBytes - Math.floor(maxBytes / 3);
    for (const text of segments) {
      const selected = takeUtf8Start(text, remaining);
      if (selected) head.push(selected);
      remaining -= Buffer.byteLength(selected, 'utf8');
      if (selected.length !== text.length) break;
    }
    remaining = maxBytes - head.reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0);
    for (const text of [...segments].reverse()) {
      const selected = takeUtf8End(text, remaining);
      if (selected) tail.unshift(selected);
      remaining -= Buffer.byteLength(selected, 'utf8');
      if (selected.length !== text.length) break;
    }
    startsAtOutputStart &&= head.length > 0;
    endsAtOutputEnd &&= tail.length > 0;
    segments = [...head, ...tail];
  }
  return createCommandOutputView({
    segments,
    observedBytes,
    capturedBytes: segments.reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0),
    startsAtOutputStart,
    endsAtOutputEnd
  });
}

function takeUtf8Start(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? '')) low -= 1;
  return value.slice(0, low);
}
function takeUtf8End(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), 'utf8') <= maxBytes) high = middle;
    else low = middle + 1;
  }
  if (/[\uDC00-\uDFFF]/u.test(value[low] ?? '')) low += 1;
  return value.slice(low);
}
function dropUtf8Bytes(value: string, bytes: number): string {
  if (bytes <= 0) return value;
  let consumed = 0;
  for (let index = 0; index < value.length; ) {
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

function terminalProgress(
  record: ManagedProcess,
  status: Exclude<CommandExecutionStatus, 'running'>
): ToolProgress {
  const stage =
    status === 'timed_out'
      ? 'process_timed_out'
      : status === 'failed'
        ? 'process_failed'
        : status === 'stopped'
          ? 'process_stopped'
          : 'process_exited';
  return { type: 'status', stage, message: `Process ${record.id} ${status}.` };
}
function recoveredTerminalResult(
  entry: ProcessLedgerEntry,
  terminal: SupervisorTerminalState,
  stopped: boolean,
  receipt: ProcessTerminalRecord | undefined,
  outputDiagnostic: string | undefined
): CommandExecutionResult {
  const stream = (observedBytes: number) => createCommandOutputView({
    segments: [],
    observedBytes,
    capturedBytes: 0,
    startsAtOutputStart: true,
    endsAtOutputEnd: observedBytes === 0 && receipt !== undefined
  });
  const cursorEnd = receipt?.cursorEnd ?? 0;
  return Object.freeze({
    processId: entry.processId,
    owner: entry.owner,
    status:
      receipt?.status ?? entry.terminationReason ?? (terminal.state === 'exited'
        ? 'exited'
        : terminal.state === 'stopped' || stopped
          ? 'stopped'
          : 'failed'),
    cursorStart: 0,
    cursorEnd,
    originalOutput: receipt?.artifact || receipt?.protectedArtifact
      ? { kind: 'captured' as const, cursorEnd, omittedBytes: receipt.combined.observedBytes - receipt.combined.capturedBytes }
      : { kind: 'unavailable' as const, cursorEnd, diagnostic: outputDiagnostic ?? 'Original process output could not be retained.' },
    stdout: stream(receipt?.stdout.observedBytes ?? 0),
    stderr: stream(receipt?.stderr.observedBytes ?? 0),
    combined: stream(receipt?.combined.observedBytes ?? 0),
    ...(receipt?.artifact === undefined ? {} : { artifact: receipt.artifact }),
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    diagnostic: [stopped
      ? 'An authenticated orphaned supervisor stopped its owned process tree during startup reconciliation.'
      : 'An authenticated supervisor terminal report was recovered during startup reconciliation.',
      outputDiagnostic, receipt?.diagnostic].filter((part) => part !== undefined).join(' ')
  });
}
function terminalRecordFromReport(
  report: CommandExecutionReport,
  rootPath: string,
  executionTargetId: string
): ProcessTerminalRecord {
  const { result, protectedArtifact } = report;
  if (result.status === 'running') throw new Error('A running process has no terminal record.');
  const counts = (stream: CommandOutputView) => ({
    observedBytes: stream.observedBytes,
    capturedBytes: stream.capturedBytes
  });
  return Object.freeze({
    schemaVersion: 1,
    processId: result.processId,
    rootPath,
    executionTargetId,
    owner: result.owner,
    status: result.status,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    cursorEnd: result.cursorEnd,
    stdout: counts(result.stdout),
    stderr: counts(result.stderr),
    combined: counts(result.combined),
    ...(result.artifact ? { artifact: result.artifact } : {}),
    ...(protectedArtifact ? { protectedArtifact } : {}),
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic })
  });
}

function compactTerminalReport(report: CommandExecutionReport): CommandExecutionReport {
  const empty = (output: CommandOutputView) => createCommandOutputView({
    segments: [], observedBytes: output.observedBytes, capturedBytes: 0,
    startsAtOutputStart: output.observedBytes === 0, endsAtOutputEnd: output.observedBytes === 0
  });
  return Object.freeze({ ...report, result: Object.freeze({
    ...report.result, cursorStart: report.result.cursorEnd,
    stdout: empty(report.result.stdout), stderr: empty(report.result.stderr),
    combined: empty(report.result.combined)
  }) });
}

function recoveryIdentity(
  ledgerDirectory: string | undefined,
  rootedFileAuthority: RootedFileAuthority
): string {
  if (ledgerDirectory === undefined) return `local-command:ephemeral:${randomUUID()}`;
  return `local-command:sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        ledgerDirectory: path.resolve(ledgerDirectory),
        rootPath: rootedFileAuthority.identity
      })
    )
    .digest('hex')}`;
}
function requirePid(tree: OwnedProcessTree): number {
  const pid = tree.child.pid;
  if (pid === undefined || pid <= 0) throw new Error('Process PID is unavailable.');
  return pid;
}
function appendDiagnostic(existing: string | undefined, next: string): string {
  return existing ? `${existing} ${next}` : next;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(label + ' must be positive.');
  return value;
}
