import { type BearerTokenProvider } from '@agent-core/auth';
import { ModelProviderError, type ModelRequest, type ModelStreamEvent, type ModelToolCall } from '@agent-core/model';
import { readBoundedResponseText, readJsonSseEvents, waitForResponseOrStatus } from '@agent-core/provider-openai-responses';

import { CONTENT_TYPE_JSON } from './constants.js';
import {
  classifyStatus,
  extractErrorMessage,
  normalizeError,
  parseCodexModelResponse,
  summarizeCodexFailure
} from './errors.js';
import {
  type OpenAICodexResponsesPayload,
  type OpenAICodexSseEvent,
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
import { accountIdFromToken } from './oauth.js';
import { toCodexResponsesRequest } from './request.js';
import { stringValue, throwIfAborted } from './utils.js';

export interface CodexHttpTransportConfig {
  providerId: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  tokenProvider: BearerTokenProvider;
  originator: string;
  statusIntervalMs: number;
}

export async function fetchCodexResponse(config: CodexHttpTransportConfig, request: ModelRequest, stream: boolean): Promise<Response> {
  try {
    const token = await config.tokenProvider.getBearerToken(request.signal);
    const accountId = accountIdFromToken(token);
    const init: RequestInit = {
      method: 'POST',
      headers: requestHeaders(token.token, accountId, stream, config.originator),
      body: JSON.stringify(toCodexResponsesRequest(request, stream))
    };
    if (request.signal) {
      init.signal = request.signal;
    }
    const response = await config.fetchImpl(config.baseUrl, init);
    await throwIfBadResponse(config, response);
    return response;
  } catch (error) {
    throw normalizeError(config.providerId, error);
  }
}

export async function* streamCodexHttp(config: CodexHttpTransportConfig, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
  throwIfAborted(request.signal);
  try {
    const responsePromise = fetchCodexResponse(config, request, true);
    const startedAt = Date.now();
    let response: Response | undefined;
    while (!response) {
      const result = await waitForResponseOrStatus(responsePromise, config.statusIntervalMs, request.signal);
      if (result.type === 'response') {
        response = result.response;
      } else {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
        yield { type: 'status', message: `Waiting for OpenAI Codex stream response (${String(elapsedSeconds)}s).` };
      }
    }

    if (!response.body) {
      throw new ModelProviderError({
        provider: config.providerId,
        code: 'malformed_response',
        message: 'OpenAI Codex streaming response did not include a readable body.'
      });
    }

    let content = '';
    let reasoning = '';
    let reasoningSummary = '';
    let completedResponse: OpenAICodexResponsesPayload | undefined;
    const toolCalls: ModelToolCall[] = [];
    const accumulators = new Map<string, StreamingFunctionCallAccumulator>();
    const customAccumulators = new Map<string, StreamingCustomToolCallAccumulator>();

    for await (const event of readSseEvents(response.body, config.providerId)) {
      if (event.type === 'comment') {
        yield { type: 'status', message: `OpenAI Codex stream status: ${event.comment}`, raw: event };
        continue;
      }
      if (event.data === '[DONE]') {
        break;
      }
      const part = event.data;
      const eventType = part.type ?? '';

      if (eventType === 'response.failed') {
        const failure = summarizeCodexFailure(part);
        throw new ModelProviderError({
          provider: config.providerId,
          code: 'provider_unavailable',
          message: `OpenAI Codex response failed: ${failure.message}`,
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

      const toolCall = toolCallFromOutputItem(config.providerId, part.item);
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
      ? toModelResponse(config.providerId, request, completedResponse, { strategy: 'http_full_replay' })
      : fallbackStreamResponse(config.providerId, request, content, reasoning, reasoningSummary, toolCalls, { strategy: 'http_full_replay' });
    const responseToolCalls = dedupeToolCalls([...(responsePayload.toolCalls ?? []), ...toolCalls]);
    const recoveredResponse = parseCodexModelResponse({
      ...responsePayload,
      content: content && responsePayload.content.length === 0 ? content : responsePayload.content,
      terminationReason: responseToolCalls.length > 0 ? 'tool_calls' : responsePayload.terminationReason,
      ...(reasoning && !responsePayload.reasoning ? { reasoning } : {}),
      ...(reasoningSummary && !responsePayload.reasoningSummary ? { reasoningSummary } : {}),
      ...(responseToolCalls.length > 0 ? { toolCalls: responseToolCalls } : {})
    });
    yield { type: 'done', response: recoveredResponse };
  } catch (error) {
    throw normalizeError(config.providerId, error);
  }
}

export function requestHeaders(token: string, accountId: string, stream: boolean, originator: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': CONTENT_TYPE_JSON,
    'OpenAI-Beta': 'responses=experimental',
    'chatgpt-account-id': accountId,
    originator,
    ...(stream ? { accept: 'text/event-stream' } : {})
  };
}

async function throwIfBadResponse(config: CodexHttpTransportConfig, response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const { text: body, truncated } = await readBoundedResponseText(response);
  if (response.status === 401) {
    await config.tokenProvider.invalidate?.('unauthorized');
  }
  const extractedMessage = extractErrorMessage(body);
  throw new ModelProviderError({
    provider: config.providerId,
    code: classifyStatus(response.status, body),
    message: `OpenAI Codex request failed with HTTP ${String(response.status)}: ${extractedMessage}`,
    retryable: response.status === 429 || response.status >= 500,
    diagnostic: {
      transport: 'http_sse',
      causeSummary: {
        status: response.status,
        errorMessage: extractedMessage,
        ...(truncated ? { bodyTruncated: true } : {})
      }
    }
  });
}

function readSseEvents(body: ReadableStream<Uint8Array>, provider: string): AsyncIterable<OpenAICodexSseEvent> {
  return readJsonSseEvents(body, {
    createMalformedError: (message, cause) => new ModelProviderError({ provider, code: 'malformed_response', message: `OpenAI Codex ${message}`, cause })
  });
}
