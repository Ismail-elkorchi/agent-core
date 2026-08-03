import { isJsonObject, type JsonObject } from '@agent-core/evidence';
import type { ToolCall, ToolDefinition } from './definition.js';
import type { ToolPreparationContext } from './context.js';
import { isToolAvailable } from './policy.js';

export type ToolEffectKind = 'read' | 'write' | 'execute' | 'network' | 'mixed';
export type ToolIdempotency = 'pure' | 'idempotent' | 'non_idempotent';

interface ToolEffectsBase {
  readonly kind: ToolEffectKind;
  readonly resourceScopes: readonly string[];
  readonly reversible: boolean;
  readonly compensation?: Readonly<JsonObject>;
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
  readonly tool: ToolDefinition;
  readonly input: unknown;
  readonly effects: ToolEffects;
  readonly fingerprint: string;
  readonly context: ToolPreparationContext;
}

export type ToolAuthorizer = (request: ToolAuthorizationRequest) => ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;

export const POLICY_TOOL_AUTHORIZER: ToolAuthorizer = (request) => isToolAvailable(request.tool, request.context.policy)
  ? { decision: 'allow', reason: 'Allowed by the configured tool policy.' }
  : { decision: 'deny', reason: `Tool ${request.tool.name} is unavailable under the configured policy.` };

export function validateToolEffects(value: unknown): ToolEffects {
  if (!isRecord(value) || !isToolEffectKind(value.kind)) throw new Error('Invalid tool effect kind.');
  const resourceScopes: string[] = [];
  if (!Array.isArray(value.resourceScopes) || value.resourceScopes.length === 0) throw new Error('Tool effects require at least one resource scope.');
  for (const scope of value.resourceScopes) {
    if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('Tool effects require non-empty resource scopes.');
    resourceScopes.push(scope);
  }
  if (!isToolIdempotency(value.idempotency)) throw new Error('Invalid tool idempotency.');
  if (value.idempotency === 'idempotent' && (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.trim().length === 0)) throw new Error('Idempotent tool effects require a non-empty idempotencyKey.');
  if (value.idempotency !== 'idempotent' && value.idempotencyKey !== undefined) throw new Error('Only idempotent tool effects may declare idempotencyKey.');
  if (typeof value.reversible !== 'boolean') throw new Error('Tool reversibility must be boolean.');
  if (value.compensation !== undefined && !isJsonObject(value.compensation)) throw new Error('Tool compensation metadata must be a JSON object.');
  const dependsOnCallIndices = value.dependsOnCallIndices === undefined ? undefined : validateDependencies(value.dependsOnCallIndices);
  const base = {
    kind: value.kind,
    resourceScopes: Object.freeze(resourceScopes),
    reversible: value.reversible,
    ...(value.compensation === undefined ? {} : { compensation: Object.freeze({ ...value.compensation }) }),
    ...(dependsOnCallIndices === undefined ? {} : { dependsOnCallIndices })
  };
  if (value.idempotency === 'idempotent') {
    if (typeof value.idempotencyKey !== 'string') throw new Error('Idempotent tool effects require a string idempotencyKey.');
    return Object.freeze({ ...base, idempotency: 'idempotent', idempotencyKey: value.idempotencyKey });
  }
  if (value.idempotency === 'pure') return Object.freeze({ ...base, idempotency: 'pure' });
  return Object.freeze({ ...base, idempotency: 'non_idempotent' });
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
function isToolEffectKind(value: unknown): value is ToolEffectKind { return value === 'read' || value === 'write' || value === 'execute' || value === 'network' || value === 'mixed'; }
function isToolIdempotency(value: unknown): value is ToolIdempotency { return value === 'pure' || value === 'idempotent' || value === 'non_idempotent'; }
