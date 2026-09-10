import {
  type BearerToken,
  type BearerTokenProvider,
  CachedBearerTokenProvider,
  type CredentialStore,
  type ProviderAuth
} from '@agent-core/auth';
import { parseJsonValue } from '@agent-core/json';
import {
  type CompiledModelRequest,
  type ModelCompilationOptions,
  type ModelProvider,
  ModelProviderError,
  type ModelProviderInfo,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
  type ModelTransportOptions,
  assertModelRequestSupported,
  assertProviderContextCompatible,
  compileModelRequest,
  conservativeProtocolCapabilities,
  modelTransportSignal,
  parseModelProfile,
  parseModelRequest,
  requiredProtocolRevision
} from '@agent-core/model';
import { responsesPayloadPaths } from '@agent-core/provider-openai-responses';

import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID
} from './constants.js';
import {
  type CodexContinuationResponse,
  assembleCodexWebSocketRequest,
  normalizedOutputItems
} from './continuation.js';
import {
  normalizeError,
  parseCodexJsonResponse,
  parseCodexModelResponse,
  summarizeCodexFailure
} from './errors.js';
import {
  type OpenAICodexResponsesPayload,
  type StreamingCustomToolCallAccumulator,
  type StreamingFunctionCallAccumulator,
  addUniqueToolCall,
  dedupeToolCalls,
  fallbackStreamResponse,
  mergeStreamingCustomToolCallParts,
  mergeStreamingFunctionCallParts,
  reasoningChannelFromEvent,
  toModelResponse,
  toolCallFromOutputItem
} from './events.js';
import {
  type CodexHttpTransportConfig,
  fetchCodexResponse,
  requestHeaders,
  streamCodexHttp
} from './http-transport.js';
import { type OpenAICodexModelProfileDefinition, describeOpenAICodexModel } from './model-profile.js';
import {
  type OpenAICodexDeviceCodeInfo,
  type OpenAICodexDeviceCodeLoginOptions,
  OpenAICodexTokenRefresher,
  accountIdFromToken,
  loginOpenAICodexDeviceCode,
  resolveTokenProvider
} from './oauth.js';
import { cacheCodexCompiledRequest, codexCompiledRequest, toCodexResponsesRequest } from './request.js';
import { errorMessage, stringValue, throwIfAborted } from './utils.js';
import {
  type CodexWebSocket,
  type CodexWebSocketFactory,
  type CodexWebSocketOptions,
  CodexWebSocketTransportError,
  defaultCodexWebSocketFactory,
  readCodexWebSocketEvents,
  resolveCodexUrl,
  resolveCodexWebSocketUrl,
  sendWebSocketJson,
  waitForWebSocketOpen,
  websocketHeaders
} from './websocket-transport.js';

export { OpenAICodexTokenRefresher, loginOpenAICodexDeviceCode };
export type {
  CodexWebSocket,
  CodexWebSocketFactory,
  CodexWebSocketOptions,
  OpenAICodexDeviceCodeInfo,
  OpenAICodexDeviceCodeLoginOptions,
  OpenAICodexModelProfileDefinition
};

export type OpenAICodexTransport = 'http_sse' | 'websocket';

export interface OpenAICodexProviderOptions {
  auth?: ProviderAuth | BearerTokenProvider;
  credentialStore?: CredentialStore;
  credentialKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  transport?: OpenAICodexTransport;
  webSocketFactory?: CodexWebSocketFactory;
  statusIntervalMs?: number;
  streamIdleTimeoutMs?: number;
  originator?: string;
  modelProfiles?: Record<string, OpenAICodexModelProfileDefinition>;
}

export class OpenAICodexProvider implements ModelProvider {
  readonly id = OPENAI_CODEX_PROVIDER_ID;
  readonly implementationId = 'agent-core.provider.openai-codex@1';
  private readonly compiledRequests = new WeakSet<CompiledModelRequest>();
  private readonly tokenProvider: BearerTokenProvider;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transport: OpenAICodexTransport;
  private readonly webSocketFactory: CodexWebSocketFactory;
  private readonly statusIntervalMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly originator: string;
  private readonly modelProfiles: Record<string, OpenAICodexModelProfileDefinition>;

