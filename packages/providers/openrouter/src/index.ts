import {
  type ModelCapabilities,
  ModelContractError,
  type ModelImage,
  type ModelMessage,
  type ModelModality,
  type ModelPricing,
  type ModelProfile,
  type ModelProvider,
  ModelProviderError,
  type ModelProviderErrorCode,
  type ModelProviderInfo,
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

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  appUrl?: string;
  appTitle?: string;
  fetch?: typeof fetch;
  statusIntervalMs?: number;
  catalogTtlMs?: number;
}

interface OpenRouterModelCatalog {
  data?: OpenRouterModelRecord[];
}

interface OpenRouterModelRecord {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number | null;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    [key: string]: unknown;
  };
  pricing?: Record<string, string | number | null | undefined>;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    [key: string]: unknown;
  } | null;
  supported_parameters?: string[];
  reasoning?: {
    supported_efforts?: string[] | null;
    supports_max_tokens?: boolean;
    mandatory?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenRouterChatResponse {
  id?: string;
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  provider?: string;
  error?: { code?: number | string; message?: string; metadata?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

interface OpenRouterChoice {
  message?: OpenRouterResponseMessage;
  delta?: OpenRouterResponseMessage;
  finish_reason?: string | null;
  [key: string]: unknown;
}

interface OpenRouterResponseMessage {
  role?: string;
  content?: string | null | Record<string, unknown>[];
  reasoning?: string | null;
  reasoning_details?: unknown;
  tool_calls?: OpenRouterWireToolCall[];
  [key: string]: unknown;
}

interface OpenRouterWireToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; [key: string]: unknown };
  completion_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

interface StreamingToolCallAccumulator {
  id?: string;
  type?: 'function';
  name?: string;
  argumentsText: string;
  emittedKey?: string;
}

type OpenRouterSseEvent =
  | { type: 'comment'; comment: string }
  | { type: 'data'; data: OpenRouterChatResponse | '[DONE]' };

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';
const OPENROUTER_PROVIDER_ID = 'openrouter';
const MAX_SSE_BUFFER_BYTES = 1_048_576;
const MAX_DIAGNOSTIC_BODY_BYTES = 65_536;
const MAX_JSON_BODY_BYTES = 33_554_432;
const CONTENT_TYPE_JSON = 'application/json';

export class OpenRouterProvider implements ModelProvider {
  readonly id = OPENROUTER_PROVIDER_ID;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly appUrl: string | undefined;
  private readonly appTitle: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly statusIntervalMs: number;
  private readonly catalogTtlMs: number;
  private modelCatalogPromise: Promise<OpenRouterModelRecord[]> | undefined;
  private modelCatalogExpiresAt = 0;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? OPENROUTER_BASE_URL);
    this.defaultModel = options.model ?? OPENROUTER_DEFAULT_MODEL;
    this.appUrl = options.appUrl ?? process.env.OPENROUTER_APP_URL;
    this.appTitle = options.appTitle ?? process.env.OPENROUTER_APP_TITLE;
    this.fetchImpl = options.fetch ?? fetch;
    this.statusIntervalMs = Math.max(1, options.statusIntervalMs ?? 15_000);
    this.catalogTtlMs = Math.max(1, options.catalogTtlMs ?? 5 * 60_000);
  }

  describe(): ModelProviderInfo {
    return {
      id: this.id,
      displayName: 'OpenRouter model provider',
      defaultModel: this.defaultModel
    };
  }

  async describeModel(model: string): Promise<ModelProfile> {
    const selectedModel = model || this.defaultModel;
    const catalog = await this.modelCatalog();
    const record = catalog.find((item) => item.id === selectedModel);
    if (!record) {
      throw new ModelProviderError({
        provider: this.id,
        code: 'model_unavailable',
        message: `OpenRouter model not found in catalog: ${selectedModel}`
      });
    }
    return parseModelProfile(modelRecordToProfile(record));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      request = await this.validateRequest(request);
      const response = await this.fetchChatCompletion(request, false);
      const payload = await parseJsonResponse<OpenRouterChatResponse>(this.id, response);
      return toModelResponse(this.id, request, payload);
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    try {
      request = await this.validateRequest(request);
      const responsePromise = this.fetchChatCompletion(request, true);
      const startedAt = Date.now();
      let response: Response | undefined;
      while (!response) {
        const result = await waitForOpenRouterResponse(responsePromise, this.statusIntervalMs, request.signal);
        if (result.type === 'response') {
          response = result.response;
        } else {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
          yield { type: 'status', message: `Waiting for OpenRouter stream response (${String(elapsedSeconds)}s).` };
        }
      }

      if (!response.body) {
        throw new ModelProviderError({
          provider: this.id,
          code: 'malformed_response',
          message: 'OpenRouter streaming response did not include a readable body.'
        });
      }

      let content = '';
      let reasoning = '';
      let usage: ModelUsage | undefined;
      let providerTerminationReason: string | undefined;
      let responseId: string | undefined;
      let actualModel = request.model || this.defaultModel;
      let lastRaw: OpenRouterChatResponse | undefined;
      const toolCallParts = new Map<number, StreamingToolCallAccumulator>();
      const toolCalls: ModelToolCall[] = [];

      for await (const event of readSseEvents(response.body)) {
        if (event.type === 'comment') {
          yield { type: 'status', message: `OpenRouter stream status: ${event.comment}`, raw: event };
          continue;
        }
        if (event.data === '[DONE]') {
          break;
        }
        const part = event.data;
        throwIfOpenRouterError(this.id, part, content.length > 0);
        lastRaw = part;
        responseId = part.id ?? responseId;
        actualModel = part.model ?? actualModel;
        usage = normalizeUsage(part.usage) ?? usage;

        const choice = part.choices?.[0];
        const delta = choice?.delta ?? choice?.message;
        if (choice?.finish_reason) {
          providerTerminationReason = choice.finish_reason;
        }

        const contentDelta = contentFromWire(delta?.content);
        if (contentDelta.length > 0) {
          content += contentDelta;
          yield { type: 'content', content: contentDelta, accumulated: content, raw: part };
        }

        const reasoningDelta = reasoningFromWire(delta);
        if (reasoningDelta.length > 0) {
          reasoning += reasoningDelta;
          yield { type: 'reasoning', reasoning: reasoningDelta, accumulatedReasoning: reasoning, raw: part };
        }

        for (const toolCall of mergeStreamingToolCalls(toolCallParts, delta?.tool_calls ?? [])) {
          const key = JSON.stringify(toolCall);
          if (!toolCalls.some((existing) => JSON.stringify(existing) === key)) {
            toolCalls.push(toolCall);
            yield { type: 'tool_call', toolCall, raw: part };
          }
        }
      }

      const finalToolCalls = Array.from(toolCallParts.values()).map((item) => accumulatorToToolCall(this.id, item));
      const responseToolCalls = dedupeToolCalls([...toolCalls, ...finalToolCalls]);
      const responsePayload: ModelResponse = {
        content,
        model: actualModel,
        provider: this.id,
        terminationReason: normalizeOpenRouterTermination(this.id, providerTerminationReason, responseToolCalls.length > 0),
        ...(providerTerminationReason ? { providerTerminationReason: providerTerminationReason } : {}),
        raw: lastRaw
      };
      if (responseId) responsePayload.requestId = responseId;
      if (usage) responsePayload.usage = usage;
      if (reasoning) responsePayload.reasoning = reasoning;
      if (responseToolCalls.length > 0) responsePayload.toolCalls = responseToolCalls;
      yield { type: 'done', response: parseOpenRouterModelResponse(responsePayload) };
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  private async modelCatalog(): Promise<OpenRouterModelRecord[]> {
    if (Date.now() >= this.modelCatalogExpiresAt) {
      this.modelCatalogPromise = undefined;
    }
    this.modelCatalogPromise ??= this.fetchModelCatalog()
      .then((records) => {
        this.modelCatalogExpiresAt = Date.now() + this.catalogTtlMs;
        return records;
      })
      .catch((error: unknown) => {
        this.modelCatalogPromise = undefined;
        this.modelCatalogExpiresAt = 0;
        throw error;
      });
    return this.modelCatalogPromise;
  }

  refreshModelCatalog(): Promise<void> {
    this.modelCatalogPromise = undefined;
    this.modelCatalogExpiresAt = 0;
    return this.modelCatalog().then(() => undefined);
  }

  private async validateRequest(request: ModelRequest): Promise<ModelRequest> {
    const owned = parseModelRequest(request);
    throwIfAborted(owned.signal);
    if (!this.apiKey?.trim()) {
      throw new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: 'OpenRouter API key is required. Set OPENROUTER_API_KEY or pass apiKey.'
      });
    }
    assertModelRequestSupported(await this.describeModel(owned.model), owned);
    return owned;
  }

  private async fetchModelCatalog(): Promise<OpenRouterModelRecord[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(false)
      });
      await throwIfBadResponse(this.id, response);
      const payload = await parseJsonResponse<OpenRouterModelCatalog>(this.id, response);
      if (!Array.isArray(payload.data)) {
        throw new ModelProviderError({
          provider: this.id,
          code: 'malformed_response',
          message: 'OpenRouter models response did not include a data array.'
        });
      }
      return payload.data;
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  private async fetchChatCompletion(request: ModelRequest, stream: boolean): Promise<Response> {
    const apiKey = this.apiKey?.trim();
    if (!apiKey) {
      throw new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: 'OpenRouter API key is required. Set OPENROUTER_API_KEY or pass apiKey.'
      });
    }
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(toOpenRouterChatRequest(request, stream))
      };
      if (request.signal) {
        init.signal = request.signal;
      }
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, init);
      await throwIfBadResponse(this.id, response);
      return response;
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  private headers(includeJson: boolean): HeadersInit {
    const headers: Record<string, string> = {};
    const apiKey = this.apiKey?.trim();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (includeJson) {
      headers['Content-Type'] = CONTENT_TYPE_JSON;
    }
    if (this.appUrl) {
      headers['HTTP-Referer'] = this.appUrl;
    }
    if (this.appTitle) {
      headers['X-OpenRouter-Title'] = this.appTitle;
    }
    return headers;
  }
}

