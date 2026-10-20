import { hashJson } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import { SKILL_LIMITS, SkillPackageError, parseSkillReference, skillDiscoveryRequestSchema, skillIdentifier,
  type SkillAccessRequest, type SkillDescriptor, type SkillDiscoveryPage, type SkillDiscoveryRequest,
  type SkillPackage, type SkillPackageInput, type SkillPackageSource, type SkillReference,
  type SkillResourceRead, type SkillScopeDescriptor, type SkillSourceOptions } from './contracts.js';
import { captureSkill, readCapturedResource, type CapturedSkill } from './package.js';

export abstract class IndexedSkillSource implements SkillPackageSource {
  readonly scopeId: string;
  protected readonly bindingRevision: string;
  protected readonly packageIds: readonly string[];
  private readonly indexRevision: string;
  private readonly access: SkillSourceOptions['access'];
  private readonly fence: SkillSourceOptions['withAccess'];
  protected closed = false;
  private closing = false;
  private activeDispatches = 0;
  private closeCompletion: Promise<void> | undefined;
  private finishClose: (() => void) | undefined;
  protected constructor(options: SkillSourceOptions, packageIds: readonly string[]) {
    this.scopeId = skillIdentifier(options.scopeId, 'scopeId');
    this.bindingRevision = skillIdentifier(options.bindingRevision, 'bindingRevision');
    if (packageIds.length > SKILL_LIMITS.packages || new Set(packageIds).size !== packageIds.length)
      throw new SkillPackageError('resource_limit', 'Skill source has duplicate package identities or exceeds its inventory bound.');
    this.packageIds = Object.freeze(packageIds.map(id => skillIdentifier(id, 'packageId')).sort());
    this.indexRevision = hashJson(parseJsonObject({ scopeId: this.scopeId, bindingRevision: this.bindingRevision, packages: this.packageIds }));
    this.access = options.access;
    this.fence = options.withAccess;
  }
  protected abstract describe(packageId: string, maxBytes: number, signal?: AbortSignal): Promise<{ readonly descriptor: SkillDescriptor; readonly scannedBytes: number }>;
  protected abstract capture(reference: SkillReference, signal?: AbortSignal): Promise<CapturedSkill>;

