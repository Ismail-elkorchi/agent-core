import type { ToolCall, ToolEffects, ToolObservation } from '@agent-core/tools';
import type { AgentTuiActivityEntry } from './conversation-model.js';

export function toolActivityId(identity: {
  readonly turnId: string;
  readonly toolBatchId: string;
  readonly callIndex: number;
  readonly callId?: string;
}): string {
  return `tool:${identity.callId ?? `${identity.turnId}:${identity.toolBatchId}:${String(identity.callIndex)}`}`;
}

export function pendingToolActivity(id: string, call: ToolCall): AgentTuiActivityEntry {
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label: toolLabel(call),
    status: 'running',
    summary: 'Waiting to run',
    details: formatToolInput(call)
  };
}

export function runningToolActivity(
  id: string,
  call: ToolCall,
  effects: ToolEffects
): AgentTuiActivityEntry {
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label: toolLabel(call),
    status: 'running',
    summary: 'Running',
    details: [formatToolInput(call), formatEffects(effects)].filter(Boolean).join('\n\n')
  };
}

export function updatedToolActivity(
  current: AgentTuiActivityEntry | undefined,
  id: string,
  toolName: string,
  message: string
): AgentTuiActivityEntry {
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label: current?.label ?? humanize(toolName),
    status: 'running',
    summary: compact(message),
    ...(current?.details === undefined ? {} : { details: current.details })
  };
}

export function completedToolActivity(
  current: AgentTuiActivityEntry | undefined,
  id: string,
  toolName: string,
  observation: ToolObservation
): AgentTuiActivityEntry {
  const summary = compact(observation.summary);
  const details = [
    current?.details,
    formatOutput(observation.output),
    formatEvidence(observation)
  ].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n');
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label: current?.label ?? humanize(toolName),
    status: observation.ok ? 'success' : 'failed',
    ...(summary.length === 0 ? {} : { summary }),
    ...(details.length === 0 ? {} : { details: bounded(details, 6_000) })
  };
}

export function formatApprovalInput(call: ToolCall): string {
  return formatToolInput(call);
}

function toolLabel(call: ToolCall): string {
  const value = call.input.kind === 'json' ? call.input.value : undefined;
  switch (call.name) {
    case 'shell_command': return `Run ${quoted(firstString(value, ['command']) ?? (call.input.kind === 'text' ? call.input.value : 'command'))}`;
    case 'apply_patch': return 'Apply workspace patch';
    case 'read_text_files': return `Read ${compactTarget(value, ['paths', 'path'])}`;
    case 'search_file_text': return `Search for ${quoted(firstString(value, ['query', 'pattern']) ?? 'text')}`;
    case 'list_directory_tree': return `List ${compactTarget(value, ['path', 'root'])}`;
    default: return humanize(call.name);
  }
}

function compactTarget(value: Record<string, unknown> | undefined, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
    if (Array.isArray(candidate)) {
      const paths = candidate.filter((item): item is string => typeof item === 'string');
      if (paths.length > 0) return paths.length === 1 ? paths[0] ?? 'workspace' : `${String(paths.length)} paths`;
    }
  }
  return 'workspace';
}

function firstString(value: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return compact(candidate);
  }
  return undefined;
}

function formatToolInput(call: ToolCall): string {
  const value = call.input.kind === 'text' ? call.input.value : call.input.value;
  return `Input\n${formatValue(value)}`;
}

function formatEffects(effects: ToolEffects): string {
  return `Effects\n${humanize(effects.kind)} · ${effects.resourceScopes.join(', ')} · ${humanize(effects.idempotency)}`;
}

function formatOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  const formatted = formatValue(output);
  return formatted.length === 0 ? undefined : `Output\n${formatted}`;
}

function formatEvidence(observation: ToolObservation): string | undefined {
  const items = observation.evidence?.items ?? [];
  if (items.length === 0) return undefined;
  const lines = items.slice(0, 12).map((item) => {
    const resources = (item.resources ?? []).map((resource) => resource.uri).join(', ');
    return `- ${humanize(item.action)}${resources.length === 0 ? '' : `: ${resources}`}${item.summary === undefined ? '' : ` — ${compact(item.summary)}`}`;
  });
  return `Evidence\n${lines.join('\n')}${items.length > lines.length ? `\n… ${String(items.length - lines.length)} more` : ''}`;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return bounded(value.trim(), 4_000);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return bounded(String(value), 4_000);
  try {
    return bounded(JSON.stringify(value, null, 2), 4_000);
  } catch {
    return '[Unserializable value]';
  }
}

function quoted(value: string): string {
  return `“${bounded(value.replaceAll('\n', ' '), 72)}”`;
}

function compact(value: string): string {
  return bounded(value.trim().replaceAll(/\s+/g, ' '), 180);
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words.length === 0 ? 'Tool' : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}
