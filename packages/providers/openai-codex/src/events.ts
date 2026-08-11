import {
  ModelProviderError,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage
} from '@agent-core/model';
import { normalizeJsonSafe, parseJsonObject, type JsonObject } from '@agent-core/json';

import { parseCodexModelResponse, summarizeCodexFailure } from './errors.js';
import { errorMessage, isJsonObject, stringValue } from './utils.js';

export interface OpenAICodexResponsesPayload {
  id?: string;
  model?: string;
  status?: string;
  output_text?: string;
  output?: OpenAICodexOutputItem[];
  usage?: OpenAICodexUsage;
  error?: OpenAICodexErrorBody;
  incomplete_details?: {
    reason?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenAICodexOutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  content?: OpenAICodexContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  summary?: OpenAICodexContentPart[] | string;
  encrypted_content?: string;
  [key: string]: unknown;
}

export interface OpenAICodexContentPart {
  type?: string;
  text?: string;
  output_text?: string;
  summary_text?: string;
  [key: string]: unknown;
}

export interface OpenAICodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; [key: string]: unknown };
  output_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface OpenAICodexErrorBody {
  message?: string;
  type?: string;
  code?: string;
  [key: string]: unknown;
}

export interface OpenAICodexStreamData {
  type?: string;
  delta?: string;
  response?: OpenAICodexResponsesPayload;
  item?: OpenAICodexOutputItem;
  output_index?: number;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  error?: OpenAICodexErrorBody;
  [key: string]: unknown;
}

export type OpenAICodexSseEvent =
  | { type: 'comment'; comment: string }
  | { type: 'data'; data: OpenAICodexStreamData | '[DONE]' };

export interface StreamingFunctionCallAccumulator {
  id?: string;
  callId?: string;
  name?: string;
  argumentsText: string;
  emittedKey?: string;
}

export interface StreamingCustomToolCallAccumulator {
  id?: string;
  callId?: string;
  name?: string;
  inputText: string;
  emittedKey?: string;
}

export function toModelResponse(
  provider: string,
  request: ModelRequest,
  payload: OpenAICodexResponsesPayload,
  transport: { strategy: string; reusedContinuation?: boolean } = { strategy: 'http_full_replay' }
): ModelResponse {
  if (payload.error) {
    const failure = summarizeCodexFailure(payload);
    throw new ModelProviderError({
      provider,
      code: 'provider_unavailable',
      message: `OpenAI Codex response contained an error: ${failure.message}`,
      retryable: true,
      cause: payload,
      diagnostic: {
        transport: transport.strategy,
        ...(failure.eventType ? { eventType: failure.eventType } : {}),
        causeSummary: failure.causeSummary
      }
    });
  }
  if (payload.status !== 'completed' && payload.status !== 'incomplete') {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `OpenAI Codex returned non-terminal response status: ${String(payload.status)}.`,
      cause: payload
    });
  }
  const content = typeof payload.output_text === 'string' ? payload.output_text : contentFromOutput(payload.output ?? []);
  const toolCalls = normalizeToolCalls(provider, payload.output ?? []);
  const reasoningSummary = reasoningSummaryFromOutput(payload.output ?? []);
  const usage = normalizeUsage(payload.usage);
  const providerTerminationReason = payload.incomplete_details?.reason ?? payload.status;
  return parseCodexModelResponse({
    content,
    model: payload.model ?? request.model,
    provider,
    terminationReason: normalizeOpenAITermination(payload, toolCalls.length > 0),
    ...(providerTerminationReason ? { providerTerminationReason } : {}),
    ...(payload.id ? { requestId: payload.id } : {}),
    ...(usage ? { usage } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw: normalizeJsonSafe(payload).value,
    transport: responseTransport(provider, transport.strategy, payload.id, transport)
  });
}

