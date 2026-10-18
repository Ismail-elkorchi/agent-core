import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import type { CompiledToolDefinition } from './core/compiled.js';
import { toolDefinitionHash } from './core/contract.js';
import { abortableToolBoundary } from './core/context.js';
import { ToolRegistry } from './core/registry.js';

/** Exact source and authority binding. Neither discovery nor loading grants invocation authority. */
export interface ToolReference {
  readonly sourceId: string;
  readonly toolId: string;
  readonly revision: string;
  readonly bindingRevision: string;
}
export interface ToolCatalogDescriptor {
  readonly reference: ToolReference;
  readonly name: string;
  readonly description: string;
  readonly implementationId: string;
}
export interface ToolSourceSnapshot {
  readonly sourceId: string;
  readonly bindingRevision: string;
  readonly revision: string;
  readonly tools: readonly ToolCatalogDescriptor[];
}
export interface ToolCatalogSource {
  readonly id: string;
  snapshot(signal?: AbortSignal): Promise<ToolSourceSnapshot>;
  load(reference: ToolReference, signal?: AbortSignal): Promise<CompiledToolDefinition>;
}
export interface ToolCatalogSelection {
  readonly revision: string;
  readonly references: readonly ToolReference[];
}
export interface ToolCatalogSelectionState {
  /** Host-owned session/branch identity, independent of a transport connection. */
  readonly ownerId: string;
  readonly selection: ToolCatalogSelection;
}
export interface ToolCatalogSelectionStore {
  read(): Promise<ToolCatalogSelectionState>;
  find(operationId: string): Promise<ToolCatalogSelectionState | undefined>;
  save(input: {
    readonly ownerId: string;
    readonly expectedRevision: string;
    readonly selection: ToolCatalogSelection;
    readonly operationId: string;
  }): Promise<ToolCatalogSelectionState>;
}
export interface ToolDiscoveryRequest {
  readonly target?: 'inventory' | 'selection' | undefined;
  readonly query?: string | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly expectedRevision?: string | undefined;
}
export interface ToolDiscoveryItem {
  readonly reference: ToolReference;
  readonly name?: string;
  readonly description?: string;
  readonly implementationId?: string;
  readonly loaded: boolean;
  readonly unavailableReason?: 'source_unavailable' | 'definition_changed' | 'load_failed';
}
export interface ToolDiscoveryPage {
  readonly target: 'inventory' | 'selection';
  readonly revision: string;
  readonly selectionRevision: string;
  readonly totalCount: number;
  readonly offset: number;
  readonly items: readonly ToolDiscoveryItem[];
  readonly unavailableSources: readonly string[];
  readonly unavailableSelectedCount: number;
  readonly coverage: 'complete' | 'partial';
  readonly nextOffset?: number;
}

const MAX_TOOLS = 10_000;
const MAX_SOURCES = 128;
export const TOOL_CATALOG_LIMITS = Object.freeze({ selectionReferences: 256, discoveryItems: 128,
  discoveryBytes: 256 * 1024, sourceConcurrency: 4 });
const SOURCE_LIMITS = { maxDepth: 10, maxCollectionEntries: 100_000,
  maxStringBytes: 16_384, maxTotalBytes: 8 * 1024 * 1024 };
const emptySelection = (): ToolCatalogSelection => captureToolCatalogSelection([]);

