import { parseJsonObject } from '@agent-core/json';
import { renderDiagnostic } from '@agent-core/json/diagnostics';
import {
  decodeOwnedAgentCheckResult,
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
    super(
      reasonValue instanceof Error
        ? reasonValue.message
        : typeof reasonValue === 'string'
          ? reasonValue
          : 'Verification aborted.'
    );
    this.name = 'AgentVerificationAbortedError';
  }
}

export const EMPTY_OBSERVED_FACTS_READER: AgentObservedFactsReader = Object.freeze({
  read() {
    return Promise.resolve({ items: [], bytes: 0, truncated: false });
  },
  readArtifact() {
    return Promise.reject(new Error('Artifact reading is unavailable for this verification run.'));
  }
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
  const metadata = parseJsonObject(input.metadata ?? {});
  const execution = input.execution ?? { observedFacts: EMPTY_OBSERVED_FACTS_READER };
  const results: AgentCheckResult[] = [];
  for (const check of input.checks) {
    if (check.kind !== 'deterministic')
      throw new TypeError(`Effectful check ${check.id} requires the durable verification driver.`);
    throwIfVerificationAborted(input.signal);
    const timeoutMs = check.timeoutMs ?? input.defaultTimeoutMs ?? 30_000;
    const identity: AgentTurnIdentity = {
      turnIndex: input.turnIndex,
      turnId: input.turnId,
      requestAttempt: input.requestAttempt
    };
    await input.append({
      type: 'check.started',
      ...identity,
      check: check.id,
      implementationId: check.implementationId,
      requirement: check.requirement,
      timeoutMs
    });
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
  const forwardAbort = () => {
    controller.abort(input.parentSignal.reason);
  };
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
    const durationMs = Math.max(0, performance.now() - startedAt);
    try {
      const owned = parseJsonObject(observation);
      return decodeOwnedAgentCheckResult(
        {
          ...owned,
          id: input.check.id,
          implementationId: input.check.implementationId,
          requirement: input.check.requirement
        },
        durationMs
      );
    } catch (error) {
      const message = renderDiagnostic(error).text;
      return Object.freeze({
        id: input.check.id,
        implementationId: input.check.implementationId,
        requirement: input.check.requirement,
        verdict: 'unknown',
        summary: 'Verifier returned an invalid result.',
        diagnostic: Object.freeze({ kind: 'invalid_result', message }),
        durationMs
      });
    }
  } catch (error) {
    throwIfVerificationAborted(input.parentSignal);
    const details = renderDiagnostic(error).text;
    const diagnostic: AgentCheckDiagnostic =
      error instanceof CheckTimeoutError
        ? { kind: 'timeout', message: error.message }
        : { kind: diagnosticKind(error), message: details, details };
    return Object.freeze({
      id: input.check.id,
      implementationId: input.check.implementationId,
      requirement: input.check.requirement,
      verdict: 'unknown',
      summary: diagnostic.message,
      diagnostic: Object.freeze(diagnostic),
      durationMs: Math.max(0, performance.now() - startedAt)
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    input.parentSignal.removeEventListener('abort', forwardAbort);
  }
}

function throwIfVerificationAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentVerificationAbortedError(signal.reason);
}
function diagnosticKind(error: unknown): AgentCheckDiagnostic['kind'] {
  if (typeof error !== 'object' || error === null) return 'exception';
  try {
    const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (code === 'EACCES') return 'permission_denied';
    if (code === 'ENOENT' || code === 'ENOTSUP') return 'unavailable';
  } catch {
    /* Uninspectable exceptions still have a bounded diagnostic. */
  }
  return 'exception';
}

class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Verifier timed out after ${String(timeoutMs)}ms.`);
    this.name = 'CheckTimeoutError';
  }
}
