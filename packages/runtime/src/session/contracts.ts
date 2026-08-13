import type { ArtifactRef } from '@agent-core/evidence';
import type { JsonObject, JsonValue } from '@agent-core/json';
import type { ModelReasoningRequest, ModelResponseFormat } from '@agent-core/model';
import type { ContextItemInput } from '../context/manager.js';
import type {
  AgentEffectiveInstruction,
  AgentTerminalSnapshot,
  AgentToolCallAttemptIdentity,
  AgentToolCallIdentity,
  AgentTurnIdentity
} from '../run/contracts.js';

export type SessionHeader = Readonly<{
  readonly type: 'session';
  readonly version: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly workspaceRoot: string;
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
  readonly runId: string;
  readonly finalizationId: string;
  readonly terminal: AgentTerminalSnapshot;
}>;

export type SessionTurnDigest = Readonly<{
  readonly runId: string;
  readonly finalizationId: string;
  readonly task: string;
  readonly status: string;
  readonly result?: string;
}>;

export type SessionContextProjection = Readonly<{
  readonly type: 'context';
  readonly id: string;
  readonly timestamp: string;
  readonly throughEntryId: string;
  readonly throughFinalizationId: string;
  readonly historyDigest: string;
  readonly recentTurns: readonly SessionTurnDigest[];
}>;

export type SessionBranchEntry =
  | SessionInputEntry
  | SessionAssistantEntry
  | SessionToolCallEntry
  | SessionObservationEntry
  | SessionBranchMarkerEntry
  | SessionModelSettingsEntry
  | SessionCompactionEntry;

export type SessionConversationItem =
  | SessionInputEntry
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

export type SessionSubmissionTransition = Readonly<{
  readonly type: `submission.${SessionSubmissionState}`;
  readonly submissionId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly errorMessage?: string;
}>;

export type SessionSubmissionRecord = SessionQueuedSubmission | SessionSubmissionTransition;

export interface SessionPendingSubmission {
  readonly submissionId: string;
  readonly runId: string;
  readonly state: 'queued' | Extract<SessionSubmissionState, 'claimed' | 'suspended'>;
  readonly input: SessionSubmissionInput;
  readonly configuration: SessionSubmissionConfiguration;
}

export interface CreateSessionOptions {
  readonly id?: string;
  readonly workspaceRoot: string;
  readonly parentSessionId?: string;
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
  readonly workspaceRoot: string;
  readonly timestamp: string;
  readonly updatedAt: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface SessionReplayState {
  readonly session: SessionDescriptor;
  readonly branch: readonly SessionBranchEntry[];
  readonly terminalProjections: readonly SessionFinalProjection[];
  readonly contextProjection?: SessionContextProjection;
  readonly compaction?: SessionCompactionEntry;
  readonly ledgerRunIds: readonly string[];
}

export interface SessionRepository {
  create(options: CreateSessionOptions): Promise<SessionDescriptor>;
  open(sessionId: string): Promise<SessionDescriptor>;
  list(workspaceRoot?: string): Promise<readonly SessionSummary[]>;
  loadReplayState(sessionId: string, leafId?: string | null): Promise<SessionReplayState>;
  readConversation(sessionId: string): Promise<readonly SessionConversationItem[]>;
  listBranchPoints(sessionId: string): Promise<readonly SessionBranchPoint[]>;
  appendInput(sessionId: string, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry>;
  appendAssistant(sessionId: string, input: { runId: string; identity: AgentTurnIdentity; content: string }): Promise<SessionAssistantEntry>;
  appendToolCall(sessionId: string, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry>;
  appendObservation(sessionId: string, input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Promise<SessionObservationEntry>;
  appendModelSettings(sessionId: string, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry>;
  appendCompaction(sessionId: string, input: { summary: string; provider: string; model: string }): Promise<SessionCompactionEntry>;
  branchFrom(sessionId: string, entryId: string, label?: string): Promise<SessionBranchMarkerEntry>;
  projectFinal(sessionId: string, terminal: AgentTerminalSnapshot): Promise<SessionFinalProjection>;
  enqueueSubmission(sessionId: string, input: { submissionId: string; runId: string; input: SessionSubmissionInput; configuration: SessionSubmissionConfiguration }): Promise<void>;
  transitionSubmission(sessionId: string, submissionId: string, outcome: { state: SessionSubmissionState; errorMessage?: string }): Promise<void>;
  loadPendingSubmissions(sessionId: string): Promise<readonly SessionPendingSubmission[]>;
}