export function parseToolReference(value: unknown): ToolReference {
  const record = parseJsonObject(value);
  exact(record, ['sourceId', 'toolId', 'revision', 'bindingRevision']);
  return Object.freeze({ sourceId: identifier(record.sourceId, 'sourceId'),
    toolId: identifier(record.toolId, 'toolId'), revision: identifier(record.revision, 'revision'),
    bindingRevision: identifier(record.bindingRevision, 'bindingRevision') });
}
export function describeCatalogTool(input: {
  readonly sourceId: string; readonly toolId: string; readonly bindingRevision: string;
  readonly tool: CompiledToolDefinition;
}): ToolCatalogDescriptor {
  return descriptor({ reference: { sourceId: input.sourceId, toolId: input.toolId,
    bindingRevision: input.bindingRevision, revision: toolDefinitionHash(input.tool) },
    name: input.tool.name, description: input.tool.description, implementationId: input.tool.implementationId });
}
export function captureToolSourceSnapshot(input: {
  readonly sourceId: string; readonly bindingRevision: string; readonly tools: readonly ToolCatalogDescriptor[];
}): ToolSourceSnapshot {
  const sourceId = identifier(input.sourceId, 'sourceId');
  const bindingRevision = identifier(input.bindingRevision, 'bindingRevision');
  if (!Array.isArray(input.tools) || input.tools.length > MAX_TOOLS)
    throw new RangeError('Tool source inventory exceeds its descriptor bound.');
  const tools = input.tools.map(descriptor).sort((a, b) => compare(a.reference.toolId, b.reference.toolId));
  if (tools.some(tool => tool.reference.sourceId !== sourceId || tool.reference.bindingRevision !== bindingRevision))
    throw new Error('Tool descriptor belongs to a different source binding.');
  if (new Set(tools.map(tool => tool.reference.toolId)).size !== tools.length ||
      new Set(tools.map(tool => tool.name)).size !== tools.length)
    throw new Error('Tool source contains duplicate tool identities or names.');
  const material = parseJsonObject({ sourceId, bindingRevision, tools }, SOURCE_LIMITS);
  return Object.freeze({ sourceId, bindingRevision, tools: Object.freeze(tools), revision: hashJson(material) });
}
export function parseToolSourceSnapshot(value: unknown): ToolSourceSnapshot {
  const record = parseJsonObject(value, SOURCE_LIMITS);
  exact(record, ['sourceId', 'bindingRevision', 'revision', 'tools']);
  if (!Array.isArray(record.tools)) throw new TypeError('Tool source requires descriptors.');
  const snapshot = captureToolSourceSnapshot({ sourceId: identifier(record.sourceId, 'sourceId'),
    bindingRevision: identifier(record.bindingRevision, 'bindingRevision'), tools: record.tools.map(descriptor) });
  if (snapshot.revision !== record.revision) throw new Error('Tool source snapshot revision mismatch.');
  return snapshot;
}
export function captureToolCatalogSelection(references: readonly ToolReference[]): ToolCatalogSelection {
  if (!Array.isArray(references) || references.length > TOOL_CATALOG_LIMITS.selectionReferences)
    throw new RangeError('Loaded tool selection exceeds its bound.');
  const owned = Object.freeze(references.map(parseToolReference).sort((a, b) => compare(referenceKey(a), referenceKey(b))));
  if (new Set(owned.map(referenceKey)).size !== owned.length)
    throw new Error('Loaded tool selection contains duplicate source identities.');
  return Object.freeze({ references: owned, revision: hashJson(owned) });
}
export function parseToolCatalogSelection(value: unknown): ToolCatalogSelection {
  const record = parseJsonObject(value, SOURCE_LIMITS);
  exact(record, ['revision', 'references']);
  if (!Array.isArray(record.references)) throw new TypeError('Loaded tool selection requires references.');
  const selection = captureToolCatalogSelection(record.references.map(parseToolReference));
  if (selection.revision !== record.revision) throw new Error('Loaded tool selection revision mismatch.');
  return selection;
}

