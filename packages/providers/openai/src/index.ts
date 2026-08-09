import {
  AuthError,
  type BearerTokenProvider,
  CachedBearerTokenProvider,
  createBearerTokenProvider,
  EnvBearerTokenProvider,
  type ProviderAuth,
  StaticBearerTokenProvider
} from '@agent-core/auth';
import {
  type ModelCapabilities,
  ModelContractError,
  type ModelImage,
  type ModelMessage,
  type ModelProfile,
  type ModelProvider,
  ModelProviderError,
  type ModelProviderErrorCode,
  type ModelProviderErrorDiagnosticValue,
  type ModelProviderInfo,
  type ModelProviderSession,
  type ModelProviderState,
  type ModelReasoningRequest,
  type ModelRequest,
  type ModelResponse,
  type ModelResponseFormat,
  type ModelStreamEvent,
  type ModelTool,
  type ModelToolCall,
  type ModelUsage,
  assertModelRequestSupported,
  parseModelProfile,
  parseModelRequest,
  parseModelResponse
} from '@agent-core/model';
import { readBoundedJsonResponse, readBoundedResponseText, readJsonSseEvents, waitForResponseOrStatus } from '@agent-core/provider-openai-responses';

export interface OpenAIProviderOptions {
  auth?: ProviderAuth | BearerTokenProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  statusIntervalMs?: number;
  modelProfiles?: Record<string, OpenAIModelProfileDefinition>;
}

export type OpenAIModelProfileDefinition = Omit<ModelProfile, 'id' | 'provider'>;

interface OpenAIBuiltInProfile {
  displayName?: string;
  capabilities?: Partial<ModelCapabilities>;
  modalities?: Partial<ModelProfile['modalities']>;
  limits?: Partial<ModelProfile['limits']>;
  supportedParameters?: ModelProfile['supportedParameters'];
  pricing?: ModelProfile['pricing'];
  metadata?: Record<string, unknown>;
}

export interface OpenAIRequestOptions {
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  safetyIdentifier?: string;
  promptCacheKey?: string;
  promptCacheOptions?: { mode?: 'implicit' | 'explicit'; ttl?: '30m' };
  reasoningContext?: 'auto' | 'current_turn' | 'all_turns';
}

interface OpenAIResponsesPayload {
  id?: string;
  model?: string;
  status?: string;
  output_text?: string;
  output?: OpenAIOutputItem[];
  usage?: OpenAIUsage;
  error?: OpenAIErrorBody;
  incomplete_details?: {
    reason?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenAIOutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  content?: OpenAIContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  summary?: OpenAIContentPart[] | string;
  [key: string]: unknown;
}

interface OpenAIContentPart {
  type?: string;
  text?: string;
  output_text?: string;
  summary_text?: string;
  [key: string]: unknown;
}

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; [key: string]: unknown };
  output_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

interface OpenAIErrorBody {
  message?: string;
  type?: string;
  code?: string;
  [key: string]: unknown;
}

interface OpenAIStreamData {
  type?: string;
  delta?: string;
  response?: OpenAIResponsesPayload;
  item?: OpenAIOutputItem;
  output_index?: number;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  error?: OpenAIErrorBody;
  [key: string]: unknown;
}

type OpenAISseEvent =
  | { type: 'comment'; comment: string }
  | { type: 'data'; data: OpenAIStreamData | '[DONE]' };

interface StreamingFunctionCallAccumulator {
  id?: string;
  callId?: string;
  name?: string;
  argumentsText: string;
  emittedKey?: string;
}

interface StreamingCustomToolCallAccumulator {
  id?: string;
  callId?: string;
  name?: string;
  inputText: string;
  emittedKey?: string;
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-5.6-sol';
const OPENAI_PROVIDER_ID = 'openai';
const CONTENT_TYPE_JSON = 'application/json';
const OPENAI_DEFAULT_LIMITS: ModelProfile['limits'] = {
  contextTokens: 1_050_000,
  maxInputTokens: 922_000,
  outputTokens: 128_000
};

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }, { kind: 'grammar', syntax: 'lark' }, { kind: 'grammar', syntax: 'regex' }],
  jsonMode: true,
  jsonSchema: true,
  logprobs: true,
  temperature: true,
  topP: true,
  reasoning: {
    strategies: ['effort'],
    canDisable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    modes: ['standard', 'pro'],
    summaries: ['auto', 'concise', 'detailed'],
    separateOutput: true
  }
};

const DEFAULT_SUPPORTED_PARAMETERS: ModelProfile['supportedParameters'] = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'responseFormat',
  'tools',
  'reasoning',
  'logprobs',
  'topLogprobs',
  'metadata',
  'providerOptions'
];

export class OpenAIProvider implements ModelProvider {
  readonly id = OPENAI_PROVIDER_ID;
  private readonly tokenProvider: BearerTokenProvider;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly statusIntervalMs: number;
  private readonly modelProfiles: Record<string, OpenAIModelProfileDefinition>;