function toOpenRouterChatRequest(request: ModelRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toOpenRouterMessage),
    stream
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  if (request.responseFormat) body.response_format = toOpenRouterResponseFormat(request.responseFormat);
  if (request.tools && request.tools.length > 0) body.tools = request.tools.map(toOpenRouterTool);
  if (request.reasoning) body.reasoning = toOpenRouterReasoning(request.reasoning);
  if (request.logprobs !== undefined) body.logprobs = request.logprobs;
  if (request.topLogprobs !== undefined) body.top_logprobs = request.topLogprobs;
  if (request.metadata && Object.keys(request.metadata).length > 0) body.metadata = request.metadata;
  applyOpenRouterProviderOptions(body, request);
  return body;
}

function toOpenRouterMessage(message: ModelMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    role: message.role
  };
  if (message.name) body.name = message.name;
  if (message.reasoning) body.reasoning = message.reasoning;
  if (message.toolCalls && message.toolCalls.length > 0) body.tool_calls = message.toolCalls.map(toOpenRouterToolCall);
  if (message.toolCallId) body.tool_call_id = message.toolCallId;
  if (message.toolName) body.name = message.toolName;
  body.content = contentForOpenRouterMessage(message);
  return body;
}

function contentForOpenRouterMessage(message: ModelMessage): unknown {
  if (message.images && message.images.length > 0) {
    return toOpenRouterContentParts(message.content, message.images);
  }
  if (message.role === 'assistant' && message.content.length === 0 && message.toolCalls && message.toolCalls.length > 0) {
    return null;
  }
  return message.content;
}

