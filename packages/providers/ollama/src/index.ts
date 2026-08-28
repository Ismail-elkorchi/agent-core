import { type ChatRequest, type Message, Ollama, type Tool } from 'ollama';
import { parseJsonObject } from '@agent-core/json';
import {
  type ModelCapabilities,
  ModelContractError,
  type ModelMessage,
  type ModelProfile,
  type ModelProvider,
  ModelProviderError,
  type ModelProviderErrorCode,
  type ModelProviderInfo,
  type ModelRequest,
  type ModelResponse,
  type ModelResponseFormat,
  type ModelImage,
  type ModelReasoningRequest,
  type ModelStreamEvent,
  type ModelTool,
  type ModelToolCall,
  type ModelUsage,
  assertModelRequestSupported,
  parseModelProfile,
  parseModelRequest,
  parseModelResponse
} from '@agent-core/model';
import {
  decodeOllamaShowResponse,
  decodeOllamaWireResponse,
  type OllamaShowResponse,
  type OllamaWireResponse,
  type OllamaWireToolCall
} from './wire.js';

export type { OllamaShowResponse } from './wire.js';

export interface OllamaClient {
  chat(request: ChatRequest & { stream: true }): Promise<AsyncIterable<unknown>>;
  show?(request: { model: string; verbose?: boolean }): Promise<unknown>;
  abort?(): void;
}

export interface OllamaGenerationOptions {
  num_ctx?: number;
  num_predict?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  repeat_penalty?: number;
  repeat_last_n?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  num_gpu?: number;
  num_thread?: number;
}

export interface OllamaProviderOptions {
  host?: string;
  model?: string;
  fetch?: typeof fetch;
  clientFactory?: () => OllamaClient;
  keepAlive?: string | number;
  reasoning?: ModelReasoningRequest;
  generationOptions?: OllamaGenerationOptions;
  modelProfiles?: Record<string, OllamaModelProfileOverride>;
  /** Selects documented feature availability; Ollama Cloud currently lacks structured outputs. */
  deployment?: 'local' | 'cloud';
}

