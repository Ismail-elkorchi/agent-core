import * as z from 'zod';

export const hiddenModeSchema = z.enum(['include', 'exclude', 'only']);

export const listDirectoryTreeInputSchema = z.strictObject({
  path: z.string().trim().min(1).default('.').meta({
    description: 'Directory path to list, relative to the configured root. First call shape: {} lists "." at depth 1.'
  }),
  depth: z.int().min(1).max(20).default(1).meta({
    description: 'Maximum directory depth to return. Depth 1 returns only the direct children of path. Defaults to 1.'
  }),
  maxVisitedEntries: z.int().min(1).max(2_000).default(300).meta({
    description: 'Maximum number of directory entries inspected during traversal. Defaults to 300. Reaching the limit produces partial coverage.'
  }),
  hidden: hiddenModeSchema.default('include').meta({
    description: 'How to handle entries whose path contains a hidden segment. Defaults to "include".'
  }),
  exclude: z.array(z.string().trim().min(1)).default([]).meta({
    description: 'Caller-chosen names, relative paths, or simple wildcard patterns to omit. Examples: [".git", "node_modules", "dist"].'
  })
});

export type ListDirectoryTreeArguments = z.input<typeof listDirectoryTreeInputSchema>;
export type ListDirectoryTreeInput = z.output<typeof listDirectoryTreeInputSchema>;

export type ListedDirectoryEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface ListedDirectoryEntry {
  path: string;
  type: ListedDirectoryEntryType;
  size?: number;
}

export type OmittedDirectoryEntry =
  | { path: string; type: ListedDirectoryEntryType; pattern: string; reason: 'excluded' }
  | { path: string; type: 'directory'; message: string; reason: 'unreadable' };

export interface ListDirectoryTreeOutput {
  path: string;
  scope: {
    path: string;
  };
  filters: {
    hidden: z.output<typeof hiddenModeSchema>;
    exclude: string[];
  };
  limits: {
    depth: number;
    maxVisitedEntries: number;
  };
  entries: ListedDirectoryEntry[];
  omitted: OmittedDirectoryEntry[];
  counts: {
    files: number;
    directories: number;
    symlinks: number;
    other: number;
  };
  coverage: 'complete' | 'partial';
}
