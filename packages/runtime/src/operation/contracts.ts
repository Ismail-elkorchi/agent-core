import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { AgentRunBudgetState, AgentTurnIdentity } from '../run/contracts.js';
import { decodeContextItemInput, type ContextItemInput } from '../context/manager.js';

export interface AgentOperationInput {
  readonly task: string;
  readonly instructions: readonly string[];
  readonly contextItems: readonly ContextItemInput[];
}

export interface AgentOperationConfiguration {
  readonly providerId: string;
  readonly model: string;
  readonly runtimeImplementationId: string;
  readonly toolImplementationIds: readonly string[];
  readonly checkIds: readonly string[];
  readonly policyHash: string;
}

export type AgentOperationControl =
  | Readonly<{ readonly status: 'detached' }>
  | Readonly<{ readonly status: 'owned'; readonly driverId: string }>
  | Readonly<{ readonly status: 'abort_requested'; readonly driverId?: string; readonly reason: string }>;

export type AgentOperationPhase =
  | Readonly<{ readonly kind: 'accepted' }>
  | Readonly<{ readonly kind: 'preparing'; readonly step: 'initialize' | 'assemble_turn'; readonly turnIndex: number }>
  | Readonly<{
      readonly kind: 'provider';
      readonly stage: 'ready' | 'effect_pending' | 'settled' | 'outcome_unknown';
      readonly identity: AgentTurnIdentity;
      readonly requestEventId?: string;
      readonly effectId?: string;
      readonly responseEventId?: string;
    }>
  | Readonly<{
      readonly kind: 'tools';
      readonly stage: 'ready' | 'effect_pending' | 'settled' | 'projecting' | 'complete';
      readonly identity: AgentTurnIdentity;
      readonly toolBatchId: string;
      readonly callCount: number;
      readonly nextCallIndex: number;
      readonly effectId?: string;
      readonly settlementEventId?: string;
    }>
  | Readonly<{
      readonly kind: 'approval';
      readonly identity: AgentTurnIdentity;
      readonly toolBatchId: string;
      readonly callCount: number;
      readonly nextCallIndex: number;
      readonly pendingApprovalIds: readonly string[];
    }>
  | Readonly<{
      readonly kind: 'verification';
      readonly stage: 'ready' | 'effect_pending' | 'settled' | 'complete';
      readonly checkIds: readonly string[];
      readonly nextCheckIndex: number;
      readonly effectId?: string;
      readonly resultEventId?: string;
    }>
  | Readonly<{
      readonly kind: 'disposition';
      readonly stage: 'ready' | 'decided';
      readonly candidateEventId: string;
      readonly verificationEventIds: readonly string[];
      readonly decisionEventId?: string;
    }>
  | Readonly<{
      readonly kind: 'finalization';
      readonly stage: 'ready' | 'prepared' | 'session_projected' | 'committed';
      readonly terminalEventId?: string;
    }>
  | Readonly<{
      readonly kind: 'suspended';
      readonly reason: 'approval_required' | 'provider_outcome_unknown' | 'tool_outcome_unknown' | 'missing_implementation' | 'user_decision';
      readonly effectId?: string;
      readonly pendingApprovalIds?: readonly string[];
    }>
  | Readonly<{ readonly kind: 'cancelling'; readonly stage: 'requested' | 'finalizing' }>
  | Readonly<{ readonly kind: 'terminal'; readonly resultEventId: string }>;

export interface AgentOperationState {
  readonly runId: string;
  readonly finalizationId: string;
  readonly revision: number;
  readonly driverGeneration: number;
  readonly input: AgentOperationInput;
  readonly configuration: AgentOperationConfiguration;
  readonly control: AgentOperationControl;
  readonly phase: AgentOperationPhase;
  readonly budget?: AgentRunBudgetState;
}

export type AgentOperationProcedure =
  | 'prepare'
  | 'assemble_turn'
  | 'prepare_provider_request'
  | 'reconcile_provider_request'
  | 'consume_provider_settlement'
  | 'prepare_tool_call'
  | 'reconcile_tool_call'
  | 'consume_tool_settlement'
  | 'project_tool_settlement'
  | 'advance_after_tools'
  | 'prepare_verification'
  | 'reconcile_verification'
  | 'consume_verification_settlement'
  | 'decide_candidate'
  | 'finalize'
  | 'reconcile_finalization'
  | 'finalize_abort';