function toOpenRouterContentParts(content: string, images: ModelImage[]): Record<string, unknown>[] {
  return [
    ...(content.length > 0 ? [{ type: 'text', text: content }] : []),
    ...images.map((image) => ({
      type: 'image_url',
      image_url: {
        url: `data:${image.mediaType};base64,${imageToBase64(image)}`,
        ...(image.detail ? { detail: image.detail } : {})
      }
    }))
  ];
}

function imageToBase64(image: ModelImage): string {
  return image.type === 'base64' ? image.data : Buffer.from(image.data).toString('base64');
}

function toOpenRouterTool(tool: ModelTool): Record<string, unknown> {
  if (tool.type !== 'function') {
    throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: `OpenRouter provider only supports JSON function tools: ${tool.name}` });
  }
  const body: Record<string, unknown> = {
    type: tool.type,
    function: {
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      ...(tool.function.parameters ? { parameters: tool.function.parameters } : {})
    }
  };
  return body;
}

function toOpenRouterToolCall(toolCall: ModelToolCall): Record<string, unknown> {
  if (toolCall.input.kind !== 'json') {
    throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: `OpenRouter provider only supports JSON function tool calls: ${toolCall.name}` });
  }
  return {
    ...(toolCall.id ? { id: toolCall.id } : {}),
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input.value)
    }
  };
}

