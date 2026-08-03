import type { ToolDefinition } from './definition.js';

export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'destructive';

export interface ToolPolicy {
  allowedRisks: readonly ToolRisk[];
  dryRunWrites?: boolean;
  allowUnsafeShell?: boolean;
}

export const READ_ONLY_TOOL_POLICY: ToolPolicy = { allowedRisks: ['read'] };

export function isToolAvailable(tool: ToolDefinition, policy: ToolPolicy): boolean {
  if (tool.isAvailable) {
    return tool.isAvailable(policy);
  }
  return isRiskAllowed(policy, tool.risk);
}

export function isRiskAllowed(policy: ToolPolicy, risk: ToolRisk): boolean {
  return policy.allowedRisks.includes(risk);
}
