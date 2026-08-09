import { parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/evidence';
import type { ToolDefinition } from '@agent-core/tools';

type ToolObservationPresenter = NonNullable<ToolDefinition['presentObservation']>;

function presenter(title: string, primaryKeys: readonly string[]): ToolObservationPresenter {
  return ({ observation }) => {
    const scope = parseJsonValue(observation.scope) as JsonObject;
    const base = {
      ok: observation.ok,
      title,
      summary: observation.summary,
      scope,
      coverage: observation.scope.coverage,
      ...(observation.scope.omitted ? { omitted: observation.scope.omitted } : {}),
      ...(observation.scope.causes?.length ? { warnings: [...observation.scope.causes] } : {})
    };
    if (observation.kind === 'failure') {
      return {
        ...base,
        failures: parseJsonValue(observation.output),
        ...(observation.output.recovery ? { next: observation.output.recovery } : {})
      };
    }
    const output = parseJsonValue(observation.output);
    const results = orderedResult(output, primaryKeys, observation.content === undefined ? undefined : parseJsonValue(observation.content));
    return {
      ...base,
      results,
      ...(observation.scope.coverage === 'partial' ? { next: continuationFor(primaryKeys[0] ?? 'results', output) } : {})
    };
  };
}

function orderedResult(output: JsonValue, primaryKeys: readonly string[], content: JsonValue | undefined): JsonValue {
  if (!isJsonObject(output)) return content === undefined ? { output } : { output, content };
  const result: Record<string, JsonValue> = {};
  for (const key of primaryKeys) {
    const value = output[key];
    if (Object.hasOwn(output, key) && value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(output)) if (!Object.hasOwn(result, key)) result[key] = value;
  if (content !== undefined) result.content = content;
  return parseJsonValue(result);
}

function continuationFor(primary: string, output: JsonValue): string {
  if (isJsonObject(output)) {
    const cursor = output.nextCursor ?? output.nextOffset ?? output.nextStartLine;
    if (typeof cursor === 'number' || typeof cursor === 'string') return `Continue ${primary} from ${String(cursor)}.`;
  }
  return `Narrow the request or continue from the reported ${primary} boundary.`;
}

function isJsonObject(value: JsonValue): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export const presentListDirectoryObservation = presenter('Directory listing', ['entries']);
export const presentFindFilesObservation = presenter('File search', ['matches']);
export const presentReadFilesObservation = presenter('File contents', ['files']);
export const presentSearchTextObservation = presenter('Text search', ['matches', 'files']);
export const presentApplyPatchObservation = presenter('Patch transaction', ['changes']);
export const presentProcessObservation = presenter('Process', ['status', 'stdout', 'stderr', 'combined', 'processId']);
export const presentReadArtifactObservation = presenter('Artifact range', ['text', 'offset', 'end', 'size', 'mediaType']);
