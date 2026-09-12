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
import { decodeToolPhase, type AgentToolPhase } from './tool-state.js';

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
      readonly toolBatches?: readonly IndexedToolBatch[];
      readonly budget?: AgentRunBudgetState;
    }>;

export interface IndexedProviderRequest {
  readonly index: number;
  readonly value: AgentProviderPhase;
}

export interface IndexedToolBatch {
  readonly index: number;
  readonly value: AgentToolPhase;
}

export function createAgentRunStateTransition(
  previous: AgentRunState | undefined,
  next: AgentRunState
): AgentRunStateTransition {
  if (!previous) return Object.freeze({ kind: 'accepted', state: next });
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
    throw new Error('A run transition must preserve or advance its driver generation exactly once.');

  const providerRequests = indexedChanges(previous.providerRequests, next.providerRequests);
  const toolBatches = indexedChanges(previous.toolBatches, next.toolBatches);
  if (previous.budget !== undefined && next.budget === undefined)
    throw new Error('A run transition cannot remove an accepted budget state.');

  return Object.freeze({
    kind: 'updated',
    runId: next.runId,
    revision: next.revision,
    driverGeneration: next.driverGeneration,
    ...(same(previous.control, next.control) ? {} : { control: next.control }),
    ...(same(previous.phase, next.phase) ? {} : { phase: next.phase }),
    ...(providerRequests.length === 0 ? {} : { providerRequests }),
    ...(toolBatches.length === 0 ? {} : { toolBatches }),
    ...(same(previous.budget, next.budget) || next.budget === undefined ? {} : { budget: next.budget })
  });
}

export function applyAgentRunStateTransition(
  previous: AgentRunState | undefined,
  transition: AgentRunStateTransition
): AgentRunState {
  if (transition.kind === 'accepted') {
    if (previous) throw new Error(`Run ${previous.runId} contains more than one acceptance transition.`);
    return transition.state;
  }
  if (!previous) throw new Error(`Run ${transition.runId} starts without an acceptance transition.`);
  if (
    transition.runId !== previous.runId ||
    transition.revision !== previous.revision + 1 ||
    transition.driverGeneration < previous.driverGeneration ||
    transition.driverGeneration > previous.driverGeneration + 1
  )
    throw new Error(`Run ${transition.runId} contains a non-contiguous transition.`);
  const budget = transition.budget ?? previous.budget;
  return decodeAgentRunState({
    ...previous,
    revision: transition.revision,
    driverGeneration: transition.driverGeneration,
    control: transition.control ?? previous.control,
    phase: transition.phase ?? previous.phase,
    providerRequests: applyIndexed(previous.providerRequests, transition.providerRequests),
    toolBatches: applyIndexed(previous.toolBatches, transition.toolBatches),
    ...(budget === undefined ? {} : { budget })
  });
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
    return Object.freeze({ kind: 'accepted', state: decodeAgentRunState(object.state) });
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
    'toolBatches',
    'budget'
  ]);
  const runId = identifier(object.runId, 'runId');
  const revision = nonnegativeInteger(object.revision, 'revision');
  const driverGeneration = nonnegativeInteger(object.driverGeneration, 'driverGeneration');
  const control = object.control === undefined ? undefined : decodeAgentRunControl(object.control);
  const phase = object.phase === undefined ? undefined : decodeAgentRunControlPhase(object.phase);
  const providerRequests = decodeIndexed(object.providerRequests, decodeProviderPhase, 'providerRequests');
  const toolBatches = decodeIndexed(object.toolBatches, decodeToolPhase, 'toolBatches');
  const budget = object.budget === undefined ? undefined : decodeAgentRunBudgetState(object.budget);
  return Object.freeze({
    kind: 'updated',
    runId,
    revision,
    driverGeneration,
    ...(control ? { control } : {}),
    ...(phase ? { phase } : {}),
    ...(providerRequests ? { providerRequests } : {}),
    ...(toolBatches ? { toolBatches } : {}),
    ...(budget ? { budget } : {})
  });
}

function indexedChanges<T>(previous: readonly T[], next: readonly T[]): readonly { index: number; value: T }[] {
  if (next.length < previous.length) throw new Error('Run work collections cannot shrink.');
  const changes: { index: number; value: T }[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const value = next[index];
    if (value !== undefined && !same(previous[index], value)) changes.push(Object.freeze({ index, value }));
  }
  return Object.freeze(changes);
}

function applyIndexed<T>(
  previous: readonly T[],
  changes: readonly { readonly index: number; readonly value: T }[] | undefined
): readonly T[] {
  if (!changes) return previous;
  const next = [...previous];
  for (const change of changes) {
    if (change.index > next.length) throw new Error('Run collection transition has a positional gap.');
    next[change.index] = change.value;
  }
  return Object.freeze(next);
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
  return left === right || (left !== undefined && right !== undefined && hashJson(left) === hashJson(right));
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
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}
