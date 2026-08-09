import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import createIgnore, { type Ignore } from 'ignore';
import { ToolInputError, requireWorkspaceRoot, throwIfAborted, type ToolExecutionContext } from '@agent-core/tools';
import { requireLocalToolConfiguration } from './configuration.js';
import { relativePath, requireDirectoryInsideRoot, resolveInsideRoot } from './filesystem.js';

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
  readonly includeMetadata?: boolean;
  readonly signal?: AbortSignal;
}
export interface WorkspaceSelectionEntry { readonly path: string; readonly type: WorkspaceEntryType; readonly size?: number; readonly modifiedAt?: string }
export interface WorkspaceFileSelectionResult {
  readonly startPath: string;
  readonly entries: readonly WorkspaceSelectionEntry[];
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly visitedEntries: number;
  readonly returnedEntries: number;
  readonly omittedEntries: number;
  readonly omittedIgnoreFiles: number;
  readonly omissionSamples: readonly { path: string; reason: 'hidden' | 'gitignored' | 'excluded' | 'unreadable' | 'limit'; message?: string }[];
}
interface IgnoreRules { readonly base: string; readonly matcher: Ignore }

export class WorkspaceFileSelector {
  private readonly rootDir: string;
  constructor(rootDir: string, private readonly limits: WorkspaceFileSelectionLimits) { this.rootDir = path.resolve(rootDir); }

  async select(request: WorkspaceFileSelectionRequest): Promise<WorkspaceFileSelectionResult> {
    const start = resolveInsideRoot(this.rootDir, request.startPath);
    await requireDirectoryInsideRoot(this.rootDir, start, request.startPath);
    const startPath = relativePath(this.rootDir, start) || '.';
    const patterns = request.patterns.length > 0 ? request.patterns.map(normalizePattern) : ['**/*'];
    const exclusions = request.exclude.map(normalizePattern);
    if (patterns.length + exclusions.length > this.limits.maxGlobExpansions) throw new ToolInputError('Workspace glob patterns exceed the host limit.');
    const requestedLimit = Math.min(request.requestedLimit ?? this.limits.maxReturnedEntries, this.limits.maxReturnedEntries);
    const entries: WorkspaceSelectionEntry[] = [];
    const samples: WorkspaceFileSelectionResult['omissionSamples'][number][] = [];
    const causes = new Set<string>();
    let visitedEntries = 0;
    let omittedEntries = 0;
    let loadedIgnoreFiles = 0;
    let omittedIgnoreFiles = 0;
    let stopped = false;

    const walk = async (directory: string, depth: number, inherited: readonly IgnoreRules[]): Promise<void> => {
      if (stopped) return;
      throwIfAborted(request.signal);
      let directoryEntries: Dirent[];
      try { directoryEntries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) {
        causes.add('unreadable_branch');
        sample(samples, { path: relativePath(this.rootDir, directory), reason: 'unreadable', message: message(error) });
        return;
      }
      directoryEntries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      let rules = inherited;
      const ignoreEntry = request.respectGitIgnore ? directoryEntries.find((entry) => entry.name === '.gitignore' && entry.isFile()) : undefined;
      if (ignoreEntry) {
        if (loadedIgnoreFiles < this.limits.maxIgnoreFiles) {
          try {
            const base = relativePath(this.rootDir, directory);
            const content = await fs.readFile(path.join(directory, ignoreEntry.name), 'utf8');
            rules = Object.freeze([...inherited, { base: base === '.' ? '' : base, matcher: createIgnore().add(content) }]);
            loadedIgnoreFiles += 1;
          } catch (error) {
            causes.add('unreadable_ignore_file');
            sample(samples, { path: relativePath(this.rootDir, path.join(directory, ignoreEntry.name)), reason: 'unreadable', message: message(error) });
          }
        } else {
          omittedIgnoreFiles += 1;
          causes.add('ignore_file_limit');
        }
      }

      for (const dirent of directoryEntries) {
        throwIfAborted(request.signal);
        if (visitedEntries >= this.limits.maxVisitedEntries) {
          stopped = true; omittedEntries += 1; causes.add('visit_limit');
          sample(samples, { path: relativePath(this.rootDir, path.join(directory, dirent.name)), reason: 'limit' });
          break;
        }
        visitedEntries += 1;
        const absolute = path.join(directory, dirent.name);
        const workspacePath = relativePath(this.rootDir, absolute);
        const scopedPath = relativePath(start, absolute);
        const type = entryType(dirent);
        const isDirectory = type === 'directory';
        if (workspacePath === '.git' || workspacePath.startsWith('.git/')) { omittedEntries += 1; continue; }
        if (!request.includeHidden && hidden(workspacePath)) { omittedEntries += 1; sample(samples, { path: workspacePath, reason: 'hidden' }); continue; }
        if (matchesAny(scopedPath, exclusions, isDirectory)) { omittedEntries += 1; sample(samples, { path: workspacePath, reason: 'excluded' }); continue; }
        if (request.respectGitIgnore && ignored(workspacePath, isDirectory, rules)) { omittedEntries += 1; sample(samples, { path: workspacePath, reason: 'gitignored' }); continue; }
        const matches = matchesAny(scopedPath, patterns, isDirectory) && matchesType(type, request.type);
        if (matches) {
          if (entries.length >= requestedLimit) {
            stopped = true; omittedEntries += 1; causes.add('result_limit');
            sample(samples, { path: workspacePath, reason: 'limit' });
            break;
          }
          try { entries.push(await makeEntry(workspacePath, absolute, type, request.includeMetadata === true)); }
          catch (error) { omittedEntries += 1; causes.add('unreadable_entry'); sample(samples, { path: workspacePath, reason: 'unreadable', message: message(error) }); }
        }
        if (isDirectory) {
          if (depth >= this.limits.maxDepth) { causes.add('depth_limit'); omittedEntries += 1; sample(samples, { path: workspacePath, reason: 'limit' }); continue; }
          await walk(absolute, depth + 1, rules);
        }
      }
    };
    await walk(start, 1, []);
    if (omittedIgnoreFiles > 0) causes.add('ignore_file_limit');
    return Object.freeze({
      startPath, entries: Object.freeze(entries), coverage: causes.size === 0 ? 'complete' : 'partial',
      causes: Object.freeze([...causes].sort()), visitedEntries, returnedEntries: entries.length, omittedEntries, omittedIgnoreFiles,
      omissionSamples: Object.freeze(samples)
    });
  }
}

