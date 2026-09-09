import type { JsonObject, JsonValue } from '@agent-core/json';
import type { ModelOutputItem, ModelReasoningRequest, ModelResponseFormat } from '@agent-core/model';
import type { ArtifactRef } from '@agent-core/persistence';
import type {
  ContextTransitionCommit,
  ContextTransitionRecord,
  ContextWindowRecord
} from '../context/contracts.js';
import type { PromptContextItemInput } from '../inference/prompt-material.js';
import type {
  AgentEffectiveInstruction,
  AgentTerminalSnapshot,
  AgentToolCallAttemptIdentity,
  AgentToolCallIdentity,
  AgentTurnIdentity
} from '../run/contracts.js';
import type { AgentDecisionRequest } from '../run/control/contracts.js';
import type { SessionBinding, SessionBindingInput } from './binding.js';

export type SessionHeader = Readonly<{
  readonly type: 'session';
  readonly version: 1;
  readonly format: 'agent-core.session/2';
  readonly id: string;
  readonly timestamp: string;
  readonly binding: SessionBinding;
  readonly parentSessionId?: string;
  readonly provider?: string;
  readonly model?: string;
}>;

export interface SessionDescriptor {
  readonly id: string;
  readonly header: SessionHeader;
  readonly leafId: string | null;
}

export interface SessionBranchBoundary {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly leafHash: string | null;
}

export interface SessionBranchCursor {
  readonly boundary: SessionBranchBoundary;
  /** First not-yet-returned ancestor, inclusive. */
  readonly entryId: string;
}

interface SessionBranchReadLimits {
  readonly limit?: number;
  readonly maxBytes?: number;
}

type SessionBranchReadPosition =
  | { readonly leafId?: string | null; readonly cursor?: never }
  | { readonly cursor: SessionBranchCursor; readonly leafId?: never };

export type SessionBranchPageRequest = SessionBranchReadLimits &
  SessionBranchReadPosition & {
    readonly direction?: 'older' | 'newer';
  };

export interface SessionBranchPage {
  readonly boundary: SessionBranchBoundary;
  readonly entries: readonly SessionBranchEntry[];
  readonly older?: SessionBranchCursor;
  readonly newer?: SessionBranchCursor;
}

export type SessionBranchSearchRequest = SessionBranchReadLimits &
  SessionBranchReadPosition & {
    /** Literal, case-sensitive text. Search cursors retain the exact query. */
    readonly query: string;
    readonly cursor?: SessionBranchCursor & { readonly query: string };
  };

export interface SessionBranchSearchResult {
  readonly boundary: SessionBranchBoundary;
  readonly matches: readonly { readonly entryId: string; readonly excerpt: string }[];
  readonly older?: SessionBranchCursor & { readonly query: string };
}

export type BaseSessionEntry = Readonly<{
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly source?: import('../history/contracts.js').HistoryEventSource;
}>;

export type SessionInputEntry = BaseSessionEntry &
  Readonly<{
    readonly type: 'input';
    readonly runId: string;
    readonly task: string;
    readonly originalInput?: SessionSubmissionInput;
    readonly instructions: readonly AgentEffectiveInstruction[];
  }>;

export type SessionSteeringEntry = BaseSessionEntry &
  Readonly<{
    readonly type: 'steering';
    readonly runId: string;
    readonly deliveryId?: string;
    readonly originalInput?: SessionSubmissionInput;
    readonly content: string;
    readonly relationship?: SessionInputRelationship;
  }>;

export type SessionAssistantEntry = BaseSessionEntry &
  AgentTurnIdentity &
  Readonly<{
    readonly type: 'assistant';
    readonly runId: string;
    readonly content: string;
    readonly output?: readonly ModelOutputItem[];
    readonly completeness?: 'complete' | 'partial' | 'indeterminate' | 'absent';
  }>;

export type SessionToolCallEntry = BaseSessionEntry &
  AgentToolCallIdentity &
  Readonly<{
    readonly type: 'tool_call';
    readonly runId: string;
    readonly call: JsonValue;
  }>;

export type SessionObservationEntry = BaseSessionEntry &
  AgentTurnIdentity &
  Readonly<{
    readonly type: 'observation';
    readonly runId: string;
    readonly toolBatchId?: string;
    readonly callIndex?: number;
    readonly callId?: string;
    readonly toolAttempt?: number;
    readonly toolName: string;
    readonly ok: boolean;
    readonly summary: string;
    readonly output?: JsonValue;
    readonly artifacts?: readonly ArtifactRef[];
    readonly metadata?: JsonObject;
  }>;

export type SessionBranchMarkerEntry = BaseSessionEntry &
  Readonly<{
    readonly type: 'branch';
    readonly fromEntryId: string;
    readonly noteSource?: {
      readonly scope: import('../notes/contracts.js').NoteScope;
      readonly watermark: number;
    };
    readonly label?: string;
  }>;

