import path from 'node:path';
import { RootedFileAuthority, rootedFileIdentitiesEqual, type RootedFileIdentity } from '@agent-core/tools-local';
import { SKILL_LIMITS, SkillPackageError, skillResourcePath, type SkillDescriptor, type SkillFileInput,
  type SkillReference, type SkillSourceOptions } from './contracts.js';
import { captureSkill, type CapturedSkill } from './package.js';
import { IndexedSkillSource, describeSkill, referenceKey } from './source.js';

export interface FileSystemSkillSourceOptions extends SkillSourceOptions {
  /** Exact package roots only. No implicit home, parent-directory, or workspace discovery. */
  readonly roots: readonly { readonly packageId: string; readonly path: string }[];
}
/** Explicit Node adapter. Uses the existing Linux fd-rooted authority; unsupported confinement fails closed. */
export class FileSystemSkillSource extends IndexedSkillSource {
  private readonly roots = new Map<string, string>();
  private readonly retained = new Map<string, CapturedSkill>();
  private retainedBytes = 0;
  private closeResult: Promise<void> | undefined;
  constructor(options: FileSystemSkillSourceOptions) {
    super(options, options.roots.map(root => root.packageId));
    if (process.platform !== 'linux') throw new SkillPackageError('unsupported_source', 'Filesystem skill packages require Linux handle-relative confinement; use an immutable non-filesystem source on this platform.');
    for (const root of options.roots) {
      if (!path.isAbsolute(root.path)) throw new SkillPackageError('unsafe_path', 'Skill package roots must be explicit absolute directories.');
      this.roots.set(root.packageId, root.path);
    }
  }
  close(): Promise<void> {
    return this.closeResult ??= this.closeSource().then(() => { this.retained.clear(); this.retainedBytes = 0; });
  }
  protected async describe(packageId: string, maxBytes: number, signal?: AbortSignal): Promise<{ descriptor: SkillDescriptor; scannedBytes: number }> {
    const captured = await this.snapshot(packageId, maxBytes, signal);
    return { descriptor: describeSkill(captured.value), scannedBytes: captured.value.manifest.totalBytes };
  }
  protected async capture(reference: SkillReference, signal?: AbortSignal): Promise<CapturedSkill> {
    const key = referenceKey(reference);
    const retained = this.retained.get(key);
    if (retained) return retained;
    const captured = await this.snapshot(reference.packageId, SKILL_LIMITS.packageBytes, signal);
    signal?.throwIfAborted();
    if (this.closed) throw new SkillPackageError('access_denied', 'Skill source is closed.');
    if (captured.value.reference.revision !== reference.revision)
      throw new SkillPackageError('revision_unavailable', 'Skill package changed or its exact old revision is unavailable. Discover and explicitly select the new revision.');
    const existing = this.retained.get(key);
    if (existing) return existing;
    if (this.retainedBytes + captured.value.manifest.totalBytes > SKILL_LIMITS.scanBytes * 4)
      throw new SkillPackageError('resource_limit', 'Retained skill resources exceed the 64 MiB source bound. Use a smaller configured source.');
    this.retained.set(key, captured);
    this.retainedBytes += captured.value.manifest.totalBytes;
    return captured;
  }
  private async snapshot(packageId: string, maximum: number, signal?: AbortSignal): Promise<CapturedSkill> {
    signal?.throwIfAborted();
    const directory = this.roots.get(packageId);
    if (directory === undefined) throw new SkillPackageError('access_denied', 'Skill package root is not granted.');
    let root: RootedFileAuthority | undefined;
    let bytes = 0;
    try {
      root = RootedFileAuthority.adopt(directory);
      const files: SkillFileInput[] = [];
      const identities: { path: string; identity: RootedFileIdentity; directory: boolean }[] = [];
      let entries = 0;
      const visit = async (folder: string, depth: number): Promise<void> => {
        signal?.throwIfAborted();
        if (depth > SKILL_LIMITS.depth) throw new SkillPackageError('resource_limit', 'Skill package directory depth exceeds its bound.');
        if (!root) throw new SkillPackageError('access_denied', 'Skill root is closed.');
        const handle = await root.openDirectory(folder);
        try {
          identities.push({ path: folder, identity: handle.identity, directory: true });
          const children = await handle.entries(SKILL_LIMITS.files * 2 - entries + 1);
          entries += children.length;
          if (entries > SKILL_LIMITS.files * 2) throw new SkillPackageError('resource_limit', 'Skill package directory entry count exceeds its bound.');
          for (const child of [...children].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            signal?.throwIfAborted();
            const relative = skillResourcePath(folder === '.' ? child.name : `${folder}/${child.name}`);
            if (child.type === 'directory') { await visit(relative, depth + 1); continue; }
            if (child.type !== 'file') throw new SkillPackageError('unsafe_path', 'Skill packages cannot contain symlinks or nonregular resources.');
            if (files.length >= SKILL_LIMITS.files) throw new SkillPackageError('resource_limit', 'Skill package file count exceeds its bound.');
            const file = await root.openFile(relative);
            try {
              const bound = Math.min(relative === 'SKILL.md' ? SKILL_LIMITS.instructionBytes : SKILL_LIMITS.fileBytes,
                SKILL_LIMITS.packageBytes - bytes, maximum - bytes);
              if (file.size > bound) throw new SkillPackageError('resource_limit', 'Skill package exceeds its resource or scan byte bound.');
              const content = await file.readAll(bound);
              if (!rootedFileIdentitiesEqual(file.identity, await file.identityNow()))
                throw new SkillPackageError('revision_unavailable', 'Skill resource changed while capturing its revision.');
              files.push({ path: relative, content }); bytes += content.length;
              identities.push({ path: relative, identity: file.identity, directory: false });
            } finally { await file.close(); }
          }
        } finally { await handle.close(); }
      };
      await visit('.', 0);
      for (const entry of identities) {
        signal?.throwIfAborted();
        if (entry.directory) {
          const handle = await root.openDirectory(entry.path);
          try { if (!rootedFileIdentitiesEqual(entry.identity, handle.identity))
            throw new SkillPackageError('revision_unavailable', 'Skill package inventory changed while capturing its revision.'); }
          finally { await handle.close(); }
        } else if (!rootedFileIdentitiesEqual(entry.identity, await root.fileIdentity(entry.path)))
          throw new SkillPackageError('revision_unavailable', 'Skill resource changed while capturing its revision.');
      }
      const captured = captureSkill({ scopeId: this.scopeId, bindingRevision: this.bindingRevision, packageId, files });
      if (captured.value.manifest.metadata.name !== path.basename(directory))
        throw new SkillPackageError('invalid_package', 'SKILL.md name must match its package directory name.');
      return captured;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SkillPackageError) throw new SkillPackageError(error.code, error.message, maximum);
      throw new SkillPackageError('unsafe_path', 'Unable to capture skill root safely. Check root availability, platform confinement, symlinks, hard links, and resource bounds.', maximum);
    } finally { root?.close(); }
  }
}
