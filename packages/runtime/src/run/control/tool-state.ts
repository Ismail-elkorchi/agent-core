import { decodeAgentRunRecordRef, type AgentRunRecordRef } from './records.js';
import {
  decodeStoredToolObservation,
  type StoredToolObservation
} from '../../orchestration/observation-source.js';
import { decodeEffectExecutionState, type EffectExecutionState } from '@agent-core/effects';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { parseModelToolCall, type ModelToolCall } from '@agent-core/model';
import { hashJson, validatePublicArtifactRef } from '@agent-core/persistence';
import {
  decodeOwnedToolEffects,
  decodeToolContent,
  decodeOwnedToolObservationForPersistence,
  decodeToolCall,
  effectsConflict,
  type ToolCall,
  type ToolEffects,
  type ToolObservation
} from '@agent-core/tools';
import type {
  AgentApprovalBinding,
  AgentApprovalRequest,
  AgentEffectiveInstruction,
  AgentTurnIdentity
} from '../contracts.js';
import { decodeToolCatalog, type ToolCatalogSnapshot } from '../tool-catalog.js';

export interface AgentToolCallPlanRecord {
  readonly toolImplementationId: string;
  readonly canonicalInput: JsonValue;
  readonly fingerprint: string;
  readonly effects: ToolEffects;
  readonly binding: AgentApprovalBinding;
  readonly authorization: 'allow' | 'deny' | 'require_approval';
  readonly authorizationReason?: string;
  readonly approval?: AgentApprovalRequest;
}

export interface AgentToolSettlementRecord {
  readonly observationId: string;
  readonly observation?: ToolObservation;
  readonly original: StoredToolObservation;
  readonly modelContentRef?: import('@agent-core/persistence').PublicArtifactRef;
  readonly modelContent: readonly import('@agent-core/tools').ToolContent[];
  readonly createdAt: string;
}

export interface AgentToolResultDelivery {
  readonly deliveryId: string;
  readonly inputIdentity: string;
  readonly targetResponseId: string;
  readonly status: 'admitted' | 'submitted' | 'acknowledged' | 'applied' | 'failed' | 'uncertain';
  readonly successorResponseId?: string;
}

interface AgentToolBatchBase {
  readonly kind: 'tools';
  readonly identity: AgentTurnIdentity;
  readonly toolBatchId: string;
  readonly calls: readonly ToolCall[];
  readonly callStates: readonly AgentToolCallState[];
  readonly maxConcurrency: number;
  readonly source: Readonly<{
    readonly responseId: string;
    readonly catalog: ToolCatalogSnapshot;
    readonly nativeCatalogIdentity?: string;
  }>;
  readonly modelCalls: readonly ModelToolCall[];
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly modelInputModalities: readonly string[];
}

export type AgentToolCallState =
  | Readonly<{
      readonly stage: 'resolved';
      readonly toolAttempt: number;
      readonly record: AgentRunRecordRef;
      readonly effect?: never;
      readonly plan?: never;
      readonly settlement?: never;
    }>
  | Readonly<{
      readonly stage: 'approval';
      readonly plan: AgentToolCallPlanRecord;
      readonly approval: AgentApprovalRequest;
    }>
  | Readonly<{
      readonly stage: 'ready';
      readonly approved?: Readonly<{
        readonly approval: AgentApprovalRequest;
        readonly decision: 'allow' | 'deny';
      }>;
    }>
  | Readonly<{
      readonly stage: 'effect_ready';
      readonly plan: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }>;
    }>
  | Readonly<{
      readonly stage: 'effect_pending';
      readonly plan: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' }>;
    }>
  | Readonly<{
      readonly stage: 'settled';
      readonly plan?: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' }>;
      readonly settlement: AgentToolSettlementRecord;
    }>
  | Readonly<{
      readonly stage: 'recording';
      readonly plan?: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' }>;
      readonly settlement: AgentToolSettlementRecord;
    }>
  | Readonly<{
      readonly stage: 'recorded';
      readonly delivery?: AgentToolResultDelivery;
      readonly plan?: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect?: Extract<EffectExecutionState, { readonly phase: 'settled' }>;
      readonly settlement: AgentToolSettlementRecord;
    }>
  | Readonly<{
      readonly stage: 'outcome_unknown';
      readonly plan: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect: Extract<EffectExecutionState, { readonly phase: 'started' | 'closed' }>;
    }>
  | Readonly<{
      readonly stage: 'cancelled';
      readonly plan?: AgentToolCallPlanRecord;
      readonly toolAttempt: number;
      readonly effect?: Extract<EffectExecutionState, { readonly phase: 'closed' }>;
    }>;

