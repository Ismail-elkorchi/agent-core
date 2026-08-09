import { parseJsonObject, type JsonObject, type JsonPrimitive, type JsonValue } from '@agent-core/json';

export type JsonMember = JsonValue;

export type EvidenceAction =
  | 'list'
  | 'search'
  | 'read'
  | 'execute'
  | 'create'
  | 'update'
  | 'delete'
  | 'move'
  | 'verify';

export type EvidenceConfidence = 'unverified' | 'verified';
export type EvidenceOutcome = 'success' | 'failure';

export interface EvidenceRange {
  kind: 'line' | 'byte';
  start?: number;
  end?: number;
}

export interface EvidenceResource {
  uri: string;
  range?: EvidenceRange;
  sha256?: string;
  fullSha256?: string;
  mediaType?: string;
}

export interface EvidenceScope {
  filters?: JsonObject;
  limits?: JsonObject;
  omitted?: JsonObject;
  coverage?: 'complete' | 'partial' | 'absent';
  truncated?: boolean;
  confidence?: EvidenceConfidence;
}

export interface ToolEvidenceItem {
  action: EvidenceAction;
  resources?: readonly EvidenceResource[];
  scope?: EvidenceScope;
  summary?: string;
  outcome: EvidenceOutcome;
}

export interface ToolEvidenceDelta {
  items: readonly ToolEvidenceItem[];
}

export interface EvidenceRecord extends ToolEvidenceItem {
  id: string;
  observationId: string;
  toolName: string;
  createdAt: string;
  resources: readonly EvidenceResource[];
  outcome: EvidenceOutcome;
}

export interface EvidenceRecordContext {
  observationId: string;
  toolName: string;
  createdAt?: string;
}

export function normalizeToolEvidenceDelta(delta: unknown, context: EvidenceRecordContext): EvidenceRecord[] {
  if (delta === undefined) return [];
  const parsed = parseToolEvidenceDelta(delta);
  const createdAt = context.createdAt ?? new Date().toISOString();
  return parsed.items.map((item, index): EvidenceRecord => Object.freeze({
      id: `${context.observationId}:evidence:${String(index + 1)}`,
      observationId: context.observationId,
      toolName: context.toolName,
      createdAt,
      action: item.action,
      resources: item.resources ?? Object.freeze([]),
      outcome: item.outcome,
      ...(item.scope ? { scope: item.scope } : {}),
      ...(item.summary ? { summary: item.summary } : {})
    }));
}

export function evidenceDelta(items: readonly ToolEvidenceItem[]): ToolEvidenceDelta {
  return parseToolEvidenceDelta({ items });
}

/** The single ownership and validation boundary for evidence emitted by tools. */
export function parseToolEvidenceDelta(value: unknown): ToolEvidenceDelta {
  const record = parseJsonObject(value);
  rejectUnknown(record, ['items'], 'Tool evidence');
  if (!Array.isArray(record.items)) throw new Error('Tool evidence must contain an items array.');
  return Object.freeze({ items: Object.freeze(record.items.map((item, index) => parseEvidenceItem(item, index))) });
}

export function workspaceResource(path: string, options: Omit<EvidenceResource, 'uri'> = {}): EvidenceResource {
  return {
    uri: `workspace://${path}`,
    ...options
  };
}

export function toEvidenceJsonObject(value: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const json = toEvidenceJsonMember(item);
    if (json !== undefined) {
      output[key] = json;
    }
  }
  return output;
}

function parseEvidenceItem(value: JsonValue, index: number): ToolEvidenceItem {
  const item = parseJsonObject(value);
  rejectUnknown(item, ['action', 'resources', 'scope', 'summary', 'outcome'], `Tool evidence item ${String(index)}`);
  if (!isEvidenceAction(item.action)) throw new Error(`Tool evidence item ${String(index)} has an invalid action.`);
  if (item.outcome !== 'success' && item.outcome !== 'failure') throw new Error(`Tool evidence item ${String(index)} has an invalid outcome.`);
  if (item.resources !== undefined && !Array.isArray(item.resources)) throw new Error(`Tool evidence item ${String(index)} resources must be an array.`);
  if (item.summary !== undefined && (typeof item.summary !== 'string' || item.summary.trim().length === 0 || Buffer.byteLength(item.summary, 'utf8') > 1_000)) {
    throw new Error(`Tool evidence item ${String(index)} has an invalid summary.`);
  }
  const resources = item.resources === undefined ? undefined : Object.freeze(item.resources.map((resource, resourceIndex) => parseEvidenceResource(resource, index, resourceIndex)));
  const scope = item.scope === undefined ? undefined : parseEvidenceScope(item.scope, index);
  return Object.freeze({
    action: item.action,
    outcome: item.outcome,
    ...(resources ? { resources } : {}),
    ...(scope ? { scope } : {}),
    ...(typeof item.summary === 'string' ? { summary: item.summary.trim() } : {})
  });
}

