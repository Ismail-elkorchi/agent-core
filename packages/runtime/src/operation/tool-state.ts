import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { hashJson } from '@agent-core/evidence';
import {
  decodeOwnedToolEffects,
  decodeOwnedToolObservationForPersistence,
  decodeToolCall,
  effectsConflict,
  encodeToolObservation,
  type ToolCall,
  type ToolEffects,
  type ToolObservation
} from '@agent-core/tools';
import { decodeEffectExecutionState, type EffectExecutionState } from '@agent-core/effects';
import type { AgentApprovalBinding, AgentApprovalRequest, AgentEffectiveInstruction, AgentTurnIdentity } from '../run/contracts.js';

export interface AgentToolPreparationRecord {
  readonly toolImplementationId: string;
  readonly canonicalInput: JsonValue;
  readonly fingerprint: string;
  readonly effects: ToolEffects;
  readonly binding: AgentApprovalBinding;
  readonly authorization: 'allow' | 'deny' | 'require_approval';
  readonly authorizationReason?: string;
}

export interface AgentToolSettlementRecord {
  readonly observationId: string;
  readonly observation: ToolObservation;
  readonly createdAt: string;
}

interface AgentToolBatchBase {
  readonly kind: 'tools';
  readonly identity: AgentTurnIdentity;
  readonly toolBatchId: string;
  readonly calls: readonly ToolCall[];
  readonly callStates: readonly AgentToolCallOperationState[];
  readonly maxConcurrency: number;
  readonly nextProjectionIndex: number;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly modelInputModalities: readonly string[];
}

