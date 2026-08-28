import { hashJson } from '@agent-core/evidence';
import { startExternalEffect, type EffectExecutionState } from '@agent-core/effects';
import type { JsonObject, JsonValue } from '@agent-core/json';
import { abortableToolBoundary, MissingToolServiceError, throwIfAborted, ToolInputError, type ToolCanonicalizationContext, type ToolExecutionContext, type ToolPreparationContext, type ToolPreparationLifetime, type ToolPreparationResource } from './context.js';
import type { ToolCall, ToolDefinition, ToolObservation } from './definition.js';
import { invalidOutputObservation, invalidToolInputObservation, missingServiceObservation, parseToolObservation, runtimeErrorObservation, unknownToolObservation } from './observation.js';
import { assertEffectsWithinEnvelope, encodeToolEffects, validateToolEffects, type ToolEffects } from './authorization.js';
import { encodeToolPolicy } from './policy.js';

const PREPARED_TOOL_CALL = Symbol('agent-core.prepared-tool-call');
const TOOL_INVOCATION = Symbol('agent-core.tool-invocation');
import { isOwnedToolCall } from './call.js';

export interface PreparedToolCall {
  readonly [PREPARED_TOOL_CALL]: true;
  readonly call: ToolCall;
  readonly toolImplementationId: string;
  readonly canonicalSnapshot: JsonValue;
  readonly effects: ToolEffects;
  readonly fingerprint: string;
}

export interface ToolInvocation {
  readonly [TOOL_INVOCATION]: true;
  readonly call: ToolCall;
  readonly effectId: string;
  readonly driverGeneration: number;
}

export class ToolInvocationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInvocationAuthorityError';
  }
}

export type ToolCallPreparation =
  | { readonly ok: true; readonly prepared: PreparedToolCall }
  | { readonly ok: false; readonly observation: ToolObservation };

/** Resolve, parse, canonicalize, and derive effects before any authorization decision. */
export async function prepareToolCall(call: ToolCall, tools: readonly ToolDefinition[], context: ToolPreparationContext): Promise<ToolCallPreparation> {
  if (!isOwnedToolCall(call)) throw new Error('Tool calls must be created or decoded before preparation.');
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return { ok: false, observation: unknownToolObservation(call) };
  const lifetime = new PreparationLifetime();
  const preparationContext: ToolCanonicalizationContext = Object.freeze({ ...context, preparation: lifetime });
  try {
    const decoded = tool.decodeInput(call.input);
    if (!decoded.ok) return { ok: false, observation: decoded.observation };
    const canonicalized = await abortableToolBoundary(context.signal, () => tool.canonicalizeInput(decoded.input, preparationContext));
    const canonicalSnapshot = tool.snapshotInput(canonicalized);
    const effects = validateToolEffects(await abortableToolBoundary(context.signal, () => tool.deriveEffects(canonicalized, preparationContext)));
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
      effects: encodeToolEffects(effects),
      policy: encodeToolPolicy(context.policy),
      boundary: Object.freeze({ authorizationPolicyId: context.boundary.authorizationPolicyId, executionTargetId: context.boundary.executionTargetId })
    });
    const prepared = Object.freeze({
      [PREPARED_TOOL_CALL]: true as const,
      call,
      toolImplementationId: tool.implementationId,
      canonicalSnapshot,
      effects,
      fingerprint: hashJson(fingerprintInput)
    });
    preparedToolCalls.set(prepared, {
      state: 'prepared',
      lifetime,
      invoke: async (executionContext: ToolExecutionContext) => {
        const observation = await tool.invoke(canonicalized, executionContext);
        try { return parseToolObservation(tool, observation); }
        catch (error) { return invalidOutputObservation(tool.name, error instanceof Error ? error : new Error(String(error))); }
      }
    });
    return { ok: true, prepared };
  } catch (error) {
    await lifetime.release();
    if (context.signal.aborted) { throwIfAborted(context.signal); }
    if (error instanceof ToolInputError) return { ok: false, observation: invalidToolInputObservation(tool.name, error.message, error.details) };
    if (error instanceof MissingToolServiceError) return { ok: false, observation: missingServiceObservation(tool.name, error.serviceName, undefined, error.details) };
    return { ok: false, observation: runtimeErrorObservation(tool.name, error) };
  }
}

interface PreparedToolCallRecord {
  state: 'prepared' | 'transferred' | 'released';
  readonly lifetime: PreparationLifetime;
  readonly invoke: (context: ToolExecutionContext) => Promise<ToolObservation>;
}

