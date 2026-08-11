import type { ToolCall } from './definition.js';
import type { ToolPreparationContext } from './context.js';
import { isRiskAllowed, type ToolRisk } from './policy.js';
import { validateResourceScope } from './resources.js';
import { parseJsonObject } from '@agent-core/json';
import type { JsonObject } from '@agent-core/json';

export type ToolResourceAccessMode = 'read' | 'write' | 'execute' | 'network' | 'delete';
export type ToolIdempotency = 'pure' | 'idempotent' | 'non_idempotent';

export interface ToolResourceAccess {
  readonly mode: ToolResourceAccessMode;
  readonly scope: string;
}

export interface ToolEffectEnvelope {
  readonly accesses: readonly ToolResourceAccess[];
  readonly lockScopes: readonly string[];
}

interface ToolEffectsBase {
  readonly accesses: readonly ToolResourceAccess[];
  readonly lockScopes: readonly string[];
  /** Zero-based source-call indices that must complete before this call executes. */
  readonly dependsOnCallIndices?: readonly number[];
}

export type ToolEffects = ToolEffectsBase & (
  | { readonly idempotency: 'pure' | 'non_idempotent'; readonly idempotencyKey?: never }
  | { readonly idempotency: 'idempotent'; readonly idempotencyKey: string }
);

export type ToolAuthorizationDecision =
  | { readonly decision: 'allow'; readonly reason?: string }
  | { readonly decision: 'deny'; readonly reason: string }
  | { readonly decision: 'require_approval'; readonly reason: string };

export interface ToolAuthorizationRequest {
  readonly call: ToolCall;
  readonly toolImplementationId: string;
  readonly input: unknown;
  readonly effects: ToolEffects;
  readonly fingerprint: string;
  readonly context: ToolPreparationContext;
}

export type ToolAuthorizer = (request: ToolAuthorizationRequest) => ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;

export const POLICY_TOOL_AUTHORIZER: ToolAuthorizer = (request) => {
  const denied = deniedEffectRisks(request.effects, request.context.policy);
  return denied.length === 0
    ? { decision: 'allow', reason: 'Allowed by the configured tool policy.' }
    : { decision: 'deny', reason: `Tool ${request.call.name} requires prohibited risk${denied.length === 1 ? '' : 's'}: ${denied.join(', ')}.` };
};

export function deniedEffectRisks(effects: ToolEffects, policy: import('./policy.js').ToolPolicy): readonly ToolRisk[] {
  return Object.freeze([...new Set(effects.accesses.map((access) => accessRisk(access.mode)).filter((risk) => !isRiskAllowed(policy, risk)))]);
}

export function enforceAllowedEffects(request: ToolAuthorizationRequest): ToolAuthorizationDecision | undefined {
  const denied = deniedEffectRisks(request.effects, request.context.policy);
  return denied.length === 0 ? undefined : {
    decision: 'deny',
    reason: 'Tool ' + request.call.name + ' requires prohibited risk' + (denied.length === 1 ? '' : 's') + ': ' + denied.join(', ') + '.'
  };
}

export function validateToolEffectEnvelope(value: unknown): ToolEffectEnvelope {
  const record = parseJsonObject(value, { maxDepth: 8, maxCollectionEntries: 10_000, maxStringBytes: 16_000, maxTotalBytes: 1_000_000 });
  const accesses = validateResourceAccesses(record.accesses, 'effect envelope');
  const lockScopes = validateScopes(record.lockScopes, 'effect envelope lockScopes');
  return Object.freeze({ accesses, lockScopes });
}

export function validateToolEffects(value: unknown): ToolEffects {
  const record = parseJsonObject(value, { maxDepth: 8, maxCollectionEntries: 10_000, maxStringBytes: 16_000, maxTotalBytes: 1_000_000 });
  return decodeOwnedToolEffects(record);
}

