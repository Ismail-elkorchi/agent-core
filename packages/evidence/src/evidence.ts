import type { JsonObject, JsonPrimitive, JsonValue } from './json.js';

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
  mediaType?: string;
}

export interface EvidenceScope {
  filters?: JsonObject;
  limits?: JsonObject;
  omitted?: JsonObject;
  coverage?: 'complete' | 'partial';
  truncated?: boolean;
  confidence?: EvidenceConfidence;
}

export interface ToolEvidenceItem {
  action: EvidenceAction;
  resources?: EvidenceResource[];
  scope?: EvidenceScope;
  summary?: string;
  outcome?: EvidenceOutcome;
}

export interface ToolEvidenceDelta {
  items: ToolEvidenceItem[];
}

export interface EvidenceRecord extends ToolEvidenceItem {
  id: string;
  observationId: string;
  toolName: string;
  createdAt: string;
  resources: EvidenceResource[];
  outcome: EvidenceOutcome;
}

export interface EvidenceRecordContext {
  observationId: string;
  toolName: string;
  createdAt?: string;
}

export function normalizeToolEvidenceDelta(delta: unknown, context: EvidenceRecordContext): EvidenceRecord[] {
  if (!isRecord(delta) || !Array.isArray(delta.items)) {
    return [];
  }
  const createdAt = context.createdAt ?? new Date().toISOString();
  const records: EvidenceRecord[] = [];
  for (const [index, item] of delta.items.entries()) {
    if (!isRecord(item) || !isEvidenceAction(item.action)) {
      continue;
    }
    const resources = Array.isArray(item.resources)
      ? item.resources.map(normalizeEvidenceResource).filter((resource): resource is EvidenceResource => resource !== undefined)
      : [];
    const record: EvidenceRecord = {
      id: `${context.observationId}:evidence:${String(index + 1)}`,
      observationId: context.observationId,
      toolName: context.toolName,
      createdAt,
      action: item.action,
      resources,
      outcome: item.outcome === 'failure' ? 'failure' : 'success'
    };
    const scope = normalizeEvidenceScope(item.scope);
    if (scope) {
      record.scope = scope;
    }
    if (typeof item.summary === 'string' && item.summary.trim().length > 0) {
      record.summary = item.summary.trim().slice(0, 1_000);
    }
    records.push(record);
  }
  return records;
}

export function evidenceDelta(items: ToolEvidenceItem[]): ToolEvidenceDelta {
  return { items };
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

function normalizeEvidenceResource(value: unknown): EvidenceResource | undefined {
  if (!isRecord(value) || typeof value.uri !== 'string' || value.uri.trim().length === 0) {
    return undefined;
  }
  const resource: EvidenceResource = { uri: value.uri.trim().slice(0, 1_000) };
  const range = normalizeEvidenceRange(value.range);
  if (range) {
    resource.range = range;
  }
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256)) {
    resource.sha256 = value.sha256.toLowerCase();
  }
  if (typeof value.mediaType === 'string' && value.mediaType.trim().length > 0) {
    resource.mediaType = value.mediaType.trim().slice(0, 200);
  }
  return resource;
}

function normalizeEvidenceRange(value: unknown): EvidenceRange | undefined {
  if (!isRecord(value) || (value.kind !== 'line' && value.kind !== 'byte')) {
    return undefined;
  }
  const range: EvidenceRange = { kind: value.kind };
  if (typeof value.start === 'number' && Number.isFinite(value.start)) {
    range.start = Math.max(0, Math.floor(value.start));
  }
  if (typeof value.end === 'number' && Number.isFinite(value.end)) {
    range.end = Math.max(0, Math.floor(value.end));
  }
  return range;
}

function normalizeEvidenceScope(value: unknown): EvidenceScope | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const scope: EvidenceScope = {};
  const filters = isRecord(value.filters) ? toEvidenceJsonObject(value.filters) : undefined;
  const limits = isRecord(value.limits) ? toEvidenceJsonObject(value.limits) : undefined;
  const omitted = isRecord(value.omitted) ? toEvidenceJsonObject(value.omitted) : undefined;
  if (filters && Object.keys(filters).length > 0) {
    scope.filters = filters;
  }
  if (limits && Object.keys(limits).length > 0) {
    scope.limits = limits;
  }
  if (omitted && Object.keys(omitted).length > 0) {
    scope.omitted = omitted;
  }
  if (typeof value.truncated === 'boolean') {
    scope.truncated = value.truncated;
  }
  if (value.coverage === 'complete' || value.coverage === 'partial') {
    scope.coverage = value.coverage;
  }
  if (value.confidence === 'verified' || value.confidence === 'unverified') {
    scope.confidence = value.confidence;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
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
