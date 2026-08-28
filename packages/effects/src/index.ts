import { parseJsonObject, type JsonObject } from '@agent-core/json';

export interface EffectResourcePrecondition {
  readonly resource: string;
  readonly validatorId: string;
  readonly expectedVersion: string;
}

export type EffectRecoveryCapability =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'preconditioned_reexecution'; readonly preconditions: readonly EffectResourcePrecondition[] }
  | { readonly kind: 'queryable'; readonly service: string; readonly reconcilerId: string; readonly externalExecutionId: string; readonly expiresAt: string }
  | { readonly kind: 'idempotency_key'; readonly service: string; readonly key: string; readonly expiresAt: string }
  | { readonly kind: 'buffered_mutation'; readonly authority: string; readonly reconcilerId: string; readonly transactionId: string };

export interface EffectExposureQuantity {
  /** Application-defined unit such as `tokens`, `milliseconds`, or `usd_micros`. */
  readonly unit: string;
  /** Conservative whole-unit reservation. */
  readonly amount: number;
}

export interface EffectExposureReservation { readonly quantities: readonly EffectExposureQuantity[] }

export interface ExternalEffectIntent {
  readonly effectId: string;
  readonly operationId: string;
  readonly implementationId: string;
  readonly parametersDigest: string;
  readonly recovery: EffectRecoveryCapability;
  readonly exposure: EffectExposureReservation;
}

export interface EffectStartTicket {
  readonly ticketId: string;
  readonly effectId: string;
  readonly parametersDigest: string;
  readonly driverGeneration: number;
}

export interface EffectSettlementPermit {
  readonly permitId: string;
  readonly effectId: string;
  readonly parametersDigest: string;
}

export type EffectExposureSettlement =
  | { readonly status: 'known'; readonly quantities: readonly EffectExposureQuantity[] }
  | { readonly status: 'unknown'; readonly reserved: readonly EffectExposureQuantity[] };

export type ExternalEffectSettlement =
  | { readonly outcome: 'succeeded' | 'failed' | 'cancelled'; readonly resultDigest: string; readonly exposure: EffectExposureSettlement }
  | { readonly outcome: 'unknown'; readonly exposure: Extract<EffectExposureSettlement, { readonly status: 'unknown' }> };

export type EffectClosure =
  | { readonly reason: 'cancelled_before_start' }
  | { readonly reason: 'expired' | 'reconciliation_unavailable' | 'unknown_outcome'; readonly exposure: Extract<EffectExposureSettlement, { readonly status: 'unknown' }> };

interface EffectExecutionBase {
  readonly intent: ExternalEffectIntent;
  readonly settlementPermit: EffectSettlementPermit;
}

export type EffectExecutionState =
  | (EffectExecutionBase & { readonly phase: 'ticket_issued'; readonly ticket: EffectStartTicket })
  | (EffectExecutionBase & { readonly phase: 'started'; readonly ticket: EffectStartTicket })
  | (EffectExecutionBase & { readonly phase: 'settled'; readonly settlement: ExternalEffectSettlement })
  | (EffectExecutionBase & { readonly phase: 'closed'; readonly closure: EffectClosure });

export type EffectTicketIssueResult =
  | { readonly status: 'issued'; readonly state: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }> }
  | { readonly status: 'rejected'; readonly reason: 'stale_driver' };

export type EffectStartResult =
  | { readonly status: 'started'; readonly state: Extract<EffectExecutionState, { readonly phase: 'started' }> }
  | { readonly status: 'rejected'; readonly reason: 'stale_driver' | 'ticket_mismatch' | 'ticket_consumed' | 'effect_terminal' };

export type EffectSettlementResult =
  | { readonly status: 'settled'; readonly state: Extract<EffectExecutionState, { readonly phase: 'settled' }> }
  | { readonly status: 'already_settled'; readonly state: Extract<EffectExecutionState, { readonly phase: 'settled' }> }
  | { readonly status: 'late'; readonly state: Extract<EffectExecutionState, { readonly phase: 'closed' }> }
  | { readonly status: 'rejected'; readonly reason: 'effect_not_started' | 'permit_mismatch' | 'settlement_conflict' };

export type EffectReconciliationObservation =
  | { readonly status: 'running' }
  | { readonly status: 'settled'; readonly settlement: ExternalEffectSettlement }
  | { readonly status: 'not_found' }
  | { readonly status: 'expired' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'parameter_mismatch' };