export type AgentToolPhase = Readonly<AgentToolBatchBase>;

export function decodeToolPhase(value: unknown): AgentToolPhase {
  const phase = parseJsonObject(value);
  return decodeOwnedToolPhase(phase);
}

export function decodeOwnedToolPhase(phase: JsonObject): AgentToolPhase {
  if (phase.kind !== 'tools') throw new TypeError('Tool work kind must be tools.');
  exact(phase, [...COMMON_FIELDS, 'kind']);
  const common = decodeCommon(phase);
  for (const [index, state] of common.callStates.entries()) {
    const approval =
      state.stage === 'approval'
        ? state.approval
        : state.stage === 'ready'
          ? state.approved?.approval
          : undefined;
    if (approval) {
      assertApprovalCall(
        common,
        index,
        approval.callIndex,
        approval.callId,
        approval.toolBatchId,
        approval.turnIndex,
        approval.turnId,
        approval.requestAttempt
      );
    }
  }
  return Object.freeze({ kind: 'tools', ...common });
}

function decodeCallState(value: unknown, callIndex: number, callCount: number): AgentToolCallState {
  const state = object(value, `tool call state ${String(callIndex)}`);
  const stage = enumeration(
    state.stage,
    [
      'resolved',
      'approval',
      'ready',
      'effect_ready',
      'effect_pending',
      'settled',
      'recording',
      'recorded',
      'outcome_unknown',
      'cancelled'
    ] as const,
    `callStates[${String(callIndex)}].stage`
  );
  if (stage === 'resolved') {
    exact(state, ['stage', 'toolAttempt', 'record']);
    const record = decodeAgentRunRecordRef(state.record);
    if (record.kind !== 'tool_call')
      throw new TypeError('Resolved tool work requires its original call record.');
    return Object.freeze({
      stage,
      toolAttempt: positiveInteger(state.toolAttempt, 'resolved.toolAttempt'),
      record
    });
  }
  if (stage === 'approval') {
    exact(state, ['stage', 'plan', 'approval']);
    const plan = decodeToolCallPlan(state.plan);
    const approval = decodeApproval(state.approval);
    assertToolDependencies(plan.effects, callIndex, callCount);
    if (
      approval.fingerprint !== plan.fingerprint ||
      hashJson(approval.binding) !== hashJson(plan.binding) ||
      hashJson(approval.input) !== hashJson(plan.canonicalInput) ||
      hashJson(approval.effects) !== hashJson(plan.effects)
    ) {
      throw new TypeError('Approval identity does not match its tool-call plan.');
    }
    return Object.freeze({ stage, plan, approval });
  }
  exact(
    state,
    stage === 'ready'
      ? ['stage', 'approved']
      : [
          'stage',
          'plan',
          'toolAttempt',
          'effect',
          'settlement',
          ...(stage === 'recorded' ? ['delivery'] : [])
        ]
  );
  if (stage === 'ready') {
    const approved = state.approved === undefined ? undefined : decodeApproved(state.approved);
    if (approved && approved.approval.callIndex !== callIndex)
      throw new TypeError('Stored approval decision does not match its tool-call index.');
    return Object.freeze({ stage, ...(approved ? { approved } : {}) });
  }
  const toolAttempt = positiveInteger(
    state.toolAttempt,
    `callStates[${String(callIndex)}].toolAttempt`
  );
  const plan = state.plan === undefined ? undefined : decodeToolCallPlan(state.plan);
  const effect = state.effect === undefined ? undefined : decodeEffectExecutionState(state.effect);
  if (stage === 'effect_ready') {
    if (!plan || effect?.phase !== 'ticket_issued')
      throw new TypeError('An effect-ready tool call requires plan and an issued ticket.');
    assertToolDependencies(plan.effects, callIndex, callCount);
    assertEffectMatchesPlan(effect, plan);
    return Object.freeze({ stage, plan, toolAttempt, effect });
  }
  if (stage === 'effect_pending') {
    if (!plan || effect?.phase !== 'started')
      throw new TypeError('An effect-pending tool call requires plan and a started effect.');
    assertToolDependencies(plan.effects, callIndex, callCount);
    assertEffectMatchesPlan(effect, plan);
    return Object.freeze({ stage, plan, toolAttempt, effect });
  }
  if (stage === 'outcome_unknown') {
    if (
      !plan ||
      (effect?.phase !== 'started' && effect?.phase !== 'closed') ||
      (effect.phase === 'closed' && effect.closure.reason === 'cancelled_before_start')
    ) {
      throw new TypeError(
        'An unknown tool outcome requires plan and an outstanding or explicitly closed started effect.'
      );
    }
    assertToolDependencies(plan.effects, callIndex, callCount);
    assertEffectMatchesPlan(effect, plan);
    return Object.freeze({ stage, plan, toolAttempt, effect });
  }
  if (stage === 'cancelled') {
    if (
      effect !== undefined &&
      (effect.phase !== 'closed' || effect.closure.reason !== 'cancelled_before_start')
    ) {
      throw new TypeError('A cancelled tool call may retain only an effect closed before start.');
    }
    if (effect && !plan)
      throw new TypeError('A cancelled external tool effect requires its plan record.');
    if (plan) assertToolDependencies(plan.effects, callIndex, callCount);
    if (effect && plan) assertEffectMatchesPlan(effect, plan);
    return Object.freeze({
      stage,
      ...(plan ? { plan } : {}),
      toolAttempt,
      ...(effect ? { effect } : {})
    });
  }
  const settlement = decodeAgentToolSettlementRecord(state.settlement);
  if (plan) assertToolDependencies(plan.effects, callIndex, callCount);
  if (effect !== undefined && effect.phase !== 'settled')
    throw new TypeError('A settled tool call may retain only a settled external effect.');
  if (effect && !plan)
    throw new TypeError('A settled external tool effect requires its plan record.');
  if (effect && plan) assertEffectMatchesPlan(effect, plan);
  if (effect?.settlement.outcome === 'unknown')
    throw new TypeError(
      'A durable tool observation cannot be backed by an unknown effect settlement.'
    );
  if (effect && effect.settlement.resultDigest !== settlement.original.digest) {
    throw new TypeError('External effect settlement does not match the durable tool observation.');
  }
  return Object.freeze({
    stage,
    ...(plan ? { plan } : {}),
    toolAttempt,
    ...(effect ? { effect } : {}),
    settlement,
    ...(stage === 'recorded' && state.delivery !== undefined
      ? { delivery: decodeToolResultDelivery(state.delivery) }
      : {})
  });
}

