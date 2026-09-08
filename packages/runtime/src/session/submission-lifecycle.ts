import { parseJsonObject } from '@agent-core/json';
import type { ModelReasoningRequest } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import * as z from 'zod';
import { sourceSchema } from '../history/schema.js';
import { decodePromptContextItemInput } from '../inference/prompt-material.js';
import type {
  SessionInputRelationship,
  SessionPendingSubmission,
  SessionSubmissionConfiguration,
  SessionSubmissionInput,
  SessionSubmissionRecord,
  SessionSubmissionState,
  SessionSubmissionTransition,
  SessionSuspensionAction,
  SessionSuspensionCategory,
  SessionSuspensionDescriptor
} from './contracts.js';

type SubmissionState = SessionPendingSubmission['state'] | 'completed' | 'failed';
type FoldedSubmission = Omit<SessionPendingSubmission, 'state'> & {
  readonly state: SubmissionState;
  readonly errorMessage?: string;
};

const ownedConfigurations = new WeakSet();

export function ownSessionSubmissionInput(value: unknown): SessionSubmissionInput {
  const input = parseJsonObject(value, {
    maxStringBytes: 8 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxCollectionEntries: 50_000,
    maxDepth: 64
  });
  if (typeof input.task !== 'string' || input.task.trim().length === 0)
    throw new Error('Session input task must be a non-empty string.');
  const instructions = input.instructions;
  if (
    instructions !== undefined &&
    (!Array.isArray(instructions) || instructions.some((item) => typeof item !== 'string'))
  )
    throw new Error('Session instructions must be strings.');
  const contextItems = input.contextItems;
  if (contextItems !== undefined && !Array.isArray(contextItems))
    throw new Error('Session context items must be an array.');
  if (
    Object.keys(input).some(
      (key) => !['task', 'instructions', 'contextItems', 'relationship'].includes(key)
    )
  )
    throw new Error('Unsupported session submission input field.');
  return Object.freeze({
    task: input.task,
    ...(input.relationship === undefined
      ? {}
      : { relationship: decodeSessionInputRelationship(input.relationship) }),
    ...(instructions === undefined
      ? {}
      : {
          instructions: Object.freeze(
            instructions.map((item) => {
              if (typeof item !== 'string') throw new Error('Session instructions must be strings.');
              return item;
            })
          )
        }),
    ...(contextItems === undefined
      ? {}
      : { contextItems: Object.freeze(contextItems.map(decodePromptContextItemInput)) })
  });
}

export function ownSessionSubmissionConfiguration(
  configuration: SessionSubmissionConfiguration
): SessionSubmissionConfiguration {
  if (ownedConfigurations.has(configuration)) return configuration;
  if (
    typeof configuration.provider !== 'string' ||
    typeof configuration.model !== 'string' ||
    configuration.provider.trim().length === 0 ||
    configuration.model.trim().length === 0
  ) {
    throw new Error('Session provider and model must be non-empty strings.');
  }
  if (configuration.temperature !== undefined && !Number.isFinite(configuration.temperature))
    throw new Error('Session temperature must be finite.');
  const owned: SessionSubmissionConfiguration = Object.freeze({
    provider: configuration.provider,
    model: configuration.model,
    ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
    ...(configuration.reasoning === undefined ? {} : { reasoning: ownReasoning(configuration.reasoning) }),
    ...(configuration.responseFormat === undefined
      ? {}
      : {
          responseFormat:
            typeof configuration.responseFormat === 'string'
              ? ownResponseFormatName(configuration.responseFormat)
              : Object.freeze({
                  type: 'json_schema' as const,
                  schema: parseJsonObject(configuration.responseFormat.schema)
                })
        })
  });
  ownedConfigurations.add(owned);
  return owned;
}