export type OllamaModelProfileOverride = Omit<ModelProfile, 'id' | 'provider'>;

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly implementationId = 'agent-core.provider.ollama@1';
  private readonly clientFactory: () => OllamaClient;
  private readonly defaultModel: string;
  private readonly keepAlive: string | number | undefined;
  private readonly reasoning: ModelReasoningRequest | undefined;
  private readonly generationOptions: OllamaGenerationOptions;
  private readonly modelProfiles: Record<string, OllamaModelProfileOverride>;
  private readonly deployment: 'local' | 'cloud';
  private readonly discoveredProfiles = new Map<string, Promise<ModelProfile>>();

  constructor(options: OllamaProviderOptions = {}) {
    this.defaultModel = options.model ?? 'llama3.1';
    const fetch = options.fetch ?? globalThis.fetch;
    const config = { ...(options.host ? { host: options.host } : {}), fetch };
    this.clientFactory = options.clientFactory ?? (() => {
      const client = new Ollama(config);
      return {
        chat: (request) => client.chat(request),
        show: async (request) => {
          const response = await client.show(request);
          const modelInfo = toRecord(response.model_info);
          return {
            ...(response.parameters ? { parameters: response.parameters } : {}),
            capabilities: response.capabilities,
            ...(modelInfo ? { model_info: modelInfo } : {}),
            details: toRecord(response.details) ?? {},
            modified_at: response.modified_at instanceof Date ? response.modified_at.toISOString() : String(response.modified_at)
          };
        },
        abort: () => {
          client.abort();
        }
      };
    });
    this.keepAlive = options.keepAlive;
    this.reasoning = options.reasoning;
    this.generationOptions = validateGenerationOptions({ ...(options.generationOptions ?? {}) });
    this.modelProfiles = options.modelProfiles ?? {};
    this.deployment = options.deployment ?? 'local';
  }

  describe(): ModelProviderInfo {
    return {
      id: this.id,
      displayName: `Ollama ${this.deployment} model provider`,
      defaultModel: this.defaultModel
    };
  }

  describeModel(model: string): Promise<ModelProfile> {
    const selectedModel = model || this.defaultModel;
    const override = this.modelProfiles[selectedModel];
    if (override) return Promise.resolve(parseModelProfile({ id: selectedModel, provider: this.id, ...override }));
    let profile = this.discoveredProfiles.get(selectedModel);
    if (!profile) {
      profile = this.discoverModel(selectedModel).catch((error: unknown) => {
        this.discoveredProfiles.delete(selectedModel);
        throw error;
      });
      this.discoveredProfiles.set(selectedModel, profile);
    }
    return profile;
  }

  refreshModelProfile(model: string): Promise<ModelProfile> {
    const selectedModel = model || this.defaultModel;
    this.discoveredProfiles.delete(selectedModel);
    return this.describeModel(selectedModel);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    let finalResponse: ModelResponse | undefined;
    try {
      for await (const event of this.stream(request)) {
        if (event.type === 'done') {
          finalResponse = event.response;
        }
      }
      if (!finalResponse) {
        throw new ModelProviderError({ provider: this.id, code: 'malformed_response', message: 'Ollama stream ended without a final response.' });
      }
      return finalResponse;
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    try {
      request = parseModelRequest(request);
      assertModelRequestSupported(await this.describeModel(request.model), request);
    }
    catch (error) { throw this.normalizeError(error); }
    throwIfAborted(request.signal);
    const client = this.clientFactory();
    const chatRequest = this.toChatRequest(request, true);
    const cleanupAbort = this.bindAbort(request.signal, client);
    throwIfAborted(request.signal);
    let content = '';
    let reasoning = '';
    const toolCalls: ModelToolCall[] = [];

    try {
      const stream = await client.chat(chatRequest);
      for await (const part of stream) {
        let wirePart: OllamaWireResponse;
        try { wirePart = decodeOllamaWireResponse(part); }
        catch (error) { throw new ModelProviderError({ provider: this.id, code: 'malformed_response', message: `Ollama response was malformed: ${error instanceof Error ? error.message : String(error)}`, cause: error }); }
        if (wirePart.error) throw new ModelProviderError({ provider: this.id, code: 'provider_unavailable', message: `Ollama stream error: ${wirePart.error}`, retryable: content.length === 0, cause: wirePart });
        throwIfAborted(request.signal);
        const delta = typeof wirePart.message?.content === 'string' ? wirePart.message.content : '';
        if (delta.length > 0) {
          content += delta;
          yield { type: 'content', content: delta, accumulated: content, raw: wirePart.raw };
        }

        const reasoningDelta = typeof wirePart.message?.thinking === 'string' ? wirePart.message.thinking : '';
        if (reasoningDelta.length > 0) {
          reasoning += reasoningDelta;
          yield { type: 'reasoning', reasoning: reasoningDelta, accumulatedReasoning: reasoning, raw: wirePart.raw };
        }

        for (const toolCall of normalizeToolCalls(wirePart.message?.tool_calls ?? [])) {
          toolCalls.push(toolCall);
          yield { type: 'tool_call', toolCall, raw: wirePart.raw };
        }

        if (wirePart.done) {
          const response = this.toModelResponse(wirePart, request, content, reasoning, toolCalls);
          yield { type: 'done', response };
          return;
        }
      }
      throw new ModelProviderError({ provider: this.id, code: 'malformed_response', message: 'Ollama stream ended before a done response.' });
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      cleanupAbort();
    }
  }

  private toChatRequest(request: ModelRequest, stream: true): ChatRequest & { stream: true } {
    const options = this.toRuntimeOptions(request);
    const chatRequest: ChatRequest & { stream: true } = {
      model: request.model || this.defaultModel,
      messages: request.messages.map(toOllamaMessage),
      stream
    };
    if (request.responseFormat !== undefined && this.deployment === 'cloud') throw new ModelProviderError({ provider: this.id, code: 'invalid_request', message: 'Ollama Cloud does not currently support structured-output formats.' });
    const format = request.responseFormat ? toOllamaFormat(request.responseFormat) : undefined;
    if (format !== undefined) {
      chatRequest.format = format;
    }
    if (request.tools && request.tools.length > 0) {
      chatRequest.tools = request.tools.map(toOllamaTool);
    }
    const keepAlive = request.keepAlive ?? this.keepAlive;
    if (keepAlive !== undefined) {
      chatRequest.keep_alive = keepAlive;
    }
    const think = toOllamaThink(request.reasoning ?? this.reasoning, request.model || this.defaultModel);
    if (think !== undefined) {
      chatRequest.think = think;
    }
    if (request.logprobs !== undefined) {
      chatRequest.logprobs = request.logprobs;
    }
    if (request.topLogprobs !== undefined) {
      chatRequest.top_logprobs = request.topLogprobs;
    }
    if (Object.keys(options).length > 0) {
      chatRequest.options = options;
    }
    return chatRequest;
  }

  private toModelResponse(
    response: OllamaWireResponse,
    request: ModelRequest,
    content: string,
    reasoning: string,
    streamedToolCalls: ModelToolCall[]
  ): ModelResponse {
    const fallbackContentValue: unknown = response.message?.content;
    if (fallbackContentValue !== undefined && typeof fallbackContentValue !== 'string') {
      throw new ModelProviderError({ provider: this.id, code: 'malformed_response', message: 'Ollama response did not contain message.content.' });
    }
    const fallbackContent = fallbackContentValue ?? '';
    const responseToolCalls = normalizeToolCalls(response.message?.tool_calls ?? []);
    const toolCalls = dedupeToolCalls([...streamedToolCalls, ...responseToolCalls]);
    const usage = normalizeUsage(response);
    const timings = normalizeTimings(response);
    const responseReasoning = reasoning || response.message?.thinking;
    return parseOllamaModelResponse({
      content: content || fallbackContent,
      model: typeof response.model === 'string' && response.model.length > 0 ? response.model : request.model,
      provider: this.id,
      terminationReason: toolCalls.length > 0
        ? 'tool_calls'
        : response.done_reason === 'length'
          ? 'output_limit'
          : response.done_reason === 'stop'
            ? 'stop'
            : 'unknown',
      ...(response.done_reason ? { providerTerminationReason: response.done_reason } : {}),
      ...(usage ? { usage } : {}),
      ...(responseReasoning ? { reasoning: responseReasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(Object.keys(timings).length > 0 ? { timings } : {}),
      ...(response.logprobs ? { logprobs: response.logprobs } : {}),
      raw: response.raw
    });
  }

  private toRuntimeOptions(request: ModelRequest): OllamaGenerationOptions {
    const requestOptions = ollamaProviderOptions(request);
    const options: OllamaGenerationOptions = { ...this.generationOptions, ...requestOptions };
    if (request.temperature !== undefined) {
      options.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
      options.top_p = request.topP;
    }
    if (request.maxOutputTokens !== undefined) {
      options.num_predict = request.maxOutputTokens;
    }
    return options;
  }

  private async discoverModel(model: string): Promise<ModelProfile> {
    const client = this.clientFactory();
    if (!client.show) throw new ModelProviderError({ provider: this.id, code: 'model_unavailable', message: `Ollama model ${model} cannot be profiled because the client does not implement show(). Supply a complete modelProfiles override for offline or custom clients.` });
    try {
      const details = decodeOllamaShowResponse(await client.show({ model, verbose: false }));
      return parseModelProfile(profileFromShow(model, details, this.generationOptions, this.deployment));
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private bindAbort(signal: AbortSignal | undefined, client: OllamaClient): () => void {
    if (!signal) {
      return () => undefined;
    }
    if (signal.aborted) {
      client.abort?.();
      return () => undefined;
    }
    const abort = () => client.abort?.();
    signal.addEventListener('abort', abort, { once: true });
    return () => { signal.removeEventListener('abort', abort); };
  }

  private normalizeError(error: unknown): ModelProviderError {
    if (error instanceof ModelProviderError) {
      return error;
    }
    if (error instanceof ModelContractError) {
      return new ModelProviderError({ provider: this.id, code: 'invalid_request', message: error.message, retryable: false, cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isAbortError(error) || /abort/i.test(message)) {
      return new ModelProviderError({ provider: this.id, code: 'aborted', message: `Ollama request aborted: ${message}`, retryable: false, cause: error });
    }
    const statusCode = statusCodeFromError(error);
    const code = classifyError(message, statusCode);
    return new ModelProviderError({
      provider: this.id,
      code,
      message: `Ollama request failed: ${message}`,
      retryable: code === 'provider_unavailable' || code === 'rate_limited',
      cause: error
    });
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof Map) {
    const map: ReadonlyMap<unknown, unknown> = value;
    const output: Record<string, unknown> = {};
    for (const [key, item] of map) if (typeof key === 'string') output[key] = item;
    return output;
  }
  return isJsonObject(value) ? { ...value } : undefined;
}

function toOllamaMessage(message: ModelMessage): Message {
  const ollamaMessage: Message = {
    role: message.role,
    content: message.content
  };
  if (message.reasoning) {
    ollamaMessage.thinking = message.reasoning;
  }
  const images = toOllamaImages(message.images);
  if (images) {
    ollamaMessage.images = images;
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    ollamaMessage.tool_calls = message.toolCalls.map(toOllamaToolCall);
  }
  if (message.toolName) {
    ollamaMessage.tool_name = message.toolName;
  }
  return ollamaMessage;
}

function toOllamaThink(reasoning: ModelReasoningRequest | undefined, model: string): boolean | 'high' | 'medium' | 'low' | undefined {
  if (!reasoning) {
    return undefined;
  }
  if ('summary' in reasoning) throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: 'Ollama does not expose a reasoning summary control.' });
  const gptOss = /(^|[/:])gpt-oss(?:[-:]|$)/i.test(model);
  if (reasoning.strategy === 'disabled') {
    if (gptOss) throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: 'Ollama GPT-OSS models do not allow thinking to be disabled.' });
    return false;
  }
  if (reasoning.strategy === 'enabled') {
    if (gptOss) throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: 'Ollama GPT-OSS requires an explicit low, medium, or high reasoning effort.' });
    return true;
  }
  if (reasoning.strategy === 'budget') throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: 'Ollama does not expose a thinking token budget.' });
  if (reasoning.effort === 'minimal' || reasoning.effort === 'xhigh' || reasoning.effort === 'max') {
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: `Ollama reasoning effort is not supported: ${reasoning.effort}`
    });
  }
  return reasoning.effort;
}

