import { assertAgentRunStateInvariants } from './state-invariants.js';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { decodeAgentRunBudgetState, type AgentRunBudgetState } from '../contracts.js';
import {
  decodeAgentRunControl,
  decodeAgentRunControlPhase,
  decodeAgentRunState,
  decodeProviderPhase,
  type AgentProviderPhase,
  type AgentRunControl,
  type AgentRunControlPhase,
  type AgentRunState
} from './contracts.js';
import { AgentRunRecords, decodeAgentToolWorkRecord, type AgentToolWorkRecord } from './records.js';

export type AgentRunStateTransition =
  | Readonly<{ readonly kind: 'accepted'; readonly state: AgentRunState }>
  | Readonly<{
      readonly kind: 'updated';
      readonly runId: string;
      readonly revision: number;
      readonly driverGeneration: number;
      readonly control?: AgentRunControl;
      readonly phase?: AgentRunControlPhase;
      readonly providerRequests?: readonly IndexedProviderRequest[];
      readonly toolRecords?: readonly IndexedToolBatch[];
      readonly providerRequestCount?: number;
      readonly toolBatchCount?: number;
      readonly budget?: AgentRunBudgetState;
    }>;

export interface IndexedProviderRequest {
  readonly index: number;
  readonly value: AgentProviderPhase;
}

export interface IndexedToolBatch {
  readonly index: number;
  readonly value: AgentToolWorkRecord;
}

export async function createAgentRunStateTransition(
  previous: AgentRunState | undefined,
  next: AgentRunState,
  records: AgentRunRecords
): Promise<AgentRunStateTransition> {
  assertAgentRunStateInvariants(next);
  if (!previous) {
    if (next.toolBatches.length || next.providerRequests.length)
      throw new Error('Acceptance cannot contain uncommitted work.');
    return Object.freeze({ kind: 'accepted', state: next });
  }
  if (
    previous.runId !== next.runId ||
    previous.finalizationId !== next.finalizationId ||
    !same(previous.input, next.input) ||
    !same(previous.configuration, next.configuration)
  )
    throw new Error('A run transition cannot replace immutable run identity or configuration.');
  if (next.revision !== previous.revision + 1)
    throw new Error('A run transition must advance its revision exactly once.');
  if (
    next.driverGeneration < previous.driverGeneration ||
    next.driverGeneration > previous.driverGeneration + 1
  )
    throw new Error(
      'A run transition must preserve or advance its driver generation exactly once.'
    );

  assertRetainedWork(previous, next);
  const providerRequests = indexedChanges(previous.providerRequests, next.providerRequests).map(
    (entry) => Object.freeze({ index: entry.index, value: decodeProviderPhase(entry.value) })
  );
  const toolRecords = await Promise.all(
    indexedChanges(previous.toolBatches, next.toolBatches).map(async (entry) => ({
      index: entry.index,
      value: await records.storeTools(next.runId, entry.value)
    }))
  );
  if (previous.budget !== undefined && next.budget === undefined)
    throw new Error('A run transition cannot remove an accepted budget state.');

  return Object.freeze({
    kind: 'updated',
    runId: next.runId,
    revision: next.revision,
    driverGeneration: next.driverGeneration,
    ...(same(previous.control, next.control)
      ? {}
      : { control: decodeAgentRunControl(next.control) }),
    ...(same(previous.phase, next.phase) ? {} : { phase: decodeAgentRunControlPhase(next.phase) }),
    ...(providerRequests.length === 0 &&
    previous.providerRequests.length === next.providerRequests.length
      ? {}
      : { providerRequests, providerRequestCount: next.providerRequests.length }),
    ...(toolRecords.length === 0 && previous.toolBatches.length === next.toolBatches.length
      ? {}
      : { toolRecords, toolBatchCount: next.toolBatches.length }),
    ...(same(previous.budget, next.budget) || next.budget === undefined
      ? {}
      : { budget: decodeAgentRunBudgetState(next.budget) })
  });
}