  constructor(options: OpenAIProviderOptions = {}) {
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? OPENAI_BASE_URL);
    this.defaultModel = options.model ?? OPENAI_DEFAULT_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.statusIntervalMs = Math.max(1, options.statusIntervalMs ?? 15_000);
    this.modelProfiles = options.modelProfiles ?? {};
    this.tokenProvider = new CachedBearerTokenProvider(resolveTokenProvider(options));
  }

  describe(): ModelProviderInfo {
    return {
      id: this.id,
      displayName: 'OpenAI Responses API provider',
      defaultModel: this.defaultModel
    };
  }

  createSession(): ModelProviderSession {
    return new OpenAIProviderSession(this);
  }

  describeModel(model: string): Promise<ModelProfile> {
    const selectedModel = model || this.defaultModel;
    const builtIn = openAIBuiltInProfile(selectedModel);
    const explicit = this.modelProfiles[selectedModel];
    if (explicit) {
      return Promise.resolve(parseModelProfile({ id: selectedModel, provider: this.id, ...explicit }));
    }
    if (!builtIn) {
      return Promise.reject(new ModelProviderError({
        provider: this.id,
        code: 'model_unavailable',
        message: `OpenAI model ${selectedModel} has no trusted built-in profile. Supply a complete modelProfiles definition after verifying its contract.`
      }));
    }
    const displayName = builtIn.displayName;
    const pricing = builtIn.pricing;
    return Promise.resolve(parseModelProfile({
      id: selectedModel,
      provider: this.id,
      ...(displayName ? { displayName } : {}),
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        ...(builtIn.capabilities ?? {})
      },
      modalities: {
        input: builtIn.modalities?.input ?? ['text', 'image'],
        output: builtIn.modalities?.output ?? ['text']
      },
      limits: {
        ...OPENAI_DEFAULT_LIMITS,
        ...(builtIn.limits ?? {})
      },
      supportedParameters: builtIn.supportedParameters ?? DEFAULT_SUPPORTED_PARAMETERS,
      ...(pricing ? { pricing } : {}),
      metadata: {
        api: 'responses',
        ...(builtIn.metadata ?? {})
      }
    }));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.createSession().complete(request);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const session = this.createSession();
    if (!session.stream) {
      throw new ModelProviderError({ provider: this.id, code: 'invalid_request', message: 'OpenAI provider session does not support streaming.' });
    }
    yield* session.stream(request);
  }

  async *streamWithContinuation(request: ModelRequest, previousResponseId: string | undefined): AsyncIterable<ModelStreamEvent> {
    try {
      parseModelRequest(request);
      throwIfAborted(request.signal);
      const reusedContinuation = previousResponseId !== undefined;
      const responsePromise = this.fetchResponse(request, true, previousResponseId);
      const startedAt = Date.now();
      let response: Response | undefined;
      while (!response) {
        const result = await waitForResponseOrStatus(responsePromise, this.statusIntervalMs, request.signal);
        if (result.type === 'response') {
          response = result.response;
        } else {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
          yield { type: 'status', message: `Waiting for OpenAI stream response (${String(elapsedSeconds)}s).` };
        }
      }

      if (!response.body) {
        throw new ModelProviderError({
          provider: this.id,
          code: 'malformed_response',
          message: 'OpenAI streaming response did not include a readable body.'
        });
      }

      let content = '';
      let reasoning = '';
      let reasoningSummary = '';
      let completedResponse: OpenAIResponsesPayload | undefined;
      const toolCalls: ModelToolCall[] = [];
      const accumulators = new Map<string, StreamingFunctionCallAccumulator>();
      const customAccumulators = new Map<string, StreamingCustomToolCallAccumulator>();

      for await (const event of readSseEvents(response.body)) {
        if (event.type === 'comment') {
          yield { type: 'status', message: `OpenAI stream status: ${event.comment}`, raw: event };
          continue;
        }
        if (event.data === '[DONE]') {
          break;
        }
        const part = event.data;
        const eventType = part.type ?? '';

        if (eventType === 'response.failed') {
          const failure = summarizeOpenAIFailure(part);
          throw new ModelProviderError({
            provider: this.id,
            code: 'provider_unavailable',
            message: `OpenAI response failed: ${failure.message}`,
            retryable: true,
            cause: part,
            diagnostic: {
              transport: 'http_sse',
              ...(failure.eventType ? { eventType: failure.eventType } : {}),
              causeSummary: failure.causeSummary
            }
          });
        }

        if ((eventType === 'response.completed' || eventType === 'response.incomplete') && part.response) {
          completedResponse = part.response;
        }

        const contentDelta = stringValue(part.delta);
        if (eventType === 'response.output_text.delta' && contentDelta.length > 0) {
          content += contentDelta;
          yield { type: 'content', content: contentDelta, accumulated: content, raw: part };
          continue;
        }

        const reasoningChannel = reasoningChannelFromEvent(eventType);
        if (reasoningChannel && contentDelta.length > 0) {
          if (reasoningChannel === 'summary') {
            reasoningSummary += contentDelta;
            yield { type: 'reasoning', reasoning: contentDelta, accumulatedReasoning: reasoningSummary, channel: 'summary', raw: part };
          } else {
            reasoning += contentDelta;
            yield { type: 'reasoning', reasoning: contentDelta, accumulatedReasoning: reasoning, channel: 'reasoning', raw: part };
          }
          continue;
        }

        const toolCall = toolCallFromOutputItem(this.id, part.item);
        if (eventType === 'response.output_item.done' && toolCall) {
          const deduped = addUniqueToolCall(toolCalls, toolCall);
          if (deduped) {
            yield { type: 'tool_call', toolCall, raw: part };
          }
          continue;
        }

        for (const streamedToolCall of mergeStreamingFunctionCallParts(accumulators, part)) {
          const deduped = addUniqueToolCall(toolCalls, streamedToolCall);
          if (deduped) {
            yield { type: 'tool_call', toolCall: streamedToolCall, raw: part };
          }
        }

        for (const streamedToolCall of mergeStreamingCustomToolCallParts(customAccumulators, part)) {
          const deduped = addUniqueToolCall(toolCalls, streamedToolCall);
          if (deduped) {
            yield { type: 'tool_call', toolCall: streamedToolCall, raw: part };
          }
        }
      }

      const responsePayload = completedResponse
        ? toModelResponse(this.id, request, completedResponse, { reusedContinuation })
        : fallbackStreamResponse(this.id, request, content, reasoning, reasoningSummary, toolCalls, { reusedContinuation });
      const responseToolCalls = dedupeToolCalls([...(responsePayload.toolCalls ?? []), ...toolCalls]);
      const recoveredResponse = parseOpenAIModelResponse({
        ...responsePayload,
        content: content && responsePayload.content.length === 0 ? content : responsePayload.content,
        terminationReason: responseToolCalls.length > 0 ? 'tool_calls' : responsePayload.terminationReason,
        ...(reasoning && !responsePayload.reasoning ? { reasoning } : {}),
        ...(reasoningSummary && !responsePayload.reasoningSummary ? { reasoningSummary } : {}),
        ...(responseToolCalls.length > 0 ? { toolCalls: responseToolCalls } : {})
      });
      yield { type: 'done', response: recoveredResponse };
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  async fetchResponse(request: ModelRequest, stream: boolean, previousResponseId?: string): Promise<Response> {
    try {
      parseModelRequest(request);
      assertModelRequestSupported(await this.describeModel(request.model), request);
      const token = await this.tokenProvider.getBearerToken(request.signal);
      const init: RequestInit = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': CONTENT_TYPE_JSON
        },
        body: JSON.stringify(toOpenAIResponsesRequest(request, stream, previousResponseId))
      };
      if (request.signal) {
        init.signal = request.signal;
      }
      const response = await this.fetchImpl(`${this.baseUrl}/responses`, init);
      await this.throwIfBadResponse(response);
      return response;
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  private async throwIfBadResponse(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }
    const { text: body, truncated } = await readBoundedResponseText(response);
    if (response.status === 401) {
      await this.tokenProvider.invalidate?.('unauthorized');
    }
    const extractedMessage = extractErrorMessage(body);
    throw new ModelProviderError({
      provider: this.id,
      code: classifyStatus(response.status, body),
      message: `OpenAI request failed with HTTP ${String(response.status)}: ${extractedMessage}`,
      retryable: response.status === 429 || response.status >= 500,
      diagnostic: {
        transport: 'http',
        causeSummary: {
          status: response.status,
          errorMessage: extractedMessage,
          ...(truncated ? { bodyTruncated: true } : {})
        }
      }
    });
  }
}

