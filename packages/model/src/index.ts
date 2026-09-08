import type {
  ModelTransportOptions,
  ModelToolResultSubmission,
  ModelToolResultDelivery,
  ModelNativeContinuation,
  ModelNativeDelivery,
  ModelNativeResponseBoundary,
  ModelNativeToolCallIdentity
} from './native.js';
export * from './native.js';
import type { JsonObject, JsonValue } from '@agent-core/json';
import type { EffectRecoveryCapability } from '@agent-core/effects';

export type ModelImage =
  | {
      readonly type: 'base64';
      readonly data: string;
      readonly mediaType: ModelImageMediaType;
      readonly detail?: ModelImageDetail;
    }
  | {
      readonly type: 'bytes';
      readonly data: Uint8Array;
      readonly mediaType: ModelImageMediaType;
      readonly detail?: ModelImageDetail;
    };

export type ModelImageDetail = 'auto' | 'low' | 'high' | 'original';
export type ModelImageMediaType = `image/${string}`;

/** Ordered content; payload references are data, never an instruction channel. */
export type ModelContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: ModelImage }
  | {
      readonly type: 'audio' | 'video' | 'document';
      readonly mediaType: string;
      readonly source: { readonly type: 'base64' | 'url' | 'file'; readonly value: string };
      readonly tokenCount?: number;
    };

interface ModelInputBase {
  readonly content: string;
  readonly name?: string;
  readonly parts?: readonly ModelContentPart[];
}
interface ModelNonToolInput extends ModelInputBase {
  readonly toolCalls?: never;
  readonly toolName?: never;
  readonly toolCallId?: never;
  readonly toolCallType?: never;
  readonly images?: never;
}
export interface ModelSystemInput extends ModelNonToolInput {
  readonly role: 'system';
}
export interface ModelDeveloperInput extends ModelNonToolInput {
  readonly role: 'developer';
}
export interface ModelUserInput extends ModelInputBase {
  readonly role: 'user';
  readonly images?: readonly ModelImage[];
  readonly toolCalls?: never;
  readonly toolName?: never;
  readonly toolCallId?: never;
  readonly toolCallType?: never;
}
export interface ModelAssistantInput extends ModelInputBase {
  readonly role: 'assistant';
  readonly toolCalls?: readonly ModelToolCall[];
  readonly toolName?: never;
  readonly toolCallId?: never;
  readonly toolCallType?: never;
  readonly images?: never;
}
export interface ModelToolResultInput extends ModelInputBase {
  readonly role: 'tool';
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly toolCallType: ModelToolKind;
  readonly toolCalls?: never;
  readonly images?: readonly ModelImage[];
}
export interface ModelProtocolInput extends ModelNonToolInput {
  readonly role: 'protocol';
  readonly content: '';
  readonly state: ProviderContextState;
}
export interface ModelControlInput extends ModelNonToolInput {
  readonly role: 'control';
  readonly content: '';
  readonly update: ModelControlUpdate;
}
export type ModelInputItem =
  | ModelSystemInput
  | ModelDeveloperInput
  | ModelUserInput
  | ModelAssistantInput
  | ModelToolResultInput
  | ModelProtocolInput
  | ModelControlInput;
export type ModelOutputItem =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'media'; readonly part: Exclude<ModelContentPart, { type: 'text' }> }
  | { readonly type: 'tool_call'; readonly toolCall: ModelToolCall }
  | { readonly type: 'protocol'; readonly state: ProviderContextState }
  | { readonly type: 'refusal'; readonly text: string };
export type ModelAuthorityRole = 'system' | 'developer' | 'user' | 'assistant';
export interface ModelControlUpdate {
  readonly id: string;
  readonly type: 'configuration';
  readonly reasoning: ModelReasoningRequest;
}

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ModelCapabilities {
  readonly protocol?: ModelProtocolCapabilities;
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly supportedToolInputs: readonly ModelToolInputSupport[];
  readonly jsonMode: boolean;
  readonly jsonSchema: boolean;
  readonly logprobs: boolean;
  readonly temperature: boolean;
  readonly topP: boolean;
  readonly reasoning?: ModelReasoningCapabilities;
}

export type ModelReasoningStrategy = 'toggle' | 'effort' | 'budget';
export type ModelReasoningSummary = 'auto' | 'concise' | 'detailed';

