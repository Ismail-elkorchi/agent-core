import type { ToolDefinition } from './definition.js';
import { parseJsonObject } from '@agent-core/json';

export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'destructive';

/** `execute` authorizes ambient process execution unless a host explicitly documents isolation. Ambient execution may indirectly exercise every other operating-system authority. */

export interface ToolPolicy {
  allowedRisks: readonly ToolRisk[];
  dryRunWrites?: boolean;
}

export const READ_ONLY_TOOL_POLICY: ToolPolicy = parseToolPolicy({ allowedRisks: ['read'] });

export function parseToolPolicy(value: unknown): ToolPolicy {
  const record = parseJsonObject(value, { maxDepth: 4, maxCollectionEntries: 20, maxStringBytes: 100, maxTotalBytes: 2_000 });
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
