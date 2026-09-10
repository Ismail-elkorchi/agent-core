import { canonicalJsonString, parseJsonObject, parseJsonValue, type JsonObject } from '@agent-core/json';
import { MODEL_REQUEST_JSON_LIMITS } from './json-limits.js';
import { parseModelRequest, ModelContractError } from './validation.js';
import type {
  ModelContentPart,
  ModelImage,
  ModelInputItem,
  ModelLimits,
  ModelPricing,
  ModelProfile,
  ModelRequest
} from './index.js';

export interface RequestEstimator {
  estimateText(text: string): number;
  estimateImage(image: ModelImage): number;
  estimateItems(items: readonly ModelInputItem[]): number;
}
/** Diagnostic heuristic, never a tokenizer or an exact admission guarantee. */
export class CompleteRequestEstimator implements RequestEstimator {
  static readonly DEFAULT_IMAGE_TOKENS = 2_000;
  private readonly encoder = new TextEncoder();
  estimateText(text: string): number {
    return Math.ceil(this.encoder.encode(text).byteLength / 3);
  }
  estimateImage(image: ModelImage): number {
    void image;
    return CompleteRequestEstimator.DEFAULT_IMAGE_TOKENS;
  }
  estimateItems(items: readonly ModelInputItem[]): number {
    const accounting = accountItems(items, this);
    if (accounting.some((part) => part.status === 'unknown'))
      throw new ModelContractError('Cannot estimate unknown protocol/media token cost.', [
        'Use RequestAccounting with a declared unknown-token admission policy.'
      ]);
    return accounting.reduce((total, part) => total + (part.tokens ?? 0), 0);
  }
}
export type RequestAccountingKind =
  | 'text'
  | 'tool_arguments'
  | 'tool_results'
  | 'media'
  | 'reasoning'
  | 'tool_schema'
  | 'response_schema'
  | 'control'
  | 'framing'
  | 'provider_input';
export type RequestAccountingComponent =
  | {
      readonly kind: RequestAccountingKind;
      readonly path: string;
      readonly status: 'estimated' | 'counted';
      readonly tokens: number;
      readonly reason?: never;
    }
  | {
      readonly kind: RequestAccountingKind;
      readonly path: string;
      readonly status: 'unknown';
      readonly reason: string;
      readonly tokens?: never;
    };