  constructor(options: OpenAICodexProviderOptions = {}) {
    this.baseUrl = resolveCodexUrl(options.baseUrl ?? OPENAI_CODEX_BASE_URL);
    this.defaultModel = options.model ?? OPENAI_CODEX_DEFAULT_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.transport = options.transport ?? 'http_sse';
    this.webSocketFactory = options.webSocketFactory ?? defaultCodexWebSocketFactory;
    this.statusIntervalMs = Math.max(1, options.statusIntervalMs ?? 15_000);
    this.streamIdleTimeoutMs = Math.max(1, options.streamIdleTimeoutMs ?? 120_000);
    this.originator = options.originator ?? 'agent-core';
    this.modelProfiles = options.modelProfiles ?? {};
    this.tokenProvider = new CachedBearerTokenProvider(resolveTokenProvider(options, this.fetchImpl));
  }

  describe(): ModelProviderInfo {
    return {
      id: this.id,
      displayName: 'OpenAI Codex ChatGPT subscription provider',
      defaultModel: this.defaultModel
    };
  }

  createSession(): ModelProviderSession {
    return new OpenAICodexProviderSession(this);
  }

  describeModel(model: string) {
    const profile = describeOpenAICodexModel(model || this.defaultModel, this.modelProfiles);
    return Promise.resolve(
      parseModelProfile({
        ...profile,
        capabilities: {
          ...profile.capabilities,
          protocol: conservativeProtocolCapabilities(this.baseUrl, {
            reasoningAccounting: 'included_output',
            revision: 'codex-responses-2026-09-07-v1',
            roles: ['system', 'developer', 'user', 'assistant'],
            inputKinds: ['text', 'image', 'tool_call', 'tool_result', 'protocol'],
            outputKinds: ['text', 'tool_call', 'protocol', 'refusal'],
            state: 'exact',
            continuation: 'exact_prefix'
          })
        }
      })
    );
  }

  async compileRequest(
    request: ModelRequest,
    options?: ModelCompilationOptions
  ): Promise<CompiledModelRequest> {
    request = await this.validateRequest(request);
    const cached = codexCompiledRequest(request);
    if (
      cached &&
      this.compiledRequests.has(cached) &&
      (options === undefined || options.outputReservation === cached.accounting.outputReservation)
    )
      return cached;
    // Each compilation keeps its own logical identity across provider instances and policies.
    if (cached) request = parseModelRequest({ ...request });
    const body = toCodexResponsesRequest(request, false);
    delete body.stream;
    const compiled = await compileModelRequest({
      request,
      profile: await this.describeModel(request.model),
      body,
      payloadPaths: responsesPayloadPaths(body),
      ...options,
      endpoint: this.baseUrl
    });
    cacheCodexCompiledRequest(compiled);
    this.compiledRequests.add(compiled);
    return compiled;
  }
  assertCompiled(compiled: CompiledModelRequest): void {
    if (
      !this.compiledRequests.has(compiled) ||
      compiled.endpoint !== this.baseUrl ||
      codexCompiledRequest(compiled.logicalRequest) !== compiled
    )
      throw new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: 'Compiled request was not admitted by this provider instance.'
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
    const session = this.createSession();
    if (!session.completeCompiled)
      throw new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: 'Session has no compiled completion transport.'
      });
    return session.completeCompiled(await this.compileRequest(request), options);
  }

  async *stream(request: ModelRequest, options?: ModelTransportOptions): AsyncIterable<ModelStreamEvent> {
    const session = this.createSession();
    if (!session.streamCompiled) {
      throw new ModelProviderError({
        provider: this.id,
        code: 'invalid_request',
        message: 'OpenAI Codex provider session does not support streaming.'
      });
    }
    yield* session.streamCompiled(await this.compileRequest(request), options);
  }

  async fetchResponse(
    request: ModelRequest,
    stream: boolean,
    options?: ModelTransportOptions
  ): Promise<Response> {
    const compiled = await this.compileRequest(request);
    return fetchCodexResponse(
      this.httpTransportConfig(),
      compiled.logicalRequest,
      stream,
      modelTransportSignal(compiled.logicalRequest, options)
    );
  }

  async *streamHttp(
    request: ModelRequest,
    onResponsePayload?: (payload: OpenAICodexResponsesPayload) => void,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent> {
    const compiled = await this.compileRequest(request);
    yield* streamCodexHttp(
      { ...this.httpTransportConfig(), ...(onResponsePayload ? { onResponsePayload } : {}) },
      compiled.logicalRequest,
      modelTransportSignal(compiled.logicalRequest, options)
    );
  }

  async validateRequest(request: ModelRequest): Promise<ModelRequest> {
    try {
      const owned = parseModelRequest(request);
      assertModelRequestSupported(await this.describeModel(owned.model), owned);
      for (const [index, item] of owned.messages.entries())
        if (item.role === 'protocol')
          await assertProviderContextCompatible(
            item.state,
            owned,
            this.baseUrl,
            owned.messages.slice(0, index),
            this.id,
            requiredProtocolRevision(await this.describeModel(owned.model))
          );
      return owned;
    } catch (error) {
      throw normalizeError(this.id, error);
    }
  }

  async tokenForRequest(signal: AbortSignal | undefined): Promise<BearerToken> {
    return this.tokenProvider.getBearerToken(signal);
  }

  codexAccountId(token: BearerToken): string {
    return accountIdFromToken(token);
  }

  httpUrl(): string {
    return this.baseUrl;
  }

  websocketUrl(): string {
    return resolveCodexWebSocketUrl(this.baseUrl);
  }

  shouldUseWebSocket(): boolean {
    return this.transport === 'websocket';
  }

  createWebSocket(url: string, options: CodexWebSocketOptions): CodexWebSocket {
    return this.webSocketFactory(url, options);
  }

  headersForRequest(token: string, accountId: string, stream: boolean): Record<string, string> {
    return requestHeaders(token, accountId, stream, this.originator);
  }

  headersForWebSocket(token: string, accountId: string): Record<string, string> {
    return websocketHeaders(token, accountId, this.originator);
  }

  private httpTransportConfig(): CodexHttpTransportConfig {
    return {
      providerId: this.id,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      tokenProvider: this.tokenProvider,
      originator: this.originator,
      statusIntervalMs: this.statusIntervalMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs
    };
  }
}

