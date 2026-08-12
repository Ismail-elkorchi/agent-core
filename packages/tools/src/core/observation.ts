import * as z from 'zod';
import { decodeOwnedToolCall } from './call.js';
import {
  validatePublicArtifactRef,
  encodeToolEvidenceDelta,
  parseToolEvidenceDelta,
  type ToolEvidenceDelta
} from '@agent-core/evidence';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import type {
  InvalidArgumentsToolFailureOutput,
  InvalidOutputToolFailureOutput,
  MissingServiceToolFailureOutput,
  PolicyToolFailureOutput,
  RuntimeErrorToolFailureOutput,
  ToolCall,
  ToolContent,
  ToolDefinition,
  ToolFailureObservation,
  ToolFailureObservationInput,
  ToolFailureOutput,
  ToolObservation,
  ToolResultObservation,
  ToolResultObservationInput,
  ToolScope,
  ToolValidationIssue,
  ToolValidationIssues,
  UnknownToolFailureOutput
} from './definition.js';

const OWNED_TOOL_OBSERVATIONS = new WeakSet();
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
    ...rest, ...(rest.details ? { details: ownDetails(rest.details) } : {})
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
  const issues = error instanceof z.ZodError
    ? validationIssues(error)
    : Object.freeze({ issues: Object.freeze([Object.freeze({ path: Object.freeze([]), code: 'invalid_observation', message: error.message })]) });
  return freezeFailure('Tool ' + toolName + ' returned an observation that violates its contract.', {
    blocked: true, reason: 'invalid_output', recovery: 'Treat this invocation as a tool implementation failure.', issues
  });
}
export function invalidToolInputObservation(toolName: string, message: string, details: unknown = {}): ToolFailureObservation<InvalidArgumentsToolFailureOutput> {
  return freezeFailure('Invalid arguments for ' + toolName + ': ' + message, {
    blocked: true, reason: 'invalid_arguments',
    recovery: 'Fix the arguments according to the tool schema and call this tool again.',
    details: ownDetails(details)
  });
}
export function missingServiceObservation(toolName: string, serviceName: string, recovery = 'This tool cannot run until the caller provides the required execution service.', details: unknown = {}): ToolFailureObservation<MissingServiceToolFailureOutput> {
  const ownedDetails = ownDetails(details);
  return freezeFailure('Tool ' + toolName + ' is missing required service: ' + serviceName, {
    blocked: true, reason: 'missing_service', service: serviceName,
    ...(Object.keys(ownedDetails).length > 0 ? { details: ownedDetails } : {}), recovery
  });
}
export function runtimeErrorObservation(toolName: string, error: unknown, details?: unknown): ToolFailureObservation<RuntimeErrorToolFailureOutput> {
  const message = error instanceof Error ? error.message : String(error);
  return freezeFailure('Tool ' + toolName + ' failed: ' + message, {
    blocked: true, reason: 'runtime_error', error: message,
    ...(details ? { details: ownDetails(details) } : {}),
    recovery: 'Use the observation to adjust the next tool call or choose another available tool.'
  });
}

/** The sole boundary from untrusted tool output into Agent Core. */
export function parseToolObservation(tool: Pick<ToolDefinition, 'outputSchema'> | undefined, value: unknown): ToolObservation {
  if (isOwnedToolObservation(value)) return value;
  return parseOwnedToolObservation(tool, parseJsonObject(value, JSON_LIMITS));
}

function isOwnedToolObservation(value: unknown): value is ToolObservation {
  return typeof value === 'object' && value !== null && OWNED_TOOL_OBSERVATIONS.has(value);
}

function parseOwnedToolObservation(tool: Pick<ToolDefinition, 'outputSchema'> | undefined, record: JsonObject): ToolObservation {
  const unknown = Object.keys(record).filter((key) => !['kind', 'ok', 'summary', 'scope', 'content', 'metadata', 'evidence', 'output'].includes(key));
  if (unknown.length > 0) throw new Error('Tool observation contains unsupported fields: ' + unknown.join(', ') + '.');
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) throw new Error('Tool observation requires a non-empty summary.');
  if (Buffer.byteLength(record.summary, 'utf8') > 64_000) throw new Error('Tool observation summary exceeds the host limit.');
  const scope = parseToolScope(record.scope);
  const content = parseContent(record.content);
  const metadata = record.metadata === undefined ? undefined : requireJsonObject(record.metadata, 'Tool observation metadata');
  const evidence = record.evidence === undefined ? undefined : parseEvidence(record.evidence);
  if (record.kind === 'result' && typeof record.ok === 'boolean') {
    if (!tool) throw new Error('A result observation requires its tool definition.');
    const parsed = tool.outputSchema.safeParse(record.output);
    if (!parsed.success) throw parsed.error;
    const output = parseJsonValue(parsed.data, JSON_LIMITS);
    return ownResultObservation({
      kind: 'result', ok: record.ok, summary: record.summary, scope, output,
      ...(content ? { content } : {}), ...(metadata ? { metadata } : {}), ...(evidence ? { evidence } : {})
    });
  }
  if (record.kind !== 'failure' || record.ok !== false) throw new Error('Tool observation kind and ok fields are inconsistent.');
  if (record.output === undefined) throw new Error('Tool failure output must be an object.');
  const output = parseFailureOutput(requireJsonObject(record.output, 'Tool failure output'));
  return ownFailureObservation({
    kind: 'failure', ok: false, summary: record.summary, scope, output,
    ...(content ? { content } : {}), ...(metadata ? { metadata } : {}), ...(evidence ? { evidence } : {})
  });
}

