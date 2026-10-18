import { requestAccountingInputTokens, type CompiledModelRequest, type ModelProfile } from '@agent-core/model';
import type { CompiledToolDefinition, ToolDefinition } from '@agent-core/tools';
import { parseJsonObject, DEFAULT_SAFE_JSON_PARSE_LIMITS } from '@agent-core/json';
import { MAX_MANIFEST_BYTES } from './inspection.js';
import { SESSION_STATE_RETRIEVAL_LIMITS } from '../session/session-state.js';
import { hashJson } from '@agent-core/persistence';
import { requestCapacity, type RequestAdmission } from '../inference/request-admission.js';

/** Control presentation bounds and the durable unchanged-boundary request allowance. */
export const DEFAULT_CONTEXT_CONTROL_POLICY = Object.freeze({
  requestsPerBoundary: 4,
  inventoryBytes: 4096,
  inventoryItems: 12,
  resultBytes: 8192,
  recentResults: 2,
  taskBytes: 32768,
  currentRequestBytes: 4096,
  steeringBytes: 4096,
  steeringItems: 8,
  statePreviewBytes: 2048,
  outputTokens: 8192,
  toolCalls: 2,
  exchangeRecords: 16,
  sourceReadBytes: 32768,
  rejectionBytes: 8192,
  rejectionPreviewBytes: 2048,
  reserveMode: 'required'
});

export type ContextControlPolicy = { readonly [K in keyof typeof DEFAULT_CONTEXT_CONTROL_POLICY]: K extends 'reserveMode' ? 'required' | 'advisory' : number };

/** Ceilings are bounded by the metadata paging, inspection and JSON contracts used below. */
export const CONTEXT_CONTROL_POLICY_BOUNDS = Object.freeze({
  requestsPerBoundary: 4095, exchangeRecords: 4096, toolCalls: 4095,
  inventoryItems: 100, inventoryBytes: MAX_MANIFEST_BYTES,
  resultBytes: DEFAULT_SAFE_JSON_PARSE_LIMITS.maxStringBytes,
  taskBytes: DEFAULT_SAFE_JSON_PARSE_LIMITS.maxStringBytes,
  currentRequestBytes: DEFAULT_SAFE_JSON_PARSE_LIMITS.maxStringBytes,
  steeringBytes: DEFAULT_SAFE_JSON_PARSE_LIMITS.maxStringBytes, steeringItems: 1024,
  statePreviewBytes: SESSION_STATE_RETRIEVAL_LIMITS.maxBytes,
  sourceReadBytes: DEFAULT_SAFE_JSON_PARSE_LIMITS.maxTotalBytes,
  rejectionBytes: DEFAULT_SAFE_JSON_PARSE_LIMITS.maxTotalBytes,
  rejectionPreviewBytes: DEFAULT_SAFE_JSON_PARSE_LIMITS.maxStringBytes,
  recentResults: 4096, outputTokens: Number.MAX_SAFE_INTEGER
});

/** Host policy is captured once; every numeric allowance is finite and positive. */
export function parseContextControlPolicy(input: unknown = {}): ContextControlPolicy {
  const object = parseJsonObject(input);
  const policy: Record<string, unknown> = { ...DEFAULT_CONTEXT_CONTROL_POLICY, ...object };
  for (const [key, value] of Object.entries(policy)) {
    if (!Object.hasOwn(DEFAULT_CONTEXT_CONTROL_POLICY, key)) throw new TypeError(`Unknown context control policy field: ${key}`);
    if (key === 'reserveMode') {
      if (value !== 'required' && value !== 'advisory') throw new TypeError('Invalid context reserve mode.');
    } else {
      const maximum = CONTEXT_CONTROL_POLICY_BOUNDS[key as keyof typeof CONTEXT_CONTROL_POLICY_BOUNDS];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new TypeError(`Context control ${key} must be an integer from 1 to ${String(maximum)}.`);
    }
  }
  if (Number(policy.toolCalls) + 1 > Number(policy.exchangeRecords))
    throw new TypeError('Context control exchangeRecords must cover one response and every permitted tool result.');
  return Object.freeze(policy) as ContextControlPolicy;
}

export interface OutputReservationPolicy { readonly minimum: number; readonly maximum: number }
export function parseOutputReservationPolicy(input: unknown): OutputReservationPolicy {
  const value = parseJsonObject(input);
  if (Object.keys(value).some(key => key !== 'minimum' && key !== 'maximum') ||
      typeof value.minimum !== 'number' || !Number.isSafeInteger(value.minimum) || value.minimum < 1 ||
      typeof value.maximum !== 'number' || !Number.isSafeInteger(value.maximum) || value.maximum < value.minimum)
    throw new TypeError('Output reservation policy requires positive ordered minimum and maximum.');
  return Object.freeze({ minimum: value.minimum, maximum: value.maximum });
}

/** Resolve a current window choice under the host's fixed ceiling or explicit range. */
export function resolveOutputReservation(configured: number, policy: OutputReservationPolicy | undefined, selected?: number): number {
  if (!Number.isSafeInteger(configured) || configured < 1 || (policy && policy.maximum > configured))
    throw new RangeError('Output reservation policy exceeds the configured output allowance.');
  const reservation = selected ?? policy?.maximum ?? configured;
  if (!Number.isSafeInteger(reservation) || reservation < 1 ||
      (policy ? reservation < policy.minimum || reservation > policy.maximum : reservation !== configured))
    throw new RangeError('Requested output reservation is outside the host-authorized allowance; the prior window remains unchanged.');
  return reservation;
}

