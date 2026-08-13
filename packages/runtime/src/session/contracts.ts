import type { ArtifactRef } from '@agent-core/evidence';
import type { JsonObject, JsonValue } from '@agent-core/json';
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

export type SessionBranchEntry = SessionInputEntry | SessionToolCallEntry | SessionObservationEntry | SessionBranchMarkerEntry | SessionModelSettingsEntry;

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
  readonly ledgerRunIds: readonly string[];
}

export interface SessionRepository {
  create(options: CreateSessionOptions): Promise<SessionDescriptor>;
  open(sessionId: string): Promise<SessionDescriptor>;
  list(workspaceRoot?: string): Promise<readonly SessionSummary[]>;
  loadReplayState(sessionId: string, leafId?: string | null): Promise<SessionReplayState>;
  appendInput(sessionId: string, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry>;
  appendToolCall(sessionId: string, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry>;
  appendObservation(sessionId: string, input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Promise<SessionObservationEntry>;
  appendModelSettings(sessionId: string, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry>;
  branchFrom(sessionId: string, entryId: string, label?: string): Promise<SessionBranchMarkerEntry>;
  projectFinal(sessionId: string, terminal: AgentTerminalSnapshot): Promise<SessionFinalProjection>;
}