function ownResultObservation<TOutput>(observation: ToolResultObservationInput<JsonValue & TOutput>): ToolResultObservation<TOutput> {
  const owned = Object.freeze(observation) as ToolResultObservation<TOutput>;
  OWNED_TOOL_OBSERVATIONS.add(owned);
  return owned;
}

function ownFailureObservation<TOutput extends ToolFailureOutput>(observation: ToolFailureObservationInput<TOutput>): ToolFailureObservation<TOutput> {
  const owned = Object.freeze(observation) as ToolFailureObservation<TOutput>;
  OWNED_TOOL_OBSERVATIONS.add(owned);
  return owned;
}

export function decodeOwnedToolObservationForPersistence(record: JsonObject): ToolObservation {
  return parseOwnedToolObservation(record.kind === 'result' ? persistenceTool() : undefined, record);
}

function parseToolScope(value: JsonValue | undefined): ToolScope {
  if (value === undefined) throw new Error('Tool scope must be an object.');
  const record = requireJsonObject(value, 'Tool scope');
  const unknown = Object.keys(record).filter((key) => !['resources', 'filters', 'limits', 'omitted', 'coverage', 'truncated', 'causes'].includes(key));
  if (unknown.length > 0) throw new Error('Tool scope contains unsupported fields: ' + unknown.join(', ') + '.');
  if (!Array.isArray(record.resources) || !record.resources.every((item) => typeof item === 'string')) throw new Error('Tool scope resources must be strings.');
  if (record.coverage !== 'complete' && record.coverage !== 'partial') throw new Error('Tool scope coverage is invalid.');
  if (record.truncated !== undefined && typeof record.truncated !== 'boolean') throw new Error('Tool scope truncated must be boolean.');
  const rawCauses = record.causes;
  if (rawCauses !== undefined && (!Array.isArray(rawCauses) || !rawCauses.every((item) => typeof item === 'string' && item.length > 0))) throw new Error('Tool scope causes must be non-empty strings.');
  const resources = Object.freeze(record.resources.map(validateResourceScope));
  if (new Set(resources).size !== resources.length) throw new Error('Tool scope resources must be unique.');
  const filters = record.filters === undefined ? undefined : requireJsonObject(record.filters, 'Tool scope filters');
  const limits = record.limits === undefined ? undefined : requireJsonObject(record.limits, 'Tool scope limits');
  const omitted = record.omitted === undefined ? undefined : requireJsonObject(record.omitted, 'Tool scope omitted');
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
  switch (value.reason) {
    case 'unknown_tool': { exactFailure(value, ['blocked', 'reason', 'recovery', 'toolCall']); const toolCall = decodeToolCall(value.toolCall); if (!toolCall) break; return Object.freeze({ blocked: true, reason: value.reason, recovery: value.recovery, toolCall }); }
    case 'policy': exactFailure(value, ['blocked', 'reason', 'recovery', 'tool', 'policyReason', 'details']); if ((value.tool !== undefined && typeof value.tool !== 'string') || (value.policyReason !== undefined && typeof value.policyReason !== 'string') || (value.details !== undefined && !jsonObject(value.details))) break; return Object.freeze({ blocked: true, reason: value.reason, recovery: value.recovery, ...(typeof value.tool === 'string' ? { tool: value.tool } : {}), ...(typeof value.policyReason === 'string' ? { policyReason: value.policyReason } : {}), ...(jsonObject(value.details) ? { details: value.details } : {}) });
    case 'invalid_arguments': { exactFailure(value, ['blocked', 'reason', 'recovery', 'issues', 'details']); const issues = value.issues === undefined ? undefined : decodeValidationIssues(value.issues); if ((value.issues !== undefined && !issues) || (value.details !== undefined && !jsonObject(value.details))) break; return Object.freeze({ blocked: true, reason: value.reason, recovery: value.recovery, ...(issues ? { issues } : {}), ...(jsonObject(value.details) ? { details: value.details } : {}) }); }
    case 'invalid_output': { exactFailure(value, ['blocked', 'reason', 'recovery', 'issues']); const issues = decodeValidationIssues(value.issues); if (!issues) break; return Object.freeze({ blocked: true, reason: value.reason, recovery: value.recovery, issues }); }
    case 'missing_service': exactFailure(value, ['blocked', 'reason', 'recovery', 'service', 'details']); if (typeof value.service !== 'string' || (value.details !== undefined && !jsonObject(value.details))) break; return Object.freeze({ blocked: true, reason: value.reason, recovery: value.recovery, service: value.service, ...(jsonObject(value.details) ? { details: value.details } : {}) });
    case 'runtime_error': exactFailure(value, ['blocked', 'reason', 'recovery', 'error', 'details']); if (typeof value.error !== 'string' || (value.details !== undefined && !jsonObject(value.details))) break; return Object.freeze({ blocked: true, reason: value.reason, recovery: value.recovery, error: value.error, ...(jsonObject(value.details) ? { details: value.details } : {}) });
    default: break;
  }
  throw new Error('Tool failure output does not match a declared failure contract.');
}
function parseContent(value: JsonValue | undefined): readonly ToolContent[] | undefined {
  if (value === undefined) return undefined;
  if (!jsonArray(value)) throw new Error('Tool observation content must be an array.');
  return Object.freeze(value.map((item): ToolContent => {
    const record = requireJsonObject(item, 'Tool content');
    if (record.type === 'text' && typeof record.text === 'string' && (record.mediaType === undefined || typeof record.mediaType === 'string')) return Object.freeze({ type: 'text', text: record.text, ...(record.mediaType ? { mediaType: record.mediaType } : {}) });
    if ((record.type === 'image' || record.type === 'artifact') && record.artifact !== undefined) {
      const artifact = requireJsonObject(record.artifact, 'Tool content artifact');
      validatePublicArtifactRef(artifact);
      if (record.type === 'image' && (record.detail === 'high' || record.detail === 'original')) return Object.freeze({ type: 'image', artifact, detail: record.detail });
      if (record.type === 'artifact') return Object.freeze({ type: 'artifact', artifact });
    }
    throw new Error('Tool observation content item is invalid or uses an unsupported modality.');
  }));
}
function parseEvidence(value: JsonValue): ToolEvidenceDelta {
  return parseToolEvidenceDelta(requireJsonObject(value, 'Tool evidence'));
}
function persistenceTool(): Pick<ToolDefinition, 'outputSchema'> {
  return { outputSchema: z.unknown() };
}
function freezeFailure<T extends ToolFailureOutput>(summary: string, output: T): ToolFailureObservation<T> {
  if (summary.trim().length === 0 || Buffer.byteLength(summary, 'utf8') > 64_000) throw new Error('Tool failure summary is invalid.');
  Object.freeze(output);
  return ownFailureObservation({ kind: 'failure', ok: false, summary, scope: failureScope(), output });
}
function failureScope(): ToolScope { return Object.freeze({ resources: Object.freeze([]), coverage: 'partial', causes: Object.freeze(['tool_failure']) }); }
function jsonObject(value: JsonValue | undefined): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function jsonArray(value: JsonValue | undefined): value is readonly JsonValue[] { return Array.isArray(value); }
function requireJsonObject(value: JsonValue, label: string): JsonObject {
  if (!jsonObject(value)) throw new Error(label + ' must be an object.');
  return value;
}
function decodeToolCall(value: JsonValue | undefined): ToolCall | undefined {
  if (!jsonObject(value)) return undefined;
  try { return decodeOwnedToolCall(value); } catch { return undefined; }
}
function decodeValidationIssues(value: JsonValue | undefined): ToolValidationIssues | undefined {
  if (!jsonObject(value) || !jsonArray(value.issues)) return undefined;
  const issues: ToolValidationIssue[] = [];
  for (const issue of value.issues) {
    if (!jsonObject(issue) || !jsonArray(issue.path) || !issue.path.every((part) => typeof part === 'string' || typeof part === 'number') || typeof issue.code !== 'string' || typeof issue.message !== 'string') return undefined;
    issues.push(Object.freeze({ path: Object.freeze([...issue.path]), code: issue.code, message: issue.message }));
  }
  return Object.freeze({ issues: Object.freeze(issues) });
}
function validationIssues(error: z.ZodError): ToolValidationIssues {
  return Object.freeze({ issues: Object.freeze(error.issues.map((issue) => Object.freeze({ path: Object.freeze(issue.path.map((item) => typeof item === 'number' ? item : String(item))), code: issue.code, message: issue.message }))) });
}

