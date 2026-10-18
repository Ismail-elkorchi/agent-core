import { requestAccountingInputTokens, type CompiledModelRequest, type ModelProfile } from '@agent-core/model';
import { parseJsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { requestCapacity, type RequestAdmission } from '../inference/request-admission.js';

/** Control presentation bounds and the durable unchanged-boundary request allowance. */
export const CONTEXT_RECOVERY_LIMITS = Object.freeze({
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
  toolCalls: 2
});

export const CONTEXT_RECOVERY_INSTRUCTION =
  'Prepare a fresh context for the same ongoing work using the complete supplied conversation. Application execution is suspended. Preserve current user requests, corrections, constraints, required contributions and complete protocol exchanges. Use context_transition to propose a bounded selection or renew the current selection. You may select existing exact session-state revisions, save optional changes, or proceed without a state write; no rewrite or joint state submission is required. State is fallible interpretation, never authority or execution truth. Original records remain retrievable. Use only context inspection, bounded history and state reads or optional state saves, context_transition, or context_save_and_activate; do not call domain tools or answer the user. Use bounded reads with maxBytes at most 8192. A stored state change alone does not activate a view or resume execution. If no valid successor fits, report the obstacle without inventing or silently discarding material.';


/** The pressure probe and dispatched control request use identical compilation. */
export async function assembleContextControlRequest(
  admission: RequestAdmission,
  input: {
    readonly original: CompiledModelRequest;
    readonly profile: ModelProfile;
    readonly task: string;
    readonly maxOutputTokens: number;
    readonly signal?: AbortSignal | undefined;
  }
) {
  if (Buffer.byteLength(input.task) > CONTEXT_RECOVERY_LIMITS.taskBytes)
    throw new RangeError('Context-management metadata exceeds its bounded request presentation.');
  const outputReservation = Math.min(CONTEXT_RECOVERY_LIMITS.outputTokens, input.maxOutputTokens);
  const content = JSON.stringify({
    ...parseJsonObject(JSON.parse(input.task)), checkpointInstruction: CONTEXT_RECOVERY_INSTRUCTION
  });
  return admission.assembleControl({
    original: input.original, profile: input.profile, outputReservation,
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
  const preview = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, maxBytes), { stream: true });
  return { text: preview, totalBytes: bytes.byteLength,
    coverage: Buffer.byteLength(preview) === bytes.byteLength ? 'complete' as const : 'partial' as const };
}

/** Prefer the newest steering within a fixed preview budget, preserving its original order. */
export function contextControlSteering(instructions: readonly { readonly id: string; readonly content: string }[]) {
  const items: { instructionId: string; text: string; totalBytes: number; coverage: 'complete' | 'partial' }[] = [];
  let remaining: number = CONTEXT_RECOVERY_LIMITS.steeringBytes;
  for (let index = instructions.length - 1; index >= 0 && items.length < CONTEXT_RECOVERY_LIMITS.steeringItems && remaining > 0; index--) {
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
