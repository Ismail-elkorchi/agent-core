import * as z from 'zod';
import { isJsonObject, normalizeJsonSafe, validateArtifactRef, type ArtifactRef, type JsonObject, type JsonValue } from '@agent-core/evidence';
import type {
  InvalidArgumentsToolFailureOutput,
  MissingServiceDetails,
  MissingServiceToolFailureOutput,
  PolicyToolFailureOutput,
  RuntimeErrorToolFailureOutput,
  ToolCall,
  ToolFailureObservation,
  ToolFailureOutput,
  ToolObservation,
  ToolValidationIssues,
  UnknownToolFailureOutput
} from './definition.js';

type PolicyFailureDetails = Omit<PolicyToolFailureOutput, 'blocked' | 'reason' | 'recovery'> & {
  recovery?: string;
};

export function unknownToolObservation(call: ToolCall): ToolFailureObservation<UnknownToolFailureOutput> {
  return {
    kind: 'failure',
    ok: false,
    summary: `Unknown tool: ${call.name}`,
    output: {
      blocked: true,
      reason: 'unknown_tool',
      toolCall: call,
      recovery: 'Call one of the native tools provided in the current model request.'
    }
  };
}

export function policyBlockedObservation(summary: string, details: PolicyFailureDetails = {}): ToolFailureObservation<PolicyToolFailureOutput> {
  const { recovery, ...rest } = details;
  return {
    kind: 'failure',
    ok: false,
    summary,
    output: {
      blocked: true,
      reason: 'policy',
      recovery: recovery ?? 'Choose an available tool or ask the user to allow the required risk.',
      ...rest
    }
  };
}

export function invalidArgumentsObservation(toolName: string, error: z.ZodError): ToolFailureObservation<InvalidArgumentsToolFailureOutput> {
  return {
    kind: 'failure',
    ok: false,
    summary: `Invalid arguments for ${toolName}: ${z.prettifyError(error)}`,
    output: {
      blocked: true,
      reason: 'invalid_arguments',
      recovery: 'Fix the arguments according to the tool schema and call this tool again.',
      issues: validationIssues(error)
    }
  };
}

export function invalidToolInputObservation(toolName: string, message: string, details: Record<string, unknown> = {}): ToolFailureObservation<InvalidArgumentsToolFailureOutput> {
  return {
    kind: 'failure',
    ok: false,
    summary: `Invalid arguments for ${toolName}: ${message}`,
    output: {
      blocked: true,
      reason: 'invalid_arguments',
      recovery: 'Fix the arguments according to the tool schema and call this tool again.',
      details
    }
  };
}

export function missingServiceObservation(
  toolName: string,
  serviceName: string,
  recovery = 'This tool cannot run until the caller provides the required execution service.',
  details: MissingServiceDetails = {}
): ToolFailureObservation<MissingServiceToolFailureOutput> {
  return {
    kind: 'failure',
    ok: false,
    summary: `Tool ${toolName} is missing required service: ${serviceName}`,
    output: {
      blocked: true,
      reason: 'missing_service',
      service: serviceName,
      ...(Object.keys(details).length > 0 ? { details } : {}),
      recovery
    }
  };
}

export function runtimeErrorObservation(toolName: string, error: unknown, details?: Record<string, unknown>): ToolFailureObservation<RuntimeErrorToolFailureOutput> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'failure',
    ok: false,
    summary: `Tool ${toolName} failed: ${message}`,
    output: {
      blocked: true,
      reason: 'runtime_error',
      error: message,
      ...(details ? { details } : {}),
      recovery: 'Use the observation to adjust the next tool call or choose another available tool.'
    }
  };
}

/** Converts an untrusted tool return value into a bounded, replay-safe observation. */
export function normalizeToolObservationForPersistence(value: unknown): ToolObservation<JsonValue> {
  if (!isRecord(value) || typeof value.summary !== 'string' || value.summary.trim().length === 0) throw new Error('Tool observation requires a non-empty summary.');
  const output = normalizeJsonSafe(value.output).value;
  const artifacts = parseArtifacts(value.artifacts);
  const metadata = parseMetadata(value.metadata);
  if (value.kind === 'result' && typeof value.ok === 'boolean') {
    return Object.freeze({ kind: 'result', ok: value.ok, output, summary: value.summary, ...artifacts, ...metadata });
  }
  if (value.kind !== 'failure' || value.ok !== false) throw new Error('Tool observation must be a successful result or a failure.');
  return Object.freeze({ kind: 'failure', ok: false, output: parseFailureOutput(output), summary: value.summary, ...artifacts, ...metadata });
}

