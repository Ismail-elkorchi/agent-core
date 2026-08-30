import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { decodeEffectExecutionState, decodeEffectRecoveryCapability, type EffectExecutionState } from '@agent-core/effects';
import { hashJson } from '@agent-core/evidence';
import { decodeAgentRunBudgetState, decodeOwnedAgentCheckResult, type AgentCheckResult, type AgentRunBudgetState, type AgentTurnIdentity } from '../run/contracts.js';
import { decodeContextItemInput, type ContextItemInput } from '../context/manager.js';
import { decodeToolCall, type ToolCall } from '@agent-core/tools';
import { decodeToolOperationPhase, nextStartableToolCallIndex, type AgentApprovalOperationPhase, type AgentToolOperationPhase } from './tool-state.js';
import { decodeDispositionOperationPhase, type AgentDispositionOperationPhase } from './disposition/state.js';

export type { AgentApprovalOperationPhase, AgentToolOperationPhase, AgentToolPreparationRecord, AgentToolSettlementRecord } from './tool-state.js';
export type { AgentDispositionOperationPhase, AgentDispositionPreparationRecord } from './disposition/state.js';

export interface AgentOperationInput {
  readonly task: string;
  readonly instructions: readonly string[];
  readonly contextItems: readonly ContextItemInput[];
}

export interface AgentOperationConfiguration {
  readonly providerId: string;
  readonly providerImplementationId: string;
  readonly model: string;
  readonly runtimeImplementationId: string;
  readonly toolImplementationIds: readonly string[];
  readonly checks: readonly { readonly id: string; readonly implementationId: string }[];
  readonly disposition: Readonly<{ readonly implementationId: string; readonly policyIdentity: JsonValue; readonly policyHash: string }>;
  readonly policyHash: string;
}

export interface AgentCheckPreparationRecord {
  readonly checkImplementationId: string;
  readonly fingerprint: string;
  readonly authorization: JsonValue;
  readonly recovery: import('@agent-core/effects').EffectRecoveryCapability;
}

interface AgentVerificationPhaseBase {
  readonly kind: 'verification';
  readonly identity: AgentTurnIdentity;
  readonly providerSettlementEventId: string;
  readonly checkIds: readonly string[];
  readonly nextCheckIndex: number;
}

export type AgentOperationControl =
  | Readonly<{ readonly status: 'detached' }>
  | Readonly<{ readonly status: 'owned'; readonly driverId: string }>
  | Readonly<{ readonly status: 'abort_requested'; readonly driverId?: string; readonly reason: string }>;

interface AgentProviderPhaseBase {
  readonly kind: 'provider';
  readonly identity: AgentTurnIdentity;
  readonly toolBatchId: string;
}

