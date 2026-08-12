export interface OpenRouterModelCatalog { readonly data?: readonly OpenRouterModelRecord[] }
export interface OpenRouterModelRecord {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly context_length?: number | null;
  readonly architecture?: Readonly<Record<string, unknown>> & { readonly input_modalities?: readonly string[]; readonly output_modalities?: readonly string[] };
  readonly pricing?: Readonly<Record<string, string | number | null>>;
  readonly top_provider?: (Readonly<Record<string, unknown>> & { readonly context_length?: number | null; readonly max_completion_tokens?: number | null }) | null;
  readonly supported_parameters?: readonly string[];
  readonly reasoning?: Readonly<Record<string, unknown>> & { readonly supported_efforts?: readonly string[] | null; readonly supports_max_tokens?: boolean; readonly mandatory?: boolean };
}
export interface OpenRouterChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly OpenRouterChoice[];
  readonly usage?: OpenRouterUsage;
  readonly provider?: string;
  readonly error?: Readonly<Record<string, unknown>> & { readonly code?: number | string; readonly message?: string; readonly metadata?: unknown };
}
export interface OpenRouterChoice {
  readonly message?: OpenRouterResponseMessage;
  readonly delta?: OpenRouterResponseMessage;
  readonly finish_reason?: string | null;
}
export interface OpenRouterResponseMessage {
  readonly role?: string;
  readonly content?: string | null | readonly Readonly<Record<string, unknown>>[];
  readonly reasoning?: string | null;
  readonly reasoning_details?: unknown;
  readonly tool_calls?: readonly OpenRouterWireToolCall[];
}
export interface OpenRouterWireToolCall {
  readonly id?: string;
  readonly index?: number;
  readonly type?: string;
  readonly function?: Readonly<Record<string, unknown>> & { readonly name?: string; readonly arguments?: string | Readonly<Record<string, unknown>> };
}
export interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: Readonly<Record<string, unknown>> & { readonly cached_tokens?: number; readonly cache_write_tokens?: number };
  readonly completion_tokens_details?: Readonly<Record<string, unknown>> & { readonly reasoning_tokens?: number };
}

export function decodeOpenRouterModelCatalog(value: unknown): OpenRouterModelCatalog {
  const record = object(value, 'OpenRouter model catalog');
  return Object.freeze({ ...(record.data === undefined ? {} : { data: array(record.data, 'OpenRouter model catalog.data', decodeModelRecord) }) });
}

export function decodeOpenRouterChatResponse(value: unknown): OpenRouterChatResponse {
  const record = object(value, 'OpenRouter chat response');
  const error = record.error === undefined ? undefined : decodeError(record.error, 'OpenRouter chat response.error');
  return Object.freeze({
    ...stringField(record, 'id', 'OpenRouter chat response'),
    ...stringField(record, 'model', 'OpenRouter chat response'),
    ...(record.choices === undefined ? {} : { choices: array(record.choices, 'OpenRouter chat response.choices', decodeChoice) }),
    ...(record.usage === undefined ? {} : { usage: decodeUsage(record.usage, 'OpenRouter chat response.usage') }),
    ...stringField(record, 'provider', 'OpenRouter chat response'),
    ...(error === undefined ? {} : { error })
  });
}

function decodeModelRecord(value: unknown, label: string): OpenRouterModelRecord {
  const record = object(value, label);
  const architecture = record.architecture === undefined ? undefined : decodeArchitecture(record.architecture, `${label}.architecture`);
  const pricing = record.pricing === undefined ? undefined : decodePricing(record.pricing, `${label}.pricing`);
  const topProvider = record.top_provider === null ? null : record.top_provider === undefined ? undefined : decodeTopProvider(record.top_provider, `${label}.top_provider`);
  const reasoning = record.reasoning === undefined ? undefined : decodeReasoning(record.reasoning, `${label}.reasoning`);
  return Object.freeze({
    ...stringField(record, 'id', label),
    ...stringField(record, 'name', label),
    ...stringField(record, 'description', label),
    ...nullableNumberField(record, 'context_length', label),
    ...(architecture === undefined ? {} : { architecture }),
    ...(pricing === undefined ? {} : { pricing }),
    ...(topProvider === undefined ? {} : { top_provider: topProvider }),
    ...(record.supported_parameters === undefined ? {} : { supported_parameters: stringArray(record.supported_parameters, `${label}.supported_parameters`) }),
    ...(reasoning === undefined ? {} : { reasoning })
  });
}

