export const DEFAULT_SSE_BUFFER_BYTES = 1_048_576;
export const DEFAULT_DIAGNOSTIC_BODY_BYTES = 65_536;
export const DEFAULT_JSON_BODY_BYTES = 33_554_432;

export type JsonSseEvent<T extends Record<string, unknown>> =
  | { readonly type: 'comment'; readonly comment: string }
  | { readonly type: 'data'; readonly data: T | '[DONE]' };

export interface JsonSseReaderOptions {
  readonly maxBufferedBytes?: number;
  readonly createMalformedError: (message: string, cause?: unknown) => Error;
}

export type ResponseHeaderWait<T> =
  | { readonly type: 'response'; readonly response: T }
  | { readonly type: 'status' };

/** Races response headers against a status tick without leaking the losing timer. */
export function waitForResponseOrStatus<T>(response: Promise<T>, intervalMs: number, signal?: AbortSignal): Promise<ResponseHeaderWait<T>> {
  const interval = positiveLimit(intervalMs, 'intervalMs');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: ResponseHeaderWait<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => { fail(abortError(signal?.reason)); };
    const timer = setTimeout(() => { finish({ type: 'status' }); }, interval);
    response.then((value) => { finish({ type: 'response', response: value }); }, fail);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function* readJsonSseEvents<T extends Record<string, unknown>>(
  body: ReadableStream<Uint8Array>,
  options: JsonSseReaderOptions
): AsyncIterable<JsonSseEvent<T>> {
  const maximum = positiveLimit(options.maxBufferedBytes ?? DEFAULT_SSE_BUFFER_BYTES, 'maxBufferedBytes');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      assertBounded(buffer, maximum, options);
      const drained = drainJsonSseBuffer<T>(buffer, options);
      buffer = drained.remainder;
      yield* drained.events;
    }
    buffer += decoder.decode();
    assertBounded(buffer, maximum, options);
    const drained = drainJsonSseBuffer<T>(`${buffer}\n\n`, options);
    yield* drained.events;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes = DEFAULT_DIAGNOSTIC_BODY_BYTES
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const maximum = positiveLimit(maximumBytes, 'maximumBytes');
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maximum - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        bytes = maximum;
        truncated = true;
        await reader.cancel('diagnostic response body exceeded configured bound');
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(joined), truncated };
}

export async function readBoundedJsonResponse<T>(response: Response, maximumBytes = DEFAULT_JSON_BODY_BYTES): Promise<T> {
  const result = await readBoundedResponseText(response, maximumBytes);
  if (result.truncated) throw new Error(`JSON response exceeded the ${String(maximumBytes)} byte limit.`);
  return JSON.parse(result.text) as T;
}

function drainJsonSseBuffer<T extends Record<string, unknown>>(
  input: string,
  options: JsonSseReaderOptions
): { readonly events: JsonSseEvent<T>[]; readonly remainder: string } {
  let buffer = input;
  const events: JsonSseEvent<T>[] = [];
  for (;;) {
    const boundary = /\r?\n\r?\n/.exec(buffer);
    if (!boundary) return { events, remainder: buffer };
    const rawEvent = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary[0].length);
    const lines = rawEvent.split(/\r?\n/).map((line) => line.trim());
    for (const comment of lines.filter((line) => line.startsWith(':')).map((line) => line.slice(1).trim()).filter(Boolean)) events.push({ type: 'comment', comment });
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { events.push({ type: 'data', data }); continue; }
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) throw new Error('event data must be a JSON object');
      events.push({ type: 'data', data: parsed as T });
    } catch (error) {
      throw options.createMalformedError(`SSE event was not valid JSON: ${errorMessage(error)}`, error);
    }
  }
}

function assertBounded(buffer: string, maximum: number, options: JsonSseReaderOptions): void {
  const bytes = new TextEncoder().encode(buffer).byteLength;
  if (bytes > maximum) throw options.createMalformedError(`SSE event exceeded the ${String(maximum)} byte buffer limit.`);
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function abortError(reason: unknown): Error { const error = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'Request aborted.'); error.name = 'AbortError'; return error; }
