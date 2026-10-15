import { parseJsonObject } from '@agent-core/json';
import {
  assertModelRequestSupported,
  assertProviderContextCompatible,
  type CompiledModelRequest,
  compileModelRequest,
  RequestTokenEstimator,
  conservativeProtocolCapabilities,
  createProviderContextState,
  type ModelCapabilities,
  type ModelCatalogEntry,
  type ModelCompilationOptions,
  ModelContractError,
  type ModelDiscoveryOptions,
  type ModelImage,
  type ModelInputItem,
  type ModelOutputItem,
  type ModelProfile,
  type ModelProvider,
  ModelProviderError,
  type ModelProviderInfo,
  type ModelReasoningRequest,
  type ModelReasoningCapabilities,
  type ModelRequest,
  type ModelResponse,
  type ModelResponseFormat,
  type ModelStreamEvent,
  type ModelTool,
  type ModelToolCall,
  type ModelTransportOptions,
  modelTransportSignal,
  type ModelUsage,
  parseModelProfile,
  parseModelRequest,
  parseModelResponse,
  requiredProtocolRevision
} from '@agent-core/model';
import { decodeHttpFailure, readBoundedJsonResponse } from '@agent-core/provider-openai-responses';
import { readOllamaStream, requestOllama } from './transport.js';
import {
  type OllamaChatRequest,
  type OllamaInputMessage,
  type OllamaTool,
  decodeOllamaShowResponse,
  decodeOllamaWireResponse,
  type OllamaShowResponse,
  type OllamaWireResponse,
  type OllamaWireToolCall
} from './wire.js';

