import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { splitLogicalLines, ToolInputError } from '@agent-core/tools';

export type HiddenMode = 'include' | 'exclude' | 'only';

export interface PathMatcher {
  pattern: string;
  matches(workspaceRelativePath: string, scopedRelativePath: string, name: string): boolean;
}

export type TextFileFailureReason = 'not_found' | 'not_file' | 'binary' | 'too_large' | 'symlink' | 'path_outside_workspace';

export interface TextFileFailure {
  path: string;
  reason: TextFileFailureReason;
  message: string;
  bytes?: number;
}

export interface TextFileData {
  path: string;
  absolutePath: string;
  bytes: number;
  mode: number;
  content: string;
  lines: string[];
}

export type ParentDirectoryFailureReason = 'parent_missing' | 'parent_symlink' | 'parent_not_directory';

export interface ParentDirectoryFailure {
  path: string;
  reason: ParentDirectoryFailureReason;
  message: string;
}

export type ParentDirectoryValidation =
  | { ok: true; parentDirsToCreate: string[] }
  | { ok: false; failure: ParentDirectoryFailure };

export function resolveInsideRoot(
  rootDir: string,
  requestedPath: string,
  options: { emptyPathMessage?: string } = {}
): string {
  if (requestedPath.trim().length === 0) {
    throw new ToolInputError(options.emptyPathMessage ?? 'Path cannot be empty.', { path: requestedPath });
  }
  const normalizedRequest = requestedPath;
  if (path.isAbsolute(normalizedRequest) || path.win32.isAbsolute(normalizedRequest)) {
    throw new ToolInputError(`Absolute paths are not allowed: ${requestedPath}`, { path: requestedPath });
  }
  const root = path.resolve(rootDir);
  const absolutePath = path.resolve(root, normalizedRequest);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new ToolInputError(`Path escapes configured root: ${requestedPath}`, { path: requestedPath });
  }
  return absolutePath;
}

export function relativePath(rootDir: string, absolutePath: string): string {
  return path.relative(path.resolve(rootDir), path.resolve(absolutePath)).split(path.sep).join('/');
}

/** Canonicalizes an existing path (including symlinks) or the deepest existing parent for a new path. */
export async function canonicalWorkspacePath(rootDir: string, requestedPath: string): Promise<string> {
  const root = path.resolve(rootDir);
  const realRoot = await fs.realpath(root);
  let absolute = resolveInsideRoot(root, requestedPath);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(absolute);
      absolute = path.join(real, ...suffix.reverse());
      break;
    } catch (error) {
      if (nodeCode(error) !== 'ENOENT') throw error;
      if (absolute === root) throw error;
      suffix.push(path.basename(absolute));
      absolute = path.dirname(absolute);
    }
  }
  if (absolute !== realRoot && !absolute.startsWith(`${realRoot}${path.sep}`)) throw new ToolInputError(`Path escapes configured root via alias: ${requestedPath}`, { path: requestedPath });
  return path.relative(realRoot, absolute).split(path.sep).join('/') || '.';
}

export async function inspectTextFile(rootDir: string, requestedPath: string, maxBytes: number, options: { rejectSymlink?: boolean } = {}): Promise<
  | { ok: true; file: TextFileData }
  | { ok: false; failure: TextFileFailure }
> {
  let absolutePath;
  try {
    absolutePath = resolveInsideRoot(rootDir, requestedPath, {
      emptyPathMessage: 'Path cannot be empty.'
    });
  } catch (error) {
    if (error instanceof ToolInputError) {
      return {
        ok: false,
        failure: {
          path: requestedPath,
          reason: 'path_outside_workspace',
          message: error.message
        }
      };
    }
    throw error;
  }
  const displayPath = relativePath(rootDir, absolutePath);
  let linkStat;
  try {
    linkStat = await fs.lstat(absolutePath);
  } catch {
    return {
      ok: false,
      failure: {
        path: displayPath || requestedPath,
        reason: 'not_found',
        message: `File does not exist or cannot be read: ${requestedPath}`
      }
    };
  }
  if (linkStat.isSymbolicLink() && options.rejectSymlink === true) {
    return {
      ok: false,
      failure: {
        path: displayPath,
        reason: 'symlink',
        message: `Refusing to write through symlink file path: ${requestedPath}`
      }
    };
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    return {
      ok: false,
      failure: {
        path: displayPath || requestedPath,
        reason: 'not_found',
        message: `File does not exist or cannot be read: ${requestedPath}`
      }
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      failure: {
        path: displayPath,
        reason: 'not_file',
        message: `Path is not a regular file: ${requestedPath}`
      }
    };
  }
  try {
    await assertRealPathInsideRoot(rootDir, absolutePath, requestedPath);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return {
        ok: false,
        failure: {
          path: displayPath,
          reason: 'path_outside_workspace',
          message: error.message
        }
      };
    }
    throw error;
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      failure: {
        path: displayPath,
        reason: 'too_large',
        message: `File is too large to read inline (${String(stat.size)} bytes, max ${String(maxBytes)}): ${requestedPath}`,
        bytes: stat.size
      }
    };
  }
  const buffer = await fs.readFile(absolutePath);
  if (isProbablyBinary(buffer)) {
    return {
      ok: false,
      failure: {
        path: displayPath,
        reason: 'binary',
        message: `Refusing probable binary file: ${requestedPath}`,
        bytes: stat.size
      }
    };
  }
  const content = buffer.toString('utf8');
  return {
    ok: true,
    file: {
      path: displayPath,
      absolutePath,
      bytes: stat.size,
      mode: stat.mode,
      content,
      lines: splitTextLines(content)
    }
  };
}