export async function applyAgentRunStateTransition(
  previous: AgentRunState | undefined,
  transition: AgentRunStateTransition,
  records: AgentRunRecords
): Promise<AgentRunState> {
  if (transition.kind === 'accepted') {
    if (previous)
      throw new Error(`Run ${previous.runId} contains more than one acceptance transition.`);
    return transition.state;
  }
  if (!previous)
    throw new Error(`Run ${transition.runId} starts without an acceptance transition.`);
  if (
    transition.runId !== previous.runId ||
    transition.revision !== previous.revision + 1 ||
    transition.driverGeneration < previous.driverGeneration ||
    transition.driverGeneration > previous.driverGeneration + 1
  )
    throw new Error(`Run ${transition.runId} contains a non-contiguous transition.`);
  const budget = transition.budget ?? previous.budget;
  const state: AgentRunState = Object.freeze({
    ...previous,
    revision: transition.revision,
    driverGeneration: transition.driverGeneration,
    control: transition.control ?? previous.control,
    phase: transition.phase ?? previous.phase,
    providerRequests: applyIndexed(
      previous.providerRequests,
      transition.providerRequests,
      transition.providerRequestCount
    ),
    toolBatches: applyIndexed(
      previous.toolBatches,
      transition.toolRecords
        ? await Promise.all(
            transition.toolRecords.map(async (entry) => ({
              index: entry.index,
              value: await records.loadTools(previous.runId, entry.value)
            }))
          )
        : undefined,
      transition.toolBatchCount
    ),
    ...(budget === undefined ? {} : { budget })
  });
  assertAgentRunStateInvariants(state);
  assertRetainedWork(previous, state);
  return state;
}

export function decodeAgentRunStateTransition(value: unknown): AgentRunStateTransition {
  const object = parseJsonObject(value, {
    maxDepth: 18,
    maxCollectionEntries: 20_000,
    maxStringBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024
  });
  if (object.kind === 'accepted') {
    exact(object, ['kind', 'state']);
    const state = decodeAgentRunState(object.state);
    if (
      state.phase.kind !== 'accepted' ||
      state.revision !== 0 ||
      state.driverGeneration !== 0 ||
      state.providerRequests.length ||
      state.toolBatches.length
    )
      throw new TypeError(
        'Incompatible run acceptance: work must be admitted through referenced transitions; retain original data.'
      );
    return Object.freeze({ kind: 'accepted', state });
  }
  if (object.kind !== 'updated') throw new TypeError('Run state transition kind is invalid.');
  exact(object, [
    'kind',
    'runId',
    'revision',
    'driverGeneration',
    'control',
    'phase',
    'providerRequests',
    'toolRecords',
    'providerRequestCount',
    'toolBatchCount',
    'budget'
  ]);
  const runId = identifier(object.runId, 'runId');
  const revision = nonnegativeInteger(object.revision, 'revision');
  const driverGeneration = nonnegativeInteger(object.driverGeneration, 'driverGeneration');
  const control = object.control === undefined ? undefined : decodeAgentRunControl(object.control);
  const phase = object.phase === undefined ? undefined : decodeAgentRunControlPhase(object.phase);
  const providerRequests = decodeIndexed(
    object.providerRequests,
    decodeProviderPhase,
    'providerRequests'
  );
  const toolRecords = decodeIndexed(object.toolRecords, decodeAgentToolWorkRecord, 'toolRecords');
  const providerRequestCount =
    object.providerRequestCount === undefined
      ? undefined
      : nonnegativeInteger(object.providerRequestCount, 'providerRequestCount');
  const toolBatchCount =
    object.toolBatchCount === undefined
      ? undefined
      : nonnegativeInteger(object.toolBatchCount, 'toolBatchCount');
  if (
    (providerRequests === undefined) !== (providerRequestCount === undefined) ||
    (toolRecords === undefined) !== (toolBatchCount === undefined)
  )
    throw new TypeError(
      'Incompatible run transition: work replacements require explicit outstanding counts; retain old data and start a new run.'
    );
  const budget = object.budget === undefined ? undefined : decodeAgentRunBudgetState(object.budget);
  return Object.freeze({
    kind: 'updated',
    runId,
    revision,
    driverGeneration,
    ...(control ? { control } : {}),
    ...(phase ? { phase } : {}),
    ...(providerRequests && providerRequestCount !== undefined
      ? { providerRequests, providerRequestCount }
      : {}),
    ...(toolRecords && toolBatchCount !== undefined ? { toolRecords, toolBatchCount } : {}),
    ...(budget ? { budget } : {})
  });
}