export type { OllamaShowResponse } from './wire.js';

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
  private readonly endpoint: string;
  private readonly compiledRequests = new WeakMap<ModelRequest, CompiledModelRequest>();
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly keepAlive: string | number | undefined;
  private readonly reasoning: ModelReasoningRequest | undefined;
  private readonly generationOptions: OllamaGenerationOptions;
  private readonly modelProfiles: Record<string, OllamaModelProfileOverride>;
  private readonly deployment: 'local' | 'cloud';
  private readonly discoveredProfiles = new Map<string, Promise<ModelProfile>>();

  constructor(options: OllamaProviderOptions = {}) {
    const host = new URL(options.host ?? 'http://127.0.0.1:11434');
    if (host.protocol !== 'http:' && host.protocol !== 'https:')
      throw new TypeError('Ollama host must be an HTTP or HTTPS URL.');
    if (host.username || host.password || host.search || host.hash)
      throw new TypeError('Ollama host must be a base URL without credentials, query, or fragment.');
    this.baseUrl = host.href.replace(/\/+$/u, '');
    this.endpoint = `${this.baseUrl}/api/chat`;
    this.defaultModel = options.model ?? 'llama3.1';
    this.fetch = options.fetch ?? globalThis.fetch;
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

  async listModels(options: ModelDiscoveryOptions = {}): Promise<readonly ModelCatalogEntry[]> {
    options.signal?.throwIfAborted();
    try {
      const response = await this.readJson('tags', undefined, options.signal);
      if (
        typeof response !== 'object' ||
        response === null ||
        !('models' in response) ||
        !Array.isArray(response.models)
      )
        throw new ModelProviderError({
          provider: this.id,
          code: 'malformed_response',
          message: 'Ollama model discovery response has no models array.'
        });
      const entries: unknown[] = response.models;
      const result = entries.map((entry) => {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !('name' in entry) ||
          typeof entry.name !== 'string' ||
          !entry.name
        )
          throw new ModelProviderError({
            provider: this.id,
            code: 'malformed_response',
            message: 'Ollama catalog model name is missing.'
          });
        return { id: entry.name };
      });
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      throw this.normalizeError(error, options.signal);
    }
  }

  describeModel(model: string): Promise<ModelProfile> {
    const selectedModel = model || this.defaultModel;
    const override = this.modelProfiles[selectedModel];
    if (override)
      return Promise.resolve(
        parseModelProfile({
          id: selectedModel,
          provider: this.id,
          ...override,
          capabilities: {
            ...override.capabilities,
            protocol: override.capabilities.protocol ?? this.protocol()
          }
        })
      );
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

  private protocol() {
    return conservativeProtocolCapabilities(this.endpoint, {
      reasoningAccounting: 'included_output',
      contextReset: 'fresh_request',
      revision: 'ollama-chat-2026-09-07-v2',
      roles: ['system', 'developer', 'user', 'assistant'],
      developerRole: 'system_if_no_system',
      inputKinds: ['text', 'image', 'tool_call', 'tool_result', 'protocol'],
      outputKinds: ['text', 'tool_call', 'protocol'],
      state: 'exact'
    });
  }
  async compileRequest(
    request: ModelRequest,
    options?: ModelCompilationOptions
  ): Promise<CompiledModelRequest> {
    request = parseModelRequest(request);
    const cached = this.compiledRequests.get(request);
    if (
      cached &&
      (options?.tokenObservation === undefined || cached.accounting.method.name === 'provider-count') &&
      (options === undefined || options.outputReservation === cached.accounting.outputReservation)
    )
      return cached;
    if (cached) request = parseModelRequest({ ...request });
    if (request.reasoning === undefined && this.reasoning !== undefined) {
      request = parseModelRequest({ ...request, reasoning: this.reasoning });
    }
    const profile = await this.describeModel(request.model);
    assertModelRequestSupported(profile, request);
    for (const [index, item] of request.messages.entries())
      if (item.role === 'protocol')
        await assertProviderContextCompatible(
          item.state,
          request,
          this.endpoint,
          request.messages.slice(0, index),
          this.id,
          requiredProtocolRevision(await this.describeModel(request.model))
        );
    const wire = this.toChatRequest(
      request,
      profile.capabilities.protocol?.developerRole === 'system_if_no_system'
    );
    const body: Record<string, unknown> = { ...wire };
    delete body.stream;
    const compiled = await compileModelRequest({
      ...options,
      request,
      profile,
      body,
      payloadPaths: ollamaPayloadPaths(body),
      ...(typeof wire.options?.num_predict === 'number' && wire.options.num_predict > 0
        ? { outputReservation: wire.options.num_predict }
        : {}),
      endpoint: this.endpoint
    });
    this.compiledRequests.set(compiled.logicalRequest, compiled);
    return compiled;
  }
  private assertCompiled(compiled: CompiledModelRequest): void {
    if (this.compiledRequests.get(compiled.logicalRequest) !== compiled)
      throw new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: 'Unrecognized compiled request.'
      });
  }
  completeCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): Promise<ModelResponse> {
    this.assertCompiled(compiled);
    return this.complete(compiled.logicalRequest, options);
  }
  async *streamCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent> {
    this.assertCompiled(compiled);
    yield* this.stream(compiled.logicalRequest, options);
  }

  async complete(request: ModelRequest, options?: ModelTransportOptions): Promise<ModelResponse> {
    let finalResponse: ModelResponse | undefined;
    for await (const event of this.stream(request, options)) {
      if (event.type === 'done') {
        finalResponse = event.response;
      }
    }
    if (!finalResponse) {
      throw new ModelProviderError({
        provider: this.id,
        code: 'malformed_response',
        message: 'Ollama stream ended without a final response.'
      });
    }
    return finalResponse;
  }

  async *stream(request: ModelRequest, options?: ModelTransportOptions): AsyncIterable<ModelStreamEvent> {
    let compiled: CompiledModelRequest;
    try {
      compiled = await this.compileRequest(request);
      request = compiled.logicalRequest;
    } catch (error) {
      throw this.normalizeError(error, options?.signal);
    }
    const signal = modelTransportSignal(request, options);
    throwIfAborted(signal);
    let content = '';
    let reasoning = '';
    const toolCalls: ModelToolCall[] = [];

    try {
      const response = await requestOllama(
        this.fetch,
        this.endpoint,
        { ...compiled.body, stream: true },
        signal
      );
      const stream = readOllamaStream(response, signal);
      for await (const part of stream) {
        let wirePart: OllamaWireResponse;
        try {
          wirePart = decodeOllamaWireResponse(part);
        } catch (error) {
          throw new ModelProviderError({
            provider: this.id,
            code: 'malformed_response',
            message: `Ollama response was malformed: ${error instanceof Error ? error.message : String(error)}`,
            cause: error
          });
        }
        if (wirePart.error) {
          const failure =
            wirePart.status === undefined
              ? { code: 'provider_unavailable' as const, retryable: true }
              : decodeHttpFailure(wirePart.status, JSON.stringify({ error: wirePart.error }));
          throw new ModelProviderError({
            provider: this.id,
            ...failure,
            message: `Ollama stream error: ${wirePart.error}`,
            retryable:
              failure.retryable &&
              content.length === 0 &&
              reasoning.length === 0 &&
              toolCalls.length === 0,
            cause: wirePart
          });
        }
        throwIfAborted(signal);
        const delta = typeof wirePart.message?.content === 'string' ? wirePart.message.content : '';
        if (delta.length > 0) {
          content += delta;
          yield { type: 'content', content: delta, accumulated: content, raw: wirePart.raw };
        }

        const reasoningDelta =
          typeof wirePart.message?.thinking === 'string' ? wirePart.message.thinking : '';
        if (reasoningDelta.length > 0) {
          reasoning += reasoningDelta;
          yield {
            type: 'reasoning',
            reasoning: reasoningDelta,
            accumulatedReasoning: reasoning,
            raw: wirePart.raw
          };
        }

        for (const toolCall of normalizeToolCalls(wirePart.message?.tool_calls ?? [])) {
          toolCalls.push(toolCall);
          yield { type: 'tool_call', toolCall, raw: wirePart.raw };
        }

        if (wirePart.done) {
          const response = await this.toModelResponse(wirePart, request, content, reasoning, toolCalls);
          yield { type: 'done', response };
          return;
        }
      }
      throw new ModelProviderError({
        provider: this.id,
        code: 'malformed_response',
        message: 'Ollama stream ended before a done response.'
      });
    } catch (error) {
      throw this.normalizeError(error, signal, content.length > 0 || reasoning.length > 0 || toolCalls.length > 0);
    }
  }

  private toChatRequest(
    request: ModelRequest,
    lowerDeveloper: boolean
  ): OllamaChatRequest {
    const options = this.toRuntimeOptions(request);
    const chatRequest: OllamaChatRequest = {
      model: request.model || this.defaultModel,
      messages: toOllamaMessages(request.messages, lowerDeveloper),
      stream: true,
      truncate: false,
      shift: false
    };
    if (request.responseFormat !== undefined && this.deployment === 'cloud')
      throw new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: 'Ollama Cloud does not currently support structured-output formats.'
      });
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
    const think = toOllamaThink(request.reasoning);
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

  private async toModelResponse(
    response: OllamaWireResponse,
    request: ModelRequest,
    content: string,
    reasoning: string,
    toolCalls: readonly ModelToolCall[]
  ): Promise<ModelResponse> {
    const usage = normalizeUsage(response);
    const timings = normalizeTimings(response);
    const output: ModelOutputItem[] = [];
    if (reasoning)
      output.push({
        type: 'protocol',
        state: await createProviderContextState({
          protocolRevision: requiredProtocolRevision(await this.describeModel(request.model)),
          request,
          provider: this.id,
          endpoint: this.endpoint,
          requestId: 'ollama-response',
          kind: 'ollama.thinking',
          requiresExactPrefix: false,
          data: { thinking: reasoning },
          tokenEstimate: new RequestTokenEstimator().estimateText(reasoning)
        })
      });
    if (content) output.push({ type: 'text', text: content });
    output.push(...toolCalls.map((toolCall) => ({ type: 'tool_call' as const, toolCall })));
    return parseOllamaModelResponse({
      output,
      content,
      model:
        typeof response.model === 'string' && response.model.length > 0 ? response.model : request.model,
      provider: this.id,
      terminationReason:
        toolCalls.length > 0
          ? 'tool_calls'
          : response.done_reason === 'length'
            ? 'output_limit'
            : response.done_reason === 'stop'
              ? 'stop'
              : 'unknown',
      ...(response.done_reason ? { providerTerminationReason: response.done_reason } : {}),
      ...(usage ? { usage } : {}),
      ...(reasoning ? { reasoning } : {}),
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
    try {
      const raw = await this.readJson('show', { model, verbose: false });
      let details: OllamaShowResponse;
      try {
        details = decodeOllamaShowResponse(raw);
      } catch (cause) {
        throw new ModelProviderError({
          provider: this.id,
          code: 'malformed_response',
          message: 'Ollama model discovery returned invalid metadata.',
          cause
        });
      }
      const profile = profileFromShow(model, details, this.generationOptions, this.deployment);
      return parseModelProfile({
        ...profile,
        capabilities: { ...profile.capabilities, protocol: this.protocol() }
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async readJson(path: 'show' | 'tags', body?: object, signal?: AbortSignal): Promise<unknown> {
    const response = await requestOllama(this.fetch, `${this.baseUrl}/api/${path}`, body, signal);
    try {
      return await readBoundedJsonResponse(response);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModelProviderError({
        provider: this.id,
        code: 'malformed_response',
        message: `Ollama /api/${path} did not return a bounded JSON response.`
      });
    }
  }

  private normalizeError(error: unknown, signal?: AbortSignal, delivered = false): ModelProviderError {
    if (error instanceof ModelProviderError) {
      return error;
    }
    if (error instanceof ModelContractError) {
      return new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: error.message,
        retryable: false,
        cause: error
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (signal?.aborted || isAbortError(error)) {
      return new ModelProviderError({
        provider: this.id,
        code: 'aborted',
        message: `Ollama request aborted: ${message}`,
        retryable: false,
        cause: error
      });
    }
    return new ModelProviderError({
      provider: this.id,
      code: 'provider_unavailable',
      retryable: !delivered,
      message: `Ollama request failed: ${message}`,
      cause: error
    });
  }
}

function toOllamaMessage(message: ModelInputItem, lowerDeveloper: boolean): OllamaInputMessage {
  if (message.role === 'control' || message.role === 'protocol')
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: `Unsupported Ollama input role: ${message.role}.`
    });
  if (message.parts?.length) {
    let sawImage = false;
    let text = message.content;
    const images = [...(message.images ?? [])];
    for (const part of message.parts) {
      if (part.type === 'text' && !sawImage) text += part.text;
      else if (part.type === 'image') {
        sawImage = true;
        images.push(part.image);
      } else
        throw new ModelProviderError({
          provider: 'ollama',
          code: 'invalid_request',
          message: 'Ollama cannot represent this ordered content sequence.'
        });
    }
    if (images.length && message.role !== 'user' && message.role !== 'tool')
      throw new ModelProviderError({
        provider: 'ollama',
        code: 'invalid_request',
        message: 'Ollama media requires user or tool input.'
      });
    const plain = { ...message };
    delete plain.parts;
    return toOllamaMessage(
      { ...plain, content: text, ...(images.length ? { images } : {}) } as ModelInputItem,
      lowerDeveloper
    );
  }
  const ollamaMessage: OllamaInputMessage = {
    role: message.role === 'developer' && lowerDeveloper ? 'system' : message.role,
    content: message.content
  };

  const images = toOllamaImages(message.images);
  if (images) {
    ollamaMessage.images = images;
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    ollamaMessage.tool_calls = message.toolCalls.map(toOllamaToolCall);
  }
  if (message.toolCallId !== undefined) ollamaMessage.tool_call_id = message.toolCallId;
  if (message.toolName) {
    ollamaMessage.tool_name = message.toolName;
  }
  return ollamaMessage;
}

function toOllamaThink(
  reasoning: ModelReasoningRequest | undefined
): boolean | string | undefined {
  if (!reasoning) {
    return undefined;
  }
  if ('summary' in reasoning)
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: 'Ollama does not expose a reasoning summary control.'
    });
  if (reasoning.strategy === 'disabled') {
    return false;
  }
  if (reasoning.strategy === 'enabled') {
    return true;
  }
  if (reasoning.strategy === 'budget')
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: 'Ollama does not expose a thinking token budget.'
    });
  return reasoning.effort;
}