/** In-memory selection is explicit and replaceable by the session-owned journal capability. */
export class InMemoryToolCatalogSelectionStore implements ToolCatalogSelectionStore {
  private selection = emptySelection();
  private readonly operations = new Map<string, ToolCatalogSelectionState>();
  constructor(private readonly ownerId: string) { identifier(ownerId, 'ownerId'); }
  read(): Promise<ToolCatalogSelectionState> { return Promise.resolve(this.state()); }
  find(operationId: string): Promise<ToolCatalogSelectionState | undefined> { return Promise.resolve(this.operations.get(operationId)); }
  save(input: Parameters<ToolCatalogSelectionStore['save']>[0]): Promise<ToolCatalogSelectionState> {
    return Promise.resolve().then(() => {
      const selection = parseToolCatalogSelection(input.selection);
      const operationId = identifier(input.operationId, 'operationId');
      if (input.ownerId !== this.ownerId) throw new PersistenceConflictError('Tool selection owner changed.');
      const previous = this.operations.get(operationId);
      if (previous !== undefined) {
        if (previous.selection.revision !== selection.revision) throw new PersistenceConflictError('Tool selection operation changed.');
        return previous;
      }
      if (input.expectedRevision !== this.selection.revision)
        throw new PersistenceConflictError('Loaded tool selection changed.');
      this.selection = selection;
      this.operations.set(operationId, this.state());
      return this.state();
    });
  }
  private state(): ToolCatalogSelectionState { return Object.freeze({ ownerId: this.ownerId, selection: this.selection }); }
}

/** One source-independent owner of discovered definitions and exact loaded references. */
export class ToolCatalog {
  private readonly eager: readonly CompiledToolDefinition[];
  private readonly sources: readonly ToolCatalogSource[];
  private readonly reservedNames = new Set<string>();
  private store: ToolCatalogSelectionStore;
  private state: ToolCatalogSelectionState;
  private snapshots = new Map<string, ToolSourceSnapshot>();
  private unavailableSources: readonly string[] = Object.freeze([]);
  private unavailableTools: readonly { readonly reference: ToolReference; readonly reason: NonNullable<ToolDiscoveryItem['unavailableReason']> }[] = Object.freeze([]);
  private loaded = new Map<string, CompiledToolDefinition>();
  private tools: readonly CompiledToolDefinition[];
  private queue: Promise<void> = Promise.resolve();
  private inventoryRevision = hashJson([]);

  constructor(options: { readonly tools?: readonly CompiledToolDefinition[];
    readonly sources?: readonly ToolCatalogSource[]; readonly selectionStore?: ToolCatalogSelectionStore } = {}) {
    this.eager = Object.freeze(new ToolRegistry(options.tools ?? []).list());
    this.sources = Object.freeze([...(options.sources ?? [])]);
    if (this.sources.length > MAX_SOURCES || new Set(this.sources.map(source => identifier(source.id, 'sourceId'))).size !== this.sources.length)
      throw new Error('Tool catalog sources must have unique bounded identities.');
    this.store = options.selectionStore ?? new InMemoryToolCatalogSelectionStore('runtime');
    this.state = Object.freeze({ ownerId: 'runtime', selection: emptySelection() });
    this.tools = this.eager;
  }

  /** Runtime session composition binds this before its first refresh. */
  bindSelectionStore(store: ToolCatalogSelectionStore): void { this.store = store; }
  /** Host composition reserves control names before a selected source can publish a collision. */
  reserveNames(names: readonly string[]): void {
    const owned = names.map(name => identifier(name, 'reservedName'));
    if (this.tools.some(tool => owned.includes(tool.name)))
      throw new Error('Tool catalog conflicts with a host-reserved control name.');
    for (const name of owned) this.reservedNames.add(name);
  }
  current(): readonly CompiledToolDefinition[] { return this.tools; }
  hasSelectionControls(): boolean { return this.sources.length > 0 || this.state.selection.references.length > 0; }
  selection(): ToolCatalogSelectionState { return this.state; }

  refresh(signal?: AbortSignal): Promise<readonly CompiledToolDefinition[]> {
    return this.serial(async () => { await this.refreshOwned(signal); return this.tools; });
  }

