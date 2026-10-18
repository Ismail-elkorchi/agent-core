import { parseJsonObject } from '@agent-core/json';
import { classifyModelHttpFailure, type ModelProviderError, type ModelUsage } from '@agent-core/model';

export const DEFAULT_SSE_BUFFER_BYTES = 1_048_576;
export const DEFAULT_DIAGNOSTIC_BODY_BYTES = 65_536;
export const DEFAULT_JSON_BODY_BYTES = 33_554_432;

export type JsonSseEvent<T> =
  | { readonly type: 'comment'; readonly comment: string }
  | { readonly type: 'status'; readonly idleMs: number }
  | { readonly type: 'data'; readonly data: T | '[DONE]' };

export interface JsonSseReaderOptions<T> {
  readonly maxBufferedBytes?: number;
  readonly statusIntervalMs?: number;
  readonly idleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly decodeData: (value: unknown) => T;
  readonly createMalformedError: (message: string, cause?: unknown) => Error;
  readonly createIdleError?: (idleMs: number) => Error;
}

export type ResponseHeaderWait<T> =
  { readonly type: 'response'; readonly response: T } | { readonly type: 'status' };

export interface ResponsesContentPart extends Readonly<Record<string, unknown>> {
  readonly type?: string;
  readonly text?: string;
  readonly output_text?: string;
  readonly summary_text?: string;
}

export interface ResponsesErrorBody extends Readonly<Record<string, unknown>> {
  readonly message?: string;
  readonly type?: string;
  readonly code?: string;
}

export interface ResponsesOutputItem extends Readonly<Record<string, unknown>> {
  readonly id?: string;
  readonly type?: string;
  readonly status?: string;
  readonly role?: string;
  readonly content?: readonly ResponsesContentPart[];
  readonly call_id?: string | null;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly input?: string;
  readonly summary?: readonly ResponsesContentPart[] | string;
  readonly encrypted_content?: string;
  readonly error?: ResponsesErrorBody;
}

export interface ResponsesUsage extends Readonly<Record<string, unknown>> {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: Readonly<Record<string, unknown>> & {
    readonly cached_tokens?: number;
    readonly cache_write_tokens?: number;
  };
  readonly output_tokens_details?: Readonly<Record<string, unknown>> & {
    readonly reasoning_tokens?: number;
  };
}

export function responsesUsage(usage: ResponsesUsage | undefined): ModelUsage | undefined {
  if (usage?.input_tokens === undefined || usage.output_tokens === undefined) return undefined;
  const promptTokens = usage.input_tokens;
  const completionTokens = usage.output_tokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(usage.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cacheReadTokens: usage.input_tokens_details.cached_tokens }),
    ...(usage.input_tokens_details?.cache_write_tokens === undefined
      ? {}
      : { cacheWriteTokens: usage.input_tokens_details.cache_write_tokens }),
    ...(usage.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: usage.output_tokens_details.reasoning_tokens })
  };
}

export interface ResponsesPayload extends Readonly<Record<string, unknown>> {
  readonly id?: string;
  readonly model?: string;
  readonly status?: string;
  readonly output_text?: string;
  readonly output?: readonly ResponsesOutputItem[];
  readonly usage?: ResponsesUsage;
  readonly error?: ResponsesErrorBody;
  readonly incomplete_details?: Readonly<Record<string, unknown>> & { readonly reason?: string };
}

export interface ResponsesStreamData extends ResponsesPayload {
  readonly type: string;
  readonly delta?: string;
  readonly response?: ResponsesPayload;
  readonly item?: ResponsesOutputItem;
  readonly output_index?: number;
  readonly item_id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly input?: string;
}