function parseEvidenceResource(value: JsonValue, itemIndex: number, resourceIndex: number): EvidenceResource {
  const resource = parseJsonObject(value);
  rejectUnknown(resource, ['uri', 'range', 'sha256', 'fullSha256', 'mediaType'], `Tool evidence resource ${String(itemIndex)}:${String(resourceIndex)}`);
  if (typeof resource.uri !== 'string' || resource.uri.trim().length === 0 || Buffer.byteLength(resource.uri, 'utf8') > 1_000) {
    throw new Error(`Tool evidence resource ${String(itemIndex)}:${String(resourceIndex)} has an invalid URI.`);
  }
  const range = resource.range === undefined ? undefined : parseEvidenceRange(resource.range, itemIndex, resourceIndex);
  const sha256 = parseOptionalSha256(resource.sha256, 'sha256', itemIndex, resourceIndex);
  const fullSha256 = parseOptionalSha256(resource.fullSha256, 'fullSha256', itemIndex, resourceIndex);
  if (resource.mediaType !== undefined && (typeof resource.mediaType !== 'string' || resource.mediaType.trim().length === 0
    || Buffer.byteLength(resource.mediaType, 'utf8') > 200 || !/^[^\s/]+\/[^\s]+$/u.test(resource.mediaType.trim()))) {
    throw new Error(`Tool evidence resource ${String(itemIndex)}:${String(resourceIndex)} has an invalid media type.`);
  }
  return Object.freeze({
    uri: resource.uri.trim(),
    ...(range ? { range } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(fullSha256 ? { fullSha256 } : {}),
    ...(typeof resource.mediaType === 'string' ? { mediaType: resource.mediaType.trim() } : {})
  });
}

function parseEvidenceRange(value: JsonValue, itemIndex: number, resourceIndex: number): EvidenceRange {
  const range = parseJsonObject(value);
  rejectUnknown(range, ['kind', 'start', 'end'], `Tool evidence range ${String(itemIndex)}:${String(resourceIndex)}`);
  if (range.kind !== 'line' && range.kind !== 'byte') throw new Error(`Tool evidence range ${String(itemIndex)}:${String(resourceIndex)} has an invalid kind.`);
  const minimum = range.kind === 'line' ? 1 : 0;
  for (const key of ['start', 'end'] as const) {
    const number = range[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum)) throw new Error(`Tool evidence range ${String(itemIndex)}:${String(resourceIndex)} has an invalid ${key}.`);
  }
  if (typeof range.start === 'number' && typeof range.end === 'number' && range.end < range.start) throw new Error(`Tool evidence range ${String(itemIndex)}:${String(resourceIndex)} ends before it starts.`);
  return Object.freeze({ kind: range.kind, ...(typeof range.start === 'number' ? { start: range.start } : {}), ...(typeof range.end === 'number' ? { end: range.end } : {}) });
}

function parseEvidenceScope(value: JsonValue, itemIndex: number): EvidenceScope {
  const scope = parseJsonObject(value);
  rejectUnknown(scope, ['filters', 'limits', 'omitted', 'coverage', 'truncated', 'confidence'], `Tool evidence scope ${String(itemIndex)}`);
  if (scope.coverage !== undefined && scope.coverage !== 'complete' && scope.coverage !== 'partial' && scope.coverage !== 'absent') throw new Error(`Tool evidence scope ${String(itemIndex)} has invalid coverage.`);
  if (scope.truncated !== undefined && typeof scope.truncated !== 'boolean') throw new Error(`Tool evidence scope ${String(itemIndex)} has invalid truncation.`);
  if (scope.confidence !== undefined && scope.confidence !== 'verified' && scope.confidence !== 'unverified') throw new Error(`Tool evidence scope ${String(itemIndex)} has invalid confidence.`);
  if (scope.coverage === 'complete' && scope.truncated === true) throw new Error(`Tool evidence scope ${String(itemIndex)} cannot be complete and truncated.`);
  return Object.freeze({
    ...(scope.filters === undefined ? {} : { filters: parseJsonObject(scope.filters) }),
    ...(scope.limits === undefined ? {} : { limits: parseJsonObject(scope.limits) }),
    ...(scope.omitted === undefined ? {} : { omitted: parseJsonObject(scope.omitted) }),
    ...(scope.coverage === undefined ? {} : { coverage: scope.coverage }),
    ...(scope.truncated === undefined ? {} : { truncated: scope.truncated }),
    ...(scope.confidence === undefined ? {} : { confidence: scope.confidence })
  });
}

function parseOptionalSha256(value: JsonValue | undefined, field: string, itemIndex: number, resourceIndex: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) throw new Error(`Tool evidence resource ${String(itemIndex)}:${String(resourceIndex)} has an invalid ${field}.`);
  return value.toLowerCase();
}

function rejectUnknown(record: JsonObject, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}.`);
}

function toEvidenceJsonMember(value: unknown): JsonMember | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(toEvidenceJsonPrimitive).filter((item): item is JsonPrimitive => item !== undefined);
    return items.length === value.length ? items : undefined;
  }
  if (isRecord(value)) {
    const output: Record<string, JsonPrimitive | JsonPrimitive[]> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = Array.isArray(item)
        ? item.map(toEvidenceJsonPrimitive).filter((entry): entry is JsonPrimitive => entry !== undefined)
        : toEvidenceJsonPrimitive(item);
      if (json !== undefined) {
        output[key] = json;
      }
    }
    return output;
  }
  return undefined;
}

function toEvidenceJsonPrimitive(value: unknown): JsonPrimitive | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function isEvidenceAction(value: unknown): value is EvidenceAction {
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