function reasoningFromShow(response: OllamaShowResponse): ModelReasoningCapabilities | undefined {
  const values = response.thinking?.values;
  if (values === undefined || values.every((value) => value === false)) return undefined;
  const efforts = values.filter((value): value is string => typeof value === 'string');
  return {
    strategies: [
      ...(values.includes(true) ? ['toggle' as const] : []),
      ...(efforts.length ? ['effort' as const] : [])
    ],
    canDisable: values.includes(false),
    ...(efforts.length ? { efforts } : {}),
    separateOutput: true
  };
}

function profileFromShow(
  model: string,
  response: OllamaShowResponse,
  generationOptions: OllamaGenerationOptions,
  deployment: 'local' | 'cloud'
): ModelProfile {
  const declared = new Set(response.capabilities ?? []);
  if (!declared.has('completion'))
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'model_unavailable',
      message: `Ollama model ${model} does not declare the completion capability required for chat.`
    });
  const modelContext = contextLengthFromModelInfo(response.model_info);
  const configuredContext = positiveIntegerOrUndefined(generationOptions.num_ctx);
  const parameterContext = positiveIntegerOrUndefined(parameterValue(response.parameters, 'num_ctx'));
  const contextTokens = configuredContext ?? parameterContext ?? modelContext;
  if (!contextTokens)
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'malformed_response',
      message: `Ollama /api/show did not declare a usable context length for ${model}. Supply a complete modelProfiles override.`
    });
  const outputTokens =
    positiveIntegerOrUndefined(generationOptions.num_predict) ??
    positiveIntegerOrUndefined(parameterValue(response.parameters, 'num_predict'));
  const reasoning = reasoningFromShow(response);
  const capabilities: ModelCapabilities = {
    streaming: true,
    toolCalling: declared.has('tools'),
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: deployment === 'local',
    jsonSchema: deployment === 'local',
    logprobs: true,
    temperature: true,
    topP: true,
    ...(reasoning === undefined ? {} : { reasoning })
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
      ...(response.thinking === undefined ? {} : { thinking: response.thinking }),
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
  const line = parameters
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name} `));
  if (!line) return undefined;
  const value = Number(line.slice(name.length).trim());
  return Number.isFinite(value) ? value : undefined;
}

function ollamaProviderOptions(request: ModelRequest): OllamaGenerationOptions {
  if (!request.providerOptions) return {};
  if (request.providerOptions.provider !== 'ollama')
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: `Request options for ${request.providerOptions.provider} cannot be used with Ollama.`
    });
  return validateGenerationOptions(request.providerOptions.values);
}

function validateGenerationOptions(value: Record<string, unknown>): OllamaGenerationOptions {
  const allowed = new Set([
    'num_ctx',
    'num_predict',
    'temperature',
    'top_p',
    'seed',
    'repeat_penalty',
    'repeat_last_n',
    'frequency_penalty',
    'presence_penalty',
    'stop',
    'num_gpu',
    'num_thread'
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: `Unsupported Ollama generation option(s): ${unknown.join(', ')}.`
    });
  for (const key of ['num_ctx', 'num_predict', 'seed', 'repeat_last_n', 'num_gpu', 'num_thread']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key])))
      throw new ModelProviderError({
        provider: 'ollama',
        code: 'invalid_request',
        message: `Ollama ${key} must be an integer.`
      });
  }
  for (const key of ['temperature', 'top_p', 'repeat_penalty', 'frequency_penalty', 'presence_penalty']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key])))
      throw new ModelProviderError({
        provider: 'ollama',
        code: 'invalid_request',
        message: `Ollama ${key} must be finite.`
      });
  }
  if (
    value.stop !== undefined &&
    (!Array.isArray(value.stop) || !value.stop.every((item) => typeof item === 'string'))
  )
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: 'Ollama stop must be an array of strings.'
    });
  return { ...value };
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function toOllamaImages(images: readonly ModelImage[] | undefined): OllamaInputMessage['images'] | undefined {
  return images?.length ? images.map(toBase64Image) : undefined;
}

function toBase64Image(image: ModelImage): string {
  return image.type === 'base64' ? image.data : Buffer.from(image.data).toString('base64');
}

function toOllamaTool(tool: ModelTool): OllamaTool {
  if (tool.type !== 'function') {
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: `Ollama provider only supports JSON function tools: ${tool.name}`
    });
  }
  const fn: OllamaTool['function'] = { name: tool.function.name };
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

function toOllamaToolCall(toolCall: ModelToolCall): NonNullable<OllamaInputMessage['tool_calls']>[number] {
  if (toolCall.input.kind !== 'json') {
    throw new ModelProviderError({
      provider: 'ollama',
      code: 'invalid_request',
      message: `Ollama provider only supports JSON function tool calls: ${toolCall.name}`
    });
  }
  return {
    ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
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
    return {
      type: 'function',
      ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
      name: toolCall.function.name,
      input: { kind: 'json', value: toolCall.function.arguments }
    };
  });
}

function normalizeUsage(response: OllamaWireResponse): ModelUsage | undefined {
  if (response.prompt_eval_count === undefined || response.eval_count === undefined) {
    return undefined;
  }
  const promptTokens = response.prompt_eval_count;
  const completionTokens = response.eval_count;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(response.prompt_eval_cached_count === undefined
      ? {}
      : { cacheReadTokens: response.prompt_eval_cached_count })
  };
}

function normalizeTimings(response: OllamaWireResponse): Record<string, number> {
  const timings: Record<string, number> = {};
  if (response.total_duration !== undefined) timings.totalDurationNs = response.total_duration;
  if (response.load_duration !== undefined) timings.loadDurationNs = response.load_duration;
  if (response.prompt_eval_duration !== undefined)
    timings.promptEvalDurationNs = response.prompt_eval_duration;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parseOllamaModelResponse(value: unknown): ModelResponse {
  try {
    return parseModelResponse(value);
  } catch (error) {
    if (error instanceof ModelContractError) {
      throw new ModelProviderError({
        provider: 'ollama',
        code: 'malformed_response',
        message: `Ollama response violated the model contract: ${error.message}`,
        cause: error
      });
    }
    throw error;
  }
}

function toOllamaMessages(items: readonly ModelInputItem[], lowerDeveloper: boolean): OllamaInputMessage[] {
  const messages: OllamaInputMessage[] = [];
  let thinking: string | undefined;
  for (const item of items) {
    if (item.role === 'protocol') {
      if (
        thinking !== undefined ||
        item.state.kind !== 'ollama.thinking' ||
        typeof item.state.data.thinking !== 'string'
      )
        throw new ModelProviderError({
          provider: 'ollama',
          code: 'invalid_request',
          message: 'Unsupported Ollama thinking state.'
        });
      thinking = item.state.data.thinking;
      continue;
    }
    if (thinking !== undefined && item.role !== 'assistant')
      throw new ModelProviderError({
        provider: 'ollama',
        code: 'invalid_request',
        message: 'Thinking must precede its assistant message.'
      });
    const message = toOllamaMessage(item, lowerDeveloper);
    if (thinking !== undefined) {
      message.thinking = thinking;
      thinking = undefined;
    }
    const previous = messages.at(-1);
    if (item.role === 'assistant' && previous?.role === 'assistant') {
      previous.content += message.content;
      if (message.tool_calls) previous.tool_calls = [...(previous.tool_calls ?? []), ...message.tool_calls];
      if (message.thinking) previous.thinking = message.thinking;
    } else messages.push(message);
  }
  if (thinking !== undefined) messages.push({ role: 'assistant', content: '', thinking });
  return messages;
}

function ollamaPayloadPaths(body: Record<string, unknown>): readonly (readonly (string | number)[])[] {
  const paths: (string | number)[][] = [];
  if (!Array.isArray(body.messages)) return paths;
  for (const [index, raw] of (body.messages as unknown[]).entries()) {
    const message = parseJsonObject(raw);
    if (message.images !== undefined) paths.push(['messages', index, 'images']);
    if (message.role === 'assistant' && message.thinking !== undefined)
      paths.push(['messages', index, 'thinking']);
  }
  return paths;
}