function normalizeOpenAITermination(
  payload: OpenAICodexResponsesPayload,
  hasToolCalls: boolean
): ModelResponse['terminationReason'] {
  if (hasToolCalls) {
    return 'tool_calls';
  }
  if (payload.incomplete_details?.reason === 'max_output_tokens') {
    return 'output_limit';
  }
  if (payload.incomplete_details?.reason === 'content_filter') {
    return 'content_filter';
  }
  if (payload.status === 'completed') {
    return 'stop';
  }
  return 'unknown';
}

export function fallbackStreamResponse(
  provider: string,
  request: ModelRequest,
  content: string,
  reasoning: string,
  reasoningSummary: string,
  toolCalls: ModelToolCall[],
  transport: { strategy: string; reusedContinuation?: boolean } = { strategy: 'http_full_replay' }
): ModelResponse {
  return parseCodexModelResponse({
    content,
    model: request.model,
    provider,
    terminationReason: 'unknown',
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
    ...(toolCalls.length > 0 ? { toolCalls: dedupeToolCalls(toolCalls) } : {}),
    transport: responseTransport(provider, transport.strategy, undefined, transport)
  });
}

export function contentFromOutput(output: OpenAICodexOutputItem[]): string {
  return output
    .filter((item) => item.type === 'message' || item.role === 'assistant')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? part.output_text ?? '')
    .join('');
}

export function toolCallFromOutputItem(provider: string, item: OpenAICodexOutputItem | undefined): ModelToolCall | undefined {
  if (item?.type === 'custom_tool_call') {
    if (!item.name) {
      throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenAI Codex custom_tool_call item did not include name.' });
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
    throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenAI Codex function_call item did not include name.' });
  }
  return {
    ...(item.call_id ? { id: item.call_id } : item.id ? { id: item.id } : {}),
    type: 'function',
    name: item.name,
    input: { kind: 'json', value: parseToolArguments(provider, item.arguments) }
  };
}

export function mergeStreamingFunctionCallParts(accumulators: Map<string, StreamingFunctionCallAccumulator>, part: OpenAICodexStreamData): ModelToolCall[] {
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

export function mergeStreamingCustomToolCallParts(accumulators: Map<string, StreamingCustomToolCallAccumulator>, part: OpenAICodexStreamData): ModelToolCall[] {
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

export function addUniqueToolCall(toolCalls: ModelToolCall[], toolCall: ModelToolCall): boolean {
  const key = toolCallIdentity(toolCall);
  if (toolCalls.some((existing) => toolCallIdentity(existing) === key)) {
    return false;
  }
  toolCalls.push(toolCall);
  return true;
}

export function dedupeToolCalls(toolCalls: ModelToolCall[]): ModelToolCall[] {
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

export function reasoningChannelFromEvent(eventType: string): 'summary' | 'reasoning' | undefined {
  if (eventType === 'response.reasoning_summary_text.delta') {
    return 'summary';
  }
  if (eventType === 'response.reasoning_text.delta' || eventType === 'response.reasoning.delta') {
    return 'reasoning';
  }
  return undefined;
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

function reasoningSummaryFromOutput(output: OpenAICodexOutputItem[]): string {
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

function normalizeToolCalls(provider: string, output: OpenAICodexOutputItem[]): ModelToolCall[] {
  return output
    .map((item) => toolCallFromOutputItem(provider, item))
    .filter((toolCall): toolCall is ModelToolCall => toolCall !== undefined);
}

function parseToolArguments(provider: string, value: string | undefined): JsonObject {
  if (value === undefined || value.length === 0) {
    return Object.freeze({});
  }
  try {
    return parseJsonObject(JSON.parse(value));
  } catch (error) {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `OpenAI Codex tool call arguments were not valid JSON: ${errorMessage(error)}`,
      cause: error
    });
  }
  throw new ModelProviderError({ provider, code: 'malformed_response', message: 'OpenAI Codex tool call arguments must decode to a JSON object.' });
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
      input: { kind: 'json', value: parseJsonObject(parsed) }
    };
  } catch {
    return undefined;
  }
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

function normalizeUsage(usage: OpenAICodexUsage | undefined): ModelUsage | undefined {
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
