import { createRequire } from 'node:module';

import { ModelProviderError } from '@agent-core/model';
import { decodeResponsesStreamData } from '@agent-core/provider-openai-responses';

import {
  CONTENT_TYPE_JSON,
  OPENAI_CODEX_PROVIDER_ID,
  RESPONSES_WEBSOCKETS_BETA
} from './constants.js';
import { malformedStreamEvent } from './errors.js';
import type { OpenAICodexStreamData } from './events.js';
import {
  abortError,
  errorMessage,
  isJsonObject,
  stringValue,
  stripTrailingSlash,
  throwIfAborted
} from './utils.js';

const require = createRequire(import.meta.url);
const HeaderWebSocket = require('ws') as typeof import('ws').WebSocket;
const MAX_INBOUND_FRAME_BYTES = 1_048_576;
const MAX_QUEUED_EVENTS = 1_024;

export type CodexWebSocketFactory = (url: string, options: CodexWebSocketOptions) => CodexWebSocket;

export interface CodexWebSocketOptions {
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface CodexWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void, options?: { once?: boolean }): void;
  addEventListener(type: 'error', listener: (event: unknown) => void, options?: { once?: boolean }): void;
  addEventListener(type: 'close', listener: (event: { code?: number; reason?: string }) => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'error', listener: (event: unknown) => void): void;
  removeEventListener(type: 'close', listener: (event: { code?: number; reason?: string }) => void): void;
}

export type CodexWebSocketFailurePhase = 'connect' | 'send' | 'stream';
export type CodexWebSocketFailureKind = 'error' | 'close' | 'not_open';

export class CodexWebSocketTransportError extends Error {
  readonly phase: CodexWebSocketFailurePhase;
  readonly kind: CodexWebSocketFailureKind;
  readonly closeCode: number | undefined;
  readonly closeReason: string | undefined;
  readonly detail: string | undefined;

  constructor(
    message: string,
    options: {
      phase: CodexWebSocketFailurePhase;
      kind: CodexWebSocketFailureKind;
      closeCode?: number;
      closeReason?: string;
      detail?: string;
      cause?: unknown;
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CodexWebSocketTransportError';
    this.phase = options.phase;
    this.kind = options.kind;
    this.closeCode = options.closeCode;
    this.closeReason = options.closeReason;
    this.detail = options.detail;
  }
}

export function defaultCodexWebSocketFactory(url: string, options: CodexWebSocketOptions): CodexWebSocket {
  const socket = new HeaderWebSocket(url, [], {
    headers: options.headers,
    followRedirects: true
  });
  if (options.signal) {
    const abort = () => {
      socket.terminate();
    };
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
    };
    if (options.signal.aborted) {
      abort();
    } else {
      options.signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('close', cleanup, { once: true });
      socket.addEventListener('error', cleanup, { once: true });
    }
  }
  return socket;
}

export function websocketHeaders(token: string, accountId: string, originator: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': CONTENT_TYPE_JSON,
    'OpenAI-Beta': RESPONSES_WEBSOCKETS_BETA,
    'chatgpt-account-id': accountId,
    originator
  };
}

export function resolveCodexUrl(baseUrl: string): string {
  const normalized = stripTrailingSlash(baseUrl);
  if (normalized.endsWith('/codex/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/codex')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: `OpenAI Codex WebSocket URL must use http, https, ws, or wss: ${httpUrl}`
    });
  }
  return url.toString();
}