export function decodeOwnedToolEffects(record: JsonObject): ToolEffects {
  const accesses = validateResourceAccesses(record.accesses, 'effects');
  const lockScopes = validateScopes(record.lockScopes, 'effect lockScopes');
  if (!isToolIdempotency(record.idempotency)) throw new Error('Invalid tool idempotency.');
  const dependsOnCallIndices = record.dependsOnCallIndices === undefined ? undefined : validateDependencies(record.dependsOnCallIndices);
  const base = { accesses, lockScopes, ...(dependsOnCallIndices === undefined ? {} : { dependsOnCallIndices }) };
  if (record.idempotency === 'idempotent') {
    if (typeof record.idempotencyKey !== 'string' || record.idempotencyKey.trim().length === 0) throw new Error('Idempotent tool effects require a non-empty idempotencyKey.');
    return Object.freeze({ ...base, idempotency: 'idempotent', idempotencyKey: record.idempotencyKey });
  }
  if (record.idempotencyKey !== undefined) throw new Error('Only idempotent tool effects may declare idempotencyKey.');
  return Object.freeze({ ...base, idempotency: record.idempotency });
}

export function encodeToolEffects(effects: ToolEffects): JsonObject {
  return Object.freeze({
    accesses: Object.freeze(effects.accesses.map((access) => Object.freeze({ mode: access.mode, scope: access.scope }))),
    lockScopes: Object.freeze([...effects.lockScopes]),
    ...(effects.dependsOnCallIndices === undefined ? {} : { dependsOnCallIndices: Object.freeze([...effects.dependsOnCallIndices]) }),
    idempotency: effects.idempotency,
    ...(effects.idempotency === 'idempotent' ? { idempotencyKey: effects.idempotencyKey } : {})
  });
}

export function assertEffectsWithinEnvelope(effects: ToolEffects, envelope: ToolEffectEnvelope): void {
  for (const access of effects.accesses) {
    if (!envelope.accesses.some((allowed) => allowed.mode === access.mode && scopeContains(allowed.scope, access.scope))) {
      throw new Error(`Derived ${access.mode} access ${access.scope} exceeds the tool effect envelope.`);
    }
  }
  for (const lockScope of effects.lockScopes) {
    if (!envelope.lockScopes.some((allowed) => scopeContains(allowed, lockScope))) {
      throw new Error(`Derived lock scope ${lockScope} exceeds the tool effect envelope.`);
    }
  }
}

export function scopesOverlap(left: string, right: string): boolean {
  return scopeContains(left, right) || scopeContains(right, left);
}

export function accessRisk(mode: ToolResourceAccessMode): ToolRisk {
  if (mode === 'read') return 'read';
  if (mode === 'write') return 'write';
  if (mode === 'execute') return 'execute';
  if (mode === 'network') return 'network';
  return 'destructive';
}

export function scopeContains(parent: string, child: string): boolean {
  return parent === '*' || parent === child || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}
function validateResourceAccesses(value: unknown, label: string): readonly ToolResourceAccess[] {
  if (!Array.isArray(value)) throw new Error(`Tool ${label} accesses must be an array.`);
  const accesses = value.map((item) => {
    if (!isRecord(item) || !isAccessMode(item.mode) || typeof item.scope !== 'string' || item.scope.trim().length === 0) throw new Error(`Tool ${label} contains an invalid resource access.`);
    return Object.freeze({ mode: item.mode, scope: validateResourceScope(item.scope) });
  });
  const identities = accesses.map((access) => `${access.mode}\0${access.scope}`);
  if (new Set(identities).size !== identities.length) throw new Error(`Tool ${label} resource accesses must be unique.`);
  return Object.freeze(accesses);
}
function validateScopes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Tool ${label} must be an array.`);
  const scopes = value.map((scope) => {
    if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error(`Tool ${label} requires non-empty scopes.`);
    return validateResourceScope(scope);
  });
  if (new Set(scopes).size !== scopes.length) throw new Error(`Tool ${label} scopes must be unique.`);
  return Object.freeze(scopes);
}
function validateDependencies(value: unknown): readonly number[] {
  if (!Array.isArray(value)) throw new Error('Tool effect dependencies must be an array of call indices.');
  const dependencies = value.map((item) => {
    if (!Number.isInteger(item) || Number(item) < 0) throw new Error('Tool effect dependencies must be nonnegative integer call indices.');
    return Number(item);
  });
  if (new Set(dependencies).size !== dependencies.length) throw new Error('Tool effect dependencies must be unique.');
  return Object.freeze(dependencies);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isAccessMode(value: unknown): value is ToolResourceAccessMode { return value === 'read' || value === 'write' || value === 'execute' || value === 'network' || value === 'delete'; }
function isToolIdempotency(value: unknown): value is ToolIdempotency { return value === 'pure' || value === 'idempotent' || value === 'non_idempotent'; }
