import { decodeEffectExecutionState, type EffectExecutionState } from '@agent-core/effects';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import {
  decodePromptContextItemInput,
  type PromptContextItemInput
} from '../../inference/prompt-material.js';
import { parseSessionImages } from '../../session/images.js';
import {
  decodeAgentRunBudgetState,
  type AgentRunBudgetState,
  type AgentTurnIdentity
} from '../contracts.js';
import { assertAgentRunStateInvariants } from './state-invariants.js';
import { decodeToolPhase, isToolCallStartable, type AgentToolPhase } from './tool-state.js';

export type { AgentToolCallPlanRecord, AgentToolPhase, AgentToolSettlementRecord } from './tool-state.js';

export interface AgentRunStateInput {
  readonly task: string;
  readonly images?: readonly import('../../session/images.js').SessionImageInput[];
  readonly instructions: readonly string[];
  readonly contextItems: readonly PromptContextItemInput[];
}

export interface AgentRunControlConfiguration {
  readonly providerId: string;
  readonly providerImplementationId: string;
  readonly model: string;
  readonly runtimeImplementationId: string;
  readonly toolImplementationIds: readonly string[];

  readonly policyHash: string;
}

export type AgentRunControl =
  | Readonly<{ readonly status: 'detached' }>
  | Readonly<{ readonly status: 'owned'; readonly driverId: string }>
  | Readonly<{ readonly status: 'abort_requested'; readonly driverId?: string; readonly reason: string }>;

interface AgentProviderPhaseBase {
  readonly kind: 'provider';
  readonly identity: AgentTurnIdentity;
  readonly toolBatchId: string;
}

export type AgentProviderPhase =
  | Readonly<AgentProviderPhaseBase & { readonly stage: 'ready' }>
  | Readonly<
      AgentProviderPhaseBase & {
        readonly stage: 'effect_ready';
        readonly requestEventId: string;
        readonly responseId: string;
        readonly effect: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }>;
      }
    >
  | Readonly<
      AgentProviderPhaseBase & {
        readonly stage: 'effect_pending';
        readonly requestEventId: string;
        readonly responseId: string;
        readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' }>;
      }
    >
  | Readonly<
      AgentProviderPhaseBase & {
        readonly stage: 'settled';
        readonly requestEventId: string;
        readonly responseId: string;
        readonly effect: Extract<EffectExecutionState, { readonly phase: 'settled' }>;
        readonly settlementEventId: string;
      }
    >
  | Readonly<
      AgentProviderPhaseBase & {
        readonly stage: 'consumed';
        readonly requestEventId: string;
        readonly responseId: string;
        readonly effect: Extract<EffectExecutionState, { readonly phase: 'settled' }>;
        readonly settlementEventId: string;
      }
    >
  | Readonly<
      AgentProviderPhaseBase & {
        readonly stage: 'outcome_unknown';
        readonly requestEventId: string;
        readonly responseId: string;
        readonly effect: Extract<EffectExecutionState, { readonly phase: 'closed' }>;
      }
    >;

export interface AgentDecisionRequest {
  readonly id: string;
  readonly reason: string;
  readonly choices: readonly string[];
  readonly fingerprint: string;
  readonly runRevision: number;
}

export interface AgentDecisionContinuation {
  readonly kind: 'cancelled_provider_start';
  readonly blockedProvider: Readonly<
    AgentProviderPhaseBase & {
      readonly requestEventId: string;
      readonly responseId: string;
      readonly effect: Extract<EffectExecutionState, { readonly phase: 'closed' }>;
    }
  >;
}