function openAIBuiltInProfile(model: string): OpenAIBuiltInProfile | undefined {
  if (model === 'gpt-5.6-sol' || model === 'gpt-5.6') return gpt56Profile('GPT-5.6 Sol', 'sol', 5, 30);
  if (model === 'gpt-5.6-terra') return gpt56Profile('GPT-5.6 Terra', 'terra', 2.5, 15);
  if (model === 'gpt-5.6-luna') return gpt56Profile('GPT-5.6 Luna', 'luna', 1, 6);
  if (model === 'gpt-5.5') return {
    displayName: 'GPT-5.5',
    limits: { contextTokens: 1_050_000, maxInputTokens: 922_000, outputTokens: 128_000 },
    pricing: tieredOpenAIPricing(5, 30),
    capabilities: { reasoning: { strategies: ['effort'], canDisable: true, efforts: ['low', 'medium', 'high', 'xhigh'], summaries: ['auto', 'concise', 'detailed'], separateOutput: true } },
    metadata: { modelTier: 'gpt-5.5', defaultReasoningEffort: 'medium' }
  };
  if (model === 'gpt-5.5-pro') return {
    displayName: 'GPT-5.5 Pro',
    limits: { contextTokens: 1_050_000, maxInputTokens: 922_000, outputTokens: 128_000 },
    pricing: { currency: 'USD', rates: { input: 30, output: 180 } },
    capabilities: {
      streaming: false,
      reasoning: { strategies: ['effort'], canDisable: false, efforts: ['medium', 'high', 'xhigh'], summaries: ['auto', 'concise', 'detailed'], separateOutput: true }
    },
    metadata: { modelTier: 'standalone-pro-model', defaultReasoningEffort: 'high' }
  };
  return undefined;
}

function gpt56Profile(displayName: string, modelTier: string, inputRate: number, outputRate: number): OpenAIBuiltInProfile {
  return {
    displayName,
    limits: { contextTokens: 1_050_000, maxInputTokens: 922_000, outputTokens: 128_000 },
    pricing: tieredOpenAIPricing(inputRate, outputRate),
    metadata: { modelTier, defaultReasoningEffort: 'medium', defaultReasoningMode: 'standard' }
  };
}

function tieredOpenAIPricing(inputRate: number, outputRate: number): NonNullable<ModelProfile['pricing']> {
  return {
    currency: 'USD',
    rates: { input: inputRate, cacheRead: inputRate / 10, cacheWrite: inputRate * 1.25, output: outputRate },
    inputTiers: [{ aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }]
  };
}

class OpenAIProviderSession implements ModelProviderSession {
  private previousResponseId: string | undefined;

  constructor(private readonly provider: OpenAIProvider) {}

  retryDisposition(): 'reset_required' { return 'reset_required'; }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const previousResponseId = this.previousResponseId;
    const reusedContinuation = previousResponseId !== undefined;
    try {
      const response = await this.provider.fetchResponse(request, false, previousResponseId);
      const payload = await parseJsonResponse<OpenAIResponsesPayload>(this.provider.id, response);
      const modelResponse = toModelResponse(this.provider.id, request, payload, { reusedContinuation });
      this.previousResponseId = modelResponse.transport?.responseId;
      const state = this.providerState(request.model);
      return state ? parseOpenAIModelResponse({ ...modelResponse, providerState: state }) : modelResponse;
    } catch (error) {
      this.resetContinuation('error');
      throw withContinuationDiagnostic(this.provider.id, error, {
        previousResponseId,
        reusedContinuation,
        transport: 'http',
        strategy: 'stored_response'
      });
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const previousResponseId = this.previousResponseId;
    const reusedContinuation = previousResponseId !== undefined;
    try {
      for await (const event of this.provider.streamWithContinuation(request, previousResponseId)) {
        if (event.type === 'done') {
          this.previousResponseId = event.response.transport?.responseId;
          const state = this.providerState(request.model);
          yield state
            ? { ...event, response: parseOpenAIModelResponse({ ...event.response, providerState: state }) }
            : event;
          continue;
        }
        yield event;
      }
    } catch (error) {
      this.resetContinuation('error');
      throw withContinuationDiagnostic(this.provider.id, error, {
        previousResponseId,
        reusedContinuation,
        transport: 'http_sse',
        strategy: 'stored_response'
      });
    }
  }

