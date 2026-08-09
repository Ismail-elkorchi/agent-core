import * as z from 'zod';
import {
  parseJsonObject,
  parseJsonValue,
  validatePublicArtifactRef,
  type JsonObject,
  type JsonValue,
  type ToolEvidenceDelta
} from '@agent-core/evidence';
import type {
  InvalidArgumentsToolFailureOutput,
  InvalidOutputToolFailureOutput,
  MissingServiceDetails,
  MissingServiceToolFailureOutput,
  PolicyToolFailureOutput,
  RuntimeErrorToolFailureOutput,
  ToolCall,
  ToolContent,
  ToolDefinition,
  ToolFailureObservation,
  ToolFailureOutput,
  ToolObservation,
  ToolScope,
  ToolValidationIssues,
  UnknownToolFailureOutput
} from './definition.js';
import { validateResourceScope } from './resources.js';

type PolicyFailureDetails = Omit<PolicyToolFailureOutput, 'blocked' | 'reason' | 'recovery'> & { recovery?: string };
const JSON_LIMITS = { maxDepth: 32, maxCollectionEntries: 50_000, maxStringBytes: 4_000_000, maxTotalBytes: 8_000_000 };

export function unknownToolObservation(call: ToolCall): ToolFailureObservation<UnknownToolFailureOutput> {
  return freezeFailure('Unknown tool: ' + call.name, {
    blocked: true, reason: 'unknown_tool', toolCall: call,
    recovery: 'Call one of the native tools provided in the current model request.'
  });
}
export function policyBlockedObservation(summary: string, details: PolicyFailureDetails = {}): ToolFailureObservation<PolicyToolFailureOutput> {
  const { recovery, ...rest } = details;
  return freezeFailure(summary, {
    blocked: true, reason: 'policy',
    recovery: recovery ?? 'Choose an available tool or ask the user to allow the required resource access.',
    ...rest
  });
}
export function invalidArgumentsObservation(toolName: string, error: z.ZodError): ToolFailureObservation<InvalidArgumentsToolFailureOutput> {
  return freezeFailure('Invalid arguments for ' + toolName + ': ' + z.prettifyError(error), {
    blocked: true, reason: 'invalid_arguments',
    recovery: 'Fix the arguments according to the tool schema and call this tool again.',
    issues: validationIssues(error)
  });
}
export function invalidOutputObservation(toolName: string, error: z.ZodError | Error): ToolFailureObservation<InvalidOutputToolFailureOutput> {
  const issues = error instanceof z.ZodError ? validationIssues(error) : { issues: [{ path: [], code: 'invalid_observation', message: error.message }] };
  return freezeFailure('Tool ' + toolName + ' returned an observation that violates its contract.', {
    blocked: true, reason: 'invalid_output', recovery: 'Treat this invocation as a tool implementation failure.', issues
  });
}
export function invalidToolInputObservation(toolName: string, message: string, details: Record<string, unknown> = {}): ToolFailureObservation<InvalidArgumentsToolFailureOutput> {
  return freezeFailure('Invalid arguments for ' + toolName + ': ' + message, {
    blocked: true, reason: 'invalid_arguments',
    recovery: 'Fix the arguments according to the tool schema and call this tool again.',
    details
  });
}
export function missingServiceObservation(toolName: string, serviceName: string, recovery = 'This tool cannot run until the caller provides the required execution service.', details: MissingServiceDetails = {}): ToolFailureObservation<MissingServiceToolFailureOutput> {
  return freezeFailure('Tool ' + toolName + ' is missing required service: ' + serviceName, {
    blocked: true, reason: 'missing_service', service: serviceName,
    ...(Object.keys(details).length > 0 ? { details } : {}), recovery
  });
}
export function runtimeErrorObservation(toolName: string, error: unknown, details?: Record<string, unknown>): ToolFailureObservation<RuntimeErrorToolFailureOutput> {
  const message = error instanceof Error ? error.message : String(error);
  return freezeFailure('Tool ' + toolName + ' failed: ' + message, {
    blocked: true, reason: 'runtime_error', error: message,
    ...(details ? { details } : {}),
    recovery: 'Use the observation to adjust the next tool call or choose another available tool.'
  });
}

/** The sole boundary from untrusted tool output into Agent Core. */
export function parseToolObservation(tool: Pick<ToolDefinition, 'outputSchema'> | undefined, value: unknown): ToolObservation<JsonValue> {
  return parseOwnedToolObservation(tool, parseJsonObject(value, JSON_LIMITS));
}