export type AgentProviderOperationPhase =
  | Readonly<AgentProviderPhaseBase & { readonly stage: 'ready' }>
  | Readonly<AgentProviderPhaseBase & { readonly stage: 'effect_ready'; readonly requestEventId: string; readonly responseId: string; readonly effect: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }> }>
  | Readonly<AgentProviderPhaseBase & { readonly stage: 'effect_pending'; readonly requestEventId: string; readonly responseId: string; readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' }> }>
  | Readonly<AgentProviderPhaseBase & { readonly stage: 'settled'; readonly requestEventId: string; readonly responseId: string; readonly effect: Extract<EffectExecutionState, { readonly phase: 'settled' }>; readonly settlementEventId: string }>
  | Readonly<AgentProviderPhaseBase & { readonly stage: 'outcome_unknown'; readonly requestEventId: string; readonly responseId: string; readonly effect: Extract<EffectExecutionState, { readonly phase: 'closed' }> }>;

export interface AgentDecisionRequest {
  readonly id: string;
  readonly reason: string;
  readonly choices: readonly string[];
  readonly fingerprint: string;
  readonly operationRevision: number;
}

export interface AgentDecisionContinuation {
  readonly kind: 'cancelled_provider_start';
  readonly blockedProvider: Readonly<AgentProviderPhaseBase & {
    readonly requestEventId: string;
    readonly responseId: string;
    readonly effect: Extract<EffectExecutionState, { readonly phase: 'closed' }>;
  }>;
}

export type AgentOperationPhase =
  | Readonly<{ readonly kind: 'accepted' }>
  | Readonly<{ readonly kind: 'preparing'; readonly step: 'initialize' | 'assemble_turn'; readonly turnIndex: number }>
  | AgentProviderOperationPhase
  | AgentToolOperationPhase
  | AgentApprovalOperationPhase
  | Readonly<AgentVerificationPhaseBase & { readonly stage: 'ready' }>
  | Readonly<AgentVerificationPhaseBase & { readonly stage: 'deterministic_pending' }>
  | Readonly<AgentVerificationPhaseBase & { readonly stage: 'effect_ready'; readonly preparation: AgentCheckPreparationRecord; readonly effect: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }> }>
  | Readonly<AgentVerificationPhaseBase & { readonly stage: 'effect_pending'; readonly preparation: AgentCheckPreparationRecord; readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' }> }>
  | Readonly<AgentVerificationPhaseBase & { readonly stage: 'settled'; readonly result: AgentCheckResult; readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' | 'closed' }> }>
  | Readonly<AgentVerificationPhaseBase & { readonly stage: 'complete' }>
  | AgentDispositionOperationPhase
  | Readonly<{
      readonly kind: 'finalization';
      readonly stage: 'ready' | 'prepared' | 'session_projected' | 'committed';
      readonly terminalEventId?: string;
    }>
  | Readonly<{ readonly kind: 'suspended'; readonly reason: 'provider_outcome_unknown' | 'tool_outcome_unknown' | 'disposition_outcome_unknown' | 'missing_implementation'; readonly effectId?: string }>
  | Readonly<{
      readonly kind: 'suspended';
      readonly reason: 'user_decision';
      readonly effectId: string;
      readonly decisionRequest: AgentDecisionRequest;
      readonly continuation: AgentDecisionContinuation;
    }>
  | Readonly<{ readonly kind: 'cancelling'; readonly stage: 'requested' | 'finalizing'; readonly toolBatch?: AgentToolOperationPhase }>
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
  readonly toolCalls: readonly ToolCall[];
  readonly revisionInstructions: readonly string[];
  readonly budget?: AgentRunBudgetState;
}

export type AgentOperationProcedure =
  | 'prepare'
  | 'assemble_turn'
  | 'prepare_provider_request'
  | 'start_provider_request'
  | 'reconcile_provider_request'
  | 'consume_provider_settlement'
  | 'prepare_tool_call'
  | 'start_tool_call'
  | 'reconcile_tool_call'
  | 'prepare_tool_projection'
  | 'project_tool_settlement'
  | 'advance_after_tools'
  | 'prepare_verification'
  | 'start_verification'
  | 'reconcile_verification'
  | 'consume_verification_settlement'
  | 'prepare_disposition'
  | 'start_disposition'
  | 'reconcile_disposition'
  | 'consume_disposition'
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
      if (state.phase.stage === 'effect_ready') return Object.freeze({ kind: 'execute', procedure: 'start_provider_request' });
      if (state.phase.stage === 'effect_pending') return Object.freeze({ kind: 'execute', procedure: 'reconcile_provider_request' });
      if (state.phase.stage === 'settled') return Object.freeze({ kind: 'execute', procedure: 'consume_provider_settlement' });
      return Object.freeze({ kind: 'wait', reason: 'external_outcome' });
    case 'tools':
      if (state.phase.nextProjectionIndex === state.phase.calls.length) return Object.freeze({ kind: 'execute', procedure: 'advance_after_tools' });
      if (state.phase.callStates[state.phase.nextProjectionIndex]?.stage === 'projecting') return Object.freeze({ kind: 'execute', procedure: 'project_tool_settlement' });
      if (state.phase.callStates.some((call) => (call.stage === 'effect_ready' || call.stage === 'effect_pending')
        && call.effect.ticket.driverGeneration !== state.driverGeneration)
        || state.phase.callStates.some((call) => call.stage === 'outcome_unknown' && call.effect.phase === 'started'
          && call.effect.intent.recovery.kind !== 'unknown' && call.effect.ticket.driverGeneration !== state.driverGeneration)) {
        return Object.freeze({ kind: 'execute', procedure: 'reconcile_tool_call' });
      }
      if (state.phase.callStates.some((call) => call.stage === 'ready')) return Object.freeze({ kind: 'execute', procedure: 'prepare_tool_call' });
      if (nextStartableToolCallIndex(state.phase, state.driverGeneration) !== undefined) return Object.freeze({ kind: 'execute', procedure: 'start_tool_call' });
      if (state.phase.callStates[state.phase.nextProjectionIndex]?.stage === 'settled') return Object.freeze({ kind: 'execute', procedure: 'prepare_tool_projection' });
      if (state.phase.callStates.some((call) => call.stage === 'effect_pending')) return Object.freeze({ kind: 'execute', procedure: 'reconcile_tool_call' });
      if (state.phase.callStates.some((call) => call.stage === 'outcome_unknown')) return Object.freeze({ kind: 'wait', reason: 'external_outcome' });
      throw new TypeError('Tool batch has no executable operation instruction.');
    case 'approval': return Object.freeze({ kind: 'wait', reason: 'approval' });
    case 'verification':
      if (state.phase.stage === 'ready') return Object.freeze({ kind: 'execute', procedure: 'prepare_verification' });
      if (state.phase.stage === 'effect_ready') return Object.freeze({ kind: 'execute', procedure: 'start_verification' });
      if (state.phase.stage === 'effect_pending') return Object.freeze({ kind: 'execute', procedure: 'reconcile_verification' });
      if (state.phase.stage === 'deterministic_pending') return Object.freeze({ kind: 'execute', procedure: 'reconcile_verification' });
      return Object.freeze({ kind: 'execute', procedure: 'consume_verification_settlement' });
    case 'disposition':
      if (state.phase.stage === 'ready') return Object.freeze({ kind: 'execute', procedure: 'prepare_disposition' });
      if (state.phase.stage === 'effect_ready') return Object.freeze({ kind: 'execute', procedure: 'start_disposition' });
      if (state.phase.stage === 'effect_pending') return Object.freeze({ kind: 'execute', procedure: 'reconcile_disposition' });
      if (state.phase.stage === 'outcome_unknown') return Object.freeze({ kind: 'wait', reason: 'external_outcome' });
      return Object.freeze({ kind: 'execute', procedure: 'consume_disposition' });
    case 'finalization': return Object.freeze({ kind: 'execute', procedure: state.phase.stage === 'ready' ? 'finalize' : 'reconcile_finalization' });
    case 'suspended':
      return Object.freeze({ kind: 'wait', reason: state.phase.reason === 'user_decision' || state.phase.reason === 'missing_implementation' ? 'user_decision' : 'external_outcome' });
    case 'cancelling': return Object.freeze({ kind: 'execute', procedure: 'finalize_abort' });
  }
}