export type AgentOperationInstruction =
  | Readonly<{ readonly kind: 'execute'; readonly procedure: AgentOperationProcedure }>
  | Readonly<{ readonly kind: 'wait'; readonly reason: 'approval' | 'external_outcome' | 'user_decision' | 'driver' }>
  | Readonly<{ readonly kind: 'complete' }>;

export function nextAgentOperationInstruction(state: AgentOperationState): AgentOperationInstruction {
  if (state.phase.kind === 'terminal') return Object.freeze({ kind: 'complete' });
  if (state.control.status === 'detached') return Object.freeze({ kind: 'wait', reason: 'driver' });
  if (state.control.status === 'abort_requested') return Object.freeze({ kind: 'execute', procedure: 'finalize_abort' });
  switch (state.phase.kind) {
    case 'accepted': return Object.freeze({ kind: 'execute', procedure: 'prepare' });
    case 'preparing': return Object.freeze({ kind: 'execute', procedure: state.phase.step === 'initialize' ? 'prepare' : 'assemble_turn' });
    case 'provider':
      if (state.phase.stage === 'ready') return Object.freeze({ kind: 'execute', procedure: 'prepare_provider_request' });
      if (state.phase.stage === 'effect_pending') return Object.freeze({ kind: 'execute', procedure: 'reconcile_provider_request' });
      if (state.phase.stage === 'settled') return Object.freeze({ kind: 'execute', procedure: 'consume_provider_settlement' });
      return Object.freeze({ kind: 'wait', reason: 'external_outcome' });
    case 'tools':
      if (state.phase.stage === 'ready') return Object.freeze({ kind: 'execute', procedure: 'prepare_tool_call' });
      if (state.phase.stage === 'effect_pending') return Object.freeze({ kind: 'execute', procedure: 'reconcile_tool_call' });
      if (state.phase.stage === 'settled') return Object.freeze({ kind: 'execute', procedure: 'consume_tool_settlement' });
      if (state.phase.stage === 'projecting') return Object.freeze({ kind: 'execute', procedure: 'project_tool_settlement' });
      return Object.freeze({ kind: 'execute', procedure: 'advance_after_tools' });
    case 'approval': return Object.freeze({ kind: 'wait', reason: 'approval' });
    case 'verification':
      if (state.phase.stage === 'ready') return Object.freeze({ kind: 'execute', procedure: 'prepare_verification' });
      if (state.phase.stage === 'effect_pending') return Object.freeze({ kind: 'execute', procedure: 'reconcile_verification' });
      return Object.freeze({ kind: 'execute', procedure: 'consume_verification_settlement' });
    case 'disposition': return Object.freeze({ kind: 'execute', procedure: 'decide_candidate' });
    case 'finalization': return Object.freeze({ kind: 'execute', procedure: state.phase.stage === 'ready' ? 'finalize' : 'reconcile_finalization' });
    case 'suspended':
      return Object.freeze({ kind: 'wait', reason: state.phase.reason === 'approval_required' ? 'approval' : state.phase.reason === 'user_decision' || state.phase.reason === 'missing_implementation' ? 'user_decision' : 'external_outcome' });
    case 'cancelling': return Object.freeze({ kind: 'execute', procedure: 'finalize_abort' });
  }
}

export function decodeAgentOperationState(value: unknown): AgentOperationState {
  let state: JsonObject;
  try { state = parseJsonObject(value, { maxDepth: 18, maxCollectionEntries: 20_000, maxStringBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }); }
  catch (error) { throw new TypeError('operation state is invalid.', { cause: error }); }
  exact(state, ['runId', 'finalizationId', 'revision', 'driverGeneration', 'input', 'configuration', 'control', 'phase', 'budget']);
  const input = decodeInput(state.input);
  const configuration = decodeConfiguration(state.configuration);
  const control = decodeControl(state.control);
  const phase = decodePhase(state.phase);
  const budget = state.budget === undefined ? undefined : decodeBudget(state.budget);
  return Object.freeze({
    runId: identifier(state.runId, 'runId'),
    finalizationId: identifier(state.finalizationId, 'finalizationId'),
    revision: nonnegativeInteger(state.revision, 'revision'),
    driverGeneration: nonnegativeInteger(state.driverGeneration, 'driverGeneration'),
    input,
    configuration,
    control,
    phase,
    ...(budget === undefined ? {} : { budget })
  });
}