export interface ModelReasoningCapabilities {
  readonly strategies: readonly ModelReasoningStrategy[];
  readonly canDisable: boolean;
  readonly efforts?: readonly ModelReasoningEffort[];
  readonly modes?: readonly ModelReasoningMode[];
  readonly summaries?: readonly ModelReasoningSummary[];
  readonly separateOutput: boolean;
}

export type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'pdf' | (string & {});

export interface ModelModalities {
  readonly input: readonly ModelModality[];
  readonly output: readonly ModelModality[];
}

export interface ModelLimits {
  readonly contextTokens?: number;
  readonly maxInputTokens?: number;
  readonly outputTokens?: number;
}

export interface ModelTokenRates {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface ModelPricingTier {
  /** Applies to the whole request when prompt tokens exceed this threshold. */
  readonly aboveInputTokens: number;
  readonly inputMultiplier: number;
  readonly outputMultiplier: number;
}

export interface ModelPricing {
  readonly currency: string;
  readonly rates: ModelTokenRates;
  readonly inputTiers?: readonly ModelPricingTier[];
  readonly metadata?: JsonObject;
}

export type ModelParameter =
  | 'temperature'
  | 'topP'
  | 'maxOutputTokens'
  | 'responseFormat'
  | 'tools'
  | 'keepAlive'
  | 'reasoning'
  | 'logprobs'
  | 'topLogprobs'
  | 'metadata'
  | 'providerOptions';

export interface ModelProfile {
  readonly id: string;
  readonly provider: string;
  readonly displayName?: string;
  readonly capabilities: ModelCapabilities;
  readonly modalities: ModelModalities;
  readonly limits: ModelLimits;
  readonly supportedParameters: readonly ModelParameter[];
  readonly pricing?: ModelPricing;
  readonly metadata?: JsonObject;
}

export interface ModelProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly defaultModel: string;
}

export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelReasoningMode = 'standard' | 'pro';

export type ModelReasoningRequest =
  | {
      readonly strategy: 'disabled';
    }
  | {
      readonly strategy: 'enabled';
      readonly summary?: ModelReasoningSummary;
    }
  | {
      readonly strategy: 'effort';
      readonly effort: Exclude<ModelReasoningEffort, 'none'>;
      /** A provider-declared execution mode, serialized only by adapters that support it. */
      readonly mode?: ModelReasoningMode;
      readonly summary?: ModelReasoningSummary;
    }
  | {
      readonly strategy: 'budget';
      readonly maxTokens: number;
      readonly summary?: ModelReasoningSummary;
    };