function profileFromShow(model: string, response: OllamaShowResponse, generationOptions: OllamaGenerationOptions, deployment: 'local' | 'cloud'): ModelProfile {
  const declared = new Set(response.capabilities ?? []);
  if (!declared.has('completion')) throw new ModelProviderError({ provider: 'ollama', code: 'model_unavailable', message: `Ollama model ${model} does not declare the completion capability required for chat.` });
  const modelContext = contextLengthFromModelInfo(response.model_info);
  const configuredContext = positiveIntegerOrUndefined(generationOptions.num_ctx);
  const parameterContext = positiveIntegerOrUndefined(parameterValue(response.parameters, 'num_ctx'));
  const contextTokens = configuredContext ?? parameterContext ?? modelContext;
  if (!contextTokens) throw new ModelProviderError({ provider: 'ollama', code: 'malformed_response', message: `Ollama /api/show did not declare a usable context length for ${model}. Supply a complete modelProfiles override.` });
  const outputTokens = positiveIntegerOrUndefined(generationOptions.num_predict)
    ?? positiveIntegerOrUndefined(parameterValue(response.parameters, 'num_predict'));
  const supportsThinking = declared.has('thinking');
  const gptOss = /(^|[/:])gpt-oss(?:[-:]|$)/i.test(model);
  const capabilities: ModelCapabilities = {
    streaming: true,
    toolCalling: declared.has('tools'),
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: deployment === 'local',
    jsonSchema: deployment === 'local',
    logprobs: true,
    temperature: true,
    topP: true,
    ...(supportsThinking ? {
      reasoning: gptOss
        ? { strategies: ['effort'], canDisable: false, efforts: ['low', 'medium', 'high'], separateOutput: true }
        : { strategies: ['toggle'], canDisable: true, separateOutput: true }
    } : {})
  };
  const supportedParameters: ModelProfile['supportedParameters'] = [
    'temperature',
    'topP',
    'maxOutputTokens',
    ...(deployment === 'local' ? ['responseFormat' as const] : []),
    'keepAlive',
    'logprobs',
    'topLogprobs',
    'providerOptions',
    ...(capabilities.toolCalling ? ['tools' as const] : []),
    ...(capabilities.reasoning ? ['reasoning' as const] : [])
  ];
  return {
    id: model,
    provider: 'ollama',
    capabilities,
    modalities: { input: declared.has('vision') ? ['text', 'image'] : ['text'], output: ['text'] },
    limits: { contextTokens, ...(outputTokens ? { outputTokens } : {}) },
    supportedParameters,
    metadata: parseJsonObject({
      discovery: 'ollama.show',
      deployment,
      declaredCapabilities: [...declared],
      ...(response.details ? { details: response.details } : {}),
      ...(response.modified_at ? { modifiedAt: response.modified_at } : {})
    })
  };
}