export const UNKNOWN_EFFECT_RECOVERY: EffectRecoveryCapability = Object.freeze({ kind: 'unknown' });
export const NO_EFFECT_EXPOSURE: EffectExposureReservation = Object.freeze({ quantities: Object.freeze([]) });

export function decodeEffectRecoveryCapability(value: unknown): EffectRecoveryCapability {
  const record = object(value, 'effect recovery capability');
  if (record.kind === 'unknown') return UNKNOWN_EFFECT_RECOVERY;
  if (record.kind === 'preconditioned_reexecution') {
    if (!Array.isArray(record.preconditions) || record.preconditions.length === 0) throw new TypeError('Preconditioned re-execution requires at least one resource precondition.');
    const preconditions = record.preconditions.map((candidate) => {
      const item = object(candidate, 'effect resource precondition');
      return Object.freeze({ resource: identifier(item.resource, 'resource'), validatorId: identifier(item.validatorId, 'validatorId'), expectedVersion: identifier(item.expectedVersion, 'expectedVersion') });
    });
    const identities = preconditions.map((item) => `${item.resource}\0${item.validatorId}`);
    if (new Set(identities).size !== identities.length) throw new TypeError('Effect resource preconditions must be unique by resource and validator.');
    return Object.freeze({ kind: 'preconditioned_reexecution', preconditions: Object.freeze(preconditions) });
  }
  if (record.kind === 'queryable') return Object.freeze({
    kind: 'queryable', service: identifier(record.service, 'service'), reconcilerId: identifier(record.reconcilerId, 'reconcilerId'),
    externalExecutionId: identifier(record.externalExecutionId, 'externalExecutionId'), expiresAt: isoTimestamp(record.expiresAt, 'expiresAt')
  });
  if (record.kind === 'idempotency_key') return Object.freeze({
    kind: 'idempotency_key', service: identifier(record.service, 'service'), key: identifier(record.key, 'key'), expiresAt: isoTimestamp(record.expiresAt, 'expiresAt')
  });
  if (record.kind === 'buffered_mutation') return Object.freeze({
    kind: 'buffered_mutation', authority: identifier(record.authority, 'authority'), reconcilerId: identifier(record.reconcilerId, 'reconcilerId'), transactionId: identifier(record.transactionId, 'transactionId')
  });
  throw new TypeError('Unknown effect recovery capability.');
}

export function decodeEffectExposureReservation(value: unknown): EffectExposureReservation {
  const record = object(value, 'effect exposure reservation');
  return Object.freeze({ quantities: decodeQuantities(record.quantities, 'effect exposure reservation') });
}

export function decodeExternalEffectIntent(value: unknown): ExternalEffectIntent {
  const record = object(value, 'external effect intent');
  return Object.freeze({
    effectId: identifier(record.effectId, 'effectId'), operationId: identifier(record.operationId, 'operationId'),
    implementationId: identifier(record.implementationId, 'implementationId'), parametersDigest: digest(record.parametersDigest, 'parametersDigest'),
    recovery: decodeEffectRecoveryCapability(record.recovery), exposure: decodeEffectExposureReservation(record.exposure)
  });
}

export function decodeExternalEffectSettlement(value: unknown): ExternalEffectSettlement {
  const record = object(value, 'external effect settlement');
  const exposure = decodeExposureSettlement(record.exposure);
  if (record.outcome === 'unknown') {
    if (exposure.status !== 'unknown') throw new TypeError('An unknown effect outcome must retain unknown exposure.');
    return Object.freeze({ outcome: 'unknown', exposure });
  }
  if (record.outcome !== 'succeeded' && record.outcome !== 'failed' && record.outcome !== 'cancelled') throw new TypeError('Invalid external effect settlement outcome.');
  return Object.freeze({ outcome: record.outcome, resultDigest: digest(record.resultDigest, 'resultDigest'), exposure });
}