export async function waitForWebSocketOpen(socket: CodexWebSocket, signal: AbortSignal | undefined): Promise<void> {
  if (socket.readyState === 1) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event: unknown) => {
      cleanup();
      const detail = webSocketEventMessage(event);
      reject(new CodexWebSocketTransportError(`WebSocket connection failed: ${detail}`, {
        phase: 'connect',
        kind: 'error',
        detail,
        cause: event
      }));
    };
    const onClose = (event: { code?: number; reason?: string }) => {
      cleanup();
      reject(new CodexWebSocketTransportError(`WebSocket closed before opening: ${webSocketCloseMessage(event)}`, {
        phase: 'connect',
        kind: 'close',
        ...(event.code !== undefined ? { closeCode: event.code } : {}),
        ...(event.reason ? { closeReason: event.reason } : {})
      }));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function sendWebSocketJson(socket: CodexWebSocket, value: unknown, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  if (socket.readyState !== 1) {
    throw new CodexWebSocketTransportError('OpenAI Codex WebSocket is not open.', {
      phase: 'send',
      kind: 'not_open',
      detail: `readyState=${String(socket.readyState)}`
    });
  }
  socket.send(JSON.stringify(value));
  return Promise.resolve();
}

export function readCodexWebSocketEvents(socket: CodexWebSocket, signal: AbortSignal | undefined): AsyncIterable<OpenAICodexStreamData> {
  const queue: (OpenAICodexStreamData | Error)[] = [];
  let decoding = Promise.resolve();
  let overflowed = false;
  let wake: (() => void) | undefined;
  const push = (item: OpenAICodexStreamData | Error) => {
    if (queue.length >= MAX_QUEUED_EVENTS && !overflowed) {
      overflowed = true;
      queue.length = 0;
      queue.push(malformedStreamEvent(OPENAI_CODEX_PROVIDER_ID, `OpenAI Codex WebSocket exceeded the ${String(MAX_QUEUED_EVENTS)} event queue limit.`, undefined));
      socket.close();
      wake?.();
      wake = undefined;
      return;
    }
    if (overflowed) return;
    queue.push(item);
    wake?.();
    wake = undefined;
  };
  const onMessage = (event: { data: unknown }) => {
    decoding = decoding.then(() => textFromWebSocketData(event.data))
      .then((text) => {
        if (new TextEncoder().encode(text).byteLength > MAX_INBOUND_FRAME_BYTES) throw malformedStreamEvent(OPENAI_CODEX_PROVIDER_ID, `OpenAI Codex WebSocket frame exceeded the ${String(MAX_INBOUND_FRAME_BYTES)} byte limit.`, undefined);
        parseCodexWebSocketText(text).forEach(push);
      })
      .catch((error: unknown) => {
        push(error instanceof Error ? error : new Error(String(error)));
      });
  };
  const onError = (event: unknown) => {
    const detail = webSocketEventMessage(event);
    push(new CodexWebSocketTransportError(`WebSocket error: ${detail}`, {
      phase: 'stream',
      kind: 'error',
      detail,
      cause: event
    }));
  };
  const onClose = (event: { code?: number; reason?: string }) => {
    push(new CodexWebSocketTransportError(`WebSocket closed: ${webSocketCloseMessage(event)}`, {
      phase: 'stream',
      kind: 'close',
      ...(event.code !== undefined ? { closeCode: event.code } : {}),
      ...(event.reason ? { closeReason: event.reason } : {})
    }));
  };
  const onAbort = () => {
    push(abortError());
  };
  socket.addEventListener('message', onMessage);
  socket.addEventListener('error', onError);
  socket.addEventListener('close', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          while (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const item = queue.shift();
          if (!item) {
            continue;
          }
          if (item instanceof Error) {
            throw item;
          }
          yield item;
          if (item.type === 'response.completed' || item.type === 'response.incomplete' || item.type === 'response.failed' || item.type === 'error') {
            return;
          }
        }
      } finally {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  };
}

function parseCodexWebSocketText(text: string): OpenAICodexStreamData[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return decodeResponsesStreamData(parsed, 'OpenAI Codex WebSocket event');
      } catch (error) {
        throw malformedStreamEvent(OPENAI_CODEX_PROVIDER_ID, `OpenAI Codex WebSocket event was not valid JSON: ${errorMessage(error)}`, error);
      }
    });
}

async function textFromWebSocketData(data: unknown): Promise<string> {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (isBlobLike(data)) {
    return data.text();
  }
  return String(data);
}

function isBlobLike(value: unknown): value is { text(): Promise<string> } {
  return isJsonObject(value) && typeof value.text === 'function';
}

function webSocketEventMessage(event: unknown): string {
  if (event instanceof Error) {
    return event.message;
  }
  if (!isJsonObject(event)) {
    return String(event);
  }
  const parts: string[] = [];
  const eventName = typeof event.constructor.name === 'string' && event.constructor.name !== 'Object'
    ? event.constructor.name
    : undefined;
  if (eventName) {
    parts.push(eventName);
  }
  const type = stringValue(event.type);
  if (type) {
    parts.push(`type=${type}`);
  }
  const message = stringValue(event.message);
  if (message) {
    parts.push(`message=${message}`);
  }
  const code = stringValue(event.code) || (typeof event.code === 'number' ? String(event.code) : '');
  if (code) {
    parts.push(`code=${code}`);
  }
  const reason = stringValue(event.reason);
  if (reason) {
    parts.push(`reason=${reason}`);
  }
  if ('wasClean' in event && typeof event.wasClean === 'boolean') {
    parts.push(`wasClean=${String(event.wasClean)}`);
  }
  const nestedError = event.error;
  if (nestedError instanceof Error) {
    parts.push(`error=${nestedError.message}`);
  } else if (typeof nestedError === 'string' && nestedError.length > 0) {
    parts.push(`error=${nestedError}`);
  }
  return parts.length > 0 ? parts.join('; ') : '[opaque WebSocket event]';
}

function webSocketCloseMessage(event: { code?: number; reason?: string }): string {
  const code = String(event.code ?? 'unknown');
  const reason = event.reason?.trim();
  return reason ? `${code} ${reason}` : code;
}
