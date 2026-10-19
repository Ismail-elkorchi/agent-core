import { parseSessionSubmissionOrigin } from './submission-origin.js';
import { decodeContextAdmissionConflict } from '../run/context-admission.js';
import { parseJsonObject } from '@agent-core/json';
import { parseModelSelection, type ModelSelection, type ModelReasoningRequest } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import * as z from 'zod';
import { sourceSchema } from '../history/schema.js';
import { ownPromptContextInputs } from '../inference/prompt-material.js';
import type {
  SessionInputRelationship,
  SessionBranchEntry,
  SessionRunFinalization,
  SessionRunFinalizationConfirmation,
  SessionAdmittedSubmission,
  SessionRepository,
  SessionPendingSubmission,
  SessionQueuedSubmissionChange,
  SessionSubmissionConfiguration,
  SessionSubmissionInput,
  SessionSubmissionRecord,
  SessionSubmissionOutcome,
  SessionSubmissionState,
  SessionSubmissionTransition,
  SessionSubmissionUpdate,
  SessionSuspensionAction,
  SessionSuspensionCategory,
  SessionSuspensionDescriptor
} from './contracts.js';
import { parseSessionImages } from './images.js';

type SubmissionState = SessionPendingSubmission['state'] | 'completed' | 'failed' | 'cancelled';
type FoldedSubmission = import('./contracts.js').SessionSubmissionSnapshot;

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
      (key) => !['task', 'origin', 'instructions', 'contextItems', 'relationship', 'images'].includes(key)
    )
  )
    throw new Error('Unsupported session submission input field.');
  return Object.freeze({
    task: input.task,
    ...(input.origin === undefined ? {} : { origin: parseSessionSubmissionOrigin(input.origin) }),
    ...(input.images === undefined ? {} : { images: parseSessionImages(input.images) }),
    ...(input.relationship === undefined
      ? {}
      : { relationship: decodeSessionInputRelationship(input.relationship) }),
    ...(instructions === undefined
      ? {}
      : {
          instructions: Object.freeze(
            instructions.map((item) => {
              if (typeof item !== 'string')
                throw new Error('Session instructions must be strings.');
              return item;
            })
          )
        }),
    ...(contextItems === undefined
      ? {}
      : { contextItems: ownPromptContextInputs(contextItems) })
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
  if (configuration.endpoint !== undefined && (typeof configuration.endpoint !== 'string' || !configuration.endpoint.trim()))
    throw new Error('Session endpoint must be a non-empty string.');
  if (configuration.temperature !== undefined && !Number.isFinite(configuration.temperature))
    throw new Error('Session temperature must be finite.');
  const owned: SessionSubmissionConfiguration = Object.freeze({
    provider: configuration.provider,
    model: configuration.model,
    ...(configuration.endpoint === undefined ? {} : { endpoint: configuration.endpoint }),
    ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
    ...(configuration.reasoning === undefined
      ? {}
      : { reasoning: ownReasoning(configuration.reasoning) }),
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
      submission.state === 'completed' ||
      submission.state === 'failed' ||
      submission.state === 'cancelled'
        ? []
        : [
            Object.freeze({
              submissionId: submission.submissionId,
              runId: submission.runId,
              state: submission.state,
              input: submission.input,
              configuration: submission.configuration,
              ...(submission.claimId === undefined ? {} : { claimId: submission.claimId }),
              ...(submission.suspension === undefined ? {} : { suspension: submission.suspension })
            })
          ]
    )
  );
}

export function createSessionSubmissionTransition(
  records: readonly SessionSubmissionRecord[],
  submissionId: string,
  outcome: SessionSubmissionOutcome
): SessionSubmissionTransition | undefined {
  const pending = pendingSessionSubmissions(records);
  const current = foldSubmissions(records).get(submissionId);
  if (outcome.state === 'claimed') {
    const occupying = pending.find((entry) => entry.state !== 'queued');
    if (occupying && occupying.submissionId !== submissionId)
      throw new Error(`Session is occupied by submission ${occupying.submissionId}.`);
    if (!occupying && pending[0]?.submissionId !== submissionId)
      throw new Error('Session submissions must be claimed in durable admission order.');
  }
  if (current === undefined) throw new Error(`Unknown session submission: ${submissionId}`);
  const state = outcome.state;
  const claimId = outcome.claimId;
  if (typeof claimId !== 'string' || claimId.length === 0)
    throw new Error('Session submission claim identity is invalid.');
  assertSubmissionOwnership(current, {
    type: `submission.${state}`, claimId,
    ...(outcome.state === 'claimed' && outcome.expectedClaimId !== undefined
      ? { previousClaimId: outcome.expectedClaimId } : {})
  });
  const base = {
    claimId,
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
    assertSubmissionTransition(current.state, state, submissionId);
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
    assertSubmissionTransition(current.state, state, submissionId);
    return Object.freeze({ ...base, type: 'submission.failed', errorMessage });
  }
  if (current.state === state && state !== 'claimed') return undefined;
  assertSubmissionTransition(current.state, state, submissionId);
  return Object.freeze({
    ...base,
    type: state === 'claimed' ? 'submission.claimed' : 'submission.completed',
    ...(outcome.state === 'claimed' && outcome.expectedClaimId !== undefined
      ? { previousClaimId: outcome.expectedClaimId } : {})
  });
}

function foldSubmissions(
  records: readonly SessionSubmissionRecord[]
): Map<string, FoldedSubmission> {
  const submissions = new Map<string, FoldedSubmission>();
  let capacity: number | undefined;
  for (const record of records) {
    if (record.type === 'submission.admitted') {
      if (!Number.isSafeInteger(record.maximumQueuedInputs) || record.maximumQueuedInputs < 0 ||
          (capacity !== undefined && capacity !== record.maximumQueuedInputs))
        throw new Error('Session submission capacity policy is invalid.');
      capacity = record.maximumQueuedInputs;
      const pending = [...submissions.values()].filter((entry) => entry.state === 'queued' || entry.state === 'claimed' || entry.state === 'suspended');
      if (record.claimId !== undefined && pending.length > 0)
        throw new Error('Session admission cannot overtake pending work.');
      if (record.claimId === undefined && pending.filter((entry) => entry.state === 'queued').length >= capacity)
        throw new Error('Session submission capacity was exceeded.');
      if ([...submissions.values()].some((entry) => entry.runId === record.runId))
        throw new Error(`Duplicate submission run: ${record.runId}`);
      if (submissions.has(record.submissionId))
        throw new Error(`Duplicate queued session submission: ${record.submissionId}`);
      submissions.set(
        record.submissionId,
        Object.freeze({
          submissionId: record.submissionId,
          runId: record.runId,
          state: record.claimId === undefined ? 'queued' : 'claimed',
          ...(record.claimId === undefined ? {} : { claimId: record.claimId }),
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
    if (record.type === 'submission.revised' || record.type === 'submission.cancelled') {
      if (current.state !== 'queued')
        throw new Error(`Only queued input can change: ${record.submissionId}`);
      submissions.set(
        record.submissionId,
        record.type === 'submission.revised'
          ? Object.freeze({ ...current, input: record.input })
          : Object.freeze({ ...current, state: 'cancelled' })
      );
      continue;
    }
    if (record.type === 'submission.claimed') {
      const pending = [...submissions.values()].filter((entry) => entry.state === 'queued' || entry.state === 'claimed' || entry.state === 'suspended');
      const occupying = pending.find((entry) => entry.state !== 'queued');
      if ((occupying && occupying.submissionId !== record.submissionId) || (!occupying && pending[0]?.submissionId !== record.submissionId))
        throw new Error('Session claim contradicts its durable execution slot or queue order.');
    }
    assertSubmissionOwnership(current, record);
    const state = submissionTransitionState(record);
    assertSubmissionTransition(current.state, state, record.submissionId);
    const suspension =
      record.type === 'submission.suspended'
        ? ownSessionSuspensionDescriptor(record.suspension)
        : undefined;
    submissions.set(
      record.submissionId,
      Object.freeze({
        ...current,
        state,
        claimId: record.claimId,
        ...(record.type === 'submission.failed' ? { errorMessage: record.errorMessage } : {}),
        ...(suspension === undefined ? {} : { suspension })
      })
    );
  }
  return submissions;
}

export function createQueuedSubmissionUpdate(
  records: readonly SessionSubmissionRecord[],
  submissionId: string,
  change: SessionQueuedSubmissionChange
): SessionSubmissionUpdate {
  const current = foldSubmissions(records).get(submissionId);
  if (current?.state !== 'queued')
    throw new Error(`Submission is no longer queued: ${submissionId}`);
  if (hashJson(current.input) !== hashJson(ownSessionSubmissionInput(change.expectedInput)))
    throw new Error(`Queued input changed since it was read: ${submissionId}`);
  const base = { submissionId, runId: current.runId, timestamp: new Date().toISOString() };
  return Object.freeze(
    change.kind === 'replace'
      ? { ...base, type: 'submission.revised', input: ownSessionSubmissionInput(change.input) }
      : { ...base, type: 'submission.cancelled' }
  );
}

export function originalAcceptedInput(
  records: readonly SessionSubmissionRecord[],
  runId: string
): { readonly originalInput?: SessionSubmissionInput } {
  const accepted = [...foldSubmissions(records).values()].find(
    (submission) => submission.runId === runId
  );
  return accepted === undefined ? {} : { originalInput: accepted.input };
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
    'contextAdmission',
    'diagnostic'
  ]);
  if (Object.keys(object).some((field) => !allowed.has(field)))
    throw new TypeError('Session suspension has unsupported fields.');
  const runId = suspensionString(object.runId, 'runId');
  const submissionId = suspensionString(object.submissionId, 'submissionId');
  const category = suspensionCategory(object.category);
  const reason = suspensionReason(object.reason);
  const effectId =
    object.effectId === undefined ? undefined : suspensionString(object.effectId, 'effectId');
  if (reason !== 'runtime_failed' && object.diagnostic !== undefined)
    throw new TypeError('Only a runtime failure may contain its diagnostic.');
  if (!Array.isArray(object.actions) || object.actions.length === 0)
    throw new TypeError('Session suspension actions are invalid.');
  const actions = object.actions.map(suspensionAction);
  if (new Set(actions).size !== actions.length)
    throw new TypeError('Session suspension actions are invalid.');
  const contextAdmission =
    object.contextAdmission === undefined
      ? undefined
      : decodeContextAdmissionConflict(object.contextAdmission);
  const expected: readonly SessionSuspensionAction[] =
    category === 'approval'
      ? ['approval', 'abort']
      : category === 'external_recovery'
        ? ['reconcile', 'abort']
        : category === 'context_admission'
          ? contextAdmission?.kind === 'request_preparation' ? ['resume', 'context', 'abort'] : ['context', 'abort']
          : ['resume', 'abort'];
  if (
    actions.length !== expected.length ||
    !actions.every((action, index) => action === expected[index])
  )
    throw new TypeError('Session suspension actions do not match its category.');
  if (
    (category === 'approval') !== (reason === 'approval_required') ||
    (category === 'runtime') !== (reason === 'missing_implementation' || reason === 'runtime_failed') ||
    (category === 'context_admission') !== (reason === 'context_admission')
  )
    throw new TypeError('Session suspension category does not match its reason.');
  if (
    (category === 'context_admission') !== (contextAdmission !== undefined) ||
    (category === 'context_admission' && effectId !== undefined)
  )
    throw new TypeError(
      'Context admission suspension requires its conflict and cannot identify an effect.'
    );
  const descriptor = {
    runId,
    submissionId,
    category,
    ...(effectId === undefined ? {} : { effectId }),
    actions: Object.freeze(actions),
    ...(contextAdmission === undefined ? {} : { contextAdmission })
  };
  return reason === 'runtime_failed'
    ? Object.freeze({ ...descriptor, reason, diagnostic: suspensionString(object.diagnostic, 'diagnostic') })
    : Object.freeze({ ...descriptor, reason });
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
    value !== 'runtime' &&
    value !== 'context_admission'
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
    value !== 'runtime_failed' &&
    value !== 'context_admission'
  )
    throw new TypeError('Session suspension reason is invalid.');
  return value;
}

function suspensionAction(value: unknown): SessionSuspensionAction {
  if (
    value !== 'approval' &&
    value !== 'reconcile' &&
    value !== 'resume' &&
    value !== 'context' &&
    value !== 'abort'
  )
    throw new TypeError('Session suspension action is invalid.');
  return value;
}

function submissionTransitionState(
  record: SessionSubmissionTransition
): Exclude<SessionSubmissionState, 'cancelled'> {
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

export class SessionSubmissionOwnershipError extends Error {
  constructor(readonly submissionId: string) {
    super(`Session submission claim is no longer owned: ${submissionId}`);
    this.name = 'SessionSubmissionOwnershipError';
  }
}

export function assertSubmissionOwnership(
  current: { readonly submissionId: string; readonly claimId?: string },
  record: { readonly type: string; readonly claimId: string; readonly previousClaimId?: string }
): void {
  if (record.type === 'submission.claimed') {
    if (current.claimId !== record.previousClaimId || current.claimId === record.claimId)
      throw new SessionSubmissionOwnershipError(current.submissionId);
  } else if (current.claimId !== record.claimId) {
    throw new SessionSubmissionOwnershipError(current.submissionId);
  }
}

export function assertSubmissionTransition(
  current: SubmissionState,
  next: Exclude<SubmissionState, 'queued'>,
  submissionId: string
): void {
  const allowed =
    current === 'queued'
      ? next === 'claimed'
      : current === 'claimed'
        ? next === 'claimed' || next === 'suspended' || next === 'completed' || next === 'failed'
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

/** The submission journal is the sole scheduling authority. */
export function assertSessionIdle(records: readonly SessionSubmissionRecord[]): void {
  if (pendingSessionSubmissions(records).length > 0)
    throw new Error('Session mutation requires an idle session with no pending submissions.');
}

export function createSessionAdmission(
  records: readonly SessionSubmissionRecord[],
  input: Parameters<SessionRepository['admitSubmission']>[1]
): SessionAdmittedSubmission {
  if (typeof input.submissionId !== 'string' || input.submissionId.length === 0 ||
      typeof input.runId !== 'string' || input.runId.length === 0)
    throw new Error('Session submission identity is invalid.');
  const maximumQueuedInputs = input.maximumQueuedInputs ?? 1024;
  if (!Number.isSafeInteger(maximumQueuedInputs) || maximumQueuedInputs < 0)
    throw new Error('maximumQueuedInputs must be a non-negative safe integer.');
  const policy = records.find((record) => record.type === 'submission.admitted');
  if (policy && policy.maximumQueuedInputs !== maximumQueuedInputs)
    throw new Error('Session queue capacity differs from its durable admission policy.');
  if (records.some((record) => record.submissionId === input.submissionId))
    throw new Error(`Duplicate session submission: ${input.submissionId}`);
  if (records.some((record) => record.runId === input.runId))
    throw new Error(`Duplicate session submission run: ${input.runId}`);
  if (input.claimId !== undefined && (typeof input.claimId !== 'string' || input.claimId.length === 0))
    throw new Error('Session submission claim identity is invalid.');
  const pending = pendingSessionSubmissions(records);
  const claimId = pending.length === 0 ? input.claimId : undefined;
  if (claimId === undefined && pending.filter((entry) => entry.state === 'queued').length >= maximumQueuedInputs)
    throw new Error(`Session input queue limit of ${String(maximumQueuedInputs)} was reached.`);
  return Object.freeze({
    type: 'submission.admitted', submissionId: input.submissionId, runId: input.runId,
    timestamp: new Date().toISOString(), maximumQueuedInputs,
    ...(claimId === undefined ? {} : { claimId }),
    input: ownSessionSubmissionInput(input.input),
    configuration: ownSessionSubmissionConfiguration(input.configuration)
  });
}

export function sessionSubmission(records: readonly SessionSubmissionRecord[], submissionId: string): FoldedSubmission | undefined {
  return foldSubmissions(records).get(submissionId);
}

/** Model selection is an idle-session mutation, never an execution observation. */
export function assertSessionModelSettings(pending: readonly SessionPendingSubmission[]): void {
  if (pending.length > 0)
    throw new Error('Session mutation requires an idle session with no pending submissions.');
}

export class SessionConfigurationChangedError extends Error {
  constructor() {
    super('Session model configuration changed before admission. Refresh the configuration and submit again.');
    this.name = 'SessionConfigurationChangedError';
  }
}

/** Compare the complete model binding under the repository admission lock. */
export function assertSessionAdmissionConfiguration(
  configuration: SessionSubmissionConfiguration,
  selection: ModelSelection | undefined
): void {
  if (!selection) return;
  const { responseFormat: ignored, ...binding } = ownSessionSubmissionConfiguration(configuration);
  void ignored;
  if (hashJson(parseModelSelection(binding)) !== hashJson(parseModelSelection(selection)))
    throw new SessionConfigurationChangedError();
}

/** The first admission fixes the initial model until an explicit branch-local selection replaces it. */
export function initialSessionModelSelection(
  records: readonly SessionSubmissionRecord[]
): import('@agent-core/model').ModelSelection | undefined {
  const admitted = records.find((record) => record.type === 'submission.admitted');
  if (!admitted) return undefined;
  const configuration = admitted.configuration;
  return Object.freeze({
    provider: configuration.provider,
    model: configuration.model,
    ...(configuration.endpoint === undefined ? {} : { endpoint: configuration.endpoint }),
    ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
    ...(configuration.reasoning === undefined ? {} : { reasoning: configuration.reasoning })
  });
}

/** Only accepted user corrections fence participant work; materialized run input is not a new correction. */
export function isAcceptedUserCorrection(
  record: SessionBranchEntry | SessionSubmissionRecord | SessionRunFinalization | SessionRunFinalizationConfirmation
): boolean {
  return (record.type === 'steering' && record.originalInput?.origin === undefined) ||
    (record.type === 'submission.revised' && record.input.origin === undefined) ||
    (record.type === 'submission.admitted' && record.input.origin === undefined &&
      (record.input.relationship?.kind === 'correct' || record.input.relationship?.kind === 'replace'));
}

/** Bind the materialized run input to the provenance already accepted by its session. */
export function materializedSessionInput(
  accepted: { readonly originalInput?: SessionSubmissionInput },
  input: Parameters<SessionRepository['appendInput']>[1]
): { readonly originalInput?: SessionSubmissionInput } {
  const origin = input.origin === undefined ? undefined : parseSessionSubmissionOrigin(input.origin);
  if (accepted.originalInput && hashJson(accepted.originalInput.origin ?? null) !== hashJson(origin ?? null))
    throw new Error('Run input origin differs from its accepted session submission.');
  if (accepted.originalInput) return accepted;
  return origin === undefined ? {} : { originalInput: ownSessionSubmissionInput({ task: input.task, origin,
    ...(input.images === undefined ? {} : { images: input.images }) }) };
}