export type AgentRunControlPhase =
  | Readonly<{ readonly kind: 'accepted' }>
  | Readonly<{
      readonly kind: 'initializing';
      readonly step: 'initialize' | 'assemble_turn';
      readonly turnIndex: number;
    }>
  | Readonly<{ readonly kind: 'active' }>
  | Readonly<{
      readonly kind: 'finalization';
      readonly stage: 'ready' | 'staged' | 'session_recorded' | 'committed';
      readonly terminalEventId?: string;
    }>
  | Readonly<{
      readonly kind: 'suspended';
      readonly reason: 'provider_outcome_unknown' | 'tool_outcome_unknown' | 'missing_implementation';
      readonly effectId?: string;
    }>
  | Readonly<{
      readonly kind: 'suspended';
      readonly reason: 'user_decision';
      readonly effectId: string;
      readonly decisionRequest: AgentDecisionRequest;
      readonly continuation: AgentDecisionContinuation;
    }>
  | Readonly<{ readonly kind: 'suspended'; readonly reason: 'approval'; readonly approvalId: string }>
  | Readonly<{ readonly kind: 'cancelling'; readonly stage: 'requested' | 'finalizing' }>
  | Readonly<{ readonly kind: 'terminal'; readonly resultEventId: string }>;

export interface AgentRunState {
  readonly runId: string;
  readonly finalizationId: string;
  readonly revision: number;
  readonly driverGeneration: number;
  readonly input: AgentRunStateInput;
  readonly configuration: AgentRunControlConfiguration;
  readonly control: AgentRunControl;
  readonly phase: AgentRunControlPhase;
  readonly providerRequests: readonly AgentProviderPhase[];
  readonly toolBatches: readonly AgentToolPhase[];
  readonly budget?: AgentRunBudgetState;
}

export type AgentRunProcedure =
  | 'initialize_run'
  | 'assemble_turn'
  | 'authorize_provider_request'
  | 'start_provider_request'
  | 'reconcile_provider_request'
  | 'consume_provider_settlement'
  | 'plan_tool_call'
  | 'start_tool_call'
  | 'reconcile_tool_call'
  | 'begin_observation_recording'
  | 'record_tool_observation'
  | 'record_tool_delivery'
  | 'advance_after_tools'
  | 'finalize'
  | 'reconcile_finalization'
  | 'finalize_abort';

export type AgentRunTarget =
  | Readonly<{ readonly kind: 'provider'; readonly turnId: string; readonly requestAttempt: number }>
  | Readonly<{ readonly kind: 'tool'; readonly toolBatchId: string; readonly callIndex: number }>;

export type AgentToolTarget = Extract<AgentRunTarget, { readonly kind: 'tool' }>;
export type AgentProviderTarget = Extract<AgentRunTarget, { readonly kind: 'provider' }>;

export type AgentRunInstruction =
  | Readonly<{
      readonly kind: 'execute';
      readonly procedure: AgentRunProcedure;
      readonly target?: AgentRunTarget;
    }>
  | Readonly<{
      readonly kind: 'wait';
      readonly reason: 'approval' | 'external_outcome' | 'user_decision' | 'driver';
    }>
  | Readonly<{ readonly kind: 'complete' }>;

export function nextAgentRunInstruction(state: AgentRunState): AgentRunInstruction {
  if (state.phase.kind === 'terminal') return Object.freeze({ kind: 'complete' });
  if (state.control.status === 'detached') return Object.freeze({ kind: 'wait', reason: 'driver' });
  if (state.control.status === 'abort_requested')
    return Object.freeze({ kind: 'execute', procedure: 'finalize_abort' });
  switch (state.phase.kind) {
    case 'accepted':
      return Object.freeze({ kind: 'execute', procedure: 'initialize_run' });
    case 'initializing':
      return Object.freeze({
        kind: 'execute',
        procedure: state.phase.step === 'initialize' ? 'initialize_run' : 'assemble_turn'
      });
    case 'active':
      return activeInstructions(state)[0] ?? Object.freeze({ kind: 'wait', reason: 'external_outcome' });
    case 'finalization':
      return Object.freeze({
        kind: 'execute',
        procedure: state.phase.stage === 'ready' ? 'finalize' : 'reconcile_finalization'
      });
    case 'suspended':
      return Object.freeze({
        kind: 'wait',
        reason:
          state.phase.reason === 'approval'
            ? 'approval'
            : state.phase.reason === 'user_decision' || state.phase.reason === 'missing_implementation'
              ? 'user_decision'
              : 'external_outcome'
      });
    case 'cancelling':
      return Object.freeze({ kind: 'execute', procedure: 'finalize_abort' });
  }
}

