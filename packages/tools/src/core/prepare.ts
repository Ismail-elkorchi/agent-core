import { hashRecord, normalizeJsonSafe } from '@agent-core/evidence';
import { abortableToolBoundary, MissingToolServiceError, throwIfAborted, ToolInputError, type ToolPreparationContext } from './context.js';
import type { ToolCall, ToolDefinition, ToolObservation } from './definition.js';
import { invalidToolInputObservation, missingServiceObservation, runtimeErrorObservation, unknownToolObservation } from './observation.js';
import { assertEffectsWithinEnvelope, validateToolEffects, type ToolEffects } from './authorization.js';

export interface PreparedToolCall {
  readonly call: ToolCall;
  readonly tool: ToolDefinition;
  readonly decodedInput: unknown;
  readonly canonicalInput: unknown;
  readonly effects: ToolEffects;
  readonly fingerprint: string;
}

export type ToolCallPreparation =
  | { readonly ok: true; readonly prepared: PreparedToolCall }
  | { readonly ok: false; readonly observation: ToolObservation };

/** Resolve, parse, canonicalize, and derive effects before any authorization decision. */
export async function prepareToolCall(call: ToolCall, tools: readonly ToolDefinition[], context: ToolPreparationContext): Promise<ToolCallPreparation> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return { ok: false, observation: unknownToolObservation(call) };
  try {
    const decoded = tool.decodeInput(call.input);
    if (!decoded.ok) return { ok: false, observation: decoded.observation };
    const canonicalInput = await abortableToolBoundary(context.signal, () => tool.canonicalizeInput(decoded.input, context));
    const effects = validateToolEffects(await abortableToolBoundary(context.signal, () => tool.deriveEffects(canonicalInput, context)));
    assertEffectsWithinEnvelope(effects, tool.effectEnvelope);
    const normalized = normalizeJsonSafe({
      tool: { name: tool.name, implementationId: tool.implementationId, description: tool.description, jsonSchema: tool.jsonSchema, effectEnvelope: tool.effectEnvelope },
      canonicalInput,
      effects,
      policy: context.policy,
      boundary: context.boundary
    }, { maxDepth: 32, maxCollectionEntries: 20_000, maxStringBytes: 4_000_000, maxTotalBytes: 8_000_000 });
    if (normalized.diagnostics.length > 0) {
      return { ok: false, observation: invalidToolInputObservation(tool.name, 'Canonical tool input is not safely serializable.', { diagnostics: normalized.diagnostics }) };
    }
    return { ok: true, prepared: Object.freeze({ call, tool, decodedInput: decoded.input, canonicalInput, effects, fingerprint: hashRecord(normalized.value) }) };
  } catch (error) {
    if (context.signal.aborted) { throwIfAborted(context.signal); }
    if (error instanceof ToolInputError) return { ok: false, observation: invalidToolInputObservation(tool.name, error.message, error.details) };
    if (error instanceof MissingToolServiceError) return { ok: false, observation: missingServiceObservation(tool.name, error.serviceName, undefined, error.details) };
    return { ok: false, observation: runtimeErrorObservation(tool.name, error) };
  }
}