function decodeChoice(value: unknown, label: string): OpenRouterChoice {
  const record = object(value, label);
  const finishReason = record.finish_reason;
  if (finishReason !== undefined && finishReason !== null && typeof finishReason !== 'string') throw new Error(`${label}.finish_reason must be a string or null.`);
  return Object.freeze({
    ...(record.message === undefined ? {} : { message: decodeMessage(record.message, `${label}.message`) }),
    ...(record.delta === undefined ? {} : { delta: decodeMessage(record.delta, `${label}.delta`) }),
    ...(finishReason === undefined ? {} : { finish_reason: finishReason })
  });
}

function decodeMessage(value: unknown, label: string): OpenRouterResponseMessage {
  const record = object(value, label);
  const content = record.content;
  if (content !== undefined && content !== null && typeof content !== 'string' && !Array.isArray(content)) throw new Error(`${label}.content must be text, an array, or null.`);
  const contentParts = Array.isArray(content) ? Object.freeze(content.map((part, index) => object(part, `${label}.content[${String(index)}]`))) : content;
  const reasoning = record.reasoning;
  if (reasoning !== undefined && reasoning !== null && typeof reasoning !== 'string') throw new Error(`${label}.reasoning must be a string or null.`);
  return Object.freeze({
    ...stringField(record, 'role', label),
    ...(contentParts === undefined ? {} : { content: contentParts }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(record.reasoning_details === undefined ? {} : { reasoning_details: record.reasoning_details }),
    ...(record.tool_calls === undefined ? {} : { tool_calls: array(record.tool_calls, `${label}.tool_calls`, decodeToolCall) })
  });
}

function decodeToolCall(value: unknown, label: string): OpenRouterWireToolCall {
  const record = object(value, label);
  const index = integer(record.index, `${label}.index`);
  const fn = record.function === undefined ? undefined : object(record.function, `${label}.function`);
  let decodedFunction: OpenRouterWireToolCall['function'];
  if (fn) {
    const argumentsValue = fn.arguments;
    if (argumentsValue !== undefined && typeof argumentsValue !== 'string' && !isObject(argumentsValue)) throw new Error(`${label}.function.arguments must be a string or object.`);
    decodedFunction = Object.freeze({ ...stringField(fn, 'name', `${label}.function`), ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }) });
  }
  return Object.freeze({ ...stringField(record, 'id', label), ...(index === undefined ? {} : { index }), ...stringField(record, 'type', label), ...(decodedFunction === undefined ? {} : { function: decodedFunction }) });
}

function decodeUsage(value: unknown, label: string): OpenRouterUsage {
  const record = object(value, label);
  return Object.freeze({
    ...integerField(record, 'prompt_tokens', label),
    ...integerField(record, 'completion_tokens', label),
    ...integerField(record, 'total_tokens', label),
    ...(record.prompt_tokens_details === undefined ? {} : { prompt_tokens_details: decodeDetails(record.prompt_tokens_details, `${label}.prompt_tokens_details`, ['cached_tokens', 'cache_write_tokens']) }),
    ...(record.completion_tokens_details === undefined ? {} : { completion_tokens_details: decodeDetails(record.completion_tokens_details, `${label}.completion_tokens_details`, ['reasoning_tokens']) })
  });
}