export async function assertRealPathInsideRoot(rootDir: string, absolutePath: string, requestedPath: string): Promise<void> {
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(path.resolve(rootDir)),
    fs.realpath(absolutePath)
  ]);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new ToolInputError(`Path escapes configured root via symlink: ${requestedPath}`, { path: requestedPath });
  }
}

export async function requireDirectoryInsideRoot(rootDir: string, absolutePath: string, requestedPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    throw new ToolInputError(`Directory does not exist or cannot be read: ${requestedPath}`, {
      kind: 'directory_not_found',
      path: requestedPath
    });
  }
  if (!stat.isDirectory()) {
    throw new ToolInputError(`Path is not a directory: ${requestedPath}`, { path: requestedPath });
  }
  await assertRealPathInsideRoot(rootDir, absolutePath, requestedPath);
}

export async function assertPathIsNotSymlink(rootDir: string, requestedPath: string): Promise<void> {
  const absolutePath = resolveInsideRoot(rootDir, requestedPath);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new ToolInputError(`Refusing to write through symlink file path: ${requestedPath}`, { path: requestedPath });
  }
}

export async function validateParentDirectory(
  rootDir: string,
  absolutePath: string,
  requestedPath: string,
  createParentDirectories: boolean
): Promise<ParentDirectoryValidation> {
  const root = path.resolve(rootDir);
  const parent = path.dirname(absolutePath);
  const missing: string[] = [];
  let current = parent;
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      missing.push(current);
      current = path.dirname(current);
      continue;
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        failure: {
          path: relativePath(root, current),
          reason: 'parent_symlink',
          message: `Refusing to write inside symlink parent directory for: ${requestedPath}`
        }
      };
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        failure: {
          path: relativePath(root, current),
          reason: 'parent_not_directory',
          message: `Parent path is not a directory for: ${requestedPath}`
        }
      };
    }
    await assertRealPathInsideRoot(root, current, requestedPath);
    if (missing.length > 0 && !createParentDirectories) {
      return {
        ok: false,
        failure: {
          path: relativePath(root, parent),
          reason: 'parent_missing',
          message: `Parent directory does not exist: ${relativePath(root, parent)}`
        }
      };
    }
    return { ok: true, parentDirsToCreate: missing.reverse() };
  }

  if (missing.length > 0 && !createParentDirectories) {
    return {
      ok: false,
      failure: {
        path: relativePath(root, parent),
        reason: 'parent_missing',
        message: `Parent directory does not exist: ${relativePath(root, parent)}`
      }
    };
  }
  return { ok: true, parentDirsToCreate: missing.reverse() };
}

export function byteLengthUtf8(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function splitTextLines(content: string): string[] {
  return splitLogicalLines(content).lines;
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  if (sample.includes(0)) {
    return true;
  }
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }
  return sample.length > 0 && suspicious / sample.length > 0.2;
}

export function hasHiddenSegment(relativePathValue: string): boolean {
  return relativePathValue.split('/').some((segment) => segment.startsWith('.') && segment.length > 1);
}

export function hiddenModeAllows(relativePathValue: string, mode: HiddenMode): boolean {
  const hidden = hasHiddenSegment(relativePathValue);
  return mode === 'include' || (mode === 'exclude' && !hidden) || (mode === 'only' && hidden);
}

export function validateRelativePatterns(patterns: readonly string[], fieldName: string): void {
  for (const pattern of patterns) {
    const normalized = normalizePattern(pattern);
    if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new ToolInputError(`${fieldName} patterns must be relative and cannot contain "..": ${pattern}`, {
        field: fieldName,
        pattern
      });
    }
  }
}

export function createPathMatcher(pattern: string): PathMatcher {
  const normalizedPattern = normalizePattern(pattern);
  const hasWildcard = /[*?]/.test(normalizedPattern);
  const hasPathSeparator = normalizedPattern.includes('/');
  const regex = hasWildcard ? globToRegExp(normalizedPattern) : undefined;

  return {
    pattern,
    matches(workspaceRelativePath, scopedRelativePath, name) {
      if (regex) {
        return regex.test(workspaceRelativePath) || regex.test(scopedRelativePath) || regex.test(name);
      }
      if (!hasPathSeparator) {
        return name === normalizedPattern
          || workspaceRelativePath.split('/').includes(normalizedPattern)
          || scopedRelativePath.split('/').includes(normalizedPattern);
      }
      return pathMatchesOrDescends(workspaceRelativePath, normalizedPattern)
        || pathMatchesOrDescends(scopedRelativePath, normalizedPattern);
    }
  };
}

export function normalizePattern(pattern: string): string {
  return pattern.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    const next = pattern[index + 1] ?? '';
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathMatchesOrDescends(candidate: string, pattern: string): boolean {
  return candidate === pattern || candidate.startsWith(`${pattern}/`);
}
function nodeCode(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
