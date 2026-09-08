import WebSocket from 'ws';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { nativeFailure as failure } from './native-output.js';

export interface OpenAIResponsesWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(type: 'open' | 'close', listener: () => void): unknown;
  on(type: 'message', listener: (data: unknown) => void): unknown;
  on(type: 'error', listener: (error: Error) => void): unknown;
  removeAllListeners(): unknown;
}
export type OpenAIResponsesWebSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>
) => OpenAIResponsesWebSocket;
export const defaultOpenAIResponsesWebSocketFactory: OpenAIResponsesWebSocketFactory = (url, headers) =>
  new WebSocket(url, { headers });

/** One bounded reader owns all response lifetimes on this native connection. */
export class NativeResponsesConnection {
  private socket: OpenAIResponsesWebSocket | undefined;
  private readonly queue: JsonObject[] = [];
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  constructor(
    private readonly host: {
      endpoint(): string;
      nativeHeaders(signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
    },
    private readonly factory: OpenAIResponsesWebSocketFactory,
    private readonly idleTimeoutMs: number,
    private readonly onFailure: (error: Error) => void
  ) {}
  get available(): boolean {
    return this.socket?.readyState === 1;
  }
  send(body: JsonObject): void {
    if (!this.socket || this.failure)
      throw failure('provider_unavailable', 'Native connection is unavailable.');
    this.socket.send(JSON.stringify(body));
  }
  notify(): void {
    if (this.queue.length < 1024) this.queue.push({ type: 'agent.native.wake' });
    this.wake?.();
  }
  close(error: Error): void {
    this.failure = error;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.close();
    }
    this.wake?.();
  }
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket?.readyState === 1) return;
    this.failure = undefined;
    this.queue.length = 0;
    const headers = await this.host.nativeHeaders(signal);
    signal?.throwIfAborted();
    const url = this.host
      .endpoint()
      .replace(/^https:/u, 'wss:')
      .replace(/^http:/u, 'ws:');
    const socket = this.factory(url, headers);
    this.socket = socket;
    socket.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
        if (!text || Buffer.byteLength(text) > 4 * 1024 * 1024 || this.queue.length >= 1024)
          throw failure('malformed_response', 'Native event exceeds the bounded receive queue.');
        this.queue.push(parseJsonObject(JSON.parse(text) as unknown));
        this.wake?.();
      } catch (error) {
        this.onFailure(
          error instanceof Error ? error : failure('malformed_response', 'Malformed native event.')
        );
      }
    });
    socket.on('error', (error) => {
      this.onFailure(error);
    });
    socket.on('close', () => {
      this.onFailure(failure('provider_unavailable', 'Native connection disconnected.'));
    });
    if (socket.readyState === 1) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(failure('provider_unavailable', 'Native connection timed out.'));
        },
        Math.min(this.idleTimeoutMs, 30_000)
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => {
        finish(failure('aborted', 'Native connection aborted.'));
      };
      socket.on('open', () => {
        finish();
      });
      socket.on('error', (error) => {
        finish(error);
      });
      socket.on('close', () => {
        finish(failure('provider_unavailable', 'Native connection closed before opening.'));
      });
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  async next(signal?: AbortSignal): Promise<JsonObject> {
    for (;;) {
      const event = this.queue.shift();
      if (event) return event;
      signal?.throwIfAborted();
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wake = undefined;
          reject(failure('provider_unavailable', 'Native response timed out.'));
        }, this.idleTimeoutMs);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
      });
    }
  }
}
