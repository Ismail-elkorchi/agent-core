import { parseJsonObject, parseJsonValue, type JsonValue } from '@agent-core/json';
import { decodeEffectRecoveryCapability, type EffectRecoveryCapability } from '@agent-core/effects';
import type { AgentCandidate, AgentCheckResult, AgentRunBudgetState } from '../../run/contracts.js';

export type AgentDispositionDecision =
  | Readonly<{ readonly kind: 'accept' }>
  | Readonly<{ readonly kind: 'revise'; readonly instruction: string }>
  | Readonly<{ readonly kind: 'fail'; readonly reason: string }>
  | Readonly<{ readonly kind: 'inconclusive'; readonly reason: string }>;

export interface AgentDispositionInput {
  readonly candidate: AgentCandidate;
  readonly checkResults: readonly AgentCheckResult[];
  readonly budget: AgentRunBudgetState;
  readonly control: Readonly<{
    readonly status: 'owned';
    readonly driverGeneration: number;
  }>;
  readonly policyIdentity: JsonValue;
  readonly receipts: Readonly<{
    readonly providerSettlementEventId: string;
    readonly candidateEventId: string;
    readonly verificationEventIds: readonly string[];
  }>;
}

interface AgentDispositionPolicyBase {
  /** Stable identity for the admitted evaluator implementation and semantics. */
  readonly implementationId: string;
  /** Canonical configuration consumed by the evaluator and captured with the operation. */
  readonly policyIdentity: JsonValue;
}

export interface AgentDeterministicDispositionPolicy extends AgentDispositionPolicyBase {
  readonly kind: 'deterministic';
  readonly evaluate: (input: AgentDispositionInput) => AgentDispositionDecision;
}

export interface AgentEffectDispositionPolicy extends AgentDispositionPolicyBase {
  readonly kind: 'effect';
  /**
   * Returns a non-accepting decision when disposition needs no external side
   * effect, or a prepared effect. Acceptance must cross the prepared effect
   * boundary because an effect policy owns candidate publication.
   */
  readonly prepare: (input: AgentDispositionInput) => AgentDispositionDecision | AgentPreparedDispositionEffect | Promise<AgentDispositionDecision | AgentPreparedDispositionEffect>;
}

export type AgentDispositionPolicy = AgentDeterministicDispositionPolicy | AgentEffectDispositionPolicy;

export type AgentDispositionEffectReconciliation =
  | Readonly<{ readonly status: 'settled'; readonly decision: AgentDispositionDecision }>
  | Readonly<{ readonly status: 'running' | 'unknown' | 'expired' }>;

export interface AgentPreparedDispositionEffect {
  readonly authorization: JsonValue;
  readonly recovery: EffectRecoveryCapability;
  start(signal: AbortSignal): Promise<AgentDispositionDecision>;
  reconcile(signal: AbortSignal): Promise<AgentDispositionEffectReconciliation>;
  release(): Promise<void>;
}

export interface AgentPreparedDispositionEffectInput {
  readonly authorization: JsonValue;
  readonly recovery: EffectRecoveryCapability;
  readonly start: (signal: AbortSignal) => Promise<AgentDispositionDecision>;
  readonly reconcile: (signal: AbortSignal) => Promise<AgentDispositionEffectReconciliation>;
  readonly release: () => Promise<void>;
}

const PREPARED_DISPOSITION_EFFECTS = new WeakSet();
const MAX_DECISION_TEXT_BYTES = 32 * 1024;

export const ACCEPT_CANDIDATE_DISPOSITION: AgentDeterministicDispositionPolicy = Object.freeze({
  kind: 'deterministic',
  implementationId: 'agent-core.disposition.accept-v1',
  policyIdentity: Object.freeze({ strategy: 'accept' }),
  evaluate: () => Object.freeze({ kind: 'accept' })
});