export function decodeEffectExecutionState(value: unknown): EffectExecutionState {
  const record = object(value, 'effect execution state');
  const intent = decodeExternalEffectIntent(record.intent);
  const settlementPermit = decodeEffectSettlementPermit(record.settlementPermit);
  assertEffectBinding(intent, settlementPermit, 'settlement permit');
  if (record.phase === 'ticket_issued' || record.phase === 'started') {
    const ticket = decodeStartTicket(record.ticket);
    assertEffectBinding(intent, ticket, 'start ticket');
    return Object.freeze({ phase: record.phase, intent, settlementPermit, ticket });
  }
  if (record.phase === 'settled') return Object.freeze({ phase: record.phase, intent, settlementPermit, settlement: decodeExternalEffectSettlement(record.settlement) });
  if (record.phase === 'closed') return Object.freeze({ phase: record.phase, intent, settlementPermit, closure: decodeClosure(record.closure, intent.exposure) });
  throw new TypeError('Unknown effect execution phase.');
}

export function encodeEffectRecoveryCapability(value: EffectRecoveryCapability): JsonObject {
  if (value.kind === 'unknown') return Object.freeze({ kind: value.kind });
  if (value.kind === 'preconditioned_reexecution') return Object.freeze({ kind: value.kind, preconditions: Object.freeze(value.preconditions.map((item) => Object.freeze({ resource: item.resource, validatorId: item.validatorId, expectedVersion: item.expectedVersion }))) });
  if (value.kind === 'queryable') return Object.freeze({ kind: value.kind, service: value.service, reconcilerId: value.reconcilerId, externalExecutionId: value.externalExecutionId, expiresAt: value.expiresAt });
  if (value.kind === 'idempotency_key') return Object.freeze({ kind: value.kind, service: value.service, key: value.key, expiresAt: value.expiresAt });
  return Object.freeze({ kind: value.kind, authority: value.authority, reconcilerId: value.reconcilerId, transactionId: value.transactionId });
}

export function encodeEffectExposureReservation(value: EffectExposureReservation): JsonObject {
  return Object.freeze({ quantities: encodeQuantities(value.quantities) });
}

export function encodeExternalEffectIntent(value: ExternalEffectIntent): JsonObject {
  return Object.freeze({
    effectId: value.effectId, operationId: value.operationId, implementationId: value.implementationId, parametersDigest: value.parametersDigest,
    recovery: encodeEffectRecoveryCapability(value.recovery), exposure: encodeEffectExposureReservation(value.exposure)
  });
}

export function encodeExternalEffectSettlement(value: ExternalEffectSettlement): JsonObject {
  return Object.freeze({ outcome: value.outcome, ...(value.outcome === 'unknown' ? {} : { resultDigest: value.resultDigest }), exposure: encodeExposureSettlement(value.exposure) });
}

export function encodeEffectExecutionState(value: EffectExecutionState): JsonObject {
  const base = {
    phase: value.phase,
    intent: encodeExternalEffectIntent(value.intent),
    settlementPermit: Object.freeze({ permitId: value.settlementPermit.permitId, effectId: value.settlementPermit.effectId, parametersDigest: value.settlementPermit.parametersDigest })
  };
  if (value.phase === 'ticket_issued' || value.phase === 'started') return Object.freeze({
    ...base,
    ticket: Object.freeze({ ticketId: value.ticket.ticketId, effectId: value.ticket.effectId, parametersDigest: value.ticket.parametersDigest, driverGeneration: value.ticket.driverGeneration })
  });
  if (value.phase === 'settled') return Object.freeze({ ...base, settlement: encodeExternalEffectSettlement(value.settlement) });
  return Object.freeze({ ...base, closure: encodeClosure(value.closure) });
}

export function issueEffectStartTicket(input: {
  readonly intent: ExternalEffectIntent;
  readonly ticketId: string;
  readonly settlementPermitId: string;
  readonly driverGeneration: number;
  readonly currentDriverGeneration: number;
}): EffectTicketIssueResult {
  const ticketId = identifier(input.ticketId, 'ticketId');
  const permitId = identifier(input.settlementPermitId, 'settlementPermitId');
  generation(input.driverGeneration, 'driverGeneration');
  generation(input.currentDriverGeneration, 'currentDriverGeneration');
  if (input.driverGeneration !== input.currentDriverGeneration) return Object.freeze({ status: 'rejected', reason: 'stale_driver' });
  const ticket = Object.freeze({ ticketId, effectId: input.intent.effectId, parametersDigest: input.intent.parametersDigest, driverGeneration: input.driverGeneration });
  const settlementPermit = Object.freeze({ permitId, effectId: input.intent.effectId, parametersDigest: input.intent.parametersDigest });
  return Object.freeze({ status: 'issued', state: Object.freeze({ phase: 'ticket_issued', intent: input.intent, ticket, settlementPermit }) });
}

