import type { ModelReasoningEffort } from '@agent-core/model';

export function parseReasoningEffort(value: string, source: string): ModelReasoningEffort {
  if (value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  throw new Error(`${source} must be one of: none, minimal, low, medium, high, xhigh, max.`);
}
