export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type JsonNormalizationDiagnosticCode =
  | 'access_error'
  | 'accessor'
  | 'bigint'
  | 'binary'
  | 'circular'
  | 'collection_truncated'
  | 'depth_truncated'
  | 'error'
  | 'function'
  | 'invalid_date'
  | 'symbol'
  | 'text_truncated'
  | 'total_bytes_truncated'
  | 'unsupported';

export interface JsonNormalizationDiagnostic {
  readonly code: JsonNormalizationDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface JsonNormalizationLimits {
  readonly maxDepth: number;
  readonly maxCollectionEntries: number;
  readonly maxStringBytes: number;
  readonly maxTotalBytes: number;
}

interface JsonNormalizationResultBase {
  readonly value: JsonValue;
  readonly bytes: number;
  readonly truncated: boolean;
}

export type JsonNormalizationResult =
  | (JsonNormalizationResultBase & { readonly status: 'clean'; readonly diagnostics: readonly [] })
  | (JsonNormalizationResultBase & { readonly status: 'normalized_with_diagnostics'; readonly diagnostics: readonly [JsonNormalizationDiagnostic, ...JsonNormalizationDiagnostic[]] });

export const DEFAULT_JSON_NORMALIZATION_LIMITS: JsonNormalizationLimits = Object.freeze({
  maxDepth: 8,
  maxCollectionEntries: 100,
  maxStringBytes: 8 * 1024,
  maxTotalBytes: 32 * 1024
});

export interface SafeJsonParseLimits {
  readonly maxDepth: number;
  readonly maxCollectionEntries: number;
  readonly maxStringBytes: number;
  readonly maxTotalBytes: number;
}
export const DEFAULT_SAFE_JSON_PARSE_LIMITS: SafeJsonParseLimits = Object.freeze({
  maxDepth: 32,
  maxCollectionEntries: 20_000,
  maxStringBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024
});

/** Strict JSON ownership boundary. It never invokes accessors and returns a frozen owned snapshot. */
export function parseJsonValue(input: unknown, requested: Partial<SafeJsonParseLimits> = {}): JsonValue {
  const limits = validateLimits({ ...DEFAULT_SAFE_JSON_PARSE_LIMITS, ...requested });
  const state = { entries: 0, stringBytes: 0 };
  const value = copyJson(input, '$', 0, limits, state, new WeakSet());
  const totalBytes = utf8Bytes(JSON.stringify(value));
  if (totalBytes > limits.maxTotalBytes) throw new Error('JSON value exceeds the total byte limit of ' + String(limits.maxTotalBytes) + '.');
  return value;
}

export function parseJsonObject(input: unknown, requested: Partial<SafeJsonParseLimits> = {}): JsonObject {
  const value = parseJsonValue(input, requested);
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('JSON value must be an object.');
  return value;
}

export function normalizeJsonSafe(
  input: unknown,
  requestedLimits: Partial<JsonNormalizationLimits> = {}
): JsonNormalizationResult {
  const limits = validateLimits({ ...DEFAULT_JSON_NORMALIZATION_LIMITS, ...requestedLimits });
  const diagnostics: JsonNormalizationDiagnostic[] = [];
  const seen = new WeakMap<object, string>();
  const value = normalizeValue(input, '$', 0, limits, diagnostics, seen);
  let text = JSON.stringify(value);
  let output = value;
  if (utf8Bytes(text) > limits.maxTotalBytes) {
    diagnostics.push({
      code: 'total_bytes_truncated',
      path: '$',
      message: `Normalized JSON exceeded ${String(limits.maxTotalBytes)} bytes.`
    });
    output = {
      truncated: true,
      preview: truncateText(text, Math.max(0, limits.maxTotalBytes - 256)),
      originalBytes: utf8Bytes(text)
    };
    text = JSON.stringify(output);
  }
  const truncated = diagnostics.some((diagnostic) => diagnostic.code.includes('truncated') || diagnostic.code === 'circular');
  if (diagnostics.length === 0) {
    const emptyDiagnostics: readonly [] = Object.freeze([]);
    return Object.freeze({ status: 'clean', value: output, bytes: utf8Bytes(text), truncated, diagnostics: emptyDiagnostics });
  }
  const [first, ...rest] = diagnostics;
  if (!first) throw new Error('JSON normalization diagnostic invariant violated.');
  const nonemptyDiagnostics: readonly [JsonNormalizationDiagnostic, ...JsonNormalizationDiagnostic[]] = Object.freeze([Object.freeze(first), ...rest.map((diagnostic) => Object.freeze(diagnostic))]);
  return Object.freeze({ status: 'normalized_with_diagnostics', value: output, bytes: utf8Bytes(text), truncated, diagnostics: nonemptyDiagnostics });
}

function copyJson(
  value: unknown,
  path: string,
  depth: number,
  limits: SafeJsonParseLimits,
  state: { entries: number; stringBytes: number },
  seen: WeakSet<object>
): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(path + ' contains a non-finite number.');
    return value;
  }
  if (typeof value === 'string') {
    const bytes = utf8Bytes(value);
    if (bytes > limits.maxStringBytes) throw new Error(path + ' exceeds the string byte limit.');
    state.stringBytes += bytes;
    if (state.stringBytes > limits.maxTotalBytes) throw new Error('JSON strings exceed the total byte limit.');
    return value;
  }
  if (typeof value !== 'object') throw new Error(path + ' contains a non-JSON value.');
  if (depth >= limits.maxDepth) throw new Error(path + ' exceeds the JSON depth limit.');
  if (seen.has(value)) throw new Error(path + ' contains a cycle.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const length = dataDescriptor(value, 'length', path);
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new Error(path + ' has an invalid array length.');
      state.entries += length;
      if (state.entries > limits.maxCollectionEntries) throw new Error(path + ' exceeds the JSON collection limit.');
      const output: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error(path + '[' + String(index) + '] must be a data property.');
        output.push(copyJson(descriptor.value, path + '[' + String(index) + ']', depth + 1, limits, state, seen));
      }
      return Object.freeze(output) as unknown as JsonValue;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(path + ' has an unsupported object prototype.');
    const output: JsonObject = {};
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) throw new Error(path + ' contains a symbol key.');
    const stringKeys = keys as string[];
    state.entries += stringKeys.length;
    if (state.entries > limits.maxCollectionEntries) throw new Error(path + ' exceeds the JSON collection limit.');
    for (const key of stringKeys.sort((a, b) => a.localeCompare(b, 'en'))) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) continue;
      if (!('value' in descriptor)) throw new Error(path + '.' + key + ' is an accessor property.');
      Object.defineProperty(output, key, {
        value: copyJson(descriptor.value, path + '.' + key, depth + 1, limits, state, seen),
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}
function dataDescriptor(object: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) throw new Error(path + '.' + key + ' must be a data property.');
  return descriptor.value;
}