  async discover(request: ToolDiscoveryRequest = {}, signal?: AbortSignal): Promise<ToolDiscoveryPage> {
    return this.serial(async () => {
      const target = request.target ?? 'inventory';
      if (!['inventory', 'selection'].includes(target)) throw new TypeError('Invalid tool discovery target.');
      await this.refreshOwned(signal, target === 'inventory');
      const query = request.query ?? '';
      if (typeof query !== 'string' || query.length > 4096) throw new RangeError('Tool discovery query exceeds its bound.');
      const revision = target === 'inventory' ? this.inventoryRevision : this.state.selection.revision;
      if (request.expectedRevision !== undefined && request.expectedRevision !== revision)
        throw new PersistenceConflictError('Tool discovery revision changed; restart discovery.');
      const inventory = [...this.snapshots.values()].flatMap(snapshot => snapshot.tools);
      const candidates: readonly ToolDiscoveryItem[] = target === 'inventory' ? inventory.map(entry => ({ ...entry,
        loaded: this.loaded.has(exactReferenceKey(entry.reference)) })) : this.state.selection.references.map(reference => {
          const entry = inventory.find(item => exactReferenceKey(item.reference) === exactReferenceKey(reference));
          const unavailable = this.unavailableTools.find(item => exactReferenceKey(item.reference) === exactReferenceKey(reference));
          return { ...(entry ?? { reference }), loaded: this.loaded.has(exactReferenceKey(reference)),
            ...(unavailable ? { unavailableReason: unavailable.reason } : {}) };
        });
      const descriptors = candidates.filter(tool => `${tool.name ?? ''}\n${tool.description ?? ''}\n${tool.reference.sourceId}\n${tool.reference.toolId}`.includes(query))
        .sort((a, b) => compare(referenceKey(a.reference), referenceKey(b.reference)));
      const offset = request.offset ?? 0;
      const limit = request.limit ?? 32;
      const maxBytes = request.maxBytes ?? 32_768;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > descriptors.length ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > TOOL_CATALOG_LIMITS.discoveryItems ||
          !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > TOOL_CATALOG_LIMITS.discoveryBytes)
        throw new RangeError('Invalid tool discovery bounds.');
      const items: ToolDiscoveryItem[] = [];
      const page = (): ToolDiscoveryPage => Object.freeze({ target, revision,
        selectionRevision: this.state.selection.revision, totalCount: descriptors.length, offset,
        items: Object.freeze([...items]), unavailableSources: this.unavailableSources, unavailableSelectedCount: this.unavailableTools.length,
        coverage: offset === 0 && items.length === descriptors.length && this.unavailableSources.length === 0 && this.unavailableTools.length === 0 ? 'complete' : 'partial',
        ...(offset + items.length < descriptors.length ? { nextOffset: offset + items.length } : {}) });
      for (const entry of descriptors.slice(offset, offset + limit)) {
        items.push(Object.freeze(entry));
        if (jsonBytes(page()) > maxBytes) { items.pop(); break; }
      }
      if (offset < descriptors.length && items.length === 0)
        throw new RangeError('A tool descriptor does not fit the requested discovery byte bound.');
      const result = page();
      if (jsonBytes(result) > maxBytes) throw new RangeError('Tool discovery bookkeeping exceeds its byte bound.');
      return result;
    });
  }

  select(references: readonly ToolReference[], options: {
    readonly expectedOwnerId: string; readonly expectedSelectionRevision: string;
    readonly operationId: string; readonly signal?: AbortSignal;
  }): Promise<ToolCatalogSelectionState> {
    return this.serial(async () => {
      if (!Array.isArray(references) || references.length > TOOL_CATALOG_LIMITS.selectionReferences)
        throw new RangeError(`Select at most ${String(TOOL_CATALOG_LIMITS.selectionReferences)} exact tool references.`);
      const selection = captureToolCatalogSelection(references);
      const requested = selection.references;
      await this.refreshOwned(options.signal, false, requested);
      if (options.expectedOwnerId !== this.state.ownerId)
        throw new PersistenceConflictError('Tool selection owner changed before loading.');
      const operationId = identifier(options.operationId, 'operationId');
      const previous = await this.store.find(operationId);
      if (previous) {
        const recorded = ownSelectionState(previous);
        if (recorded.ownerId !== this.state.ownerId || recorded.selection.revision !== selection.revision)
          throw new PersistenceConflictError('Tool selection operation changed.');
        return recorded;
      }
      if (options.expectedSelectionRevision !== this.state.selection.revision)
        throw new PersistenceConflictError('Loaded tool selection changed before loading.');
      const loaded = new Map<string, CompiledToolDefinition>();
      for (const reference of requested) {
        const tool = this.loaded.get(exactReferenceKey(reference)) ?? await this.resolve(reference, this.snapshots, options.signal);
        loaded.set(exactReferenceKey(reference), tool);
      }
      // Name collisions are rejected before selection publication, not during a later model request.
      const nextTools = this.selectedTools(selection, loaded);
      options.signal?.throwIfAborted();
      const state = ownSelectionState(await this.store.save({ ownerId: this.state.ownerId,
        expectedRevision: this.state.selection.revision, selection, operationId }));
      if (state.ownerId !== this.state.ownerId || state.selection.revision !== selection.revision)
        throw new PersistenceConflictError('Tool selection publication returned a different owner or selection.');
      this.state = state;
      this.loaded = loaded;
      this.tools = nextTools;
      this.unavailableTools = Object.freeze([]);
      return state;
    });
  }

  private async refreshOwned(signal?: AbortSignal, discoverAll = false, requested: readonly ToolReference[] = []): Promise<void> {
    signal?.throwIfAborted();
    const state = ownSelectionState(await this.store.read());
    signal?.throwIfAborted();
    const requiredSources = new Set([...state.selection.references, ...requested].map(reference => reference.sourceId));
    const snapshots = new Map<string, ToolSourceSnapshot>();
    const unavailable: string[] = [];
    const sources = this.sources.filter(source => discoverAll || requiredSources.has(source.id));
    let nextSource = 0;
    await Promise.all(Array.from({ length: Math.min(sources.length, TOOL_CATALOG_LIMITS.sourceConcurrency) }, async () => {
      for (;;) {
        signal?.throwIfAborted();
        const source = sources[nextSource++];
        if (!source) return;
        try {
          const snapshot = parseToolSourceSnapshot(await (signal ? abortableToolBoundary(signal, () => source.snapshot(signal)) : source.snapshot()));
          if (snapshot.sourceId !== source.id) throw new Error('Catalog source changed identity.');
          snapshots.set(source.id, snapshot);
        } catch {
          signal?.throwIfAborted();
          unavailable.push(source.id);
        }
      }
    }));
    const loaded = new Map<string, CompiledToolDefinition>();
    const unavailableTools: { reference: ToolReference; reason: 'source_unavailable' | 'definition_changed' | 'load_failed' }[] = [];
    for (const reference of state.selection.references) {
      const key = exactReferenceKey(reference);
      try {
        const entry = this.requireDescriptor(reference, snapshots);
        const cached = this.state.ownerId === state.ownerId ? this.loaded.get(key) : undefined;
        const tool = cached ?? await this.resolve(reference, snapshots, signal);
        assertDefinition(entry, tool);
        loaded.set(key, tool);
      } catch {
        signal?.throwIfAborted();
        const source = snapshots.get(reference.sourceId);
        const exact = source?.tools.some(tool => exactReferenceKey(tool.reference) === key);
        unavailableTools.push(Object.freeze({ reference, reason: !source ? 'source_unavailable' : exact ? 'load_failed' : 'definition_changed' }));
      }
    }
    const tools = this.selectedTools(state.selection, loaded);
    signal?.throwIfAborted();
    this.snapshots = snapshots;
    this.unavailableSources = Object.freeze(unavailable.sort(compare));
    this.inventoryRevision = hashJson({ sources: [...snapshots.values()].map(snapshot => ({ sourceId: snapshot.sourceId, revision: snapshot.revision })).sort((a, b) => compare(a.sourceId, b.sourceId)), unavailableSources: this.unavailableSources });
    this.state = state;
    this.loaded = loaded;
    this.unavailableTools = Object.freeze(unavailableTools);
    this.tools = tools;
  }
  private selectedTools(selection: ToolCatalogSelection, loaded: ReadonlyMap<string, CompiledToolDefinition>): readonly CompiledToolDefinition[] {
    return Object.freeze(new ToolRegistry([...this.eager, ...selection.references.flatMap(reference => {
      const tool = loaded.get(exactReferenceKey(reference));
      if (tool && this.reservedNames.has(tool.name)) throw new Error('Tool catalog conflicts with a host-reserved control name.');
      return tool ? [tool] : [];
    })]).list());
  }
  private requireDescriptor(reference: ToolReference, snapshots: ReadonlyMap<string, ToolSourceSnapshot>): ToolCatalogDescriptor {
    const source = snapshots.get(reference.sourceId);
    const entry = source?.tools.find(tool => tool.reference.toolId === reference.toolId);
    if (!entry || exactReferenceKey(entry.reference) !== exactReferenceKey(reference))
      throw new PersistenceConflictError('Exact tool reference is no longer available; discover its current definition.');
    return entry;
  }
  private async resolve(reference: ToolReference, snapshots: ReadonlyMap<string, ToolSourceSnapshot>, signal?: AbortSignal): Promise<CompiledToolDefinition> {
    const entry = this.requireDescriptor(reference, snapshots);
    const source = this.sources.find(source => source.id === reference.sourceId);
    if (!source) throw new Error('Tool source is unavailable.');
    const tool = await (signal ? abortableToolBoundary(signal, () => source.load(reference, signal)) : source.load(reference));
    signal?.throwIfAborted();
    new ToolRegistry([tool]);
    assertDefinition(entry, tool);
    return tool;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const completion = this.queue.then(operation);
    this.queue = completion.then(() => undefined, () => undefined);
    return completion;
  }
}

