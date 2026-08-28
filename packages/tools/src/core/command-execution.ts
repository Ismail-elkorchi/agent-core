import type { ProtectedArtifactRef, PublicArtifactRef } from '@agent-core/evidence';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { ToolProgress, ToolResourceLease } from './context.js';
import type { ResourceLeaseCoordinator } from './resource-leases.js';
import { isResourceLeaseCoordinator } from './resource-leases.js';

export type CommandOutputStream = 'stdout' | 'stderr';
export type CommandExecutionStatus = 'running' | 'exited' | 'stopped' | 'timed_out' | 'failed';

export interface CommandExecutionOwner {
  readonly runId: string;
  readonly turnId: string;
  readonly toolBatchId: string;
  readonly callIndex: number;
}

export interface CommandExecutionDescriptor {
  /** Versioned implementation identity captured with durable effect intent. */
  readonly implementationId: string;
  /** Stable identity of the recovery store and execution authority. */
  readonly recoveryIdentity: string;
  readonly capabilities: readonly string[];
  readonly supportsPty: boolean;
}

export interface PrepareCommandRequest {
  readonly command: string;
  /** Canonical path relative to the command authority's adopted workspace. */
  readonly workspacePath: string;
  readonly pty: boolean;
  readonly timeoutMs: number;
  readonly yieldMs: number;
  readonly outputTokenBudget: number;
  readonly owner: CommandExecutionOwner;
}

export interface StartPreparedCommandOptions {
  readonly signal?: AbortSignal;
  readonly lease?: ToolResourceLease;
  readonly onProgress?: (progress: ToolProgress) => void | Promise<void>;
}

/** Authority-owned command preparation. It may reserve resources but must not execute the target. */
export interface CommandExecutionPreparation {
  /** Exact, immutable evidence included in the tool authorization fingerprint. */
  readonly authorization: JsonObject;
  release(): void | Promise<void>;
}

const PREPARED_COMMAND_EXECUTION = Symbol('agent-core.prepared-command-execution');
/** Opaque, single-authority preparation admitted by this package. */
export interface PreparedCommandExecution {
  readonly [PREPARED_COMMAND_EXECUTION]: true;
  readonly request: PrepareCommandRequest;
  readonly authorization: JsonObject;
}

export interface CommandOutputView {
  readonly text: string;
  readonly observedBytes: number;
  readonly capturedBytes: number;
  readonly omittedBytes: number;
  readonly startsAtOutputStart: boolean;
  readonly endsAtOutputEnd: boolean;
}

export interface CommandExecutionResult {
  readonly processId: string;
  readonly owner: CommandExecutionOwner;
  readonly status: CommandExecutionStatus;
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly cursorExpired?: boolean;
  readonly stdout: CommandOutputView;
  readonly stderr: CommandOutputView;
  readonly combined: CommandOutputView;
  readonly artifact?: PublicArtifactRef;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly diagnostic?: string;
  readonly progressDroppedEvents?: number;
  readonly progressDeliveryErrors?: number;
}

export interface CommandExecutionReport {
  readonly result: CommandExecutionResult;
  readonly protectedArtifact?: ProtectedArtifactRef;
}

export interface CommandReconciliationResult {
  readonly resolved: readonly string[];
  readonly unresolved: readonly {
    readonly processId: string;
    readonly workspace: string;
    readonly diagnostic: string;
  }[];
}

/**
 * Application-supplied command authority. Implementations own process identity,
 * retention, output cursors, recovery, and cleanup; tools only consume this
 * behavior contract.
 */
