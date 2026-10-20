import { parseJsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { SKILL_LIMITS, SkillPackageError, parseSkillReference, skillDiscoveryRequestSchema, skillSelectionBudgetSchema, skillSelectionReferencesSchema, skillScopeDiscoveryRequestSchema, skillIdentifier, skillResourceReadRequestSchema, skillResourceRangeSchema, skillResourcePath,
  type SkillDiscoveryPage, type SkillDiscoveryRequest, type SkillPackage, type SkillPackageSource,
  type SkillReference, type SkillResourceRead, type SkillScopeDescriptor, type SkillScopeDiscoveryRequest, type SkillScopeDiscoveryPage } from './contracts.js';
import { parseSkillPackage, captureSkillResourceRead } from './package.js';
import { byteLength, referenceKey } from './source.js';

/** Bounded read adapter only. Saving/activating exact references belongs to Core's existing context view. */
export class SkillCatalog {
  private readonly sources = new Map<string, SkillPackageSource>();
  constructor(options: { readonly sources: readonly SkillPackageSource[] }) {
    if (options.sources.length > SKILL_LIMITS.sources) throw new SkillPackageError('resource_limit', 'Skill catalog source count exceeds its bound.');
    for (const source of options.sources) {
      if (this.sources.has(source.scopeId)) throw new SkillPackageError('invalid_package', 'Skill catalog has duplicate scope identities.');
      this.sources.set(source.scopeId, source);
    }
  }
  /** Cold discovery of granted source identities. Never asks a source for package inventory or bodies. */
  async discoverScopes(input: SkillScopeDiscoveryRequest = {}, signal?: AbortSignal): Promise<SkillScopeDiscoveryPage> {
    const request = skillScopeDiscoveryRequestSchema.parse(input);
    const visible: SkillScopeDescriptor[] = [];
    const availability = { unavailable: false };
    // At most two metadata checks per configured source (64 sources maximum),
    // independent of output pagination. No package scan is started here.
    const inspect = async (scopeId: string, source: SkillPackageSource): Promise<SkillScopeDescriptor | undefined> => {
      try {
        const value = await abortable(() => source.describeScope(signal), signal);
        return value === undefined ? undefined : scopeDescriptor(value, scopeId);
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof SkillPackageError && error.code === 'access_denied')) availability.unavailable = true;
        return undefined;
      }
    };
    for (const [scopeId, source] of this.sources) {
      const descriptor = await inspect(scopeId, source);
      if (descriptor !== undefined) visible.push(descriptor);
    }
    // Recheck readable sources after asynchronous discovery, without exposing
    // denied source positions, scan counts, diagnostics, or catalog hashes.
    const current: SkillScopeDescriptor[] = [];
    for (const descriptor of visible) {
      const value = await inspect(descriptor.scopeId, this.source(descriptor.scopeId));
      if (value !== undefined) current.push(value);
    }
    current.sort((a, b) => a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0);
    const revision = hashJson({ scopes: current, unavailable: availability.unavailable });
    if (request.expectedRevision !== undefined && request.expectedRevision !== revision)
      throw new SkillPackageError('revision_unavailable', 'Authorized skill scope inventory changed. Discover scopes again.');
    const maxBytes = request.maxBytes ?? SKILL_LIMITS.discoveryBytes;
    const limit = request.limit ?? 16;
    let offset = request.offset ?? 0;
    if (offset > current.length) throw new SkillPackageError('invalid_range', 'Invalid authorized skill scope offset.');
    const items: SkillScopeDescriptor[] = [];
    let bytes = byteLength({ revision, items, coverage: 'complete', nextOffset: SKILL_LIMITS.sources });
    if (bytes > maxBytes) throw new SkillPackageError('resource_limit', 'Scope discovery byte limit is too small for page bookkeeping.');
    while (offset < current.length && items.length < limit) {
      const descriptor = current[offset];
      if (!descriptor) break;
      const size = byteLength(descriptor) + 1;
      if (bytes + size > maxBytes) {
        if (items.length === 0) throw new SkillPackageError('resource_limit', 'Scope discovery byte limit is too small for one descriptor.');
        break;
      }
      items.push(descriptor); bytes += size; offset++;
    }
    signal?.throwIfAborted();
    return Object.freeze({ revision, items: Object.freeze(items), coverage: offset < current.length || availability.unavailable ? 'partial' : 'complete',
      ...(offset < current.length ? { nextOffset: offset } : {}) });
  }
  discover(input: SkillDiscoveryRequest, signal?: AbortSignal): Promise<SkillDiscoveryPage> {
    const request = skillDiscoveryRequestSchema.parse(input);
    return abortable(async () => discoveryPage(await this.source(request.scopeId).discover(request, signal), request), signal);
  }
  load(input: SkillReference, signal?: AbortSignal): Promise<SkillPackage> {
    const reference = parseSkillReference(input);
    return abortable(async () => parseSkillPackage(await this.source(reference.scopeId).load(reference, signal), reference), signal);
  }
  async loadSelection(inputs: readonly SkillReference[], options: { readonly maxBytes?: number; readonly signal?: AbortSignal } = {}): Promise<readonly SkillPackage[]> {
    const references = selection(inputs);
    const maxBytes = skillSelectionBudgetSchema.parse(options.maxBytes ?? SKILL_LIMITS.selectionBytes);
    const loaded: SkillPackage[] = [];
    let bytes = 2;
    if (bytes > maxBytes) throw new SkillPackageError('resource_limit', 'Selected skill instructions and manifests exceed the context byte bound.');
    for (const reference of references) {
      const value = await this.load(reference, options.signal);
      bytes += byteLength(value) + (loaded.length > 0 ? 1 : 0);
      if (bytes > maxBytes) throw new SkillPackageError('resource_limit', 'Selected skill instructions and manifests exceed the context byte bound.');
      loaded.push(value);
    }
    await this.assertAvailable(references, options.signal);
    return Object.freeze(loaded);
  }
  async readResource(input: SkillReference, path: string, range: { readonly offset: number; readonly length: number }, signal?: AbortSignal): Promise<SkillResourceRead> {
    const reference = parseSkillReference(input);
    const resourcePath = skillResourcePath(path);
    const parsedRange = skillResourceRangeSchema.safeParse(range);
    if (!parsedRange.success) throw new SkillPackageError('invalid_range', 'Skill resource range is invalid or exceeds its byte bound.');
    const query = skillResourceReadRequestSchema.parse({ ref: reference, path: resourcePath, offset: parsedRange.data.offset, length: parsedRange.data.length });
    const requestedRange = Object.freeze({ offset: query.offset, length: query.length });
    return abortable(async () => {
      const source = this.source(reference.scopeId);
      const loaded = await this.load(reference, signal);
      const resource = loaded.manifest.resources.find(item => item.path === resourcePath);
      if (!resource) throw new SkillPackageError('revision_unavailable', 'Resource is absent from this exact skill revision.');
      if (query.offset > resource.size) throw new SkillPackageError('invalid_range', 'Skill resource offset exceeds its exact size.');
      const read = captureSkillResourceRead(await source.readResource(reference, resourcePath, requestedRange, signal),
        { reference, resource, ...requestedRange });
      await source.assertAvailable([reference], signal);
      return read;
    }, signal);
  }
  async assertAvailable(inputs: readonly SkillReference[], signal?: AbortSignal): Promise<void> {
    for (const [scope, references] of this.group(inputs))
      await abortable(() => this.source(scope).assertAvailable(references, signal), signal);
  }
  async withAvailable<T>(inputs: readonly SkillReference[], operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const groups = [...this.group(inputs)];
    const enter = async (index: number): Promise<T> => {
      signal?.throwIfAborted();
      const group = groups[index];
      if (!group) return operation();
      return this.source(group[0]).withAvailable(group[1], () => enter(index + 1), signal);
    };
    return abortable(() => enter(0), signal);
  }
  private group(inputs: readonly SkillReference[]): ReadonlyMap<string, readonly SkillReference[]> {
    const groups = new Map<string, SkillReference[]>();
    for (const reference of selection(inputs, false).sort((a, b) => a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0)) {
      const refs = groups.get(reference.scopeId) ?? [];
      refs.push(reference); groups.set(reference.scopeId, refs);
    }
    return groups;
  }
  private source(scopeId: string): SkillPackageSource {
    const source = this.sources.get(scopeId);
    if (!source) throw new SkillPackageError('access_denied', 'Skill scope is unavailable or not granted.');
    return source;
  }
}
function selection(inputs: readonly SkillReference[], uniquePackages = true): SkillReference[] {
  if (!Array.isArray(inputs) || inputs.length > (uniquePackages ? SKILL_LIMITS.selection : SKILL_LIMITS.dependencies))
    throw new SkillPackageError('resource_limit', 'Skill selection exceeds its reference bound.');
  const references = uniquePackages ? [...skillSelectionReferencesSchema.parse(inputs)].map(parseSkillReference) : inputs.map(parseSkillReference);
  if (!uniquePackages) return [...new Map(references.map(reference => [referenceKey(reference), reference])).values()];
  const identities = references.map(reference => JSON.stringify([reference.scopeId, reference.packageId]));
  if (new Set(identities).size !== identities.length)
    throw new SkillPackageError('invalid_package', 'A skill selection cannot contain duplicate package identities or revisions.');
  return references;
}
async function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Skill request aborted.')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function discoveryPage(input: unknown, request: SkillDiscoveryRequest): SkillDiscoveryPage {
  const data = parseJsonObject(input, { maxDepth: 6, maxTotalBytes: SKILL_LIMITS.discoveryBytes + 4096,
    maxStringBytes: 8192, maxCollectionEntries: 4096 });
  if (Object.keys(data).some(key => !['scopeId', 'revision', 'items', 'diagnostics', 'scanned', 'scannedBytes', 'coverage', 'nextOffset'].includes(key)) ||
    data.scopeId !== request.scopeId || typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(data.revision) ||
    !Array.isArray(data.items) || data.items.length > (request.limit ?? 16) || !Array.isArray(data.diagnostics) ||
    typeof data.scanned !== 'number' || !Number.isSafeInteger(data.scanned) || data.scanned < 0 || data.scanned > (request.maxScanned ?? 16) ||
    typeof data.scannedBytes !== 'number' || !Number.isSafeInteger(data.scannedBytes) || data.scannedBytes < 0 || data.scannedBytes > (request.maxScanBytes ?? SKILL_LIMITS.scanBytes) ||
    (data.coverage !== 'complete' && data.coverage !== 'partial') ||
    (data.nextOffset !== undefined && (typeof data.nextOffset !== 'number' || !Number.isSafeInteger(data.nextOffset) || data.nextOffset <= (request.offset ?? 0) || data.nextOffset > SKILL_LIMITS.packages)))
    throw new SkillPackageError('invalid_package', 'Skill source returned an invalid or oversized discovery page.');
  const items = Object.freeze(data.items.map(value => {
    const item = parseJsonObject(value);
    if (Object.keys(item).some(key => !['reference', 'name', 'description'].includes(key)) ||
      typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 64 ||
      typeof item.description !== 'string' || item.description.length < 1 || item.description.length > 1024)
      throw new SkillPackageError('invalid_package', 'Skill source returned invalid discovery metadata.');
    const reference = parseSkillReference(item.reference);
    if (reference.scopeId !== request.scopeId) throw new SkillPackageError('access_denied', 'Skill source returned another scope.');
    return Object.freeze({ reference, name: item.name, description: item.description });
  }));
  const diagnostics = Object.freeze(data.diagnostics.map(value => {
    const item = parseJsonObject(value);
    if (Object.keys(item).some(key => !['packageId', 'code', 'message'].includes(key)) ||
      typeof item.packageId !== 'string' || item.packageId.length > 256 ||
      typeof item.code !== 'string' || item.code.length > 64 || typeof item.message !== 'string' || item.message.length > 256)
      throw new SkillPackageError('invalid_package', 'Skill source returned an invalid diagnostic.');
    return Object.freeze({ packageId: item.packageId, code: item.code, message: item.message });
  }));
  if (new Set(items.map(item => JSON.stringify([item.reference.scopeId, item.reference.packageId]))).size !== items.length ||
    items.length + diagnostics.length > data.scanned ||
    byteLength(data) > (request.maxBytes ?? SKILL_LIMITS.discoveryBytes) ||
    (data.coverage === 'complete' && (diagnostics.length > 0 || data.nextOffset !== undefined)) ||
    (request.expectedRevision !== undefined && data.revision !== request.expectedRevision))
    throw new SkillPackageError('invalid_package', 'Skill source exceeded discovery bounds or changed inventory revision.');
  return Object.freeze({ scopeId: data.scopeId, revision: data.revision, items, diagnostics, scanned: data.scanned,
    scannedBytes: data.scannedBytes, coverage: data.coverage, ...(typeof data.nextOffset === 'number' ? { nextOffset: data.nextOffset } : {}) });
}

function scopeDescriptor(input: unknown, expectedScopeId: string): SkillScopeDescriptor {
  const value = parseJsonObject(input, { maxDepth: 1, maxTotalBytes: 4096, maxStringBytes: 1024, maxCollectionEntries: 2 });
  if (Object.keys(value).some(key => !['scopeId', 'bindingRevision'].includes(key)) || value.scopeId !== expectedScopeId)
    throw new SkillPackageError('invalid_package', 'Skill source returned invalid scope metadata.');
  return Object.freeze({ scopeId: skillIdentifier(value.scopeId, 'scopeId'), bindingRevision: skillIdentifier(value.bindingRevision, 'bindingRevision') });
}
