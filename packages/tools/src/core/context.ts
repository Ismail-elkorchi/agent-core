import type { ToolPolicy } from './policy.js';
import type { MissingServiceDetails } from './definition.js';

export class MissingToolServiceError extends Error {
  readonly serviceName: string;
  readonly details: MissingServiceDetails;

  constructor(serviceName: string, message = `Tool requires service: ${serviceName}`, details: MissingServiceDetails = {}) {
    super(message);
    this.name = 'MissingToolServiceError';
    this.serviceName = serviceName;
    this.details = details;
  }
}

export class ToolInputError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolInputError';
    this.details = details;
  }
}

export interface ToolExecutionContext {
  policy: ToolPolicy;
  signal?: AbortSignal;
  services?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  invocation?: ToolInvocationContext;
  emitProgress?: (progress: ToolProgress) => void | Promise<void>;
}

export interface ToolProgress {
  readonly stage: string;
  readonly message?: string;
  readonly completed?: number;
  readonly total?: number;
}

export interface ToolAuthorizationBoundary {
  readonly authorizationPolicyId: string;
  readonly executionTargetId: string;
}

export interface ToolPreparationContext extends Omit<ToolExecutionContext, 'signal' | 'invocation'> {
  readonly signal: AbortSignal;
  readonly boundary: ToolAuthorizationBoundary;
}

export interface ToolInvocationContext {
  readonly runId: string;
  readonly turnId: string;
  readonly requestAttempt: number;
  readonly toolBatchId: string;
  readonly callIndex: number;
  readonly callId?: string;
  readonly toolAttempt: number;
  readonly idempotencyKey?: string;
}

export type ToolServiceValidator<T> = (value: unknown) => value is T;

export function requireToolService<T>(
  context: ToolExecutionContext,
  name: string,
  validate: ToolServiceValidator<T>,
  expected: string
): T {
  const value = context.services?.[name];
  if (value === undefined) {
    throw new MissingToolServiceError(name, `Tool requires service: ${name}`, { expected, actualType: 'missing' });
  }
  if (!validate(value)) {
    throw new MissingToolServiceError(name, `Tool service ${name} is invalid; expected ${expected}.`, {
      expected,
      actualType: valueType(value)
    });
  }
  return value;
}

export function requireWorkspaceRoot(context: ToolExecutionContext): string {
  return requireToolService(context, 'workspaceRoot', isNonEmptyString, 'non-empty string workspace root');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new Error(typeof reason === 'string' ? reason : 'Tool execution aborted.');
}

export async function abortableToolBoundary<T>(signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
  throwIfAborted(signal);
  let removeAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      try { throwIfAborted(signal); }
      catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => { signal.removeEventListener('abort', onAbort); };
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    removeAbort();
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function valueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}