function parseOwnedToolObservation(tool: Pick<ToolDefinition, 'outputSchema'> | undefined, record: JsonObject): ToolObservation<JsonValue> {
  const unknown = Object.keys(record).filter((key) => !['kind', 'ok', 'summary', 'scope', 'content', 'metadata', 'evidence', 'output'].includes(key));
  if (unknown.length > 0) throw new Error('Tool observation contains unsupported fields: ' + unknown.join(', ') + '.');
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) throw new Error('Tool observation requires a non-empty summary.');
  if (Buffer.byteLength(record.summary, 'utf8') > 64_000) throw new Error('Tool observation summary exceeds the host limit.');
  const scope = parseToolScope(record.scope);
  const content = parseContent(record.content);
  const metadata = record.metadata === undefined ? undefined : parseJsonObject(record.metadata, JSON_LIMITS);
  const evidence = record.evidence === undefined ? undefined : parseEvidence(record.evidence);
  if (record.kind === 'result' && typeof record.ok === 'boolean') {
    if (!tool) throw new Error('A result observation requires its tool definition.');
    const parsed = tool.outputSchema.safeParse(record.output);
    if (!parsed.success) throw parsed.error;
    const output = parseJsonValue(parsed.data, JSON_LIMITS);
    return Object.freeze({
      kind: 'result', ok: record.ok, summary: record.summary, scope, output,
      ...(content ? { content } : {}), ...(metadata ? { metadata } : {}), ...(evidence ? { evidence } : {})
    });
  }
  if (record.kind !== 'failure' || record.ok !== false) throw new Error('Tool observation kind and ok fields are inconsistent.');
  const output = parseFailureOutput(parseJsonObject(record.output, JSON_LIMITS));
  return Object.freeze({
    kind: 'failure', ok: false, summary: record.summary, scope, output,
    ...(content ? { content } : {}), ...(metadata ? { metadata } : {}), ...(evidence ? { evidence } : {})
  });
}

export function normalizeToolObservationForPersistence(value: unknown): ToolObservation<JsonValue> {
  const record = parseJsonObject(value, JSON_LIMITS);
  return parseOwnedToolObservation(record.kind === 'result' ? persistenceTool() : undefined, record);
}

export function parseToolScope(value: unknown): ToolScope {
  const record = parseJsonObject(value, JSON_LIMITS);
  const unknown = Object.keys(record).filter((key) => !['resources', 'filters', 'limits', 'omitted', 'coverage', 'truncated', 'causes'].includes(key));
  if (unknown.length > 0) throw new Error('Tool scope contains unsupported fields: ' + unknown.join(', ') + '.');
  if (!Array.isArray(record.resources) || !record.resources.every((item) => typeof item === 'string')) throw new Error('Tool scope resources must be strings.');
  if (record.coverage !== 'complete' && record.coverage !== 'partial') throw new Error('Tool scope coverage is invalid.');
  if (record.truncated !== undefined && typeof record.truncated !== 'boolean') throw new Error('Tool scope truncated must be boolean.');
  const rawCauses = record.causes;
  if (rawCauses !== undefined && (!Array.isArray(rawCauses) || !rawCauses.every((item) => typeof item === 'string' && item.length > 0))) throw new Error('Tool scope causes must be non-empty strings.');
  const resources = Object.freeze(record.resources.map(validateResourceScope));
  if (new Set(resources).size !== resources.length) throw new Error('Tool scope resources must be unique.');
  const filters = record.filters === undefined ? undefined : parseJsonObject(record.filters);
  const limits = record.limits === undefined ? undefined : parseJsonObject(record.limits);
  const omitted = record.omitted === undefined ? undefined : parseJsonObject(record.omitted);
  const causes = rawCauses === undefined ? undefined : Object.freeze([...new Set(rawCauses as string[])]);
  if (record.coverage === 'complete' && (record.truncated === true || (causes?.length ?? 0) > 0)) throw new Error('A complete tool scope cannot be truncated or have omission causes.');
  return Object.freeze({
    resources, coverage: record.coverage,
    ...(filters ? { filters } : {}), ...(limits ? { limits } : {}), ...(omitted ? { omitted } : {}),
    ...(record.truncated === undefined ? {} : { truncated: record.truncated }), ...(causes ? { causes } : {})
  });
}

