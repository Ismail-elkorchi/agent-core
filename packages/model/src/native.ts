import { parseJsonObject } from '@agent-core/json';
import type { CompiledModelRequest } from './accounting.js';
import type { ModelInputItem, ModelRequest, ModelTool, ModelToolResultInput } from './index.js';
import { ModelContractError, parseModelRequest } from './validation.js';

export type ModelDeliveryStatus = 'submitted' | 'acknowledged' | 'applied' | 'failed' | 'uncertain';
export interface ModelNativeToolCallIdentity {
  readonly responseId: string;
  readonly catalogIdentity: string;
  readonly toolCallId: string;
}
export interface ModelNativeDelivery {
  readonly deliveryId: string;
  /** Current continuation parent, which can differ from a result's source response. */
  readonly responseId: string;
  readonly inputIdentity: string;
  readonly status: ModelDeliveryStatus;
  readonly successorResponseId?: string;
  readonly detail?: string;
}
export interface ModelToolResultDelivery extends ModelNativeDelivery {
  readonly sourceCalls: readonly ModelNativeToolCallIdentity[];
}
export interface ModelToolResultSubmission {
  readonly deliveryId: string;
  readonly responseId: string;
  readonly results: readonly ModelToolResultInput[];
  readonly sourceCalls: readonly ModelNativeToolCallIdentity[];
  readonly tools?: readonly ModelTool[];
  readonly signal?: AbortSignal;
}
export interface ModelNativeContinuation {
  readonly deliveryId: string;
  readonly responseId: string;
  readonly input: readonly ModelInputItem[];
  readonly tools?: readonly ModelTool[];
  readonly signal?: AbortSignal;
}
export interface ModelNativeDispatch {
  readonly kind: 'steering' | 'tool_results' | 'continuation';
  readonly deliveryId: string;
  readonly responseId: string;
  /** Exact frame bytes/state, owned by the native session and admitted before send. */
  readonly compiled: CompiledModelRequest;
  readonly sourceCalls: readonly ModelNativeToolCallIdentity[];
  /** Existing steering reservation reused by an explicit required-result continuation. */
  readonly generationDeliveryId: string;
}
export interface ModelNativeResponseBoundary {
  readonly responseId: string;
  readonly previousResponseId?: string;
  readonly deliveryIds: readonly string[];
  readonly generationDeliveryId?: string;
  readonly requiredToolCallIds: readonly string[];
  readonly pendingToolCalls: readonly ModelNativeToolCallIdentity[];
  readonly continuation: 'client' | 'automatic';
  readonly inputIdentity: string;
  readonly catalogIdentity: string;
  /** Exact causal input for this response, excluding this response's output. */
  readonly request: ModelRequest;
}
export interface ModelTransportOptions {
  readonly signal?: AbortSignal;
  readonly native?: {
    /** Persist and reserve before returning. Throwing prevents transport submission. */
    readonly admit: (dispatch: ModelNativeDispatch) => Promise<void>;
  };
}
/** Transport cancellation never changes the compiled request or its model-visible identity. */
export function modelTransportSignal(
  request: ModelRequest,
  options?: ModelTransportOptions
): AbortSignal | undefined {
  if (!options?.signal || options.signal === request.signal) return request.signal;
  return request.signal ? AbortSignal.any([request.signal, options.signal]) : options.signal;
}
function required(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new ModelContractError('Invalid native identity.', ['Nonempty string required.']);
  return value;
}
export function parseModelNativeToolCallIdentity(value: unknown): ModelNativeToolCallIdentity {
  const item = parseJsonObject(value);
  if (Object.keys(item).some((key) => !['responseId', 'catalogIdentity', 'toolCallId'].includes(key)))
    throw new ModelContractError('Invalid native call identity.', ['Unknown field.']);
  return Object.freeze({
    responseId: required(item.responseId),
    catalogIdentity: required(item.catalogIdentity),
    toolCallId: required(item.toolCallId)
  });
}
export function parseModelNativeDelivery(value: unknown): ModelNativeDelivery {
  const item = parseJsonObject(value);
  const status = item.status;
  if (
    status !== 'submitted' &&
    status !== 'acknowledged' &&
    status !== 'applied' &&
    status !== 'failed' &&
    status !== 'uncertain'
  )
    throw new ModelContractError('Invalid native delivery.', ['Unknown status.']);
  if (status === 'applied' && item.successorResponseId === undefined)
    throw new ModelContractError('Invalid native delivery.', [
      'Applied delivery requires its causal successor.'
    ]);
  return Object.freeze({
    deliveryId: required(item.deliveryId),
    responseId: required(item.responseId),
    inputIdentity: required(item.inputIdentity),
    status,
    ...(item.successorResponseId === undefined
      ? {}
      : { successorResponseId: required(item.successorResponseId) }),
    ...(item.detail === undefined ? {} : { detail: required(item.detail) })
  });
}
export function parseModelToolResultDelivery(value: unknown): ModelToolResultDelivery {
  const item = parseJsonObject(value);
  if (!Array.isArray(item.sourceCalls) || !item.sourceCalls.length)
    throw new ModelContractError('Invalid native result delivery.', ['Original source calls required.']);
  const sourceCalls = item.sourceCalls.map(parseModelNativeToolCallIdentity);
  if (new Set(sourceCalls.map((call) => call.toolCallId)).size !== sourceCalls.length)
    throw new ModelContractError('Invalid native result delivery.', ['Duplicate source call.']);
  return Object.freeze({
    ...parseModelNativeDelivery(item),
    sourceCalls: Object.freeze(sourceCalls)
  });
}
export function parseModelNativeResponseBoundary(value: unknown): ModelNativeResponseBoundary {
  const item = parseJsonObject(value);
  if (
    !Array.isArray(item.requiredToolCallIds) ||
    !Array.isArray(item.pendingToolCalls) ||
    (item.continuation !== 'client' && item.continuation !== 'automatic')
  )
    throw new ModelContractError('Invalid native boundary.', ['Structured protocol obligations required.']);
  if (!Array.isArray(item.deliveryIds))
    throw new ModelContractError('Invalid native boundary.', ['Delivery identities required.']);
  const pendingToolCalls = item.pendingToolCalls.map(parseModelNativeToolCallIdentity);
  const requiredToolCallIds = item.requiredToolCallIds.map(required);
  const deliveryIds = item.deliveryIds.map(required);
  if (
    new Set(pendingToolCalls.map((call) => call.toolCallId)).size !== pendingToolCalls.length ||
    new Set(requiredToolCallIds).size !== requiredToolCallIds.length ||
    new Set(deliveryIds).size !== deliveryIds.length ||
    requiredToolCallIds.some((id) => !pendingToolCalls.some((call) => call.toolCallId === id))
  )
    throw new ModelContractError('Invalid native boundary.', [
      'Duplicate or unmatched protocol obligations.'
    ]);
  if (item.generationDeliveryId !== undefined && !deliveryIds.includes(required(item.generationDeliveryId)))
    throw new ModelContractError('Invalid native boundary.', ['Generation is not a contributing delivery.']);
  return Object.freeze({
    responseId: required(item.responseId),
    ...(item.previousResponseId === undefined
      ? {}
      : { previousResponseId: required(item.previousResponseId) }),
    deliveryIds: Object.freeze(deliveryIds),
    ...(item.generationDeliveryId === undefined
      ? {}
      : { generationDeliveryId: required(item.generationDeliveryId) }),
    requiredToolCallIds: Object.freeze(requiredToolCallIds),
    pendingToolCalls: Object.freeze(pendingToolCalls),
    continuation: item.continuation,
    inputIdentity: required(item.inputIdentity),
    catalogIdentity: required(item.catalogIdentity),
    request: parseModelRequest(item.request)
  });
}
