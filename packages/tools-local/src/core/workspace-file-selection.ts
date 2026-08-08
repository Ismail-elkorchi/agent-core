import { constants, promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import createIgnore, { type Ignore } from 'ignore';
import { ToolInputError, requireWorkspaceRoot, type ToolExecutionContext } from '@agent-core/tools';
import { requireLocalToolConfiguration } from './configuration.js';
import { relativePath, requireDirectoryInsideRoot, resolveInsideRoot } from './filesystem.js';

export type WorkspaceEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface WorkspaceFileSelectionLimits {
  readonly maxDepth: number;
  readonly maxVisitedEntries: number;
  readonly maxReturnedEntries: number;
  readonly maxIgnoreFiles: number;
  readonly maxGlobExpansions: number;
}

export interface WorkspaceFileSelectionRequest {
  readonly startPath: string;
  readonly patterns: readonly string[];
  readonly type: 'file' | 'directory' | 'any';
  readonly respectGitIgnore: boolean;
  readonly includeHidden: boolean;
  readonly exclude: readonly string[];
  readonly requestedLimit?: number;
  readonly includeMetadata?: boolean;
}

export interface WorkspaceSelectionEntry {
  readonly path: string;
  readonly type: WorkspaceEntryType;
  readonly size?: number;
  readonly modifiedAt?: string;
}

export interface WorkspaceFileSelectionResult {
  readonly startPath: string;
  readonly entries: readonly WorkspaceSelectionEntry[];
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly visitedEntries: number;
  readonly returnedEntries: number;
  readonly omittedEntries: number;
  readonly omissionSamples: readonly { path: string; reason: 'hidden' | 'gitignored' | 'excluded' | 'unreadable' | 'limit'; message?: string }[];
}

interface IgnoreRuleSet { readonly base: string; readonly matcher: Ignore }

export class WorkspaceFileSelector {
  private readonly rootDir: string;
  private readonly limits: WorkspaceFileSelectionLimits;

  constructor(rootDir: string, limits: WorkspaceFileSelectionLimits) {
    this.rootDir = path.resolve(rootDir);
    this.limits = limits;
  }

  async select(request: WorkspaceFileSelectionRequest): Promise<WorkspaceFileSelectionResult> {
    const start = resolveInsideRoot(this.rootDir, request.startPath);
    await requireDirectoryInsideRoot(this.rootDir, start, request.startPath);
    const startPath = relativePath(this.rootDir, start) || '.';
    const requestedLimit = Math.min(request.requestedLimit ?? this.limits.maxReturnedEntries, this.limits.maxReturnedEntries);
    const basePatterns = request.patterns.length > 0 ? request.patterns.map(normalizePattern) : ['**/*'];
    const patterns = withHiddenPatterns(basePatterns, this.limits.maxGlobExpansions);
    const excludedPaths = await collectExcludedPaths(start, withHiddenPatterns(request.exclude.map(normalizePattern), this.limits.maxGlobExpansions));
    const ignoreRules = request.respectGitIgnore ? await this.loadIgnoreRules() : [];
    const entries: WorkspaceSelectionEntry[] = [];
    const samples: WorkspaceFileSelectionResult['omissionSamples'][number][] = [];
    const causes = new Set<string>();
    const seenPaths = new Set<string>();
    let visitedEntries = 0;
    let omittedEntries = 0;

    try {
      const iterator = fs.glob(patterns, {
        cwd: start,
        withFileTypes: true
      });
      for await (const dirent of iterator) {
        const scopedPath = direntPath(dirent, start);
        const workspacePath = relativePath(this.rootDir, path.resolve(start, scopedPath));
        if (seenPaths.has(workspacePath)) continue;
        seenPaths.add(workspacePath);
        visitedEntries += 1;
        if (visitedEntries > this.limits.maxVisitedEntries) {
          omittedEntries += 1;
          causes.add('host traversal limit reached');
          sample(samples, { path: workspacePath, reason: 'limit' });
          break;
        }
        if (!request.includeHidden && hasHiddenSegment(workspacePath)) {
          omittedEntries += 1;
          sample(samples, { path: workspacePath, reason: 'hidden' });
          continue;
        }
        if (isExcludedPath(scopedPath, excludedPaths)) {
          omittedEntries += 1;
          sample(samples, { path: workspacePath, reason: 'excluded' });
          continue;
        }
        if (request.respectGitIgnore && isIgnored(workspacePath, ignoreRules)) {
          omittedEntries += 1;
          sample(samples, { path: workspacePath, reason: 'gitignored' });
          continue;
        }
        const type = entryType(dirent);
        if (type === 'directory' && await isUnreadableDirectory(path.resolve(start, scopedPath))) {
          omittedEntries += 1;
          causes.add('one or more directory branches were unreadable');
          sample(samples, { path: workspacePath, reason: 'unreadable', message: 'Directory permissions do not allow traversal.' });
          continue;
        }
        if (!matchesType(type, request.type)) continue;
        if (entries.length >= requestedLimit) {
          omittedEntries += 1;
          causes.add('requested result limit reached');
          sample(samples, { path: workspacePath, reason: 'limit' });
          continue;
        }
        try {
          entries.push(await makeEntry(workspacePath, path.resolve(start, scopedPath), type, request.includeMetadata === true));
        } catch (error) {
          omittedEntries += 1;
          causes.add('one or more entries became unreadable');
          sample(samples, { path: workspacePath, reason: 'unreadable', message: errorMessage(error) });
        }
      }
    } catch (error) {
      causes.add('one or more directory branches were unreadable');
      sample(samples, { path: startPath, reason: 'unreadable', message: errorMessage(error) });
    }

    entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    return {
      startPath,
      entries,
      coverage: causes.size === 0 ? 'complete' : 'partial',
      causes: [...causes].sort(),
      visitedEntries,
      returnedEntries: entries.length,
      omittedEntries,
      omissionSamples: samples
    };
  }

  private async loadIgnoreRules(): Promise<readonly IgnoreRuleSet[]> {
    const files: string[] = [];
    for await (const file of fs.glob(['.gitignore', '**/.gitignore'], { cwd: this.rootDir })) {
      files.push(file);
      if (files.length >= this.limits.maxIgnoreFiles) break;
    }
    files.sort((left, right) => left.localeCompare(right, 'en'));
    const rules: IgnoreRuleSet[] = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(path.resolve(this.rootDir, file), 'utf8');
        rules.push({ base: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file), matcher: createIgnore().add(content) });
      } catch {
        // A concurrently removed ignore file does not make file selection unsafe.
      }
    }
    return rules;
  }
}