function ownDetails(value: unknown): JsonObject { return parseJsonObject(value, JSON_LIMITS); }
function exactFailure(value: JsonObject, fields: readonly string[]): void { if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error('Tool failure output contains unsupported fields.'); }

export function encodeToolObservation(observation: ToolObservation): JsonObject {
  if (!isOwnedToolObservation(observation)) throw new Error('Tool observations must be decoded or constructed before encoding.');
  return Object.freeze({
    kind: observation.kind, ok: observation.ok, summary: observation.summary, scope: encodeToolScope(observation.scope), output: observation.kind === 'result' ? observation.output : encodeToolFailureOutput(observation.output),
    ...(observation.content ? { content: Object.freeze(observation.content.map(encodeToolContent)) } : {}),
    ...(observation.metadata ? { metadata: observation.metadata } : {}), ...(observation.evidence ? { evidence: encodeToolEvidenceDelta(observation.evidence) } : {})
  });
}

export function updateToolObservation(observation: ToolObservation, changes: { readonly summary?: string; readonly content?: readonly ToolContent[]; readonly metadata?: JsonObject; readonly output?: JsonValue }): ToolObservation {
  if (!isOwnedToolObservation(observation)) throw new Error('Tool observations must be owned before updating.');
  const summary = changes.summary ?? observation.summary;
  if (summary.trim().length === 0 || Buffer.byteLength(summary, 'utf8') > 64_000) throw new Error('Tool observation summary is invalid.');
  const content = changes.content === undefined ? observation.content : parseContent(parseJsonValue(changes.content, JSON_LIMITS));
  const metadata = changes.metadata === undefined ? observation.metadata : parseJsonObject(changes.metadata, JSON_LIMITS);
  if (observation.kind === 'failure') {
    const output = changes.output === undefined ? observation.output : parseFailureOutput(requireJsonObject(parseJsonValue(changes.output, JSON_LIMITS), 'Tool failure output'));
    return ownFailureObservation({ ...observation, summary, output, ...(content ? { content } : {}), ...(metadata ? { metadata } : {}) });
  }
  const output = changes.output === undefined ? observation.output : parseJsonValue(changes.output, JSON_LIMITS);
  return ownResultObservation({ ...observation, summary, output, ...(content ? { content } : {}), ...(metadata ? { metadata } : {}) });
}