function ownReasoning(reasoning: ModelReasoningRequest): ModelReasoningRequest {
  switch (reasoning.strategy) {
    case 'disabled':
      return Object.freeze({ strategy: 'disabled' });
    case 'enabled':
      assertReasoningSummary(reasoning.summary);
      return Object.freeze({
        strategy: 'enabled',
        ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary })
      });
    case 'effort':
      assertReasoningSummary(reasoning.summary);
      return Object.freeze({
        strategy: 'effort',
        effort: reasoning.effort,
        ...(reasoning.mode === undefined ? {} : { mode: reasoning.mode }),
        ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary })
      });
    case 'budget':
      assertReasoningSummary(reasoning.summary);
      if (!Number.isSafeInteger(reasoning.maxTokens) || reasoning.maxTokens < 1)
        throw new Error('Session reasoning budget must be a positive safe integer.');
      return Object.freeze({
        strategy: 'budget',
        maxTokens: reasoning.maxTokens,
        ...(reasoning.summary === undefined ? {} : { summary: reasoning.summary })
      });
    default:
      throw new Error('Session reasoning strategy is invalid.');
  }
}

function assertReasoningSummary(value: string | undefined): void {
  if (value !== undefined && value !== 'auto' && value !== 'concise' && value !== 'detailed')
    throw new Error('Session reasoning summary is invalid.');
}

function ownResponseFormatName(value: string): 'text' | 'json' {
  if (value !== 'text' && value !== 'json') throw new Error('Session response format is invalid.');
  return value;
}

export function pendingSessionSubmissions(
  records: readonly SessionSubmissionRecord[]
): readonly SessionPendingSubmission[] {
  return Object.freeze(
    [...foldSubmissions(records).values()].flatMap((submission) =>
      submission.state === 'completed' || submission.state === 'failed'
        ? []
        : [
            Object.freeze({
              submissionId: submission.submissionId,
              runId: submission.runId,
              state: submission.state,
              input: submission.input,
              configuration: submission.configuration,
              ...(submission.suspension === undefined ? {} : { suspension: submission.suspension })
            })
          ]
    )
  );
}

export function createSessionSubmissionTransition(
  records: readonly SessionSubmissionRecord[],
  submissionId: string,
  outcome:
    | { readonly state: 'claimed' | 'completed' }
    | { readonly state: 'suspended'; readonly suspension: SessionSuspensionDescriptor }
    | { readonly state: 'failed'; readonly errorMessage: string }
): SessionSubmissionTransition | undefined {
  const current = foldSubmissions(records).get(submissionId);
  if (current === undefined) throw new Error(`Unknown session submission: ${submissionId}`);
  const state = outcome.state;
  const base = {
    type: `submission.${state}`,
    submissionId,
    runId: current.runId,
    timestamp: new Date().toISOString()
  } as const;
  if (outcome.state === 'suspended') {
    const suspension = ownSessionSuspensionDescriptor(outcome.suspension);
    if (suspension.submissionId !== submissionId || suspension.runId !== current.runId)
      throw new Error(`Session suspension identity changed: ${submissionId}`);
    if (current.state === state) {
      if (current.suspension === undefined || hashJson(current.suspension) !== hashJson(suspension))
        throw new Error(`Conflicting suspension for session submission: ${submissionId}`);
      return undefined;
    }
    assertTransition(current.state, state, submissionId);
    return Object.freeze({ ...base, type: 'submission.suspended', suspension });
  }
  if (outcome.state === 'failed') {
    const errorMessage = outcome.errorMessage;
    if (errorMessage.trim().length === 0)
      throw new Error(`Failed session submission requires an error: ${submissionId}`);
    if (current.state === state) {
      if (current.errorMessage !== errorMessage)
        throw new Error(`Conflicting failure for session submission: ${submissionId}`);
      return undefined;
    }
    assertTransition(current.state, state, submissionId);
    return Object.freeze({ ...base, type: 'submission.failed', errorMessage });
  }
  if (current.state === state) {
    if (state === 'claimed') throw new Error(`Session submission is already claimed: ${submissionId}`);
    return undefined;
  }
  assertTransition(current.state, state, submissionId);
  return Object.freeze({
    ...base,
    type: state === 'claimed' ? 'submission.claimed' : 'submission.completed'
  });
}

