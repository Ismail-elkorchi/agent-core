import { requestAccountingInputTokens, type CompiledModelRequest, type ModelProfile, type ModelTool } from '@agent-core/model';
import { parseJsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { createPromptMaterial } from '../inference/prompt-material.js';
import type { ModelRequest } from '@agent-core/model';
import type { RequestAdmission } from '../inference/request-admission.js';
import type { PromptToolSummary } from '../inference/prompt-material.js';

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
  'Prepare a fresh context for the same ongoing work using the complete supplied conversation. Application execution is suspended. Reconcile current user requests, corrections and constraints; preserve material findings with evidence and usable unfinished work in sessionState. Select a recent source boundary and older exact evidence using context_transition. State is fallible interpretation, never authority or execution truth. Original records remain retrievable. Use only context inspection, history reads/search/latest and context_transition; do not call domain tools or answer the user. Keep required user contributions and protocol exchanges. Use bounded reads with maxBytes at most 8192. Submit state and selection together. If no valid successor fits, do not invent or silently discard material.';


/** The pressure probe and dispatched control request use identical compilation. */
export async function assembleContextControlRequest(
  admission: RequestAdmission,
  input: {
    readonly original: ModelRequest;
    readonly model: string;
    readonly profile: ModelProfile;
    readonly tools: readonly ModelTool[];
    readonly summaries: readonly PromptToolSummary[];
    readonly task: string;
    readonly maxOutputTokens: number;
    readonly signal?: AbortSignal | undefined;
  }
) {
  if (Buffer.byteLength(input.task) > CONTEXT_RECOVERY_LIMITS.taskBytes)
    throw new RangeError('Context-management metadata exceeds its bounded request presentation.');
  const outputReservation = Math.min(CONTEXT_RECOVERY_LIMITS.outputTokens, input.maxOutputTokens);
  const roles = input.profile.capabilities.protocol?.roles ?? ['system', 'user', 'assistant'];
  if (!roles.includes('user')) throw new RangeError('Context renewal requires a supported user control-message role.');
  // Explicit runtime control is a new user message. Authority, signed native prefix,
  // originals and tools are preserved exactly; the execution gate restricts effects.
  const control = { role: 'user' as const, content: JSON.stringify({
    ...parseJsonObject(JSON.parse(input.task)), checkpointInstruction: CONTEXT_RECOVERY_INSTRUCTION
  }) };
  const messages = [...input.original.messages, control];
  const request: ModelRequest = {
    ...input.original,
    messages,
    ...(input.profile.supportedParameters.includes('maxOutputTokens') ? { maxOutputTokens: outputReservation } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  };
  const presentation = {
    authority: hashJson(request.messages.filter(message => message.role === 'system' || message.role === 'developer')),
    // The complete original request is carried as captured material, never reconstructed summaries.
    context: hashJson(input.original.messages.filter(message => message.role !== 'system' && message.role !== 'developer')),
    sessionState: hashJson(null),
    runInstructions: hashJson([control])
  };
  const compiled = await admission.compile(request, input.profile, outputReservation, presentation);
  const material = createPromptMaterial({ task: control.content,
    instructions: [],
    context: [], tools: input.summaries });
  return { request, compiled, assembly: { material, messages: request.messages,
    context: { items: [], totalTokens: 0 },
    estimate: { modelWindowTokens: requestAccountingInputTokens(compiled.accounting), contextTokens: 0 } } };

}

/** Total compiled footprint, including independent reasoning reservation. */
export function contextControlHeadroom(compiled: CompiledModelRequest): number {
  return requestAccountingInputTokens(compiled.accounting) + compiled.accounting.outputReservation +
    (compiled.accounting.pricingSemantics.reasoningIncludedInOutput === false
      ? compiled.accounting.reasoningReservation : 0);
}

/** Leave room after an ordinary response for the full checkpoint's additional input and output. */
export function contextControlReserve(original: CompiledModelRequest, checkpoint: CompiledModelRequest): number {
  const checkpointOutput = checkpoint.accounting.outputReservation +
    (checkpoint.accounting.pricingSemantics.reasoningIncludedInOutput === false ? checkpoint.accounting.reasoningReservation : 0);
  return Math.max(0, contextControlHeadroom(checkpoint) - contextControlHeadroom(original) + checkpointOutput);
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
