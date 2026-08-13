import type { JsonObject, JsonValue } from '@agent-core/json';

export type ModelImage =
  | { readonly type: 'base64'; readonly data: string; readonly mediaType: ModelImageMediaType; readonly detail?: ModelImageDetail }
  | { readonly type: 'bytes'; readonly data: Uint8Array; readonly mediaType: ModelImageMediaType; readonly detail?: ModelImageDetail };

export type ModelImageDetail = 'auto' | 'low' | 'high' | 'original';
export type ModelImageMediaType = `image/${string}`;

interface ModelMessageBase {
  readonly content: string;
  readonly name?: string;
}

export interface ModelSystemMessage extends ModelMessageBase {
  readonly role: 'system';
  readonly reasoning?: never;
  readonly toolCalls?: never;
  readonly toolName?: never;
  readonly toolCallId?: never;
  readonly toolCallType?: never;
  readonly images?: never;
}

export interface ModelUserMessage extends ModelMessageBase {
  readonly role: 'user';
  readonly images?: readonly ModelImage[];
  readonly reasoning?: never;
  readonly toolCalls?: never;
  readonly toolName?: never;
  readonly toolCallId?: never;
  readonly toolCallType?: never;
}

export interface ModelAssistantMessage extends ModelMessageBase {
  readonly role: 'assistant';
  readonly reasoning?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly toolName?: never;
  readonly toolCallId?: never;
  readonly toolCallType?: never;
  readonly images?: never;
}

export interface ModelToolMessage extends ModelMessageBase {
  readonly role: 'tool';
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly toolCallType: ModelToolKind;
  readonly reasoning?: never;
  readonly toolCalls?: never;
  readonly images?: readonly ModelImage[];
}

export type ModelMessage =
  | ModelSystemMessage
  | ModelUserMessage
  | ModelAssistantMessage
  | ModelToolMessage;

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ModelCapabilities {
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
  readonly messages: readonly ModelMessage[];
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

export type ModelResponseFormat = 'text' | 'json' | { readonly type: 'json_schema'; readonly schema: JsonObject };

export type ModelToolInputSupport =
  | { readonly kind: 'json' }
  | { readonly kind: 'text' }
  | { readonly kind: 'grammar'; readonly syntax: string };

export type ModelToolInput =
  | { readonly kind: 'json'; readonly value: JsonObject }
  | { readonly kind: 'text'; readonly value: string };

export type ModelToolKind = 'function' | 'custom';

export type ModelTool = ModelFunctionTool | ModelCustomTool;

export interface ModelFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: JsonObject;
  };
}

export type ModelCustomToolFormat =
  | { type: 'text' }
  | { type: 'grammar'; syntax: string; definition: string };

export interface ModelCustomTool {
  readonly type: 'custom';
  readonly name: string;
  readonly description?: string;
  readonly format: ModelCustomToolFormat;
}

export interface ModelFunctionToolCall {
  readonly id?: string;
  readonly type: 'function';
  readonly name: string;
  readonly input: Extract<ModelToolInput, { kind: 'json' }>;
}

export interface ModelCustomToolCall {
  readonly id?: string;
  readonly type: 'custom';
  readonly name: string;
  readonly input: Extract<ModelToolInput, { kind: 'text' }>;
}

export type ModelToolCall = ModelFunctionToolCall | ModelCustomToolCall;

export interface ModelResponse {
  readonly content: string;
  readonly model: string;
  readonly provider: string;
  readonly providerState?: ModelProviderState;
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

export type ModelTerminationReason =
  | 'stop'
  | 'tool_calls'
  | 'output_limit'
  | 'content_filter'
  | 'unknown';

export interface ModelProviderState {
  readonly provider: string;
  readonly model: string;
  readonly kind: string;
  readonly data: JsonObject;
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
  | { readonly type: 'content'; readonly content: string; readonly accumulated: string; readonly raw?: JsonValue }
  | { readonly type: 'reasoning'; readonly reasoning: string; readonly accumulatedReasoning: string; readonly channel?: ModelReasoningChannel; readonly raw?: JsonValue }
  | { readonly type: 'tool_call'; readonly toolCall: ModelToolCall; readonly raw?: JsonValue }
  | { readonly type: 'status'; readonly message: string; readonly raw?: JsonValue }
  | { readonly type: 'done'; readonly response: ModelResponse };

export interface ModelProvider {
  readonly id: string;
  describe(): ModelProviderInfo;
  describeModel(model: string): Promise<ModelProfile>;
  createSession?(): ModelProviderSession;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export interface ModelProviderSession {
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  /** Declares whether continuation state is safe after a failed request. */
  retryDisposition(error: unknown): ModelProviderSessionRetryDisposition;
  restoreProviderState?(state: ModelProviderState): void;
  resetContinuation?(reason: string): void;
  close?(): Promise<void>;
}

export type ModelProviderSessionRetryDisposition = 'reusable' | 'reset_required' | 'unknown';

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

export interface TokenEstimator {
  estimateText(text: string): number;
  /** Estimate one encoded image. Implementations must never silently count an image as zero. */
  estimateImage(image: ModelImage): number;
  estimateMessages(messages: readonly ModelMessage[]): number;
}

export class SimpleTokenEstimator implements TokenEstimator {
  /** Conservative fallback used when a provider-specific image estimator is unavailable. */
  static readonly DEFAULT_IMAGE_TOKENS = 2_000;

  estimateText(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / 4);
  }

  estimateImage(image: ModelImage): number {
    void image;
    return SimpleTokenEstimator.DEFAULT_IMAGE_TOKENS;
  }

  estimateMessages(messages: readonly ModelMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateText(message.content)
      + (message.images ?? []).reduce((imageTotal, image) => imageTotal + this.estimateImage(image), 0) + 4, 0);
  }
}

export * from './validation.js';
