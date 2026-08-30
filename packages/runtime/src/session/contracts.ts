import type { ArtifactRef } from '@agent-core/evidence';
import type { JsonObject, JsonValue } from '@agent-core/json';
import type { ModelReasoningRequest, ModelResponseFormat } from '@agent-core/model';
import type { ContextItemInput } from '../context/manager.js';
import type { SessionBinding, SessionBindingInput } from './binding.js';
import type {
  AgentEffectiveInstruction,
  AgentTerminalSnapshot,
  AgentToolCallAttemptIdentity,
  AgentToolCallIdentity,
  AgentTurnIdentity
} from '../run/contracts.js';
import type { AgentDecisionRequest } from '../operation/contracts.js';

export type SessionHeader = Readonly<{
  readonly type: 'session';
  readonly version: 1;
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

export type BaseSessionEntry = Readonly<{
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}>;

export type SessionInputEntry = BaseSessionEntry & Readonly<{
  readonly type: 'input';
  readonly runId: string;
  readonly task: string;
  readonly instructions: readonly AgentEffectiveInstruction[];
}>;

export type SessionSteeringEntry = BaseSessionEntry & Readonly<{
  readonly type: 'steering';
  readonly runId: string;
  readonly content: string;
}>;

export type SessionAssistantEntry = BaseSessionEntry & AgentTurnIdentity & Readonly<{
  readonly type: 'assistant';
  readonly runId: string;
  readonly content: string;
}>;

export type SessionToolCallEntry = BaseSessionEntry & AgentToolCallIdentity & Readonly<{
  readonly type: 'tool_call';
  readonly runId: string;
  readonly call: JsonValue;
}>;

export type SessionObservationEntry = BaseSessionEntry & AgentTurnIdentity & Readonly<{
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

export type SessionBranchMarkerEntry = BaseSessionEntry & Readonly<{
  readonly type: 'branch';
  readonly fromEntryId: string;
  readonly label?: string;
}>;

export type SessionModelSettingsEntry = BaseSessionEntry & Readonly<{
  readonly type: 'model_settings';
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
}>;

export type SessionCompactionEntry = BaseSessionEntry & Readonly<{
  readonly type: 'compaction';
  readonly summary: string;
  readonly provider: string;
  readonly model: string;
}>;

export type SessionFinalProjection = Readonly<{
  readonly type: 'final';
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
  | SessionCompactionEntry;

export type SessionConversationItem =
  | SessionInputEntry
  | SessionSteeringEntry
  | SessionAssistantEntry
  | SessionToolCallEntry
  | SessionObservationEntry
  | SessionCompactionEntry;

export interface SessionBranchPoint {
  readonly entryId: string;
  readonly timestamp: string;
  readonly kind: 'final' | 'compaction';
  readonly runId?: string;
  readonly finalizationId?: string;
}

export interface SessionSubmissionInput {
  readonly task: string;
  readonly instructions?: readonly string[];
  readonly contextItems?: readonly ContextItemInput[];
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

export type SessionSubmissionState = 'claimed' | 'suspended' | 'completed' | 'failed';

export type SessionSuspensionCategory = 'approval' | 'external_recovery' | 'implementation' | 'user_decision';
export type SessionSuspensionAction = 'approval' | 'reconcile' | 'resume' | 'decide' | 'abort';
export interface SessionSuspensionDescriptor {
  readonly runId: string;
  readonly submissionId: string;
  readonly category: SessionSuspensionCategory;
  readonly reason: 'approval_required' | 'provider_outcome_unknown' | 'tool_outcome_unknown' | 'disposition_outcome_unknown' | 'missing_implementation' | 'user_decision';
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
  | (SessionSubmissionTransitionBase & Readonly<{ readonly type: 'submission.claimed' | 'submission.completed' }>)
  | (SessionSubmissionTransitionBase & Readonly<{ readonly type: 'submission.suspended'; readonly suspension: SessionSuspensionDescriptor }>)
  | (SessionSubmissionTransitionBase & Readonly<{ readonly type: 'submission.failed'; readonly errorMessage: string }>);

export type SessionSubmissionRecord = SessionQueuedSubmission | SessionSubmissionTransition;

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
  readonly terminalProjections: readonly SessionFinalProjection[];
  readonly compaction?: SessionCompactionEntry;
  readonly ledgerRunIds: readonly string[];
}

export interface SessionRepository {
  create(options: CreateSessionOptions): Promise<SessionDescriptor>;
  open(sessionId: string, expectedBinding: SessionBindingInput): Promise<SessionDescriptor>;
  list(): Promise<readonly SessionSummary[]>;
  loadReplayState(session: SessionDescriptor, leafId?: string | null): Promise<SessionReplayState>;
  readConversation(session: SessionDescriptor): Promise<readonly SessionConversationItem[]>;
  listBranchPoints(session: SessionDescriptor): Promise<readonly SessionBranchPoint[]>;
  appendInput(session: SessionDescriptor, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry>;
  appendSteering(session: SessionDescriptor, input: { runId: string; content: string }): Promise<SessionSteeringEntry>;
  appendAssistant(session: SessionDescriptor, input: { runId: string; identity: AgentTurnIdentity; content: string }): Promise<SessionAssistantEntry>;
  appendToolCall(session: SessionDescriptor, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry>;
  appendObservation(session: SessionDescriptor, input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Promise<SessionObservationEntry>;
  appendModelSettings(session: SessionDescriptor, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry>;
  appendCompaction(session: SessionDescriptor, input: { summary: string; provider: string; model: string }): Promise<SessionCompactionEntry>;
  branchFrom(session: SessionDescriptor, entryId: string, label?: string): Promise<SessionBranchMarkerEntry>;
  projectFinal(session: SessionDescriptor, terminal: AgentTerminalSnapshot): Promise<SessionFinalProjection>;
  enqueueSubmission(session: SessionDescriptor, input: { submissionId: string; runId: string; input: SessionSubmissionInput; configuration: SessionSubmissionConfiguration }): Promise<void>;
  transitionSubmission(session: SessionDescriptor, submissionId: string, outcome:
    | { readonly state: 'claimed' | 'completed' }
    | { readonly state: 'suspended'; readonly suspension: SessionSuspensionDescriptor }
    | { readonly state: 'failed'; readonly errorMessage: string }): Promise<void>;
  loadPendingSubmissions(session: SessionDescriptor): Promise<readonly SessionPendingSubmission[]>;
}
