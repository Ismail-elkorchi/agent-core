import { validateArtifactRef, type ArtifactRef } from '@agent-core/persistence';
import { normalizeJsonSafe } from '@agent-core/json';
import {
  parseAgentCheckResult,
  type AgentCheckContext,
  type AgentCheckDefinition,
  type AgentCheckDiagnostic,
  type AgentCheckObservation,
  type AgentCheckResult,
  type AgentEffectiveInstruction,
  type AgentObservedFactsReader,
  type AgentPresentModelOutput,
  type AgentTurnIdentity,
  type AgentVerificationExecutionContext
} from '../run/contracts.js';
import type { AgentAuditEvent, AgentProgressEvent } from '../events.js';

export type {
  AgentCheckContext,
  AgentCheckDefinition,
  AgentCheckObservation,
  AgentCheckRequirement,
  AgentCheckResult,
  AgentCheckVerdict,
  AgentVerificationStatus
} from '../run/contracts.js';

export class AgentVerificationAbortedError extends Error {
  constructor(readonly reasonValue: unknown) {
    super(reasonValue instanceof Error ? reasonValue.message : typeof reasonValue === 'string' ? reasonValue : 'Verification aborted.');
    this.name = 'AgentVerificationAbortedError';
  }
}

export const EMPTY_OBSERVED_FACTS_READER: AgentObservedFactsReader = Object.freeze({
  read() { return Promise.resolve({ items: [], bytes: 0, truncated: false }); },
  readArtifact() { return Promise.reject(new Error('Artifact reading is unavailable for this verification run.')); }
});

export async function runAgentChecks(input: {
  readonly runId: string;
  readonly checks: readonly AgentCheckDefinition[];
  readonly task: string;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly modelOutput: AgentPresentModelOutput;
  readonly turnIndex: number;
  readonly turnId: string;
  readonly requestAttempt: number;
  readonly signal: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly execution?: AgentVerificationExecutionContext;
  readonly defaultTimeoutMs?: number;
  readonly append: (event: AgentAuditEvent) => Promise<unknown>;
  readonly emit: (event: AgentProgressEvent) => Promise<void>;
}): Promise<readonly AgentCheckResult[]> {
  const metadataValue = normalizeJsonSafe(input.metadata ?? {}).value;
  const metadata = isRecord(metadataValue) ? metadataValue : {};
  const execution = input.execution ?? { observedFacts: EMPTY_OBSERVED_FACTS_READER };
  const results: AgentCheckResult[] = [];
  for (const check of input.checks) {
    if (check.kind !== 'deterministic') throw new TypeError(`Effectful check ${check.id} requires the durable verification driver.`);
    throwIfVerificationAborted(input.signal);
    const timeoutMs = check.timeoutMs ?? input.defaultTimeoutMs ?? 30_000;
    const identity: AgentTurnIdentity = { turnIndex: input.turnIndex, turnId: input.turnId, requestAttempt: input.requestAttempt };
    await input.append({ type: 'check.started', ...identity, check: check.id, implementationId: check.implementationId, requirement: check.requirement, timeoutMs });
    const result = await executeAgentCheckAction({
      check,
      timeoutMs,
      parentSignal: input.signal,
      context: {
        runId: input.runId,
        task: input.task,
        instructions: input.instructions,
        modelOutput: input.modelOutput,
        ...identity,
        metadata,
        signal: input.signal,
        execution
      },
      action: (context) => check.run(context)
    });
    results.push(result);
    await input.append({ type: 'check.ended', ...identity, check: check.id, result });
    await input.emit({ type: 'check.ended', ...identity, result });
    // Observers are delivery-only, but they may request cancellation. Do not let a
    // cancellation delivered with the last check race past the verification commit.
    throwIfVerificationAborted(input.signal);
  }
  throwIfVerificationAborted(input.signal);
  return Object.freeze(results);
}

