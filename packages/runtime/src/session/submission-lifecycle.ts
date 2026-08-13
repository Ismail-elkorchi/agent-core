import type {
  SessionPendingSubmission,
  SessionSubmissionConfiguration,
  SessionSubmissionInput,
  SessionSubmissionRecord,
  SessionSubmissionState,
  SessionSubmissionTransition
} from './contracts.js';
import { parseJsonObject } from '@agent-core/json';
import type { ModelReasoningRequest } from '@agent-core/model';

type SubmissionState = SessionPendingSubmission['state'] | 'completed' | 'failed';
type FoldedSubmission = Omit<SessionPendingSubmission, 'state'> & {
  readonly state: SubmissionState;
  readonly errorMessage?: string;
};

const ownedConfigurations = new WeakSet();

export function ownSessionSubmissionInput(input: SessionSubmissionInput): SessionSubmissionInput {
  return Object.freeze({
    task: input.task,
    ...(input.instructions === undefined ? {} : { instructions: Object.freeze([...input.instructions]) }),
    ...(input.contextItems === undefined ? {} : { contextItems: Object.freeze(input.contextItems.map((item) => Object.freeze({
      ...item, ...(item.range === undefined ? {} : { range: Object.freeze({ ...item.range }) })
    }))) })
  });
}

export function ownSessionSubmissionConfiguration(configuration: SessionSubmissionConfiguration): SessionSubmissionConfiguration {
  if (ownedConfigurations.has(configuration)) return configuration;
  if (typeof configuration.provider !== 'string' || typeof configuration.model !== 'string' || configuration.provider.trim().length === 0 || configuration.model.trim().length === 0) {
    throw new Error('Session provider and model must be non-empty strings.');
  }
  if (configuration.temperature !== undefined && !Number.isFinite(configuration.temperature)) throw new Error('Session temperature must be finite.');
  const owned: SessionSubmissionConfiguration = Object.freeze({
    provider: configuration.provider,
    model: configuration.model,
    ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
    ...(configuration.reasoning === undefined ? {} : { reasoning: ownReasoning(configuration.reasoning) }),
    ...(configuration.responseFormat === undefined ? {} : {
      responseFormat: typeof configuration.responseFormat === 'string'
        ? ownResponseFormatName(configuration.responseFormat)
        : Object.freeze({ type: 'json_schema' as const, schema: parseJsonObject(configuration.responseFormat.schema) })
    })
  });
  ownedConfigurations.add(owned);
  return owned;
}

function ownReasoning(reasoning: ModelReasoningRequest): ModelReasoningRequest {
  switch (reasoning.strategy) {
    case 'disabled': return Object.freeze({ strategy: 'disabled' });
    case 'enabled':
      assertReasoningSummary(reasoning.summary);
      return Object.freeze({ strategy: 'enabled', ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary }) });
    case 'effort':
      assertReasoningSummary(reasoning.summary);
      return Object.freeze({ strategy: 'effort', effort: reasoning.effort,
        ...(reasoning.mode === undefined ? {} : { mode: reasoning.mode }), ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary }) });
    case 'budget':
      assertReasoningSummary(reasoning.summary);
      if (!Number.isSafeInteger(reasoning.maxTokens) || reasoning.maxTokens < 1) throw new Error('Session reasoning budget must be a positive safe integer.');
      return Object.freeze({ strategy: 'budget', maxTokens: reasoning.maxTokens, ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary }) });
    default: throw new Error('Session reasoning strategy is invalid.');
  }
}

function assertReasoningSummary(value: string | undefined): void {
  if (value !== undefined && value !== 'auto' && value !== 'concise' && value !== 'detailed') throw new Error('Session reasoning summary is invalid.');
}

function ownResponseFormatName(value: string): 'text' | 'json' {
  if (value !== 'text' && value !== 'json') throw new Error('Session response format is invalid.');
  return value;
}

export function pendingSessionSubmissions(records: readonly SessionSubmissionRecord[]): readonly SessionPendingSubmission[] {
  return Object.freeze([...foldSubmissions(records).values()].flatMap((submission) =>
    submission.state === 'completed' || submission.state === 'failed' ? [] : [Object.freeze({
      submissionId: submission.submissionId, runId: submission.runId, state: submission.state,
      input: submission.input, configuration: submission.configuration
    })]
  ));
}

export function createSessionSubmissionTransition(
  records: readonly SessionSubmissionRecord[],
  submissionId: string,
  state: SessionSubmissionState,
  errorMessage?: string
): SessionSubmissionTransition | undefined {
  const current = foldSubmissions(records).get(submissionId);
  if (current === undefined) throw new Error(`Unknown session submission: ${submissionId}`);
  if (state !== 'failed' && errorMessage !== undefined) throw new Error(`Only failed session submissions may contain an error: ${submissionId}`);
  if (current.state === state) {
    if (state === 'claimed') throw new Error(`Session submission is already claimed: ${submissionId}`);
    if (state === 'failed' && current.errorMessage !== errorMessage) throw new Error(`Conflicting failure for session submission: ${submissionId}`);
    return undefined;
  }
  assertTransition(current.state, state, submissionId);
  return Object.freeze({
    type: `submission.${state}`,
    submissionId,
    runId: current.runId,
    timestamp: new Date().toISOString(),
    ...(errorMessage === undefined ? {} : { errorMessage })
  });
}

function foldSubmissions(records: readonly SessionSubmissionRecord[]): Map<string, FoldedSubmission> {
  const submissions = new Map<string, FoldedSubmission>();
  for (const record of records) {
    if (record.type === 'submission.queued') {
      if (submissions.has(record.submissionId)) throw new Error(`Duplicate queued session submission: ${record.submissionId}`);
      submissions.set(record.submissionId, Object.freeze({
        submissionId: record.submissionId, runId: record.runId, state: 'queued',
        input: record.input, configuration: record.configuration
      }));
      continue;
    }
    const current = submissions.get(record.submissionId);
    if (current === undefined) throw new Error(`Session submission transition has no queued record: ${record.submissionId}`);
    if (current.runId !== record.runId) throw new Error(`Session submission run identity changed: ${record.submissionId}`);
    const state = submissionTransitionState(record);
    assertTransition(current.state, state, record.submissionId);
    if (state !== 'failed' && record.errorMessage !== undefined) throw new Error(`Only failed session submissions may contain an error: ${record.submissionId}`);
    submissions.set(record.submissionId, Object.freeze({ ...current, state,
      ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }) }));
  }
  return submissions;
}

function submissionTransitionState(record: SessionSubmissionTransition): SessionSubmissionState {
  switch (record.type) {
    case 'submission.claimed': return 'claimed';
    case 'submission.suspended': return 'suspended';
    case 'submission.completed': return 'completed';
    case 'submission.failed': return 'failed';
  }
}

function assertTransition(current: SubmissionState, next: Exclude<SubmissionState, 'queued'>, submissionId: string): void {
  const allowed = current === 'queued'
    ? next === 'claimed'
    : current === 'claimed'
      ? next === 'suspended' || next === 'completed' || next === 'failed'
      : current === 'suspended'
        ? next === 'claimed' || next === 'failed'
        : false;
  if (!allowed) throw new Error(`Invalid session submission transition ${current} -> ${next}: ${submissionId}`);
}
