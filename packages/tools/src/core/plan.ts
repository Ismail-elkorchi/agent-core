import { hashJson } from '@agent-core/persistence';
import { decodeEffectRecoveryCapability, type EffectExecutionState } from '@agent-core/effects';
import type { JsonObject, JsonValue } from '@agent-core/json';
import { abortableToolBoundary, MissingToolServiceError, throwIfAborted, ToolInputError, type ToolCanonicalizationContext, type ToolExecutionContext, type ToolPlanningContext, type ToolPlanLifetime, type ToolPlanResource } from './context.js';
import type { ToolCall, ToolDefinition, ToolEffectRecoveryResult, ToolObservation } from './definition.js';
import { invalidOutputObservation, invalidToolInputObservation, missingServiceObservation, parseToolObservation, runtimeErrorObservation, unknownToolObservation } from './observation.js';
import { assertEffectsWithinEnvelope, encodeToolEffects, validateToolEffects, type ToolEffects } from './authorization.js';
import { encodeToolPolicy } from './policy.js';

const TOOL_CALL_PLAN = Symbol('agent-core.plan-tool-call');
const TOOL_INVOCATION = Symbol('agent-core.tool-invocation');
import { isOwnedToolCall } from './call.js';

export interface ToolCallPlan {
  readonly [TOOL_CALL_PLAN]: true;
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

export type ToolCallPlanningResult =
  | { readonly ok: true; readonly plan: ToolCallPlan }
  | { readonly ok: false; readonly observation: ToolObservation };

/** Resolve, parse, canonicalize, and derive effects before any authorization decision. */
export async function planToolCall(call: ToolCall, tools: readonly ToolDefinition[], context: ToolPlanningContext): Promise<ToolCallPlanningResult> {
  if (!isOwnedToolCall(call)) throw new Error('Tool calls must be created or decoded before lifetime.');
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return { ok: false, observation: unknownToolObservation(call) };
  const lifetime = new PlanningLifetime();
  const planningContext: ToolCanonicalizationContext = Object.freeze({ ...context, lifetime });
  try {
    const decoded = tool.decodeInput(call.input);
    if (!decoded.ok) return { ok: false, observation: decoded.observation };
    const canonicalized = await abortableToolBoundary(context.signal, () => tool.canonicalizeInput(decoded.input, planningContext));
    const canonicalSnapshot = tool.snapshotInput(canonicalized);
    const effects = validateToolEffects(await abortableToolBoundary(context.signal, () => tool.deriveEffects(canonicalized, planningContext)));
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
    const plan = Object.freeze({
      [TOOL_CALL_PLAN]: true as const,
      call,
      toolImplementationId: tool.implementationId,
      canonicalSnapshot,
      effects,
      fingerprint: hashJson(fingerprintInput)
    });
    const recover = tool.recover?.bind(tool);
    toolCallPlans.set(plan, {
      state: 'planned',
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
    return { ok: true, plan };
  } catch (error) {
    await lifetime.release();
    if (context.signal.aborted) { throwIfAborted(context.signal); }
    if (error instanceof ToolInputError) return { ok: false, observation: invalidToolInputObservation(tool.name, error.message, error.details) };
    if (error instanceof MissingToolServiceError) return { ok: false, observation: missingServiceObservation(tool.name, error.serviceName, undefined, error.details) };
    return { ok: false, observation: runtimeErrorObservation(tool.name, error) };
  }
}

interface ToolCallPlanRecord {
  state: 'planned' | 'transferred' | 'released';
  readonly lifetime: PlanningLifetime;
  readonly recover?: (effect: Extract<EffectExecutionState, { readonly phase: 'started' }>, context: ToolExecutionContext) => Promise<ToolEffectRecoveryDecision>;
  readonly invoke: (context: ToolExecutionContext) => Promise<ToolObservation>;
}

interface ToolInvocationRecord {
  state: 'ready' | 'running' | 'returned' | 'released';
  readonly plan: ToolCallPlan;
  readonly lifetime: PlanningLifetime;
  readonly invoke: (context: ToolExecutionContext) => Promise<ToolObservation>;
  completion?: Promise<ToolObservation>;
}

const toolCallPlans = new WeakMap<ToolCallPlan, ToolCallPlanRecord>();
const toolInvocations = new WeakMap<ToolInvocation, ToolInvocationRecord>();

export type ToolEffectRecoveryDecision =
  | Exclude<ToolEffectRecoveryResult, { readonly status: 'settled' }>
  | { readonly status: 'settled'; readonly observation: ToolObservation };

export async function recoverToolCallPlan(
  plan: ToolCallPlan,
  effect: Extract<EffectExecutionState, { readonly phase: 'started' }>,
  context: ToolExecutionContext
): Promise<ToolEffectRecoveryDecision> {
  const record = requireToolCallPlanRecord(plan);
  if (record.state !== 'planned') throw new ToolInvocationAuthorityError('Tool call lifetime is not available for recovery.');
  if (effect.intent.implementationId !== plan.toolImplementationId || effect.intent.parametersDigest !== plan.fingerprint) {
    throw new ToolInvocationAuthorityError('Effect recovery authority does not match the tool-call plan.');
  }
  if (!record.recover) return Object.freeze({ status: 'unavailable', reason: 'The tool implementation does not expose effect recovery.' });
  return record.recover(effect, context);
}

export async function startToolCallPlan(
  plan: ToolCallPlan,
  effect: Extract<EffectExecutionState, { readonly phase: 'started' }>
): Promise<ToolInvocation> {
  const record = requireToolCallPlanRecord(plan);
  if (record.state !== 'planned') throw new ToolInvocationAuthorityError('Tool call lifetime has already transferred or been released.');
  if (effect.intent.implementationId !== plan.toolImplementationId || effect.intent.parametersDigest !== plan.fingerprint) {
    await releaseToolCallPlan(plan);
    throw new ToolInvocationAuthorityError('Effect authority does not match the tool-call plan.');
  }
  record.state = 'transferred';
  const invocation = Object.freeze({
    [TOOL_INVOCATION]: true as const,
    call: plan.call,
    effectId: effect.intent.effectId,
    driverGeneration: effect.ticket.driverGeneration
  });
  toolInvocations.set(invocation, { state: 'ready', plan, lifetime: record.lifetime, invoke: record.invoke });
  return invocation;
}

export async function releaseToolCallPlan(plan: ToolCallPlan): Promise<void> {
  const record = requireToolCallPlanRecord(plan);
  if (record.state === 'released') return;
  if (record.state === 'transferred') throw new ToolInvocationAuthorityError('Tool call lifetime authority was transferred to an invocation.');
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
  const plan = requireToolCallPlanRecord(record.plan);
  plan.state = 'released';
  await record.lifetime.release();
}

function requireToolCallPlanRecord(plan: ToolCallPlan): ToolCallPlanRecord {
  const record = toolCallPlans.get(plan);
  if (!record) throw new TypeError('Tool call lifetime was not created by this package instance.');
  return record;
}

function requireInvocationRecord(invocation: ToolInvocation): ToolInvocationRecord {
  const record = toolInvocations.get(invocation);
  if (!record) throw new TypeError('Tool invocation was not created by this package instance.');
  return record;
}

class PlanningLifetime implements ToolPlanLifetime {
  private readonly resources: ToolPlanResource[] = [];
  private released = false;

  async own(resource: unknown): Promise<void> {
    if (!isPlanningResource(resource)) throw new TypeError('Planning resources require a release action.');
    if (this.released) {
      await resource.release();
      throw new Error('Tool lifetime has already ended.');
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
    if (failures.length > 0) throw new AggregateError(failures, 'Tool lifetime resource release failed.');
  }
}

function isPlanningResource(value: unknown): value is ToolPlanResource {
  return (typeof value === 'object' && value !== null || typeof value === 'function')
    && 'release' in value
    && typeof value.release === 'function';
}

function decodeToolEffectRecoveryResult(tool: ToolDefinition, value: unknown): ToolEffectRecoveryDecision {
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