function foldSubmissions(records: readonly SessionSubmissionRecord[]): Map<string, FoldedSubmission> {
  const submissions = new Map<string, FoldedSubmission>();
  for (const record of records) {
    if (record.type === 'submission.queued') {
      if (submissions.has(record.submissionId))
        throw new Error(`Duplicate queued session submission: ${record.submissionId}`);
      submissions.set(
        record.submissionId,
        Object.freeze({
          submissionId: record.submissionId,
          runId: record.runId,
          state: 'queued',
          input: record.input,
          configuration: record.configuration
        })
      );
      continue;
    }
    const current = submissions.get(record.submissionId);
    if (current === undefined)
      throw new Error(`Session submission transition has no queued record: ${record.submissionId}`);
    if (current.runId !== record.runId)
      throw new Error(`Session submission run identity changed: ${record.submissionId}`);
    const state = submissionTransitionState(record);
    assertTransition(current.state, state, record.submissionId);
    const suspension =
      record.type === 'submission.suspended'
        ? ownSessionSuspensionDescriptor(record.suspension)
        : undefined;
    submissions.set(
      record.submissionId,
      Object.freeze({
        ...current,
        state,
        ...(record.type === 'submission.failed' ? { errorMessage: record.errorMessage } : {}),
        ...(suspension === undefined ? {} : { suspension })
      })
    );
  }
  return submissions;
}

export function ownSessionSuspensionDescriptor(value: unknown): SessionSuspensionDescriptor {
  const object = parseJsonObject(value);
  const allowed = new Set([
    'runId',
    'submissionId',
    'category',
    'reason',
    'effectId',
    'actions',
    'decisionRequest'
  ]);
  if (Object.keys(object).some((field) => !allowed.has(field)))
    throw new TypeError('Session suspension has unsupported fields.');
  const runId = suspensionString(object.runId, 'runId');
  const submissionId = suspensionString(object.submissionId, 'submissionId');
  const category = suspensionCategory(object.category);
  const reason = suspensionReason(object.reason);
  const effectId =
    object.effectId === undefined ? undefined : suspensionString(object.effectId, 'effectId');
  if (!Array.isArray(object.actions) || object.actions.length === 0)
    throw new TypeError('Session suspension actions are invalid.');
  const actions = object.actions.map(suspensionAction);
  if (new Set(actions).size !== actions.length)
    throw new TypeError('Session suspension actions are invalid.');
  const expected: readonly SessionSuspensionAction[] =
    category === 'approval'
      ? ['approval', 'abort']
      : category === 'external_recovery'
        ? ['reconcile', 'abort']
        : category === 'implementation'
          ? ['resume', 'abort']
          : ['decide', 'abort'];
  if (actions.length !== expected.length || !actions.every((action, index) => action === expected[index]))
    throw new TypeError('Session suspension actions do not match its category.');
  if (
    (category === 'approval') !== (reason === 'approval_required') ||
    (category === 'implementation') !== (reason === 'missing_implementation') ||
    (category === 'user_decision') !== (reason === 'user_decision')
  )
    throw new TypeError('Session suspension category does not match its reason.');
  const request =
    object.decisionRequest === undefined ? undefined : ownDecisionRequest(object.decisionRequest);
  if (category === 'user_decision' && request === undefined)
    throw new TypeError('Session user-decision suspension requires a decision request.');
  if (category !== 'user_decision' && request !== undefined)
    throw new TypeError('Only user-decision suspensions may contain a decision request.');
  return Object.freeze({
    runId,
    submissionId,
    category,
    reason,
    ...(effectId === undefined ? {} : { effectId }),
    actions: Object.freeze(actions),
    ...(request === undefined
      ? {}
      : { decisionRequest: Object.freeze({ ...request, choices: Object.freeze([...request.choices]) }) })
  });
}