export async function executeAgentCheckAction(input: {
  readonly check: AgentCheckDefinition;
  readonly timeoutMs: number;
  readonly parentSignal: AbortSignal;
  readonly context: AgentCheckContext;
  readonly action: (context: AgentCheckContext) => Promise<AgentCheckObservation>;
}): Promise<AgentCheckResult> {
  const controller = new AbortController();
  const forwardAbort = () => { controller.abort(input.parentSignal.reason); };
  if (input.parentSignal.aborted) forwardAbort();
  else input.parentSignal.addEventListener('abort', forwardAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new CheckTimeoutError(input.timeoutMs));
      reject(new CheckTimeoutError(input.timeoutMs));
    }, input.timeoutMs);
  });
  const startedAt = performance.now();
  try {
    const observation = await Promise.race([
      Promise.resolve().then(() => input.action({ ...input.context, signal: controller.signal })),
      timeoutPromise
    ]);
    throwIfVerificationAborted(input.parentSignal);
    return parseAgentCheckResult(normalizeObservation(input.check, observation), Math.max(0, performance.now() - startedAt));
  } catch (error) {
    throwIfVerificationAborted(input.parentSignal);
    const details = safeDetails(error);
    const diagnostic: AgentCheckDiagnostic = error instanceof CheckTimeoutError
      ? { kind: 'timeout', message: error.message }
      : { kind: diagnosticKind(error), message: errorMessage(error), ...(details === undefined ? {} : { details }) };
    return parseAgentCheckResult({
      id: input.check.id,
      implementationId: input.check.implementationId,
      requirement: input.check.requirement,
      verdict: 'unknown',
      summary: diagnostic.message,
      diagnostic
    }, Math.max(0, performance.now() - startedAt));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    input.parentSignal.removeEventListener('abort', forwardAbort);
  }
}

function normalizeObservation(check: AgentCheckDefinition, value: unknown): Omit<AgentCheckResult, 'durationMs'> {
  if (!isRecord(value)) return invalidResult(check, 'Verifier returned no result object.');
  if (value.verdict !== 'passed' && value.verdict !== 'failed' && value.verdict !== 'unknown') return invalidResult(check, 'Verifier returned an unsupported verdict.');
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) return invalidResult(check, 'Verifier returned a malformed summary.');
  if (value.artifacts !== undefined && !validArtifacts(value.artifacts)) return invalidResult(check, 'Verifier returned malformed artifacts.');
  const diagnostic = normalizeDiagnostic(value.diagnostic);
  if (value.diagnostic !== undefined && diagnostic === undefined) return invalidResult(check, 'Verifier returned a malformed diagnostic.');
  const normalized = value.output === undefined ? undefined : normalizeJsonSafe(value.output);
  return {
    id: check.id,
    implementationId: check.implementationId,
    requirement: check.requirement,
    verdict: value.verdict,
    summary: value.summary.trim(),
    ...(normalized ? { output: normalized.value, ...(normalized.diagnostics.length > 0 ? { outputNormalization: normalized.diagnostics } : {}) } : {}),
    ...(validArtifacts(value.artifacts) ? { artifacts: Object.freeze(value.artifacts.map((artifact) => Object.freeze({ ...artifact }))) } : {}),
    ...(diagnostic ? { diagnostic } : {})
  };
}

function invalidResult(check: AgentCheckDefinition, message: string): Omit<AgentCheckResult, 'durationMs'> {
  return { id: check.id, implementationId: check.implementationId, requirement: check.requirement, verdict: 'unknown', summary: message, diagnostic: { kind: 'invalid_result', message } };
}

function normalizeDiagnostic(value: unknown): AgentCheckDiagnostic | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isDiagnosticKind(value.kind) || typeof value.message !== 'string' || value.message.trim().length === 0) return undefined;
  const details = value.details === undefined ? undefined : normalizeJsonSafe(value.details).value;
  return { kind: value.kind, message: value.message.trim(), ...(details === undefined ? {} : { details }) };
}

function validArtifact(value: unknown): value is ArtifactRef { try { validateArtifactRef(value); return true; } catch { return false; } }
function validArtifacts(value: unknown): value is readonly ArtifactRef[] { return Array.isArray(value) && value.every(validArtifact); }
function isDiagnosticKind(value: unknown): value is AgentCheckDiagnostic['kind'] { return value === 'exception' || value === 'timeout' || value === 'unavailable' || value === 'permission_denied' || value === 'aborted' || value === 'invalid_result'; }
function throwIfVerificationAborted(signal: AbortSignal): void { if (signal.aborted) throw new AgentVerificationAbortedError(signal.reason); }
function diagnosticKind(error: unknown): AgentCheckDiagnostic['kind'] {
  if (isRecord(error) && error.code === 'EACCES') return 'permission_denied';
  if (isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTSUP')) return 'unavailable';
  return 'exception';
}
function safeDetails(error: unknown) { return normalizeJsonSafe(error).value ?? undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) { super(`Verifier timed out after ${String(timeoutMs)}ms.`); this.name = 'CheckTimeoutError'; }
}