function parseFailureOutput(value: JsonValue): ToolFailureOutput {
  if (!isJsonObject(value) || value.blocked !== true || typeof value.recovery !== 'string') return persistenceFailure(value);
  if (value.reason === 'unknown_tool' && isToolCall(value.toolCall)) return { blocked: true, reason: 'unknown_tool', recovery: value.recovery, toolCall: value.toolCall };
  if (value.reason === 'policy') return {
    blocked: true, reason: 'policy', recovery: value.recovery,
    ...(typeof value.tool === 'string' ? { tool: value.tool } : {}),
    ...(isToolRisk(value.risk) ? { risk: value.risk } : {}),
    ...(typeof value.policyReason === 'string' ? { policyReason: value.policyReason } : {}),
    ...(isJsonObject(value.details) ? { details: value.details } : {})
  };
  if (value.reason === 'invalid_arguments') return {
    blocked: true, reason: 'invalid_arguments', recovery: value.recovery,
    ...(isValidationIssues(value.issues) ? { issues: value.issues } : {}),
    ...(isJsonObject(value.details) ? { details: value.details } : {})
  };
  if (value.reason === 'missing_service' && typeof value.service === 'string') return {
    blocked: true, reason: 'missing_service', recovery: value.recovery, service: value.service,
    ...(isMissingServiceDetails(value.details) ? { details: value.details } : {})
  };
  if (value.reason === 'runtime_error' && typeof value.error === 'string') return {
    blocked: true, reason: 'runtime_error', recovery: value.recovery, error: value.error,
    ...(isJsonObject(value.details) ? { details: value.details } : {})
  };
  return persistenceFailure(value);
}

function persistenceFailure(output: JsonValue): RuntimeErrorToolFailureOutput {
  return { blocked: true, reason: 'runtime_error', error: 'Tool failure output was malformed.', recovery: 'Treat this tool call as failed and choose a safe alternative.', details: { output } };
}
function parseArtifacts(value: unknown): { artifacts?: ArtifactRef[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error('Tool observation artifacts must be an array.');
  const artifacts = value.map((item) => { validateArtifactRef(item); return Object.freeze({ ...item }); });
  return artifacts.length === 0 ? {} : { artifacts };
}
function parseMetadata(value: unknown): { metadata?: JsonObject } {
  if (value === undefined) return {};
  const normalized = normalizeJsonSafe(value).value;
  if (!isJsonObject(normalized)) throw new Error('Tool observation metadata must be an object.');
  return { metadata: normalized };
}
function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value) && typeof value.name === 'string' && value.name.length > 0 && (value.id === undefined || typeof value.id === 'string')
    && isRecord(value.input) && ((value.input.kind === 'text' && typeof value.input.value === 'string') || (value.input.kind === 'json' && isJsonObject(value.input.value)));
}
function isToolRisk(value: unknown): value is import('./policy.js').ToolRisk { return value === 'read' || value === 'write' || value === 'execute' || value === 'network' || value === 'destructive'; }
function isValidationIssues(value: unknown): value is ToolValidationIssues {
  return isRecord(value) && Array.isArray(value.issues) && value.issues.every((issue) => isRecord(issue) && Array.isArray(issue.path)
    && issue.path.every((part) => typeof part === 'string' || typeof part === 'number') && typeof issue.code === 'string' && typeof issue.message === 'string');
}
function isMissingServiceDetails(value: unknown): value is MissingServiceDetails {
  return isRecord(value) && (value.expected === undefined || typeof value.expected === 'string') && (value.actualType === undefined || typeof value.actualType === 'string');
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function validationIssues(error: z.ZodError): ToolValidationIssues {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.map((item) => typeof item === 'number' ? item : String(item)),
      code: issue.code,
      message: issue.message
    }))
  };
}