  restoreProviderState(state: ModelProviderState): void {
    if (state.provider !== OPENAI_PROVIDER_ID || state.kind !== 'openai.responses.stored_response') {
      return;
    }
    const responseId = state.data.responseId;
    this.previousResponseId = typeof responseId === 'string' && responseId.length > 0 ? responseId : undefined;
  }

  resetContinuation(reason: string): void {
    void reason;
    this.previousResponseId = undefined;
  }

  private providerState(model: string): ModelProviderState | undefined {
    return this.previousResponseId
      ? {
        provider: OPENAI_PROVIDER_ID,
        model,
        kind: 'openai.responses.stored_response',
        data: {
          responseId: this.previousResponseId
        }
      }
      : undefined;
  }
}

function withContinuationDiagnostic(
  provider: string,
  error: unknown,
  continuation: {
    previousResponseId: string | undefined;
    reusedContinuation: boolean;
    transport: string;
    strategy: string;
  }
): ModelProviderError {
  const normalized = normalizeError(provider, error);
  if (!continuation.reusedContinuation || !continuation.previousResponseId) {
    return normalized;
  }
  return new ModelProviderError({
    provider: normalized.provider,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    cause: normalized.causeValue,
    diagnostic: {
      transport: normalized.diagnostic.transport ?? continuation.transport,
      ...(normalized.diagnostic.eventType ? { eventType: normalized.diagnostic.eventType } : {}),
      causeSummary: {
        ...(normalized.diagnostic.causeSummary ?? {}),
        previousResponseId: continuation.previousResponseId,
        reusedContinuation: true,
        continuationStrategy: continuation.strategy
      }
    }
  });
}

function resolveTokenProvider(options: OpenAIProviderOptions): BearerTokenProvider {
  if (options.auth) {
    return isBearerTokenProvider(options.auth) ? options.auth : createBearerTokenProvider(options.auth);
  }
  if (options.apiKey !== undefined) {
    return new StaticBearerTokenProvider(options.apiKey, {
      type: 'api_key',
      label: 'configured OpenAI API key',
      provider: OPENAI_PROVIDER_ID
    });
  }
  return new EnvBearerTokenProvider('OPENAI_API_KEY', {
    label: 'OPENAI_API_KEY environment variable',
    provider: OPENAI_PROVIDER_ID
  });
}

function isBearerTokenProvider(value: ProviderAuth | BearerTokenProvider): value is BearerTokenProvider {
  return typeof (value as BearerTokenProvider).getBearerToken === 'function';
}

function toOpenAIResponsesRequest(request: ModelRequest, stream: boolean, previousResponseId: string | undefined): Record<string, unknown> {
  const { instructions, input, usesPreviousResponse } = toOpenAIInput(request.messages, previousResponseId !== undefined);
  const body: Record<string, unknown> = {
    model: request.model,
    input,
    store: true,
    stream
  };
  if (instructions.length > 0) body.instructions = instructions;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  const text = toOpenAITextConfig(request.responseFormat);
  if (text) body.text = text;
  if (request.tools && request.tools.length > 0) body.tools = request.tools.map(toOpenAITool);
  const reasoning = toOpenAIReasoning(request.reasoning);
  if (reasoning) body.reasoning = reasoning;
  if (request.logprobs !== undefined || request.topLogprobs !== undefined) {
    body.include = ['message.output_text.logprobs'];
    if (request.topLogprobs !== undefined) body.top_logprobs = request.topLogprobs;
  }
  if (request.metadata && Object.keys(request.metadata).length > 0) body.metadata = request.metadata;
  if (previousResponseId && usesPreviousResponse) body.previous_response_id = previousResponseId;
  applyOpenAIProviderOptions(body, request);
  return body;
}

function applyOpenAIProviderOptions(body: Record<string, unknown>, request: ModelRequest): void {
  const options = providerOptionsFor(request, OPENAI_PROVIDER_ID);
  if (!options) return;
  const allowed = new Set(['serviceTier', 'safetyIdentifier', 'promptCacheKey', 'promptCacheOptions', 'reasoningContext']);
  rejectUnknownProviderOptions(options, allowed, OPENAI_PROVIDER_ID);
  if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
  if (options.safetyIdentifier !== undefined) body.safety_identifier = options.safetyIdentifier;
  if (options.promptCacheKey !== undefined) body.prompt_cache_key = options.promptCacheKey;
  if (options.promptCacheOptions !== undefined) body.prompt_cache_options = options.promptCacheOptions;
  if (options.reasoningContext !== undefined) body.reasoning = { ...(isJsonObject(body.reasoning) ? body.reasoning : {}), context: options.reasoningContext };
}

function providerOptionsFor(request: ModelRequest, provider: string): Record<string, unknown> | undefined {
  if (!request.providerOptions) return undefined;
  if (request.providerOptions.provider !== provider) {
    throw new ModelProviderError({ provider, code: 'invalid_request', message: `Request options for ${request.providerOptions.provider} cannot be used with ${provider}.` });
  }
  return request.providerOptions.values;
}