export type ContextControlRole = 'read' | 'state' | 'activation' | 'catalog';
const controlGrants = new WeakMap<ToolDefinition, ContextControlRole>();
/** Explicit host grant bound to this exact compiled definition, never its self-declared name or ID. */
export function grantContextControlTool<T extends CompiledToolDefinition>(tool: T, role: ContextControlRole): T {
  if (!['read', 'state', 'activation', 'catalog'].includes(role)) throw new TypeError('Invalid context control role.');
  if (role === 'read' && !tool.effectEnvelope.accesses.every(access => access.mode === 'read' &&
      ['context', 'history', 'session_state', 'tool_catalog'].includes(access.scope)))
    throw new TypeError('Context control reads require read-only context, history, session-state or tool-catalog effects.');
  controlGrants.set(tool, role);
  return tool;
}
export function contextControlRole(tool: ToolDefinition | undefined): ContextControlRole | undefined {
  return tool ? controlGrants.get(tool) : undefined;
}

function contextRecoveryInstruction(policy: ContextControlPolicy): string {
  return `Prepare a fresh context for the same ongoing work using the complete supplied conversation. Application execution is suspended. Preserve current user requests, corrections, constraints, required contributions and complete protocol exchanges. Use context_transition to propose a bounded selection or renew the current selection. You may select existing exact session-state revisions, save optional changes, or proceed without a state write; no rewrite or joint state submission is required. State is fallible interpretation, never authority or execution truth. Original records remain retrievable. Use only the host-granted controlTools listed here for context inspection, bounded history and state reads, optional state saves, context activation, or exact tool-catalog selection; do not call domain tools or answer the user. Use bounded reads with maxBytes at most ${String(policy.resultBytes)}. A stored state change alone does not activate a view or resume execution. tool_catalog_select can replace the loaded tool selection with fewer references, or an empty array, to reduce tool-schema cost; the successor still requires admission. If no valid successor fits, report the obstacle without inventing or silently discarding material.`;
}


/** The pressure probe and dispatched control request use identical compilation. */
export async function assembleContextControlRequest(
  admission: RequestAdmission,
  input: {
    readonly policy?: ContextControlPolicy;
    readonly original: CompiledModelRequest;
    readonly profile: ModelProfile;
    readonly task: string;
    readonly tools?: readonly import('@agent-core/model').ModelTool[];
    readonly maxOutputTokens: number;
    readonly signal?: AbortSignal | undefined;
  }
) {
  const policy = input.policy ?? DEFAULT_CONTEXT_CONTROL_POLICY;
  if (Buffer.byteLength(input.task) > policy.taskBytes)
    throw new RangeError('Context-management metadata exceeds its bounded request presentation.');
  const outputReservation = Math.min(policy.outputTokens, input.maxOutputTokens);
  const content = JSON.stringify({
    ...parseJsonObject(JSON.parse(input.task)), checkpointInstruction: contextRecoveryInstruction(policy)
  });
  if (Buffer.byteLength(content) > policy.taskBytes)
    throw new RangeError('Context-management metadata and instructions exceed the configured task presentation bound.');
  return admission.assembleControl({
    original: input.original, profile: input.profile, outputReservation,
    ...(input.tools ? { tools: input.tools } : {}),
    control: { kind: 'context-recovery', id: `context-recovery-${hashJson(content)}`, content },
    ...(input.signal ? { signal: input.signal } : {})
  });

}

/**
 * Reserve the next checkpoint after the ordinary generation is retained as input.
 * Input-only limits do not release the ordinary output reservation: compare each
 * compiled request's actual input capacity, not just their total footprints.
 * Tool observations and newly accepted input still need their own admission.
 */
export function contextControlReserve(original: CompiledModelRequest, checkpoint: CompiledModelRequest): number {
  const ordinaryCapacity = requestCapacity(original.accounting).inputCapacity;
  const checkpointCapacity = requestCapacity(checkpoint.accounting).inputCapacity;
  if (ordinaryCapacity === undefined || checkpointCapacity === undefined) return 0;
  const output = original.accounting.outputReservation +
    (original.accounting.pricingSemantics.reasoningIncludedInOutput === false ? original.accounting.reasoningReservation : 0);
  // A retained generation becomes input, including the input estimator's margin.
  const retainedOutput = Math.ceil(output * (1 + checkpoint.accounting.uncertainty.headroomRatio));
  const inputDelta = requestAccountingInputTokens(checkpoint.accounting) - requestAccountingInputTokens(original.accounting);
  return Math.max(0, ordinaryCapacity - checkpointCapacity + inputDelta + retainedOutput);
}

/** A bounded presentation retains explicit byte coverage and never changes its source. */
export function contextControlPreview(text: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(text);
  const preview = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, maxBytes), { stream: true });
  return { text: preview, totalBytes: bytes.byteLength,
    coverage: Buffer.byteLength(preview) === bytes.byteLength ? 'complete' as const : 'partial' as const };
}

/** Prefer the newest steering within a fixed preview budget, preserving its original order. */
export function contextControlSteering(instructions: readonly { readonly id: string; readonly content: string }[], policy: ContextControlPolicy = DEFAULT_CONTEXT_CONTROL_POLICY) {
  const items: { instructionId: string; text: string; totalBytes: number; coverage: 'complete' | 'partial' }[] = [];
  let remaining: number = policy.steeringBytes;
  for (let index = instructions.length - 1; index >= 0 && items.length < policy.steeringItems && remaining > 0; index--) {
    const instruction = instructions[index];
    if (!instruction) continue;
    const preview = contextControlPreview(instruction.content, remaining);
    items.unshift({ instructionId: instruction.id, ...preview });
    remaining -= Buffer.byteLength(preview.text);
  }
  return { items, totalItems: instructions.length,
    coverage: items.length === instructions.length && items.every(item => item.coverage === 'complete')
      ? 'complete' as const : 'partial' as const };
}