function parseFailureOutput(value: JsonObject): ToolFailureOutput {
  if (value.blocked !== true || typeof value.recovery !== 'string' || value.recovery.length === 0) throw new Error('Tool failure output must be blocked and provide recovery guidance.');
  if (value.reason === 'unknown_tool' && isToolCall(value.toolCall)) return Object.freeze({ blocked: true, reason: 'unknown_tool', recovery: value.recovery, toolCall: value.toolCall as unknown as ToolCall });
  if (value.reason === 'policy') return Object.freeze({ blocked: true, reason: 'policy', recovery: value.recovery, ...(typeof value.tool === 'string' ? { tool: value.tool } : {}), ...(typeof value.policyReason === 'string' ? { policyReason: value.policyReason } : {}), ...(jsonObject(value.details) ? { details: value.details } : {}) });
  if (value.reason === 'invalid_arguments') return Object.freeze({ blocked: true, reason: 'invalid_arguments', recovery: value.recovery, ...(isValidationIssues(value.issues) ? { issues: value.issues as unknown as ToolValidationIssues } : {}), ...(jsonObject(value.details) ? { details: value.details } : {}) });
  if (value.reason === 'invalid_output' && isValidationIssues(value.issues)) return Object.freeze({ blocked: true, reason: 'invalid_output', recovery: value.recovery, issues: value.issues as unknown as ToolValidationIssues });
  if (value.reason === 'missing_service' && typeof value.service === 'string') return Object.freeze({ blocked: true, reason: 'missing_service', recovery: value.recovery, service: value.service, ...(isMissingServiceDetails(value.details) ? { details: value.details as unknown as MissingServiceDetails } : {}) });
  if (value.reason === 'runtime_error' && typeof value.error === 'string') return Object.freeze({ blocked: true, reason: 'runtime_error', recovery: value.recovery, error: value.error, ...(jsonObject(value.details) ? { details: value.details } : {}) });
  throw new Error('Tool failure output does not match a declared failure contract.');
}
function parseContent(value: unknown): readonly ToolContent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Tool observation content must be an array.');
  return Object.freeze(value.map((item): ToolContent => {
    const record = ownRecord(item, 'Tool content');
    if (record.type === 'text' && typeof record.text === 'string' && (record.mediaType === undefined || typeof record.mediaType === 'string')) return Object.freeze({ type: 'text', text: record.text, ...(record.mediaType ? { mediaType: record.mediaType } : {}) });
    if ((record.type === 'image' || record.type === 'artifact') && record.artifact !== undefined) {
      const artifact = parseJsonObject(record.artifact, JSON_LIMITS);
      validatePublicArtifactRef(artifact);
      if (record.type === 'image' && (record.detail === 'high' || record.detail === 'original')) return Object.freeze({ type: 'image', artifact, detail: record.detail });
      if (record.type === 'artifact') return Object.freeze({ type: 'artifact', artifact });
    }
    throw new Error('Tool observation content item is invalid or uses an unsupported modality.');
  }));
}
function parseEvidence(value: unknown): ToolEvidenceDelta {
  const copy = parseJsonObject(value, JSON_LIMITS);
  if (!Array.isArray(copy.items)) throw new Error('Tool evidence must contain an items array.');
  return copy as unknown as ToolEvidenceDelta;
}
function persistenceTool(): Pick<ToolDefinition, 'outputSchema'> {
  return { outputSchema: z.unknown() };
}
function freezeFailure<T extends ToolFailureOutput>(summary: string, output: T): ToolFailureObservation<T> {
  return Object.freeze({ kind: 'failure', ok: false, summary, scope: failureScope(), output });
}
function failureScope(): ToolScope { return Object.freeze({ resources: Object.freeze([]), coverage: 'partial', causes: Object.freeze(['tool_failure']) }); }
function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(label + ' must be an object.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(label + ' has an unsupported prototype.');
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(label + ' contains a symbol key.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (!('value' in descriptor)) throw new Error(label + ' contains an accessor.');
    output[key] = descriptor.value;
  }
  return output;
}
function jsonObject(value: JsonValue | undefined): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isToolCall(value: JsonValue | undefined): boolean {
  return jsonObject(value) && typeof value.name === 'string' && (value.id === undefined || typeof value.id === 'string') && jsonObject(value.input)
    && ((value.input.kind === 'text' && typeof value.input.value === 'string') || (value.input.kind === 'json' && jsonObject(value.input.value)));
}
function isValidationIssues(value: JsonValue | undefined): boolean {
  return jsonObject(value) && Array.isArray(value.issues) && value.issues.every((issue) => jsonObject(issue) && Array.isArray(issue.path)
    && issue.path.every((part) => typeof part === 'string' || typeof part === 'number') && typeof issue.code === 'string' && typeof issue.message === 'string');
}
function isMissingServiceDetails(value: JsonValue | undefined): boolean {
  return jsonObject(value) && (value.expected === undefined || typeof value.expected === 'string') && (value.actualType === undefined || typeof value.actualType === 'string');
}
function validationIssues(error: z.ZodError): ToolValidationIssues {
  return { issues: error.issues.map((issue) => ({ path: issue.path.map((item) => typeof item === 'number' ? item : String(item)), code: issue.code, message: issue.message })) };
}
