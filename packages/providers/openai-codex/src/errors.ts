import { AuthError } from '@agent-core/auth';
import {
  ModelContractError,
  ModelProviderError,
  type ModelResponse,
  parseModelResponse,
  type ModelProviderErrorCode,
  type ModelProviderErrorDiagnosticValue
} from '@agent-core/model';
import { decodeResponsesPayload, readBoundedJsonResponse } from '@agent-core/provider-openai-responses';

import { OPENAI_CODEX_PROVIDER_ID } from './constants.js';
import type {
  OpenAICodexOutputItem,
  OpenAICodexResponsesPayload,
  OpenAICodexStreamData
} from './events.js';
import { errorMessage, isAbortError, isJsonObject } from './utils.js';

export async function parseCodexJsonResponse(provider: string, response: Response): Promise<OpenAICodexResponsesPayload> {
  try {
    return decodeResponsesPayload(await readBoundedJsonResponse(response), 'OpenAI Codex response');
  } catch (error) {
    throw new ModelProviderError({
      provider,
      code: 'malformed_response',
      message: `OpenAI Codex response was not valid JSON: ${errorMessage(error)}`,
      cause: error
    });
  }
}

export function normalizeError(provider: string, error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  if (error instanceof ModelContractError) {
    return new ModelProviderError({ provider, code: 'invalid_request', message: error.message, retryable: false, cause: error });
  }
  if (error instanceof AuthError) {
    return new ModelProviderError({
      provider,
      code: authErrorCodeToModelCode(error),
      message: `OpenAI Codex credentials error: ${error.message}`,
      retryable: error.retryable,
      cause: error
    });
  }
  const message = errorMessage(error);
  if (isAbortError(error) || /abort/i.test(message)) {
    return new ModelProviderError({ provider, code: 'aborted', message: `OpenAI Codex request aborted: ${message}`, cause: error });
  }
  return new ModelProviderError({
    provider,
    code: 'provider_unavailable',
    message: `OpenAI Codex request failed: ${message}`,
    retryable: true,
    cause: error
  });
}

export function parseCodexModelResponse(value: unknown): ModelResponse {
  try {
    return parseModelResponse(value);
  } catch (error) {
    if (error instanceof ModelContractError) {
      throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'malformed_response', message: `OpenAI Codex response violated the model contract: ${error.message}`, cause: error });
    }
    throw error;
  }
}

export function classifyStatus(status: number, body: string): ModelProviderErrorCode {
  if (status === 404) return 'model_unavailable';
  if (status === 408 || status === 413 || /context|token|too large/i.test(body)) return 'context_overflow';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 401 || status === 402 || status === 403 || status === 422) return 'invalid_request';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

export function extractErrorMessage(body: string): string {
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

export function summarizeCodexFailure(payload: OpenAICodexStreamData | OpenAICodexResponsesPayload): {
  message: string;
  eventType?: string;
  causeSummary: Record<string, ModelProviderErrorDiagnosticValue>;
} {
  const response = isCodexStreamData(payload) ? payload.response : undefined;
  const payloadIncompleteDetails = payload.incomplete_details;
  const payloadOutput = payload.output;
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

function isCodexStreamData(value: OpenAICodexStreamData | OpenAICodexResponsesPayload): value is OpenAICodexStreamData {
  return typeof value.type === 'string';
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

function summarizedFailureMessage(summary: Record<string, ModelProviderErrorDiagnosticValue>): string {
  const parts = [
    typeof summary.eventType === 'string' ? `event=${summary.eventType}` : '',
    typeof summary.status === 'string' ? `status=${summary.status}` : '',
    typeof summary.responseId === 'string' ? `responseId=${summary.responseId}` : '',
    typeof summary.incompleteReason === 'string' ? `incompleteReason=${summary.incompleteReason}` : ''
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('; ') : 'provider returned a failed response without error details';
}

function firstOutputError(items: readonly OpenAICodexOutputItem[] | undefined): {
  type?: string;
  status?: string;
  message?: string;
  code?: string;
} | undefined {
  for (const item of items ?? []) {
    if (item.status === 'failed' || item.type === 'error' || isJsonObject(item.error)) {
      const error = isJsonObject(item.error) ? item.error : undefined;
      return {
        ...(item.type ? { type: item.type } : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(typeof error?.message === 'string' ? { message: error.message } : {}),
        ...(typeof error?.code === 'string' ? { code: error.code } : {})
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

export function malformedStreamEvent(provider: string, message: string, cause: unknown): ModelProviderError {
  return new ModelProviderError({
    provider,
    code: 'malformed_response',
    message,
    cause
  });
}
