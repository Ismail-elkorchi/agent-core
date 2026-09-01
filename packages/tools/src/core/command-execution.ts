import type { ProtectedArtifactRef, PublicArtifactRef } from '@agent-core/persistence';
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

export interface CommandExecutionPlanRequest {
  readonly command: string;
  /** Canonical path relative to the command authority's adopted root. */
  readonly rootedDirectory: string;
  readonly pty: boolean;
  readonly timeoutMs: number;
  readonly yieldMs: number;
  readonly outputTokenBudget: number;
  readonly owner: CommandExecutionOwner;
}

export interface StartCommandExecutionOptions {
  readonly signal?: AbortSignal;
  readonly lease?: ToolResourceLease;
  readonly onProgress?: (progress: ToolProgress) => void | Promise<void>;
}

/** Authority-owned command planning. It may reserve resources but must not execute the target. */
export interface CommandExecutionReservation {
  readonly [COMMAND_EXECUTION_RESERVATION]: true;
  /** Exact, immutable observedFacts included in the tool authorization fingerprint. */
  readonly authorization: JsonObject;
  release(): void | Promise<void>;
}

const COMMAND_EXECUTION_RESERVATION = Symbol('agent-core.command-execution-planning');
const commandExecutionReservations = new WeakSet<CommandExecutionReservation>();

export function createCommandExecutionReservation(
  authorizationValue: unknown,
  release: () => void | Promise<void>
): CommandExecutionReservation {
  if (typeof release !== 'function') throw new TypeError('Command execution planning release must be callable.');
  const authorization = parseJsonObject(authorizationValue, {
    maxDepth: 24,
    maxCollectionEntries: 2_000,
    maxStringBytes: 256_000,
    maxTotalBytes: 512_000
  });
  const planning = Object.freeze({
    [COMMAND_EXECUTION_RESERVATION]: true as const,
    authorization,
    release
  });
  commandExecutionReservations.add(planning);
  return planning;
}

const COMMAND_EXECUTION_PLAN = Symbol('agent-core.plan-command-execution');
/** Opaque, single-authority planning admitted by this package. */
export interface CommandExecutionPlan {
  readonly [COMMAND_EXECUTION_PLAN]: true;
  readonly request: CommandExecutionPlanRequest;
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
    readonly rootPath: string;
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
  plan(request: CommandExecutionPlanRequest): Promise<CommandExecutionReservation>;
  start(plan: CommandExecutionReservation, options?: StartCommandExecutionOptions): Promise<CommandExecutionResult>;
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
const commandExecutionPlans = new WeakMap<CommandExecutionPlan, {
  state: 'plan' | 'started' | 'released';
  readonly authority: CommandExecution;
  readonly source: CommandExecutionReservation;
}>();

export async function planCommandExecution(
  authority: CommandExecution,
  request: CommandExecutionPlanRequest
): Promise<CommandExecutionPlan> {
  if (!isCommandExecution(authority)) throw new TypeError('Command execution authority was not adopted.');
  validateCommandExecutionPlanRequest(request);
  const source = await authority.plan(request);
  if (!isCommandExecutionReservation(source)) {
    throw new TypeError('Command execution planning is invalid.');
  }
  const plan = Object.freeze({
    [COMMAND_EXECUTION_PLAN]: true as const,
    request: Object.freeze({ ...request, owner: Object.freeze({ ...request.owner }) }),
    authorization: source.authorization
  });
  commandExecutionPlans.set(plan, { state: 'plan', authority, source });
  return plan;
}

export function isCommandExecutionReservation(value: unknown): value is CommandExecutionReservation {
  return typeof value === 'object' && value !== null && commandExecutionReservations.has(value as CommandExecutionReservation);
}

export async function startCommandExecutionPlan(
  authority: CommandExecution,
  plan: CommandExecutionPlan,
  options: StartCommandExecutionOptions = {}
): Promise<CommandExecutionResult> {
  const record = requireCommandExecutionPlan(plan, authority);
  if (record.state !== 'plan') throw new Error('Command execution planning is single-use.');
  record.state = 'started';
  return authority.start(record.source, options);
}

export async function releaseCommandExecutionPlan(
  authority: CommandExecution,
  plan: CommandExecutionPlan
): Promise<void> {
  const record = requireCommandExecutionPlan(plan, authority);
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
  const complete = ['plan', 'start', 'query', 'writeInput', 'closeInput', 'terminate', 'disposeRun', 'recoveredTerminalReports',
    'acknowledgeTerminalReport', 'reconcile', 'retryReconciliation', 'acknowledgeUnresolved', 'close']
    .every((key) => typeof candidate[key as keyof CommandExecution] === 'function');
  if (!complete) throw new TypeError('Command execution behavior is incomplete.');
  adoptedCommandExecutions.add(value);
  return value as CommandExecution;
}

function requireCommandExecutionPlan(plan: CommandExecutionPlan, authority: CommandExecution) {
  const record = commandExecutionPlans.get(plan);
  if (record?.authority !== authority) throw new TypeError('Command planning does not belong to this execution authority.');
  return record;
}

function validateCommandExecutionPlanRequest(request: CommandExecutionPlanRequest): void {
  if (typeof request.command !== 'string' || request.command.length === 0) throw new TypeError('Command must be non-empty.');
  if (typeof request.rootedDirectory !== 'string') throw new TypeError('Command rooted directory must be a string.');
  if (typeof request.pty !== 'boolean') throw new TypeError('Command PTY selection must be boolean.');
  for (const [name, value] of [['timeoutMs', request.timeoutMs], ['yieldMs', request.yieldMs], ['outputTokenBudget', request.outputTokenBudget]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  if (!validIdentity(request.owner.runId) || !validIdentity(request.owner.turnId)
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