/** Every legal independent procedure, in deterministic recording/tool/provider order. */
export function nextAgentRunInstructions(state: AgentRunState): readonly AgentRunInstruction[] {
  if (state.phase.kind !== 'active' || state.control.status !== 'owned') {
    return Object.freeze([nextAgentRunInstruction(state)]);
  }
  const instructions = activeInstructions(state);
  return instructions.length ? instructions : Object.freeze([{ kind: 'wait', reason: 'external_outcome' }]);
}

function activeInstructions(state: AgentRunState): readonly AgentRunInstruction[] {
  const instructions: AgentRunInstruction[] = [];
  const execute = (procedure: AgentRunProcedure, target?: AgentRunTarget): void => {
    instructions.push(Object.freeze({ kind: 'execute', procedure, ...(target ? { target } : {}) }));
  };
  // Observations never wait for a lower call index or a newer response.
  for (const batch of state.toolBatches) {
    for (const [callIndex, call] of batch.callStates.entries()) {
      const target: AgentToolTarget = Object.freeze({
        kind: 'tool',
        toolBatchId: batch.toolBatchId,
        callIndex
      });
      if (call.stage === 'recording') execute('record_tool_observation', target);
      if (call.stage === 'settled') execute('begin_observation_recording', target);
    }
  }
  const approval = state.toolBatches.some((batch) =>
    batch.callStates.some((call) => call.stage === 'approval')
  );
  for (const batch of state.toolBatches) {
    for (const [callIndex, call] of batch.callStates.entries()) {
      const target: AgentToolTarget = Object.freeze({
        kind: 'tool',
        toolBatchId: batch.toolBatchId,
        callIndex
      });
      if (
        (call.stage === 'effect_ready' ||
          call.stage === 'effect_pending' ||
          (call.stage === 'outcome_unknown' &&
            call.effect.phase === 'started' &&
            call.effect.intent.recovery.kind !== 'unknown')) &&
        (call.effect.phase === 'ticket_issued' || call.effect.phase === 'started') &&
        call.effect.ticket.driverGeneration !== state.driverGeneration
      ) {
        execute('reconcile_tool_call', target);
      } else if (!approval && call.stage === 'ready') execute('plan_tool_call', target);
      else if (
        !approval &&
        isToolCallStartable(batch, callIndex, state.driverGeneration, state.toolBatches)
      ) {
        execute('start_tool_call', target);
      }
    }
  }
  for (const request of state.providerRequests) {
    const target: AgentProviderTarget = Object.freeze({
      kind: 'provider',
      turnId: request.identity.turnId,
      requestAttempt: request.identity.requestAttempt
    });
    if (request.stage === 'settled') execute('consume_provider_settlement', target);
    else if (request.stage === 'effect_pending') execute('reconcile_provider_request', target);
    else if (!approval && request.stage === 'ready') execute('authorize_provider_request', target);
    else if (!approval && request.stage === 'effect_ready') execute('start_provider_request', target);
  }
  if (instructions.length === 0) {
    if (approval) instructions.push(Object.freeze({ kind: 'wait', reason: 'approval' }));
    else if (
      state.toolBatches.every((batch) =>
        batch.callStates.every((call) => call.stage === 'recorded' || call.stage === 'cancelled')
      ) &&
      state.providerRequests.every((request) => request.stage === 'consumed')
    )
      execute('advance_after_tools');
    else if (
      state.toolBatches.some((batch) => batch.callStates.some((call) => call.stage === 'effect_pending'))
    ) {
      for (const batch of state.toolBatches) {
        const callIndex = batch.callStates.findIndex((call) => call.stage === 'effect_pending');
        if (callIndex >= 0)
          execute('reconcile_tool_call', { kind: 'tool', toolBatchId: batch.toolBatchId, callIndex });
      }
    }
  }
  return Object.freeze(instructions);
}