function ownSelectionState(value: ToolCatalogSelectionState): ToolCatalogSelectionState {
  return Object.freeze({ ownerId: identifier(value.ownerId, 'ownerId'), selection: parseToolCatalogSelection(value.selection) });
}
function descriptor(value: unknown): ToolCatalogDescriptor {
  const record = parseJsonObject(value, SOURCE_LIMITS);
  exact(record, ['reference', 'name', 'description', 'implementationId']);
  if (typeof record.description !== 'string' || record.description.length > 16_384)
    throw new TypeError('Tool descriptor requires a bounded description.');
  return Object.freeze({ reference: parseToolReference(record.reference), name: identifier(record.name, 'name'),
    description: record.description, implementationId: identifier(record.implementationId, 'implementationId') });
}
function assertDefinition(entry: ToolCatalogDescriptor, tool: CompiledToolDefinition): void {
  if (toolDefinitionHash(tool) !== entry.reference.revision || tool.name !== entry.name ||
      tool.implementationId !== entry.implementationId || tool.description !== entry.description)
    throw new PersistenceConflictError('Loaded tool differs from its discovered definition.');
}
function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 ||
      new TextEncoder().encode(value).byteLength > 1024 || value.trim() !== value)
    throw new TypeError(`Invalid tool catalog ${field}.`);
  return value;
}
function exact(record: JsonObject, keys: readonly string[]): void {
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !(key in record)))
    throw new TypeError('Tool catalog record has incompatible fields.');
}
function referenceKey(reference: ToolReference): string { return JSON.stringify([reference.sourceId, reference.toolId]); }
function exactReferenceKey(reference: ToolReference): string { return JSON.stringify([reference.sourceId, reference.toolId, reference.revision, reference.bindingRevision]); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function jsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