interface ToolInvocationRecord {
  state: 'ready' | 'running' | 'returned' | 'released';
  readonly prepared: PreparedToolCall;
  readonly lifetime: PreparationLifetime;
  readonly invoke: (context: ToolExecutionContext) => Promise<ToolObservation>;
  completion?: Promise<ToolObservation>;
}

const preparedToolCalls = new WeakMap<PreparedToolCall, PreparedToolCallRecord>();
const toolInvocations = new WeakMap<ToolInvocation, ToolInvocationRecord>();

export async function startPreparedToolCall(
  prepared: PreparedToolCall,
  effect: Extract<EffectExecutionState, { readonly phase: 'ticket_issued' }>,
  currentDriverGeneration: number
): Promise<ToolInvocation> {
  const record = requirePreparedRecord(prepared);
  if (record.state !== 'prepared') throw new ToolInvocationAuthorityError('Tool call preparation has already transferred or been released.');
  if (effect.intent.implementationId !== prepared.toolImplementationId || effect.intent.parametersDigest !== prepared.fingerprint) {
    await releasePreparedToolCall(prepared);
    throw new ToolInvocationAuthorityError('Effect authority does not match the prepared tool call.');
  }
  const started = startExternalEffect(effect, effect.ticket, currentDriverGeneration);
  if (started.status !== 'started') {
    await releasePreparedToolCall(prepared);
    throw new ToolInvocationAuthorityError(`Tool effect start was rejected: ${started.reason}.`);
  }
  record.state = 'transferred';
  const invocation = Object.freeze({
    [TOOL_INVOCATION]: true as const,
    call: prepared.call,
    effectId: effect.intent.effectId,
    driverGeneration: effect.ticket.driverGeneration
  });
  toolInvocations.set(invocation, { state: 'ready', prepared, lifetime: record.lifetime, invoke: record.invoke });
  return invocation;
}

export async function releasePreparedToolCall(prepared: PreparedToolCall): Promise<void> {
  const record = requirePreparedRecord(prepared);
  if (record.state === 'released') return;
  if (record.state === 'transferred') throw new ToolInvocationAuthorityError('Tool call preparation authority was transferred to an invocation.');
  record.state = 'released';
  await record.lifetime.release();
}

export function beginToolInvocation(invocation: ToolInvocation, context: ToolExecutionContext): Promise<ToolObservation> {
  const record = requireInvocationRecord(invocation);
  if (record.state !== 'ready') throw new ToolInvocationAuthorityError('Tool invocation authority is single-use.');
  record.state = 'running';
  const completion = record.invoke(context).finally(() => { if (record.state === 'running') record.state = 'returned'; });
  record.completion = completion;
  return completion;
}

export async function releaseToolInvocation(invocation: ToolInvocation): Promise<void> {
  const record = requireInvocationRecord(invocation);
  if (record.state === 'released') return;
  if (record.completion) await record.completion.catch(() => undefined);
  record.state = 'released';
  const prepared = requirePreparedRecord(record.prepared);
  prepared.state = 'released';
  await record.lifetime.release();
}

function requirePreparedRecord(prepared: PreparedToolCall): PreparedToolCallRecord {
  const record = preparedToolCalls.get(prepared);
  if (!record) throw new TypeError('Tool call preparation was not created by this package instance.');
  return record;
}

function requireInvocationRecord(invocation: ToolInvocation): ToolInvocationRecord {
  const record = toolInvocations.get(invocation);
  if (!record) throw new TypeError('Tool invocation was not created by this package instance.');
  return record;
}

class PreparationLifetime implements ToolPreparationLifetime {
  private readonly resources: ToolPreparationResource[] = [];
  private released = false;

  async own(resource: unknown): Promise<void> {
    if (!isPreparationResource(resource)) throw new TypeError('Preparation resources require a release operation.');
    if (this.released) {
      await resource.release();
      throw new Error('Tool preparation has already ended.');
    }
    this.resources.push(resource);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const failures: unknown[] = [];
    for (const resource of this.resources.splice(0).reverse()) {
      try { await resource.release(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Tool preparation resource release failed.');
  }
}

function isPreparationResource(value: unknown): value is ToolPreparationResource {
  return (typeof value === 'object' && value !== null || typeof value === 'function')
    && 'release' in value
    && typeof value.release === 'function';
}
