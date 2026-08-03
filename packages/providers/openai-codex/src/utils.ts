import { AuthError } from '@agent-core/auth';
import { ModelProviderError } from '@agent-core/model';

import { OPENAI_CODEX_PROVIDER_ID } from './constants.js';

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw new ModelProviderError({
    provider: OPENAI_CODEX_PROVIDER_ID,
    code: 'aborted',
    message: typeof signal.reason === 'string' ? signal.reason : 'OpenAI Codex request aborted.',
    cause: signal.reason
  });
}

export function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const error = new Error('OpenAI Codex request aborted.');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function numericValue(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function parseJsonText(text: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `${label} was not valid JSON: ${errorMessage(error)}`,
      cause: error
    });
  }
}
