import type { RequestCostEstimate } from './budget-accountant.js';

export interface OverflowDiagnostic {
  reason: 'model_context_window' | 'tool_schema_cost';
  messageTokens: number;
  modelWindowTokens: number;
  contextTokens: number;
  toolSchemaTokens: number;
  outputReserveTokens: number;
  totalRequestTokens: number;
}

export interface OverflowRecoveryResult {
  readonly kind: 'diagnostic';
  readonly diagnostic: OverflowDiagnostic;
}

export function createOverflowDiagnostic(estimate: RequestCostEstimate): OverflowDiagnostic {
  return Object.freeze({
    reason:
      estimate.toolSchemaTokens >
      estimate.messageTokens + estimate.modelWindowTokens + estimate.contextTokens
        ? 'tool_schema_cost'
        : 'model_context_window',
    messageTokens: estimate.messageTokens,
    modelWindowTokens: estimate.modelWindowTokens,
    contextTokens: estimate.contextTokens,
    toolSchemaTokens: estimate.toolSchemaTokens,
    outputReserveTokens: estimate.outputReserveTokens,
    totalRequestTokens: estimate.totalRequestTokens
  });
}
