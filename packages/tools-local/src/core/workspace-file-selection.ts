import path from 'node:path';
import createIgnore, { type Ignore } from 'ignore';
import { ToolInputError, throwIfAborted, type ToolExecutionContext } from '@agent-core/tools';
import { requireLocalToolConfiguration } from './configuration.js';
import { requireWorkspaceFileRoot } from './workspace.js';
import { isWorkspaceFileRoot, type WorkspaceFileRoot, type WorkspaceDirectoryEntry } from './workspace-file-root.js';

export type WorkspaceEntryType = 'file' | 'directory' | 'symlink' | 'other';
export interface WorkspaceFileSelectionLimits { readonly maxDepth: number; readonly maxVisitedEntries: number; readonly maxReturnedEntries: number; readonly maxIgnoreFiles: number; readonly maxGlobExpansions: number }
export interface WorkspaceFileSelectionRequest {
  readonly startPath: string;
  readonly patterns: readonly string[];
  readonly type: 'file' | 'directory' | 'any';
  readonly respectGitIgnore: boolean;
  readonly includeHidden: boolean;
  readonly exclude: readonly string[];
  readonly requestedLimit?: number;
  /** Requested traversal depth. Omitted means the host maximum. */
  readonly traversalDepth?: number;
  readonly includeMetadata?: boolean;
  readonly signal?: AbortSignal;
}
export interface WorkspaceSelectionEntry { readonly path: string; readonly type: WorkspaceEntryType; readonly size?: number; readonly modifiedAt?: string }
export interface WorkspaceOmissionCount { readonly count: number; readonly relation: 'exact' | 'at_least' }
export interface WorkspaceSelectionOmission extends WorkspaceOmissionCount { readonly cause: string }
export interface WorkspaceFileSelectionResult {
  readonly startPath: string;
  readonly requestedDepth: number | null;
  readonly effectiveDepth: number;
  readonly hostMaximumDepth: number;
  readonly entries: readonly WorkspaceSelectionEntry[];
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly visitedEntries: number;
  readonly returnedEntries: number;
  readonly omittedEntries: WorkspaceOmissionCount;
  readonly omittedIgnoreFiles: WorkspaceOmissionCount;
  readonly omissions: readonly WorkspaceSelectionOmission[];
  readonly omissionSamples: readonly { path: string; reason: 'hidden' | 'gitignored' | 'excluded' | 'unreadable' | 'limit'; message?: string }[];
}
interface IgnoreRules { readonly base: string; readonly matcher: Ignore }

export class WorkspaceFileSelector {
  constructor(private readonly root: WorkspaceFileRoot, private readonly limits: WorkspaceFileSelectionLimits) {
    if (!isWorkspaceFileRoot(root)) throw new TypeError('WorkspaceFileSelector requires an adopted WorkspaceFileRoot.');
  }