/** Wait for a response or cancellation, with an optional status tick. */
export function waitForResponseOrStatus<T>(
  response: Promise<T>,
  intervalMs: number | undefined,
  signal?: AbortSignal
): Promise<ResponseHeaderWait<T>> {
  const interval = intervalMs === undefined ? undefined : positiveLimit(intervalMs, 'intervalMs');
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
    const onAbort = () => {
      fail(abortError(signal?.reason));
    };
    const timer =
      interval === undefined
        ? undefined
        : setTimeout(() => {
            finish({ type: 'status' });
          }, interval);
    response.then((value) => {
      finish({ type: 'response', response: value });
    }, fail);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function* readJsonSseEvents<T>(
  body: ReadableStream<Uint8Array>,
  options: JsonSseReaderOptions<T>
): AsyncIterable<JsonSseEvent<T>> {
  const maximum = positiveLimit(options.maxBufferedBytes ?? DEFAULT_SSE_BUFFER_BYTES, 'maxBufferedBytes');
  const statusInterval =
    options.statusIntervalMs === undefined
      ? undefined
      : positiveLimit(options.statusIntervalMs, 'statusIntervalMs');
  const idleTimeout =
    options.idleTimeoutMs === undefined ? undefined : positiveLimit(options.idleTimeoutMs, 'idleTimeoutMs');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  let pendingRead = reader.read();
  let idleStartedAt = Date.now();
  try {
    for (;;) {
      const result = await waitForResponseOrStatus(
        pendingRead,
        statusInterval === undefined && idleTimeout === undefined
          ? undefined
          : Math.min(
              statusInterval ?? idleTimeout ?? 1,
              Math.max(1, (idleTimeout ?? Number.MAX_SAFE_INTEGER) - (Date.now() - idleStartedAt))
            ),
        options.signal
      );
      if (result.type === 'status') {
        const idleMs = Date.now() - idleStartedAt;
        if (idleTimeout !== undefined && idleMs >= idleTimeout) {
          throw (
            options.createIdleError?.(idleMs) ??
            options.createMalformedError(`stream was idle for ${String(idleMs)}ms.`)
          );
        }
        yield { type: 'status', idleMs };
        continue;
      }
      const { value, done } = result.response;
      if (done) {
        finished = true;
        break;
      }
      idleStartedAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      buffer = yield* drainJsonSseBuffer(buffer, maximum, options);
      pendingRead = reader.read();
    }
    buffer += decoder.decode();
    yield* drainJsonSseBuffer(`${buffer}\n\n`, maximum, options);
  } finally {
    if (!finished) {
      try {
        await reader.cancel('SSE reader stopped before the response body completed.');
      } catch {
        /* Preserve the authoritative stream error. */
      }
    }
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
        await reader.cancel('response body exceeded configured bound');
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
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes = DEFAULT_JSON_BODY_BYTES
): Promise<unknown> {
  const result = await readBoundedResponseText(response, maximumBytes);
  if (result.truncated) throw new Error(`JSON response exceeded the ${String(maximumBytes)} byte limit.`);
  return JSON.parse(result.text) as unknown;
}

/** Resolve HTTP retry guidance when the response arrives, not when a later retry starts. */
export function retryAfterDeadline(value: string | null, receivedAt = Date.now()): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds < 0) return undefined;
  const deadline = Number.isFinite(seconds)
    ? Math.ceil(receivedAt + seconds * 1000)
    : Date.parse(value);
  return Number.isSafeInteger(deadline) && deadline >= 0 ? deadline : undefined;
}

/** Decode the shared JSON error envelope without inferring control state from its prose. */
export function decodeHttpFailure(
  status: number,
  body: unknown
): Pick<ModelProviderError, 'message' | 'code' | 'retryable'> {
  const text = typeof body === 'string' ? body : undefined;
  if (text !== undefined)
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Gateways may return plain text or HTML; retain the bounded original diagnostic.
    }
  const envelope = isRecord(body) ? body : undefined;
  const error = isRecord(envelope?.error) ? envelope.error : envelope;
  const metadata = isRecord(error?.metadata) ? error.metadata : undefined;
  const details = isRecord(error?.details) ? error.details : undefined;
  const message =
    typeof error?.message === 'string'
      ? error.message
      : typeof envelope?.error === 'string'
        ? envelope.error
        : text !== undefined && text.length > 0
          ? text
          : 'Provider request failed.';
  if (
    status === 429 &&
    (error?.type === 'insufficient_quota' ||
      error?.code === 'credit_balance_exhausted' ||
      error?.code === 'organization_spend_limit_exceeded' ||
      error?.code === 'project_spend_limit_exceeded' ||
      error?.code === 'organization_usage_limit_exceeded' ||
      details?.error_code === 'enforced_spend_limit_reached')
  ) {
    return { code: 'invalid_request', retryable: false, message };
  }
  return {
    ...classifyModelHttpFailure(
      status,
      error?.code === 'context_length_exceeded' ||
        metadata?.error_type === 'context_length_exceeded'
    ),
    message
  };
}