export function decodeAgentOperationState(value: unknown): AgentOperationState {
  let state: JsonObject;
  try { state = parseJsonObject(value, { maxDepth: 18, maxCollectionEntries: 20_000, maxStringBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }); }
  catch (error) { throw new TypeError('operation state is invalid.', { cause: error }); }
  exact(state, ['runId', 'finalizationId', 'revision', 'driverGeneration', 'input', 'configuration', 'control', 'phase', 'toolCalls', 'revisionInstructions', 'budget']);
  const input = decodeInput(state.input);
  const configuration = decodeConfiguration(state.configuration);
  const control = decodeControl(state.control);
  const phase = decodePhase(state.phase);
  const toolCalls = Object.freeze(array(state.toolCalls, 'toolCalls').map((call) => decodeToolCall(call)));
  const revisionInstructions = stringArray(state.revisionInstructions, 'revisionInstructions');
  const budget = state.budget === undefined ? undefined : decodeBudget(state.budget);
  const runId = identifier(state.runId, 'runId');
  const revision = nonnegativeInteger(state.revision, 'revision');
  if (phase.kind === 'suspended' && phase.reason === 'user_decision') {
    if (phase.decisionRequest.operationRevision > revision
      || (control.status !== 'abort_requested' && phase.decisionRequest.operationRevision !== revision)) {
      throw new TypeError('Decision request revision does not match the operation revision.');
    }
    if (phase.continuation.blockedProvider.effect.intent.operationId !== runId) throw new TypeError('Decision continuation does not belong to this operation.');
  }
  return Object.freeze({
    runId,
    finalizationId: identifier(state.finalizationId, 'finalizationId'),
    revision,
    driverGeneration: nonnegativeInteger(state.driverGeneration, 'driverGeneration'),
    input,
    configuration,
    control,
    phase,
    toolCalls,
    revisionInstructions,
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
  exact(configuration, ['providerId', 'providerImplementationId', 'model', 'runtimeImplementationId', 'toolImplementationIds', 'checks', 'disposition', 'policyHash']);
  const disposition = object(configuration.disposition, 'disposition configuration');
  exact(disposition, ['implementationId', 'policyIdentity', 'policyHash']);
  const dispositionPolicyIdentity = parseJsonValue(disposition.policyIdentity);
  const dispositionPolicyHash = digest(disposition.policyHash, 'disposition.policyHash');
  if (hashJson(dispositionPolicyIdentity) !== dispositionPolicyHash) throw new TypeError('disposition.policyHash does not match disposition.policyIdentity.');
  return Object.freeze({
    providerId: identifier(configuration.providerId, 'providerId'),
    providerImplementationId: identifier(configuration.providerImplementationId, 'providerImplementationId'),
    model: nonempty(configuration.model, 'model'),
    runtimeImplementationId: identifier(configuration.runtimeImplementationId, 'runtimeImplementationId'),
    toolImplementationIds: uniqueIdentifiers(configuration.toolImplementationIds, 'toolImplementationIds'),
    checks: checkBindings(configuration.checks),
    disposition: Object.freeze({
      implementationId: identifier(disposition.implementationId, 'disposition.implementationId'),
      policyIdentity: dispositionPolicyIdentity,
      policyHash: dispositionPolicyHash
    }),
    policyHash: nonempty(configuration.policyHash, 'policyHash')
  });
}

function checkBindings(value: unknown): readonly { readonly id: string; readonly implementationId: string }[] {
  if (!Array.isArray(value)) throw new TypeError('checks must be an array.');
  const ids = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const object = parseJsonObject(entry);
    exact(object, ['id', 'implementationId']);
    const id = identifier(object.id, `checks[${String(index)}].id`);
    if (ids.has(id)) throw new TypeError(`checks contains duplicate id: ${id}`);
    ids.add(id);
    return Object.freeze({ id, implementationId: identifier(object.implementationId, `checks[${String(index)}].implementationId`) });
  }));
}

