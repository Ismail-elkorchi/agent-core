import { hashJson } from '@agent-core/persistence';
import { parseJsonObject, type JsonValue } from '@agent-core/json';
import { toolDefinitionHash, type CompiledToolDefinition } from '@agent-core/tools';

const TOOL_CATALOG_FORMAT = 'agent-core.tool-catalog/2';

export interface ToolCatalogEntry {
  readonly name: string;
  readonly implementationId: string;
  readonly definitionHash: string;
}
export interface ToolCatalogSnapshot {
  readonly format: typeof TOOL_CATALOG_FORMAT;
  readonly revision: string;
  readonly entries: readonly ToolCatalogEntry[];
}
export function captureToolCatalog(tools: readonly CompiledToolDefinition[]): ToolCatalogSnapshot {
  const entries = Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        implementationId: tool.implementationId,
        definitionHash: toolDefinitionHash(tool)
      })
    )
  );
  return Object.freeze({
    format: TOOL_CATALOG_FORMAT,
    revision: hashJson({ format: TOOL_CATALOG_FORMAT, entries }),
    entries
  });
}
export function decodeToolCatalog(value: JsonValue | undefined): ToolCatalogSnapshot {
  const object = parseJsonObject(value);
  if (
    Object.keys(object).some((key) => !['format', 'revision', 'entries'].includes(key)) ||
    object.format !== TOOL_CATALOG_FORMAT ||
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
    hashJson({ format: TOOL_CATALOG_FORMAT, entries }) !== object.revision
  )
    throw new Error('Tool catalog revision mismatch.');
  return Object.freeze({ format: TOOL_CATALOG_FORMAT, revision: object.revision, entries });
}
export function assertToolCatalogCurrent(
  snapshot: ToolCatalogSnapshot,
  tools: readonly CompiledToolDefinition[]
): void {
  const current = captureToolCatalog(tools);
  if (current.revision !== snapshot.revision)
    throw new Error('Advertised tool definitions changed; a new request catalog is required.');
}