export type AgentToolCallOperationState =
  | Readonly<{ readonly stage: 'ready'; readonly approved?: Readonly<{ readonly approval: AgentApprovalRequest; readonly decision: 'allow' | 'deny' }> }>
  | Readonly<{ readonly stage: 'effect_ready'; readonly preparation: AgentToolPreparationRecord; readonly toolAttempt: number; readonly effect: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }> }>
  | Readonly<{ readonly stage: 'effect_pending'; readonly preparation: AgentToolPreparationRecord; readonly toolAttempt: number; readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' }> }>
  | Readonly<{ readonly stage: 'settled'; readonly preparation?: AgentToolPreparationRecord; readonly toolAttempt: number; readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' }>; readonly settlement: AgentToolSettlementRecord }>
  | Readonly<{ readonly stage: 'projecting'; readonly preparation?: AgentToolPreparationRecord; readonly toolAttempt: number; readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' }>; readonly settlement: AgentToolSettlementRecord }>
  | Readonly<{ readonly stage: 'projected'; readonly preparation?: AgentToolPreparationRecord; readonly toolAttempt: number; readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' }>; readonly settlement: AgentToolSettlementRecord }>
  | Readonly<{ readonly stage: 'outcome_unknown'; readonly preparation: AgentToolPreparationRecord; readonly toolAttempt: number; readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' | 'closed' }> }>
  | Readonly<{ readonly stage: 'cancelled'; readonly preparation?: AgentToolPreparationRecord; readonly toolAttempt: number; readonly effect?: Extract<EffectExecutionState, { readonly phase: 'closed' }> }>;

export type AgentToolOperationPhase = Readonly<AgentToolBatchBase>;

export type AgentApprovalOperationPhase = Readonly<Omit<AgentToolBatchBase, 'kind'> & {
  readonly kind: 'approval';
  readonly approvalCallIndex: number;
  readonly preparation: AgentToolPreparationRecord;
  readonly approval: AgentApprovalRequest;
}>;

export function decodeToolOperationPhase(value: unknown): AgentToolOperationPhase | AgentApprovalOperationPhase {
  const phase = object(value, 'tool operation phase');
  const kind = enumeration(phase.kind, ['tools', 'approval'] as const, 'phase.kind');
  const common = decodeCommon(phase);
  if (kind === 'approval') {
    exact(phase, [...COMMON_FIELDS, 'kind', 'approvalCallIndex', 'preparation', 'approval']);
    const approvalCallIndex = nonnegativeInteger(phase.approvalCallIndex, 'phase.approvalCallIndex');
    const preparation = decodePreparation(phase.preparation);
    const approval = decodeApproval(phase.approval);
    assertApprovalCall(common, approvalCallIndex, approval.callIndex, approval.callId, approval.toolBatchId, approval.turnIndex, approval.turnId, approval.requestAttempt);
    assertToolDependencies(preparation.effects, approvalCallIndex, common.calls.length);
    if (approval.fingerprint !== preparation.fingerprint || approval.binding.toolImplementationId !== preparation.toolImplementationId) {
      throw new TypeError('Approval identity does not match its prepared tool call.');
    }
    return Object.freeze({ kind, ...common, approvalCallIndex, preparation, approval });
  }
  exact(phase, [...COMMON_FIELDS, 'kind']);
  return Object.freeze({ kind, ...common });
}

function decodeCallState(value: unknown, callIndex: number, callCount: number): AgentToolCallOperationState {
  const state = object(value, `tool call state ${String(callIndex)}`);
  const stage = enumeration(state.stage, ['ready', 'effect_ready', 'effect_pending', 'settled', 'projecting', 'projected', 'outcome_unknown', 'cancelled'] as const, `callStates[${String(callIndex)}].stage`);
  exact(state, ['stage', 'approved', 'preparation', 'toolAttempt', 'effect', 'settlement']);
  if (stage === 'ready') {
    const approved = state.approved === undefined ? undefined : decodeApproved(state.approved);
    if (approved && approved.approval.callIndex !== callIndex) throw new TypeError('Stored approval decision does not match its tool-call index.');
    return Object.freeze({ stage, ...(approved ? { approved } : {}) });
  }
  const toolAttempt = positiveInteger(state.toolAttempt, `callStates[${String(callIndex)}].toolAttempt`);
  const preparation = state.preparation === undefined ? undefined : decodePreparation(state.preparation);
  const effect = state.effect === undefined ? undefined : decodeEffectExecutionState(state.effect);
  if (stage === 'effect_ready') {
    if (!preparation || effect?.phase !== 'ticket_issued') throw new TypeError('An effect-ready tool call requires preparation and an issued ticket.');
    assertToolDependencies(preparation.effects, callIndex, callCount);
    assertEffectMatchesPreparation(effect, preparation);
    return Object.freeze({ stage, preparation, toolAttempt, effect });
  }
  if (stage === 'effect_pending') {
    if (!preparation || effect?.phase !== 'started') throw new TypeError('An effect-pending tool call requires preparation and a started effect.');
    assertToolDependencies(preparation.effects, callIndex, callCount);
    assertEffectMatchesPreparation(effect, preparation);
    return Object.freeze({ stage, preparation, toolAttempt, effect });
  }
  if (stage === 'outcome_unknown') {
    if (!preparation || (effect?.phase !== 'started' && effect?.phase !== 'closed')
      || (effect.phase === 'closed' && effect.closure.reason === 'cancelled_before_start')) {
      throw new TypeError('An unknown tool outcome requires preparation and an outstanding or explicitly closed started effect.');
    }
    assertToolDependencies(preparation.effects, callIndex, callCount);
    assertEffectMatchesPreparation(effect, preparation);
    return Object.freeze({ stage, preparation, toolAttempt, effect });
  }
  if (stage === 'cancelled') {
    if (effect !== undefined && (effect.phase !== 'closed' || effect.closure.reason !== 'cancelled_before_start')) {
      throw new TypeError('A cancelled tool call may retain only an effect closed before start.');
    }
    if (effect && !preparation) throw new TypeError('A cancelled external tool effect requires its preparation record.');
    if (preparation) assertToolDependencies(preparation.effects, callIndex, callCount);
    if (effect && preparation) assertEffectMatchesPreparation(effect, preparation);
    return Object.freeze({ stage, ...(preparation ? { preparation } : {}), toolAttempt, ...(effect ? { effect } : {}) });
  }
  const settlement = decodeAgentToolSettlementRecord(state.settlement);
  if (preparation) assertToolDependencies(preparation.effects, callIndex, callCount);
  if (effect !== undefined && effect.phase !== 'settled') throw new TypeError('A settled tool call may retain only a settled external effect.');
  if (effect && !preparation) throw new TypeError('A settled external tool effect requires its preparation record.');
  if (effect && preparation) assertEffectMatchesPreparation(effect, preparation);
  if (effect?.settlement.outcome === 'unknown') throw new TypeError('A durable tool observation cannot be backed by an unknown effect settlement.');
  if (effect && effect.settlement.resultDigest !== hashJson(encodeToolObservation(settlement.observation))) {
    throw new TypeError('External effect settlement does not match the durable tool observation.');
  }
  return Object.freeze({ stage, ...(preparation ? { preparation } : {}), toolAttempt, ...(effect ? { effect } : {}), settlement });
}

const COMMON_FIELDS = ['identity', 'toolBatchId', 'calls', 'callStates', 'maxConcurrency', 'nextProjectionIndex', 'instructions', 'modelInputModalities'] as const;

function decodeCommon(value: JsonObject): Omit<AgentToolBatchBase, 'kind'> {
  const calls = array(value.calls, 'phase.calls').map((call) => decodeToolCall(call));
  const callStates = array(value.callStates, 'phase.callStates').map((state, index) => decodeCallState(state, index, calls.length));
  if (callStates.length !== calls.length) throw new TypeError('phase.callStates must contain exactly one state per tool call.');
  const maxConcurrency = positiveInteger(value.maxConcurrency, 'phase.maxConcurrency');
  const nextProjectionIndex = nonnegativeInteger(value.nextProjectionIndex, 'phase.nextProjectionIndex');
  if (nextProjectionIndex > calls.length) throw new TypeError('phase.nextProjectionIndex exceeds the tool-call count.');
  for (const [index, state] of callStates.entries()) {
    if (index < nextProjectionIndex && state.stage !== 'projected') throw new TypeError('Every tool call before nextProjectionIndex must be projected.');
    if (index >= nextProjectionIndex && state.stage === 'projected') throw new TypeError('A tool call cannot be projected beyond the contiguous projection prefix.');
  }
  return Object.freeze({
    identity: decodeTurnIdentity(value.identity),
    toolBatchId: identifier(value.toolBatchId, 'phase.toolBatchId'),
    calls: Object.freeze(calls),
    callStates: Object.freeze(callStates),
    maxConcurrency,
    nextProjectionIndex,
    instructions: Object.freeze(array(value.instructions, 'phase.instructions').map((item, index) => decodeInstruction(item, `phase.instructions[${String(index)}]`))),
    modelInputModalities: uniqueStrings(value.modelInputModalities, 'phase.modelInputModalities')
  });
}

export function nextStartableToolCallIndex(phase: AgentToolOperationPhase, driverGeneration: number): number | undefined {
  const active = phase.callStates.flatMap((state, index) => state.stage === 'effect_pending'
    || (state.stage === 'outcome_unknown' && state.effect.phase === 'started')
    ? [{ index, preparation: state.preparation }]
    : []);
  if (active.length >= phase.maxConcurrency) return undefined;
  for (const [index, state] of phase.callStates.entries()) {
    if (state.stage !== 'effect_ready') continue;
    if (state.effect.ticket.driverGeneration !== driverGeneration) continue;
    const dependencies = state.preparation.effects.dependsOnCallIndices ?? [];
    if (dependencies.some((dependency) => {
      const dependencyState = phase.callStates[dependency];
      return dependencyState?.stage !== 'settled' && dependencyState?.stage !== 'projected';
    })) continue;
    if (active.some((running) => effectsConflict(running.preparation.effects, state.preparation.effects))) continue;
    return index;
  }
  return undefined;
}

function assertToolDependencies(effects: ToolEffects, callIndex: number, callCount: number): void {
  for (const dependency of effects.dependsOnCallIndices ?? []) {
    if (dependency >= callIndex || dependency >= callCount) {
      throw new TypeError(`Tool call ${String(callIndex)} has invalid dependency ${String(dependency)}.`);
    }
  }
}

function assertApprovalCall(
  common: Omit<AgentToolBatchBase, 'kind'>,
  approvalCallIndex: number,
  callIndex: number,
  callId: string | undefined,
  toolBatchId: string,
  turnIndex: number,
  turnId: string,
  requestAttempt: number
): void {
  const call = common.calls[approvalCallIndex];
  const state = common.callStates[approvalCallIndex];
  if (!call || state?.stage !== 'ready' || callIndex !== approvalCallIndex || call.id !== callId || toolBatchId !== common.toolBatchId
    || turnIndex !== common.identity.turnIndex || turnId !== common.identity.turnId || requestAttempt !== common.identity.requestAttempt) {
    throw new TypeError('Approval identity does not match its durable tool call.');
  }
}

function assertEffectMatchesPreparation(effect: EffectExecutionState, preparation: AgentToolPreparationRecord): void {
  if (effect.intent.implementationId !== preparation.toolImplementationId || effect.intent.parametersDigest !== preparation.fingerprint) {
    throw new TypeError('External effect intent does not match its prepared tool call.');
  }
}

function decodePreparation(value: unknown): AgentToolPreparationRecord {
  const record = object(value, 'tool preparation');
  exact(record, ['toolImplementationId', 'canonicalInput', 'fingerprint', 'effects', 'binding', 'authorization', 'authorizationReason']);
  const authorizationReason = optionalString(record.authorizationReason, 'preparation.authorizationReason');
  return Object.freeze({
    toolImplementationId: identifier(record.toolImplementationId, 'preparation.toolImplementationId'),
    canonicalInput: parseJsonValue(record.canonicalInput),
    fingerprint: digest(record.fingerprint, 'preparation.fingerprint'),
    effects: decodeOwnedToolEffects(object(record.effects, 'preparation.effects')),
    binding: decodeBinding(record.binding),
    authorization: enumeration(record.authorization, ['allow', 'deny', 'require_approval'] as const, 'preparation.authorization'),
    ...(authorizationReason ? { authorizationReason } : {})
  });
}

export function decodeAgentToolSettlementRecord(value: unknown): AgentToolSettlementRecord {
  const record = object(value, 'tool settlement');
  exact(record, ['observationId', 'observation', 'createdAt']);
  return Object.freeze({
    observationId: identifier(record.observationId, 'settlement.observationId'),
    observation: decodeOwnedToolObservationForPersistence(object(record.observation, 'settlement.observation')),
    createdAt: timestamp(record.createdAt, 'settlement.createdAt')
  });
}

function decodeApproval(value: unknown): AgentApprovalRequest {
  const record = object(value, 'approval request');
  exact(record, ['runId', 'turnIndex', 'turnId', 'requestAttempt', 'toolBatchId', 'callIndex', 'callId', 'approvalId', 'status', 'toolName', 'fingerprint', 'input', 'effects', 'binding', 'policyHash', 'reason']);
  if (record.status !== 'pending') throw new TypeError('approval.status must be pending.');
  const callId = optionalString(record.callId, 'approval.callId');
  return Object.freeze({
    runId: identifier(record.runId, 'approval.runId'),
    ...decodeTurnIdentity(record),
    toolBatchId: identifier(record.toolBatchId, 'approval.toolBatchId'),
    callIndex: nonnegativeInteger(record.callIndex, 'approval.callIndex'),
    ...(callId ? { callId } : {}),
    approvalId: identifier(record.approvalId, 'approval.approvalId'),
    status: 'pending',
    toolName: identifier(record.toolName, 'approval.toolName'),
    fingerprint: digest(record.fingerprint, 'approval.fingerprint'),
    input: parseJsonValue(record.input),
    effects: decodeOwnedToolEffects(object(record.effects, 'approval.effects')),
    binding: decodeBinding(record.binding),
    policyHash: digest(record.policyHash, 'approval.policyHash'),
    reason: nonempty(record.reason, 'approval.reason')
  });
}

function decodeApproved(value: unknown): Readonly<{ readonly approval: AgentApprovalRequest; readonly decision: 'allow' | 'deny' }> {
  const record = object(value, 'approval decision');
  exact(record, ['approval', 'decision']);
  return Object.freeze({ approval: decodeApproval(record.approval), decision: enumeration(record.decision, ['allow', 'deny'] as const, 'approval decision') });
}

function decodeBinding(value: unknown): AgentApprovalBinding {
  const record = object(value, 'approval binding');
  exact(record, ['toolImplementationId', 'authorizationPolicyId', 'executionTargetId']);
  return Object.freeze({
    toolImplementationId: identifier(record.toolImplementationId, 'binding.toolImplementationId'),
    authorizationPolicyId: identifier(record.authorizationPolicyId, 'binding.authorizationPolicyId'),
    executionTargetId: identifier(record.executionTargetId, 'binding.executionTargetId')
  });
}

function decodeInstruction(value: unknown, path: string): AgentEffectiveInstruction {
  const record = object(value, path);
  exact(record, ['id', 'content', 'provenance', 'role', 'sourceUri', 'priority']);
  const role = optionalString(record.role, `${path}.role`);
  const sourceUri = optionalString(record.sourceUri, `${path}.sourceUri`);
  const priority = record.priority === undefined ? undefined : finite(record.priority, `${path}.priority`);
  return Object.freeze({
    id: identifier(record.id, `${path}.id`),
    content: nonempty(record.content, `${path}.content`),
    provenance: enumeration(record.provenance, ['application', 'run', 'steering'] as const, `${path}.provenance`),
    ...(role ? { role } : {}),
    ...(sourceUri ? { sourceUri } : {}),
    ...(priority === undefined ? {} : { priority })
  });
}

function decodeTurnIdentity(value: unknown): AgentTurnIdentity {
  const record = object(value, 'turn identity');
  return Object.freeze({
    turnIndex: positiveInteger(record.turnIndex, 'turnIndex'),
    turnId: identifier(record.turnId, 'turnId'),
    requestAttempt: positiveInteger(record.requestAttempt, 'requestAttempt')
  });
}

function object(value: unknown, label: string): JsonObject {
  try { return parseJsonObject(value, { maxDepth: 24, maxCollectionEntries: 20_000, maxStringBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }); }
  catch (error) { throw new TypeError(`${label} must be bounded JSON object data.`, { cause: error }); }
}
function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`); return value; }
function exact(value: JsonObject, fields: readonly string[]): void { const allowed = new Set(fields); const unknown = Object.keys(value).filter((key) => !allowed.has(key)); if (unknown.length) throw new TypeError(`Unsupported tool operation fields: ${unknown.join(', ')}.`); }
function identifier(value: unknown, label: string): string { if (typeof value !== 'string' || value.trim().length === 0 || hasControlCharacter(value)) throw new TypeError(`${label} must be a non-empty identifier.`); return value; }
function hasControlCharacter(value: string): boolean { for (let index = 0; index < value.length; index += 1) { const unit = value.charCodeAt(index); if (unit <= 31 || unit === 127) return true; } return false; }
function digest(value: unknown, label: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`); return value; }
function nonempty(value: unknown, label: string): string { if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`); return value; }
function optionalString(value: unknown, label: string): string | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`); return value; }
function nonnegativeInteger(value: unknown, label: string): number { if (!Number.isInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a nonnegative integer.`); return Number(value); }
function positiveInteger(value: unknown, label: string): number { const number = nonnegativeInteger(value, label); if (number === 0) throw new TypeError(`${label} must be positive.`); return number; }
function finite(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite.`); return value; }
function timestamp(value: unknown, label: string): string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp.`); return value; }
function uniqueStrings(value: unknown, label: string): readonly string[] { const strings = array(value, label).map((item) => identifier(item, label)); if (new Set(strings).size !== strings.length) throw new TypeError(`${label} must be unique.`); return Object.freeze(strings); }
function enumeration<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] { if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${label} is invalid.`); return value; }
