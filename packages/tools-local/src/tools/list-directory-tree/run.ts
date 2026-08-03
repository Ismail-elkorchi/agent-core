import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { evidenceDelta, toEvidenceJsonObject, workspaceResource } from '@agent-core/evidence';
import { requireWorkspaceRoot, type ToolExecutionContext } from '@agent-core/tools';
import type { ToolObservation } from '@agent-core/tools';
import { createPathMatcher, hasHiddenSegment, relativePath, requireDirectoryInsideRoot, resolveInsideRoot } from '../../core/filesystem.js';
import type {
  ListDirectoryTreeInput,
  ListDirectoryTreeOutput,
  ListedDirectoryEntry,
  ListedDirectoryEntryType,
  OmittedDirectoryEntry
} from './schema.js';

export async function listDirectoryTree(input: ListDirectoryTreeInput, context: ToolExecutionContext): Promise<ToolObservation<ListDirectoryTreeOutput>> {
  const rootDir = requireWorkspaceRoot(context);
  const result = await walkDirectoryTree({
    rootDir,
    startPath: input.path,
    depth: input.depth,
    maxVisitedEntries: input.maxVisitedEntries,
    hidden: input.hidden,
    exclude: input.exclude
  });
  const coverage = result.coverage === 'partial' ? ' The listing has partial coverage because traversal stopped early or a directory was unreadable.' : '';
  return {
    kind: 'result',
    ok: true,
    summary: `Listed ${String(result.entries.length)} entries under ${result.path} at depth ${String(input.depth)}.${coverage}`,
    output: result,
    evidence: evidenceDelta([{
      action: 'list',
      resources: [workspaceResource(result.path)],
      scope: {
        filters: toEvidenceJsonObject(result.filters),
        limits: toEvidenceJsonObject(result.limits),
        omitted: toEvidenceJsonObject({ entries: result.omitted.length }),
        coverage: result.coverage,
        confidence: 'verified'
      },
      summary: `Listed ${String(result.entries.length)} entries under ${result.path}.`
    }])
  };
}

interface WalkDirectoryTreeOptions {
  rootDir: string;
  startPath: string;
  depth: number;
  maxVisitedEntries: number;
  hidden: ListDirectoryTreeInput['hidden'];
  exclude: string[];
}

async function walkDirectoryTree(options: WalkDirectoryTreeOptions): Promise<ListDirectoryTreeOutput> {
  const root = path.resolve(options.rootDir);
  const start = resolveInsideRoot(root, options.startPath, {
    emptyPathMessage: 'Path cannot be empty. Omit path or use "." to list the configured root.'
  });
  await requireDirectoryInsideRoot(root, start, options.startPath);
  const excludeMatchers = options.exclude.map(createPathMatcher);
  const entries: ListedDirectoryEntry[] = [];
  const omitted: OmittedDirectoryEntry[] = [];
  const counts = { files: 0, directories: 0, symlinks: 0, other: 0 };
  let visitedEntries = 0;
  async function walk(current: string, currentDepth: number): Promise<boolean> {
    if (visitedEntries >= options.maxVisitedEntries) return true;

    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try { directory = await fs.opendir(current); }
    catch (error) {
      omitted.push({ path: relativePath(root, current) || '.', type: 'directory', reason: 'unreadable', message: error instanceof Error ? error.message : String(error) });
      return true;
    }

    for await (const dirent of directory) {
      if (visitedEntries >= options.maxVisitedEntries) return true;
      visitedEntries += 1;

      const absolute = path.join(current, dirent.name);
      const entry = await toListedEntry(root, absolute, dirent);
      const relativeToStart = relativePath(start, absolute);
      const matchedExclude = excludeMatchers.find((matcher) => matcher.matches(entry.path, relativeToStart, dirent.name));
      if (matchedExclude) {
        omitted.push({ path: entry.path, type: entry.type, pattern: matchedExclude.pattern, reason: 'excluded' });
        continue;
      }

      const hiddenPath = hasHiddenSegment(relativeToStart);
      const includeEntry = options.hidden === 'include'
        || (options.hidden === 'exclude' && !hiddenPath)
        || (options.hidden === 'only' && hiddenPath);

      if (includeEntry) {
        entries.push(entry);
        incrementCounts(counts, entry.type);
      }

      if (dirent.isDirectory() && currentDepth < options.depth && (options.hidden !== 'exclude' || !hiddenPath)) {
        if (await walk(absolute, currentDepth + 1)) return true;
      }
    }
    return false;
  }

  const partialCoverage = await walk(start, 1);

  const listedPath = relativePath(root, start) || '.';
  return {
    path: listedPath,
    scope: {
      path: listedPath
    },
    filters: {
      hidden: options.hidden,
      exclude: [...options.exclude]
    },
    limits: {
      depth: options.depth,
      maxVisitedEntries: options.maxVisitedEntries
    },
    entries,
    omitted,
    counts,
    coverage: partialCoverage ? 'partial' : 'complete'
  };
}

async function toListedEntry(root: string, absolute: string, dirent: Dirent): Promise<ListedDirectoryEntry> {
  const type = entryType(dirent);
  if (type !== 'file') {
    return { path: relativePath(root, absolute), type };
  }
  const stat = await fs.stat(absolute);
  return { path: relativePath(root, absolute), type, size: stat.size };
}

function entryType(dirent: Dirent): ListedDirectoryEntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

function incrementCounts(counts: ListDirectoryTreeOutput['counts'], type: ListedDirectoryEntryType): void {
  switch (type) {
    case 'file':
      counts.files += 1;
      return;
    case 'directory':
      counts.directories += 1;
      return;
    case 'symlink':
      counts.symlinks += 1;
      return;
    case 'other':
      counts.other += 1;
      return;
  }
}
