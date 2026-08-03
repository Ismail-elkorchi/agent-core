import { type OpenAICodexResponsesPayload, contentFromOutput, toolCallFromOutputItem } from './events.js';
import { toCodexFunctionCallInput } from './request.js';
import { isJsonObject } from './utils.js';

export interface CodexContinuationResponse {
  responseId: string;
  outputItems: unknown[];
}

export function prepareCodexWebSocketRequest(
  fullRequest: Record<string, unknown>,
  previousRequest: Record<string, unknown> | undefined,
  previousResponse: CodexContinuationResponse | undefined
): { request: Record<string, unknown>; reusedContinuation: boolean } {
  if (!previousRequest || !previousResponse) {
    return { request: fullRequest, reusedContinuation: false };
  }
  if (!requestPropertiesMatch(previousRequest, fullRequest)) {
    return { request: fullRequest, reusedContinuation: false };
  }
  const previousInput = arrayValue(previousRequest.input);
  const currentInput = arrayValue(fullRequest.input);
  const afterPreviousInput = stripPrefix(currentInput, previousInput);
  if (!afterPreviousInput) {
    return { request: fullRequest, reusedContinuation: false };
  }
  const incrementalInput = stripPrefix(afterPreviousInput, previousResponse.outputItems);
  if (!incrementalInput || incrementalInput.length === 0) {
    return { request: fullRequest, reusedContinuation: false };
  }
  return {
    request: {
      ...fullRequest,
      previous_response_id: previousResponse.responseId,
      input: incrementalInput
    },
    reusedContinuation: true
  };
}

export function normalizedOutputItems(provider: string, payload: OpenAICodexResponsesPayload): unknown[] {
  const output = payload.output ?? [];
  const items: unknown[] = [];
  let sawAssistantMessage = false;
  for (const item of output) {
    if (item.type === 'reasoning') {
      items.push(item);
      continue;
    }
    const toolCall = toolCallFromOutputItem(provider, item);
    if (toolCall) {
      items.push(toCodexFunctionCallInput(toolCall));
      continue;
    }
    if (item.type === 'message' || item.role === 'assistant') {
      sawAssistantMessage = true;
      const content = contentFromOutput([item]);
      if (content.length > 0) {
        items.push({ role: 'assistant', content });
      }
    }
  }
  if (!sawAssistantMessage && typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    items.push({ role: 'assistant', content: payload.output_text });
  }
  return items;
}

function requestPropertiesMatch(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => key !== 'input'));
  for (const key of keys) {
    if (stableJson(left[key]) !== stableJson(right[key])) {
      return false;
    }
  }
  return true;
}

function stripPrefix(items: unknown[], prefix: unknown[]): unknown[] | undefined {
  if (prefix.length > items.length) {
    return undefined;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (stableJson(items[index]) !== stableJson(prefix[index])) {
      return undefined;
    }
  }
  return items.slice(prefix.length);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
