import { hashJson } from '@agent-core/persistence';
import { parseJsonObject, type JsonValue } from '@agent-core/json';
import type { CompiledToolDefinition } from '@agent-core/tools';

export interface ToolCatalogEntry {
  readonly name: string;
  readonly implementationId: string;
  readonly definitionHash: string;
}
export interface ToolCatalogSnapshot {
  readonly revision: string;
  readonly entries: readonly ToolCatalogEntry[];
}
export function captureToolCatalog(tools: readonly CompiledToolDefinition[]): ToolCatalogSnapshot {
  const entries = Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        implementationId: tool.implementationId,
        definitionHash: hashJson({
          name: tool.name,
          implementationId: tool.implementationId,
          description: tool.description,
          jsonSchema: tool.jsonSchema,
          effectEnvelope: tool.effectEnvelope,
          ...(tool.textInput
            ? {
                textInput: {
                  description: tool.textInput.description ?? '',
                  format: tool.textInput.format
                }
              }
            : {})
        })
      })
    )
  );
  return Object.freeze({
    revision: hashJson(entries),
    entries
  });
}
export function decodeToolCatalog(value: JsonValue | undefined): ToolCatalogSnapshot {
  const object = parseJsonObject(value);
  if (
    Object.keys(object).some((key) => key !== 'revision' && key !== 'entries') ||
    typeof object.revision !== 'string' ||
    !Array.isArray(object.entries)
  )
    throw new Error('Invalid tool catalog snapshot.');
  const entries = Object.freeze(
    object.entries.map((value) => {
      const item = parseJsonObject(value);
      if (
        Object.keys(item).some((key) => !['name', 'implementationId', 'definitionHash'].includes(key)) ||
        typeof item.name !== 'string' ||
        typeof item.implementationId !== 'string' ||
        typeof item.definitionHash !== 'string'
      )
        throw new Error('Invalid catalog entry.');
      return Object.freeze({
        name: item.name,
        implementationId: item.implementationId,
        definitionHash: item.definitionHash
      });
    })
  );
  if (
    new Set(entries.map((entry) => entry.name)).size !== entries.length ||
    hashJson(entries) !== object.revision
  )
    throw new Error('Tool catalog revision mismatch.');
  return Object.freeze({ revision: object.revision, entries });
}
export function assertToolCatalogCurrent(
  snapshot: ToolCatalogSnapshot,
  tools: readonly CompiledToolDefinition[]
): void {
  const current = captureToolCatalog(tools);
  if (current.revision !== snapshot.revision)
    throw new Error('Advertised tool definitions changed; a new request catalog is required.');
}
