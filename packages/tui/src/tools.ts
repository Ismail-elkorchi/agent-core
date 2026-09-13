import type { ToolCall, ToolEffects, ToolObservation, ToolProgress } from '@agent-core/tools';
import type { ActivityDetail, ConversationActivityEntry } from './conversation.js';
export interface ToolActivity extends ConversationActivityEntry {
  readonly activity: 'tool';
}

interface ExistingActivity {
  readonly label: string;
  readonly details?: readonly ActivityDetail[];
}

type ToolDisplayValue = ToolCall['input']['value'] | ToolObservation['output'];

export function toolActivityId(identity: {
  readonly runId: string;
  readonly turnId: string;
  readonly toolBatchId: string;
  readonly callIndex: number;
  readonly callId?: string;
}): string {
  return `tool:${identity.runId}:${identity.turnId}:${identity.toolBatchId}:${String(identity.callIndex)}`;
}

export function completedSessionToolActivity(
  current: ExistingActivity | undefined,
  entry: import('@agent-core/runtime').SessionObservationEntry
): ToolActivity {
  const details = settleDetails(current, [
    detail('output', entry.output === undefined ? undefined : `Output\n${formatValue(entry.output)}`),
    detail(
      'artifacts',
      entry.artifacts?.length
        ? `Artifacts\n${entry.artifacts
            .filter((artifact) => artifact.visibility === 'public')
            .map((artifact) => artifact.artifactId)
            .join('\n')}`
        : undefined
    )
  ]);
  return {
    id: sessionObservationActivityId(entry),
    kind: 'activity',
    activity: 'tool',
    label: current?.label ?? humanize(entry.toolName),
    status: entry.ok ? 'success' : 'failed',
    summary: compact(entry.summary),
    ...(details.length === 0 ? {} : { details: details })
  };
}

export function sessionObservationActivityId(
  entry: import('@agent-core/runtime').SessionObservationEntry
): string {
  if (entry.toolBatchId !== undefined && entry.callIndex !== undefined) {
    return toolActivityId({
      runId: entry.runId,
      turnId: entry.turnId,
      toolBatchId: entry.toolBatchId,
      callIndex: entry.callIndex
    });
  }
  return `tool:${entry.runId}:observation:${entry.id}`;
}

export function pendingToolActivity(id: string, call: ToolCall, label = humanize(call.name)): ToolActivity {
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label,
    status: 'running',
    summary: 'Waiting to run',
    details: [{ id: 'input', content: formatToolInput(call) }]
  };
}

export function runningToolActivity(
  id: string,
  call: ToolCall,
  effects: ToolEffects,
  label = humanize(call.name)
): ToolActivity {
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label,
    status: 'running',
    summary: 'Running',
    details: [
      { id: 'input', content: formatToolInput(call) },
      { id: 'effects', content: formatEffects(effects) }
    ]
  };
}

export function updatedToolActivity(
  current: ExistingActivity | undefined,
  id: string,
  toolName: string,
  progress: ToolProgress
): ToolActivity {
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label: current?.label ?? humanize(toolName),
    status: 'running',
    summary:
      progress.type === 'output'
        ? `${progress.stream} output`
        : progress.type === 'status'
          ? compact(progress.message ?? progress.stage)
          : `${progress.name}: ${String(progress.value)}${progress.unit ? ` ${progress.unit}` : ''}`,
    details:
      progress.type === 'output'
        ? [
            ...(current?.details ?? []).filter((section) => section.id !== `live:${progress.stream}`),
            {
              id: `live:${progress.stream}`,
              content: `${current?.details?.find((section) => section.id === `live:${progress.stream}`)?.content ?? `${progress.stream}\n`}${progress.text}`
            }
          ]
        : (current?.details ?? [])
  };
}

export function completedToolActivity(
  current: ExistingActivity | undefined,
  id: string,
  toolName: string,
  observation: ToolObservation
): ToolActivity {
  const summary = compact(observation.summary);
  const details = settleDetails(current, [
    detail('output', formatOutput(observation.output)),
    detail('observed-facts', formatObservedFacts(observation))
  ]);
  return {
    id,
    kind: 'activity',
    activity: 'tool',
    label: current?.label ?? humanize(toolName),
    status: observation.ok ? 'success' : 'failed',
    ...(summary.length === 0 ? {} : { summary }),
    ...(details.length === 0 ? {} : { details: details })
  };
}

export function formatApprovalInput(call: ToolCall): string {
  return formatToolInput(call);
}

function formatToolInput(call: ToolCall): string {
  const value = call.input.value;
  return `Input\n${formatValue(value)}`;
}

function formatEffects(effects: ToolEffects): string {
  const accesses = effects.accesses.map((access) => `${humanize(access.mode)} ${access.scope}`).join(', ');
  const locks = effects.lockScopes.length > 0 ? ` · locks ${effects.lockScopes.join(', ')}` : '';
  return `Effects\n${accesses || 'none'}${locks} · ${formatRecovery(effects.recovery)}`;
}

function formatRecovery(recovery: ToolEffects['recovery']): string {
  if (recovery.kind === 'unknown') return 'recovery unknown';
  if (recovery.kind === 'preconditioned_reexecution')
    return `re-executable with ${String(recovery.preconditions.length)} precondition${recovery.preconditions.length === 1 ? '' : 's'}`;
  if (recovery.kind === 'queryable')
    return recovery.expiresAt === null ? 'durable reconciliation' : `queryable until ${recovery.expiresAt}`;
  if (recovery.kind === 'idempotency_key') return `parameter-bound idempotency until ${recovery.expiresAt}`;
  return `journal-reconcilable ${recovery.transactionId}`;
}

function formatOutput(output: ToolObservation['output']): string | undefined {
  const formatted = formatValue(output);
  return formatted.length === 0 ? undefined : `Output\n${formatted}`;
}

function formatObservedFacts(observation: ToolObservation): string | undefined {
  const items = observation.observedFacts?.items ?? [];
  if (items.length === 0) return undefined;
  const lines = items.map((item) => {
    const resources = (item.resources ?? []).map((resource) => resource.uri).join(', ');
    return `- ${humanize(item.action)}${resources.length === 0 ? '' : `: ${resources}`}${item.summary === undefined ? '' : ` — ${compact(item.summary)}`}`;
  });
  return `Observed facts\n${lines.join('\n')}`;
}

function formatValue(value: ToolDisplayValue): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
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

function detail(id: string, content: string | undefined): ActivityDetail | undefined {
  return content === undefined || content.length === 0 ? undefined : { id, content };
}
function settleDetails(
  current: ExistingActivity | undefined,
  output: readonly (ActivityDetail | undefined)[]
): readonly ActivityDetail[] {
  return [
    ...(current?.details ?? []).filter((section) => section.id === 'input' || section.id === 'effects'),
    ...output.filter((section): section is ActivityDetail => section !== undefined)
  ];
}