export type SessionModelSettingsEntry = BaseSessionEntry &
  Readonly<{
    readonly type: 'model_settings';
    readonly provider: string;
    readonly model: string;
    readonly temperature?: number;
    readonly reasoningEffort?: string;
  }>;

export type SessionContextTransitionEntry = BaseSessionEntry &
  Readonly<{
    readonly type: 'context_transition';
    readonly window: ContextWindowRecord;
    readonly transition: ContextTransitionRecord;
  }>;

export type SessionRunFinalization = Readonly<{
  readonly type: 'run_finalization';
  readonly id: string;
  readonly timestamp: string;
  readonly throughEntryId: string;
  readonly runId: string;
  readonly finalizationId: string;
  readonly terminal: AgentTerminalSnapshot;
}>;

export type SessionBranchEntry =
  | SessionInputEntry
  | SessionSteeringEntry
  | SessionAssistantEntry
  | SessionToolCallEntry
  | SessionObservationEntry
  | SessionBranchMarkerEntry
  | SessionModelSettingsEntry
  | SessionContextTransitionEntry;

export type SessionConversationItem =
  | SessionInputEntry
  | SessionSteeringEntry
  | SessionAssistantEntry
  | SessionToolCallEntry
  | SessionObservationEntry;

export interface SessionBranchPoint {
  readonly entryId: string;
  readonly timestamp: string;
  readonly kind: 'run_finalization' | 'context_transition';
  readonly runId?: string;
  readonly finalizationId?: string;
}

export interface SessionInputRelationship {
  readonly kind: 'continue' | 'correct' | 'side_question' | 'replace';
  readonly relatedSources?: readonly import('../history/contracts.js').HistorySourceRef[] | undefined;
}

export interface SessionSubmissionInput {
  readonly relationship?: SessionInputRelationship;
  readonly task: string;
  readonly instructions?: readonly string[];
  readonly contextItems?: readonly PromptContextItemInput[];
}

export interface SessionSubmissionConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly reasoning?: ModelReasoningRequest;
  readonly responseFormat?: ModelResponseFormat;
}

export type SessionQueuedSubmission = Readonly<{
  readonly type: 'submission.queued';
  readonly submissionId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly input: SessionSubmissionInput;
  readonly configuration: SessionSubmissionConfiguration;
}>;

export type SessionSubmissionState = 'claimed' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export type SessionSuspensionCategory = 'approval' | 'external_recovery' | 'implementation' | 'user_decision';
export type SessionSuspensionAction = 'approval' | 'reconcile' | 'resume' | 'decide' | 'abort';
export interface SessionSuspensionDescriptor {
  readonly runId: string;
  readonly submissionId: string;
  readonly category: SessionSuspensionCategory;
  readonly reason:
    | 'approval_required'
    | 'provider_outcome_unknown'
    | 'tool_outcome_unknown'
    | 'missing_implementation'
    | 'user_decision';
  readonly effectId?: string;
  readonly actions: readonly SessionSuspensionAction[];
  readonly decisionRequest?: AgentDecisionRequest;
}

type SessionSubmissionTransitionBase = Readonly<{
  readonly submissionId: string;
  readonly runId: string;
  readonly timestamp: string;
}>;

export type SessionSubmissionTransition =
  | (SessionSubmissionTransitionBase &
      Readonly<{ readonly type: 'submission.claimed' | 'submission.completed' }>)
  | (SessionSubmissionTransitionBase &
      Readonly<{ readonly type: 'submission.suspended'; readonly suspension: SessionSuspensionDescriptor }>)
  | (SessionSubmissionTransitionBase &
      Readonly<{ readonly type: 'submission.failed'; readonly errorMessage: string }>);

export type SessionSubmissionUpdate = SessionSubmissionTransitionBase &
  (
    | { readonly type: 'submission.revised'; readonly input: SessionSubmissionInput }
    | { readonly type: 'submission.cancelled' }
  );

export type SessionQueuedSubmissionChange = { readonly expectedInput: SessionSubmissionInput } & (
  | { readonly kind: 'replace'; readonly input: SessionSubmissionInput }
  | { readonly kind: 'cancel' }
);

export type SessionSubmissionRecord =
  | SessionQueuedSubmission
  | SessionSubmissionTransition
  | SessionSubmissionUpdate;

export interface SessionPendingSubmission {
  readonly submissionId: string;
  readonly runId: string;
  readonly state: 'queued' | Extract<SessionSubmissionState, 'claimed' | 'suspended'>;
  readonly input: SessionSubmissionInput;
  readonly configuration: SessionSubmissionConfiguration;
  readonly suspension?: SessionSuspensionDescriptor;
}