function rejectUnknownProviderOptions(options: Record<string, unknown>, allowed: ReadonlySet<string>, provider: string): void {
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ModelProviderError({ provider, code: 'invalid_request', message: `Unsupported ${provider} provider option(s): ${unknown.join(', ')}.` });
  if (options.serviceTier !== undefined && (typeof options.serviceTier !== 'string' || !['auto', 'default', 'flex', 'priority'].includes(options.serviceTier))) throw new ModelProviderError({ provider, code: 'invalid_request', message: 'OpenAI serviceTier is invalid.' });
  if (options.promptCacheOptions !== undefined && (!isJsonObject(options.promptCacheOptions) || !onlyOpenAIOptionKeys(options.promptCacheOptions, ['mode', 'ttl']) || (options.promptCacheOptions.mode !== undefined && options.promptCacheOptions.mode !== 'implicit' && options.promptCacheOptions.mode !== 'explicit') || (options.promptCacheOptions.ttl !== undefined && options.promptCacheOptions.ttl !== '30m'))) throw new ModelProviderError({ provider, code: 'invalid_request', message: 'OpenAI promptCacheOptions must use mode implicit|explicit and ttl 30m.' });
  if (options.reasoningContext !== undefined && options.reasoningContext !== 'auto' && options.reasoningContext !== 'current_turn' && options.reasoningContext !== 'all_turns') throw new ModelProviderError({ provider, code: 'invalid_request', message: 'OpenAI reasoningContext is invalid.' });
  for (const key of ['safetyIdentifier', 'promptCacheKey']) if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key].length === 0)) throw new ModelProviderError({ provider, code: 'invalid_request', message: `OpenAI ${key} must be a non-empty string.` });
}

function onlyOpenAIOptionKeys(value: Record<string, unknown>, allowed: string[]): boolean { const keys = new Set(allowed); return Object.keys(value).every((key) => keys.has(key)); }

function toOpenAIInput(messages: ModelMessage[], preferIncremental = false): { instructions: string; input: unknown[]; usesPreviousResponse: boolean } {
  const instructionMessages = instructionMessagesFrom(messages);
  const input: unknown[] = [];
  const projectedMessages = preferIncremental ? incrementalMessagesAfterPreviousResponse(messages) : undefined;
  for (const message of projectedMessages ?? messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'tool') {
      input.push(toolCallOutputForOpenAIMessage(message));
      if (message.images && message.images.length > 0) input.push({ role: 'user', content: contentForOpenAIMessage({ role: 'user', content: '', images: message.images }) });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content.length > 0) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push(toOpenAIFunctionCallInput(toolCall));
      }
      continue;
    }
    input.push({
      role: 'user',
      content: contentForOpenAIMessage(message)
    });
  }
  return {
    instructions: instructionMessages.join('\n\n'),
    input,
    usesPreviousResponse: projectedMessages !== undefined
  };
}

function instructionMessagesFrom(messages: ModelMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'system' && message.content.trim().length > 0)
    .map((message) => message.content);
}

function incrementalMessagesAfterPreviousResponse(messages: ModelMessage[]): ModelMessage[] | undefined {
  const lastAssistantIndex = findLastIndex(messages, (message) => message.role === 'assistant');
  const candidateMessages = lastAssistantIndex >= 0
    ? messages.slice(lastAssistantIndex + 1)
    : messages.filter((message) => message.role !== 'system');
  const incrementalMessages = candidateMessages.filter((message) => message.role !== 'system');
  return incrementalMessages.length > 0 ? incrementalMessages : undefined;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) {
      return index;
    }
  }
  return -1;
}

function contentForOpenAIMessage(message: ModelMessage): string | Record<string, unknown>[] {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }
  return [
    ...(message.content.length > 0 ? [{ type: 'input_text', text: message.content }] : []),
    ...message.images.map((image) => ({
      type: 'input_image',
      image_url: `data:${image.mediaType};base64,${imageToBase64(image)}`,
      ...(image.detail ? { detail: image.detail } : {})
    }))
  ];
}

function imageToBase64(image: ModelImage): string {
  return image.type === 'base64' ? image.data : Buffer.from(image.data).toString('base64');
}

function toOpenAIFunctionCallInput(toolCall: ModelToolCall): Record<string, unknown> {
  if (toolCall.input.kind === 'text') {
    return {
      type: 'custom_tool_call',
      call_id: toolCall.id ?? `call_${toolCall.name}`,
      name: toolCall.name,
      input: toolCall.input.value
    };
  }
  return {
    type: 'function_call',
    call_id: toolCall.id ?? `call_${toolCall.name}`,
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.input.value)
  };
}

function toOpenAITool(tool: ModelTool): Record<string, unknown> {
  if (tool.type === 'custom') {
    return {
      type: 'custom',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      format: tool.format
    };
  }
  return {
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { parameters: tool.function.parameters } : {})
  };
}

function toolCallOutputForOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  const callId = message.toolCallId ?? message.toolName ?? message.name ?? 'call_unknown';
  if (message.toolCallType === 'custom') {
    return {
      type: 'custom_tool_call_output',
      call_id: callId,
      output: message.content
    };
  }
  return {
    type: 'function_call_output',
    call_id: callId,
    output: message.content
  };
}

function toOpenAITextConfig(format: ModelResponseFormat | undefined): Record<string, unknown> | undefined {
  if (!format || format === 'text') {
    return undefined;
  }
  if (format === 'json') {
    return { format: { type: 'json_object' } };
  }
  return {
    format: {
      type: 'json_schema',
      name: 'agent_core_response',
      strict: true,
      schema: format.schema
    }
  };
}

function toOpenAIReasoning(reasoning: ModelReasoningRequest | undefined): Record<string, unknown> | undefined {
  if (!reasoning) {
    return undefined;
  }
  if (reasoning.strategy === 'disabled') return { effort: 'none' };
  if (reasoning.strategy === 'enabled') throw new ModelProviderError({ provider: OPENAI_PROVIDER_ID, code: 'invalid_request', message: 'OpenAI Responses requires an explicit reasoning effort.' });
  if (reasoning.strategy === 'budget') throw new ModelProviderError({ provider: OPENAI_PROVIDER_ID, code: 'invalid_request', message: 'OpenAI Responses does not accept a reasoning token budget.' });
  return {
    effort: reasoning.effort,
    ...(reasoning.mode ? { mode: reasoning.mode } : {}),
    ...(reasoning.summary ? { summary: reasoning.summary } : {})
  };
}