function normalizeValue(
  value: unknown,
  path: string,
  depth: number,
  limits: JsonNormalizationLimits,
  diagnostics: JsonNormalizationDiagnostic[],
  seen: WeakMap<object, string>
): JsonValue {
  try {
    return normalizeValueUnsafe(value, path, depth, limits, diagnostics, seen);
  } catch (error) {
    diagnostics.push({ code: 'access_error', path, message: `Value could not be inspected: ${safeErrorMessage(error)}.` });
    return '[value inspection failed]';
  }
}

function normalizeValueUnsafe(
  value: unknown,
  path: string,
  depth: number,
  limits: JsonNormalizationLimits,
  diagnostics: JsonNormalizationDiagnostic[],
  seen: WeakMap<object, string>
): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const truncated = truncateText(value, limits.maxStringBytes);
    if (truncated !== value) {
      diagnostics.push({ code: 'text_truncated', path, message: `String exceeded ${String(limits.maxStringBytes)} bytes.` });
    }
    return truncated;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'undefined') return null;
  if (typeof value === 'bigint') {
    diagnostics.push({ code: 'bigint', path, message: 'BigInt was converted to a decimal string.' });
    return `${String(value)}n`;
  }
  if (typeof value === 'function') {
    diagnostics.push({ code: 'function', path, message: 'Function was replaced with a descriptive marker.' });
    return `[function ${safeFunctionName(value)}]`;
  }
  if (typeof value === 'symbol') {
    diagnostics.push({ code: 'symbol', path, message: 'Symbol was replaced with a descriptive marker.' });
    return `[symbol ${value.description ?? ''}]`;
  }
  if (isError(value)) {
    diagnostics.push({ code: 'error', path, message: 'Error was converted to structured JSON.' });
    return normalizeError(value, path, depth, limits, diagnostics, seen);
  }
  if (isDate(value)) {
    const timestamp = Date.prototype.getTime.call(value);
    if (!Number.isFinite(timestamp)) {
      diagnostics.push({ code: 'invalid_date', path, message: 'Invalid Date was replaced with a descriptive marker.' });
      return '[invalid date]';
    }
    return new Date(timestamp).toISOString();
  }
  if (isUint8Array(value)) {
    const byteLength = value.byteLength;
    diagnostics.push({ code: 'binary', path, message: `Binary value (${String(byteLength)} bytes) was replaced with metadata.` });
    return nullPrototypeObject([['type', 'binary'], ['bytes', byteLength]]);
  }
  if (depth >= limits.maxDepth) {
    diagnostics.push({ code: 'depth_truncated', path, message: `Value exceeded maximum depth ${String(limits.maxDepth)}.` });
    return '[maximum depth reached]';
  }
  if (typeof value === 'object') {
    const priorPath = seen.get(value);
    if (priorPath !== undefined) {
      diagnostics.push({ code: 'circular', path, message: `Circular reference points to ${priorPath}.` });
      return `[circular -> ${priorPath}]`;
    }
    seen.set(value, path);
    try {
      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        const length = typeof lengthDescriptor?.value === 'number' && Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0
          ? lengthDescriptor.value
          : 0;
        const selectedLength = Math.min(length, limits.maxCollectionEntries);
        const output: JsonValue[] = [];
        for (let index = 0; index < selectedLength; index += 1) {
          output.push(normalizeOwnProperty(value, String(index), `${path}[${String(index)}]`, depth + 1, limits, diagnostics, seen));
        }
        if (selectedLength < length) {
          diagnostics.push({ code: 'collection_truncated', path, message: `Array was truncated from ${String(length)} entries.` });
          output.push(`[${String(length - selectedLength)} entries omitted]`);
        }
        return output;
      }
      const keys = Reflect.ownKeys(value);
      const enumerableKeys: string[] = [];
      for (const key of keys) {
        if (typeof key === 'symbol') {
          diagnostics.push({ code: 'symbol', path, message: 'A symbol-keyed property was omitted.' });
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable === true) enumerableKeys.push(key);
      }
      enumerableKeys.sort((left, right) => left.localeCompare(right));
      const selected = enumerableKeys.slice(0, limits.maxCollectionEntries);
      const output = Object.create(null) as JsonObject;
      for (const key of selected) {
        defineJsonProperty(output, key, normalizeOwnProperty(value, key, `${path}.${key}`, depth + 1, limits, diagnostics, seen));
      }
      if (selected.length < enumerableKeys.length) {
        diagnostics.push({ code: 'collection_truncated', path, message: `Object was truncated from ${String(enumerableKeys.length)} entries.` });
        defineJsonProperty(output, '__omittedEntries', enumerableKeys.length - selected.length);
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
  diagnostics.push({ code: 'unsupported', path, message: 'Unsupported value was replaced with its object tag.' });
  return Object.prototype.toString.call(value);
}

function normalizeOwnProperty(
  object: object,
  key: string,
  path: string,
  depth: number,
  limits: JsonNormalizationLimits,
  diagnostics: JsonNormalizationDiagnostic[],
  seen: WeakMap<object, string>
): JsonValue {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return null;
    if (!('value' in descriptor)) {
      diagnostics.push({ code: 'accessor', path, message: 'Accessor property was not invoked.' });
      return '[accessor omitted]';
    }
    return normalizeValue(descriptor.value, path, depth, limits, diagnostics, seen);
  } catch (error) {
    diagnostics.push({ code: 'access_error', path, message: `Property could not be inspected: ${safeErrorMessage(error)}.` });
    return '[property inspection failed]';
  }
}