function decodeCheckPreparation(value: unknown): AgentCheckPreparationRecord {
  const preparation = object(value, 'verification preparation');
  exact(preparation, ['checkImplementationId', 'fingerprint', 'authorization', 'recovery']);
  return Object.freeze({
    checkImplementationId: identifier(preparation.checkImplementationId, 'verification preparation checkImplementationId'),
    fingerprint: digest(preparation.fingerprint, 'verification preparation fingerprint'),
    authorization: parseJsonValue(preparation.authorization),
    recovery: decodeEffectRecoveryCapability(preparation.recovery)
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
      exact(phase, ['kind', 'stage', 'identity', 'toolBatchId', 'requestEventId', 'responseId', 'effect', 'settlementEventId']);
      const stage = enumeration(phase.stage, ['ready', 'effect_ready', 'effect_pending', 'settled', 'outcome_unknown'] as const, 'phase.stage');
      const requestEventId = optionalIdentifier(phase.requestEventId, 'phase.requestEventId');
      const responseId = optionalIdentifier(phase.responseId, 'phase.responseId');
      const settlementEventId = optionalIdentifier(phase.settlementEventId, 'phase.settlementEventId');
      const effect = phase.effect === undefined ? undefined : decodeEffectExecutionState(phase.effect);
      if (stage === 'ready' && (requestEventId || responseId || effect || settlementEventId)) throw new TypeError('A ready provider phase cannot retain effect state.');
      if (stage !== 'ready' && (!requestEventId || !responseId || !effect)) throw new TypeError(`Provider stage ${stage} requires request, response, and effect identity.`);
      const base = { kind, identity: decodeTurnIdentity(phase.identity), toolBatchId: identifier(phase.toolBatchId, 'phase.toolBatchId') } as const;
      if (stage === 'ready') return Object.freeze({ ...base, stage });
      if (!requestEventId || !responseId || !effect) throw new TypeError(`Provider stage ${stage} is incomplete.`);
      if (stage === 'effect_ready') {
        if (effect.phase !== 'ticket_issued') throw new TypeError('An effect-ready provider phase requires an issued ticket.');
        return Object.freeze({ ...base, stage, requestEventId, responseId, effect });
      }
      if (stage === 'effect_pending') {
        if (effect.phase !== 'started') throw new TypeError('An effect-pending provider phase requires a started effect.');
        return Object.freeze({ ...base, stage, requestEventId, responseId, effect });
      }
      if (stage === 'settled') {
        if (effect.phase !== 'settled' || !settlementEventId) throw new TypeError('A settled provider phase requires effect and response settlement.');
        return Object.freeze({ ...base, stage, requestEventId, responseId, effect, settlementEventId });
      }
      if (effect.phase !== 'closed') throw new TypeError('An unknown provider outcome requires a closed effect.');
      return Object.freeze({ ...base, stage, requestEventId, responseId, effect });
    }
    case 'tools':
    case 'approval': return decodeToolOperationPhase(phase);
    case 'verification': {
      exact(phase, ['kind', 'stage', 'identity', 'providerSettlementEventId', 'checkIds', 'nextCheckIndex', 'preparation', 'effect', 'result']);
      const identity = decodeTurnIdentity(phase.identity);
      const providerSettlementEventId = identifier(phase.providerSettlementEventId, 'phase.providerSettlementEventId');
      const checkIds = uniqueIdentifiers(phase.checkIds, 'phase.checkIds');
      const nextCheckIndex = nonnegativeInteger(phase.nextCheckIndex, 'phase.nextCheckIndex');
      if (nextCheckIndex > checkIds.length) throw new TypeError('phase.nextCheckIndex exceeds phase.checkIds length.');
      const stage = enumeration(phase.stage, ['ready', 'deterministic_pending', 'effect_ready', 'effect_pending', 'settled', 'complete'] as const, 'phase.stage');
      const base = { kind, identity, providerSettlementEventId, checkIds, nextCheckIndex } as const;
      if (stage === 'complete') {
        if (nextCheckIndex !== checkIds.length) throw new TypeError('Complete verification must consume every check.');
        return Object.freeze({ ...base, stage });
      }
      if (nextCheckIndex >= checkIds.length) throw new TypeError(`Verification ${stage} requires a current check.`);
      if (stage === 'ready' || stage === 'deterministic_pending') return Object.freeze({ ...base, stage });
      if (stage === 'effect_ready') {
        const preparation = decodeCheckPreparation(phase.preparation);
        const effect = decodeEffectExecutionState(phase.effect);
        if (effect.phase !== 'ticket_issued') throw new TypeError('Verification effect_ready has an invalid effect state.');
        if (effect.intent.implementationId !== preparation.checkImplementationId || effect.intent.parametersDigest !== preparation.fingerprint) throw new TypeError('Verification effect does not match its preparation.');
        return Object.freeze({ ...base, stage, preparation, effect });
      }
      if (stage === 'effect_pending') {
        const preparation = decodeCheckPreparation(phase.preparation);
        const effect = decodeEffectExecutionState(phase.effect);
        if (effect.phase !== 'started') throw new TypeError('Verification effect_pending has an invalid effect state.');
        if (effect.intent.implementationId !== preparation.checkImplementationId || effect.intent.parametersDigest !== preparation.fingerprint) throw new TypeError('Verification effect does not match its preparation.');
        return Object.freeze({ ...base, stage, preparation, effect });
      }
      const result = decodeOwnedAgentCheckResult(object(phase.result, 'phase.result'));
      if (result.id !== checkIds[nextCheckIndex]) throw new TypeError('Settled verification result does not match the current check.');
      const effect = phase.effect === undefined ? undefined : decodeEffectExecutionState(phase.effect);
      if (effect !== undefined && effect.phase !== 'settled' && effect.phase !== 'closed') throw new TypeError('Settled verification retains an invalid effect state.');
      return Object.freeze({ ...base, stage, result, ...(effect ? { effect } : {}) });
    }
    case 'disposition': return decodeDispositionOperationPhase(phase);
    case 'finalization': {
      exact(phase, ['kind', 'stage', 'terminalEventId']);
      const terminalEventId = optionalIdentifier(phase.terminalEventId, 'phase.terminalEventId');
      return Object.freeze({ kind, stage: enumeration(phase.stage, ['ready', 'prepared', 'session_projected', 'committed'] as const, 'phase.stage'), ...(terminalEventId ? { terminalEventId } : {}) });
    }
    case 'suspended': {
      const reason = enumeration(phase.reason, ['provider_outcome_unknown', 'tool_outcome_unknown', 'disposition_outcome_unknown', 'missing_implementation', 'user_decision'] as const, 'phase.reason');
      exact(phase, reason === 'user_decision' ? ['kind', 'reason', 'effectId', 'decisionRequest', 'continuation'] : ['kind', 'reason', 'effectId']);
      const effectId = optionalIdentifier(phase.effectId, 'phase.effectId');
      if (reason === 'user_decision') {
        if (!effectId) throw new TypeError('A user decision requires its blocked effect identity.');
        const decisionRequest = decodeDecisionRequest(phase.decisionRequest);
        const continuation = decodeDecisionContinuation(phase.continuation);
        if (continuation.blockedProvider.effect.intent.effectId !== effectId) throw new TypeError('Decision continuation effect identity does not match its suspension.');
        const expectedFingerprint = hashJson({
          id: decisionRequest.id,
          reason: decisionRequest.reason,
          choices: decisionRequest.choices,
          operationRevision: decisionRequest.operationRevision,
          effectId
        });
        if (decisionRequest.fingerprint !== expectedFingerprint) throw new TypeError('Decision request fingerprint is inconsistent.');
        if (decisionRequest.choices.length !== 1 || decisionRequest.choices[0] !== 'abort') throw new TypeError('A cancelled provider start permits only abort.');
        return Object.freeze({ kind, reason, effectId, decisionRequest, continuation });
      }
      return Object.freeze({ kind, reason, ...(effectId ? { effectId } : {}) });
    }
    case 'cancelling':
      exact(phase, ['kind', 'stage', 'toolBatch']);
      return Object.freeze({
        kind,
        stage: enumeration(phase.stage, ['requested', 'finalizing'] as const, 'phase.stage'),
        ...(phase.toolBatch === undefined ? {} : { toolBatch: decodeCancellingToolBatch(phase.toolBatch) })
      });
    case 'terminal':
      exact(phase, ['kind', 'resultEventId']);
      return Object.freeze({ kind, resultEventId: identifier(phase.resultEventId, 'phase.resultEventId') });
  }
}