function toOpenRouterResponseFormat(format: ModelResponseFormat): unknown {
  if (format === 'text') {
    return undefined;
  }
  if (format === 'json') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'agent_core_response',
      strict: true,
      schema: format.schema
    }
  };
}

function toOpenRouterReasoning(reasoning: ModelReasoningRequest): Record<string, unknown> | undefined {
  if ('summary' in reasoning) throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: 'OpenRouter does not expose a route-neutral reasoning summary control.' });
  if (reasoning.strategy === 'disabled') return { enabled: false };
  if (reasoning.strategy === 'enabled') return { enabled: true };
  if (reasoning.strategy === 'budget') return { max_tokens: reasoning.maxTokens };
  if (reasoning.mode !== undefined) throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: 'OpenRouter does not expose OpenAI standard/pro reasoning mode as a route-neutral control.' });
  return { effort: reasoning.effort };
}

function applyOpenRouterProviderOptions(body: Record<string, unknown>, request: ModelRequest): void {
  if (!request.providerOptions) return;
  if (request.providerOptions.provider !== OPENROUTER_PROVIDER_ID) throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: `Request options for ${request.providerOptions.provider} cannot be used with OpenRouter.` });
  const values = request.providerOptions.values;
  const allowed = new Set(['provider', 'transforms', 'reasoningOutput']);
  const unknown = Object.keys(values).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: `Unsupported OpenRouter provider option(s): ${unknown.join(', ')}.` });
  if (values.provider !== undefined && !isJsonObject(values.provider)) throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: 'OpenRouter provider routing options must be a JSON object.' });
  if (values.transforms !== undefined && (!Array.isArray(values.transforms) || !values.transforms.every((item) => typeof item === 'string'))) throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: 'OpenRouter transforms must be an array of strings.' });
  if (values.reasoningOutput !== undefined && values.reasoningOutput !== 'include' && values.reasoningOutput !== 'omit') throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'invalid_request', message: 'OpenRouter reasoningOutput must be include or omit.' });
  if (values.provider !== undefined) body.provider = values.provider;
  if (values.transforms !== undefined) body.transforms = values.transforms;
  if (values.reasoningOutput !== undefined) {
    const reasoning = isJsonObject(body.reasoning) ? body.reasoning : {};
    body.reasoning = { ...reasoning, exclude: values.reasoningOutput === 'omit' };
  }
}

