import { parseJsonObject, type JsonObject, type JsonPrimitive, type JsonValue } from '@agent-core/json';

export type JsonMember = JsonValue;

export type ObservationAction =
  | 'list'
  | 'search'
  | 'read'
  | 'execute'
  | 'create'
  | 'update'
  | 'delete'
  | 'move'
  | 'verify';

export type ObservationActuality = 'predicted' | 'observed';
export type ObservationOutcome = 'success' | 'failure';

export interface ObservedRange {
  readonly kind: 'line' | 'byte';
  readonly start?: number;
  readonly end?: number;
}

export interface ObservedResource {
  readonly uri: string;
  readonly range?: ObservedRange;
  readonly sha256?: string;
  readonly fullSha256?: string;
  readonly mediaType?: string;
}

export interface ObservationScope {
  readonly filters?: JsonObject;
  readonly limits?: JsonObject;
  readonly omitted?: JsonObject;
  readonly coverage?: 'complete' | 'partial' | 'absent';
  readonly truncated?: boolean;
  readonly actuality?: ObservationActuality;
}

export interface ToolResultFact {
  readonly action: ObservationAction;
  readonly resources?: readonly ObservedResource[];
  readonly scope?: ObservationScope;
  readonly summary?: string;
  readonly outcome: ObservationOutcome;
}

export interface ToolResultFacts {
  readonly items: readonly ToolResultFact[];
}

export interface ObservedFactRecord extends ToolResultFact {
  readonly id: string;
  readonly observationId: string;
  readonly toolName: string;
  readonly createdAt: string;
  readonly resources: readonly ObservedResource[];
  readonly outcome: ObservationOutcome;
}

export interface ObservedFactRecordContext {
  readonly observationId: string;
  readonly toolName: string;
  readonly createdAt?: string;
}

const OWNED_OBSERVED_FACT_RECORDS = new WeakSet();

export function recordObservedFacts(delta: ToolResultFacts | undefined, context: ObservedFactRecordContext): ObservedFactRecord[] {
  if (delta === undefined) return [];
  const createdAt = context.createdAt ?? new Date().toISOString();
  return delta.items.map((item, index): ObservedFactRecord => ownObservedFactRecord({
      id: `${context.observationId}:fact:${String(index + 1)}`,
      observationId: context.observationId,
      toolName: context.toolName,
      createdAt,
      action: item.action,
      resources: item.resources ?? [],
      outcome: item.outcome,
      ...(item.scope ? { scope: item.scope } : {}),
      ...(item.summary ? { summary: item.summary } : {})
    }));
}

export function ownObservedFactRecord(value: ObservedFactRecord): ObservedFactRecord {
  if (OWNED_OBSERVED_FACT_RECORDS.has(value)) return value;
  const record = Object.freeze({
    ...value,
    resources: Object.freeze(value.resources.map(ownObservedResource)),
    ...(value.scope ? { scope: ownObservationScope(value.scope) } : {})
  });
  OWNED_OBSERVED_FACT_RECORDS.add(record);
  return record;
}

export function decodeOwnedObservedFactRecord(value: JsonObject): ObservedFactRecord {
  rejectUnknown(value, ['id', 'observationId', 'toolName', 'createdAt', 'action', 'resources', 'scope', 'summary', 'outcome'], 'Observed fact record');
  const id = value.id; const observationId = value.observationId; const toolName = value.toolName; const createdAt = value.createdAt;
  if (typeof id !== 'string' || id.length === 0 || typeof observationId !== 'string' || observationId.length === 0 || typeof toolName !== 'string' || toolName.length === 0 || typeof createdAt !== 'string' || createdAt.length === 0) throw new Error('Observed fact record identity is invalid.');
  if (!isObservationAction(value.action) || (value.outcome !== 'success' && value.outcome !== 'failure') || !jsonArray(value.resources)) throw new Error('Observed fact record is invalid.');
  if (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.trim().length === 0 || Buffer.byteLength(value.summary, 'utf8') > 1_000)) throw new Error('Observed fact record summary is invalid.');
  const record = Object.freeze({
    id, observationId, toolName, createdAt,
    action: value.action, resources: Object.freeze(value.resources.map((resource, index) => parseObservedResource(resource, 0, index))), outcome: value.outcome,
    ...(value.scope === undefined ? {} : { scope: parseObservationScope(value.scope, 0) }),
    ...(typeof value.summary === 'string' ? { summary: value.summary.trim() } : {})
  });
  OWNED_OBSERVED_FACT_RECORDS.add(record);
  return record;
}