export function toolWork(
  state: AgentRunState,
  target: Pick<AgentToolTarget, 'toolBatchId' | 'callIndex'>
): AgentToolPhase {
  const batch = state.toolBatches.find((item) => item.toolBatchId === target.toolBatchId);
  if (!batch?.callStates[target.callIndex])
    throw new TypeError('Tool target does not identify retained work.');
  return batch;
}

export function providerWork(
  state: AgentRunState,
  target: Pick<AgentProviderTarget, 'turnId' | 'requestAttempt'>
): AgentProviderPhase {
  const request = state.providerRequests.find(
    (item) =>
      item.identity.turnId === target.turnId && item.identity.requestAttempt === target.requestAttempt
  );
  if (!request) throw new TypeError('Provider target does not identify retained work.');
  return request;
}

/** Required protocol obligations; async permits overlap, never omission of a result. */
export function outstandingToolObligations(state: AgentRunState): readonly Readonly<{
  target: AgentToolTarget;
  responseId: string;
  callId?: string;
  async: boolean;
  stage: import('./tool-state.js').AgentToolCallState['stage'];
  delivery?: import('./tool-state.js').AgentToolResultDelivery;
}>[] {
  return Object.freeze(
    state.toolBatches.flatMap((batch) =>
      batch.callStates.flatMap((call, callIndex) => {
        if (
          call.stage === 'cancelled' ||
          (call.stage === 'recorded' && call.delivery?.status === 'applied')
        )
          return [];
        const modelCall = batch.modelCalls[callIndex];
        return [
          Object.freeze({
            target: Object.freeze({ kind: 'tool' as const, toolBatchId: batch.toolBatchId, callIndex }),
            responseId: batch.source.responseId,
            ...(modelCall?.id ? { callId: modelCall.id } : {}),
            async: modelCall?.async === true,
            stage: call.stage,
            ...(call.stage === 'recorded' && call.delivery ? { delivery: call.delivery } : {})
          })
        ];
      })
    )
  );
}

export function decodeAgentRunState(value: unknown): AgentRunState {
  let state: JsonObject;
  try {
    state = parseJsonObject(value, {
      maxDepth: 18,
      maxCollectionEntries: 20_000,
      maxStringBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024
    });
  } catch (error) {
    throw new TypeError('run state is invalid.', { cause: error });
  }
  exact(state, [
    'runId',
    'finalizationId',
    'revision',
    'driverGeneration',
    'input',
    'configuration',
    'control',
    'phase',
    'providerRequests',
    'toolBatches',
    'budget'
  ]);
  const input = decodeAgentRunStateInput(state.input);
  const configuration = decodeAgentRunControlConfiguration(state.configuration);
  const control = decodeAgentRunControl(state.control);
  const phase = decodeAgentRunControlPhase(state.phase);
  const providerRequests = Object.freeze(
    array(state.providerRequests, 'providerRequests').map(decodeProviderPhase)
  );
  const toolBatches = Object.freeze(array(state.toolBatches, 'toolBatches').map(decodeToolPhase));
  const budget = state.budget === undefined ? undefined : decodeBudget(state.budget);
  const runId = identifier(state.runId, 'runId');
  const revision = nonnegativeInteger(state.revision, 'revision');
  const decoded: AgentRunState = Object.freeze({
    runId,
    finalizationId: identifier(state.finalizationId, 'finalizationId'),
    revision,
    driverGeneration: nonnegativeInteger(state.driverGeneration, 'driverGeneration'),
    input,
    configuration,
    control,
    phase,
    providerRequests,
    toolBatches,
    ...(budget === undefined ? {} : { budget })
  });
  assertAgentRunStateInvariants(decoded);
  return decoded;
}