function toModelResponse(provider: string, request: ModelRequest, payload: OpenRouterChatResponse): ModelResponse {
  throwIfOpenRouterError(provider, payload, false);
  const choice = payload.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenRouter response did not include choices[0].message.' });
  }
  const content = contentFromWire(message.content);
  const toolCalls = normalizeToolCalls(provider, message.tool_calls ?? []);
  const response: ModelResponse = {
    content,
    model: payload.model ?? request.model,
    provider,
    terminationReason: normalizeOpenRouterTermination(
      provider,
      choice.finish_reason,
      toolCalls.length > 0
    ),
    ...(choice.finish_reason ? { providerTerminationReason: choice.finish_reason } : {}),
    raw: payload
  };
  if (payload.id) response.requestId = payload.id;
  const usage = normalizeUsage(payload.usage);
  if (usage) response.usage = usage;
  const reasoning = reasoningFromWire(message);
  if (reasoning) response.reasoning = reasoning;
  if (toolCalls.length > 0) response.toolCalls = toolCalls;
  return parseOpenRouterModelResponse(response);
}

function normalizeOpenRouterTermination(
  provider: string,
  reason: string | null | undefined,
  hasToolCalls: boolean
): ModelResponse['terminationReason'] {
  if (reason === 'error') {
    throw new ModelProviderError({
      provider,
      code: 'provider_unavailable',
      message: 'OpenRouter reported an error finish reason.'
    });
  }
  if (hasToolCalls) {
    return 'tool_calls';
  }
  if (reason === 'tool_calls' || reason === 'function_call') {
    return 'tool_calls';
  }
  if (reason === 'stop') {
    return 'stop';
  }
  if (reason === 'length') {
    return 'output_limit';
  }
  if (reason === 'content_filter') {
    return 'content_filter';
  }
  return 'unknown';
}

function contentFromWire(content: OpenRouterResponseMessage['content'] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!content) {
    return '';
  }
  return content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

function reasoningFromWire(message: OpenRouterResponseMessage | undefined): string {
  if (!message) {
    return '';
  }
  if (typeof message.reasoning === 'string') {
    return message.reasoning;
  }
  if (message.reasoning_details !== undefined) {
    return JSON.stringify(message.reasoning_details);
  }
  return '';
}

function normalizeToolCalls(provider: string, toolCalls: OpenRouterWireToolCall[]): ModelToolCall[] {
  return toolCalls.map((toolCall) => wireToolCallToModelToolCall(provider, toolCall));
}

function wireToolCallToModelToolCall(provider: string, toolCall: OpenRouterWireToolCall): ModelToolCall {
  const name = toolCall.function?.name;
  if (!name) {
    throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenRouter tool call did not include function.name.' });
  }
  return {
    ...(toolCall.id ? { id: toolCall.id } : {}),
    type: 'function',
    name,
    input: { kind: 'json', value: parseToolArguments(provider, toolCall.function?.arguments) }
  };
}

