import { hashJson } from '@agent-core/evidence';
import { parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';
import { abortableToolBoundary, MissingToolServiceError, throwIfAborted, ToolInputError, type ToolExecutionContext, type ToolPreparationContext } from './context.js';
import type { ToolCall, ToolDefinition, ToolObservation } from './definition.js';
import { invalidOutputObservation, invalidToolInputObservation, missingServiceObservation, parseToolObservation, runtimeErrorObservation, unknownToolObservation } from './observation.js';
import { assertEffectsWithinEnvelope, validateToolEffects, type ToolEffects } from './authorization.js';

export interface PreparedToolCall {
  readonly call: ToolCall;
  readonly toolImplementationId: string;
  readonly canonicalSnapshot: JsonValue;
  readonly effects: ToolEffects & JsonObject;
  readonly fingerprint: string;
  invoke(context: ToolExecutionContext): Promise<ToolObservation>;
}

export type ToolCallPreparation =
  | { readonly ok: true; readonly prepared: PreparedToolCall }
  | { readonly ok: false; readonly observation: ToolObservation };

/** Resolve, parse, canonicalize, and derive effects before any authorization decision. */
export async function prepareToolCall(call: ToolCall, tools: readonly ToolDefinition[], context: ToolPreparationContext): Promise<ToolCallPreparation> {
  const ownedCall = ownToolCall(call);
  const tool = tools.find((candidate) => candidate.name === ownedCall.name);
  if (!tool) return { ok: false, observation: unknownToolObservation(ownedCall) };
  try {
    const decoded = tool.decodeInput(ownedCall.input);
    if (!decoded.ok) return { ok: false, observation: decoded.observation };
    const canonicalized = await abortableToolBoundary(context.signal, () => tool.canonicalizeInput(decoded.input, context));
    const canonicalSnapshot = tool.snapshotInput(canonicalized);
    const effects = validateToolEffects(await abortableToolBoundary(context.signal, () => tool.deriveEffects(canonicalized, context)));
    assertEffectsWithinEnvelope(effects, tool.effectEnvelope);
    const fingerprintInput: JsonObject = Object.freeze({
      tool: Object.freeze({
        name: tool.name,
        implementationId: tool.implementationId,
        description: tool.description,
        jsonSchema: tool.jsonSchema,
        effectEnvelope: Object.freeze({
          accesses: Object.freeze(tool.effectEnvelope.accesses.map((access) => Object.freeze({ mode: access.mode, scope: access.scope }))),
          lockScopes: Object.freeze([...tool.effectEnvelope.lockScopes])
        })
      }),
      canonicalInput: canonicalSnapshot,
      effects,
      policy: context.policy,
      boundary: Object.freeze({ authorizationPolicyId: context.boundary.authorizationPolicyId, executionTargetId: context.boundary.executionTargetId })
    });
    return { ok: true, prepared: Object.freeze({
      call: ownedCall,
      toolImplementationId: tool.implementationId,
      canonicalSnapshot,
      effects,
      fingerprint: hashJson(fingerprintInput),
      invoke: async (executionContext: ToolExecutionContext) => {
        const observation = await tool.invoke(canonicalized, executionContext);
        try { return parseToolObservation(tool, observation); }
        catch (error) { return parseToolObservation(undefined, invalidOutputObservation(tool.name, error instanceof Error ? error : new Error(String(error)))); }
      }
    }) };
  } catch (error) {
    if (context.signal.aborted) { throwIfAborted(context.signal); }
    if (error instanceof ToolInputError) return { ok: false, observation: invalidToolInputObservation(tool.name, error.message, error.details) };
    if (error instanceof MissingToolServiceError) return { ok: false, observation: missingServiceObservation(tool.name, error.serviceName, undefined, error.details) };
    return { ok: false, observation: runtimeErrorObservation(tool.name, error) };
  }
}

function ownToolCall(value: unknown): ToolCall {
  const record = parseJsonObject(value, { maxDepth: 32, maxCollectionEntries: 20_000, maxStringBytes: 4_000_000, maxTotalBytes: 8_000_000 });
  if (Object.keys(record).some((key) => key !== 'id' && key !== 'name' && key !== 'input') || typeof record.name !== 'string' || record.name.trim().length === 0
    || (record.id !== undefined && typeof record.id !== 'string') || !jsonObject(record.input)) throw new Error('Tool call does not match the strict JSON tool-call contract.');
  const input = record.input;
  if (input.kind === 'json' && jsonObject(input.value)) return Object.freeze({ ...(typeof record.id === 'string' ? { id: record.id } : {}), name: record.name, input: Object.freeze({ kind: 'json', value: input.value }) });
  if (input.kind === 'text' && typeof input.value === 'string') return Object.freeze({ ...(typeof record.id === 'string' ? { id: record.id } : {}), name: record.name, input: Object.freeze({ kind: 'text', value: input.value }) });
  throw new Error('Tool call input is invalid.');
}
function jsonObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