function contextLengthFromModelInfo(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  const entries = Object.entries(modelInfo)
    .filter(([key]) => key.endsWith('.context_length'))
    .map(([, value]) => positiveIntegerOrUndefined(value))
    .filter((value): value is number => value !== undefined);
  return entries.length > 0 ? Math.max(...entries) : undefined;
}

function parameterValue(parameters: string | undefined, name: string): number | undefined {
  if (!parameters) return undefined;
  const line = parameters.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith(`${name} `));
  if (!line) return undefined;
  const value = Number(line.slice(name.length).trim());
  return Number.isFinite(value) ? value : undefined;
}

function ollamaProviderOptions(request: ModelRequest): OllamaGenerationOptions {
  if (!request.providerOptions) return {};
  if (request.providerOptions.provider !== 'ollama') throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: `Request options for ${request.providerOptions.provider} cannot be used with Ollama.` });
  return validateGenerationOptions(request.providerOptions.values);
}

function validateGenerationOptions(value: Record<string, unknown>): OllamaGenerationOptions {
  const allowed = new Set(['num_ctx', 'num_predict', 'temperature', 'top_p', 'seed', 'repeat_penalty', 'repeat_last_n', 'frequency_penalty', 'presence_penalty', 'stop', 'num_gpu', 'num_thread']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: `Unsupported Ollama generation option(s): ${unknown.join(', ')}.` });
  for (const key of ['num_ctx', 'num_predict', 'seed', 'repeat_last_n', 'num_gpu', 'num_thread']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key]))) throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: `Ollama ${key} must be an integer.` });
  }
  for (const key of ['temperature', 'top_p', 'repeat_penalty', 'frequency_penalty', 'presence_penalty']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: `Ollama ${key} must be finite.` });
  }
  if (value.stop !== undefined && (!Array.isArray(value.stop) || !value.stop.every((item) => typeof item === 'string'))) throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: 'Ollama stop must be an array of strings.' });
  return { ...value };
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function toOllamaImages(images: readonly ModelImage[] | undefined): Message['images'] | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }
  const hasBytes = images.some((image) => image.type === 'bytes');
  const hasBase64 = images.some((image) => image.type === 'base64');
  if (hasBytes && hasBase64) {
    return images.map(toBase64Image);
  }
  if (hasBytes) {
    return images.map((image) => {
      if (image.type !== 'bytes') {
        throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: 'Ollama image array contained mixed image types.' });
      }
      return image.data;
    });
  }
  return images.map((image) => {
    if (image.type !== 'base64') {
      throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: 'Ollama image array contained mixed image types.' });
    }
    return image.data;
  });
}