function encodeToolScope(scope: ToolScope): JsonObject { return Object.freeze({ resources: Object.freeze([...scope.resources]), coverage: scope.coverage, ...(scope.filters ? { filters: scope.filters } : {}), ...(scope.limits ? { limits: scope.limits } : {}), ...(scope.omitted ? { omitted: scope.omitted } : {}), ...(scope.truncated === undefined ? {} : { truncated: scope.truncated }), ...(scope.causes ? { causes: Object.freeze([...scope.causes]) } : {}) }); }
function encodeToolContent(content: ToolContent): JsonObject { return content.type === 'text' ? Object.freeze({ type: content.type, text: content.text, ...(content.mediaType ? { mediaType: content.mediaType } : {}) }) : Object.freeze({ type: content.type, artifact: Object.freeze({ ...content.artifact }), ...(content.type === 'image' ? { detail: content.detail } : {}) }); }
export function encodeToolFailureOutput(output: ToolFailureOutput): JsonObject {
  const common = { blocked: true, reason: output.reason, recovery: output.recovery } as const;
  if (output.reason === 'unknown_tool') return Object.freeze({ ...common, toolCall: Object.freeze({ ...(output.toolCall.id ? { id: output.toolCall.id } : {}), name: output.toolCall.name, input: output.toolCall.input.kind === 'json' ? Object.freeze({ kind: 'json', value: output.toolCall.input.value }) : Object.freeze({ kind: 'text', value: output.toolCall.input.value }) }) });
  if (output.reason === 'policy') return Object.freeze({ ...common, ...(output.tool ? { tool: output.tool } : {}), ...(output.policyReason ? { policyReason: output.policyReason } : {}), ...(output.details ? { details: output.details } : {}) });
  if (output.reason === 'invalid_arguments') return Object.freeze({ ...common, ...(output.issues ? { issues: encodeValidationIssues(output.issues) } : {}), ...(output.details ? { details: output.details } : {}) });
  if (output.reason === 'invalid_output') return Object.freeze({ ...common, issues: encodeValidationIssues(output.issues) });
  if (output.reason === 'missing_service') return Object.freeze({ ...common, service: output.service, ...(output.details ? { details: output.details } : {}) });
  return Object.freeze({ ...common, error: output.error, ...(output.details ? { details: output.details } : {}) });
}
function encodeValidationIssues(value: ToolValidationIssues): JsonObject { return Object.freeze({ issues: Object.freeze(value.issues.map((issue) => Object.freeze({ path: Object.freeze([...issue.path]), code: issue.code, message: issue.message }))) }); }