export function decodeAgentRunStateInput(value: unknown): AgentRunStateInput {
  const input = object(value, 'run input');
  exact(input, ['task', 'instructions', 'contextItems', 'images']);
  return Object.freeze({
    task: nonempty(input.task, 'task'),
    ...(input.images === undefined ? {} : { images: parseSessionImages(input.images) }),
    instructions: stringArray(input.instructions, 'instructions'),
    contextItems: Object.freeze(
      array(input.contextItems, 'contextItems').map((item) => decodePromptContextItemInput(item))
    )
  });
}

export function decodeAgentRunControlConfiguration(value: unknown): AgentRunControlConfiguration {
  const configuration = object(value, 'run configuration');
  exact(configuration, [
    'providerId',
    'providerImplementationId',
    'model',
    'runtimeImplementationId',
    'toolImplementationIds',
    'policyHash'
  ]);
  return Object.freeze({
    providerId: identifier(configuration.providerId, 'providerId'),
    providerImplementationId: identifier(
      configuration.providerImplementationId,
      'providerImplementationId'
    ),
    model: nonempty(configuration.model, 'model'),
    runtimeImplementationId: identifier(configuration.runtimeImplementationId, 'runtimeImplementationId'),
    toolImplementationIds: uniqueIdentifiers(configuration.toolImplementationIds, 'toolImplementationIds'),
    policyHash: nonempty(configuration.policyHash, 'policyHash')
  });
}

export function decodeAgentRunControl(value: unknown): AgentRunControl {
  const control = object(value, 'run control');
  const status = enumeration(
    control.status,
    ['detached', 'owned', 'abort_requested'] as const,
    'control.status'
  );
  if (status === 'detached') {
    exact(control, ['status']);
    return Object.freeze({ status });
  }
  if (status === 'owned') {
    exact(control, ['status', 'driverId']);
    return Object.freeze({ status, driverId: identifier(control.driverId, 'control.driverId') });
  }
  exact(control, ['status', 'driverId', 'reason']);
  const driverId =
    control.driverId === undefined ? undefined : identifier(control.driverId, 'control.driverId');
  return Object.freeze({
    status,
    ...(driverId === undefined ? {} : { driverId }),
    reason: nonempty(control.reason, 'control.reason')
  });
}

export function decodeAgentRunControlPhase(value: unknown): AgentRunControlPhase {
  const phase = object(value, 'run phase');
  const kind = enumeration(
    phase.kind,
    ['accepted', 'initializing', 'active', 'finalization', 'suspended', 'cancelling', 'terminal'] as const,
    'phase.kind'
  );
  switch (kind) {
    case 'accepted':
      exact(phase, ['kind']);
      return Object.freeze({ kind });
    case 'initializing':
      exact(phase, ['kind', 'step', 'turnIndex']);
      return Object.freeze({
        kind,
        step: enumeration(phase.step, ['initialize', 'assemble_turn'] as const, 'phase.step'),
        turnIndex: positiveInteger(phase.turnIndex, 'phase.turnIndex')
      });
    case 'active':
      exact(phase, ['kind']);
      return Object.freeze({ kind });
    case 'finalization': {
      exact(phase, ['kind', 'stage', 'terminalEventId']);
      const terminalEventId = optionalIdentifier(phase.terminalEventId, 'phase.terminalEventId');
      return Object.freeze({
        kind,
        stage: enumeration(
          phase.stage,
          ['ready', 'staged', 'session_recorded', 'committed'] as const,
          'phase.stage'
        ),
        ...(terminalEventId ? { terminalEventId } : {})
      });
    }
    case 'suspended': {
      const reason = enumeration(
        phase.reason,
        [
          'approval',
          'provider_outcome_unknown',
          'tool_outcome_unknown',
          'missing_implementation',
          'user_decision'
        ] as const,
        'phase.reason'
      );
      if (reason === 'approval') {
        exact(phase, ['kind', 'reason', 'approvalId']);
        return Object.freeze({ kind, reason, approvalId: identifier(phase.approvalId, 'approvalId') });
      }
      exact(
        phase,
        reason === 'user_decision'
          ? ['kind', 'reason', 'effectId', 'decisionRequest', 'continuation']
          : ['kind', 'reason', 'effectId']
      );
      const effectId = optionalIdentifier(phase.effectId, 'phase.effectId');
      if (reason === 'user_decision') {
        if (!effectId) throw new TypeError('A user decision requires its blocked effect identity.');
        const decisionRequest = decodeDecisionRequest(phase.decisionRequest);
        const continuation = decodeDecisionContinuation(phase.continuation);
        if (continuation.blockedProvider.effect.intent.effectId !== effectId)
          throw new TypeError('Decision continuation effect identity does not match its suspension.');
        const expectedFingerprint = hashJson({
          id: decisionRequest.id,
          reason: decisionRequest.reason,
          choices: decisionRequest.choices,
          runRevision: decisionRequest.runRevision,
          effectId
        });
        if (decisionRequest.fingerprint !== expectedFingerprint)
          throw new TypeError('Decision request fingerprint is inconsistent.');
        if (decisionRequest.choices.length !== 1 || decisionRequest.choices[0] !== 'abort')
          throw new TypeError('A cancelled provider start permits only abort.');
        return Object.freeze({ kind, reason, effectId, decisionRequest, continuation });
      }
      return Object.freeze({ kind, reason, ...(effectId ? { effectId } : {}) });
    }
    case 'cancelling':
      exact(phase, ['kind', 'stage']);
      return Object.freeze({
        kind,
        stage: enumeration(phase.stage, ['requested', 'finalizing'] as const, 'phase.stage')
      });
    case 'terminal':
      exact(phase, ['kind', 'resultEventId']);
      return Object.freeze({ kind, resultEventId: identifier(phase.resultEventId, 'phase.resultEventId') });
  }
}