export function encodeObservedFactRecord(value: ObservedFactRecord): JsonObject {
  const record = ownObservedFactRecord(value);
  return Object.freeze({
    id: record.id, observationId: record.observationId, toolName: record.toolName, createdAt: record.createdAt,
    action: record.action, resources: Object.freeze(record.resources.map(encodeObservedResource)), outcome: record.outcome,
    ...(record.scope ? { scope: encodeObservationScope(record.scope) } : {}), ...(record.summary ? { summary: record.summary } : {})
  });
}

export function encodeToolResultFacts(value: ToolResultFacts): JsonObject {
  return Object.freeze({ items: Object.freeze(value.items.map((item) => Object.freeze({
    action: item.action, outcome: item.outcome,
    ...(item.resources ? { resources: Object.freeze(item.resources.map(encodeObservedResource)) } : {}),
    ...(item.scope ? { scope: encodeObservationScope(item.scope) } : {}), ...(item.summary ? { summary: item.summary } : {})
  }))) });
}

/** Semantic validation for observedFacts in an already-decoded JSON observation. */
export function parseToolResultFacts(value: JsonObject): ToolResultFacts {
  rejectUnknown(value, ['items'], 'Tool result facts');
  if (!jsonArray(value.items)) throw new Error('Tool result facts must contain an items array.');
  return Object.freeze({ items: Object.freeze(value.items.map((item, index) => parseToolResultFact(item, index))) });
}

export function toObservationJsonObject(value: Record<string, unknown>): JsonObject {
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const json = toObservationJsonMember(item);
    if (json !== undefined) {
      output[key] = json;
    }
  }
  return Object.freeze(output);
}

function parseToolResultFact(value: JsonValue, index: number): ToolResultFact {
  const item = requireJsonObject(value, `Tool result facts item ${String(index)}`);
  rejectUnknown(item, ['action', 'resources', 'scope', 'summary', 'outcome'], `Tool result facts item ${String(index)}`);
  if (!isObservationAction(item.action)) throw new Error(`Tool result facts item ${String(index)} has an invalid action.`);
  if (item.outcome !== 'success' && item.outcome !== 'failure') throw new Error(`Tool result facts item ${String(index)} has an invalid outcome.`);
  if (item.resources !== undefined && !jsonArray(item.resources)) throw new Error(`Tool result facts item ${String(index)} resources must be an array.`);
  if (item.summary !== undefined && (typeof item.summary !== 'string' || item.summary.trim().length === 0 || Buffer.byteLength(item.summary, 'utf8') > 1_000)) {
    throw new Error(`Tool result facts item ${String(index)} has an invalid summary.`);
  }
  const resources = item.resources === undefined ? undefined : Object.freeze(item.resources.map((resource, resourceIndex) => parseObservedResource(resource, index, resourceIndex)));
  const scope = item.scope === undefined ? undefined : parseObservationScope(item.scope, index);
  return Object.freeze({
    action: item.action,
    outcome: item.outcome,
    ...(resources ? { resources } : {}),
    ...(scope ? { scope } : {}),
    ...(typeof item.summary === 'string' ? { summary: item.summary.trim() } : {})
  });
}

