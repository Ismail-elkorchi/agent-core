import type { ToolDefinition } from './definition.js';

export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'destructive';

export interface ToolPolicy {
  allowedRisks: readonly ToolRisk[];
  dryRunWrites?: boolean;
}

export const READ_ONLY_TOOL_POLICY: ToolPolicy = parseToolPolicy({ allowedRisks: ['read'] });

export function parseToolPolicy(value: unknown): ToolPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Tool policy must be an object.');
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'allowedRisks' && key !== 'dryRunWrites');
  if (unknown.length > 0) throw new Error('Tool policy contains unsupported fields: ' + unknown.join(', ') + '.');
  if (!Array.isArray(record.allowedRisks)) throw new Error('Tool policy must declare allowedRisks.');
  const allowedRisks: ToolRisk[] = record.allowedRisks.map((risk: unknown): ToolRisk => {
    if (risk !== 'read' && risk !== 'write' && risk !== 'execute' && risk !== 'network' && risk !== 'destructive') throw new Error('Tool policy contains an unsupported risk.');
    return risk;
  });
  if (new Set(allowedRisks).size !== allowedRisks.length) throw new Error('Tool policy risks must be unique.');
  if (record.dryRunWrites !== undefined && typeof record.dryRunWrites !== 'boolean') throw new Error('Tool policy dryRunWrites must be boolean.');
  return Object.freeze({ allowedRisks: Object.freeze(allowedRisks), ...(record.dryRunWrites === true ? { dryRunWrites: true } : {}) });
}

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
