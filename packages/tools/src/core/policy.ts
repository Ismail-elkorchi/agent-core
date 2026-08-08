import type { ToolDefinition } from './definition.js';

export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'destructive';

export interface ToolPolicy {
  allowedRisks: readonly ToolRisk[];
  dryRunWrites?: boolean;
}

export const READ_ONLY_TOOL_POLICY: ToolPolicy = { allowedRisks: ['read'] };

export function isToolAvailable(tool: ToolDefinition, policy: ToolPolicy): boolean {
  if (tool.isAvailable) {
    return tool.isAvailable(policy);
  }
  return tool.effectEnvelope.accesses.some((access) => isRiskAllowed(policy, accessRisk(access.mode)));
}

export function isRiskAllowed(policy: ToolPolicy, risk: ToolRisk): boolean {
  return policy.allowedRisks.includes(risk);
}

function accessRisk(mode: import('./authorization.js').ToolResourceAccessMode): ToolRisk {
  if (mode === 'read') return 'read';
  if (mode === 'write') return 'write';
  if (mode === 'execute') return 'execute';
  if (mode === 'network') return 'network';
  return 'destructive';
}