async function collectExcludedPaths(start: string, patterns: readonly string[]): Promise<ReadonlySet<string>> {
  const excluded = new Set<string>();
  if (patterns.length === 0) return excluded;
  for await (const matchedPath of fs.glob(patterns, { cwd: start })) {
    excluded.add(normalizeRelativePath(matchedPath));
  }
  return excluded;
}

function isExcludedPath(candidate: string, excluded: ReadonlySet<string>): boolean {
  const normalized = normalizeRelativePath(candidate);
  for (const excludedPath of excluded) {
    if (normalized === excludedPath || normalized.startsWith(`${excludedPath}/`)) return true;
  }
  return false;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

export function createWorkspaceFileSelector(rootDir: string, limits: WorkspaceFileSelectionLimits): WorkspaceFileSelector {
  return new WorkspaceFileSelector(rootDir, limits);
}

export function isWorkspaceFileSelector(value: unknown): value is WorkspaceFileSelector {
  return value instanceof WorkspaceFileSelector;
}

export function workspaceFileSelector(context: ToolExecutionContext): WorkspaceFileSelector {
  const service = context.services?.workspaceFileSelector;
  if (service !== undefined) {
    if (!isWorkspaceFileSelector(service)) throw new ToolInputError('The workspaceFileSelector service is invalid.');
    return service;
  }
  return createWorkspaceFileSelector(requireWorkspaceRoot(context), requireLocalToolConfiguration(context).fileSelection);
}

function isIgnored(workspacePath: string, rules: readonly IgnoreRuleSet[]): boolean {
  if (workspacePath === '.git' || workspacePath.startsWith('.git/')) return true;
  let ignored = false;
  for (const rule of rules) {
    if (rule.base !== '' && workspacePath !== rule.base && !workspacePath.startsWith(`${rule.base}/`)) continue;
    const scoped = rule.base === '' ? workspacePath : workspacePath.slice(rule.base.length + 1);
    const result = rule.matcher.test(scoped);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

function direntPath(dirent: Dirent, start: string): string {
  const parent = path.resolve(dirent.parentPath);
  return path.relative(start, path.join(parent, dirent.name));
}

function normalizePattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized.length === 0 || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new ToolInputError(`Invalid workspace glob pattern: ${pattern}`, { pattern });
  }
  return normalized;
}

function withHiddenPatterns(patterns: readonly string[], maxExpansions: number): string[] {
  const output = new Set<string>();
  for (const pattern of patterns) {
    const segmentVariants = pattern.split('/').map((segment): readonly string[] => {
      if (segment === '**') return ['**', '**/.*/**'];
      if (!segment.startsWith('.') && hasGlobMagic(segment)) return [segment, `.${segment}`];
      return [segment];
    });
    let expanded = [''];
    for (const variants of segmentVariants) {
      expanded = expanded.flatMap((prefix) => variants.map((variant) => prefix.length === 0 ? variant : `${prefix}/${variant}`));
      if (output.size + expanded.length > maxExpansions) throw new ToolInputError(`Workspace glob patterns exceed the host expansion limit of ${String(maxExpansions)}.`);
    }
    for (const item of expanded) output.add(item);
    if (pattern.endsWith('**')) {
      const hiddenTerminal = `${pattern}/.*`;
      output.add(hiddenTerminal);
      if (output.size > maxExpansions) throw new ToolInputError(`Workspace glob patterns exceed the host expansion limit of ${String(maxExpansions)}.`);
    }
  }
  return [...output];
}

function hasGlobMagic(segment: string): boolean {
  return segment.includes('*') || segment.includes('?') || segment.includes('[') || segment.includes('{');
}

async function isUnreadableDirectory(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath, constants.R_OK | constants.X_OK);
    return false;
  } catch {
    return true;
  }
}

function entryType(dirent: Dirent): WorkspaceEntryType {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

function matchesType(actual: WorkspaceEntryType, requested: WorkspaceFileSelectionRequest['type']): boolean {
  return requested === 'any' || actual === requested;
}

async function makeEntry(workspacePath: string, absolutePath: string, type: WorkspaceEntryType, metadata: boolean): Promise<WorkspaceSelectionEntry> {
  if (!metadata) return { path: workspacePath, type };
  const stat = await fs.stat(absolutePath);
  return { path: workspacePath, type, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function hasHiddenSegment(value: string): boolean {
  return value.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

function sample(samples: WorkspaceFileSelectionResult['omissionSamples'][number][], entry: WorkspaceFileSelectionResult['omissionSamples'][number]): void {
  if (samples.length < 10) samples.push(entry);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