function suspensionString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`Session suspension ${field} is invalid.`);
  return value;
}

function suspensionCategory(value: unknown): SessionSuspensionCategory {
  if (
    value !== 'approval' &&
    value !== 'external_recovery' &&
    value !== 'implementation' &&
    value !== 'user_decision'
  )
    throw new TypeError('Session suspension category is invalid.');
  return value;
}

function suspensionReason(value: unknown): SessionSuspensionDescriptor['reason'] {
  if (
    value !== 'approval_required' &&
    value !== 'provider_outcome_unknown' &&
    value !== 'tool_outcome_unknown' &&
    value !== 'missing_implementation' &&
    value !== 'user_decision'
  )
    throw new TypeError('Session suspension reason is invalid.');
  return value;
}

function suspensionAction(value: unknown): SessionSuspensionAction {
  if (
    value !== 'approval' &&
    value !== 'reconcile' &&
    value !== 'resume' &&
    value !== 'decide' &&
    value !== 'abort'
  )
    throw new TypeError('Session suspension action is invalid.');
  return value;
}

function ownDecisionRequest(value: unknown): NonNullable<SessionSuspensionDescriptor['decisionRequest']> {
  const object = parseJsonObject(value);
  if (
    Object.keys(object).length !== 5 ||
    !Object.keys(object).every(
      (field) =>
        field === 'id' ||
        field === 'reason' ||
        field === 'choices' ||
        field === 'fingerprint' ||
        field === 'runRevision'
    )
  ) {
    throw new TypeError('Session decision request has unsupported or missing fields.');
  }
  const id = suspensionString(object.id, 'decision request id');
  const reason = suspensionString(object.reason, 'decision request reason');
  if (
    !Array.isArray(object.choices) ||
    object.choices.length === 0 ||
    !object.choices.every((choice) => typeof choice === 'string' && choice.length > 0)
  )
    throw new TypeError('Session decision request choices are invalid.');
  const choices = Object.freeze(object.choices.map((choice) => String(choice)));
  if (typeof object.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(object.fingerprint))
    throw new TypeError('Session decision request fingerprint is invalid.');
  if (
    typeof object.runRevision !== 'number' ||
    !Number.isSafeInteger(object.runRevision) ||
    object.runRevision < 0
  )
    throw new TypeError('Session decision request revision is invalid.');
  return Object.freeze({
    id,
    reason,
    choices,
    fingerprint: object.fingerprint,
    runRevision: object.runRevision
  });
}

function submissionTransitionState(record: SessionSubmissionTransition): SessionSubmissionState {
  switch (record.type) {
    case 'submission.claimed':
      return 'claimed';
    case 'submission.suspended':
      return 'suspended';
    case 'submission.completed':
      return 'completed';
    case 'submission.failed':
      return 'failed';
  }
}

function assertTransition(
  current: SubmissionState,
  next: Exclude<SubmissionState, 'queued'>,
  submissionId: string
): void {
  const allowed =
    current === 'queued'
      ? next === 'claimed'
      : current === 'claimed'
        ? next === 'suspended' || next === 'completed' || next === 'failed'
        : current === 'suspended'
          ? next === 'claimed' || next === 'failed'
          : false;
  if (!allowed)
    throw new Error(`Invalid session submission transition ${current} -> ${next}: ${submissionId}`);
}

const relationshipSchema = z
  .strictObject({
    kind: z.enum(['continue', 'correct', 'side_question', 'replace']),
    relatedSources: z.array(sourceSchema).max(1000).readonly().optional()
  })
  .readonly();
export function decodeSessionInputRelationship(value: unknown): SessionInputRelationship {
  return relationshipSchema.parse(value);
}