export interface CommandExecution {
  readonly descriptor: CommandExecutionDescriptor;
  readonly resourceLeases: ResourceLeaseCoordinator;
  prepare(request: PrepareCommandRequest): Promise<CommandExecutionPreparation>;
  start(prepared: CommandExecutionPreparation, options?: StartPreparedCommandOptions): Promise<CommandExecutionResult>;
  query(processId: string, outputTokenBudget: number, yieldMs?: number, afterCursor?: number, requester?: CommandExecutionOwner): Promise<CommandExecutionResult>;
  writeInput(processId: string, text: string, requester?: CommandExecutionOwner): Promise<void>;
  closeInput(processId: string, requester?: CommandExecutionOwner): Promise<void>;
  terminate(processId: string, requester?: CommandExecutionOwner): Promise<CommandExecutionResult>;
  disposeRun(runId: string): Promise<readonly CommandExecutionReport[]>;
  recoveredTerminalReports(): readonly CommandExecutionReport[];
  acknowledgeTerminalReport(processId: string): Promise<void>;
  reconcile(): Promise<CommandReconciliationResult>;
  retryReconciliation(): Promise<CommandReconciliationResult>;
  acknowledgeUnresolved(processIds: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

const adoptedCommandExecutions = new WeakSet();
const preparedCommands = new WeakMap<PreparedCommandExecution, {
  state: 'prepared' | 'started' | 'released';
  readonly authority: CommandExecution;
  readonly source: CommandExecutionPreparation;
}>();

export async function prepareCommandExecution(
  authority: CommandExecution,
  request: PrepareCommandRequest
): Promise<PreparedCommandExecution> {
  if (!isCommandExecution(authority)) throw new TypeError('Command execution authority was not adopted.');
  validatePrepareRequest(request);
  const source = await authority.prepare(request);
  if (typeof source !== 'object' || source === null || typeof source.release !== 'function') {
    throw new TypeError('Command execution preparation is invalid.');
  }
  let authorization: JsonObject;
  try {
    authorization = parseJsonObject(source.authorization, {
      maxDepth: 24,
      maxCollectionEntries: 2_000,
      maxStringBytes: 256_000,
      maxTotalBytes: 512_000
    });
  } catch (error) {
    await Promise.resolve(source.release()).catch(() => undefined);
    throw error;
  }
  const prepared = Object.freeze({
    [PREPARED_COMMAND_EXECUTION]: true as const,
    request: Object.freeze({ ...request, owner: Object.freeze({ ...request.owner }) }),
    authorization
  });
  preparedCommands.set(prepared, { state: 'prepared', authority, source });
  return prepared;
}

export async function startPreparedCommandExecution(
  authority: CommandExecution,
  prepared: PreparedCommandExecution,
  options: StartPreparedCommandOptions = {}
): Promise<CommandExecutionResult> {
  const record = requirePreparedCommand(prepared, authority);
  if (record.state !== 'prepared') throw new Error('Command execution preparation is single-use.');
  record.state = 'started';
  return authority.start(record.source, options);
}

export async function releasePreparedCommandExecution(
  authority: CommandExecution,
  prepared: PreparedCommandExecution
): Promise<void> {
  const record = requirePreparedCommand(prepared, authority);
  if (record.state === 'released') return;
  record.state = 'released';
  await record.source.release();
}

export function adoptCommandExecution(value: unknown): CommandExecution {
  if (isCommandExecution(value)) return value;
  if (typeof value !== 'object' || value === null) throw new TypeError('Command execution must be an object.');
  const candidate = value as Partial<Record<keyof CommandExecution, unknown>>;
  const descriptor = candidate.descriptor;
  if (typeof descriptor !== 'object' || descriptor === null) throw new TypeError('Command execution descriptor is required.');
  const owned = descriptor as Partial<CommandExecutionDescriptor>;
  if (!validIdentity(owned.implementationId) || !validIdentity(owned.recoveryIdentity)
    || !Array.isArray(owned.capabilities) || !owned.capabilities.every((item) => validIdentity(item))
    || new Set(owned.capabilities).size !== owned.capabilities.length
    || typeof owned.supportsPty !== 'boolean') throw new TypeError('Command execution descriptor is invalid.');
  if (!Object.isFrozen(descriptor) || !Object.isFrozen(owned.capabilities)) {
    throw new TypeError('Command execution descriptor and capabilities must be immutable.');
  }
  if (!isResourceLeaseCoordinator(candidate.resourceLeases)) throw new TypeError('Command execution resource lease coordinator is invalid.');
  const complete = ['prepare', 'start', 'query', 'writeInput', 'closeInput', 'terminate', 'disposeRun', 'recoveredTerminalReports',
    'acknowledgeTerminalReport', 'reconcile', 'retryReconciliation', 'acknowledgeUnresolved', 'close']
    .every((key) => typeof candidate[key as keyof CommandExecution] === 'function');
  if (!complete) throw new TypeError('Command execution behavior is incomplete.');
  adoptedCommandExecutions.add(value);
  return value as CommandExecution;
}

function requirePreparedCommand(prepared: PreparedCommandExecution, authority: CommandExecution) {
  const record = preparedCommands.get(prepared);
  if (!record || record.authority !== authority) throw new TypeError('Command preparation does not belong to this execution authority.');
  return record;
}

function validatePrepareRequest(request: PrepareCommandRequest): void {
  if (typeof request !== 'object' || request === null) throw new TypeError('Command preparation request must be an object.');
  if (typeof request.command !== 'string' || request.command.length === 0) throw new TypeError('Command must be non-empty.');
  if (typeof request.workspacePath !== 'string') throw new TypeError('Command workspace path must be a string.');
  if (typeof request.pty !== 'boolean') throw new TypeError('Command PTY selection must be boolean.');
  for (const [name, value] of [['timeoutMs', request.timeoutMs], ['yieldMs', request.yieldMs], ['outputTokenBudget', request.outputTokenBudget]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  if (typeof request.owner !== 'object' || request.owner === null
    || !validIdentity(request.owner.runId) || !validIdentity(request.owner.turnId)
    || !validIdentity(request.owner.toolBatchId) || !Number.isSafeInteger(request.owner.callIndex) || request.owner.callIndex < 0) {
    throw new TypeError('Command execution owner is invalid.');
  }
}

export function isCommandExecution(value: unknown): value is CommandExecution {
  return typeof value === 'object' && value !== null && adoptedCommandExecutions.has(value);
}

function validIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false;
  }
  return true;
}