export function decodeProviderPhase(value: unknown): AgentProviderPhase {
  const phase = object(value, 'provider work');
  if (phase.kind !== 'provider') throw new TypeError('Provider work kind must be provider.');
  const kind = 'provider';
  exact(phase, [
    'kind',
    'stage',
    'identity',
    'toolBatchId',
    'requestEventId',
    'responseId',
    'effect',
    'settlementEventId'
  ]);
  const stage = enumeration(
    phase.stage,
    ['ready', 'effect_ready', 'effect_pending', 'settled', 'consumed', 'outcome_unknown'] as const,
    'phase.stage'
  );
  const requestEventId = optionalIdentifier(phase.requestEventId, 'phase.requestEventId');
  const responseId = optionalIdentifier(phase.responseId, 'phase.responseId');
  const settlementEventId = optionalIdentifier(phase.settlementEventId, 'phase.settlementEventId');
  const effect = phase.effect === undefined ? undefined : decodeEffectExecutionState(phase.effect);
  if (stage === 'ready' && (requestEventId || responseId || effect || settlementEventId))
    throw new TypeError('A ready provider phase cannot retain effect state.');
  if (stage !== 'ready' && (!requestEventId || !responseId || !effect))
    throw new TypeError(`Provider stage ${stage} requires request, response, and effect identity.`);
  const base = {
    kind,
    identity: decodeTurnIdentity(phase.identity),
    toolBatchId: identifier(phase.toolBatchId, 'phase.toolBatchId')
  } as const;
  if (stage === 'ready') return Object.freeze({ ...base, stage });
  if (!requestEventId || !responseId || !effect)
    throw new TypeError(`Provider stage ${stage} is incomplete.`);
  if (stage === 'effect_ready') {
    if (effect.phase !== 'ticket_issued')
      throw new TypeError('An effect-ready provider phase requires an issued ticket.');
    return Object.freeze({ ...base, stage, requestEventId, responseId, effect });
  }
  if (stage === 'effect_pending') {
    if (effect.phase !== 'started')
      throw new TypeError('An effect-pending provider phase requires a started effect.');
    return Object.freeze({ ...base, stage, requestEventId, responseId, effect });
  }
  if (stage === 'settled' || stage === 'consumed') {
    if (effect.phase !== 'settled' || !settlementEventId)
      throw new TypeError('A settled provider phase requires effect and response settlement.');
    return Object.freeze({ ...base, stage, requestEventId, responseId, effect, settlementEventId });
  }
  if (effect.phase !== 'closed')
    throw new TypeError('An unknown provider outcome requires a closed effect.');
  return Object.freeze({ ...base, stage, requestEventId, responseId, effect });
}