function decodeDecisionRequest(value: unknown): AgentDecisionRequest {
  const request = object(value, 'decision request');
  exact(request, ['id', 'reason', 'choices', 'fingerprint', 'operationRevision']);
  const choices = uniqueIdentifiers(request.choices, 'decisionRequest.choices');
  if (choices.length === 0) throw new TypeError('decisionRequest.choices must not be empty.');
  return Object.freeze({
    id: identifier(request.id, 'decisionRequest.id'),
    reason: nonempty(request.reason, 'decisionRequest.reason'),
    choices,
    fingerprint: digest(request.fingerprint, 'decisionRequest.fingerprint'),
    operationRevision: nonnegativeInteger(request.operationRevision, 'decisionRequest.operationRevision')
  });
}

function decodeDecisionContinuation(value: unknown): AgentDecisionContinuation {
  const continuation = object(value, 'decision continuation');
  exact(continuation, ['kind', 'blockedProvider']);
  if (continuation.kind !== 'cancelled_provider_start') throw new TypeError('Unknown decision continuation.');
  const blockedProvider = object(continuation.blockedProvider, 'blocked provider continuation');
  exact(blockedProvider, ['kind', 'identity', 'toolBatchId', 'requestEventId', 'responseId', 'effect']);
  if (blockedProvider.kind !== 'provider') throw new TypeError('Decision continuation must retain a blocked provider phase.');
  const effect = decodeEffectExecutionState(blockedProvider.effect);
  if (effect.phase !== 'closed' || effect.closure.reason !== 'cancelled_before_start') throw new TypeError('Decision continuation must retain a provider effect closed before start.');
  return Object.freeze({
    kind: continuation.kind,
    blockedProvider: Object.freeze({
      kind: blockedProvider.kind,
      identity: decodeTurnIdentity(blockedProvider.identity),
      toolBatchId: identifier(blockedProvider.toolBatchId, 'decision continuation toolBatchId'),
      requestEventId: identifier(blockedProvider.requestEventId, 'decision continuation requestEventId'),
      responseId: identifier(blockedProvider.responseId, 'decision continuation responseId'),
      effect
    })
  });
}