export function startExternalEffect(state: EffectExecutionState, ticket: EffectStartTicket, currentDriverGeneration: number): EffectStartResult {
  generation(currentDriverGeneration, 'currentDriverGeneration');
  if (ticket.driverGeneration !== currentDriverGeneration) return Object.freeze({ status: 'rejected', reason: 'stale_driver' });
  if (state.phase === 'settled' || state.phase === 'closed') return Object.freeze({ status: 'rejected', reason: 'effect_terminal' });
  if (state.phase === 'started') return Object.freeze({ status: 'rejected', reason: 'ticket_consumed' });
  if (!ticketsEqual(state.ticket, ticket)) return Object.freeze({ status: 'rejected', reason: 'ticket_mismatch' });
  return Object.freeze({ status: 'started', state: Object.freeze({ phase: 'started', intent: state.intent, ticket: state.ticket, settlementPermit: state.settlementPermit }) });
}

export function settleExternalEffect(state: EffectExecutionState, permit: EffectSettlementPermit, settlement: ExternalEffectSettlement): EffectSettlementResult {
  if (!permitsEqual(state.settlementPermit, permit)) return Object.freeze({ status: 'rejected', reason: 'permit_mismatch' });
  if (state.phase === 'ticket_issued') return Object.freeze({ status: 'rejected', reason: 'effect_not_started' });
  if (state.phase === 'closed') return Object.freeze({ status: 'late', state });
  if (state.phase === 'settled') return settlementsEqual(state.settlement, settlement)
    ? Object.freeze({ status: 'already_settled', state })
    : Object.freeze({ status: 'rejected', reason: 'settlement_conflict' });
  return Object.freeze({ status: 'settled', state: Object.freeze({ phase: 'settled', intent: state.intent, settlementPermit: state.settlementPermit, settlement }) });
}

export function closeExternalEffect(
  state: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' | 'started' }>,
  reason: 'cancelled_before_start' | 'expired' | 'reconciliation_unavailable' | 'unknown_outcome'
): Extract<EffectExecutionState, { readonly phase: 'closed' }> {
  if (state.phase === 'started' && reason === 'cancelled_before_start') throw new TypeError('A started external effect cannot be closed as cancelled before start.');
  if (state.phase === 'ticket_issued' && reason !== 'cancelled_before_start') throw new TypeError('An unstarted external effect has no external outcome to reconcile.');
  const closure: EffectClosure = reason === 'cancelled_before_start'
    ? Object.freeze({ reason })
    : Object.freeze({ reason, exposure: unknownExposure(state.intent.exposure) });
  return Object.freeze({ phase: 'closed', intent: state.intent, settlementPermit: state.settlementPermit, closure });
}

export function knownEffectExposure(quantities: readonly EffectExposureQuantity[]): EffectExposureSettlement {
  return Object.freeze({ status: 'known', quantities: ownQuantities(quantities) });
}

export function unknownEffectExposure(reservation: EffectExposureReservation): Extract<EffectExposureSettlement, { readonly status: 'unknown' }> {
  return unknownExposure(reservation);
}

function decodeExposureSettlement(value: unknown): EffectExposureSettlement {
  const record = object(value, 'effect exposure settlement');
  if (record.status === 'known') return Object.freeze({ status: 'known', quantities: decodeQuantities(record.quantities, 'known effect exposure') });
  if (record.status === 'unknown') return Object.freeze({ status: 'unknown', reserved: decodeQuantities(record.reserved, 'unknown effect exposure') });
  throw new TypeError('Invalid effect exposure settlement.');
}

function decodeStartTicket(value: unknown): EffectStartTicket {
  const record = object(value, 'effect start ticket');
  const driverGeneration = Number(record.driverGeneration);
  generation(driverGeneration, 'driverGeneration');
  return Object.freeze({
    ticketId: identifier(record.ticketId, 'ticketId'), effectId: identifier(record.effectId, 'effectId'),
    parametersDigest: digest(record.parametersDigest, 'parametersDigest'), driverGeneration
  });
}

export function decodeEffectSettlementPermit(value: unknown): EffectSettlementPermit {
  const record = object(value, 'effect settlement permit');
  return Object.freeze({
    permitId: identifier(record.permitId, 'permitId'), effectId: identifier(record.effectId, 'effectId'),
    parametersDigest: digest(record.parametersDigest, 'parametersDigest')
  });
}

