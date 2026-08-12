import { parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';

export interface OllamaWireToolCall { readonly function: { readonly name: string; readonly arguments: JsonObject } }
export interface OllamaWireMessage { readonly content?: string; readonly thinking?: string; readonly tool_calls?: readonly OllamaWireToolCall[] }
export interface OllamaWireResponse {
  readonly raw: JsonObject;
  readonly model?: string;
  readonly done?: boolean;
  readonly done_reason?: string;
  readonly message?: OllamaWireMessage;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly total_duration?: number;
  readonly load_duration?: number;
  readonly prompt_eval_duration?: number;
  readonly eval_duration?: number;
  readonly logprobs?: JsonValue;
  readonly error?: string;
}
export interface OllamaShowResponse {
  readonly parameters?: string;
  readonly capabilities?: readonly string[];
  readonly model_info?: JsonObject;
  readonly details?: JsonObject;
  readonly modified_at?: string;
}

export function decodeOllamaWireResponse(value: unknown): OllamaWireResponse {
  const raw = parseJsonObject(value);
  const message = raw.message === undefined ? undefined : decodeMessage(raw.message);
  return Object.freeze({
    raw,
    ...stringField(raw, 'model', 'Ollama response'),
    ...booleanField(raw, 'done', 'Ollama response'),
    ...stringField(raw, 'done_reason', 'Ollama response'),
    ...(message === undefined ? {} : { message }),
    ...numberField(raw, 'prompt_eval_count', 'Ollama response'),
    ...numberField(raw, 'eval_count', 'Ollama response'),
    ...numberField(raw, 'total_duration', 'Ollama response'),
    ...numberField(raw, 'load_duration', 'Ollama response'),
    ...numberField(raw, 'prompt_eval_duration', 'Ollama response'),
    ...numberField(raw, 'eval_duration', 'Ollama response'),
    ...(raw.logprobs === undefined ? {} : { logprobs: raw.logprobs }),
    ...stringField(raw, 'error', 'Ollama response')
  });
}

export function decodeOllamaShowResponse(value: unknown): OllamaShowResponse {
  const raw = parseJsonObject(value);
  const capabilities = raw.capabilities;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string'))) throw new Error('Ollama show response.capabilities must be an array of strings.');
  const modelInfo = ownedObject(raw.model_info, 'Ollama show response.model_info');
  const details = ownedObject(raw.details, 'Ollama show response.details');
  return Object.freeze({
    ...stringField(raw, 'parameters', 'Ollama show response'),
    ...(capabilities === undefined ? {} : { capabilities: Object.freeze(capabilities.map((item) => item)) }),
    ...(modelInfo === undefined ? {} : { model_info: modelInfo }),
    ...(details === undefined ? {} : { details }),
    ...stringField(raw, 'modified_at', 'Ollama show response')
  });
}

function decodeMessage(value: JsonValue): OllamaWireMessage {
  const record = ownedObject(value, 'Ollama response.message');
  if (!record) throw new Error('Ollama response.message must be an object.');
  const toolCalls = record.tool_calls;
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) throw new Error('Ollama response.message.tool_calls must be an array.');
  return Object.freeze({
    ...stringField(record, 'content', 'Ollama response.message'),
    ...stringField(record, 'thinking', 'Ollama response.message'),
    ...(toolCalls === undefined ? {} : { tool_calls: Object.freeze(toolCalls.map(decodeToolCall)) })
  });
}

function decodeToolCall(value: JsonValue, index: number): OllamaWireToolCall {
  const record = ownedObject(value, `Ollama response.message.tool_calls[${String(index)}]`);
  const fn = ownedObject(record?.function, `Ollama response.message.tool_calls[${String(index)}].function`);
  if (!fn || typeof fn.name !== 'string' || fn.name.trim().length === 0) throw new Error(`Ollama response.message.tool_calls[${String(index)}].function.name must be a non-empty string.`);
  const argumentsValue = ownedObject(fn.arguments, `Ollama response.message.tool_calls[${String(index)}].function.arguments`);
  if (!argumentsValue) throw new Error(`Ollama response.message.tool_calls[${String(index)}].function.arguments must be an object.`);
  return Object.freeze({ function: Object.freeze({ name: fn.name, arguments: argumentsValue }) });
}

function ownedObject(value: JsonValue | undefined, label: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isOwnedObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}
function isOwnedObject(value: JsonValue): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function stringField(record: JsonObject, key: string, label: string): Record<string, string> { const value = record[key]; if (value === undefined) return {}; if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string.`); return { [key]: value }; }
function booleanField(record: JsonObject, key: string, label: string): Record<string, boolean> { const value = record[key]; if (value === undefined) return {}; if (typeof value !== 'boolean') throw new Error(`${label}.${key} must be boolean.`); return { [key]: value }; }
function numberField(record: JsonObject, key: string, label: string): Record<string, number> { const value = record[key]; if (value === undefined) return {}; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label}.${key} must be a non-negative finite number.`); return { [key]: value }; }