function decodeDetails(value: unknown, label: string, fields: readonly string[]): Readonly<Record<string, unknown>> {
  const record = object(value, label);
  const result: Record<string, unknown> = {};
  for (const field of fields) Object.assign(result, integerField(record, field, label));
  return Object.freeze(result);
}

function decodeArchitecture(value: unknown, label: string): OpenRouterModelRecord['architecture'] {
  const record = object(value, label);
  return Object.freeze({
    ...(record.input_modalities === undefined ? {} : { input_modalities: stringArray(record.input_modalities, `${label}.input_modalities`) }),
    ...(record.output_modalities === undefined ? {} : { output_modalities: stringArray(record.output_modalities, `${label}.output_modalities`) })
  });
}

function decodePricing(value: unknown, label: string): Readonly<Record<string, string | number | null>> {
  const record = object(value, label);
  const result: Record<string, string | number | null> = {};
  for (const [key, item] of Object.entries(record)) {
    if (item !== null && typeof item !== 'string' && typeof item !== 'number') throw new Error(`${label}.${key} must be a string, number, or null.`);
    result[key] = item;
  }
  return Object.freeze(result);
}

function decodeTopProvider(value: unknown, label: string): Exclude<OpenRouterModelRecord['top_provider'], null | undefined> {
  const record = object(value, label);
  return Object.freeze({ ...nullableNumberField(record, 'context_length', label), ...nullableNumberField(record, 'max_completion_tokens', label) });
}

function decodeReasoning(value: unknown, label: string): NonNullable<OpenRouterModelRecord['reasoning']> {
  const record = object(value, label);
  const efforts = record.supported_efforts;
  if (efforts !== undefined && efforts !== null && !Array.isArray(efforts)) throw new Error(`${label}.supported_efforts must be an array or null.`);
  return Object.freeze({
    ...(efforts === undefined ? {} : { supported_efforts: efforts === null ? null : stringArray(efforts, `${label}.supported_efforts`) }),
    ...booleanField(record, 'supports_max_tokens', label),
    ...booleanField(record, 'mandatory', label)
  });
}

function decodeError(value: unknown, label: string): NonNullable<OpenRouterChatResponse['error']> {
  const record = object(value, label);
  if (record.code !== undefined && typeof record.code !== 'string' && typeof record.code !== 'number') throw new Error(`${label}.code must be a string or number.`);
  return Object.freeze({ ...(record.code === undefined ? {} : { code: record.code }), ...stringField(record, 'message', label), ...(record.metadata === undefined ? {} : { metadata: record.metadata }) });
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> { if (!isObject(value)) throw new Error(`${label} must be an object.`); return value; }
function isObject(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function array<T>(value: unknown, label: string, decode: (value: unknown, label: string) => T): readonly T[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array.`); return Object.freeze(value.map((item, index) => decode(item, `${label}[${String(index)}]`))); }
function stringArray(value: unknown, label: string): readonly string[] { if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${label} must be an array of strings.`); return Object.freeze(value.map((item) => item)); }
function stringField(record: Readonly<Record<string, unknown>>, key: string, label: string): Record<string, string> { const value = record[key]; if (value === undefined) return {}; if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string.`); return { [key]: value }; }
function booleanField(record: Readonly<Record<string, unknown>>, key: string, label: string): Record<string, boolean> { const value = record[key]; if (value === undefined) return {}; if (typeof value !== 'boolean') throw new Error(`${label}.${key} must be boolean.`); return { [key]: value }; }
function integerField(record: Readonly<Record<string, unknown>>, key: string, label: string): Record<string, number> { const value = integer(record[key], `${label}.${key}`); return value === undefined ? {} : { [key]: value }; }
function integer(value: unknown, label: string): number | undefined { if (value === undefined) return undefined; if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`); return value; }
function nullableNumberField(record: Readonly<Record<string, unknown>>, key: string, label: string): Record<string, number | null> { const value = record[key]; if (value === undefined) return {}; if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${label}.${key} must be a finite number or null.`); return { [key]: value }; }