export interface RequestAccounting {
  readonly version: 1;
  readonly method: { readonly name: string; readonly version: string };
  readonly components: readonly RequestAccountingComponent[];
  readonly estimatedInputTokens: number;
  readonly unknownComponents: readonly RequestAccountingComponent[];
  readonly unknownTokenAllowance?: number;
  readonly outputReservation: number;
  readonly outputReservationSource: 'request' | 'policy' | 'unknown';
  readonly reasoningReservation: number;
  readonly limits: ModelLimits;
  readonly pricing?: ModelPricing;
  readonly pricingSemantics: {
    readonly cachedTokensOccupyContext: true;
    readonly reasoningIncludedInOutput: boolean | 'unknown';
  };
  readonly uncertainty: { readonly calibrated: false; readonly headroomRatio: number };
}
/** Admission policy, independent of provider generation controls. */
export interface ModelCompilationOptions {
  readonly outputReservation?: number;
}
export interface RequestAccountingOptions extends ModelCompilationOptions {
  readonly estimator?: RequestEstimator;
  /** Bounded parent output that can enter a preauthorized native successor. */
  readonly retainedInputTokenReservation?: number;
  readonly unknownTokenAllowance?: number;
  readonly headroomRatio?: number;
  readonly providerInputTokens?: number;
  /** Adapter-known encoded media or opaque protocol locations, never arbitrary field-name filtering. */
  readonly payloadPaths?: readonly (readonly (string | number)[])[];
}
export interface CompiledModelRequest {
  readonly version: 1;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly capabilityRevision: string;
  readonly logicalRequest: ModelRequest;
  readonly body: JsonObject;
  /** Provider-retained context counted in addition to the transmitted body. */
  readonly retainedBody?: JsonObject;
  readonly accounting: RequestAccounting;
  readonly inputIdentity: string;
}
export function accountModelRequest(
  request: ModelRequest,
  profile: ModelProfile,
  options: RequestAccountingOptions = {}
): RequestAccounting {
  const estimator = options.estimator ?? new CompleteRequestEstimator();
  const components = accountItems(request.messages, estimator);
  const add = (kind: RequestAccountingKind, path: string, value: unknown) => {
    if (value !== undefined)
      components.push({
        kind,
        path,
        status: 'estimated',
        tokens: checked(estimator.estimateText(JSON.stringify(value)), path)
      });
  };
  add('tool_schema', 'tools', request.tools);
  add('response_schema', 'responseFormat', request.responseFormat);
  const controls: Record<string, unknown> = { ...request };
  delete controls.messages;
  delete controls.tools;
  delete controls.responseFormat;
  delete controls.signal;
  add('control', 'request', controls);
  components.push({ kind: 'framing', path: 'request', status: 'estimated', tokens: 12 });
  return assembleAccounting(components, request, profile, options);
}
function assembleAccounting(
  parts: readonly RequestAccountingComponent[],
  request: ModelRequest,
  profile: ModelProfile,
  options: RequestAccountingOptions
): RequestAccounting {
  const providerCount = options.providerInputTokens;
  const components: readonly RequestAccountingComponent[] =
    providerCount === undefined
      ? parts
      : [
          {
            kind: 'provider_input',
            path: 'body',
            status: 'counted',
            tokens: checked(providerCount, 'providerInputTokens')
          }
        ];
  const headroomRatio = options.headroomRatio ?? 0.2;
  if (!Number.isFinite(headroomRatio) || headroomRatio < 0)
    throw new RangeError('headroomRatio must be finite and nonnegative.');
  const unknown = components.filter((part) => part.status === 'unknown');
  const outputReservation = checked(
    request.maxOutputTokens ?? options.outputReservation ?? 0,
    'outputReservation',
    request.maxOutputTokens !== undefined || options.outputReservation !== undefined
  );
  const unknownTokenAllowance =
    options.unknownTokenAllowance === undefined
      ? undefined
      : checked(options.unknownTokenAllowance, 'unknownTokenAllowance');
  return Object.freeze({
    version: 1,
    method: Object.freeze({
      name: providerCount === undefined ? 'complete-utf8-estimate' : 'provider-count',
      version: '1'
    }),
    components: Object.freeze(components.map((part) => Object.freeze(part))),
    unknownComponents: Object.freeze(unknown),
    estimatedInputTokens: components.reduce((sum, part) => sum + (part.tokens ?? 0), 0),
    ...(unknownTokenAllowance === undefined ? {} : { unknownTokenAllowance }),
    outputReservation,
    outputReservationSource:
      request.maxOutputTokens !== undefined
        ? 'request'
        : options.outputReservation !== undefined
          ? 'policy'
          : 'unknown',
    reasoningReservation: request.reasoning?.strategy === 'budget' ? request.reasoning.maxTokens : 0,
    limits: Object.freeze({ ...profile.limits }),
    ...(profile.pricing ? { pricing: profile.pricing } : {}),
    pricingSemantics: Object.freeze({
      cachedTokensOccupyContext: true,
      reasoningIncludedInOutput:
        profile.capabilities.protocol?.reasoningAccounting === 'included_output'
          ? true
          : profile.capabilities.protocol?.reasoningAccounting === 'separate'
            ? false
            : 'unknown'
    }),
    uncertainty: Object.freeze({
      calibrated: false,
      headroomRatio: providerCount === undefined ? headroomRatio : 0
    })
  });
}
export function requestAccountingInputTokens(accounting: RequestAccounting): number {
  if (accounting.unknownComponents.length && accounting.unknownTokenAllowance === undefined)
    throw new ModelContractError(
      'Request accounting has unknown token costs.',
      accounting.unknownComponents.map((part) => `${part.path}: ${part.reason ?? 'unknown'}`)
    );
  return (
    Math.ceil(accounting.estimatedInputTokens * (1 + accounting.uncertainty.headroomRatio)) +
    (accounting.unknownTokenAllowance ?? 0)
  );
}
export function assertRequestAccountingFits(accounting: RequestAccounting): void {
  const input = requestAccountingInputTokens(accounting);
  const issues: string[] = [];
  const separateReasoning =
    accounting.pricingSemantics.reasoningIncludedInOutput === false ? accounting.reasoningReservation : 0;
  if (
    accounting.reasoningReservation > 0 &&
    accounting.pricingSemantics.reasoningIncludedInOutput === 'unknown'
  )
    issues.push('Reasoning accounting semantics require an explicit provider declaration.');
  if (accounting.outputReservationSource === 'unknown')
    issues.push('An explicit output reservation policy is required.');
  if (accounting.limits.maxInputTokens !== undefined && input > accounting.limits.maxInputTokens)
    issues.push('Input token limit exceeded.');
  if (
    accounting.limits.outputTokens !== undefined &&
    accounting.outputReservation > accounting.limits.outputTokens
  )
    issues.push('Output token limit exceeded.');
  if (
    accounting.limits.contextTokens !== undefined &&
    input + accounting.outputReservation + separateReasoning > accounting.limits.contextTokens
  )
    issues.push('Context token limit exceeded.');
  if (
    accounting.pricingSemantics.reasoningIncludedInOutput !== false &&
    accounting.reasoningReservation > accounting.outputReservation
  )
    issues.push('Reasoning reservation exceeds reserved output.');
  if (issues.length) throw new ModelContractError('Request accounting exceeds admission limits.', issues);
}
/** Own the exact serialized body before admission. Transport/auth fields do not enter the model body. */
export async function compileModelRequest(
  options: RequestAccountingOptions & {
    readonly request: ModelRequest;
    readonly profile: ModelProfile;
    readonly body: unknown;
    readonly endpoint: string;
    readonly retainedBody?: unknown;
    readonly retainedPayloadPaths?: readonly (readonly (string | number)[])[];
  }
): Promise<CompiledModelRequest> {
  const request = parseModelRequest(options.request);
  const body = parseJsonObject(options.body, MODEL_REQUEST_JSON_LIMITS);
  const estimator = options.estimator ?? new CompleteRequestEstimator();
  // Count the provider representation once. Native payloads use semantic accounting separately.
  const semantic = accountModelRequest(request, options.profile, options);
  const accountingBody = omitPayloads(body, options.payloadPaths ?? []);
  const components: RequestAccountingComponent[] = semantic.components.filter(
    (part) => part.kind === 'media' || part.kind === 'reasoning'
  );
  for (const [key, value] of Object.entries(accountingBody)) {
    const kind: RequestAccountingKind =
      key === 'tools'
        ? 'tool_schema'
        : key === 'text' || key === 'response_format'
          ? 'response_schema'
          : key === 'input' || key === 'messages'
            ? 'provider_input'
            : 'control';
    components.push({
      kind,
      path: `body.${key}`,
      status: 'estimated',
      tokens: checked(estimator.estimateText(JSON.stringify({ [key]: value })), key)
    });
  }
  const retainedBody =
    options.retainedBody === undefined ? undefined : parseJsonObject(options.retainedBody);
  if (retainedBody) {
    const retained = omitPayloads(retainedBody, options.retainedPayloadPaths ?? []);
    for (const [key, value] of Object.entries(retained))
      components.push({
        kind: 'provider_input',
        path: `retainedBody.${key}`,
        status: 'estimated',
        tokens: checked(estimator.estimateText(JSON.stringify({ [key]: value })), key)
      });
  }
  const retainedInputTokenReservation = options.retainedInputTokenReservation;
  if (retainedInputTokenReservation !== undefined)
    components.push({
      kind: 'provider_input',
      path: 'retainedBody.pendingOutput',
      status: 'estimated',
      tokens: checked(retainedInputTokenReservation, 'retainedInputTokenReservation')
    });
  const accounting = assembleAccounting(
    components,
    request,
    options.profile,
    options.providerInputTokens === undefined
      ? options
      : {
          ...options,
          providerInputTokens: options.providerInputTokens + (retainedInputTokenReservation ?? 0)
        }
  );
  return Object.freeze({
    version: 1,
    provider: options.profile.provider,
    model: request.model,
    endpoint: options.endpoint,
    capabilityRevision: options.profile.capabilities.protocol?.revision ?? 'conservative-v1',
    logicalRequest: request,
    body,
    ...(retainedBody ? { retainedBody } : {}),
    accounting,
    inputIdentity: await modelInputIdentity(retainedBody ? { body, retainedBody } : body)
  });
}
/** Exact SHA-256 identity of canonical JSON; not a claim about tokenization. */
export async function modelInputIdentity(value: unknown): Promise<string> {
  const owned = parseJsonValue(value, MODEL_REQUEST_JSON_LIMITS);
  const bytes = new TextEncoder().encode(canonicalJsonString(owned));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
function omitPayloads(
  body: JsonObject,
  paths: readonly (readonly (string | number)[])[]
): Record<string, unknown> {
  if (paths.length === 0) return body;
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  for (const path of paths) {
    if (!path.length) throw new RangeError('A payload path cannot omit the entire request.');
    let current: unknown = copy;
    for (const segment of path.slice(0, -1)) {
      if (current === null || typeof current !== 'object')
        throw new RangeError('Payload path does not exist in compiled body.');
      current = Reflect.get(current, segment) as unknown;
    }
    const key = path.at(-1);
    if (
      key === undefined ||
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    )
      throw new RangeError('Payload path does not exist in compiled body.');
    Reflect.set(current, key, '[native payload]');
  }
  return copy;
}
function accountItems(
  items: readonly ModelInputItem[],
  estimator: RequestEstimator
): RequestAccountingComponent[] {
  const parts: RequestAccountingComponent[] = [];
  const add = (kind: RequestAccountingKind, path: string, text: string) => {
    parts.push({ kind, path, status: 'estimated', tokens: checked(estimator.estimateText(text), path) });
  };
  items.forEach((item, index) => {
    const path = `messages[${String(index)}]`;
    add(item.role === 'tool' ? 'tool_results' : 'text', path, item.content);
    add(
      'framing',
      `${path}.identity`,
      JSON.stringify({
        role: item.role,
        name: item.name,
        toolName: item.toolName,
        toolCallId: item.toolCallId,
        toolCallType: item.toolCallType
      })
    );
    parts.push({ kind: 'framing', path, status: 'estimated', tokens: 4 });
    for (const call of item.toolCalls ?? [])
      add('tool_arguments', `${path}.toolCalls`, JSON.stringify(call));
    for (const image of item.images ?? [])
      parts.push({
        kind: 'media',
        path: `${path}.images`,
        status: 'estimated',
        tokens: checked(estimator.estimateImage(image), path, true)
      });
    for (const part of item.parts ?? []) accountPart(part, path, estimator, parts);
    if (item.role === 'control') add('control', path, JSON.stringify(item.update));
    if (item.role === 'protocol') {
      if (item.state.tokenCount !== undefined)
        parts.push({
          kind: 'reasoning',
          path,
          status: 'counted',
          tokens: checked(item.state.tokenCount, path)
        });
      else if (item.state.tokenEstimate !== undefined)
        parts.push({
          kind: 'reasoning',
          path,
          status: 'estimated',
          tokens: checked(item.state.tokenEstimate, path)
        });
      else
        parts.push({
          kind: 'reasoning',
          path,
          status: 'unknown',
          reason: 'Opaque provider state requires provider counting or an explicit unknown-token allowance.'
        });
    }
  });
  return parts;
}
function accountPart(
  part: ModelContentPart,
  path: string,
  estimator: RequestEstimator,
  parts: RequestAccountingComponent[]
): void {
  if (part.type === 'text')
    parts.push({
      kind: 'text',
      path,
      status: 'estimated',
      tokens: checked(estimator.estimateText(part.text), path)
    });
  else if (part.type === 'image')
    parts.push({
      kind: 'media',
      path,
      status: 'estimated',
      tokens: checked(estimator.estimateImage(part.image), path, true)
    });
  else if (part.tokenCount !== undefined)
    parts.push({ kind: 'media', path, status: 'counted', tokens: checked(part.tokenCount, path, true) });
  else
    parts.push({
      kind: 'media',
      path,
      status: 'unknown',
      reason: `${part.type} requires provider counting or declared admission allowance.`
    });
}
function checked(value: number, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new RangeError(
      `${label} token count must be a ${positive ? 'positive' : 'nonnegative'} safe integer.`
    );
  return value;
}