function parseObservedResource(value: JsonValue, itemIndex: number, resourceIndex: number): ObservedResource {
  const resource = requireJsonObject(value, `Tool result facts resource ${String(itemIndex)}:${String(resourceIndex)}`);
  rejectUnknown(resource, ['uri', 'range', 'sha256', 'fullSha256', 'mediaType'], `Tool result facts resource ${String(itemIndex)}:${String(resourceIndex)}`);
  if (typeof resource.uri !== 'string' || resource.uri.trim().length === 0 || Buffer.byteLength(resource.uri, 'utf8') > 1_000) {
    throw new Error(`Tool result facts resource ${String(itemIndex)}:${String(resourceIndex)} has an invalid URI.`);
  }
  const range = resource.range === undefined ? undefined : parseObservedRange(resource.range, itemIndex, resourceIndex);
  const sha256 = parseOptionalSha256(resource.sha256, 'sha256', itemIndex, resourceIndex);
  const fullSha256 = parseOptionalSha256(resource.fullSha256, 'fullSha256', itemIndex, resourceIndex);
  if (resource.mediaType !== undefined && (typeof resource.mediaType !== 'string' || resource.mediaType.trim().length === 0
    || Buffer.byteLength(resource.mediaType, 'utf8') > 200 || !/^[^\s/]+\/[^\s]+$/u.test(resource.mediaType.trim()))) {
    throw new Error(`Tool result facts resource ${String(itemIndex)}:${String(resourceIndex)} has an invalid media type.`);
  }
  return Object.freeze({
    uri: resource.uri.trim(),
    ...(range ? { range } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(fullSha256 ? { fullSha256 } : {}),
    ...(typeof resource.mediaType === 'string' ? { mediaType: resource.mediaType.trim() } : {})
  });
}

function parseObservedRange(value: JsonValue, itemIndex: number, resourceIndex: number): ObservedRange {
  const range = requireJsonObject(value, `Tool result facts range ${String(itemIndex)}:${String(resourceIndex)}`);
  rejectUnknown(range, ['kind', 'start', 'end'], `Tool result facts range ${String(itemIndex)}:${String(resourceIndex)}`);
  if (range.kind !== 'line' && range.kind !== 'byte') throw new Error(`Tool result facts range ${String(itemIndex)}:${String(resourceIndex)} has an invalid kind.`);
  const minimum = range.kind === 'line' ? 1 : 0;
  for (const key of ['start', 'end'] as const) {
    const number = range[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum)) throw new Error(`Tool result facts range ${String(itemIndex)}:${String(resourceIndex)} has an invalid ${key}.`);
  }
  if (typeof range.start === 'number' && typeof range.end === 'number' && range.end < range.start) throw new Error(`Tool result facts range ${String(itemIndex)}:${String(resourceIndex)} ends before it starts.`);
  return Object.freeze({ kind: range.kind, ...(typeof range.start === 'number' ? { start: range.start } : {}), ...(typeof range.end === 'number' ? { end: range.end } : {}) });
}

function parseObservationScope(value: JsonValue, itemIndex: number): ObservationScope {
  const scope = requireJsonObject(value, `Tool result facts scope ${String(itemIndex)}`);
  rejectUnknown(scope, ['filters', 'limits', 'omitted', 'coverage', 'truncated', 'actuality'], `Tool result facts scope ${String(itemIndex)}`);
  if (scope.coverage !== undefined && scope.coverage !== 'complete' && scope.coverage !== 'partial' && scope.coverage !== 'absent') throw new Error(`Tool result facts scope ${String(itemIndex)} has invalid coverage.`);
  if (scope.truncated !== undefined && typeof scope.truncated !== 'boolean') throw new Error(`Tool result facts scope ${String(itemIndex)} has invalid truncation.`);
  if (scope.actuality !== undefined && scope.actuality !== 'observed' && scope.actuality !== 'predicted') throw new Error(`Tool result facts scope ${String(itemIndex)} has invalid actuality.`);
  if (scope.coverage === 'complete' && scope.truncated === true) throw new Error(`Tool result facts scope ${String(itemIndex)} cannot be complete and truncated.`);
  return Object.freeze({
    ...(scope.filters === undefined ? {} : { filters: requireJsonObject(scope.filters, `Tool result facts scope ${String(itemIndex)} filters`) }),
    ...(scope.limits === undefined ? {} : { limits: requireJsonObject(scope.limits, `Tool result facts scope ${String(itemIndex)} limits`) }),
    ...(scope.omitted === undefined ? {} : { omitted: requireJsonObject(scope.omitted, `Tool result facts scope ${String(itemIndex)} omitted`) }),
    ...(scope.coverage === undefined ? {} : { coverage: scope.coverage }),
    ...(scope.truncated === undefined ? {} : { truncated: scope.truncated }),
    ...(scope.actuality === undefined ? {} : { actuality: scope.actuality })
  });
}