export function createWorkspaceFileSelector(rootDir: string, limits: WorkspaceFileSelectionLimits): WorkspaceFileSelector { return new WorkspaceFileSelector(rootDir, limits); }
export function isWorkspaceFileSelector(value: unknown): value is WorkspaceFileSelector { return value instanceof WorkspaceFileSelector; }
export function workspaceFileSelector(context: ToolExecutionContext): WorkspaceFileSelector {
  const service = context.services?.workspaceFileSelector;
  if (service !== undefined) {
    if (!isWorkspaceFileSelector(service)) throw new ToolInputError('The workspaceFileSelector service is invalid.');
    return service;
  }
  return createWorkspaceFileSelector(requireWorkspaceRoot(context), requireLocalToolConfiguration(context).fileSelection);
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
function entryType(dirent: Dirent): WorkspaceEntryType { return dirent.isFile() ? 'file' : dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'other'; }
function matchesType(actual: WorkspaceEntryType, requested: WorkspaceFileSelectionRequest['type']): boolean { return requested === 'any' || actual === requested; }
async function makeEntry(workspacePath: string, absolutePath: string, type: WorkspaceEntryType, metadata: boolean): Promise<WorkspaceSelectionEntry> {
  if (!metadata) return Object.freeze({ path: workspacePath, type });
  const stat = await fs.lstat(absolutePath);
  return Object.freeze({ path: workspacePath, type, size: stat.size, modifiedAt: stat.mtime.toISOString() });
}
function hidden(value: string): boolean { return value.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..'); }
function sample(samples: WorkspaceFileSelectionResult['omissionSamples'][number][], entry: WorkspaceFileSelectionResult['omissionSamples'][number]): void { if (samples.length < 10) samples.push(Object.freeze(entry)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