export function validateAgentDispositionPolicy(policy: AgentDispositionPolicy | undefined): AgentDispositionPolicy {
  const candidate = policy ?? ACCEPT_CANDIDATE_DISPOSITION;
  const kind: string = candidate.kind;
  if (!validIdentity(candidate.implementationId)) throw new TypeError('Disposition implementationId must be a non-empty bounded identity.');
  const policyIdentity = parseJsonValue(candidate.policyIdentity);
  if (kind === 'deterministic' && candidate.kind === 'deterministic') {
    if (typeof candidate.evaluate !== 'function') throw new TypeError('A deterministic disposition policy requires evaluate().');
    return Object.freeze({ kind: candidate.kind, implementationId: candidate.implementationId, policyIdentity, evaluate: candidate.evaluate });
  }
  if (kind !== 'effect' || candidate.kind !== 'effect' || typeof candidate.prepare !== 'function') throw new TypeError('Disposition policy kind must be deterministic or effect.');
  return Object.freeze({ kind: candidate.kind, implementationId: candidate.implementationId, policyIdentity, prepare: candidate.prepare });
}

export function parseAgentDispositionDecision(value: unknown): AgentDispositionDecision {
  const decision = parseJsonObject(value, { maxDepth: 4, maxCollectionEntries: 8, maxStringBytes: MAX_DECISION_TEXT_BYTES, maxTotalBytes: MAX_DECISION_TEXT_BYTES + 1024 });
  if (decision.kind === 'accept') {
    exact(decision, ['kind']);
    return Object.freeze({ kind: decision.kind });
  }
  if (decision.kind === 'revise') {
    exact(decision, ['kind', 'instruction']);
    return Object.freeze({ kind: decision.kind, instruction: decisionText(decision.instruction, 'instruction') });
  }
  if (decision.kind === 'fail' || decision.kind === 'inconclusive') {
    exact(decision, ['kind', 'reason']);
    return Object.freeze({ kind: decision.kind, reason: decisionText(decision.reason, 'reason') });
  }
  throw new TypeError('Disposition decision kind must be accept, revise, fail, or inconclusive.');
}

export function parseAgentDispositionEffectReconciliation(value: unknown): AgentDispositionEffectReconciliation {
  const reconciliation = parseJsonObject(value, { maxDepth: 5, maxCollectionEntries: 10, maxStringBytes: MAX_DECISION_TEXT_BYTES, maxTotalBytes: MAX_DECISION_TEXT_BYTES + 2048 });
  if (reconciliation.status === 'settled') {
    exact(reconciliation, ['status', 'decision']);
    return Object.freeze({ status: reconciliation.status, decision: parseAgentDispositionDecision(reconciliation.decision) });
  }
  if (reconciliation.status === 'running' || reconciliation.status === 'unknown' || reconciliation.status === 'expired') {
    exact(reconciliation, ['status']);
    return Object.freeze({ status: reconciliation.status });
  }
  throw new TypeError('Disposition reconciliation status must be settled, running, unknown, or expired.');
}

export function createAgentPreparedDispositionEffect(input: AgentPreparedDispositionEffectInput): AgentPreparedDispositionEffect {
  if (typeof input.start !== 'function' || typeof input.reconcile !== 'function' || typeof input.release !== 'function') {
    throw new TypeError('Prepared disposition effect requires start, reconcile, and release operations.');
  }
  const prepared = Object.freeze({
    authorization: parseJsonValue(input.authorization),
    recovery: decodeEffectRecoveryCapability(input.recovery),
    start: input.start,
    reconcile: input.reconcile,
    release: input.release
  });
  PREPARED_DISPOSITION_EFFECTS.add(prepared);
  return prepared;
}

export function isAgentPreparedDispositionEffect(value: unknown): value is AgentPreparedDispositionEffect {
  return typeof value === 'object' && value !== null && PREPARED_DISPOSITION_EFFECTS.has(value);
}

function decisionText(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`Disposition ${field} must be non-empty.`);
  if (new TextEncoder().encode(value).byteLength > MAX_DECISION_TEXT_BYTES) throw new TypeError(`Disposition ${field} exceeds ${String(MAX_DECISION_TEXT_BYTES)} bytes.`);
  return value;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) throw new TypeError(`Disposition decision has unsupported fields: ${unsupported.join(', ')}.`);
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 256;
}