export function decodeResponsesPayload(value: unknown, label = 'Responses response'): ResponsesPayload {
  const record = requiredRecord(value, label);
  const properties = { ...record };
  delete properties.output;
  delete properties.usage;
  delete properties.error;
  delete properties.incomplete_details;
  const output = optionalArray(record.output, `${label}.output`, decodeResponsesOutputItem);
  const usage = record.usage == null ? undefined : decodeResponsesUsage(record.usage, `${label}.usage`);
  const error = record.error == null ? undefined : decodeResponsesError(record.error, `${label}.error`);
  const incompleteDetails =
    record.incomplete_details == null
      ? undefined
      : decodeIncompleteDetails(record.incomplete_details, `${label}.incomplete_details`);
  return Object.freeze({
    ...properties,
    ...optionalStringProperty(record, 'id', label),
    ...optionalStringProperty(record, 'model', label),
    ...optionalStringProperty(record, 'status', label),
    ...optionalStringProperty(record, 'output_text', label),
    ...(output === undefined ? {} : { output }),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
    ...(incompleteDetails === undefined ? {} : { incomplete_details: incompleteDetails })
  });
}

export function decodeResponsesStreamData(
  value: unknown,
  label = 'Responses stream event'
): ResponsesStreamData {
  const payload = decodeResponsesPayload(value, label);
  const type = requiredString(payload.type, `${label}.type`);
  const response =
    payload.response === undefined
      ? undefined
      : decodeResponsesPayload(payload.response, `${label}.response`);
  if ((type === 'response.completed' || type === 'response.incomplete') && response === undefined) {
    throw new Error(`${label}.response is required for a terminal response event.`);
  }
  const item =
    payload.item === undefined ? undefined : decodeResponsesOutputItem(payload.item, `${label}.item`);
  const outputIndex = optionalNonNegativeInteger(payload.output_index, `${label}.output_index`);
  return Object.freeze({
    ...payload,
    type,
    ...optionalStringProperty(payload, 'delta', label),
    ...(response === undefined ? {} : { response }),
    ...(item === undefined ? {} : { item }),
    ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
    ...optionalStringProperty(payload, 'item_id', label),
    ...optionalStringProperty(payload, 'call_id', label),
    ...optionalStringProperty(payload, 'name', label),
    ...optionalStringProperty(payload, 'arguments', label),
    ...optionalStringProperty(payload, 'input', label)
  });
}

function decodeResponsesOutputItem(value: unknown, label: string): ResponsesOutputItem {
  const record = requiredRecord(value, label);
  const properties = { ...record };
  delete properties.error;
  const content = optionalArray(record.content, `${label}.content`, decodeResponsesContentPart);
  const summary =
    typeof record.summary === 'string'
      ? record.summary
      : optionalArray(record.summary, `${label}.summary`, decodeResponsesContentPart);
  const error = record.error == null ? undefined : decodeResponsesError(record.error, `${label}.error`);
  return Object.freeze({
    ...properties,
    ...optionalStringProperty(record, 'id', label),
    ...optionalStringProperty(record, 'type', label),
    ...optionalStringProperty(record, 'status', label),
    ...optionalStringProperty(record, 'role', label),
    ...(content === undefined ? {} : { content }),
    ...(record.call_id === null && (record.type === 'tool_search_call' || record.type === 'tool_search_output')
      ? { call_id: null } : optionalStringProperty(record, 'call_id', label)),
    ...optionalStringProperty(record, 'name', label),
    ...(record.type === 'tool_search_call' && record.arguments !== undefined
      ? { arguments: parseJsonObject(record.arguments) } : optionalStringProperty(record, 'arguments', label)),
    ...optionalStringProperty(record, 'input', label),
    ...(summary === undefined ? {} : { summary }),
    ...optionalStringProperty(record, 'encrypted_content', label),
    ...(error === undefined ? {} : { error })
  });
}

function decodeResponsesContentPart(value: unknown, label: string): ResponsesContentPart {
  const record = requiredRecord(value, label);
  return Object.freeze({
    ...record,
    ...optionalStringProperty(record, 'type', label),
    ...optionalStringProperty(record, 'text', label),
    ...optionalStringProperty(record, 'output_text', label),
    ...optionalStringProperty(record, 'summary_text', label)
  });
}

