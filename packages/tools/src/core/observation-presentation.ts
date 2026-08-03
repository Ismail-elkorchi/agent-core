import type { ToolCall, ToolObservation } from './definition.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface ToolObservationPresentation {
  ok: boolean;
  title: string;
  summary: string;
  scope?: JsonObject;
  filters?: JsonObject;
  limits?: JsonObject;
  results?: JsonValue;
  failures?: JsonValue;
  omitted?: JsonObject;
  coverage?: 'complete' | 'partial';
  truncated?: boolean;
  warnings?: string[];
  next?: string;
}

export interface ToolObservationPresentationLimit {
  maxBytes: number;
}

export interface ToolObservationPresentationRequest<TInput = unknown, TOutput = unknown> {
  call: ToolCall;
  input: TInput;
  observation: ToolObservation<TOutput>;
  limit: ToolObservationPresentationLimit;
}

export interface ToolObservationPresentationValidationIssue {
  path: string;
  message: string;
}

export type ToolObservationPresentationValidationResult =
  | { ok: true; presentation: ToolObservationPresentation }
  | { ok: false; issues: ToolObservationPresentationValidationIssue[] };

export function validateToolObservationPresentation(value: unknown): ToolObservationPresentationValidationResult {
  const issues: ToolObservationPresentationValidationIssue[] = [];
  if (!isJsonObject(value)) {
    return { ok: false, issues: [{ path: '$', message: 'Tool observation presentation must be a JSON object.' }] };
  }

  requireType(value, 'ok', 'boolean', issues);
  requireType(value, 'title', 'string', issues);
  requireType(value, 'summary', 'string', issues);
  optionalObject(value, 'scope', issues);
  optionalObject(value, 'filters', issues);
  optionalObject(value, 'limits', issues);
  optionalJson(value, 'results', issues);
  optionalJson(value, 'failures', issues);
  optionalObject(value, 'omitted', issues);
  if (value.coverage !== undefined && value.coverage !== 'complete' && value.coverage !== 'partial') {
    issues.push({ path: '$.coverage', message: 'Field coverage must be complete or partial.' });
  }
  optionalType(value, 'truncated', 'boolean', issues);
  optionalStringArray(value, 'warnings', issues);
  optionalType(value, 'next', 'string', issues);

  if (issues.length > 0) return { ok: false, issues };
  if (!isToolObservationPresentation(value)) return { ok: false, issues: [{ path: '$', message: 'Validated fields did not form a tool observation presentation.' }] };
  return { ok: true, presentation: value };
}

export function toolFailurePresentation(toolName: string, observation: ToolObservation): ToolObservationPresentation {
  const output = toJsonValue(observation.output);
  return {
    ok: false,
    title: `${toolName} failed`,
    summary: observation.summary,
    failures: output,
    next: recoveryFromJson(output) ?? 'Use the failure details to adjust the next tool call.'
  };
}

export function toJsonValue(value: unknown): JsonValue {
  return toJsonValueInner(value, new WeakSet());
}

export function estimateJsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function requireType(
  value: JsonObject,
  key: string,
  expected: 'boolean' | 'string',
  issues: ToolObservationPresentationValidationIssue[]
): void {
  if (!(key in value)) {
    issues.push({ path: `$.${key}`, message: `Required field ${key} is missing.` });
    return;
  }
  if (typeof value[key] !== expected) {
    issues.push({ path: `$.${key}`, message: `Field ${key} must be ${expected}.` });
  }
}

function optionalType(
  value: JsonObject,
  key: string,
  expected: 'boolean' | 'string',
  issues: ToolObservationPresentationValidationIssue[]
): void {
  if (!(key in value)) {
    return;
  }
  if (typeof value[key] !== expected) {
    issues.push({ path: `$.${key}`, message: `Field ${key} must be ${expected}.` });
  }
}

function optionalObject(value: JsonObject, key: string, issues: ToolObservationPresentationValidationIssue[]): void {
  if (!(key in value)) {
    return;
  }
  const item = value[key];
  if (!isJsonObject(item)) {
    issues.push({ path: `$.${key}`, message: `Field ${key} must be a JSON object.` });
  }
}

function optionalJson(value: JsonObject, key: string, issues: ToolObservationPresentationValidationIssue[]): void {
  if (!(key in value)) {
    return;
  }
  if (!isJsonValue(value[key])) {
    issues.push({ path: `$.${key}`, message: `Field ${key} must be JSON-serializable.` });
  }
}

function optionalStringArray(value: JsonObject, key: string, issues: ToolObservationPresentationValidationIssue[]): void {
  if (!(key in value)) {
    return;
  }
  const item = value[key];
  if (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string')) {
    issues.push({ path: `$.${key}`, message: `Field ${key} must be an array of strings.` });
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isJsonObject(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recoveryFromJson(value: JsonValue): string | undefined {
  return isJsonObject(value) && typeof value.recovery === 'string' ? value.recovery : undefined;
}

function toJsonValueInner(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message
    };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `[binary ${String(value.byteLength)} bytes]`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[circular]';
    }
    seen.add(value);
    return value.map((item) => toJsonValueInner(item, seen));
  }
  if (isUnknownRecord(value)) {
    if (seen.has(value)) {
      return '[circular]';
    }
    seen.add(value);
    const output: JsonObject = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item !== undefined) {
        output[key] = toJsonValueInner(item, seen);
      }
    }
    return output;
  }
  return Object.prototype.toString.call(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function isToolObservationPresentation(value: JsonObject): value is JsonObject & ToolObservationPresentation {
  return typeof value.ok === 'boolean' && typeof value.title === 'string' && typeof value.summary === 'string'
    && (value.scope === undefined || isJsonObject(value.scope))
    && (value.filters === undefined || isJsonObject(value.filters))
    && (value.limits === undefined || isJsonObject(value.limits))
    && (value.results === undefined || isJsonValue(value.results))
    && (value.failures === undefined || isJsonValue(value.failures))
    && (value.omitted === undefined || isJsonObject(value.omitted))
    && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.warnings === undefined || (Array.isArray(value.warnings) && value.warnings.every((item) => typeof item === 'string')))
    && (value.next === undefined || typeof value.next === 'string');
}
