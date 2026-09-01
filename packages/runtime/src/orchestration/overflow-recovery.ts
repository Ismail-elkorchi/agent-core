import type { RequestCostEstimate } from './budget-accountant.js';

export type OverflowRecoveryAction =
  | { kind: 'reduce_context_history'; reductions: number }
  | { kind: 'reduce_observed_facts'; removedRecords: number }
  | { kind: 'install_checkpoint'; compactedToolResults: number }
  | { kind: 'diagnostic_failure'; diagnostic: OverflowDiagnostic };

export interface OverflowDiagnostic {
  reason: 'model_context_window' | 'tool_schema_cost';
  messageTokens: number;
  modelWindowTokens: number;
  contextTokens: number;
  observedFactTokens: number;
  toolSchemaTokens: number;
  outputReserveTokens: number;
  totalRequestTokens: number;
  readonly reductionsAttempted: readonly OverflowRecoveryAction[];
}

export type OverflowRecoveryResult =
  | { kind: 'retry'; action: OverflowRecoveryAction }
  | { kind: 'diagnostic'; diagnostic: OverflowDiagnostic };

export const OVERFLOW_RECOVERY_STAGES = ['older_history', 'all_history', 'observedFacts', 'checkpoint'] as const;
export type OverflowRecoveryStage = typeof OVERFLOW_RECOVERY_STAGES[number];

export function createOverflowDiagnostic(estimate: RequestCostEstimate, actions: readonly OverflowRecoveryAction[]): OverflowDiagnostic {
  return Object.freeze({
    reason: estimate.toolSchemaTokens > estimate.messageTokens + estimate.modelWindowTokens + estimate.contextTokens
      ? 'tool_schema_cost'
      : 'model_context_window',
    messageTokens: estimate.messageTokens,
    modelWindowTokens: estimate.modelWindowTokens,
    contextTokens: estimate.contextTokens,
    observedFactTokens: estimate.observedFactTokens,
    toolSchemaTokens: estimate.toolSchemaTokens,
    outputReserveTokens: estimate.outputReserveTokens,
    totalRequestTokens: estimate.totalRequestTokens,
    reductionsAttempted: [...actions]
  });
}