  async describeScope(signal?: AbortSignal): Promise<SkillScopeDescriptor | undefined> {
    try {
      await this.check('discover', [], signal);
      const descriptor = Object.freeze({ scopeId: this.scopeId, bindingRevision: this.bindingRevision });
      await this.check('discover', [], signal);
      return descriptor;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SkillPackageError && error.code === 'access_denied') return undefined;
      throw error;
    }
  }

  async discover(input: SkillDiscoveryRequest, signal?: AbortSignal): Promise<SkillDiscoveryPage> {
    const request = skillDiscoveryRequestSchema.parse(input);
    await this.check('discover', [], signal);
    if (request.scopeId !== this.scopeId) throw new SkillPackageError('access_denied', 'Skill discovery scope is not granted.');
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.indexRevision)
      throw new SkillPackageError('revision_unavailable', 'Skill source inventory or binding revision changed.');
    const limit = request.limit ?? 16;
    const maxBytes = request.maxBytes ?? SKILL_LIMITS.discoveryBytes;
    const maxScanned = request.maxScanned ?? 16;
    const maxScanBytes = request.maxScanBytes ?? SKILL_LIMITS.scanBytes;
    let offset = request.offset ?? 0;
    if (offset > this.packageIds.length) throw new SkillPackageError('invalid_range', 'Invalid skill discovery offset.');
    const query = request.query?.toLowerCase();
    const items: SkillDescriptor[] = [];
    const diagnostics: { readonly packageId: string; readonly code: string; readonly message: string }[] = [];
    let scanned = 0, scannedBytes = 0;
    // Reserve complete page bookkeeping, including the longest possible continuation.
    let outputBytes = byteLength({ scopeId: this.scopeId, revision: this.indexRevision, items: [], diagnostics: [],
      scanned: maxScanned, scannedBytes: maxScanBytes, coverage: 'complete', nextOffset: this.packageIds.length });
    if (outputBytes > maxBytes) throw new SkillPackageError('resource_limit', 'Discovery byte limit is too small for page bookkeeping.');
    while (offset < this.packageIds.length && scanned < maxScanned && items.length < limit && scannedBytes < maxScanBytes) {
      signal?.throwIfAborted();
      const packageId = this.packageIds[offset];
      if (packageId === undefined) break;
      scanned++;
      await this.check('discover', [], signal, [packageId]);
      let found: Awaited<ReturnType<IndexedSkillSource['describe']>>;
      try { found = await this.describe(packageId, maxScanBytes - scannedBytes, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof SkillPackageError) || error.code === 'access_denied') throw error;
        scannedBytes += error.scannedBytes;
        const diagnostic = Object.freeze({ packageId, code: error.code, message: error.message.slice(0, 256) });
        const bytes = byteLength(diagnostic) + 1;
        if (outputBytes + bytes > maxBytes) {
          if (items.length === 0 && diagnostics.length === 0) throw new SkillPackageError('resource_limit', 'Discovery byte limit is too small for a diagnostic.');
          break;
        }
        diagnostics.push(diagnostic); outputBytes += bytes; offset++; continue;
      }
      scannedBytes += found.scannedBytes;
      await this.check('discover', [found.descriptor.reference], signal);
      const item = found.descriptor;
      if (!query || `${item.name}\n${item.description}`.toLowerCase().includes(query)) {
        const bytes = byteLength(item) + 1;
        if (outputBytes + bytes > maxBytes) {
          if (items.length === 0 && diagnostics.length === 0)
            throw new SkillPackageError('resource_limit', 'Discovery byte limit is too small for one exact descriptor.');
          break;
        }
        items.push(item); outputBytes += bytes;
      }
      offset++;
    }
    await this.check('discover', [], signal);
    return Object.freeze({ scopeId: this.scopeId, revision: this.indexRevision, items: Object.freeze(items),
      diagnostics: Object.freeze(diagnostics), scanned, scannedBytes,
      coverage: offset < this.packageIds.length || diagnostics.length > 0 ? 'partial' : 'complete',
      ...(offset < this.packageIds.length ? { nextOffset: offset } : {}) });
  }
  async load(input: SkillReference, signal?: AbortSignal): Promise<SkillPackage> {
    const reference = this.reference(input);
    await this.check('read', [reference], signal);
    const captured = await this.capture(reference, signal);
    await this.check('read', [reference], signal);
    return captured.value;
  }
  async readResource(input: SkillReference, path: string, range: { readonly offset: number; readonly length: number }, signal?: AbortSignal): Promise<SkillResourceRead> {
    const reference = this.reference(input);
    await this.check('read', [reference], signal);
    const captured = await this.capture(reference, signal);
    const read = readCapturedResource(captured, reference, path, range);
    await this.check('read', [reference], signal);
    return read;
  }
  async assertAvailable(inputs: readonly SkillReference[], signal?: AbortSignal): Promise<void> {
    const references = inputs.map(reference => this.reference(reference));
    await this.check('read', references, signal);
    for (const reference of references) { signal?.throwIfAborted(); await this.capture(reference, signal); }
    await this.check('read', references, signal);
  }
  async withAvailable<T>(inputs: readonly SkillReference[], operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.isClosed()) throw new SkillPackageError('access_denied', 'Skill source is closed.');
    this.activeDispatches++;
    try {
      const references = inputs.map(reference => this.reference(reference));
      await this.assertAvailable(references, signal);
      const request = this.request('dispatch', references);
      if (this.access && !this.fence)
        throw new SkillPackageError('access_denied', 'Dynamic skill access requires a host revocation fence for dispatch.');
      const run = async (): Promise<T> => { await this.check('dispatch', references, signal); return operation(); };
      return await (this.fence ? this.fence(request, run, signal) : run());
    } finally {
      this.activeDispatches--;
      if (this.activeDispatches === 0) { this.finishClose?.(); this.finishClose = undefined; }
    }
  }
  /** The close acknowledgement follows any already-entered dispatch boundary. */
  protected closeSource(): Promise<void> {
    if (this.closeCompletion) return this.closeCompletion;
    this.closing = true;
    if (this.activeDispatches === 0) {
      this.closed = true;
      this.closeCompletion = Promise.resolve();
    } else {
      this.closeCompletion = new Promise<void>(resolve => { this.finishClose = () => { this.closed = true; resolve(); }; });
    }
    return this.closeCompletion;
  }
  protected reference(input: SkillReference): SkillReference {
    const reference = parseSkillReference(input);
    if (reference.scopeId !== this.scopeId || reference.bindingRevision !== this.bindingRevision ||
      !this.packageIds.includes(reference.packageId))
      throw new SkillPackageError('access_denied', 'Skill reference is outside this source grant or binding.');
    return reference;
  }
  protected async check(action: SkillAccessRequest['action'], references: readonly SkillReference[], signal?: AbortSignal, packageIds?: readonly string[]): Promise<void> {
    signal?.throwIfAborted();
    if (this.isClosed()) throw new SkillPackageError('access_denied', 'Skill source is closed.');
    await this.access?.(this.request(action, references, packageIds), signal);
    signal?.throwIfAborted();
    if (this.isClosed()) throw new SkillPackageError('access_denied', 'Skill source is closed.');
  }
  private isClosed(): boolean { return this.closed || this.closing; }
  private request(action: SkillAccessRequest['action'], references: readonly SkillReference[], packageIds?: readonly string[]): SkillAccessRequest {
    return Object.freeze({ scopeId: this.scopeId, bindingRevision: this.bindingRevision, action, packageIds: Object.freeze(packageIds ? [...packageIds] : [...new Set(references.map(reference => reference.packageId))]), references: Object.freeze([...references]) });
  }
}
export interface InMemorySkillSourceOptions extends SkillSourceOptions { readonly packages: readonly SkillPackageInput[] }
/** Host-supplied immutable transport content, not an independent material journal or active view. */
export class InMemorySkillSource extends IndexedSkillSource {
  private readonly revisions = new Map<string, CapturedSkill>();
  private readonly heads = new Map<string, CapturedSkill>();
  constructor(options: InMemorySkillSourceOptions) {
    if (options.packages.length > SKILL_LIMITS.packages) throw new SkillPackageError('resource_limit', 'Skill source exceeds package bound.');
    super(options, [...new Set(options.packages.map(input => input.packageId))]);
    let retainedBytes = 0;
    for (const input of options.packages) {
      const captured = captureSkill({ ...input, scopeId: this.scopeId, bindingRevision: this.bindingRevision });
      retainedBytes += captured.value.manifest.totalBytes;
      if (retainedBytes > SKILL_LIMITS.scanBytes * 4)
        throw new SkillPackageError('resource_limit', 'In-memory skill source exceeds its 64 MiB retained-content bound.');
      this.revisions.set(referenceKey(captured.value.reference), captured);
      this.heads.set(input.packageId, captured);
    }
  }
  protected describe(packageId: string, _maxBytes: number, signal?: AbortSignal): Promise<{ descriptor: SkillDescriptor; scannedBytes: number }> {
    signal?.throwIfAborted();
    const captured = this.heads.get(packageId);
    if (!captured) throw new SkillPackageError('revision_unavailable', 'Skill package is unavailable.');
    return Promise.resolve({ descriptor: describeSkill(captured.value), scannedBytes: 0 });
  }
  protected capture(reference: SkillReference, signal?: AbortSignal): Promise<CapturedSkill> {
    signal?.throwIfAborted();
    const captured = this.revisions.get(referenceKey(reference));
    if (!captured) throw new SkillPackageError('revision_unavailable', 'Exact skill revision is unavailable; select a new revision explicitly.');
    return Promise.resolve(captured);
  }
}
export function describeSkill(value: SkillPackage): SkillDescriptor {
  return Object.freeze({ reference: value.reference, name: value.manifest.metadata.name, description: value.manifest.metadata.description });
}
export function referenceKey(reference: SkillReference): string { return JSON.stringify([reference.scopeId, reference.packageId, reference.revision, reference.bindingRevision]); }
export function byteLength(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