function indexedChanges<T>(
  previous: readonly T[],
  next: readonly T[]
): readonly { index: number; value: T }[] {
  const changes: { index: number; value: T }[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const value = next[index];
    if (value !== undefined && !same(previous[index], value))
      changes.push(Object.freeze({ index, value }));
  }
  return Object.freeze(changes);
}

function applyIndexed<T>(
  previous: readonly T[],
  changes: readonly { readonly index: number; readonly value: T }[] | undefined,
  count: number | undefined
): readonly T[] {
  if (!changes) return previous;
  if (count === undefined) throw new Error('Run work replacement has no bound.');
  const next = [...previous];
  for (const change of changes) {
    if (change.index >= count) throw new Error('Run work change is outside its declared count.');
    if (change.index > next.length)
      throw new Error('Run collection transition has a positional gap.');
    next[change.index] = change.value;
  }
  if (count > next.length) throw new Error('Run work count is inconsistent.');
  return Object.freeze(next.slice(0, count));
}

function decodeIndexed<T>(
  value: unknown,
  decode: (input: unknown) => T,
  label: string
): readonly { readonly index: number; readonly value: T }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const seen = new Set<number>();
  return Object.freeze(
    value.map((item, position) => {
      const entry = objectValue(item, `${label}[${String(position)}]`);
      exact(entry, ['index', 'value']);
      const index = nonnegativeInteger(entry.index, `${label}.index`);
      if (seen.has(index)) throw new TypeError(`${label} contains a duplicate index.`);
      seen.add(index);
      return Object.freeze({ index, value: decode(entry.value) });
    })
  );
}

function same(left: unknown, right: unknown): boolean {
  return (
    left === right ||
    (left !== undefined && right !== undefined && hashJson(left) === hashJson(right))
  );
}

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object.`);
  return value as JsonObject;
}

function exact(value: JsonObject, fields: readonly string[]): void {
  if (Object.keys(value).some((field) => !fields.includes(field)))
    throw new TypeError('Run state transition contains an unsupported field.');
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}

function assertRetainedWork(previous: AgentRunState, next: AgentRunState): void {
  for (const request of previous.providerRequests) {
    const retained = next.providerRequests.find(
      (item) =>
        item.identity.turnId === request.identity.turnId &&
        item.identity.requestAttempt === request.identity.requestAttempt
    );
    const reprepare =
      request.stage === 'ready' &&
      previous.phase.kind === 'suspended' &&
      previous.phase.reason === 'context_admission' &&
      next.phase.kind === 'initializing' &&
      next.phase.step === 'assemble_turn' &&
      next.phase.turnIndex === previous.phase.turnIndex;
    if (!retained && request.stage !== 'consumed' && !reprepare)
      throw new Error('Unresolved provider work cannot be removed.');
    if (
      retained &&
      (!same(request.identity, retained.identity) || request.toolBatchId !== retained.toolBatchId)
    )
      throw new Error('Provider source identity changed.');
  }
  for (const batch of previous.toolBatches) {
    const retained = next.toolBatches.find((item) => item.toolBatchId === batch.toolBatchId);
    if (!retained) {
      if (
        !batch.callStates.every(
          (call) =>
            call.stage === 'resolved' ||
            call.stage === 'cancelled' ||
            (call.stage === 'recorded' &&
              (!batch.source.nativeCatalogIdentity || call.delivery?.status === 'applied'))
        )
      )
        throw new Error('Unresolved tool or delivery work cannot be removed.');
    } else {
      const { callStates: oldCalls, ...oldSource } = batch;
      const { callStates: newCalls, ...newSource } = retained;
      if (oldCalls.length !== newCalls.length || !same(oldSource, newSource))
        throw new Error('Original tool source cannot change.');
    }
  }
}