class OpenAICodexProviderSession implements ModelProviderSession {
  private webSocket: CodexWebSocket | undefined;
  private webSocketFallbackReported = false;
  private lastRequest: Record<string, unknown> | undefined;
  private lastResponse: CodexContinuationResponse | undefined;

  constructor(private readonly provider: OpenAICodexProvider) {}
  completeCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): Promise<ModelResponse> {
    this.provider.assertCompiled(compiled);
    return this.complete(compiled.logicalRequest, options);
  }
  async *streamCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent> {
    this.provider.assertCompiled(compiled);
    yield* this.stream(compiled.logicalRequest, options);
  }

  async complete(request: ModelRequest, options?: ModelTransportOptions): Promise<ModelResponse> {
    try {
      request = (await this.provider.compileRequest(request)).logicalRequest;
      const response = await this.provider.fetchResponse(request, false, options);
      const payload = await parseCodexJsonResponse(this.provider.id, response);
      const modelResponse = await toModelResponse(this.provider.id, request, payload, {
        strategy: 'http_full_replay',
        endpoint: this.provider.httpUrl()
      });
      this.rememberFullHttpRequest(request, false, payload);
      return modelResponse;
    } catch (error) {
      this.resetContinuation('error');
      throw normalizeError(this.provider.id, error);
    }
  }

  async *stream(request: ModelRequest, options?: ModelTransportOptions): AsyncIterable<ModelStreamEvent> {
    request = (await this.provider.compileRequest(request)).logicalRequest;
    if (!this.provider.shouldUseWebSocket()) {
      yield* this.streamHttp(request, options);
      return;
    }

    let emittedModelEvent = false;
    try {
      for await (const event of this.streamWebSocket(request, options)) {
        if (event.type === 'content' || event.type === 'reasoning' || event.type === 'tool_call') {
          emittedModelEvent = true;
        }
        yield event;
      }
    } catch (error) {
      this.resetContinuation('websocket_error');
      const webSocketError = websocketFailureError(
        this.provider.id,
        error,
        emittedModelEvent ? 'after_model_event' : 'before_model_event'
      );
      if (emittedModelEvent || isWebSocketProviderResponseFailure(webSocketError)) {
        throw webSocketError;
      }
      if (!this.webSocketFallbackReported) {
        this.webSocketFallbackReported = true;
        yield {
          type: 'status',
          message: `OpenAI Codex WebSocket unavailable; transport=websocket; phase=before_model_event; falling back to transport=http_sse: ${errorMessage(error)}`
        };
      }
      yield* this.streamHttp(request, options);
    }
  }

  resetContinuation(reason: string): void {
    void reason;
    this.lastRequest = undefined;
    this.lastResponse = undefined;
  }

  close(): Promise<void> {
    this.webSocket?.close();
    this.webSocket = undefined;
    return Promise.resolve();
  }

  private async *streamHttp(
    request: ModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent> {
    let payload: OpenAICodexResponsesPayload | undefined;
    for await (const event of this.provider.streamHttp(
      request,
      (value) => {
        payload = value;
      },
      options
    )) {
      if (event.type === 'done') {
        this.rememberFullHttpRequest(request, true, payload);
        yield event;
        continue;
      }
      yield event;
    }
  }

  private async *streamWebSocket(
    request: ModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent> {
    const signal = modelTransportSignal(request, options);
    throwIfAborted(signal);
    const token = await this.provider.tokenForRequest(signal);
    const accountId = this.provider.codexAccountId(token);
    const socket = await this.ensureWebSocket(token.token, accountId, signal);
    await this.provider.compileRequest(request);
    const fullRequest = toCodexResponsesRequest(request, true);
    const assembly = assembleCodexWebSocketRequest(fullRequest, this.lastRequest, this.lastResponse);
    const wireRequest = {
      type: 'response.create',
      ...assembly.request
    };
    const streamEvents = readCodexWebSocketEvents(socket, signal);
    await sendWebSocketJson(socket, wireRequest, signal);

    let content = '';
    let reasoning = '';
    let reasoningSummary = '';
    let completedResponse: OpenAICodexResponsesPayload | undefined;
    const toolCalls: ModelToolCall[] = [];
    const accumulators = new Map<string, StreamingFunctionCallAccumulator>();
    const customAccumulators = new Map<string, StreamingCustomToolCallAccumulator>();

    for await (const part of streamEvents) {
      const eventType = part.type;
      if (eventType === 'response.failed' || eventType === 'error') {
        const failure = summarizeCodexFailure(part);
        const causeSummary = {
          ...failure.causeSummary,
          continuationStrategy: assembly.reusedContinuation ? 'websocket_delta' : 'websocket_full_replay',
          reusedContinuation: assembly.reusedContinuation,
          ...(assembly.reusedContinuation && this.lastResponse
            ? { previousResponseId: this.lastResponse.responseId }
            : {})
        };
        throw new ModelProviderError({
          provider: this.provider.id,
          code: 'provider_unavailable',
          message: `OpenAI Codex WebSocket response failed: ${failure.message}`,
          retryable: true,
          cause: part,
          diagnostic: {
            transport: 'websocket',
            ...(failure.eventType ? { eventType: failure.eventType } : {}),
            causeSummary
          }
        });
      }

      if ((eventType === 'response.completed' || eventType === 'response.incomplete') && part.response) {
        completedResponse = part.response;
      }

      const contentDelta = stringValue(part.delta);
      if (eventType === 'response.output_text.delta' && contentDelta.length > 0) {
        content += contentDelta;
        yield {
          type: 'content',
          content: contentDelta,
          accumulated: content,
          raw: parseJsonValue(part)
        };
        continue;
      }

      const reasoningChannel = reasoningChannelFromEvent(eventType);
      if (reasoningChannel && contentDelta.length > 0) {
        if (reasoningChannel === 'summary') {
          reasoningSummary += contentDelta;
          yield {
            type: 'reasoning',
            reasoning: contentDelta,
            accumulatedReasoning: reasoningSummary,
            channel: 'summary',
            raw: parseJsonValue(part)
          };
        } else {
          reasoning += contentDelta;
          yield {
            type: 'reasoning',
            reasoning: contentDelta,
            accumulatedReasoning: reasoning,
            channel: 'reasoning',
            raw: parseJsonValue(part)
          };
        }
        continue;
      }

      const toolCall = toolCallFromOutputItem(this.provider.id, part.item);
      if (eventType === 'response.output_item.done' && toolCall) {
        const deduped = addUniqueToolCall(toolCalls, toolCall);
        if (deduped) {
          yield { type: 'tool_call', toolCall, raw: parseJsonValue(part) };
        }
        continue;
      }

      for (const streamedToolCall of mergeStreamingFunctionCallParts(accumulators, part)) {
        const deduped = addUniqueToolCall(toolCalls, streamedToolCall);
        if (deduped) {
          yield { type: 'tool_call', toolCall: streamedToolCall, raw: parseJsonValue(part) };
        }
      }

      for (const streamedToolCall of mergeStreamingCustomToolCallParts(customAccumulators, part)) {
        const deduped = addUniqueToolCall(toolCalls, streamedToolCall);
        if (deduped) {
          yield { type: 'tool_call', toolCall: streamedToolCall, raw: parseJsonValue(part) };
        }
      }

      if (eventType === 'response.completed' || eventType === 'response.incomplete') {
        break;
      }
    }

    const responsePayload = completedResponse
      ? await toModelResponse(this.provider.id, request, completedResponse, {
          endpoint: this.provider.httpUrl(),
          strategy: assembly.reusedContinuation ? 'websocket_delta' : 'websocket_full_replay',
          reusedContinuation: assembly.reusedContinuation
        })
      : fallbackStreamResponse(this.provider.id, request, content, reasoning, reasoningSummary, toolCalls, {
          strategy: assembly.reusedContinuation ? 'websocket_delta' : 'websocket_full_replay',
          reusedContinuation: assembly.reusedContinuation
        });
    const responseToolCalls = dedupeToolCalls([...(responsePayload.toolCalls ?? []), ...toolCalls]);
    const recoveredResponse = parseCodexModelResponse({
      ...responsePayload,
      content: content && responsePayload.content.length === 0 ? content : responsePayload.content,
      terminationReason: responseToolCalls.length > 0 ? 'tool_calls' : responsePayload.terminationReason,
      ...(reasoning && !responsePayload.reasoning ? { reasoning } : {}),
      ...(reasoningSummary && !responsePayload.reasoningSummary ? { reasoningSummary } : {}),
      ...(responseToolCalls.length > 0 ? { toolCalls: responseToolCalls } : {})
    });
    this.rememberContinuationBase(fullRequest, completedResponse);
    yield {
      type: 'done',
      response: recoveredResponse
    };
  }

  private async ensureWebSocket(
    token: string,
    accountId: string,
    signal: AbortSignal | undefined
  ): Promise<CodexWebSocket> {
    if (this.webSocket?.readyState === 1) {
      return this.webSocket;
    }
    const hadSocket = this.webSocket !== undefined;
    this.webSocket?.close();
    this.webSocket = undefined;
    if (hadSocket) {
      this.resetContinuation('websocket_reconnect');
    }
    const headers = this.provider.headersForWebSocket(token, accountId);
    const socket = this.provider.createWebSocket(this.provider.websocketUrl(), {
      headers,
      ...(signal ? { signal } : {})
    });
    await waitForWebSocketOpen(socket, signal);
    this.webSocket = socket;
    return socket;
  }

  private rememberFullHttpRequest(
    request: ModelRequest,
    stream: boolean,
    payload: OpenAICodexResponsesPayload | undefined
  ): void {
    if (!payload) {
      return;
    }
    this.rememberContinuationBase(toCodexResponsesRequest(request, stream), payload);
  }

  private rememberContinuationBase(
    fullRequest: Record<string, unknown>,
    payload: OpenAICodexResponsesPayload | undefined
  ): void {
    if (!payload?.id) {
      return;
    }
    this.lastRequest = fullRequest;
    this.lastResponse = {
      responseId: payload.id,
      outputItems: normalizedOutputItems(this.provider.id, payload)
    };
  }
}

function isWebSocketProviderResponseFailure(error: unknown): boolean {
  return (
    error instanceof ModelProviderError &&
    error.diagnostic.transport === 'websocket' &&
    typeof error.diagnostic.eventType === 'string'
  );
}

function websocketFailureError(
  provider: string,
  error: unknown,
  phase: 'before_model_event' | 'after_model_event'
): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  const causeSummary: Record<string, string | number | boolean> = { phase };
  if (error instanceof CodexWebSocketTransportError) {
    causeSummary.webSocketPhase = error.phase;
    causeSummary.webSocketEvent = error.kind;
    if (error.closeCode !== undefined) {
      causeSummary.closeCode = error.closeCode;
    }
    if (error.closeReason !== undefined) {
      causeSummary.closeReason = error.closeReason;
    }
    if (error.detail !== undefined) {
      causeSummary.detail = error.detail;
    }
  } else {
    causeSummary.message = errorMessage(error);
  }
  return new ModelProviderError({
    provider,
    code: 'provider_unavailable',
    message: `OpenAI Codex WebSocket transport failed: ${errorMessage(error)}`,
    retryable: true,
    cause: error,
    diagnostic: {
      transport: 'websocket',
      causeSummary
    }
  });
}