export interface CreateSessionOptions {
  readonly id?: string;
  readonly binding: SessionBindingInput;
  readonly parent?: SessionDescriptor;
  readonly provider?: string;
  readonly model?: string;
}

export interface SessionObservationInput {
  readonly ok: boolean;
  readonly summary: string;
  readonly output?: unknown;
  readonly artifacts?: readonly ArtifactRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SessionSummary {
  readonly id: string;
  readonly timestamp: string;
  readonly updatedAt: string;
  readonly provider?: string;
  readonly model?: string;
  readonly bindingSchemaId: string;
  readonly bindingSchemaVersion: number;
  readonly bindingSha256: string;
}

export interface SessionReplayState {
  readonly session: SessionDescriptor;
  readonly branch: readonly SessionBranchEntry[];
  readonly runFinalizations: readonly SessionRunFinalization[];
  readonly contextWindow?: ContextWindowRecord;
  readonly sourceRevision: number;
  readonly ledgerRunIds: readonly string[];
}

export interface SessionRepository {
  create(options: CreateSessionOptions): Promise<SessionDescriptor>;
  open(sessionId: string, expectedBinding: SessionBindingInput): Promise<SessionDescriptor>;
  list(): Promise<readonly SessionSummary[]>;
  loadReplayState(session: SessionDescriptor, leafId?: string | null): Promise<SessionReplayState>;
  readConversation(session: SessionDescriptor): Promise<readonly SessionConversationItem[]>;
  listBranchPoints(session: SessionDescriptor): Promise<readonly SessionBranchPoint[]>;
  appendInput(
    session: SessionDescriptor,
    input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }
  ): Promise<SessionInputEntry>;
  appendSteering(
    session: SessionDescriptor,
    input: {
      runId: string;
      content: string;
      deliveryId?: string;
      relationship?: SessionInputRelationship;
      originalInput?: SessionSubmissionInput;
    }
  ): Promise<SessionSteeringEntry>;
  appendAssistant(
    session: SessionDescriptor,
    input: {
      runId: string;
      identity: AgentTurnIdentity;
      content: string;
      output?: readonly ModelOutputItem[];
      completeness?: SessionAssistantEntry['completeness'];
      source?: import('../history/contracts.js').HistoryEventSource;
    }
  ): Promise<SessionAssistantEntry>;
  appendToolCall(
    session: SessionDescriptor,
    input: { runId: string; identity: AgentToolCallIdentity; call: unknown }
  ): Promise<SessionToolCallEntry>;
  appendObservation(
    session: SessionDescriptor,
    input: {
      runId: string;
      identity: AgentTurnIdentity &
        Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>;
      toolName: string;
      observation: SessionObservationInput;
    }
  ): Promise<SessionObservationEntry>;
  appendModelSettings(
    session: SessionDescriptor,
    settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }
  ): Promise<SessionModelSettingsEntry>;
  commitContextTransition(
    session: SessionDescriptor,
    input: ContextTransitionCommit
  ): Promise<SessionContextTransitionEntry>;
  branchFrom(
    session: SessionDescriptor,
    entryId: string,
    label?: string,
    noteSource?: SessionBranchMarkerEntry['noteSource']
  ): Promise<SessionBranchMarkerEntry>;
  recordRunFinalization(
    session: SessionDescriptor,
    terminal: AgentTerminalSnapshot
  ): Promise<SessionRunFinalization>;
  enqueueSubmission(
    session: SessionDescriptor,
    input: {
      submissionId: string;
      runId: string;
      input: SessionSubmissionInput;
      configuration: SessionSubmissionConfiguration;
    }
  ): Promise<void>;
  transitionSubmission(
    session: SessionDescriptor,
    submissionId: string,
    outcome:
      | { readonly state: 'claimed' | 'completed' }
      | { readonly state: 'suspended'; readonly suspension: SessionSuspensionDescriptor }
      | { readonly state: 'failed'; readonly errorMessage: string }
  ): Promise<void>;
  loadPendingSubmissions(session: SessionDescriptor): Promise<readonly SessionPendingSubmission[]>;
  updateQueuedSubmission(
    session: SessionDescriptor,
    submissionId: string,
    change: SessionQueuedSubmissionChange
  ): Promise<void>;
  readBranchPage(session: SessionDescriptor, request?: SessionBranchPageRequest): Promise<SessionBranchPage>;
  searchBranch(
    session: SessionDescriptor,
    request: SessionBranchSearchRequest
  ): Promise<SessionBranchSearchResult>;
  readBranchEntry(
    session: SessionDescriptor,
    boundary: SessionBranchBoundary,
    entryId: string
  ): Promise<SessionBranchEntry>;
}