const COMMON_FIELDS = [
  'identity',
  'toolBatchId',
  'calls',
  'callStates',
  'maxConcurrency',
  'source',
  'modelCalls',
  'instructions',
  'modelInputModalities'
] as const;

function decodeCommon(value: JsonObject): Omit<AgentToolBatchBase, 'kind'> {
  const calls = array(value.calls, 'phase.calls').map((call) => decodeToolCall(call));
  const callStates = array(value.callStates, 'phase.callStates').map((state, index) =>
    decodeCallState(state, index, calls.length)
  );
  if (callStates.length !== calls.length)
    throw new TypeError('phase.callStates must contain exactly one state per tool call.');
  const maxConcurrency = positiveInteger(value.maxConcurrency, 'phase.maxConcurrency');
  const sourceValue = object(value.source, 'tool source');
  exact(sourceValue, ['responseId', 'catalog', 'nativeCatalogIdentity']);
  const source = Object.freeze({
    responseId: identifier(sourceValue.responseId, 'source.responseId'),
    catalog: decodeToolCatalog(sourceValue.catalog),
    ...(sourceValue.nativeCatalogIdentity === undefined
      ? {}
      : {
          nativeCatalogIdentity: identifier(
            sourceValue.nativeCatalogIdentity,
            'source.nativeCatalogIdentity'
          )
        })
  });
  const modelCalls = Object.freeze(array(value.modelCalls, 'modelCalls').map(parseModelToolCall));
  if (modelCalls.length !== calls.length)
    throw new TypeError('Each call requires its original model call.');
  for (const [index, call] of calls.entries()) {
    const modelCall = modelCalls[index];
    if (
      !modelCall ||
      modelCall.id !== call.id ||
      modelCall.name !== call.name ||
      hashJson(call.input) !== hashJson(modelCall.input)
    ) {
      throw new TypeError('Tool call does not match its original model call.');
    }
  }
  return Object.freeze({
    identity: decodeTurnIdentity(value.identity),
    toolBatchId: identifier(value.toolBatchId, 'phase.toolBatchId'),
    calls: Object.freeze(calls),
    callStates: Object.freeze(callStates),
    maxConcurrency,
    source,
    modelCalls,
    instructions: Object.freeze(
      array(value.instructions, 'phase.instructions').map((item, index) =>
        decodeInstruction(item, `phase.instructions[${String(index)}]`)
      )
    ),
    modelInputModalities: uniqueStrings(value.modelInputModalities, 'phase.modelInputModalities')
  });
}

