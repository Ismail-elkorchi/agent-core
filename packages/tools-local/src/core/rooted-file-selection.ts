import path from 'node:path';
import createIgnore, { type Ignore } from 'ignore';
import {
  ToolInputError,
  throwIfAborted,
  isWorkspaceFiles,
  type WorkspaceFiles,
  type ToolExecutionContext
} from '@agent-core/tools';
import { requireLocalToolConfiguration } from './configuration.js';
import { requireRootedFileAuthority } from './rooted-files.js';
import {
  isRootedFileAuthority,
  type RootedFileAuthority,
  type RootedDirectoryEntry
} from './rooted-file-authority.js';

export type RootedEntryType = 'file' | 'directory' | 'symlink' | 'other';
export interface RootedFileSelectionLimits {
  readonly maxDepth: number;
  readonly maxVisitedEntries: number;
  readonly maxReturnedEntries: number;
  readonly maxIgnoreFiles: number;
  readonly maxGlobExpansions: number;
}
export interface RootedFileSelectionRequest {
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
export interface RootedSelectionEntry {
  readonly path: string;
  readonly type: RootedEntryType;
  readonly size?: number;
  readonly modifiedAt?: string;
}
export interface RootedOmissionCount {
  readonly count: number;
  readonly relation: 'exact' | 'at_least';
}
export interface RootedSelectionOmission extends RootedOmissionCount {
  readonly cause: string;
}
export interface RootedFileSelectionResult {
  readonly startPath: string;
  readonly requestedDepth: number | null;
  readonly effectiveDepth: number;
  readonly hostMaximumDepth: number;
  readonly entries: readonly RootedSelectionEntry[];
  readonly coverage: 'complete' | 'partial';
  readonly causes: readonly string[];
  readonly visitedEntries: number;
  readonly returnedEntries: number;
  readonly omittedEntries: RootedOmissionCount;
  readonly omittedIgnoreFiles: RootedOmissionCount;
  readonly omissions: readonly RootedSelectionOmission[];
  readonly omissionSamples: readonly {
    path: string;
    reason: 'hidden' | 'gitignored' | 'excluded' | 'unreadable' | 'limit';
    message?: string;
  }[];
}
interface IgnoreRules {
  readonly base: string;
  readonly matcher: Ignore;
}

export class RootedFileSelector {
  constructor(
    private readonly root: RootedFileAuthority | WorkspaceFiles,
    private readonly limits: RootedFileSelectionLimits
  ) {
    if (!isRootedFileAuthority(root) && !isWorkspaceFiles(root))
      throw new TypeError('RootedFileSelector requires an adopted RootedFileAuthority.');
  }

  async select(request: RootedFileSelectionRequest): Promise<RootedFileSelectionResult> {
    const startPath = isWorkspaceFiles(this.root)
      ? this.root.normalize(request.startPath)
      : this.root.canonicalPath(request.startPath);
    const rootKind = isWorkspaceFiles(this.root)
      ? (await this.root.stat(startPath)).kind
      : (await this.root.inspectPath(startPath)).kind;
    if (rootKind !== 'directory' && !(rootKind === 'file' && request.type === 'file'))
      throw new ToolInputError(
        rootKind === 'absent'
          ? `Selection path does not exist: ${startPath}`
          : `Selection path is not a ${request.type === 'file' ? 'file or directory' : 'directory'}: ${startPath}`
      );
    const patterns =
      request.patterns.length > 0 ? request.patterns.map(normalizePattern) : ['**/*'];
    const exclusions = request.exclude.map(normalizePattern);
    if (patterns.length + exclusions.length > this.limits.maxGlobExpansions)
      throw new ToolInputError('Rooted file glob patterns exceed the host limit.');
    const requestedLimit = Math.min(
      request.requestedLimit ?? this.limits.maxReturnedEntries,
      this.limits.maxReturnedEntries
    );
    const requestedDepth = request.traversalDepth ?? this.limits.maxDepth;
    if (!Number.isSafeInteger(requestedDepth) || requestedDepth < 1)
      throw new ToolInputError('Rooted file traversal depth must be a positive integer.');
    const traversalDepth = Math.min(requestedDepth, this.limits.maxDepth);
    const entries: RootedSelectionEntry[] = [];
    const samples: RootedFileSelectionResult['omissionSamples'][number][] = [];
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
      omissionCounts.set(cause, {
        count: prior.count + count,
        relation: prior.relation === 'at_least' || relation === 'at_least' ? 'at_least' : 'exact'
      });
    };