function toBase64Image(image: ModelImage): string {
  return image.type === 'base64' ? image.data : Buffer.from(image.data).toString('base64');
}

function toOllamaTool(tool: ModelTool): Tool {
  if (tool.type !== 'function') {
    throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: `Ollama provider only supports JSON function tools: ${tool.name}` });
  }
  const fn: Tool['function'] = { name: tool.function.name };
  if (tool.function.description) {
    fn.description = tool.function.description;
  }
  if (tool.function.parameters) {
    fn.parameters = tool.function.parameters;
  }
  return {
    type: tool.type,
    function: fn
  };
}

function toOllamaToolCall(toolCall: ModelToolCall): NonNullable<Message['tool_calls']>[number] {
  if (toolCall.input.kind !== 'json') {
    throw new ModelProviderError({ provider: 'ollama', code: 'invalid_request', message: `Ollama provider only supports JSON function tool calls: ${toolCall.name}` });
  }
  return {
    function: {
      name: toolCall.name,
      arguments: toolCall.input.value
    }
  };
}

function toOllamaFormat(format: ModelResponseFormat): string | object | undefined {
  if (format === 'text') {
    return undefined;
  }
  if (format === 'json') {
    return 'json';
  }
  return format.schema;
}

function normalizeToolCalls(toolCalls: readonly OllamaWireToolCall[]): ModelToolCall[] {
  return toolCalls.map((toolCall) => {
    return { type: 'function', name: toolCall.function.name, input: { kind: 'json', value: toolCall.function.arguments } };
  });
}

