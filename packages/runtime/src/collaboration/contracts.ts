import type { ScopedShareSource } from './share-contracts.js';
import type { CollaborationCoordinator } from './coordinator.js';
import { parseInferenceBudget, type InferenceBudget } from '../inference/repository.js';
import type { EventLedgerTail, EventReference } from '@agent-core/persistence';
import type { AgentSession, AgentSessionConfiguration } from '../session/agent-session.js';
import type { SessionSubmissionSnapshot } from '../session/contracts.js';
import type { AgentRunCoordinator } from '../run/control/driver.js';
import type { CollaborationRepository } from './repository.js';

/** These grants are supplied by the host, never inferred from task prose or topology. */
export interface ParticipantCapabilities {
  readonly toolNames: readonly string[];
  readonly collaboration?: {
    readonly actions: readonly ('start' | 'inspect' | 'continue' | 'message' | 'interrupt' | 'cancel' | 'accept')[];
    readonly participantIds: readonly string[];
  };
}
/** An exact already-imported peer delivery; resolving it never broadens source access. */
export interface CollaborationSourceReference {
  readonly deliveryId: string;
  readonly fingerprint: string;
}
export interface CollaborationParticipant {
  readonly groupId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly createdBySessionId: string;
  readonly parentParticipantId?: string;
}
export interface ParticipantAssignmentSender {readonly sessionId:string;readonly participantId?:string;readonly runId?:string}
export interface ParticipantAssignment {
  readonly origin: 'delegated' | 'user';
  readonly delegatedBy?: ParticipantAssignmentSender;
  readonly assignmentId: string;
  readonly participantId: string;
  readonly revision: number;
  readonly runId: string;
  readonly task: string;
  readonly epoch: number;
  readonly capabilityRevision: string;
  readonly capabilities: ParticipantCapabilities;
  /** Exact host model configuration captured before this assignment is admitted. */
  readonly configuration?: AgentSessionConfiguration;
  readonly budgetOwnerId: string;
  readonly budgetScopeId: string;
  readonly sourceRefs: readonly CollaborationSourceReference[];
  readonly initialSources: readonly ScopedShareSource[];
  readonly sourceSender?: {readonly participantId:string;readonly sessionId:string;readonly runId:string};
}
export interface ParticipantExecutionBinding {
  readonly groupId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly runId: string;
  readonly hostGeneration: number;
  readonly correctionEpoch: number;
  readonly capabilityRevision: string;
  readonly budgetOwnerId: string;
  readonly budgetScopeId: string;
  readonly capabilities: ParticipantCapabilities;
  readonly assertCurrent: () => Promise<void>;
  /** Serialize the admission/commit boundary, not an external operation's whole execution. */
  readonly withCurrent: <T>(operation: () => Promise<T>) => Promise<T>;
}
export interface ParticipantSessionFactoryInput {
  readonly coordinator: CollaborationCoordinator;
  readonly participant: CollaborationParticipant;
  readonly assignment: ParticipantAssignment;
  readonly binding: ParticipantExecutionBinding;
  readonly assertCurrent: () => Promise<void>;
  readonly withCurrent: ParticipantExecutionBinding['withCurrent'];
}
interface ParticipantResultIdentity {
  readonly resultId: string;
  readonly participantId: string;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly runId: string;
  readonly epoch: number;
}
/** Results refer to recorded truth. Acceptance is an independent application decision. */
export type ParticipantResultRecord = ParticipantResultIdentity & (
  | { readonly kind: 'partial'; readonly source: EventReference }
  | { readonly kind: 'final'; readonly finalizationId: string; readonly runEnded: EventReference }
);
export interface ParticipantResultAcceptance {
  readonly operationId: string;
  readonly resultId: string;
  readonly epoch: number;
}
export interface ParticipantControlTarget {
  readonly participantId: string;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly runId: string;
}
export interface ParticipantControlRecord {
  readonly operationId: string;
  readonly mode: 'interrupt' | 'cancel';
  readonly targets: readonly ParticipantControlTarget[];
  readonly reason: string;
  readonly epoch: number;
  readonly applied: boolean;
}
export interface ParticipantView {
  readonly phase: 'admitted' | 'running' | 'suspended' | 'ended' | 'cancelled';
  readonly participant: CollaborationParticipant;
  readonly assignment: ParticipantAssignment;
  readonly cancelled: boolean;
  readonly resultCount: number;
  readonly results: readonly ParticipantResultRecord[];
}
export interface CollaborationGroupState {
  readonly groupId: string;
  readonly supervisorSessionId: string;
  readonly budgetOwnerId: string;
  readonly maxParticipants: number;
  readonly maxConcurrentRuns: number;
  readonly epoch: number;
  readonly correctionRevision: number;
  readonly hostGeneration: number;
  readonly hostId: string;
  readonly tail: EventLedgerTail;
  readonly participants: readonly ParticipantView[];
  readonly controls: readonly ParticipantControlRecord[];
  readonly acceptances: readonly ParticipantResultAcceptance[];
}
export interface CollaborationCoordinatorOptions {
  readonly groupId: string;
  readonly hostId: string;
  readonly supervisorSessionId: string;
  readonly budgetOwnerId: string;
  readonly repository: CollaborationRepository;
  readonly runs: AgentRunCoordinator;
  /** Reopen the exact session identity, using the ordinary AgentSession/AgentRuntime path. */
  readonly createSession: (input: ParticipantSessionFactoryInput) => AgentSession | Promise<AgentSession>;
  readonly maxParticipants?: number;
  readonly maxConcurrentRuns?: number;
  readonly maxWaitMs?: number;
  readonly maxPendingOperations?: number;
  readonly readCorrectionRevision?: () => Promise<number>;
  /** Indexed canonical submission lookup for this exact session/run; never starts a session. */
  readonly readSubmission?: (input:{readonly sessionId:string;readonly runId:string}) => Promise<SessionSubmissionSnapshot | undefined>;
  readonly validateCapabilities?: (capabilities:ParticipantCapabilities) => void | Promise<void>;
  /** Capture the host-owned model binding before durable assignment admission. */
  readonly captureConfiguration?: () => AgentSessionConfiguration | Promise<AgentSessionConfiguration>;
  /** Release only this participant owner's application resources; must support idempotent retry. */
  readonly closeParticipant?: (participantId:string) => Promise<void>;
}
export interface ParticipantAssignmentInput {
  readonly origin?: 'delegated' | 'user';
  readonly delegatedBy?: ParticipantAssignmentSender;
  readonly operationId: string;
  readonly task: string;
  readonly expectedEpoch: number;
  readonly capabilityRevision: string;
  readonly capabilities: ParticipantCapabilities;
  readonly budgetScopeId: string;
  readonly sourceRefs?: readonly CollaborationSourceReference[];
  readonly initialSources?: readonly ScopedShareSource[];
  readonly sourceSender?: {readonly participantId:string;readonly sessionId:string;readonly runId:string};
}
export interface ParticipantStartInput extends ParticipantAssignmentInput {
  readonly participantId?: string;
  readonly sessionId?: string;
  readonly assignmentId?: string;
  readonly parentParticipantId?: string;
}
export interface ParticipantContinueInput extends ParticipantAssignmentInput {
  readonly expectedSessionId?: string;
  readonly expectedRunId?: string;
  readonly participantId: string;
  readonly assignmentId?: string;
}
export interface ParticipantControlInput {
  readonly operationId: string;
  readonly participantId: string;
  readonly expectedEpoch: number;
  readonly reason: string;
  readonly expectedSessionId?: string;
  readonly expectedRunId?: string;
  /** Host-bound target grant. Omission is reserved for an unrestricted supervisor. */
  readonly authorizedParticipantIds?: readonly string[];
}
export interface ParticipantWaitResult {
  readonly reason: 'settled' | 'timeout' | 'aborted';
  readonly participants: readonly ParticipantSummary[];
}