function decodeInput(value: unknown): AgentOperationInput {
  const input = object(value, 'operation input');
  exact(input, ['task', 'instructions', 'contextItems']);
  return Object.freeze({
    task: nonempty(input.task, 'task'),
    instructions: stringArray(input.instructions, 'instructions'),
    contextItems: Object.freeze(array(input.contextItems, 'contextItems').map((item) => decodeContextItemInput(item)))
  });
}

function decodeConfiguration(value: unknown): AgentOperationConfiguration {
  const configuration = object(value, 'operation configuration');
  exact(configuration, ['providerId', 'model', 'runtimeImplementationId', 'toolImplementationIds', 'checkIds', 'policyHash']);
  return Object.freeze({
    providerId: identifier(configuration.providerId, 'providerId'),
    model: nonempty(configuration.model, 'model'),
    runtimeImplementationId: identifier(configuration.runtimeImplementationId, 'runtimeImplementationId'),
    toolImplementationIds: uniqueIdentifiers(configuration.toolImplementationIds, 'toolImplementationIds'),
    checkIds: uniqueIdentifiers(configuration.checkIds, 'checkIds'),
    policyHash: nonempty(configuration.policyHash, 'policyHash')
  });
}

function decodeControl(value: unknown): AgentOperationControl {
  const control = object(value, 'operation control');
  const status = enumeration(control.status, ['detached', 'owned', 'abort_requested'] as const, 'control.status');
  if (status === 'detached') {
    exact(control, ['status']);
    return Object.freeze({ status });
  }
  if (status === 'owned') {
    exact(control, ['status', 'driverId']);
    return Object.freeze({ status, driverId: identifier(control.driverId, 'control.driverId') });
  }
  exact(control, ['status', 'driverId', 'reason']);
  const driverId = control.driverId === undefined ? undefined : identifier(control.driverId, 'control.driverId');
  return Object.freeze({ status, ...(driverId === undefined ? {} : { driverId }), reason: nonempty(control.reason, 'control.reason') });
}

