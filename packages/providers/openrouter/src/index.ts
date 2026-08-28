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
import { normalizeJsonSafe, parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  readBoundedJsonResponse,
  readBoundedResponseText,
  readJsonSseEvents,
  waitForResponseOrStatus,
  type JsonSseEvent
} from '@agent-core/provider-openai-responses';
import {
  decodeOpenRouterChatResponse,
  decodeOpenRouterModelCatalog,
  type OpenRouterChatResponse,
  type OpenRouterModelRecord,
  type OpenRouterResponseMessage,
  type OpenRouterUsage,
  type OpenRouterWireToolCall
} from './wire.js';

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  appUrl?: string;
  appTitle?: string;
  fetch?: typeof fetch;
  statusIntervalMs?: number;
  streamIdleTimeoutMs?: number;
  catalogTtlMs?: number;
}

interface StreamingToolCallAccumulator {
  id?: string;
  type?: 'function';
  name?: string;
  argumentsText: string;
  emittedKey?: string;
}

type OpenRouterSseEvent = JsonSseEvent<OpenRouterChatResponse>;

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';
const OPENROUTER_PROVIDER_ID = 'openrouter';
const CONTENT_TYPE_JSON = 'application/json';

export class OpenRouterProvider implements ModelProvider {
  readonly id = OPENROUTER_PROVIDER_ID;
  readonly implementationId = 'agent-core.provider.openrouter@1';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly appUrl: string | undefined;
  private readonly appTitle: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly statusIntervalMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly catalogTtlMs: number;
  private modelCatalogPromise: Promise<readonly OpenRouterModelRecord[]> | undefined;
  private modelCatalogExpiresAt = 0;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? OPENROUTER_BASE_URL);
    this.defaultModel = options.model ?? OPENROUTER_DEFAULT_MODEL;
    this.appUrl = options.appUrl ?? process.env.OPENROUTER_APP_URL;
    this.appTitle = options.appTitle ?? process.env.OPENROUTER_APP_TITLE;
    this.fetchImpl = options.fetch ?? fetch;
    this.statusIntervalMs = Math.max(1, options.statusIntervalMs ?? 15_000);
    this.streamIdleTimeoutMs = Math.max(1, options.streamIdleTimeoutMs ?? 120_000);
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
      const payload = await decodeJsonResponse(this.id, response, decodeOpenRouterChatResponse, 'OpenRouter chat response');
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
        const result = await waitForResponseOrStatus(responsePromise, this.statusIntervalMs, request.signal);
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

      for await (const event of readSseEvents(response.body, request.signal, this.statusIntervalMs, this.streamIdleTimeoutMs)) {
        if (event.type === 'comment') {
          yield { type: 'status', message: `OpenRouter stream status: ${event.comment}`, raw: event };
          continue;
        }
        if (event.type === 'status') {
          yield { type: 'status', message: `Waiting for OpenRouter stream data (${String(Math.max(1, Math.round(event.idleMs / 1_000)))}s).` };
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
          yield { type: 'content', content: contentDelta, accumulated: content, raw: normalizeJsonSafe(part).value };
        }

        const reasoningDelta = reasoningFromWire(delta);
        if (reasoningDelta.length > 0) {
          reasoning += reasoningDelta;
          yield { type: 'reasoning', reasoning: reasoningDelta, accumulatedReasoning: reasoning, raw: normalizeJsonSafe(part).value };
        }

        for (const toolCall of mergeStreamingToolCalls(toolCallParts, delta?.tool_calls ?? [])) {
          const key = JSON.stringify(toolCall);
          if (!toolCalls.some((existing) => JSON.stringify(existing) === key)) {
            toolCalls.push(toolCall);
            yield { type: 'tool_call', toolCall, raw: normalizeJsonSafe(part).value };
          }
        }
      }

      const finalToolCalls = Array.from(toolCallParts.values()).map((item) => accumulatorToToolCall(this.id, item));
      const responseToolCalls = dedupeToolCalls([...toolCalls, ...finalToolCalls]);
      yield { type: 'done', response: parseOpenRouterModelResponse({
        content,
        model: actualModel,
        provider: this.id,
        terminationReason: normalizeOpenRouterTermination(this.id, providerTerminationReason, responseToolCalls.length > 0),
        ...(providerTerminationReason ? { providerTerminationReason: providerTerminationReason } : {}),
        ...(responseId ? { requestId: responseId } : {}),
        ...(usage ? { usage } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(responseToolCalls.length > 0 ? { toolCalls: responseToolCalls } : {}),
        ...(lastRaw === undefined ? {} : { raw: normalizeJsonSafe(lastRaw).value })
      }) };
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  private async modelCatalog(): Promise<readonly OpenRouterModelRecord[]> {
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

  private async fetchModelCatalog(): Promise<readonly OpenRouterModelRecord[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(false)
      });
      await throwIfBadResponse(this.id, response);
      const payload = await decodeJsonResponse(this.id, response, decodeOpenRouterModelCatalog, 'OpenRouter model catalog');
      if (payload.data === undefined) {
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

function toOpenRouterContentParts(content: string, images: readonly ModelImage[]): Record<string, unknown>[] {
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
  const usage = normalizeUsage(payload.usage);
  const reasoning = reasoningFromWire(message);
  return parseOpenRouterModelResponse({
    content,
    model: payload.model ?? request.model,
    provider,
    terminationReason: normalizeOpenRouterTermination(
      provider,
      choice.finish_reason,
      toolCalls.length > 0
    ),
    ...(choice.finish_reason ? { providerTerminationReason: choice.finish_reason } : {}),
    ...(payload.id ? { requestId: payload.id } : {}),
    ...(usage ? { usage } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw: normalizeJsonSafe(payload).value
  });
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

function normalizeToolCalls(provider: string, toolCalls: readonly OpenRouterWireToolCall[]): ModelToolCall[] {
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
    input: { kind: 'json', value: parseToolArguments(provider, toolCall.function.arguments) }
  };
}

function parseToolArguments(provider: string, value: string | Readonly<Record<string, unknown>> | undefined): JsonObject {
  if (value === undefined || value === '') {
    return Object.freeze({});
  }
  if (typeof value !== 'string') {
    return parseJsonObject(value);
  }
  try {
    return parseJsonObject(JSON.parse(value));
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

function mergeStreamingToolCalls(accumulators: Map<number, StreamingToolCallAccumulator>, deltas: readonly OpenRouterWireToolCall[]): ModelToolCall[] {
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
      input: { kind: 'json', value: parseJsonObject(parsed) }
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

function canonicalOpenRouterParameters(parameters: readonly string[]): ModelProfile['supportedParameters'] {
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
    metadata: parseJsonObject(modelMetadata(record))
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

function normalizeModalities(value: readonly string[] | undefined, fallback: ModelModality[]): ModelModality[] {
  return value && value.length > 0 ? [...value] : fallback;
}

function normalizePricing(pricing: OpenRouterModelRecord['pricing']): ModelPricing | undefined {
  if (!pricing) {
    return undefined;
  }
  const rates: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
  const input = pricePerMillion(pricing.prompt);
  const output = pricePerMillion(pricing.completion);
  const cacheRead = pricePerMillion(pricing.input_cache_read);
  const cacheWrite = pricePerMillion(pricing.input_cache_write);
  if (input !== undefined) rates.input = input;
  if (output !== undefined) rates.output = output;
  if (cacheRead !== undefined) rates.cacheRead = cacheRead;
  if (cacheWrite !== undefined) rates.cacheWrite = cacheWrite;
  const metadata = Object.fromEntries(Object.entries(pricing).filter(([key]) => !['prompt', 'completion', 'input_cache_read', 'input_cache_write'].includes(key)));
  return Object.keys(rates).length > 0 || Object.keys(metadata).length > 0 ? { currency: 'USD', rates, ...(Object.keys(metadata).length > 0 ? { metadata: parseJsonObject(metadata) } : {}) } : undefined;
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

function readSseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, statusIntervalMs: number, idleTimeoutMs: number): AsyncIterable<OpenRouterSseEvent> {
  return readJsonSseEvents(body, {
    ...(signal ? { signal } : {}),
    statusIntervalMs,
    idleTimeoutMs,
    decodeData: decodeOpenRouterChatResponse,
    createMalformedError: (message, cause) => new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'malformed_response', message: `OpenRouter ${message}`, cause }),
    createIdleError: (idleMs) => new ModelProviderError({ provider: OPENROUTER_PROVIDER_ID, code: 'provider_unavailable', message: `OpenRouter stream was idle for ${String(idleMs)}ms.`, retryable: true, diagnostic: { transport: 'http_sse', causeSummary: { idleMs } } })
  });
}

async function decodeJsonResponse<T>(provider: string, response: Response, decode: (value: unknown) => T, label: string): Promise<T> {
  try {
    return decode(await readBoundedJsonResponse(response));
  } catch (error) {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `${label} was malformed: ${error instanceof Error ? error.message : String(error)}`,
      cause: error
    });
  }
}

async function throwIfBadResponse(provider: string, response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const { text: body, truncated } = await readBoundedResponseText(response);
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
    const parsed: unknown = JSON.parse(body);
    if (!isJsonObject(parsed)) return body;
    const error = isJsonObject(parsed.error) ? parsed.error : undefined;
    return typeof error?.message === 'string' ? error.message : typeof parsed.message === 'string' ? parsed.message : body;
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