export function nextStartableToolCallIndex(
  phase: AgentToolPhase,
  driverGeneration: number,
  batches: readonly AgentToolPhase[]
): number | undefined {
  const index = phase.callStates.findIndex((_, callIndex) =>
    isToolCallStartable(phase, callIndex, driverGeneration, batches)
  );
  return index < 0 ? undefined : index;
}

export function isToolCallStartable(
  phase: AgentToolPhase,
  callIndex: number,
  driverGeneration: number,
  batches: readonly AgentToolPhase[]
): boolean {
  const state = phase.callStates[callIndex];
  if (state?.stage !== 'effect_ready' || state.effect.ticket.driverGeneration !== driverGeneration)
    return false;
  const active = batches.flatMap((batch) =>
    batch.callStates.flatMap((call) =>
      call.stage === 'effect_pending' || call.stage === 'outcome_unknown' ? [call] : []
    )
  );
  const concurrency = Math.min(
    phase.maxConcurrency,
    ...batches
      .filter((batch) =>
        batch.callStates.some(
          (call) =>
            call.stage !== 'recorded' && call.stage !== 'resolved' && call.stage !== 'cancelled'
        )
      )
      .map((batch) => batch.maxConcurrency)
  );
  if (active.length >= concurrency) return false;
  if (active.some((running) => effectsConflict(running.plan.effects, state.plan.effects)))
    return false;
  return !(state.plan.effects.dependsOnCallIndices ?? []).some((dependency) => {
    const dependencyState = phase.callStates[dependency];
    return (
      dependencyState?.stage !== 'settled' &&
      dependencyState?.stage !== 'recording' &&
      dependencyState?.stage !== 'recorded' &&
      dependencyState?.stage !== 'resolved'
    );
  });
}