function toModelResponse(
  provider: string,
  request: ModelRequest,
  payload: OpenAIResponsesPayload,
  transport: { reusedContinuation?: boolean } = {}
): ModelResponse {
  if (payload.error) {
    const failure = summarizeOpenAIFailure(payload);
    throw new ModelProviderError({
      provider,
      code: 'provider_unavailable',
      message: `OpenAI response contained an error: ${failure.message}`,
      retryable: true,
      cause: payload,
      diagnostic: {
        transport: 'http',
        ...(failure.eventType ? { eventType: failure.eventType } : {}),
        causeSummary: failure.causeSummary
      }
    });
  }
  if (payload.status !== 'completed' && payload.status !== 'incomplete') {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `OpenAI returned non-terminal response status: ${String(payload.status)}.`,
      cause: payload
    });
  }
  const content = typeof payload.output_text === 'string' ? payload.output_text : contentFromOutput(payload.output ?? []);
  const toolCalls = normalizeToolCalls(provider, payload.output ?? []);
  const reasoningSummary = reasoningSummaryFromOutput(payload.output ?? []);
  const providerTerminationReason = payload.incomplete_details?.reason ?? payload.status;
  const response: ModelResponse = {
    content,
    model: payload.model ?? request.model,
    provider,
    terminationReason: normalizeOpenAITermination(payload, toolCalls.length > 0),
    ...(providerTerminationReason ? { providerTerminationReason } : {}),
    raw: payload,
    transport: responseTransport(provider, 'stored_response', payload.id, transport)
  };
  if (payload.id) response.requestId = payload.id;
  const usage = normalizeUsage(payload.usage);
  if (usage) response.usage = usage;
  if (reasoningSummary) response.reasoningSummary = reasoningSummary;
  if (toolCalls.length > 0) response.toolCalls = toolCalls;
  return parseOpenAIModelResponse(response);
}

function fallbackStreamResponse(
  provider: string,
  request: ModelRequest,
  content: string,
  reasoning: string,
  reasoningSummary: string,
  toolCalls: ModelToolCall[],
  transport: { reusedContinuation?: boolean } = {}
): ModelResponse {
  const response: ModelResponse = {
    content,
    model: request.model,
    provider,
    terminationReason: toolCalls.length > 0 ? 'tool_calls' : 'unknown',
    transport: responseTransport(provider, 'stored_response', undefined, transport)
  };
  if (reasoning) response.reasoning = reasoning;
  if (reasoningSummary) response.reasoningSummary = reasoningSummary;
  if (toolCalls.length > 0) response.toolCalls = dedupeToolCalls(toolCalls);
  return parseOpenAIModelResponse(response);
}

function normalizeOpenAITermination(
  payload: OpenAIResponsesPayload,
  hasToolCalls: boolean
): ModelResponse['terminationReason'] {
  if (hasToolCalls) {
    return 'tool_calls';
  }
  const incompleteReason = payload.incomplete_details?.reason;
  if (incompleteReason === 'max_output_tokens') {
    return 'output_limit';
  }
  if (incompleteReason === 'content_filter') {
    return 'content_filter';
  }
  if (payload.status === 'completed') {
    return 'stop';
  }
  return 'unknown';
}

function responseTransport(
  provider: string,
  strategy: string,
  responseId: string | undefined,
  options: { reusedContinuation?: boolean }
): NonNullable<ModelResponse['transport']> {
  return {
    provider,
    strategy,
    ...(responseId ? { responseId } : {}),
    ...(options.reusedContinuation !== undefined ? { reusedContinuation: options.reusedContinuation } : {})
  };
}

function contentFromOutput(output: OpenAIOutputItem[]): string {
  return output
    .filter((item) => item.type === 'message' || item.role === 'assistant')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? part.output_text ?? '')
    .join('');
}

