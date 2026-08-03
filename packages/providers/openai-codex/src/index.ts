import {
  type BearerToken,
  type BearerTokenProvider,
  CachedBearerTokenProvider,
  type CredentialStore,
  type ProviderAuth
} from '@agent-core/auth';
import {
  assertModelRequestSupported,
  type ModelProvider,
  ModelProviderError,
  type ModelProviderInfo,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall
} from '@agent-core/model';

import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID
} from './constants.js';
import {
  type CodexContinuationResponse,
  normalizedOutputItems,
  prepareCodexWebSocketRequest
} from './continuation.js';
import {
  parseJsonResponse,
  normalizeError,
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
import {
  type OpenAICodexModelProfileDefinition,
  describeOpenAICodexModel
} from './model-profile.js';
import {
  type OpenAICodexDeviceCodeInfo,
  type OpenAICodexDeviceCodeLoginOptions,
  OpenAICodexTokenRefresher,
  loginOpenAICodexDeviceCode,
  accountIdFromToken,
  resolveTokenProvider
} from './oauth.js';
import { toCodexResponsesRequest } from './request.js';
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
import { errorMessage, stringValue, throwIfAborted } from './utils.js';

export {
  OpenAICodexTokenRefresher,
  loginOpenAICodexDeviceCode
};
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
  originator?: string;
  modelProfiles?: Record<string, OpenAICodexModelProfileDefinition>;
}

export class OpenAICodexProvider implements ModelProvider {
  readonly id = OPENAI_CODEX_PROVIDER_ID;
  private readonly tokenProvider: BearerTokenProvider;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transport: OpenAICodexTransport;
  private readonly webSocketFactory: CodexWebSocketFactory;
  private readonly statusIntervalMs: number;
  private readonly originator: string;
  private readonly modelProfiles: Record<string, OpenAICodexModelProfileDefinition>;

  constructor(options: OpenAICodexProviderOptions = {}) {
    this.baseUrl = resolveCodexUrl(options.baseUrl ?? OPENAI_CODEX_BASE_URL);
    this.defaultModel = options.model ?? OPENAI_CODEX_DEFAULT_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.transport = options.transport ?? 'http_sse';
    this.webSocketFactory = options.webSocketFactory ?? defaultCodexWebSocketFactory;
    this.statusIntervalMs = Math.max(1, options.statusIntervalMs ?? 15_000);
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
    return Promise.resolve(describeOpenAICodexModel(model || this.defaultModel, this.modelProfiles));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.createSession().complete(request);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const session = this.createSession();
    if (!session.stream) {
      throw new ModelProviderError({ provider: this.id, code: 'invalid_request', message: 'OpenAI Codex provider session does not support streaming.' });
    }
    yield* session.stream(request);
  }

  async fetchResponse(request: ModelRequest, stream: boolean): Promise<Response> {
    await this.validateRequest(request);
    return fetchCodexResponse(this.httpTransportConfig(), request, stream);
  }

  async *streamHttp(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    await this.validateRequest(request);
    yield* streamCodexHttp(this.httpTransportConfig(), request);
  }

  async validateRequest(request: ModelRequest): Promise<void> {
    try { assertModelRequestSupported(await this.describeModel(request.model), request); }
    catch (error) { throw normalizeError(this.id, error); }
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
      statusIntervalMs: this.statusIntervalMs
    };
  }
}

class OpenAICodexProviderSession implements ModelProviderSession {
  private webSocket: CodexWebSocket | undefined;
  private webSocketFallbackReported = false;
  private lastRequest: Record<string, unknown> | undefined;
  private lastResponse: CodexContinuationResponse | undefined;

  constructor(private readonly provider: OpenAICodexProvider) {}