function decodeResponsesUsage(value: unknown, label: string): ResponsesUsage {
  const record = requiredRecord(value, label);
  const inputDetails =
    record.input_tokens_details === undefined
      ? undefined
      : decodeTokenDetails(record.input_tokens_details, `${label}.input_tokens_details`, [
          'cached_tokens',
          'cache_write_tokens'
        ]);
  const outputDetails =
    record.output_tokens_details === undefined
      ? undefined
      : decodeTokenDetails(record.output_tokens_details, `${label}.output_tokens_details`, [
          'reasoning_tokens'
        ]);
  return Object.freeze({
    ...record,
    ...optionalIntegerProperty(record, 'input_tokens', label),
    ...optionalIntegerProperty(record, 'output_tokens', label),
    ...optionalIntegerProperty(record, 'total_tokens', label),
    ...(inputDetails === undefined ? {} : { input_tokens_details: inputDetails }),
    ...(outputDetails === undefined ? {} : { output_tokens_details: outputDetails })
  });
}

function decodeTokenDetails(
  value: unknown,
  label: string,
  fields: readonly string[]
): Readonly<Record<string, unknown>> {
  const record = requiredRecord(value, label);
  const decoded: Record<string, unknown> = { ...record };
  for (const field of fields) {
    const number = optionalNonNegativeInteger(record[field], `${label}.${field}`);
    if (number !== undefined) decoded[field] = number;
  }
  return Object.freeze(decoded);
}

function decodeResponsesError(value: unknown, label: string): ResponsesErrorBody {
  const record = requiredRecord(value, label);
  const code = record.code;
  if (code !== undefined && typeof code !== 'string' && typeof code !== 'number')
    throw new Error(`${label}.code must be a string or number.`);
  return Object.freeze({
    ...record,
    ...optionalStringProperty(record, 'message', label),
    ...optionalStringProperty(record, 'type', label),
    ...(code === undefined ? {} : { code: String(code) })
  });
}

function decodeIncompleteDetails(
  value: unknown,
  label: string
): Readonly<Record<string, unknown>> & { readonly reason?: string } {
  const record = requiredRecord(value, label);
  return Object.freeze({ ...record, ...optionalStringProperty(record, 'reason', label) });
}

// Decode on demand so a terminal event can stop consumption before later frames.
function* drainJsonSseBuffer<T>(
  input: string,
  maximum: number,
  options: JsonSseReaderOptions<T>
): Generator<JsonSseEvent<T>, string> {
  let buffer = input;
  for (;;) {
    const boundary = /\r?\n\r?\n/.exec(buffer);
    if (!boundary) {
      assertBounded(buffer, maximum, options);
      return buffer;
    }
    const rawEvent = buffer.slice(0, boundary.index);
    assertBounded(rawEvent, maximum, options);
    buffer = buffer.slice(boundary.index + boundary[0].length);
    const lines = rawEvent.split(/\r?\n/).map((line) => line.trim());
    for (const comment of lines
      .filter((line) => line.startsWith(':'))
      .map((line) => line.slice(1).trim())
      .filter(Boolean))
      yield { type: 'comment', comment };
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    if (data === '[DONE]') {
      yield { type: 'data', data };
      continue;
    }
    try {
      yield { type: 'data', data: options.decodeData(JSON.parse(data) as unknown) };
    } catch (error) {
      throw options.createMalformedError(`SSE event was malformed: ${errorMessage(error)}`, error);
    }
  }
}

function optionalArray<T>(
  value: unknown,
  label: string,
  decode: (value: unknown, label: string) => T
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return Object.freeze(value.map((item, index) => decode(item, `${label}[${String(index)}]`)));
}

function optionalStringProperty(
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): Record<string, string> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string.`);
  return { [key]: value };
}

function optionalIntegerProperty(
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): Record<string, number> {
  const value = optionalNonNegativeInteger(record[key], `${label}.${key}`);
  return value === undefined ? {} : { [key]: value };
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function assertBounded<T>(buffer: string, maximum: number, options: JsonSseReaderOptions<T>): void {
  const bytes = new TextEncoder().encode(buffer).byteLength;
  if (bytes > maximum)
    throw options.createMalformedError(`SSE event exceeded the ${String(maximum)} byte buffer limit.`);
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' ? reason : 'Request aborted.');
  error.name = 'AbortError';
  return error;
}

export {
  responsesInput,
  responsesOutput,
  responsesToolCall,
  responsesPayloadPaths,
  responsesOpaqueProtocolPayloads
} from './model-items.js';
export { responsesTool } from './tools.js';

export { responsesCaller, responsesCallerWire } from './advanced-tools.js';