function parseToolArguments(provider: string, value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined || value === '') {
    return {};
  }
  if (typeof value !== 'string') {
    return value;
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
      message: `OpenRouter tool call arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      cause: error
    });
  }
  throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenRouter tool call arguments must decode to a JSON object.' });
}

function mergeStreamingToolCalls(accumulators: Map<number, StreamingToolCallAccumulator>, deltas: OpenRouterWireToolCall[]): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const existing = accumulators.get(index) ?? { argumentsText: '' };
    if (delta.id) existing.id = delta.id;
    if (delta.type === 'function') existing.type = 'function';
    if (delta.function?.name) existing.name = delta.function.name;
    if (typeof delta.function?.arguments === 'string') {
      existing.argumentsText += delta.function.arguments;
    } else if (delta.function?.arguments && typeof delta.function.arguments === 'object') {
      existing.argumentsText += JSON.stringify(delta.function.arguments);
    }
    accumulators.set(index, existing);
    const maybeToolCall = tryAccumulatorToToolCall(existing);
    if (maybeToolCall) {
      const key = JSON.stringify(maybeToolCall);
      if (existing.emittedKey !== key) {
        existing.emittedKey = key;
        toolCalls.push(maybeToolCall);
      }
    }
  }
  return toolCalls;
}

function tryAccumulatorToToolCall(item: StreamingToolCallAccumulator): ModelToolCall | undefined {
  if (!item.name || item.argumentsText.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = item.argumentsText.length > 0 ? JSON.parse(item.argumentsText) : {};
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    return {
      ...(item.id ? { id: item.id } : {}),
      type: 'function',
      name: item.name,
      input: { kind: 'json', value: parsed }
    };
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accumulatorToToolCall(provider: string, item: StreamingToolCallAccumulator): ModelToolCall {
  if (!item.name) {
    throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenRouter streamed tool call did not include function.name.' });
  }
  return {
    ...(item.id ? { id: item.id } : {}),
    type: 'function',
    name: item.name,
    input: { kind: 'json', value: parseToolArguments(provider, item.argumentsText) }
  };
}

function dedupeToolCalls(toolCalls: ModelToolCall[]): ModelToolCall[] {
  const seen = new Set<string>();
  const result: ModelToolCall[] = [];
  for (const toolCall of toolCalls) {
    const key = JSON.stringify(toolCall);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(toolCall);
    }
  }
  return result;
}

function canonicalOpenRouterParameters(parameters: string[]): ModelProfile['supportedParameters'] {
  const supported = new Set<ModelProfile['supportedParameters'][number]>(['providerOptions']);
  const mappings: Record<string, ModelProfile['supportedParameters'][number]> = {
    temperature: 'temperature',
    top_p: 'topP',
    max_tokens: 'maxOutputTokens',
    max_completion_tokens: 'maxOutputTokens',
    response_format: 'responseFormat',
    structured_outputs: 'responseFormat',
    tools: 'tools',
    tool_choice: 'tools',
    reasoning: 'reasoning',
    include_reasoning: 'reasoning',
    logprobs: 'logprobs',
    top_logprobs: 'topLogprobs',
    metadata: 'metadata'
  };
  for (const parameter of parameters) {
    const canonical = mappings[parameter];
    if (canonical) supported.add(canonical);
  }
  return [...supported];
}

function throwIfOpenRouterError(provider: string, payload: OpenRouterChatResponse, afterVisibleContent: boolean): void {
  if (!payload.error) return;
  const message = payload.error.message ?? 'OpenRouter returned an error payload.';
  const code = typeof payload.error.code === 'number' ? payload.error.code : Number(payload.error.code);
  throw new ModelProviderError({
    provider,
    code: Number.isFinite(code) ? classifyStatus(code, message) : 'provider_unavailable',
    message: `OpenRouter response error: ${message}`,
    retryable: !afterVisibleContent && (code === 429 || code >= 500),
    cause: payload,
    diagnostic: {
      transport: 'http_sse',
      eventType: 'error',
      causeSummary: {
        ...(Number.isFinite(code) ? { status: code } : {}),
        errorMessage: message,
        partialContent: afterVisibleContent
      }
    }
  });
}

function modelRecordToProfile(record: OpenRouterModelRecord): ModelProfile {
  const wireParameters = record.supported_parameters ?? [];
  const supported = new Set(wireParameters);
  const supportedParameters = canonicalOpenRouterParameters(wireParameters);
  const hasReasoning = record.reasoning !== undefined || supported.has('reasoning');
  const reasoningEfforts = openRouterReasoningEfforts(record.reasoning);
  const contextTokens = numberOrUndefined(record.top_provider?.context_length) ?? numberOrUndefined(record.context_length);
  const outputTokens = numberOrUndefined(record.top_provider?.max_completion_tokens);
  const pricing = normalizePricing(record.pricing);
  const capabilities: ModelCapabilities = {
    streaming: true,
    toolCalling: supported.has('tools'),
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: supported.has('response_format'),
    jsonSchema: supported.has('structured_outputs'),
    logprobs: supported.has('logprobs') || supported.has('top_logprobs'),
    temperature: supported.has('temperature'),
    topP: supported.has('top_p'),
    ...(hasReasoning
      ? { reasoning: {
        strategies: ['toggle', ...(reasoningEfforts.length > 0 ? ['effort' as const] : []), ...(record.reasoning?.supports_max_tokens === true ? ['budget' as const] : [])],
        canDisable: record.reasoning?.mandatory !== true,
        ...(reasoningEfforts.length > 0 ? { efforts: reasoningEfforts } : {}),
        separateOutput: supported.has('include_reasoning')
      } }
      : {})
  };
  return {
    id: requiredString(record.id, 'OpenRouter model record missing id.'),
    provider: OPENROUTER_PROVIDER_ID,
    ...(record.name ? { displayName: record.name } : {}),
    capabilities,
    modalities: {
      input: normalizeModalities(record.architecture?.input_modalities, ['text']),
      output: normalizeModalities(record.architecture?.output_modalities, ['text'])
    },
    limits: {
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(contextTokens !== undefined && outputTokens !== undefined ? { maxInputTokens: Math.max(1, contextTokens - outputTokens) } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {})
    },
    supportedParameters,
    ...(pricing ? { pricing } : {}),
    metadata: modelMetadata(record)
  };
}

function openRouterReasoningEfforts(reasoning: OpenRouterModelRecord['reasoning']): ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[] {
  const values = reasoning?.supported_efforts;
  if (values === null) return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (!Array.isArray(values)) return [];
  const supported = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  return values.filter((value): value is 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' => typeof value === 'string' && supported.has(value));
}

function modelMetadata(record: OpenRouterModelRecord): Record<string, unknown> {
  return {
    ...(record.description ? { description: record.description } : {}),
    ...(record.architecture ? { architecture: record.architecture } : {}),
    ...(record.top_provider ? { topProvider: record.top_provider } : {}),
    ...(record.reasoning ? { reasoning: record.reasoning } : {}),
    wireSupportedParameters: record.supported_parameters ?? []
  };
}

function normalizeModalities(value: string[] | undefined, fallback: ModelModality[]): ModelModality[] {
  return value && value.length > 0 ? value : fallback;
}

function normalizePricing(pricing: OpenRouterModelRecord['pricing']): ModelPricing | undefined {
  if (!pricing) {
    return undefined;
  }
  const rates: ModelPricing['rates'] = {};
  const input = pricePerMillion(pricing.prompt);
  const output = pricePerMillion(pricing.completion);
  const cacheRead = pricePerMillion(pricing.input_cache_read);
  const cacheWrite = pricePerMillion(pricing.input_cache_write);
  if (input !== undefined) rates.input = input;
  if (output !== undefined) rates.output = output;
  if (cacheRead !== undefined) rates.cacheRead = cacheRead;
  if (cacheWrite !== undefined) rates.cacheWrite = cacheWrite;
  const metadata = Object.fromEntries(Object.entries(pricing).filter(([key]) => !['prompt', 'completion', 'input_cache_read', 'input_cache_write'].includes(key)));
  return Object.keys(rates).length > 0 || Object.keys(metadata).length > 0 ? { currency: 'USD', rates, ...(Object.keys(metadata).length > 0 ? { metadata } : {}) } : undefined;
}

function pricePerMillion(value: string | number | null | undefined): number | undefined {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return undefined;
  }
  return numberValue * 1_000_000;
}

function normalizeUsage(usage: OpenRouterUsage | undefined): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(usage.prompt_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.prompt_tokens_details.cached_tokens }),
    ...(usage.prompt_tokens_details?.cache_write_tokens === undefined ? {} : { cacheWriteTokens: usage.prompt_tokens_details.cache_write_tokens }),
    ...(usage.completion_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens })
  };
}

function waitForOpenRouterResponse<T>(response: Promise<T>, intervalMs: number, signal: AbortSignal | undefined): Promise<{ type: 'response'; response: T } | { type: 'status' }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { type: 'response'; response: T } | { type: 'status' }) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(result); };
    const fail = (error: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error instanceof Error ? error : new Error(String(error))); };
    const onAbort = () => { fail(abortError()); };
    const timer = setTimeout(() => { finish({ type: 'status' }); }, intervalMs);
    response.then((value) => { finish({ type: 'response', response: value }); }, fail);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('OpenRouter request aborted.');
  error.name = 'AbortError';
  return error;
}

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<OpenRouterSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      assertOpenRouterSseBuffer(buffer);
      yield* drainSseBuffer(buffer, (next) => {
        buffer = next;
      });
    }
    buffer += decoder.decode();
    assertOpenRouterSseBuffer(buffer);
    yield* drainSseBuffer(`${buffer}\n\n`, (next) => {
      buffer = next;
    });
  } finally {
    reader.releaseLock();
  }
}

function assertOpenRouterSseBuffer(buffer: string): void {
  if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_BUFFER_BYTES) throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'malformed_response', message: `OpenRouter SSE event exceeded the ${String(MAX_SSE_BUFFER_BYTES)} byte buffer limit.` });
}

function* drainSseBuffer(buffer: string, setBuffer: (value: string) => void): Iterable<OpenRouterSseEvent> {
  for (;;) {
    const boundary = /\r?\n\r?\n/.exec(buffer);
    if (!boundary) {
      setBuffer(buffer);
      return;
    }
    const rawEvent = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary[0].length);
    const lines = rawEvent
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const comment of lines.filter((line) => line.startsWith(':')).map((line) => line.slice(1).trim()).filter((line) => line.length > 0)) {
      yield { type: 'comment', comment };
    }
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data.length === 0) {
      continue;
    }
    if (data === '[DONE]') {
      yield { type: 'data', data: '[DONE]' };
      continue;
    }
    try {
      yield { type: 'data', data: JSON.parse(data) as OpenRouterChatResponse };
    } catch (error) {
      throw new ModelProviderError({
        provider: OPENROUTER_PROVIDER_ID,
        code: 'malformed_response',
        message: `OpenRouter stream event was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        cause: error
      });
    }
  }
}