  async select(request: WorkspaceFileSelectionRequest): Promise<WorkspaceFileSelectionResult> {
    const startPath = this.root.canonicalPath(request.startPath);
    const startHandle = await this.root.openDirectory(startPath);
    await startHandle.close();
    const patterns = request.patterns.length > 0 ? request.patterns.map(normalizePattern) : ['**/*'];
    const exclusions = request.exclude.map(normalizePattern);
    if (patterns.length + exclusions.length > this.limits.maxGlobExpansions) throw new ToolInputError('Workspace glob patterns exceed the host limit.');
    const requestedLimit = Math.min(request.requestedLimit ?? this.limits.maxReturnedEntries, this.limits.maxReturnedEntries);
    const requestedDepth = request.traversalDepth ?? this.limits.maxDepth;
    if (!Number.isSafeInteger(requestedDepth) || requestedDepth < 1) throw new ToolInputError('Workspace traversal depth must be a positive integer.');
    const traversalDepth = Math.min(requestedDepth, this.limits.maxDepth);
    const entries: WorkspaceSelectionEntry[] = [];
    const samples: WorkspaceFileSelectionResult['omissionSamples'][number][] = [];
    const causes = new Set<string>();
    let visitedEntries = 0;
    let omittedEntries = 0;
    let loadedIgnoreFiles = 0;
    let omittedIgnoreFiles = 0;
    const omissionCounts = new Map<string, { count: number; relation: 'exact' | 'at_least' }>();
    let stopped = false;
    const omit = (cause: string, count = 1, relation: 'exact' | 'at_least' = 'exact') => {
      omittedEntries += count;
      const prior = omissionCounts.get(cause) ?? { count: 0, relation: 'exact' as const };
      omissionCounts.set(cause, { count: prior.count + count, relation: prior.relation === 'at_least' || relation === 'at_least' ? 'at_least' : 'exact' });
    };

    const walk = async (directory: string, depth: number, inherited: readonly IgnoreRules[]): Promise<void> => {
      if (stopped) return;
      throwIfAborted(request.signal);
      let directoryEntries: readonly WorkspaceDirectoryEntry[];
      try {
        const handle = await this.root.openDirectory(directory);
        try { directoryEntries = await handle.entries(); }
        finally { await handle.close(); }
      }
      catch (error) {
        causes.add('unreadable_branch');
        omit('unreadable_branch', 1, 'at_least');
        sample(samples, { path: directory, reason: 'unreadable', message: message(error) });
        return;
      }
      directoryEntries = [...directoryEntries].sort((a, b) => a.name.localeCompare(b.name, 'en'));
      let rules = inherited;
      const ignoreEntry = request.respectGitIgnore ? directoryEntries.find((entry) => entry.name === '.gitignore' && entry.type === 'file') : undefined;
      if (ignoreEntry) {
        if (loadedIgnoreFiles < this.limits.maxIgnoreFiles) {
          try {
            const base = directory;
            const ignorePath = joinWorkspacePath(directory, ignoreEntry.name);
            const file = await this.root.openFile(ignorePath);
            let content: string;
            try { content = (await file.readAll(1_000_000)).toString('utf8'); }
            finally { await file.close(); }
            rules = Object.freeze([...inherited, { base: base === '.' ? '' : base, matcher: createIgnore().add(content) }]);
            loadedIgnoreFiles += 1;
          } catch (error) {
            causes.add('unreadable_ignore_file');
            sample(samples, { path: joinWorkspacePath(directory, ignoreEntry.name), reason: 'unreadable', message: message(error) });
          }
        } else {
          omittedIgnoreFiles += 1;
          causes.add('ignore_file_limit');
          omit('ignore_file_limit');
        }
      }

      for (const dirent of directoryEntries) {
        throwIfAborted(request.signal);
        if (visitedEntries >= this.limits.maxVisitedEntries) {
          stopped = true; omit('visit_limit', 1, 'at_least'); causes.add('visit_limit');
          sample(samples, { path: joinWorkspacePath(directory, dirent.name), reason: 'limit' });
          break;
        }
        visitedEntries += 1;
        const workspacePath = joinWorkspacePath(directory, dirent.name);
        const scopedPath = startPath === '.' ? workspacePath : workspacePath.slice(startPath.length + 1);
        const type = dirent.type;
        const isDirectory = type === 'directory';
        if (this.root.isReservedPath(workspacePath)) { omit('reserved_metadata'); continue; }
        if (!request.includeHidden && hidden(workspacePath)) { omit('hidden'); sample(samples, { path: workspacePath, reason: 'hidden' }); continue; }
        if (matchesAny(scopedPath, exclusions, isDirectory)) { omit('excluded'); sample(samples, { path: workspacePath, reason: 'excluded' }); continue; }
        if (request.respectGitIgnore && ignored(workspacePath, isDirectory, rules)) { omit('gitignored'); sample(samples, { path: workspacePath, reason: 'gitignored' }); continue; }
        const matches = matchesAny(scopedPath, patterns, isDirectory) && matchesType(type, request.type);
        if (matches) {
          if (entries.length >= requestedLimit) {
            stopped = true; omit('result_limit', 1, 'at_least'); causes.add('result_limit');
            sample(samples, { path: workspacePath, reason: 'limit' });
            break;
          }
          try { entries.push(await makeEntry(this.root, workspacePath, type, request.includeMetadata === true)); }
          catch (error) { omit('unreadable_entry'); causes.add('unreadable_entry'); sample(samples, { path: workspacePath, reason: 'unreadable', message: message(error) }); }
        }
        if (isDirectory) {
          if (depth >= traversalDepth) {
            const hostLimited = request.traversalDepth === undefined || requestedDepth > this.limits.maxDepth;
            if (hostLimited && depth >= this.limits.maxDepth) {
              const descendants = await immediateEntryCount(this.root, workspacePath);
              if (descendants > 0) {
                causes.add('host_depth_limit'); omit('host_depth_limit', descendants, 'at_least'); sample(samples, { path: workspacePath, reason: 'limit' });
              }
            }
            continue;
          }
          await walk(workspacePath, depth + 1, rules);
        }
      }
    };
    await walk(startPath, 1, []);
    if (omittedIgnoreFiles > 0) causes.add('ignore_file_limit');
    const lowerBound = [...omissionCounts.values()].some((item) => item.relation === 'at_least');
    return Object.freeze({
      startPath, requestedDepth: request.traversalDepth ?? null, effectiveDepth: traversalDepth, hostMaximumDepth: this.limits.maxDepth,
      entries: Object.freeze(entries), coverage: causes.size === 0 ? 'complete' : 'partial',
      causes: Object.freeze([...causes].sort()), visitedEntries, returnedEntries: entries.length,
      omittedEntries: Object.freeze({ count: omittedEntries, relation: lowerBound ? 'at_least' : 'exact' }),
      omittedIgnoreFiles: Object.freeze({ count: omittedIgnoreFiles, relation: 'exact' }),
      omissions: Object.freeze([...omissionCounts.entries()].map(([cause, value]) => Object.freeze({ cause, ...value })).sort((a, b) => a.cause.localeCompare(b.cause, 'en'))),
      omissionSamples: Object.freeze(samples)
    });
  }
}
async function immediateEntryCount(root: WorkspaceFileRoot, directory: string): Promise<number> {
  try {
    const handle = await root.openDirectory(directory);
    try { return (await handle.entries()).length; }
    finally { await handle.close(); }
  }
  catch { return 1; }
}

