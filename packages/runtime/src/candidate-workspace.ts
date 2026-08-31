import type { EffectRecoveryCapability } from '@agent-core/effects';
import { parseJsonValue, type JsonValue } from '@agent-core/json';
import {
  createAgentPreparedDispositionEffect,
  type AgentDispositionDecision,
  type AgentPreparedDispositionEffect
} from './operation/disposition/contracts.js';

export interface AgentCandidateWorkspaceDescriptor {
  readonly implementationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourceId: string;
}

export interface AgentCandidateWorkspaceCheckpoint {
  readonly checkpointId: string;
  readonly digest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface AgentCandidateWorkspaceDiffEntry {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'replaced';
  readonly content: 'text' | 'binary' | 'directory' | 'other';
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

export interface AgentCandidateWorkspaceDiff {
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly entries: readonly AgentCandidateWorkspaceDiffEntry[];
}

export type AgentCandidateWorkspacePromotionResult =
  | Readonly<{
      readonly status: 'promoted';
      readonly baselineDigest: string;
      readonly candidateDigest: string;
      readonly changedPaths: readonly string[];
      readonly transactionId: string;
    }>
  | Readonly<{
      readonly status: 'not_promoted';
      readonly reason: string;
    }>;

export type AgentCandidateWorkspacePromotionReconciliation =
  | Readonly<{ readonly status: 'settled'; readonly result: AgentCandidateWorkspacePromotionResult }>
  | Readonly<{ readonly status: 'running' | 'unknown' | 'expired' }>;

export interface AgentPreparedCandidateWorkspacePromotion {
  readonly authorization: JsonValue;
  readonly recovery: EffectRecoveryCapability;
  start(signal: AbortSignal): Promise<AgentCandidateWorkspacePromotionResult>;
  reconcile(signal: AbortSignal): Promise<AgentCandidateWorkspacePromotionReconciliation>;
  release(): Promise<void>;
}

export interface AgentCandidateWorkspace {
  readonly descriptor: AgentCandidateWorkspaceDescriptor;
  readonly baseline: AgentCandidateWorkspaceCheckpoint;
  checkpoint(label: string, signal?: AbortSignal): Promise<AgentCandidateWorkspaceCheckpoint>;
  diff(signal?: AbortSignal): Promise<AgentCandidateWorkspaceDiff>;
  rollback(checkpointId: string, signal?: AbortSignal): Promise<AgentCandidateWorkspaceCheckpoint>;
  preparePromotion(signal?: AbortSignal): Promise<AgentPreparedCandidateWorkspacePromotion | AgentCandidateWorkspacePromotionResult>;
  release(): Promise<void>;
}

/** Converts a candidate publication into the disposition effect that owns acceptance. */
export async function prepareCandidateWorkspaceAcceptance(
  workspace: AgentCandidateWorkspace,
  signal?: AbortSignal
): Promise<AgentDispositionDecision | AgentPreparedDispositionEffect> {
  const prepared = await workspace.preparePromotion(signal);
  if (!isPreparedPromotion(prepared)) return promotionDecision(prepared);
  return createAgentPreparedDispositionEffect({
    authorization: parseJsonValue(prepared.authorization),
    recovery: prepared.recovery,
    start: async (startSignal) => promotionDecision(await prepared.start(startSignal)),
    reconcile: async (reconcileSignal) => {
      const reconciliation = await prepared.reconcile(reconcileSignal);
      return reconciliation.status === 'settled'
        ? Object.freeze({ status: 'settled' as const, decision: promotionDecision(reconciliation.result) })
        : reconciliation;
    },
    release: () => prepared.release()
  });
}

function isPreparedPromotion(
  value: AgentPreparedCandidateWorkspacePromotion | AgentCandidateWorkspacePromotionResult
): value is AgentPreparedCandidateWorkspacePromotion {
  return 'start' in value && typeof value.start === 'function';
}

function promotionDecision(result: AgentCandidateWorkspacePromotionResult): AgentDispositionDecision {
  return result.status === 'promoted'
    ? Object.freeze({ kind: 'accept' as const })
    : Object.freeze({ kind: 'inconclusive' as const, reason: boundedReason(result.reason) });
}

function boundedReason(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return 'Candidate workspace publication did not complete.';
  return normalized.length <= 16_000 ? normalized : `${normalized.slice(0, 15_999)}…`;
}
