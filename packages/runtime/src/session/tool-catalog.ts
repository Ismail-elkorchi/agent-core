import { parseJsonObject } from '@agent-core/json';
import { captureToolCatalogSelection, parseToolCatalogSelection, type ToolCatalogSelectionStore, type ToolCatalogSelectionState } from '@agent-core/tools';
import type { SessionDescriptor, SessionRepository, SessionToolCatalogSelectionEntry } from './contracts.js';

/** Branch persistence reuses the session journal and its conditional-write boundary. */
export class SessionToolCatalogSelectionStore implements ToolCatalogSelectionStore {
  constructor(private readonly repository: SessionRepository, private readonly session: SessionDescriptor,
    private readonly withOwnership?: <T>(operation: () => Promise<T>) => Promise<T>) {}
  read(): Promise<ToolCatalogSelectionState> { return this.repository.currentToolCatalogSelection(this.session); }
  find(operationId: string): Promise<ToolCatalogSelectionState | undefined> {
    return this.repository.findToolCatalogSelection(this.session, operationId);
  }
  save(input: Parameters<ToolCatalogSelectionStore['save']>[0]): Promise<ToolCatalogSelectionState> {
    return this.repository.saveToolCatalogSelection(this.session, input, this.withOwnership ? { withOwnership: this.withOwnership } : {});
  }
}
export function toolCatalogSelectionOwner(sessionId: string, branchId: string): string {
  return `session/${encodeURIComponent(sessionId)}/branch/${encodeURIComponent(branchId)}`;
}
export function emptySessionToolCatalogSelection(sessionId: string, branchId = sessionId): ToolCatalogSelectionState {
  return Object.freeze({ ownerId: toolCatalogSelectionOwner(sessionId, branchId), selection: captureToolCatalogSelection([]) });
}
export function decodeSessionToolCatalogSelection(value: unknown): SessionToolCatalogSelectionEntry {
  const record = parseJsonObject(value, { maxDepth: 12, maxCollectionEntries: 5000, maxStringBytes: 16_384, maxTotalBytes: 2 * 1024 * 1024 });
  const keys = ['type', 'id', 'parentId', 'timestamp', 'branchId', 'operationId', 'selection'];
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !(key in record)) ||
      record.type !== 'tool_catalog_selection' || typeof record.id !== 'string' || !record.id ||
      (record.parentId !== null && typeof record.parentId !== 'string') || typeof record.timestamp !== 'string' ||
      typeof record.branchId !== 'string' || !record.branchId || typeof record.operationId !== 'string' || !record.operationId)
    throw new TypeError('Invalid session tool catalog selection.');
  return Object.freeze({ type: 'tool_catalog_selection', id: record.id, parentId: record.parentId,
    timestamp: record.timestamp, branchId: record.branchId, operationId: record.operationId,
    selection: parseToolCatalogSelection(record.selection) });
}