    const walk = async (
      directory: string,
      depth: number,
      inherited: readonly IgnoreRules[]
    ): Promise<void> => {
      if (stopped) return;
      throwIfAborted(request.signal);
      let directoryEntries: readonly RootedDirectoryEntry[];
      try {
        directoryEntries = await directoryPage(
          this.root,
          directory,
          this.limits.maxVisitedEntries - visitedEntries + 1
        );
      } catch (error) {
        causes.add('unreadable_branch');
        omit('unreadable_branch', 1, 'at_least');
        sample(samples, { path: directory, reason: 'unreadable', message: message(error) });
        return;
      }
      directoryEntries = [...directoryEntries].sort((a, b) => a.name.localeCompare(b.name, 'en'));
      let rules = inherited;
      const ignoreEntry = request.respectGitIgnore
        ? directoryEntries.find((entry) => entry.name === '.gitignore' && entry.type === 'file')
        : undefined;
      if (ignoreEntry) {
        if (loadedIgnoreFiles < this.limits.maxIgnoreFiles) {
          try {
            const base = directory;
            const ignorePath = joinRootedPath(directory, ignoreEntry.name);
            let content: string;
            if (isWorkspaceFiles(this.root)) {
              content = new TextDecoder('utf-8', { fatal: true }).decode(
                (await this.root.readFile(ignorePath, { maximumBytes: 1_000_000 })).bytes
              );
            } else {
              const file = await this.root.openFile(ignorePath);
              try {
                content = (await file.readAll(1_000_000)).toString('utf8');
              } finally {
                await file.close();
              }
            }
            rules = Object.freeze([
              ...inherited,
              { base: base === '.' ? '' : base, matcher: createIgnore().add(content) }
            ]);
            loadedIgnoreFiles += 1;
          } catch (error) {
            causes.add('unreadable_ignore_file');
            sample(samples, {
              path: joinRootedPath(directory, ignoreEntry.name),
              reason: 'unreadable',
              message: message(error)
            });
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
          stopped = true;
          omit('visit_limit', 1, 'at_least');
          causes.add('visit_limit');
          sample(samples, { path: joinRootedPath(directory, dirent.name), reason: 'limit' });
          break;
        }
        visitedEntries += 1;
        const rootedDirectory = joinRootedPath(directory, dirent.name);
        const scopedPath =
          startPath === '.' ? rootedDirectory : rootedDirectory.slice(startPath.length + 1);
        const type = dirent.type;
        const isDirectory = type === 'directory';
        if (reservedPath(this.root, rootedDirectory)) {
          omit('reserved_metadata');
          continue;
        }
        if (!request.includeHidden && hidden(rootedDirectory)) {
          omit('hidden');
          sample(samples, { path: rootedDirectory, reason: 'hidden' });
          continue;
        }
        if (matchesAny(scopedPath, exclusions, isDirectory)) {
          omit('excluded');
          sample(samples, { path: rootedDirectory, reason: 'excluded' });
          continue;
        }
        if (request.respectGitIgnore && ignored(rootedDirectory, isDirectory, rules)) {
          omit('gitignored');
          sample(samples, { path: rootedDirectory, reason: 'gitignored' });
          continue;
        }
        const matches =
          matchesAny(scopedPath, patterns, isDirectory) && matchesType(type, request.type);
        if (matches) {
          if (entries.length >= requestedLimit) {
            stopped = true;
            omit('result_limit', 1, 'at_least');
            causes.add('result_limit');
            sample(samples, { path: rootedDirectory, reason: 'limit' });
            break;
          }
          try {
            entries.push(
              await makeEntry(this.root, rootedDirectory, type, request.includeMetadata === true)
            );
          } catch (error) {
            omit('unreadable_entry');
            causes.add('unreadable_entry');
            sample(samples, {
              path: rootedDirectory,
              reason: 'unreadable',
              message: message(error)
            });
          }
        }
        if (isDirectory) {
          if (depth >= traversalDepth) {
            const hostLimited =
              request.traversalDepth === undefined || requestedDepth > this.limits.maxDepth;
            if (hostLimited && depth >= this.limits.maxDepth) {
              const descendants = await immediateEntryCount(this.root, rootedDirectory);
              if (descendants > 0) {
                causes.add('host_depth_limit');
                omit('host_depth_limit', descendants, 'at_least');
                sample(samples, { path: rootedDirectory, reason: 'limit' });
              }
            }
            continue;
          }
          await walk(rootedDirectory, depth + 1, rules);
        }
      }
    };
    if (rootKind === 'file') {
      const scopedPath = path.posix.basename(startPath);
      if (!request.includeHidden && hidden(startPath)) {
        omit('hidden');
        sample(samples, { path: startPath, reason: 'hidden' });
      } else if (matchesAny(scopedPath, exclusions, false)) {
        omit('excluded');
        sample(samples, { path: startPath, reason: 'excluded' });
      } else if (matchesAny(scopedPath, patterns, false)) {
        entries.push(await makeEntry(this.root, startPath, 'file', request.includeMetadata === true));
      }
      visitedEntries = 1;
    } else {
      await walk(startPath, 1, []);
    }
    if (omittedIgnoreFiles > 0) causes.add('ignore_file_limit');
    const lowerBound = [...omissionCounts.values()].some((item) => item.relation === 'at_least');
    return Object.freeze({
      startPath,
      requestedDepth: request.traversalDepth ?? null,
      effectiveDepth: traversalDepth,
      hostMaximumDepth: this.limits.maxDepth,
      entries: Object.freeze(entries),
      coverage: causes.size === 0 ? 'complete' : 'partial',
      causes: Object.freeze([...causes].sort()),
      visitedEntries,
      returnedEntries: entries.length,
      omittedEntries: Object.freeze({
        count: omittedEntries,
        relation: lowerBound ? 'at_least' : 'exact'
      }),
      omittedIgnoreFiles: Object.freeze({ count: omittedIgnoreFiles, relation: 'exact' }),
      omissions: Object.freeze(
        [...omissionCounts.entries()]
          .map(([cause, value]) => Object.freeze({ cause, ...value }))
          .sort((a, b) => a.cause.localeCompare(b.cause, 'en'))
      ),
      omissionSamples: Object.freeze(samples)
    });
  }
}
async function immediateEntryCount(
  root: RootedFileAuthority | WorkspaceFiles,
  directory: string
): Promise<number> {
  try {
    return (await directoryPage(root, directory, 1)).length;
  } catch {
    return 1;
  }
}

export function createRootedFileSelector(
  root: RootedFileAuthority,
  limits: RootedFileSelectionLimits
): RootedFileSelector {
  return new RootedFileSelector(root, limits);
}
export function isRootedFileSelector(value: unknown): value is RootedFileSelector {
  return value instanceof RootedFileSelector;
}
export function rootedFileSelector(context: ToolExecutionContext): RootedFileSelector {
  const service = context.services?.rootedFileSelector;
  if (service !== undefined) {
    if (!isRootedFileSelector(service))
      throw new ToolInputError('The rootedFileSelector service is invalid.');
    return service;
  }
  const workspace = context.services?.workspaceFiles;
  if (workspace !== undefined) {
    if (!isWorkspaceFiles(workspace))
      throw new ToolInputError('Workspace file authority is invalid.');
    return new RootedFileSelector(workspace, requireLocalToolConfiguration(context).fileSelection);
  }
  return createRootedFileSelector(
    requireRootedFileAuthority(context),
    requireLocalToolConfiguration(context).fileSelection
  );
}
function ignored(
  rootedDirectory: string,
  directory: boolean,
  rules: readonly IgnoreRules[]
): boolean {
  let result = false;
  for (const rule of rules) {
    if (
      rule.base !== '' &&
      rootedDirectory !== rule.base &&
      !rootedDirectory.startsWith(rule.base + '/')
    )
      continue;
    const scoped = rule.base === '' ? rootedDirectory : rootedDirectory.slice(rule.base.length + 1);
    const tested = rule.matcher.test(scoped + (directory ? '/' : ''));
    if (tested.ignored) result = true;
    if (tested.unignored) result = false;
  }
  return result;
}
function matchesAny(candidate: string, patterns: readonly string[], directory: boolean): boolean {
  return patterns.some(
    (pattern) =>
      matchesGlob(candidate, pattern) || (directory && matchesGlob(candidate + '/', pattern))
  );
}
function matchesGlob(candidate: string, pattern: string): boolean {
  const visibleCandidate = candidate
    .split('/')
    .map((part) => (part.startsWith('.') ? part.slice(1) : part))
    .join('/');
  return (
    path.matchesGlob(candidate, pattern) ||
    path.matchesGlob(visibleCandidate, pattern) ||
    (pattern.startsWith('**/') &&
      (path.matchesGlob(candidate, pattern.slice(3)) ||
        path.matchesGlob(visibleCandidate, pattern.slice(3))))
  );
}
function normalizePattern(pattern: string): string {
  const normalized = pattern
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/u, '');
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..')
  )
    throw new ToolInputError('Invalid rooted file glob pattern: ' + pattern, { pattern });
  return normalized;
}
function matchesType(
  actual: RootedEntryType,
  requested: RootedFileSelectionRequest['type']
): boolean {
  return requested === 'any' || actual === requested;
}
async function makeEntry(
  root: RootedFileAuthority | WorkspaceFiles,
  rootedDirectory: string,
  type: RootedEntryType,
  metadata: boolean
): Promise<RootedSelectionEntry> {
  if (!metadata) return Object.freeze({ path: rootedDirectory, type });
  if (isWorkspaceFiles(root)) {
    const stat = await root.stat(rootedDirectory);
    return Object.freeze({
      path: rootedDirectory,
      type,
      ...(stat.kind === 'file' ? { size: stat.revision.size } : {})
    });
  }
  if (type === 'file') {
    const handle = await root.openFile(rootedDirectory);
    try {
      return Object.freeze({
        path: rootedDirectory,
        type,
        size: handle.size,
        modifiedAt: nanosecondsToIso(handle.identity.modifiedNanoseconds)
      });
    } finally {
      await handle.close();
    }
  }
  if (type === 'directory') {
    const handle = await root.openDirectory(rootedDirectory);
    try {
      return Object.freeze({
        path: rootedDirectory,
        type,
        size: handle.size,
        modifiedAt: nanosecondsToIso(handle.identity.modifiedNanoseconds)
      });
    } finally {
      await handle.close();
    }
  }
  return Object.freeze({ path: rootedDirectory, type });
}
function hidden(value: string): boolean {
  return value
    .split('/')
    .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}
function sample(
  samples: RootedFileSelectionResult['omissionSamples'][number][],
  entry: RootedFileSelectionResult['omissionSamples'][number]
): void {
  if (samples.length < 10) samples.push(Object.freeze(entry));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function joinRootedPath(parent: string, name: string): string {
  return parent === '.' ? name : `${parent}/${name}`;
}
function nanosecondsToIso(value: string): string {
  return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
}

async function directoryPage(
  root: RootedFileAuthority | WorkspaceFiles,
  directory: string,
  maximum: number
): Promise<readonly RootedDirectoryEntry[]> {
  if (isWorkspaceFiles(root)) {
    const entries: RootedDirectoryEntry[] = [];
    for await (const entry of root.list(directory)) {
      entries.push(entry);
      if (entries.length >= maximum) break;
    }
    return entries;
  }
  const handle = await root.openDirectory(directory);
  try {
    return await handle.entries();
  } finally {
    await handle.close();
  }
}
function reservedPath(root: RootedFileAuthority | WorkspaceFiles, pathname: string): boolean {
  if (!isWorkspaceFiles(root)) return root.isReservedPath(pathname);
  try {
    root.normalize(pathname);
    return false;
  } catch {
    return true;
  }
}