  retryDisposition(): 'reset_required' { return 'reset_required'; }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      const response = await this.provider.fetchResponse(request, false);
      const payload = await parseJsonResponse<OpenAICodexResponsesPayload>(this.provider.id, response);
      const modelResponse = toModelResponse(this.provider.id, request, payload, { strategy: 'http_full_replay' });
      this.rememberFullHttpRequest(request, false, payload);
      return modelResponse;
    } catch (error) {
      this.resetContinuation('error');
      throw normalizeError(this.provider.id, error);
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    await this.provider.validateRequest(request);
    if (!this.provider.shouldUseWebSocket()) {
      yield* this.streamHttp(request);
      return;
    }

    let emittedModelEvent = false;
    try {
      for await (const event of this.streamWebSocket(request)) {
        if (event.type === 'content' || event.type === 'reasoning' || event.type === 'tool_call') {
          emittedModelEvent = true;
        }
        yield event;
      }
    } catch (error) {
      this.resetContinuation('websocket_error');
      const webSocketError = websocketFailureError(this.provider.id, error, emittedModelEvent ? 'after_model_event' : 'before_model_event');
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
      yield* this.streamHttp(request);
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

  private async *streamHttp(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    for await (const event of this.provider.streamHttp(request)) {
      if (event.type === 'done') {
        this.rememberFullHttpRequest(request, true, event.response.raw as OpenAICodexResponsesPayload | undefined);
        yield event;
        continue;
      }
      yield event;
    }
  }

  private async *streamWebSocket(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    throwIfAborted(request.signal);
    const token = await this.provider.tokenForRequest(request.signal);
    const accountId = this.provider.codexAccountId(token);
    const socket = await this.ensureWebSocket(token.token, accountId, request.signal);
    const fullRequest = toCodexResponsesRequest(request, true);
    const prepared = prepareCodexWebSocketRequest(fullRequest, this.lastRequest, this.lastResponse);
    const wireRequest = {
      type: 'response.create',
      ...prepared.request
    };
    const streamEvents = readCodexWebSocketEvents(socket, request.signal);
    await sendWebSocketJson(socket, wireRequest, request.signal);

    let content = '';
    let reasoning = '';
    let reasoningSummary = '';
    let completedResponse: OpenAICodexResponsesPayload | undefined;
    const toolCalls: ModelToolCall[] = [];
    const accumulators = new Map<string, StreamingFunctionCallAccumulator>();
    const customAccumulators = new Map<string, StreamingCustomToolCallAccumulator>();

    for await (const part of streamEvents) {
      const eventType = part.type ?? '';
      if (eventType === 'response.failed' || eventType === 'error') {
        const failure = summarizeCodexFailure(part);
        const causeSummary = {
          ...failure.causeSummary,
          continuationStrategy: prepared.reusedContinuation ? 'websocket_delta' : 'websocket_full_replay',
          reusedContinuation: prepared.reusedContinuation,
          ...(prepared.reusedContinuation && this.lastResponse
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

      const toolCall = toolCallFromOutputItem(this.provider.id, part.item);
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

      if (eventType === 'response.completed' || eventType === 'response.incomplete') {
        break;
      }
    }

    const responsePayload = completedResponse
      ? toModelResponse(this.provider.id, request, completedResponse, {
        strategy: prepared.reusedContinuation ? 'websocket_delta' : 'websocket_full_replay',
        reusedContinuation: prepared.reusedContinuation
      })
      : fallbackStreamResponse(this.provider.id, request, content, reasoning, reasoningSummary, toolCalls, {
        strategy: prepared.reusedContinuation ? 'websocket_delta' : 'websocket_full_replay',
        reusedContinuation: prepared.reusedContinuation
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
    this.rememberPreparedRequest(fullRequest, recoveredResponse.raw as OpenAICodexResponsesPayload | undefined);
    yield {
      type: 'done',
      response: recoveredResponse
    };
  }

  private async ensureWebSocket(token: string, accountId: string, signal: AbortSignal | undefined): Promise<CodexWebSocket> {
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

  private rememberFullHttpRequest(request: ModelRequest, stream: boolean, payload: OpenAICodexResponsesPayload | undefined): void {
    if (!payload) {
      return;
    }
    this.rememberPreparedRequest(toCodexResponsesRequest(request, stream), payload);
  }

  private rememberPreparedRequest(fullRequest: Record<string, unknown>, payload: OpenAICodexResponsesPayload | undefined): void {
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
  return error instanceof ModelProviderError
    && error.diagnostic.transport === 'websocket'
    && typeof error.diagnostic.eventType === 'string';
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