async function parseJsonResponse<T>(provider: string, response: Response): Promise<T> {
  try {
    const result = await readBoundedText(response, MAX_JSON_BODY_BYTES);
    if (result.truncated) throw new Error(`JSON response exceeded the ${String(MAX_JSON_BODY_BYTES)} byte limit.`);
    return JSON.parse(result.text) as T;
  } catch (error) {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `OpenRouter response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      cause: error
    });
  }
}

async function throwIfBadResponse(provider: string, response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const { text: body, truncated } = await readBoundedText(response, MAX_DIAGNOSTIC_BODY_BYTES);
  const retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'));
  const extractedMessage = extractErrorMessage(body);
  throw new ModelProviderError({
    provider,
    code: classifyStatus(response.status, body),
    message: `OpenRouter request failed with HTTP ${String(response.status)}: ${extractedMessage}`,
    retryable: response.status === 429 || response.status >= 500,
    diagnostic: {
      transport: 'http',
      causeSummary: {
        status: response.status,
        errorMessage: extractedMessage,
        ...(truncated ? { bodyTruncated: true } : {}),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      }
    }
  });
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        bytes = maximumBytes;
        truncated = true;
        await reader.cancel('response body exceeded configured bound');
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(joined), truncated };
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function normalizeError(provider: string, error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  if (error instanceof ModelContractError) {
    return new ModelProviderError({ provider, code: 'invalid_request', message: error.message, retryable: false, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isAbortError(error) || /abort/i.test(message)) {
    return new ModelProviderError({ provider, code: 'aborted', message: `OpenRouter request aborted: ${message}`, cause: error });
  }
  return new ModelProviderError({
    provider,
    code: 'provider_unavailable',
    message: `OpenRouter request failed: ${message}`,
    retryable: true,
    cause: error
  });
}

function parseOpenRouterModelResponse(value: unknown): ModelResponse {
  try {
    return parseModelResponse(value);
  } catch (error) {
    if (error instanceof ModelContractError) {
      throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'malformed_response', message: `OpenRouter response violated the model contract: ${error.message}`, cause: error });
    }
    throw error;
  }
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
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? body;
  } catch {
    return body;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw new ModelProviderError({
    provider: OPENROUTER_PROVIDER_ID,
    code: 'aborted',
    message: typeof signal.reason === 'string' ? signal.reason : 'OpenRouter request aborted.',
    cause: signal.reason
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'malformed_response', message });
  }
  return value;
}

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