function dedupeToolCalls(toolCalls: ModelToolCall[]): ModelToolCall[] {
  const seen = new Set<string>();
  const deduped: ModelToolCall[] = [];
  for (const toolCall of toolCalls) {
    const key = JSON.stringify(toolCall);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(toolCall);
  }
  return deduped;
}

function normalizeUsage(response: OllamaWireResponse): ModelUsage | undefined {
  if (response.prompt_eval_count === undefined && response.eval_count === undefined) {
    return undefined;
  }
  const promptTokens = response.prompt_eval_count ?? 0;
  const completionTokens = response.eval_count ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

function normalizeTimings(response: OllamaWireResponse): Record<string, number> {
  const timings: Record<string, number> = {};
  if (response.total_duration !== undefined) timings.totalDurationNs = response.total_duration;
  if (response.load_duration !== undefined) timings.loadDurationNs = response.load_duration;
  if (response.prompt_eval_duration !== undefined) timings.promptEvalDurationNs = response.prompt_eval_duration;
  if (response.eval_duration !== undefined) timings.evalDurationNs = response.eval_duration;
  return timings;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw new ModelProviderError({
    provider: 'ollama',
    code: 'aborted',
    message: typeof signal.reason === 'string' ? signal.reason : 'Ollama request aborted.',
    retryable: false,
    cause: signal.reason
  });
}

function classifyError(message: string, statusCode: number | undefined): ModelProviderErrorCode {
  if (statusCode === 404 || /not found|model .* not found/i.test(message)) {
    return 'model_unavailable';
  }
  if (statusCode === 400 || /invalid|bad request|schema|format|does not support tools|tools?.*not supported|tool calling.*not supported/i.test(message)) {
    return 'invalid_request';
  }
  if (statusCode === 408 || /context|token|too large|maximum context/i.test(message)) {
    return 'context_overflow';
  }
  if (statusCode === 429 || /rate.?limit|too many requests/i.test(message)) {
    return 'rate_limited';
  }
  if (/malformed|invalid json/i.test(message)) {
    return 'malformed_response';
  }
  return 'provider_unavailable';
}

function statusCodeFromError(error: unknown): number | undefined {
  if (!isJsonObject(error)) return undefined;
  const statusCode = error.status_code ?? error.status;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOllamaModelResponse(value: unknown): ModelResponse {
  try {
    return parseModelResponse(value);
  } catch (error) {
    if (error instanceof ModelContractError) {
      throw new ModelProviderError({ provider: 'ollama', code: 'malformed_response', message: `Ollama response violated the model contract: ${error.message}`, cause: error });
    }
    throw error;
  }
}