function decodePhase(value: unknown): AgentOperationPhase {
  const phase = object(value, 'operation phase');
  const kind = enumeration(phase.kind, ['accepted', 'preparing', 'provider', 'tools', 'approval', 'verification', 'disposition', 'finalization', 'suspended', 'cancelling', 'terminal'] as const, 'phase.kind');
  switch (kind) {
    case 'accepted':
      exact(phase, ['kind']);
      return Object.freeze({ kind });
    case 'preparing':
      exact(phase, ['kind', 'step', 'turnIndex']);
      return Object.freeze({ kind, step: enumeration(phase.step, ['initialize', 'assemble_turn'] as const, 'phase.step'), turnIndex: positiveInteger(phase.turnIndex, 'phase.turnIndex') });
    case 'provider': {
      exact(phase, ['kind', 'stage', 'identity', 'requestEventId', 'effectId', 'responseEventId']);
      const requestEventId = optionalIdentifier(phase.requestEventId, 'phase.requestEventId');
      const effectId = optionalIdentifier(phase.effectId, 'phase.effectId');
      const responseEventId = optionalIdentifier(phase.responseEventId, 'phase.responseEventId');
      return Object.freeze({ kind, stage: enumeration(phase.stage, ['ready', 'effect_pending', 'settled', 'outcome_unknown'] as const, 'phase.stage'), identity: decodeTurnIdentity(phase.identity), ...(requestEventId ? { requestEventId } : {}), ...(effectId ? { effectId } : {}), ...(responseEventId ? { responseEventId } : {}) });
    }
    case 'tools': {
      exact(phase, ['kind', 'stage', 'identity', 'toolBatchId', 'callCount', 'nextCallIndex', 'effectId', 'settlementEventId']);
      const callCount = nonnegativeInteger(phase.callCount, 'phase.callCount');
      const nextCallIndex = nonnegativeInteger(phase.nextCallIndex, 'phase.nextCallIndex');
      if (nextCallIndex > callCount) throw new TypeError('phase.nextCallIndex exceeds phase.callCount.');
      const effectId = optionalIdentifier(phase.effectId, 'phase.effectId');
      const settlementEventId = optionalIdentifier(phase.settlementEventId, 'phase.settlementEventId');
      return Object.freeze({ kind, stage: enumeration(phase.stage, ['ready', 'effect_pending', 'settled', 'projecting', 'complete'] as const, 'phase.stage'), identity: decodeTurnIdentity(phase.identity), toolBatchId: identifier(phase.toolBatchId, 'phase.toolBatchId'), callCount, nextCallIndex, ...(effectId ? { effectId } : {}), ...(settlementEventId ? { settlementEventId } : {}) });
    }
    case 'approval':
      exact(phase, ['kind', 'identity', 'toolBatchId', 'callCount', 'nextCallIndex', 'pendingApprovalIds']);
      {
        const callCount = positiveInteger(phase.callCount, 'phase.callCount');
        const nextCallIndex = nonnegativeInteger(phase.nextCallIndex, 'phase.nextCallIndex');
        if (nextCallIndex >= callCount) throw new TypeError('phase.nextCallIndex must identify a call in phase.callCount.');
        return Object.freeze({ kind, identity: decodeTurnIdentity(phase.identity), toolBatchId: identifier(phase.toolBatchId, 'phase.toolBatchId'), callCount, nextCallIndex, pendingApprovalIds: nonemptyUniqueIdentifiers(phase.pendingApprovalIds, 'phase.pendingApprovalIds') });
      }
    case 'verification': {
      exact(phase, ['kind', 'stage', 'checkIds', 'nextCheckIndex', 'effectId', 'resultEventId']);
      const checkIds = uniqueIdentifiers(phase.checkIds, 'phase.checkIds');
      const nextCheckIndex = nonnegativeInteger(phase.nextCheckIndex, 'phase.nextCheckIndex');
      if (nextCheckIndex > checkIds.length) throw new TypeError('phase.nextCheckIndex exceeds phase.checkIds length.');
      const effectId = optionalIdentifier(phase.effectId, 'phase.effectId');
      const resultEventId = optionalIdentifier(phase.resultEventId, 'phase.resultEventId');
      return Object.freeze({ kind, stage: enumeration(phase.stage, ['ready', 'effect_pending', 'settled', 'complete'] as const, 'phase.stage'), checkIds, nextCheckIndex, ...(effectId ? { effectId } : {}), ...(resultEventId ? { resultEventId } : {}) });
    }
    case 'disposition': {
      exact(phase, ['kind', 'stage', 'candidateEventId', 'verificationEventIds', 'decisionEventId']);
      const decisionEventId = optionalIdentifier(phase.decisionEventId, 'phase.decisionEventId');
      return Object.freeze({ kind, stage: enumeration(phase.stage, ['ready', 'decided'] as const, 'phase.stage'), candidateEventId: identifier(phase.candidateEventId, 'phase.candidateEventId'), verificationEventIds: uniqueIdentifiers(phase.verificationEventIds, 'phase.verificationEventIds'), ...(decisionEventId ? { decisionEventId } : {}) });
    }
    case 'finalization': {
      exact(phase, ['kind', 'stage', 'terminalEventId']);
      const terminalEventId = optionalIdentifier(phase.terminalEventId, 'phase.terminalEventId');
      return Object.freeze({ kind, stage: enumeration(phase.stage, ['ready', 'prepared', 'session_projected', 'committed'] as const, 'phase.stage'), ...(terminalEventId ? { terminalEventId } : {}) });
    }
    case 'suspended': {
      exact(phase, ['kind', 'reason', 'effectId', 'pendingApprovalIds']);
      const effectId = optionalIdentifier(phase.effectId, 'phase.effectId');
      const pendingApprovalIds = phase.pendingApprovalIds === undefined ? undefined : nonemptyUniqueIdentifiers(phase.pendingApprovalIds, 'phase.pendingApprovalIds');
      return Object.freeze({ kind, reason: enumeration(phase.reason, ['approval_required', 'provider_outcome_unknown', 'tool_outcome_unknown', 'missing_implementation', 'user_decision'] as const, 'phase.reason'), ...(effectId ? { effectId } : {}), ...(pendingApprovalIds ? { pendingApprovalIds } : {}) });
    }
    case 'cancelling':
      exact(phase, ['kind', 'stage']);
      return Object.freeze({ kind, stage: enumeration(phase.stage, ['requested', 'finalizing'] as const, 'phase.stage') });
    case 'terminal':
      exact(phase, ['kind', 'resultEventId']);
      return Object.freeze({ kind, resultEventId: identifier(phase.resultEventId, 'phase.resultEventId') });
  }
}

function decodeTurnIdentity(value: unknown): AgentTurnIdentity {
  const identity = object(value, 'turn identity');
  exact(identity, ['turnIndex', 'turnId', 'requestAttempt']);
  return Object.freeze({ turnIndex: positiveInteger(identity.turnIndex, 'turnIndex'), turnId: identifier(identity.turnId, 'turnId'), requestAttempt: positiveInteger(identity.requestAttempt, 'requestAttempt') });
}

