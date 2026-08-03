import type { ArtifactRef, JsonObject, JsonValue } from '@agent-core/evidence';
import type {
  AgentEffectiveInstruction,
  AgentTerminalSnapshot,
  AgentToolCallAttemptIdentity,
  AgentToolCallIdentity,
  AgentTurnIdentity
} from '../run/contracts.js';

export interface SessionHeader {
  readonly type: 'session';
  readonly version: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly workspaceRoot: string;
  readonly parentSessionId?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface AgentSession {
  readonly id: string;
  readonly header: SessionHeader;
  readonly leafId: string | null;
}

export interface BaseSessionEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

export interface SessionInputEntry extends BaseSessionEntry {
  readonly type: 'input';
  readonly runId: string;
  readonly task: string;
  readonly instructions: readonly AgentEffectiveInstruction[];
}

export interface SessionToolCallEntry extends BaseSessionEntry, AgentToolCallIdentity {
  readonly type: 'tool_call';
  readonly runId: string;
  readonly call: JsonValue;
}

export interface SessionObservationEntry extends BaseSessionEntry, AgentTurnIdentity {
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
}

export interface SessionBranchMarkerEntry extends BaseSessionEntry {
  readonly type: 'branch';
  readonly fromEntryId: string;
  readonly label?: string;
}

export interface SessionModelSettingsEntry extends BaseSessionEntry {
  readonly type: 'model_settings';
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
}

export interface SessionFinalProjection {
  readonly type: 'final';
  readonly id: string;
  readonly timestamp: string;
  readonly runId: string;
  readonly finalizationId: string;
  readonly terminal: AgentTerminalSnapshot;
}

export interface SessionTurnDigest {
  readonly runId: string;
  readonly finalizationId: string;
  readonly task: string;
  readonly status: string;
  readonly result?: string;
}

export interface SessionContextProjection {
  readonly type: 'context';
  readonly id: string;
  readonly timestamp: string;
  readonly throughEntryId: string;
  readonly throughFinalizationId: string;
  readonly historyDigest: string;
  readonly recentTurns: readonly SessionTurnDigest[];
}

export type SessionBranchEntry = SessionInputEntry | SessionToolCallEntry | SessionObservationEntry | SessionBranchMarkerEntry | SessionModelSettingsEntry;
export type SessionRecord = SessionHeader | SessionBranchEntry | SessionFinalProjection | SessionContextProjection;

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
  readonly provider?: string;
  readonly model?: string;
}

export interface SessionReplayState {
  readonly session: AgentSession;
  readonly branch: readonly SessionBranchEntry[];
  readonly terminalProjections: readonly SessionFinalProjection[];
  readonly contextProjection?: SessionContextProjection;
  readonly ledgerRunIds: readonly string[];
}

export interface SessionRepository {
  create(options: CreateSessionOptions): Promise<AgentSession>;
  open(sessionId: string): Promise<AgentSession>;
  list(workspaceRoot?: string): Promise<readonly SessionSummary[]>;
  loadReplayState(sessionId: string, leafId?: string | null): Promise<SessionReplayState>;
  appendInput(sessionId: string, input: { runId: string; task: string; instructions?: readonly AgentEffectiveInstruction[] }): Promise<SessionInputEntry>;
  appendToolCall(sessionId: string, input: { runId: string; identity: AgentToolCallIdentity; call: unknown }): Promise<SessionToolCallEntry>;
  appendObservation(sessionId: string, input: { runId: string; identity: AgentTurnIdentity & Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>; toolName: string; observation: SessionObservationInput }): Promise<SessionObservationEntry>;
  appendModelSettings(sessionId: string, settings: { provider: string; model: string; temperature?: number; reasoningEffort?: string }): Promise<SessionModelSettingsEntry>;
  branchFrom(sessionId: string, entryId: string, label?: string): Promise<SessionBranchMarkerEntry>;
  projectFinal(sessionId: string, terminal: AgentTerminalSnapshot): Promise<SessionFinalProjection>;
}