function assertToolDependencies(effects: ToolEffects, callIndex: number, callCount: number): void {
  for (const dependency of effects.dependsOnCallIndices ?? []) {
    if (dependency >= callIndex || dependency >= callCount) {
      throw new TypeError(
        `Tool call ${String(callIndex)} has invalid dependency ${String(dependency)}.`
      );
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
  if (
    !call ||
    (state?.stage !== 'ready' && state?.stage !== 'approval') ||
    callIndex !== approvalCallIndex ||
    call.id !== callId ||
    toolBatchId !== common.toolBatchId ||
    turnIndex !== common.identity.turnIndex ||
    turnId !== common.identity.turnId ||
    requestAttempt !== common.identity.requestAttempt
  ) {
    throw new TypeError('Approval identity does not match its durable tool call.');
  }
}

function assertEffectMatchesPlan(
  effect: EffectExecutionState,
  plan: AgentToolCallPlanRecord
): void {
  if (
    effect.intent.implementationId !== plan.toolImplementationId ||
    effect.intent.parametersDigest !== plan.fingerprint
  ) {
    throw new TypeError('External effect intent does not match its tool-call plan.');
  }
}

function decodeToolCallPlan(value: unknown): AgentToolCallPlanRecord {
  const record = object(value, 'tool plan');
  exact(record, [
    'toolImplementationId',
    'canonicalInput',
    'fingerprint',
    'effects',
    'binding',
    'authorization',
    'authorizationReason',
    'approval'
  ]);
  const authorizationReason = optionalString(
    record.authorizationReason,
    'plan.authorizationReason'
  );
  return Object.freeze({
    toolImplementationId: identifier(record.toolImplementationId, 'plan.toolImplementationId'),
    canonicalInput: parseJsonValue(record.canonicalInput),
    fingerprint: digest(record.fingerprint, 'plan.fingerprint'),
    effects: decodeOwnedToolEffects(object(record.effects, 'plan.effects')),
    binding: decodeBinding(record.binding),
    authorization: enumeration(
      record.authorization,
      ['allow', 'deny', 'require_approval'] as const,
      'plan.authorization'
    ),
    ...(authorizationReason ? { authorizationReason } : {}),
    ...(record.approval === undefined ? {} : { approval: decodeApproval(record.approval) })
  });
}

export function decodeToolResultDelivery(value: unknown): AgentToolResultDelivery {
  const record = parseJsonObject(value);
  exact(record, [
    'deliveryId',
    'inputIdentity',
    'targetResponseId',
    'status',
    'successorResponseId'
  ]);
  const successorResponseId = optionalString(
    record.successorResponseId,
    'delivery.successorResponseId'
  );
  return Object.freeze({
    deliveryId: identifier(record.deliveryId, 'delivery.deliveryId'),
    inputIdentity: identifier(record.inputIdentity, 'delivery.inputIdentity'),
    targetResponseId: identifier(record.targetResponseId, 'delivery.targetResponseId'),
    status: enumeration(
      record.status,
      ['admitted', 'submitted', 'acknowledged', 'applied', 'failed', 'uncertain'] as const,
      'delivery.status'
    ),
    ...(successorResponseId ? { successorResponseId } : {})
  });
}

export function decodeAgentToolSettlementRecord(value: unknown): AgentToolSettlementRecord {
  const record = object(value, 'tool settlement');
  exact(record, [
    'observationId',
    'observation',
    'original',
    'modelContent',
    'modelContentRef',
    'createdAt'
  ]);
  const original = decodeStoredToolObservation(record.original);
  if ((record.observation === undefined) !== (original.storage === 'unavailable'))
    throw new Error('Original observation availability is inconsistent.');
  return Object.freeze({
    observationId: identifier(record.observationId, 'settlement.observationId'),
    modelContent: decodeToolContent(record.modelContent),
    original,
    ...(record.modelContentRef === undefined
      ? {}
      : { modelContentRef: publicModelContentRef(record.modelContentRef) }),
    ...(record.observation === undefined
      ? {}
      : {
          observation: decodeOwnedToolObservationForPersistence(
            object(record.observation, 'settlement.observation')
          )
        }),
    createdAt: timestamp(record.createdAt, 'settlement.createdAt')
  });
}

function decodeApproval(value: unknown): AgentApprovalRequest {
  const record = object(value, 'approval request');
  exact(record, [
    'runId',
    'turnIndex',
    'turnId',
    'requestAttempt',
    'toolBatchId',
    'callIndex',
    'callId',
    'approvalId',
    'status',
    'toolName',
    'fingerprint',
    'input',
    'effects',
    'binding',
    'policyHash',
    'reason'
  ]);
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

function decodeApproved(
  value: unknown
): Readonly<{ readonly approval: AgentApprovalRequest; readonly decision: 'allow' | 'deny' }> {
  const record = object(value, 'approval decision');
  exact(record, ['approval', 'decision']);
  return Object.freeze({
    approval: decodeApproval(record.approval),
    decision: enumeration(record.decision, ['allow', 'deny'] as const, 'approval decision')
  });
}

function decodeBinding(value: unknown): AgentApprovalBinding {
  const record = object(value, 'approval binding');
  exact(record, ['toolImplementationId', 'authorizationPolicyId', 'executionTargetId']);
  return Object.freeze({
    toolImplementationId: identifier(record.toolImplementationId, 'binding.toolImplementationId'),
    authorizationPolicyId: identifier(
      record.authorizationPolicyId,
      'binding.authorizationPolicyId'
    ),
    executionTargetId: identifier(record.executionTargetId, 'binding.executionTargetId')
  });
}

function decodeInstruction(value: unknown, path: string): AgentEffectiveInstruction {
  const record = object(value, path);
  exact(record, ['id', 'content', 'provenance', 'role', 'sourceUri', 'priority']);
  const role = optionalString(record.role, `${path}.role`);
  const sourceUri = optionalString(record.sourceUri, `${path}.sourceUri`);
  const priority =
    record.priority === undefined ? undefined : finite(record.priority, `${path}.priority`);
  return Object.freeze({
    id: identifier(record.id, `${path}.id`),
    content: nonempty(record.content, `${path}.content`),
    provenance: enumeration(
      record.provenance,
      ['application', 'run', 'steering'] as const,
      `${path}.provenance`
    ),
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
  if (!isObject(value)) throw new TypeError(`${label} must be object data.`);
  return value;
}
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}
function exact(value: JsonObject, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new TypeError(`Unsupported tool operation fields: ${unknown.join(', ')}.`);
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || hasControlCharacter(value))
    throw new TypeError(`${label} must be a non-empty identifier.`);
  return value;
}
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 31 || unit === 127) return true;
  }
  return false;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new TypeError(`${label} must be a SHA-256 digest.`);
  return value;
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(`${label} must be non-empty.`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}
function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0)
    throw new TypeError(`${label} must be a nonnegative integer.`);
  return Number(value);
}
function positiveInteger(value: unknown, label: string): number {
  const number = nonnegativeInteger(value, label);
  if (number === 0) throw new TypeError(`${label} must be positive.`);
  return number;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${label} must be finite.`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new TypeError(`${label} must be an ISO timestamp.`);
  return value;
}
function uniqueStrings(value: unknown, label: string): readonly string[] {
  const strings = array(value, label).map((item) => identifier(item, label));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${label} must be unique.`);
  return Object.freeze(strings);
}
function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value))
    throw new TypeError(`${label} is invalid.`);
  return value;
}

function publicModelContentRef(
  value: unknown
): import('@agent-core/persistence').PublicArtifactRef {
  const ref = parseJsonObject(value);
  validatePublicArtifactRef(ref);
  return ref;
}
