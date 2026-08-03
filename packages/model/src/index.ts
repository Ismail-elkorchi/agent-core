export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

export type ModelImage =
  | { type: 'base64'; data: string; mediaType: ModelImageMediaType; detail?: ModelImageDetail }
  | { type: 'bytes'; data: Uint8Array; mediaType: ModelImageMediaType; detail?: ModelImageDetail };

export type ModelImageDetail = 'auto' | 'low' | 'high' | 'original';
export type ModelImageMediaType = `image/${string}`;

interface ModelMessageBase {
  content: string;
  name?: string;
}

export interface ModelSystemMessage extends ModelMessageBase {
  role: 'system';
  reasoning?: never;
  toolCalls?: never;
  toolName?: never;
  toolCallId?: never;
  toolCallType?: never;
  images?: never;
}

export interface ModelUserMessage extends ModelMessageBase {
  role: 'user';
  images?: ModelImage[];
  reasoning?: never;
  toolCalls?: never;
  toolName?: never;
  toolCallId?: never;
  toolCallType?: never;
}

export interface ModelAssistantMessage extends ModelMessageBase {
  role: 'assistant';
  reasoning?: string;
  toolCalls?: ModelToolCall[];
  toolName?: never;
  toolCallId?: never;
  toolCallType?: never;
  images?: never;
}

export interface ModelToolMessage extends ModelMessageBase {
  role: 'tool';
  toolName: string;
  toolCallId?: string;
  toolCallType: ModelToolKind;
  reasoning?: never;
  toolCalls?: never;
  images?: never;
}

export type ModelMessage =
  | ModelSystemMessage
  | ModelUserMessage
  | ModelAssistantMessage
  | ModelToolMessage;

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  supportedToolInputs: ModelToolInputSupport[];
  jsonMode: boolean;
  jsonSchema: boolean;
  logprobs: boolean;
  temperature: boolean;
  topP: boolean;
  reasoning?: ModelReasoningCapabilities;
}

export type ModelReasoningStrategy = 'toggle' | 'effort' | 'budget';
export type ModelReasoningSummary = 'auto' | 'concise' | 'detailed';

export interface ModelReasoningCapabilities {
  strategies: ModelReasoningStrategy[];
  canDisable: boolean;
  efforts?: ModelReasoningEffort[];
  modes?: ModelReasoningMode[];
  summaries?: ModelReasoningSummary[];
  separateOutput: boolean;
}

export type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'pdf' | (string & {});

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface ModelLimits {
  contextTokens?: number;
  maxInputTokens?: number;
  outputTokens?: number;
}

export interface ModelTokenRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelPricingTier {
  /** Applies to the whole request when prompt tokens exceed this threshold. */
  aboveInputTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

export interface ModelPricing {
  currency: string;
  rates: ModelTokenRates;
  inputTiers?: ModelPricingTier[];
  metadata?: Record<string, unknown>;
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
  id: string;
  provider: string;
  displayName?: string;
  capabilities: ModelCapabilities;
  modalities: ModelModalities;
  limits: ModelLimits;
  supportedParameters: ModelParameter[];
  pricing?: ModelPricing;
  metadata?: Record<string, unknown>;
}

export interface ModelProviderInfo {
  id: string;
  displayName: string;
  defaultModel: string;
}

export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelReasoningMode = 'standard' | 'pro';

export type ModelReasoningRequest =
  | {
    strategy: 'disabled';
  }
  | {
    strategy: 'enabled';
    summary?: ModelReasoningSummary;
  }
  | {
    strategy: 'effort';
    effort: Exclude<ModelReasoningEffort, 'none'>;
    /** A provider-declared execution mode, serialized only by adapters that support it. */
    mode?: ModelReasoningMode;
    summary?: ModelReasoningSummary;
  }
  | {
    strategy: 'budget';
    maxTokens: number;
    summary?: ModelReasoningSummary;
  };

export interface ModelProviderOptions {
  provider: string;
  values: ModelProviderStateObject;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  responseFormat?: ModelResponseFormat;
  tools?: ModelTool[];
  keepAlive?: string | number;
  reasoning?: ModelReasoningRequest;
  logprobs?: boolean;
  topLogprobs?: number;
  providerOptions?: ModelProviderOptions;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

export type ModelResponseFormat = 'text' | 'json' | { type: 'json_schema'; schema: Record<string, unknown> };

export type ModelToolInputFormat = 'json' | 'text' | 'grammar';

export type ModelToolInputSupport =
  | { readonly kind: 'json' }
  | { readonly kind: 'text' }
  | { readonly kind: 'grammar'; readonly syntax: string };

export type ModelToolInput =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export type ModelToolKind = 'function' | 'custom';

export type ModelTool = ModelFunctionTool | ModelCustomTool;

export interface ModelFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ModelCustomToolFormat =
  | { type: 'text' }
  | { type: 'grammar'; syntax: string; definition: string };

export interface ModelCustomTool {
  type: 'custom';
  name: string;
  description?: string;
  format: ModelCustomToolFormat;
}

export interface ModelFunctionToolCall {
  id?: string;
  type: 'function';
  name: string;
  input: Extract<ModelToolInput, { kind: 'json' }>;
}

export interface ModelCustomToolCall {
  id?: string;
  type: 'custom';
  name: string;
  input: Extract<ModelToolInput, { kind: 'text' }>;
}

export type ModelToolCall = ModelFunctionToolCall | ModelCustomToolCall;

export interface ModelResponse {
  content: string;
  model: string;
  provider: string;
  providerState?: ModelProviderState;
  requestId?: string;
  transport?: ModelTransportMetadata;
  usage?: ModelUsage;
  reasoning?: string;
  reasoningSummary?: string;
  toolCalls?: ModelToolCall[];
  terminationReason: ModelTerminationReason;
  providerTerminationReason?: string;
  timings?: Record<string, number>;
  logprobs?: unknown;
  raw?: unknown;
}

export type ModelTerminationReason =
  | 'stop'
  | 'tool_calls'
  | 'output_limit'
  | 'content_filter'
  | 'unknown';

export type ModelProviderStatePrimitive = string | number | boolean | null;
export type ModelProviderStateValue = ModelProviderStatePrimitive | ModelProviderStateValue[] | ModelProviderStateObject;

export interface ModelProviderStateObject { [key: string]: ModelProviderStateValue }

export interface ModelProviderState {
  provider: string;
  model: string;
  kind: string;
  data: ModelProviderStateObject;
}

export interface ModelTransportMetadata {
  provider: string;
  strategy: string;
  responseId?: string;
  reusedContinuation?: boolean;
  fallbackReason?: string;
}

export type ModelReasoningChannel = 'reasoning' | 'summary';

export type ModelStreamEvent =
  | { type: 'content'; content: string; accumulated: string; raw?: unknown }
  | { type: 'reasoning'; reasoning: string; accumulatedReasoning: string; channel?: ModelReasoningChannel; raw?: unknown }
  | { type: 'tool_call'; toolCall: ModelToolCall; raw?: unknown }
  | { type: 'status'; message: string; raw?: unknown }
  | { type: 'done'; response: ModelResponse };

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
  provider: string;
  code: ModelProviderErrorCode;
  retryable: boolean;
  transport?: string;
  eventType?: string;
  causeSummary?: Record<string, ModelProviderErrorDiagnosticValue>;
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
  estimateMessages(messages: ModelMessage[]): number;
}

export class SimpleTokenEstimator implements TokenEstimator {
  estimateText(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / 4);
  }

  estimateMessages(messages: ModelMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateText(message.content) + 4, 0);
  }
}

export * from './validation.js';