function normalizeError(
  error: Error,
  path: string,
  depth: number,
  limits: JsonNormalizationLimits,
  diagnostics: JsonNormalizationDiagnostic[],
  seen: WeakMap<object, string>
): JsonValue {
  const output = Object.create(null) as JsonObject;
  for (const key of ['name', 'message', 'stack'] as const) {
    const value = safeErrorField(error, key);
    if (value !== undefined) defineJsonProperty(output, key, normalizeValue(value, `${path}.${key}`, depth + 1, limits, diagnostics, seen));
  }
  const keys = Reflect.ownKeys(error);
  for (const key of keys) {
    if (typeof key !== 'string' || key === 'name' || key === 'message' || key === 'stack') continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor?.enumerable !== true) continue;
    defineJsonProperty(output, key, normalizeOwnProperty(error, key, `${path}.${key}`, depth + 1, limits, diagnostics, seen));
  }
  return output;
}

function safeErrorField(error: Error, key: 'name' | 'message' | 'stack'): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor && 'value' in descriptor) return descriptor.value;
    if (key === 'name') return 'Error';
    return undefined;
  } catch { return undefined; }
}

function isError(value: object): value is Error { try { return value instanceof Error; } catch { return false; } }
function isDate(value: object): value is Date { try { return value instanceof Date; } catch { return false; } }
function isUint8Array(value: object): value is Uint8Array { try { return value instanceof Uint8Array; } catch { return false; } }
function safeFunctionName(value: { readonly name?: unknown }): string { try { return typeof value.name === 'string' && value.name.length > 0 ? value.name : 'anonymous'; } catch { return 'uninspectable'; } }
function safeErrorMessage(error: unknown): string { try { return error instanceof Error ? error.message : String(error); } catch { return 'unknown inspection error'; } }
function defineJsonProperty(object: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: false, writable: false });
}
function nullPrototypeObject(entries: readonly (readonly [string, JsonValue])[]): JsonObject {
  const output = Object.create(null) as JsonObject;
  for (const [key, value] of entries) defineJsonProperty(output, key, value);
  return output;
}

function validateLimits(limits: JsonNormalizationLimits): JsonNormalizationLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new Error(`JSON normalization limit ${name} must be a positive finite integer.`);
    }
  }
  return Object.freeze(limits);
}

function truncateText(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= Math.max(0, maxBytes - 16)) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}...[truncated]`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
