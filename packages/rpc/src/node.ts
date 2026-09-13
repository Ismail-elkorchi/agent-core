import { Readable, Writable } from 'node:stream';
import * as z from 'zod';

const requestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  params: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional()
});
type Id = string | number | null;
type Response = { readonly jsonrpc: '2.0'; readonly id: Id } & (
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
);

import { RpcError, type RpcMethod } from './index.js';

export interface JsonlRpcOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostic: (message: string) => void;
  readonly methods: Readonly<Record<string, RpcMethod>>;
  readonly onClose: () => Promise<void>;
}

/** One local connection. Request IDs correlate delivery; they never deduplicate application effects. */
export class JsonlRpcConnection {
  private readonly requests = new Set<Promise<void>>();
  private readonly requestIds = new Set<Id>();
  private activeRequests = 0;
  private readonly methods: ReadonlyMap<string, RpcMethod>;
  private outputDelivery: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private stopping = false;
  private closed = false;
  private failure: Error | undefined;

  private readonly outputError = (error: Error): void => {
    this.fail(error);
  };
  constructor(private readonly options: JsonlRpcOptions) {
    this.methods = new Map(Object.entries(options.methods));
    options.output.on('error', this.outputError);
  }

  async run(): Promise<void> {
    try {
      for await (const frame of readFrames(this.options.input)) {
        if (this.stopping) break;
        let value: unknown;
        try {
          value = JSON.parse(frame);
        } catch {
          await this.send(errorResponse(null, -32700, 'Parse error'));
          continue;
        }
        if (this.requests.size >= 32) {
          const response = overloadResponse(value);
          if (response !== undefined) await this.send(response);
          continue;
        }
        const pending = this.process(value)
          .catch((cause: unknown) => {
            this.fail(cause);
          })
          .finally(() => this.requests.delete(pending));
        this.requests.add(pending);
      }
    } catch (cause) {
      if (!this.stopping) this.fail(cause);
    } finally {
      this.stopping = true;
      const deadline = setTimeout(() => {
        if (this.queuedBytes > 0)
          this.options.output.destroy(new Error('RPC output did not drain during shutdown.'));
      }, 1000);
      try {
        await this.options.onClose();
      } catch (cause) {
        this.fail(cause);
      }
      await Promise.all(this.requests);
      await this.outputDelivery;
      clearTimeout(deadline);
      this.options.output.off('error', this.outputError);
      this.closed = true;
    }
    if (this.failure !== undefined) throw this.failure;
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', method, params });
  }

  /** Stop accepting requests. Already admitted responses drain after application shutdown. */
  stop(): void {
    this.stopping = true;
    this.options.input.destroy();
  }

  private async process(value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      if (value.length === 0 || value.length > 32) {
        await this.send(errorResponse(null, -32600, 'A batch must contain between 1 and 32 requests.'));
        return;
      }
      const responses = (await Promise.all(value.map((request) => this.dispatch(request)))).filter(
        (response) => response !== undefined
      );
      if (responses.length > 0) await this.send(responses);
    } else {
      const response = await this.dispatch(value);
      if (response !== undefined) await this.send(response);
    }
  }

  private async dispatch(value: unknown): Promise<Response | undefined> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return errorResponse(null, -32600, 'Invalid Request');
    const request = parsed.data;
    if (this.activeRequests >= 32)
      return request.id === undefined
        ? undefined
        : errorResponse(request.id, -32001, 'Too many concurrent requests.');
    if (request.id !== undefined && this.requestIds.has(request.id))
      return errorResponse(request.id, -32001, 'Request ID is already in flight.');
    if (request.id !== undefined) this.requestIds.add(request.id);
    this.activeRequests++;
    try {
      const method = this.methods.get(request.method);
      if (method === undefined) throw new RpcError(-32601, 'Method not found');
      const result = await method.invoke(request.params);
      return request.id === undefined
        ? undefined
        : { jsonrpc: '2.0', id: request.id, result: result ?? null };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (request.id === undefined) {
        this.options.diagnostic(error.message);
        return undefined;
      }
      return errorResponse(request.id, error instanceof RpcError ? error.code : -32000, error.message);
    } finally {
      this.activeRequests--;
      if (request.id !== undefined) this.requestIds.delete(request.id);
    }
  }

  private send(value: unknown): Promise<void> {
    if (this.closed || this.failure !== undefined)
      return Promise.reject(this.failure ?? new Error('RPC connection is closed.'));
    let frame: string;
    try {
      frame = `${JSON.stringify(value)}\n`;
    } catch (cause) {
      return Promise.reject(
        new RpcError(-32603, cause instanceof Error ? cause.message : 'Result cannot be serialized.')
      );
    }
    const bytes = Buffer.byteLength(frame);
    if (bytes > 8 * 1024 * 1024 || this.queuedBytes + bytes > 16 * 1024 * 1024) {
      const error = new Error(
        'RPC output capacity exceeded; reconnect and read authoritative application state.'
      );
      this.fail(error);
      return Promise.reject(error);
    }
    this.queuedBytes += bytes;
    const delivered = this.outputDelivery
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.failure !== undefined) {
              reject(this.failure);
              return;
            }
            const output = this.options.output;
            const closed = () => {
              finish(new Error('RPC output closed before delivery.'));
            };
            const finish = (error?: Error | null): void => {
              output.off('error', finish);
              output.off('close', closed);
              if (error == null) resolve();
              else reject(error);
            };
            output.once('error', finish);
            output.once('close', closed);
            output.write(frame, finish);
          })
      )
      .finally(() => {
        this.queuedBytes -= bytes;
      });
    this.outputDelivery = delivered.catch((cause: unknown) => {
      this.fail(cause);
    });
    return delivered;
  }

  private fail(cause: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = cause instanceof Error ? cause : new Error(String(cause));
    this.options.diagnostic(this.failure.message);
    this.stop();
  }
}

async function* readFrames(input: Readable): AsyncGenerator<string> {
  let parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) throw new Error('JSONL input must supply UTF-8 bytes.');
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index);
      bytes += part.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('JSONL request exceeds 8 MiB.');
      parts.push(part);
      yield new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes));
      parts = [];
      bytes = 0;
      start = index + 1;
    }
    if (start < chunk.length) {
      const part = chunk.subarray(start);
      bytes += part.byteLength;
      parts.push(part);
    }
    if (bytes > 8 * 1024 * 1024) throw new Error('JSONL request exceeds 8 MiB.');
  }
  if (bytes !== 0) throw new Error('EOF before the JSONL request terminator.');
}

function errorResponse(id: Id, code: number, message: string): Response {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function overloadResponse(value: unknown): Response | readonly Response[] | undefined {
  const respond = (value: unknown): Response | undefined => {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return errorResponse(null, -32600, 'Invalid Request');
    return parsed.data.id === undefined
      ? undefined
      : errorResponse(parsed.data.id, -32001, 'Too many concurrent requests.');
  };
  if (!Array.isArray(value)) return respond(value);
  if (value.length === 0 || value.length > 32) return errorResponse(null, -32600, 'Invalid batch.');
  const responses = value.map(respond).filter((response) => response !== undefined);
  return responses.length === 0 ? undefined : responses;
}