function reasoningSummaryFromOutput(output: OpenAIOutputItem[]): string {
  return output
    .filter((item) => item.type === 'reasoning')
    .map((item) => {
      if (typeof item.summary === 'string') {
        return item.summary;
      }
      if (Array.isArray(item.summary)) {
        return item.summary.map((part) => part.text ?? part.summary_text ?? '').join('');
      }
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function normalizeToolCalls(provider: string, output: OpenAIOutputItem[]): ModelToolCall[] {
  return output
    .map((item) => toolCallFromOutputItem(provider, item))
    .filter((toolCall): toolCall is ModelToolCall => toolCall !== undefined);
}

function toolCallFromOutputItem(provider: string, item: OpenAIOutputItem | undefined): ModelToolCall | undefined {
  if (item?.type === 'custom_tool_call') {
    if (!item.name) {
      throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenAI custom_tool_call item did not include name.' });
    }
    return {
      ...(item.call_id ? { id: item.call_id } : item.id ? { id: item.id } : {}),
      type: 'custom',
      name: item.name,
      input: { kind: 'text', value: stringValue(item.input) }
    };
  }
  if (item?.type !== 'function_call') {
    return undefined;
  }
  if (!item.name) {
    throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenAI function_call item did not include name.' });
  }
  return {
    ...(item.call_id ? { id: item.call_id } : item.id ? { id: item.id } : {}),
    type: 'function',
    name: item.name,
    input: { kind: 'json', value: parseToolArguments(provider, item.arguments) }
  };
}

function parseToolArguments(provider: string, value: string | undefined): Record<string, unknown> {
  if (value === undefined || value.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (isJsonObject(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `OpenAI tool call arguments were not valid JSON: ${errorMessage(error)}`,
      cause: error
    });
  }
  throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenAI tool call arguments must decode to a JSON object.' });
}

function mergeStreamingFunctionCallParts(accumulators: Map<string, StreamingFunctionCallAccumulator>, part: OpenAIStreamData): ModelToolCall[] {
  const eventType = part.type ?? '';
  if (!eventType.includes('function_call')) {
    return [];
  }
  const key = part.item_id ?? String(part.output_index ?? 0);
  const existing = accumulators.get(key) ?? { argumentsText: '' };
  if (typeof part.call_id === 'string') existing.callId = part.call_id;
  if (typeof part.name === 'string') existing.name = part.name;
  if (typeof part.delta === 'string') existing.argumentsText += part.delta;
  if (typeof part.arguments === 'string') existing.argumentsText = part.arguments;
  accumulators.set(key, existing);
  const maybeToolCall = tryAccumulatorToToolCall(existing);
  if (!maybeToolCall) {
    return [];
  }
  const callKey = JSON.stringify(maybeToolCall);
  if (existing.emittedKey === callKey) {
    return [];
  }
  existing.emittedKey = callKey;
  return [maybeToolCall];
}

function tryAccumulatorToToolCall(item: StreamingFunctionCallAccumulator): ModelToolCall | undefined {
  if (!item.name || item.argumentsText.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(item.argumentsText);
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    return {
      ...(item.callId ? { id: item.callId } : item.id ? { id: item.id } : {}),
      type: 'function',
      name: item.name,
      input: { kind: 'json', value: parsed }
    };
  } catch {
    return undefined;
  }
}

function mergeStreamingCustomToolCallParts(accumulators: Map<string, StreamingCustomToolCallAccumulator>, part: OpenAIStreamData): ModelToolCall[] {
  const eventType = part.type ?? '';
  if (!eventType.includes('custom_tool_call')) {
    return [];
  }
  const key = part.item_id ?? String(part.output_index ?? 0);
  const existing = accumulators.get(key) ?? { inputText: '' };
  if (typeof part.call_id === 'string') existing.callId = part.call_id;
  if (typeof part.name === 'string') existing.name = part.name;
  if (typeof part.delta === 'string') existing.inputText += part.delta;
  if (typeof part.input === 'string') existing.inputText = part.input;
  if (part.item?.type === 'custom_tool_call') {
    if (typeof part.item.call_id === 'string') existing.callId = part.item.call_id;
    if (typeof part.item.id === 'string') existing.id = part.item.id;
    if (typeof part.item.name === 'string') existing.name = part.item.name;
    if (typeof part.item.input === 'string') existing.inputText = part.item.input;
  }
  accumulators.set(key, existing);
  const maybeToolCall = tryCustomAccumulatorToToolCall(existing);
  if (!maybeToolCall) {
    return [];
  }
  const callKey = JSON.stringify(maybeToolCall);
  if (existing.emittedKey === callKey) {
    return [];
  }
  existing.emittedKey = callKey;
  return [maybeToolCall];
}

function tryCustomAccumulatorToToolCall(item: StreamingCustomToolCallAccumulator): ModelToolCall | undefined {
  if (!item.name || item.inputText.length === 0) {
    return undefined;
  }
  return {
    ...(item.callId ? { id: item.callId } : item.id ? { id: item.id } : {}),
    type: 'custom',
    name: item.name,
    input: { kind: 'text', value: item.inputText }
  };
}

function addUniqueToolCall(toolCalls: ModelToolCall[], toolCall: ModelToolCall): boolean {
  const key = toolCallIdentity(toolCall);
  if (toolCalls.some((existing) => toolCallIdentity(existing) === key)) {
    return false;
  }
  toolCalls.push(toolCall);
  return true;
}

function dedupeToolCalls(toolCalls: ModelToolCall[]): ModelToolCall[] {
  const seen = new Set<string>();
  const result: ModelToolCall[] = [];
  for (const toolCall of toolCalls) {
    const key = toolCallIdentity(toolCall);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(toolCall);
    }
  }
  return result;
}

function toolCallIdentity(toolCall: ModelToolCall): string {
  return JSON.stringify([toolCall.id, toolCall.type, toolCall.name, toolCall.input]);
}

function normalizeUsage(usage: OpenAIUsage | undefined): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(usage.input_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.input_tokens_details.cached_tokens }),
    ...(usage.input_tokens_details?.cache_write_tokens === undefined ? {} : { cacheWriteTokens: usage.input_tokens_details.cache_write_tokens }),
    ...(usage.output_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.output_tokens_details.reasoning_tokens })
  };
}

function readSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<OpenAISseEvent> {
  return readJsonSseEvents<OpenAIStreamData>(body, {
    createMalformedError: (message, cause) => new ModelProviderError({ provider: OPENAI_PROVIDER_ID, code: 'malformed_response', message: `OpenAI ${message}`, cause })
  });
}

async function parseJsonResponse<T>(provider: string, response: Response): Promise<T> {
  try {
    return await readBoundedJsonResponse<T>(response);
  } catch (error) {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `OpenAI response was not valid JSON: ${errorMessage(error)}`,
      cause: error
    });
  }
}

function normalizeError(provider: string, error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  if (error instanceof ModelContractError) {
    return new ModelProviderError({
      provider,
      code: 'invalid_request',
      message: error.message,
      retryable: false,
      cause: error
    });
  }
  if (error instanceof AuthError) {
    return new ModelProviderError({
      provider,
      code: authErrorCodeToModelCode(error),
      message: `OpenAI credentials error: ${error.message}`,
      retryable: error.retryable,
      cause: error
    });
  }
  const message = errorMessage(error);
  if (isAbortError(error) || /abort/i.test(message)) {
    return new ModelProviderError({ provider, code: 'aborted', message: `OpenAI request aborted: ${message}`, cause: error });
  }
  return new ModelProviderError({
    provider,
    code: 'provider_unavailable',
    message: `OpenAI request failed: ${message}`,
    retryable: true,
    cause: error
  });
}