export interface CollaborationPolicy {
  readonly maxPendingOperations: number;
  readonly participantBudget: InferenceBudget;
  readonly maxParticipants: number;
  readonly maxConcurrentRuns: number;
  readonly maxWaitMs: number;
}
/** Bounded policy shared by application setup and the host, with no silent unknown fields. */
export function parseCollaborationPolicy(value: unknown = {}): CollaborationPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Collaboration policy must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['maxParticipants', 'maxConcurrentRuns', 'maxWaitMs', 'maxPendingOperations', 'participantBudget'].includes(key)))
    throw new TypeError('Unknown collaboration policy field.');
  const bounded = (value: unknown, fallback: number, maximum: number, name: string): number => {
    const selected = value === undefined ? fallback : value;
    if (typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
      throw new RangeError(`Invalid collaboration ${name}.`);
    return selected;
  };
  const maxParticipants = bounded(input.maxParticipants, 4, 256, 'maxParticipants');
  const maxConcurrentRuns = bounded(input.maxConcurrentRuns, Math.min(2, maxParticipants), maxParticipants, 'maxConcurrentRuns');
  return Object.freeze({maxPendingOperations:bounded(input.maxPendingOperations,64,1024,'maxPendingOperations'),participantBudget:parseInferenceBudget(input.participantBudget ?? {maxInvocations:32,maxPromptTokens:1000000,maxCompletionTokens:64000}),maxParticipants, maxConcurrentRuns, maxWaitMs: bounded(input.maxWaitMs, 30000, 300000, 'maxWaitMs')});
}

export interface ParticipantUserInput {
  readonly participantId: string;
  readonly sessionId: string;
  readonly expectedRunId: string;
  readonly expectedEpoch: number;
  readonly task: string;
}
export interface ParticipantUserContinueInput extends ParticipantUserInput { readonly operationId: string }
export type CollaborationNotification = {readonly type:'collaboration.changed';readonly groupId:string} | {readonly type:'delivery.gap'};

export interface ParticipantSummary {
  readonly participant: CollaborationParticipant;
  readonly assignment: Omit<ParticipantAssignment, 'capabilities' | 'configuration' | 'sourceRefs' | 'initialSources' | 'sourceSender'>;
  readonly sourceCount: number;
  readonly taskTruncated: boolean;
  readonly phase: ParticipantView['phase'];
  readonly cancelled: boolean;
  readonly resultCount: number;
  readonly results: readonly ParticipantResultRecord[];
}
export interface CollaborationParticipantPage {
  readonly groupId: string;
  readonly supervisorSessionId: string;
  readonly epoch: number;
  readonly maxParticipants: number;
  readonly maxConcurrentRuns: number;
  readonly maxWaitMs: number;
  readonly participants: readonly ParticipantSummary[];
  readonly total: number;
  readonly nextOffset: number | null;
  readonly coverage: 'complete' | 'partial';
}

export interface ParticipantResultRead {
  readonly result: ParticipantResultRecord;
  readonly source: EventReference;
  readonly classification: 'model_authored';
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly totalBytes: number;
  readonly coverage: 'complete' | 'partial';
  readonly executionStatus: 'completed' | 'aborted' | 'failed' | 'in_progress';
  readonly completeness: 'complete' | 'partial' | 'indeterminate' | 'absent';
}
