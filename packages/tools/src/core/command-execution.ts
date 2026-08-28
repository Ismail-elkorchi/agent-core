import type { ProtectedArtifactRef, PublicArtifactRef } from '@agent-core/evidence';
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

export interface StartCommandRequest {
  readonly command: string;
  /** Canonical path relative to the command authority's adopted workspace. */
  readonly workspacePath: string;
  readonly pty: boolean;
  readonly timeoutMs: number;
  readonly yieldMs: number;
  readonly outputTokenBudget: number;
  readonly owner: CommandExecutionOwner;
  readonly signal?: AbortSignal;
  readonly lease?: ToolResourceLease;
  readonly onProgress?: (progress: ToolProgress) => void | Promise<void>;
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
  start(request: StartCommandRequest): Promise<CommandExecutionResult>;
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
  const complete = ['start', 'query', 'writeInput', 'closeInput', 'terminate', 'disposeRun', 'recoveredTerminalReports',
    'acknowledgeTerminalReport', 'reconcile', 'retryReconciliation', 'acknowledgeUnresolved', 'close']
    .every((key) => typeof candidate[key as keyof CommandExecution] === 'function');
  if (!complete) throw new TypeError('Command execution behavior is incomplete.');
  adoptedCommandExecutions.add(value);
  return value as CommandExecution;
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