function decodeCancellingToolBatch(value: unknown): AgentToolOperationPhase {
  const batch = decodeToolOperationPhase(value);
  if (batch.kind !== 'tools') throw new TypeError('A cancelling tool batch must retain tool state.');
  if (batch.callStates.some((call) => call.stage === 'ready' || call.stage === 'effect_ready' || call.stage === 'effect_pending')) {
    throw new TypeError('A cancelling tool batch cannot retain open tool calls.');
  }
  return batch;
}

function decodeTurnIdentity(value: unknown): AgentTurnIdentity {
  const identity = object(value, 'turn identity');
  exact(identity, ['turnIndex', 'turnId', 'requestAttempt']);
  return Object.freeze({ turnIndex: positiveInteger(identity.turnIndex, 'turnIndex'), turnId: identifier(identity.turnId, 'turnId'), requestAttempt: positiveInteger(identity.requestAttempt, 'requestAttempt') });
}

function decodeBudget(value: unknown): AgentRunBudgetState {
  return decodeAgentRunBudgetState(value);
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
function digest(value: unknown, name: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${name} must be a SHA-256 digest.`); return value; }
function hasControlCharacter(value: string): boolean { for (let index = 0; index < value.length; index += 1) { const unit = value.charCodeAt(index); if (unit <= 31 || unit === 127) return true; } return false; }
function optionalIdentifier(value: unknown, name: string): string | undefined { return value === undefined ? undefined : identifier(value, name); }
function nonnegativeInteger(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`); return value; }
function positiveInteger(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`); return value; }
function stringArray(value: unknown, name: string): readonly string[] { return Object.freeze(array(value, name).map((item, index) => nonempty(item, `${name}[${String(index)}]`))); }
function uniqueIdentifiers(value: unknown, name: string): readonly string[] { const items = Object.freeze(array(value, name).map((item, index) => identifier(item, `${name}[${String(index)}]`))); if (new Set(items).size !== items.length) throw new TypeError(`${name} contains duplicate identities.`); return items; }
function enumeration<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] { if (!oneOf(value, values)) throw new TypeError(`${name} is invalid.`); return value; }
function oneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] { return typeof value === 'string' && values.some((candidate) => candidate === value); }
function isJsonObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
