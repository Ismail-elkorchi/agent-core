import * as z from 'zod';

export const listDirectoryInputSchema = z.strictObject({
  path: z.string().trim().min(1).default('.').meta({ description: 'Workspace-relative directory path. Defaults to the workspace root.' }),
  depth: z.int().min(1).default(1).meta({ description: 'Requested number of directory levels. The host clamps this to its traversal limit.' }),
  includeHidden: z.boolean().default(false).meta({ description: 'Include paths with hidden segments. Defaults to false.' }),
  respectGitIgnore: z.boolean().default(true).meta({ description: 'Apply Git ignore rules. Defaults to true.' }),
  exclude: z.array(z.string().trim().min(1)).default([]).meta({ description: 'Glob patterns to exclude.' }),
  resultLimit: z.int().min(1).optional().meta({ description: 'Optional smaller result limit.' }),
  includeMetadata: z.boolean().default(false).meta({ description: 'Include file size and modification time.' })
});

const entrySchema = z.strictObject({
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.int().nonnegative().optional(),
  modifiedAt: z.string().optional()
});

const omissionSchema = z.strictObject({
  path: z.string(),
  reason: z.enum(['hidden', 'gitignored', 'excluded', 'unreadable', 'limit']),
  message: z.string().optional()
});

export const listDirectoryOutputSchema = z.strictObject({
  path: z.string(),
  entries: z.array(entrySchema),
  coverage: z.enum(['complete', 'partial']),
  causes: z.array(z.string()),
  counts: z.strictObject({ visited: z.int().nonnegative(), returned: z.int().nonnegative(), omitted: z.int().nonnegative() }),
  omitted: z.strictObject({ ignoreFiles: z.int().nonnegative() }),
  omissionSamples: z.array(omissionSchema)
});

export type ListDirectoryInput = z.output<typeof listDirectoryInputSchema>;
export type ListDirectoryOutput = z.output<typeof listDirectoryOutputSchema>;
