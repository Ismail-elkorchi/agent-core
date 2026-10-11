import type { JsonObject, JsonValue } from '@agent-core/json';
import type { ToolCall } from '@agent-core/tools';

function localToolCallLabel(call: ToolCall): string {
  const value = call.input.kind === 'json' ? call.input.value : undefined;
  switch (call.name) {
    case 'exec_command':
      return `Run ${quoted(firstString(value, ['command']) ?? 'command')}`;
    case 'write_stdin':
      return `Continue ${compactTarget(value, ['processId'])}`;
    case 'stop_process':
      return `Stop ${compactTarget(value, ['processId'])}`;
    case 'edit_text':
      return `Edit ${readTargets(value)}`;
    case 'apply_patch':
      return 'Apply workspace patch';
    case 'read_files':
      return `Read ${readTargets(value)}`;
    case 'search_text':
      return `Search for ${quoted(firstString(value, ['query']) ?? 'text')}`;
    case 'list_directory':
      return `List ${compactTarget(value, ['path'])}`;
    case 'find_files':
      return `Find ${compactTarget(value, ['patterns'])}`;
    case 'view_image':
      return `View ${compactTarget(value, ['path'])}`;
    case 'read_artifact':
      return `Read ${compactTarget(value, ['artifactId'])}`;
    default:
      return humanize(call.name);
  }
}

function compactTarget(value: JsonObject | undefined, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
    if (Array.isArray(candidate)) {
      const paths = candidate.filter((item): item is string => typeof item === 'string');
      if (paths.length > 0)
        return paths.length === 1 ? (paths[0] ?? 'workspace') : `${String(paths.length)} paths`;
    }
  }
  return 'workspace';
}

function firstString(value: JsonObject | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return compact(candidate);
  }
  return undefined;
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

function readTargets(value: JsonObject | undefined): string {
  const files = value?.files;
  if (!Array.isArray(files)) return 'files';
  const paths = files.flatMap((file: JsonValue) => {
    if (!isObject(file) || typeof file.path !== 'string') return [];
    return [file.path + (typeof file.startLine === 'number' ? `:${String(file.startLine)}` : '')];
  });
  return bounded(paths.join(', ') || 'files', 180);
}

/** Tool arguments may still be invalid while a received call is displayed. This is presentation, not admission. */
export function localToolCallPresentation(call: ToolCall): {
  readonly label: string;
  readonly details?: readonly {
    readonly id: string;
    readonly content: string;
    readonly format?: 'diff';
  }[];
} {
  const label = localToolCallLabel(call);
  const value = call.input.kind === 'json' ? call.input.value : undefined;
  const patch = call.input.kind === 'text' ? call.input.value : value?.patch;
  if (call.name === 'apply_patch' && typeof patch === 'string')
    return { label, details: [{ id: 'input', content: patch, format: 'diff' }] };
  if (call.name === 'exec_command' && typeof value?.command === 'string')
    return { label, details: [{ id: 'input', content: value.command }] };
  if (call.name === 'read_files' && Array.isArray(value?.files))
    return {
      label,
      details: [
        {
          id: 'input',
          content: value.files
            .map((file: JsonValue) => {
              if (
                !isObject(file) ||
                typeof file.path !== 'string' ||
                (file.startLine !== undefined && typeof file.startLine !== 'number') ||
                (file.lineCount !== undefined && typeof file.lineCount !== 'number')
              )
                return JSON.stringify(file);
              return `${file.path} · from line ${String(file.startLine ?? 1)}${file.lineCount === undefined ? '' : ` · ${String(file.lineCount)} lines`}`;
            })
            .join('\n')
        }
      ]
    };
  return { label };
}

function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