export interface ModelProviderOptions {
  readonly provider: string;
  readonly values: JsonObject;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelInputItem[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly responseFormat?: ModelResponseFormat;
  readonly tools?: readonly ModelTool[];
  readonly keepAlive?: string | number;
  readonly reasoning?: ModelReasoningRequest;
  readonly logprobs?: boolean;
  readonly topLogprobs?: number;
  readonly providerOptions?: ModelProviderOptions;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type ModelResponseFormat =
  'text' | 'json' | { readonly type: 'json_schema'; readonly schema: JsonObject };

export type ModelToolInputSupport =
  | { readonly kind: 'json' }
  | { readonly kind: 'text' }
  | { readonly kind: 'grammar'; readonly syntax: string };

export type ModelToolInput =
  { readonly kind: 'json'; readonly value: JsonObject } | { readonly kind: 'text'; readonly value: string };

export type ModelToolKind = 'function' | 'custom';

export type ModelTool = ModelFunctionTool | ModelCustomTool;

export interface ModelFunctionTool {
  readonly type: 'function';
  readonly async?: boolean;
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: JsonObject;
  };
}

export type ModelCustomToolFormat =
  { type: 'text' } | { type: 'grammar'; syntax: string; definition: string };

export interface ModelCustomTool {
  readonly async?: boolean;
  readonly type: 'custom';
  readonly name: string;
  readonly description?: string;
  readonly format: ModelCustomToolFormat;
}

export interface ModelFunctionToolCall {
  readonly async?: boolean;
  readonly id?: string;
  readonly type: 'function';
  readonly name: string;
  readonly input: Extract<ModelToolInput, { kind: 'json' }>;
}

export interface ModelCustomToolCall {
  readonly async?: boolean;
  readonly id?: string;
  readonly type: 'custom';
  readonly name: string;
  readonly input: Extract<ModelToolInput, { kind: 'text' }>;
}

export type ModelToolCall = ModelFunctionToolCall | ModelCustomToolCall;

export interface ModelResponse {
  readonly output?: readonly ModelOutputItem[];
  readonly content: string;
  readonly model: string;
  readonly provider: string;
  readonly providerState?: ProviderContextState;
  readonly requestId?: string;
  readonly transport?: ModelTransportMetadata;
  readonly usage?: ModelUsage;
  readonly reasoning?: string;
  readonly reasoningSummary?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly terminationReason: ModelTerminationReason;
  readonly providerTerminationReason?: string;
  readonly timings?: Readonly<Record<string, number>>;
  readonly logprobs?: JsonValue;
  readonly raw?: JsonValue;
}

export type ModelTerminationReason = 'stop' | 'tool_calls' | 'output_limit' | 'content_filter' | 'unknown';

/** Adapter-owned protocol material. Payloads must never be exposed by ordinary history reads. */
export interface ProviderContextState {
  readonly version: 1;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly kind: string;
  readonly data: JsonObject;
  readonly origin: { readonly requestId: string; readonly inputIdentity: string };
  readonly compatibility: {
    readonly model: string;
    readonly endpoint: string;
    readonly requiresExactPrefix: boolean;
  };
  readonly replay: 'required' | 'optional' | 'handle';
  readonly tokenCount?: number;
  readonly tokenEstimate?: number;
  readonly artifact?: { readonly id: string; readonly digest: string };
  readonly handle?: string;
}
export interface ModelProtocolCapabilities {
  readonly version: 1;
  readonly revision: string;
  readonly endpoint: string;
  readonly roles: readonly ModelAuthorityRole[];
  /** A single native system channel can carry developer authority only when no system contribution is present. */
  readonly developerRole?: 'native' | 'system_if_no_system' | 'unsupported';
  readonly inputKinds: readonly (
    'text' | 'image' | 'audio' | 'video' | 'document' | 'tool_call' | 'tool_result' | 'protocol' | 'control'
  )[];
  readonly outputKinds: readonly ModelOutputItem['type'][];
  readonly state: 'none' | 'exact';
  readonly continuation: 'replay' | 'exact_prefix';
  readonly asyncTools: boolean;
  readonly steering: 'next_request' | 'native';
  readonly contextTransforms: readonly string[];
  readonly toolChoice: readonly ('auto' | 'none' | 'required' | 'named')[];
  readonly counting: 'estimate' | 'provider';
  readonly reasoningAccounting?: 'included_output' | 'separate' | 'unknown';
}
export interface ModelSteeringSubmission {
  readonly deliveryId: string;
  readonly responseId: string;
  readonly input: readonly ModelInputItem[];
  readonly signal?: AbortSignal;
}
export interface ModelSteeringDelivery {
  readonly deliveryId: string;
  readonly responseId: string;
  readonly status: 'submitted' | 'acknowledged' | 'applied' | 'failed' | 'uncertain';
  readonly providerEventId?: string;
  readonly inputIdentity?: string;
  readonly successorResponseId?: string;
  readonly requiredToolCallIds?: readonly string[];
  readonly detail?: string;
}
export interface ModelContextTransformRequest {
  readonly transformId: string;
  readonly request: ModelRequest;
  readonly signal?: AbortSignal;
}
export interface ModelContextTransformResult {
  readonly transformId: string;
  readonly input: readonly ModelInputItem[];
  readonly state: ProviderContextState;
  readonly usage?: ModelUsage;
}

export interface ModelTransportMetadata {
  readonly provider: string;
  readonly strategy: string;
  readonly responseId?: string;
  readonly reusedContinuation?: boolean;
  readonly fallbackReason?: string;
}

export type ModelReasoningChannel = 'reasoning' | 'summary';

export type ModelStreamEvent =
  | {
      readonly type: 'response_started';
      readonly responseId: string;
      readonly native?: ModelNativeResponseBoundary;
    }
  | {
      readonly type: 'response_boundary';
      readonly response: ModelResponse;
      readonly native?: ModelNativeResponseBoundary;
    }
  | { readonly type: 'tool_result_delivery'; readonly delivery: ModelToolResultDelivery }
  | { readonly type: 'native_delivery'; readonly delivery: ModelNativeDelivery }
  | { readonly type: 'steering'; readonly delivery: ModelSteeringDelivery }
  | {
      readonly type: 'content';
      readonly content: string;
      readonly accumulated: string;
      readonly raw?: JsonValue;
    }
  | {
      readonly type: 'reasoning';
      readonly reasoning: string;
      readonly accumulatedReasoning: string;
      readonly channel?: ModelReasoningChannel;
      readonly raw?: JsonValue;
    }
  | {
      readonly type: 'tool_call';
      readonly toolCall: ModelToolCall;
      readonly source?: ModelNativeToolCallIdentity;
      readonly raw?: JsonValue;
    }
  | { readonly type: 'status'; readonly message: string; readonly raw?: JsonValue }
  | { readonly type: 'done'; readonly response: ModelResponse };

export interface ModelProvider {
  readonly id: string;
  /** Stable identity of the adapter implementation whose request and recovery semantics are in force. */
  readonly implementationId: string;
  compileRequest?(request: ModelRequest): Promise<import('./accounting.js').CompiledModelRequest>;
  completeCompiled?(
    request: import('./accounting.js').CompiledModelRequest,
    options?: ModelTransportOptions
  ): Promise<ModelResponse>;
  streamCompiled?(
    request: import('./accounting.js').CompiledModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent>;
  transformContext?(request: ModelContextTransformRequest): Promise<ModelContextTransformResult>;
  compileContextTransform?(
    request: ModelContextTransformRequest
  ): Promise<import('./accounting.js').CompiledModelRequest>;
  transformContextCompiled?(
    transformId: string,
    request: import('./accounting.js').CompiledModelRequest,
    options?: ModelTransportOptions
  ): Promise<ModelContextTransformResult>;
  describe(): ModelProviderInfo;
  describeModel(model: string): Promise<ModelProfile>;
  createSession?(): ModelProviderSession;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  /** Recovery facts the provider can prove for this exact request. Absence means unknown. */
  requestRecovery?(request: ModelRequest): EffectRecoveryCapability;
}

export interface ModelProviderSession {
  deliverToolResults?(input: ModelToolResultSubmission): Promise<ModelToolResultDelivery>;
  toolResultStatus?(deliveryId: string): Promise<ModelToolResultDelivery>;
  continueNative?(input: ModelNativeContinuation): Promise<ModelNativeDelivery>;
  nativeDeliveryStatus?(deliveryId: string): Promise<ModelNativeDelivery>;
  completeCompiled?(
    request: import('./accounting.js').CompiledModelRequest,
    options?: ModelTransportOptions
  ): Promise<ModelResponse>;
  streamCompiled?(
    request: import('./accounting.js').CompiledModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent>;
  steer?(submission: ModelSteeringSubmission): Promise<ModelSteeringDelivery>;
  steeringStatus?(deliveryId: string): Promise<ModelSteeringDelivery>;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  restoreProviderState?(state: ProviderContextState): void;
  resetContinuation?(reason: string): void;
  close?(): Promise<void>;
}

export type ModelProviderErrorCode =
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'invalid_request'
  | 'context_overflow'
  | 'rate_limited'
  | 'malformed_response'
  | 'aborted'
  | 'unknown';

export type ModelProviderErrorDiagnosticValue = string | number | boolean | null;

export interface ModelProviderErrorDiagnostic {
  readonly provider: string;
  readonly code: ModelProviderErrorCode;
  readonly retryable: boolean;
  readonly transport?: string;
  readonly eventType?: string;
  readonly causeSummary?: Readonly<Record<string, ModelProviderErrorDiagnosticValue>>;
}

export class ModelProviderError extends Error {
  readonly code: ModelProviderErrorCode;
  readonly retryable: boolean;
  readonly provider: string;
  readonly causeValue: unknown;
  readonly diagnostic: ModelProviderErrorDiagnostic;

  constructor(options: {
    provider: string;
    code: ModelProviderErrorCode;
    message: string;
    retryable?: boolean;
    cause?: unknown;
    diagnostic?: {
      transport?: string;
      eventType?: string;
      causeSummary?: Record<string, ModelProviderErrorDiagnosticValue>;
    };
  }) {
    super(options.message);
    this.name = 'ModelProviderError';
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.causeValue = options.cause;
    this.diagnostic = {
      provider: options.provider,
      code: options.code,
      retryable: this.retryable,
      ...(options.diagnostic?.transport ? { transport: options.diagnostic.transport } : {}),
      ...(options.diagnostic?.eventType ? { eventType: options.diagnostic.eventType } : {}),
      ...(options.diagnostic?.causeSummary ? { causeSummary: options.diagnostic.causeSummary } : {})
    };
  }
}

export * from './accounting.js';
export * from './protocol.js';
export * from './validation.js';
