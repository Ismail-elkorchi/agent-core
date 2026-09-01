import { normalizeJsonSafe, parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { decodeEffectExecutionState, decodeEffectRecoveryCapability, type EffectExecutionState } from '@agent-core/effects';
import { hashJson } from '@agent-core/persistence';
import { decodeAgentRunBudgetState, type AgentRunBudgetState, type AgentTurnIdentity } from '../../contracts.js';
import { parseAgentDispositionDecision, type AgentDispositionDecision } from './contracts.js';

export interface AgentDispositionEffectPlanRecord {
  readonly implementationId: string;
  readonly fingerprint: string;
  readonly authorization: JsonValue;
  readonly recovery: import('@agent-core/effects').EffectRecoveryCapability;
}

interface AgentDispositionPhaseBase {
  readonly kind: 'disposition';
  readonly identity: AgentTurnIdentity;
  readonly providerSettlementEventId: string;
  readonly modelOutputEventId: string;
  readonly verificationEventIds: readonly string[];
  readonly inputDigest: string;
  readonly revisionCount: number;
  readonly controlSnapshot: Readonly<{ readonly status: 'owned'; readonly driverGeneration: number }>;
  readonly budgetSnapshot: AgentRunBudgetState;
}

export type AgentDispositionPhase =
  | Readonly<AgentDispositionPhaseBase & { readonly stage: 'ready' }>
  | Readonly<AgentDispositionPhaseBase & { readonly stage: 'effect_ready'; readonly plan: AgentDispositionEffectPlanRecord; readonly effect: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }> }>
  | Readonly<AgentDispositionPhaseBase & { readonly stage: 'effect_pending'; readonly plan: AgentDispositionEffectPlanRecord; readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' }> }>
  | Readonly<AgentDispositionPhaseBase & { readonly stage: 'outcome_unknown'; readonly plan: AgentDispositionEffectPlanRecord; readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' | 'closed' }> }>
  | Readonly<AgentDispositionPhaseBase & { readonly stage: 'decided'; readonly decision: AgentDispositionDecision; readonly decisionEventId: string; readonly outputDigest: string; readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' }> }>;

const BASE_FIELDS = ['kind', 'stage', 'identity', 'providerSettlementEventId', 'modelOutputEventId', 'verificationEventIds', 'inputDigest', 'revisionCount', 'controlSnapshot', 'budgetSnapshot'] as const;

export function decodeDispositionPhase(value: unknown): AgentDispositionPhase {
  const phase = object(value, 'disposition phase');
  const stage = enumeration(phase.stage, ['ready', 'effect_ready', 'effect_pending', 'outcome_unknown', 'decided'] as const, 'disposition.stage');
  const base = {
    kind: 'disposition' as const,
    identity: decodeTurnIdentity(phase.identity),
    providerSettlementEventId: identifier(phase.providerSettlementEventId, 'disposition.providerSettlementEventId'),
    modelOutputEventId: identifier(phase.modelOutputEventId, 'disposition.modelOutputEventId'),
    verificationEventIds: uniqueIdentifiers(phase.verificationEventIds, 'disposition.verificationEventIds'),
    inputDigest: digest(phase.inputDigest, 'disposition.inputDigest'),
    revisionCount: nonnegativeInteger(phase.revisionCount, 'disposition.revisionCount'),
    controlSnapshot: decodeControlSnapshot(phase.controlSnapshot),
    budgetSnapshot: decodeAgentRunBudgetState(phase.budgetSnapshot)
  };
  if (base.budgetSnapshot.revisionAttempts !== base.revisionCount) throw new TypeError('Disposition budget snapshot contradicts its revision count.');
  if (stage === 'ready') {
    exact(phase, BASE_FIELDS);
    return Object.freeze({ ...base, stage });
  }
  if (stage === 'decided') {
    exact(phase, [...BASE_FIELDS, 'decision', 'decisionEventId', 'outputDigest', 'effect']);
    const effect = phase.effect === undefined ? undefined : decodeEffectExecutionState(phase.effect);
    if (effect !== undefined && effect.phase !== 'settled') throw new TypeError('A decided disposition may retain only a settled effect.');
    const decision = parseAgentDispositionDecision(phase.decision);
    const outputDigest = digest(phase.outputDigest, 'disposition.outputDigest');
    if (hashJson(decision) !== outputDigest) throw new TypeError('Disposition output digest does not match its decision.');
    if (effect && (effect.settlement.outcome !== 'succeeded'
      || effect.settlement.resultDigest !== outputDigest
      || effect.settlement.exposure.status !== 'known'
      || effect.settlement.exposure.quantities.length !== 0)) {
      throw new TypeError('Disposition effect settlement does not match its decision output.');
    }
    return Object.freeze({
      ...base,
      stage,
      decision,
      decisionEventId: identifier(phase.decisionEventId, 'disposition.decisionEventId'),
      outputDigest,
      ...(effect ? { effect } : {})
    });
  }
  exact(phase, [...BASE_FIELDS, 'plan', 'effect']);
  const plan = decodeEffectPlan(phase.plan, base.inputDigest);
  const effect = decodeEffectExecutionState(phase.effect);
  if (effect.intent.implementationId !== plan.implementationId || effect.intent.parametersDigest !== plan.fingerprint) {
    throw new TypeError('Disposition effect does not match its plan.');
  }
  if (stage === 'effect_ready') {
    if (effect.phase !== 'ticket_issued') throw new TypeError('An effect-ready disposition requires an issued ticket.');
    return Object.freeze({ ...base, stage, plan, effect });
  }
  if (stage === 'effect_pending') {
    if (effect.phase !== 'started') throw new TypeError('An effect-pending disposition requires a started effect.');
    return Object.freeze({ ...base, stage, plan, effect });
  }
  if (effect.phase !== 'started' && effect.phase !== 'closed') throw new TypeError('An unknown disposition outcome requires a started or closed effect.');
  if (effect.phase === 'closed' && effect.closure.reason === 'cancelled_before_start') throw new TypeError('An unknown disposition effect must have been started.');
  return Object.freeze({ ...base, stage, plan, effect });
}

function decodeEffectPlan(value: unknown, inputDigest: string): AgentDispositionEffectPlanRecord {
  const plan = object(value, 'disposition plan');
  exact(plan, ['implementationId', 'fingerprint', 'authorization', 'recovery']);
  const decoded = Object.freeze({
    implementationId: identifier(plan.implementationId, 'disposition plan implementationId'),
    fingerprint: digest(plan.fingerprint, 'disposition plan fingerprint'),
    authorization: parseJsonValue(plan.authorization),
    recovery: decodeEffectRecoveryCapability(plan.recovery)
  });
  const fingerprint = hashJson(normalizeJsonSafe(Object.freeze({ implementationId: decoded.implementationId, inputDigest, authorization: decoded.authorization, recovery: decoded.recovery })).value);
  if (fingerprint !== decoded.fingerprint) throw new TypeError('Disposition plan fingerprint does not match its captured intent.');
  return decoded;
}

function decodeTurnIdentity(value: unknown): AgentTurnIdentity {
  const identity = object(value, 'disposition identity');
  exact(identity, ['turnIndex', 'turnId', 'requestAttempt']);
  return Object.freeze({
    turnIndex: positiveInteger(identity.turnIndex, 'disposition.turnIndex'),
    turnId: identifier(identity.turnId, 'disposition.turnId'),
    requestAttempt: positiveInteger(identity.requestAttempt, 'disposition.requestAttempt')
  });
}

function decodeControlSnapshot(value: unknown): Readonly<{ readonly status: 'owned'; readonly driverGeneration: number }> {
  const control = object(value, 'disposition control snapshot');
  exact(control, ['status', 'driverGeneration']);
  if (control.status !== 'owned') throw new TypeError('Disposition control snapshot must be owned.');
  return Object.freeze({ status: control.status, driverGeneration: nonnegativeInteger(control.driverGeneration, 'disposition control driverGeneration') });
}

function object(value: unknown, label: string): JsonObject {
  try { return parseJsonObject(value); }
  catch (error) { throw new TypeError(`${label} must be an object.`, { cause: error }); }
}

function exact(value: JsonObject, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) throw new TypeError(`Disposition state has unsupported fields: ${unsupported.join(', ')}.`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > 256) throw new TypeError(`${label} must be a bounded identity.`);
  return value;
}

function digest(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return value;
}

function nonnegativeInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative integer.`);
  return value;
}

function positiveInteger(value: JsonValue | undefined, label: string): number {
  const parsed = nonnegativeInteger(value, label);
  if (parsed === 0) throw new TypeError(`${label} must be positive.`);
  return parsed;
}

function uniqueIdentifiers(value: JsonValue | undefined, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const output = value.map((item, index) => identifier(item, `${label}[${String(index)}]`));
  if (new Set(output).size !== output.length) throw new TypeError(`${label} must contain unique identities.`);
  return Object.freeze(output);
}

function enumeration<const T extends readonly string[]>(value: JsonValue | undefined, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.some((modelOutput) => modelOutput === value)) throw new TypeError(`${label} is invalid.`);
  return value;
}
