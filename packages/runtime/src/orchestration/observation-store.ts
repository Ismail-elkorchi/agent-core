import { createHash, randomUUID } from 'node:crypto';
import { normalizeToolEvidenceDelta, type EvidenceRecord } from '@agent-core/evidence';
import {
  type JsonObject,
  type JsonValue,
  type ToolCall,
  type ToolDefinition,
  type ToolObservationPresentation,
  type ToolObservation,
  estimateJsonBytes,
  toJsonValue,
  validateToolObservationPresentation
} from '@agent-core/tools';

export const IMMEDIATE_TOOL_PRESENTATION_MAX_BYTES = 12_000;
export const RETAINED_TOOL_PRESENTATION_MAX_BYTES = 2_400;

export interface ToolObservationRecord {
  id: string;
  turnIndex: number;
  call: ToolCall;
  toolName: string;
  fullObservation: ToolObservation;
  immediatePresentation: ToolObservationPresentation;
  retainedPresentation: ToolObservationPresentation;
  evidence: EvidenceRecord[];
  createdAt: string;
}

export class ObservationStore {
  private readonly records = new Map<string, ToolObservationRecord>();

  put(input: {
    turnIndex: number;
    call: ToolCall;
    canonicalInput?: unknown;
    tool: ToolDefinition | undefined;
    observation: ToolObservation;
  }): ToolObservationRecord {
    const immediatePresentation = presentToolObservation({
      call: input.call,
      canonicalInput: input.canonicalInput,
      observation: input.observation,
      tool: input.tool,
      maxBytes: IMMEDIATE_TOOL_PRESENTATION_MAX_BYTES
    });
    const retainedPresentation = presentToolObservation({
      call: input.call,
      canonicalInput: input.canonicalInput,
      observation: input.observation,
      tool: input.tool,
      maxBytes: RETAINED_TOOL_PRESENTATION_MAX_BYTES
    });
    const id = `obs_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const record: ToolObservationRecord = {
      id,
      turnIndex: input.turnIndex,
      call: input.call,
      toolName: input.call.name,
      fullObservation: input.observation,
      immediatePresentation,
      retainedPresentation,
      evidence: normalizeToolEvidenceDelta(input.observation.evidence, {
        observationId: id,
        toolName: input.call.name,
        createdAt
      }),
      createdAt
    };
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): ToolObservationRecord | undefined {
    return this.records.get(id);
  }
}

export function serializeToolObservationPresentation(presentation: ToolObservationPresentation): string {
  return JSON.stringify(presentation, null, 2);
}

function presentToolObservation(input: {
  call: ToolCall;
  canonicalInput?: unknown;
  observation: ToolObservation;
  tool: ToolDefinition | undefined;
  maxBytes: number;
}): ToolObservationPresentation {
  const presented = buildToolObservationPresentation(input.call, input.canonicalInput, input.observation, input.tool, input.maxBytes);
  const redacted = redactToolObservationPresentation(presented);
  const reduced = reduceToolObservationPresentation(redacted, input.maxBytes, input.call.name);
  const validated = validateToolObservationPresentation(reduced);
  if (!validated.ok) {
    return invalidPresenterPresentation(input.call.name, validated.issues);
  }
  const serialized = serializeToolObservationPresentation(validated.presentation);
  if (Buffer.byteLength(serialized, 'utf8') <= input.maxBytes) {
    return validated.presentation;
  }
  return emergencyToolObservationPresentation(input.call.name, validated.presentation, Buffer.byteLength(serialized, 'utf8'), input.maxBytes);
}

function buildToolObservationPresentation(
  toolCall: ToolCall,
  canonicalInput: unknown,
  observation: ToolObservation,
  tool: ToolDefinition | undefined,
  maxBytes: number
): ToolObservationPresentation {
  let rawPresentation: unknown;
  try {
    rawPresentation = tool?.presentObservation
      ? tool.presentObservation({
        call: toolCall,
        input: canonicalInput,
        observation,
        limit: { maxBytes }
      })
      : fallbackToolObservationPresentation(toolCall, observation);
  } catch (error) {
    return {
      ok: false,
      title: 'Invalid tool presenter output',
      summary: `Presenter for ${toolCall.name} threw before producing an observation presentation.`,
      failures: {
        reason: 'presenter_error',
        error: error instanceof Error ? error.message : String(error)
      },
      truncated: false,
      next: 'Use the recorded tool observation in the ledger for debugging; the invalid presentation was replaced by a safe failure.'
    };
  }

  const validated = validateToolObservationPresentation(rawPresentation);
  return validated.ok ? validated.presentation : invalidPresenterPresentation(toolCall.name, validated.issues);
}

function fallbackToolObservationPresentation(toolCall: ToolCall, observation: ToolObservation): ToolObservationPresentation {
  const base = {
    ok: observation.ok,
    title: `${toolCall.name} observation`,
    summary: observation.summary,
    truncated: false
  };
  if (observation.ok) {
    return {
      ...base,
      results: {
        output: toJsonValue(observation.output),
        ...(observation.artifacts ? { artifacts: toJsonValue(observation.artifacts) } : {}),
        ...(observation.metadata ? { metadata: toJsonValue(observation.metadata) } : {})
      },
      next: 'This external tool used the generic presentation; treat the result as scoped to the tool call.'
    };
  }
  return {
    ...base,
    failures: toJsonValue(observation.output),
    next: 'Use the failure details to adjust the next tool call.'
  };
}

function invalidPresenterPresentation(toolName: string, issues: { path: string; message: string }[]): ToolObservationPresentation {
  return {
    ok: false,
    title: 'Invalid tool presenter output',
    summary: `Presenter for ${toolName} produced an invalid tool observation presentation. It was not sent to the model.`,
    failures: {
      reason: 'invalid_presenter_output',
      issues: issues.map((issue) => ({ path: issue.path, message: issue.message }))
    },
    truncated: false,
    next: 'Use the recorded tool observation in the ledger for debugging; the invalid presentation was replaced by a safe failure.'
  };
}

function redactToolObservationPresentation(presentation: ToolObservationPresentation): ToolObservationPresentation {
  const state = { redactions: 0 };
  const redacted = redactJsonValue(toJsonValue(presentation), [], state);
  const validated = validateToolObservationPresentation(redacted);
  const next = validated.ok ? validated.presentation : invalidPresenterPresentation('redaction', validated.issues);
  if (state.redactions === 0) {
    return next;
  }
  return addWarning(next, `Global redaction replaced ${String(state.redactions)} sensitive value${state.redactions === 1 ? '' : 's'} with [REDACTED].`);
}

function redactJsonValue(value: JsonValue, pathParts: string[], state: { redactions: number }): JsonValue {
  if (typeof value === 'string') {
    return redactString(value, pathParts, state);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactJsonValue(item, [...pathParts, String(index)], state));
  }
  if (isJsonObject(value)) {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = redactJsonValue(item, [...pathParts, key], state);
    }
    return output;
  }
  return value;
}

function redactString(value: string, pathParts: string[], state: { redactions: number }): string {
  const key = pathParts.at(-1) ?? '';
  if (/(authorization|credential|password|secret|token|api[-_]?key)/i.test(key) && value.length > 0) {
    state.redactions += 1;
    return '[REDACTED]';
  }
  const patterns = [
    /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    /(sk-(?:or-v1-)?[A-Za-z0-9_-]{16,})/g,
    /([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*=)[^\s]+/gi
  ];
  let next = value;
  for (const pattern of patterns) {
    next = next.replace(pattern, (_match: string, prefix?: string) => {
      state.redactions += 1;
      return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return next;
}

function reduceToolObservationPresentation(presentation: ToolObservationPresentation, maxBytes: number, toolName: string): ToolObservationPresentation {
  let next = cloneToolObservationPresentation(presentation);
  if (presentationBytes(next) <= maxBytes) {
    return next;
  }

  const omitted = { items: 0, bytes: 0 };
  let contentTruncated = false;
  let partialCoverage = false;
  const originalBytes = presentationBytes(next);
  while (presentationBytes(next) > maxBytes && next.results !== undefined) {
    const reduced = reduceJsonEvidence(next.results);
    if (!reduced.changed) {
      next.results = {
        truncated: true,
        message: 'Results omitted from the observation presentation because they exceeded the transcript budget.'
      };
      omitted.items += 1;
      partialCoverage = true;
      break;
    }
    next.results = reduced.value;
    omitted.items += reduced.omittedItems;
    omitted.bytes += reduced.omittedBytes;
    contentTruncated ||= reduced.truncated;
    partialCoverage ||= reduced.partial;
  }

  while (presentationBytes(next) > maxBytes && next.failures !== undefined) {
    const reduced = reduceJsonEvidence(next.failures);
    if (!reduced.changed) {
      next.failures = {
        truncated: true,
        message: 'Failure details omitted from the observation presentation because they exceeded the transcript budget.'
      };
      omitted.items += 1;
      partialCoverage = true;
      break;
    }
    next.failures = reduced.value;
    omitted.items += reduced.omittedItems;
    omitted.bytes += reduced.omittedBytes;
    contentTruncated ||= reduced.truncated;
    partialCoverage ||= reduced.partial;
  }

  if (omitted.items > 0 || omitted.bytes > 0 || presentationBytes(next) < originalBytes) {
    next = addWarning(next, 'The observation presentation was structurally reduced before serialization.');
    next = addPresentationOmitted(next, omitted.items, Math.max(omitted.bytes, originalBytes - presentationBytes(next)));
    if (contentTruncated) next.truncated = true;
    if (partialCoverage) next.coverage = 'partial';
  }

  if (presentationBytes(next) <= maxBytes) {
    return next;
  }

  return emergencyToolObservationPresentation(toolName, next, presentationBytes(next), maxBytes);
}

function reduceJsonEvidence(value: JsonValue): { value: JsonValue; changed: boolean; omittedItems: number; omittedBytes: number; truncated: boolean; partial: boolean } {
  const before = estimateJsonBytes(value);
  const shortened = shortenLongestString(value);
  if (shortened.changed) {
    return {
      value: shortened.value,
      changed: true,
      omittedItems: 0,
      omittedBytes: Math.max(0, before - estimateJsonBytes(shortened.value)),
      truncated: true,
      partial: false
    };
  }
  const dropped = dropOneArrayItem(value);
  if (dropped.changed) {
    return {
      value: dropped.value,
      changed: true,
      omittedItems: 1,
      omittedBytes: Math.max(0, before - estimateJsonBytes(dropped.value)),
      truncated: false,
      partial: true
    };
  }
  return { value, changed: false, omittedItems: 0, omittedBytes: 0, truncated: false, partial: false };
}

function shortenLongestString(value: JsonValue): { value: JsonValue; changed: boolean } {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= 1_000) {
      return { value, changed: false };
    }
    const next = `${value.slice(0, Math.max(0, Math.floor(value.length * 0.5)))}\n[field truncated for observation presentation]`;
    return { value: next, changed: true };
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = shortenLongestString(value[index] ?? null);
      if (result.changed) {
        const copy = [...value];
        copy[index] = result.value;
        return { value: copy, changed: true };
      }
    }
    return { value, changed: false };
  }
  if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const result = shortenLongestString(item);
      if (result.changed) {
        return { value: { ...value, [key]: result.value }, changed: true };
      }
    }
  }
  return { value, changed: false };
}

function dropOneArrayItem(value: JsonValue): { value: JsonValue; changed: boolean } {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { value, changed: false };
    }
    return { value: value.slice(0, -1), changed: true };
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      const [key, item] = entry;
      const result = dropOneArrayItem(item);
      if (result.changed) {
        return { value: { ...value, [key]: result.value }, changed: true };
      }
    }
  }
  return { value, changed: false };
}

function emergencyToolObservationPresentation(toolName: string, presentation: ToolObservationPresentation, bytes: number, maxBytes: number): ToolObservationPresentation {
  return {
    ok: presentation.ok,
    title: 'Tool observation emergency truncation',
    summary: `Observation presentation for ${toolName} remained too large after structured reduction.`,
    scope: {
      tool: toolName,
      originalTitle: presentation.title
    },
    omitted: {
      presentationBytes: bytes,
      maxBytes
    },
    truncated: true,
    warnings: ['Emergency truncation replaced the oversized presentation with this compact marker. No partial JSON was sent.'],
    next: 'Use a narrower tool call or inspect the full ledger observation outside the model transcript.'
  };
}

function addWarning(presentation: ToolObservationPresentation, warning: string): ToolObservationPresentation {
  const warnings = [...(presentation.warnings ?? [])];
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
  return { ...presentation, warnings };
}

function addPresentationOmitted(presentation: ToolObservationPresentation, items: number, bytes: number): ToolObservationPresentation {
  const omitted = { ...(presentation.omitted ?? {}) };
  if (items > 0) {
    omitted.presentationItems = numericJsonValue(omitted.presentationItems) + items;
  }
  if (bytes > 0) {
    omitted.presentationBytes = numericJsonValue(omitted.presentationBytes) + bytes;
  }
  return { ...presentation, omitted };
}

function numericJsonValue(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function cloneToolObservationPresentation(presentation: ToolObservationPresentation): ToolObservationPresentation {
  const json = toJsonValue(presentation);
  const validated = validateToolObservationPresentation(json);
  return validated.ok ? validated.presentation : invalidPresenterPresentation('clone', validated.issues);
}

function presentationBytes(presentation: ToolObservationPresentation): number {
  return Buffer.byteLength(JSON.stringify(toJsonValue(presentation), null, 2), 'utf8');
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sha256ToolObservationPresentation(presentation: ToolObservationPresentation): string {
  return createHash('sha256').update(serializeToolObservationPresentation(presentation)).digest('hex');
}
