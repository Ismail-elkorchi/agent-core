import { isJsonObject, isJsonValue, normalizeJsonSafe, parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';
import type { ToolCall, ToolObservation } from './definition.js';
export type { JsonObject, JsonValue } from '@agent-core/json';

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
export type ToolObservationPresentationMode = 'immediate' | 'retained';
export interface ToolObservationPresentationRequest<TInput = unknown, TOutput = unknown> {
  call: ToolCall;
  input: TInput;
  observation: ToolObservation<TOutput>;
  mode: ToolObservationPresentationMode;
  maxTokens: number;
}
export interface ToolObservationPresentationValidationIssue { path: string; message: string }
export type ToolObservationPresentationValidationResult =
  | { ok: true; presentation: ToolObservationPresentation }
  | { ok: false; issues: ToolObservationPresentationValidationIssue[] };

export function validateToolObservationPresentation(value: unknown): ToolObservationPresentationValidationResult {
  let owned: JsonObject;
  try { owned = parseJsonObject(value); }
  catch { return { ok: false, issues: [{ path: '$', message: 'Tool observation presentation must be a bounded JSON object without accessors.' }] }; }
  const issues: ToolObservationPresentationValidationIssue[] = [];
  requireType(owned, 'ok', 'boolean', issues);
  requireType(owned, 'title', 'string', issues);
  requireType(owned, 'summary', 'string', issues);
  for (const key of ['scope', 'filters', 'limits', 'omitted']) optionalObject(owned, key, issues);
  for (const key of ['results', 'failures']) optionalJson(owned, key, issues);
  if (owned.coverage !== undefined && owned.coverage !== 'complete' && owned.coverage !== 'partial') issues.push({ path: '$.coverage', message: 'Field coverage must be complete or partial.' });
  optionalType(owned, 'truncated', 'boolean', issues);
  optionalType(owned, 'next', 'string', issues);
  if (owned.warnings !== undefined && (!Array.isArray(owned.warnings) || owned.warnings.some((entry) => typeof entry !== 'string'))) issues.push({ path: '$.warnings', message: 'Field warnings must be an array of strings.' });
  const keys = new Set(['ok', 'title', 'summary', 'scope', 'filters', 'limits', 'results', 'failures', 'omitted', 'coverage', 'truncated', 'warnings', 'next']);
  const unknown = Object.keys(owned).filter((key) => !keys.has(key));
  if (unknown.length > 0) issues.push({ path: '$', message: 'Unsupported presentation fields: ' + unknown.join(', ') + '.' });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, presentation: owned as unknown as ToolObservationPresentation };
}

export function toolFailurePresentation(toolName: string, observation: ToolObservation): ToolObservationPresentation {
  const output = toJsonValue(observation.output);
  return {
    ok: false,
    title: toolName + ' failed',
    summary: observation.summary,
    scope: toObject(observation.scope),
    failures: output,
    coverage: observation.scope.coverage,
    next: recoveryFromJson(output) ?? 'Use the failure details to adjust the next tool call.'
  };
}

export function toJsonValue(value: unknown): JsonValue {
  return normalizeJsonSafe(value, { maxDepth: 32, maxCollectionEntries: 20_000, maxStringBytes: 2_000_000, maxTotalBytes: 4_000_000 }).value;
}

function requireType(value: JsonObject, key: string, expected: 'boolean' | 'string', issues: ToolObservationPresentationValidationIssue[]): void {
  if (!(key in value)) issues.push({ path: '$.' + key, message: 'Required field ' + key + ' is missing.' });
  else if (typeof value[key] !== expected) issues.push({ path: '$.' + key, message: 'Field ' + key + ' must be ' + expected + '.' });
}
function optionalType(value: JsonObject, key: string, expected: 'boolean' | 'string', issues: ToolObservationPresentationValidationIssue[]): void {
  if (key in value && typeof value[key] !== expected) issues.push({ path: '$.' + key, message: 'Field ' + key + ' must be ' + expected + '.' });
}
function optionalObject(value: JsonObject, key: string, issues: ToolObservationPresentationValidationIssue[]): void {
  if (key in value && !isJsonObject(value[key])) issues.push({ path: '$.' + key, message: 'Field ' + key + ' must be a JSON object.' });
}
function optionalJson(value: JsonObject, key: string, issues: ToolObservationPresentationValidationIssue[]): void {
  if (key in value && !isJsonValue(value[key])) issues.push({ path: '$.' + key, message: 'Field ' + key + ' must be JSON.' });
}
function recoveryFromJson(value: JsonValue): string | undefined {
  return isJsonObject(value) && typeof value.recovery === 'string' ? value.recovery : undefined;
}
function toObject(value: unknown): JsonObject {
  const normalized = toJsonValue(value);
  return isJsonObject(normalized) ? normalized : parseJsonObject({ value: normalized });
}