function parseOpenAIModelResponse(value: unknown): ModelResponse {
  try {
    return parseModelResponse(value);
  } catch (error) {
    if (error instanceof ModelContractError) {
      throw new ModelProviderError({ provider: OPENAI_PROVIDER_ID, code: 'malformed_response', message: `OpenAI response violated the model contract: ${error.message}`, cause: error });
    }
    throw error;
  }
}

function authErrorCodeToModelCode(error: AuthError): ModelProviderErrorCode {
  if (error.code === 'aborted') {
    return 'aborted';
  }
  if (error.code === 'io_error') {
    return 'provider_unavailable';
  }
  return 'invalid_request';
}

function classifyStatus(status: number, body: string): ModelProviderErrorCode {
  if (status === 404) return 'model_unavailable';
  if (status === 408 || status === 413 || /context|token|too large/i.test(body)) return 'context_overflow';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 401 || status === 402 || status === 403 || status === 422) return 'invalid_request';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

function extractErrorMessage(body: string): string {
  if (body.length === 0) {
    return 'empty response body';
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (isJsonObject(parsed)) {
      const error = parsed.error;
      if (isJsonObject(error) && typeof error.message === 'string') {
        return error.message;
      }
      if (typeof parsed.message === 'string') {
        return parsed.message;
      }
    }
    return body;
  } catch {
    return body;
  }
}

function summarizeOpenAIFailure(payload: OpenAIStreamData | OpenAIResponsesPayload): {
  message: string;
  eventType?: string;
  causeSummary: Record<string, ModelProviderErrorDiagnosticValue>;
} {
  const response = isJsonObject(payload.response) ? payload.response as OpenAIResponsesPayload : undefined;
  const payloadIncompleteDetails = isJsonObject(payload.incomplete_details) ? payload.incomplete_details : undefined;
  const payloadOutput = Array.isArray(payload.output) ? payload.output as OpenAIOutputItem[] : undefined;
  const error = payload.error ?? response?.error;
  const causeSummary: Record<string, ModelProviderErrorDiagnosticValue> = {};
  addDiagnosticField(causeSummary, 'eventType', payload.type);
  addDiagnosticField(causeSummary, 'status', payload.status ?? response?.status);
  addDiagnosticField(causeSummary, 'responseId', payload.id ?? response?.id);
  addDiagnosticField(causeSummary, 'model', payload.model ?? response?.model);
  addDiagnosticField(causeSummary, 'errorMessage', error?.message);
  addDiagnosticField(causeSummary, 'errorCode', error?.code);
  addDiagnosticField(causeSummary, 'errorType', error?.type);
  addDiagnosticField(causeSummary, 'incompleteReason', payloadIncompleteDetails?.reason ?? response?.incomplete_details?.reason);

  const outputError = firstOutputError(payloadOutput ?? response?.output);
  if (outputError) {
    addDiagnosticField(causeSummary, 'outputErrorType', outputError.type);
    addDiagnosticField(causeSummary, 'outputErrorStatus', outputError.status);
    addDiagnosticField(causeSummary, 'outputErrorMessage', outputError.message);
    addDiagnosticField(causeSummary, 'outputErrorCode', outputError.code);
  }

  const message = error?.message
    ?? error?.code
    ?? error?.type
    ?? outputError?.message
    ?? outputError?.code
    ?? summarizedFailureMessage(causeSummary);
  return {
    message,
    ...(typeof causeSummary.eventType === 'string' ? { eventType: causeSummary.eventType } : {}),
    causeSummary
  };
}

function summarizedFailureMessage(summary: Record<string, ModelProviderErrorDiagnosticValue>): string {
  const parts = [
    typeof summary.eventType === 'string' ? `event=${summary.eventType}` : '',
    typeof summary.status === 'string' ? `status=${summary.status}` : '',
    typeof summary.responseId === 'string' ? `responseId=${summary.responseId}` : '',
    typeof summary.incompleteReason === 'string' ? `incompleteReason=${summary.incompleteReason}` : ''
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('; ') : 'provider returned a failed response without error details';
}

function firstOutputError(items: OpenAIOutputItem[] | undefined): {
  type?: string;
  status?: string;
  message?: string;
  code?: string;
} | undefined {
  for (const item of items ?? []) {
    if (item.status === 'failed' || item.type === 'error' || isJsonObject(item.error)) {
      const error = isJsonObject(item.error) ? item.error as OpenAIErrorBody : undefined;
      return {
        ...(item.type ? { type: item.type } : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(error?.message ? { message: error.message } : {}),
        ...(error?.code ? { code: error.code } : {})
      };
    }
  }
  return undefined;
}

function addDiagnosticField(
  target: Record<string, ModelProviderErrorDiagnosticValue>,
  key: string,
  value: unknown
): void {
  const diagnosticValue = diagnosticValueFromUnknown(value);
  if (diagnosticValue !== undefined && diagnosticValue !== '') {
    target[key] = diagnosticValue;
  }
}

function diagnosticValueFromUnknown(value: unknown): ModelProviderErrorDiagnosticValue | undefined {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (isJsonObject(value)) {
    return truncateDiagnosticString(JSON.stringify(value));
  }
  return undefined;
}

function truncateDiagnosticString(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function reasoningChannelFromEvent(eventType: string): 'summary' | 'reasoning' | undefined {
  if (eventType === 'response.reasoning_summary_text.delta') {
    return 'summary';
  }
  if (eventType === 'response.reasoning_text.delta' || eventType === 'response.reasoning.delta') {
    return 'reasoning';
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw new ModelProviderError({
    provider: OPENAI_PROVIDER_ID,
    code: 'aborted',
    message: typeof signal.reason === 'string' ? signal.reason : 'OpenAI request aborted.',
    cause: signal.reason
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