export function createWorkspaceFileSelector(root: WorkspaceFileRoot, limits: WorkspaceFileSelectionLimits): WorkspaceFileSelector { return new WorkspaceFileSelector(root, limits); }
export function isWorkspaceFileSelector(value: unknown): value is WorkspaceFileSelector { return value instanceof WorkspaceFileSelector; }
export function workspaceFileSelector(context: ToolExecutionContext): WorkspaceFileSelector {
  const service = context.services?.workspaceFileSelector;
  if (service !== undefined) {
    if (!isWorkspaceFileSelector(service)) throw new ToolInputError('The workspaceFileSelector service is invalid.');
    return service;
  }
  return createWorkspaceFileSelector(requireWorkspaceFileRoot(context), requireLocalToolConfiguration(context).fileSelection);
}
function ignored(workspacePath: string, directory: boolean, rules: readonly IgnoreRules[]): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.base !== '' && workspacePath !== rule.base && !workspacePath.startsWith(rule.base + '/')) continue;
    const scoped = rule.base === '' ? workspacePath : workspacePath.slice(rule.base.length + 1);
    const tested = rule.matcher.test(scoped + (directory ? '/' : ''));
    if (tested.ignored) result = true;
    if (tested.unignored) result = false;
  }
  return result;
}
function matchesAny(candidate: string, patterns: readonly string[], directory: boolean): boolean {
  return patterns.some((pattern) => matchesGlob(candidate, pattern) || (directory && matchesGlob(candidate + '/', pattern)));
}
function matchesGlob(candidate: string, pattern: string): boolean {
  const visibleCandidate = candidate.split('/').map((part) => part.startsWith('.') ? part.slice(1) : part).join('/');
  return path.matchesGlob(candidate, pattern) || path.matchesGlob(visibleCandidate, pattern)
    || (pattern.startsWith('**/') && (path.matchesGlob(candidate, pattern.slice(3)) || path.matchesGlob(visibleCandidate, pattern.slice(3))));
}
function normalizePattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\/+/u, '');
  if (normalized.length === 0 || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new ToolInputError('Invalid workspace glob pattern: ' + pattern, { pattern });
  return normalized;
}
function matchesType(actual: WorkspaceEntryType, requested: WorkspaceFileSelectionRequest['type']): boolean { return requested === 'any' || actual === requested; }
async function makeEntry(root: WorkspaceFileRoot, workspacePath: string, type: WorkspaceEntryType, metadata: boolean): Promise<WorkspaceSelectionEntry> {
  if (!metadata) return Object.freeze({ path: workspacePath, type });
  if (type === 'file') {
    const handle = await root.openFile(workspacePath);
    try { return Object.freeze({ path: workspacePath, type, size: handle.size, modifiedAt: nanosecondsToIso(handle.identity.modifiedNanoseconds) }); }
    finally { await handle.close(); }
  }
  if (type === 'directory') {
    const handle = await root.openDirectory(workspacePath);
    try { return Object.freeze({ path: workspacePath, type, size: handle.size, modifiedAt: nanosecondsToIso(handle.identity.modifiedNanoseconds) }); }
    finally { await handle.close(); }
  }
  return Object.freeze({ path: workspacePath, type });
}
function hidden(value: string): boolean { return value.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..'); }
function sample(samples: WorkspaceFileSelectionResult['omissionSamples'][number][], entry: WorkspaceFileSelectionResult['omissionSamples'][number]): void { if (samples.length < 10) samples.push(Object.freeze(entry)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function joinWorkspacePath(parent: string, name: string): string { return parent === '.' ? name : `${parent}/${name}`; }
function nanosecondsToIso(value: string): string { return new Date(Number(BigInt(value) / 1_000_000n)).toISOString(); }
