import type { RequestCostEstimate } from './budget-accountant.js';

export type OverflowRecoveryAction =
  | { kind: 'reduce_context_history'; reductions: number }
  | { kind: 'reduce_context'; removedItems: number }
  | { kind: 'reduce_evidence'; removedRecords: number }
  | { kind: 'install_checkpoint'; compactedToolResults: number }
  | { kind: 'diagnostic_failure'; diagnostic: OverflowDiagnostic };

export interface OverflowDiagnostic {
  reason: 'model_context_window' | 'tool_schema_cost';
  messageTokens: number;
  contextHistoryTokens: number;
  contextTokens: number;
  evidenceTokens: number;
  toolSchemaTokens: number;
  outputReserveTokens: number;
  totalRequestTokens: number;
  reductionsAttempted: OverflowRecoveryAction[];
}

export type OverflowRecoveryResult =
  | { kind: 'retry'; action: OverflowRecoveryAction }
  | { kind: 'diagnostic'; diagnostic: OverflowDiagnostic };

export const OVERFLOW_RECOVERY_STAGES = ['older_history', 'all_history', 'context', 'evidence', 'checkpoint'] as const;
export type OverflowRecoveryStage = typeof OVERFLOW_RECOVERY_STAGES[number];

export function createOverflowDiagnostic(estimate: RequestCostEstimate, actions: readonly OverflowRecoveryAction[]): OverflowDiagnostic {
  return Object.freeze({
    reason: estimate.toolSchemaTokens > estimate.messageTokens + estimate.contextHistoryTokens + estimate.contextTokens
      ? 'tool_schema_cost'
      : 'model_context_window',
    messageTokens: estimate.messageTokens,
    contextHistoryTokens: estimate.contextHistoryTokens,
    contextTokens: estimate.contextTokens,
    evidenceTokens: estimate.evidenceTokens,
    toolSchemaTokens: estimate.toolSchemaTokens,
    outputReserveTokens: estimate.outputReserveTokens,
    totalRequestTokens: estimate.totalRequestTokens,
    reductionsAttempted: [...actions]
  });
}