function decodeClosure(value: unknown, reservation: EffectExposureReservation): EffectClosure {
  const record = object(value, 'effect closure');
  if (record.reason === 'cancelled_before_start') return Object.freeze({ reason: record.reason });
  if (record.reason !== 'expired' && record.reason !== 'reconciliation_unavailable' && record.reason !== 'unknown_outcome') throw new TypeError('Invalid effect closure reason.');
  const exposure = decodeExposureSettlement(record.exposure);
  if (exposure.status !== 'unknown') throw new TypeError('An unresolved effect closure must retain unknown exposure.');
  if (!quantitiesEqual(exposure.reserved, reservation.quantities)) throw new TypeError('An unresolved effect closure must retain the exact exposure reservation.');
  return Object.freeze({ reason: record.reason, exposure });
}

function encodeClosure(value: EffectClosure): JsonObject {
  return value.reason === 'cancelled_before_start'
    ? Object.freeze({ reason: value.reason })
    : Object.freeze({ reason: value.reason, exposure: encodeExposureSettlement(value.exposure) });
}

function encodeExposureSettlement(value: EffectExposureSettlement): JsonObject {
  return value.status === 'known'
    ? Object.freeze({ status: value.status, quantities: encodeQuantities(value.quantities) })
    : Object.freeze({ status: value.status, reserved: encodeQuantities(value.reserved) });
}

function decodeQuantities(value: unknown, label: string): readonly EffectExposureQuantity[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} quantities must be an array.`);
  return ownQuantities(value.map((candidate) => {
    const item = object(candidate, `${label} quantity`);
    if (!Number.isSafeInteger(item.amount) || Number(item.amount) < 0) throw new TypeError(`${label} amounts must be nonnegative safe integers.`);
    return { unit: identifier(item.unit, 'unit'), amount: Number(item.amount) };
  }));
}

function ownQuantities(value: readonly EffectExposureQuantity[]): readonly EffectExposureQuantity[] {
  const quantities = value.map((item) => Object.freeze({ unit: item.unit, amount: item.amount }));
  if (new Set(quantities.map((item) => item.unit)).size !== quantities.length) throw new TypeError('Effect exposure units must be unique.');
  return Object.freeze(quantities);
}

function encodeQuantities(value: readonly EffectExposureQuantity[]): readonly JsonObject[] {
  return Object.freeze(value.map((item) => Object.freeze({ unit: item.unit, amount: item.amount })));
}

function unknownExposure(reservation: EffectExposureReservation): Extract<EffectExposureSettlement, { readonly status: 'unknown' }> {
  return Object.freeze({ status: 'unknown', reserved: ownQuantities(reservation.quantities) });
}

function ticketsEqual(left: EffectStartTicket, right: EffectStartTicket): boolean {
  return left.ticketId === right.ticketId && left.effectId === right.effectId && left.parametersDigest === right.parametersDigest && left.driverGeneration === right.driverGeneration;
}

function permitsEqual(left: EffectSettlementPermit, right: EffectSettlementPermit): boolean {
  return left.permitId === right.permitId && left.effectId === right.effectId && left.parametersDigest === right.parametersDigest;
}

function settlementsEqual(left: ExternalEffectSettlement, right: ExternalEffectSettlement): boolean {
  return JSON.stringify(encodeExternalEffectSettlement(left)) === JSON.stringify(encodeExternalEffectSettlement(right));
}

function quantitiesEqual(left: readonly EffectExposureQuantity[], right: readonly EffectExposureQuantity[]): boolean {
  return JSON.stringify(encodeQuantities(left)) === JSON.stringify(encodeQuantities(right));
}

function assertEffectBinding(intent: ExternalEffectIntent, value: { readonly effectId: string; readonly parametersDigest: string }, label: string): void {
  if (intent.effectId !== value.effectId || intent.parametersDigest !== value.parametersDigest) throw new TypeError(`Effect ${label} does not match its intent.`);
}

function object(value: unknown, label: string): JsonObject {
  try { return parseJsonObject(value, { maxDepth: 12, maxCollectionEntries: 10_000, maxStringBytes: 64_000, maxTotalBytes: 1_000_000 }); }
  catch (error) { throw new TypeError(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || hasControlCharacter(value)) throw new TypeError(`${label} must be a non-empty string without control characters.`);
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO-8601 UTC timestamp.`);
  return value;
}

function generation(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer.`);
}