function decodeDecisionRequest(value: unknown): AgentDecisionRequest {
  const request = object(value, 'decision request');
  exact(request, ['id', 'reason', 'choices', 'fingerprint', 'runRevision']);
  const choices = uniqueIdentifiers(request.choices, 'decisionRequest.choices');
  if (choices.length === 0) throw new TypeError('decisionRequest.choices must not be empty.');
  return Object.freeze({
    id: identifier(request.id, 'decisionRequest.id'),
    reason: nonempty(request.reason, 'decisionRequest.reason'),
    choices,
    fingerprint: digest(request.fingerprint, 'decisionRequest.fingerprint'),
    runRevision: nonnegativeInteger(request.runRevision, 'decisionRequest.runRevision')
  });
}

function decodeDecisionContinuation(value: unknown): AgentDecisionContinuation {
  const continuation = object(value, 'decision continuation');
  exact(continuation, ['kind', 'blockedProvider']);
  if (continuation.kind !== 'cancelled_provider_start')
    throw new TypeError('Unknown decision continuation.');
  const blockedProvider = object(continuation.blockedProvider, 'blocked provider continuation');
  exact(blockedProvider, ['kind', 'identity', 'toolBatchId', 'requestEventId', 'responseId', 'effect']);
  if (blockedProvider.kind !== 'provider')
    throw new TypeError('Decision continuation must retain a blocked provider phase.');
  const effect = decodeEffectExecutionState(blockedProvider.effect);
  if (effect.phase !== 'closed' || effect.closure.reason !== 'cancelled_before_start')
    throw new TypeError('Decision continuation must retain a provider effect closed before start.');
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

function decodeTurnIdentity(value: unknown): AgentTurnIdentity {
  const identity = object(value, 'turn identity');
  exact(identity, ['turnIndex', 'turnId', 'requestAttempt']);
  return Object.freeze({
    turnIndex: positiveInteger(identity.turnIndex, 'turnIndex'),
    turnId: identifier(identity.turnId, 'turnId'),
    requestAttempt: positiveInteger(identity.requestAttempt, 'requestAttempt')
  });
}

function decodeBudget(value: unknown): AgentRunBudgetState {
  return decodeAgentRunBudgetState(value);
}

function object(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}
function exact(value: JsonObject, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) throw new TypeError(`Unsupported run fields: ${unsupported.join(', ')}.`);
}
function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}
function identifier(value: unknown, name: string): string {
  const result = nonempty(value, name);
  if (hasControlCharacter(result) || Buffer.byteLength(result, 'utf8') > 512)
    throw new TypeError(`${name} is invalid.`);
  return result;
}
function digest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new TypeError(`${name} must be a SHA-256 digest.`);
  return value;
}
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 31 || unit === 127) return true;
  }
  return false;
}
function optionalIdentifier(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : identifier(value, name);
}
function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer.`);
  return value;
}
function stringArray(value: unknown, name: string): readonly string[] {
  return Object.freeze(
    array(value, name).map((item, index) => nonempty(item, `${name}[${String(index)}]`))
  );
}
function uniqueIdentifiers(value: unknown, name: string): readonly string[] {
  const items = Object.freeze(
    array(value, name).map((item, index) => identifier(item, `${name}[${String(index)}]`))
  );
  if (new Set(items).size !== items.length) throw new TypeError(`${name} contains duplicate identities.`);
  return items;
}
function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string
): T[number] {
  if (!oneOf(value, values)) throw new TypeError(`${name} is invalid.`);
  return value;
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.some((modelOutput) => modelOutput === value);
}
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