function ownObservedResource(value: ObservedResource): ObservedResource {
  return Object.freeze({ ...value, ...(value.range ? { range: Object.freeze({ ...value.range }) } : {}) });
}

function ownObservationScope(value: ObservationScope): ObservationScope {
  return Object.freeze({ ...value,
    ...(value.filters ? { filters: parseJsonObject(value.filters) } : {}),
    ...(value.limits ? { limits: parseJsonObject(value.limits) } : {}),
    ...(value.omitted ? { omitted: parseJsonObject(value.omitted) } : {})
  });
}

function encodeObservedResource(value: ObservedResource): JsonObject {
  return Object.freeze({ uri: value.uri, ...(value.range ? { range: Object.freeze({ ...value.range }) } : {}), ...(value.sha256 ? { sha256: value.sha256 } : {}), ...(value.fullSha256 ? { fullSha256: value.fullSha256 } : {}), ...(value.mediaType ? { mediaType: value.mediaType } : {}) });
}

function encodeObservationScope(value: ObservationScope): JsonObject {
  return Object.freeze({ ...(value.filters ? { filters: value.filters } : {}), ...(value.limits ? { limits: value.limits } : {}), ...(value.omitted ? { omitted: value.omitted } : {}), ...(value.coverage ? { coverage: value.coverage } : {}), ...(value.truncated === undefined ? {} : { truncated: value.truncated }), ...(value.actuality ? { actuality: value.actuality } : {}) });
}

function parseOptionalSha256(value: JsonValue | undefined, field: string, itemIndex: number, resourceIndex: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) throw new Error(`Tool result facts resource ${String(itemIndex)}:${String(resourceIndex)} has an invalid ${field}.`);
  return value.toLowerCase();
}

function rejectUnknown(record: JsonObject, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}.`);
}

function requireJsonObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}
function jsonArray(value: JsonValue | undefined): value is readonly JsonValue[] { return Array.isArray(value); }

function toObservationJsonMember(value: unknown): JsonMember | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(toObservationJsonPrimitive).filter((item): item is JsonPrimitive => item !== undefined);
    return items.length === value.length ? Object.freeze(items) : undefined;
  }
  if (isRecord(value)) {
    const output: Record<string, JsonPrimitive | JsonPrimitive[]> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = Array.isArray(item)
        ? item.map(toObservationJsonPrimitive).filter((entry): entry is JsonPrimitive => entry !== undefined)
        : toObservationJsonPrimitive(item);
      if (json !== undefined) {
        output[key] = json;
      }
    }
    return Object.freeze(output);
  }
  return undefined;
}

function toObservationJsonPrimitive(value: unknown): JsonPrimitive | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function isObservationAction(value: unknown): value is ObservationAction {
  return value === 'list'
    || value === 'search'
    || value === 'read'
    || value === 'execute'
    || value === 'create'
    || value === 'update'
    || value === 'delete'
    || value === 'move'
    || value === 'verify';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
