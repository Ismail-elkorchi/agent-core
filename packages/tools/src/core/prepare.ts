import { hashJson } from '@agent-core/evidence';
import { decodeEffectRecoveryCapability, type EffectExecutionState } from '@agent-core/effects';
import type { JsonObject, JsonValue } from '@agent-core/json';
import { abortableToolBoundary, MissingToolServiceError, throwIfAborted, ToolInputError, type ToolCanonicalizationContext, type ToolExecutionContext, type ToolPreparationContext, type ToolPreparationLifetime, type ToolPreparationResource } from './context.js';
import type { ToolCall, ToolDefinition, ToolEffectRecoveryResult, ToolObservation } from './definition.js';
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
    const recover = tool.recover?.bind(tool);
    preparedToolCalls.set(prepared, {
      state: 'prepared',
      lifetime,
      ...(recover ? {
        recover: async (effect: Extract<EffectExecutionState, { readonly phase: 'started' }>, executionContext: ToolExecutionContext) => {
          let result: unknown;
          try {
            result = await recover(canonicalized, effect, executionContext);
          } catch (error) {
            if (executionContext.signal?.aborted) throwIfAborted(executionContext.signal);
            return Object.freeze({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
          }
          return decodeToolEffectRecoveryResult(tool, result);
        }
      } : {}),
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
  readonly recover?: (effect: Extract<EffectExecutionState, { readonly phase: 'started' }>, context: ToolExecutionContext) => Promise<PreparedToolEffectRecovery>;
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

export type PreparedToolEffectRecovery =
  | Exclude<ToolEffectRecoveryResult, { readonly status: 'settled' }>
  | { readonly status: 'settled'; readonly observation: ToolObservation };

export async function recoverPreparedToolCall(
  prepared: PreparedToolCall,
  effect: Extract<EffectExecutionState, { readonly phase: 'started' }>,
  context: ToolExecutionContext
): Promise<PreparedToolEffectRecovery> {
  const record = requirePreparedRecord(prepared);
  if (record.state !== 'prepared') throw new ToolInvocationAuthorityError('Tool call preparation is not available for recovery.');
  if (effect.intent.implementationId !== prepared.toolImplementationId || effect.intent.parametersDigest !== prepared.fingerprint) {
    throw new ToolInvocationAuthorityError('Effect recovery authority does not match the prepared tool call.');
  }
  if (!record.recover) return Object.freeze({ status: 'unavailable', reason: 'The tool implementation does not expose effect recovery.' });
  return record.recover(effect, context);
}

export async function startPreparedToolCall(
  prepared: PreparedToolCall,
  effect: Extract<EffectExecutionState, { readonly phase: 'started' }>
): Promise<ToolInvocation> {
  const record = requirePreparedRecord(prepared);
  if (record.state !== 'prepared') throw new ToolInvocationAuthorityError('Tool call preparation has already transferred or been released.');
  if (effect.intent.implementationId !== prepared.toolImplementationId || effect.intent.parametersDigest !== prepared.fingerprint) {
    await releasePreparedToolCall(prepared);
    throw new ToolInvocationAuthorityError('Effect authority does not match the prepared tool call.');
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

function decodeToolEffectRecoveryResult(tool: ToolDefinition, value: unknown): PreparedToolEffectRecovery {
  if (!record(value) || typeof value.status !== 'string') throw new TypeError('Tool recovery must return a recovery result.');
  if (value.status === 'reexecute') {
    exact(value, ['status', 'preconditions']);
    const capability = decodeEffectRecoveryCapability({ kind: 'preconditioned_reexecution', preconditions: value.preconditions });
    if (capability.kind !== 'preconditioned_reexecution') throw new TypeError('Tool recovery preconditions are invalid.');
    return Object.freeze({ status: value.status, preconditions: capability.preconditions });
  }
  if (value.status === 'settled') {
    exact(value, ['status', 'observation']);
    return Object.freeze({ status: value.status, observation: parseToolObservation(tool, value.observation) });
  }
  if (value.status === 'running') {
    exact(value, ['status']);
    return Object.freeze({ status: value.status });
  }
  if (value.status === 'not_found' || value.status === 'expired' || value.status === 'unavailable' || value.status === 'parameter_mismatch') {
    exact(value, ['status', 'reason']);
    if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.trim().length === 0)) throw new TypeError('Tool recovery reason must be non-empty.');
    return Object.freeze({ status: value.status, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) });
  }
  throw new TypeError('Tool recovery status is invalid.');
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) throw new TypeError(`Tool recovery returned unsupported fields: ${unsupported.join(', ')}.`);
}