function decodeBudget(value: unknown): AgentRunBudgetState {
  const budget = object(value, 'operation budget');
  exact(budget, ['modelTurns', 'totalToolCalls', 'repeatedIdenticalToolCalls', 'elapsedMs', 'promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'knownCosts', 'pricingStatus', 'unknownPricedTokens', 'consecutiveProviderFailures', 'consecutiveToolFailures', 'providerRetries']);
  return Object.freeze({
    modelTurns: nonnegativeInteger(budget.modelTurns, 'budget.modelTurns'), totalToolCalls: nonnegativeInteger(budget.totalToolCalls, 'budget.totalToolCalls'), repeatedIdenticalToolCalls: nonnegativeInteger(budget.repeatedIdenticalToolCalls, 'budget.repeatedIdenticalToolCalls'), elapsedMs: nonnegativeInteger(budget.elapsedMs, 'budget.elapsedMs'), promptTokens: nonnegativeInteger(budget.promptTokens, 'budget.promptTokens'), completionTokens: nonnegativeInteger(budget.completionTokens, 'budget.completionTokens'), cacheReadTokens: nonnegativeInteger(budget.cacheReadTokens, 'budget.cacheReadTokens'), cacheWriteTokens: nonnegativeInteger(budget.cacheWriteTokens, 'budget.cacheWriteTokens'), reasoningTokens: nonnegativeInteger(budget.reasoningTokens, 'budget.reasoningTokens'), knownCosts: numberRecord(budget.knownCosts, 'budget.knownCosts'), pricingStatus: enumeration(budget.pricingStatus, ['known', 'partial', 'unknown'] as const, 'budget.pricingStatus'), unknownPricedTokens: nonnegativeInteger(budget.unknownPricedTokens, 'budget.unknownPricedTokens'), consecutiveProviderFailures: nonnegativeInteger(budget.consecutiveProviderFailures, 'budget.consecutiveProviderFailures'), consecutiveToolFailures: nonnegativeInteger(budget.consecutiveToolFailures, 'budget.consecutiveToolFailures'), providerRetries: nonnegativeInteger(budget.providerRetries, 'budget.providerRetries')
  });
}

function object(value: unknown, name: string): JsonObject { if (!isJsonObject(value)) throw new TypeError(`${name} must be an object.`); return value; }
function exact(value: JsonObject, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) throw new TypeError(`Unsupported operation fields: ${unsupported.join(', ')}.`);
}
function array(value: unknown, name: string): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`); return value; }
function nonempty(value: unknown, name: string): string { if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`); return value; }
function identifier(value: unknown, name: string): string { const result = nonempty(value, name); if (hasControlCharacter(result) || Buffer.byteLength(result, 'utf8') > 512) throw new TypeError(`${name} is invalid.`); return result; }
function hasControlCharacter(value: string): boolean { for (let index = 0; index < value.length; index += 1) { const unit = value.charCodeAt(index); if (unit <= 31 || unit === 127) return true; } return false; }
function optionalIdentifier(value: unknown, name: string): string | undefined { return value === undefined ? undefined : identifier(value, name); }
function nonnegativeInteger(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`); return value; }
function positiveInteger(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`); return value; }
function stringArray(value: unknown, name: string): readonly string[] { return Object.freeze(array(value, name).map((item, index) => nonempty(item, `${name}[${String(index)}]`))); }
function uniqueIdentifiers(value: unknown, name: string): readonly string[] { const items = Object.freeze(array(value, name).map((item, index) => identifier(item, `${name}[${String(index)}]`))); if (new Set(items).size !== items.length) throw new TypeError(`${name} contains duplicate identities.`); return items; }
function nonemptyUniqueIdentifiers(value: unknown, name: string): readonly string[] { const items = uniqueIdentifiers(value, name); if (items.length === 0) throw new TypeError(`${name} must not be empty.`); return items; }
function numberRecord(value: unknown, name: string): Readonly<Record<string, number>> { const record = object(value, name); const owned: Record<string, number> = {}; for (const [key, item] of Object.entries(record)) { if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new TypeError(`${name}.${key} must be a non-negative finite number.`); owned[key] = item; } return Object.freeze(owned); }
function enumeration<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] { if (!oneOf(value, values)) throw new TypeError(`${name} is invalid.`); return value; }
function oneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] { return typeof value === 'string' && values.some((candidate) => candidate === value); }
function isJsonObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
